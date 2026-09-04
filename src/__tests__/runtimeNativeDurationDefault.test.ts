/**
 * runtimeNativeDurationDefault.test.ts
 *
 * Runaway-guard half of the 2026-08-19 dollar-kill incident fix
 * (runtime.ts's `NATIVE_DEFAULT_MAX_DURATION_MS`): checkNativeBudget no
 * longer stops a native-rail mission on its notional cost (see
 * runtimeBudgetCapSalvage.test.ts) — but that must not leave a native
 * mission with NO bound at all. MissionContract.maxDurationMs already
 * defaults to "unlimited" when the user leaves the launch form's duration
 * cap on its default ('unlimited' — NewMissionModal.tsx's own
 * DURATION_OPTIONS), which was an acceptable default only because a
 * native overshoot used to hit the dollar kill as a backstop. This file
 * proves runMission now falls back to NATIVE_DEFAULT_MAX_DURATION_MS on the
 * native rail specifically whenever the mission's own contract sets no
 * explicit cap, using the SAME real wall-clock timer
 * (armDurationExceededTimer) already unit-tested generically in
 * durationCap.test.ts.
 *
 * The mocked mission "pings" (fires a synthetic tool step) every 5 minutes
 * so the PRE-EXISTING silence watchdog (10min threshold, see
 * runtimeSilenceWatchdog.test.ts) never independently trips and confounds
 * which guard actually stopped the mission — this isolates the assertion to
 * the duration guard alone, the one this fix adds.
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

vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn(() => Promise.resolve(0)),
  emitBuffered: vi.fn(() => Promise.resolve(0)),
}));

vi.mock('../lib/journal/projectId', () => ({
  projectIdFromRoot: vi.fn(() => 'test-project-id'),
}));

import { runMission, NATIVE_DEFAULT_MAX_DURATION_MS } from '../lib/agents/runtime';
import type { Mission, MissionContract } from '../lib/agents/types';

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

const baseContract: Omit<MissionContract, 'maxDurationMs'> = {
  objective: 'test',
  model: 'claude-sonnet',
  permissionMode: 'acceptEdits',
  budgetCapUsd: 0, // unlimited — isolates every test in this file to the DURATION guard alone
  proofs: [],
  gates: { evaluators: false, humanApprove: false },
  shareToTeam: false,
  parentDepth: 0,
};

/** Wires invoke()/listen() so agent_run hangs forever (never fires
 *  done/error on its own — the exact "genuinely stuck" shape this guard
 *  exists for), while `agent_run_kill` — the guard's own real action —
 *  synthesizes the `agent://error/{id}` event a killed real process would
 *  eventually raise, so runMission's own promise settles instead of hanging
 *  the test forever. */
function wireHangingNativeRun(worktreePath: string): {
  invokedCommands: () => string[];
  fireHeartbeat: (missionId: string) => void;
} {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  mockedListen.mockImplementation((eventName: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(eventName, handler);
    return Promise.resolve(() => {
      handlers.delete(eventName);
    });
  });

  mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'agent_create_worktree') return Promise.resolve(worktreePath);
    if (cmd === 'agent_run') return Promise.resolve(undefined); // never fires done/error
    if (cmd === 'agent_run_kill') {
      const id = (args?.id as string | undefined) ?? '';
      handlers.get(`agent://error/${id}`)?.({ payload: 'Killed: duration cap exceeded' });
      return Promise.resolve(undefined);
    }
    if (cmd === 'agent_worktree_diff') return Promise.resolve(''); // nothing written — genuinely stuck
    if (cmd === 'agent_discard_worktree') return Promise.resolve(undefined);
    return Promise.resolve(undefined);
  });

  return {
    invokedCommands: () => mockedInvoke.mock.calls.map(([cmd]) => cmd as string),
    fireHeartbeat: (missionId: string) => {
      handlers.get(`agent://step/${missionId}`)?.({
        payload: { kind: 'tool', name: 'heartbeat', summary: 'still working' },
      });
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  setTauriRuntime(true);
});

afterEach(() => {
  vi.useRealTimers();
  setTauriRuntime(false);
});

describe('NATIVE_DEFAULT_MAX_DURATION_MS', () => {
  it('is a sane, generous-but-bounded default: 2 hours', () => {
    expect(NATIVE_DEFAULT_MAX_DURATION_MS).toBe(2 * 60 * 60_000);
  });
});

describe('runMission — native rail runaway guard (Fix D)', () => {
  it('an explicit contract.maxDurationMs still bounds a genuinely stuck native mission', async () => {
    const worktreePath = 'C:\\repo\\.lazy\\worktrees\\mission-explicit-cap';
    const { invokedCommands } = wireHangingNativeRun(worktreePath);
    const capMs = 3 * 60_000; // well under the 10min silence threshold — isolates this test to duration
    const mission: Mission = {
      id: 'mission-explicit-cap-1',
      title: 'Explicit cap native mission',
      status: 'queued',
      model: 'claude-sonnet',
      contract: { ...baseContract, maxDurationMs: capMs },
    };
    const onUpdate = vi.fn();
    const missionPromise = runMission(mission, 'C:\\repo', { onUpdate, stopSignal: () => false });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(capMs - 5_000);
    expect(invokedCommands()).not.toContain('agent_run_kill');

    await vi.advanceTimersByTimeAsync(10_000);
    await missionPromise;

    expect(invokedCommands()).toContain('agent_run_kill');
    const patches = onUpdate.mock.calls.map((c) => (c[0] as { patch: Partial<Mission> }).patch);
    const finalPatch = [...patches].reverse().find((p) => p.status !== undefined);
    expect(finalPatch?.status).toBe('failed'); // nothing was ever written — nothing to salvage
    expect(finalPatch?.statusReason).toBeTruthy();
  }, 20_000);

  it('with NO explicit maxDurationMs, a native mission is still bounded by the default — never runs forever', async () => {
    const worktreePath = 'C:\\repo\\.lazy\\worktrees\\mission-runaway';
    const { invokedCommands, fireHeartbeat } = wireHangingNativeRun(worktreePath);
    const mission: Mission = {
      id: 'mission-runaway-1',
      title: 'Runaway native mission (no explicit cap)',
      status: 'queued',
      model: 'claude-sonnet',
      contract: { ...baseContract }, // maxDurationMs intentionally absent
    };
    const onUpdate = vi.fn();
    const missionPromise = runMission(mission, 'C:\\repo', { onUpdate, stopSignal: () => false });
    await vi.advanceTimersByTimeAsync(0);

    // Heartbeat every 5min (< the 10min silence threshold) so the
    // PRE-EXISTING silence watchdog never independently trips — isolates
    // this run to the duration guard this fix adds.
    const HEARTBEAT_MS = 5 * 60_000;
    let elapsed = 0;
    while (elapsed < NATIVE_DEFAULT_MAX_DURATION_MS - HEARTBEAT_MS) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      elapsed += HEARTBEAT_MS;
      fireHeartbeat(mission.id);
    }
    // Still short of the default cap — not stopped yet.
    expect(invokedCommands()).not.toContain('agent_run_kill');

    // Cross the default cap.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS + 60_000);
    await missionPromise;

    expect(invokedCommands()).toContain('agent_run_kill');
    const patches = onUpdate.mock.calls.map((c) => (c[0] as { patch: Partial<Mission> }).patch);
    const finalPatch = [...patches].reverse().find((p) => p.status !== undefined);
    expect(finalPatch?.status).toBe('failed');
    // Duration wording (minutes-based), never the silence watchdog's own
    // "agent silencieux" message — proves THIS guard is what fired.
    expect(finalPatch?.statusReason?.toLowerCase()).not.toContain('silencieux');
  }, 20_000);
});
