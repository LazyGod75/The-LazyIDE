/**
 * Tests for reconciler.ts — the pure FleetProject[] + canvas geometry ->
 * React Flow nodes/edges mapping (spec §6). Covers: zone grouping,
 * incremental placement, stable positions, loop aggregation, hierarchy +
 * chain edges (incl. tombstones), hideMerged filtering, referential data
 * stability, and the scheduledAgentsToNodeData mapper.
 */

import { describe, it, expect } from 'vitest';
import {
  reconcile,
  scheduledAgentsToNodeData,
  TRANSVERSE_PROJECT_ID,
  type CanvasReactFlowNode,
  type MissionLoopMeta,
  type ReconcileInputs,
} from '../components/agents/canvas/reconciler';
import { DEFAULT_CANVAS_PREFS, makeRef, type Chain, type DraftSpec, type ProjectNodeData } from '../components/agents/canvas/canvasTypes';
import {
  FULL_CARD_MAX_HEIGHT,
  FULL_CARD_WIDTH,
  GRID_CELL_HEIGHT,
  GRID_CELL_WIDTH,
  LANE_MODE_ZONE_WIDTH,
  ZONE_MIN_WIDTH_FOR_TITLE,
  ZONE_TITLE_BAND_HEIGHT,
  ZONE_HEADER_HEIGHT,
  ZONE_PADDING,
  ZONE_VERTICAL_GAP,
  packColumnsForZoneCount,
  zoneMinWidthForTitle,
  zoneRowPackGap,
  zoneSameRowPackGap,
} from '../components/agents/canvas/geometry';
import { getNodesBounds } from '@xyflow/system';
import type { FleetMission, FleetProject } from '../lib/agents/fleetMissions';
import type { StoredAgent } from '../lib/agents/agentsStorage';
import type { LazyAgent } from '../lib/agents/agentDef';

// ── Fixtures ───────────────────────────────────────────────────────

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
    ...overrides,
  };
}

function findNode(nodes: readonly CanvasReactFlowNode[], id: string): CanvasReactFlowNode {
  const found = nodes.find((n) => n.id === id);
  if (!found) throw new Error(`node ${id} not found among [${nodes.map((n) => n.id).join(', ')}]`);
  return found;
}

// ── Zone grouping ──────────────────────────────────────────────────

describe('reconcile — zone grouping', () => {
  it('creates one project node per open project, with no parentId', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', name: 'Proj One' }), project({ projectId: 'p2', name: 'Proj Two' })],
      }),
    );

    const p1 = findNode(nodes, makeRef('project', 'p1'));
    const p2 = findNode(nodes, makeRef('project', 'p2'));
    expect(p1.type).toBe('project');
    expect(p1.parentId).toBeUndefined();
    expect(p2.type).toBe('project');
    expect(p2.parentId).toBeUndefined();
  });

  // 2026-08-05 "zones-projet-disparues" incident — real report: after a
  // clear_canvas(all) sweep, the canvas rendered only ONE project zone
  // instead of the 4 genuinely open projects (byType project:1, back to 4
  // only after a full reload). Audited every emission path in this file and
  // reconcilerZones.ts (computeZoneLayout/emitZone/packAutoPlacedZones): NO
  // condition here hides an empty zone, skips a collapsed one, or re-filters
  // `projects` by content — every project in the INPUT array unconditionally
  // gets exactly one zone node (see this test), collapsed or not, empty or
  // not — the empty-state "Lancer un agent" card a zone-less project used to
  // show is exactly what an EMPTY-but-still-emitted zone renders as. Locked
  // in here as a permanent regression guard for that invariant; if a project
  // zone goes missing again, the defect is in whatever computes THIS
  // function's `projects` input (agentsStore.tsx's fleet-projects
  // derivation / clear_canvas handling), not in this pure mapping.
  it('renders one zone per OPEN project even with zero content on every one of them (4 open, 4 zones)', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({ projectId: 'p1' }),
          project({ projectId: 'p2' }),
          project({ projectId: 'p3' }),
          project({ projectId: 'p4' }),
        ],
      }),
    );

    const projectNodes = nodes.filter((n) => n.type === 'project');
    expect(projectNodes).toHaveLength(4);
    expect(projectNodes.map((n) => n.id).sort()).toEqual(
      [makeRef('project', 'p1'), makeRef('project', 'p2'), makeRef('project', 'p3'), makeRef('project', 'p4')].sort(),
    );
    // Every one of them is genuinely emitted (not just present in the array
    // with some degenerate shape) — the same empty-state a zone-less project
    // renders via ProjectNodeData.hasChildren: false.
    for (const node of projectNodes) {
      const data = node.data as unknown as ProjectNodeData;
      expect(data.hasChildren).toBe(false);
      expect(data.counts.total).toBe(0);
    }
  });

  it('keeps rendering all 4 zones across a SECOND reconcile with the previous pass fed back as prevNodes (rules out a stale prevNodes/stableNode reuse regression)', () => {
    const inputs = baseInputs({
      projects: [
        project({ projectId: 'p1' }),
        project({ projectId: 'p2' }),
        project({ projectId: 'p3' }),
        project({ projectId: 'p4' }),
      ],
    });
    const first = reconcile(inputs);
    expect(first.nodes.filter((n) => n.type === 'project')).toHaveLength(4);

    const second = reconcile({ ...inputs, prevNodes: first.nodes });
    expect(second.nodes.filter((n) => n.type === 'project')).toHaveLength(4);
  });

  it('nests a mission node under its project with extent parent', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'Fix bug' })] })],
      }),
    );

    const missionNode = findNode(nodes, makeRef('mission', 'm1'));
    expect(missionNode.parentId).toBe(makeRef('project', 'p1'));
    expect(missionNode.extent).toBe('parent');
    expect(missionNode.type).toBe('mission');
  });

  it('places a draft with no projectId, and a schedule for a closed project, into the synthetic Transverse zone', () => {
    const drafts: DraftSpec[] = [{ id: 'd1', title: 'T', task: 'x', createdBy: 'user' }];
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1' })],
        drafts,
        scheduled: [
          { scheduleId: 's1', agentName: 'a', cron: '0 9 * * *', cronLabel: '9h', enabled: true, projectId: 'closed-project' },
        ],
      }),
    );

    const transverse = findNode(nodes, makeRef('project', TRANSVERSE_PROJECT_ID));
    expect(transverse.type).toBe('project');

    const draftNode = findNode(nodes, makeRef('draft', 'd1'));
    expect(draftNode.parentId).toBe(makeRef('project', TRANSVERSE_PROJECT_ID));

    const schedNode = findNode(nodes, makeRef('schedule', 's1'));
    expect(schedNode.parentId).toBe(makeRef('project', TRANSVERSE_PROJECT_ID));
  });

  it('omits the Transverse zone entirely when it would have no children', () => {
    const { nodes } = reconcile(baseInputs({ projects: [project({ projectId: 'p1' })] }));
    expect(nodes.find((n) => n.id === makeRef('project', TRANSVERSE_PROJECT_ID))).toBeUndefined();
  });

  it('collapsed zone omits its children entirely and renders a fixed chip size', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'x' })] })],
        collapsed: { p1: true },
      }),
    );

    expect(nodes.find((n) => n.id === makeRef('mission', 'm1'))).toBeUndefined();
    const zone = findNode(nodes, makeRef('project', 'p1'));
    expect((zone.data as { collapsed: boolean }).collapsed).toBe(true);
    expect(zone.width).toBeGreaterThan(0);
    expect(zone.height).toBeGreaterThan(0);
  });

  it('sizes a project zone to the bounding box of its children plus padding', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [mission({ id: 'm1', title: 'a' }), mission({ id: 'm2', title: 'b' })],
          }),
        ],
      }),
    );
    const zone = findNode(nodes, makeRef('project', 'p1'));
    // two children placed side by side (grid, max 4/row) must produce a
    // width wider than a single 260px cell.
    expect(zone.width).toBeGreaterThan(260);
  });

  it('emits every project node BEFORE its children (React Flow parent-order requirement)', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' }), mission({ id: 'm2', title: 'b' })] }),
          project({ projectId: 'p2', missions: [mission({ id: 'm3', title: 'c' })] }),
        ],
      }),
    );
    const indexById = new Map(nodes.map((n, i) => [n.id, i] as const));
    for (const node of nodes) {
      if (!node.parentId) continue;
      const parentIndex = indexById.get(node.parentId);
      expect(parentIndex).toBeDefined();
      expect(parentIndex!).toBeLessThan(indexById.get(node.id)!);
    }
  });
});

// ── Zone packing (spec CRITICAL 1 — W6b geometry fix wave) ───────────

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function projectZoneRects(nodes: readonly CanvasReactFlowNode[]): Rect[] {
  return nodes
    .filter((n) => n.type === 'project')
    .map((n) => ({ x: n.position.x, y: n.position.y, width: n.width ?? 0, height: n.height ?? 0 }));
}

/** Every pair of rects in `rects` must be pairwise non-overlapping — the
 *  CRITICAL 1 invariant this wave's task explicitly asks for a property
 *  test on ("for any fixture, no two auto-placed zone rects intersect"). */
function assertNoOverlap(rects: readonly Rect[]): void {
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      expect(rectsOverlap(rects[i]!, rects[j]!)).toBe(false);
    }
  }
}

/** Deterministic PRNG (mulberry32) — no new test dependency (fast-check
 *  isn't in package.json), just a seeded generator so the property test
 *  below is reproducible across runs while still exercising many distinct
 *  fixture shapes. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('reconcile — zone packing (spec CRITICAL 1)', () => {
  it('packs several auto-placed (no persisted position) zones without any two overlapping', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({ projectId: 'gameon-mobile', missions: Array.from({ length: 12 }, (_, i) => mission({ id: `gm-${i}`, title: `m${i}` })) }),
          project({ projectId: 'site-web', missions: Array.from({ length: 5 }, (_, i) => mission({ id: `sw-${i}`, title: `m${i}` })) }),
          project({ projectId: 'training-api', missions: Array.from({ length: 3 }, (_, i) => mission({ id: `ta-${i}`, title: `m${i}` })) }),
        ],
      }),
    );
    assertNoOverlap(projectZoneRects(nodes));
  });

  it('leaves a persisted (user-dragged) zone position untouched by the packer', () => {
    const stored = { x: 5000, y: 5000 };
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
        positions: { [makeRef('project', 'p1')]: stored },
      }),
    );
    expect(findNode(nodes, makeRef('project', 'p1')).position).toEqual(stored);
  });

  it('re-packs the auto-placed zones on the very next reconcile when one of them grows past its neighbor', () => {
    const small = reconcile(
      baseInputs({
        projects: [
          project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] }),
          project({ projectId: 'p2', missions: [mission({ id: 'm2', title: 'b' })] }),
        ],
      }),
    );
    assertNoOverlap(projectZoneRects(small.nodes));

    // p1 grows a lot of new children — big enough that, under the OLD
    // static-width placement, it would have shoved into p2's old slot.
    const grown = reconcile(
      baseInputs({
        projects: [
          project({ projectId: 'p1', missions: Array.from({ length: 20 }, (_, i) => mission({ id: `m1-${i}`, title: `m${i}` })) }),
          project({ projectId: 'p2', missions: [mission({ id: 'm2', title: 'b' })] }),
        ],
      }),
    );
    assertNoOverlap(projectZoneRects(grown.nodes));
  });

  it('property: for many randomized fixtures (varying project/mission counts, laneMode on/off), no two auto-placed zones ever intersect', () => {
    const rand = mulberry32(1337);
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const projectCount = 1 + Math.floor(rand() * 6); // 1..6
      const laneMode = rand() < 0.5;
      const projects: FleetProject[] = Array.from({ length: projectCount }, (_, p) => {
        const missionCount = Math.floor(rand() * 11); // 0..10
        return project({
          projectId: `rand-p${p}`,
          missions: Array.from({ length: missionCount }, (_, m) => mission({ id: `rand-p${p}-m${m}`, title: `m${m}` })),
        });
      });
      const { nodes } = reconcile(
        baseInputs({ projects, prefs: { ...DEFAULT_CANVAS_PREFS, laneMode } }),
      );
      assertNoOverlap(projectZoneRects(nodes));
    }
  });

  // fix/canvas-title-float (requirement 4, "guard the top") — a zone's own
  // title now floats ABOVE its frame (ProjectGroupNode.tsx's
  // canvas-zone-header), so the ROW-TO-ROW gap the auto-packer leaves
  // between two STACKED zones must be wide enough that a title floating
  // above the lower zone can never reach the upper zone's own bottom edge,
  // at the canvas's real zoom floor — see geometry.ts's ZONE_VERTICAL_GAP
  // doc comment for the worked math.
  //
  // scratch/_canvas-label-design.md §3.2/§3.3 — the real production packing
  // path (reconcilerZones.ts's packAutoPlacedZones) now uses
  // `zoneRowPackGap()`, which is `ZONE_VERTICAL_GAP` itself: bounding the
  // LOD compensation (chrome/lod.ts's `LOD_FLOOR_ZOOM`, 0.25) already
  // shrank that constant from an airtight-at-the-absolute-floor 456 down to
  // 192 — small enough to use directly as the routine packing gap, no
  // separate "practical zoom" evaluation needed any more ("plus de formule
  // au pire cas").
  it('spaces STACKED zone rows apart by exactly ZONE_VERTICAL_GAP (192, not the old airtight-but-oversized 456)', () => {
    // packColumnsForZoneCount(4) is 3 (geometry.ts) — a 4th same-shaped zone
    // (identical single-mission children, so identical computed size)
    // forces a wrap into row 1, directly below zone p0.
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({ projectId: 'p0', missions: [mission({ id: 'm0', title: 'a' })] }),
          project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] }),
          project({ projectId: 'p2', missions: [mission({ id: 'm2', title: 'a' })] }),
          project({ projectId: 'p3', missions: [mission({ id: 'm3', title: 'a' })] }),
        ],
      }),
    );
    const row0Zone = findNode(nodes, makeRef('project', 'p0'));
    const row1Zone = findNode(nodes, makeRef('project', 'p3'));
    expect(row1Zone.position.y).toBe(row0Zone.position.y + (row0Zone.height ?? 0) + zoneRowPackGap());
    expect(zoneRowPackGap()).toBe(ZONE_VERTICAL_GAP);
    // Meaningfully smaller than the old airtight-at-the-absolute-floor value
    // — proves the packer isn't accidentally still using the bigger number.
    expect(zoneRowPackGap()).toBeLessThan(456);
  });
});

// ── Full-card sizing (spec CRITICAL 2/3 — W6b geometry fix wave) ─────

describe('reconcile — full-card node sizing (spec CRITICAL 2/3)', () => {
  it('gives every mission/loop/schedule/draft child the same fixed full-card footprint used by nodeChrome.tsx', () => {
    const missionLoopMeta = new Map<string, MissionLoopMeta>([
      ['loop1', { loopConfig: { cadence: '1h', stopCondition: { kind: 'manual' }, enabled: true, iterationCount: 0, iterationMissionIds: [] } }],
    ]);
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' }), mission({ id: 'loop1', title: 'b' })] })],
        drafts: [{ id: 'd1', title: 'T', task: 'x', createdBy: 'user', projectId: 'p1' }],
        scheduled: [{ scheduleId: 's1', agentName: 'a', cron: '0 9 * * *', cronLabel: '9h', enabled: true, projectId: 'p1' }],
        missionLoopMeta,
      }),
    );
    for (const ref of [makeRef('mission', 'm1'), makeRef('loop', 'loop1'), makeRef('draft', 'd1'), makeRef('schedule', 's1')]) {
      const node = findNode(nodes, ref);
      expect(node.width).toBe(FULL_CARD_WIDTH);
      expect(node.height).toBe(FULL_CARD_MAX_HEIGHT);
    }
  });

  it("sizes a zone's bounding box to cover every child's full-card footprint (never smaller than the real rendered card)", () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
      }),
    );
    const zone = findNode(nodes, makeRef('project', 'p1'));
    const child = findNode(nodes, makeRef('mission', 'm1'));
    // The single child sits at (ZONE_PADDING, ZONE_HEADER_HEIGHT) — the
    // zone must be at least that far plus the card's own full width/height
    // plus the right/bottom padding, i.e. strictly wider/taller than the
    // card itself never merely equal to it (spec CRITICAL 3).
    expect(zone.width!).toBeGreaterThanOrEqual(child.position.x + (child.width ?? 0));
    expect(zone.height!).toBeGreaterThanOrEqual(child.position.y + (child.height ?? 0));
  });
});

// ── Lane mode zone widening (spec CRITICAL 4 — W6b geometry fix wave) ─

describe('reconcile — lane mode zone widening (spec CRITICAL 4)', () => {
  it('widens a zone to fit 5 full lane columns + gutter when prefs.laneMode is on, even with very few children', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
        prefs: { ...DEFAULT_CANVAS_PREFS, laneMode: true },
      }),
    );
    const zone = findNode(nodes, makeRef('project', 'p1'));
    expect(zone.width!).toBeGreaterThanOrEqual(LANE_MODE_ZONE_WIDTH);
  });

  it('does NOT widen a zone past its real bounding box when laneMode is off', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
        prefs: { ...DEFAULT_CANVAS_PREFS, laneMode: false },
      }),
    );
    const zone = findNode(nodes, makeRef('project', 'p1'));
    expect(zone.width!).toBeLessThan(LANE_MODE_ZONE_WIDTH);
  });

  it('stamps ProjectNodeData.laneMode from the live prefs so ProjectGroupNode can render lane guides without a separate store read', () => {
    const on = reconcile(
      baseInputs({ projects: [project({ projectId: 'p1' })], prefs: { ...DEFAULT_CANVAS_PREFS, laneMode: true } }),
    );
    const off = reconcile(
      baseInputs({ projects: [project({ projectId: 'p1' })], prefs: { ...DEFAULT_CANVAS_PREFS, laneMode: false } }),
    );
    expect((findNode(on.nodes, makeRef('project', 'p1')).data as ProjectNodeData).laneMode).toBe(true);
    expect((findNode(off.nodes, makeRef('project', 'p1')).data as ProjectNodeData).laneMode).toBe(false);
  });
});

// ── Zone title-width floor (fix/canvas-zone-title-clip) ──────────────

// David's measured repro, round 3 of the floating-title saga: with the
// round-2 "geometric containment" fix live (ProjectGroupNode.tsx's outer
// header clamped to `maxWidth: width` + `overflow: hidden`), all 8 zone
// headers read `uc`, `La`, `uc`, `uc`, `laz`, `La`, `La`, `de` — 2-3
// characters, no ellipsis, every zone indistinguishable. His own
// requirement (verbatim): "a header must never paint outside its zone AND
// must stay identifiable ... the zone's own width has to accommodate a
// usable name at the zoom levels people actually use ... the answer is
// likely in the layout (minimum zone width / how zones are packed)."
//
// STATED EXPECTATION (required before implementing, per David's own
// instruction — "state what you expect the header to read for a zone
// named uc-smoke-2026-08-12 at minimum zoom, and make the test assert
// that"): at ZONE_SPACING_PRACTICAL_ZOOM (0.5) — the SAME "zoom people
// actually use, not the absolute technical floor" tier zoneSameRowPackGap/
// zoneRowPackGap already codify for the identical class of trade-off — a
// zone named "uc-smoke-2026-08-12" (19 characters, under the existing
// 22-char ZONE_TITLE_RESERVED_NAME_CHARS cap) must be packed wide enough
// that its header renders the FULL, untruncated string with NO ellipsis.
// This suite proves the LAYOUT half of that (the zone really does get
// widened to `zoneMinWidthForTitle(name)`); canvasNodes.test.tsx's own
// sibling suite proves the RENDERING half (given a zone this wide, the
// header text is exactly the full name).
describe("reconcile — zone width widens for its own title (fix/canvas-zone-title-clip)", () => {
  it("widens a zone to zoneMinWidthForTitle(name) even with a single small child, when the name needs more room than the child's own bbox", () => {
    const longName = 'uc-smoke-2026-08-12';
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', name: longName, missions: [mission({ id: 'm1', title: 'a' })] })],
      }),
    );
    const zone = findNode(nodes, makeRef('project', 'p1'));
    expect(zone.width!).toBeGreaterThanOrEqual(zoneMinWidthForTitle(longName));
  });

  it('does not widen a zone past what a SHORT name needs — the floor is per-zone, not a flat worst-case applied to every zone', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', name: 'Lazy', missions: [mission({ id: 'm1', title: 'a' })] })],
      }),
    );
    const zone = findNode(nodes, makeRef('project', 'p1'));
    expect(zone.width!).toBeLessThan(ZONE_MIN_WIDTH_FOR_TITLE);
  });

  it('never grows the zone width past its own real bbox once that bbox already exceeds the title-width floor (a busy zone with many children is unaffected)', () => {
    const missions = Array.from({ length: 6 }, (_, i) => mission({ id: `m${i}`, title: 'a' }));
    const { nodes } = reconcile(
      baseInputs({ projects: [project({ projectId: 'p1', name: 'demo-shop', missions })] }),
    );
    const zone = findNode(nodes, makeRef('project', 'p1'));
    // 6 full-card children packed at GRID_CELL_WIDTH apart comfortably
    // exceed the (short-name) title-width floor — the bbox, not the floor,
    // is what actually governs this zone's width.
    expect(zone.width!).toBeGreaterThan(zoneMinWidthForTitle('demo-shop'));
  });
});

// scratch/_canvas-label-design.md §3.3 item 4 ("densité interne des zones")
// — the internal mission grid no longer wraps at a flat 4-columns-always;
// it targets a squat ~1.5 aspect via the SAME `packColumnsForZoneCount`
// formula the zone-level packer uses (geometry.ts), just evaluated at a
// tighter ratio. 6 is a deliberately chosen count where the old fixed-4
// grid and the new aspect-1.5 grid DISAGREE (old: 4 cols, 2 rows — a wide
// 4+2 shelf; new: `round(sqrt(6*1.5)) = round(3) = 3` cols, 2 rows — a
// square 3+3) — proving this is a real behavior change, not a coincidence
// that happens to match at some other count (12, for instance, lands on 4
// cols either way).
describe('reconcile — internal zone density wraps toward ~1.5 aspect, not a flat 4 columns (scratch/_canvas-label-design.md §3.3 item 4)', () => {
  it('6 fresh (unpinned) missions in one zone wrap into 3 columns, not the old flat 4', () => {
    const missions = Array.from({ length: 6 }, (_, i) => mission({ id: `m${i}`, title: 'a' }));
    const { nodes } = reconcile(baseInputs({ projects: [project({ projectId: 'p1', name: 'demo-shop', missions })] }));
    const children = nodes.filter((n) => n.parentId === makeRef('project', 'p1'));
    expect(children).toHaveLength(6);
    const distinctCols = new Set(children.map((c) => Math.round((c.position.x - ZONE_PADDING) / GRID_CELL_WIDTH)));
    expect(distinctCols.size).toBe(packColumnsForZoneCount(6, 1.5)); // 3, not the old flat 4
  });

  it('no two of those 6 auto-placed children overlap (the density change never reintroduces the sibling no-overlap invariant)', () => {
    const missions = Array.from({ length: 6 }, (_, i) => mission({ id: `m${i}`, title: 'a' }));
    const { nodes } = reconcile(baseInputs({ projects: [project({ projectId: 'p1', name: 'demo-shop', missions })] }));
    const children = nodes.filter((n) => n.parentId === makeRef('project', 'p1'));
    for (let i = 0; i < children.length; i += 1) {
      for (let j = i + 1; j < children.length; j += 1) {
        const a = children[i]!;
        const b = children[j]!;
        const overlapsX = a.position.x < b.position.x + b.width! && b.position.x < a.position.x + a.width!;
        const overlapsY = a.position.y < b.position.y + b.height! && b.position.y < a.position.y + a.height!;
        expect(overlapsX && overlapsY).toBe(false);
      }
    }
  });

  it('an existing PERSISTED child position is still never moved by the density change (spec §6 hard requirement)', () => {
    const pinnedRef = makeRef('mission', 'm0');
    const pinnedPos = { x: 9999, y: 9999 };
    const missions = Array.from({ length: 6 }, (_, i) => mission({ id: `m${i}`, title: 'a' }));
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', name: 'demo-shop', missions })],
        positions: { [pinnedRef]: pinnedPos },
      }),
    );
    expect(findNode(nodes, pinnedRef).position).toEqual(pinnedPos);
  });
});

// ── Legacy row-position migration + auto-pack pinned-avoidance
//    (fix/canvas-legacy-row-migration-envelope, fix/canvas-auto-pack-avoid-pinned) ──

// David's round-6 report: with the round-5 title-width floor live,
// `migrateBloatedZoneRowPositions` STILL never fired on his own real,
// months-old profile — "fit" still measured 3767.52 x 880 for 8 zones,
// unchanged. Per his own instruction ("read the real persisted data rather
// than inferring its shape ... it is on this machine"), the ACTUAL data
// was read directly from his `com.lazy.app` profile's
// `canvas/layout.json`. It carries exactly 5 PINNED project zones (matching
// his own live log's `persistedCount 5`):
//   "Lazy" (718,0), "lazy-backoffice" (2607.6,0), "LazySite-internet"
//   (3253.52,0), "Lazy-real-test" (0,656), "debounce" (794.72,656)
// Two rows by shared Y (0 and 656). Row y:0's "Lazy" -> "lazy-backoffice"
// gap is ~1543.6 flow px against a `zoneSameRowPackGap('Lazy')` of only
// ~345.9 (a ~4.5x overspend) — real, unmistakable legacy bloat by this
// file's own existing 3x multiplier — but the OLD `LEGACY_ROW_GAP_
// ABSOLUTE_FLOOR` (2000) sat ABOVE this specific profile's own (smaller,
// intermediate-formula-generation) bloat, so the migration silently passed
// it through. Row y:656's "Lazy-real-test" -> "debounce" gap (~319.7) was
// NEVER bloated — a fresh row.y:0's OWN internal "lazy-backoffice" ->
// "LazySite-internet" gap (~157.9) also was NOT bloated on its own.
const REAL_PINNED_PROJECTS = [
  { projectId: 'p-lazy', name: 'Lazy', x: 718, y: 0 },
  { projectId: 'p-backoffice', name: 'lazy-backoffice', x: 2607.6, y: 0 },
  { projectId: 'p-site', name: 'LazySite-internet', x: 3253.52, y: 0 },
  { projectId: 'p-real-test', name: 'Lazy-real-test', x: 0, y: 656 },
  { projectId: 'p-debounce', name: 'debounce', x: 794.72, y: 656 },
];

function realProfilePositions(): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  for (const p of REAL_PINNED_PROJECTS) positions[makeRef('project', p.projectId)] = { x: p.x, y: p.y };
  return positions;
}

function realProfileProjects(): FleetProject[] {
  return REAL_PINNED_PROJECTS.map((p) => project({ projectId: p.projectId, name: p.name }));
}

describe('reconcile — legacy row-position migration, built from David\'s own REAL profile data (fix/canvas-legacy-row-migration-envelope)', () => {
  it('compacts the bloated "Lazy" -> "lazy-backoffice" gap in row y:0, and CASCADES the same correction to "LazySite-internet" so the row\'s overall span actually shrinks (not just the one internal gap)', () => {
    const { nodes } = reconcile(baseInputs({ projects: realProfileProjects(), positions: realProfilePositions() }));
    const lazy = findNode(nodes, makeRef('project', 'p-lazy'));
    const backoffice = findNode(nodes, makeRef('project', 'p-backoffice'));
    const site = findNode(nodes, makeRef('project', 'p-site'));

    // "Lazy" is the row's own left anchor — untouched.
    expect(lazy.position.x).toBe(718);
    // "lazy-backoffice" compacts to exactly Lazy's right edge + today's
    // practical same-row gap for ITS name.
    const expectedBackofficeX = 718 + lazy.width! + zoneSameRowPackGap('lazy-backoffice');
    expect(backoffice.position.x).toBeCloseTo(expectedBackofficeX, 5);
    // "LazySite-internet" was NEVER independently bloated relative to
    // "lazy-backoffice" (~157.9px gap, well under threshold) — its OWN
    // original relative gap to its neighbour is preserved EXACTLY, just
    // carried forward from the neighbour's new (compacted) position rather
    // than its stale original one.
    const originalGap = 3253.52 - (2607.6 + backoffice.width!);
    const expectedSiteX = expectedBackofficeX + backoffice.width! + originalGap;
    expect(site.position.x).toBeCloseTo(expectedSiteX, 5);

    // The row's overall span (and therefore the whole-canvas bounds) is
    // now meaningfully smaller — this is the actual, user-visible fix:
    // compacting only the flagged pair without cascading left the row's
    // rightmost edge (and therefore "fit"'s own bounding box) unchanged.
    const rightEdge = site.position.x + site.width!;
    expect(rightEdge).toBeLessThan(3253.52 + site.width! - 900); // meaningfully left of the original edge
  });

  it('never touches row y:656 ("Lazy-real-test" -> "debounce") — that gap was never independently bloated', () => {
    const { nodes } = reconcile(baseInputs({ projects: realProfileProjects(), positions: realProfilePositions() }));
    const realTest = findNode(nodes, makeRef('project', 'p-real-test'));
    const debounce = findNode(nodes, makeRef('project', 'p-debounce'));
    expect(realTest.position).toEqual({ x: 0, y: 656 });
    expect(debounce.position).toEqual({ x: 794.72, y: 656 });
  });

  it('shrinks the whole-canvas bounds for this exact real shape from the live-reported 3767.52 down to a materially tighter figure', () => {
    const { nodes } = reconcile(baseInputs({ projects: realProfileProjects(), positions: realProfilePositions() }));
    const zoneNodes = nodes.filter((n) => n.type === 'project');
    const bounds = getNodesBounds(zoneNodes as never);
    expect(bounds.width).toBeLessThan(3000); // was 3767.52 live, unfixed
  });

  it('is idempotent: re-running reconcile() with the corrected positions as the new starting point produces no further correction', () => {
    const positions = realProfilePositions();
    const projects = realProfileProjects();
    const first = reconcile(baseInputs({ projects, positions }));
    expect(Object.keys(first.declutteredPositions).length).toBeGreaterThan(0); // the migration DID correct something
    const settledPositions = { ...positions, ...first.declutteredPositions };
    const second = reconcile(baseInputs({ projects, positions: settledPositions }));
    expect(second.declutteredPositions).toEqual({});
  });
});

// David's same round-6 report, second half of the same live measurement:
// even with the row-gap migration above landed, his FULL profile (5 pinned
// + `freshlyPackedCount: 3` auto-placed zones) still measured ~3771px —
// barely moved. Root cause: `packAutoPlacedZones` always starts its OWN
// shelf-pack at (0, 0), entirely independent of where pinned zones sit —
// with exactly 3 fresh zones (matching `AUTO_PACK_MAX_PER_ROW`), they ALL
// land in row y:0, the SAME row his pinned zones already occupy there. The
// reactive `declutterPinnedZones` nudge then shoves the pinned row far
// enough right to clear them, reproducing the same bloat from a different
// mechanism (see reconcilerZones.ts's `packAutoPlacedZones` doc comment).
describe('reconcile — fresh auto-packed zones avoid a pinned row entirely (fix/canvas-auto-pack-avoid-pinned)', () => {
  it('places 3 fresh (unpinned) zones BELOW the pinned row y:0, not overlapping it — so the reactive pinned-vs-auto declutter nudge never has to shove the pinned row sideways', () => {
    const projects = [
      ...realProfileProjects(),
      project({ projectId: 'fresh-a', name: 'fresh-a' }),
      project({ projectId: 'fresh-b', name: 'fresh-b' }),
      project({ projectId: 'fresh-c', name: 'fresh-c' }),
    ];
    const { nodes } = reconcile(baseInputs({ projects, positions: realProfilePositions() }));
    const lazy = findNode(nodes, makeRef('project', 'p-lazy'));
    // The pinned row's own left anchor is UNCHANGED from its real persisted
    // value — proof the fresh zones never forced a reactive rightward nudge.
    expect(lazy.position.x).toBe(718);

    const freshNodes = ['fresh-a', 'fresh-b', 'fresh-c'].map((id) => findNode(nodes, makeRef('project', id)));
    const pinnedRowBottom = Math.max(
      ...['p-lazy', 'p-backoffice', 'p-site'].map((id) => {
        const n = findNode(nodes, makeRef('project', id));
        return n.position.y + n.height!;
      }),
    );
    for (const fresh of freshNodes) {
      expect(fresh.position.y).toBeGreaterThanOrEqual(pinnedRowBottom);
    }
    expect(findSiblingOverlaps(nodes, new Set())).toEqual([]);
  });

  it('the whole-canvas bounds for the FULL 8-zone real shape (5 pinned + 3 fresh) stays as tight as the 5-pinned-only case — the fresh zones add height, not width', () => {
    const projects = [
      ...realProfileProjects(),
      project({ projectId: 'fresh-a', name: 'fresh-a' }),
      project({ projectId: 'fresh-b', name: 'fresh-b' }),
      project({ projectId: 'fresh-c', name: 'fresh-c' }),
    ];
    const { nodes } = reconcile(baseInputs({ projects, positions: realProfilePositions() }));
    const zoneNodes = nodes.filter((n) => n.type === 'project');
    const bounds = getNodesBounds(zoneNodes as never);
    expect(bounds.width).toBeLessThan(3000);
  });
});

// ── Placement ──────────────────────────────────────────────────────

describe('reconcile — incremental placement', () => {
  it('gives a brand new node a grid slot when no position is stored', () => {
    const { nodes } = reconcile(
      baseInputs({ projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })] }),
    );
    const node = findNode(nodes, makeRef('mission', 'm1'));
    // W-CARDS — row 0 also clears ZONE_TITLE_BAND_HEIGHT (the reserved
    // title-protection gap below the header, geometry.ts's own doc
    // comment), on top of ZONE_HEADER_HEIGHT (36, see R2b chromePlan §5).
    expect(node.position).toEqual({ x: ZONE_PADDING, y: ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT });
  });

  it('never changes the position of a node that already has a stored position', () => {
    const stored = { x: 999, y: 777 };
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
        positions: { [makeRef('mission', 'm1')]: stored },
      }),
    );
    expect(findNode(nodes, makeRef('mission', 'm1')).position).toEqual(stored);
  });

  it('places a second new sibling after the first, never overlapping', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [mission({ id: 'm1', title: 'a' }), mission({ id: 'm2', title: 'b' })],
          }),
        ],
      }),
    );
    const p1 = findNode(nodes, makeRef('mission', 'm1')).position;
    const p2 = findNode(nodes, makeRef('mission', 'm2')).position;
    expect(p1).not.toEqual(p2);
  });

  it('continues incremental placement after an already-positioned sibling instead of overlapping it', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [mission({ id: 'm1', title: 'a' }), mission({ id: 'm2', title: 'b' })],
          }),
        ],
        positions: { [makeRef('mission', 'm1')]: { x: ZONE_PADDING, y: ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT } }, // occupies slot 0
      }),
    );
    const m2 = findNode(nodes, makeRef('mission', 'm2')).position;
    expect(m2).not.toEqual({ x: ZONE_PADDING, y: ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT }); // slot 1, not slot 0 again
  });
});

// ── Zone header running count (fix/canvas-ux R4d defect #6 investigation) ──
//
// R3 dogfood evidence: a project zone's header showed "0 actifs" while a
// mission was genuinely running. Root-caused to `useFleetMissions`/
// `mergeLiveMissions` (src/lib/agents/fleetMissions.ts) — the hook that
// merges the active project's LIVE agentsStore missions over the slower
// journal-snapshot poll BEFORE handing `FleetProject[]` to this reconciler.
// That file is explicitly R4e's owned territory this wave (sibling working
// concurrently on fleetMissions/lib-journal/agentsStore — out of bounds for
// this fix). This is the regression lock for the HALF of the pipeline this
// wave DOES own: `computeZoneLayout`'s `counts.running` (reconcilerZones.ts,
// consumed by nodes/ProjectGroupNode.tsx's header) must always be a PURE,
// FRESH derivation of whatever `zone.missions` `reconcile()` receives THIS
// call — proving there is no separate caching/staleness bug on the
// reconciler side of the boundary. Two independent `reconcile()` calls
// (never memoized against each other) with the SAME project id but
// different mission snapshots — the honest shape a live poll tick takes —
// must each reflect their OWN input, not a stale carry-over.
describe('reconcile — zone header running count reflects the CURRENT missions input (fix/canvas-ux R4d defect #6)', () => {
  it('counts.running is 0 with no running missions, then reflects a freshly-started one on the very next reconcile call', () => {
    const idleInputs = baseInputs({
      projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'Queued task', status: 'queued' })] })],
    });
    const idle = reconcile(idleInputs);
    const idleProject = findNode(idle.nodes, makeRef('project', 'p1')).data as unknown as ProjectNodeData;
    expect(idleProject.counts.running).toBe(0);

    // Same project id, a NEW missions snapshot where that same mission is
    // now running (the merged-live-read-model shape mergeLiveMissions
    // produces upstream) — a brand-new `reconcile()` call, never reusing
    // the previous one's cached result.
    const runningInputs = baseInputs({
      projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'Queued task', status: 'running' })] })],
    });
    const running = reconcile(runningInputs);
    const runningProject = findNode(running.nodes, makeRef('project', 'p1')).data as unknown as ProjectNodeData;
    expect(runningProject.counts.running).toBe(1);
  });

  it('counts.running always matches the SAME missions array the mission cards themselves are built from (never a second, divergent source)', () => {
    const missions: FleetMission[] = [
      mission({ id: 'm1', title: 'One', status: 'running' }),
      mission({ id: 'm2', title: 'Two', status: 'queued' }),
      mission({ id: 'm3', title: 'Three', status: 'running' }),
    ];
    const { nodes } = reconcile(baseInputs({ projects: [project({ projectId: 'p1', missions })] }));

    const projectData = findNode(nodes, makeRef('project', 'p1')).data as unknown as ProjectNodeData;
    const renderedRunningCards = missions.filter(
      (m) => m.status === 'running' && nodes.some((n) => n.id === makeRef('mission', m.id)),
    );
    expect(projectData.counts.running).toBe(renderedRunningCards.length);
  });
});

// ── Loop aggregation ───────────────────────────────────────────────

describe('reconcile — loop aggregation', () => {
  it('renders a loop-config mission as a loop node, not a plain mission node', () => {
    const missionLoopMeta = new Map<string, MissionLoopMeta>([
      ['loop1', { loopConfig: { cadence: '1h', stopCondition: { kind: 'manual' }, enabled: true, iterationCount: 0, iterationMissionIds: [] } }],
    ]);
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'loop1', title: 'Recurring' })] })],
        missionLoopMeta,
      }),
    );

    expect(nodes.find((n) => n.id === makeRef('mission', 'loop1'))).toBeUndefined();
    const loopNode = findNode(nodes, makeRef('loop', 'loop1'));
    expect(loopNode.type).toBe('loop');
  });

  it('folds loop-iteration children into recentIterations (max 3, most recent first) instead of rendering them standalone', () => {
    const missionLoopMeta = new Map<string, MissionLoopMeta>([
      ['loop1', { loopConfig: { cadence: '1h', stopCondition: { kind: 'manual' }, enabled: true, iterationCount: 4, iterationMissionIds: [] } }],
      ['iter1', { loopParentId: 'loop1', loopIteration: 1 }],
      ['iter2', { loopParentId: 'loop1', loopIteration: 2 }],
      ['iter3', { loopParentId: 'loop1', loopIteration: 3 }],
      ['iter4', { loopParentId: 'loop1', loopIteration: 4 }],
    ]);
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [
              mission({ id: 'loop1', title: 'Recurring' }),
              mission({ id: 'iter1', title: 'Iter 1', status: 'done', stage: 'merged' }),
              mission({ id: 'iter2', title: 'Iter 2', status: 'done', stage: 'merged' }),
              mission({ id: 'iter3', title: 'Iter 3', status: 'done', stage: 'merged' }),
              mission({ id: 'iter4', title: 'Iter 4', status: 'running' }),
            ],
          }),
        ],
        missionLoopMeta,
      }),
    );

    for (const id of ['iter1', 'iter2', 'iter3', 'iter4']) {
      expect(nodes.find((n) => n.id === makeRef('mission', id))).toBeUndefined();
    }
    const loopNode = findNode(nodes, makeRef('loop', 'loop1'));
    const data = loopNode.data as { recentIterations: Array<{ id: string; iteration: number }> };
    expect(data.recentIterations).toHaveLength(3);
    expect(data.recentIterations.map((c) => c.id)).toEqual(['iter4', 'iter3', 'iter2']); // desc by iteration
  });

  it('renders an orphaned loop-iteration mission standalone when its declared parent is absent from the zone', () => {
    const missionLoopMeta = new Map<string, MissionLoopMeta>([['iter1', { loopParentId: 'missing-parent', loopIteration: 1 }]]);
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'iter1', title: 'Orphan iteration' })] })],
        missionLoopMeta,
      }),
    );
    expect(findNode(nodes, makeRef('mission', 'iter1'))).toBeDefined();
  });
});

// ── hideMerged ─────────────────────────────────────────────────────

describe('reconcile — hideMerged pref', () => {
  it('filters out a merged mission when hideMerged is true', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'done', status: 'done', stage: 'merged' })] })],
        prefs: { ...DEFAULT_CANVAS_PREFS, hideMerged: true },
      }),
    );
    expect(nodes.find((n) => n.id === makeRef('mission', 'm1'))).toBeUndefined();
  });

  it('keeps a merged mission when hideMerged is false', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'done', status: 'done', stage: 'merged' })] })],
        prefs: { ...DEFAULT_CANVAS_PREFS, hideMerged: false },
      }),
    );
    expect(findNode(nodes, makeRef('mission', 'm1'))).toBeDefined();
  });
});

// ── R13 — mission lifecycle (archived) ──────────────────────────────
// "Archiver" hides a terminal mission from the LIVE canvas via the additive
// Mission.archived flag — this is the ONE place the reconciler filters it
// out. Never destroys anything: Replay/Rapport/history read the journal
// directly (missions_current), not this reconciled node list, so an
// archived mission is unaffected there — see Mission.archived's doc comment
// (lib/agents/types.ts) and reconciler.ts's own comment at this filter.

describe('reconcile — archived mission filtering (R13)', () => {
  it('filters out an archived mission from the live canvas node set', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [mission({ id: 'm1', title: 'done and archived', status: 'done', archived: true })],
          }),
        ],
      }),
    );
    expect(nodes.find((n) => n.id === makeRef('mission', 'm1'))).toBeUndefined();
  });

  it('keeps a non-archived terminal mission (default behavior unchanged)', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [mission({ id: 'm1', title: 'done, not archived', status: 'done' })],
          }),
        ],
      }),
    );
    expect(findNode(nodes, makeRef('mission', 'm1'))).toBeDefined();
  });

  it('an archived mission does not affect its sibling non-archived missions in the same zone', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [
              mission({ id: 'm1', title: 'archived', status: 'done', archived: true }),
              mission({ id: 'm2', title: 'still visible', status: 'running' }),
            ],
          }),
        ],
      }),
    );
    expect(nodes.find((n) => n.id === makeRef('mission', 'm1'))).toBeUndefined();
    expect(findNode(nodes, makeRef('mission', 'm2'))).toBeDefined();
  });
});

// ── W-DISMISS — mission lifecycle (dismissedRefs) ───────────────────
// "Retirer du canvas" / "Masquer" (CanvasContextMenu.tsx) hides a mission
// from the LIVE canvas via canvasStore's additive `dismissedRefs` slice —
// filtered alongside `!m.archived` above (same honesty rule: never touches
// the underlying Mission record, only this reconciled node list).

describe('reconcile — dismissed mission filtering (W-DISMISS)', () => {
  it('filters out a mission whose ref is in dismissedRefs', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [mission({ id: 'm1', title: 'dismissed', status: 'done' })],
          }),
        ],
        dismissedRefs: new Set([makeRef('mission', 'm1')]),
      }),
    );
    expect(nodes.find((n) => n.id === makeRef('mission', 'm1'))).toBeUndefined();
  });

  it('keeps a non-dismissed mission (default behavior unchanged)', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [mission({ id: 'm1', title: 'not dismissed', status: 'done' })],
          }),
        ],
      }),
    );
    expect(findNode(nodes, makeRef('mission', 'm1'))).toBeDefined();
  });

  it('a dismissed mission does not affect its sibling non-dismissed missions in the same zone', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [
              mission({ id: 'm1', title: 'dismissed', status: 'running' }),
              mission({ id: 'm2', title: 'still visible', status: 'running' }),
            ],
          }),
        ],
        dismissedRefs: new Set([makeRef('mission', 'm1')]),
      }),
    );
    expect(nodes.find((n) => n.id === makeRef('mission', 'm1'))).toBeUndefined();
    expect(findNode(nodes, makeRef('mission', 'm2'))).toBeDefined();
  });

  it('filters a dismissed mission even while it renders as a loop node (kind-agnostic ref)', () => {
    const missionLoopMeta = new Map<string, MissionLoopMeta>([
      ['loop1', { loopConfig: { cadence: '1h', stopCondition: { kind: 'manual' }, enabled: true, iterationCount: 0, iterationMissionIds: [] } }],
    ]);
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [mission({ id: 'loop1', title: 'a loop', status: 'running' })],
          }),
        ],
        missionLoopMeta,
        dismissedRefs: new Set([makeRef('mission', 'loop1')]),
      }),
    );
    expect(nodes.find((n) => n.id === makeRef('loop', 'loop1'))).toBeUndefined();
    expect(nodes.find((n) => n.id === makeRef('mission', 'loop1'))).toBeUndefined();
  });
});

// ── Edges ──────────────────────────────────────────────────────────

describe('reconcile — hierarchy edges', () => {
  it('creates a hierarchy edge from a sub-mission to its parent when both are rendered', () => {
    const missionLoopMeta = new Map<string, MissionLoopMeta>([['child1', { parentMissionId: 'parent1' }]]);
    const { edges } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [mission({ id: 'parent1', title: 'Orchestrator' }), mission({ id: 'child1', title: 'Sub' })],
          }),
        ],
        missionLoopMeta,
      }),
    );
    const hierarchyEdge = edges.find((e) => e.type === 'hierarchy');
    expect(hierarchyEdge).toMatchObject({ source: makeRef('mission', 'parent1'), target: makeRef('mission', 'child1') });
  });

  it('an orchestrator mission with two sub-missions yields 2 hierarchy edges, and every sub-mission sits in the SAME zone as its parent (spec §4.2 "sub-missions render as child nodes ... in the same zone", W5a #6)', () => {
    const missionLoopMeta = new Map<string, MissionLoopMeta>([
      ['child1', { parentMissionId: 'parent1' }],
      ['child2', { parentMissionId: 'parent1' }],
    ]);
    const { nodes, edges } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [
              mission({ id: 'parent1', title: 'Orchestrator' }),
              mission({ id: 'child1', title: 'Sub A' }),
              mission({ id: 'child2', title: 'Sub B' }),
            ],
          }),
        ],
        missionLoopMeta,
      }),
    );

    const hierarchyEdges = edges.filter((e) => e.type === 'hierarchy');
    expect(hierarchyEdges).toHaveLength(2);
    expect(hierarchyEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: makeRef('mission', 'parent1'), target: makeRef('mission', 'child1') }),
        expect.objectContaining({ source: makeRef('mission', 'parent1'), target: makeRef('mission', 'child2') }),
      ]),
    );

    // Same zone: every node (parent + both sub-missions) shares the SAME
    // parentId — the project zone, never a separate sub-zone/child grouping.
    const projectRef = makeRef('project', 'p1');
    expect(findNode(nodes, makeRef('mission', 'parent1')).parentId).toBe(projectRef);
    expect(findNode(nodes, makeRef('mission', 'child1')).parentId).toBe(projectRef);
    expect(findNode(nodes, makeRef('mission', 'child2')).parentId).toBe(projectRef);
  });

  it('omits a hierarchy edge when the parent mission is not rendered (e.g. hidden by hideMerged)', () => {
    const missionLoopMeta = new Map<string, MissionLoopMeta>([['child1', { parentMissionId: 'parent1' }]]);
    const { edges } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [
              mission({ id: 'parent1', title: 'Orchestrator', status: 'done', stage: 'merged' }),
              mission({ id: 'child1', title: 'Sub' }),
            ],
          }),
        ],
        missionLoopMeta,
        prefs: { ...DEFAULT_CANVAS_PREFS, hideMerged: true },
      }),
    );
    expect(edges.find((e) => e.type === 'hierarchy')).toBeUndefined();
  });
});

describe('reconcile — chain edges and tombstones', () => {
  it('creates a normal chain edge when both endpoints resolve', () => {
    const chains: Chain[] = [
      { id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'success', createdBy: 'user' },
    ];
    const { edges } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
        drafts: [{ id: 'd1', title: 'T', task: 'x', createdBy: 'user', projectId: 'p1' }],
        chains,
      }),
    );
    const edge = edges.find((e) => e.id === 'c1');
    expect(edge).toBeDefined();
    expect((edge!.data as { tombstone: boolean }).tombstone).toBe(false);
  });

  // Chantier 3 (plan-first canvas) — a chain tagged `proposedPlanId` (a
  // still-pending manager plan proposal's dependsOn edge) surfaces as
  // `data.proposed: true` on the rendered edge, the flag ChainEdge.tsx
  // renders dashed/dimmed. An untagged chain never sets it (never `false`
  // — `undefined` per the module's own doc comment, same convention as
  // `firing`/`pinned` right above it).
  it('marks a proposed-plan chain edge with data.proposed — a normal chain never sets the field at all', () => {
    const chains: Chain[] = [
      { id: 'c-proposed', sourceRef: makeRef('draft', 'd1'), targetRef: makeRef('draft', 'd2'), condition: 'success', createdBy: 'manager', proposedPlanId: 'plan-1' },
      { id: 'c-normal', sourceRef: makeRef('draft', 'd1'), targetRef: makeRef('draft', 'd3'), condition: 'success', createdBy: 'user' },
    ];
    const { edges } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [] })],
        drafts: [
          { id: 'd1', title: 'A', task: 'x', createdBy: 'manager', projectId: 'p1', proposedPlanId: 'plan-1' },
          { id: 'd2', title: 'B', task: 'x', createdBy: 'manager', projectId: 'p1', proposedPlanId: 'plan-1' },
          { id: 'd3', title: 'C', task: 'x', createdBy: 'user', projectId: 'p1' },
        ],
        chains,
      }),
    );
    const proposedEdge = edges.find((e) => e.id === 'c-proposed')!;
    const normalEdge = edges.find((e) => e.id === 'c-normal')!;
    expect((proposedEdge.data as { proposed?: boolean }).proposed).toBe(true);
    expect((normalEdge.data as { proposed?: boolean }).proposed).toBeUndefined();
  });

  it('tombstones a chain edge whose target no longer resolves to any rendered node', () => {
    const chains: Chain[] = [
      { id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('mission', 'does-not-exist'), condition: 'always', createdBy: 'user' },
    ];
    const { edges } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
        chains,
      }),
    );
    const edge = edges.find((e) => e.id === 'c1');
    expect((edge!.data as { tombstone: boolean }).tombstone).toBe(true);
  });

  // Defect #9 fix ("tombstone rendering") — a tombstoned chain's edge no
  // longer points at a nonexistent node id (the cause of the "floating
  // crossed chip in the void" QA finding); it collapses to a self-loop on
  // whichever endpoint DID survive, or is dropped when NEITHER did.

  it('a tombstoned chain edge collapses to a self-loop on the surviving endpoint, never a ref to the missing one', () => {
    const chains: Chain[] = [
      { id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('mission', 'does-not-exist'), condition: 'always', createdBy: 'user' },
    ];
    const { edges } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
        chains,
      }),
    );
    const edge = edges.find((e) => e.id === 'c1')!;
    expect(edge.source).toBe(makeRef('mission', 'm1'));
    expect(edge.target).toBe(makeRef('mission', 'm1'));
  });

  it('a tombstoned chain edge with the SOURCE missing collapses onto the surviving target', () => {
    const chains: Chain[] = [
      { id: 'c1', sourceRef: makeRef('mission', 'does-not-exist'), targetRef: makeRef('mission', 'm2'), condition: 'always', createdBy: 'user' },
    ];
    const { edges } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm2', title: 'b' })] })],
        chains,
      }),
    );
    const edge = edges.find((e) => e.id === 'c1')!;
    expect(edge.source).toBe(makeRef('mission', 'm2'));
    expect(edge.target).toBe(makeRef('mission', 'm2'));
    expect((edge.data as { tombstone: boolean }).tombstone).toBe(true);
  });

  it('drops a chain edge entirely when NEITHER endpoint resolves to any rendered node', () => {
    const chains: Chain[] = [
      {
        id: 'c1',
        sourceRef: makeRef('mission', 'gone-1'),
        targetRef: makeRef('mission', 'gone-2'),
        condition: 'always',
        createdBy: 'user',
      },
    ];
    const { edges } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
        chains,
      }),
    );
    expect(edges.find((e) => e.id === 'c1')).toBeUndefined();
  });

  // Ghost-edge repro (2026-08-04 live dogfood: "canvas still renders ~35
  // `ctrl:<from>-><to>` control edges + some legacy `e-N` edges after every
  // draft from an old plan was deleted, 0 drafts rendered") — these ids are
  // exactly what compileOrchestrator.ts's `edgeId()` / the pre-fix `e-${n}`
  // counter mint for a plan's dependency/join-fan-in edges, materialized
  // onto the canvas as ordinary `Chain` records by irToCanvas.ts. Neither id
  // SHAPE is special-cased anywhere in buildChainEdges — this only re-proves
  // the existing "drops when neither endpoint resolves" contract holds for
  // the REAL id scheme a stale plan graph leaves behind, not just the
  // `mission:`-ref fixtures above.
  it('drops an orphaned plan-graph control edge (ctrl: id, draft refs) once both its drafts are gone', () => {
    const chains: Chain[] = [
      { id: 'ctrl:step-1->step-2', sourceRef: makeRef('draft', 'step-1'), targetRef: makeRef('draft', 'step-2'), condition: 'always', createdBy: 'manager' },
      { id: 'e-3', sourceRef: makeRef('draft', 'step-2'), targetRef: makeRef('draft', 'step-3'), condition: 'always', createdBy: 'manager' },
    ];
    const { edges } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [] })],
        drafts: [], // every draft from the old plan was already deleted
        chains,
      }),
    );
    expect(edges.find((e) => e.id === 'ctrl:step-1->step-2')).toBeUndefined();
    expect(edges.find((e) => e.id === 'e-3')).toBeUndefined();
  });

  it('keeps an orphaned control edge fully intact when both its drafts are still rendered', () => {
    const chains: Chain[] = [
      { id: 'ctrl:step-1->step-2', sourceRef: makeRef('draft', 'step-1'), targetRef: makeRef('draft', 'step-2'), condition: 'always', createdBy: 'manager' },
    ];
    const { edges } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [] })],
        drafts: [
          { id: 'step-1', title: 'A', task: 'x', createdBy: 'manager', projectId: 'p1' },
          { id: 'step-2', title: 'B', task: 'x', createdBy: 'manager', projectId: 'p1' },
        ],
        chains,
      }),
    );
    const edge = edges.find((e) => e.id === 'ctrl:step-1->step-2');
    expect(edge).toBeDefined();
    expect((edge!.data as { tombstone: boolean }).tombstone).toBe(false);
  });

  it('carries the condition and disabled flag through onto the edge data', () => {
    const chains: Chain[] = [
      { id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('mission', 'm2'), condition: 'fail', createdBy: 'manager', disabled: true },
    ];
    const { edges } = reconcile(
      baseInputs({
        projects: [
          project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' }), mission({ id: 'm2', title: 'b' })] }),
        ],
        chains,
      }),
    );
    const edge = edges.find((e) => e.id === 'c1');
    expect(edge!.data).toMatchObject({ condition: 'fail', disabled: true, tombstone: false });
  });
});

// ── Firing (W3, chainEngine.ts's Chain.lastFiredAtMs -> ChainEdgeData.firing) ──

describe('reconcile — chain firing window', () => {
  function chainsWithLastFired(lastFiredAtMs?: number): Chain[] {
    return [
      { id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('mission', 'm2'), condition: 'success', createdBy: 'user', lastFiredAtMs },
    ];
  }

  function reconcileAt(nowMs: number, lastFiredAtMs?: number) {
    return reconcile(
      baseInputs({
        projects: [
          project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' }), mission({ id: 'm2', title: 'b' })] }),
        ],
        chains: chainsWithLastFired(lastFiredAtMs),
        nowMs,
      }),
    );
  }

  it('firing is undefined when lastFiredAtMs is absent', () => {
    const { edges } = reconcileAt(10_000);
    expect((edges.find((e) => e.id === 'c1')!.data as { firing?: boolean }).firing).toBeUndefined();
  });

  it('firing is true within the 4s window after lastFiredAtMs', () => {
    const { edges } = reconcileAt(10_000, 8_000); // 2s ago
    expect((edges.find((e) => e.id === 'c1')!.data as { firing?: boolean }).firing).toBe(true);
  });

  it('firing is true at the instant of firing (delta 0)', () => {
    const { edges } = reconcileAt(10_000, 10_000);
    expect((edges.find((e) => e.id === 'c1')!.data as { firing?: boolean }).firing).toBe(true);
  });

  it('firing turns falsy again once the 4s window elapses', () => {
    const { edges } = reconcileAt(10_000, 5_000); // 5s ago — past the 4s window
    expect((edges.find((e) => e.id === 'c1')!.data as { firing?: boolean }).firing).toBeUndefined();
  });

  it('defaults nowMs to Date.now() when omitted (real-caller ergonomics)', () => {
    const now = Date.now();
    const { edges } = reconcile(
      baseInputs({
        projects: [
          project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' }), mission({ id: 'm2', title: 'b' })] }),
        ],
        chains: chainsWithLastFired(now),
        // nowMs intentionally omitted
      }),
    );
    expect((edges.find((e) => e.id === 'c1')!.data as { firing?: boolean }).firing).toBe(true);
  });
});

// ── Referential stability ──────────────────────────────────────────

describe('reconcile — referential data stability', () => {
  it('reuses the same data object reference when the underlying mission fact is unchanged', () => {
    const inputs = baseInputs({
      projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a', updatedMs: 1000 })] })],
    });
    const first = reconcile(inputs);
    const second = reconcile({ ...inputs, prevNodes: first.nodes });

    const firstData = findNode(first.nodes, makeRef('mission', 'm1')).data;
    const secondData = findNode(second.nodes, makeRef('mission', 'm1')).data;
    expect(secondData).toBe(firstData);
  });

  it('produces a NEW data object reference when the underlying mission fact changes', () => {
    const inputs = baseInputs({
      projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a', updatedMs: 1000, status: 'running' })] })],
    });
    const first = reconcile(inputs);

    const changedInputs = baseInputs({
      projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a', updatedMs: 2000, status: 'done' })] })],
      prevNodes: first.nodes,
    });
    const second = reconcile(changedInputs);

    const firstData = findNode(first.nodes, makeRef('mission', 'm1')).data;
    const secondData = findNode(second.nodes, makeRef('mission', 'm1')).data;
    expect(secondData).not.toBe(firstData);
  });

  it('keeps project node data stable across reconciles when counts are unchanged', () => {
    const inputs = baseInputs({
      projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
    });
    const first = reconcile(inputs);
    const second = reconcile({ ...inputs, prevNodes: first.nodes });

    expect(findNode(second.nodes, makeRef('project', 'p1')).data).toBe(findNode(first.nodes, makeRef('project', 'p1')).data);
  });

  // W-CAMERA (defect: fitView-never-moves) — the WHOLE node object, not just
  // `data`, must stay referentially stable across a no-op reconcile, so
  // React Flow's own `adoptUserNodes` identity fast-path (`userNode ===
  // internals.userNode`) recognizes it and keeps `measured`/`handleBounds`
  // instead of wiping them on every ~30s poll.

  it('reuses the same mission node object reference across a no-op reconcile', () => {
    const inputs = baseInputs({
      projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a', updatedMs: 1000 })] })],
    });
    const first = reconcile(inputs);
    const second = reconcile({ ...inputs, prevNodes: first.nodes });

    expect(findNode(second.nodes, makeRef('mission', 'm1'))).toBe(findNode(first.nodes, makeRef('mission', 'm1')));
  });

  it('reuses the same project (zone) node object reference across a no-op reconcile', () => {
    const inputs = baseInputs({
      projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
    });
    const first = reconcile(inputs);
    const second = reconcile({ ...inputs, prevNodes: first.nodes });

    expect(findNode(second.nodes, makeRef('project', 'p1'))).toBe(findNode(first.nodes, makeRef('project', 'p1')));
  });

  it('produces a NEW mission node object reference when the mission fact actually changes', () => {
    const inputs = baseInputs({
      projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a', updatedMs: 1000, status: 'running' })] })],
    });
    const first = reconcile(inputs);

    const changedInputs = baseInputs({
      projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a', updatedMs: 2000, status: 'done' })] })],
      prevNodes: first.nodes,
    });
    const second = reconcile(changedInputs);

    expect(findNode(second.nodes, makeRef('mission', 'm1'))).not.toBe(findNode(first.nodes, makeRef('mission', 'm1')));
  });

  it('produces a NEW mission node object reference when its position changes (drag), even though `data` is unchanged', () => {
    const inputs = baseInputs({
      projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a', updatedMs: 1000 })] })],
    });
    const first = reconcile(inputs);
    const missionRef = makeRef('mission', 'm1');

    const draggedInputs = baseInputs({
      projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a', updatedMs: 1000 })] })],
      positions: { [missionRef]: { x: 999, y: 999 } },
      prevNodes: first.nodes,
    });
    const second = reconcile(draggedInputs);

    const firstNode = findNode(first.nodes, missionRef);
    const secondNode = findNode(second.nodes, missionRef);
    expect(secondNode).not.toBe(firstNode);
    // `data` itself is still unchanged/reused — only the whole-node identity
    // differs, because `position` (not `data`) is what actually changed.
    expect(secondNode.data).toBe(firstNode.data);
    expect(secondNode.position).toEqual({ x: 999, y: 999 });
  });
});

// ── Living surfaces (fix/canvas-ux R7) ────────────────────────────────
//
// terminal/preview nodes are fully canvas-owned (no read-model fact — see
// canvasTypes.ts's SurfaceSpec doc comment), so they slot into the SAME
// zone-children / transverse-fallback / edge-building pipeline drafts/notes/
// routers already use, with their own default footprint
// (reconcilerZones.ts's TERMINAL_NODE_SIZE/PREVIEW_NODE_SIZE).

describe('reconcile — living surfaces (R7)', () => {
  it('emits a terminal node nested under its owning project zone, at the default footprint', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1' })],
        surfaces: [{ id: 's1', kind: 'terminal', projectId: 'p1', cwd: '/repo' }],
      }),
    );
    const node = findNode(nodes, makeRef('terminal', 's1'));
    expect(node.type).toBe('terminal');
    expect(node.parentId).toBe(makeRef('project', 'p1'));
    expect(node.data).toEqual({ id: 's1', kind: 'terminal', projectId: 'p1', cwd: '/repo' });
  });

  it('emits a preview node using its OWN resized footprint, not the default, when SurfaceSpec.width/height is set', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1' })],
        surfaces: [{ id: 's1', kind: 'preview', projectId: 'p1', url: 'http://localhost:3000', width: 700, height: 500 }],
      }),
    );
    const node = findNode(nodes, makeRef('preview', 's1'));
    expect(node.width).toBe(700);
    expect(node.height).toBe(500);
  });

  it('falls back to the Transverse zone for a surface with no projectId', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1' })],
        surfaces: [{ id: 's1', kind: 'terminal' }],
      }),
    );
    const node = findNode(nodes, makeRef('terminal', 's1'));
    expect(node.parentId).toBe(makeRef('project', TRANSVERSE_PROJECT_ID));
  });

  it('draws a dotted surface-edge from a surface\'s ownerRef to itself, when both are rendered', () => {
    const { edges } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
        surfaces: [{ id: 's1', kind: 'terminal', projectId: 'p1', ownerRef: makeRef('mission', 'm1') }],
      }),
    );
    const edge = edges.find((e) => e.id === `surface:${makeRef('mission', 'm1')}:s1`);
    expect(edge).toBeDefined();
    expect(edge!.type).toBe('hierarchy');
    expect(edge!.source).toBe(makeRef('mission', 'm1'));
    expect(edge!.target).toBe(makeRef('terminal', 's1'));
  });

  it('never emits a surface-edge when ownerRef points at a mission that never rendered (never a floating/broken edge)', () => {
    const { nodes, edges } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1' })],
        surfaces: [{ id: 's1', kind: 'terminal', projectId: 'p1', ownerRef: makeRef('mission', 'ghost') }],
      }),
    );
    expect(findNode(nodes, makeRef('terminal', 's1'))).toBeDefined(); // the surface itself still renders standalone
    expect(edges.find((e) => e.id.startsWith('surface:'))).toBeUndefined();
  });

  it('omits the surface-edge entirely for a surface with no ownerRef (standalone terminal/preview)', () => {
    const { edges } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1' })],
        surfaces: [{ id: 's1', kind: 'preview', projectId: 'p1' }],
      }),
    );
    expect(edges.find((e) => e.id.startsWith('surface:'))).toBeUndefined();
  });
});

// Preview-surface-correctness fix — "a persisted, sane position tethered to
// its owning mission" (founder brief): a FRESH terminal/preview surface with
// a resolvable ownerRef is placed immediately right of its owner instead of
// the generic grid-slot queue every unrelated child uses, and that position
// is persisted (via `declutteredPositions`) on the very reconcile it is
// first computed — never silently re-drifted every render.
describe('reconcile — living surfaces (R7) — tethered position (preview-surface-correctness fix)', () => {
  it('tethers a FRESH surface immediately right of its ownerRef\'s box, same y, and persists it', () => {
    const { nodes, declutteredPositions } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
        surfaces: [{ id: 's1', kind: 'preview', projectId: 'p1', url: 'http://localhost:3000', ownerRef: makeRef('mission', 'm1') }],
      }),
    );
    const missionNode = findNode(nodes, makeRef('mission', 'm1'));
    const previewNode = findNode(nodes, makeRef('preview', 's1'));
    const previewRef = makeRef('preview', 's1');

    expect(previewNode.position.y).toBe(missionNode.position.y);
    expect(previewNode.position.x).toBe(missionNode.position.x + (missionNode.width ?? 0) + 40);
    // Persisted on this SAME reconcile — the caller (useCanvasFlowGraph.ts)
    // writes declutteredPositions straight back into canvasStore, so a
    // surface only ever needs tethering ONCE.
    expect(declutteredPositions[previewRef]).toEqual(previewNode.position);
  });

  it('never re-tethers a surface that already has a persisted position — a user-dragged spot always wins', () => {
    const previewRef = makeRef('preview', 's1');
    const { nodes, declutteredPositions } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
        surfaces: [{ id: 's1', kind: 'preview', projectId: 'p1', url: 'http://localhost:3000', ownerRef: makeRef('mission', 'm1') }],
        positions: { [previewRef]: { x: 5000, y: 5000 } },
      }),
    );
    expect(findNode(nodes, previewRef).position).toEqual({ x: 5000, y: 5000 });
    expect(declutteredPositions[previewRef]).toBeUndefined();
  });

  it('falls back to the generic grid-slot placement (untethered, unpersisted) when ownerRef never resolves to a rendered child', () => {
    const previewRef = makeRef('preview', 's1');
    const { nodes, declutteredPositions } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1' })],
        surfaces: [{ id: 's1', kind: 'preview', projectId: 'p1', url: 'http://localhost:3000', ownerRef: makeRef('mission', 'ghost') }],
      }),
    );
    expect(findNode(nodes, previewRef)).toBeDefined(); // still renders, just not tethered
    expect(declutteredPositions[previewRef]).toBeUndefined();
  });

  it('never tethers a surface with no ownerRef at all (standalone) — same untouched fallback as before this fix', () => {
    const previewRef = makeRef('preview', 's1');
    const { declutteredPositions } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
        surfaces: [{ id: 's1', kind: 'preview', projectId: 'p1', url: 'http://localhost:3000' }],
      }),
    );
    expect(declutteredPositions[previewRef]).toBeUndefined();
  });
});

// ── Canvas Groups / frames (W-CLOSE row 2) ────────────────────────────
//
// A frame is fully canvas-owned (no read-model fact — canvasTypes.ts's
// FrameSpec doc comment) and purely visual: it renders nested under its
// zone like every other child, but deliberately OUTSIDE the bbox-sizing/
// collision-resolution pipeline (reconcilerZones.ts's `buildFrameNodes`,
// called separately from `collectZoneChildren`).

describe('reconcile — frames / Canvas Groups (W-CLOSE row 2)', () => {
  it('emits a frame node nested under its owning project zone, rendered behind everything (negative zIndex)', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1' })],
        frames: [{ id: 'f1', projectId: 'p1', title: 'Group A', width: 400, height: 300 }],
      }),
    );
    const node = findNode(nodes, makeRef('frame', 'f1'));
    expect(node.type).toBe('frame');
    expect(node.parentId).toBe(makeRef('project', 'p1'));
    expect(node.width).toBe(400);
    expect(node.height).toBe(300);
    expect(node.zIndex).toBeLessThan(0);
    expect(node.data).toEqual({ id: 'f1', projectId: 'p1', title: 'Group A', width: 400, height: 300 });
  });

  it('falls back to the Transverse zone for a frame with no projectId', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1' })],
        frames: [{ id: 'f1', title: 'Transverse group', width: 200, height: 150 }],
      }),
    );
    const node = findNode(nodes, makeRef('frame', 'f1'));
    expect(node.parentId).toBe(makeRef('project', TRANSVERSE_PROJECT_ID));
  });

  it('never grows the zone bbox — a frame far larger than every real child does not resize the project node', () => {
    const withoutFrame = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
      }),
    );
    const withFrame = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
        frames: [{ id: 'f1', projectId: 'p1', title: 'Huge group', width: 5000, height: 5000 }],
      }),
    );
    const zoneWithout = findNode(withoutFrame.nodes, makeRef('project', 'p1'));
    const zoneWith = findNode(withFrame.nodes, makeRef('project', 'p1'));
    expect(zoneWith.width).toBe(zoneWithout.width);
    expect(zoneWith.height).toBe(zoneWithout.height);
  });

  it('never participates in collision resolution — a frame may overlap a real sibling (purely visual, no reflow)', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] })],
        frames: [{ id: 'f1', projectId: 'p1', title: 'Overlapping group', width: 400, height: 300 }],
        positions: {
          [makeRef('mission', 'm1')]: { x: 10, y: 10 },
          [makeRef('frame', 'f1')]: { x: 0, y: 0 }, // deliberately overlaps the mission above
        },
      }),
    );
    const mNode = findNode(nodes, makeRef('mission', 'm1'));
    const fNode = findNode(nodes, makeRef('frame', 'f1'));
    // Both kept their EXACT persisted positions — neither was nudged away
    // from the other, unlike two real (ChildCandidate) siblings would be.
    expect(mNode.position).toEqual({ x: 10, y: 10 });
    expect(fNode.position).toEqual({ x: 0, y: 0 });
  });

  it('is absent from the collapsed-zone render (children hidden entirely, frames included)', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1' })],
        frames: [{ id: 'f1', projectId: 'p1', title: 'Group', width: 200, height: 150 }],
        collapsed: { p1: true },
      }),
    );
    expect(nodes.find((n) => n.id === makeRef('frame', 'f1'))).toBeUndefined();
  });
});

// ── Sibling no-overlap invariant (fix/canvas-ux R4a, extended R10) ────
//
// David's rule, verbatim: "le canvas pour chaque projet n'a pas vraiment de
// limite en taille donc AUCUN agent ne doit être superposé ou l'un sur
// l'autre" — zones are unbounded, so two rendered SIBLING nodes (same
// parentId, i.e. same zone) overlapping is never acceptable. This is a
// stricter, PER-CHILD version of the existing "zone packing" property test
// above (which only covers PROJECT-level rects) — see reconcilerZones.ts's
// `computeZoneLayout` (the `resolveCollisions` two-pass fix) for what makes
// this pass.
//
// R10 tightens this further: a PERSISTED position is no longer automatically
// exempt from the invariant just because it's pinned — reconcilerZones.ts's
// `declutterPinnedChildren` now resolves a PINNED x PINNED collision too
// (the more-recently-updated node keeps its spot, the older one is nudged).
// The ONLY remaining exemption is a pair the user is actively dragging THIS
// session (`sessionDraggedIds` — canvasStore's session-dragged set): both
// members of a colliding pair must be session-dragged for the overlap to be
// allowed, matching declutterPinnedOverlaps' "never touch an immovable
// candidate, even against another immovable one" rule.

function siblingRects(nodes: readonly CanvasReactFlowNode[]): Array<Rect & { id: string; parentId: string }> {
  return nodes
    .filter((n): n is CanvasReactFlowNode & { parentId: string } => n.type !== 'project' && n.parentId !== undefined)
    .map((n) => ({ id: n.id, parentId: n.parentId, x: n.position.x, y: n.position.y, width: n.width ?? 0, height: n.height ?? 0 }));
}

/** Every pair of SAME-ZONE sibling rects must be non-overlapping unless BOTH
 *  ids are in `sessionDraggedIds` (a pair the user is actively dragging this
 *  session — declutterPinnedOverlaps' one deliberate exception) — returns
 *  human-readable violation strings (empty array = invariant holds) rather
 *  than a boolean so a failing assertion names exactly which pair/zone
 *  broke. Pass an empty set (the common case in these tests) to assert the
 *  FULL invariant with no exemption at all. */
function findSiblingOverlaps(nodes: readonly CanvasReactFlowNode[], sessionDraggedIds: ReadonlySet<string> = new Set()): string[] {
  const rects = siblingRects(nodes);
  const violations: string[] = [];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (a.parentId !== b.parentId) continue; // not siblings — different zones
      if (sessionDraggedIds.has(a.id) && sessionDraggedIds.has(b.id)) continue; // both actively user-dragged this session — allowed
      if (rectsOverlap(a, b)) violations.push(`${a.id} x ${b.id} in zone ${a.parentId}`);
    }
  }
  return violations;
}

describe('reconcile — sibling no-overlap invariant (fix/canvas-ux R4a)', () => {
  // Deterministic regression case — the EXACT W10 defect shape traced by
  // hand: 3 auto-eligible siblings where ONE is pinned to precisely the
  // pixel `assignChildPositions`' counter-only formula would ALSO hand to a
  // still-auto sibling (existingCount only counts HOW MANY are pinned, never
  // checks WHERE) — reproduced here as a standalone, always-repeatable case
  // rather than relying on the randomized property test alone to catch it.
  it('resolves a pinned mission that lands exactly on the grid slot a still-auto sibling would also compute (the W10 defect shape)', () => {
    const pinnedRef = makeRef('mission', 'm-pinned');
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [
              mission({ id: 'm-auto-1', title: 'a' }),
              mission({ id: 'm-pinned', title: 'b' }),
              mission({ id: 'm-auto-2', title: 'c' }),
            ],
          }),
        ],
        // slot 1 (col1, row0) — exactly where `m-auto-1` (the FIRST auto
        // sibling processed) would otherwise land per the old counter-only
        // formula (existingCount=1 pinned -> first auto gets slot 1).
        positions: { [pinnedRef]: { x: ZONE_PADDING + GRID_CELL_WIDTH, y: ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT } },
      }),
    );
    const pinnedIds = new Set([pinnedRef]);
    expect(findSiblingOverlaps(nodes, pinnedIds)).toEqual([]);
    // The pinned node itself must still be exactly where it was pinned.
    expect(findNode(nodes, pinnedRef).position).toEqual({ x: ZONE_PADDING + GRID_CELL_WIDTH, y: ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT });
  });

  // fix/canvas-ux R7 (living surfaces) — the EXPANDED-PANEL case the task
  // explicitly asks this invariant to cover: a mission's live-panel footprint
  // (520x420, reconcilerZones.ts's LIVE_PANEL_SIZE) is FAR bigger than the
  // default full-card grid slot (260x236 + margin) — an auto-placed sibling
  // whose default-sized slot would have been perfectly clear now lands
  // squarely inside the expanded card's real footprint unless
  // `effectiveChildSize` (reconcilerZones.ts) feeds that real size into the
  // collision-resolution pass, not just `DEFAULT_NODE_SIZE.mission`.
  it('an EXPANDED mission (live-panel footprint) never overlaps the next auto-placed sibling in the same zone', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [
              mission({ id: 'm-expanded', title: 'a' }),
              mission({ id: 'm-auto-1', title: 'b' }),
              mission({ id: 'm-auto-2', title: 'c' }),
            ],
          }),
        ],
        expandedPanels: { [makeRef('mission', 'm-expanded')]: { width: 520, height: 420 } },
      }),
    );
    expect(findSiblingOverlaps(nodes, new Set())).toEqual([]);
    const expandedNode = findNode(nodes, makeRef('mission', 'm-expanded'));
    expect(expandedNode.width).toBe(520);
    expect(expandedNode.height).toBe(420);
  });

  it('an expanded mission that is ALSO user-pinned still keeps every auto sibling clear of its real (expanded) footprint', () => {
    const expandedRef = makeRef('mission', 'm-expanded');
    const { nodes } = reconcile(
      baseInputs({
        projects: [
          project({
            projectId: 'p1',
            missions: [
              mission({ id: 'm-expanded', title: 'a' }),
              mission({ id: 'm-auto-1', title: 'b' }),
            ],
          }),
        ],
        positions: { [expandedRef]: { x: ZONE_PADDING, y: ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT } },
        expandedPanels: { [expandedRef]: { width: 520, height: 420 } },
      }),
    );
    expect(findSiblingOverlaps(nodes, new Set([expandedRef]))).toEqual([]);
  });

  // ── R10: PINNED x PINNED declutter ──────────────────────────────────
  // David's rule extended: a persisted position is preferred, but two
  // persisted-position siblings colliding with EACH OTHER (e.g. two
  // missions from different sessions/runs, both auto-placed-then-persisted
  // onto the same grid slot) is exactly the case pre-R10 `resolveCollisions`
  // never checked (both branches return a "fixed" item untouched — see that
  // function's own doc comment). declutterPinnedChildren
  // (reconcilerZones.ts) now resolves it: the MORE RECENT node (by
  // FleetMission.updatedMs) keeps its spot, the older one is nudged via
  // findFreePosition, and its new position is surfaced on
  // `reconcile(...).declutteredPositions` for the caller to persist.

  describe('R10 — persisted-position declutter', () => {
    it('resolves two PINNED missions at the identical position: the more recently updated one keeps its spot', () => {
      const oldRef = makeRef('mission', 'm-old');
      const newRef = makeRef('mission', 'm-new');
      const samePos = { x: 100, y: 100 };
      const { nodes, declutteredPositions } = reconcile(
        baseInputs({
          projects: [
            project({
              projectId: 'p1',
              missions: [
                mission({ id: 'm-old', title: 'old', updatedMs: 1000 }),
                mission({ id: 'm-new', title: 'new', updatedMs: 5000 }),
              ],
            }),
          ],
          positions: { [oldRef]: samePos, [newRef]: samePos },
        }),
      );

      expect(findSiblingOverlaps(nodes)).toEqual([]);
      // The newer node is untouched — still exactly where it was pinned.
      expect(findNode(nodes, newRef).position).toEqual(samePos);
      // The older node was nudged elsewhere...
      expect(findNode(nodes, oldRef).position).not.toEqual(samePos);
      // ...and its corrected position is surfaced for the caller to persist.
      expect(declutteredPositions[oldRef]).toEqual(findNode(nodes, oldRef).position);
      expect(declutteredPositions[newRef]).toBeUndefined();
    });

    it('breaks a recency tie by config/array order — the first-listed mission keeps its spot', () => {
      const firstRef = makeRef('mission', 'm-first');
      const secondRef = makeRef('mission', 'm-second');
      const samePos = { x: 100, y: 100 };
      const { nodes } = reconcile(
        baseInputs({
          projects: [
            project({
              projectId: 'p1',
              missions: [
                mission({ id: 'm-first', title: 'first', updatedMs: 3000 }),
                mission({ id: 'm-second', title: 'second', updatedMs: 3000 }),
              ],
            }),
          ],
          positions: { [firstRef]: samePos, [secondRef]: samePos },
        }),
      );

      expect(findSiblingOverlaps(nodes)).toEqual([]);
      expect(findNode(nodes, firstRef).position).toEqual(samePos);
      expect(findNode(nodes, secondRef).position).not.toEqual(samePos);
    });

    it('a node with no recency signal (e.g. a note) always loses to a mission at the same pinned position', () => {
      const missionRef = makeRef('mission', 'm1');
      const noteRef = makeRef('note', 'n1');
      const samePos = { x: 100, y: 100 };
      const { nodes } = reconcile(
        baseInputs({
          projects: [project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a', updatedMs: 1 })] })],
          notes: [{ id: 'n1', text: 'note', projectId: 'p1' }],
          positions: { [missionRef]: samePos, [noteRef]: samePos },
        }),
      );

      expect(findSiblingOverlaps(nodes)).toEqual([]);
      expect(findNode(nodes, missionRef).position).toEqual(samePos);
      expect(findNode(nodes, noteRef).position).not.toEqual(samePos);
    });

    it('a session-dragged node is NEVER nudged, even by a much more recently updated pinned sibling', () => {
      const draggedRef = makeRef('mission', 'm-dragged');
      const newerRef = makeRef('mission', 'm-newer');
      const samePos = { x: 100, y: 100 };
      const { nodes, declutteredPositions } = reconcile(
        baseInputs({
          projects: [
            project({
              projectId: 'p1',
              missions: [
                mission({ id: 'm-dragged', title: 'dragged', updatedMs: 1 }),
                mission({ id: 'm-newer', title: 'newer', updatedMs: 999999 }),
              ],
            }),
          ],
          positions: { [draggedRef]: samePos, [newerRef]: samePos },
          sessionDraggedRefs: new Set([draggedRef]),
        }),
      );

      // The session-dragged node keeps its exact spot regardless of recency...
      expect(findNode(nodes, draggedRef).position).toEqual(samePos);
      expect(declutteredPositions[draggedRef]).toBeUndefined();
      // ...the newer-but-not-session-dragged sibling is the one that yields.
      expect(findNode(nodes, newerRef).position).not.toEqual(samePos);
      expect(findSiblingOverlaps(nodes)).toEqual([]);
    });

    it('two session-dragged siblings that collide with each other are left overlapping this session (the one documented exception)', () => {
      const aRef = makeRef('mission', 'm-a');
      const bRef = makeRef('mission', 'm-b');
      const samePos = { x: 100, y: 100 };
      const { nodes, declutteredPositions } = reconcile(
        baseInputs({
          projects: [
            project({
              projectId: 'p1',
              missions: [mission({ id: 'm-a', title: 'a' }), mission({ id: 'm-b', title: 'b' })],
            }),
          ],
          positions: { [aRef]: samePos, [bRef]: samePos },
          sessionDraggedRefs: new Set([aRef, bRef]),
        }),
      );

      expect(findNode(nodes, aRef).position).toEqual(samePos);
      expect(findNode(nodes, bRef).position).toEqual(samePos);
      expect(declutteredPositions).toEqual({});
      // The general invariant tolerates exactly this pair, since BOTH are
      // session-dragged.
      expect(findSiblingOverlaps(nodes, new Set([aRef, bRef]))).toEqual([]);
    });

    it('a three-way pinned collision resolves fully: only the most recent keeps its spot, both others are nudged clear', () => {
      const aRef = makeRef('mission', 'm-a');
      const bRef = makeRef('mission', 'm-b');
      const cRef = makeRef('mission', 'm-c');
      const samePos = { x: 100, y: 100 };
      const { nodes } = reconcile(
        baseInputs({
          projects: [
            project({
              projectId: 'p1',
              missions: [
                mission({ id: 'm-a', title: 'a', updatedMs: 10 }),
                mission({ id: 'm-b', title: 'b', updatedMs: 999 }),
                mission({ id: 'm-c', title: 'c', updatedMs: 20 }),
              ],
            }),
          ],
          positions: { [aRef]: samePos, [bRef]: samePos, [cRef]: samePos },
        }),
      );

      expect(findSiblingOverlaps(nodes)).toEqual([]);
      expect(findNode(nodes, bRef).position).toEqual(samePos);
      expect(findNode(nodes, aRef).position).not.toEqual(samePos);
      expect(findNode(nodes, cRef).position).not.toEqual(samePos);
      expect(findNode(nodes, aRef).position).not.toEqual(findNode(nodes, cRef).position);
    });
  });

  // ── fix/persisted-positions-declutter: ZONE-vs-ZONE PINNED declutter ──
  //
  // Real-data probe finding (product owner, real session screenshots):
  // mission cards became FULL-size at every zoom (commit 1e1adfa removed the
  // chip/dot LOD tiers) but real sessions carry PERSISTED positions saved
  // back when children were smaller — both at the CHILD level (already
  // covered above by R10's declutterPinnedChildren) and at the ZONE level:
  // two projects each with their OWN persisted position can collide once
  // their real full-card bbox outgrows the gap that existed when those
  // positions were saved. Confirmed on real data as an INTER-ZONE overflow
  // (two DIFFERENT projects' cards colliding) — reconcilerZones.ts's
  // `declutterPinnedZones` closes this the same way `declutterPinnedChildren`
  // closes the child-level gap: session-dragged > recency > array order,
  // minimum-displacement nudge via findFreePosition.
  describe('R-ZONE — persisted ZONE-vs-ZONE declutter (inter-zone overflow)', () => {
    it('two PINNED zones whose real (full-card) bboxes collide are decluttered: the newer project keeps its spot', () => {
      const p1Ref = makeRef('project', 'p1');
      const p2Ref = makeRef('project', 'p2');
      // 40px apart — far closer than any real zone's computed width
      // (ZONE_PADDING*2 + FULL_CARD_WIDTH alone is already > 300), so these
      // two zones' bboxes are guaranteed to overlap regardless of exact
      // child count/size — the same shape as the real M47 (project "Lazy")
      // x M53 (project "lazy-backoffice") inter-zone pair the probe found.
      const { nodes } = reconcile(
        baseInputs({
          projects: [
            project({ projectId: 'p1', missions: [mission({ id: 'm47', title: 'older', updatedMs: 1000 })] }),
            project({ projectId: 'p2', missions: [mission({ id: 'm53', title: 'newer', updatedMs: 9000 })] }),
          ],
          positions: { [p1Ref]: { x: 0, y: 0 }, [p2Ref]: { x: 40, y: 0 } },
        }),
      );

      assertNoOverlap(projectZoneRects(nodes));
      // The more-recently-updated project (p2) is untouched...
      expect(findNode(nodes, p2Ref).position).toEqual({ x: 40, y: 0 });
      // ...the older one (p1) is the one nudged clear.
      expect(findNode(nodes, p1Ref).position).not.toEqual({ x: 0, y: 0 });
    });

    it('surfaces the corrected zone position on declutteredPositions for the caller to persist', () => {
      const p1Ref = makeRef('project', 'p1');
      const p2Ref = makeRef('project', 'p2');
      const { declutteredPositions } = reconcile(
        baseInputs({
          projects: [
            project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a', updatedMs: 1 })] }),
            project({ projectId: 'p2', missions: [mission({ id: 'm2', title: 'b', updatedMs: 2 })] }),
          ],
          positions: { [p1Ref]: { x: 0, y: 0 }, [p2Ref]: { x: 40, y: 0 } },
        }),
      );
      expect(declutteredPositions[p1Ref]).toBeDefined();
      expect(declutteredPositions[p2Ref]).toBeUndefined();
    });

    it('two PINNED zones that do NOT collide are left exactly where they were pinned (zero movement)', () => {
      const p1Ref = makeRef('project', 'p1');
      const p2Ref = makeRef('project', 'p2');
      const { nodes, declutteredPositions } = reconcile(
        baseInputs({
          projects: [
            project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] }),
            project({ projectId: 'p2', missions: [mission({ id: 'm2', title: 'b' })] }),
          ],
          positions: { [p1Ref]: { x: 0, y: 0 }, [p2Ref]: { x: 5000, y: 5000 } },
        }),
      );
      expect(findNode(nodes, p1Ref).position).toEqual({ x: 0, y: 0 });
      expect(findNode(nodes, p2Ref).position).toEqual({ x: 5000, y: 5000 });
      expect(declutteredPositions).toEqual({});
    });

    it('two session-dragged PINNED zones colliding with each other are left overlapping this session (documented exception)', () => {
      const p1Ref = makeRef('project', 'p1');
      const p2Ref = makeRef('project', 'p2');
      const { nodes } = reconcile(
        baseInputs({
          projects: [
            project({ projectId: 'p1', missions: [mission({ id: 'm1', title: 'a' })] }),
            project({ projectId: 'p2', missions: [mission({ id: 'm2', title: 'b' })] }),
          ],
          positions: { [p1Ref]: { x: 0, y: 0 }, [p2Ref]: { x: 40, y: 0 } },
          sessionDraggedRefs: new Set([p1Ref, p2Ref]),
        }),
      );
      expect(findNode(nodes, p1Ref).position).toEqual({ x: 0, y: 0 });
      expect(findNode(nodes, p2Ref).position).toEqual({ x: 40, y: 0 });
    });
  });

  // ── Real-data shape: intra-zone mission x draft, ~60 world-units apart ──
  //
  // The real-data probe's other two findings were mission x DRAFT pairs
  // (mission:M46 x draft:draft-...) in the SAME zone — confirming the
  // declutter must cover every child KIND, not just mission x mission.
  // reconcilerZones.ts's declutterPinnedChildren/recencyOfChild already
  // operate over the generic ChildCandidate list (missions/drafts/schedules/
  // notes/routers alike) — this is a regression lock for that, using the
  // exact real-world shape (~60 world-units apart, well inside
  // FULL_CARD_MAX_HEIGHT=236, chip-era spacing that used to be legal).
  describe('R-ZONE — intra-zone mission x draft declutter (real-data shape)', () => {
    it('a PINNED mission and a PINNED draft ~60 world-units apart (legal chip-era spacing) are decluttered under full-card dimensions', () => {
      const missionRef = makeRef('mission', 'm46');
      const draftRef = makeRef('draft', 'draft-612a3179');
      const basePos = { x: ZONE_PADDING, y: ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT };
      const { nodes } = reconcile(
        baseInputs({
          projects: [project({ projectId: 'p1', missions: [mission({ id: 'm46', title: 'a', updatedMs: 5000 })] })],
          drafts: [{ id: 'draft-612a3179', title: 'd', task: 'x', createdBy: 'user', projectId: 'p1' }],
          positions: { [missionRef]: basePos, [draftRef]: { x: basePos.x, y: basePos.y + 60 } },
        }),
      );
      expect(findSiblingOverlaps(nodes)).toEqual([]);
      // The mission (real recency signal) keeps its spot; the draft (no
      // recency signal, recencyOfChild returns 0) is the one nudged.
      expect(findNode(nodes, missionRef).position).toEqual(basePos);
      expect(findNode(nodes, draftRef).position).not.toEqual({ x: basePos.x, y: basePos.y + 60 });
    });
  });

  interface RandomFixture {
    inputs: ReconcileInputs;
    pinnedIds: Set<string>;
    /** R10 — the subset of `pinnedIds` marked session-dragged this pass (the
     *  ONE remaining overlap exemption — see findSiblingOverlaps' doc
     *  comment). */
    sessionDraggedIds: Set<string>;
  }

  /** Seeded randomized fixture generator — mixes missions/drafts/notes/
   *  routers/expanded loops, occasional pinned positions (some DELIBERATELY
   *  aligned to a canonical grid slot, to keep reproducing the W10 defect
   *  shape at random — and now, per R10, occasionally landing TWO pinned
   *  siblings on the exact same slot, to exercise the declutter pass),
   *  randomized mission recency (so the declutter winner varies rather than
   *  always resolving via the array-order tiebreak), occasional
   *  session-dragged marking, laneMode on/off, and a folded orchestrator. */
  function randomFixture(seed: number): RandomFixture {
    const rand = mulberry32(seed);
    const positions: Record<string, { x: number; y: number }> = {};
    const pinnedIds = new Set<string>();
    const sessionDraggedIds = new Set<string>();
    const missionLoopMeta = new Map<string, MissionLoopMeta>();
    const expandedLoops = new Set<string>();
    const foldedOrchestrators = new Set<string>();
    const drafts: DraftSpec[] = [];
    const notes: Array<{ id: string; text: string; projectId?: string }> = [];
    const routers: Array<{ id: string; projectId?: string; branches: Array<{ id: string; label: string; condition: { kind: 'default' } }> }> = [];

    const statuses: FleetMission['status'][] = ['queued', 'running', 'done', 'review', 'failed'];
    const pinSlot = (ref: string): void => {
      const slot = Math.floor(rand() * 8); // deliberately grid-aligned, to keep reproducing W10's exact shape
      const col = slot % 4;
      const row = Math.floor(slot / 4);
      positions[ref] = { x: ZONE_PADDING + col * GRID_CELL_WIDTH, y: ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT + row * GRID_CELL_HEIGHT };
      pinnedIds.add(ref);
      // R10 — occasionally mark this pinned ref session-dragged (the user is
      // actively repositioning it THIS session) — the one candidate the
      // declutter pass must never nudge, even against a collision.
      if (rand() < 0.15) sessionDraggedIds.add(ref);
    };

    const projectCount = 1 + Math.floor(rand() * 3); // 1..3 zones
    const projects: FleetProject[] = [];
    for (let p = 0; p < projectCount; p += 1) {
      const projectId = `zp${p}`;
      const missionCount = 1 + Math.floor(rand() * 6); // 1..6
      const missions: FleetMission[] = [];
      for (let m = 0; m < missionCount; m += 1) {
        const id = `${projectId}-m${m}`;
        const status = statuses[Math.floor(rand() * statuses.length)]!;
        // R10 — randomized recency so the declutter pass's winner varies
        // (rather than every mission sharing mission()'s default updatedMs,
        // which would always resolve via the array-order tiebreak alone).
        const updatedMs = Math.floor(rand() * 1_000_000);
        missions.push(mission({ id, title: `m${m}`, status, updatedMs }));
        if (rand() < 0.25) {
          missionLoopMeta.set(id, {
            loopConfig: { cadence: '1h', stopCondition: { kind: 'manual' }, enabled: true, iterationCount: 3, iterationMissionIds: [] },
          });
          if (rand() < 0.6) expandedLoops.add(id);
          const iterCount = 1 + Math.floor(rand() * 3);
          for (let it = 0; it < iterCount; it += 1) {
            const iterId = `${id}-iter${it}`;
            missions.push(mission({ id: iterId, title: `iter${it}`, status: 'done', stage: 'merged' }));
            missionLoopMeta.set(iterId, { loopParentId: id, loopIteration: it + 1 });
          }
        }
        // R10 — bumped from 0.35 (W10 baseline) so multiple missions land on
        // the SAME grid slot more often, deliberately exercising pinned x
        // pinned declutter (not just pinned-vs-auto) at random.
        if (rand() < 0.45) pinSlot(makeRef('mission', id));
      }
      projects.push(project({ projectId, missions }));

      if (rand() < 0.5) {
        const draftId = `${projectId}-d0`;
        drafts.push({ id: draftId, title: 'draft', task: 'x', createdBy: 'user', projectId });
        if (rand() < 0.3) pinSlot(makeRef('draft', draftId));
      }
      if (rand() < 0.4) notes.push({ id: `${projectId}-n0`, text: 'note', projectId });
      if (rand() < 0.3) {
        routers.push({ id: `${projectId}-r0`, projectId, branches: [{ id: 'b1', label: '1', condition: { kind: 'default' } }] });
      }
      if (rand() < 0.2 && missions.length > 0) foldedOrchestrators.add(missions[0]!.id);
    }

    const laneMode = rand() < 0.5;
    return {
      inputs: baseInputs({
        projects,
        drafts,
        notes,
        routers,
        positions,
        missionLoopMeta,
        expandedLoops,
        foldedOrchestrators,
        prefs: { ...DEFAULT_CANVAS_PREFS, laneMode },
        sessionDraggedRefs: sessionDraggedIds,
      }),
      pinnedIds,
      sessionDraggedIds,
    };
  }

  it('property: 40 randomized seeded fixtures — no two sibling nodes ever intersect under ANY mix (pinned x pinned included), except a pair actively dragged THIS session', () => {
    const failingSeeds: number[] = [];
    for (let seed = 0; seed < 40; seed += 1) {
      const { inputs, sessionDraggedIds } = randomFixture(seed);
      const { nodes } = reconcile(inputs);
      const violations = findSiblingOverlaps(nodes, sessionDraggedIds);
      if (violations.length > 0) failingSeeds.push(seed);
    }
    // Pre-R4a (reconcilerZones.ts's assignChildPositions with no
    // resolveCollisions pass at all), this exact property failed on the
    // majority of these 40 seeds — see the git history of this describe
    // block for that baseline. Pre-R10 (resolveCollisions in place, but
    // pinned x pinned never checked against itself — declutterPinnedChildren
    // did not exist yet), asserting `findSiblingOverlaps(nodes,
    // sessionDraggedIds)` here (i.e. the FULL invariant, not exempting plain
    // pinned x pinned collisions) fails on a meaningful chunk of these seeds
    // too, now that `pinSlot`'s odds were bumped specifically to make two
    // pinned siblings land on the identical grid slot far more often. Proves
    // the pinned x pinned gap R10 closes was pervasive, not a rare corner case.
    expect(failingSeeds).toEqual([]);
  });
});

// ── scheduledAgentsToNodeData ──────────────────────────────────────

function agentDef(overrides: Partial<LazyAgent> & { id: string; name: string }): LazyAgent {
  return {
    displayName: overrides.name,
    description: 'x',
    color: 'violet',
    tags: [],
    systemPrompt: 'x',
    modelTier: 'sonnet',
    triggers: { manual: true },
    scope: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('scheduledAgentsToNodeData', () => {
  it('skips agents with no schedule trigger', () => {
    const agents: StoredAgent[] = [{ agent: agentDef({ id: 'a1', name: 'no-schedule' }), scope: 'user' }];
    expect(scheduledAgentsToNodeData(agents, undefined)).toEqual([]);
  });

  it('maps a scheduled agent to ScheduleNodeData with a formatted cron label', () => {
    const agents: StoredAgent[] = [
      {
        agent: agentDef({ id: 'a1', name: 'nightly', triggers: { manual: true, schedule: { cron: '0 9 * * *', mode: 'local', enabled: true } } }),
        scope: 'user',
      },
    ];
    const [node] = scheduledAgentsToNodeData(agents, undefined);
    expect(node).toMatchObject({ scheduleId: 'a1', agentName: 'nightly', cron: '0 9 * * *', enabled: true });
    expect(node.cronLabel).toBe('Chaque jour a 9h');
  });

  it('assigns projectId from the active project for scope=project, and leaves it undefined for scope=user (Transverse)', () => {
    const schedule = { cron: '0 9 * * *', mode: 'local' as const, enabled: true };
    const agents: StoredAgent[] = [
      { agent: agentDef({ id: 'a1', name: 'proj', triggers: { manual: true, schedule } }), scope: 'project' },
      { agent: agentDef({ id: 'a2', name: 'user', triggers: { manual: true, schedule } }), scope: 'user' },
    ];
    const result = scheduledAgentsToNodeData(agents, 'p1');
    expect(result.find((n) => n.scheduleId === 'a1')?.projectId).toBe('p1');
    expect(result.find((n) => n.scheduleId === 'a2')?.projectId).toBeUndefined();
  });

  it('leaves nextRunMs undefined for a disabled schedule', () => {
    const agents: StoredAgent[] = [
      {
        agent: agentDef({ id: 'a1', name: 'off', triggers: { manual: true, schedule: { cron: '0 9 * * *', mode: 'local', enabled: false } } }),
        scope: 'user',
      },
    ];
    expect(scheduledAgentsToNodeData(agents, undefined)[0].nextRunMs).toBeUndefined();
  });

  it('computes a concrete nextRunMs for an enabled exact-hour cron', () => {
    const nowMs = new Date('2026-01-01T08:00:00.000Z').getTime();
    const agents: StoredAgent[] = [
      {
        agent: agentDef({ id: 'a1', name: 'on', triggers: { manual: true, schedule: { cron: '0 9 * * *', mode: 'local', enabled: true } } }),
        scope: 'user',
      },
    ];
    const [node] = scheduledAgentsToNodeData(agents, undefined, nowMs);
    expect(node.nextRunMs).toBeGreaterThan(nowMs);
  });
});

describe('reconcile — LazyBots zone is distinct from agent project zones', () => {
  it('emits the LazyBots zone even when the roster is empty', () => {
    const { nodes } = reconcile(baseInputs({ bots: [] }));
    const zone = findNode(nodes, makeRef('project', 'lazybots'));
    expect(zone.type).toBe('project');
    expect((zone.data as ProjectNodeData).name).toBe('LazyBots');
    expect(nodes.some((n) => n.type === 'bot')).toBe(false);
  });

  it('does not emit the LazyBots zone when bots is omitted', () => {
    const { nodes } = reconcile(baseInputs());
    expect(nodes.some((n) => n.id === makeRef('project', 'lazybots'))).toBe(false);
  });

  it('places an unpinned LazyBots zone to the left of project zones, not in the void', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', name: 'App' })],
        bots: [],
        positions: { [makeRef('project', 'p1')]: { x: 400, y: 100 } },
      }),
    );
    const zone = findNode(nodes, makeRef('project', 'lazybots'));
    expect(zone.position.x).toBeLessThan(400);
    expect(zone.position.y).toBe(100);
  });

  it('migrates the old (0, -340) default out of the void next to project zones', () => {
    const { nodes } = reconcile(
      baseInputs({
        projects: [project({ projectId: 'p1', name: 'App' })],
        bots: [],
        positions: {
          [makeRef('project', 'p1')]: { x: 400, y: 100 },
          [makeRef('project', 'lazybots')]: { x: 0, y: -340 },
        },
      }),
    );
    const zone = findNode(nodes, makeRef('project', 'lazybots'));
    expect(zone.position).not.toEqual({ x: 0, y: -340 });
    expect(zone.position.x).toBeLessThan(400);
  });
});

describe('reconcile — LazyBot VM window node (botVm)', () => {
  const botConfig = {
    id: 'bot_test1',
    name: 'Checker',
    description: 'd',
    systemPrompt: 'p',
    autonomy: 'supervised' as const,
    capabilities: { browser: true, desktop: true, sandbox: false, maxConcurrentSessions: 1 },
    routines: [],
    profileIds: [],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('emits a botVm node + hierarchy edge only when the bot window is open', () => {
    const { nodes, edges } = reconcile(
      baseInputs({
        bots: [
          { bot: botConfig, status: 'idle', activeRuns: 0 },
          { bot: { ...botConfig, id: 'bot_open', name: 'Open' }, status: 'working', activeRuns: 1, vmOpen: true },
        ],
      }),
    );

    // Closed bot → no botVm node.
    expect(nodes.some((n) => n.id === makeRef('botVm', 'bot_test1'))).toBe(false);
    // Open bot → botVm node with window data + the tether edge.
    const vmNode = findNode(nodes, makeRef('botVm', 'bot_open'));
    expect(vmNode.type).toBe('botVm');
    const data = vmNode.data as Record<string, unknown>;
    expect(data.botId).toBe('bot_open');
    expect(data.botName).toBe('Open');
    expect(typeof data.width).toBe('number');
    const edge = edges.find((e) => e.id === `hierarchy:bot:bot_open:vm`);
    expect(edge).toBeDefined();
    expect(edge?.source).toBe(makeRef('bot', 'bot_open'));
    expect(edge?.target).toBe(makeRef('botVm', 'bot_open'));
  });

  it('honors a persisted VM window size override', () => {
    const { nodes } = reconcile(
      baseInputs({
        bots: [{ bot: botConfig, status: 'idle', activeRuns: 0, vmOpen: true, vmSize: { width: 500, height: 400 } }],
      }),
    );
    const vmNode = findNode(nodes, makeRef('botVm', 'bot_test1'));
    const data = vmNode.data as Record<string, unknown>;
    expect(data.width).toBe(500);
    expect(data.height).toBe(400);
  });
});

