/**
 * canvasPerf.test.ts — W5b deliverable #5a: reconciler perf at fleet scale.
 * A synthetic fixture (8 projects / 150 mission nodes / 30 chains, roughly
 * the "target 150+ nodes fluid" bar from spec §5's Performance section)
 * exercises `reconcile()` directly — no React/JSDOM needed, this is a pure
 * function per reconciler.ts's own module header.
 *
 * Two properties are asserted:
 *   (1) reconcile() stays well under a generous CI-safe wall-clock bound
 *       over repeated calls (never a tight local-machine budget — CI
 *       runners are slower and noisier than a dev box);
 *   (2) a SECOND reconcile() over identical inputs (same `prevNodes`
 *       roundtrip a caller like useCanvasFlowGraph.ts always does) returns
 *       referentially-EQUAL `node.data` for every unchanged node — the
 *       stability reconciler.ts's `stableData`/`dataUnchanged` helpers
 *       promise (W1a), now asserted at 150-node scale rather than the
 *       handful of nodes reconciler.test.ts's own fixtures use.
 */

import { describe, it, expect } from 'vitest';
import { reconcile, type CanvasReactFlowNode, type ReconcileInputs } from '../components/agents/canvas/reconciler';
import { DEFAULT_CANVAS_PREFS, makeRef, type Chain, type DraftSpec } from '../components/agents/canvas/canvasTypes';
import type { FleetMission, FleetProject } from '../lib/agents/fleetMissions';
import type { FleetStage } from '../lib/agents/fleetStage';

const PROJECT_COUNT = 8;
const TOTAL_MISSIONS = 150;
const CHAIN_COUNT = 30;
const STAGES: readonly FleetStage[] = ['plan', 'code', 'test', 'review', 'merged'];
const STATUSES: readonly FleetMission['status'][] = ['queued', 'running', 'review', 'done', 'failed'];

function buildMission(index: number): FleetMission {
  return {
    id: `mission-${index}`,
    title: `Mission ${index}`,
    status: STATUSES[index % STATUSES.length]!,
    stage: STAGES[index % STAGES.length]!,
    model: 'sonnet',
    progress: index % 100,
    updatedMs: 1_000_000 + index,
    urgent: index % 11 === 0,
  };
}

/** 8 projects, 150 missions distributed round-robin (~18-19 per project —
 *  never a suspiciously round "exactly 18.75", deliberately uneven like a
 *  real fleet). */
function buildProjects(): FleetProject[] {
  const projects: FleetProject[] = Array.from({ length: PROJECT_COUNT }, (_, i) => ({
    projectId: `proj-${i}`,
    root: `/fixtures/proj-${i}`,
    name: `Project ${i}`,
    missions: [],
  }));
  for (let i = 0; i < TOTAL_MISSIONS; i += 1) {
    projects[i % PROJECT_COUNT]!.missions.push(buildMission(i));
  }
  return projects;
}

/** 30 chains, each linking two missions in the SAME project (so every
 *  source/target ref actually resolves to a rendered node — reconciler.ts
 *  only marks a chain `tombstone` otherwise, which this fixture deliberately
 *  avoids so the perf pass exercises the real (non-tombstoned) edge-build
 *  path). */
function buildChains(projects: readonly FleetProject[]): Chain[] {
  const chains: Chain[] = [];
  for (let i = 0; i < CHAIN_COUNT; i += 1) {
    const project = projects[i % projects.length]!;
    const missions = project.missions;
    const source = missions[i % missions.length]!;
    const target = missions[(i + 1) % missions.length]!;
    if (source.id === target.id) continue;
    chains.push({
      id: `chain-${i}`,
      sourceRef: makeRef('mission', source.id),
      targetRef: makeRef('mission', target.id),
      condition: 'success',
      createdBy: 'user',
    });
  }
  return chains;
}

function buildInputs(prevNodes: readonly CanvasReactFlowNode[] = []): ReconcileInputs {
  const projects = buildProjects();
  const drafts: DraftSpec[] = [];
  return {
    projects,
    drafts,
    chains: buildChains(projects),
    notes: [],
    scheduled: [],
    positions: {},
    collapsed: {},
    prefs: DEFAULT_CANVAS_PREFS,
    prevNodes,
    nowMs: 2_000_000,
  };
}

describe('reconcile — perf at fleet scale (8 projects / 150 missions / 30 chains)', () => {
  it('produces the expected node/edge counts', () => {
    const { nodes, edges } = reconcile(buildInputs());
    const missionNodes = nodes.filter((n) => n.type === 'mission');
    const projectNodes = nodes.filter((n) => n.type === 'project');
    expect(projectNodes).toHaveLength(PROJECT_COUNT);
    expect(missionNodes).toHaveLength(TOTAL_MISSIONS);
    expect(edges.filter((e) => e.type === 'chain').length).toBeGreaterThan(0);
  });

  it('completes in well under 50ms per call, averaged over 10 iterations (generous CI bound)', () => {
    const inputs = buildInputs();
    // Warm up once (JIT/module init) before timing, same convention as
    // every other perf-sensitive test in this repo (never time cold start).
    reconcile(inputs);

    const ITERATIONS = 10;
    const started = performance.now();
    for (let i = 0; i < ITERATIONS; i += 1) {
      reconcile(inputs);
    }
    const elapsedMs = performance.now() - started;
    const perCallMs = elapsedMs / ITERATIONS;

    expect(perCallMs).toBeLessThan(50);
  });

  it('returns referentially-equal node.data for every unchanged node across two calls with the same prevNodes roundtrip', () => {
    const firstInputs = buildInputs();
    const first = reconcile(firstInputs);

    // Exactly the roundtrip useCanvasFlowGraph.ts performs every poll:
    // feed the previous call's OWN output nodes back in as `prevNodes`,
    // with otherwise byte-identical inputs.
    const second = reconcile(buildInputs(first.nodes));

    expect(second.nodes).toHaveLength(first.nodes.length);
    const firstById = new Map(first.nodes.map((n) => [n.id, n] as const));
    let comparedCount = 0;
    for (const node of second.nodes) {
      const prev = firstById.get(node.id);
      expect(prev).toBeDefined();
      expect(node.data).toBe(prev!.data); // referential equality, not deep-equal
      comparedCount += 1;
    }
    expect(comparedCount).toBe(TOTAL_MISSIONS + PROJECT_COUNT);
  });
});
