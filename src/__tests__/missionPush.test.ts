/* missionPush.test.ts — post-merge push plumbing (missionPush.ts).
 *
 * The founding bug this guards (verified on the backoffice test repo):
 * approveMission merged the worktree branch locally but never pushed, so
 * "main never moved / nothing reached the remote" while the UI implied the
 * mission was fully delivered. The module's contract is honesty-first:
 *   - pushed                -> git push exited 0 (work IS on the remote)
 *   - skipped_no_remote     -> no remote configured (local-only merge)
 *   - skipped_no_upstream   -> remote exists but branch tracks nothing
 *   - failed(reason)        -> real push error (auth/network/rejected)
 * It NEVER throws, NEVER fabricates a push, and NEVER blocks the already-
 * reported merge success.
 */

import { describe, it, expect, vi } from 'vitest';
import { pushAfterMissionMerge, type MissionPushDeps } from '../lib/agents/missionPush';

function makeDeps(overrides: Partial<MissionPushDeps> = {}): MissionPushDeps {
  return {
    isTauri: () => true,
    repoHasRemote: vi.fn().mockResolvedValue(true),
    repoHasUpstream: vi.fn().mockResolvedValue(true),
    pushGit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('pushAfterMissionMerge — post-merge push (plumbing fix)', () => {
  it('pushes when a remote and an upstream both exist', async () => {
    const deps = makeDeps();
    const result = await pushAfterMissionMerge('/repo', deps);

    expect(result).toEqual({ outcome: 'pushed' });
    expect(deps.pushGit).toHaveBeenCalledWith('/repo');
    expect(deps.repoHasRemote).toHaveBeenCalledWith('/repo');
    expect(deps.repoHasUpstream).toHaveBeenCalledWith('/repo');
  });

  it('skips (never pushes, never throws) when the repo has NO remote — local-only project', async () => {
    const deps = makeDeps({ repoHasRemote: vi.fn().mockResolvedValue(false) });
    const result = await pushAfterMissionMerge('/local-only-repo', deps);

    expect(result).toEqual({ outcome: 'skipped_no_remote' });
    // The local-only case must not even attempt the push, and must not
    // consult upstream (nothing to track against).
    expect(deps.pushGit).not.toHaveBeenCalled();
    expect(deps.repoHasUpstream).not.toHaveBeenCalled();
  });

  it('skips when a remote exists but the current branch has NO upstream', async () => {
    const deps = makeDeps({ repoHasUpstream: vi.fn().mockResolvedValue(false) });
    const result = await pushAfterMissionMerge('/repo', deps);

    expect(result).toEqual({ outcome: 'skipped_no_upstream' });
    expect(deps.pushGit).not.toHaveBeenCalled();
  });

  it('reports a real push failure honestly (auth/network/rejected) instead of pretending', async () => {
    const deps = makeDeps({ pushGit: vi.fn().mockRejectedValue(new Error('git push error: rejected')) });
    const result = await pushAfterMissionMerge('/repo', deps);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.reason).toContain('rejected');
    }
  });

  it('treats an unreadable remote probe as no-remote (unknown is NOT pushed)', async () => {
    const deps = makeDeps({ repoHasRemote: vi.fn().mockRejectedValue(new Error('boom')) });
    const result = await pushAfterMissionMerge('/repo', deps);

    expect(result).toEqual({ outcome: 'skipped_no_remote' });
    expect(deps.pushGit).not.toHaveBeenCalled();
  });

  it('NEVER pushes on the web/mock platform (no real git backend)', async () => {
    const deps = makeDeps({ isTauri: () => false });
    const result = await pushAfterMissionMerge('/repo', deps);

    expect(result).toEqual({ outcome: 'skipped_no_remote' });
    expect(deps.pushGit).not.toHaveBeenCalled();
    expect(deps.repoHasRemote).not.toHaveBeenCalled();
  });

  it('never throws on any failure path (contract: caller can always journal the truth)', async () => {
    const deps = makeDeps({
      repoHasRemote: vi.fn().mockRejectedValue(new Error('boom1')),
      repoHasUpstream: vi.fn().mockRejectedValue(new Error('boom2')),
      pushGit: vi.fn().mockRejectedValue(new Error('boom3')),
    });
    const result = await pushAfterMissionMerge('/repo', deps);
    expect(['skipped_no_remote', 'skipped_no_upstream', 'failed']).toContain(result.outcome);
  });
});
