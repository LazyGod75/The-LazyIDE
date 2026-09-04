/**
 * runtimeQuotaExhaustion.test.ts — real incident regression test (2026-08-19):
 * a mission whose native CLI run hits the Claude CLI's own subscription/
 * session quota wall ("You've hit your session limit · resets 12:30am
 * (Europe/Paris)") must NOT be retried, must end 'failed' with an honest
 * statusReason naming the real cause and the reset time (never "see agent
 * logs"), and must journal a distinct `mission.quota_exhausted` event
 * alongside `mission.failed`.
 *
 * Mirrors runtimeRetry.test.ts's harness exactly, but — unlike that file —
 * does NOT mock '../lib/agents/recovery': this test exercises the REAL
 * evaluateRecovery (quotaExhaustionPolicy) end-to-end, through runMission's
 * agent://error/{id} handling, the same path the real incident went through.
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

// ── Scheduler pool backoff — mocked purely to ASSERT the wiring (runtime.ts
// dynamically imports this module to avoid a static circular import, see its
// own comment); never required for the mission's own outcome, which is
// covered even if this mock were absent (runtime.ts's call site is
// try/catch-wrapped, best-effort). Vitest's vi.mock factory must not close
// over an outer-scope variable that doesn't start with "mock" (hoisting
// restriction) — the vi.fn()s are created INSIDE the factory instead, and
// retrieved afterwards via the mocked module's own exports.
vi.mock('../lib/agents/scheduler', () => ({
  reportQuotaExhausted: vi.fn(),
  resolveProvider: vi.fn(() => 'claude-cli'),
}));

import { runMission } from '../lib/agents/runtime';
import type { Mission } from '../lib/agents/types';
import * as schedulerMocked from '../lib/agents/scheduler';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedListen = listen as ReturnType<typeof vi.fn>;
const reportQuotaExhausted = schedulerMocked.reportQuotaExhausted as ReturnType<typeof vi.fn>;
const resolveProvider = schedulerMocked.resolveProvider as ReturnType<typeof vi.fn>;

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

/** Drives one runMission call whose agent://error/{id} payload is `errorText`
 *  — mirrors what run.rs's `error_event` carries for a native CLI run
 *  (see run.rs's "reported is_error in its result" branch), and returns the
 *  invoke() call log for assertions. */
async function runMissionWithAgentError(errorText: string): Promise<{
  invokedCommands: string[];
  onUpdate: ReturnType<typeof vi.fn>;
}> {
  const worktreePath = 'C:\\repo\\.lazy\\worktrees\\mission-quota';

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
      const req = args?.req as { id: string } | undefined;
      const errorHandler = req ? handlers.get(`agent://error/${req.id}`) : undefined;
      errorHandler?.({ payload: errorText });
      return Promise.resolve(undefined);
    }
    return Promise.resolve(undefined);
  });

  const mission: Mission = {
    id: 'mission-quota',
    title: 'Write the docs',
    status: 'queued',
    model: 'sonnet',
  };

  const onUpdate = vi.fn();
  await runMission(mission, 'C:\\repo', { onUpdate });

  const invokedCommands = mockedInvoke.mock.calls.map(([cmd]) => cmd as string);
  return { invokedCommands, onUpdate };
}

describe('runMission — quota exhaustion (real incident, 2026-08-19)', () => {
  it('does not schedule an immediate retry: exactly one agent_run call, mission ends failed with an honest statusReason', async () => {
    const { invokedCommands, onUpdate } = await runMissionWithAgentError(
      "agent_run: claude reported is_error in its result — You've hit your session limit · resets 12:30am (Europe/Paris)",
    );

    // Exactly ONE attempt — no retry-then-fail-again second agent_run call
    // (contrast runtimeRetry.test.ts's ordinary-error case, which retries
    // exactly once).
    const runCount = invokedCommands.filter((c) => c === 'agent_run').length;
    expect(runCount).toBe(1);

    // Terminal, honest — never the generic "see agent logs" pointer.
    const failedCall = onUpdate.mock.calls.find(
      ([update]) => update.patch?.status === 'failed',
    );
    expect(failedCall).toBeDefined();
    const statusReason = failedCall?.[0]?.patch?.statusReason as string | undefined;
    expect(statusReason).toBeDefined();
    expect(statusReason).toContain('quota');
    expect(statusReason).toContain('12:30am (Europe/Paris)');
    expect(statusReason?.toLowerCase()).not.toContain('see agent logs');

    // The scheduler pool was backed off with the parsed reset time, so
    // sibling missions still queued on the same pool are not launched into
    // the same wall the moment a slot frees. Fire-and-forget on runtime.ts's
    // side (dynamic import, never awaited by runMission itself — see its own
    // comment) — waitFor absorbs that one extra microtask hop.
    await vi.waitFor(() => {
      expect(reportQuotaExhausted).toHaveBeenCalled();
    });
    expect(resolveProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'mission-quota' }));
    expect(reportQuotaExhausted).toHaveBeenCalledWith('claude-cli', expect.any(Number));
  });

  it('a variant with no reset time is also detected and still results in no retry', async () => {
    const { invokedCommands, onUpdate } = await runMissionWithAgentError(
      "agent_run: claude reported is_error in its result — You've hit your session limit.",
    );

    const runCount = invokedCommands.filter((c) => c === 'agent_run').length;
    expect(runCount).toBe(1);

    const failedCall = onUpdate.mock.calls.find(
      ([update]) => update.patch?.status === 'failed',
    );
    const statusReason = failedCall?.[0]?.patch?.statusReason as string | undefined;
    expect(statusReason).toContain('quota');

    // No reset time was parseable — reportQuotaExhausted is still called
    // (falls back to a conservative window internally), with resetAtMs
    // undefined this time.
    await vi.waitFor(() => {
      expect(reportQuotaExhausted).toHaveBeenCalled();
    });
    expect(reportQuotaExhausted).toHaveBeenCalledWith('claude-cli', undefined);
  });

  it('an ordinary agent failure (no quota signature) still retries as before — regression guard', async () => {
    const { invokedCommands } = await runMissionWithAgentError('boom: something unrelated broke');

    // Falls through to defaultPolicy: initial attempt + one retry.
    const runCount = invokedCommands.filter((c) => c === 'agent_run').length;
    expect(runCount).toBe(2);
    expect(reportQuotaExhausted).not.toHaveBeenCalled();
  });
});
