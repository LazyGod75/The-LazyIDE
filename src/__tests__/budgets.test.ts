/**
 * T1.3 — Budget enforcement tests (spec §7.3/§8).
 *
 * Covers:
 *   - classifyBudget (runtime.ts): pure threshold classification.
 *   - planAndActManaged (managedAgent.ts): live per-step enforcement —
 *     0/absent cap = unlimited; pauses once at >=90% (one budget.warning);
 *     stops at >=100% with budget.exceeded + mission.failed reason
 *     'budget_exceeded' when the cap is not raised; resumes normally after
 *     the cap is raised while paused (no re-pause, no exceeded).
 *
 * Session cap (lazy.agents.costLimitUsd) and approve-all are covered in
 * agentsStore.test.tsx (that file's existing addMission/approveMission
 * mocking harness is the natural home — vi.mock is file-scoped/hoisted, and
 * mixing its importOriginal-style mocks with this file's full-replacement
 * managedAgent mocks in one file would be fragile). Orchestrator worktree
 * fallback is covered in orchestratorParallel.test.ts.
 *
 * Mocking harness mirrors managedAgent.test.ts exactly (same module paths,
 * same shapes) — see that file's header comments for rationale.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @tauri-apps/api/core ──────────────────────────────────────
// The global setup.ts already provides a vi.fn() for invoke.
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

import {
  planAndActManaged,
} from '../lib/agents/managedAgent';
import type { PlanStep, ActionEvent } from '../lib/agents/types';
import { streamManagedAgentTurn } from '../lib/models/managedProvider';
import { listAgents } from '../lib/agents/agentsStorage';
import { emitBuffered, emitEvent } from '../lib/journal/journal';
import type { JournalEventInput } from '../lib/journal/eventTypes';
import { classifyBudget, formatBudgetExceededMessage, formatDurationExceededMessage } from '../lib/agents/runtime';

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

/** Cumulative spend.tokens costUsd emitted so far (sum of per-turn deltas). */
function spendSoFar(): number {
  return eventsOfType(mockedEmitBuffered, 'spend.tokens').reduce(
    (sum, e) => sum + (e.payload as { costUsd: number }).costUsd,
    0,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedInvoke.mockResolvedValue(undefined);
  mockedListAgents.mockResolvedValue([]);
  localStorage.clear();
});

// ── classifyBudget (pure) ───────────────────────────────────────────

describe('classifyBudget', () => {
  it('returns "ok" when cap is 0', () => {
    expect(classifyBudget(1000, 0)).toBe('ok');
  });

  it('returns "ok" when cap is undefined', () => {
    expect(classifyBudget(1000, undefined)).toBe('ok');
  });

  it('returns "ok" when cap is negative', () => {
    expect(classifyBudget(1000, -5)).toBe('ok');
  });

  it('returns "ok" below 90%', () => {
    expect(classifyBudget(89, 100)).toBe('ok');
  });

  it('returns "warning" at exactly 90%', () => {
    expect(classifyBudget(90, 100)).toBe('warning');
  });

  it('returns "warning" between 90% and 100%', () => {
    expect(classifyBudget(95, 100)).toBe('warning');
  });

  it('returns "exceeded" at exactly 100%', () => {
    expect(classifyBudget(100, 100)).toBe('exceeded');
  });

  it('returns "exceeded" above 100%', () => {
    expect(classifyBudget(150, 100)).toBe('exceeded');
  });
});

// ── planAndActManaged — budget enforcement (T1.3) ──────────────────

describe('planAndActManaged — budget enforcement (T1.3)', () => {
  it('0 cap never emits budget events — mission completes normally (unlimited)', async () => {
    const readTurn = `THOUGHT: reading\nACTION: read_file\nARGS: {"path": "a.ts"}`;
    const finalTurn = `THOUGHT: done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    let call = 0;
    mockedStream.mockImplementation(() => {
      call += 1;
      return makeStream(call === 1 ? readTurn : finalTurn);
    });
    mockedInvoke.mockResolvedValue('file content');

    const getBudgetCapUsd = vi.fn(() => 0);
    const onBudgetPaused = vi.fn();
    const onBudgetExceeded = vi.fn();

    const opts = makeOpts({ getBudgetCapUsd, onBudgetPaused, onBudgetExceeded });
    await planAndActManaged(opts);

    expect(eventsOfType(mockedEmitBuffered, 'budget.exceeded')).toHaveLength(0);
    expect(eventsOfType(mockedEmitEvent, 'budget.warning')).toHaveLength(0);
    expect(onBudgetPaused).not.toHaveBeenCalled();
    expect(onBudgetExceeded).not.toHaveBeenCalled();
    expect(eventsOfType(mockedEmitBuffered, 'mission.completed')).toHaveLength(1);
  });

  it('absent cap (getBudgetCapUsd omitted) never emits budget events either', async () => {
    const finalTurn = `THOUGHT: done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const opts = makeOpts();
    await planAndActManaged(opts);

    expect(eventsOfType(mockedEmitBuffered, 'budget.exceeded')).toHaveLength(0);
    expect(eventsOfType(mockedEmitEvent, 'budget.warning')).toHaveLength(0);
  });

  it('pauses once at >=90% (one budget.warning, onBudgetPaused called) and stops at 100% with budget.exceeded + mission.failed reason "budget_exceeded" when the cap is not raised', async () => {
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

    // getBudgetCapUsd is engineered relative to OBSERVED cumulative spend
    // (from the real spend.tokens events this run itself emits) rather than
    // a hand-computed dollar figure — this is what makes the test robust
    // regardless of the exact OpenRouter pricing/token-estimate numbers:
    //   - turn 1: cap effectively infinite -> 'ok'.
    //   - turn 2: cap = (spend after turn 2) / 0.92 -> ratio pinned at 0.92
    //     -> 'warning', triggers the pause.
    //   - turn 3+: cap FROZEN at that same value (not recomputed against the
    //     new, larger cumulative) -> turn 3's additional spend on top
    //     necessarily pushes the ratio past 1.0 -> 'exceeded'.
    let capCalls = 0;
    let frozenCap: number | null = null;
    const getBudgetCapUsd = vi.fn(() => {
      capCalls += 1;
      if (capCalls === 1) return 1e9;
      if (capCalls === 2) {
        frozenCap = spendSoFar() / 0.92;
        return frozenCap;
      }
      return frozenCap!;
    });

    // Simulates the real pauseFlags cell: onBudgetPaused (agentsStore.tsx's
    // real implementation) flips it true; a later "resume" (user click, or
    // here just the passage of one poll tick) flips it back false — exactly
    // like resumeMission does, regardless of WHY the mission was paused.
    let paused = false;
    let pausePolls = 0;
    const onBudgetPaused = vi.fn(() => { paused = true; });
    const onBudgetExceeded = vi.fn();
    const pauseSignal = vi.fn(() => {
      if (paused) {
        pausePolls += 1;
        if (pausePolls > 1) paused = false;
      }
      return paused;
    });

    const opts = makeOpts({ getBudgetCapUsd, onBudgetPaused, onBudgetExceeded, pauseSignal });
    await planAndActManaged(opts);

    // Exactly one warning, exactly one pause-trigger, exactly one exceeded.
    const warnings = eventsOfType(mockedEmitEvent, 'budget.warning');
    expect(warnings).toHaveLength(1);
    expect((warnings[0].payload as { pct: number }).pct).toBeGreaterThanOrEqual(90);
    expect((warnings[0].payload as { pct: number }).pct).toBeLessThan(100);
    expect(onBudgetPaused).toHaveBeenCalledTimes(1);

    const exceeded = eventsOfType(mockedEmitBuffered, 'budget.exceeded');
    expect(exceeded).toHaveLength(1);
    expect(onBudgetExceeded).toHaveBeenCalledTimes(1);

    // The mission never reaches FINAL — it is hard-stopped at turn 3.
    expect(mockedStream).toHaveBeenCalledTimes(3);
    expect(eventsOfType(mockedEmitBuffered, 'mission.completed')).toHaveLength(0);
    const failed = eventsOfType(mockedEmitBuffered, 'mission.failed');
    expect(failed).toHaveLength(1);
    expect((failed[0].payload as { reason: string }).reason).toBe('budget_exceeded');

    // Honest timeline: both a pause and a resume announcement fired.
    const texts = actionTexts(opts.onAction as ReturnType<typeof vi.fn>);
    expect(texts.some((t) => t.includes('pause'))).toBe(true);
    expect(texts.some((t) => t.includes('Reprise'))).toBe(true);
  });

  it('resuming after the cap is RAISED (while paused) lets the mission continue to FINAL — no re-pause, no budget.exceeded', async () => {
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

    // Same shape as the previous test through turn 2 (pins ratio at 0.92 to
    // trigger the pause) — but from turn 3 onward the cap is RAISED to a
    // huge number, simulating updateMission({contract:{budgetCapUsd: X}})
    // while the mission sits paused: the cap-raise takes effect on the very
    // next live getBudgetCapUsd() read, same as a real resume-after-raise.
    let capCalls = 0;
    const getBudgetCapUsd = vi.fn(() => {
      capCalls += 1;
      if (capCalls === 1) return 1e9;
      if (capCalls === 2) return spendSoFar() / 0.92;
      return 1e9; // cap raised — comfortably covers everything from here on
    });

    let paused = false;
    let pausePolls = 0;
    const onBudgetPaused = vi.fn(() => { paused = true; });
    const onBudgetExceeded = vi.fn();
    const pauseSignal = vi.fn(() => {
      if (paused) {
        pausePolls += 1;
        if (pausePolls > 1) paused = false;
      }
      return paused;
    });

    const opts = makeOpts({ getBudgetCapUsd, onBudgetPaused, onBudgetExceeded, pauseSignal });
    await planAndActManaged(opts);

    expect(onBudgetPaused).toHaveBeenCalledTimes(1);
    expect(eventsOfType(mockedEmitEvent, 'budget.warning')).toHaveLength(1);
    expect(onBudgetExceeded).not.toHaveBeenCalled();
    expect(eventsOfType(mockedEmitBuffered, 'budget.exceeded')).toHaveLength(0);

    // The mission reaches FINAL normally — all 4 turns streamed, completed.
    expect(mockedStream).toHaveBeenCalledTimes(4);
    expect(eventsOfType(mockedEmitBuffered, 'mission.completed')).toHaveLength(1);
    expect(eventsOfType(mockedEmitBuffered, 'mission.failed')).toHaveLength(0);
  });

  it('still honors stopSignal while paused for budget (stops instead of waiting forever)', async () => {
    const readA = `THOUGHT: t1\nACTION: read_file\nARGS: {"path": "a.ts"}`;
    const readB = `THOUGHT: t2\nACTION: read_file\nARGS: {"path": "b.ts"}`;
    let call = 0;
    mockedStream.mockImplementation(() => {
      call += 1;
      return makeStream(call === 1 ? readA : readB);
    });
    mockedInvoke.mockResolvedValue('file content');

    let capCalls = 0;
    const getBudgetCapUsd = vi.fn(() => {
      capCalls += 1;
      if (capCalls === 1) return 1e9;
      return spendSoFar() / 0.92; // turn 2 -> 'warning', triggers pause
    });

    // pauseSignal/stopSignal start false — the PRE-EXISTING top-of-loop
    // pause check (shared with the user-pause mechanism) must stay clear
    // until the budget check itself decides to pause turn 2; onBudgetPaused
    // flips BOTH flags together (a stop requested while sitting paused for
    // budget — the wait loop must notice stopSignal, not wait forever).
    let paused = false;
    let stopRequested = false;
    const onBudgetPaused = vi.fn(() => {
      paused = true;
      stopRequested = true;
    });
    const pauseSignal = vi.fn(() => paused);
    const stopSignal = vi.fn(() => stopRequested);

    const opts = makeOpts({ getBudgetCapUsd, onBudgetPaused, pauseSignal, stopSignal });
    await planAndActManaged(opts);

    expect(onBudgetPaused).toHaveBeenCalledTimes(1);
    const texts = actionTexts(opts.onAction as ReturnType<typeof vi.fn>);
    expect(texts.some((t) => t.includes('Agent stopped by user'))).toBe(true);
    // Never reached a third turn (still paused/stopped before it).
    expect(mockedStream).toHaveBeenCalledTimes(2);
  });
});

// ── Accounting-logic near-cap trigger (2026-08-19 incident, Fix B) ─────────
//
// The real incident measured five missions overshooting a $5 cap by
// 100%-274% before stopping. Forensics traced this to the NATIVE engine
// (runtime.ts's checkNativeBudget): its cost figure is genuinely post-hoc —
// confirmed against src-tauri/src/commands/agent/{run.rs,protocol.rs},
// cost_usd/input_tokens/output_tokens are populated ONLY from the claude
// CLI's single terminal "result" line (parse_result_usage), never
// incrementally per turn — so for that engine there is no earlier moment to
// check. The MANAGED engine (planAndActManaged) has no such gap: it
// re-evaluates classifyBudgetStatus(costUsdAccum, ...) after EVERY model
// turn, before that turn's tool call executes (managedAgent.ts, ~line
// 1600) — this suite proves that check trips at the FIRST turn to cross the
// cap, never several unchecked turns later.
describe('planAndActManaged — near-cap trigger, not a large overshoot (Fix B accounting)', () => {
  it('stops on the FIRST turn that crosses the cap — later turns and FINAL never run (checked every turn, not at a coarse per-mission boundary)', async () => {
    const turnA = `THOUGHT: t1\nACTION: read_file\nARGS: {"path": "a.ts"}`;
    const turnB = `THOUGHT: t2\nACTION: read_file\nARGS: {"path": "b.ts"}`;
    const turnC = `THOUGHT: t3\nACTION: read_file\nARGS: {"path": "c.ts"}`;
    const turnD = `THOUGHT: t4\nACTION: read_file\nARGS: {"path": "d.ts"}`;
    const finalTurn = `THOUGHT: done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    let call = 0;
    mockedStream.mockImplementation(() => {
      call += 1;
      if (call === 1) return makeStream(turnA);
      if (call === 2) return makeStream(turnB);
      if (call === 3) return makeStream(turnC);
      if (call === 4) return makeStream(turnD);
      return makeStream(finalTurn);
    });
    mockedInvoke.mockResolvedValue('file content');

    // Cap frozen at turn 1's own cost alone, captured the instant it's
    // known (turn 1's own check runs right after turn 1's spend is
    // charged) — so cumulative spend crosses it starting at turn 2.
    let capCalls = 0;
    let frozenCap: number | null = null;
    const getBudgetCapUsd = vi.fn(() => {
      capCalls += 1;
      if (capCalls === 1) {
        frozenCap = spendSoFar();
        return 1e9; // turn 1 itself still passes under this call
      }
      return frozenCap!;
    });

    const opts = makeOpts({ getBudgetCapUsd });
    await planAndActManaged(opts);

    // Turn 2 trips it — turns 3, 4, and FINAL never run. If the check were
    // coarse (e.g. once per mission, like the incident's native-engine gap),
    // all 5 turns would have streamed before anything noticed the cap.
    expect(mockedStream).toHaveBeenCalledTimes(2);
    const exceeded = eventsOfType(mockedEmitBuffered, 'budget.exceeded');
    expect(exceeded).toHaveLength(1);
    const { capUsd, spentUsd } = exceeded[0].payload as { capUsd: number; spentUsd: number };
    expect(spentUsd).toBeGreaterThan(capUsd);
    // Overshoot bounded to ONE extra turn's cost on top of the cap — nowhere
    // near the incident's real-world 100%-274% accumulated over an entire
    // unchecked mission.
    expect(spentUsd).toBeLessThan(capUsd * 3);
  });
});

// ── formatBudgetExceededMessage / formatDurationExceededMessage (Fix C) ────
//
// 2026-08-19 incident: the stop message used to be a hardcoded, always-false
// "100% of the cap reached" — the real incident measured five missions
// stopping between 100% and 274% over a $5 cap, every single one reported
// as "100%". These functions replace that literal with the REAL measured
// spend/cap and a COMPUTED percentage.
//
// Fix D (2026-08-19 dollar-kill incident, display half): this message is now
// ONLY ever reached for a real-money rail (managed or BYOK — see
// checkNativeBudget's `isNativeRail` branch, which exempts the native/
// subscription rail entirely before budgetExceeded is ever set), and is
// rendered in CREDITS ("1 credit == 1 USD cent" — usdToCredits) rather than
// a raw dollar figure, matching every other real-spend surface in this app.
describe('formatBudgetExceededMessage (Fix C — honest stop message, Fix D — credits)', () => {
  it('reports the real spend, the real cap, and the real percentage in credits — never a hardcoded 100%', () => {
    const { text, reason } = formatBudgetExceededMessage(13.69, 5, undefined);
    expect(text).toContain('1369');
    expect(text).toContain('500');
    expect(text).toContain('274%');
    expect(reason).toContain('1369');
    expect(reason).toContain('500');
    expect(reason).toContain('274%');
    expect(text).not.toContain('100%');
    expect(text).not.toContain('$');
  });

  it('computes a DISTINCT percentage for each of the incident\'s five real missions — never a fixed 100%', () => {
    const cases: Array<[spentUsd: number, capUsd: number, expectedPct: number, expectedSpentCredits: number]> = [
      [5.02, 5, 100, 502],
      [6.77, 5, 135, 677],
      [7.75, 5, 155, 775],
      [8.17, 5, 163, 817],
      [13.69, 5, 274, 1369],
    ];
    for (const [spent, cap, expectedPct, expectedSpentCredits] of cases) {
      const { reason } = formatBudgetExceededMessage(spent, cap, undefined);
      expect(reason).toContain(`${expectedPct}%`);
      expect(reason).toContain(String(expectedSpentCredits));
      expect(reason).toContain('500'); // cap: $5 -> 500 credits, every case
    }
  });

  it('passes {spentCredits, capCredits, pct} to a supplied translate function, keyed on agents.runtime.budgetExceededStop/Reason', () => {
    const t = vi.fn((key: string) => key);
    formatBudgetExceededMessage(13.69, 5, t as unknown as Parameters<typeof formatBudgetExceededMessage>[2]);
    expect(t).toHaveBeenCalledWith('agents.runtime.budgetExceededStop', { spentCredits: 1369, capCredits: 500, pct: 274 });
    expect(t).toHaveBeenCalledWith('agents.runtime.budgetExceededReason', { spentCredits: 1369, capCredits: 500, pct: 274 });
  });

  it('a 0/undefined cap never divides by zero — percentage reads 0, never NaN/Infinity', () => {
    expect(formatBudgetExceededMessage(10, 0, undefined).reason).toContain('0%');
  });
});

describe('formatDurationExceededMessage (Fix C twin — wall-clock cap)', () => {
  it('reports real elapsed minutes, real cap minutes, and the real percentage', () => {
    const { reason } = formatDurationExceededMessage(15 * 60_000, 10 * 60_000, undefined);
    expect(reason).toContain('15.0');
    expect(reason).toContain('10.0');
    expect(reason).toContain('150%');
  });
});
