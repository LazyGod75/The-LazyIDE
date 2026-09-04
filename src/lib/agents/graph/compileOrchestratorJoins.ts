/* compileOrchestratorJoins — join groups + control edges for GraphIR.

   Measured 2026-08-28: compileOrchestratorToIr cyclomatic complexity was 12
   (ratchet ceiling 12). Join fan-in and dependency reroute live here so the
   compiler stays a pipeline.
*/

import type { OrchestratorPlanStep } from '../types.js';
import type { GraphEdge, JoinNodeIR } from './types.js';
import { defaultBrainPolicy } from './types.js';

export function controlEdgeId(from: string, to: string): string {
  return `ctrl:${from}->${to}`;
}

export function collectJoinGroups(steps: OrchestratorPlanStep[]): {
  joinGroups: Map<string, string>;
  groupMembers: Map<string, string[]>;
} {
  const joinGroups = new Map<string, string>();
  const groupMembers = new Map<string, string[]>();
  for (const step of steps) {
    if (!step.joinGroup) continue;
    const groupKey = step.joinGroup;
    if (!joinGroups.has(groupKey)) {
      joinGroups.set(groupKey, `join:${groupKey}`);
      groupMembers.set(groupKey, []);
    }
    groupMembers.get(groupKey)!.push(step.id);
  }
  return { joinGroups, groupMembers };
}

export function buildJoinFanIn(
  groupMembers: Map<string, string[]>,
  joinGroups: Map<string, string>,
): { joinNodes: JoinNodeIR[]; edges: GraphEdge[] } {
  const joinNodes: JoinNodeIR[] = [];
  const edges: GraphEdge[] = [];
  for (const [groupKey, memberIds] of groupMembers) {
    if (memberIds.length < 2) continue;
    const joinId = joinGroups.get(groupKey)!;
    joinNodes.push({
      id: joinId,
      kind: 'join',
      label: `Join: ${groupKey}`,
      brain: defaultBrainPolicy(),
      mode: 'all',
      merge: 'concat',
    });
    for (const memberId of memberIds) {
      edges.push({
        id: controlEdgeId(memberId, joinId),
        from: memberId,
        to: joinId,
        kind: 'control',
      });
    }
  }
  return { joinNodes, edges };
}

function rerouteThroughJoin(
  depId: string,
  groupMembers: Map<string, string[]>,
  joinGroups: Map<string, string>,
): string {
  for (const [groupKey, members] of groupMembers) {
    if (members.includes(depId)) return joinGroups.get(groupKey)!;
  }
  return depId;
}

export function buildDependencyEdges(
  steps: OrchestratorPlanStep[],
  groupMembers: Map<string, string[]>,
  joinGroups: Map<string, string>,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const step of steps) {
    const sources = new Set<string>();
    for (const depId of step.dependsOn) {
      sources.add(rerouteThroughJoin(depId, groupMembers, joinGroups));
    }
    for (const source of sources) {
      edges.push({
        id: controlEdgeId(source, step.id),
        from: source,
        to: step.id,
        kind: 'control',
      });
    }
  }
  return edges;
}
