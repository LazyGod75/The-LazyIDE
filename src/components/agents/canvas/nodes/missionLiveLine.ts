/* missionLiveLine.ts — shared "live status line" derivation for a mission
   card, extracted from MissionNode.tsx to break the import cycle between
   MissionNode.tsx and LiveMissionPanel.tsx (both need this logic; it used
   to live in MissionNode.tsx with LiveMissionPanel.tsx importing it back,
   a real value-level cycle — see madge's circular-dependency report). Pure
   relocation: same implementation, same exports, MissionNode.tsx now
   re-exports these two symbols so every existing external import (tests,
   LiveMissionPanel.tsx) keeps working unchanged.
*/

import { humanizeLiveAction, humanizeLiveActionParts, type LiveActionParts } from '../../../../lib/agents/liveActionSummary';
import type { FleetMission } from '../../../../lib/agents/fleetMissions';
import type { JudgeVerdict } from '../../../../lib/agents/types';
import { JUDGE_UNAVAILABLE_PROVIDER_REASON } from '../../../../lib/agents/evaluator';
import type { NodeLiveness } from '../chrome/nodeChrome';
import { translateStatusReason } from '../../../../lib/agents/statusReasonLabel';
import { basename } from '../../../../lib/paths';

// fix/canvas-ux R4d (dogfood defect #3) — a mission's `liveAction` is a raw
// "last message" field the native runner keeps overwriting WHILE a mission
// is actually running; once the status moves on (review/failed/done/
// paused/queued), that string is just whatever happened to be written last
// — not a lie exactly, but not this status's own truth either (R3 dogfood:
// a FAILED card showing "en attente…", a REVIEW card still showing "Running
// reviewer sub-agent…" after the review had already ended). Guard at
// render: trust `liveAction` ONLY while genuinely running (liveness
// 'running' already excludes 'paused' — see deriveMissionLiveness's own
// `if (mission.paused) return 'paused'` short-circuit, which runs BEFORE
// the status switch). Every other bucket gets ITS OWN honest state line
// instead of the stale leftover — pure, so it is directly unit-testable per
// status (see canvasNodes.test.tsx) without mounting the whole card.
type LiveLineMission = Pick<
  FleetMission,
  'liveAction' | 'statusReason' | 'pendingQuestion' | 'judgeVerdict' | 'diffFiles'
>;

/**
 * True when a JudgeVerdict's own `judge` reviewer entry carries the
 * JUDGE_UNAVAILABLE_PROVIDER_REASON marker (evaluator.ts) — i.e. the judge
 * sub-agent's OWN provider call hit a definitive, never-retry error and the
 * judge step never actually ran, as opposed to running and rejecting the
 * mission.
 *
 * Real incident (founder, 2026-08-05, DeepSeek 402): with every reviewer
 * inconclusive, evaluator.ts's aggregateVerdict has no conclusive vote to
 * average (`conclusiveNonJudge.length === 0`), so `passed` falls through to
 * `false` — a blocked approval then read as "Le juge a rejeté cette
 * mission", even though no judge ever actually looked at the code. This
 * predicate is the one place that distinction is made, so every caller
 * (this file's `deriveLiveLine`, PendingApprovalCard.tsx's own best-effort
 * mirror) shows the honest "evaluation unavailable" state instead of a
 * fabricated rejection.
 */
export function isJudgeVerdictUnavailable(verdict: Pick<JudgeVerdict, 'reviewers'> | undefined | null): boolean {
  if (!verdict) return false;
  return verdict.reviewers.some(
    (r) => r.role === 'judge' && r.summary.startsWith(`${JUDGE_UNAVAILABLE_PROVIDER_REASON}:`),
  );
}

function firstCursorFile(mission: LiveLineMission): string {
  const name = mission.diffFiles?.[0]?.filename?.trim();
  return name ? basename(name) : '';
}

function withCursorFile(text: string, mission: LiveLineMission): string {
  const file = firstCursorFile(mission);
  return file ? `${text} · ${file}` : text;
}

function reviewStatusLine(
  mission: LiveLineMission,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (!mission.judgeVerdict) return t('agents.status.review');
  if (isJudgeVerdictUnavailable(mission.judgeVerdict)) return t('canvas.node.verdictJudgeUnavailable');
  return t(mission.judgeVerdict.passed ? 'canvas.node.verdictApproved' : 'canvas.node.verdictRejected');
}

export function deriveLiveLine(
  mission: LiveLineMission,
  liveness: NodeLiveness,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (mission.pendingQuestion) return mission.pendingQuestion;
  if (liveness === 'running') return humanizeLiveAction(mission.liveAction) || t('cockpit.card.noLiveText');
  if (liveness === 'paused') return t('agents.status.paused');
  if (liveness === 'review') return withCursorFile(reviewStatusLine(mission, t), mission);
  // Real bug (M26, confirmed live): this is the exact card line that showed
  // the bare "consecutive_failures" machine token — translateStatusReason
  // maps every known raw reason to prose and never lets an unrecognized
  // snake_case token through (see statusReasonLabel.ts).
  if (liveness === 'failed') return translateStatusReason(mission.statusReason, t) ?? t('agents.status.failed');
  if (liveness === 'merged') return t('agents.status.done');
  return t('agents.status.queued');
}

/** Verb+file for LiveActionLine: running tool split, or review + real
 *  diffFiles basename. Null means the card falls back to deriveLiveLine. */
export function canvasLiveParts(
  mission: LiveLineMission,
  liveness: NodeLiveness,
  t: (key: string, params?: Record<string, string | number>) => string,
): LiveActionParts | null {
  if (mission.pendingQuestion) return null;
  if (liveness === 'running') return humanizeLiveActionParts(mission.liveAction);
  if (liveness !== 'review') return null;
  const file = firstCursorFile(mission);
  if (!file) return null;
  return { verb: reviewStatusLine(mission, t), detail: file };
}
