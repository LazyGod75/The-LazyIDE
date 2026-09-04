/**
 * canvasSubtreeFold.test.ts — W8a deliverable #2: orchestrator subtree fold
 * (reconciler hidden-children filtering, chain-edge rerouting onto the
 * orchestrator, sub-mission badge aggregates) + loop expand-in-place
 * (iteration mini nodes) + persistence roundtrip of the new optional
 * canvasStore fields (foldedOrchestrators/expandedLoops read from a
 * V1-compatible layout object carrying them additively).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  reconcile,
  ITERATION_NODE_HEIGHT,
  type CanvasReactFlowNode,
  type MissionLoopMeta,
  type ReconcileInputs,
} from '../components/agents/canvas/reconciler';
import {
  DEFAULT_CANVAS_PREFS,
  makeRef,
  type CanvasLayoutFileV1,
  type Chain,
  type IterationNodeData,
  type MissionNodeData,
} from '../components/agents/canvas/canvasTypes';
import { isCanvasLayoutFileV1 } from '../components/agents/canvas/canvasPersistence';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { FULL_CARD_MAX_HEIGHT } from '../components/agents/canvas/geometry';
import type { FleetMission, FleetProject } from '../lib/agents/fleetMissions';

// ── Fixtures (same conventions as reconciler.test.ts) ─────────────────

function mission(overrides: Partial<FleetMission> & { id: string; title: string }): FleetMission {
  return { status: 'running', stage: 'code', model: 'sonnet', updatedMs: 1000, urgent: false, ...overrides };
}

function project(overrides: Partial<FleetProject> & { projectId: string }): FleetProject {
  return { root: `/repo/${overrides.projectId}`, name: overrides.projectId, missions: [], ...overrides };
}

function baseInputs(overrides: Partial<ReconcileInputs> = {}): ReconcileInputs {
  return {
    projects: [],
    drafts: [],
    chains: [],
    notes: [],
    scheduled: [],
    positions: {},
    collapsed: {},
    prefs: DEFAULT_CANVAS_PREFS,
    nowMs: 10_000,
    ...overrides,
  };
}

function findNode(nodes: readonly CanvasReactFlowNode[], id: string): CanvasReactFlowNode {
  const found = nodes.find((n) => n.id === id);
  if (!found) throw new Error(`node ${id} not found among [${nodes.map((n) => n.id).join(', ')}]`);
  return found;
}

/** Orchestrator `orch` with two direct sub-missions (one failed) and a
 *  grandchild under sub1 — the standard fixture for the fold tests. */
function orchestratorFixture() {
  const projects = [
    project({
      projectId: 'p1',
      missions: [
        mission({ id: 'orch', title: 'Orchestrator' }),
        mission({ id: 'sub1', title: 'Sub one', status: 'running' }),
        mission({ id: 'sub2', title: 'Sub two', status: 'failed' }),
        mission({ id: 'grand1', title: 'Grandchild' }),
        mission({ id: 'other', title: 'Unrelated' }),
      ],
    }),
  ];
  const missionLoopMeta: ReadonlyMap<string, MissionLoopMeta> = new Map([
    ['sub1', { parentMissionId: 'orch' }],
    ['sub2', { parentMissionId: 'orch' }],
    ['grand1', { parentMissionId: 'sub1' }],
  ]);
  return { projects, missionLoopMeta };
}

// ── Fold filtering ───────────────────────────────────────────────────

describe('reconcile — orchestrator subtree fold (W8a)', () => {
  it('unfolded: sub-missions render as nodes and the orchestrator carries the badge aggregates', () => {
    const { projects, missionLoopMeta } = orchestratorFixture();
    const { nodes } = reconcile(baseInputs({ projects, missionLoopMeta }));

    expect(nodes.find((n) => n.id === makeRef('mission', 'sub1'))).toBeDefined();
    expect(nodes.find((n) => n.id === makeRef('mission', 'sub2'))).toBeDefined();

    const orch = findNode(nodes, makeRef('mission', 'orch'));
    const data = orch.data as MissionNodeData;
    expect(data.subMissionCount).toBe(2); // DIRECT children only
    expect(data.worstSubMissionStatus).toBe('failed'); // sub2 beats sub1's running
  });

  it('a non-orchestrator mission carries no sub-mission aggregate fields', () => {
    const { projects, missionLoopMeta } = orchestratorFixture();
    const { nodes } = reconcile(baseInputs({ projects, missionLoopMeta }));
    const other = findNode(nodes, makeRef('mission', 'other'));
    const data = other.data as MissionNodeData;
    expect(data.subMissionCount).toBeUndefined();
    expect(data.worstSubMissionStatus).toBeUndefined();
  });

  it('folded: the whole subtree (children AND grandchildren) is hidden, the orchestrator stays', () => {
    const { projects, missionLoopMeta } = orchestratorFixture();
    const { nodes } = reconcile(
      baseInputs({ projects, missionLoopMeta, foldedOrchestrators: new Set(['orch']) }),
    );

    expect(nodes.find((n) => n.id === makeRef('mission', 'sub1'))).toBeUndefined();
    expect(nodes.find((n) => n.id === makeRef('mission', 'sub2'))).toBeUndefined();
    expect(nodes.find((n) => n.id === makeRef('mission', 'grand1'))).toBeUndefined();
    expect(nodes.find((n) => n.id === makeRef('mission', 'orch'))).toBeDefined();
    expect(nodes.find((n) => n.id === makeRef('mission', 'other'))).toBeDefined();
  });

  it('folded: hierarchy edges into the hidden subtree disappear', () => {
    const { projects, missionLoopMeta } = orchestratorFixture();
    const { edges } = reconcile(
      baseInputs({ projects, missionLoopMeta, foldedOrchestrators: new Set(['orch']) }),
    );
    expect(edges.filter((e) => e.type === 'hierarchy')).toHaveLength(0);
  });

  it('folded: a chain edge whose endpoint is a hidden sub-mission is rerouted onto the orchestrator', () => {
    const { projects, missionLoopMeta } = orchestratorFixture();
    const chains: Chain[] = [
      { id: 'c1', sourceRef: makeRef('mission', 'sub2'), targetRef: makeRef('mission', 'other'), condition: 'success', createdBy: 'user' },
      { id: 'c2', sourceRef: makeRef('mission', 'other'), targetRef: makeRef('mission', 'grand1'), condition: 'always', createdBy: 'user' },
    ];
    const { edges } = reconcile(
      baseInputs({ projects, missionLoopMeta, chains, foldedOrchestrators: new Set(['orch']) }),
    );

    const c1 = edges.find((e) => e.id === 'c1')!;
    expect(c1.source).toBe(makeRef('mission', 'orch')); // rerouted, not tombstoned
    expect(c1.target).toBe(makeRef('mission', 'other'));
    expect((c1.data as { tombstone?: boolean }).tombstone).toBe(false);

    // grand1 is hidden two levels deep — still rerouted onto the nearest
    // VISIBLE ancestor, which is the folded orchestrator itself.
    const c2 = edges.find((e) => e.id === 'c2')!;
    expect(c2.target).toBe(makeRef('mission', 'orch'));
  });

  it('folded: a chain fully internal to the folded subtree is dropped for the render pass (no self-loop)', () => {
    const { projects, missionLoopMeta } = orchestratorFixture();
    const chains: Chain[] = [
      { id: 'internal', sourceRef: makeRef('mission', 'sub1'), targetRef: makeRef('mission', 'sub2'), condition: 'success', createdBy: 'user' },
    ];
    const { edges } = reconcile(
      baseInputs({ projects, missionLoopMeta, chains, foldedOrchestrators: new Set(['orch']) }),
    );
    expect(edges.find((e) => e.id === 'internal')).toBeUndefined();
  });

  it('unfolding restores identical output to a never-folded reconcile', () => {
    const { projects, missionLoopMeta } = orchestratorFixture();
    const never = reconcile(baseInputs({ projects, missionLoopMeta }));
    const unfolded = reconcile(baseInputs({ projects, missionLoopMeta, foldedOrchestrators: new Set() }));
    expect(unfolded.nodes.map((n) => n.id).sort()).toEqual(never.nodes.map((n) => n.id).sort());
    expect(unfolded.edges.map((e) => e.id).sort()).toEqual(never.edges.map((e) => e.id).sort());
  });
});

// ── Loop expand-in-place ─────────────────────────────────────────────

describe('reconcile — loop expand-in-place (W8a)', () => {
  function loopFixture() {
    const projects = [
      project({
        projectId: 'p1',
        missions: [
          mission({ id: 'loop1', title: 'Watcher loop' }),
          mission({ id: 'it1', title: 'Iter one', status: 'done' }),
          mission({ id: 'it2', title: 'Iter two', status: 'failed' }),
        ],
      }),
    ];
    const missionLoopMeta: ReadonlyMap<string, MissionLoopMeta> = new Map([
      ['loop1', { loopConfig: { cadence: '5m', stopCondition: { kind: 'manual' }, enabled: true, iterationCount: 7, iterationMissionIds: [] } }],
      ['it1', { loopParentId: 'loop1', loopIteration: 6 }],
      ['it2', { loopParentId: 'loop1', loopIteration: 7 }],
    ]);
    return { projects, missionLoopMeta };
  }

  it('collapsed by default: no iteration nodes are emitted', () => {
    const { projects, missionLoopMeta } = loopFixture();
    const { nodes } = reconcile(baseInputs({ projects, missionLoopMeta }));
    expect(nodes.filter((n) => n.type === 'iteration')).toHaveLength(0);
  });

  it('expanded: recent iterations become read-only mini nodes stacked under the loop, with hierarchy edges', () => {
    const { projects, missionLoopMeta } = loopFixture();
    const { nodes, edges } = reconcile(
      baseInputs({ projects, missionLoopMeta, expandedLoops: new Set(['loop1']) }),
    );

    const loopNode = findNode(nodes, makeRef('loop', 'loop1'));
    const iterations = nodes.filter((n) => n.type === 'iteration');
    expect(iterations).toHaveLength(2);

    // Most recent first (loopIteration desc — same order as the chips).
    const first = findNode(nodes, makeRef('iteration', 'it2'));
    const firstData = first.data as IterationNodeData;
    expect(firstData.title).toBe('Iter two');
    expect(firstData.status).toBe('failed');
    expect(firstData.loopMissionId).toBe('loop1');
    expect(first.draggable).toBe(false);

    // Laid out UNDER the loop card, stacked.
    expect(first.position.y).toBe(loopNode.position.y + FULL_CARD_MAX_HEIGHT + 8);
    const second = findNode(nodes, makeRef('iteration', 'it1'));
    expect(second.position.y).toBe(first.position.y + ITERATION_NODE_HEIGHT + 8);

    // Quiet hierarchy link loop -> iteration.
    const iterEdges = edges.filter((e) => e.type === 'hierarchy' && e.source === makeRef('loop', 'loop1'));
    expect(iterEdges.map((e) => e.target).sort()).toEqual([makeRef('iteration', 'it1'), makeRef('iteration', 'it2')].sort());
  });
});

// ── Persistence roundtrip (store-level, V1-compatible optional field) ──

describe('canvasStore — fold/expand persistence roundtrip via prefs (W8a)', () => {
  beforeEach(() => {
    _resetCanvasStoreForTests();
  });

  it('hydrate() restores the prefs-resident fold/expand records from a V1-compatible layout file', () => {
    const layout: CanvasLayoutFileV1 = {
      version: 1,
      positions: {},
      collapsed: {},
      prefs: { ...DEFAULT_CANVAS_PREFS, foldedOrchestrators: { orch: true }, expandedLoops: { loop1: true } },
      notes: [],
    };
    // Still a valid V1 file — isCanvasPrefs only checks its declared
    // booleans and tolerates the additive record fields.
    expect(isCanvasLayoutFileV1(layout)).toBe(true);

    canvasStoreVanilla.getState().hydrate(layout, null);
    expect(canvasStoreVanilla.getState().prefs.foldedOrchestrators).toEqual({ orch: true });
    expect(canvasStoreVanilla.getState().prefs.expandedLoops).toEqual({ loop1: true });
  });

  it('hydrate() of a legacy layout (no fold fields) means nothing folded/expanded', () => {
    const legacy: CanvasLayoutFileV1 = {
      version: 1,
      positions: {},
      collapsed: {},
      prefs: { laneMode: false, snap: true, hideMerged: false, minimap: true },
      notes: [],
    };
    canvasStoreVanilla.getState().hydrate(legacy, null);
    expect(canvasStoreVanilla.getState().prefs.foldedOrchestrators).toBeUndefined();
    expect(canvasStoreVanilla.getState().prefs.expandedLoops).toBeUndefined();
    // The reconciler treats both as empty sets — see the fold tests above.
  });

  it('toggle actions flip per-mission flags immutably and roundtrip through the SAME wholesale prefs save/hydrate the autosave path uses', () => {
    const state = canvasStoreVanilla.getState();
    state.toggleFoldOrchestrator('orch');
    state.toggleExpandLoop('loop1');
    expect(canvasStoreVanilla.getState().prefs.foldedOrchestrators?.orch).toBe(true);
    expect(canvasStoreVanilla.getState().prefs.expandedLoops?.loop1).toBe(true);

    canvasStoreVanilla.getState().toggleFoldOrchestrator('orch');
    expect(canvasStoreVanilla.getState().prefs.foldedOrchestrators?.orch).toBe(false);

    // Roundtrip: subscribeCanvasAutosave persists `state.prefs` wholesale
    // into CanvasLayoutFileV1.prefs — simulate exactly that shape.
    const saved: CanvasLayoutFileV1 = {
      version: 1,
      positions: {},
      collapsed: {},
      prefs: canvasStoreVanilla.getState().prefs,
      notes: [],
    };
    expect(isCanvasLayoutFileV1(saved)).toBe(true);
    _resetCanvasStoreForTests();
    canvasStoreVanilla.getState().hydrate(saved, null);
    expect(canvasStoreVanilla.getState().prefs.foldedOrchestrators).toEqual({ orch: false });
    expect(canvasStoreVanilla.getState().prefs.expandedLoops).toEqual({ loop1: true });
  });

  it('reconcile() consumes the prefs-resident records directly (live path needs no extra input)', () => {
    const { projects, missionLoopMeta } = orchestratorFixture();
    const { nodes } = reconcile(
      baseInputs({
        projects,
        missionLoopMeta,
        prefs: { ...DEFAULT_CANVAS_PREFS, foldedOrchestrators: { orch: true } },
      }),
    );
    expect(nodes.find((n) => n.id === makeRef('mission', 'sub1'))).toBeUndefined();
    expect(nodes.find((n) => n.id === makeRef('mission', 'orch'))).toBeDefined();
  });

  it('a toggled-back-off (false) record entry does NOT fold', () => {
    const { projects, missionLoopMeta } = orchestratorFixture();
    const { nodes } = reconcile(
      baseInputs({
        projects,
        missionLoopMeta,
        prefs: { ...DEFAULT_CANVAS_PREFS, foldedOrchestrators: { orch: false } },
      }),
    );
    expect(nodes.find((n) => n.id === makeRef('mission', 'sub1'))).toBeDefined();
  });
});
