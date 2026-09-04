/* graph/chainGraphAdapter.ts — P5.3 Gradual adapter: chainEngine → GraphIR runtime.

   This module provides an optional path where the existing canvas chain/draft
   state can be compiled into a GraphIR and executed via runGraph instead of
   chainEngine's direct fire-per-chain logic. It is opt-in and gradual:

   1. The existing chainEngine.ts path remains the default — no behavior change.
   2. This adapter compiles canvasStore state into a GraphIR via canvasToIr.
   3. The resulting IR can be executed by runGraph, which handles wave-based
      parallel execution, replan, contest, and checkpoint/resume.
   4. The adapter maps runGraph events back to the existing mission/journal
      system so the UI and chainEngine remain consistent.

   The adapter is NOT wired into the live path yet — it's a capability
   scaffold for P5.4+ (join/contest/loop IR parity) and P5.5 (manager actions
   compile to IR runs). Tests verify the compile + mock-run roundtrip.
*/

import type { GraphIR, GraphRun } from './types.js';
import type { GraphExecutorDeps } from './runGraph.js';
import { canvasToIr, type CanvasCompileInput } from './canvasToIr.js';
import { runGraph } from './runGraph.js';
import type { SubgraphRegistry } from './nestedSubgraphs.js';
import type { DraftSpec, Chain, RouterSpec, JoinSpec } from '../../../components/agents/canvas/canvasTypes.js';

export interface ChainGraphAdapterResult {
  ir: GraphIR;
  run: GraphRun;
}

/** Compile canvas state + execute as a graph run.
 *
 *  This is the entry point for the gradual adapter: instead of firing chains
 *  one-by-one via chainEngine.attemptFire, compile the entire canvas into a
 *  GraphIR and run it through the wave executor.
 *
 *  The caller provides the same deps that runGraph expects (launchMission,
 *  brain recall/note, emit, budget).
 */
export async function runCanvasAsGraph(
  input: CanvasCompileInput,
  deps: GraphExecutorDeps,
  opts?: { signal?: AbortSignal; subgraphRegistry?: SubgraphRegistry },
): Promise<ChainGraphAdapterResult> {
  const ir = canvasToIr(input);
  const run = await runGraph(ir, deps, opts);
  return { ir, run };
}

/** Compile canvas state into a GraphIR without executing.
 *
 *  Useful for dry-run previews, validation, and the canvas IR view (P5.6).
 */
export function compileCanvasToIr(
  drafts: DraftSpec[],
  chains: Chain[],
  routers: RouterSpec[],
  joins: JoinSpec[],
  projectId?: string,
): GraphIR {
  return canvasToIr({ drafts, chains, routers, joins, projectId });
}
