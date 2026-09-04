/**
 * Tests for managerWakeup.ts — the LazyManager proactive event wakeup.
 *
 * Two layers:
 *   1. Pure functions (classifyWakeupEvent, isEchoOfManagerTurn,
 *      checkHourlyCap) — plain fixtures, no timers, no store.
 *   2. The stateful scheduler (startManagerWakeupScheduler) — fake timers,
 *      exercising debounce coalescing, the hourly cap, echo suppression,
 *      "never wake while busy" + bounded retry, and the on/off toggle.
 *      The final describe block is the requested integration test: a
 *      mission-terminal event triggers exactly one wakeup call into a
 *      mocked manager turn.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyWakeupEvent,
  isEchoOfManagerTurn,
  checkHourlyCap,
  startManagerWakeupScheduler,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_ECHO_SUPPRESS_MS,
  FLEET_HYGIENE_SIGNIFICANT_TOTAL,
  WAKEUP_POLL_MS,
  pickWakeupTargetConversationId,
  isCriticalWakeupKind,
  type WakeupJournalRow,
  type WakeupCandidate,
  type ManagerWakeupConfig,
  type ManagerWakeupDeps,
} from '../lib/agents/managerWakeup';
import type { JournalEventType } from '../lib/journal/eventTypes';

function row(overrides: Partial<Omit<WakeupJournalRow, 'type'>> & { type: JournalEventType; ts_ms: number }): WakeupJournalRow {
  return { mission_id: null, payload: '{}', ...overrides };
}

// ── classifyWakeupEvent ──────────────────────────────────────────────────

describe('classifyWakeupEvent', () => {
  // Defect C2: mission.completed is no longer significant on its own — the
  // pipeline's own judge verdict always follows for that mission, and the
  // canvas already shows completion (see classifyWakeupEvent's own doc
  // comment for the full rationale).
  it('ignores mission.completed — no longer a wakeup trigger on its own', () => {
    expect(classifyWakeupEvent(row({ type: 'mission.completed', ts_ms: 1000, mission_id: 'M1' }))).toBeNull();
  });

  // LazyBot ≠ agent: no judge verdict ever follows a Solari bot run, so its
  // completion is the ONLY moment the manager can relay the bot's answer
  // (live QA 2026-09-02: the page title the user asked for never reached
  // the conversation).
  it('classifies lazybot.completed as bot_completed, carrying the bot name and its report', () => {
    const candidate = classifyWakeupEvent(
      row({
        type: 'lazybot.completed',
        ts_ms: 1500,
        mission_id: 'M96',
        payload: JSON.stringify({ botId: 'bot_1', botName: 'SolariTest', report: 'Title: Example Domain' }),
      }),
    );
    expect(candidate).toEqual({
      kind: 'bot_completed',
      tsMs: 1500,
      missionId: 'M96',
      botName: 'SolariTest',
      report: 'Title: Example Domain',
    });
  });

  it('classifies brain.ops_orphan as critical brain_ops_orphan (E106)', () => {
    const candidate = classifyWakeupEvent(
      row({
        type: 'brain.ops_orphan',
        ts_ms: 1600,
        payload: JSON.stringify({ phase: 'timed_out', step: 'dream', detail: 'dream killed after 600s' }),
      }),
    );
    expect(candidate).toEqual({
      kind: 'brain_ops_orphan',
      tsMs: 1600,
      opsStep: 'dream',
      opsDetail: 'dream killed after 600s',
    });
  });

  it('classifies a failed mission as mission_failed, carrying the real reason', () => {
    const candidate = classifyWakeupEvent(
      row({ type: 'mission.failed', ts_ms: 2000, mission_id: 'M2', payload: JSON.stringify({ reason: 'tests broke' }) }),
    );
    expect(candidate).toEqual({ kind: 'mission_failed', tsMs: 2000, missionId: 'M2', reason: 'tests broke' });
  });

  it('classifies a merge as merge_landed', () => {
    const candidate = classifyWakeupEvent(row({ type: 'mission.approved', ts_ms: 3000, mission_id: 'M3' }));
    expect(candidate?.kind).toBe('merge_landed');
  });

  it('classifies a blocked approval as approve_blocked with its reason', () => {
    const candidate = classifyWakeupEvent(
      row({ type: 'mission.approve_blocked', ts_ms: 4000, mission_id: 'M4', payload: JSON.stringify({ reason: 'missing proof' }) }),
    );
    expect(candidate).toEqual({ kind: 'approve_blocked', tsMs: 4000, missionId: 'M4', reason: 'missing proof' });
  });

  it('classifies gate.passed / gate.failed as review verdicts ONLY for the judge role', () => {
    const passed = classifyWakeupEvent(row({ type: 'gate.passed', ts_ms: 5000, mission_id: 'M5', payload: JSON.stringify({ role: 'judge' }) }));
    const failed = classifyWakeupEvent(row({ type: 'gate.failed', ts_ms: 6000, mission_id: 'M6', payload: JSON.stringify({ role: 'judge' }) }));
    expect(passed).toEqual({ kind: 'review_passed', tsMs: 5000, missionId: 'M5', role: 'judge' });
    expect(failed).toEqual({ kind: 'review_failed', tsMs: 6000, missionId: 'M6', role: 'judge' });
  });

  // Defect C2 (real founder repro): tester/reviewer/security/judge each emit
  // their OWN gate event for the same mission — waking on all four turned
  // one real verdict into four near-identical wakeups. Only the judge's gate
  // event (which already aggregates every other role's input) counts.
  it('ignores gate.passed / gate.failed from non-judge roles (tester, reviewer, security)', () => {
    for (const role of ['tester', 'reviewer', 'security']) {
      expect(
        classifyWakeupEvent(row({ type: 'gate.passed', ts_ms: 5000, mission_id: 'M5', payload: JSON.stringify({ role }) })),
      ).toBeNull();
      expect(
        classifyWakeupEvent(row({ type: 'gate.failed', ts_ms: 6000, mission_id: 'M6', payload: JSON.stringify({ role }) })),
      ).toBeNull();
    }
  });

  it('classifies a chain firing as chain_fired with the real target ref', () => {
    const candidate = classifyWakeupEvent(
      row({ type: 'chain.fired', ts_ms: 7000, mission_id: 'M7', payload: JSON.stringify({ targetRef: 'draft:abc' }) }),
    );
    expect(candidate).toEqual({ kind: 'chain_fired', tsMs: 7000, missionId: 'M7', targetRef: 'draft:abc' });
  });

  it('ignores mission.cancelled — not in the founder-specified significant set', () => {
    expect(classifyWakeupEvent(row({ type: 'mission.cancelled', ts_ms: 8000, mission_id: 'M8' }))).toBeNull();
  });

  it('ignores an unrelated event type (e.g. mission.step)', () => {
    expect(classifyWakeupEvent(row({ type: 'mission.step', ts_ms: 9000, mission_id: 'M9' }))).toBeNull();
  });

  it('ignores a fleet.hygiene sweep below the significant-total threshold', () => {
    const small = classifyWakeupEvent(
      row({ type: 'fleet.hygiene', ts_ms: 10_000, payload: JSON.stringify({ archived: 1, purged: 1, deduped: 0 }) }),
    );
    expect(small).toBeNull();
  });

  it('surfaces a fleet.hygiene sweep at/above the significant-total threshold', () => {
    const big = classifyWakeupEvent(
      row({
        type: 'fleet.hygiene',
        ts_ms: 11_000,
        payload: JSON.stringify({ archived: FLEET_HYGIENE_SIGNIFICANT_TOTAL, purged: 0, deduped: 0 }),
      }),
    );
    expect(big).toEqual({ kind: 'fleet_hygiene', tsMs: 11_000, hygieneTotal: FLEET_HYGIENE_SIGNIFICANT_TOTAL });
  });

  it('never throws on a malformed payload string', () => {
    expect(() => classifyWakeupEvent(row({ type: 'mission.failed', ts_ms: 1, mission_id: 'M1', payload: '{not json' }))).not.toThrow();
  });
});

// ── isEchoOfManagerTurn ──────────────────────────────────────────────────

describe('isEchoOfManagerTurn', () => {
  it('is false before any manager turn has ever ended (sentinel 0)', () => {
    expect(isEchoOfManagerTurn(1_000_000, 0, DEFAULT_ECHO_SUPPRESS_MS)).toBe(false);
  });

  it('is true for an event landing just after a manager turn ended', () => {
    const turnEndedAt = 1_000_000;
    expect(isEchoOfManagerTurn(turnEndedAt + 1_000, turnEndedAt, DEFAULT_ECHO_SUPPRESS_MS)).toBe(true);
  });

  it('is true at the exact boundary of the echo window', () => {
    const turnEndedAt = 1_000_000;
    expect(isEchoOfManagerTurn(turnEndedAt + DEFAULT_ECHO_SUPPRESS_MS, turnEndedAt, DEFAULT_ECHO_SUPPRESS_MS)).toBe(true);
  });

  it('is false once the echo window has elapsed', () => {
    const turnEndedAt = 1_000_000;
    expect(isEchoOfManagerTurn(turnEndedAt + DEFAULT_ECHO_SUPPRESS_MS + 1, turnEndedAt, DEFAULT_ECHO_SUPPRESS_MS)).toBe(false);
  });

  it('is false for an event that happened BEFORE the manager turn ended', () => {
    const turnEndedAt = 1_000_000;
    expect(isEchoOfManagerTurn(turnEndedAt - 1, turnEndedAt, DEFAULT_ECHO_SUPPRESS_MS)).toBe(false);
  });
});

// ── checkHourlyCap ───────────────────────────────────────────────────────

describe('checkHourlyCap', () => {
  it('allows firing when under the cap', () => {
    const { allowed } = checkHourlyCap([1, 2, 3], 1_000_000, 6);
    expect(allowed).toBe(true);
  });

  it('disallows firing once the cap is reached', () => {
    const now = 10_000_000;
    const timestamps = [now - 1000, now - 2000, now - 3000, now - 4000, now - 5000, now - 6000];
    const { allowed } = checkHourlyCap(timestamps, now, 6);
    expect(allowed).toBe(false);
  });

  it('prunes timestamps older than one hour before checking', () => {
    const now = 10_000_000;
    const HOUR_MS = 60 * 60 * 1000;
    const stale = [now - HOUR_MS - 1, now - HOUR_MS - 2];
    const { allowed, pruned } = checkHourlyCap(stale, now, 1);
    expect(pruned).toEqual([]);
    expect(allowed).toBe(true);
  });
});

// ── Stateful scheduler ───────────────────────────────────────────────────

function makeConfig(overrides: Partial<ManagerWakeupConfig> = {}): ManagerWakeupConfig {
  return {
    enabled: true,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    maxAutoTurnsPerHour: 6,
    echoSuppressMs: DEFAULT_ECHO_SUPPRESS_MS,
    ...overrides,
  };
}

interface Harness {
  deps: ManagerWakeupDeps;
  sendWakeupTurn: ReturnType<typeof vi.fn>;
  fetchEventsSince: ReturnType<typeof vi.fn>;
  isManagerBusy: ReturnType<typeof vi.fn>;
  config: ManagerWakeupConfig;
}

function makeHarness(configOverrides: Partial<ManagerWakeupConfig> = {}): Harness {
  const config = makeConfig(configOverrides);
  const sendWakeupTurn = vi.fn().mockResolvedValue(undefined);
  const fetchEventsSince = vi.fn().mockResolvedValue([]);
  const isManagerBusy = vi.fn().mockReturnValue(false);
  const deps: ManagerWakeupDeps = {
    fetchEventsSince,
    isManagerBusy,
    sendWakeupTurn,
    formatWakeupText: (candidates) => `wakeup: ${candidates.map((c) => c.kind).join(',')}`,
    getConfig: () => config,
  };
  return { deps, sendWakeupTurn, fetchEventsSince, isManagerBusy, config };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startManagerWakeupScheduler — debounce coalescing', () => {
  it('coalesces a burst of significant events within the debounce window into exactly ONE wakeup call', async () => {
    const { deps, sendWakeupTurn } = makeHarness();
    const handle = startManagerWakeupScheduler(deps);

    handle.ingestRows([row({ type: 'mission.failed', ts_ms: Date.now(), mission_id: 'M1' })]);
    await vi.advanceTimersByTimeAsync(30_000);
    handle.ingestRows([row({ type: 'mission.approved', ts_ms: Date.now(), mission_id: 'M2' })]);
    await vi.advanceTimersByTimeAsync(30_000);
    handle.ingestRows([
      row({ type: 'gate.passed', ts_ms: Date.now(), mission_id: 'M3', payload: JSON.stringify({ role: 'judge' }) }),
    ]);

    // Still within 90s of the LAST event — must not have fired yet.
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS - 1);
    expect(sendWakeupTurn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(sendWakeupTurn).toHaveBeenCalledTimes(1);
    const [, candidates] = sendWakeupTurn.mock.calls[0] as [string, WakeupCandidate[]];
    expect(candidates.map((c) => c.missionId)).toEqual(['M1', 'M2', 'M3']);

    handle.stop();
  });

  it('fires a separate turn for a second batch that arrives after the first one settled', async () => {
    const { deps, sendWakeupTurn } = makeHarness();
    const handle = startManagerWakeupScheduler(deps);

    handle.ingestRows([row({ type: 'mission.approved', ts_ms: Date.now(), mission_id: 'M1' })]);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(sendWakeupTurn).toHaveBeenCalledTimes(1);

    handle.ingestRows([row({ type: 'mission.approved', ts_ms: Date.now(), mission_id: 'M2' })]);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(sendWakeupTurn).toHaveBeenCalledTimes(2);

    handle.stop();
  });
});

describe('pickWakeupTargetConversationId', () => {
  const conv = (id: string, busy: boolean, lastActiveAt: number) => ({ id, busy, lastActiveAt });

  it('prefers the origin conversation when it is idle', () => {
    const state = {
      conversationOrder: ['a', 'b'],
      conversations: { a: conv('a', false, 1), b: conv('b', false, 9) },
    };
    expect(pickWakeupTargetConversationId(state, 'a')).toBe('a');
  });

  it('does not dump a wakeup onto a different conversation when the origin is busy', () => {
    const state = {
      conversationOrder: ['a', 'b'],
      conversations: { a: conv('a', true, 9), b: conv('b', false, 1) },
    };
    expect(pickWakeupTargetConversationId(state, 'a')).toBeUndefined();
  });

  it('falls back to the most recently active idle conversation when no origin is given', () => {
    const state = {
      conversationOrder: ['a', 'b'],
      conversations: { a: conv('a', false, 1), b: conv('b', false, 9) },
    };
    expect(pickWakeupTargetConversationId(state)).toBe('b');
  });
});

describe('isCriticalWakeupKind', () => {
  it('treats bot completion, mission failure, blocked approval, and brain ops orphan as critical', () => {
    expect(isCriticalWakeupKind('bot_completed')).toBe(true);
    expect(isCriticalWakeupKind('mission_failed')).toBe(true);
    expect(isCriticalWakeupKind('approve_blocked')).toBe(true);
    expect(isCriticalWakeupKind('brain_ops_orphan')).toBe(true);
    expect(isCriticalWakeupKind('fleet_hygiene')).toBe(false);
  });
});

describe('startManagerWakeupScheduler — hourly cap', () => {
  it('drops further significant events once the configured cap is reached this hour', async () => {
    const { deps, sendWakeupTurn } = makeHarness({ maxAutoTurnsPerHour: 2 });
    const handle = startManagerWakeupScheduler(deps);

    for (let i = 0; i < 3; i++) {
      handle.ingestRows([row({ type: 'mission.approved', ts_ms: Date.now(), mission_id: `M${i}` })]);
      await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    }

    expect(sendWakeupTurn).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('still fires a critical bot_completed event once the hourly cap is reached', async () => {
    const { deps, sendWakeupTurn } = makeHarness({ maxAutoTurnsPerHour: 1 });
    const handle = startManagerWakeupScheduler(deps);

    handle.ingestRows([row({ type: 'mission.approved', ts_ms: Date.now(), mission_id: 'M1' })]);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(sendWakeupTurn).toHaveBeenCalledTimes(1);

    handle.ingestRows([
      row({
        type: 'lazybot.completed',
        ts_ms: Date.now(),
        mission_id: 'M2',
        payload: JSON.stringify({ botName: 'SolariTest', report: 'Title: Example Domain' }),
      }),
    ]);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(sendWakeupTurn).toHaveBeenCalledTimes(2);
    const [, candidates] = sendWakeupTurn.mock.calls[1] as [string, WakeupCandidate[]];
    expect(candidates.map((c) => c.kind)).toEqual(['bot_completed']);

    handle.stop();
  });

  it('recovers capacity once the sliding hour window rolls forward', async () => {
    const { deps, sendWakeupTurn } = makeHarness({ maxAutoTurnsPerHour: 1 });
    const handle = startManagerWakeupScheduler(deps);

    handle.ingestRows([row({ type: 'mission.approved', ts_ms: Date.now(), mission_id: 'M1' })]);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(sendWakeupTurn).toHaveBeenCalledTimes(1);

    // Still inside the same hour — capped.
    handle.ingestRows([row({ type: 'mission.approved', ts_ms: Date.now(), mission_id: 'M2' })]);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(sendWakeupTurn).toHaveBeenCalledTimes(1);

    // Past the hour mark — capacity recovered.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    handle.ingestRows([row({ type: 'mission.approved', ts_ms: Date.now(), mission_id: 'M3' })]);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(sendWakeupTurn).toHaveBeenCalledTimes(2);

    handle.stop();
  });
});

describe('startManagerWakeupScheduler — echo suppression', () => {
  it('never arms a wakeup for an event that lands within the echo window of a manager turn ending', async () => {
    const { deps, sendWakeupTurn } = makeHarness();
    const handle = startManagerWakeupScheduler(deps);

    handle.notifyManagerTurnEnded(Date.now());
    await vi.advanceTimersByTimeAsync(5_000); // well inside the 30s echo window
    handle.ingestRows([row({ type: 'mission.approved', ts_ms: Date.now(), mission_id: 'M1' })]);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS + 5_000);

    expect(sendWakeupTurn).not.toHaveBeenCalled();
    handle.stop();
  });

  it('arms a wakeup normally once the echo window has elapsed', async () => {
    const { deps, sendWakeupTurn } = makeHarness();
    const handle = startManagerWakeupScheduler(deps);

    handle.notifyManagerTurnEnded(Date.now());
    await vi.advanceTimersByTimeAsync(DEFAULT_ECHO_SUPPRESS_MS + 1_000);
    handle.ingestRows([row({ type: 'mission.approved', ts_ms: Date.now(), mission_id: 'M1' })]);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);

    expect(sendWakeupTurn).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});

describe('startManagerWakeupScheduler — never wakes while a manager turn is running', () => {
  it('defers the fire (bounded retry) while busy, then fires once the manager frees up', async () => {
    const { deps, sendWakeupTurn, isManagerBusy } = makeHarness();
    isManagerBusy.mockReturnValue(true);
    const handle = startManagerWakeupScheduler(deps);

    handle.ingestRows([row({ type: 'mission.approved', ts_ms: Date.now(), mission_id: 'M1' })]);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(sendWakeupTurn).not.toHaveBeenCalled(); // still busy at fire time

    isManagerBusy.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(60_000); // busy-retry cadence
    expect(sendWakeupTurn).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('gives up after the bounded number of busy retries rather than retrying forever', async () => {
    const { deps, sendWakeupTurn, isManagerBusy } = makeHarness();
    isManagerBusy.mockReturnValue(true);
    const handle = startManagerWakeupScheduler(deps);

    handle.ingestRows([row({ type: 'mission.approved', ts_ms: Date.now(), mission_id: 'M1' })]);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    // Exhaust every bounded retry while still busy.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sendWakeupTurn).not.toHaveBeenCalled();

    // Manager frees up AFTER the batch was already given up — no stale fire.
    isManagerBusy.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sendWakeupTurn).not.toHaveBeenCalled();

    handle.stop();
  });

  it('keeps retrying a critical bot_completed batch after the ordinary busy-retry budget', async () => {
    const { deps, sendWakeupTurn, isManagerBusy } = makeHarness();
    isManagerBusy.mockReturnValue(true);
    const handle = startManagerWakeupScheduler(deps);

    handle.ingestRows([
      row({
        type: 'lazybot.completed',
        ts_ms: Date.now(),
        mission_id: 'M9',
        payload: JSON.stringify({ botName: 'SolariTest', report: 'done' }),
      }),
    ]);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sendWakeupTurn).not.toHaveBeenCalled();

    isManagerBusy.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendWakeupTurn).toHaveBeenCalledTimes(1);

    handle.stop();
  });
});

describe('startManagerWakeupScheduler — on/off toggle', () => {
  it('never arms or fires while disabled, and resumes normally once re-enabled', async () => {
    const config = makeConfig({ enabled: false });
    const sendWakeupTurn = vi.fn().mockResolvedValue(undefined);
    const deps: ManagerWakeupDeps = {
      fetchEventsSince: vi.fn().mockResolvedValue([]),
      isManagerBusy: () => false,
      sendWakeupTurn,
      formatWakeupText: () => 'wakeup',
      getConfig: () => config,
    };
    const handle = startManagerWakeupScheduler(deps);

    handle.ingestRows([row({ type: 'mission.approved', ts_ms: Date.now(), mission_id: 'M1' })]);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS * 2);
    expect(sendWakeupTurn).not.toHaveBeenCalled();

    config.enabled = true;
    handle.ingestRows([row({ type: 'mission.approved', ts_ms: Date.now(), mission_id: 'M2' })]);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(sendWakeupTurn).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('cancels a pending debounced batch cleanly when disabled mid-window', async () => {
    const config = makeConfig();
    const sendWakeupTurn = vi.fn().mockResolvedValue(undefined);
    const deps: ManagerWakeupDeps = {
      fetchEventsSince: vi.fn().mockResolvedValue([]),
      isManagerBusy: () => false,
      sendWakeupTurn,
      formatWakeupText: () => 'wakeup',
      getConfig: () => config,
    };
    const handle = startManagerWakeupScheduler(deps);

    handle.ingestRows([row({ type: 'mission.approved', ts_ms: Date.now(), mission_id: 'M1' })]);
    await vi.advanceTimersByTimeAsync(10_000);
    config.enabled = false;
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);

    expect(sendWakeupTurn).not.toHaveBeenCalled();
    handle.stop();
  });
});

describe('startManagerWakeupScheduler — real poll loop (integration)', () => {
  it('a mission-terminal event returned by fetchEventsSince triggers exactly ONE wakeup call into a mocked manager turn', async () => {
    const sendWakeupTurn = vi.fn().mockResolvedValue(undefined);
    const config = makeConfig();
    let served = false;
    const fetchEventsSince = vi.fn().mockImplementation(async () => {
      if (served) return [];
      served = true;
      return [row({ type: 'mission.approved', ts_ms: Date.now(), mission_id: 'M42' })];
    });
    const deps: ManagerWakeupDeps = {
      fetchEventsSince,
      isManagerBusy: () => false,
      sendWakeupTurn,
      formatWakeupText: (candidates) => `wakeup: ${candidates.map((c) => c.missionId).join(',')}`,
      getConfig: () => config,
    };

    const handle = startManagerWakeupScheduler(deps);

    // Let the immediate boot poll (called synchronously in start()) resolve.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchEventsSince).toHaveBeenCalledTimes(1);

    // Debounce settles — the mission-terminal event fires exactly once.
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(sendWakeupTurn).toHaveBeenCalledTimes(1);
    expect(sendWakeupTurn).toHaveBeenCalledWith('wakeup: M42', [expect.objectContaining({ kind: 'merge_landed', missionId: 'M42' })]);

    // A subsequent poll (no new rows) must never re-fire the same event.
    await vi.advanceTimersByTimeAsync(WAKEUP_POLL_MS * 3);
    expect(sendWakeupTurn).toHaveBeenCalledTimes(1);

    handle.stop();
  });
});
