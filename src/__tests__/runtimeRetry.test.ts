/**
 * runtimeRetry.test.ts
 *
 * Regression test for the auto-retry-reuses-a-discarded-worktree bug in
 * runMission (runtime.ts): on agentFailed, cleanupWorktree() used to run
 * BEFORE the recovery decision was evaluated, force-removing the worktree
 * directory + branch — then, if the recovery policy decided to retry, the
 * SAME (now-deleted) worktreePath was reused for the retry's planAndAct
 * call, so every retry failed immediately against a dead cwd.
 *
 * This test proves (via invoke() call ordering) that:
 *   1. The retry's agent_run call happens WITHOUT an agent_discard_worktree
 *      call in between — the worktree must still be alive when the retry runs.
 *   2. The worktree is still cleaned up exactly once, after the retry also
 *      fails (mirrors the pre-existing "no-retry path" cleanup behavior).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// ── Force claude-code mode so runMission routes to the native planAndActLive
// loop (agent_run + agent://step|done|error events) ────────────────────────
vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProviderMode: vi.fn(() => 'claude-code'),
  };
});

// ── Brain recall/startup context — required by compilePlan + planAndActLive,
// not the focus of this test ────────────────────────────────────────────────
vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    brain: {
      recall: vi.fn().mockResolvedValue({
        injectedContext: '',
        nodes: [],
        tokensInjected: 0,
        tokensSaved: 0,
      }),
      capture: vi.fn().mockResolvedValue(undefined),
      startupContext: vi.fn().mockResolvedValue(''),
    },
  })),
}));

vi.mock('../lib/brain/context', () => ({
  normalizeRecall: vi.fn((r: unknown) => r),
  buildPromptBrainContext: vi.fn(() => ''),
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

// ── Force a single retry decision, with no real backoff wait ───────────────
vi.mock('../lib/agents/recovery', () => ({
  evaluateRecovery: vi.fn(() => ({
    action: 'retry' as const,
    delayMs: 0,
    reason: 'test forced retry',
  })),
  delayMs: vi.fn().mockResolvedValue(undefined),
}));

import { runMission } from '../lib/agents/runtime';
import type { Mission } from '../lib/agents/types';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedListen = listen as ReturnType<typeof vi.fn>;

/** Toggle the global flag isTauriRuntime() reads. */
function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) {
    w['__TAURI_INTERNALS__'] = {};
  } else {
    delete w['__TAURI_INTERNALS__'];
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  setTauriRuntime(true);
});

afterEach(() => {
  setTauriRuntime(false);
});

describe('runMission — retry after agentFailed', () => {
  it('retries into the same worktree without discarding it first, then cleans up once after the retry also fails', async () => {
    const worktreePath = 'C:\\repo\\.lazy\\worktrees\\mission-1';

    // Captures the listen() handlers currently registered per event name so
    // the test can fire them manually — mirrors the global @tauri-apps/api/event
    // mock (setup.ts), which never calls handlers on its own.
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    mockedListen.mockImplementation((eventName: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(eventName, handler);
      return Promise.resolve(() => { handlers.delete(eventName); });
    });

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'agent_create_worktree') {
        return Promise.resolve(worktreePath);
      }
      if (cmd === 'agent_run') {
        // Every attempt fails — fires the error event for THIS attempt's
        // missionId synchronously, before invoke() even returns, so
        // planAndActLive's agentFinished resolves without any real wait.
        const req = args?.req as { id: string } | undefined;
        const errorHandler = req ? handlers.get(`agent://error/${req.id}`) : undefined;
        errorHandler?.({ payload: 'boom' });
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    const mission: Mission = {
      id: 'mission-1',
      title: 'Test retry mission',
      status: 'queued',
      model: 'sonnet',
    };

    const onUpdate = vi.fn();
    await runMission(mission, 'C:\\repo', { onUpdate });

    const invokedCommands = mockedInvoke.mock.calls.map(([cmd]) => cmd as string);
    const runIndexes = invokedCommands.reduce<number[]>((acc, cmd, idx) => {
      if (cmd === 'agent_run') acc.push(idx);
      return acc;
    }, []);
    const discardIndexes = invokedCommands.reduce<number[]>((acc, cmd, idx) => {
      if (cmd === 'agent_discard_worktree') acc.push(idx);
      return acc;
    }, []);

    // Two attempts: the initial run + exactly one retry.
    expect(runIndexes).toHaveLength(2);
    const [firstRunIdx, secondRunIdx] = runIndexes;

    // Regression guard: no discard between the two agent_run calls — the
    // retry must reuse a worktree that is still alive on disk.
    const discardsBetweenRuns = discardIndexes.filter((i) => i > firstRunIdx && i < secondRunIdx);
    expect(discardsBetweenRuns).toEqual([]);

    // Cleanup still happens exactly once, after the retry also fails (the
    // "no-retry path" cleanup behavior, now correctly deferred).
    expect(discardIndexes).toHaveLength(1);
    expect(discardIndexes[0]).toBeGreaterThan(secondRunIdx);

    // Both attempts must target the SAME worktreePath (not a stale/rebuilt one).
    const runCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'agent_run');
    const reqOf = (call: unknown[]): { worktreePath?: string } =>
      (call[1] as { req?: { worktreePath?: string } } | undefined)?.req ?? {};
    expect(reqOf(runCalls[0]).worktreePath).toBe(worktreePath);
    expect(reqOf(runCalls[1]).worktreePath).toBe(worktreePath);

    // Mission ends failed (retry exhausted), matching pre-existing behavior.
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'mission-1',
        patch: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });
});
