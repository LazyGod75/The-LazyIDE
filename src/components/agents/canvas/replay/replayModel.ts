/* replayModel.ts — Agent Canvas W8d: pure read-model for fleet time-travel
   Replay (LangGraph-Studio-inspired UX, reimplemented over our OWN append-
   only event journal — the journal IS the thing that makes this feature
   possible at all, no other agent-canvas product has this data spine).

   Strictly derivation-only: no invoke/fetch here (see useReplayMode.ts for
   the React hook that feeds this module real `JournalEventRow[]` rows via
   journal.ts's `journalQuery`, the only journal API the frontend may use).
   Kept separate so every derivation stays fully pure/unit-testable with
   synthetic event fixtures — same convention as
   ../../../../lib/journal/missionHistory.ts, whose exported derivations
   (`deriveStageSpans`, `deriveChainFires`, `deriveTerminalType`,
   `groupEventsByMission`, `buildProjectArchive`) this module REUSES
   verbatim rather than re-deriving stage/status logic a second way.

   Honesty rules (matches missionHistory.ts's own convention):
     - A mission with zero events inside [windowStartMs, windowEndMs] never
       appears in the timeline at all — no placeholder, no interpolation.
     - `fleetStateAt(t)` never fabricates an intermediate state: it reports
       the LAST real event-derived state at or before `t`, nothing more.
     - Windowing boundary effect (documented, not a bug): a mission whose
       real `mission.created` predates the window start but that has SOME
       in-window activity (e.g. a mission still running since yesterday,
       window = "today") is only known from its in-window events — its
       `createdAtMs`/existence boundary here is the earliest IN-WINDOW
       event, not necessarily its true lifetime start. This is an honest
       consequence of scoping a replay to a time window, not a fabricated
       fact — every field is still built ONLY from events actually queried.
*/

import type { FleetStage } from '../../../../lib/agents/fleetStage';
import type { MissionStatus } from '../../../../lib/agents/types';
import type { JournalEventRow, JournalEventType } from '../../../../lib/journal/eventTypes';
import {
  buildProjectArchive,
  deriveChainFires,
  deriveStageSpans,
  deriveTerminalType,
  groupEventsByMission,
  type ChainFireEntry,
} from '../../../../lib/journal/missionHistory';

// ── Window selector (spec: "since local midnight; selector for 24h/7j") ──

export type ReplayWindowOption = 'today' | '24h' | '7d';

/** `nowMs` is injected (never `Date.now()` read internally) so this stays
 *  pure/testable — the one hook call site (useReplayMode.ts) supplies the
 *  real clock. */
export function computeWindowStartMs(option: ReplayWindowOption, nowMs: number): number {
  if (option === '24h') return nowMs - 24 * 60 * 60 * 1000;
  if (option === '7d') return nowMs - 7 * 24 * 60 * 60 * 1000;
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime();
}

// ── Per-mission fleet snapshot ────────────────────────────────────────

export interface FleetSnapshot {
  status: MissionStatus;
  stage: FleetStage;
  paused: boolean;
}

export interface FleetStateEntry extends FleetSnapshot {
  missionId: string;
  title: string | null;
  /** ts of the earliest event this mission has WITHIN the queried window
   *  (see the windowing-boundary honesty note above) — the instant it
   *  first becomes visible while scrubbing. */
  existsSince: number;
}

interface StageKeyframe {
  tsMs: number;
  stage: FleetStage;
}
interface StatusKeyframe {
  tsMs: number;
  status: MissionStatus;
}
interface PausedKeyframe {
  tsMs: number;
  paused: boolean;
}

export interface MissionTrack {
  missionId: string;
  /** From mission.created's payload.title (via missionHistory's
   *  buildProjectArchive) — null when never observed in-window (e.g. the
   *  mission was already created before the window and only its later
   *  activity fell inside it). */
  title: string | null;
  createdAtMs: number;
  /** Ascending by tsMs — reused verbatim from missionHistory.deriveStageSpans's
   *  span boundaries, never re-derived. */
  stageKeyframes: readonly StageKeyframe[];
  /** Ascending by tsMs. */
  statusKeyframes: readonly StatusKeyframe[];
  /** Ascending by tsMs. */
  pausedKeyframes: readonly PausedKeyframe[];
}

// ── Global timeline (ticker + density ticks) ──────────────────────────

/** 'system' (defect #8 fix): a non-mission-scoped journal row — project.*
 *  (registered/opened/closed) today, but deliberately not restricted to
 *  that prefix — ANY row with no `mission_id` (a future teams.* or
 *  scheduler.* event, etc.) is a real fleet-story keyframe too, not just
 *  mission lifecycle events. See buildFleetTimeline's own doc comment.
 *  'brain' (brain-integration wave): a brain.* row (recalled/captured/
 *  promoted/decision_created/decision_hit) — also mission_id-less (see
 *  BRAIN_EVENT_TYPES below), but split out from the generic 'system' bucket
 *  so ReplayBar's ticker can render a real, brain-specific line ("14:02 —
 *  brain: 3 nœud(s) rappelé(s)") instead of the raw event-type fallback. */
export type TimelineKeyframeKind = 'created' | 'stage' | 'status' | 'chain_fired' | 'system' | 'brain';

/** One row in the flat, fleet-wide, chronologically-sorted feed ReplayBar's
 *  event ticker and density ticks read from. Carries enough raw fields for
 *  the UI to compose its OWN i18n string (this module never hardcodes
 *  display copy). */
export interface TimelineKeyframe {
  tsMs: number;
  /** `null` for a 'system'/'brain' keyframe (defect #8 fix; brain-integration
   *  wave) — neither has an owning mission; every mission-scoped kind still
   *  sets this. */
  missionId: string | null;
  kind: TimelineKeyframeKind;
  title: string | null;
  stage?: FleetStage;
  status?: MissionStatus;
  chainId?: string;
  /** Set for the 'system'/'brain' kinds: the project this event belongs to
   *  (may be an empty string for a truly global row, e.g. federated recall's
   *  `projectId: '*'`) and the RAW journal event type (e.g. 'project.opened',
   *  'brain.captured') the ticker humanizes. */
  projectId?: string;
  eventType?: JournalEventType;
  /**
   * 'brain' kind only — a REAL count parsed from the event's own payload,
   * never fabricated: brain.recalled's `nodeIds.length` (how many neurons
   * this recall actually hit). Absent for every other brain.* type, which
   * carries no analogous count in its payload (see brainDetail below for
   * those instead).
   */
  brainCount?: number;
  /**
   * 'brain' kind only — a short, UNTRANSLATED fact lifted verbatim from the
   * event's own payload (never composed/translated here — this module never
   * hardcodes display copy, see the module header): brain.captured's `kind`,
   * brain.promoted's `scope`, or brain.decision_created/decision_hit's
   * `question` (truncated). Absent for brain.recalled (see brainCount).
   */
  brainDetail?: string;
}

export interface FleetTimeline {
  windowStartMs: number;
  windowEndMs: number;
  tracks: ReadonlyMap<string, MissionTrack>;
  /** Every chain.fired/pending_cross_project/resumed row in-window, ascending
   *  by tsMs — reused verbatim from missionHistory.deriveChainFires. */
  chainFires: readonly ChainFireEntry[];
  /** Every keyframe across every mission PLUS every real chain.fired,
   *  ascending by tsMs — the single feed ReplayBar's ticker/density ticks
   *  read (never re-scanned per animation frame; see densityBuckets/
   *  lastKeyframeAtOrBefore, both binary-search based). */
  keyframes: readonly TimelineKeyframe[];
}

// ── Status derivation (event vocabulary -> MissionStatus, own to Replay —
//    does not duplicate missionHistory.ts's stage derivation, which is a
//    different axis reused as-is) ──────────────────────────────────────

/** Maps a mission's FIRST observed terminal event type onto the coarse
 *  MissionStatus vocabulary (lib/agents/types.ts) — the only vocabulary a
 *  canvas mission node actually renders. `mission.rejected` maps to
 *  'review' (a reviewer's rejection sends the mission back for a human
 *  decision, per eventTypes.ts's own doc comment — never a dead-end
 *  'failed', which is reserved for an actual execution failure).
 *  `mission.reverted` maps to 'cancelled' (the merge's effect was undone). */
const TERMINAL_STATUS_MAP: Partial<Record<JournalEventType, MissionStatus>> = {
  'mission.completed': 'done',
  'mission.approved': 'done',
  'mission.failed': 'failed',
  'mission.cancelled': 'cancelled',
  'mission.rejected': 'review',
  'mission.reverted': 'cancelled',
};

function firstOfType(asc: readonly JournalEventRow[], type: JournalEventType): JournalEventRow | undefined {
  return asc.find((e) => e.type === type);
}

// ── Brain keyframes (brain-integration wave) ──────────────────────────
//
// Every brain.* type the journal actually emits (eventTypes.ts) — none carry
// a mission_id (see TimelineKeyframe's own doc comment), so without this set
// they would all fall into the generic 'system' bucket and render as a raw
// event-type string. Split out here so the ticker can show a real,
// payload-derived line instead.
const BRAIN_EVENT_TYPES: ReadonlySet<JournalEventType> = new Set([
  'brain.recalled',
  'brain.captured',
  'brain.promoted',
  'brain.decision_created',
  'brain.decision_hit',
]);

/** Cap so a long decision question never blows up the one-line ticker —
 *  same order of magnitude as replayTicker.ts's other single-line facts. */
const BRAIN_DETAIL_MAX_CHARS = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses a brain.* row's own JSON payload into the two generic ticker facts
 * (see TimelineKeyframe's brainCount/brainDetail doc comments) — real values
 * only, never fabricated: a malformed/unexpected payload shape degrades to
 * both fields absent (the ticker still renders the raw event type via
 * replayTicker.ts's fallback), never a guessed count or label.
 */
function parseBrainKeyframeFacts(row: JournalEventRow): { brainCount?: number; brainDetail?: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return {};
  }
  if (!isRecord(payload)) return {};

  if (row.type === 'brain.recalled' && Array.isArray(payload.nodeIds)) {
    return { brainCount: payload.nodeIds.length };
  }
  if (row.type === 'brain.captured' && typeof payload.kind === 'string') {
    return { brainDetail: payload.kind.slice(0, BRAIN_DETAIL_MAX_CHARS) };
  }
  if (row.type === 'brain.promoted' && typeof payload.scope === 'string') {
    return { brainDetail: payload.scope.slice(0, BRAIN_DETAIL_MAX_CHARS) };
  }
  if (
    (row.type === 'brain.decision_created' || row.type === 'brain.decision_hit') &&
    typeof payload.question === 'string'
  ) {
    return { brainDetail: payload.question.slice(0, BRAIN_DETAIL_MAX_CHARS) };
  }
  return {};
}

/** Ascending-by-seq/ts sort — same tie-break convention as missionHistory.ts's
 *  own (private) `sortedAsc`. */
function sortedAsc(events: readonly JournalEventRow[]): JournalEventRow[] {
  return [...events].sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.ts_ms - b.ts_ms));
}

function buildStatusKeyframes(asc: readonly JournalEventRow[]): StatusKeyframe[] {
  const out: StatusKeyframe[] = [];
  const created = firstOfType(asc, 'mission.created');
  if (created) out.push({ tsMs: created.ts_ms, status: 'queued' });
  const started = firstOfType(asc, 'mission.started');
  if (started) out.push({ tsMs: started.ts_ms, status: 'running' });
  const reviewRequested = firstOfType(asc, 'mission.review_requested');
  if (reviewRequested) out.push({ tsMs: reviewRequested.ts_ms, status: 'review' });
  const terminalType = deriveTerminalType(asc);
  if (terminalType) {
    const terminalEvent = firstOfType(asc, terminalType);
    const mappedStatus = TERMINAL_STATUS_MAP[terminalType];
    if (terminalEvent && mappedStatus) out.push({ tsMs: terminalEvent.ts_ms, status: mappedStatus });
  }
  // Real event timestamps should already arrive in lifecycle order, but a
  // synthetic/corrupt fixture could tie or invert two boundaries — sort
  // defensively so fleetStateAt's binary search over this array is never
  // handed a non-monotonic key.
  return out.sort((a, b) => a.tsMs - b.tsMs);
}

function buildPausedKeyframes(asc: readonly JournalEventRow[]): PausedKeyframe[] {
  const out: PausedKeyframe[] = [];
  for (const e of asc) {
    if (e.type === 'mission.paused') out.push({ tsMs: e.ts_ms, paused: true });
    else if (e.type === 'mission.resumed') out.push({ tsMs: e.ts_ms, paused: false });
  }
  return out;
}

function buildStageKeyframes(asc: readonly JournalEventRow[]): StageKeyframe[] {
  return deriveStageSpans(asc).map((span) => ({ tsMs: span.startMs, stage: span.stage }));
}

// ── Timeline construction ──────────────────────────────────────────────

/**
 * Builds the fleet-wide replay timeline from raw journal rows (any project
 * mix, any order) bounded to [windowStartMs, windowEndMs]. Pure: `events`
 * is filtered to the window FIRST — a row outside it can never leak into
 * any derived state (the "mission with no events in the window simply
 * doesn't appear" honesty rule).
 *
 * Defect #8 fix (replay/report coherence): before this fix, every
 * non-mission row (project.registered/opened/closed, and any future
 * mission-less event type) was silently dropped by `groupEventsByMission`
 * (it requires a `mission_id`) — a day with real fleet activity but zero
 * MISSION events produced an entirely empty timeline ("Aucun événement sur
 * la fenêtre"), even though the SAME window's FLUX footer (which reads the
 * raw journal, not this derivation) showed real rows. `nonMissionKeyframes`
 * below closes that gap: every row with no `mission_id` becomes a 'system'
 * keyframe, so `« Aujourd'hui »` is never emptier than the FLUX for the
 * same window.
 */
export function buildFleetTimeline(
  events: readonly JournalEventRow[],
  windowStartMs: number,
  windowEndMs: number,
): FleetTimeline {
  const inWindow = events.filter((e) => e.ts_ms >= windowStartMs && e.ts_ms <= windowEndMs);
  const grouped = groupEventsByMission(inWindow);
  const archive = buildProjectArchive(inWindow);
  const titleByMissionId = new Map(archive.map((entry) => [entry.missionId, entry.title] as const));

  const tracks = new Map<string, MissionTrack>();
  const keyframes: TimelineKeyframe[] = [];

  for (const [missionId, missionEvents] of grouped) {
    const asc = sortedAsc(missionEvents);
    if (asc.length === 0) continue;
    const title = titleByMissionId.get(missionId) ?? null;
    const createdAtMs = asc[0].ts_ms;
    const stageKeyframes = buildStageKeyframes(asc);
    const statusKeyframes = buildStatusKeyframes(asc);
    const pausedKeyframes = buildPausedKeyframes(asc);

    tracks.set(missionId, { missionId, title, createdAtMs, stageKeyframes, statusKeyframes, pausedKeyframes });

    keyframes.push({ tsMs: createdAtMs, missionId, kind: 'created', title });
    for (const k of stageKeyframes) {
      keyframes.push({ tsMs: k.tsMs, missionId, kind: 'stage', title, stage: k.stage });
    }
    for (const k of statusKeyframes) {
      if (k.tsMs === createdAtMs) continue; // redundant "queued at creation" ticker line
      keyframes.push({ tsMs: k.tsMs, missionId, kind: 'status', title, status: k.status });
    }
  }

  const chainFires = deriveChainFires(inWindow);
  for (const fire of chainFires) {
    if (fire.kind !== 'fired') continue; // ticker/edge-pulse only cares about a REAL local launch
    keyframes.push({
      tsMs: fire.tsMs,
      missionId: fire.sourceMissionId,
      kind: 'chain_fired',
      title: titleByMissionId.get(fire.sourceMissionId) ?? null,
      chainId: fire.chainId,
    });
  }

  // Defect #8 fix — see this function's doc comment: every row with no
  // owning mission (project.registered/opened/closed today, any other
  // mission-less event type tomorrow) is a real fleet keyframe too.
  // Brain-integration wave: a brain.* row (also mission_id-less) gets its OWN
  // 'brain' kind instead of falling into the generic 'system' bucket, so the
  // ticker can render a real, payload-derived line (see
  // parseBrainKeyframeFacts) rather than the raw event-type fallback.
  for (const e of inWindow) {
    if (e.mission_id) continue; // already covered by the per-mission pass above
    if (BRAIN_EVENT_TYPES.has(e.type)) {
      keyframes.push({
        tsMs: e.ts_ms,
        missionId: null,
        kind: 'brain',
        title: null,
        projectId: e.project_id,
        eventType: e.type,
        ...parseBrainKeyframeFacts(e),
      });
      continue;
    }
    keyframes.push({
      tsMs: e.ts_ms,
      missionId: null,
      kind: 'system',
      title: null,
      projectId: e.project_id,
      eventType: e.type,
    });
  }

  keyframes.sort((a, b) => a.tsMs - b.tsMs);

  return { windowStartMs, windowEndMs, tracks, chainFires, keyframes };
}

// ── Binary-search reads (perf: no per-frame O(events) scans) ──────────

function lastAtOrBefore<T extends { tsMs: number }>(arr: readonly T[], tMs: number): T | undefined {
  let lo = 0;
  let hi = arr.length - 1;
  let answer: T | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].tsMs <= tMs) {
      answer = arr[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return answer;
}

/** First index in `arr` whose tsMs is strictly greater than `tMs` (upper
 *  bound) — used by {@link firesBetween} to avoid a linear scan. */
function upperBound<T extends { tsMs: number }>(arr: readonly T[], tMs: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].tsMs <= tMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The fleet's honest state at instant `tMs`: one entry per mission whose
 * track has ANY event at or before `tMs` (a mission that hasn't appeared
 * yet is simply absent — see module header). Each field is the most recent
 * real keyframe at or before `tMs` via binary search over that mission's
 * own (small, <=~7 entry) keyframe arrays — O(missions * log(keyframes)),
 * never a scan of the full event list, so this stays cheap to call on
 * every scrub/play tick even at fleet scale (150+ missions).
 */
export function fleetStateAt(timeline: FleetTimeline, tMs: number): Map<string, FleetStateEntry> {
  const out = new Map<string, FleetStateEntry>();
  for (const track of timeline.tracks.values()) {
    if (tMs < track.createdAtMs) continue; // honesty: not created yet at T -> hidden, never faked
    const stage = lastAtOrBefore(track.stageKeyframes, tMs)?.stage ?? 'plan';
    const status = lastAtOrBefore(track.statusKeyframes, tMs)?.status ?? 'queued';
    const paused = lastAtOrBefore(track.pausedKeyframes, tMs)?.paused ?? false;
    out.set(track.missionId, {
      missionId: track.missionId,
      title: track.title,
      existsSince: track.createdAtMs,
      stage,
      status,
      paused,
    });
  }
  return out;
}

/**
 * Every REAL chain.fired event with `t0Ms < tsMs <= t1Ms` (t0 exclusive so
 * a fixed playhead never re-reports the same fire twice; t1 inclusive so
 * landing exactly on a fire's timestamp still shows its pulse). Callers
 * pass t0 <= t1 (the previous vs. new playhead position) — an inverted
 * range (scrubbing backward) returns [] rather than replaying old fires
 * out of order.
 */
export function firesBetween(timeline: FleetTimeline, t0Ms: number, t1Ms: number): ChainFireEntry[] {
  if (t1Ms < t0Ms) return [];
  const arr = timeline.chainFires;
  const startIdx = upperBound(arr, t0Ms);
  const out: ChainFireEntry[] = [];
  for (let i = startIdx; i < arr.length && arr[i].tsMs <= t1Ms; i += 1) {
    if (arr[i].kind === 'fired') out.push(arr[i]);
  }
  return out;
}

/** The last global keyframe at or before `tMs` — feeds ReplayBar's one-line
 *  event ticker ("14:32 — M12 → TEST"). `undefined` before the very first
 *  keyframe (or when the window has none at all — the bar's own empty
 *  state, "Aucun événement sur la fenêtre"). */
export function lastKeyframeAtOrBefore(timeline: FleetTimeline, tMs: number): TimelineKeyframe | undefined {
  return lastAtOrBefore(timeline.keyframes, tMs);
}

/**
 * Buckets every keyframe's tsMs into `bucketCount` equal-width slots across
 * [windowStartMs, windowEndMs] — the scrubber's density ticks. Pure
 * counting pass over the (already small, pre-computed once per load)
 * keyframes array; not called per animation frame (ReplayBar memoizes it
 * once per timeline).
 */
export function densityBuckets(timeline: FleetTimeline, bucketCount: number): number[] {
  const buckets = new Array<number>(Math.max(1, bucketCount)).fill(0);
  const span = timeline.windowEndMs - timeline.windowStartMs;
  if (span <= 0) return buckets;
  for (const k of timeline.keyframes) {
    const frac = (k.tsMs - timeline.windowStartMs) / span;
    const idx = Math.min(buckets.length - 1, Math.max(0, Math.floor(frac * buckets.length)));
    buckets[idx] += 1;
  }
  return buckets;
}
