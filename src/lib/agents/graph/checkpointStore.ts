/* graph/checkpointStore.ts — Serialize and persist managed agent turns
   as checkpoints for the Single Graph Runtime.

   Checkpoints are stored as JSON files under:
     <projectRoot>/.lazy/checkpoints/<runId>/<checkpointId>.json

   Each checkpoint captures the full ReAct conversation state at a turn
   boundary, enabling:
   - Resume: reload state and continue from a checkpoint
   - Fork: branch a new run from a checkpoint
   - Time-travel: scrub through turn history (read-only)

   The store uses a claim-check pattern: large outputs (tool results,
   file diffs) are stored as separate blob files and referenced by path,
   keeping the checkpoint JSON small.
*/

import { getPlatform } from '../../platform/index.js';
import type { Checkpoint } from './types.js';

// ── Path helpers ──────────────────────────────────────────────────

function checkpointsDir(projectRoot: string, runId: string): string {
  return `${projectRoot}/.lazy/checkpoints/${runId}`;
}

function checkpointPath(projectRoot: string, runId: string, checkpointId: string): string {
  return `${checkpointsDir(projectRoot, runId)}/${checkpointId}.json`;
}

function blobsDir(projectRoot: string, runId: string, checkpointId: string): string {
  return `${projectRoot}/.lazy/checkpoints/${runId}/${checkpointId}_blobs`;
}

function generateCheckpointId(): string {
  return `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Checkpoint data shape ─────────────────────────────────────────

export interface CheckpointData {
  /** The ReAct conversation messages at this turn boundary. */
  messages: CheckpointMessage[];
  /** The turn number (0-indexed). */
  turn: number;
  /** Cumulative cost in USD at this checkpoint. */
  costUsd?: number;
  /** Tool calls made so far. */
  toolCallCount: number;
  /** Any attached proofs at this point. */
  proofCount: number;
  /** Mission status at checkpoint time. */
  missionStatus: string;
  /** Label for this checkpoint (e.g. "After tool: write_file"). */
  label?: string;
}

export interface CheckpointMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** If content is large, it's stored as a blob and referenced here. */
  blobRef?: string;
  toolCallId?: string;
  toolName?: string;
}

// ── Write ─────────────────────────────────────────────────────────

export async function writeCheckpoint(
  projectRoot: string,
  runId: string,
  data: CheckpointData,
  opts?: {
    nodeId?: string;
    missionId?: string;
    engine?: 'managed' | 'native' | 'graph';
    parentCheckpointId?: string;
    label?: string;
  },
): Promise<Checkpoint> {
  const checkpointId = generateCheckpointId();
  const dir = checkpointsDir(projectRoot, runId);
  const blobs = blobsDir(projectRoot, runId, checkpointId);

  // Spill large messages to blob files
  const messages: CheckpointMessage[] = [];
  let blobCount = 0;
  const fs = getPlatform().fs;

  for (const msg of data.messages) {
    if (msg.content.length > 4096) {
      blobCount += 1;
      const blobRef = `${blobs}/msg-${blobCount}.txt`;
      await fs.createDir(blobs);
      await fs.writeFile(blobRef, msg.content);
      messages.push({ ...msg, content: '', blobRef });
    } else {
      messages.push(msg);
    }
  }

  const checkpoint: Checkpoint = {
    id: checkpointId,
    runId,
    nodeId: opts?.nodeId,
    missionId: opts?.missionId,
    engine: opts?.engine ?? 'managed',
    stateRef: `${checkpointId}.json`,
    summary: {
      turn: data.turn,
      label: opts?.label ?? data.label,
    },
    createdAt: Date.now(),
    parentCheckpointId: opts?.parentCheckpointId,
  };

  // Write checkpoint JSON
  await fs.createDir(dir);
  await fs.writeFile(
    checkpointPath(projectRoot, runId, checkpointId),
    JSON.stringify({ checkpoint, data: { ...data, messages } }, null, 2),
  );

  return checkpoint;
}

// ── Read ──────────────────────────────────────────────────────────

export async function readCheckpoint(
  projectRoot: string,
  runId: string,
  checkpointId: string,
): Promise<{ checkpoint: Checkpoint; data: CheckpointData }> {
  const raw = await getPlatform().fs.readFile(checkpointPath(projectRoot, runId, checkpointId));
  const parsed = JSON.parse(raw) as { checkpoint: Checkpoint; data: CheckpointData };

  // Hydrate blob refs back to content
  const hydratedMessages: CheckpointMessage[] = [];
  for (const msg of parsed.data.messages) {
    if (msg.blobRef) {
      try {
        const content = await getPlatform().fs.readFile(msg.blobRef);
        hydratedMessages.push({ ...msg, content, blobRef: undefined });
      } catch {
        // Blob missing — use placeholder
        hydratedMessages.push({ ...msg, content: '[blob unavailable]' });
      }
    } else {
      hydratedMessages.push(msg);
    }
  }

  return {
    checkpoint: parsed.checkpoint,
    data: { ...parsed.data, messages: hydratedMessages },
  };
}

// ── List ──────────────────────────────────────────────────────────

export async function listCheckpoints(
  projectRoot: string,
  runId: string,
): Promise<Checkpoint[]> {
  const dir = checkpointsDir(projectRoot, runId);
  try {
    const entries = await getPlatform().fs.readDir(dir);
    const checkpoints: Checkpoint[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      try {
        const raw = await getPlatform().fs.readFile(`${dir}/${entry.name}`);
        const parsed = JSON.parse(raw) as { checkpoint: Checkpoint };
        checkpoints.push(parsed.checkpoint);
      } catch {
        // Skip corrupt files
      }
    }
    return checkpoints.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

// ── Delete ────────────────────────────────────────────────────────

export async function deleteCheckpoint(
  projectRoot: string,
  runId: string,
  checkpointId: string,
): Promise<void> {
  const cpPath = checkpointPath(projectRoot, runId, checkpointId);
  const blobPath = blobsDir(projectRoot, runId, checkpointId);

  try {
    await getPlatform().fs.remove(cpPath);
  } catch {
    // Already gone
  }

  // Clean up blobs
  try {
    const blobs = await getPlatform().fs.readDir(blobPath);
    for (const blob of blobs) {
      await getPlatform().fs.remove(`${blobPath}/${blob.name}`);
    }
  } catch {
    // No blobs or already gone
  }
}

// ── Latest checkpoint ─────────────────────────────────────────────

export async function getLatestCheckpoint(
  projectRoot: string,
  runId: string,
): Promise<Checkpoint | null> {
  const checkpoints = await listCheckpoints(projectRoot, runId);
  if (checkpoints.length === 0) return null;
  return checkpoints[checkpoints.length - 1];
}

// ── Checkpoint lineage ────────────────────────────────────────────

export async function getCheckpointLineage(
  projectRoot: string,
  runId: string,
  checkpointId: string,
): Promise<Checkpoint[]> {
  const all = await listCheckpoints(projectRoot, runId);
  const lineage: Checkpoint[] = [];
  let current: Checkpoint | undefined = all.find((c) => c.id === checkpointId);
  while (current) {
    lineage.unshift(current);
    current = all.find((c) => c.id === current!.parentCheckpointId);
  }
  return lineage;
}

// ── Resume ────────────────────────────────────────────────────────

/** Load checkpoint data and return the conversation messages for resuming.
 *  The caller (planAndActManaged) can use these messages to continue the
 *  ReAct loop from the checkpointed turn instead of starting from scratch.
 */
export async function loadCheckpointForResume(
  projectRoot: string,
  runId: string,
  checkpointId: string,
): Promise<{
  checkpoint: Checkpoint;
  messages: CheckpointMessage[];
  turn: number;
  costUsd?: number;
}> {
  const { checkpoint, data } = await readCheckpoint(projectRoot, runId, checkpointId);
  return {
    checkpoint,
    messages: data.messages,
    turn: data.turn,
    costUsd: data.costUsd,
  };
}
