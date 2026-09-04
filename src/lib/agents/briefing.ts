/* briefing.ts — the resume briefing (T2.5, spec §9): turns a window of raw
   journal events into a grounded digest, and (optionally) a short narrative
   paragraph describing it.

   Split in two halves, deliberately:
     1. buildBriefingDigest — PURE, synchronous, side-effect-free. Groups a
        flat JournalEventRow[] into shipped/asks/learned/spent/nightShift.
        No I/O, no randomness, no Date.now() — fully deterministic and unit
        testable on fixtures.
     2. generateBriefingNarrative — the one IMPURE piece: turns a digest into
        prose via the SAME model-gateway (`getProvider()`/`getActiveModel()`/
        `describeProviderReadiness()` from '../models') that every other
        one-shot AI feature in this app already uses (autoFix.ts,
        AiCommitMessage.tsx, AiReview.tsx, terminalAi.ts, InlineEditBar.tsx —
        see StreamChatRequest's doc comment in ../models/types.ts) and that
        managerEngine.ts's own grounded follow-up turns ultimately resolve
        into as well (streamManagedAgentTurn/streamClaudeCodeTurn/
        cliBackendProvider all wrap the exact providers getProvider()
        returns). Deliberately does NOT reuse managerEngine's
        buildManagerSystemPrompt — that prompt is action/tool-oriented
        (create_agent, launch_mission, ...) and would work against the
        "short prompt, digest-only facts" requirement here. Throws on any
        failure (readiness, empty stream, network) — the caller (Briefing.tsx)
        must fall back to the always-available digest-only bullets, never a
        fabricated narrative.

   Also owns the two small pieces of localStorage state the briefing needs:
     - lastSeen: when a scope's briefing was last DISPLAYED, so the next
       open knows where to start reading from (see resolveSinceAnchor).
     - cache: the last-generated narrative for a scope, keyed by the digest
       window's lastSeq so it is invalidated the moment new events exist.
*/

import { getProvider, describeProviderReadiness, getActiveModel } from '../models/index.js';
import type { ChatMessage } from '../models/index.js';
import type { Locale } from '../../i18n/types.js';
import type { JournalEventRow } from '../journal/eventTypes.js';

/** i18n translate function shape — see modelPickerOptions.ts's Translate doc
 *  comment for why this is a local structural type rather than a shared
 *  import. Optional: omitting `t` falls back to describeProviderReadiness's
 *  own untranslated default reason. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

// ── Digest shape ────────────────────────────────────────────────────

export interface ShippedItem {
  missionId: string;
  projectId: string;
  tsMs: number;
  kind: 'completed' | 'approved';
  /** Labels/kinds from this mission's mission.proof_attached events, if any. */
  proofRefs: string[];
}

export type AskKind = 'blocked' | 'question' | 'budget_warning' | 'budget_exceeded';

export interface AskItem {
  kind: AskKind;
  /** Null for budget events with no mission_id (a fleet/global budget signal). */
  missionId: string | null;
  projectId: string;
  tsMs: number;
  reason: string;
}

export interface LearnedItem {
  kind: 'captured' | 'decision' | 'promoted';
  label: string;
  tsMs: number;
}

export interface LearnedSummary {
  capturedCount: number;
  decisionCount: number;
  promotedCount: number;
  /** Most-recent-first, capped at TOP_ITEMS_CAP. */
  topItems: LearnedItem[];
}

export interface SpendSummary {
  totalUsd: number;
  byProject: Record<string, number>;
}

export interface NightShiftItem {
  missionId: string | null;
  projectId: string;
  tsMs: number;
  summary?: string;
}

export interface NightShiftSummary {
  count: number;
  byProject: Record<string, number>;
  /** Most-recent-first, capped at NIGHT_SHIFT_ITEMS_CAP. */
  items: NightShiftItem[];
}

export interface BriefingDigest {
  /** ts_ms of the earliest event in this digest (0 when eventCount is 0). */
  sinceMs: number;
  /** ts_ms of the latest event in this digest (0 when eventCount is 0). */
  untilMs: number;
  /** Highest `seq` seen — the cache-invalidation key (see readBriefingCache). */
  lastSeq: number;
  eventCount: number;
  shipped: ShippedItem[];
  asks: AskItem[];
  learned: LearnedSummary;
  spent: SpendSummary;
  nightShift: NightShiftSummary;
}

const TOP_ITEMS_CAP = 5;
const NIGHT_SHIFT_ITEMS_CAP = 8;

/** Mission.* types that move a blocked mission forward — its "blocked" ask
 *  is resolved (no longer open) once one of these appears later for the
 *  same mission_id. */
const BLOCKED_RESOLVERS: ReadonlySet<string> = new Set([
  'mission.resumed',
  'mission.intervened',
  'mission.approved',
  'mission.completed',
  'mission.cancelled',
  'mission.failed',
  'mission.reverted',
]);

function emptyDigest(): BriefingDigest {
  return {
    sinceMs: 0,
    untilMs: 0,
    lastSeq: 0,
    eventCount: 0,
    shipped: [],
    asks: [],
    learned: { capturedCount: 0, decisionCount: 0, promotedCount: 0, topItems: [] },
    spent: { totalUsd: 0, byProject: {} },
    nightShift: { count: 0, byProject: {}, items: [] },
  };
}

/** Best-effort JSON parse of a journal row's opaque payload — never throws;
 *  a corrupt/non-object payload degrades to `{}` (missing facts, not a crash). */
function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Builds the briefing digest from a flat window of journal events. PURE:
 * same input always produces the same output, no I/O, no clock reads. Does
 * NOT assume `events` arrives pre-sorted (defensively sorts by seq
 * ascending) so callers never have to think about ordering.
 */
export function buildBriefingDigest(events: JournalEventRow[]): BriefingDigest {
  if (events.length === 0) return emptyDigest();

  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  // ── shipped: mission.completed / mission.approved, with proof refs ──
  const proofsByMission = new Map<string, string[]>();
  for (const e of sorted) {
    if (e.type === 'mission.proof_attached' && e.mission_id) {
      const payload = parsePayload(e.payload);
      const label =
        typeof payload.label === 'string'
          ? payload.label
          : typeof payload.kind === 'string'
            ? payload.kind
            : 'proof';
      const existing = proofsByMission.get(e.mission_id) ?? [];
      proofsByMission.set(e.mission_id, [...existing, label]);
    }
  }

  // BUG-5: a later mission.failed/mission.reverted for the same mission_id
  // supersedes an earlier completed/approved event — without this, the
  // manager narrated a mission as freshly shipped when it had actually
  // failed after merging. Mirrors the resolvedLater pattern `asks` already
  // uses below for blocked/question events.
  function supersededByFailure(missionId: string, afterSeq: number): boolean {
    return sorted.some(
      (e) =>
        e.seq > afterSeq &&
        e.mission_id === missionId &&
        (e.type === 'mission.failed' || e.type === 'mission.reverted'),
    );
  }

  const shipped: ShippedItem[] = sorted
    .filter((e): e is JournalEventRow & { mission_id: string } =>
      (e.type === 'mission.completed' || e.type === 'mission.approved') &&
      e.mission_id !== null &&
      !supersededByFailure(e.mission_id, e.seq),
    )
    .map((e) => ({
      missionId: e.mission_id,
      projectId: e.project_id,
      tsMs: e.ts_ms,
      kind: e.type === 'mission.completed' ? 'completed' : 'approved',
      proofRefs: proofsByMission.get(e.mission_id) ?? [],
    }));

  // ── asks: OPEN blocked/question + every budget warning/exceeded ────
  function resolvedLater(missionId: string, afterSeq: number, kind: 'blocked' | 'question'): boolean {
    return sorted.some((e) => {
      if (e.seq <= afterSeq || e.mission_id !== missionId) return false;
      return kind === 'question' ? e.type === 'mission.answered' : BLOCKED_RESOLVERS.has(e.type);
    });
  }

  const asks: AskItem[] = [];
  for (const e of sorted) {
    if (e.type === 'mission.blocked' && e.mission_id) {
      if (resolvedLater(e.mission_id, e.seq, 'blocked')) continue;
      const payload = parsePayload(e.payload);
      asks.push({
        kind: 'blocked',
        missionId: e.mission_id,
        projectId: e.project_id,
        tsMs: e.ts_ms,
        reason: typeof payload.reason === 'string' ? payload.reason : 'Blocked',
      });
    } else if (e.type === 'mission.question' && e.mission_id) {
      if (resolvedLater(e.mission_id, e.seq, 'question')) continue;
      const payload = parsePayload(e.payload);
      asks.push({
        kind: 'question',
        missionId: e.mission_id,
        projectId: e.project_id,
        tsMs: e.ts_ms,
        reason: typeof payload.question === 'string' ? payload.question : 'Question pending',
      });
    } else if (e.type === 'budget.warning') {
      const payload = parsePayload(e.payload);
      const pct = typeof payload.pct === 'number' ? payload.pct : undefined;
      asks.push({
        kind: 'budget_warning',
        missionId: e.mission_id,
        projectId: e.project_id,
        tsMs: e.ts_ms,
        reason: pct !== undefined ? `Budget at ${pct}%` : 'Budget warning',
      });
    } else if (e.type === 'budget.exceeded') {
      const payload = parsePayload(e.payload);
      const spentUsd = typeof payload.spentUsd === 'number' ? payload.spentUsd : undefined;
      asks.push({
        kind: 'budget_exceeded',
        missionId: e.mission_id,
        projectId: e.project_id,
        tsMs: e.ts_ms,
        reason: spentUsd !== undefined ? `Budget exceeded ($${spentUsd.toFixed(2)})` : 'Budget exceeded',
      });
    }
  }

  // ── learned: brain.captured / brain.decision_created / brain.promoted ──
  const learnedItems: LearnedItem[] = [];
  let capturedCount = 0;
  let decisionCount = 0;
  let promotedCount = 0;
  for (const e of sorted) {
    if (e.type === 'brain.captured') {
      capturedCount += 1;
      const payload = parsePayload(e.payload);
      learnedItems.push({
        kind: 'captured',
        label: typeof payload.kind === 'string' ? payload.kind : 'note',
        tsMs: e.ts_ms,
      });
    } else if (e.type === 'brain.decision_created') {
      decisionCount += 1;
      const payload = parsePayload(e.payload);
      learnedItems.push({
        kind: 'decision',
        label: typeof payload.question === 'string' ? payload.question : 'decision',
        tsMs: e.ts_ms,
      });
    } else if (e.type === 'brain.promoted') {
      promotedCount += 1;
      const payload = parsePayload(e.payload);
      learnedItems.push({
        kind: 'promoted',
        label: typeof payload.scope === 'string' ? payload.scope : 'project',
        tsMs: e.ts_ms,
      });
    }
  }
  const topItems = [...learnedItems].sort((a, b) => b.tsMs - a.tsMs).slice(0, TOP_ITEMS_CAP);

  // ── spent: sum the top-level cost_usd column (same column
  //    journal_fleet_overview_inner sums in Rust), per project + total ──
  let totalUsd = 0;
  const byProject: Record<string, number> = {};
  for (const e of sorted) {
    if (e.cost_usd) {
      totalUsd += e.cost_usd;
      byProject[e.project_id] = (byProject[e.project_id] ?? 0) + e.cost_usd;
    }
  }
  for (const key of Object.keys(byProject)) byProject[key] = roundUsd(byProject[key]);

  // ── nightShift: loop.iteration events ──────────────────────────────
  const nightShiftEvents = sorted.filter((e) => e.type === 'loop.iteration');
  const nsByProject: Record<string, number> = {};
  for (const e of nightShiftEvents) {
    nsByProject[e.project_id] = (nsByProject[e.project_id] ?? 0) + 1;
  }
  const nightShiftItems: NightShiftItem[] = nightShiftEvents
    .slice(-NIGHT_SHIFT_ITEMS_CAP)
    .reverse()
    .map((e) => {
      const payload = parsePayload(e.payload);
      return {
        missionId: e.mission_id,
        projectId: e.project_id,
        tsMs: e.ts_ms,
        summary: typeof payload.summary === 'string' ? payload.summary : undefined,
      };
    });

  return {
    sinceMs: sorted[0].ts_ms,
    untilMs: sorted[sorted.length - 1].ts_ms,
    lastSeq: sorted[sorted.length - 1].seq,
    eventCount: sorted.length,
    shipped,
    asks,
    learned: { capturedCount, decisionCount, promotedCount, topItems },
    spent: { totalUsd: roundUsd(totalUsd), byProject },
    nightShift: { count: nightShiftEvents.length, byProject: nsByProject, items: nightShiftItems },
  };
}

// ── Narrative (the one impure piece) ─────────────────────────────────

const LOCALE_LANGUAGE_NAMES: Record<Locale, string> = {
  fr: 'French',
  en: 'English',
  es: 'Spanish',
  zh: 'Chinese',
  de: 'German',
  ja: 'Japanese',
};

function formatDigestFacts(digest: BriefingDigest): string {
  const lines: string[] = [
    `Window: ${digest.eventCount} events, ${new Date(digest.sinceMs).toISOString()} to ${new Date(digest.untilMs).toISOString()}.`,
  ];

  if (digest.shipped.length > 0) {
    const items = digest.shipped
      .map((s) => `${s.missionId} (${s.kind}${s.proofRefs.length > 0 ? ', proof: ' + s.proofRefs.join('/') : ''})`)
      .join('; ');
    lines.push(`Shipped (${digest.shipped.length}): ${items}`);
  }
  if (digest.asks.length > 0) {
    const items = digest.asks.map((a) => `${a.missionId ?? a.projectId} — ${a.reason}`).join('; ');
    lines.push(`Needs attention (${digest.asks.length}): ${items}`);
  }
  const { capturedCount, decisionCount, promotedCount, topItems } = digest.learned;
  if (capturedCount + decisionCount + promotedCount > 0) {
    const examples = topItems.map((i) => i.label).join('; ');
    lines.push(
      `Learned: ${capturedCount} captured, ${decisionCount} decisions, ${promotedCount} promoted.` +
        (examples ? ` Examples: ${examples}` : ''),
    );
  }
  if (digest.spent.totalUsd > 0) {
    const perProject = Object.entries(digest.spent.byProject)
      .map(([p, v]) => `${p}: $${v.toFixed(2)}`)
      .join(', ');
    lines.push(`Spent: $${digest.spent.totalUsd.toFixed(2)} total (${perProject}).`);
  }
  if (digest.nightShift.count > 0) {
    lines.push(
      `Night shift: ${digest.nightShift.count} loop iterations across ${Object.keys(digest.nightShift.byProject).length} project(s).`,
    );
  }
  return lines.join('\n');
}

/** Builds the (short, digest-only) prompt sent to the model. Exported for
 *  testability — asserting on the prompt text is how the "never invent /
 *  digest-only facts" contract is unit tested without mocking the network. */
export function buildBriefingPrompt(digest: BriefingDigest, locale: Locale): string {
  const language = LOCALE_LANGUAGE_NAMES[locale] ?? 'English';
  return (
    `Write a short (2-4 sentence) status briefing narrative in ${language} for a fleet-of-agents cockpit, ` +
    `summarizing what happened while the user was away. Use ONLY the facts listed below — never invent ` +
    `mission ids, numbers, or events that are not listed. If a category has no data, do not mention it. ` +
    `Be concrete and specific (cite mission ids/projects when present). Plain prose, no markdown headers.\n\n` +
    `FACTS:\n${formatDigestFacts(digest)}`
  );
}

/**
 * Generates a grounded narrative for `digest` via the app's shared model
 * gateway (see this file's header comment for why `getProvider()` is "the
 * same model-call path" managerEngine.ts's grounded answers ultimately use).
 * Throws on ANY failure — no model configured, empty stream, network error
 * — so the caller can fall back to the always-available digest-only bullets
 * instead of ever showing fabricated text.
 */
export async function generateBriefingNarrative(digest: BriefingDigest, locale: Locale, t?: Translate): Promise<string> {
  if (digest.eventCount === 0) {
    throw new Error('No events to narrate');
  }

  const readiness = describeProviderReadiness(undefined, t);
  if (!readiness.ready) {
    throw new Error(readiness.reason ?? 'No model available');
  }

  const provider = getProvider(t);
  const userMsg: ChatMessage = {
    id: `briefing-${Date.now()}`,
    role: 'user',
    content: buildBriefingPrompt(digest, locale),
  };

  let accumulated = '';
  const stream = provider.streamChat({
    messages: [userMsg],
    model: getActiveModel(),
    mode: 'ask',
  });
  for await (const token of stream) {
    accumulated += token;
  }

  const trimmed = accumulated.trim();
  if (!trimmed) {
    throw new Error('Empty narrative response');
  }
  return trimmed;
}

// ── lastSeen + cache (localStorage) ──────────────────────────────────

const CACHE_PREFIX = 'lazy.briefing.';
const LAST_SEEN_PREFIX = 'lazy.lastSeen.';
/** First-run lookback window (no persisted lastSeen yet): last 24h. */
const FIRST_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface BriefingCacheEntry {
  lastSeq: number;
  narrative: string;
  generatedAtMs: number;
}

/** `projectId ?? 'fleet'` — the scope segment used by both the cache key
 *  and the lastSeen key, so a per-project briefing and the fleet-wide one
 *  never share state. */
export function resolveScope(projectId?: string): string {
  return projectId ?? 'fleet';
}

function cacheKey(scope: string): string {
  return `${CACHE_PREFIX}${scope}`;
}

function lastSeenKey(scope: string): string {
  return `${LAST_SEEN_PREFIX}${scope}`;
}

/**
 * Reads the cached narrative for `scope` — but ONLY when its `lastSeq`
 * matches the digest window currently in hand. A cache built from an
 * older/smaller event window is treated as a miss (regenerate) rather than
 * served stale: this IS the "regenerate only when new events exist" rule,
 * expressed as a cache-key match instead of a separate dirty flag.
 */
export function readBriefingCache(scope: string, lastSeq: number): BriefingCacheEntry | null {
  try {
    const raw = localStorage.getItem(cacheKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BriefingCacheEntry>;
    if (
      typeof parsed.lastSeq !== 'number' ||
      typeof parsed.narrative !== 'string' ||
      typeof parsed.generatedAtMs !== 'number'
    ) {
      return null;
    }
    if (parsed.lastSeq !== lastSeq) return null;
    return parsed as BriefingCacheEntry;
  } catch {
    return null;
  }
}

export function writeBriefingCache(scope: string, entry: BriefingCacheEntry): void {
  try {
    localStorage.setItem(cacheKey(scope), JSON.stringify(entry));
  } catch {
    // localStorage may be unavailable (SSR / private mode) — cache is best-effort only.
  }
}

/** Reads the last-seen anchor (ms) for `scope`. Null means first run (no
 *  prior visit recorded) — see resolveSinceAnchor for the 24h fallback. */
export function readLastSeen(scope: string): number | null {
  try {
    const raw = localStorage.getItem(lastSeenKey(scope));
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Records `atMs` as the last time `scope`'s briefing was DISPLAYED — call
 *  this on component mount (never on every digest refresh), so the anchor
 *  reflects "since the user last looked", not "since the last poll". */
export function writeLastSeen(scope: string, atMs: number): void {
  try {
    localStorage.setItem(lastSeenKey(scope), String(atMs));
  } catch {
    // best-effort — see writeBriefingCache.
  }
}

/**
 * Resolves the since-anchor (ms) to query events from: the persisted
 * lastSeen for `scope`, or a 24h lookback window on first run.
 */
export function resolveSinceAnchor(scope: string, nowMs: number = Date.now()): number {
  const lastSeen = readLastSeen(scope);
  return lastSeen ?? nowMs - FIRST_RUN_WINDOW_MS;
}
