/* graph/brainBus.ts — Brain bus for the Single Graph Runtime.

   recallForStep: query the Brain before launching a node, return a context
   block to inject into the mission task.

   noteAfterStep: write a Brain note after a node reaches a terminal state.

   noteReplan: write a Brain note when the replan engine patches the graph.

   All fire-and-forget: never blocks execution, never throws.
*/

import { getPlatform } from '../../platform/index.js';
import type { BrainSearchResult } from '../../platform/types.js';
import type { GraphNode, NodeRun, BrainRecallBundle, GraphPatch, ContestRankingEntry } from './types.js';
import type { CaptureEvent } from '../../platform/types.js';

// ── Local dispatch (fire-and-forget, never throws) ────────────────

function dispatch(event: CaptureEvent): void {
  const platform = getPlatform();
  if (!platform?.brain?.capture) {
    console.warn('[brainBus] no brain capture platform available');
    return;
  }
  platform.brain
    .capture(event)
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[brainBus] capture failed:', event.title, msg);
    });
}

// ── recallForStep ─────────────────────────────────────────────────

export async function recallForStep(args: {
  projectRoot: string;
  graphId: string;
  runId: string;
  node: GraphNode;
}): Promise<BrainRecallBundle> {
  const { node } = args;
  const policy = node.brain;

  if (!policy.recall) {
    return emptyBundle();
  }

  const query = policy.recallQuery ?? descriptionOf(node);
  const limit = policy.recallLimit ?? 5;

  try {
    const platform = getPlatform();
    if (!platform?.brain?.search) return emptyBundle();

    const results: BrainSearchResult[] = await platform.brain.search(query, limit);
    if (results.length === 0) return emptyBundle();

    const contextBlock = formatRecallBlock(results);
    return {
      contextBlock,
      hitIds: results.map((r) => r.id),
      citations: results.map((r) => ({ id: r.id, title: r.title, snippet: r.snippet })),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[brainBus] recallForStep failed:', msg);
    return emptyBundle();
  }
}

// ── noteAfterStep ─────────────────────────────────────────────────

export function noteAfterStep(args: {
  projectRoot: string;
  graphId: string;
  runId: string;
  node: GraphNode;
  nodeRun: NodeRun;
  outcome: 'success' | 'failure' | 'skipped';
  errorMessage?: string;
  missionIds: string[];
}): void {
  const { node, nodeRun, outcome, errorMessage, missionIds, projectRoot } = args;
  const policy = node.brain;

  if (outcome === 'success' && !policy.noteOnSuccess) return;
  if (outcome === 'failure' && !policy.noteOnFailure) return;
  if (outcome === 'skipped') return;

  // H: Eval-gated retention — score the note's learning value before capturing.
  // Failure notes with high attempt counts or replan traces have higher value.
  // Success notes with low cost are deprioritized (routine successes don't teach).
  // Notes below the retention threshold (0.3) are still captured but tagged
  // 'low-value' so downstream brain cleanup can prune them.
  let retentionScore = 0.5;
  if (outcome === 'failure') {
    retentionScore = Math.min(0.9, 0.4 + nodeRun.attempt * 0.15);
  } else if (outcome === 'success') {
    retentionScore = nodeRun.costUsd !== undefined && nodeRun.costUsd > 0.01 ? 0.6 : 0.3;
  }
  const isLowValue = retentionScore < 0.3;

  const kind = outcome === 'success' ? 'outcome.success' : 'outcome.failure';
  const label = node.label ?? node.id;
  const desc = descriptionOf(node);

  const lines = [
    `Graph node: ${label} (${node.id})`,
    `Description: ${desc}`,
    `Outcome: ${outcome}`,
    `Attempt: ${nodeRun.attempt}`,
    `Missions: ${missionIds.join(', ') || 'none'}`,
    nodeRun.costUsd !== undefined ? `Cost: $${nodeRun.costUsd.toFixed(4)}` : '',
    errorMessage ? `Error: ${errorMessage.slice(0, 500)}` : '',
    `RetentionScore: ${retentionScore.toFixed(2)}`,
  ].filter(Boolean);

  const tags = [
    kind,
    'graph-node',
    `node:${node.id}`,
    `graph:${args.graphId}`,
    `run:${args.runId}`,
    ...(isLowValue ? ['low-value'] : []),
    ...(policy.tags ?? []),
  ];

  const event: CaptureEvent = {
    kind: 'agent',
    title: `Graph ${outcome}: ${label}`,
    text: lines.join('\n'),
    tags,
    source: 'lazy-ide:graph-runtime',
    space: 'code',
    cwd: projectRoot,
  };

  dispatch(event);
}

// ── noteReplan ────────────────────────────────────────────────────

export function noteReplan(args: {
  projectRoot: string;
  graphId: string;
  runId: string;
  patch: GraphPatch;
  reason: string;
}): void {
  const { patch, reason, projectRoot, graphId, runId } = args;

  const lines = [
    `Replan reason: ${reason}`,
    `Graph: ${graphId}`,
    `Run: ${runId}`,
    patch.updateNodes?.length ? `Updated nodes: ${patch.updateNodes.map((n) => n.id).join(', ')}` : '',
    patch.addNodes?.length ? `Added nodes: ${patch.addNodes.map((n) => n.id).join(', ')}` : '',
    patch.removeNodeIds?.length ? `Removed nodes: ${patch.removeNodeIds.join(', ')}` : '',
    patch.addEdges?.length ? `Added edges: ${patch.addEdges.map((e) => e.id).join(', ')}` : '',
    patch.removeEdgeIds?.length ? `Removed edges: ${patch.removeEdgeIds.join(', ')}` : '',
    patch.skipNodeIds?.length ? `Skipped nodes: ${patch.skipNodeIds.join(', ')}` : '',
  ].filter(Boolean);

  const event: CaptureEvent = {
    kind: 'learning',
    title: `Replan: ${reason.slice(0, 80)}`,
    text: lines.join('\n'),
    tags: ['graph-replan', `graph:${graphId}`, `run:${runId}`, 'orchestrator'],
    source: 'lazy-ide:graph-runtime',
    space: 'code',
    cwd: projectRoot,
  };

  dispatch(event);
}

// ── noteFork ──────────────────────────────────────────────────────

export function noteFork(args: {
  projectRoot: string;
  parentCheckpointId: string;
  newRunId: string;
}): void {
  const { parentCheckpointId, newRunId, projectRoot } = args;

  const event: CaptureEvent = {
    kind: 'decision',
    title: `Fork from checkpoint: ${parentCheckpointId}`,
    text: [`Parent checkpoint: ${parentCheckpointId}`, `New run: ${newRunId}`].join('\n'),
    tags: ['graph-fork', `checkpoint:${parentCheckpointId}`, `run:${newRunId}`, 'orchestrator'],
    source: 'lazy-ide:graph-runtime',
    space: 'code',
    cwd: projectRoot,
  };

  dispatch(event);
}

// ── noteContestRanking ────────────────────────────────────────────

export function noteContestRanking(args: {
  projectRoot: string;
  graphId: string;
  runId: string;
  nodeId: string;
  ranking: ContestRankingEntry[];
}): void {
  const { ranking, nodeId, projectRoot, graphId, runId } = args;

  const lines = ranking.map(
    (r) => `#${r.rank}: ${r.missionId} (score: ${r.score ?? 'N/A'})${r.notes ? ` — ${r.notes}` : ''}`,
  );

  const event: CaptureEvent = {
    kind: 'learning',
    title: `Contest ranking: node ${nodeId}`,
    text: [`Graph: ${graphId}`, `Run: ${runId}`, `Node: ${nodeId}`, '', ...lines].join('\n'),
    tags: ['graph-contest', `node:${nodeId}`, `graph:${graphId}`, 'orchestrator'],
    source: 'lazy-ide:graph-runtime',
    space: 'code',
    cwd: projectRoot,
  };

  dispatch(event);
}

// ── Helpers ───────────────────────────────────────────────────────

function emptyBundle(): BrainRecallBundle {
  return { contextBlock: '', hitIds: [], citations: [] };
}

function descriptionOf(node: GraphNode): string {
  if (node.kind === 'task' || node.kind === 'contest') return node.description;
  if (node.kind === 'form') return node.prompt;
  if (node.kind === 'interrupt') return node.reason;
  if (node.kind === 'router') return `Router with ${node.branches.length} branches`;
  if (node.kind === 'join') return `Join (${node.mode})`;
  if (node.kind === 'loop') return `Loop (body: ${node.bodyEntryId})`;
  if (node.kind === 'subgraph') return 'Subgraph';
  return (node as { label?: string; id: string }).label ?? (node as { id: string }).id;
}

/** Header marking the start of the auto-appended "brain recall" block in a
 *  node's task text (see buildTaskForNode in runGraph.ts). Exported so
 *  missionScopeGuard.ts can strip this block before scanning task text for
 *  a path: recalled note snippets are truncated to 200 chars (see below)
 *  and can end mid-path (e.g. "...cerveau\lazy-backo"), which the guard's
 *  path regex would otherwise treat as a real, distinct target path and
 *  wrongly refuse a mission whose real task is entirely in-scope. */
export const BRAIN_RECALL_HEADER = '## Brain recall (automatic)';

function formatRecallBlock(results: BrainSearchResult[]): string {
  const lines = results.map((r) => {
    const parts = [`- [${r.cluster ?? 'general'}] ${r.title}`];
    if (r.snippet) parts.push(`  ${r.snippet.slice(0, 200)}`);
    return parts.join('\n');
  });

  return [BRAIN_RECALL_HEADER, ...lines, 'Use these only if relevant; prefer repo truth over memory.'].join('\n');
}
