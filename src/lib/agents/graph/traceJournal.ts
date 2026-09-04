/* traceJournal.ts — Phase 6: Append-only node transition trace journal.
 *
 * Persists per-node outcomes to `<projectRoot>/.lazy/run-traces.jsonl` —
 * one JSON object per line, each representing a single node's transition
 * to a terminal state (done, failed, skipped, contested).
 *
 * This is the "substrat de traces" that Phases 8-10 learners analyze:
 *   - routingLearner: task shape → agent/model → outcome
 *   - topologyLearner: graph topology → success rate
 *   - promptLearner: prompt → quality
 *   - macroSynthesizer: recurring subgraph patterns
 *
 * Every `graph.node_finished` event writes a trace entry. The journal is
 * append-only — entries are never mutated or deleted. Readers parse line-
 * by-line and filter as needed.
 */

import type { GraphRun, NodeRun, GraphNode } from './types.js';

// ── Types ──────────────────────────────────────────────────────────

/** A single trace journal entry — one per node terminal transition. */
export interface TraceEntry {
  /** Timestamp of the node's completion (ms epoch). */
  ts: number;
  /** The run this entry belongs to. */
  runId: string;
  /** The graph IR id (static topology hash). */
  graphId: string;
  /** The orchestrator plan id, if compiled from a plan. */
  sourcePlanId?: string;
  /** The node id within the graph. */
  nodeId: string;
  /** The node kind (task, contest, interrupt, etc.). */
  nodeKind: GraphNode['kind'];
  /** The node's label/task description. */
  nodeLabel: string;
  /** The node's terminal status. */
  status: NodeRun['status'];
  /** The node's outcome classification. */
  outcome: NodeRun['outcome'];
  /** The attempt number (1-based). */
  attempt: number;
  /** Mission ids launched by this node. */
  missionIds: string[];
  /** For contest nodes, the winning mission id. */
  contestWinnerId?: string;
  /** Cost in USD for this node's execution. */
  costUsd?: number;
  /** Duration in milliseconds. */
  durationMs?: number;
  /** Error message if the node failed. */
  errorMessage?: string;
  /** Replan reason if the node was replanned. */
  replanReason?: string;
  /** The step contract (agent, model, effort) — from the node's contract. */
  stepContract?: {
    agent?: string;
    model?: string;
    effort?: string;
  };
}

// ── In-memory buffer (for non-Tauri / test environments) ───────────

interface TraceBuffer {
  entries: TraceEntry[];
}

const buffers = new Map<string, TraceBuffer>();

function bufferKey(projectRoot: string): string {
  return projectRoot;
}

function getBuffer(projectRoot: string): TraceBuffer {
  let buf = buffers.get(bufferKey(projectRoot));
  if (!buf) {
    buf = { entries: [] };
    buffers.set(bufferKey(projectRoot), buf);
  }
  return buf;
}

// ── Write ──────────────────────────────────────────────────────────

/** Append a trace entry to the journal. In Tauri environments, writes to
 *  `<projectRoot>/.lazy/run-traces.jsonl`. In non-Tauri (test/browser),
 *  appends to an in-memory buffer. */
export function appendTraceEntry(
  projectRoot: string,
  entry: TraceEntry,
): void {
  const line = JSON.stringify(entry) + '\n';
  const buf = getBuffer(projectRoot);
  buf.entries.push(entry);

  // In Tauri, write to disk. We use a dynamic import to avoid pulling
  // the Tauri API into the test bundle.
  void (async () => {
    try {
      const { isTauri } = await import('../../platform/index.js');
      if (!isTauri()) return;

      const { invoke } = await import('@tauri-apps/api/core');
      // Append to file — the Rust side handles create-if-not-exists.
      await invoke('append_to_file', {
        path: `${projectRoot}/.lazy/run-traces.jsonl`,
        content: line,
      });
    } catch {
      // Non-fatal — trace journal is best-effort. The in-memory buffer
      // still has the entry for test reads.
    }
  })();
}

/** Build a TraceEntry from a completed NodeRun + its GraphNode + the run. */
export function buildTraceEntry(
  run: GraphRun,
  node: GraphNode,
  nr: NodeRun,
  replanReason?: string,
): TraceEntry {
  const durationMs = nr.startedAt && nr.completedAt
    ? nr.completedAt - nr.startedAt
    : undefined;

  const stepContract = node.kind === 'task' && node.contract
    ? {
        agent: node.contract.agentName,
        model: node.contract.model,
        effort: node.contract.effort,
      }
    : undefined;

  return {
    ts: nr.completedAt ?? Date.now(),
    runId: run.runId,
    graphId: run.graphId,
    sourcePlanId: run.sourcePlanId,
    nodeId: node.id,
    nodeKind: node.kind,
    nodeLabel: node.label ?? node.id,
    status: nr.status,
    outcome: nr.outcome ?? (nr.status === 'done' ? 'success' : nr.status === 'failed' ? 'failure' : 'skipped'),
    attempt: nr.attempt,
    missionIds: nr.missionIds,
    contestWinnerId: nr.contestWinnerId,
    costUsd: nr.costUsd,
    durationMs,
    errorMessage: nr.errorMessage,
    replanReason,
    stepContract,
  };
}

// ── Read ───────────────────────────────────────────────────────────

/** Read all trace entries for a project. In Tauri, reads from disk; in
 *  non-Tauri, reads from the in-memory buffer. */
export async function readTraceEntries(
  projectRoot: string,
): Promise<TraceEntry[]> {
  try {
    const { isTauri } = await import('../../platform/index.js');
    if (!isTauri()) {
      return getBuffer(projectRoot).entries;
    }

    const { invoke } = await import('@tauri-apps/api/core');
    const content = await invoke<string>('read_text_file', {
      path: `${projectRoot}/.lazy/run-traces.jsonl`,
    });
    return parseTraceEntries(content);
  } catch {
    // File doesn't exist yet or read failed — return buffer
    return getBuffer(projectRoot).entries;
  }
}

/** Parse a JSONL string into TraceEntry objects. Skips malformed lines. */
export function parseTraceEntries(content: string): TraceEntry[] {
  const entries: TraceEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as TraceEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

// ── Test helpers ───────────────────────────────────────────────────

/** Test-only: clear the in-memory buffer for a project root. */
export function _clearTraceBufferForTests(projectRoot: string): void {
  buffers.delete(bufferKey(projectRoot));
}

/** Test-only: clear all in-memory buffers. */
export function _clearAllTraceBuffersForTests(): void {
  buffers.clear();
}
