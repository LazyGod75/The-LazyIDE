/* cockpitHelpers.ts — pure derivations for the fleet Cockpit (Wave 2).

   No I/O, no React — fully unit-testable (see
   src/__tests__/cockpitHelpers.test.ts). Consumes FleetMission/FleetProject
   (src/lib/agents/fleetMissions.ts) and derives everything the Cockpit's
   AGENTS zone, KPI row, and météo phrase need: urgency classification,
   sort order, badge text, elapsed-time formatting, and model-family
   grouping. Kept separate from the rendering components so every rule here
   is independently testable without mounting React.
*/

import type { FleetMission, FleetProject } from '../../../lib/agents/fleetMissions';
import type { FleetStage } from '../../../lib/agents/fleetStage';
import type { TFunc } from '../../../lib/agents/runtime';
import { isJudgeRejected } from '../approveGate';

// ── Urgent card action shape (moved from UrgentMissionCard.tsx to break the
//    import cycle between the two files — pure relocation, no behavior
//    change: UrgentMissionCard.tsx now imports this type from here instead
//    of defining it, same as it already does for UrgentKind below) ────────

export interface UrgentAction {
  key: string;
  label: string;
  solid?: boolean;
}

// ── Shared pipeline grid layout (header row + every project row) ────────

export const PIPELINE_STAGES: readonly FleetStage[] = ['plan', 'code', 'test', 'review', 'merged'];
export const PIPELINE_GRID_TEMPLATE = '200px 0.8fr 1.2fr 1fr 1fr 0.7fr';

// ── Urgency classification ──────────────────────────────────────────

export type UrgentKind = 'permission' | 'failed' | 'review';

/**
 * Maps a FleetMission onto the Cockpit's 3 urgent-card kinds. This codebase
 * has no `MissionStatus` value equivalent to the design mock's 'blocked' —
 * the real analog is a RUNNING mission with a genuine pending ask_user
 * question (see fleetMissions.ts's `pendingQuestion`, sourced from
 * missionQuestion.ts's extractPendingQuestionText). Returns null for a
 * mission that needs no human action right now.
 */
export function classifyUrgent(mission: FleetMission): UrgentKind | null {
  if (mission.pendingQuestion) return 'permission';
  if (mission.status === 'failed') return 'failed';
  if (mission.status === 'review') return 'review';
  return null;
}

const URGENT_KIND_PRIORITY: Record<UrgentKind, number> = {
  permission: 0,
  failed: 1,
  review: 2,
};

export interface RankedUrgentMission {
  projectId: string;
  mission: FleetMission;
  kind: UrgentKind;
  /** 1-based rank across the WHOLE fleet — matches the design's "N°1"/"N°2"
   *  cross-mission numbering (oldest/most-urgent first). */
  rank: number;
}

/**
 * Every urgent mission across the whole fleet, ranked: permission first,
 * then failed, then review, each group oldest (by updatedMs) first — same
 * ordering rule as the design mock's decisions() queue (§12.5), extended
 * with the 'failed' kind this codebase actually has.
 */
export function rankUrgentMissions(projects: FleetProject[]): RankedUrgentMission[] {
  const flat: Array<{ projectId: string; mission: FleetMission; kind: UrgentKind }> = [];
  for (const project of projects) {
    for (const mission of project.missions) {
      const kind = classifyUrgent(mission);
      if (kind) flat.push({ projectId: project.projectId, mission, kind });
    }
  }
  flat.sort((a, b) => {
    const kindDiff = URGENT_KIND_PRIORITY[a.kind] - URGENT_KIND_PRIORITY[b.kind];
    if (kindDiff !== 0) return kindDiff;
    return a.mission.updatedMs - b.mission.updatedMs;
  });
  return flat.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

// ── Urgent card action set ────────────────────────────────────────────

/**
 * Which action buttons an urgent card offers, per kind. Moved here from
 * ProjectRow.tsx (its sole previous call site) so it's independently
 * unit-testable without mounting React — same rationale as every other
 * export in this file (see module doc comment).
 */
export interface UrgentActionsForParams {
  mission: FleetMission;
  kind: UrgentKind;
  t: (key: string) => string;
  forceApprove: boolean;
}

export function urgentActionsFor({ mission, kind, t, forceApprove }: UrgentActionsForParams): UrgentAction[] {
  if (kind === 'permission') {
    return [
      { key: 'deny-replan', label: t('cockpit.action.denyReplan'), solid: true },
      { key: 'allow-once', label: t('cockpit.action.allowOnce') },
    ];
  }
  if (kind === 'failed') {
    return [
      { key: 'promote', label: t('cockpit.action.promote'), solid: true },
      { key: 'logs', label: t('cockpit.action.logs') },
    ];
  }
  const reviewActions: UrgentAction[] = [
    { key: 'merge', label: t(forceApprove ? 'cockpit.action.forceMerge' : 'cockpit.action.merge'), solid: true },
    { key: 'diff', label: t('cockpit.action.diff') },
  ];
  // QA B15: a 'review' mission whose judge actually REJECTED it (not just
  // still evaluating) also gets "Promouvoir en sonnet" — before this, the
  // only way to react to a rejected verdict was force-merge or discard;
  // Retry-with-a-stronger-model was reachable only from a genuine 'failed'
  // status, which a rejected judge verdict never produces (it leaves the
  // mission in 'review' — see approveGate.ts's isJudgeRejected doc comment).
  if (isJudgeRejected(mission)) {
    reviewActions.push({ key: 'promote', label: t('cockpit.action.promote') });
  }
  return reviewActions;
}

/** Count of missions needing a human decision right now, fleet-wide — the
 *  single source of truth for the météo phrase and the "décisions" KPI, so
 *  both always agree with what the AGENTS zone actually renders as urgent. */
export function countPendingDecisions(projects: FleetProject[]): number {
  return rankUrgentMissions(projects).length;
}

// ── Sorting within a pipeline column ────────────────────────────────

/**
 * Orders missions inside one (project, stage) column: urgent first (by the
 * same permission > failed > review priority), then actively running, then
 * everything else, then queued last — mirrors the design's §8.2 sort rule.
 */
export function sortMissionsForColumn(missions: FleetMission[]): FleetMission[] {
  function weight(m: FleetMission): number {
    const urgent = classifyUrgent(m);
    if (urgent) return URGENT_KIND_PRIORITY[urgent];
    if (m.status === 'running') return 10;
    if (m.status === 'queued') return 20;
    return 15;
  }
  return [...missions].sort((a, b) => weight(a) - weight(b) || a.updatedMs - b.updatedMs);
}

// ── Elapsed-time formatting (mono-styled badge suffix) ──────────────────

/** "18 min" / "2 h" / "3 j" — mono-styled badge suffix, real elapsed time
 *  from `updatedMs` (never a hardcoded per-id string like the mock).
 *  Translated via `t` when supplied — falls back to the ORIGINAL hardcoded
 *  French otherwise, same optional-everywhere contract as runtime.ts's own
 *  TFunc (see its doc comment). */
export function formatElapsed(updatedMs: number, t?: TFunc, nowMs: number = Date.now()): string {
  const diffMs = Math.max(0, nowMs - updatedMs);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return t ? t('cockpit.elapsed.justNow') : "à l'instant";
  if (minutes < 60) return t ? t('cockpit.elapsed.minutesAgo', { count: minutes }) : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t ? t('cockpit.elapsed.hoursAgo', { count: hours }) : `${hours} h`;
  const days = Math.floor(hours / 24);
  return t ? t('cockpit.elapsed.daysAgo', { count: days }) : `${days} j`;
}

// ── Model-family grouping (for the "N sonnets · N haikus · N opus" chips) ──

export type ModelFamily = 'sonnet' | 'haiku' | 'opus' | 'other';

export function modelFamily(model: string): ModelFamily {
  const lower = model.toLowerCase();
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('opus')) return 'opus';
  return 'other';
}

export interface ModelFamilyCounts {
  sonnet: number;
  haiku: number;
  opus: number;
  other: number;
}

/** Counts RUNNING (+ optionally queued) fleet missions by model family —
 *  real, derived from the current fleet snapshot, never hardcoded. */
export function countActiveByModelFamily(
  projects: FleetProject[],
  statuses: ReadonlyArray<FleetMission['status']> = ['running'],
): ModelFamilyCounts {
  const counts: ModelFamilyCounts = { sonnet: 0, haiku: 0, opus: 0, other: 0 };
  for (const project of projects) {
    for (const mission of project.missions) {
      if (!statuses.includes(mission.status)) continue;
      counts[modelFamily(mission.model)] += 1;
    }
  }
  return counts;
}

// ── "Promouvoir en sonnet" model-tier escalation ────────────────────────

/**
 * Next model tier up from a mission's current model label, for the failed
 * card's "Promouvoir en sonnet 🧠" action (spec: retry with a stronger
 * model). haiku -> sonnet, sonnet/other -> opus, opus stays opus (already
 * the top tier — nothing stronger to promote to).
 */
export function nextModelTierLabel(model: string): string {
  const family = modelFamily(model);
  if (family === 'haiku') return 'Sonnet 4.6';
  return 'Opus 4.5';
}

// ── Project status pills (météo bandeau, README-only feature per D1) ────

export type ProjectPillState = 'active' | 'urgent' | 'idle';

export interface ProjectPill {
  projectId: string;
  name: string;
  state: ProjectPillState;
}

/**
 * Per-project status pill for the météo bandeau (README prose feature the
 * .dc.html prototype computed but never rendered — D1 explicitly asks for
 * it to be built here): 'urgent' (red, pulses) if the project has any
 * blocked/failed/review-ready mission, 'active' (green) if it has any
 * running/queued mission, 'idle' ("zzz") if it has no active mission at
 * all.
 */
export function deriveProjectPills(projects: FleetProject[]): ProjectPill[] {
  return projects.map((project) => {
    const hasUrgent = project.missions.some((m) => classifyUrgent(m) !== null);
    const hasActive = project.missions.some((m) => m.status === 'running' || m.status === 'queued');
    const state: ProjectPillState = hasUrgent ? 'urgent' : hasActive ? 'active' : 'idle';
    return { projectId: project.projectId, name: project.name, state };
  });
}
