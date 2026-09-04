/* graphProposalGraph.ts — pure graph-shaping helpers for GraphProposalCard.tsx.

   Split out of the component file deliberately (coding-style.md: "200-400
   lines typical, 800 max" — the card's render logic alone was already
   pushing that cap before the 2026-08 legibility rewrite) so every function
   here stays independently testable with NO React/DOM involved: compile the
   proposal into the same {@link ProposalGraph} shape the mini-graph draws,
   compute a same-shape BFS layout (used ONLY as a real, honest degraded view
   if elkjs genuinely fails to lay the graph out — never as a transient first
   paint; see GraphProposalCard.tsx's own "NEVER DEGRADE IN SILENCE" header),
   build rich tooltip text, and flag steps whose declared dependency the user
   unchecked via partial approval.

   This module NEVER touches the graph data pipeline (compileOrchestrator.ts/
   graphIr.ts/irToCanvas.ts) — it only CALLS compileOrchestratorToIr exactly
   like the pre-rewrite GraphProposalCard.tsx already did, then reshapes its
   output into the small, preview-only ProposalGraph shape this card draws.
*/

import { compileOrchestratorToIr } from '../../lib/agents/graph/compileOrchestrator';
import { findOutOfScopeTaskPath } from '../../lib/agents/missionScopeGuard';
import { findOwningProject, resolveDeclaredProjectRoots, type ProjectLike } from '../../lib/agents/projectForPath';
import { basename } from '../../lib/paths';
import type { PreviewGraphLayout } from '../agents/canvas/layout';
import type { ManagerMessage, OrchestratorState } from '../../lib/agents/types';

export type Proposal = NonNullable<ManagerMessage['proposal']>;
export type ProposalStep = Proposal['steps'][number];
export type ProposalGraphNodeKind = 'task' | 'contest' | 'join';

export interface ProposalGraphNode {
  id: string;
  kind: ProposalGraphNodeKind;
  /** Full, untruncated step description (task/contest) or join label —
   *  truncation for display is the RENDERER's job (single-line ellipsis via
   *  CSS, item 3 of the legibility rewrite), never baked into the data. */
  label: string;
  /** Short agent/role text shown in the node's meta row, task/contest only. */
  detail?: string;
  role?: ProposalStep['role'];
  model?: string;
  /** Human-readable labels (not raw ids) of this step's declared
   *  dependencies, resolved once every node's own label is known — task/
   *  contest only. Absent when the step declares no dependency. */
  dependsOnLabels?: string[];
  /** Human-readable labels of the nodes that fan into this join — join only. */
  memberLabels?: string[];
  joinGroup?: string;
  /** Best-of-N contestant count — contest only. */
  contestN?: number;
  stepIndex?: number;
  width: number;
  height: number;
}

export interface ProposalGraphEdge {
  id: string;
  from: string;
  to: string;
}

export interface ProposalGraph {
  nodes: ProposalGraphNode[];
  edges: ProposalGraphEdge[];
}

// 2026-08 "giant empty rectangle" fix (David, verbatim: "pourquoi la j'ai
// un agent géant dans le canva ??") — this box used to be 180x84 while its
// ONLY content (since the 2026-08-06 "rectangles vides" decision, dcd708a:
// free-text titles inside these boxes were tried and explicitly rejected as
// unreadable, locked in by GraphProposalCardFit.test.tsx's "boxes are never
// labeled at any width... by design") is a 21x21 numbered badge in one
// corner and a 16x16 type glyph/pill in the other — both confined to a
// ~30px-tall strip. The other ~54px of height (64% of the box) rendered as
// pure background fill, which is exactly what read as "a giant [box for an]
// agent" holding nothing. Shrunk to match what actually gets drawn inside it
// (see GraphProposalCard.tsx's node-render block for the vertically-centered
// badge/glyph/pill layout this size now assumes) rather than reintroducing
// the free text that was already tried once and didn't work for this real
// plan. Width still budgets for the contest "best of N" pill (56px + margins)
// so a contest node never falls into dense mode purely for lack of room.
export const TASK_NODE_SIZE = { width: 120, height: 40 };
export const JOIN_NODE_SIZE = { width: 62, height: 62 };

/**
 * Compiles a still-pending proposal into the small preview graph this card
 * draws — via the SAME compileOrchestratorToIr the real orchestrator uses
 * (never a second, drifting reimplementation of join-group/contest
 * resolution), reshaped into {@link ProposalGraph}'s flatter, display-ready
 * shape. Two passes: the first mirrors the IR node-for-node; the second
 * resolves raw dependency/member ids into human-readable labels once every
 * node's own label is known (a plain single pass can't do this — a node
 * that depends on one declared LATER in `ir.nodes` would resolve to
 * `undefined` otherwise).
 */
export function buildProposalGraph(proposal: Proposal): ProposalGraph {
  const steps = proposal.steps.map((step, index) => ({
    id: step.id ?? `${index}`,
    description: step.description,
    status: 'pending' as const,
    missionIds: [],
    dependsOn: step.dependsOn ?? [],
    autonomyLevel: 'supervised' as const,
    agentName: step.agentName,
    model: step.model,
    modelId: step.modelId,
    contestN: step.contestN,
    role: step.role,
    onFail: step.onFail,
    maxAttempts: step.maxAttempts,
    joinGroup: step.joinGroup,
  }));
  const orchestrator: OrchestratorState = {
    id: proposal.planId ?? 'proposal-preview',
    name: proposal.objective,
    projectId: '',
    targetProjectIds: [],
    objective: proposal.objective,
    steps,
    currentStep: 0,
    status: 'planning',
    budget: { spentCents: 0 },
    childMissionIds: [],
    createdAt: 0,
    updatedAt: 0,
    autonomyLevel: 'supervised',
  };
  const ir = compileOrchestratorToIr(orchestrator);
  const stepIndexes = new Map(steps.map((step, index) => [step.id, index]));
  const rawDependsOnById = new Map<string, string[]>();

  const nodes: ProposalGraphNode[] = ir.nodes.map((node) => {
    if (node.kind === 'join') {
      return {
        id: node.id,
        kind: 'join',
        label: node.label ?? 'Join',
        width: JOIN_NODE_SIZE.width,
        height: JOIN_NODE_SIZE.height,
      };
    }
    const stepIndex = stepIndexes.get(node.id);
    const step = stepIndex === undefined ? undefined : proposal.steps[stepIndex];
    if (step?.dependsOn && step.dependsOn.length > 0) rawDependsOnById.set(node.id, step.dependsOn);
    return {
      id: node.id,
      kind: node.kind === 'contest' ? 'contest' : 'task',
      label: 'description' in node ? node.description : node.label ?? node.id,
      detail: step?.agentName ?? step?.role,
      role: step?.role,
      model: step?.modelId ?? step?.model,
      joinGroup: step?.joinGroup,
      contestN: node.kind === 'contest' ? node.n : undefined,
      stepIndex,
      width: TASK_NODE_SIZE.width,
      height: TASK_NODE_SIZE.height,
    };
  });

  const edges: ProposalGraphEdge[] = ir.edges
    .filter((edge) => edge.kind === 'control')
    .map((edge) => ({ id: edge.id, from: edge.from, to: edge.to }));

  // Second pass — resolve ids to labels (see doc comment above). Join
  // membership legitimately reads the IR edges (that IS what a join's
  // fan-in membership means); `dependsOnLabels` deliberately reads each
  // step's OWN declared `dependsOn` captured above, never the join-rerouted
  // IR edges — the tooltip should describe what the user/manager authored,
  // not an internal compilation detail.
  const labelById = new Map(nodes.map((node) => [node.id, node.label]));
  const enrichedNodes = nodes.map((node) => {
    if (node.kind === 'join') {
      const memberLabels = edges
        .filter((edge) => edge.to === node.id)
        .map((edge) => labelById.get(edge.from) ?? edge.from);
      return { ...node, memberLabels };
    }
    const rawDeps = rawDependsOnById.get(node.id);
    if (rawDeps && rawDeps.length > 0) {
      return { ...node, dependsOnLabels: rawDeps.map((id) => labelById.get(id) ?? id) };
    }
    return node;
  });

  return { nodes: enrichedNodes, edges };
}

/**
 * A real, honest degraded layout — a simple layered BFS (longest-path-from-
 * root layering, siblings stacked top to bottom) — used ONLY when elkjs
 * genuinely fails to resolve (network-free/local library, but a malformed
 * graph or a runtime exception inside elk are still real possibilities).
 * Never painted as a transient first frame (that was the pre-rewrite "double
 * layout" bug the founder's design review called out — see
 * GraphProposalCard.tsx's own header) — see that file for the loading
 * skeleton it renders instead while elkjs is still resolving.
 */
export function buildFallbackLayout(graph: ProposalGraph): PreviewGraphLayout {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const inbound = new Map(graph.nodes.map((node) => [node.id, 0]));
  const successors = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
    successors.get(edge.from)?.push(edge.to);
  }

  const layers = new Map<string, number>();
  const queue = graph.nodes.filter((node) => inbound.get(node.id) === 0).map((node) => node.id);
  for (const nodeId of queue) layers.set(nodeId, 0);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const nodeId = queue[cursor]!;
    const layer = layers.get(nodeId) ?? 0;
    for (const successor of successors.get(nodeId) ?? []) {
      layers.set(successor, Math.max(layers.get(successor) ?? 0, layer + 1));
      const remaining = (inbound.get(successor) ?? 1) - 1;
      inbound.set(successor, remaining);
      if (remaining === 0) queue.push(successor);
    }
  }
  for (const node of graph.nodes) {
    if (!layers.has(node.id)) layers.set(node.id, 0);
  }

  const byLayer = new Map<number, ProposalGraphNode[]>();
  for (const node of graph.nodes) {
    const layer = layers.get(node.id) ?? 0;
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), node]);
  }
  const maxRows = Math.max(...[...byLayer.values()].map((nodes) => nodes.length), 1);
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [layer, nodes] of byLayer) {
    const offset = (maxRows - nodes.length) * 52;
    nodes.forEach((node, index) => {
      positions[node.id] = { x: 20 + layer * 230, y: 20 + offset + index * 104 };
    });
  }
  const maxLayer = Math.max(...layers.values(), 0);
  return {
    positions,
    width: 40 + (maxLayer + 1) * 230,
    height: 40 + maxRows * 104,
  };
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Rich multi-line tooltip for a task/contest node (item 3 of the
 *  legibility rewrite: single-line ellipsis label + a tooltip carrying the
 *  full description, role, model, and dependencies — the information the
 *  old hard-wrapped two-line label used to mangle instead of just showing
 *  in full). */
export function buildStepTooltip(node: ProposalGraphNode, t: Translate): string {
  const lines = [node.label];
  if (node.role) lines.push(t('lazyManager.proposal.tooltipRole', { role: node.role }));
  if (node.model) lines.push(t('lazyManager.proposal.tooltipModel', { model: node.model }));
  if (node.dependsOnLabels && node.dependsOnLabels.length > 0) {
    lines.push(t('lazyManager.proposal.tooltipDependsOn', { steps: node.dependsOnLabels.join(', ') }));
  }
  return lines.join('\n');
}

/** Rich tooltip for a join node — the join's own label plus which nodes it
 *  fans in from, since the compact diamond has no room to list sources. */
export function buildJoinTooltip(node: ProposalGraphNode, t: Translate): string {
  const lines = [node.label];
  if (node.memberLabels && node.memberLabels.length > 0) {
    lines.push(t('lazyManager.proposal.tooltipJoinWaitsFor', { steps: node.memberLabels.join(', ') }));
  }
  return lines.join('\n');
}

export interface DependencyWarning {
  stepIndex: number;
  missingDependencyIndexes: number[];
}

/**
 * NEVER DEGRADE IN SILENCE (item 4 of the legibility rewrite) — partial
 * approval lets the user uncheck any step, which can silently leave a
 * STILL-CHECKED step depending on an unchecked one; that step would then
 * run without the input it expects. Pure (no React/DOM) so it is trivially
 * unit-testable on its own. Reads each step's OWN declared `dependsOn`
 * directly — never the join-rerouted graph edges buildProposalGraph
 * produces — the warning is about what the user selected among the steps
 * the manager proposed, not an internal compilation detail.
 */
export function computeDependencyWarnings(
  steps: readonly ProposalStep[],
  selectedSteps: ReadonlySet<number>,
): DependencyWarning[] {
  const indexById = new Map<string, number>(steps.map((step, index) => [step.id ?? `${index}`, index]));
  const warnings: DependencyWarning[] = [];
  steps.forEach((step, index) => {
    if (!selectedSteps.has(index)) return; // only a step the user is about to RUN can be "broken" by a missing input
    const missing = (step.dependsOn ?? [])
      .map((depId) => indexById.get(depId))
      .filter((depIndex): depIndex is number => depIndex !== undefined && depIndex !== index && !selectedSteps.has(depIndex));
    if (missing.length > 0) warnings.push({ stepIndex: index, missingDependencyIndexes: missing });
  });
  return warnings;
}

export interface OutOfScopeStepWarning {
  stepIndex: number;
  /** The absolute path mentioned in the step's own task text, verbatim —
   *  see OutOfScopeTaskPath.mentionedPath (missionScopeGuard.ts). */
  mentionedPath: string;
  /** The plan's own target root the mention falls outside of. */
  targetProjectRoot: string;
  /** basename of the currently-open project the mentioned path resolves
   *  under, when it resolves under one at all — undefined when the path
   *  belongs to no open project (a different, honestly-worded case: there
   *  is no "open that project" fix to point at). */
  ownerProjectName?: string;
}

/**
 * OUT-OF-SCOPE-AT-PROPOSAL-TIME FIX (2026-08-19, real incident: a 7-step
 * plan whose every writing step named an absolute path inside ANOTHER
 * project — engine/, ~971 files — while the plan itself targeted a
 * DIFFERENT project, and no step declared `extraReadableProjectIds` for
 * it). Before this, `findOutOfScopeTaskPath` (missionScopeGuard.ts) only
 * ever ran at LAUNCH time (agentsStore.tsx's `addMission`), one mission at
 * a time — six missions were created and blocked instantly for exactly
 * this reason before anything was said. Every ingredient this needs is
 * already available the moment a plan is proposed (the task text, the
 * plan's resolved `targetProjectRoot`, and the open-projects registry the
 * caller passes in) — this function is nothing more than
 * `findOutOfScopeTaskPath` called once per step, reusing that SAME guard
 * (never a second, drifting path-scanning heuristic — this file's own
 * header states that rule for every helper here) so a launch-time refusal
 * and a proposal-time warning can never disagree about what counts as
 * "out of scope". `findOwningProject` (also reused, not reimplemented)
 * additionally names WHICH open project the mention belongs to, so the
 * card can suggest the exact fix (declare `extraReadableProjectIds`)
 * instead of a bare refusal.
 *
 * Pure (no React/DOM, no I/O) — `openProjects` is whatever the caller
 * already has loaded (GraphProposalCard reads it from AppContext), never
 * fetched here. Returns `[]` when `targetProjectRoot` is not yet known
 * (see proposal.targetProjectRoot's own doc comment, types.ts, for the
 * brief window this covers) — an unresolved target must never be treated
 * as "everything is in scope".
 */
export function computeOutOfScopeStepWarnings(
  steps: readonly ProposalStep[],
  targetProjectRoot: string | undefined,
  openProjects: readonly ProjectLike[],
): OutOfScopeStepWarning[] {
  if (!targetProjectRoot) return [];
  const warnings: OutOfScopeStepWarning[] = [];
  steps.forEach((step, index) => {
    const extraReadableRoots = resolveDeclaredProjectRoots(step.extraReadableProjectIds, openProjects);
    const outOfScope = findOutOfScopeTaskPath(step.description, targetProjectRoot, extraReadableRoots);
    if (!outOfScope) return;
    const owner = findOwningProject(outOfScope.mentionedPath, openProjects);
    warnings.push({
      stepIndex: index,
      mentionedPath: outOfScope.mentionedPath,
      targetProjectRoot: outOfScope.activeRoot,
      ownerProjectName: owner ? basename(owner.root) : undefined,
    });
  });
  return warnings;
}

export interface JoinGroupBacking {
  joinGroup: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const GROUP_BACKING_PADDING = 14;

/**
 * Bounding-box backing for every joinGroup with 2+ resolved members (item 6
 * of the legibility rewrite: "group parallel fan-out visually by
 * joinGroup"). Mirrors compileOrchestrator.ts's own >=2-members threshold
 * for actually synthesizing a join node (a lone `joinGroup` member has
 * nothing to fan in with — no backing drawn for it either). A member whose
 * position never resolved (should not happen once `layout` matches `graph`,
 * but never assumed) is skipped rather than drawing a bounding box that
 * lies about the group's real footprint.
 */
export function computeJoinGroupBackings(graph: ProposalGraph, layout: PreviewGraphLayout): JoinGroupBacking[] {
  const byGroup = new Map<string, ProposalGraphNode[]>();
  for (const node of graph.nodes) {
    if (!node.joinGroup) continue;
    byGroup.set(node.joinGroup, [...(byGroup.get(node.joinGroup) ?? []), node]);
  }

  const backings: JoinGroupBacking[] = [];
  for (const [joinGroup, members] of byGroup) {
    if (members.length < 2) continue;
    const entries = members
      .map((node) => ({ node, pos: layout.positions[node.id] }))
      .filter((entry): entry is { node: ProposalGraphNode; pos: { x: number; y: number } } => !!entry.pos);
    if (entries.length < 2) continue;
    const minX = Math.min(...entries.map((entry) => entry.pos.x));
    const minY = Math.min(...entries.map((entry) => entry.pos.y));
    const maxX = Math.max(...entries.map((entry) => entry.pos.x + entry.node.width));
    const maxY = Math.max(...entries.map((entry) => entry.pos.y + entry.node.height));
    backings.push({
      joinGroup,
      x: minX - GROUP_BACKING_PADDING,
      y: minY - GROUP_BACKING_PADDING,
      width: maxX - minX + GROUP_BACKING_PADDING * 2,
      height: maxY - minY + GROUP_BACKING_PADDING * 2,
    });
  }
  return backings;
}
