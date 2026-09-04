/* journal.test.ts — the frontend event journal client (src/lib/journal/journal.ts).

   Covers:
   1. emitEvent: immediate invoke('journal_emit', ...), never throws.
   2. serializeEvent: camelCase -> snake_case wire mapping, spend.tokens
      top-level token columns, null defaults for absent optional ids.
   3. emitBuffered: batches into one invoke('journal_emit_batch', ...) call
      after the 500ms flush window; terminal events (mission.completed et al.,
      budget.exceeded) flush immediately instead of waiting.
   4. Circuit breaker: after 5 consecutive flush failures, further buffered
      events are dropped without attempting invoke; a success resets the
      counter; the trip logs exactly one warning (not one per dropped event).
   5. journalQuery: wraps journal_query_events, never throws (resolves [] on
      failure).
   6. journalQuery failure-streak backoff: after a real failure, further
      calls short-circuit (no invoke) for a doubling cooldown (5s/10s/.../
      120s cap); a success resets the streak; exactly one warning per
      streak transition (never one per short-circuited call), one info line
      on recovery.

   @tauri-apps/api/core is already globally mocked by src/__tests__/setup.ts
   (see teams-dispatch.test.ts / captureQueue.test.ts for the same pattern
   this file follows: vi.mocked(invoke) + fake timers + a reset-for-tests
   helper for the module's private state).
*/

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  emitEvent,
  emitBuffered,
  journalQuery,
  serializeEvent,
  resetJournalForTests,
} from '../lib/journal/journal';
import type { JournalEventInput, JournalEventRow } from '../lib/journal/eventTypes';

const mockInvoke = vi.mocked(invoke);

// ── Fixtures ──────────────────────────────────────────────────────

function missionStep(overrides: Partial<JournalEventInput> = {}): JournalEventInput {
  return {
    type: 'mission.step',
    tsMs: 1_000,
    projectId: 'proj-1',
    missionId: 'm-1',
    actor: 'agent',
    payload: { text: 'doing work' },
    ...overrides,
  } as JournalEventInput;
}

function missionCompleted(): JournalEventInput {
  return {
    type: 'mission.completed',
    tsMs: 2_000,
    projectId: 'proj-1',
    missionId: 'm-1',
    actor: 'system',
    payload: { durationMs: 500, costUsd: 0.02 },
  };
}

function spendTokens(): JournalEventInput {
  return {
    type: 'spend.tokens',
    tsMs: 3_000,
    projectId: 'proj-1',
    missionId: 'm-1',
    actor: 'agent',
    payload: { tokensIn: 100, tokensOut: 50, costUsd: 0.01, source: 'real' },
  };
}

/** A promise that never settles — simulates the backend contention-window
 *  hang the withTimeout fix targets (invoke() call that never resolves,
 *  never rejects, on its own). */
function neverResolves<T = unknown>(): Promise<T> {
  return new Promise(() => {});
}

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  resetJournalForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── emitEvent ─────────────────────────────────────────────────────

describe('emitEvent', () => {
  it('invokes journal_emit immediately with a serialized event', async () => {
    await emitEvent(missionStep());

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('journal_emit', {
      event: expect.objectContaining({
        ts_ms: 1_000,
        project_id: 'proj-1',
        mission_id: 'm-1',
        type: 'mission.step',
      }),
    });
  });

  it('never throws when invoke rejects', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('sidecar down'));

    await expect(emitEvent(missionStep())).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it('times out (never hangs) and logs a warning when journal_emit never resolves', async () => {
    // Root-cause regression guard: before this fix, invoke('journal_emit', ...)
    // had no timeout at all, so a backend contention-window hang meant this
    // promise never settled — no DB row, no catch, no warn. withTimeout now
    // bounds it, turning the hang into an ordinary rejection this function
    // already knows how to handle.
    mockInvoke.mockImplementationOnce(() => neverResolves());

    const pending = emitEvent(missionStep());
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      '[journal] emitEvent failed:',
      expect.objectContaining({
        message: expect.stringContaining('journal_emit timed out after 15000ms'),
      }),
    );
  });
});

// ── serializeEvent ────────────────────────────────────────────────

describe('serializeEvent', () => {
  it('maps camelCase fields to the snake_case wire contract', () => {
    const row = serializeEvent(missionStep());

    expect(row).toMatchObject({
      ts_ms: 1_000,
      project_id: 'proj-1',
      mission_id: 'm-1',
      actor: 'agent',
      type: 'mission.step',
    });
    expect(JSON.parse(row.payload)).toEqual({ text: 'doing work' });
  });

  it('defaults absent optional ids (missionId/agentId/runId) to null', () => {
    const row = serializeEvent({
      type: 'project.opened',
      tsMs: 5,
      projectId: 'proj-1',
      actor: 'user',
      payload: { root: '/repo' },
    });

    expect(row.mission_id).toBeNull();
    expect(row.agent_id).toBeNull();
    expect(row.run_id).toBeNull();
  });

  it('copies tokensIn/tokensOut/costUsd into top-level columns for spend.tokens', () => {
    const row = serializeEvent(spendTokens());

    expect(row.tokens_in).toBe(100);
    expect(row.tokens_out).toBe(50);
    expect(row.cost_usd).toBe(0.01);
  });

  it('defaults top-level token columns to 0 for non-spend events', () => {
    const row = serializeEvent(missionStep());

    expect(row.tokens_in).toBe(0);
    expect(row.tokens_out).toBe(0);
    expect(row.cost_usd).toBe(0);
  });
});

// ── emitBuffered — 500ms flush ────────────────────────────────────

describe('emitBuffered — 500ms flush', () => {
  it('does not call invoke before 500ms elapses', () => {
    emitBuffered(missionStep());
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('flushes buffered events as one batched invoke call after 500ms', async () => {
    emitBuffered(missionStep());
    emitBuffered(missionStep({ tsMs: 1_100 }));

    await vi.advanceTimersByTimeAsync(500);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockInvoke.mock.calls[0];
    expect(cmd).toBe('journal_emit_batch');
    expect((args as { events: unknown[] }).events).toHaveLength(2);
  });

  it('does not re-flush an already-empty buffer on the next tick', async () => {
    emitBuffered(missionStep());
    await vi.advanceTimersByTimeAsync(500);
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});

// ── emitBuffered — terminal event flush ───────────────────────────

describe('emitBuffered — terminal event flush', () => {
  it('flushes immediately (before the 500ms window) when a terminal event arrives', async () => {
    emitBuffered(missionCompleted());

    await vi.advanceTimersByTimeAsync(0);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [cmd] = mockInvoke.mock.calls[0];
    expect(cmd).toBe('journal_emit_batch');
  });

  it('flushes prior buffered non-terminal events together with the terminal one', async () => {
    emitBuffered(missionStep());
    emitBuffered(missionCompleted());

    await vi.advanceTimersByTimeAsync(0);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [, args] = mockInvoke.mock.calls[0];
    expect((args as { events: unknown[] }).events).toHaveLength(2);
  });

  it('budget.exceeded also triggers an immediate flush', async () => {
    emitBuffered({
      type: 'budget.exceeded',
      tsMs: 4_000,
      projectId: 'proj-1',
      actor: 'system',
      payload: { capUsd: 10, spentUsd: 12 },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('a terminal flush cancels the pending 500ms timer (no duplicate flush)', async () => {
    emitBuffered(missionStep());
    emitBuffered(missionCompleted());
    await vi.advanceTimersByTimeAsync(0);
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // The 500ms timer scheduled by the first (non-terminal) emit must not
    // have survived to fire a second, empty flush.
    await vi.advanceTimersByTimeAsync(500);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});

// ── emitBuffered — circuit breaker ────────────────────────────────

describe('emitBuffered — circuit breaker', () => {
  it('stops calling invoke after 5 consecutive flush failures', async () => {
    mockInvoke.mockRejectedValue(new Error('journal down'));

    for (let i = 0; i < 5; i++) {
      emitBuffered(missionCompleted());
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(mockInvoke).toHaveBeenCalledTimes(5);

    emitBuffered(missionCompleted());
    await vi.advanceTimersByTimeAsync(0);
    expect(mockInvoke).toHaveBeenCalledTimes(5); // circuit open — no 6th attempt

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('circuit breaker open'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not warn again for events dropped after the circuit is already open', async () => {
    mockInvoke.mockRejectedValue(new Error('journal down'));
    for (let i = 0; i < 5; i++) {
      emitBuffered(missionCompleted());
      await vi.advanceTimersByTimeAsync(0);
    }
    const warnCallsAtTrip = vi.mocked(console.warn).mock.calls.length;

    emitBuffered(missionCompleted());
    emitBuffered(missionCompleted());
    await vi.advanceTimersByTimeAsync(0);

    expect(mockInvoke).toHaveBeenCalledTimes(5);
    expect(vi.mocked(console.warn).mock.calls.length).toBe(warnCallsAtTrip);
  });

  it('a successful flush resets the consecutive-failure counter', async () => {
    mockInvoke.mockRejectedValue(new Error('fail'));
    for (let i = 0; i < 4; i++) {
      emitBuffered(missionCompleted());
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(mockInvoke).toHaveBeenCalledTimes(4);

    mockInvoke.mockResolvedValueOnce(undefined);
    emitBuffered(missionCompleted());
    await vi.advanceTimersByTimeAsync(0);
    expect(mockInvoke).toHaveBeenCalledTimes(5);

    // 4 more consecutive failures must still be attempted — the counter
    // restarted from 0 after the success above, so the breaker has not tripped.
    mockInvoke.mockRejectedValue(new Error('fail again'));
    for (let i = 0; i < 4; i++) {
      emitBuffered(missionCompleted());
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(mockInvoke).toHaveBeenCalledTimes(9);
  });

  it('a hung invoke (never resolves) rejects via its timeout and still counts toward the breaker', async () => {
    // Root-cause regression guard: before this fix, a never-resolving
    // invoke (the contention-window hang) never reached the catch block, so
    // consecutive failures never incremented and the breaker never tripped
    // — the journal just went dark instead of degrading. withTimeout now
    // turns the hang into an ordinary rejection after JOURNAL_INVOKE_TIMEOUT_MS
    // (15s), which flows into this exact same counter/breaker logic.
    mockInvoke.mockImplementation(() => neverResolves());

    for (let i = 0; i < 5; i++) {
      emitBuffered(missionCompleted());
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(mockInvoke).toHaveBeenCalledTimes(5);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('circuit breaker open'),
      expect.anything(),
      expect.anything(),
    );

    // Circuit now open — a 6th event must not even attempt invoke.
    mockInvoke.mockClear();
    emitBuffered(missionCompleted());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

// ── journalQuery ──────────────────────────────────────────────────

describe('journalQuery', () => {
  it('wraps journal_query_events and returns the rows', async () => {
    const rows: JournalEventRow[] = [
      {
        seq: 1,
        ts_ms: 1_000,
        project_id: 'proj-1',
        mission_id: null,
        agent_id: null,
        run_id: null,
        actor: 'user',
        type: 'mission.created',
        payload: '{}',
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
      },
    ];
    mockInvoke.mockResolvedValueOnce(rows);

    const result = await journalQuery({ projectId: 'proj-1', limit: 10 });

    expect(mockInvoke).toHaveBeenCalledWith(
      'journal_query_events',
      expect.objectContaining({ projectId: 'proj-1', limit: 10 }),
    );
    expect(result).toEqual(rows);
  });

  it('returns an empty array (never throws) when invoke rejects', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('down'));

    const result = await journalQuery({ projectId: 'proj-1' });

    expect(result).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it('returns an empty array when invoke resolves a non-array value (e.g. undefined)', async () => {
    // Mirrors the default `mockResolvedValue(undefined)` shape used by
    // src/__tests__/setup.ts's global invoke mock — callers (CockpitKpiBar)
    // iterate the result directly, so journalQuery must never hand back
    // anything other than an array.
    mockInvoke.mockResolvedValueOnce(undefined);

    const result = await journalQuery({ projectId: 'proj-1' });

    expect(result).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it('resolves an empty array (never hangs) when journal_query_events invoke never resolves', async () => {
    mockInvoke.mockImplementationOnce(() => neverResolves());

    const pending = journalQuery({ projectId: 'proj-1' });
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[journal] journalQuery failing — backoff'),
      expect.objectContaining({
        message: expect.stringContaining('journal_query_events timed out after 15000ms'),
      }),
    );
  });
});

// ── journalQuery — failure-streak backoff ──────────────────────────
// REAL INCIDENT regression guard (see journal.ts's file header): while the
// SQLite backend was held by long builds, journal_query_events started
// failing/timing out and every poller (managerWakeup.ts, loopScheduler.ts,
// nightShift.ts, useZoneDigest.ts) kept calling journalQuery on its own
// cadence regardless, producing dozens of warnings in a row against an
// already-saturated backend. These tests pin the fix: a shared,
// module-level cooldown that short-circuits repeat calls instead of
// re-attempting invoke, with exactly one warning per backoff step.

describe('journalQuery — failure-streak backoff', () => {
  it('short-circuits a call made within the cooldown window (no invoke, benign [] result)', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('backend saturated'));

    const first = await journalQuery({ projectId: 'proj-1' });
    expect(first).toEqual([]);
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Still well inside the first 5s cooldown window — must not invoke again.
    await vi.advanceTimersByTimeAsync(1_000);
    const second = await journalQuery({ projectId: 'proj-1' });

    expect(second).toEqual([]);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('doubles the backoff window per consecutive failure and caps it at 120s', async () => {
    mockInvoke.mockRejectedValue(new Error('down'));

    const expectedStepsSeconds = [5, 10, 20, 40, 80, 120]; // 6th would be 160 uncapped

    for (let i = 0; i < expectedStepsSeconds.length; i++) {
      await journalQuery({ projectId: 'proj-1' });
      expect(console.warn).toHaveBeenLastCalledWith(
        expect.stringContaining(`backoff ${expectedStepsSeconds[i]}s (streak ${i + 1})`),
        expect.anything(),
      );
      // Elapse exactly this step's cooldown so the next call is a real attempt again.
      await vi.advanceTimersByTimeAsync(expectedStepsSeconds[i] * 1_000);
    }

    expect(mockInvoke).toHaveBeenCalledTimes(expectedStepsSeconds.length);
  });

  it('a success resets the streak and logs exactly one recovery line', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('down'));
    await journalQuery({ projectId: 'proj-1' });
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000); // cooldown elapses
    mockInvoke.mockResolvedValueOnce([]);
    const result = await journalQuery({ projectId: 'proj-1' });

    expect(result).toEqual([]);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(console.info).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('[journal] journalQuery recovered after 1 failures'),
    );

    // Streak reset: the NEXT failure must restart at 5s, not continue doubling.
    mockInvoke.mockRejectedValueOnce(new Error('down again'));
    await journalQuery({ projectId: 'proj-1' });
    expect(console.warn).toHaveBeenLastCalledWith(
      expect.stringContaining('backoff 5s (streak 1)'),
      expect.anything(),
    );
  });

  it('logs exactly one warning per streak transition, never one per short-circuited call', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('down'));
    await journalQuery({ projectId: 'proj-1' }); // real attempt, fails -> 1 warning
    expect(vi.mocked(console.warn).mock.calls.length).toBe(1);

    // Several more calls land inside the same cooldown window — none of
    // them may invoke the backend or log anything additional.
    await journalQuery({ projectId: 'proj-1' });
    await journalQuery({ projectId: 'proj-1' });
    await journalQuery({ projectId: 'proj-1' });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls.length).toBe(1);
  });
});

// ── Event type coverage — payload shapes stay type-safe per variant ──

describe('event type coverage — payload shapes', () => {
  it('serializes tool.called with files and durationMs', () => {
    const e: JournalEventInput = {
      type: 'tool.called',
      tsMs: 10,
      projectId: 'proj-1',
      actor: 'agent',
      payload: { name: 'Edit', files: ['a.ts'], durationMs: 120 },
    };
    const row = serializeEvent(e);
    expect(JSON.parse(row.payload)).toEqual({ name: 'Edit', files: ['a.ts'], durationMs: 120 });
  });

  it('serializes gate.failed with a reviewer role', () => {
    const e: JournalEventInput = {
      type: 'gate.failed',
      tsMs: 11,
      projectId: 'proj-1',
      actor: 'system',
      payload: { role: 'security', reason: 'hardcoded secret found' },
    };
    const row = serializeEvent(e);
    expect(JSON.parse(row.payload)).toEqual({ role: 'security', reason: 'hardcoded secret found' });
  });

  it('serializes brain.decision_hit', () => {
    const e: JournalEventInput = {
      type: 'brain.decision_hit',
      tsMs: 12,
      projectId: 'proj-1',
      actor: 'manager',
      payload: { decisionId: 'dec-1', question: 'which auth lib?' },
    };
    const row = serializeEvent(e);
    expect(row.type).toBe('brain.decision_hit');
    expect(JSON.parse(row.payload)).toEqual({ decisionId: 'dec-1', question: 'which auth lib?' });
  });
});
