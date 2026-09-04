/* compileOrchestratorNode — GraphIR node → OrchestratorPlanStep.

   Measured 2026-08-28: nodeToStep cyclomatic complexity was 16 (ESLint
   ceiling 12). The reverse-direction contract copy lives here so
   compileOrchestratorToIr stays a compile pipeline, not a field mapper.
*/

import type { OrchestratorPlanStep } from '../types.js';
import type { GraphIR, GraphNode } from './types.js';

type NodeRun = {
  status: string;
  missionIds: string[];
  startedAt?: number;
  completedAt?: number;
  costUsd?: number;
};

export function nodeToStep(
  node: GraphNode,
  ir: GraphIR,
  run?: { nodeRuns?: Record<string, NodeRun> },
): OrchestratorPlanStep {
  const dependsOn = ir.edges
    .filter((e) => e.kind === 'control' && e.to === node.id)
    .map((e) => e.from);
  const nr = run?.nodeRuns?.[node.id];
  return attachContract(node, makeBase(node, dependsOn, nr));
}

function nodeDescription(node: GraphNode): string {
  if (node.kind === 'task' || node.kind === 'contest') return node.description;
  return node.label ?? node.id;
}

function makeBase(
  node: GraphNode,
  dependsOn: string[],
  nr: NodeRun | undefined,
): OrchestratorPlanStep {
  return {
    id: node.id,
    description: nodeDescription(node),
    status: nr ? (nr.status as OrchestratorPlanStep['status']) : 'pending',
    missionIds: nr?.missionIds ?? [],
    dependsOn,
    autonomyLevel: 'supervised',
    startedAt: nr?.startedAt,
    completedAt: nr?.completedAt,
    costCents: nr?.costUsd !== undefined ? Math.round(nr.costUsd * 100) : undefined,
  };
}

function attachContract(node: GraphNode, base: OrchestratorPlanStep): OrchestratorPlanStep {
  if (node.kind !== 'task' && node.kind !== 'contest') return base;
  return {
    ...base,
    agentName: node.contract.agentName,
    model: node.contract.model,
    modelId: node.contract.modelId,
    extraReadableProjectIds: node.contract.extraReadableProjectIds,
    baseBranch: node.contract.baseBranch,
    effort: node.contract.effort,
    engine: node.contract.engine,
    budgetCapUsd: node.contract.budgetCapUsd,
    maxDurationMs: node.contract.maxDurationMs,
    scopePaths: node.contract.scopePaths,
    proofs: node.contract.proofs,
    contestN: node.kind === 'contest' ? node.n : node.contract.contestN,
    critical: node.critical,
    maxAttempts: node.maxAttempts,
  };
}
