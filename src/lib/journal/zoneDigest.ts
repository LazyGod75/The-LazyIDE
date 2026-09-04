/* zoneDigest.ts — pure "living empty zone" read-model (defect #6 fix): what
   a project's canvas zone should show even when it has zero CURRENT
   missions, so an idle zone reads as quiet, never dead.

   Reuses missionHistory.ts's buildProjectArchive (every mission the journal
   ever saw for the project, including ones long pruned from
   missions_current) and projectReport.ts's buildProjectReport
   (mergedToday accounting) rather than re-deriving either — same honesty
   contract both siblings already established: a field with no real
   originating event is absent, never fabricated. Pure: no I/O, no React —
   see useZoneDigest.ts for the hook wiring this to the live journal.
*/

import type { JournalEventRow, JournalEventType } from './eventTypes.js';
import { buildProjectArchive } from './missionHistory.js';
import { buildProjectReport } from './projectReport.js';

/** Ghost rows shown in an idle zone body — enough to feel real, never a
 *  wall of history (spec: "up to 3 recent terminal missions"). */
const MAX_RECENT_MISSIONS = 3;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ── Brain visibility (brain-integration wave) ─────────────────────────
//
// Every brain.* event type the journal actually emits (eventTypes.ts) —
// federatedRecall.ts (brain.recalled), decisions.ts (brain.decision_created/
// brain.decision_hit), consolidation.ts (brain.captured/brain.promoted).
// None of these carry a mission_id (cross-project/project-scoped facts, not
// mission-scoped ones), which is exactly why `lastActivity` above (already
// type-agnostic — it never filters by type) already surfaces them as-is; this
// set exists only to derive the two DEDICATED brain signals below.
const BRAIN_EVENT_TYPES: ReadonlySet<JournalEventType> = new Set([
  'brain.recalled',
  'brain.captured',
  'brain.promoted',
  'brain.decision_created',
  'brain.decision_hit',
]);

/** Events that add a genuinely NEW neuron to the brain — captured (a new
 *  note/insight) and decision_created (a new decision). `recalled` (a read),
 *  `promoted` (moves an existing neuron's scope), and `decision_hit` (reuses
 *  an existing decision) never create a new one, so they must not inflate
 *  brainNeuronsToday. */
const NEURON_CREATING_TYPES: ReadonlySet<JournalEventType> = new Set([
  'brain.captured',
  'brain.decision_created',
]);

/** Same LOCAL-calendar-day convention as projectReport.ts's own (private)
 *  isSameLocalDay — duplicated locally rather than exported/shared across
 *  modules, matching this codebase's established "each module keeps its own
 *  small copy" precedent (see e.g. MissionCurrentRow duplicated verbatim
 *  across chainEngine.ts/fleetMissions.ts). */
function isSameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Minimal `useI18n().t` shape — same local-alias convention
 *  CanvasCommandBar.tsx/replayTicker.ts already established for passing
 *  `t` around as a plain parameter into a non-React pure function. */
export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/**
 * Small i18n-aware relative-age formatter ("il y a 2h" style) shared by
 * every zone-digest consumer (ProjectGroupNode.tsx's living empty zone,
 * ProjectReportPage.tsx's empty-state "Dernière activité" line — see
 * their own call sites for "same zone-digest source"). Deliberately NOT
 * AttentionInbox.tsx's private, English-only `timeAgo` (not exported, not
 * locale-aware): this one goes through `t()` so it respects the active
 * locale like every other canvas label.
 */
export function formatZoneDigestAge(atMs: number, t: TranslateFn, nowMs: number = Date.now()): string {
  const diff = Math.max(0, nowMs - atMs);
  if (diff < MINUTE_MS) return t('canvas.zone.digest.justNow');
  if (diff < HOUR_MS) return t('canvas.zone.digest.minutesAgo', { count: Math.floor(diff / MINUTE_MS) });
  if (diff < DAY_MS) return t('canvas.zone.digest.hoursAgo', { count: Math.floor(diff / HOUR_MS) });
  return t('canvas.zone.digest.daysAgo', { count: Math.floor(diff / DAY_MS) });
}

/** Ghost-row status label i18n key per terminal event type
 *  (ZoneDigestMission.terminalType) — shared mission-status label mapping
 *  local to the zone-digest feature (no single canonical one exists across
 *  the canvas components today; see this fix's report). */
const ZONE_DIGEST_STATUS_KEY: Partial<Record<JournalEventType, string>> = {
  'mission.completed': 'canvas.zone.digest.status.completed',
  'mission.approved': 'canvas.zone.digest.status.approved',
  'mission.failed': 'canvas.zone.digest.status.failed',
  'mission.cancelled': 'canvas.zone.digest.status.cancelled',
  'mission.rejected': 'canvas.zone.digest.status.rejected',
  'mission.reverted': 'canvas.zone.digest.status.reverted',
};

/** Resolves a terminal event type to its ghost-row status i18n key, falling
 *  back to the 'completed' label for any type not in the map above (never
 *  undefined — every call site needs a renderable string). */
export function zoneDigestStatusLabelKey(terminalType: JournalEventType): string {
  return ZONE_DIGEST_STATUS_KEY[terminalType] ?? 'canvas.zone.digest.status.completed';
}

export interface ZoneDigestActivity {
  type: JournalEventType;
  atMs: number;
}

/** One compact "ghost row" — a mission that reached SOME terminal outcome
 *  (done, failed, cancelled, rejected, reverted — not just a successful
 *  merge), newest first. */
export interface ZoneDigestMission {
  missionId: string;
  title: string | null;
  terminalType: JournalEventType;
  atMs: number;
}

export interface ZoneDigest {
  /** The single most recent event of ANY type observed for this project
   *  (project.*, mission.*, chain.*, ...) — null when the journal has no
   *  rows for it at all yet. This is what makes an idle zone's "dernier
   *  événement il y a 2h — mission.completed" line honest: it is never
   *  narrower than what the FLUX footer already shows for the same
   *  project (both read the same journal). */
  lastActivity: ZoneDigestActivity | null;
  /** Up to MAX_RECENT_MISSIONS most-recently-finished missions. */
  recentMissions: readonly ZoneDigestMission[];
  /** Missions that reached a SUCCESS terminal event today (local calendar
   *  day) — same accounting as projectReport.ts's own mergedTodayCount. */
  mergedTodayCount: number;
  /**
   * Brain visibility (brain-integration wave) — the single most recent
   * brain.* event (recalled/captured/promoted/decision_created/
   * decision_hit) observed for this project, null when none yet. Distinct
   * from `lastActivity` above: a zone whose most recent event happens to be
   * mundane (e.g. project.opened) can still honestly say "the brain last did
   * something Xh ago" from this field, instead of that fact being silently
   * shadowed by a more recent non-brain row.
   */
  lastBrainActivity: ZoneDigestActivity | null;
  /**
   * Count of brain.captured + brain.decision_created events (real NEW
   * neurons only — not reads/promotions/reuses, see NEURON_CREATING_TYPES)
   * whose timestamp falls on the same LOCAL calendar day as `nowMs` — same
   * accounting convention as `mergedTodayCount`/projectReport.ts's own. An
   * honest 0 when the project's brain learned nothing today, never absent
   * (the count is always derivable from whatever events were queried).
   */
  brainNeuronsToday: number;
}

/** Builds a zone digest from a flat (any order) list of one project's
 *  journal rows. `nowMs` is injectable for deterministic "today" tests;
 *  defaults to Date.now(). */
export function buildZoneDigest(events: readonly JournalEventRow[], nowMs: number = Date.now()): ZoneDigest {
  let lastActivity: ZoneDigestActivity | null = null;
  let lastBrainActivity: ZoneDigestActivity | null = null;
  let brainNeuronsToday = 0;
  for (const row of events) {
    if (!lastActivity || row.ts_ms > lastActivity.atMs) {
      lastActivity = { type: row.type, atMs: row.ts_ms };
    }
    if (BRAIN_EVENT_TYPES.has(row.type)) {
      if (!lastBrainActivity || row.ts_ms > lastBrainActivity.atMs) {
        lastBrainActivity = { type: row.type, atMs: row.ts_ms };
      }
      if (NEURON_CREATING_TYPES.has(row.type) && isSameLocalDay(row.ts_ms, nowMs)) {
        brainNeuronsToday += 1;
      }
    }
  }

  const recentMissions: ZoneDigestMission[] = [];
  for (const entry of buildProjectArchive(events)) {
    if (entry.terminalType === null) continue;
    recentMissions.push({
      missionId: entry.missionId,
      title: entry.title,
      terminalType: entry.terminalType,
      atMs: entry.lastEventMs,
    });
    if (recentMissions.length >= MAX_RECENT_MISSIONS) break;
  }

  const { mergedTodayCount } = buildProjectReport(events, nowMs);

  return { lastActivity, recentMissions, mergedTodayCount, lastBrainActivity, brainNeuronsToday };
}
