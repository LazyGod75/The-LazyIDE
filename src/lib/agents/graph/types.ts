/* graph/types.ts — Graph IR: the single intermediate representation for
   orchestrator plans, canvas graphs, and manager-compiled actions.

   Phase 1: types only — additive, no existing types modified.
   See docs/superpowers/specs/2026-07-24-graph-ir-spec.md for the full spec.
*/

import type { ProofRequirement, GateConfig, Effort } from '../types.js';

// ── Brain policy ──────────────────────────────────────────────────

export interface BrainPolicy {
  recall: boolean;
  recallQuery?: string;
  recallLimit?: number;
  noteOnSuccess: boolean;
  noteOnFailure: boolean;
  tags?: string[];
}

export function defaultBrainPolicy(overrides?: Partial<BrainPolicy>): BrainPolicy {
  return {
    recall: true,
    recallLimit: 5,
    noteOnSuccess: true,
    noteOnFailure: true,
    ...overrides,
  };
}

// ── Step contract ─────────────────────────────────────────────────

export interface StepContract {
  agentName?: string;
  model?: string;
  /**
   * Exact catalog id (see OrchestratorPlanStepInput.modelId's doc comment,
   * ../types.ts) naming ONE model precisely, taking priority over `model`
   * (a tier hint) at resolution time — same ManagerModelId contract the
   * manager's other launch actions use. Threaded from
   * OrchestratorPlanStep.modelId by compileOrchestrator.ts's stepToNode, and
   * read back out by graph/sgrOrchestratorRunner.ts's launchOptsFromNode —
   * this is the plan-first path's leg of the modelId catalog wave (see
   * managerEngine.ts's module comment above resolveManagerModelId).
   */
  modelId?: string;
  /**
   * Cross-project READ access (see OrchestratorPlanStepInput.extraReadableProjectIds's
   * doc comment, ../types.ts, for the full contract): project ids/names —
   * NOT yet resolved to real roots at this layer, that happens where the
   * `launchMission` dep is actually implemented (agentsStore.tsx's SGR
   * `launchMission` callback), the same choke point `launch_mission`'s own
   * executor resolves through. Threaded from OrchestratorPlanStep.extraReadableProjectIds
   * by compileOrchestrator.ts's stepToNode, and read back out by
   * graph/sgrOrchestratorRunner.ts's launchOptsFromNode — same thread shape
   * as `modelId` above.
   */
  extraReadableProjectIds?: string[];
  /** See OrchestratorPlanStepInput.baseBranch's doc comment (../types.ts)
   *  for the full contract and thread — this is the graph-IR leg. Set
   *  EXPLICITLY on the plan step by the manager/user (wins over inherited
   *  default), OR injected dynamically by runGraph.ts's
   *  `resolveInheritedBranches` right before launch when the step has
   *  `dependsOn` and no explicit baseBranch of its own — see that
   *  function's doc comment for the inheritance rule. */
  baseBranch?: string;
  /** See Mission.mergeBranches's doc comment (../types.ts) — the graph-IR
   *  leg of the fan-in dependency merge. NEVER set by the plan compiler
   *  itself (no `OrchestratorPlanStep` field feeds this); only
   *  runGraph.ts's `resolveInheritedBranches` injects it, when a node has
   *  more than one resolved upstream branch and no explicit `baseBranch`. */
  mergeBranches?: string[];
  effort?: Effort;
  engine?: 'cli' | 'pro' | 'auto';
  permissionMode?: 'plan' | 'acceptEdits' | 'full';
  budgetCapUsd?: number;
  maxDurationMs?: number;
  scopePaths?: string[];
  proofs?: ProofRequirement[];
  gates?: GateConfig;
  contestN?: number;
  toolPolicy?: { allow?: string[]; deny?: string[] };
  requiresSessionful?: boolean;
  title?: string;
  /** JSON-Schema-ish structured output contract (enforced at settle). */
  outputSchema?: Record<string, unknown>;
}

export function defaultStepContract(overrides?: Partial<StepContract>): StepContract {
  return {
    engine: 'auto',
    permissionMode: 'acceptEdits',
    ...overrides,
  };
}

// ── Graph defaults ────────────────────────────────────────────────

export interface GraphDefaults {
  autonomyLevel: 'manual' | 'supervised' | 'yolo' | 'custom';
  engine?: 'cli' | 'pro' | 'auto';
  modelTier?: 'haiku' | 'sonnet' | 'opus' | string;
  permissionMode?: 'plan' | 'acceptEdits' | 'full';
  budgetCapUsd?: number;
  maxDurationMs?: number;
  brain: BrainPolicy;
  maxReplans?: number;
  maxParallelNodes?: number;
}

export function defaultGraphDefaults(overrides?: Partial<GraphDefaults>): GraphDefaults {
  return {
    autonomyLevel: 'supervised',
    engine: 'auto',
    maxReplans: 2,
    maxParallelNodes: 0,
    brain: defaultBrainPolicy(),
    ...overrides,
  };
}

// ── Node base ─────────────────────────────────────────────────────

export interface GraphNodeBase {
  id: string;
  label?: string;
  brain: BrainPolicy;
  critical?: boolean;
  maxAttempts?: number;
  ui?: { x?: number; y?: number };
}

// ── Task node ─────────────────────────────────────────────────────

export interface TaskNode extends GraphNodeBase {
  kind: 'task';
  description: string;
  contract: StepContract;
}

// ── Contest node ──────────────────────────────────────────────────

export interface ContestNode extends GraphNodeBase {
  kind: 'contest';
  description: string;
  contract: StepContract;
  n: number;
  ranking: 'judge' | 'first_success' | 'manual';
}

// ── Router node ───────────────────────────────────────────────────

export interface RouterBranch {
  id: string;
  label: string;
  condition:
    | { kind: 'outcome'; value: 'success' | 'fail' }
    | { kind: 'contains'; value: string }
    | { kind: 'default' };
  targetNodeId?: string;
}

export interface RouterNodeIR extends GraphNodeBase {
  kind: 'router';
  branches: RouterBranch[];
}

// ── Join node ─────────────────────────────────────────────────────

export interface JoinNodeIR extends GraphNodeBase {
  kind: 'join';
  mode: 'all' | 'any' | 'quorum';
  quorum?: number;
  merge: 'concat' | 'summary' | 'winner_only' | 'structured';
}

// ── Loop node ─────────────────────────────────────────────────────

export interface LoopNodeIR extends GraphNodeBase {
  kind: 'loop';
  bodyEntryId: string;
  exit: { kind: 'max_iterations'; n: number } | { kind: 'predicate'; expression: string };
  cadence?: string;
}

// ── Form node (HITL) ──────────────────────────────────────────────

export interface FormField {
  id: string;
  label: string;
  type: 'text' | 'boolean' | 'select';
  options?: string[];
}

export interface FormNode extends GraphNodeBase {
  kind: 'form';
  prompt: string;
  fields?: FormField[];
  timeoutMs?: number | null;
}

// ── Subgraph node ─────────────────────────────────────────────────

export interface SubgraphNode extends GraphNodeBase {
  kind: 'subgraph';
  graph: GraphIR | { graphId: string };
}

// ── Interrupt node ────────────────────────────────────────────────

export interface InterruptNode extends GraphNodeBase {
  kind: 'interrupt';
  reason: string;
  payload?: Record<string, unknown>;
}

// ── Node union ────────────────────────────────────────────────────

export type GraphNode =
  | TaskNode
  | ContestNode
  | RouterNodeIR
  | JoinNodeIR
  | LoopNodeIR
  | FormNode
  | SubgraphNode
  | InterruptNode;

// ── Edge ──────────────────────────────────────────────────────────

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: 'control' | 'data';
  condition?: RouterBranch['condition'];
  map?: { fromPath: string; toPath: string }[];
}

// ── GraphIR (top-level) ───────────────────────────────────────────

export interface GraphIR {
  id: string;
  version: 1;
  name: string;
  objective: string;
  projectId: string;
  targetProjectIds?: string[];
  defaults: GraphDefaults;
  nodes: GraphNode[];
  edges: GraphEdge[];
  entryNodeIds?: string[];
  createdAt: number;
  updatedAt: number;
  source: 'plan' | 'canvas' | 'manager' | 'yaml' | 'fork' | 'import';
  sourceRef?: string;
}

// ── Runtime types (GraphRun — not part of static IR) ──────────────

export interface NodeRun {
  nodeId: string;
  status: 'pending' | 'ready' | 'running' | 'blocked' | 'done' | 'failed' | 'skipped';
  attempt: number;
  missionIds: string[];
  startedAt?: number;
  completedAt?: number;
  costUsd?: number;
  errorMessage?: string;
  outputRef?: string;
  /** Structured/parsed output for downstream edge.map (data plane). */
  output?: unknown;
  lastCheckpointId?: string;
  brainNoteIds?: string[];
  /** Phase 6: Node outcome contract — formalized for the trace journal.
   *  'success' = node completed normally; 'failure' = node failed;
   *  'skipped' = node was skipped (cancelled or condition not met);
   *  'contested' = node was a contest and a winner was selected. */
  outcome?: 'success' | 'failure' | 'skipped' | 'contested';
  /** Phase 6: For contest nodes, the mission id of the winning contestant. */
  contestWinnerId?: string;
  /**
   * Dependency-branch inheritance (chained-steps-restart-from-empty-main
   * fix) — the git branch this node's settled mission ended up on
   * (`Mission.worktree`, which is always the branch name, never a path —
   * see runtime.ts's `branch` local). Set by runGraph.ts the moment a
   * task/contest node reaches `status: 'done'` (contest: the WINNING
   * contestant's branch), and for a 'done' loop node (the LAST successful
   * iteration's branch). A downstream node with this node as a `dependsOn`
   * predecessor and no explicit `contract.baseBranch` of its own reads this
   * field to start its own worktree FROM here, instead of the repo default
   * — see `resolveInheritedBranches` in runGraph.ts. Absent for node kinds
   * that never launch a mission (join/router/interrupt/form/subgraph) —
   * `resolveInheritedBranches` walks THROUGH a join predecessor to its own
   * members rather than treating the join itself as a branch producer.
   */
  resultBranch?: string;
}

export interface GraphRun {
  runId: string;
  graphId: string;
  graphVersion: 1;
  status: 'pending' | 'running' | 'paused' | 'interrupted' | 'failed' | 'done' | 'cancelled';
  nodeRuns: Record<string, NodeRun>;
  /** Node id → last settled structured output (data plane). */
  nodeOutputs?: Record<string, unknown>;
  budget: { spentUsd: number; limitUsd?: number };
  replanCount: number;
  checkpoints: string[];
  createdAt: number;
  updatedAt: number;
  brainTraceId?: string;
  /** Orchestrator / plan id when compiled from a plan. */
  sourcePlanId?: string;
}

// ── Brain recall bundle ───────────────────────────────────────────

export interface BrainRecallBundle {
  contextBlock: string;
  hitIds: string[];
  citations: Array<{ id: string; title: string; snippet?: string }>;
}

// ── Replan patch ──────────────────────────────────────────────────

export interface GraphPatch {
  updateNodes?: Array<{ id: string; description?: string; contract?: Partial<StepContract> }>;
  addNodes?: GraphNode[];
  removeNodeIds?: string[];
  addEdges?: GraphEdge[];
  removeEdgeIds?: string[];
  skipNodeIds?: string[];
  reason: string;
}

// ── Checkpoint ────────────────────────────────────────────────────

export interface Checkpoint {
  id: string;
  runId: string;
  nodeId?: string;
  missionId?: string;
  engine: 'managed' | 'native' | 'graph';
  stateRef: string;
  summary: {
    stepIndex?: number;
    turn?: number;
    label?: string;
  };
  createdAt: number;
  parentCheckpointId?: string;
}

// ── Contest ranking entry ─────────────────────────────────────────

export interface ContestRankingEntry {
  missionId: string;
  rank: number;
  score?: number;
  notes?: string;
}
