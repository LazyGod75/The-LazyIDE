/* runMissionReview — Steps C-empty-fail, D (review), F (eval) of runMission.

   Extracted because runMission's measured cyclomatic complexity was 46
   after the settle split (2026-08-28 ESLint; ratchet 12). Behavior copied.
*/

import type { Mission, ActionEvent, AgentMetrics } from './types.js';
import type { TFunc, MissionUpdate } from './runtime.js';
import type { CompiledPlan } from './stageContract.js';
import type { CaptureOutcomeFn } from './runMissionSettle.js';
import { evaluateMission, deriveJudgesApproved, formatVerdictScoreLine } from './evaluator.js';
import { saveArtifacts } from './artifacts.js';
import { executeLearningStage } from './learningStage.js';
import { translateStatusReason } from './statusReasonLabel.js';
import { emitBuffered } from '../journal/journal.js';

function clockHm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function tx(t: TFunc | undefined, key: string, fallback: string, params?: Record<string, string | number>): string {
  return t ? t(key, params) : fallback;
}

export interface MissionDiffSlice {
  diffSnippet: string[];
  diffAdded: number;
  diffRemoved: number;
  diffFiles: Mission['diffFiles'];
  diffIncompleteFiles: Mission['diffIncompleteFiles'];
  emptyDeliverable: boolean;
}

export async function failEmptyStepCapDeliverable(opts: {
  mission: Mission;
  projectId: string;
  branch: string;
  timeline: ActionEvent[];
  stepCapFallthroughReason: string;
  missionStartedAt: number;
  finalMetrics?: AgentMetrics;
  t?: TFunc;
  onUpdate: (update: MissionUpdate) => void;
  cleanupWorktree: () => Promise<void>;
  captureOutcome: CaptureOutcomeFn;
}): Promise<void> {
  await opts.cleanupWorktree();
  const translated = translateStatusReason(opts.stepCapFallthroughReason, opts.t) ?? opts.stepCapFallthroughReason;
  opts.onUpdate({
    id: opts.mission.id,
    patch: {
      status: 'failed',
      progress: 100,
      liveAction: undefined,
      statusReason: translated,
      actionTimeline: [
        ...opts.timeline.map((e) => ({ ...e, isLive: false })),
        { time: clockHm(), text: translated, isLive: false },
      ],
      worktree: opts.branch,
    },
  });
  opts.captureOutcome(opts.mission, opts.projectId, 'failed', opts.missionStartedAt, opts.finalMetrics, undefined, {
    category: opts.stepCapFallthroughReason,
    message: translated,
  });
}

export function announceReviewReady(opts: {
  mission: Mission;
  projectId: string;
  branch: string;
  timeline: ActionEvent[];
  diff: MissionDiffSlice;
  stepCapFallthroughReason: string | null;
  missionStartedAt: number;
  finalMetrics?: AgentMetrics;
  t?: TFunc;
  onUpdate: (update: MissionUpdate) => void;
  captureOutcome: CaptureOutcomeFn;
}): ActionEvent[] {
  const preserved = 'step cap reached — deliverable preserved for review';
  const reviewText = opts.stepCapFallthroughReason
    ? preserved
    : tx(opts.t, 'agents.runtime.diffComputed', 'Diff calculé — mission prête pour revue');
  const finalTimeline: ActionEvent[] = [
    ...opts.timeline.map((e) => ({ ...e, isLive: false })),
    { time: clockHm(), text: reviewText, isLive: false },
  ];
  const { diff } = opts;
  opts.onUpdate({
    id: opts.mission.id,
    patch: {
      status: 'review',
      progress: 100,
      liveAction: undefined,
      statusReason: opts.stepCapFallthroughReason ? preserved : undefined,
      diffSnippet: diff.diffSnippet,
      diffAdded: diff.diffAdded,
      diffRemoved: diff.diffRemoved,
      diffFiles: diff.diffFiles,
      diffIncompleteFiles: diff.diffIncompleteFiles,
      emptyDeliverable: diff.emptyDeliverable,
      actionTimeline: finalTimeline,
      worktree: opts.branch,
      judgesApproved: undefined,
    },
  });
  emitBuffered({
    type: 'mission.completed',
    tsMs: Date.now(),
    projectId: opts.projectId,
    missionId: opts.mission.id,
    actor: 'agent',
    payload: {
      durationMs: Date.now() - opts.missionStartedAt,
      costUsd: opts.finalMetrics?.costUsd,
    },
  });
  const files = diff.diffFiles ?? [];
  opts.captureOutcome(
    opts.mission,
    opts.projectId,
    'review',
    opts.missionStartedAt,
    opts.finalMetrics,
    files.length > 0
      ? { filesChanged: files.length, linesAdded: diff.diffAdded, linesRemoved: diff.diffRemoved }
      : undefined,
    opts.stepCapFallthroughReason
      ? { category: opts.stepCapFallthroughReason, message: preserved }
      : undefined,
  );
  return finalTimeline;
}

function missionWithDiff(mission: Mission, diff: MissionDiffSlice): Mission {
  return {
    ...mission,
    diffSnippet: diff.diffSnippet,
    diffAdded: diff.diffAdded,
    diffRemoved: diff.diffRemoved,
    diffFiles: diff.diffFiles,
    diffIncompleteFiles: diff.diffIncompleteFiles,
    emptyDeliverable: diff.emptyDeliverable,
  };
}

export interface AutomatedEvalOpts {
  mission: Mission;
  repoPath: string;
  worktreePath: string;
  compiled: CompiledPlan;
  diff: MissionDiffSlice;
  finalTimeline: ActionEvent[];
  t?: TFunc;
  onUpdate: (update: MissionUpdate) => void;
}

function applyEvalSuccess(
  opts: AutomatedEvalOpts,
  evalTimeline: ActionEvent[],
  verdict: Awaited<ReturnType<typeof evaluateMission>>,
): void {
  const scoreFallback = opts.t ? opts.t('agents.runtime.scoreUnavailable') : 'score indisponible';
  const result = verdict.passed
    ? tx(opts.t, 'agents.runtime.evalPassed', 'PASSÉ')
    : tx(opts.t, 'agents.runtime.evalFailed', 'RECALÉ');
  const doneText = opts.t
    ? opts.t('agents.runtime.evalDone', { score: formatVerdictScoreLine(verdict, scoreFallback), result })
    : `[eval] Évaluation terminée — ${formatVerdictScoreLine(verdict, 'score indisponible')} — ${verdict.passed ? 'PASSÉ' : 'RECALÉ'}`;
  opts.onUpdate({
    id: opts.mission.id,
    patch: {
      judgeVerdict: verdict,
      judgesApproved: deriveJudgesApproved(verdict),
      actionTimeline: [
        ...evalTimeline.map((e) => ({ ...e, isLive: false })),
        { time: clockHm(), text: doneText, isLive: false },
      ],
      liveAction: undefined,
    },
  });
  // Fire-and-forget learning stage — never blocks the eval success path.
  void persistLearningStage(opts, missionWithDiff(opts.mission, opts.diff));
}

async function persistLearningStage(opts: AutomatedEvalOpts, withDiff: Mission): Promise<void> {
  try {
    const stage = await executeLearningStage(opts.compiled, withDiff, opts.t);
    if (!stage.ran && !stage.insights.length) return;
    opts.onUpdate({
      id: opts.mission.id,
      patch: {
        learningInsights: stage.insights,
        ...(stage.plan ? { compiledPlan: stage.plan } : {}),
      },
    });
    await saveArtifacts(opts.repoPath, withDiff, {
      compiledPlan: stage.plan ?? opts.compiled,
      learningInsights: stage.insights,
    });
  } catch {
    // Non-fatal
  }
}

async function applyEvalUnavailable(
  opts: AutomatedEvalOpts,
  evalTimeline: ActionEvent[],
  withDiff: Mission,
): Promise<void> {
  opts.onUpdate({
    id: opts.mission.id,
    patch: {
      actionTimeline: [
        ...evalTimeline.map((e) => ({ ...e, isLive: false })),
        {
          time: clockHm(),
          text: tx(opts.t, 'agents.runtime.evalUnavailable', '[eval] Évaluation indisponible — revue manuelle requise'),
          isLive: false,
        },
      ],
      liveAction: undefined,
      judgesApproved: 'évaluation indisponible',
    },
  });
  await persistLearningStage(opts, withDiff);
}

export async function runAutomatedEvaluation(opts: AutomatedEvalOpts): Promise<void> {
  const evalTimeline: ActionEvent[] = [
    ...opts.finalTimeline,
    {
      time: clockHm(),
      text: tx(opts.t, 'agents.runtime.evalStarting', "Démarrage de l'évaluation automatique…"),
      isLive: true,
    },
  ];
  opts.onUpdate({
    id: opts.mission.id,
    patch: {
      actionTimeline: evalTimeline,
      liveAction: tx(opts.t, 'agents.runtime.evalInProgress', 'Évaluation en cours…'),
    },
  });
  const withDiff = missionWithDiff(opts.mission, opts.diff);
  try {
    const verdict = await evaluateMission(withDiff, {
      repoPath: opts.repoPath,
      worktreePath: opts.worktreePath,
      onProgress: (msg) => {
        const next: ActionEvent[] = [
          ...evalTimeline.map((e) => ({ ...e, isLive: false })),
          { time: clockHm(), text: `[eval] ${msg}`, isLive: true },
        ];
        evalTimeline.splice(0, evalTimeline.length, ...next);
        opts.onUpdate({
          id: opts.mission.id,
          patch: { actionTimeline: [...evalTimeline], liveAction: msg },
        });
      },
    });
    applyEvalSuccess(opts, evalTimeline, verdict);
  } catch {
    await applyEvalUnavailable(opts, evalTimeline, withDiff);
  }
}
