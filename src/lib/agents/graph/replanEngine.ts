/* graph/replanEngine.ts — Structural replan engine for the Single Graph Runtime.

   When a node fails, the replan engine:
   1. Receives the failure diagnosis + Brain context
   2. Produces a GraphPatch (update nodes, add nodes, skip nodes, etc.)
   3. Respects maxReplans and budget gates
   4. Writes a Brain note via noteReplan

   The patch is applied to the GraphIR and the run resumes from the next wave.
*/

import type { GraphIR, GraphRun, GraphPatch, GraphNode, NodeRun } from './types.js';
import { noteReplan } from './brainBus.js';

export interface ReplanContext {
  graphId: string;
  runId: string;
  projectRoot: string;
  failedNodeId: string;
  failedNodeRun: NodeRun;
  diagnosis: {
    category: string;
    rootCause: string;
    suggestedFix: string;
    confidence: number;
    brainContext?: string;
    /** Phase 4: Whether this failure was preventable (LLM-assessed). */
    preventable?: boolean;
  };
  attempt: number;
}

export interface ReplanResult {
  patch: GraphPatch | null;
  reason: string;
  shouldRetry: boolean;
  shouldSkip: boolean;
  shouldAbort: boolean;
  /** The graph/run AFTER this replan — always present, even on the
   *  no-patch/abort paths (unchanged pass-through of the input `ir`/`run`
   *  in that case). Callers should always adopt these, never the `ir`/`run`
   *  they originally passed in — see applyPatch's doc comment: neither
   *  parameter is mutated. */
  ir: GraphIR;
  run: GraphRun;
}

// ── Main entry point ──────────────────────────────────────────────

export function replan(
  ir: GraphIR,
  run: GraphRun,
  ctx: ReplanContext,
): ReplanResult {
  const { failedNodeId, attempt } = ctx;

  // Gate 1: maxReplans exceeded
  if (run.replanCount >= (ir.defaults.maxReplans ?? 2)) {
    return {
      patch: null,
      reason: `Max replans (${ir.defaults.maxReplans ?? 2}) exceeded for graph ${ir.id}`,
      shouldRetry: false,
      shouldSkip: false,
      shouldAbort: true,
      ir,
      run,
    };
  }

  // Gate 2: budget exhausted
  if (run.budget.limitUsd !== undefined && run.budget.spentUsd >= run.budget.limitUsd) {
    return {
      patch: null,
      reason: `Budget exhausted ($${run.budget.spentUsd.toFixed(2)} / $${run.budget.limitUsd.toFixed(2)})`,
      shouldRetry: false,
      shouldSkip: false,
      shouldAbort: true,
      ir,
      run,
    };
  }

  // Gate 3: too many attempts on the same node — respect node-level maxAttempts
  // (default 2, hard cap 5 via compileOrchestratorToIr) instead of hardcoded 3
  const node = ir.nodes.find((n) => n.id === failedNodeId);
  const nodeMaxAttempts = Math.min(node?.maxAttempts ?? 2, 5);
  if (attempt > nodeMaxAttempts) {
    const isCritical = node?.critical !== false;
    if (!isCritical) {
      const patch: GraphPatch = {
        skipNodeIds: [failedNodeId],
        reason: `Node ${failedNodeId} failed ${attempt} times (max ${nodeMaxAttempts}) — skipping non-critical node`,
      };
      const patched = applyPatch(ir, run, patch, ctx);
      return {
        patch,
        reason: patch.reason,
        shouldRetry: false,
        shouldSkip: true,
        shouldAbort: false,
        ir: patched.ir,
        run: patched.run,
      };
    }
    return {
      patch: null,
      reason: `Critical node ${failedNodeId} failed ${attempt} times (max ${nodeMaxAttempts}) — aborting`,
      shouldRetry: false,
      shouldSkip: false,
      shouldAbort: true,
      ir,
      run,
    };
  }

  // Strategy: produce a patch based on diagnosis category
  // Phase 4: If diagnosis says the failure was NOT preventable, retrying
  // the same approach is unlikely to help — lean toward abort for critical
  // nodes or skip for non-critical ones.
  if (ctx.diagnosis.preventable === false && attempt > 1) {
    const isCritical = node?.critical !== false;
    if (!isCritical) {
      const patch: GraphPatch = {
        skipNodeIds: [failedNodeId],
        reason: `Node ${failedNodeId} failed with non-preventable cause — skipping non-critical node`,
      };
      const patched = applyPatch(ir, run, patch, ctx);
      return {
        patch,
        reason: patch.reason,
        shouldRetry: false,
        shouldSkip: true,
        shouldAbort: false,
        ir: patched.ir,
        run: patched.run,
      };
    }
    return {
      patch: null,
      reason: `Critical node ${failedNodeId} failed with non-preventable cause — aborting`,
      shouldRetry: false,
      shouldSkip: false,
      shouldAbort: true,
      ir,
      run,
    };
  }

  const patch = buildPatchFromDiagnosis(ir, ctx);
  if (!patch) {
    return {
      patch: null,
      reason: 'No replan strategy available for this failure',
      shouldRetry: false,
      shouldSkip: false,
      shouldAbort: true,
      ir,
      run,
    };
  }

  const patched = applyPatch(ir, run, patch, ctx);
  return {
    patch,
    reason: patch.reason,
    shouldRetry: true,
    shouldSkip: false,
    shouldAbort: false,
    ir: patched.ir,
    run: patched.run,
  };
}

// ── Patch builder ─────────────────────────────────────────────────

function buildPatchFromDiagnosis(ir: GraphIR, ctx: ReplanContext): GraphPatch | null {
  const { failedNodeId, diagnosis, attempt } = ctx;
  const node = ir.nodes.find((n) => n.id === failedNodeId);
  if (!node) return null;

  const reason = `Replan #${attempt + 1}: ${diagnosis.category} — ${diagnosis.rootCause}`;

  // Strategy 1: type_error / lint_error → update description with fix hint
  if (diagnosis.category === 'type_error' || diagnosis.category === 'lint_error') {
    return {
      updateNodes: [
        {
          id: failedNodeId,
          description: appendFixHint(node, diagnosis.suggestedFix),
        },
      ],
      reason,
    };
  }

  // Strategy 2: test_failure → update description + add a verification step
  if (diagnosis.category === 'test_failure') {
    const verifyNodeId = `${failedNodeId}-verify-${attempt + 1}`;
    const verifyNode: GraphNode = {
      id: verifyNodeId,
      kind: 'task',
      label: `Verify fix for ${failedNodeId}`,
      description: `Run tests and verify the fix for: ${diagnosis.rootCause}`,
      contract: { ...('contract' in node ? node.contract : {}), engine: 'auto' },
      brain: node.brain,
      critical: false,
      maxAttempts: 1,
    };

    // Find edges from failedNodeId and insert verify node between
    const downstreamEdges = ir.edges.filter((e) => e.kind === 'control' && e.from === failedNodeId);

    return {
      updateNodes: [
        {
          id: failedNodeId,
          description: appendFixHint(node, diagnosis.suggestedFix),
        },
      ],
      addNodes: [verifyNode],
      addEdges: [
        { id: `e-replan-${Date.now()}-1`, from: failedNodeId, to: verifyNodeId, kind: 'control' },
        ...downstreamEdges.map((e) => ({
          id: `e-replan-${Date.now()}-${e.to}`,
          from: verifyNodeId,
          to: e.to,
          kind: 'control' as const,
        })),
      ],
      removeEdgeIds: downstreamEdges.map((e) => e.id),
      reason,
    };
  }

  // Strategy 3: budget_exceeded → can't fix by replanning, abort
  if (diagnosis.category === 'budget_exceeded') {
    return null;
  }

  // Strategy 4: infrastructure → simple retry with backoff hint
  if (diagnosis.category === 'infrastructure') {
    return {
      updateNodes: [
        {
          id: failedNodeId,
          description: appendFixHint(node, `Retry after backoff. ${diagnosis.suggestedFix}`),
        },
      ],
      reason,
    };
  }

  // Strategy 5: git_error → update description with fix hint
  if (diagnosis.category === 'git_error') {
    return {
      updateNodes: [
        {
          id: failedNodeId,
          description: appendFixHint(node, diagnosis.suggestedFix),
        },
      ],
      reason,
    };
  }

  // Strategy 6: unknown_failure → generic retry with diagnosis hint
  return {
    updateNodes: [
      {
        id: failedNodeId,
        description: appendFixHint(node, diagnosis.suggestedFix),
      },
    ],
    reason: `${reason} (generic retry)`,
  };
}

// ── Patch application ─────────────────────────────────────────────

/** Applies a GraphPatch to `ir`/`run`, returning NEW objects — neither
 *  input parameter is mutated. Same values, same Brain-note side effect,
 *  as the previous in-place-mutating design; only object identity changes.
 *  Callers must adopt the returned `{ ir, run }`, not their original
 *  references, to observe the patch. */
function applyPatch(ir: GraphIR, run: GraphRun, patch: GraphPatch, ctx: ReplanContext): { ir: GraphIR; run: GraphRun } {
  let nextNodes = ir.nodes;
  let nextEdges = ir.edges;
  let nextNodeRuns = run.nodeRuns;

  // Update nodes
  if (patch.updateNodes) {
    nextNodes = nextNodes.map((node) => {
      const update = patch.updateNodes!.find((u) => u.id === node.id);
      if (!update || (node.kind !== 'task' && node.kind !== 'contest')) return node;
      return {
        ...node,
        ...(update.description ? { description: update.description } : {}),
        ...(update.contract ? { contract: { ...node.contract, ...update.contract } } : {}),
      };
    });
  }

  // Add nodes
  if (patch.addNodes) {
    nextNodes = [...nextNodes, ...patch.addNodes];
    for (const newNode of patch.addNodes) {
      if (!nextNodeRuns[newNode.id]) {
        nextNodeRuns = {
          ...nextNodeRuns,
          [newNode.id]: { nodeId: newNode.id, status: 'pending', attempt: 0, missionIds: [] },
        };
      }
    }
  }

  // Remove nodes
  if (patch.removeNodeIds) {
    const removeIds = patch.removeNodeIds;
    nextNodes = nextNodes.filter((n) => !removeIds.includes(n.id));
    const remainingNodeRuns = { ...nextNodeRuns };
    for (const id of removeIds) delete remainingNodeRuns[id];
    nextNodeRuns = remainingNodeRuns;
  }

  // Add edges
  if (patch.addEdges) {
    nextEdges = [...nextEdges, ...patch.addEdges];
  }

  // Remove edges
  if (patch.removeEdgeIds) {
    const removeEdgeIds = patch.removeEdgeIds;
    nextEdges = nextEdges.filter((e) => !removeEdgeIds.includes(e.id));
  }

  // Skip nodes — mark as skipped in the run
  if (patch.skipNodeIds) {
    for (const id of patch.skipNodeIds) {
      if (nextNodeRuns[id]) {
        nextNodeRuns = {
          ...nextNodeRuns,
          [id]: { ...nextNodeRuns[id], status: 'skipped', completedAt: Date.now() },
        };
      }
    }
  }

  // Reset the failed node's run state for retry
  if (patch.updateNodes?.some((u) => u.id === ctx.failedNodeId)) {
    const failedNr = nextNodeRuns[ctx.failedNodeId];
    if (failedNr && failedNr.status === 'failed') {
      nextNodeRuns = {
        ...nextNodeRuns,
        [ctx.failedNodeId]: { ...failedNr, status: 'pending', errorMessage: undefined, completedAt: undefined },
      };
    }
  }

  const nextIr: GraphIR = { ...ir, nodes: nextNodes, edges: nextEdges };
  const nextRun: GraphRun = {
    ...run,
    nodeRuns: nextNodeRuns,
    replanCount: run.replanCount + 1,
    updatedAt: Date.now(),
  };

  // Write Brain note
  noteReplan({
    projectRoot: ctx.projectRoot,
    graphId: ctx.graphId,
    runId: ctx.runId,
    patch,
    reason: patch.reason,
  });

  return { ir: nextIr, run: nextRun };
}

// ── Helpers ───────────────────────────────────────────────────────

function appendFixHint(node: GraphNode, hint: string): string {
  if (node.kind === 'task' || node.kind === 'contest') {
    return `${node.description}\n\n[Replan hint: ${hint}]`;
  }
  return node.label ?? node.id;
}
