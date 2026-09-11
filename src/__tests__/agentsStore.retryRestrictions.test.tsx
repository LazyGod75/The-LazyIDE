/**
 * agentsStore.retryRestrictions.test.tsx
 *
 * SECURITY regression coverage: retryMission used to transmit ONLY
 * permissionMode to runMission, silently dropping:
 *   - allowedTools/deniedTools (a tool-restricted mission could use ALL
 *     tools after retry — a real permission-bypass)
 *   - getBudgetCapUsd/onBudgetPaused/getMaxDurationMs/onDurationPaused
 *     (budget caps and wall-clock limits disabled on retry)
 *
 * addMission's own launch path (agentsStore.tsx) correctly threads all of
 * these; retryMission must do the same so a retry is a faithful re-run of
 * the ORIGINAL mission's restrictions, never a silent widening.
 *
 * Harness mirrors agentsStore.missionLaunchStall.test.tsx (own
 * @tauri-apps/api/core + runtime + journal mocks) for per-test control over
 * the mocked runMission's call arguments.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import type { MissionContract } from '../lib/agents/types';

const { mockInvoke, mockRunMission, mockEmitEvent } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockRunMission: vi.fn(),
  mockEmitEvent: vi.fn((_e: unknown) => Promise.resolve(0)),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
  emit: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/brain/capture', () => ({ captureAgentMission: vi.fn() }));

// Keep everything else in runtime.ts real (classifyMissionModel, etc. — the
// scheduler depends on it) — mirrors agentsStore.test.tsx's own runtime mock.
vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: mockRunMission,
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../lib/journal/journal', () => ({
  emitEvent: mockEmitEvent,
  emitBuffered: vi.fn(() => Promise.resolve(0)),
}));

vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return { ...actual, runManagerTurn: vi.fn() };
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

function restrictedContract(): MissionContract {
  return {
    objective: 'Restricted retry repro',
    model: 'claude-sonnet-5',
    permissionMode: 'acceptEdits',
    budgetCapUsd: 5,
    maxDurationMs: 600_000,
    proofs: [],
    gates: { evaluators: false, humanApprove: false },
    shareToTeam: false,
  };
}

beforeEach(() => {
  localStorage.clear();
  mockInvoke.mockReset().mockImplementation(() => Promise.resolve(undefined));
  mockRunMission.mockReset().mockResolvedValue(undefined);
  mockEmitEvent.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// Locate the runMission call retryMission made for the CLONE (the LAST call
// — addMission's own launch is the first when a mission is added then
// retried in the same hook). Returns the options object (3rd arg).
function lastRunMissionOpts(): Record<string, unknown> {
  expect(mockRunMission).toHaveBeenCalled();
  const lastCall = mockRunMission.mock.calls[mockRunMission.mock.calls.length - 1]!;
  // runMission(mission, repoPath, opts)
  return lastCall[2] as Record<string, unknown>;
}

describe('retryMission — preserves tool restrictions + budget/duration caps (SECURITY)', () => {
  it('re-threads allowedTools/deniedTools from the original mission on retry', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    const allowedTools = ['Read', 'Grep', 'Bash'];
    const deniedTools = ['Write', 'Edit'];
    await act(async () => {
      await result.current.addMission({
        title: 'Tool-restricted mission',
        repo: '.',
        worktree: '',
        modelLabel: 'claude-sonnet-5',
        mode: 'agent',
        orchestrator: false,
        allowedTools,
        deniedTools,
        contract: restrictedContract(),
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1]!.id;

    // Flip to a retriable terminal-ish state, then retry.
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'review' } });
    });

    mockRunMission.mockClear();
    await act(async () => {
      await result.current.retryMission(missionId);
    });

    const opts = lastRunMissionOpts();
    expect(opts.allowedTools).toEqual(allowedTools);
    expect(opts.deniedTools).toEqual(deniedTools);
  });

  it('threads getBudgetCapUsd/getMaxDurationMs getters that read the clone\'s contract', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Budget-capped mission',
        repo: '.',
        worktree: '',
        modelLabel: 'claude-sonnet-5',
        mode: 'agent',
        orchestrator: false,
        contract: restrictedContract(),
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1]!.id;

    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'review' } });
    });

    mockRunMission.mockClear();
    await act(async () => {
      await result.current.retryMission(missionId);
    });

    const opts = lastRunMissionOpts();
    // The getters must be real functions (not undefined — the pre-fix bug).
    expect(typeof opts.getBudgetCapUsd).toBe('function');
    expect(typeof opts.onBudgetPaused).toBe('function');
    expect(typeof opts.getMaxDurationMs).toBe('function');
    expect(typeof opts.onDurationPaused).toBe('function');
    // And they must read the CLONE's contract values (5 / 600_000 above).
    expect((opts.getBudgetCapUsd as () => number | undefined)()).toBe(5);
    expect((opts.getMaxDurationMs as () => number | undefined)()).toBe(600_000);
  });

  it('onBudgetPaused/onDurationPaused flip the clone to paused (resumable via Resume)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Pause-on-budget mission',
        repo: '.',
        worktree: '',
        modelLabel: 'claude-sonnet-5',
        mode: 'agent',
        orchestrator: false,
        contract: restrictedContract(),
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1]!.id;

    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'review' } });
    });

    mockRunMission.mockClear();
    await act(async () => {
      await result.current.retryMission(missionId);
    });

    const cloneId = result.current.missions[result.current.missions.length - 1]!.id;
    const opts = lastRunMissionOpts();

    act(() => {
      (opts.onBudgetPaused as () => void)();
    });
    expect(result.current.missions.find((m) => m.id === cloneId)?.paused).toBe(true);

    // Reset and check the duration callback independently.
    act(() => {
      result.current.updateMission({ id: cloneId, patch: { paused: false } });
    });
    act(() => {
      (opts.onDurationPaused as () => void)();
    });
    expect(result.current.missions.find((m) => m.id === cloneId)?.paused).toBe(true);
  });

  it('preserves permissionMode from the original contract (unchanged behaviour)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Permission-mode mission',
        repo: '.',
        worktree: '',
        modelLabel: 'claude-sonnet-5',
        mode: 'agent',
        orchestrator: false,
        contract: { ...restrictedContract(), permissionMode: 'plan' },
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1]!.id;

    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'review' } });
    });

    mockRunMission.mockClear();
    await act(async () => {
      await result.current.retryMission(missionId);
    });

    const opts = lastRunMissionOpts();
    expect(opts.permissionMode).toBe('plan');
  });
});
