/* graph/sgrOrchestratorRunner.ts — Default plan execution path via SGR.

   Replaces sequential orchestratorExecutor for Manager execute_plan.
   Compiles OrchestratorState → GraphIR → runGraph, maps StepContract into
   launchMission, syncs step statuses back onto the orchestrator, and
   exposes the live GraphRun for UI (debug snapshot / tree).
*/

import type { Mission, OrchestratorState, OrchestratorPlanStep } from '../types.js';
import type { GraphIR, GraphRun, GraphNode, BrainRecallBundle } from './types.js';
import type { GraphExecutorDeps } from './runGraph.js';
import { compileOrchestratorToIr } from './compileOrchestrator.js';
import { runGraph } from './runGraph.js';
import { initGraphRun } from './graphIr.js';
import { createRunnerGraphDeps } from './runnerGraphDeps.js';
import { saveGraphRun, reconcilePhantomGraphRuns } from './graphRunStore.js';
import { buildDebugSnapshot, type RunDebugSnapshot } from './graphDebugView.js';
import { saveOrchestratorState } from '../orchestratorState.js';
import { findMissionById, subscribe } from '../globalRuntime.js';
import { observeMissionOutcome } from '../observationEngine.js';
import { diagnose } from '../diagnosisEngine.js';
import { emit } from '../../bus.js';

export interface SgrLaunchOpts {
  title?: string;
  agentName?: string;
  model?: string;
  /** Exact catalog id (see StepContract.modelId's doc comment, ./types.ts)
   *  — the final leg of the plan-first modelId thread, read by the
   *  `launchMission` dep (agentsStore.tsx) and passed to
   *  resolveManagerModelId ahead of the `model` tier hint. */
  modelId?: string;
  /** Cross-project READ access — see StepContract.extraReadableProjectIds's
   *  doc comment (./types.ts) for the full thread. STILL UNRESOLVED ids/
   *  names at this point — the `launchMission` dep implementation
   *  (agentsStore.tsx's SGR launchMission callback) resolves each one to a
   *  real, currently open project root (or drops it with a warning) before
   *  it ever reaches NewMissionInput.extraReadableRoots. */
  extraReadableProjectIds?: string[];
  /** See OrchestratorPlanStepInput.baseBranch's doc comment (../types.ts)
   *  for the full contract — the plan-first leg of the base-branch thread,
   *  read by the `launchMission` dep (agentsStore.tsx) and forwarded onto
   *  NewMissionInput.baseBranch -> Mission.baseBranch. */
  baseBranch?: string;
  /** See Mission.mergeBranches's doc comment (../types.ts) — the plan-first
   *  leg of the fan-in dependency merge thread, injected dynamically by
   *  runGraph.ts's `resolveInheritedBranches` (never set by the plan
   *  compiler itself). */
  mergeBranches?: string[];
  projectId?: string;
  budgetCapUsd?: number;
  maxDurationMs?: number;
  engine?: 'cli' | 'pro' | 'auto';
  permissionMode?: 'plan' | 'acceptEdits' | 'full';
  effort?: string;
}

export interface SgrOrchestratorRunnerDeps {
  launchMission: (task: string, opts?: SgrLaunchOpts) => Promise<string>;
  projectRoot: string;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  onRunUpdate?: (run: GraphRun, snapshot: RunDebugSnapshot, ir: GraphIR) => void;
}

/** Terminal = permanently finished. `review` is NOT terminal — it's a
 *  paused state awaiting human decision. The orchestrator should treat
 *  a `review` mission as "settled enough to continue planning" but not
 *  as "done". See MissionStatus doc comment in types.ts. */
function isTerminalStatus(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/** Paused = waiting for a decision, not permanently finished. */
function isPausedStatus(status: string): boolean {
  return status === 'review';
}

/** A mission has "settled" if it's terminal OR paused — the orchestrator
 *  can stop waiting and proceed to the next wave. Terminal and paused
 *  are distinguished downstream (runGraph treats review as success). */
function hasSettled(status: string): boolean {
  return isTerminalStatus(status) || isPausedStatus(status);
}

async function waitForMission(id: string, signal?: AbortSignal): Promise<Mission | undefined> {
  const existing = findMissionById(id);
  if (existing && hasSettled(existing.status)) return existing;

  return new Promise((resolve) => {
    let resolved = false;
    const unsub = subscribe(() => {
      const m = findMissionById(id);
      if (m && hasSettled(m.status)) {
        resolved = true;
        unsub();
        resolve(m);
      }
    });
    const onAbort = () => {
      if (!resolved) {
        resolved = true;
        unsub();
        resolve(undefined);
      }
    };
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function waitForMissions(ids: string[], signal?: AbortSignal): Promise<Mission[]> {
  const results = await Promise.all(ids.map((id) => waitForMission(id, signal)));
  return results.filter((m): m is Mission => m !== undefined);
}

function mapNodeStatusToStep(status: string): OrchestratorPlanStep['status'] {
  switch (status) {
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    case 'running':
    case 'ready':
      return 'in_progress';
    case 'blocked':
      return 'failed';
    default:
      return 'pending';
  }
}

function syncOrchestratorFromRun(
  orch: OrchestratorState,
  run: GraphRun,
): OrchestratorState {
  const steps = orch.steps.map((step) => {
    const nr = run.nodeRuns[step.id];
    if (!nr) return step;
    return {
      ...step,
      status: mapNodeStatusToStep(nr.status),
      missionIds: nr.missionIds.length > 0 ? nr.missionIds : step.missionIds,
      startedAt: nr.startedAt ?? step.startedAt,
      completedAt: nr.completedAt ?? step.completedAt,
      costCents:
        nr.costUsd !== undefined ? Math.round(nr.costUsd * 100) : step.costCents,
    };
  });

  let status: OrchestratorState['status'] = orch.status;
  if (run.status === 'running') status = 'executing';
  else if (run.status === 'interrupted') status = 'blocked';
  else if (run.status === 'done') status = 'done';
  else if (run.status === 'failed' || run.status === 'cancelled') status = 'blocked';

  const spentCents = Math.round(run.budget.spentUsd * 100);
  const inProgressIdx = steps.findIndex((s) => s.status === 'in_progress');

  return {
    ...orch,
    steps,
    status,
    currentStep: inProgressIdx >= 0 ? inProgressIdx : orch.currentStep,
    budget: {
      ...orch.budget,
      spentCents: Math.max(orch.budget.spentCents, spentCents),
    },
    childMissionIds: Array.from(
      new Set([
        ...orch.childMissionIds,
        ...Object.values(run.nodeRuns).flatMap((nr) => nr.missionIds),
      ]),
    ),
    updatedAt: Date.now(),
  };
}

/** Exported for direct unit/integration testing of the plan-first modelId
 *  thread (see StepContract.modelId's doc comment) — pure, no side effects. */
export function launchOptsFromNode(node: GraphNode, projectId: string): SgrLaunchOpts {
  const opts: SgrLaunchOpts = { projectId };
  if (node.kind === 'task' || node.kind === 'contest') {
    const c = node.contract;
    opts.title = (c.title ?? node.label ?? node.id).slice(0, 80);
    opts.agentName = c.agentName;
    opts.model = c.model;
    opts.modelId = c.modelId;
    opts.extraReadableProjectIds = c.extraReadableProjectIds;
    opts.baseBranch = c.baseBranch;
    opts.mergeBranches = c.mergeBranches;
    opts.budgetCapUsd = c.budgetCapUsd;
    opts.maxDurationMs = c.maxDurationMs;
    opts.engine = c.engine;
    opts.permissionMode = c.permissionMode;
    opts.effort = c.effort;
  } else {
    opts.title = (node.label ?? node.id).slice(0, 80);
  }
  return opts;
}

export interface SgrRunResult {
  orchestrator: OrchestratorState;
  run: GraphRun;
  ir: GraphIR;
  snapshot: RunDebugSnapshot;
}

/**
 * EXECUTE_PLAN REPLAY fix (2026-08-05, real prod incident — a plan
 * re-executed after a partial run relaunched EVERY step, done ones
 * included: three duplicate "structure" missions off the same plan,
 * M25/M26). runGraph always starts from a blank GraphRun unless handed one
 * via `opts.existingRun` (see runGraph's own "Initialize or resume run"
 * comment) — a blank run gives every node status 'pending' regardless of
 * whether some OTHER, earlier run already finished it (initGraphRun has no
 * notion of "this ran before"), so a second startOrchestratorViaSgr call on
 * the SAME plan was indistinguishable from the first.
 *
 * Builds the GraphRun a fresh run WOULD have produced if it had already
 * executed every step the orchestrator's OWN persisted state (`step.status`
 * — kept current by syncOrchestratorFromRun after every prior run) marks
 * 'done'/'skipped': getReadyNodes (graphIr.ts) only ever skips a node whose
 * OWN run status is already 'done'/'skipped', so seeding those statuses
 * here is enough to keep runGraph from ever re-launching them, while a
 * still-'pending' (or reset-to-'pending' by resume_graph_run) step's
 * dependency on one of them still resolves normally (its predecessor's
 * seeded 'done' status satisfies getReadyNodes's own dependency check)
 * ­— never a second, parallel "is this done" notion.
 *
 * A mission that reached 'review' is folded into 'done' here too — by the
 * time this reads `step.status`, syncOrchestratorFromRun has already mapped
 * a review-settled node to step status 'done' (mapNodeStatusToStep), same
 * "review is settled enough to continue" rule this module's own
 * isPausedStatus/hasSettled helpers apply during the ORIGINAL run.
 *
 * Returns `undefined` (never seeds) when NOTHING is settled yet — a plan's
 * first execution behaves exactly as before this fix, zero behavior change
 * for the overwhelmingly common case.
 *
 * Also seeds `resultBranch` (best-effort) for each settled step so a still-
 * pending dependent can still resolve dependency-branch inheritance
 * (resolveInheritedBranches, runGraph.ts) — OrchestratorState.steps itself
 * never carries this (syncOrchestratorFromRun does not persist it, only
 * status/missionIds/timing/cost), so it is looked up from the settled
 * step's own last mission via the SAME globalRuntime registry
 * waitForMission already trusts. Within the same session (the reported
 * bug's own scenario — a plan re-executed shortly after a partial run,
 * never an app restart) that registry still has the mission; when it does
 * not, this leaves `resultBranch` unset and resolveInheritedBranches fails
 * LOUDLY with its own honest "no branch to inherit from" error — never a
 * silent, wrong fallback.
 */
export function seedRunFromSteps(
  ir: GraphIR,
  orchestrator: OrchestratorState,
): GraphRun | undefined {
  const settled = orchestrator.steps.filter((s) => s.status === 'done' || s.status === 'skipped');
  if (settled.length === 0) return undefined;

  const run = initGraphRun(ir.id, ir);
  for (const step of settled) {
    const nr = run.nodeRuns[step.id];
    if (!nr) continue; // step not present in this (possibly narrowed) IR — nothing to seed
    const lastMissionId = step.missionIds[step.missionIds.length - 1];
    const lastMission = lastMissionId ? findMissionById(lastMissionId) : undefined;
    run.nodeRuns[step.id] = {
      ...nr,
      status: step.status === 'skipped' ? 'skipped' : 'done',
      missionIds: step.missionIds,
      completedAt: step.completedAt,
      outcome: step.status === 'skipped' ? 'skipped' : 'success',
      resultBranch: lastMission?.worktree || undefined,
    };
  }
  return run;
}

/** Execute a plan through the Single Graph Runtime (default path). */
export async function startOrchestratorViaSgr(
  orchestrator: OrchestratorState,
  deps: SgrOrchestratorRunnerDeps,
  opts?: { signal?: AbortSignal },
): Promise<SgrRunResult> {
  const ir = compileOrchestratorToIr(orchestrator);

  // D7 fix (item 6, 2026-08-15 audit) — before starting/resuming a REAL
  // run for this project, sweep any GraphRun files left behind by a
  // process that died mid-run (status still 'pending'/'running'/'paused'
  // on disk is proof nothing is actively driving that wave loop anymore)
  // and rewrite them to 'interrupted'. See graphRunStore.ts's own header
  // comment for the full rationale and documented scope (this makes the
  // ON-DISK state honest; it does not itself resume anything, and does not
  // touch OrchestratorState.status — a separate, lossier projection).
  // Best-effort: never lets a reconciliation failure block a real run.
  await reconcilePhantomGraphRuns(deps.projectRoot).catch(() => {});

  let liveOrch: OrchestratorState = {
    ...orchestrator,
    status: 'executing',
    updatedAt: Date.now(),
  };
  await saveOrchestratorState(deps.projectRoot, liveOrch);

  const graphDeps: GraphExecutorDeps = {
    projectRoot: deps.projectRoot,

    launchMission: async (args: {
      node: GraphNode;
      task: string;
      brainContext: BrainRecallBundle;
      projectId: string;
    }) => {
      const launchOpts = launchOptsFromNode(args.node, args.projectId || orchestrator.projectId);
      return deps.launchMission(args.task, launchOpts);
    },

    waitForMissions,

    persistRun: async (run) => {
      liveOrch = syncOrchestratorFromRun(liveOrch, run);
      await saveOrchestratorState(deps.projectRoot, liveOrch);
      // D7 fix (item 6, 2026-08-15 audit) — the FULL GraphRun (nodeOutputs,
      // budget, checkpoints, replanCount included) is now itself persisted,
      // additively, alongside the existing lossy OrchestratorStep
      // projection above (which stays — this does not replace it). See
      // graphRunStore.ts's own header comment for the full defect writeup
      // and documented scope.
      await saveGraphRun(deps.projectRoot, run);
      const snapshot = buildDebugSnapshot(ir, run);
      deps.onRunUpdate?.(run, snapshot, ir);
      deps.onEvent?.('graph.run_persisted', {
        runId: run.runId,
        status: run.status,
        planId: orchestrator.id,
      });
    },

    emit: (type, payload) => {
      try {
        emit(
          type as keyof import('../../bus.js').BusEvents,
          payload as import('../../bus.js').BusEvents[keyof import('../../bus.js').BusEvents],
        );
      } catch {
        // bus may not know graph.* types — still forward to runner hook
      }
      deps.onEvent?.(type, payload);
    },

    diagnose: async ({ missionId, errorMessage, projectId }) => {
      const mission = findMissionById(missionId);
      if (!mission) {
        return {
          category: 'unknown',
          rootCause: errorMessage ?? 'mission missing',
          suggestedFix: 'retry step',
          confidence: 0.2,
        };
      }
      const outcome = observeMissionOutcome(mission, projectId, deps.projectRoot);
      const d = await diagnose(outcome, deps.projectRoot);
      return {
        category: d.category,
        rootCause: d.rootCause,
        suggestedFix: d.suggestedFix,
        confidence: d.confidence,
        brainContext: d.brainContext,
      };
    },
  };

  // P6.d: route mission launches through lazy-runnerd when it's enabled and
  // running (checkRunner's own invoke('runner_status') probe) — transparent
  // fallback to graphDeps unchanged (persistRun/emit/diagnose untouched)
  // whenever the runner is unavailable, which is the default/test state.
  const runnerDeps = createRunnerGraphDeps({ fallback: graphDeps, projectId: orchestrator.projectId });

  // EXECUTE_PLAN REPLAY fix — see seedRunFromSteps's own doc comment. A
  // no-op (undefined) for a plan's first execution; on a re-execution with
  // some steps already settled, runGraph resumes from them instead of
  // relaunching everything.
  const existingRun = seedRunFromSteps(ir, orchestrator);
  const run = await runGraph(ir, runnerDeps, { signal: opts?.signal, existingRun });

  // Phase 11: Run learning pipeline on accumulated traces after graph completes.
  // Best-effort — never blocks or fails the orchestrator.
  if (run.status === 'done' || run.status === 'failed') {
    try {
      const { readTraceEntries } = await import('./traceJournal.js');
      const { runLearningPipeline } = await import('../lessons/learningPipeline.js');
      const entries = await readTraceEntries(deps.projectRoot);
      if (entries.length > 0) {
        const projectId = orchestrator.projectId;
        runLearningPipeline(projectId, entries);
      }
    } catch {
      // Learning pipeline failure is non-fatal
    }
  }

  liveOrch = syncOrchestratorFromRun(liveOrch, run);
  await saveOrchestratorState(deps.projectRoot, liveOrch);
  const snapshot = buildDebugSnapshot(ir, run);
  deps.onRunUpdate?.(run, snapshot, ir);

  return { orchestrator: liveOrch, run, ir, snapshot };
}
