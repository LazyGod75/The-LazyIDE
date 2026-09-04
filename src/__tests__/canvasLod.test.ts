/**
 * canvasLod.test.ts — W-UX3 finding A ("quand on dézoome, les agents
 * deviennent invisibles"): boundary coverage for `lodScale` (chrome/lod.ts),
 * the pure inverse-zoom compensation every fleet-view dot and zone header
 * label applies through the `--canvas-lod-*-scale` CSS vars
 * (CanvasLodBroadcaster.tsx).
 */

import { describe, it, expect } from 'vitest';
import {
  DOT_LOD_TARGET_PX,
  HEADER_CLAMP_ZOOM,
  HEADER_MINIMAL_ZOOM,
  HOVER_ACTIONS_MIN_ZOOM,
  LOD_FLOOR_ZOOM,
  MISSION_CHIP_CONTENT_WIDTH,
  MISSION_CHIP_LOD_TARGET_PX,
  ZONE_LABEL_CONTENT_PX,
  ZONE_LABEL_LOD_TARGET_PX,
  ZONE_TITLE_BAND_TARGET_PX,
  lodScale,
  titleBandHeight,
} from '../components/agents/canvas/chrome/lod';
import { DOT_SIZE } from '../components/agents/canvas/chrome/nodeChrome';
import { ZOOM_AGGREGATE, ZOOM_CHIP } from '../components/agents/canvas/canvasTypes';
import {
  ZONE_GAP,
  ZONE_HEADER_HEIGHT,
  ZONE_HORIZONTAL_GAP,
  ZONE_TITLE_AVG_CHAR_WIDTH_RATIO,
  ZONE_TITLE_BAND_HEIGHT,
  ZONE_TITLE_CHROME_WIDTH_PX,
  ZONE_TITLE_CONTENT_MAX_WIDTH_PX,
  ZONE_TITLE_GAP_ABOVE,
  ZONE_TITLE_MAX_FLOW_HEIGHT,
  ZONE_TITLE_MAX_FLOW_WIDTH,
  ZONE_TITLE_TYPICAL_MAX_NAME_CHARS,
  ZONE_VERTICAL_GAP,
} from '../components/agents/canvas/geometry';

// W-CARDS: no semantic zoom (founder standing decision, restated verbatim
// after an earlier wave violated it again — see canvasTypes.ts's
// ZOOM_AGGREGATE doc comment for the full quote). The old "aggregate zone
// dashboard" tier this describe block used to lock in place is retired:
// ZOOM_AGGREGATE is forced to 0, so it can never be reached by a live zoom
// (which is never negative) — content is never hidden or replaced by zoom
// again, only the header row's title band stays protected (LaneGuides/
// gridSlotPosition in reconcilerZones.ts).
describe('three-tier fleet view thresholds (W-UX3, fix/canvas-legibility)', () => {
  it('ZOOM_AGGREGATE is forced to 0 — permanently below the RF minZoom floor, unreachable', () => {
    expect(ZOOM_AGGREGATE).toBe(0);
    expect(ZOOM_AGGREGATE).toBeLessThan(LOD_FLOOR_ZOOM);
    expect(ZOOM_AGGREGATE).toBeLessThan(ZOOM_CHIP);
  });

  it("David's 10% repro zoom no longer lands in any hiding tier — content stays visible", () => {
    expect(0.1).toBeGreaterThan(ZOOM_AGGREGATE); // aggregate tier can never engage
    expect(0.35).toBeGreaterThan(ZOOM_AGGREGATE);
    expect(0.35).toBeLessThan(ZOOM_CHIP);
  });
});

describe('mission billboard chip LOD constants (fix/canvas-legibility)', () => {
  // scratch/_canvas-label-design.md §3.2 — the compensation band now only
  // holds a constant screen size from LOD_FLOOR_ZOOM (0.25) upward; every
  // zoom in this array must be >= that floor (was [0.1, 0.15, 0.22, ...],
  // three of which are now BELOW the (raised) floor and would legitimately
  // shrink instead of holding constant — see the "below the floor" suite).
  it('holds the chip at its target screen size across the whole chip-zoom band (at or above the floor)', () => {
    for (const zoom of [LOD_FLOOR_ZOOM, 0.3, 0.4, 0.54]) {
      const scale = lodScale(zoom, MISSION_CHIP_CONTENT_WIDTH, MISSION_CHIP_LOD_TARGET_PX);
      const screenPx = MISSION_CHIP_CONTENT_WIDTH * zoom * scale;
      expect(screenPx).toBeCloseTo(MISSION_CHIP_LOD_TARGET_PX, 6);
    }
  });

  it('is a no-op once the chip is already legible at its natural size', () => {
    expect(lodScale(1, MISSION_CHIP_CONTENT_WIDTH, MISSION_CHIP_LOD_TARGET_PX)).toBe(1);
  });
});

describe('lodScale — constant screen-size compensation', () => {
  it('is a no-op (exactly 1) when the natural screen size already meets the target', () => {
    // zoom 1: a 20px dot is 20 screen px >= 18 target — untouched.
    expect(lodScale(1, DOT_SIZE, DOT_LOD_TARGET_PX)).toBe(1);
    // zoom 2 (zoomed in): still untouched, never shrinks legible content.
    expect(lodScale(2, DOT_SIZE, DOT_LOD_TARGET_PX)).toBe(1);
  });

  // scratch/_canvas-label-design.md §3.2 ("compensation bornée, le modèle
  // tldraw") — David's original repro zoom (0.1) is now BELOW the raised
  // LOD_FLOOR_ZOOM (0.25), so the dot no longer holds a full 18 screen px
  // there BY DESIGN (it shrinks with the canvas past the floor, same as
  // tldraw's own `min(scale, 3.5)` cap) — the constant-screen-size guarantee
  // now applies AT the floor zoom, verified below.
  it("compensates at the (now-bounded) floor zoom: a 20px dot renders ~18 screen px, not 2", () => {
    const scale = lodScale(LOD_FLOOR_ZOOM, DOT_SIZE, DOT_LOD_TARGET_PX);
    const screenPx = DOT_SIZE * LOD_FLOOR_ZOOM * scale;
    expect(screenPx).toBeCloseTo(DOT_LOD_TARGET_PX, 6);
    // Inside the brief's own "~16-18 screen px" acceptance range.
    expect(screenPx).toBeGreaterThanOrEqual(16);
    expect(screenPx).toBeLessThanOrEqual(18);
  });

  it('holds the dot at the target screen size across the whole dot-zoom band (at or above the floor)', () => {
    for (const zoom of [LOD_FLOOR_ZOOM, 0.3, 0.44]) {
      const scale = lodScale(zoom, DOT_SIZE, DOT_LOD_TARGET_PX);
      const screenPx = DOT_SIZE * zoom * scale;
      expect(screenPx).toBeCloseTo(DOT_LOD_TARGET_PX, 6);
    }
  });

  it('caps compensation at the floor zoom — below it, content gracefully shrinks instead of the scale exploding', () => {
    const scaleAtFloor = lodScale(LOD_FLOOR_ZOOM, DOT_SIZE, DOT_LOD_TARGET_PX);
    const scaleBelowFloor = lodScale(0.01, DOT_SIZE, DOT_LOD_TARGET_PX);
    expect(scaleBelowFloor).toBe(scaleAtFloor); // capped, not larger
  });

  // scratch/_canvas-label-design.md §3.2 — the tldraw-aligned bound itself:
  // below the floor, the on-screen size DECREASES as zoom decreases further
  // (never held constant past this point, never explodes either) — the
  // "gracefully shrinks" half of the design's own acceptance language.
  it('below the floor, the on-screen size shrinks WITH the canvas instead of staying pinned (tldraw-aligned bound)', () => {
    const screenPxAt = (zoom: number) => DOT_SIZE * zoom * lodScale(zoom, DOT_SIZE, DOT_LOD_TARGET_PX);
    const atFloor = screenPxAt(LOD_FLOOR_ZOOM);
    const belowFloor = screenPxAt(0.15);
    const deepBelowFloor = screenPxAt(0.05);
    expect(belowFloor).toBeLessThan(atFloor);
    expect(deepBelowFloor).toBeLessThan(belowFloor);
  });

  it('zone label: 12.5px content compensates to ~11.5 screen px at the floor zoom', () => {
    const scale = lodScale(LOD_FLOOR_ZOOM, ZONE_LABEL_CONTENT_PX, ZONE_LABEL_LOD_TARGET_PX);
    const screenPx = ZONE_LABEL_CONTENT_PX * LOD_FLOOR_ZOOM * scale;
    expect(screenPx).toBeCloseTo(ZONE_LABEL_LOD_TARGET_PX, 6);
    // Inside the brief's own "~11-12 screen px" range.
    expect(screenPx).toBeGreaterThanOrEqual(11);
    expect(screenPx).toBeLessThanOrEqual(12);
  });

  it('the bounded compensation factor is ~3.7x at the floor (tldraw-aligned), not the old ~9.2x', () => {
    const maxScale = lodScale(LOD_FLOOR_ZOOM, ZONE_LABEL_CONTENT_PX, ZONE_LABEL_LOD_TARGET_PX);
    expect(maxScale).toBeCloseTo(3.68, 2);
    expect(maxScale).toBeLessThan(3.7);
  });

  it('zone label is untouched at zooms where it is already legible (>= ~0.92)', () => {
    expect(lodScale(1, ZONE_LABEL_CONTENT_PX, ZONE_LABEL_LOD_TARGET_PX)).toBe(1);
    expect(lodScale(0.95, ZONE_LABEL_CONTENT_PX, ZONE_LABEL_LOD_TARGET_PX)).toBe(1);
  });

  it('degrades safely (returns 1) on nonsensical inputs', () => {
    expect(lodScale(0.1, 0, DOT_LOD_TARGET_PX)).toBe(1);
    expect(lodScale(0.1, DOT_SIZE, 0)).toBe(1);
    expect(lodScale(0.1, -5, DOT_LOD_TARGET_PX)).toBe(1);
  });
});

// fix/canvas-header-overflow — measured bug: at low zoom (David's own
// 14-17% repro), a project/frame header's LOD-compensated identity cluster
// overflowed past its own zone and covered a NEIGHBOURING zone's title
// (measured: "Lazy" covered by the lazy-backoffice/LazySite-internet
// zones). See chrome/lod.ts's own module header for the full maths.
describe('locked threshold decisions (fix/canvas-header-overflow)', () => {
  it('HOVER_ACTIONS_MIN_ZOOM is 0.3, strictly between HEADER_MINIMAL_ZOOM and HEADER_CLAMP_ZOOM', () => {
    expect(HOVER_ACTIONS_MIN_ZOOM).toBe(0.3);
    expect(HOVER_ACTIONS_MIN_ZOOM).toBeGreaterThan(HEADER_MINIMAL_ZOOM);
    expect(HOVER_ACTIONS_MIN_ZOOM).toBeLessThan(HEADER_CLAMP_ZOOM);
  });
});

// fix/canvas-title-band-zoom — founder's refined W-CARDS rule, verbatim:
// "juste le titre et la zone de titre doivent s'adapter, actuellement si je
// dézoome le texte devient illisible et la zone de titre trop petite". The
// header ROW's own effective flow-space height (not just its text content,
// covered by lodScale above) must grow enough at deep dezoom to hold
// ZONE_TITLE_BAND_TARGET_PX on screen, capped so it never grows past the
// title's own worst-case footprint (geometry.ts's ZONE_TITLE_MAX_FLOW_HEIGHT
// — fix/canvas-title-float renamed/decoupled this bound from `ZONE_HEADER_
// HEIGHT + ZONE_TITLE_BAND_HEIGHT`, which now means something else — see
// geometry.ts's ZONE_TITLE_BAND_HEIGHT doc comment).
describe('titleBandHeight — zoom-compensated title band height (fix/canvas-title-band-zoom, fix/canvas-title-float)', () => {
  // scratch/_canvas-label-design.md §3.2 — the constant-screen-size band
  // only holds from LOD_FLOOR_ZOOM (0.25) upward now (was 0.1) — 0.13 is
  // BELOW the new floor, so it moves to the "bounded, shrinks below the
  // floor" suite instead of this one.
  it('holds the row at its screen-px target across the whole zoom range down to the floor', () => {
    for (const zoom of [LOD_FLOOR_ZOOM, 0.35, 0.6, 1]) {
      const flowHeight = titleBandHeight(zoom, ZONE_HEADER_HEIGHT, ZONE_TITLE_MAX_FLOW_HEIGHT);
      const screenPx = flowHeight * zoom;
      expect(screenPx).toBeCloseTo(ZONE_TITLE_BAND_TARGET_PX, 6);
    }
  });

  // scratch/_canvas-label-design.md §3.2 — David's ORIGINAL repro zoom
  // (0.13) is now below the raised LOD_FLOOR_ZOOM (0.25): the row is
  // already at its fixed max (176 flow px, capped — see the next test) and
  // shrinks WITH zoom below that point, same bounded-compensation shape as
  // `lodScale` itself. It no longer holds the full 44 screen px there BY
  // DESIGN — the guarantee moved to "held from the floor zoom upward",
  // covered above — but it is STILL dramatically better than the old,
  // totally-uncompensated 36*0.13 ≈ 4.7px a bare resting height would give.
  it("at zoom 0.13 (below the floor), the row is capped at its fixed max and shrinks proportionally — still far more legible than the old uncompensated 36*0.13 ≈ 4.7px", () => {
    const flowHeight = titleBandHeight(0.13, ZONE_HEADER_HEIGHT, ZONE_TITLE_MAX_FLOW_HEIGHT);
    expect(flowHeight).toBe(ZONE_TITLE_MAX_FLOW_HEIGHT); // already at the cap below the floor
    const screenPx = flowHeight * 0.13;
    expect(screenPx).toBeGreaterThan(36 * 0.13); // the OLD (unfixed) math, for contrast
    expect(screenPx).toBeCloseTo(22.88, 1);
  });

  it('is exactly the fixed max at the real zoom floor — the row can grow no further, and needs no further growth there', () => {
    const flowHeight = titleBandHeight(LOD_FLOOR_ZOOM, ZONE_HEADER_HEIGHT, ZONE_TITLE_MAX_FLOW_HEIGHT);
    expect(flowHeight).toBe(ZONE_TITLE_MAX_FLOW_HEIGHT);
    expect(flowHeight).toBe(176);
  });

  it('never grows past the fixed max even below the floor zoom (capped, matching lodScale\'s own floor behavior)', () => {
    const atFloor = titleBandHeight(LOD_FLOOR_ZOOM, ZONE_HEADER_HEIGHT, ZONE_TITLE_MAX_FLOW_HEIGHT);
    const belowFloor = titleBandHeight(0.01, ZONE_HEADER_HEIGHT, ZONE_TITLE_MAX_FLOW_HEIGHT);
    expect(belowFloor).toBe(atFloor);
  });

  it('never shrinks below the original resting header height, even zoomed in past 100%', () => {
    const flowHeight = titleBandHeight(3, ZONE_HEADER_HEIGHT, ZONE_TITLE_MAX_FLOW_HEIGHT);
    expect(flowHeight).toBe(ZONE_HEADER_HEIGHT);
  });

  it('at rest zoom (1.0), sits at the target itself — between the min and max clamps', () => {
    const flowHeight = titleBandHeight(1, ZONE_HEADER_HEIGHT, ZONE_TITLE_MAX_FLOW_HEIGHT);
    expect(flowHeight).toBeCloseTo(ZONE_TITLE_BAND_TARGET_PX, 6);
  });
});

// fix/canvas-title-float — geometry.ts's ZONE_TITLE_BAND_HEIGHT no longer
// carries the title's worst-case footprint (that job moved to
// ZONE_TITLE_MAX_FLOW_HEIGHT below): the title no longer renders INSIDE the
// zone frame at all (it floats ABOVE it, ProjectGroupNode.tsx's
// canvas-zone-header), so there is no more in-frame band to reserve.
describe('geometry.ts ZONE_TITLE_BAND_HEIGHT — retired in-frame reservation (fix/canvas-title-float)', () => {
  it('is a tiny/zero in-frame top content-inset now, not a 404px dead gap', () => {
    expect(ZONE_TITLE_BAND_HEIGHT).toBe(0);
    // The fixed child-start offset (reconcilerZones.ts's gridSlotPosition)
    // is now just the plain resting header height — children fill the zone
    // from very near its real top.
    expect(ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT).toBe(36);
  });
});

// fix/canvas-title-float — locked value: ZONE_TITLE_MAX_FLOW_HEIGHT is
// DERIVED (not a re-hardcoded magic number) from the exact same worked math
// ZONE_TITLE_BAND_HEIGHT used to embody, so a drift in either constant fails
// loudly here instead of silently re-introducing "title clipped at deep
// dezoom".
describe('geometry.ts ZONE_TITLE_MAX_FLOW_HEIGHT — worked math (fix/canvas-title-float)', () => {
  // scratch/_canvas-label-design.md §3.2 — LOD_FLOOR_ZOOM raised 0.1 -> 0.25
  // (the "compensation bornée, modèle tldraw" fix), so the derived max flow
  // height dropped from 440 to 176 in lockstep — still the SAME formula
  // (`TARGET / LOD_FLOOR_ZOOM`), just against the new floor.
  it('is exactly TARGET / LOD_FLOOR_ZOOM = 176', () => {
    expect(ZONE_TITLE_BAND_TARGET_PX).toBe(44);
    expect(LOD_FLOOR_ZOOM).toBe(0.25);
    expect(ZONE_TITLE_MAX_FLOW_HEIGHT).toBe(176);
  });
});

// fix/canvas-title-float — requirement 4 ("guard the top"): a title floating
// above zone B (worst case: ZONE_TITLE_MAX_FLOW_HEIGHT tall, floating up
// from ZONE_TITLE_GAP_ABOVE above zone B's own top edge) must never land on
// zone A's bottom edge, at ANY zoom the orchestrator verifies live (0.1, 0.3,
// 1.0 — this invariant holds identically at every zoom, since the packer's
// spacing is a FIXED flow-space gap, never a function of the live zoom).
describe('ZONE_VERTICAL_GAP — inter-zone spacing guards the floating title (fix/canvas-title-float)', () => {
  // scratch/_canvas-label-design.md §3.2 — bounding LOD_FLOOR_ZOOM (0.1 ->
  // 0.25) shrank ZONE_TITLE_MAX_FLOW_HEIGHT (440 -> 176) in lockstep, so
  // this derived sum shrank with it: 176 + 16 = 192 (was 456). Small enough
  // now to use directly as the routine row-to-row packing gap — see
  // geometry.ts's `zoneRowPackGap` doc comment.
  it('is exactly the title\'s worst-case footprint plus its breathing gap: 176 + 16 = 192', () => {
    expect(ZONE_VERTICAL_GAP).toBe(ZONE_TITLE_MAX_FLOW_HEIGHT + ZONE_TITLE_GAP_ABOVE);
    expect(ZONE_VERTICAL_GAP).toBe(192);
  });

  it('is strictly larger than the plain horizontal ZONE_GAP (same-row zones never needed this much room)', () => {
    expect(ZONE_VERTICAL_GAP).toBeGreaterThan(ZONE_GAP);
  });

  // Simulates the actual geometry: zone A ends at some Y; zone B starts
  // ZONE_VERTICAL_GAP below that (packAutoPlacedZones'/layoutAll's own
  // row-to-row cursor advance). The floating title above zone B reaches as
  // high as `titleBandHeight(zoom) + ZONE_TITLE_GAP_ABOVE` above zone B's
  // own top — this must never reach (or pass) zone A's bottom edge, at every
  // zoom down to the canvas floor.
  it('the floating title above zone B never reaches zone A\'s bottom edge, at zoom 0.1 / 0.3 / 1.0 (orchestrator\'s own verification zooms)', () => {
    const zoneABottomY = 1000; // arbitrary — only the GAP below matters
    const zoneBTopY = zoneABottomY + ZONE_VERTICAL_GAP;
    for (const zoom of [0.1, 0.3, 1.0]) {
      const titleFlowHeight = titleBandHeight(zoom, ZONE_HEADER_HEIGHT, ZONE_TITLE_MAX_FLOW_HEIGHT);
      const titleTopY = zoneBTopY - ZONE_TITLE_GAP_ABOVE - titleFlowHeight;
      expect(titleTopY).toBeGreaterThanOrEqual(zoneABottomY);
    }
  });

  it('holds even at the theoretical worst case (title pinned to its max height, not the live-zoom-derived one)', () => {
    const zoneABottomY = 0;
    const zoneBTopY = ZONE_VERTICAL_GAP;
    const worstCaseTitleTopY = zoneBTopY - ZONE_TITLE_GAP_ABOVE - ZONE_TITLE_MAX_FLOW_HEIGHT;
    expect(worstCaseTitleTopY).toBe(zoneABottomY); // exactly tight, not just "probably enough"
  });
});

// fix/canvas-title-full-name (founder, verbatim: "je veux le titre ENTIER
// tout le temps") — `headerClampMaxWidth` (chrome/lod.ts) is REMOVED: it
// capped the zone title caption's on-screen footprint at its own frame's
// width, which is exactly what forced the name span to ellipsis-truncate
// down to a single letter at low zoom (a narrow zone's width divided by the
// LOD scale factor collapses to a few flow px). The caption is now sized to
// its own full, untruncated content (`width: max-content`,
// ProjectGroupNode.tsx) — the horizontal collision that clamp used to
// prevent (a title painting over a neighbouring zone) is now prevented BY
// CONSTRUCTION instead (the round-2 geometric containment fix,
// `canvas-zone-header`'s outer `maxWidth: width` + `overflow: hidden`,
// unchanged by scratch/_canvas-label-design.md). `ZONE_HORIZONTAL_GAP` below
// is therefore no longer the ACTIVE same-row packing gap (that's now
// `geometry.ts`'s flat `ZONE_PACK_HORIZONTAL_GAP_FLOW_PX`, 64 — see
// reconcilerZones.test/layout.test's own packing suites) — kept as a
// documented theoretical worst-case bound only, its own worked math still
// locked here so a future change to the underlying LOD/chrome constants
// doesn't silently drift unnoticed.
describe('ZONE_TITLE_MAX_FLOW_WIDTH / ZONE_HORIZONTAL_GAP — theoretical worst-case horizontal reach (fix/canvas-title-full-name, no longer the active packing gap)', () => {
  it('ZONE_TITLE_CONTENT_MAX_WIDTH_PX is the typical-max-name text width plus its fixed chrome', () => {
    expect(ZONE_TITLE_CONTENT_MAX_WIDTH_PX).toBeCloseTo(
      ZONE_TITLE_TYPICAL_MAX_NAME_CHARS * ZONE_LABEL_CONTENT_PX * ZONE_TITLE_AVG_CHAR_WIDTH_RATIO + ZONE_TITLE_CHROME_WIDTH_PX,
      6,
    );
  });

  // scratch/_canvas-label-design.md §3.2 — the bounded LOD_FLOOR_ZOOM (0.25)
  // caps this factor at ~3.68x now (was ~9.2x at the old 0.1 floor).
  it('ZONE_TITLE_MAX_FLOW_WIDTH is the content width times the SAME max LOD scale factor the title\'s own transform reaches at the zoom floor', () => {
    const maxScale = lodScale(LOD_FLOOR_ZOOM, ZONE_LABEL_CONTENT_PX, ZONE_LABEL_LOD_TARGET_PX);
    expect(maxScale).toBeCloseTo(3.68, 2);
    expect(ZONE_TITLE_MAX_FLOW_WIDTH).toBeCloseTo(ZONE_TITLE_CONTENT_MAX_WIDTH_PX * maxScale, 6);
  });

  it('ZONE_HORIZONTAL_GAP is exactly ZONE_TITLE_MAX_FLOW_WIDTH — the "simpler and robust" shape (gap alone covers the title\'s worst-case reach)', () => {
    expect(ZONE_HORIZONTAL_GAP).toBe(ZONE_TITLE_MAX_FLOW_WIDTH);
  });

  it('is strictly larger than the plain lane-gutter ZONE_GAP (a full-name title needs far more room than the internal lane chrome gap)', () => {
    expect(ZONE_HORIZONTAL_GAP).toBeGreaterThan(ZONE_GAP);
  });

  // Simulates the actual geometry: zone A (left) sits at x=0 with some
  // width; zone B (right, same row) starts at zoneA.width + ZONE_HORIZONTAL_GAP
  // (packAutoPlacedZones'/layoutAll's own same-row cursorX advance). The
  // floating title above zone A reaches as far right as
  // ZONE_TITLE_MAX_FLOW_WIDTH from zone A's own left edge (its anchor,
  // `left: 0` — ProjectGroupNode.tsx) — this must never reach (or pass)
  // zone B's own left edge, at every zone-A width down to the worst case
  // (a vanishingly narrow zone).
  it('the floating title above zone A never reaches zone B\'s left edge, for any zone-A width (worst case: 0)', () => {
    for (const zoneAWidth of [0, 220, 380, 1200]) {
      const zoneBLeftX = zoneAWidth + ZONE_HORIZONTAL_GAP;
      const titleRightReachX = ZONE_TITLE_MAX_FLOW_WIDTH; // from zone A's own left edge (x=0)
      expect(titleRightReachX).toBeLessThanOrEqual(zoneBLeftX);
    }
  });

  it('holds even at the theoretical worst case (zone A has zero width) — exactly tight, not just "probably enough"', () => {
    const zoneAWidth = 0;
    const zoneBLeftX = zoneAWidth + ZONE_HORIZONTAL_GAP;
    expect(ZONE_TITLE_MAX_FLOW_WIDTH).toBe(zoneBLeftX);
  });
});
