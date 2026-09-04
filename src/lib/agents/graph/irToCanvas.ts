/* graph/irToCanvas.ts — Decompile a GraphIR back into canvas state.

   The reverse of canvasToIr.ts: takes a GraphIR and produces the
   DraftSpec/Chain/RouterSpec/JoinSpec arrays the canvas can render.

   Mapping:
   - TaskNode → DraftSpec
   - RouterNodeIR → RouterSpec + Chains for branch targets
   - GraphEdge → Chain
   - JoinNodeIR → JoinSpec + Chains

   This enables roundtrip: canvas → IR → canvas (P5.9 tests).
*/

import type { GraphIR, TaskNode, RouterNodeIR, GraphEdge, JoinNodeIR } from './types.js';
import type { DraftSpec, Chain, RouterSpec, JoinSpec, RouterBranch as CanvasRouterBranch, ChainCondition } from '../../../components/agents/canvas/canvasTypes.js';
import { makeRef } from '../../../components/agents/canvas/canvasTypes.js';

export interface CanvasDecompileResult {
  drafts: DraftSpec[];
  chains: Chain[];
  routers: RouterSpec[];
  joins: JoinSpec[];
}

export function irToCanvas(ir: GraphIR): CanvasDecompileResult {
  const drafts: DraftSpec[] = [];
  const chains: Chain[] = [];
  const routers: RouterSpec[] = [];
  const joins: JoinSpec[] = [];

  // Bug fix (FINDINGS-RUN-NUIT.md QA repro: "une zone projet Transverse
  // apparaît sans avoir été demandée" — a plan's steps landed in the
  // synthetic Transverse zone instead of the project they were drawn up
  // for). `ir.projectId` was never read here at all, so every drafted/
  // routed/joined primitive from a plan carried NO `projectId` — and
  // reconciler.ts's own `belongsToTransverse` convention
  // (`!projectId || !openProjectIds.has(projectId)`) reads an absent
  // projectId as "put this in Transverse", same as canvasTypes.ts's
  // documented "absent = Transverse" rule for DraftSpec/RouterSpec/JoinSpec.
  //
  // `ir.projectId` is what a plan's own project resolution already decided
  // BEFORE this function ever runs: compileOrchestratorToIr mirrors
  // `OrchestratorState.projectId` verbatim (compileOrchestrator.ts), and
  // generate_plan's own executor (agentsStore.tsx) resolves that field via
  // `resolveProjectRoot()` at plan-creation time — the ACTIVE project
  // whenever the manager's generate_plan action carried no explicit
  // projectId of its own. So "no explicit project -> the project active at
  // creation time" (this fix's own documented choice, per this task's
  // brief) falls out for free from that existing resolution: this function
  // never has to guess or re-resolve anything, it only has to stop
  // dropping the field it was already handed. An empty string (never
  // produced by the real generate_plan path, only by canvasToIr's own
  // roundtrip fixtures when no projectId is given) is normalized to
  // `undefined` rather than stamped verbatim, so a genuinely projectless
  // roundtrip still reads as "absent" rather than an empty-but-present
  // field — same falsy-collapses-to-Transverse behavior either way, but
  // honest about which case is which.
  const projectId = ir.projectId || undefined;
  const joinSourceRefs = new Map<string, string[]>();
  for (const edge of ir.edges) {
    if (edge.kind !== 'control' || !edge.to.startsWith('join:')) continue;
    const sourceRef = nodeIdToRef(edge.from);
    if (!sourceRef) continue;
    joinSourceRefs.set(edge.to, [...(joinSourceRefs.get(edge.to) ?? []), sourceRef]);
  }

  // ── TaskNodes → DraftSpecs ────────────────────────────────────────
  for (const node of ir.nodes) {
    if (node.kind === 'task') {
      const task = node as TaskNode;
      drafts.push({
        id: stripPrefix(task.id, 'draft:'),
        title: task.label ?? task.id,
        task: task.description,
        agentName: task.contract?.agentName,
        model: task.contract?.model,
        permissionMode: task.contract?.permissionMode,
        createdBy: 'manager',
        projectId,
      });
    } else if (node.kind === 'router') {
      const router = node as RouterNodeIR;
      routers.push({
        id: stripPrefix(router.id, 'router:'),
        projectId,
        branches: router.branches.map((b): CanvasRouterBranch => ({
          id: b.id,
          label: b.label,
          condition: b.condition,
        })),
      });
    } else if (node.kind === 'join') {
      const join = node as JoinNodeIR;
      joins.push({
        id: stripPrefix(join.id, 'join:'),
        projectId,
        name: join.label,
        sourceRefs: joinSourceRefs.get(join.id) ?? [],
        mode: 'all_success', // Default mode
      });
    }
  }

  // ── Edges → Chains ────────────────────────────────────────────────
  for (const edge of ir.edges) {
    if (edge.kind !== 'control') continue;

    const sourceRef = nodeIdToRef(edge.from);
    const targetRef = nodeIdToRef(edge.to);
    if (!sourceRef || !targetRef) continue;

    chains.push({
      id: edge.id,
      sourceRef,
      targetRef,
      condition: mapEdgeCondition(edge.condition),
      createdBy: 'manager',
    });
  }

  return { drafts, chains, routers, joins };
}

// ── Helpers ──────────────────────────────────────────────────────

function stripPrefix(id: string, prefix: string): string {
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function nodeIdToRef(nodeId: string): string | null {
  if (nodeId.startsWith('draft:')) {
    return makeRef('draft', nodeId.slice('draft:'.length));
  }
  if (nodeId.startsWith('router:')) {
    return makeRef('router', nodeId.slice('router:'.length));
  }
  if (nodeId.startsWith('join:')) {
    return makeRef('join', nodeId.slice('join:'.length));
  }
  // Unprefixed IDs (from compileOrchestratorToIr which uses raw step.id)
  // are treated as draft refs — the most common node kind in plans.
  return makeRef('draft', nodeId);
}

function mapEdgeCondition(condition: GraphEdge['condition']): ChainCondition {
  if (!condition) return 'always';
  if (condition.kind === 'outcome') {
    return condition.value === 'success' ? 'success' : 'fail';
  }
  return 'always';
}

// ── Chantier 3 (plan-first canvas) ─────────────────────────────────────
//
// The canvas must show a manager-proposed plan's graph BEFORE the user
// validates it — dashed "proposed" nodes/edges, not just a chat bubble
// (GraphProposalCard.tsx's own mini-DAG never left the chat). This reuses
// `irToCanvas` UNCHANGED (same ids: a step's `draft:<id>` ref is preserved
// verbatim, see this module's own header) and only STAMPS every produced
// primitive with `proposedPlanId` — the one field DraftNode.tsx/
// ChainEdge.tsx/JoinNode.tsx branch on for the dashed "proposed" visual
// (canvasTypes.ts's own doc comments on that field).
//
// Identity continuity (chantier 3's core ask) falls out of this for free:
// canvasStore's `acceptProposedSteps` (see its own doc comment) does not
// call `irToCanvas`/`addDraft` again at validation time — it finds these
// SAME already-rendered primitives (by `proposedPlanId`) and clears the
// stamp on the accepted subset, so the proposed node and the validated
// node are the literal same object, never a delete+recreate pair.

/** Stamps every drafted/chained/joined primitive from a {@link
 *  CanvasDecompileResult} with `proposedPlanId` — routers are left alone
 *  (no `proposedPlanId` field exists on `RouterSpec`: a plan step never
 *  compiles to a router today, see compileOrchestrator.ts's `stepToNode`). */
export function irToProposedCanvas(ir: GraphIR, planId: string): CanvasDecompileResult {
  const base = irToCanvas(ir);
  return {
    drafts: base.drafts.map((d) => ({ ...d, proposedPlanId: planId })),
    chains: base.chains.map((c) => ({ ...c, proposedPlanId: planId })),
    routers: base.routers,
    joins: base.joins.map((j) => ({ ...j, proposedPlanId: planId })),
  };
}
