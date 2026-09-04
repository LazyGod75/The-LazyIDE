/* estimator.test.ts — pre-launch mission quotes (src/lib/agents/estimator.ts).

   Covers:
   1. sizeClassOf: monotonic with task length/verbs and with scope breadth.
   2. modelTierOf: native ids (pattern), OpenRouter ids (catalog tier),
      unknown ids (safe fallback).
   3. quote(): ranges monotonic with size class, tier scales cost, and
      orchestrator raises agent count + cost.
   4. History blend: >=5 comparable journal samples shift the quoted range;
      fewer than 5 leaves the pure heuristic untouched.
   5. defaultBudgetCapUsd: 3x the quote's cost upper bound.

   journalQuery (src/lib/journal/journal.ts) is mocked directly rather than
   the underlying Tauri invoke — estimator.ts only ever calls journalQuery,
   never invoke itself.
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sizeClassOf,
  sizeClassRank,
  modelTierOf,
  quote,
  defaultBudgetCapUsd,
  SIZE_CLASSES,
  type SizeClass,
  type MissionQuote,
} from '../lib/agents/estimator';
import { journalQuery } from '../lib/journal/journal';
import type { JournalEventRow } from '../lib/journal/eventTypes';

vi.mock('../lib/journal/journal', () => ({
  journalQuery: vi.fn(),
}));

const mockJournalQuery = vi.mocked(journalQuery);

beforeEach(() => {
  mockJournalQuery.mockReset();
  mockJournalQuery.mockResolvedValue([]);
});

// ── Fixtures ──────────────────────────────────────────────────────────

const XS_TEXT = 'Fix typo.';
const S_TEXT = 'Add a small loading spinner icon to the login form footer area nicely.';
const M_TEXT =
  'Add pagination and update the API client, then refactor the missions list component for the new schema.';
const L_TEXT =
  'Refactor the auth module: extract validators, add tests, update callers, migrate the token storage, and document the new flow across the package.';
const BROAD_SCOPE = ['src/lib/agents/', 'src/components/agents/'];

function createdRow(missionId: string, title: string): JournalEventRow {
  return {
    seq: 0,
    ts_ms: 0,
    project_id: 'proj-1',
    mission_id: missionId,
    agent_id: null,
    run_id: null,
    actor: 'user',
    type: 'mission.created',
    payload: JSON.stringify({ title }),
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  };
}

function completedRow(missionId: string, costUsd: number, durationMs: number): JournalEventRow {
  return {
    seq: 0,
    ts_ms: 0,
    project_id: 'proj-1',
    mission_id: missionId,
    agent_id: null,
    run_id: null,
    actor: 'system',
    type: 'mission.completed',
    payload: JSON.stringify({ costUsd, durationMs }),
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  };
}

// ── sizeClassOf ───────────────────────────────────────────────────────

describe('sizeClassOf', () => {
  it('is monotonic with task length + action-verb density', () => {
    const ranks = [XS_TEXT, S_TEXT, M_TEXT, L_TEXT].map((t) => sizeClassRank(sizeClassOf(t)));
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
    }
  });

  it('is monotonic with scope breadth: the same text never gets smaller with more/broader scope', () => {
    const noScope = sizeClassRank(sizeClassOf(L_TEXT));
    const withScope = sizeClassRank(sizeClassOf(L_TEXT, BROAD_SCOPE));
    expect(withScope).toBeGreaterThanOrEqual(noScope);
  });

  it('adding scope paths never decreases the size class, for a fixed text', () => {
    const oneNarrowPath = sizeClassRank(sizeClassOf(M_TEXT, ['src/lib/agents/estimator.ts']));
    const twoBroadPaths = sizeClassRank(
      sizeClassOf(M_TEXT, ['src/lib/agents/estimator.ts', ...BROAD_SCOPE]),
    );
    expect(twoBroadPaths).toBeGreaterThanOrEqual(oneNarrowPath);
  });

  it('an empty task with no scope classifies as the smallest bucket', () => {
    expect(sizeClassOf('')).toBe('xs');
  });

  it('covers the full size-class range across the fixtures used in this file', () => {
    // Sanity check that the fixtures above actually exercise distinct
    // buckets rather than clustering into one or two — guards against the
    // monotonicity assertions above passing vacuously.
    const distinctClasses = new Set(
      [XS_TEXT, S_TEXT, M_TEXT, L_TEXT].map((t) => sizeClassOf(t)),
    );
    expect(distinctClasses.size).toBeGreaterThanOrEqual(3);
  });
});

// ── modelTierOf ───────────────────────────────────────────────────────

describe('modelTierOf', () => {
  it('classifies native Anthropic ids by naming pattern', () => {
    expect(modelTierOf('claude-haiku-4-5')).toBe('cheap');
    expect(modelTierOf('claude-sonnet-5')).toBe('standard');
    expect(modelTierOf('claude-opus-5')).toBe('premium');
    expect(modelTierOf('claude-fable-5')).toBe('premium');
  });

  it('classifies OpenRouter ids via the curated catalog tier', () => {
    expect(modelTierOf('anthropic/claude-haiku-4.5')).toBe('cheap'); // tier: fast
    expect(modelTierOf('anthropic/claude-sonnet-5')).toBe('standard'); // tier: balanced
    expect(modelTierOf('anthropic/claude-opus-5')).toBe('premium'); // tier: max
    expect(modelTierOf('deepseek/deepseek-v4-flash')).toBe('cheap'); // tier: fast
    // V4 Pro moved max -> fast in the 2026-08-08 curation: at $0.44/$0.87 it
    // is cheaper than every 'fast' model it used to sit above.
    expect(modelTierOf('deepseek/deepseek-v4-pro')).toBe('cheap'); // tier: fast
    expect(modelTierOf('moonshotai/kimi-k3')).toBe('premium'); // tier: max
  });

  it('falls back to standard for unrecognized ids', () => {
    expect(modelTierOf('some-unknown-future-model')).toBe('standard');
  });
});

// ── quote() ───────────────────────────────────────────────────────────

describe('quote', () => {
  it('cost and duration ranges are monotonic with size class', async () => {
    const texts = [XS_TEXT, S_TEXT, M_TEXT, L_TEXT];
    const quotes: MissionQuote[] = [];
    for (const text of texts) {
      quotes.push(await quote(text, { model: 'claude-sonnet-5' }));
    }

    for (let i = 1; i < quotes.length; i++) {
      expect(quotes[i].costUsd[0]).toBeGreaterThanOrEqual(quotes[i - 1].costUsd[0]);
      expect(quotes[i].costUsd[1]).toBeGreaterThanOrEqual(quotes[i - 1].costUsd[1]);
      expect(quotes[i].durationMin[0]).toBeGreaterThanOrEqual(quotes[i - 1].durationMin[0]);
      expect(quotes[i].durationMin[1]).toBeGreaterThanOrEqual(quotes[i - 1].durationMin[1]);
    }
    // At least one strict increase somewhere, or the fixtures aren't
    // actually exercising different size classes.
    expect(quotes[quotes.length - 1].costUsd[1]).toBeGreaterThan(quotes[0].costUsd[1]);
  });

  it('every range has lo <= hi', async () => {
    const q = await quote(M_TEXT, { model: 'claude-sonnet-5' });
    expect(q.costUsd[0]).toBeLessThanOrEqual(q.costUsd[1]);
    expect(q.durationMin[0]).toBeLessThanOrEqual(q.durationMin[1]);
  });

  it('scales cost with model tier: cheap < standard < premium for the same task', async () => {
    const cheap = await quote(M_TEXT, { model: 'claude-haiku-4-5' });
    const standard = await quote(M_TEXT, { model: 'claude-sonnet-5' });
    const premium = await quote(M_TEXT, { model: 'claude-opus-5' });

    expect(cheap.costUsd[1]).toBeLessThan(standard.costUsd[1]);
    expect(standard.costUsd[1]).toBeLessThan(premium.costUsd[1]);
  });

  it('orchestrator raises the agent count above 1, for every size class', async () => {
    for (const text of [XS_TEXT, S_TEXT, M_TEXT, L_TEXT]) {
      const solo = await quote(text, { model: 'claude-sonnet-5', orchestrator: false });
      const withOrchestrator = await quote(text, { model: 'claude-sonnet-5', orchestrator: true });
      expect(solo.agents).toBe(1);
      expect(withOrchestrator.agents).toBeGreaterThan(1);
    }
  });

  it('orchestrator raises the cost range vs. a solo run of the same task', async () => {
    const solo = await quote(M_TEXT, { model: 'claude-sonnet-5' });
    const withOrchestrator = await quote(M_TEXT, { model: 'claude-sonnet-5', orchestrator: true });
    expect(withOrchestrator.costUsd[1]).toBeGreaterThan(solo.costUsd[1]);
  });

  it('is defensive: a rejected journalQuery still resolves to a pure-heuristic quote', async () => {
    mockJournalQuery.mockRejectedValue(new Error('journal unreachable'));
    const q = await quote(M_TEXT, { model: 'claude-sonnet-5' });
    expect(q.costUsd[0]).toBeGreaterThan(0);
    expect(q.agents).toBe(1);
  });

  // ── History blend ─────────────────────────────────────────────────

  it('blends journal history into the range once >=5 comparable samples exist', async () => {
    const baseline = await quote(M_TEXT, { model: 'claude-sonnet-5' });

    const rows: JournalEventRow[] = [];
    // Pick a historical cost/duration comfortably inside the heuristic
    // range but off-center, so the blended bounds visibly shift from the
    // pure-heuristic baseline (blendRange clamps median +/-40% into the
    // heuristic range — a median near an edge would clamp back to that
    // same edge and the shift wouldn't be observable).
    const historicalCost = baseline.costUsd[0] + (baseline.costUsd[1] - baseline.costUsd[0]) * 0.65;
    const historicalDurationMin =
      baseline.durationMin[0] + (baseline.durationMin[1] - baseline.durationMin[0]) * 0.65;

    for (let i = 0; i < 6; i++) {
      const missionId = `hist-${i}`;
      rows.push(createdRow(missionId, M_TEXT));
      rows.push(completedRow(missionId, historicalCost, historicalDurationMin * 60_000));
    }
    mockJournalQuery.mockResolvedValue(rows);

    const blended = await quote(M_TEXT, { model: 'claude-sonnet-5' });

    expect(blended).not.toEqual(baseline);
    expect(blended.costUsd[0]).toBeGreaterThanOrEqual(baseline.costUsd[0]);
    expect(blended.costUsd[1]).toBeLessThanOrEqual(baseline.costUsd[1]);
  });

  it('ignores journal history below the 5-sample threshold', async () => {
    const baseline = await quote(M_TEXT, { model: 'claude-sonnet-5' });

    const rows: JournalEventRow[] = [];
    const historicalCost = baseline.costUsd[0] + (baseline.costUsd[1] - baseline.costUsd[0]) * 0.65;
    const historicalDurationMin =
      baseline.durationMin[0] + (baseline.durationMin[1] - baseline.durationMin[0]) * 0.65;

    for (let i = 0; i < 4; i++) {
      const missionId = `hist-${i}`;
      rows.push(createdRow(missionId, M_TEXT));
      rows.push(completedRow(missionId, historicalCost, historicalDurationMin * 60_000));
    }
    mockJournalQuery.mockResolvedValue(rows);

    const result = await quote(M_TEXT, { model: 'claude-sonnet-5' });
    expect(result).toEqual(baseline);
  });

  it('only blends samples whose historical title classifies into the same size class', async () => {
    const baseline = await quote(M_TEXT, { model: 'claude-sonnet-5' });

    const rows: JournalEventRow[] = [];
    // 6 samples, but tagged with an XS-classifying title — must NOT match
    // the 'm'-sized query above, so the heuristic baseline is unaffected.
    for (let i = 0; i < 6; i++) {
      const missionId = `hist-xs-${i}`;
      rows.push(createdRow(missionId, XS_TEXT));
      rows.push(completedRow(missionId, 100, 100 * 60_000)); // wildly out of M's range
    }
    mockJournalQuery.mockResolvedValue(rows);

    const result = await quote(M_TEXT, { model: 'claude-sonnet-5' });
    expect(result).toEqual(baseline);
  });
});

// ── defaultBudgetCapUsd ────────────────────────────────────────────────

describe('defaultBudgetCapUsd', () => {
  it('is 3x the quote cost upper bound', () => {
    const q: MissionQuote = { costUsd: [1, 5], durationMin: [1, 2], agents: 1 };
    expect(defaultBudgetCapUsd(q)).toBe(15);
  });

  it('rounds to cents', () => {
    const q: MissionQuote = { costUsd: [1, 2.34], durationMin: [1, 2], agents: 1 };
    expect(defaultBudgetCapUsd(q)).toBe(7.02);
  });
});

// ── SIZE_CLASSES export sanity ──────────────────────────────────────────

describe('SIZE_CLASSES', () => {
  it('is ordered smallest to largest and matches SizeClass', () => {
    const expected: SizeClass[] = ['xs', 's', 'm', 'l', 'xl'];
    expect(SIZE_CLASSES).toEqual(expected);
  });
});
