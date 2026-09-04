/* missionHistory.ts — pure read-model derivations over the event journal for
   one mission's run history (Agent Canvas W8b: history drawer + stage Gantt).

   Strictly derivation-only: no invoke/fetch here — see useMissionHistory.ts
   for the React hooks that feed this module real `JournalEventRow[]` rows
   (via journal.ts's `journalQuery`, the only journal API the frontend may
   use). Kept separate from the hooks file so every derivation stays fully
   pure and unit-testable with synthetic event fixtures (no React, no mocked
   invoke needed).

   Honesty rule (matches managerEngine.ts's formatMissionDetail and
   activityFeedFormat.ts's convention): every derived field is computed ONLY
   from events that were actually observed in the journal. A stage boundary,
   metric, or archive row that cannot be derived from the real event
   vocabulary (eventTypes.ts) is simply absent — never fabricated, never a
   placeholder.

   GENERATION SCOPING (MAJEUR fix, R3 dogfood 2026-07): mission ids (M1..Mn
   per project) get RECYCLED across unrelated runs — a fresh mission can mint
   the same id an older, long-finished mission once used (agentsStore.tsx's
   id-minting only ratchets past ids currently held in memory, not every id
   the append-only journal has ever seen for that project — see
   agentsStore.missionIdCollision.test.tsx for the minting-side half of this
   story). Because the journal is queried by mission_id alone, a flat
   `WHERE mission_id = ?` blends TWO unrelated missions' event streams
   together — e.g. today's M9 (still in review) showing July-11 M9's Gantt,
   duration, cost, and "Terminée" status.
   `splitMissionGenerations`/`currentGenerationEvents` below are the ONE
   shared primitive every read-model in this file (and projectReport.ts,
   zoneDigest.ts) uses to draw the boundary: the LAST `mission.created` event
   for an id starts its CURRENT generation; everything before that belongs to
   an earlier, separate generation. A read-model's headline fields
   (stageSpans, terminalType, tokens, completedMissions, archive rows, ...)
   reflect the CURRENT generation ONLY — an older generation is either
   surfaced honestly as its own clearly-separated entry (buildProjectArchive,
   buildProjectReport — one row per (missionId, generation)) or listed
   collapsed under `previousGenerations` (buildMissionRunHistory), never
   silently blended in.
*/

import type { FleetStage } from '../agents/fleetStage.js';
import type { JournalEventRow, JournalEventType } from './eventTypes.js';

// ── Types ────────────────────────────────────────────────────────────

/** Provenance of a mission's aggregated token/cost numbers — mirrors
 *  SpendTokensPayload.source (eventTypes.ts) plus 'unknown' for a mission
 *  that never emitted a single spend.tokens event, and 'mixed' when its
 *  spend.tokens events disagree (e.g. an 'estimated' turn followed later by
 *  a 'settled' correction). */
export type TokensSource = 'real' | 'estimated' | 'settled' | 'mixed' | 'unknown';

/**
 * One horizontal Gantt bar. `endMs: null` means the stage is still open — no
 * event has closed it yet (e.g. the mission is still running, or is in
 * review with no terminal event yet) — StageGantt renders that as a live
 * pulsing bar reaching "now" rather than a fixed-width one.
 *
 * `stage` reuses fleetStage.ts's 5-column vocabulary (plan/code/test/review/
 * merged) purely as a shared color/label key (see StageGantt.tsx's import of
 * chrome/StageRail's STAGE_COLORS) — this module never re-derives FleetStage
 * from status/planSteps the way fleetStage.ts does; see deriveStageSpans's
 * doc comment for the actual event-level mapping.
 */
export interface StageSpan {
  stage: FleetStage;
  startMs: number;
  endMs: number | null;
}

export interface ChainFireEntry {
  kind: 'fired' | 'pending_cross_project' | 'resumed';
  chainId: string;
  sourceMissionId: string;
  targetRef: string;
  projectId: string;
  tsMs: number;
}

export interface TokenAggregate {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  source: TokensSource;
}

export interface MissionRunHistory {
  missionId: string;
  /** This mission id's CURRENT-GENERATION events ONLY, ascending by seq (real
   *  journal order) — see this module's header on generation scoping. An
   *  older generation of the same (recycled) id is never blended in here;
   *  see `previousGenerations` below. */
  events: readonly JournalEventRow[];
  stageSpans: readonly StageSpan[];
  tokens: TokenAggregate;
  chainFires: readonly ChainFireEntry[];
  /** The first terminal-type event observed for this mission's CURRENT
   *  generation, or null while still in flight — never an older
   *  generation's terminal event. */
  terminalType: JournalEventType | null;
  /** ts of the earliest event for this mission's current generation
   *  (mission.created when present, else the first row's ts). */
  startedAtMs: number | null;
  /** terminalType's ts minus startedAtMs, or null when not yet derivable (no terminal event). */
  durationMs: number | null;
  /** Older generations of this SAME (recycled) mission id, oldest-first —
   *  honest, collapsed summaries kept clearly SEPARATE from the fields
   *  above, never merged into them. Empty when this id has never been
   *  reused (the common case). See this module's header. */
  previousGenerations: readonly ProjectArchiveEntry[];
}

export interface ProjectArchiveEntry {
  missionId: string;
  /** Generation index for this id (0 = oldest) — see splitMissionGenerations.
   *  Distinguishes two unrelated missions that happen to share a recycled
   *  id: an archive/report listing keys its rows by (missionId, generation),
   *  never by missionId alone. */
  generation: number;
  /** From mission.created's payload.title — null when that event was never observed for this id
   *  (e.g. a legacy-migrated row, see eventTypes.ts's MissionCreatedPayload.imported). */
  title: string | null;
  terminalType: JournalEventType | null;
  startedAtMs: number | null;
  durationMs: number | null;
  costUsd: number;
  /** ts of this mission's most recently observed event — the archive's sort key (newest-first). */
  lastEventMs: number;
}

// ── Constants ────────────────────────────────────────────────────────

const TERMINAL_EVENT_TYPES: readonly JournalEventType[] = [
  'mission.completed',
  'mission.approved',
  'mission.failed',
  'mission.rejected',
  'mission.cancelled',
  'mission.reverted',
];

/** Terminal events that represent an actual SUCCESSFUL outcome — the only
 *  ones that produce a 'merged' marker span (see deriveStageSpans). */
const SUCCESS_TERMINAL_EVENT_TYPES: readonly JournalEventType[] = ['mission.completed', 'mission.approved'];

const CHAIN_EVENT_KIND: Partial<Record<JournalEventType, ChainFireEntry['kind']>> = {
  'chain.fired': 'fired',
  'chain.pending_cross_project': 'pending_cross_project',
  'chain.resumed': 'resumed',
};

// ── Small helpers ────────────────────────────────────────────────────

function sortedAsc(events: readonly JournalEventRow[]): JournalEventRow[] {
  return [...events].sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.ts_ms - b.ts_ms));
}

function firstOfType(events: readonly JournalEventRow[], type: JournalEventType): JournalEventRow | undefined {
  return events.find((e) => e.type === type);
}

function firstOfTypes(
  events: readonly JournalEventRow[],
  types: readonly JournalEventType[],
): JournalEventRow | undefined {
  return events.find((e) => types.includes(e.type));
}

function earliestDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((v): v is number => v !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

/** Best-effort JSON.parse of a row's raw payload text — the journal stores
 *  payload as opaque JSON (Rust never inspects it, per eventTypes.ts's
 *  header), so a parse failure is expected on a corrupt/truncated row and
 *  must degrade honestly rather than throw. */
function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ── Mission generations (recycled-id scoping — see module header) ────

export interface MissionGeneration {
  /** 0 = oldest. The LAST (highest) index is this id's CURRENT generation. */
  generation: number;
  /** Ascending (real journal order), scoped to just this one generation. */
  events: readonly JournalEventRow[];
}

/**
 * Splits ONE mission id's own events (any order, any mix of generations)
 * into distinct generations: a generation starts at a `mission.created`
 * event and runs up to (excluding) the NEXT `mission.created` for the same
 * id, or the end of the list. When `mission.created` was never observed at
 * all for this id (e.g. a legacy-migrated row — see eventTypes.ts's
 * MissionCreatedPayload.imported), there is no boundary to split on and the
 * whole list is treated as a single generation — never split on any other
 * event type, since only mission.created reliably marks "a new mission just
 * started using this id" (spec: recycled ids only ever restart at creation).
 */
export function splitMissionGenerations(events: readonly JournalEventRow[]): MissionGeneration[] {
  const asc = sortedAsc(events);
  if (asc.length === 0) return [];

  const boundaries: number[] = [];
  asc.forEach((e, i) => {
    if (e.type === 'mission.created') boundaries.push(i);
  });
  if (boundaries.length === 0) return [{ generation: 0, events: asc }];

  return boundaries.map((start, i) => ({
    generation: i,
    events: asc.slice(start, i + 1 < boundaries.length ? boundaries[i + 1] : asc.length),
  }));
}

/**
 * THE shared generation-scoping primitive (missionHistory.ts, projectReport.ts,
 * and zoneDigest.ts all rely on this — directly or via buildMissionRunHistory/
 * buildProjectArchive/buildProjectReport below): scopes a flat, possibly
 * multi-mission event list down to ONE mission id's CURRENT generation only.
 * Never blends an older generation's events into the result — see this
 * module's header for why that matters (recycled mission ids).
 */
export function currentGenerationEvents(
  events: readonly JournalEventRow[],
  missionId: string,
): JournalEventRow[] {
  const scoped = events.filter((e) => e.mission_id === missionId);
  const generations = splitMissionGenerations(scoped);
  return generations.length > 0 ? [...generations[generations.length - 1].events] : [];
}

// ── Stage spans ──────────────────────────────────────────────────────

/**
 * Derives Gantt-ready stage spans from a mission's REAL events only:
 *
 *   plan   — mission.created  -> mission.started   (queued / pre-execution)
 *   code   — mission.started  -> the EARLIEST of: first gate.* event,
 *            mission.review_requested, or any terminal event
 *   test   — first gate.* event -> last gate.* event (evaluators actually ran —
 *            tester/reviewer/security/judge, see eventTypes.ts's GatePassedPayload/
 *            GateFailedPayload)
 *   review — mission.review_requested -> any terminal event
 *   merged — a ZERO-WIDTH marker (startMs === endMs) at the first SUCCESS
 *            terminal event (mission.completed/mission.approved) — a
 *            completion is instantaneous, never a fabricated duration.
 *
 * Each span is included ONLY when its start boundary was actually observed —
 * e.g. a mission with no mission.review_requested event produces no 'review'
 * span at all, rather than guessing one from status. `endMs: null` means the
 * span is still open (no closing event yet); the caller renders that as live.
 */
export function deriveStageSpans(events: readonly JournalEventRow[]): StageSpan[] {
  const asc = sortedAsc(events);
  if (asc.length === 0) return [];

  const created = firstOfType(asc, 'mission.created');
  const started = firstOfType(asc, 'mission.started');
  const reviewRequested = firstOfType(asc, 'mission.review_requested');
  const gateEvents = asc.filter((e) => e.type === 'gate.passed' || e.type === 'gate.failed');
  const terminal = firstOfTypes(asc, TERMINAL_EVENT_TYPES);
  const successTerminal = firstOfTypes(asc, SUCCESS_TERMINAL_EVENT_TYPES);

  const spans: StageSpan[] = [];

  if (created) {
    spans.push({ stage: 'plan', startMs: created.ts_ms, endMs: started?.ts_ms ?? null });
  }

  if (started) {
    const codeEnd = earliestDefined(gateEvents[0]?.ts_ms, reviewRequested?.ts_ms, terminal?.ts_ms);
    spans.push({ stage: 'code', startMs: started.ts_ms, endMs: codeEnd ?? null });
  }

  if (gateEvents.length > 0) {
    spans.push({ stage: 'test', startMs: gateEvents[0].ts_ms, endMs: gateEvents[gateEvents.length - 1].ts_ms });
  }

  if (reviewRequested) {
    spans.push({ stage: 'review', startMs: reviewRequested.ts_ms, endMs: terminal?.ts_ms ?? null });
  }

  if (successTerminal) {
    spans.push({ stage: 'merged', startMs: successTerminal.ts_ms, endMs: successTerminal.ts_ms });
  }

  return spans;
}

// ── Token/cost aggregate ─────────────────────────────────────────────

/**
 * Sums every spend.tokens event's top-level tokens_in/tokens_out/cost_usd
 * columns (journal.ts's serializeEvent already copies these there so a SUM
 * never needs to parse payload JSON — same convention `projections.ts`'s
 * fleet KPI aggregates rely on). `source` reports 'unknown' when the mission
 * never emitted a spend.tokens event, the single observed source value when
 * every event agrees, or 'mixed' when they disagree.
 */
export function deriveTokenAggregate(events: readonly JournalEventRow[]): TokenAggregate {
  const spendEvents = events.filter((e) => e.type === 'spend.tokens');
  if (spendEvents.length === 0) {
    return { tokensIn: 0, tokensOut: 0, costUsd: 0, source: 'unknown' };
  }

  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  const sources = new Set<string>();

  for (const e of spendEvents) {
    tokensIn += e.tokens_in;
    tokensOut += e.tokens_out;
    costUsd += e.cost_usd;
    const payload = parsePayload(e.payload);
    const source = payload && typeof payload.source === 'string' ? payload.source : undefined;
    if (source) sources.add(source);
  }

  const source: TokensSource =
    sources.size === 0 ? 'unknown' : sources.size > 1 ? 'mixed' : ((sources.values().next().value as TokensSource) ?? 'unknown');

  return { tokensIn, tokensOut, costUsd, source };
}

// ── Chain fires ──────────────────────────────────────────────────────

/**
 * Every chain.fired/chain.pending_cross_project/chain.resumed row this
 * mission's events carry (either as the source or via targetRef), oldest
 * first. A row whose payload is missing a required field (malformed/
 * corrupt) is skipped rather than rendered with fabricated blanks.
 */
export function deriveChainFires(events: readonly JournalEventRow[]): ChainFireEntry[] {
  const out: ChainFireEntry[] = [];
  for (const e of sortedAsc(events)) {
    const kind = CHAIN_EVENT_KIND[e.type];
    if (!kind) continue;
    const payload = parsePayload(e.payload);
    if (!payload) continue;
    const chainId = typeof payload.chainId === 'string' ? payload.chainId : undefined;
    const sourceMissionId = typeof payload.sourceMissionId === 'string' ? payload.sourceMissionId : undefined;
    const targetRef = typeof payload.targetRef === 'string' ? payload.targetRef : undefined;
    const projectId = typeof payload.projectId === 'string' ? payload.projectId : e.project_id;
    if (!chainId || !sourceMissionId || !targetRef) continue;
    out.push({ kind, chainId, sourceMissionId, targetRef, projectId, tsMs: e.ts_ms });
  }
  return out;
}

// ── Terminal status / duration ────────────────────────────────────────

export function deriveTerminalType(events: readonly JournalEventRow[]): JournalEventType | null {
  return firstOfTypes(sortedAsc(events), TERMINAL_EVENT_TYPES)?.type ?? null;
}

function deriveStartAndDuration(asc: readonly JournalEventRow[]): { startedAtMs: number | null; durationMs: number | null } {
  if (asc.length === 0) return { startedAtMs: null, durationMs: null };
  const created = firstOfType(asc, 'mission.created');
  const startedAtMs = created?.ts_ms ?? asc[0].ts_ms;
  const terminal = firstOfTypes(asc, TERMINAL_EVENT_TYPES);
  const durationMs = terminal ? terminal.ts_ms - startedAtMs : null;
  return { startedAtMs, durationMs };
}

function extractTitle(asc: readonly JournalEventRow[]): string | null {
  const created = firstOfType(asc, 'mission.created');
  if (!created) return null;
  const payload = parsePayload(created.payload);
  return payload && typeof payload.title === 'string' ? payload.title : null;
}

/** Shared per-generation summary builder — the ONE place that derives an
 *  archive/history "row" (title, terminal status, timing, cost) for a single
 *  generation's own event slice. Used by buildProjectArchive (one row per
 *  (missionId, generation)) and buildMissionRunHistory's `previousGenerations`
 *  (collapsed summaries of a recycled id's earlier runs) alike, so both stay
 *  in sync rather than re-deriving the same fields twice. */
function summarizeGeneration(missionId: string, generation: number, asc: readonly JournalEventRow[]): ProjectArchiveEntry {
  const { startedAtMs, durationMs } = deriveStartAndDuration(asc);
  const tokens = deriveTokenAggregate(asc);
  return {
    missionId,
    generation,
    title: extractTitle(asc),
    terminalType: deriveTerminalType(asc),
    startedAtMs,
    durationMs,
    costUsd: tokens.costUsd,
    lastEventMs: asc[asc.length - 1].ts_ms,
  };
}

// ── Composition ──────────────────────────────────────────────────────

/**
 * Builds the full read-model for one mission id from its raw journal rows
 * (any order, any mix of generations — this sorts and generation-scopes
 * internally). Every headline field (events/stageSpans/tokens/chainFires/
 * terminalType/duration) reflects this id's CURRENT generation ONLY — see
 * this module's header on why mission ids get recycled and why that matters.
 * Older generations of the same id are never blended in; they're listed,
 * honestly separated, under `previousGenerations`. Pure: no I/O.
 */
export function buildMissionRunHistory(missionId: string, events: readonly JournalEventRow[]): MissionRunHistory {
  const asc = currentGenerationEvents(events, missionId);
  const generations = splitMissionGenerations(events.filter((e) => e.mission_id === missionId));
  const previousGenerations = generations
    .slice(0, -1)
    .map((g) => summarizeGeneration(missionId, g.generation, g.events));

  const { startedAtMs, durationMs } = deriveStartAndDuration(asc);
  return {
    missionId,
    events: asc,
    stageSpans: deriveStageSpans(asc),
    tokens: deriveTokenAggregate(asc),
    chainFires: deriveChainFires(asc),
    terminalType: deriveTerminalType(asc),
    startedAtMs,
    durationMs,
    previousGenerations,
  };
}

// ── Project archive ────────────────────────────────────────────────

/** Groups a flat (possibly multi-mission) list of journal rows by mission_id.
 *  Rows without a mission_id (project.*, loop.tick, etc.) are dropped — an
 *  archive entry is inherently per-mission. NOTE: this groups by id alone
 *  (pre-generation) — buildProjectArchive/buildProjectReport further split
 *  each id's bucket into generations (see splitMissionGenerations) before
 *  deriving anything from it, so a recycled id's two unrelated runs are
 *  never merged together downstream. */
export function groupEventsByMission(events: readonly JournalEventRow[]): Map<string, JournalEventRow[]> {
  const map = new Map<string, JournalEventRow[]>();
  for (const e of events) {
    if (!e.mission_id) continue;
    const bucket = map.get(e.mission_id);
    if (bucket) bucket.push(e);
    else map.set(e.mission_id, [e]);
  }
  return map;
}

/**
 * Builds one archive row per (missionId, generation) seen in `events` —
 * every mission GENERATION the journal has any row for, including ones no
 * longer present in `missions_current` (the events table is append-only and
 * never forgets a row even after a mission is pruned/rotated from the live
 * projection — see missionsProjection.ts's header) AND including every
 * earlier generation of a RECYCLED id as its own separate, honest row rather
 * than blending it into the current one (see this module's header). Sorted
 * newest-first by each generation's last observed event. Two rows CAN share
 * the same `missionId` when that id was reused — callers must key list
 * rendering by (missionId, generation), never missionId alone.
 */
export function buildProjectArchive(events: readonly JournalEventRow[]): ProjectArchiveEntry[] {
  const grouped = groupEventsByMission(events);
  const entries: ProjectArchiveEntry[] = [];

  for (const [missionId, missionEvents] of grouped) {
    for (const gen of splitMissionGenerations(missionEvents)) {
      entries.push(summarizeGeneration(missionId, gen.generation, gen.events));
    }
  }

  return entries.sort((a, b) => b.lastEventMs - a.lastEventMs);
}
