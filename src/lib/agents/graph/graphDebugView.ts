/* graph/graphDebugView.ts — P5.6 Live node debugger (cost, brain cites).

   Produces a debug snapshot of a GraphRun for the canvas overlay:
   - Per-node status, cost, mission count
   - Brain recall hits and note ids
   - Error messages for failed nodes
   - Overall run status and budget consumption

   This is a pure projection — no side effects. The canvas can render
   this as an overlay or tooltip on each node.
*/

import type { GraphRun, NodeRun, GraphIR } from './types.js';

export interface NodeDebugInfo {
  nodeId: string;
  label: string;
  kind: string;
  status: NodeRun['status'];
  attempt: number;
  missionCount: number;
  costUsd?: number;
  brainNoteIds?: string[];
  errorMessage?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}

export interface RunDebugSnapshot {
  runId: string;
  graphId: string;
  status: GraphRun['status'];
  totalNodes: number;
  doneCount: number;
  failedCount: number;
  runningCount: number;
  pendingCount: number;
  blockedCount: number;
  totalCostUsd: number;
  totalMissions: number;
  nodes: NodeDebugInfo[];
}

export function buildDebugSnapshot(ir: GraphIR, run: GraphRun): RunDebugSnapshot {
  const nodes: NodeDebugInfo[] = [];
  let totalCostUsd = 0;
  let totalMissions = 0;
  let doneCount = 0;
  let failedCount = 0;
  let runningCount = 0;
  let pendingCount = 0;
  let blockedCount = 0;

  for (const node of ir.nodes) {
    const nr = run.nodeRuns[node.id];
    if (!nr) continue;

    if (nr.costUsd) totalCostUsd += nr.costUsd;
    totalMissions += nr.missionIds.length;

    switch (nr.status) {
      case 'done': doneCount++; break;
      case 'failed': failedCount++; break;
      case 'running': runningCount++; break;
      case 'pending': pendingCount++; break;
      case 'ready': pendingCount++; break;
      case 'blocked': blockedCount++; break;
      case 'skipped': break;
    }

    const durationMs = nr.startedAt && nr.completedAt
      ? nr.completedAt - nr.startedAt
      : undefined;

    nodes.push({
      nodeId: node.id,
      label: node.label ?? node.id,
      kind: node.kind,
      status: nr.status,
      attempt: nr.attempt,
      missionCount: nr.missionIds.length,
      costUsd: nr.costUsd,
      brainNoteIds: nr.brainNoteIds,
      errorMessage: nr.errorMessage,
      startedAt: nr.startedAt,
      completedAt: nr.completedAt,
      durationMs,
    });
  }

  return {
    runId: run.runId,
    graphId: run.graphId,
    status: run.status,
    totalNodes: ir.nodes.length,
    doneCount,
    failedCount,
    runningCount,
    pendingCount,
    blockedCount,
    totalCostUsd,
    totalMissions,
    nodes,
  };
}
