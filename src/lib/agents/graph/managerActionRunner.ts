/* graph/managerActionRunner.ts — P5.5 Manager actions compile to IR runs.

   Wraps the existing compileOrchestratorToIr + runGraph path so manager
   actions (e.g. "execute plan", "run selected steps") can be compiled
   into GraphIR and executed through the Single Graph Runtime.

   This replaces the sequential orchestratorExecutor.ts path for new
   manager-initiated runs, while the legacy executor remains as a
   compat shim for existing callers.
*/

import type { OrchestratorState } from '../types.js';
import type { GraphIR, GraphRun } from './types.js';
import type { GraphExecutorDeps } from './runGraph.js';
import { compileOrchestratorToIr } from './compileOrchestrator.js';
import { runGraph } from './runGraph.js';
import type { SubgraphRegistry } from './nestedSubgraphs.js';

export interface ManagerActionRunResult {
  ir: GraphIR;
  run: GraphRun;
}

/** Compile a manager plan (OrchestratorState) into a GraphIR and execute it. */
export async function runManagerPlanAsGraph(
  orchestrator: OrchestratorState,
  deps: GraphExecutorDeps,
  opts?: { signal?: AbortSignal; subgraphRegistry?: SubgraphRegistry },
): Promise<ManagerActionRunResult> {
  const ir = compileOrchestratorToIr(orchestrator);
  const run = await runGraph(ir, deps, opts);
  return { ir, run };
}

/** Compile a subset of steps from a plan into a GraphIR (for partial runs). */
export async function runManagerStepsAsGraph(
  orchestrator: OrchestratorState,
  stepIds: string[],
  deps: GraphExecutorDeps,
  opts?: { signal?: AbortSignal; subgraphRegistry?: SubgraphRegistry },
): Promise<ManagerActionRunResult> {
  const subsetSteps = orchestrator.steps.filter((s) => stepIds.includes(s.id));
  const subsetDeps = new Set<string>();
  for (const step of subsetSteps) {
    for (const dep of step.dependsOn) {
      subsetDeps.add(dep);
    }
  }
  // Include dependency steps that aren't in the selection
  const allNeeded = new Set([...stepIds, ...subsetDeps]);
  const filteredOrch: OrchestratorState = {
    ...orchestrator,
    steps: orchestrator.steps.filter((s) => allNeeded.has(s.id)),
  };

  const ir = compileOrchestratorToIr(filteredOrch);
  const run = await runGraph(ir, deps, opts);
  return { ir, run };
}
