import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mission, ActionEvent } from '../lib/agents/types';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn(),
}));

import { emitEvent } from '../lib/journal/journal';
import {
  createWorktreeWithBaseBranchFallback,
  createMissionWorktree,
} from '../lib/agents/runMissionWorktree';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'M1',
    title: 'Fix login',
    status: 'queued',
    ...overrides,
  } as Mission;
}

const timeline: ActionEvent[] = [{ time: '00:00', text: 'start', isLive: true }];

beforeEach(() => {
  invoke.mockReset();
  vi.mocked(emitEvent).mockClear();
});

describe('createWorktreeWithBaseBranchFallback', () => {
  it('forwards baseBranch when the create succeeds', async () => {
    invoke.mockResolvedValue('/wt/m1');
    const created = await createWorktreeWithBaseBranchFallback('/repo', 'agent/m1', 'main');
    expect(created.worktreePath).toBe('/wt/m1');
    expect(created.fallbackFromMissingBase).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(
      'agent_create_worktree',
      expect.objectContaining({ baseBranch: 'main', branch: 'agent/m1' }),
    );
  });

  it('retries once without baseBranch when that branch is already gone', async () => {
    invoke
      .mockRejectedValueOnce(new Error("base branch 'agent/parent' does not exist"))
      .mockResolvedValueOnce('/wt/m1');
    const created = await createWorktreeWithBaseBranchFallback(
      '/repo',
      'agent/m1',
      'agent/parent',
    );
    expect(created.fallbackFromMissingBase).toBe('agent/parent');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1]).toEqual(
      expect.objectContaining({ baseBranch: undefined, branch: 'agent/m1' }),
    );
  });

  it('does not retry unrelated git errors', async () => {
    invoke.mockRejectedValue(new Error("merge branch 'x' does not exist"));
    await expect(
      createWorktreeWithBaseBranchFallback('/repo', 'agent/m1', 'main', ['x']),
    ).rejects.toThrow(/merge branch/);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('createMissionWorktree', () => {
  it('returns the path and marks the worktree ready', async () => {
    invoke.mockResolvedValue('/wt/m1');
    const updates: Array<{ liveAction?: string; status?: string }> = [];
    const path = await createMissionWorktree({
      mission: mission(),
      repoPath: '/repo',
      branch: 'agent/m1',
      projectId: 'p1',
      initialTimeline: timeline,
      onUpdate: (u) => updates.push(u.patch),
    });
    expect(path).toBe('/wt/m1');
    expect(updates[0]?.liveAction).toMatch(/Worktree prêt/);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('fails the mission without falling back to the main repo', async () => {
    invoke.mockRejectedValue(new Error('not a git repository'));
    const updates: Array<{ status?: string; statusReason?: string }> = [];
    const path = await createMissionWorktree({
      mission: mission(),
      repoPath: '/repo',
      branch: 'agent/m1',
      projectId: 'p1',
      initialTimeline: timeline,
      onUpdate: (u) => updates.push(u.patch),
    });
    expect(path).toBeNull();
    expect(updates[0]?.status).toBe('failed');
    expect(updates[0]?.statusReason).toMatch(/worktree_creation_failed/);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mission.failed', payload: { reason: 'worktree_creation_failed' } }),
    );
  });
});
