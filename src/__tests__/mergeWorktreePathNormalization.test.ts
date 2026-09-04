/**
 * mergeWorktreePathNormalization.test.ts — QA B11 regression coverage.
 *
 * runtime.ts's mergeWorktree used to pass whatever repoPath string it was
 * handed straight through to the `agent_merge_worktree` Tauri invoke.
 * resolveProjectRoot (agentsStore.tsx) has three possible sources for that
 * string — `get_project_root` (Rust canonicalize, always \\?\-prefixed
 * backslash-only on Windows), `find_git_root` (git-style forward-slash,
 * never \\?\-prefixed), and `get_cwd` — so a \\?\-prefixed path with even
 * one stray forward slash mixed in (e.g. built by naively concatenating a
 * verbatim base with a '/'-joined segment upstream) disables Win32's
 * separator translation for the WHOLE string and fails Rust's
 * `Command::current_dir` with "os error 267" (ERROR_DIRECTORY) — even
 * though the directory genuinely exists on disk. A legit, judge-approved
 * mission (M11) hit exactly this while another mission (M9) merged fine
 * moments earlier from the same UI action.
 *
 * Fixed by normalizing ONCE at the mergeWorktree boundary (paths.ts's
 * normalizeRepoPathForGit — see its own unit tests in paths.test.ts) so
 * every caller (cockpit urgent card, drawer controls, attention inbox,
 * code-space drawer — all funnel through agentsStore.tsx's approveMission
 * -> this exact function) behaves identically regardless of which
 * resolveProjectRoot source produced their repoPath.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ cmd, args: args ?? {} });
    return Promise.resolve('fake-merge-sha');
  }),
}));

describe('mergeWorktree — repoPath normalization at the Tauri boundary (QA B11)', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
  });

  it('strips a \\\\?\\ verbatim prefix and fixes mixed separators before invoking agent_merge_worktree', async () => {
    const { mergeWorktree } = await import('../lib/agents/runtime');
    const mixedPath = String.raw`\\?\C:\Users\user\demo-shop` + '/sub/dir';

    await mergeWorktree(mixedPath, 'agent/m-11');

    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0]!.cmd).toBe('agent_merge_worktree');
    expect(invokeCalls[0]!.args.repoPath).toBe(String.raw`C:\Users\user\demo-shop\sub\dir`);
    expect(invokeCalls[0]!.args.branch).toBe('agent/m-11');
    expect(invokeCalls[0]!.args.repoPath as string).not.toContain('/');
  });

  it('leaves an already-clean Windows path unchanged', async () => {
    const { mergeWorktree } = await import('../lib/agents/runtime');
    const clean = String.raw`\\?\C:\Users\user\demo-shop`;

    await mergeWorktree(clean, 'agent/m-9');

    expect(invokeCalls[0]!.args.repoPath).toBe(String.raw`C:\Users\user\demo-shop`);
  });

  it('leaves a POSIX repoPath (dev/CI) unchanged', async () => {
    const { mergeWorktree } = await import('../lib/agents/runtime');

    await mergeWorktree('/home/dev/demo-shop', 'agent/m-1');

    expect(invokeCalls[0]!.args.repoPath).toBe('/home/dev/demo-shop');
  });

  // 2026-08-05: mergeIntoDir (the orchestrator fan-in merge target, Step E
  // of runtime.ts) was NOT normalized alongside repoPath — this is the
  // remaining gap that let a fan-in merge still hit "os error 267" while a
  // top-level merge (mergeIntoDir absent) was already clean since QA B11.
  it('strips a \\\\?\\ verbatim prefix and fixes mixed separators in mergeIntoDir too', async () => {
    const { mergeWorktree } = await import('../lib/agents/runtime');
    const cleanRepoPath = String.raw`\\?\C:\Users\user\demo-shop`;
    const mixedMergeIntoDir = String.raw`\\?\C:\Users\user\demo-shop\.lazy\worktrees\parent` + '/sub';

    await mergeWorktree(cleanRepoPath, 'agent/m-child', mixedMergeIntoDir);

    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0]!.args.mergeIntoDir).toBe(
      String.raw`C:\Users\user\demo-shop\.lazy\worktrees\parent\sub`,
    );
    expect(invokeCalls[0]!.args.mergeIntoDir as string).not.toContain('/');
  });

  it('leaves mergeIntoDir undefined when the caller omits it (top-level merge, unchanged default)', async () => {
    const { mergeWorktree } = await import('../lib/agents/runtime');

    await mergeWorktree(String.raw`\\?\C:\Users\user\demo-shop`, 'agent/m-9');

    expect(invokeCalls[0]!.args.mergeIntoDir).toBeUndefined();
  });
});
