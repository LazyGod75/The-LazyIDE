/* graph/__tests__/replanEngineImmutability.test.ts — applyPatch/replan
   immutability acceptance test (immut-applypatch-void-mutation fix).

   Real defect (craft review, 2026-08): replanEngine.ts::applyPatch mutated
   its `ir`/`run` PARAMETERS in place (`node.description = ...`,
   `ir.nodes.push(...)`, `delete run.nodeRuns[id]`) and returned void — the
   caller's own `ir`/`run` objects silently changed underneath it. `replan()`
   (the exported entry point, wired live via
   sgrOrchestratorRunner.ts's `deps.diagnose` → runGraph.ts's P2.5 replan
   branch) relied entirely on that in-place mutation to propagate a patch
   back to its caller, since `ReplanResult` never carried the patched
   `ir`/`run` itself.

   This test asserts the caller's ORIGINAL `ir`/`run` objects are left
   untouched by `replan()`, and the patched values are returned explicitly
   via `result.ir`/`result.run` instead.
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { replan, type ReplanContext } from '../replanEngine';
import { defaultBrainPolicy, defaultGraphDefaults, defaultStepContract } from '../types';
import type { GraphIR, TaskNode } from '../types';
import { initGraphRun } from '../graphIr';

vi.mock('../brainBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../brainBus')>();
  return { ...actual, noteReplan: vi.fn() };
});

function makeIr(): GraphIR {
  const node: TaskNode = {
    id: 'a',
    kind: 'task',
    label: 'a',
    description: 'original description',
    contract: defaultStepContract(),
    brain: defaultBrainPolicy(),
    critical: true,
    maxAttempts: 3,
  };
  return {
    id: 'test-graph',
    version: 1,
    name: 'Test',
    objective: 'test objective',
    projectId: 'p1',
    defaults: defaultGraphDefaults(),
    nodes: [node],
    edges: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: 'plan',
  };
}

describe('replanEngine — applyPatch/replan immutability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leaves the caller\'s original ir/run untouched and returns the patched values via result.ir/result.run', () => {
    const ir = makeIr();
    const run = initGraphRun(ir.id, ir);
    run.nodeRuns['a'] = { nodeId: 'a', status: 'failed', attempt: 1, missionIds: [] };

    const ctx: ReplanContext = {
      graphId: ir.id,
      runId: run.runId,
      projectRoot: '/tmp/test',
      failedNodeId: 'a',
      failedNodeRun: run.nodeRuns['a'],
      diagnosis: {
        category: 'type_error',
        rootCause: 'a type error',
        suggestedFix: 'fix the types',
        confidence: 0.8,
      },
      attempt: 1,
    };

    const result = replan(ir, run, ctx);

    // The strategy chosen for 'type_error' must actually have produced a
    // patch (sanity check the test exercises applyPatch at all).
    expect(result.shouldRetry).toBe(true);
    expect(result.patch).not.toBeNull();

    // Immutability: the CALLER's original objects must be untouched.
    expect(ir.nodes[0]).toMatchObject({ description: 'original description' });
    expect(run.replanCount).toBe(0);
    expect(run.nodeRuns['a'].status).toBe('failed');

    // The patched state is returned explicitly, as NEW objects.
    expect(result.ir).not.toBe(ir);
    expect(result.run).not.toBe(run);
    const patchedNode = result.ir.nodes.find((n) => n.id === 'a');
    expect(patchedNode).toMatchObject({ description: expect.stringContaining('fix the types') });
    expect(result.run.replanCount).toBe(1);
    expect(result.run.nodeRuns['a'].status).toBe('pending');
  });
});
