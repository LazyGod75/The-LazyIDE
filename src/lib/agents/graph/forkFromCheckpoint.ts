/* graph/forkFromCheckpoint.ts — Fork a new graph run from a checkpoint.

   Given a checkpoint from an existing run, creates a NEW run with a copy
   of the graph IR and run state up to that checkpoint, allowing the user
   to explore a different path from that point.

   The original run is never modified — the fork is a true branch.
*/

import type { GraphIR, GraphRun } from './types.js';
import { initGraphRun } from './graphIr.js';
import { readCheckpoint, writeCheckpoint } from './checkpointStore.js';
import { noteFork } from './brainBus.js';

export interface ForkResult {
  newRunId: string;
  newGraphRun: GraphRun;
  forkCheckpointId: string;
}

export async function forkFromCheckpoint(
  projectRoot: string,
  sourceRunId: string,
  checkpointId: string,
  ir: GraphIR,
  opts?: {
    nodeId?: string;
    label?: string;
  },
): Promise<ForkResult> {
  // Load the source checkpoint
  const { checkpoint, data } = await readCheckpoint(projectRoot, sourceRunId, checkpointId);

  // Create a fresh run for the fork
  const newRun = initGraphRun(`${ir.id}-fork-${Date.now()}`, ir);

  // Copy completed node runs from the source run state
  // (The checkpoint's data contains the conversation state, but the graph
  // run state needs to be reconstructed from checkpoint metadata)
  // We mark nodes as done up to the checkpoint's turn boundary
  if (checkpoint.nodeId) {
    const nr = newRun.nodeRuns[checkpoint.nodeId];
    if (nr) {
      nr.status = 'done';
      nr.completedAt = checkpoint.createdAt;
      nr.costUsd = data.costUsd;
    }
  }

  // Write a fork checkpoint in the new run that references the parent
  const forkCheckpoint = await writeCheckpoint(
    projectRoot,
    newRun.runId,
    data,
    {
      missionId: checkpoint.missionId,
      engine: checkpoint.engine,
      parentCheckpointId: checkpoint.id,
      label: opts?.label ?? `Fork from ${checkpoint.id}`,
    },
  );

  newRun.checkpoints.push(forkCheckpoint.id);
  newRun.updatedAt = Date.now();

  // Write a Brain note about the fork
  noteFork({
    projectRoot,
    parentCheckpointId: checkpoint.id,
    newRunId: newRun.runId,
  });

  return {
    newRunId: newRun.runId,
    newGraphRun: newRun,
    forkCheckpointId: forkCheckpoint.id,
  };
}
