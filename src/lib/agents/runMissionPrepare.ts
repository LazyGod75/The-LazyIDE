/* runMissionPrepare — launch prelude extracted from runMission (runtime.ts).

   Measured 2026-08-28: runMission cyclomatic complexity was 104 (ESLint
   ratchet ceiling is 12). This module owns the pre-Step-A window: bounded
   brain recall, plan compile, initial timeline, status flip to running.
   Behavior is copied, not redesigned — see runtime.ts's hang-fix comment
   on BRAIN_RECALL_TIMEOUT_MS and the brain-recall soft-fail contract.
*/

import type { Mission, PlanStep, ActionEvent } from './types.js';
import type { PermissionMode, TFunc, MissionUpdate } from './runtime.js';
import type { CompiledPlan } from './stageContract.js';
import { compilePlan, planToSteps } from './stageContract.js';
import { captureBrainContext, type CapturedBrainContext } from './brainCitations.js';
import { getPlatform } from '../platform/index.js';
import { normalizeRecall } from '../brain/context.js';
import type { BrainRecallResult } from '../platform/types.js';
import { recordRecallSaving } from '../models/costStore.js';
import { withTimeout, BRAIN_RECALL_TIMEOUT_MS } from '../models/brainSearchLoop.js';
import { launchPhaseEnter, launchPhaseExit, launchPhaseError } from './launchLog.js';
import { emitEvent } from '../journal/journal.js';

export interface MissionLaunchPrep {
  compiled: CompiledPlan;
  initialSteps: PlanStep[];
  initialTimeline: ActionEvent[];
  brainContext: CapturedBrainContext;
}

function clockHm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function tagPhase<T>(phase: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`[${phase}] ${detail}`, { cause: err });
  }
}

export async function recallMissionBrain(mission: Mission): Promise<BrainRecallResult | null> {
  launchPhaseEnter(mission.id, 'brain-recall');
  try {
    const brainRecall = normalizeRecall(
      await withTimeout(
        getPlatform().brain.recall(mission.agentTask ?? mission.title, mission.id),
        BRAIN_RECALL_TIMEOUT_MS,
        'mission brain recall',
      ),
    );
    recordRecallSaving(brainRecall, 'mission');
    launchPhaseExit(mission.id, 'brain-recall');
    return brainRecall;
  } catch (err) {
    launchPhaseError(mission.id, 'brain-recall', err);
    return null;
  }
}

export function compileLaunchArtifacts(opts: {
  mission: Mission;
  brainRecall: BrainRecallResult | null;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  deniedTools?: string[];
  t?: TFunc;
}): MissionLaunchPrep {
  const { mission, brainRecall, permissionMode, allowedTools, deniedTools, t } = opts;
  launchPhaseEnter(mission.id, 'plan-compile');
  const compiled = tagPhase('plan-compile', () =>
    compilePlan({
      mission: {
        id: mission.id,
        title: mission.title,
        agentTask: mission.agentTask,
        agentName: mission.agentName,
        isOrchestrator: mission.isOrchestrator,
        model: mission.model,
      },
      brainRecall,
      permissionMode,
      allowedTools,
      deniedTools,
    }),
  );
  launchPhaseExit(mission.id, 'plan-compile');

  const initialSteps = tagPhase('start', () => planToSteps(compiled));
  const initialTimeline: ActionEvent[] = [
    {
      time: clockHm(),
      text: t ? t('agents.runtime.missionStarted') : 'Mission démarrée — worktree en cours de création…',
      isLive: true,
    },
  ];
  if (compiled.brainAdapted) {
    initialTimeline.push({
      time: clockHm(),
      text: t
        ? t('agents.runtime.planAdapted', { count: compiled.adaptations.length })
        : `🧠 Plan adapté par le brain — ${compiled.adaptations.length} adaptation(s)`,
      isLive: false,
    });
  }
  return {
    compiled,
    initialSteps,
    initialTimeline,
    brainContext: captureBrainContext(brainRecall),
  };
}

export function announceMissionRunning(opts: {
  mission: Mission;
  projectId: string;
  prep: MissionLaunchPrep;
  onUpdate: (update: MissionUpdate) => void;
  t?: TFunc;
}): void {
  const { mission, projectId, prep, onUpdate, t } = opts;
  launchPhaseEnter(mission.id, 'status-flip-running');
  onUpdate({
    id: mission.id,
    patch: {
      status: 'running',
      progress: 0,
      planSteps: prep.initialSteps,
      actionTimeline: prep.initialTimeline,
      liveAction: t ? t('agents.runtime.initializingWorktree') : 'Initialisation du worktree…',
      compiledPlan: prep.compiled,
      brainAdapted: prep.compiled.brainAdapted,
      ...(prep.brainContext.citations.length > 0 ? { brainCitations: prep.brainContext.citations } : {}),
      ...(prep.brainContext.tokensSavedLabel ? { tokensSaved: prep.brainContext.tokensSavedLabel } : {}),
    },
  });
  launchPhaseExit(mission.id, 'status-flip-running');
  emitEvent({
    type: 'mission.started',
    tsMs: Date.now(),
    projectId,
    missionId: mission.id,
    actor: 'agent',
    payload: { model: mission.model },
  });
}

export async function prepareAndAnnounceMissionLaunch(opts: {
  mission: Mission;
  projectId: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  deniedTools?: string[];
  onUpdate: (update: MissionUpdate) => void;
  t?: TFunc;
}): Promise<MissionLaunchPrep> {
  const brainRecall = await recallMissionBrain(opts.mission);
  const prep = compileLaunchArtifacts({ ...opts, brainRecall });
  announceMissionRunning({ ...opts, prep });
  return prep;
}
