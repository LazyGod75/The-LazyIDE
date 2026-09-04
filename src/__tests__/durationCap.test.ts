/**
 * W-GUARD — Wall-clock cap enforcement tests (mirrors budgets.test.ts
 * exactly, same mocking harness, same shapes — see that file's header for
 * the full rationale).
 *
 * Covers:
 *   - classifyDuration (runtime.ts): pure threshold classification.
 *   - armDurationExceededTimer (runtime.ts): the native engine's real timer
 *     — fires onExceeded at the cap, never fires when unset, and a cleared
 *     timer never fires (no leak / no kill-after-natural-completion).
 *   - planAndActManaged (managedAgent.ts): live per-step enforcement —
 *     0/absent cap = unlimited; pauses once at >=90% (one duration.warning);
 *     stops at >=100% with duration.exceeded + mission.failed reason
 *     'duration_exceeded' when not resumed past the cap.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock @tauri-apps/api/core ──────────────────────────────────────
import { invoke } from '@tauri-apps/api/core';

// ── Mock managedProvider's streamManagedAgentTurn ─────────────────
vi.mock('../lib/models/managedProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/managedProvider')>();
  return {
    ...actual,
    streamManagedAgentTurn: vi.fn(),
  };
});

// ── Mock platform (brain recall) ──────────────────────────────────
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

// ── Mock brain/context helpers ────────────────────────────────────
vi.mock('../lib/brain/context', () => ({
  normalizeRecall: vi.fn((r: unknown) => r),
  buildPromptBrainContext: vi.fn(() => ''),
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

// ── Mock agentsStorage's listAgents (persona resolution by agentName) ─────
vi.mock('../lib/agents/agentsStorage', () => ({
  listAgents: vi.fn().mockResolvedValue([]),
}));

// ── Mock the journal client ────────────────────────────────────────
vi.mock('../lib/journal/journal', () => ({
  emitBuffered: vi.fn(),
  emitEvent: vi.fn(),
}));

import { planAndActManaged } from '../lib/agents/managedAgent';
import type { PlanStep, ActionEvent } from '../lib/agents/types';
import { streamManagedAgentTurn } from '../lib/models/managedProvider';
import { listAgents } from '../lib/agents/agentsStorage';
import { emitBuffered, emitEvent } from '../lib/journal/journal';
import type { JournalEventInput } from '../lib/journal/eventTypes';
import { classifyDuration, armDurationExceededTimer } from '../lib/agents/runtime';

// ── Helpers ───────────────────────────────────────────────────────

const mockedStream = streamManagedAgentTurn as ReturnType<typeof vi.fn>;
const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedListAgents = listAgents as ReturnType<typeof vi.fn>;
const mockedEmitBuffered = emitBuffered as ReturnType<typeof vi.fn>;
const mockedEmitEvent = emitEvent as ReturnType<typeof vi.fn>;

/** Creates an async generator that yields a single text chunk. */
async function* makeStream(text: string): AsyncIterable<string> {
  yield text;
}

function makeSteps(): PlanStep[] {
  return [
    { label: 'Initialisation', state: 'todo' as const },
    { label: 'Analyse', state: 'todo' as const },
    { label: 'Implémentation', state: 'todo' as const },
    { label: 'Tests', state: 'todo' as const },
    { label: 'Diff', state: 'todo' as const },
  ];
}

function makeOpts(overrides: Partial<Parameters<typeof planAndActManaged>[0]> = {}) {
  const onStep = vi.fn();
  const onAction = vi.fn();
  const onProgress = vi.fn();
  const stopSignal = vi.fn(() => false);

  return {
    missionId: 'test-mission-1',
    missionTitle: 'Test task',
    worktreePath: '/tmp/wt/test',
    steps: makeSteps(),
    onStep,
    onAction,
    onProgress,
    stopSignal,
    model: 'anthropic/claude-sonnet-5',
    ...overrides,
  };
}

function actionTexts(onAction: ReturnType<typeof vi.fn>): string[] {
  return onAction.mock.calls.map((c: unknown[]) => (c[0] as ActionEvent).text);
}

function eventsOfType(mock: ReturnType<typeof vi.fn>, type: string): JournalEventInput[] {
  return mock.mock.calls
    .map((c: unknown[]) => c[0] as JournalEventInput)
    .filter((e) => e.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedInvoke.mockResolvedValue(undefined);
  mockedListAgents.mockResolvedValue([]);
  localStorage.clear();
});

// ── classifyDuration (pure) ─────────────────────────────────────────

describe('classifyDuration', () => {
  it('returns "ok" when cap is 0', () => {
    expect(classifyDuration(1000, 0)).toBe('ok');
  });

  it('returns "ok" when cap is undefined', () => {
    expect(classifyDuration(1000, undefined)).toBe('ok');
  });

  it('returns "ok" when cap is negative', () => {
    expect(classifyDuration(1000, -5)).toBe('ok');
  });

  it('returns "ok" below 90%', () => {
    expect(classifyDuration(89, 100)).toBe('ok');
  });

  it('returns "warning" at exactly 90%', () => {
    expect(classifyDuration(90, 100)).toBe('warning');
  });

  it('returns "exceeded" at exactly 100%', () => {
    expect(classifyDuration(100, 100)).toBe('exceeded');
  });

  it('returns "exceeded" above 100%', () => {
    expect(classifyDuration(150, 100)).toBe('exceeded');
  });
});

// ── armDurationExceededTimer (native engine's real timer) ───────────

describe('armDurationExceededTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onExceeded exactly at maxDurationMs', () => {
    const onExceeded = vi.fn();
    armDurationExceededTimer(10_000, onExceeded);

    vi.advanceTimersByTime(9_999);
    expect(onExceeded).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onExceeded).toHaveBeenCalledTimes(1);
  });

  it('never arms a timer when maxDurationMs is unset (undefined/0/negative) — onExceeded never fires', () => {
    const onExceeded = vi.fn();
    armDurationExceededTimer(undefined, onExceeded);
    armDurationExceededTimer(0, onExceeded);
    armDurationExceededTimer(-5, onExceeded);

    vi.advanceTimersByTime(1_000_000);
    expect(onExceeded).not.toHaveBeenCalled();
  });

  it('clear() cancels the pending timer — onExceeded never fires (no kill-after-natural-completion)', () => {
    const onExceeded = vi.fn();
    const { clear } = armDurationExceededTimer(10_000, onExceeded);

    vi.advanceTimersByTime(5_000);
    clear(); // mission completed naturally before the cap
    vi.advanceTimersByTime(10_000);

    expect(onExceeded).not.toHaveBeenCalled();
  });

  it('clear() on an unset cap (no-op timer) never throws', () => {
    const { clear } = armDurationExceededTimer(undefined, vi.fn());
    expect(() => clear()).not.toThrow();
  });
});

// ── planAndActManaged — duration enforcement (W-GUARD) ──────────────

describe('planAndActManaged — wall-clock cap enforcement (W-GUARD)', () => {
  beforeEach(() => {
    // Only Date is faked (vi.setSystemTime simulates elapsed wall-clock
    // across turns) — setTimeout stays REAL so the pause-poll wait loop
    // (managedAgent.ts's `await delay(PAUSE_POLL_MS)`) actually resolves
    // instead of hanging forever under a fully-faked clock.
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('unset cap (getMaxDurationMs omitted) never emits duration events — mission completes normally', async () => {
    const finalTurn = `THOUGHT: done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const opts = makeOpts();
    await planAndActManaged(opts);

    expect(eventsOfType(mockedEmitBuffered, 'duration.exceeded')).toHaveLength(0);
    expect(eventsOfType(mockedEmitEvent, 'duration.warning')).toHaveLength(0);
    expect(eventsOfType(mockedEmitBuffered, 'mission.completed')).toHaveLength(1);
  });

  it('0 cap never emits duration events either (explicit unlimited)', async () => {
    const finalTurn = `THOUGHT: done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const getMaxDurationMs = vi.fn(() => 0);
    const opts = makeOpts({ getMaxDurationMs });
    await planAndActManaged(opts);

    expect(eventsOfType(mockedEmitBuffered, 'duration.exceeded')).toHaveLength(0);
    expect(eventsOfType(mockedEmitEvent, 'duration.warning')).toHaveLength(0);
  });

  it('pauses once at >=90% elapsed (one duration.warning, onDurationPaused called) and stops at 100% with duration.exceeded + mission.failed reason "duration_exceeded"', async () => {
    const readA = `THOUGHT: t1\nACTION: read_file\nARGS: {"path": "a.ts"}`;
    const readB = `THOUGHT: t2\nACTION: read_file\nARGS: {"path": "b.ts"}`;
    const readC = `THOUGHT: t3\nACTION: read_file\nARGS: {"path": "c.ts"}`;
    const finalTurn = `THOUGHT: done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    let call = 0;
    mockedStream.mockImplementation(() => {
      call += 1;
      if (call === 1) return makeStream(readA);
      if (call === 2) return makeStream(readB);
      if (call === 3) return makeStream(readC);
      return makeStream(finalTurn);
    });
    mockedInvoke.mockResolvedValue('file content');

    // Fake the clock advancing across turns: 0ms, then 9_100ms (91% of a
    // 10_000ms cap -> 'warning'), then 10_100ms (101% -> 'exceeded').
    let now = 0;
    vi.setSystemTime(now);
    mockedStream.mockImplementation(() => {
      call += 1;
      if (call === 1) { now = 0; vi.setSystemTime(now); return makeStream(readA); }
      if (call === 2) { now = 9_100; vi.setSystemTime(now); return makeStream(readB); }
      if (call === 3) { now = 10_100; vi.setSystemTime(now); return makeStream(readC); }
      return makeStream(finalTurn);
    });

    const getMaxDurationMs = vi.fn(() => 10_000);

    let paused = false;
    let pausePolls = 0;
    const onDurationPaused = vi.fn(() => { paused = true; });
    const onDurationExceeded = vi.fn();
    const pauseSignal = vi.fn(() => {
      if (paused) {
        pausePolls += 1;
        if (pausePolls > 1) paused = false;
      }
      return paused;
    });

    const opts = makeOpts({ getMaxDurationMs, onDurationPaused, onDurationExceeded, pauseSignal });
    await planAndActManaged(opts);

    const warnings = eventsOfType(mockedEmitEvent, 'duration.warning');
    expect(warnings).toHaveLength(1);
    expect((warnings[0].payload as { pct: number }).pct).toBeGreaterThanOrEqual(90);
    expect((warnings[0].payload as { pct: number }).pct).toBeLessThan(100);
    expect(onDurationPaused).toHaveBeenCalledTimes(1);

    const exceeded = eventsOfType(mockedEmitBuffered, 'duration.exceeded');
    expect(exceeded).toHaveLength(1);
    expect(onDurationExceeded).toHaveBeenCalledTimes(1);

    expect(eventsOfType(mockedEmitBuffered, 'mission.completed')).toHaveLength(0);
    const failed = eventsOfType(mockedEmitBuffered, 'mission.failed');
    expect(failed).toHaveLength(1);
    expect((failed[0].payload as { reason: string }).reason).toBe('duration_exceeded');

    const texts = actionTexts(opts.onAction as ReturnType<typeof vi.fn>);
    expect(texts.some((t) => t.includes('pause'))).toBe(true);
    expect(texts.some((t) => t.includes('Reprise'))).toBe(true);
  });

  it('still honors stopSignal while paused for duration (stops instead of waiting forever)', async () => {
    const readA = `THOUGHT: t1\nACTION: read_file\nARGS: {"path": "a.ts"}`;
    const readB = `THOUGHT: t2\nACTION: read_file\nARGS: {"path": "b.ts"}`;
    let call = 0;
    let now = 0;
    vi.setSystemTime(now);
    mockedStream.mockImplementation(() => {
      call += 1;
      if (call === 1) { now = 0; vi.setSystemTime(now); return makeStream(readA); }
      now = 9_500; vi.setSystemTime(now);
      return makeStream(readB);
    });
    mockedInvoke.mockResolvedValue('file content');

    const getMaxDurationMs = vi.fn(() => 10_000);

    let paused = false;
    let stopRequested = false;
    const onDurationPaused = vi.fn(() => {
      paused = true;
      stopRequested = true;
    });
    const pauseSignal = vi.fn(() => paused);
    const stopSignal = vi.fn(() => stopRequested);

    const opts = makeOpts({ getMaxDurationMs, onDurationPaused, pauseSignal, stopSignal });
    await planAndActManaged(opts);

    expect(onDurationPaused).toHaveBeenCalledTimes(1);
    const texts = actionTexts(opts.onAction as ReturnType<typeof vi.fn>);
    expect(texts.some((t) => t.includes('Agent stopped by user'))).toBe(true);
    expect(mockedStream).toHaveBeenCalledTimes(2);
  });
});
