/* graph/canvasToIr.ts — Compile a canvas state into a GraphIR.

   The canvas (React Flow) stores nodes as DraftSpec/RouterSpec/JoinSpec
   and edges as Chain objects. This compiler converts that visual
   representation into a GraphIR that the Single Graph Runtime can execute.

   Mapping:
   - DraftSpec → TaskNode (a task to execute)
   - RouterSpec → RouterNodeIR (branching)
   - JoinSpec → fan-in edges (all sources must complete before target)
   - Chain → GraphEdge (control flow / dependency)
   - ChainCondition → edge condition (success/fail/always → outcome/default)

   This is a one-way compile: canvas → IR. The reverse (IR → canvas) is
   handled by irToCanvas.ts (P5.2).

   Honesty rule (2026-08-15 audit follow-up — see refToNodeId below for the
   full per-kind reasoning): a chain the user actually wired on the canvas
   must never vanish from the compiled graph without a word. Every
   CanvasNodeKind that can appear on a chain's source/target falls into
   exactly one of three buckets, decided once in refToNodeId:
   - draft/mission/router/join: compile normally (join has no node of its
     own — its fan-in is inlined as direct edges, see the join loop below).
   - project/note/iteration/terminal/preview/frame: DECORATIVE. The canvas
     itself never lets a chain touch one (no connectable Handle, or
     chainValidation.ts's target whitelist blocks it) — excluded by design,
     not by omission.
   - schedule/loop: MEANINGFUL but not yet compilable — the canvas DOES let
     a user wire these into a chain. Compiling one throws a descriptive
     error naming the node instead of silently dropping the edge.
*/

import type { GraphIR, GraphNode, GraphEdge, TaskNode, RouterNodeIR, RouterBranch as GraphRouterBranch } from './types.js';
import { defaultBrainPolicy, defaultGraphDefaults } from './types.js';
import type { DraftSpec, Chain, RouterSpec, JoinSpec, NodeRef, RouterBranch as CanvasRouterBranch } from '../../../components/agents/canvas/canvasTypes.js';
import { parseRef, parseRouterBranchRef } from '../../../components/agents/canvas/canvasTypes.js';

export interface CanvasCompileInput {
  drafts: DraftSpec[];
  chains: Chain[];
  routers: RouterSpec[];
  joins: JoinSpec[];
  projectId?: string;
}

export function canvasToIr(input: CanvasCompileInput): GraphIR {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const now = Date.now();

  // ── Drafts → TaskNodes ────────────────────────────────────────────
  for (const draft of input.drafts) {
    nodes.push({
      id: `draft:${draft.id}`,
      kind: 'task',
      description: draft.task,
      label: draft.title,
      brain: defaultBrainPolicy(),
      contract: {
        agentName: draft.agentName,
        model: draft.model,
        permissionMode: draft.permissionMode,
      },
    } satisfies TaskNode);
  }

  // ── Routers → RouterNodeIR ────────────────────────────────────────
  for (const router of input.routers) {
    nodes.push({
      id: `router:${router.id}`,
      kind: 'router',
      branches: router.branches.map((b: CanvasRouterBranch): GraphRouterBranch => ({
        id: b.id,
        label: b.label,
        condition: b.condition,
        // RouterBranch.targetNodeId is optional (string | undefined) — an
        // unresolved branch (no matching chain) has no target at all, so
        // resolveRouterBranchTarget's `null` (shared with refToNodeId's
        // "not found" sentinel) is normalized to `undefined` here.
        targetNodeId: resolveRouterBranchTarget(router.id, b.id, input) ?? undefined,
      })),
      brain: defaultBrainPolicy({ recall: false, noteOnSuccess: false, noteOnFailure: false }),
    } satisfies RouterNodeIR);
  }

  // ── Joins → fan-in edges ──────────────────────────────────────────
  for (const join of input.joins) {
    const joinOutgoing = input.chains.filter(
      (c) => !c.disabled && parseRef(c.sourceRef)?.kind === 'join' && parseRef(c.sourceRef)?.id === join.id,
    );

    for (const sourceRef of join.sourceRefs) {
      const sourceNodeId = refToNodeId(sourceRef);
      if (!sourceNodeId) continue;

      for (const chain of joinOutgoing) {
        const targetNodeId = refToNodeId(chain.targetRef);
        if (!targetNodeId) continue;

        edges.push({
          id: `edge:${sourceNodeId}->${targetNodeId}:join:${join.id}`,
          from: sourceNodeId,
          to: targetNodeId,
          kind: 'control',
          condition: mapChainCondition(chain.condition),
        });
      }
    }
  }

  // ── Chains → Edges (skip join-originated, already handled) ────────
  for (const chain of input.chains) {
    if (chain.disabled) continue;
    if (parseRef(chain.sourceRef)?.kind === 'join') continue;

    const fromNodeId = refToNodeId(chain.sourceRef);
    const toNodeId = refToNodeId(chain.targetRef);
    if (!fromNodeId || !toNodeId) continue;

    edges.push({
      id: `edge:${fromNodeId}->${toNodeId}:${chain.id}`,
      from: fromNodeId,
      to: toNodeId,
      kind: 'control',
      condition: mapChainCondition(chain.condition),
    });
  }

  return {
    id: `canvas-${input.projectId ?? 'transverse'}-${now}`,
    version: 1,
    name: `Canvas ${input.projectId ?? 'transverse'}`,
    objective: 'Canvas-compiled graph',
    projectId: input.projectId ?? '',
    defaults: defaultGraphDefaults(),
    nodes,
    edges,
    createdAt: now,
    updatedAt: now,
    source: 'canvas',
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function refToNodeId(ref: NodeRef): string | null {
  const parsed = parseRef(ref);
  if (!parsed) return null;

  switch (parsed.kind) {
    case 'draft':
      return `draft:${parsed.id}`;
    case 'router': {
      // A router BRANCH source ref (`router:<routerId>:<branchId>`) never
      // has its own node in the IR — only the whole router does (same
      // convention as reconcilerEdges.ts's resolveRouterBranchEndpoint,
      // which resolves a branch ref down to `router:<routerId>` for the
      // exact same reason at render time). The branch's actual downstream
      // target is recorded separately, once, on the router's own
      // RouterNodeIR.branches[].targetNodeId (populated by
      // resolveRouterBranchTarget below, called ONLY from the routers loop
      // that builds RouterNodeIR).
      //
      // Bug fixed here: this case used to call resolveRouterBranchTarget
      // itself for ANY branch ref, including one appearing as a chain's own
      // sourceRef. For a chain `c2: router:r1:b1 -> draft:d2`,
      // refToNodeId(c2.sourceRef) would search input.chains for "the chain
      // whose source is router:r1:b1" — and find c2 itself (the chain
      // currently being compiled) — then return refToNodeId(c2.targetRef),
      // i.e. 'draft:d2'. With toNodeId ALSO resolving to 'draft:d2', the
      // compiled edge was `draft:d2 -> draft:d2`: a self-loop. validateGraph
      // rejects any cycle in the control graph (graphIr.ts), so a canvas
      // graph containing so much as one router failed validation outright
      // and could never run.
      const branch = parseRouterBranchRef(ref);
      return `router:${branch ? branch.routerId : parsed.id}`;
    }
    case 'mission':
      return `draft:${parsed.id}`;

    case 'join':
      // A join never gets a `join:<id>` node of its own in this compiler —
      // its fan-in is inlined as direct control edges by the joins loop
      // above (one edge per source × joinOutgoing-target pair). The
      // standalone chains loop below already skips any chain whose SOURCE
      // parses as 'join' (the joins loop already emitted it), but a join
      // used as a chain's TARGET reaches this case too: canvasStore.ts's
      // `addChain` dual-writes that wiring into BOTH `chains` (a plain
      // Chain record, targetRef: 'join:<id>') AND the target join's own
      // `sourceRefs`. Returning null here is what lets the standalone
      // loop's `if (!toNodeId) continue` skip that already-compiled-via-
      // the-joins-loop chain instead of emitting a duplicate edge. Not
      // decorative, not unsupported — resolved elsewhere, by design.
      return null;

    // ── Decorative kinds (2026-08-15 audit follow-up) ──────────────────
    // None of these can legally land on either end of a chain today —
    // verified against the live node components and chainValidation.ts,
    // not assumed:
    //   - project (zone), note, frame: render no React Flow <Handle> at
    //     all (ProjectGroupNode.tsx, NoteNode.tsx, FrameNode.tsx) —
    //     nothing can ever be dragged to/from one.
    //   - iteration: a read-only loop-iteration projection (canvasTypes.ts's
    //     own CanvasNodeKind doc comment: "never a chain target ... never
    //     draggable") — also renders no Handle.
    //   - terminal, preview: live surfaces (TerminalNode.tsx,
    //     PreviewNode.tsx) render ONLY a target Handle with
    //     `isConnectable={false}` and no source Handle at all, and
    //     chainValidation.ts's target whitelist rejects them as a chain
    //     target regardless — neither end of a chain can ever resolve here.
    // Listed explicitly, one case per kind (never a catch-all default), so
    // dropping the edge reads as an intentional decision, not an omission.
    case 'project':
    case 'note':
    case 'iteration':
    case 'terminal':
    case 'preview':
    case 'frame':
    case 'bot':
    case 'botVm':
      return null;

    // ── Meaningful but not yet compilable (2026-08-15 audit follow-up) ──
    // Unlike the kinds above, `schedule` and `loop` DO carry real
    // execution intent, and the canvas DOES let a user wire one into a
    // chain today:
    //   - ScheduleNode.tsx renders a fully connectable source AND target
    //     Handle — dragging a chain FROM a schedule into a draft/router/
    //     join passes validateChain (it whitelists TARGET kinds only, never
    //     checks the source's kind) with zero warning.
    //   - LoopNode.tsx renders the same connectable source+target pair;
    //     wiring a chain INTO a loop is rejected ('canvas.chain.intoLoop'),
    //     but wiring one OUT of a loop is accepted — and agentsStore.tsx's
    //     manager `chain_agents` action explicitly whitelists 'loop' as a
    //     valid chain source too.
    // Before this fix, this function silently returned null for both,
    // canvasToIr dropped the edge (`if (!fromNodeId) continue`), and the
    // compiled graph ran with that part of what the user drew simply
    // missing — no error, no warning. Compiling a Loop/Schedule node into
    // the graph IR is a documented, larger workstream
    // (chainGraphAdapter.ts's header: "P5.4+ join/contest/loop IR
    // parity") that this fix does not attempt; refusing to compile at all,
    // loudly and by name, is the honest alternative until that lands.
    case 'schedule':
    case 'loop':
      throw unsupportedCanvasNodeError(parsed.kind, ref);

    default: {
      // Exhaustive-by-construction: every CanvasNodeKind (canvasTypes.ts)
      // is handled by a case above. If a 13th kind is ever added without
      // updating this switch, TypeScript flags `parsed.kind` as not
      // assignable to `never` here at compile time — the whole point of
      // this fix is that a new kind can never again silently fall through
      // to null the way project/schedule/note/iteration/terminal/preview/
      // frame all did before it.
      const exhaustive: never = parsed.kind;
      throw new Error(`canvasToIr: no compile decision for canvas node kind "${String(exhaustive)}"`);
    }
  }
}

/** Builds the error canvasToIr throws when a chain touches a canvas node
 *  kind that IS meaningful to a run but that this compiler cannot yet
 *  honour (see refToNodeId's 'schedule'/'loop' case above for the full
 *  reasoning). Refusing to compile, naming the exact node, beats silently
 *  running a graph that is missing part of what the user drew. */
function unsupportedCanvasNodeError(kind: 'schedule' | 'loop', ref: NodeRef): Error {
  const reason =
    kind === 'loop'
      ? 'Loop nodes are not yet compiled into the graph IR (documented scaffold gap — see chainGraphAdapter.ts, "P5.4+ join/contest/loop IR parity")'
      : 'Schedule (cron trigger) nodes are not yet compiled into the graph IR';
  return new Error(
    `Cannot compile canvas graph: node "${ref}" is wired into a chain, but ${reason}. ` +
      `Remove the chain connecting this ${kind} node before running this graph.`,
  );
}

function resolveRouterBranchTarget(routerId: string, branchId: string, input: CanvasCompileInput): string | null {
  const branchRef = `router:${routerId}:${branchId}`;
  const chain = input.chains.find((c) => !c.disabled && c.sourceRef === branchRef);
  if (!chain) return null;
  return refToNodeId(chain.targetRef);
}

function mapChainCondition(condition: string): GraphEdge['condition'] {
  switch (condition) {
    case 'success':
      return { kind: 'outcome', value: 'success' };
    case 'fail':
      return { kind: 'outcome', value: 'fail' };
    case 'always':
      return { kind: 'default' };
    default:
      return { kind: 'default' };
  }
}
