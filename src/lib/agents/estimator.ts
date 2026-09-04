/* estimator.ts — pre-launch mission quotes (spec §7.3, §8; plan T1.2).

   Produces a `~cost, ~duration, N agents` range BEFORE a mission launches,
   shown in NewMissionModal (and later LazyManager, T2.8). Two layers:

   1. Heuristics (always available): a task is bucketed into a size class
      (sizeClassOf) from its text + declared scope, then a baseline
      cost/duration range is looked up per size class and scaled by the
      selected model's price tier and by whether an orchestrator fan-out is
      requested (see BASE_RANGES / TIER_*_MULTIPLIER / ORCHESTRATOR_*
      below). None of this requires any history to exist.

   2. History refinement (best-effort): once >=5 completed missions whose
      title classifies into the SAME size class exist in the journal, their
      median cost/duration is blended into the heuristic range (see
      blendHistory). Below that threshold, or if the journal is empty/
      unreachable, quote() falls back to pure heuristics — it never throws.

   Why classify history by title text instead of a stored size class: the
   `mission.completed` event (eventTypes.ts's MissionCompletedPayload) only
   carries `durationMs`/`costUsd`, and this task may not modify the emitters
   that would need to change to persist a size class at creation time
   (agentsStore.tsx, runtime.ts — owned by other Wave-1 tasks). Instead this
   module re-derives each historical mission's size class at READ time by
   running the same sizeClassOf() over the title captured in its
   `mission.created` event (MissionCreatedPayload.title), joined by
   missionId. Coarser than a persisted size class, but requires no emitter
   changes and self-corrects as sizeClassOf's heuristic evolves.
*/

import { journalQuery } from '../journal/journal.js';
import type { JournalEventRow } from '../journal/eventTypes.js';
import { findOpenRouterModel } from '../models/openrouterCatalog.js';

// ── Size classification ──────────────────────────────────────────────

export type SizeClass = 'xs' | 's' | 'm' | 'l' | 'xl';

/** Ordered smallest -> largest. Index doubles as a rank for monotonicity checks. */
export const SIZE_CLASSES: readonly SizeClass[] = ['xs', 's', 'm', 'l', 'xl'];

export function sizeClassRank(size: SizeClass): number {
  return SIZE_CLASSES.indexOf(size);
}

/**
 * Imperative "action" verbs commonly found in mission task text. Each match
 * roughly indicates one more discrete unit of work ("add X, fix Y and
 * refactor Z" -> 3 matches) — a coarse proxy for how many distinct changes
 * the agent has to make, independent of how verbosely each is described.
 */
const ACTION_VERB_PATTERN =
  /\b(add|fix|implement|create|update|remove|delete|refactor|migrate|write|build|test|review|wire|integrate|rename|extract|optimize|document|configure|deploy|design|investigate|debug|generate|replace|upgrade|audit)\w*\b/gi;

function countActionVerbs(text: string): number {
  return text.match(ACTION_VERB_PATTERN)?.length ?? 0;
}

/**
 * A scope path is "broad" when it targets a whole directory/tree rather
 * than a single file — it can touch an unbounded number of files, so it
 * contributes more to the size score than a narrow, single-file path.
 */
function isBroadScopePath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;
  return (
    trimmed === '.' ||
    trimmed.endsWith('/') ||
    trimmed.endsWith('\\') ||
    trimmed.includes('*') ||
    !trimmed.includes('.') // no file extension -> reads as a directory, not a file
  );
}

const BROAD_SCOPE_UNITS = 2;
const NARROW_SCOPE_UNITS = 1;
const CHARS_PER_LENGTH_UNIT = 60;
const UNITS_PER_ACTION_VERB = 1.5;

/**
 * Composite-score bucket edges. Not calibrated against real usage data (no
 * mission history exists at design time) — quote() blends in journal
 * medians once >=5 comparable historical samples exist, which is where
 * real calibration comes from over time. Until then, the only property
 * these edges must guarantee is MONOTONICITY: a task that is longer, uses
 * more action verbs, or declares broader scope must never classify into a
 * smaller bucket than one that is shorter/narrower in every dimension —
 * true by construction here since `score` is a strictly non-decreasing sum
 * of non-negative per-dimension contributions.
 */
const SIZE_THRESHOLDS: Record<Exclude<SizeClass, 'xs'>, number> = {
  s: 2,
  m: 4.5,
  l: 8,
  xl: 14,
};

/**
 * Heuristic size classifier: combines task-text length, action-verb count,
 * and declared scope breadth into one composite score, then buckets it.
 * `scopePaths` defaults to none (a quote requested before any scope is
 * declared still classifies on text alone).
 */
export function sizeClassOf(taskText: string, scopePaths: string[] = []): SizeClass {
  const text = taskText.trim();
  const lengthUnits = text.length / CHARS_PER_LENGTH_UNIT;
  const verbUnits = countActionVerbs(text) * UNITS_PER_ACTION_VERB;
  const scopeUnits = scopePaths.reduce(
    (sum, p) => sum + (isBroadScopePath(p) ? BROAD_SCOPE_UNITS : NARROW_SCOPE_UNITS),
    0,
  );
  const score = lengthUnits + verbUnits + scopeUnits;

  if (score < SIZE_THRESHOLDS.s) return 'xs';
  if (score < SIZE_THRESHOLDS.m) return 's';
  if (score < SIZE_THRESHOLDS.l) return 'm';
  if (score < SIZE_THRESHOLDS.xl) return 'l';
  return 'xl';
}

// ── Model tier ────────────────────────────────────────────────────────

export type ModelTierClass = 'cheap' | 'standard' | 'premium';

// Native Anthropic ids (registry.ts) carry no tier field, and any future/
// unlisted id (a new catalog entry, a BYOK custom id, ...) must still
// classify to *something* — so both native ids and unknown ids fall back
// to matching the id string itself against the same fast/max naming the
// model picker already uses (haiku=fast, opus/fable=max, sonnet=balanced).
const CHEAP_ID_PATTERN = /haiku|mini|flash-lite|-lite\b|nano/i;
const PREMIUM_ID_PATTERN = /opus|fable|\bmax\b|gpt-5\.5/i;

/**
 * Classifies a model id (native Anthropic or OpenRouter) into a cost tier.
 * OpenRouter ids ('provider/model') carry an explicit tier in the curated
 * catalog (openrouterCatalog.ts) — trusted first when present. Everything
 * else (native ids, and any id not found in that catalog) falls back to
 * pattern-matching the id string, mirroring the same tiering.
 */
export function modelTierOf(modelId: string): ModelTierClass {
  if (modelId.includes('/')) {
    const orModel = findOpenRouterModel(modelId);
    if (orModel) {
      if (orModel.tier === 'max') return 'premium';
      if (orModel.tier === 'fast' || orModel.tier === 'free') return 'cheap';
      return 'standard'; // 'balanced'
    }
  }
  if (CHEAP_ID_PATTERN.test(modelId)) return 'cheap';
  if (PREMIUM_ID_PATTERN.test(modelId)) return 'premium';
  return 'standard';
}

// ── Baseline heuristic table (size class x model tier) ────────────────

interface Range {
  costUsd: [number, number];
  durationMin: [number, number];
}

/**
 * Baseline ranges at the 'standard' model tier, before tier/orchestrator
 * scaling. Strictly increasing across size classes on both bounds (cost
 * and duration) by construction — this is what "quote ranges monotonic
 * with size class" actually depends on, and what estimator.test.ts asserts
 * black-box (via quote()) rather than against these private numbers.
 */
const BASE_RANGES: Record<SizeClass, Range> = {
  xs: { costUsd: [0.2, 0.6], durationMin: [2, 8] },
  s: { costUsd: [0.6, 1.5], durationMin: [8, 20] },
  m: { costUsd: [1.5, 4.0], durationMin: [20, 45] },
  l: { costUsd: [4.0, 9.0], durationMin: [45, 90] },
  xl: { costUsd: [9.0, 20.0], durationMin: [90, 180] },
};

/**
 * Rather than hand-tuning a full 5 (size) x 3 (tier) = 15-cell matrix, the
 * table is factored as base(size) * multiplier(tier): this guarantees
 * monotonicity across BOTH dimensions automatically (any size-class
 * ordering is preserved under any positive tier multiplier) and keeps the
 * whole heuristic to two small, independently-reasoned tables. Multipliers
 * are approximations of the price ratios visible in openrouterCatalog.ts
 * (e.g. haiku's priceOut=5 vs sonnet's 15 vs opus's 25) — coarse on
 * purpose, refined in practice by the history blend below.
 */
const TIER_COST_MULTIPLIER: Record<ModelTierClass, number> = {
  cheap: 0.4,
  standard: 1,
  premium: 2.2,
};

/**
 * Duration scales far less than cost across tiers — a pricier model isn't
 * necessarily slower, but extended-thinking-heavy premium models do tend
 * to run longer per step, while fast/cheap models respond quicker.
 */
const TIER_DURATION_MULTIPLIER: Record<ModelTierClass, number> = {
  cheap: 0.85,
  standard: 1,
  premium: 1.3,
};

/**
 * Sub-agent fan-out when the orchestrator toggle is on, by size class —
 * a tiny fix doesn't need 5 agents; a broad/cross-cutting task benefits
 * from more parallel lanes (spec §7.2's per-sub-agent worktrees).
 */
const ORCHESTRATOR_AGENTS: Record<SizeClass, number> = {
  xs: 2,
  s: 2,
  m: 3,
  l: 4,
  xl: 5,
};

/**
 * Cost scales with agent count but at a discount vs pure linear scaling —
 * sub-agents share the orchestrator's planning/context, so the marginal
 * cost of each additional agent is less than a fully independent run.
 */
const ORCHESTRATOR_COST_FACTOR = 0.8;

/**
 * Wall-clock duration does NOT scale with agent count (sub-agents run in
 * parallel worktrees, spec §7.2) — only a modest coordination/merge
 * overhead is added on top of the single-agent duration range.
 */
const ORCHESTRATOR_DURATION_OVERHEAD = 1.2;

// ── History refinement ───────────────────────────────────────────────

const MIN_HISTORY_SAMPLES = 5;
const HISTORY_QUERY_LIMIT = 200;
/** Blend spread: the historical range is median ± 40%, then clamped into
 *  the heuristic bounds (see blendRange) so a handful of outlier missions
 *  can never push a quote outside what the heuristic considers plausible
 *  for that size/tier/orchestrator combination. */
const BLEND_SPREAD = 0.4;

interface HistorySample {
  costUsd: number;
  durationMin: number;
}

/**
 * Reads up to HISTORY_QUERY_LIMIT `mission.created` + `mission.completed`
 * events, joins them by missionId, classifies each completed mission's
 * size class from its title (see module doc comment), and returns the
 * cost/duration samples matching `sizeClass`. Never throws — any failure
 * (unreachable journal, malformed payload JSON, missing fields) degrades
 * to an empty sample list, which quote() treats as "no history yet".
 */
async function fetchHistorySamples(sizeClass: SizeClass): Promise<HistorySample[]> {
  try {
    const rows: JournalEventRow[] = await journalQuery({
      types: ['mission.created', 'mission.completed'],
      limit: HISTORY_QUERY_LIMIT,
    });
    if (!rows || rows.length === 0) return [];

    const titleByMission = new Map<string, string>();
    const completedByMission = new Map<string, HistorySample>();

    for (const row of rows) {
      if (!row.mission_id) continue;

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        continue; // one malformed row must never poison the whole sample set
      }

      if (row.type === 'mission.created' && typeof payload.title === 'string') {
        titleByMission.set(row.mission_id, payload.title);
      } else if (row.type === 'mission.completed') {
        const costUsd = typeof payload.costUsd === 'number' ? payload.costUsd : undefined;
        const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : undefined;
        if (costUsd !== undefined && durationMs !== undefined) {
          completedByMission.set(row.mission_id, { costUsd, durationMin: durationMs / 60_000 });
        }
      }
    }

    const samples: HistorySample[] = [];
    for (const [missionId, sample] of completedByMission) {
      const title = titleByMission.get(missionId);
      if (title === undefined) continue;
      if (sizeClassOf(title) !== sizeClass) continue;
      samples.push(sample);
    }
    return samples;
  } catch {
    return [];
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/** Blends a historical median into a heuristic [lo, hi] range: median ±
 *  BLEND_SPREAD, clamped back into [lo, hi] on both ends. Always returns a
 *  valid (non-decreasing) tuple, even when the median falls outside the
 *  heuristic range entirely (both ends then clamp to the same bound). */
function blendRange([lo, hi]: [number, number], historicalMedian: number): [number, number] {
  const low = clamp(historicalMedian * (1 - BLEND_SPREAD), lo, hi);
  const high = clamp(historicalMedian * (1 + BLEND_SPREAD), lo, hi);
  return low <= high ? [low, high] : [high, low];
}

// ── Quote ─────────────────────────────────────────────────────────────

export interface MissionQuote {
  costUsd: [number, number];
  durationMin: [number, number];
  agents: number;
}

export interface QuoteOptions {
  scopePaths?: string[];
  model: string;
  orchestrator?: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundMinutes(n: number): number {
  return Math.max(1, Math.round(n));
}

/**
 * Produces a pre-launch quote: cost range, duration range, and agent count
 * for a task. Never throws (history refinement is fully defensive — see
 * fetchHistorySamples); always resolves to a usable heuristic quote at
 * minimum.
 */
export async function quote(taskText: string, opts: QuoteOptions): Promise<MissionQuote> {
  const sizeClass = sizeClassOf(taskText, opts.scopePaths);
  const tier = modelTierOf(opts.model);
  const base = BASE_RANGES[sizeClass];

  let costUsd: [number, number] = [
    base.costUsd[0] * TIER_COST_MULTIPLIER[tier],
    base.costUsd[1] * TIER_COST_MULTIPLIER[tier],
  ];
  let durationMin: [number, number] = [
    base.durationMin[0] * TIER_DURATION_MULTIPLIER[tier],
    base.durationMin[1] * TIER_DURATION_MULTIPLIER[tier],
  ];
  let agents = 1;

  if (opts.orchestrator) {
    agents = ORCHESTRATOR_AGENTS[sizeClass];
    const costFactor = agents * ORCHESTRATOR_COST_FACTOR;
    costUsd = [costUsd[0] * costFactor, costUsd[1] * costFactor];
    durationMin = [
      durationMin[0] * ORCHESTRATOR_DURATION_OVERHEAD,
      durationMin[1] * ORCHESTRATOR_DURATION_OVERHEAD,
    ];
  }

  const samples = await fetchHistorySamples(sizeClass);
  if (samples.length >= MIN_HISTORY_SAMPLES) {
    const costMedian = median(samples.map((s) => s.costUsd));
    const durationMedian = median(samples.map((s) => s.durationMin));
    costUsd = blendRange(costUsd, costMedian);
    durationMin = blendRange(durationMin, durationMedian);
  }

  return {
    costUsd: [round2(costUsd[0]), round2(costUsd[1])],
    durationMin: [roundMinutes(durationMin[0]), roundMinutes(durationMin[1])],
    agents,
  };
}

/** Default hard budget cap: 3x the quote's cost upper bound (spec §7.3). */
export function defaultBudgetCapUsd(q: MissionQuote): number {
  return round2(3 * q.costUsd[1]);
}
