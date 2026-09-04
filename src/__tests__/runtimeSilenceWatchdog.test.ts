/**
 * runtimeSilenceWatchdog.test.ts
 *
 * Real bug reproduced live (M72, 2026-08-07): a mission's agent turn went
 * silent mid-run (no error, no further action event) and stayed `running`
 * for 1535s (~25.6min) with nothing acting on it, because the mission had
 * no `contract.maxDurationMs` cap set (an optional field — the common
 * case). This test proves runMission's silence watchdog (wired via
 * lib/agents/silenceWatchdog.ts, built on the existing
 * lib/models/activityWatchdog.ts primitive) now:
 *
 *   1. Does NOT fire before SILENCE_WATCHDOG_THRESHOLD_MS of true inactivity.
 *   2. On the FIRST threshold crossing, gives the mission one more window
 *      (visible "waiting" action event) rather than failing immediately.
 *   3. On the SECOND crossing (already given one retry), ends the mission
 *      in a terminal `failed` state with a clear statusReason.
 *   4. Never fires while the mission is paused (pauseSignal) — a real,
 *      legitimate reason for silence, not a fault.
 *
 * Mirrors runtimeRetry.test.ts's mocking conventions (native/claude-code
 * engine, invoke()/listen() mocked directly) so the mission's own agent
 * turn can be made to hang forever on demand — the exact shape of the real
 * incident — by simply never firing the agent://done or agent://error
 * event for it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProviderMode: vi.fn(() => 'claude-code'),
  };
});

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

import { runMission } from '../lib/agents/runtime';
import { SILENCE_WATCHDOG_THRESHOLD_MS } from '../lib/agents/silenceWatchdog';
import type { Mission } from '../lib/agents/types';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedListen = listen as ReturnType<typeof vi.fn>;

function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) {
    w['__TAURI_INTERNALS__'] = {};
  } else {
    delete w['__TAURI_INTERNALS__'];
  }
}

/** Wires invoke() so agent_create_worktree resolves normally but agent_run
 *  NEVER fires its done/error event — the exact shape of the real incident:
 *  the process is "running" forever with no further signal at all. */
function mockHangingAgentRun(worktreePath: string): void {
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === 'agent_create_worktree') return Promise.resolve(worktreePath);
    if (cmd === 'agent_run') return Promise.resolve(undefined); // never fires done/error
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  setTauriRuntime(true);
  mockedListen.mockImplementation(() => Promise.resolve(() => {}));
});

afterEach(() => {
  vi.useRealTimers();
  setTauriRuntime(false);
});

function makeMission(): Mission {
  return {
    id: 'mission-silent-1',
    title: 'Test silent mission',
    status: 'queued',
    model: 'sonnet',
  };
}

describe('runMission — silence watchdog', () => {
  it('does not fire before the threshold — no failed/waiting patch yet', async () => {
    mockHangingAgentRun('C:\\repo\\.lazy\\worktrees\\mission-silent-1');
    const onUpdate = vi.fn();
    void runMission(makeMission(), 'C:\\repo', { onUpdate }).catch(() => {});

    // Let the pre-Step-B async setup (worktree creation, brain recall)
    // settle, then advance to just under the threshold.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SILENCE_WATCHDOG_THRESHOLD_MS - 1000);

    expect(onUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ patch: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  it('on the first crossing, notes it visibly and keeps the mission running (one free retry window)', async () => {
    mockHangingAgentRun('C:\\repo\\.lazy\\worktrees\\mission-silent-1');
    const onUpdate = vi.fn();
    void runMission(makeMission(), 'C:\\repo', { onUpdate }).catch(() => {});

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SILENCE_WATCHDOG_THRESHOLD_MS + 1000);

    // A visible "waiting" action event was reported...
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          actionTimeline: expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining('10min') }),
          ]),
        }),
      }),
    );
    // ...but the mission is NOT yet terminal.
    expect(onUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ patch: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  it('on the second crossing (already retried once), ends the mission failed with a clear reason', async () => {
    mockHangingAgentRun('C:\\repo\\.lazy\\worktrees\\mission-silent-1');
    const onUpdate = vi.fn();
    void runMission(makeMission(), 'C:\\repo', { onUpdate }).catch(() => {});

    await vi.advanceTimersByTimeAsync(0);
    // Two full silence windows: first gives a free pass, second is terminal.
    await vi.advanceTimersByTimeAsync(SILENCE_WATCHDOG_THRESHOLD_MS + 1000);
    await vi.advanceTimersByTimeAsync(SILENCE_WATCHDOG_THRESHOLD_MS + 1000);

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'mission-silent-1',
        patch: expect.objectContaining({
          status: 'failed',
          statusReason: expect.stringContaining('20min'),
        }),
      }),
    );

    // Real action taken, not just a status flip: the underlying agent run
    // was told to stop.
    const killed = mockedInvoke.mock.calls.some(([cmd]) => cmd === 'agent_run_kill');
    expect(killed).toBe(true);
  });

  it('never fires while the mission is paused — silence while paused is not a fault', async () => {
    mockHangingAgentRun('C:\\repo\\.lazy\\worktrees\\mission-silent-2');
    const onUpdate = vi.fn();
    void runMission(makeMission(), 'C:\\repo', {
      onUpdate,
      pauseSignal: () => true,
    }).catch(() => {});

    await vi.advanceTimersByTimeAsync(0);
    // Well past TWO full silence windows — would already be terminal if
    // pause were not respected.
    await vi.advanceTimersByTimeAsync(SILENCE_WATCHDOG_THRESHOLD_MS * 2 + 5000);

    expect(onUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ patch: expect.objectContaining({ status: 'failed' }) }),
    );
  });
});
