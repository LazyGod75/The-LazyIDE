/* graph/graphIr.ts — Graph IR validation, topological sort, ready-set
   computation, and cycle detection.

   Pure functions, no side effects, fully testable.
*/

import type { GraphIR, GraphNode, GraphEdge, GraphRun, NodeRun, RouterBranch } from './types.js';

// ── Validation ────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateGraph(ir: GraphIR): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Unique node ids
  const nodeIds = new Set<string>();
  const seenNodeIds: string[] = [];
  for (const node of ir.nodes) {
    if (nodeIds.has(node.id)) {
      errors.push(`Duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);
    seenNodeIds.push(node.id);
  }

  // 2. Unique edge ids
  const edgeIds = new Set<string>();
  for (const edge of ir.edges) {
    if (edgeIds.has(edge.id)) {
      errors.push(`Duplicate edge id: ${edge.id}`);
    }
    edgeIds.add(edge.id);

    // 3. Edges reference existing nodes
    if (!nodeIds.has(edge.from)) {
      errors.push(`Edge ${edge.id} references missing source node: ${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      errors.push(`Edge ${edge.id} references missing target node: ${edge.to}`);
    }
  }

  // 4. No cycles in control graph (outside loop bodies)
  const controlEdges = ir.edges.filter((e) => e.kind === 'control');
  const cycle = detectCycle(ir.nodes.map((n) => n.id), controlEdges);
  if (cycle) {
    errors.push(`Cycle detected in control graph: ${cycle.join(' → ')}`);
  }

  // 5. contest.n >= 2
  for (const node of ir.nodes) {
    if (node.kind === 'contest' && node.n < 2) {
      errors.push(`Contest node ${node.id} must have n >= 2, got ${node.n}`);
    }
  }

  // 6. join.quorum required if mode=quorum
  for (const node of ir.nodes) {
    if (node.kind === 'join' && node.mode === 'quorum' && (node.quorum === undefined || node.quorum < 1)) {
      errors.push(`Join node ${node.id} has mode=quorum but no valid quorum value`);
    }
  }

  // 7. Subgraph depth ≤ 8
  const maxDepth = checkSubgraphDepth(ir, new Set());
  if (maxDepth > 8) {
    errors.push(`Subgraph nesting depth ${maxDepth} exceeds maximum of 8`);
  }

  // 8. budgetCapUsd / maxDurationMs >= 0
  for (const node of ir.nodes) {
    if (node.kind === 'task' || node.kind === 'contest') {
      const c = node.contract;
      if (c.budgetCapUsd !== undefined && c.budgetCapUsd < 0) {
        errors.push(`Node ${node.id} has negative budgetCapUsd: ${c.budgetCapUsd}`);
      }
      if (c.maxDurationMs !== undefined && c.maxDurationMs < 0) {
        errors.push(`Node ${node.id} has negative maxDurationMs: ${c.maxDurationMs}`);
      }
    }
  }

  // Warnings for sessionful requirements
  for (const node of ir.nodes) {
    if ((node.kind === 'task' || node.kind === 'contest') && node.contract.requiresSessionful) {
      warnings.push(`Node ${node.id} requires sessionful engine — native one-shot will not support HITL`);
    }
  }

  // 9. Reject 'outcome: fail' conditions the runtime cannot honour (item 3,
  // 2026-08-15 audit, D2). getReadyNodes/evaluateCondition below only ever
  // evaluate a control edge's condition once its predecessor has ALREADY
  // settled to 'done' — a failed predecessor never lets ANY control
  // successor become ready, by design (a failed critical node aborts the
  // run; a failed non-critical one just leaves its successors permanently
  // unready). So a control edge or router branch conditioned on
  // `outcome: fail` can never fire under this runtime — silently accepting
  // and then never honouring it is exactly the "conditional routing
  // silently runs everything" bug this item exists to close for the
  // conditions we DO evaluate; for the one condition shape we do not (and
  // cannot, without a deeper redesign of the ready-set baseline — see this
  // module's own evaluateCondition doc comment), the graph is refused
  // outright instead of silently accepted-and-ignored.
  for (const edge of ir.edges) {
    if (edge.kind === 'control' && edge.condition?.kind === 'outcome' && edge.condition.value === 'fail') {
      errors.push(
        `Edge ${edge.id} (${edge.from} → ${edge.to}) has condition outcome:fail — a control edge is only ever ` +
          `evaluated once its predecessor settles 'done', so this condition can never be satisfied by this runtime`,
      );
    }
  }
  for (const node of ir.nodes) {
    if (node.kind !== 'router') continue;
    for (const branch of node.branches) {
      if (branch.condition.kind === 'outcome' && branch.condition.value === 'fail') {
        errors.push(
          `Router node ${node.id} branch ${branch.id} has condition outcome:fail — the router only evaluates a ` +
            `predecessor that has ALREADY settled 'done', so this condition can never be satisfied by this runtime`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ── Cycle detection (DFS-based) ───────────────────────────────────

export function detectCycle(nodeIds: string[], edges: GraphEdge[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const edge of edges) {
    if (adj.has(edge.from)) {
      adj.get(edge.from)!.push(edge.to);
    }
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodeIds) color.set(id, WHITE);

  let cyclePath: string[] | null = null;

  function dfs(u: string, path: string[]): void {
    if (cyclePath) return;
    color.set(u, GRAY);
    path.push(u);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GRAY) {
        // Found cycle — extract from path
        const idx = path.indexOf(v);
        cyclePath = [...path.slice(idx), v];
        return;
      }
      if (color.get(v) === WHITE) {
        dfs(v, path);
      }
    }
    path.pop();
    color.set(u, BLACK);
  }

  for (const id of nodeIds) {
    if (color.get(id) === WHITE) {
      dfs(id, []);
      if (cyclePath) return cyclePath;
    }
  }

  return null;
}

// ── Topological sort ──────────────────────────────────────────────

export function topologicalSort(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adj = new Map<string, string[]>();
  for (const node of nodes) adj.set(node.id, []);
  for (const edge of edges) {
    if (edge.kind === 'control' && adj.has(edge.from)) {
      adj.get(edge.from)!.push(edge.to);
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: GraphNode[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) return; // cycle — break
    visiting.add(id);
    for (const dep of adj.get(id) ?? []) {
      visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
    const node = byId.get(id);
    if (node) result.push(node);
  }

  // Visit in original order for deterministic output
  for (const node of nodes) visit(node.id);
  // DFS post-order gives reverse topological order — reverse to get correct order
  result.reverse();
  return result;
}

// ── Ready set computation ──────────────────────────────────────────

/**
 * Evaluates a router-branch/edge condition against a predecessor's settled
 * NodeRun. Mirrors canvasChainOps.ts's `resolveRouterBranch` semantics
 * (outcome success/fail, case-insensitive `contains`, `default` always
 * matches) so the two engines (SGR here, canvas chains there) agree on what
 * a condition means — but this is evaluated over a `NodeRun`, not a
 * `Mission`, so it reads `nodeRunOutputText` instead of a mission's own
 * output text.
 *
 * IMPORTANT: `outcome: fail` is accepted here (never throws) for defense in
 * depth, but is UNREACHABLE in practice: every caller (getReadyNodes below,
 * runGraph.ts's router-node handler) only ever calls this once the
 * predecessor has ALREADY settled to `status: 'done'` — a failed
 * predecessor never lets a control successor become ready at all, by this
 * runtime's existing design (see runGraph.ts's failedCritical/replan
 * handling). `validateGraph` refuses any graph carrying an `outcome: fail`
 * condition outright (item 3/D2, 2026-08-15 audit) specifically because
 * this runtime cannot honour it — silently accepting and then never firing
 * it would be the exact "conditional routing silently runs everything"
 * defect this item exists to close.
 */
export function evaluateCondition(condition: RouterBranch['condition'] | undefined, predRun: NodeRun): boolean {
  if (!condition || condition.kind === 'default') return true;
  if (condition.kind === 'outcome') {
    if (condition.value === 'success') return predRun.status === 'done';
    if (condition.value === 'fail') return predRun.status === 'failed';
    return false;
  }
  if (condition.kind === 'contains') {
    return nodeRunOutputText(predRun).toLowerCase().includes(condition.value.toLowerCase());
  }
  return false;
}

/** Best-effort textual rendering of a NodeRun's settled output — used by
 *  `evaluateCondition`'s `contains` case. Prefers the structured/parsed
 *  `output` (data plane); falls back to `errorMessage` so a `contains`
 *  condition can still match on a failure's own text. Never throws on a
 *  non-JSON-serializable output (circular refs, etc.) — degrades to
 *  `String(value)` instead of blowing up condition evaluation. */
function nodeRunOutputText(nr: NodeRun): string {
  const parts: string[] = [];
  if (nr.output !== undefined) {
    parts.push(typeof nr.output === 'string' ? nr.output : safeStringify(nr.output));
  }
  if (nr.errorMessage) parts.push(nr.errorMessage);
  return parts.join('\n');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Compute the set of node ids that are ready to execute:
 * - status is 'pending' or 'ready'
 * - all inbound control-edge predecessors are in status 'done' AND, for an
 *   edge carrying a `condition` (item 3/D2 fix, 2026-08-15 audit — this used
 *   to be parsed onto GraphEdge but never read here, so conditional routing
 *   silently ran every branch), that condition evaluates true against the
 *   predecessor's own settled NodeRun (see `evaluateCondition` above). An
 *   edge with no condition behaves exactly as before (unconditional).
 */
export function getReadyNodes(
  ir: GraphIR,
  run: GraphRun,
): string[] {
  const controlPreds = new Map<string, GraphEdge[]>();
  for (const node of ir.nodes) controlPreds.set(node.id, []);
  for (const edge of ir.edges) {
    if (edge.kind === 'control') {
      const preds = controlPreds.get(edge.to);
      if (preds) preds.push(edge);
    }
  }

  const ready: string[] = [];
  for (const node of ir.nodes) {
    const nr = run.nodeRuns[node.id];
    if (!nr || (nr.status !== 'pending' && nr.status !== 'ready')) continue;

    const preds = controlPreds.get(node.id) ?? [];
    const allDepsSatisfied = preds.every((edge) => {
      const predRun = run.nodeRuns[edge.from];
      if (!predRun || predRun.status !== 'done') return false;
      return evaluateCondition(edge.condition, predRun);
    });

    if (allDepsSatisfied) {
      ready.push(node.id);
    }
  }
  return ready;
}

/**
 * Get entry nodes (no inbound control edges) or use explicit entryNodeIds.
 */
export function getEntryNodes(ir: GraphIR): string[] {
  if (ir.entryNodeIds && ir.entryNodeIds.length > 0) return ir.entryNodeIds;

  const hasInbound = new Set<string>();
  for (const edge of ir.edges) {
    if (edge.kind === 'control') hasInbound.add(edge.to);
  }
  return ir.nodes.filter((n) => !hasInbound.has(n.id)).map((n) => n.id);
}

// ── Subgraph depth check ──────────────────────────────────────────

function checkSubgraphDepth(ir: GraphIR, visited: Set<string>): number {
  let maxChild = 0;
  for (const node of ir.nodes) {
    if (node.kind === 'subgraph' && !('graphId' in node.graph) && !visited.has(node.id)) {
      visited.add(node.id);
      const childIr = node.graph as GraphIR;
      const childDepth = checkSubgraphDepth(childIr, visited);
      if (childDepth + 1 > maxChild) maxChild = childDepth + 1;
    }
  }
  return maxChild;
}

// ── Helpers ───────────────────────────────────────────────────────

export function getNodeById(ir: GraphIR, id: string): GraphNode | undefined {
  return ir.nodes.find((n) => n.id === id);
}

export function getControlPredecessors(ir: GraphIR, nodeId: string): string[] {
  return ir.edges
    .filter((e) => e.kind === 'control' && e.to === nodeId)
    .map((e) => e.from);
}

export function getControlSuccessors(ir: GraphIR, nodeId: string): string[] {
  return ir.edges
    .filter((e) => e.kind === 'control' && e.from === nodeId)
    .map((e) => e.to);
}

export function initNodeRun(nodeId: string): NodeRun {
  return {
    nodeId,
    status: 'pending',
    attempt: 0,
    missionIds: [],
  };
}

export function initGraphRun(graphId: string, ir: GraphIR): GraphRun {
  const nodeRuns: Record<string, NodeRun> = {};
  for (const node of ir.nodes) {
    nodeRuns[node.id] = initNodeRun(node.id);
  }
  return {
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    graphId,
    graphVersion: 1,
    status: 'pending',
    nodeRuns,
    nodeOutputs: {},
    budget: {
      spentUsd: 0,
      limitUsd: ir.defaults.budgetCapUsd,
    },
    replanCount: 0,
    checkpoints: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourcePlanId: ir.source === 'plan' ? (ir.sourceRef ?? ir.id) : undefined,
  };
}
