/**
 * layout.test.ts — elkjs auto-layout / lane-mode fixtures (W2b, spec §4.3
 * "Lane mode", §5 "Auto-layout"). Runs the REAL elkjs bundled algorithm
 * (no mocking — `elk.bundled.js` runs synchronously in vitest's node
 * environment, confirmed by a direct smoke test before writing this
 * module) against small fixture graphs, asserting on the STRUCTURE of the
 * result (zone/child keys present, relative ordering, deterministic
 * output) rather than exact pixel coordinates elkjs's algorithm owns.
 */

import { describe, it, expect, vi } from 'vitest';
import { layoutAll, layoutZone, laneLayout, layoutPreviewGraph, layoutDraftGraphInZone, type DraftGraphNode, type DraftGraphEdge } from '../components/agents/canvas/layout';
import { DEFAULT_CANVAS_PREFS, makeRef, type MissionNodeData, type DraftSpec, type LoopNodeData } from '../components/agents/canvas/canvasTypes';
import { CELL_MARGIN, FULL_CARD_MAX_HEIGHT, LANE_ROW_HEIGHT, ZONE_HEADER_HEIGHT, ZONE_VERTICAL_GAP, zoneRowPackGap } from '../components/agents/canvas/geometry';
import { reconcile, TRANSVERSE_PROJECT_ID, type CanvasReactFlowEdge, type CanvasReactFlowNode } from '../components/agents/canvas/reconciler';
import { DEFAULT_NODE_SIZE, JOIN_NODE_SIZE } from '../components/agents/canvas/reconcilerZones';
import type { FleetMission } from '../lib/agents/fleetMissions';
import type { LoopConfig } from '../lib/agents/types';

function mission(overrides: Partial<FleetMission> = {}): FleetMission {
  return { id: 'm1', title: 'Fix bug', status: 'running', stage: 'code', model: 'sonnet', updatedMs: 1, urgent: false, ...overrides };
}

function projectNode(projectId: string): CanvasReactFlowNode {
  return {
    id: makeRef('project', projectId),
    type: 'project',
    position: { x: 0, y: 0 },
    width: 400,
    height: 300,
    data: { projectId, root: `/repo/${projectId}`, name: projectId } as unknown as CanvasReactFlowNode['data'],
  } as CanvasReactFlowNode;
}

function missionNode(id: string, projectId: string, stageOverrides: Partial<FleetMission> = {}): CanvasReactFlowNode {
  const data: MissionNodeData = { mission: mission({ id, ...stageOverrides }), projectId, isActiveProject: true };
  return {
    id: makeRef('mission', id),
    type: 'mission',
    parentId: makeRef('project', projectId),
    position: { x: 0, y: 0 },
    width: 220,
    height: 120,
    data: data as unknown as CanvasReactFlowNode['data'],
  } as CanvasReactFlowNode;
}

function draftNode(id: string, projectId: string): CanvasReactFlowNode {
  const data: DraftSpec = { id, title: 'Draft', task: 'do it', createdBy: 'user', projectId };
  return {
    id: makeRef('draft', id),
    type: 'draft',
    parentId: makeRef('project', projectId),
    position: { x: 0, y: 0 },
    width: 200,
    height: 108,
    data: data as unknown as CanvasReactFlowNode['data'],
  } as CanvasReactFlowNode;
}

function loopNode(id: string, projectId: string): CanvasReactFlowNode {
  const config: LoopConfig = { cadence: '5m', stopCondition: { kind: 'manual' }, enabled: true, iterationCount: 1, iterationMissionIds: [] };
  const data: LoopNodeData = { mission: mission({ id }), projectId, isActiveProject: true, loopConfig: config, recentIterations: [] };
  return {
    id: makeRef('loop', id),
    type: 'loop',
    parentId: makeRef('project', projectId),
    position: { x: 0, y: 0 },
    width: 210,
    height: 156,
    data: data as unknown as CanvasReactFlowNode['data'],
  } as CanvasReactFlowNode;
}

function chainEdge(id: string, source: string, target: string): CanvasReactFlowEdge {
  return {
    id,
    type: 'chain',
    source,
    target,
    data: { condition: 'success' },
  } as unknown as CanvasReactFlowEdge;
}

describe('layoutZone', () => {
  it('returns an empty patch for a zone with no children', async () => {
    const nodes = [projectNode('p1')];
    expect(await layoutZone(nodes, [], 'p1')).toEqual({});
  });

  it('returns a position keyed by every child ref, none for nodes outside the zone', async () => {
    const nodes = [projectNode('p1'), projectNode('p2'), missionNode('m1', 'p1'), missionNode('m2', 'p1'), missionNode('m3', 'p2')];
    const result = await layoutZone(nodes, [], 'p1');
    expect(Object.keys(result).sort()).toEqual([makeRef('mission', 'm1'), makeRef('mission', 'm2')].sort());
    expect(result[makeRef('mission', 'm3')]).toBeUndefined();
  });

  it('places a chained target downstream (greater x) of its source, honoring the edge as a layout constraint', async () => {
    const nodes = [projectNode('p1'), missionNode('m1', 'p1'), draftNode('d1', 'p1')];
    const edges = [chainEdge('c1', makeRef('mission', 'm1'), makeRef('draft', 'd1'))];
    const result = await layoutZone(nodes, edges, 'p1');
    expect(result[makeRef('draft', 'd1')]!.x).toBeGreaterThan(result[makeRef('mission', 'm1')]!.x);
  });

  it('ignores a chain edge to a node outside the zone (never crashes, never fabricates a position)', async () => {
    const nodes = [projectNode('p1'), projectNode('p2'), missionNode('m1', 'p1'), draftNode('d1', 'p2')];
    const edges = [chainEdge('c1', makeRef('mission', 'm1'), makeRef('draft', 'd1'))];
    const result = await layoutZone(nodes, edges, 'p1');
    expect(Object.keys(result)).toEqual([makeRef('mission', 'm1')]);
  });

  // R13 — « breathing room »: auto-layout used to tile same-layer sibling
  // cards with only 36px between them (elk.spacing.nodeNode) — widened to
  // 56px so a dense zone still keeps real air between cards instead of
  // tiling edge-to-edge with no empty pane left to right-click on.
  it('spaces two unconnected sibling nodes at least the new wider nodeNode gap apart (breathing room)', async () => {
    const nodes = [projectNode('p1'), missionNode('m1', 'p1'), missionNode('m2', 'p1')];
    const result = await layoutZone(nodes, [], 'p1');
    const m1 = result[makeRef('mission', 'm1')]!;
    const m2 = result[makeRef('mission', 'm2')]!;
    // Same layer (no edge relates them) — elk stacks unconnected siblings
    // along the perpendicular axis with elk.spacing.nodeNode between card
    // edges. Card height is 120 (missionNode fixture) — subtracting it from
    // the raw center-to-center gap isolates the actual edge-to-edge space.
    const gap = Math.abs(m2.y - m1.y) - 120;
    expect(gap).toBeGreaterThanOrEqual(56);
  });
});

describe('layoutAll', () => {
  it('positions every zone (own ref) and every child, with Transverse always last', async () => {
    const nodes = [
      projectNode(TRANSVERSE_PROJECT_ID),
      missionNode('t1', TRANSVERSE_PROJECT_ID),
      projectNode('p1'),
      missionNode('m1', 'p1'),
      projectNode('p2'),
      missionNode('m2', 'p2'),
    ];
    const result = await layoutAll(nodes, []);

    expect(result[makeRef('project', 'p1')]).toBeDefined();
    expect(result[makeRef('project', 'p2')]).toBeDefined();
    expect(result[makeRef('project', TRANSVERSE_PROJECT_ID)]).toBeDefined();
    expect(result[makeRef('mission', 'm1')]).toBeDefined();
    expect(result[makeRef('mission', 'm2')]).toBeDefined();
    expect(result[makeRef('mission', 't1')]).toBeDefined();

    // Transverse zone packed strictly after both real projects in the
    // shelf-pack's own reading order (row-major: same row further right, OR
    // a later row entirely) — scratch/_canvas-label-design.md §3.3.1's
    // viewport-aspect-aware column count means 3 zones no longer
    // necessarily share one row (2 real projects + Transverse packs 2+1,
    // not 3+0), so Transverse can legitimately wrap to its own row (x
    // resets to 0) rather than always landing strictly right of the others.
    const p1 = result[makeRef('project', 'p1')]!;
    const p2 = result[makeRef('project', 'p2')]!;
    const transverse = result[makeRef('project', TRANSVERSE_PROJECT_ID)]!;
    const packedAfter = (earlier: { x: number; y: number }) =>
      transverse.y > earlier.y || (transverse.y === earlier.y && transverse.x >= earlier.x);
    expect(packedAfter(p1)).toBe(true);
    expect(packedAfter(p2)).toBe(true);
  });

  it('never places two zones at the exact same origin', async () => {
    const nodes = [projectNode('p1'), missionNode('m1', 'p1'), projectNode('p2'), missionNode('m2', 'p2')];
    const result = await layoutAll(nodes, []);
    const p1 = result[makeRef('project', 'p1')]!;
    const p2 = result[makeRef('project', 'p2')]!;
    expect(p1).not.toEqual(p2);
  });

  // fix/canvas-title-float (requirement 4, "guard the top") — a zone's own
  // title now floats ABOVE its frame, so the "Ranger" auto-layout's own
  // row-to-row gap (this file's own MAX_ZONES_PER_ROW wrap) must be wide
  // enough that a title floating above a lower row never reaches the row
  // above's own bottom edge — see geometry.ts's ZONE_VERTICAL_GAP doc
  // comment for the worked math. Asserted as a LOWER BOUND (not an exact
  // value, unlike reconciler.test.ts's equivalent packAutoPlacedZones
  // assertion): elkjs's own layered-layout result for each zone's real
  // footprint isn't hand-reproducible here, but the row-to-row Y advance
  // must still be AT LEAST the packing gap regardless of that footprint (a
  // real footprint only ever makes the true gap bigger, never smaller) —
  // this would fail under the OLD, smaller ZONE_GAP-based spacing (60,
  // nowhere near enough to clear a floating title's own worst-case ~456px
  // footprint), so it's a meaningful regression guard, not a tautology.
  //
  // scratch/_canvas-label-design.md §3.2/§3.3 — the bound is now
  // `ZONE_VERTICAL_GAP` itself (192, not the old airtight-at-the-absolute-
  // floor 456): bounding the LOD compensation (`chrome/lod.ts`'s
  // `LOD_FLOOR_ZOOM`, 0.25) already shrank the airtight worst case small
  // enough to use directly as the routine packing gap — "plus de formule au
  // pire cas" (design doc's own words). `packColumnsForZoneCount(4)` is 3
  // (`round(sqrt(4*1.7))`), so a 4th zone still wraps to row 1, same shape
  // as the old flat-3-per-row test this replaces.
  it('spaces STACKED zone rows apart by exactly ZONE_VERTICAL_GAP (packColumnsForZoneCount(4) is 3 — a 4th zone wraps to row 1)', async () => {
    const nodes = [
      projectNode('p0'), missionNode('m0', 'p0'),
      projectNode('p1'), missionNode('m1', 'p1'),
      projectNode('p2'), missionNode('m2', 'p2'),
      projectNode('p3'), missionNode('m3', 'p3'),
    ];
    const result = await layoutAll(nodes, []);
    const row0Y = result[makeRef('project', 'p0')]!.y;
    const row1Y = result[makeRef('project', 'p3')]!.y;
    expect(row1Y - row0Y).toBeGreaterThanOrEqual(zoneRowPackGap());
    // The gap is now the small (192) flat constant, not the old 456 —
    // proves the packer isn't accidentally still using a bigger value.
    expect(zoneRowPackGap()).toBe(ZONE_VERTICAL_GAP);
    expect(zoneRowPackGap()).toBeLessThan(456);
  });
});

describe('laneLayout', () => {
  it('assigns each mission to the lane matching its own stage (x strictly increases plan -> merged)', async () => {
    const nodes = [
      projectNode('p1'),
      missionNode('plan-m', 'p1', { stage: 'plan' }),
      missionNode('code-m', 'p1', { stage: 'code' }),
      missionNode('test-m', 'p1', { stage: 'test' }),
      missionNode('review-m', 'p1', { stage: 'review' }),
      missionNode('merged-m', 'p1', { stage: 'merged' }),
    ];
    const result = await laneLayout(nodes, 'p1');
    const xOf = (id: string) => result[makeRef('mission', id)]!.x;
    expect(xOf('plan-m')).toBeLessThan(xOf('code-m'));
    expect(xOf('code-m')).toBeLessThan(xOf('test-m'));
    expect(xOf('test-m')).toBeLessThan(xOf('review-m'));
    expect(xOf('review-m')).toBeLessThan(xOf('merged-m'));
  });

  it('drafts land in the PLAN lane (same x as a plan-stage mission)', async () => {
    const nodes = [projectNode('p1'), missionNode('plan-m', 'p1', { stage: 'plan' }), draftNode('d1', 'p1')];
    const result = await laneLayout(nodes, 'p1');
    expect(result[makeRef('draft', 'd1')]!.x).toBe(result[makeRef('mission', 'plan-m')]!.x);
  });

  it('loops/schedules go to a left gutter column, strictly left of every lane', async () => {
    const nodes = [projectNode('p1'), missionNode('plan-m', 'p1', { stage: 'plan' }), loopNode('l1', 'p1')];
    const result = await laneLayout(nodes, 'p1');
    expect(result[makeRef('loop', 'l1')]!.x).toBeLessThan(result[makeRef('mission', 'plan-m')]!.x);
  });

  it('is deterministic: same input always yields the same output', async () => {
    const nodes = [projectNode('p1'), missionNode('m1', 'p1', { stage: 'test' }), missionNode('m2', 'p1', { stage: 'test' })];
    const first = await laneLayout(nodes, 'p1');
    const second = await laneLayout(nodes, 'p1');
    expect(first).toEqual(second);
  });

  it('leaves notes untouched (absent from the returned patch)', async () => {
    const nodes = [
      projectNode('p1'),
      { id: makeRef('note', 'n1'), type: 'note', parentId: makeRef('project', 'p1'), position: { x: 5, y: 5 }, data: { id: 'n1', text: 'hi' } } as unknown as CanvasReactFlowNode,
    ];
    const result = await laneLayout(nodes, 'p1');
    expect(result[makeRef('note', 'n1')]).toBeUndefined();
  });

  // W6b geometry fix wave (spec CRITICAL 4) — row 0 must leave room for the
  // PLAN/CODE/TEST/REVUE/MERGE column-header strip ProjectGroupNode.tsx
  // renders BELOW the zone's own name/count header, and stacked rows within
  // one lane must be spaced a full CELL apart so a full card never overlaps
  // the next row (same footprint as the placement grid, spec CRITICAL 2).
  it('starts row 0 strictly below the zone header, leaving room for the lane column-header strip', async () => {
    const nodes = [projectNode('p1'), missionNode('plan-m', 'p1', { stage: 'plan' })];
    const result = await laneLayout(nodes, 'p1');
    expect(result[makeRef('mission', 'plan-m')]!.y).toBeGreaterThan(ZONE_HEADER_HEIGHT);
  });

  it('stacks two nodes in the SAME lane a full CELL height apart (never overlapping vertically)', async () => {
    const nodes = [
      projectNode('p1'),
      missionNode('test-a', 'p1', { stage: 'test' }),
      missionNode('test-b', 'p1', { stage: 'test' }),
    ];
    const result = await laneLayout(nodes, 'p1');
    const ys = [result[makeRef('mission', 'test-a')]!.y, result[makeRef('mission', 'test-b')]!.y].sort((a, b) => a - b);
    expect(ys[1]! - ys[0]!).toBe(LANE_ROW_HEIGHT);
  });

  // fix/canvas-ux R4a deliverable #3 — David's no-overlap rule inside lane
  // mode too. Investigated whether a tall REVIEW card (the approve/reject
  // gate form, MissionNode.tsx's `mission.status === 'review'` branch) could
  // clip into or visually overlap the row below: `LANE_ROW_HEIGHT` is a
  // FIXED `GRID_CELL_HEIGHT` (= FULL_CARD_MAX_HEIGHT + CELL_MARGIN — see
  // geometry.ts, CELL_MARGIN tuned over time; symbolic constants below, not
  // hardcoded copies) regardless of a review card's real gate-form content
  // height — BUT nodeChrome.tsx's `NodeCard` unconditionally applies
  // `maxHeight: FULL_CARD_MAX_HEIGHT, overflow: 'hidden'` to every full-zoom
  // card (MissionNode.tsx line ~272, `isFull ? { maxHeight:
  // FULL_CARD_MAX_HEIGHT, overflow: 'hidden' } : {}`), independent of lane
  // mode and independent of review/gate-open state. So a review card's DOM
  // height can never actually exceed FULL_CARD_MAX_HEIGHT no matter how much
  // gate-form content it holds — the row height therefore always has a full
  // CELL_MARGIN buffer beyond the tallest a full card can ever render, and no
  // lane-mode overlap is possible from this. (The gate form's content getting
  // visually CLIPPED inside that ceiling is a real, separate legibility
  // concern — but it is a card-shell defect independent of lane mode's own
  // row-height math, out of this no-overlap-invariant wave's scope; flagged
  // in the report.)
  it('the fixed LANE_ROW_HEIGHT always has margin beyond FULL_CARD_MAX_HEIGHT, so no stacked lane card can ever overlap the row below regardless of gate-form content', () => {
    expect(LANE_ROW_HEIGHT).toBeGreaterThan(FULL_CARD_MAX_HEIGHT);
    // At least a full CELL_MARGIN-equivalent of breathing room, not just 1px.
    // Design pass (dezoom legibility) tightened CELL_MARGIN 30 -> 18 — the
    // invariant this asserts ("a real margin, not a razor edge") still
    // holds at the new value; referencing the constant symbolically means
    // a future re-tune of CELL_MARGIN never needs a matching test edit.
    expect(LANE_ROW_HEIGHT - FULL_CARD_MAX_HEIGHT).toBeGreaterThanOrEqual(CELL_MARGIN);
  });

  it('the reconciler gives a review-status mission (the tall gate-form card) the SAME FULL_CARD_MAX_HEIGHT footprint as any other mission — never a taller reservation the lane row-height math would need to account for', () => {
    const { nodes } = reconcile({
      projects: [{ projectId: 'p1', root: '/repo/p1', name: 'p1', missions: [{ id: 'm1', title: 'x', status: 'review', stage: 'review', model: 'sonnet', updatedMs: 1, urgent: false }] }],
      drafts: [],
      chains: [],
      notes: [],
      scheduled: [],
      positions: {},
      collapsed: {},
      prefs: DEFAULT_CANVAS_PREFS,
    });
    const reviewMission = nodes.find((n) => n.id === makeRef('mission', 'm1'));
    expect(reviewMission?.height).toBe(FULL_CARD_MAX_HEIGHT);
  });
});

// Founder's #1 complaint (dangling-edge chat-card crash) — reproduced live
// via CDP against the running app: one edge whose `target` did not match
// any node in the SAME call's node list made elkjs's bundled JSON importer
// throw `JsonImportException: Referenced shape does not exist` for the
// WHOLE layout, degrading a real 12-step plan to the broken fallback view.
// `layoutPreviewGraph` must now drop that one edge and still resolve.
describe('layoutPreviewGraph', () => {
  it('resolves a well-formed graph (baseline — no dropped edges)', async () => {
    const result = await layoutPreviewGraph(
      [{ id: 'a', width: 180, height: 84 }, { id: 'b', width: 180, height: 84 }],
      [{ id: 'e1', source: 'a', target: 'b' }],
    );
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.positions.a).toBeDefined();
    expect(result.positions.b).toBeDefined();
    expect(result.droppedEdgeIds).toBeUndefined();
  });

  it('drops an edge whose TARGET does not match any given node instead of throwing (the exact live repro: elkjs JsonImportException on a dangling target)', async () => {
    const result = await layoutPreviewGraph(
      [{ id: 'a', width: 180, height: 84 }],
      [{ id: 'e1', source: 'a', target: 'GHOST' }],
    );
    expect(result.width).toBeGreaterThan(0);
    expect(result.positions.a).toBeDefined();
    expect(result.droppedEdgeIds).toEqual(['e1']);
  });

  it('drops an edge whose SOURCE does not match any given node instead of throwing', async () => {
    const result = await layoutPreviewGraph(
      [{ id: 'a', width: 180, height: 84 }],
      [{ id: 'e1', source: 'GHOST', target: 'a' }],
    );
    expect(result.width).toBeGreaterThan(0);
    expect(result.positions.a).toBeDefined();
    expect(result.droppedEdgeIds).toEqual(['e1']);
  });

  it('a dangling edge costs only itself — the surviving well-formed edges still lay out as real layout constraints', async () => {
    const result = await layoutPreviewGraph(
      [
        { id: 'a', width: 180, height: 84 },
        { id: 'b', width: 180, height: 84 },
      ],
      [
        { id: 'e-good', source: 'a', target: 'b' },
        { id: 'e-dangling', source: 'b', target: 'GHOST' },
      ],
    );
    expect(result.droppedEdgeIds).toEqual(['e-dangling']);
    // The surviving edge is still honored as a layout constraint (b
    // downstream of a) — dropping the bad edge never disabled the good one.
    expect(result.positions.b!.x).toBeGreaterThan(result.positions.a!.x);
  });

  it('logs the dropped edge id(s) once, with a stable grep-able prefix, instead of failing silently', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await layoutPreviewGraph(
      [{ id: 'a', width: 180, height: 84 }],
      [{ id: 'e1', source: 'a', target: 'GHOST' }],
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[layoutPreviewGraph]',
      expect.stringContaining('dropped'),
      ['e1'],
    );
    warnSpy.mockRestore();
  });

  it('returns an empty layout for zero nodes without ever touching elkjs (existing early return, unaffected by the guard)', async () => {
    const result = await layoutPreviewGraph([], [{ id: 'e1', source: 'a', target: 'b' }]);
    expect(result).toEqual({ positions: {}, width: 0, height: 0 });
  });
});

// fix/canvas-node-layout — regression coverage for the live-reproduced
// defect: a plan's fan-in convergence step (two incoming edges) rendered
// inside a DIFFERENT project's zone. Root cause (see layoutDraftGraphInZone's
// own doc comment in layout.ts): the call site used to compute positions
// with the in-CHAT preview's own unbounded, zone-unaware elkjs layout
// (`layoutPreviewGraph`) and write those raw coordinates straight in as
// zone-relative child positions. elkjs's layered "RIGHT" direction gives
// each node an x proportional to its RANK (longest path from a source) — a
// fan-in node's rank is `max(rank of every parent) + 1`, the deepest/
// largest-x node in the whole graph, so it was also the one most likely to
// have an x large enough to overflow past its own zone's right edge and
// land inside whatever zone the canvas happened to pack next door. Every
// single-parent node has a smaller rank/x and, by coincidence of zone
// sizing, can still land inside its own zone — exactly the "only the
// fan-in node is wrong" pattern this was reported with.
//
// `layoutDraftGraphInZone` fixes this by routing through the SAME
// zone-padded elkjs core `layoutZone` itself uses for a zone's EXISTING
// children (`layoutGraphWithinZone`) — its own `elk.padding` guarantees
// every returned x/y is >= the zone's own content inset, and the returned
// `width`/`height` (elkjs's own computed bounding box, padding included) is
// exactly what a caller grows the zone's frame to. This test proves that
// containment holds for the general case (fan-out, fan-in, AND a reviewer
// back-edge that makes the graph genuinely cyclic), not just the simple
// single-parent chains the OLD code path also handled fine.
describe('layoutDraftGraphInZone', () => {
  it('keeps every node — fan-out, a two-parent fan-in convergence, and a cyclic reviewer back-edge — inside the zone bounding box it returns', async () => {
    const nodes: DraftGraphNode[] = [
      { id: 'spec', ...DEFAULT_NODE_SIZE.draft },
      { id: 'branch-a-1', ...DEFAULT_NODE_SIZE.draft },
      { id: 'branch-b-1', ...DEFAULT_NODE_SIZE.draft },
      { id: 'join:review', ...JOIN_NODE_SIZE },
      { id: 'review', ...DEFAULT_NODE_SIZE.draft },
      { id: 'fixer', ...DEFAULT_NODE_SIZE.draft },
      { id: 'final', ...DEFAULT_NODE_SIZE.draft },
    ];
    const edges: DraftGraphEdge[] = [
      { id: 'e-spec-a', source: 'spec', target: 'branch-a-1' }, // fan-out
      { id: 'e-spec-b', source: 'spec', target: 'branch-b-1' }, // fan-out
      { id: 'e-a-join', source: 'branch-a-1', target: 'join:review' }, // fan-in parent 1
      { id: 'e-b-join', source: 'branch-b-1', target: 'join:review' }, // fan-in parent 2
      { id: 'e-join-review', source: 'join:review', target: 'review' },
      { id: 'e-review-fixer', source: 'review', target: 'fixer' },
      { id: 'e-fixer-final', source: 'fixer', target: 'final' },
      // Reviewer sends work back to an earlier step — the graph is now
      // genuinely cyclic (spec's own doc comment: elkjs runs its own
      // cycle-breaking phase and still returns a bounded position).
      { id: 'e-fixer-spec-back', source: 'fixer', target: 'spec' },
    ];

    const result = await layoutDraftGraphInZone(nodes, edges);

    expect(result.droppedEdgeIds).toBeUndefined();
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    for (const node of nodes) {
      const pos = result.positions[node.id];
      expect(pos, `missing position for ${node.id}`).toBeDefined();
      // Every position falls INSIDE the owning zone's bounds — never a wild
      // coordinate escaping into a neighboring zone's on-canvas space.
      expect(pos!.x).toBeGreaterThanOrEqual(0);
      expect(pos!.y).toBeGreaterThanOrEqual(0);
      expect(pos!.x + node.width).toBeLessThanOrEqual(result.width);
      expect(pos!.y + node.height).toBeLessThanOrEqual(result.height);
    }
  });

  it('drops a dangling draft edge instead of crashing (mirrors layoutPreviewGraph\'s own guard)', async () => {
    const nodes: DraftGraphNode[] = [{ id: 'a', ...DEFAULT_NODE_SIZE.draft }];
    const edges: DraftGraphEdge[] = [{ id: 'e1', source: 'a', target: 'GHOST' }];
    const result = await layoutDraftGraphInZone(nodes, edges);
    expect(result.positions.a).toBeDefined();
    expect(result.droppedEdgeIds).toEqual(['e1']);
  });

  it('returns an empty layout for zero nodes', async () => {
    const result = await layoutDraftGraphInZone([], []);
    expect(result).toEqual({ positions: {}, width: 0, height: 0 });
  });
});
