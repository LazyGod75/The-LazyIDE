/* graph/compileOrchestrator.ts — Bidirectional compiler between
   OrchestratorState (legacy) and GraphIR (new runtime).

   P1.7: compat shim so existing plans work through the SGR without
   rewriting the store or manager. Step ids and dependsOn are preserved.
*/

import type { OrchestratorState, OrchestratorPlanStep, AutonomyMode } from '../types.js';
import type { GraphIR, GraphNode, GraphDefaults, GraphEdge, TaskNode } from './types.js';
import { defaultBrainPolicy, defaultGraphDefaults, defaultStepContract } from './types.js';
import { nodeToStep } from './compileOrchestratorNode.js';
import { collectJoinGroups, buildJoinFanIn, buildDependencyEdges } from './compileOrchestratorJoins.js';

// ── OrchestratorState → GraphIR ───────────────────────────────────

export function compileOrchestratorToIr(orch: OrchestratorState): GraphIR {
  const stepNodes: GraphNode[] = orch.steps.map((step) => stepToNode(step));
  const { joinGroups, groupMembers } = collectJoinGroups(orch.steps);
  const { joinNodes, edges: joinEdges } = buildJoinFanIn(groupMembers, joinGroups);
  const edges: GraphEdge[] = [
    ...joinEdges,
    ...buildDependencyEdges(orch.steps, groupMembers, joinGroups),
  ];

  const nodes: GraphNode[] = [...stepNodes, ...joinNodes];
  const defaults = defaultsFromOrch(orch);

  return {
    id: orch.id,
    version: 1,
    name: orch.name,
    objective: orch.objective,
    projectId: orch.projectId,
    targetProjectIds: orch.targetProjectIds,
    defaults,
    nodes,
    edges,
    createdAt: orch.createdAt,
    updatedAt: orch.updatedAt,
    source: 'plan',
    sourceRef: orch.id,
  };
}

function stepToNode(step: OrchestratorPlanStep): GraphNode {
  const contract = defaultStepContract({
    title: step.description.slice(0, 60),
    agentName: step.agentName,
    model: step.model,
    // Plan-first leg of the modelId catalog wave — see StepContract.modelId's
    // doc comment (./types.ts) for the full thread from OrchestratorPlanStep.
    modelId: step.modelId,
    // Plan-first leg of cross-project READ access — see
    // StepContract.extraReadableProjectIds's doc comment (./types.ts).
    extraReadableProjectIds: step.extraReadableProjectIds,
    baseBranch: step.baseBranch,
    effort: step.effort,
    engine: step.engine,
    budgetCapUsd: step.budgetCapUsd,
    maxDurationMs: step.maxDurationMs,
    scopePaths: step.scopePaths,
    proofs: step.proofs,
    contestN: step.contestN,
  });

  // Bounded self-heal: maxAttempts default 2, hard cap 5.
  const maxAttempts = Math.min(step.maxAttempts ?? 2, 5);

  // Best-of-N: contestN ≥ 2 becomes a first-class contest node (Cursor parity).
  if (step.contestN !== undefined && step.contestN > 1) {
    return {
      id: step.id,
      kind: 'contest',
      label: step.description.slice(0, 60),
      description: step.description,
      contract,
      n: step.contestN,
      ranking: 'judge',
      brain: defaultBrainPolicy(),
      critical: step.critical ?? true,
      maxAttempts,
    };
  }

  const taskNode: TaskNode = {
    id: step.id,
    kind: 'task',
    label: step.description.slice(0, 60),
    description: step.description,
    contract,
    brain: defaultBrainPolicy(),
    critical: step.critical ?? true,
    maxAttempts,
  } as TaskNode;
  // Attach role/onFail as extra properties for the replan engine.
  // We use a cast since GraphNodeBase doesn't have these fields yet —
  // the replan engine reads them from the step, not the node.
  (taskNode as TaskNode & { role?: string; onFail?: string }).role = step.role;
  (taskNode as TaskNode & { role?: string; onFail?: string }).onFail = step.onFail;
  return taskNode;
}

function defaultsFromOrch(orch: OrchestratorState): GraphDefaults {
  const brain = defaultBrainPolicy();
  return defaultGraphDefaults({
    autonomyLevel: orch.autonomyLevel,
    budgetCapUsd: orch.budget.limitCents ? orch.budget.limitCents / 100 : undefined,
    brain,
  });
}

// ── GraphIR → OrchestratorState (reverse shim) ────────────────────

export function irToOrchestratorState(
  ir: GraphIR,
  run?: { nodeRuns?: Record<string, { status: string; missionIds: string[]; startedAt?: number; completedAt?: number; costUsd?: number }> },
): OrchestratorState {
  const steps: OrchestratorPlanStep[] = ir.nodes.map((node) => nodeToStep(node, ir, run));

  return {
    id: ir.id,
    name: ir.name,
    projectId: ir.projectId,
    targetProjectIds: ir.targetProjectIds ?? [],
    objective: ir.objective,
    steps,
    currentStep: 0,
    status: 'planning',
    budget: {
      spentCents: 0,
      limitCents: ir.defaults.budgetCapUsd ? Math.round(ir.defaults.budgetCapUsd * 100) : undefined,
    },
    childMissionIds: [],
    createdAt: ir.createdAt,
    updatedAt: ir.updatedAt,
    autonomyLevel: ir.defaults.autonomyLevel as AutonomyMode,
  };
}
