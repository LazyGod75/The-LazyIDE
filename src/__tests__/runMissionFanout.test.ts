import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mission, SubAgent } from '../lib/agents/types';

const invoke = vi.fn();
const emitEvent = vi.fn();

// Configurable listen mode: which agent:// event fires for each child.
// 'done'  — only agent://done fires (child succeeds).
// 'error' — only agent://error fires (child errors out).
// 'both'  — both fire (done first, so the promise resolves).
let listenMode: 'done' | 'error' | 'both' = 'done';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, callback: () => void) => {
    if (event.startsWith('agent://done') && (listenMode === 'done' || listenMode === 'both')) {
      callback();
    }
    if (event.startsWith('agent://error') && (listenMode === 'error' || listenMode === 'both')) {
      callback();
    }
    return Promise.resolve(() => undefined);
  }),
}));
vi.mock('../lib/journal/journal', () => ({
  emitEvent: (...args: unknown[]) => emitEvent(...args),
}));

import { fanOutOrchestratorSubAgents, runOneOrchestratorSubAgent } from '../lib/agents/runMissionFanout';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'M1',
    title: 'Orchestrate',
    status: 'review',
    isOrchestrator: true,
    subAgents: [
      { name: 'Tester', status: 'queued' },
      { name: 'Reviewer', status: 'queued' },
    ],
    ...overrides,
  } as Mission;
}

beforeEach(() => {
  invoke.mockReset();
  emitEvent.mockReset();
  listenMode = 'done';
  invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'agent_create_worktree') {
      const branch = (args as { branch?: string } | undefined)?.branch ?? 'x';
      return Promise.resolve(`/wt/${branch}`);
    }
    return Promise.resolve(undefined);
  });
});

describe('fanOutOrchestratorSubAgents', () => {
  it('is a no-op when the mission is not an orchestrator', async () => {
    const updates: unknown[] = [];
    await fanOutOrchestratorSubAgents({
      mission: mission({ isOrchestrator: false }),
      repoPath: '/repo',
      parentWorktreePath: '/wt/parent',
      projectId: 'p1',
      tool: 'claude',
      model: 'sonnet',
      onUpdate: (u) => updates.push(u),
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it('blocks fan-out at depth 2 without creating child worktrees', async () => {
    await fanOutOrchestratorSubAgents({
      mission: mission({ contract: { parentDepth: 2 } } as Partial<Mission>),
      repoPath: '/repo',
      parentWorktreePath: '/wt/parent',
      projectId: 'p1',
      tool: 'claude',
      model: 'sonnet',
      onUpdate: () => undefined,
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mission.blocked',
        payload: expect.objectContaining({ reason: expect.stringMatching(/depth cap/) }),
      }),
    );
  });

  it('creates a worktree per sub-agent in parallel', async () => {
    const statuses: Array<SubAgent[] | undefined> = [];
    await fanOutOrchestratorSubAgents({
      mission: mission(),
      repoPath: '/repo',
      parentWorktreePath: '/wt/parent',
      projectId: 'p1',
      tool: 'claude',
      model: 'sonnet',
      onUpdate: (u) => statuses.push(u.patch.subAgents),
    });
    const creates = invoke.mock.calls.filter((c) => c[0] === 'agent_create_worktree');
    expect(creates).toHaveLength(2);
    expect(statuses[0]?.every((s) => s.status === 'running')).toBe(true);
    expect(statuses.at(-1)?.map((s) => s.status)).toEqual(['done', 'done']);
  });

  it('marks a child as failed (not done) when it emits agent://error', async () => {
    listenMode = 'error';
    const statuses: Array<SubAgent[] | undefined> = [];
    await fanOutOrchestratorSubAgents({
      mission: mission(),
      repoPath: '/repo',
      parentWorktreePath: '/wt/parent',
      projectId: 'p1',
      tool: 'claude',
      model: 'sonnet',
      onUpdate: (u) => statuses.push(u.patch.subAgents),
    });
    const finalStatuses = statuses.at(-1)?.map((s) => s.status);
    expect(finalStatuses).toEqual(['failed', 'failed']);
    expect(finalStatuses).not.toContain('done');
  });
});

describe('mergeAndCleanupChild (via runOneOrchestratorSubAgent)', () => {
  it('preserves the worktree on merge conflict instead of discarding it', async () => {
    listenMode = 'done';
    invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'agent_create_worktree') {
        const branch = (args as { branch?: string } | undefined)?.branch ?? 'x';
        return Promise.resolve(`/wt/${branch}`);
      }
      if (cmd === 'agent_merge_worktree') {
        return Promise.reject(new Error('merge conflict in src/index.ts'));
      }
      return Promise.resolve(undefined);
    });

    await runOneOrchestratorSubAgent({
      mission: mission({ subAgents: [{ name: 'Tester', status: 'queued' }] }),
      subAgent: { name: 'Tester', status: 'queued' },
      repoPath: '/repo',
      parentWorktreePath: '/wt/parent',
      projectId: 'p1',
      tool: 'claude',
      model: 'sonnet',
      childDepth: 1,
    });

    const discards = invoke.mock.calls.filter((c) => c[0] === 'agent_discard_worktree');
    expect(discards).toHaveLength(0);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mission.blocked',
        payload: expect.objectContaining({ reason: expect.stringMatching(/sub_agent_merge_failed/) }),
      }),
    );
  });

  it('discards the worktree after a successful merge', async () => {
    listenMode = 'done';
    invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'agent_create_worktree') {
        const branch = (args as { branch?: string } | undefined)?.branch ?? 'x';
        return Promise.resolve(`/wt/${branch}`);
      }
      return Promise.resolve(undefined);
    });

    await runOneOrchestratorSubAgent({
      mission: mission({ subAgents: [{ name: 'Tester', status: 'queued' }] }),
      subAgent: { name: 'Tester', status: 'queued' },
      repoPath: '/repo',
      parentWorktreePath: '/wt/parent',
      projectId: 'p1',
      tool: 'claude',
      model: 'sonnet',
      childDepth: 1,
    });

    const discards = invoke.mock.calls.filter((c) => c[0] === 'agent_discard_worktree');
    expect(discards).toHaveLength(1);
  });
});
