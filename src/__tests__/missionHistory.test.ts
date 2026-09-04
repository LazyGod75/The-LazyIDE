/* missionHistory.test.ts — src/lib/journal/missionHistory.ts's pure derivations.

   Every case builds synthetic JournalEventRow fixtures directly (no invoke,
   no journalQuery) — the module under test has zero I/O, so these are pure
   input/output assertions against real event-vocabulary shapes (eventTypes.ts).
*/

import { describe, it, expect } from 'vitest';
import {
  buildMissionRunHistory,
  buildProjectArchive,
  currentGenerationEvents,
  deriveChainFires,
  deriveStageSpans,
  deriveTerminalType,
  deriveTokenAggregate,
  groupEventsByMission,
  splitMissionGenerations,
} from '../lib/journal/missionHistory';
import type { JournalEventRow, JournalEventType } from '../lib/journal/eventTypes';

let seqCounter = 0;

function row(
  type: JournalEventType,
  tsMs: number,
  payload: Record<string, unknown> = {},
  overrides: Partial<JournalEventRow> = {},
): JournalEventRow {
  seqCounter += 1;
  return {
    seq: seqCounter,
    ts_ms: tsMs,
    project_id: 'proj-1',
    mission_id: 'm-1',
    agent_id: null,
    run_id: null,
    actor: 'system',
    type,
    payload: JSON.stringify(payload),
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    ...overrides,
  };
}

describe('deriveStageSpans', () => {
  it('returns [] for an empty event list', () => {
    expect(deriveStageSpans([])).toEqual([]);
  });

  it('derives a plan span from created->started, open-ended when never started', () => {
    const events = [row('mission.created', 1_000, { title: 'X' })];
    const spans = deriveStageSpans(events);
    expect(spans).toEqual([{ stage: 'plan', startMs: 1_000, endMs: null }]);
  });

  it('closes the plan span at mission.started and opens a code span', () => {
    const events = [
      row('mission.created', 1_000, { title: 'X' }),
      row('mission.started', 2_000, { model: 'sonnet' }),
    ];
    const spans = deriveStageSpans(events);
    expect(spans).toEqual([
      { stage: 'plan', startMs: 1_000, endMs: 2_000 },
      { stage: 'code', startMs: 2_000, endMs: null },
    ]);
  });

  it('closes the code span at the first gate.* event and adds a test span spanning all gate events', () => {
    const events = [
      row('mission.created', 1_000, { title: 'X' }),
      row('mission.started', 2_000, { model: 'sonnet' }),
      row('gate.passed', 5_000, { role: 'tester', score: 90 }),
      row('gate.passed', 5_500, { role: 'reviewer', score: 85 }),
      row('gate.failed', 6_000, { role: 'security', reason: 'x' }),
    ];
    const spans = deriveStageSpans(events);
    expect(spans).toContainEqual({ stage: 'code', startMs: 2_000, endMs: 5_000 });
    expect(spans).toContainEqual({ stage: 'test', startMs: 5_000, endMs: 6_000 });
  });

  it('never fabricates a review span when mission.review_requested was never emitted', () => {
    const events = [
      row('mission.created', 1_000, {}),
      row('mission.started', 2_000, {}),
      row('mission.completed', 9_000, {}),
    ];
    const spans = deriveStageSpans(events);
    expect(spans.some((s) => s.stage === 'review')).toBe(false);
  });

  it('derives a review span from review_requested to the terminal event', () => {
    const events = [
      row('mission.created', 1_000, {}),
      row('mission.started', 2_000, {}),
      row('mission.review_requested', 7_000, { proofCount: 1 }),
      row('mission.approved', 8_000, { approvedBy: 'david' }),
    ];
    const spans = deriveStageSpans(events);
    expect(spans).toContainEqual({ stage: 'review', startMs: 7_000, endMs: 8_000 });
  });

  it('adds a zero-width merged marker only for a SUCCESS terminal event (completed/approved)', () => {
    const events = [row('mission.created', 1_000, {}), row('mission.completed', 5_000, { durationMs: 4000 })];
    const spans = deriveStageSpans(events);
    expect(spans).toContainEqual({ stage: 'merged', startMs: 5_000, endMs: 5_000 });
  });

  it('does NOT add a merged marker for a failure terminal event', () => {
    const events = [row('mission.created', 1_000, {}), row('mission.started', 2_000, {}), row('mission.failed', 5_000, { reason: 'boom' })];
    const spans = deriveStageSpans(events);
    expect(spans.some((s) => s.stage === 'merged')).toBe(false);
  });

  it('leaves the review span open (endMs null) while awaiting a terminal decision', () => {
    const events = [
      row('mission.created', 1_000, {}),
      row('mission.started', 2_000, {}),
      row('mission.review_requested', 7_000, { proofCount: 1 }),
    ];
    const spans = deriveStageSpans(events);
    expect(spans).toContainEqual({ stage: 'review', startMs: 7_000, endMs: null });
  });

  it('sorts out-of-order input rows before deriving (defensive — real journal rows arrive by seq)', () => {
    const events = [
      row('mission.started', 2_000, {}),
      row('mission.created', 1_000, {}),
    ];
    // Force seq to disagree with insertion order to prove sorting is by seq, not array order.
    events[0].seq = 5;
    events[1].seq = 1;
    const spans = deriveStageSpans(events);
    expect(spans[0]).toEqual({ stage: 'plan', startMs: 1_000, endMs: 2_000 });
  });
});

describe('deriveTokenAggregate', () => {
  it('reports source "unknown" and zeroed totals when no spend.tokens event exists', () => {
    const agg = deriveTokenAggregate([row('mission.started', 1_000, {})]);
    expect(agg).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0, source: 'unknown' });
  });

  it('sums tokens/cost across multiple spend.tokens events and reports the shared source', () => {
    const events = [
      row('spend.tokens', 1_000, { tokensIn: 100, tokensOut: 50, costUsd: 0.01, source: 'real' }, { tokens_in: 100, tokens_out: 50, cost_usd: 0.01 }),
      row('spend.tokens', 2_000, { tokensIn: 200, tokensOut: 80, costUsd: 0.02, source: 'real' }, { tokens_in: 200, tokens_out: 80, cost_usd: 0.02 }),
    ];
    const agg = deriveTokenAggregate(events);
    expect(agg).toEqual({ tokensIn: 300, tokensOut: 130, costUsd: 0.03, source: 'real' });
  });

  it('reports "mixed" when spend.tokens events disagree on source', () => {
    const events = [
      row('spend.tokens', 1_000, { tokensIn: 100, tokensOut: 50, costUsd: 0.01, source: 'estimated' }, { tokens_in: 100, tokens_out: 50, cost_usd: 0.01 }),
      row('spend.tokens', 2_000, { tokensIn: 100, tokensOut: 50, costUsd: 0.012, source: 'settled' }, { tokens_in: 100, tokens_out: 50, cost_usd: 0.012 }),
    ];
    const agg = deriveTokenAggregate(events);
    expect(agg.source).toBe('mixed');
  });
});

describe('deriveChainFires', () => {
  it('extracts chain.fired/pending_cross_project/resumed rows in chronological (seq) order', () => {
    const events = [
      row(
        'chain.fired',
        3_000,
        { chainId: 'c1', sourceMissionId: 'm-1', targetRef: 'draft:d1', projectId: 'proj-1' },
        { seq: 2 },
      ),
      row(
        'chain.pending_cross_project',
        1_000,
        { chainId: 'c2', sourceMissionId: 'm-1', targetRef: 'draft:d2', projectId: 'proj-2' },
        { seq: 1 },
      ),
    ];
    const fires = deriveChainFires(events);
    expect(fires.map((f) => f.kind)).toEqual(['pending_cross_project', 'fired']);
    expect(fires[1]).toMatchObject({ chainId: 'c1', sourceMissionId: 'm-1', targetRef: 'draft:d1' });
  });

  it('skips a chain event row whose payload is missing a required field rather than fabricating it', () => {
    const events = [row('chain.fired', 1_000, { chainId: 'c1' /* missing sourceMissionId/targetRef */ })];
    expect(deriveChainFires(events)).toEqual([]);
  });
});

describe('deriveTerminalType', () => {
  it('is null while no terminal event has been observed', () => {
    expect(deriveTerminalType([row('mission.started', 1_000, {})])).toBeNull();
  });

  it('reports the first terminal event type encountered', () => {
    const events = [row('mission.started', 1_000, {}), row('mission.failed', 2_000, { reason: 'x' })];
    expect(deriveTerminalType(events)).toBe('mission.failed');
  });
});

describe('buildMissionRunHistory', () => {
  it('composes events/stageSpans/tokens/chainFires/terminalType/duration for one mission', () => {
    const events = [
      row('mission.created', 1_000, { title: 'Fix the bug' }),
      row('mission.started', 2_000, {}),
      row('mission.completed', 10_000, { durationMs: 8000 }),
    ];
    const history = buildMissionRunHistory('m-1', events);
    expect(history.missionId).toBe('m-1');
    expect(history.startedAtMs).toBe(1_000);
    expect(history.durationMs).toBe(9_000);
    expect(history.terminalType).toBe('mission.completed');
    expect(history.stageSpans.length).toBeGreaterThan(0);
    expect(history.tokens.source).toBe('unknown');
    expect(history.chainFires).toEqual([]);
  });

  it('has a null duration while the mission has no terminal event yet', () => {
    const history = buildMissionRunHistory('m-1', [row('mission.created', 1_000, {}), row('mission.started', 2_000, {})]);
    expect(history.durationMs).toBeNull();
  });
});

describe('groupEventsByMission / buildProjectArchive', () => {
  it('groups rows by mission_id and drops rows with no mission_id', () => {
    const events = [
      row('mission.created', 1_000, { title: 'A' }, { mission_id: 'm-a' }),
      row('mission.created', 1_000, { title: 'B' }, { mission_id: 'm-b' }),
      row('project.opened', 500, { root: '/repo' }, { mission_id: null }),
    ];
    const grouped = groupEventsByMission(events);
    expect([...grouped.keys()].sort()).toEqual(['m-a', 'm-b']);
  });

  it('builds one archive entry per mission, newest-first by last event, with title/terminal/duration/cost', () => {
    const events = [
      row('mission.created', 1_000, { title: 'Older mission' }, { mission_id: 'm-old' }),
      row('mission.completed', 2_000, {}, { mission_id: 'm-old' }),
      row('mission.created', 5_000, { title: 'Newer mission' }, { mission_id: 'm-new' }),
      row(
        'spend.tokens',
        6_000,
        { tokensIn: 10, tokensOut: 5, costUsd: 0.5, source: 'real' },
        { mission_id: 'm-new', tokens_in: 10, tokens_out: 5, cost_usd: 0.5 },
      ),
      row('mission.failed', 7_000, { reason: 'x' }, { mission_id: 'm-new' }),
    ];
    const archive = buildProjectArchive(events);
    expect(archive.map((e) => e.missionId)).toEqual(['m-new', 'm-old']);
    expect(archive[0]).toMatchObject({
      title: 'Newer mission',
      terminalType: 'mission.failed',
      durationMs: 2_000,
      costUsd: 0.5,
    });
    expect(archive[1]).toMatchObject({ title: 'Older mission', terminalType: 'mission.completed', durationMs: 1_000 });
  });

  it('reports title: null when mission.created was never observed for that id (e.g. legacy-imported row)', () => {
    const events = [row('mission.started', 1_000, {}, { mission_id: 'm-legacy' })];
    const archive = buildProjectArchive(events);
    expect(archive[0].title).toBeNull();
  });
});

// ── MAJEUR (R3 dogfood): mission-id recycling corrupts history ────────────
// Mission ids (M1..Mn per project) get RECYCLED across unrelated runs — a
// fresh mission can mint the same id an older, long-finished mission once
// used. Real repro: today's M9 (still in review) showed July-11 M9's Gantt
// («142h», duration 508381s, $1.077) and the Rapport showed "Terminée" / "1
// mergée aujourd'hui" for a mission that was NOT done. These fixtures
// reproduce that exact two-generation shape.

const JULY_11 = new Date(2026, 6, 11, 9, 0, 0).getTime();
const JULY_11_DONE = JULY_11 + 508_381_000; // ~142h later — matches the real Gantt evidence
// Safely after JULY_11_DONE (508_381s ≈ 5.9 days later than JULY_11) so the
// two generations never chronologically interleave — "today" here is
// whatever point after the old generation's own completion a fresh mission
// reused this id, not a literal calendar day.
const TODAY_9AM = JULY_11_DONE + 3_600_000;

/** July-11 generation of "M9": created, ran, completed successfully — a
 *  fully finished, unrelated mission that happens to have reused the id. */
function july11GenerationEvents(): JournalEventRow[] {
  return [
    row('mission.created', JULY_11, { title: 'July 11: fix the old bug' }, { mission_id: 'M9' }),
    row('mission.started', JULY_11 + 1_000, { model: 'sonnet' }, { mission_id: 'M9' }),
    row(
      'spend.tokens',
      JULY_11 + 2_000,
      { tokensIn: 4000, tokensOut: 1500, costUsd: 1.077, source: 'real' },
      { mission_id: 'M9', tokens_in: 4000, tokens_out: 1500, cost_usd: 1.077 },
    ),
    row('mission.completed', JULY_11_DONE, {}, { mission_id: 'M9' }),
  ];
}

/** Today's generation of "M9": a brand new, unrelated mission that reused
 *  the same id — created today, still in review, NOT terminal. */
function todayInReviewGenerationEvents(): JournalEventRow[] {
  return [
    row('mission.created', TODAY_9AM, { title: 'Today: refactor the new thing' }, { mission_id: 'M9' }),
    row('mission.started', TODAY_9AM + 1_000, { model: 'sonnet' }, { mission_id: 'M9' }),
    row('mission.review_requested', TODAY_9AM + 2_000, { proofCount: 1 }, { mission_id: 'M9' }),
  ];
}

describe('splitMissionGenerations', () => {
  it('returns a single generation when mission.created was observed only once (the common case)', () => {
    const events = [
      row('mission.created', 1_000, {}, { mission_id: 'M1' }),
      row('mission.started', 2_000, {}, { mission_id: 'M1' }),
    ];
    const generations = splitMissionGenerations(events);
    expect(generations).toHaveLength(1);
    expect(generations[0].generation).toBe(0);
    expect(generations[0].events).toHaveLength(2);
  });

  it('returns a single generation (no boundary to split on) when mission.created was never observed', () => {
    const events = [row('mission.started', 1_000, {}, { mission_id: 'm-legacy' })];
    expect(splitMissionGenerations(events)).toHaveLength(1);
  });

  it('splits the exact July-11/today two-generation shape into two distinct generations, oldest first', () => {
    const combined = [...july11GenerationEvents(), ...todayInReviewGenerationEvents()];
    const generations = splitMissionGenerations(combined);

    expect(generations).toHaveLength(2);
    expect(generations[0].generation).toBe(0);
    expect(generations[0].events.every((e) => e.ts_ms < TODAY_9AM)).toBe(true);
    expect(generations[1].generation).toBe(1);
    expect(generations[1].events.every((e) => e.ts_ms >= TODAY_9AM)).toBe(true);
  });

  it('splits correctly regardless of input ARRAY order (defensive — sorts by seq internally, matching real journal order)', () => {
    // Build in true chronological order first (so each row's seq — assigned
    // at construction time, like the real journal's auto-increment — agrees
    // with its ts_ms), THEN shuffle only the array position: a caller can
    // hand rows in any order, but seq (not array position) is the source of
    // truth for "real journal order" (see sortedAsc's doc comment).
    const chronological = [...july11GenerationEvents(), ...todayInReviewGenerationEvents()];
    const shuffled = [...chronological].reverse();
    const generations = splitMissionGenerations(shuffled);
    expect(generations).toHaveLength(2);
    expect(generations[0].events[0].type).toBe('mission.created');
    expect(generations[0].events[0].ts_ms).toBe(JULY_11);
    expect(generations[1].events[0].ts_ms).toBe(TODAY_9AM);
  });
});

describe('currentGenerationEvents', () => {
  it('scopes a flat multi-generation, multi-mission event list down to ONE id\'s CURRENT generation only', () => {
    const otherMission = [row('mission.created', 500, {}, { mission_id: 'M-other' })];
    const combined = [...july11GenerationEvents(), ...otherMission, ...todayInReviewGenerationEvents()];

    const current = currentGenerationEvents(combined, 'M9');

    // Only today's generation — never July 11's completed/spend.tokens rows,
    // never the unrelated M-other mission.
    expect(current.every((e) => e.mission_id === 'M9')).toBe(true);
    expect(current.every((e) => e.ts_ms >= TODAY_9AM)).toBe(true);
    expect(current.some((e) => e.type === 'mission.completed')).toBe(false);
  });

  it('returns [] for a mission id with no events at all', () => {
    expect(currentGenerationEvents(july11GenerationEvents(), 'M-nonexistent')).toEqual([]);
  });
});

describe('buildMissionRunHistory — generation scoping (MAJEUR fix)', () => {
  it('reflects ONLY the current (today, in-review) generation in every headline field — never July 11\'s terminal/duration/tokens', () => {
    const combined = [...july11GenerationEvents(), ...todayInReviewGenerationEvents()];
    const history = buildMissionRunHistory('M9', combined);

    // The exact MAJEUR bug: terminalType/durationMs/tokens must NOT leak in
    // from July 11's completed generation.
    expect(history.terminalType).toBeNull();
    expect(history.durationMs).toBeNull();
    expect(history.tokens).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0, source: 'unknown' });
    expect(history.startedAtMs).toBe(TODAY_9AM);
    expect(history.events.every((e) => e.ts_ms >= TODAY_9AM)).toBe(true);
  });

  it('lists July 11\'s finished generation under previousGenerations, honestly separated — never blended into the current fields', () => {
    const combined = [...july11GenerationEvents(), ...todayInReviewGenerationEvents()];
    const history = buildMissionRunHistory('M9', combined);

    expect(history.previousGenerations).toHaveLength(1);
    expect(history.previousGenerations[0]).toMatchObject({
      missionId: 'M9',
      generation: 0,
      title: 'July 11: fix the old bug',
      terminalType: 'mission.completed',
      durationMs: 508_381_000,
      costUsd: 1.077,
    });
  });

  it('has an empty previousGenerations when the id has never been reused (the common case)', () => {
    const history = buildMissionRunHistory('m-1', [
      row('mission.created', 1_000, { title: 'X' }),
      row('mission.completed', 2_000, {}),
    ]);
    expect(history.previousGenerations).toEqual([]);
  });
});

describe('buildProjectArchive — one row per (missionId, generation), never blended (MAJEUR fix)', () => {
  it('produces TWO separate, honest rows for a recycled id — July 11 (Terminée) and today (still in review, no fabricated status)', () => {
    const combined = [...july11GenerationEvents(), ...todayInReviewGenerationEvents()];
    const archive = buildProjectArchive(combined);

    const m9Rows = archive.filter((e) => e.missionId === 'M9');
    expect(m9Rows).toHaveLength(2);

    const july11Row = m9Rows.find((e) => e.generation === 0);
    const todayRow = m9Rows.find((e) => e.generation === 1);

    expect(july11Row).toMatchObject({ title: 'July 11: fix the old bug', terminalType: 'mission.completed' });
    // The exact MAJEUR bug: today's still-in-review generation must NEVER
    // report July 11's terminal status.
    expect(todayRow).toMatchObject({ title: 'Today: refactor the new thing', terminalType: null });
  });
});
