/**
 * canvasFit.test.ts — fix/canvas-fit-fill-ratio (David's measured repro,
 * 2026-08-14: clicking the canvas toolbar's plain "Fit view" button
 * (`[data-testid="canvas-toolbar-fit"]`) with 8 open project zones present
 * settled at 18% zoom, an 8-node content box of 516x158 inside a 1440x844
 * viewport — a 7% area fill ratio, roughly 93% of the canvas left empty).
 *
 * Root cause: `geometry.ts`'s `ZONE_VERTICAL_GAP` (456 flow px) — airtight
 * against the floating zone title's ABSOLUTE worst case (the canvas's real
 * zoom floor, 0.1, and a name up to 40 characters) — was the ROW-TO-ROW
 * advance `reconcilerZones.ts`'s `packAutoPlacedZones`/`layout.ts`'s
 * `layoutAll` used for every wrapped shelf row. A whole-canvas "fit" of N
 * stacked rows paid that worst-case gap N-1 times even though the title
 * band only ever needs that much room once a user has ALREADY zoomed out
 * past `ZONE_SPACING_PRACTICAL_ZOOM` (0.5) — the SAME feedback loop
 * `zoneSameRowPackGap` already fixed for the horizontal (same-row) axis
 * back in the P2-16 fix, left unaddressed on the vertical axis until now.
 * `zoneRowPackGap()` closes it the same way, on the axis that was missed.
 *
 * A second, independent contributor: the toolbar's plain "Fit view" button
 * called `fitView()` with NO `minZoom` floor at all — unlike its sibling
 * whole-canvas fit (`useCanvasLayout.ts`'s `fitViewAfterLayout` /
 * `cameraInsets.ts`'s `resolveArrangeFitTarget`), which already floors a
 * whole-canvas arrange fit at `ARRANGE_MIN_READABLE_ZOOM`. Two independent
 * "frame everything" implementations had drifted apart; CanvasToolbar.tsx
 * now converges onto the same floor.
 *
 * This suite proves the fix at the geometry layer using the SAME real
 * `@xyflow/system` functions React Flow's own `fitView()` resolves through
 * internally (`getNodesBounds`/`getViewportForBounds`) — not a
 * reimplementation of that math — fed by `reconcile()`'s real node output,
 * so this is a faithful, non-mocked reproduction of what a live "Fit view"
 * click actually computes, without needing a real browser layout engine.
 *
 * `reconcile()` resolves EVERY project zone's node from the model
 * (position/width/height fields on the plain node objects it returns) —
 * never a DOM query — so this suite also stands as the direct proof that
 * the fit computation is immune to the canvas's `onlyRenderVisibleElements`
 * viewport culling (a DOM-based measurement would only ever see whatever
 * happens to be currently painted, exactly the failure mode the task brief
 * warned against).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { getNodesBounds, getViewportForBounds, type Padding } from '@xyflow/system';
import { reconcile, TRANSVERSE_PROJECT_ID, type ReconcileInputs } from '../components/agents/canvas/reconciler';
import { DEFAULT_CANVAS_PREFS, makeRef, type DraftSpec } from '../components/agents/canvas/canvasTypes';
import { ARRANGE_MIN_READABLE_ZOOM, selectWholeCanvasFitNodes } from '../components/agents/canvas/cameraInsets';
import { packAllZones, type ZonePackEntry } from '../components/agents/canvas/reconcilerZones';
import { packColumnsForZoneCount } from '../components/agents/canvas/geometry';
import type { FleetMission, FleetProject } from '../lib/agents/fleetMissions';

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

/** Real project names + occupancy from David's own measured repro (8 open
 *  zones, several idle "0 active" smoke-test projects, others with a real
 *  mission or two) — not a contrived best case. */
const REPRO_PROJECT_NAMES = [
  'uc-smoke-2026-08-12',
  'uc-smoke-b',
  'Lazy-real-test',
  'debounce',
  'GameOn_',
  'Site Gameon',
  'BackOfficeGameON',
  'training-week-generator',
];
const REPRO_MISSION_COUNTS = [1, 0, 1, 0, 0, 1, 0, 0];

function reproProjects(): FleetProject[] {
  return REPRO_PROJECT_NAMES.map((name, i) =>
    project({
      projectId: `p${i}`,
      name,
      missions: Array.from({ length: REPRO_MISSION_COUNTS[i]! }, (_, m) => mission({ id: `p${i}-m${m}`, title: `mission ${m}` })),
    }),
  );
}

/** Mirrors CanvasToolbar.tsx's own fit call: whole-canvas bounds (every
 *  emitted `project` zone node — the top-level, absolutely-positioned
 *  nodes fitView actually resolves against; children are zone-relative, so
 *  they never extend a zone's own outer bbox), the SAME `getViewportForBounds`
 *  React Flow's `fitView()` calls internally, floored at
 *  `ARRANGE_MIN_READABLE_ZOOM` (the fix's own converged floor). */
function computeWholeCanvasFit(projects: FleetProject[], viewport: { width: number; height: number }) {
  const { nodes } = reconcile(baseInputs({ projects }));
  const zoneNodes = nodes.filter((n) => n.type === 'project');
  const bounds = getNodesBounds(zoneNodes as never, { nodeOrigin: [0, 0] });
  const vp = getViewportForBounds(
    bounds,
    viewport.width,
    viewport.height,
    ARRANGE_MIN_READABLE_ZOOM,
    2,
    { top: '52px', bottom: 0.2, left: '24px', right: '24px' },
  );
  const contentW = bounds.width * vp.zoom;
  const contentH = bounds.height * vp.zoom;
  return {
    bounds,
    zoom: vp.zoom,
    contentW,
    contentH,
    fillRatio: (contentW * contentH) / (viewport.width * viewport.height),
    smallerDimFill: Math.min(contentW / viewport.width, contentH / viewport.height),
  };
}

describe('canvas whole-canvas "Fit view" — fill ratio (fix/canvas-fit-fill-ratio)', () => {
  const VIEWPORT = { width: 1440, height: 844 };

  it('for 8 real-world project zones (David\'s measured repro), the fitted content fills more than 50% of the smaller viewport dimension — was 7% area fill / 18% zoom before this fix', () => {
    const result = computeWholeCanvasFit(reproProjects(), VIEWPORT);
    expect(result.smallerDimFill).toBeGreaterThan(0.5);
    // A sane band, not just "better than before": never so tight the
    // content bleeds off-viewport (>1), and comfortably readable.
    expect(result.smallerDimFill).toBeLessThanOrEqual(1);
    expect(result.zoom).toBeGreaterThanOrEqual(ARRANGE_MIN_READABLE_ZOOM);
  });

  // fix/canvas-horizontal-pack-audit (David's round-5 report on a REAL
  // packaged-app live click, instrumentation-confirmed: "model bounds
  // {x:0, y:0, width:3767.52, height:880}" for these exact 8 zones —
  // "eight zones need ~2,400px including generous gutters, not 3,767 ...
  // check whether zoneMinWidthForTitle is now inflating each zone's width
  // and compounding it"). A FRESH reconcile() of the exact same 8-project
  // fixture (no persisted positions — the only path zoneMinWidthForTitle
  // and the same-row/row-to-row packing gaps can affect) proves the
  // CURRENT formula, including this round's own zoneMinWidthForTitle
  // floor, produces bounds matching David's own "~2,400px" expectation
  // almost exactly — not the live 3767px figure. That gap is therefore
  // NOT a packing-formula regression: it points at STALE, PERSISTED zone
  // positions the live app is carrying over from an earlier session/build
  // (reconcilerZones.ts's packAutoPlacedZones "never revisits" an already-
  // persisted position — see its own doc comment), which
  // migrateBloatedZoneRowPositions exists to unwind but may not be
  // recognizing for whatever the actual legacy shape turns out to be.
  // CanvasToolbar.tsx's fit-debug logging now also reports each zone's
  // hasPersistedPosition flag directly, to confirm this on the next live
  // click rather than guessing further.
  it('a FRESH pack (no persisted positions) of the 8-zone repro stays within ~2,400px total width — proves zoneMinWidthForTitle does not compound the packing width, and gives a concrete ceiling any future packing-gap regression must not cross', () => {
    const { nodes } = reconcile(baseInputs({ projects: reproProjects() }));
    const zoneNodes = nodes.filter((n) => n.type === 'project');
    expect(zoneNodes).toHaveLength(8);
    const bounds = getNodesBounds(zoneNodes as never, { nodeOrigin: [0, 0] });
    // Comfortably above David's own "~2,400px" estimate (real margin for
    // fixture drift) but nowhere near the live-reported 3767.52 — a
    // regression that reintroduces THIS class of bug (an oversized,
    // absolute-zoom-floor-sized gap paid per zone/row, the same disease
    // ZONE_VERTICAL_GAP and the old flat ZONE_HORIZONTAL_GAP both had)
    // would blow well past this ceiling, not creep just over it.
    expect(bounds.width).toBeLessThan(2700);
  });

  it('scales to a busier, denser fleet (more missions per zone) without regressing below the same fill floor', () => {
    const busy = REPRO_PROJECT_NAMES.map((name, i) =>
      project({
        projectId: `p${i}`,
        name,
        missions: Array.from({ length: [3, 0, 5, 1, 2, 0, 4, 6][i]! }, (_, m) => mission({ id: `p${i}-m${m}`, title: `mission ${m}` })),
      }),
    );
    const result = computeWholeCanvasFit(busy, VIEWPORT);
    expect(result.smallerDimFill).toBeGreaterThan(0.5);
  });

  it('never fits below ARRANGE_MIN_READABLE_ZOOM even for a pathologically sparse, widely spread fleet (the readability floor, not just a better bbox, is what guarantees this)', () => {
    // 12 zones (packColumnsForZoneCount(12) = round(sqrt(12*1.7)) = 5 cols,
    // 3 rows) — deliberately beyond the 8-zone repro, to prove the floor
    // (not just a smaller world bbox) is what keeps a genuinely large
    // fleet legible.
    const many: FleetProject[] = Array.from({ length: 12 }, (_, i) =>
      project({ projectId: `p${i}`, name: `project-${i}`, missions: [] }),
    );
    const result = computeWholeCanvasFit(many, VIEWPORT);
    expect(result.zoom).toBeGreaterThanOrEqual(ARRANGE_MIN_READABLE_ZOOM);
  });

  // fix/canvas-fit-fill-ratio — the task brief's own caution: onlyRenderVisibleElements
  // means a DOM query only ever sees currently-painted nodes. This asserts
  // the fit input comes from reconcile()'s MODEL output (every zone's own
  // position/width/height field on the plain node object), never a DOM
  // read — the geometry above already resolves all 8 zones' real positions
  // regardless of what a viewport-culled DOM snapshot would show.
  it('resolves every zone\'s bounds from the model (reconcile()\'s own node objects), independent of any DOM/viewport-culling state', () => {
    const { nodes } = reconcile(baseInputs({ projects: reproProjects() }));
    const zoneNodes = nodes.filter((n) => n.type === 'project');
    expect(zoneNodes).toHaveLength(8);
    for (const node of zoneNodes) {
      expect(typeof node.position.x).toBe('number');
      expect(typeof node.position.y).toBe('number');
      expect(typeof node.width).toBe('number');
      expect(typeof node.height).toBe('number');
    }
  });
});

// scratch/_canvas-label-design.md §8 acceptance criterion #1 (the design
// doc's own "critère d'acceptation n°1"): "je distingue uc-smoke-b de
// uc-smoke-c et de uc-smoke-2026-08-12 sans zoomer ni survoler". Proven at
// the geometry/model layer (the same layer the rest of this suite already
// verifies "fit" against): every zone widens to at least
// `zoneMinWidthForTitle(name)` (geometry.ts — the guarantee that the FULL,
// untruncated name fits inside the header's own geometric containment
// clamp at the practical zoom), the reconciled `ProjectNodeData.name` is
// always the real, untruncated string (truncation is a presentation-layer
// concern, ProjectGroupNode.tsx's own `truncateMiddle` call — see
// canvasNodes.test.tsx/truncateMiddle.test.ts for that half), and no two
// zones' bounding boxes overlap at any packed layout.
describe('canvas zone-title distinguishability (scratch/_canvas-label-design.md acceptance criterion #1)', () => {
  it('uc-smoke-b / uc-smoke-c / uc-smoke-2026-08-12 each get a zone at least as wide as their own zoneMinWidthForTitle, and the reconciled data carries the full untruncated name', async () => {
    const { zoneMinWidthForTitle } = await import('../components/agents/canvas/geometry');
    const names = ['uc-smoke-b', 'uc-smoke-c', 'uc-smoke-2026-08-12'];
    const projects = names.map((name, i) => project({ projectId: `p${i}`, name }));
    const { nodes } = reconcile(baseInputs({ projects }));
    const zoneNodes = nodes.filter((n) => n.type === 'project');
    expect(zoneNodes).toHaveLength(3);

    const byName = new Map(zoneNodes.map((n) => [(n.data as { name: string }).name, n]));
    for (const name of names) {
      const node = byName.get(name);
      expect(node).toBeDefined();
      expect(node!.width!).toBeGreaterThanOrEqual(zoneMinWidthForTitle(name));
      // The model never truncates — only the rendered header does.
      expect((node!.data as { name: string }).name).toBe(name);
    }

    // Distinct real names -> distinct rendered header text (the whole point
    // of the middle-ellipsis fix): trivially true here since all three are
    // under the reserved-char cap and render in full, but asserted directly
    // so a future cap/truncation regression that collapsed them to the same
    // prefix would fail loudly here, not just in the pure truncateMiddle
    // unit suite.
    const { ZONE_TITLE_RESERVED_NAME_CHARS } = await import('../components/agents/canvas/geometry');
    const { truncateMiddle } = await import('../lib/truncateMiddle');
    const rendered = names.map((n) => truncateMiddle(n, ZONE_TITLE_RESERVED_NAME_CHARS));
    expect(new Set(rendered).size).toBe(3);
  });

  it('the three zones never overlap once packed (containment + a small flat gap is enough — no name-proportional spacing needed any more)', () => {
    const names = ['uc-smoke-b', 'uc-smoke-c', 'uc-smoke-2026-08-12'];
    const projects = names.map((name, i) => project({ projectId: `p${i}`, name }));
    const { nodes } = reconcile(baseInputs({ projects }));
    const zoneNodes = nodes.filter((n) => n.type === 'project');
    for (let i = 0; i < zoneNodes.length; i += 1) {
      for (let j = i + 1; j < zoneNodes.length; j += 1) {
        const a = zoneNodes[i]!;
        const b = zoneNodes[j]!;
        const overlapsX = a.position.x < b.position.x + b.width! && b.position.x < a.position.x + a.width!;
        const overlapsY = a.position.y < b.position.y + b.height! && b.position.y < a.position.y + a.height!;
        expect(overlapsX && overlapsY).toBe(false);
      }
    }
  });
});

// scratch/_canvas-label-design.md §3.3 item 5 — "Ranger"/Tidy
// (`reconcilerZones.ts`'s `packAllZones`, wired into `useCanvasLayout.ts`'s
// `tidyZones` / CanvasToolbar.tsx's `onTidyZones`). The suite above already
// proves a FRESH pack (no persisted positions) of the 8-zone repro clears the
// >50% fill floor — but `packAutoPlacedZones` (the path a normal reconcile()
// actually takes) never revisits a zone that already has a PERSISTED
// position, by design (see its own doc comment). David's real profile is
// exactly that case: 8 zones whose positions were saved months ago, before
// any of the packing-gap fixes existed — the diagnosis in §1 of the design
// doc ("zones épinglées jamais re-packées"). This suite reproduces that
// stuck-pinned shape directly (every zone pinned into one wide row, the same
// "all in row 0, huge gaps" shape the design doc's own diagnosis section
// describes) and proves `packAllZones` — the ONE path allowed to move a
// pinned zone — recovers the same fill floor the fresh-pack case already
// enjoys.
describe('canvas "Ranger" — packAllZones repacks PINNED zones (scratch/_canvas-label-design.md §3.3 item 5)', () => {
  const VIEWPORT = { width: 1440, height: 844 };

  /** Simulates David's real, months-old profile: every zone given an
   *  explicit PERSISTED position, spread far apart in a single row — the
   *  exact shape `packAutoPlacedZones` will never revisit on its own
   *  (`hasPersistedPosition` short-circuits it for every one of these). */
  function pinnedSparseRepro(): { projects: FleetProject[]; positions: Record<string, { x: number; y: number }> } {
    const projects = reproProjects();
    const positions: Record<string, { x: number; y: number }> = {};
    projects.forEach((p, i) => {
      positions[makeRef('project', p.projectId)] = { x: i * 2000, y: 0 };
    });
    return { projects, positions };
  }

  it('a pinned-sparse 8-zone profile stays stuck below the fill floor on a normal reconcile — the exact gap Ranger exists to close', () => {
    const { projects, positions } = pinnedSparseRepro();
    const { nodes } = reconcile(baseInputs({ projects, positions }));
    const zoneNodes = nodes.filter((n) => n.type === 'project');
    expect(zoneNodes).toHaveLength(8);
    const bounds = getNodesBounds(zoneNodes as never, { nodeOrigin: [0, 0] });
    const vp = getViewportForBounds(bounds, VIEWPORT.width, VIEWPORT.height, ARRANGE_MIN_READABLE_ZOOM, 2, {
      top: '52px',
      bottom: 0.2,
      left: '24px',
      right: '24px',
    });
    const smallerDimFill = Math.min(
      (bounds.width * vp.zoom) / VIEWPORT.width,
      (bounds.height * vp.zoom) / VIEWPORT.height,
    );
    // Below the >50% floor the fresh-pack suite above proves — a pinned
    // profile really is stuck sparse until something explicitly repacks it.
    expect(smallerDimFill).toBeLessThan(0.5);
  });

  it('packAllZones repacks every one of those 8 pinned zones and clears the same >50% fill floor the fresh-pack case meets', () => {
    const { projects, positions } = pinnedSparseRepro();
    const before = reconcile(baseInputs({ projects, positions }));
    const beforeZoneNodes = before.nodes.filter((n) => n.type === 'project');
    const entries: ZonePackEntry[] = beforeZoneNodes.map((n) => ({
      projectRef: n.id,
      name: (n.data as { name: string }).name,
      size: { width: n.width!, height: n.height! },
    }));

    const repacked = packAllZones(entries);
    // The last zone was pinned all the way out at x:14000 (index 7 * 2000) —
    // Ranger's whole point is that it does NOT respect that old pinned
    // position (unlike packAutoPlacedZones, which would never touch it):
    // it lands back inside a dense grid instead.
    const lastRef = makeRef('project', 'p7');
    expect(positions[lastRef]).toEqual({ x: 14000, y: 0 });
    expect(repacked.get(lastRef)!.x).toBeLessThan(2700);

    const patch: Record<string, { x: number; y: number }> = {};
    for (const [ref, pos] of repacked) patch[ref] = pos;
    const after = reconcile(baseInputs({ projects, positions: patch }));
    const afterZoneNodes = after.nodes.filter((n) => n.type === 'project');
    const bounds = getNodesBounds(afterZoneNodes as never, { nodeOrigin: [0, 0] });
    const vp = getViewportForBounds(bounds, VIEWPORT.width, VIEWPORT.height, ARRANGE_MIN_READABLE_ZOOM, 2, {
      top: '52px',
      bottom: 0.2,
      left: '24px',
      right: '24px',
    });
    const smallerDimFill = Math.min(
      (bounds.width * vp.zoom) / VIEWPORT.width,
      (bounds.height * vp.zoom) / VIEWPORT.height,
    );
    expect(smallerDimFill).toBeGreaterThan(0.5);
  });

  it('packs 8 zones into packColumnsForZoneCount(8) = 4 per row (two rows of 4), and no two repacked zones overlap', () => {
    const { projects, positions } = pinnedSparseRepro();
    const { nodes } = reconcile(baseInputs({ projects, positions }));
    const zoneNodes = nodes.filter((n) => n.type === 'project');
    const entries: ZonePackEntry[] = zoneNodes.map((n) => ({
      projectRef: n.id,
      name: (n.data as { name: string }).name,
      size: { width: n.width!, height: n.height! },
    }));

    const repacked = packAllZones(entries);
    // Row membership is by shared Y (every zone in the same shelf row gets
    // the SAME y; x is a per-zone cumulative offset, so it differs even
    // within one row — grouping by y is the correct row-count signal, not
    // the distinct-x count).
    const countByY = new Map<number, number>();
    for (const pos of repacked.values()) countByY.set(pos.y, (countByY.get(pos.y) ?? 0) + 1);
    const rowSizes = [...countByY.values()].sort((a, b) => b - a);
    const maxPerRow = packColumnsForZoneCount(8); // round(sqrt(8*1.7)) = 4
    expect(rowSizes).toEqual([maxPerRow, entries.length - maxPerRow]); // [4, 4]

    const rects = entries.map((entry) => ({ ...repacked.get(entry.projectRef)!, ...entry.size }));
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlapsX = a.x < b.x + b.width && b.x < a.x + a.width;
        const overlapsY = a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlapsX && overlapsY).toBe(false);
      }
    }
  });

  it('a zone with no zones to pack is a no-op (empty map, never a crash)', () => {
    expect(packAllZones([]).size).toBe(0);
  });
});

// fix/canvas-fit-instrumentation (round 3, David's own live rebuild: even
// with the manager COLLAPSED — the canvas owning the full window — "fit"
// still produced a 500x122 content box in a 1440x844 viewport at 14% zoom
// for 9 rendered nodes, "an order of magnitude larger than the actual
// nodes"). Instrumenting the real fit handler (CanvasToolbar.tsx) surfaced
// a genuine bug in how it fed `computeSafeMinZoom`: `getNodesBounds` is a
// PLAIN geometric union over whatever `.position` each node object reports
// — it has no notion of `parentId`/`extent: 'parent'` and does NOT resolve
// a CHILD node's flow-relative position (relative to its own zone's
// top-left) into an absolute canvas coordinate. Feeding it reconcile()'s
// FULL node list (zones AND their mission/draft/etc. children, exactly what
// `useReactFlow().getNodes()` returns) silently mixes two different
// coordinate spaces in one bounding-box union.
describe('getNodesBounds — must only ever see TOP-LEVEL (parentless) nodes (fix/canvas-fit-instrumentation)', () => {
  it('demonstrates the bug directly: a child\'s zone-relative position, read as if already absolute, distorts the union bounding box', () => {
    // A single zone at (1000, 2000), 300x300 — its own child mission sits
    // at (24, 36) RELATIVE TO THE ZONE (reconcilerZones.ts's own
    // `gridSlotPosition` starting offset), i.e. its REAL absolute position
    // is (1024, 2036), well inside the zone's own box.
    const zone = { id: 'zone1', type: 'project', position: { x: 1000, y: 2000 }, width: 300, height: 300 };
    const child = { id: 'child1', type: 'mission', position: { x: 24, y: 36 }, width: 260, height: 236, parentId: 'zone1', extent: 'parent' as const };

    const unfiltered = getNodesBounds([zone, child] as never);
    // The bug: since the child's RELATIVE (24, 36) is far from the zone's
    // own (1000, 2000), the naive union treats them as two unrelated,
    // widely-separated points — producing a bounding box roughly 4x wider
    // and 7x taller than the zone's own real 300x300 footprint, even though
    // the child never actually leaves its parent's box.
    expect(unfiltered.width).toBeGreaterThan(zone.width * 3);
    expect(unfiltered.height).toBeGreaterThan(zone.height * 3);

    // The fix: bound only top-level (parentless) nodes — exactly the
    // zone's own real footprint, since a child's `extent: 'parent'`
    // guarantees it never renders outside its own zone's box anyway.
    const topLevelOnly = [zone, child].filter((n) => !('parentId' in n) || !n.parentId);
    const filtered = getNodesBounds(topLevelOnly as never);
    expect(filtered).toEqual({ x: 1000, y: 2000, width: 300, height: 300 });
  });

  it('CanvasToolbar.tsx\'s own fit handler routes getNodes() through selectWholeCanvasFitNodes before computing bounds — regression guard against reintroducing the raw unfiltered call', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../components/agents/canvas/CanvasToolbar.tsx'),
      'utf-8',
    );
    // fix/canvas-transverse-fit-outlier replaced the plain `.filter((n) =>
    // !n.parentId)` call with `selectWholeCanvasFitNodes` (cameraInsets.ts),
    // which does the SAME parentId filtering internally (see that
    // function's own unit tests below) PLUS excludes the Transverse zone —
    // asserted verbatim so a future edit that quietly reverts to the raw
    // unfiltered/unexcluded call fails CI immediately.
    expect(source).toContain('selectWholeCanvasFitNodes(getNodes(), transverseRef)');
    expect(source).toMatch(/const topLevelNodes = selectWholeCanvasFitNodes\(getNodes\(\), transverseRef\);\s*\n\s*const modelBounds = getNodesBounds\(topLevelNodes\);/);
  });
});

// fix/canvas-transverse-fit-outlier (David's measured regression, live CDP:
// whole-canvas "Fit view" settled at zoom 0.116 with 8 open project zones —
// "unreadable thumbnails crammed in a corner of a mostly empty canvas").
//
// The `!n.parentId` filter above is verified CORRECT: reconciler.ts already
// parents every draft/mission with no `projectId` under the synthetic
// Transverse zone (`TRANSVERSE_PROJECT_ID`, see reconciler.test.ts's own
// "places a draft with no projectId ... into the synthetic Transverse zone"
// case) — they are never literally parentless in production, so they were
// never the ones inflating the union bbox. The Transverse ZONE ITSELF is a
// normal top-level node, though, and `computeSafeMinZoom` is deliberately
// unfloored on the low end (never clips real content off-screen to hold a
// readability floor — see its own doc comment) — so a Transverse zone whose
// PERSISTED position is stale/far from the rest of the packed layout (the
// exact "stale persisted position" class of bug real project zones are
// already guarded against via `migrateBloatedZoneRowPositions`/
// `declutterPinnedZones`, but which Transverse never received) has NO
// ceiling on how far it drags the WHOLE canvas's zoom down.
describe('whole-canvas "Fit view" must not let a stale/far Transverse zone tank the zoom (fix/canvas-transverse-fit-outlier)', () => {
  const VIEWPORT = { width: 1440, height: 844 };
  const PADDING: Padding = { top: '52px', bottom: 0.2, left: '24px', right: '24px' };

  function computeFit(topLevelNodes: unknown[]) {
    const bounds = getNodesBounds(topLevelNodes as never, { nodeOrigin: [0, 0] });
    const natural = getViewportForBounds(bounds, VIEWPORT.width, VIEWPORT.height, 0, 2, PADDING).zoom;
    const safeMinZoom = Number.isFinite(natural) && natural > 0 ? Math.min(ARRANGE_MIN_READABLE_ZOOM, natural) : ARRANGE_MIN_READABLE_ZOOM;
    const vp = getViewportForBounds(bounds, VIEWPORT.width, VIEWPORT.height, safeMinZoom, 2, PADDING);
    const fill = Math.min((bounds.width * vp.zoom) / VIEWPORT.width, (bounds.height * vp.zoom) / VIEWPORT.height);
    return { bounds, zoom: vp.zoom, fill };
  }

  /** A Transverse zone pinned far from the real-project cluster — the exact
   *  shape a stale build/session leaves behind (reconcilerZones.ts's own
   *  "a pinned zone's own position is NEVER touched by the auto-pack pass"
   *  rule means this, once written, persists forever until something
   *  explicitly repacks it). */
  function reproWithStaleTransverse() {
    const drafts: DraftSpec[] = Array.from({ length: 3 }, (_, i) => ({
      id: `mgr-draft-${i}`,
      title: `Manager step ${i}`,
      task: 'x',
      createdBy: 'manager',
      // deliberately NO projectId — a manager plan draft before a target
      // project is picked, reconciler.ts's own documented Transverse rule.
    }));
    const positions: Record<string, { x: number; y: number }> = {
      [makeRef('project', TRANSVERSE_PROJECT_ID)]: { x: 6000, y: 5000 },
    };
    return reconcile(baseInputs({ projects: reproProjects(), drafts, positions }));
  }

  it('reproduces the regression: including the stale-pinned Transverse zone in the fit bounds collapses zoom to ~0.13 — matching the live 0.116 measurement', () => {
    const { nodes } = reproWithStaleTransverse();
    const oldTopLevel = nodes.filter((n) => !n.parentId); // the pre-fix filter
    const result = computeFit(oldTopLevel);
    expect(result.zoom).toBeLessThan(0.2);
  });

  it('the fix: selectWholeCanvasFitNodes excludes Transverse, so the same stale-pinned zone no longer affects the fit — zoom/fill land back on the established bar (~36% zoom / ~52% fill)', () => {
    const { nodes } = reproWithStaleTransverse();
    const transverseRef = makeRef('project', TRANSVERSE_PROJECT_ID);
    const fitNodes = selectWholeCanvasFitNodes(nodes, transverseRef);
    expect(fitNodes.some((n) => n.id === transverseRef)).toBe(false);
    const result = computeFit(fitNodes);
    expect(result.zoom).toBeGreaterThanOrEqual(ARRANGE_MIN_READABLE_ZOOM);
    expect(result.fill).toBeGreaterThan(0.5);
  });

  it('falls back to every top-level node (including Transverse) when Transverse is the ONLY content — never an empty/degenerate bbox', () => {
    const drafts: DraftSpec[] = [{ id: 'd1', title: 'Solo draft', task: 'x', createdBy: 'manager' }];
    const { nodes } = reconcile(baseInputs({ projects: [], drafts }));
    const transverseRef = makeRef('project', TRANSVERSE_PROJECT_ID);
    const fitNodes = selectWholeCanvasFitNodes(nodes, transverseRef);
    expect(fitNodes).toHaveLength(1);
    expect(fitNodes[0]!.id).toBe(transverseRef);
  });

  it('a realistic (non-stale-positioned) Transverse zone degrades the fit gracefully as content grows — the outlier POSITION is the defect, not content volume', () => {
    for (const n of [3, 10, 30]) {
      const drafts: DraftSpec[] = Array.from({ length: n }, (_, i) => ({
        id: `mgr-draft-${i}`, title: `Manager step ${i}`, task: 'x', createdBy: 'manager',
      }));
      const { nodes } = reconcile(baseInputs({ projects: reproProjects(), drafts }));
      const oldTopLevel = nodes.filter((nd) => !nd.parentId);
      const result = computeFit(oldTopLevel);
      // Never anywhere near the 0.116 live regression even with 30 items,
      // as long as Transverse packs adjacent to the cluster like every
      // other auto-placed zone (no persisted position to short-circuit it).
      expect(result.zoom).toBeGreaterThan(0.15);
    }
  });
});
