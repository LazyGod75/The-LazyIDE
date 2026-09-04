/* frictionMiner.ts — Journal pathology mining for the self-improvement loop
   (Pillar D5, v1). Extends improvementLoop.ts's per-mission diagnosis
   suggestions with direct aggregation over the journal reward vocabulary
   (eventTypes.ts): recurring mission.failed reasons, mission.reverted{merged:
   true}, repeated mission.intervened, gate.failed by reviewer role, and
   budget./duration. cap warnings.

   mineFrictionsFromJournal is a PURE function (no platform/network access) so
   the ranking logic is unit-testable against a synthetic journal fixture —
   mineFrictions is the thin async orchestration that fetches real rows and
   folds in improvementLoop.ts's existing diagnosis-based suggestions.

   Never launches anything: the output is a ranked list of candidates for a
   caller (frictionAnalysis.ts) to materialize as canvas drafts, which still
   go through the normal approval/launch flow.
*/

import { journalQuery } from '../journal/journal.js';
import type { GateFailedPayload, JournalEventRow, MissionFailedPayload, MissionRevertedPayload } from '../journal/eventTypes.js';
import { runImprovementLoop, type ImprovementSuggestion } from './improvementLoop.js';
import type { AutonomyConfig } from './types.js';

// ── Types ─────────────────────────────────────────────────────────

export type FrictionSeverity = 'low' | 'medium' | 'high';

export interface ImprovementCandidate {
  id: string;
  projectId: string;
  title: string;
  /** Human-readable WHERE x WHY pathology description. */
  rationale: string;
  /** Machine-readable pathology location (e.g. 'gate:tester', 'budget', 'merge'). */
  where: string;
  /** Machine-readable pathology cause — short slug, used for brain tags. */
  why: string;
  suggestedTask: string;
  /** Mission ids / journal event kinds that support this candidate. */
  evidence: string[];
  severity: FrictionSeverity;
}

const JOURNAL_TYPES = [
  'mission.failed',
  'mission.reverted',
  'mission.intervened',
  'gate.failed',
  'budget.warning',
  'budget.exceeded',
  'duration.warning',
  'duration.exceeded',
] as const;

const SEVERITY_RANK: Record<FrictionSeverity, number> = { high: 2, medium: 1, low: 0 };

function parsePayload<T>(row: JournalEventRow): T | undefined {
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return undefined;
  }
}

function severityFor(count: number): FrictionSeverity {
  if (count >= 5) return 'high';
  if (count >= 2) return 'medium';
  return 'low';
}

function bySeverityDesc(a: ImprovementCandidate, b: ImprovementCandidate): number {
  return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
}

// ── Pure aggregation ───────────────────────────────────────────────

/**
 * Aggregates a project's journal rows into ranked improvement candidates.
 * Pure: never touches the network/platform — callers supply the rows
 * (mineFrictions below fetches them for real; tests supply a fixture).
 */
export function mineFrictionsFromJournal(projectId: string, events: readonly JournalEventRow[]): ImprovementCandidate[] {
  const failedReasons = new Map<string, { count: number; missionIds: string[] }>();
  const revertedMerged: string[] = [];
  const intervenedByMission = new Map<string, number>();
  const gateFailedByRole = new Map<string, { count: number; missionIds: string[]; reasons: string[] }>();
  let budgetWarnings = 0;
  let durationWarnings = 0;

  for (const row of events) {
    if (row.type === 'mission.failed') {
      const reason = parsePayload<MissionFailedPayload>(row)?.reason ?? 'unknown';
      const bucket = failedReasons.get(reason) ?? { count: 0, missionIds: [] };
      bucket.count += 1;
      if (row.mission_id) bucket.missionIds.push(row.mission_id);
      failedReasons.set(reason, bucket);
    } else if (row.type === 'mission.reverted') {
      const payload = parsePayload<MissionRevertedPayload>(row);
      if (payload?.merged && row.mission_id) revertedMerged.push(row.mission_id);
    } else if (row.type === 'mission.intervened') {
      if (row.mission_id) intervenedByMission.set(row.mission_id, (intervenedByMission.get(row.mission_id) ?? 0) + 1);
    } else if (row.type === 'gate.failed') {
      const payload = parsePayload<GateFailedPayload>(row);
      const role = payload?.role ?? 'unknown';
      const bucket = gateFailedByRole.get(role) ?? { count: 0, missionIds: [], reasons: [] };
      bucket.count += 1;
      if (row.mission_id) bucket.missionIds.push(row.mission_id);
      if (payload?.reason) bucket.reasons.push(payload.reason);
      gateFailedByRole.set(role, bucket);
    } else if (row.type === 'budget.warning' || row.type === 'budget.exceeded') {
      budgetWarnings += 1;
    } else if (row.type === 'duration.warning' || row.type === 'duration.exceeded') {
      durationWarnings += 1;
    }
  }

  const candidates: ImprovementCandidate[] = [];

  for (const [reason, bucket] of failedReasons) {
    candidates.push({
      id: `friction-failed-${reason.slice(0, 40)}`,
      projectId,
      title: `Recurring mission failure: ${reason.slice(0, 80)}`,
      where: 'mission-execution',
      why: reason.slice(0, 60),
      rationale: `${bucket.count} mission(s) failed for the same reason ("${reason}") in this project.`,
      suggestedTask: `Investigate and fix the recurring failure cause: ${reason}`,
      evidence: [...bucket.missionIds, 'mission.failed'],
      severity: severityFor(bucket.count),
    });
  }

  if (revertedMerged.length > 0) {
    candidates.push({
      id: 'friction-reverted-merged',
      projectId,
      title: 'Merged missions later reverted',
      where: 'merge',
      why: 'reverted-after-merge',
      rationale: `${revertedMerged.length} mission(s) were merged then reverted — the approval gate let a bad change through.`,
      suggestedTask: 'Tighten the approval/review criteria that let a since-reverted change merge.',
      evidence: [...revertedMerged, 'mission.reverted'],
      severity: severityFor(revertedMerged.length),
    });
  }

  const heavilyIntervened = [...intervenedByMission.entries()].filter(([, count]) => count >= 2);
  if (heavilyIntervened.length > 0) {
    const total = heavilyIntervened.reduce((sum, [, count]) => sum + count, 0);
    candidates.push({
      id: 'friction-intervened',
      projectId,
      title: 'Missions needing repeated human intervention',
      where: 'autonomy',
      why: 'repeated-intervention',
      rationale: `${heavilyIntervened.length} mission(s) required 2+ manual interventions (${total} total) — the agent is not autonomous enough for this task shape.`,
      suggestedTask: 'Review the intervention notes and adapt the agent prompt/template for this task shape.',
      evidence: [...heavilyIntervened.map(([id]) => id), 'mission.intervened'],
      severity: severityFor(total),
    });
  }

  for (const [role, bucket] of gateFailedByRole) {
    candidates.push({
      id: `friction-gate-${role}`,
      projectId,
      title: `Repeated ${role} gate rejections`,
      where: `gate:${role}`,
      why: (bucket.reasons[0] ?? 'reviewer-rejection').slice(0, 60),
      rationale: `The ${role} reviewer rejected ${bucket.count} mission(s) in this project.`,
      suggestedTask: `Address the recurring ${role} review feedback: ${bucket.reasons[0] ?? 'see mission history'}.`,
      evidence: [...bucket.missionIds, 'gate.failed'],
      severity: severityFor(bucket.count),
    });
  }

  if (budgetWarnings + durationWarnings > 0) {
    candidates.push({
      id: 'friction-caps',
      projectId,
      title: 'Missions frequently near budget/duration caps',
      where: 'sizing',
      why: 'cap-pressure',
      rationale: `${budgetWarnings} budget warning(s) and ${durationWarnings} duration warning(s) — missions in this project are frequently under-sized for their cost/time caps.`,
      suggestedTask: 'Raise default caps for this project or split large tasks into smaller missions.',
      evidence: ['budget.warning', 'duration.warning'],
      severity: severityFor(budgetWarnings + durationWarnings),
    });
  }

  return candidates.sort(bySeverityDesc);
}

/** Converts an improvementLoop.ts diagnosis suggestion into the ranked
 *  candidate shape, so both mining strategies share one output type. */
function suggestionToCandidate(projectId: string, suggestion: ImprovementSuggestion, index: number): ImprovementCandidate {
  const severity: FrictionSeverity = suggestion.confidence >= 0.8 ? 'high' : suggestion.confidence >= 0.6 ? 'medium' : 'low';
  return {
    id: `friction-diagnosis-${index}`,
    projectId,
    title: suggestion.task.slice(0, 80),
    where: 'diagnosis-engine',
    why: suggestion.reason.slice(0, 60),
    rationale: suggestion.reason,
    suggestedTask: suggestion.task,
    evidence: ['diagnosis-engine'],
    severity,
  };
}

// ── Orchestration ─────────────────────────────────────────────────

/**
 * Full v1 miner: combines improvementLoop.ts's existing per-mission diagnosis
 * suggestions with direct journal-vocabulary aggregation, ranked by severity.
 * `journalEvents` is an injection point for tests — production callers omit
 * it and let this fetch real rows via journalQuery.
 */
export async function mineFrictions(
  projectId: string,
  projectRoot?: string,
  autonomy?: AutonomyConfig,
  journalEvents?: readonly JournalEventRow[],
): Promise<ImprovementCandidate[]> {
  const suggestions = await runImprovementLoop(projectId, projectRoot, autonomy);
  const fromDiagnosis = suggestions.map((s, i) => suggestionToCandidate(projectId, s, i));

  let events = journalEvents;
  if (!events) {
    try {
      events = await journalQuery({ projectId, types: [...JOURNAL_TYPES], limit: 500 });
    } catch (err: unknown) {
      console.warn('[frictionMiner] journalQuery failed, mining diagnosis-only:', err);
      events = [];
    }
  }

  const fromJournal = mineFrictionsFromJournal(projectId, events);
  return [...fromDiagnosis, ...fromJournal].sort(bySeverityDesc);
}
