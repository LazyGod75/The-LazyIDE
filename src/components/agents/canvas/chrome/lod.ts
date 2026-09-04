/* lod.ts — constant SCREEN-size level-of-detail compensation
   (W-UX3 finding A: "quand on dézoome, les agents deviennent invisibles").

   React Flow renders every node inside `.react-flow__viewport`, which the
   library itself scales with ONE CSS `transform: translate(...) scale(zoom)`
   — so anything sized in FLOW units shrinks screen-linearly with zoom. The
   fleet-view dot (nodeChrome.tsx's `DOT_SIZE`, 20 flow px) is a crisp 20
   screen px at zoom 1, but a mere 2 screen px at zoom 0.1 — invisible,
   exactly David's own repro ("20px x zoom 0.1 = 2px"). Same problem, same
   fix, for a project zone's header name label (ProjectGroupNode.tsx): its
   12.5px font is genuinely 12.5 CSS px, but that's still measured in FLOW
   space, so it shrinks with the same zoom.

   The fix is the standard "map marker/label" trick: apply an INVERSE-zoom
   `transform: scale(...)` on the element itself so its FLOW size * zoom *
   compensation holds at a constant SCREEN size, down to a floor zoom —
   below that floor the compensation stops growing ("capped"), so content
   gracefully shrinks again past that point instead of the transform scale
   climbing without bound as zoom approaches 0.

   ── Perf: transform-only, ONE subscription, not one per node ───────────
   The zoom value already flows into this app once, at CanvasToolbar's own
   `useViewport()` (its live "42%" readout re-renders THAT ONE component
   every zoom tick — an already-accepted cost). Rather than every dot/zone-
   label subscribing individually (which would re-render N nodes on every
   wheel tick — the "re-render storm" the brief explicitly warns against),
   CanvasLodBroadcaster.tsx taps that SAME kind of subscription exactly
   ONCE more and relays the two computed scales as CSS custom properties
   written directly onto the canvas container's DOM node (imperative, no
   React state) — every dot/zone-label just reads
   `var(--canvas-lod-dot-scale, 1)` / `var(--canvas-lod-zone-label-scale, 1)`
   in its own inline `transform`, and the browser's CSS cascade does the
   rest for free. No node anywhere on the canvas re-renders because of this.
*/

/**
 * Zoom below which the compensation stops growing.
 *
 * scratch/_canvas-label-design.md §3.2 ("compensation bornée, le modèle
 * tldraw") — raised 0.1 -> 0.25: tldraw's own `FrameHeading.tsx` caps its
 * equivalent compensation at `min(scale, 3.5)` (source read, see that design
 * doc's own Sources section) and lets a frame label shrink WITH the canvas
 * below that, rather than holding a constant screen size all the way to the
 * technical zoom floor. At the OLD 0.1 floor, holding {@link
 * ZONE_LABEL_LOD_TARGET_PX} constant cost up to 9.2x of flow-space per
 * contre-scaled element (`11.5 / (12.5 * 0.1)`) — that worst case is what
 * forced the oversized "airtight" packing gaps (`geometry.ts`'s old
 * `ZONE_VERTICAL_GAP`/`ZONE_HORIZONTAL_GAP` formulas) that in turn inflated
 * the whole-canvas bounding box and collapsed "fit" to an illegible zoom —
 * the design doc's own diagnosed feedback loop (root cause C). At 0.25 the
 * SAME compensation costs at most ~3.7x (`11.5 / (12.5 * 0.25)`), aligned
 * with tldraw's own 3.5x — small enough that the packing gaps derived from
 * it collapse to small flat constants instead of needing "airtight at the
 * absolute floor" protection (see `geometry.ts`'s `ZONE_VERTICAL_GAP`).
 * Nothing is hidden or swapped by this change (W-CARDS's own "no semantic
 * zoom" rule is untouched) — content below this floor keeps shrinking
 * WITH the canvas, continuously, exactly like every other un-compensated
 * element already does; it simply stops holding a constant screen size past
 * this point instead of continuing to grow the multiplier without bound.
 *
 * `CanvasView.tsx`'s own React Flow `minZoom` prop is now DERIVED from this
 * same design (see that file's `dynamicMinZoom`) rather than a separately
 * hardcoded number, so the two can no longer drift apart the way the old
 * fixed `0.1`/`0.1` pair could.
 */
export const LOD_FLOOR_ZOOM = 0.25;

/** Fleet-view dot target — constant screen px the dot itself should read
 *  at, from {@link LOD_FLOOR_ZOOM} up to the zoom where dots stop being
 *  rendered at all (ZOOM_DOT, canvasTypes.ts). Comfortably inside the
 *  brief's own "~16-18 screen px" range. */
export const DOT_LOD_TARGET_PX = 18;

/** Zone header label target — constant screen px the zone name/count
 *  content should read at once zoomed out far enough to otherwise dip
 *  below it. Inside the brief's own "~11-12 screen px" range. */
export const ZONE_LABEL_LOD_TARGET_PX = 11.5;

/** fix/canvas-legibility — mission billboard chip (MissionNode.tsx's
 *  'chip' zoom tier): the chip's own flow-space content width (title +
 *  glyphs + hint, canvas.css's `.canvas-mission-chip`) and the constant
 *  screen px it should read at once zoomed below ZOOM_CHIP. Reuses
 *  `lodScale` verbatim (same inverse-zoom compensation trick as the fleet
 *  dot/zone label above) — no new function needed. */
export const MISSION_CHIP_CONTENT_WIDTH = 132;
export const MISSION_CHIP_LOD_TARGET_PX = 116;

/** The zone header's own resting font-size (ProjectGroupNode.tsx's
 *  `project-node-name` span) — the FLOW-space size the compensation is
 *  computed against, so `zoom >= ~0.92` (12.5 * 0.92 ≈ 11.5) never touches
 *  the label at all (see `lodScale`'s "already legible" early return). */
export const ZONE_LABEL_CONTENT_PX = 12.5;

/**
 * Multiply an element's own flow-space size by this to render it at a
 * constant `targetScreenPx` on screen, for any `zoom` down to
 * {@link LOD_FLOOR_ZOOM} — below that floor the compensation itself no
 * longer grows, so the element gracefully shrinks again rather than the
 * transform scale climbing without bound as zoom approaches 0.
 *
 * Returns exactly `1` (a no-op transform) whenever the element's NATURAL
 * screen size (`contentPx * zoom`) is already at or above the target — a
 * zoomed-in or at-rest canvas must never see this shrink or otherwise
 * touch content that's already legible.
 */
export function lodScale(zoom: number, contentPx: number, targetScreenPx: number): number {
  if (contentPx <= 0 || targetScreenPx <= 0) return 1;
  const naturalScreenPx = contentPx * zoom;
  if (naturalScreenPx >= targetScreenPx) return 1;
  const flooredZoom = Math.max(zoom, LOD_FLOOR_ZOOM);
  return targetScreenPx / (contentPx * flooredZoom);
}

/* ══════════════════════════════════════════════════════════════════════
   fix/canvas-header-overflow — measured bug: at low zoom (David's own
   14-17% repro), a project/frame header's LOD-compensated identity
   cluster (`lodScale` above keeps its CONTENT at a constant screen size)
   grows its own occupied FLOW-space footprint by that same compensation
   factor. A footprint that fit comfortably inside its own frame at zoom 1
   does not shrink along with the frame once the frame itself shrinks with
   zoom — it keeps its (roughly) constant on-screen size regardless, so it
   eventually overflows past the frame's own edge and paints over whatever
   sits there (a neighbouring frame's own title, in the reported repro).
   These two thresholds gate the DOM-level reductions (hiding secondary
   badges, then the header row itself) a pure CSS transform cannot express
   on its own.

   fix/canvas-title-full-name (founder, verbatim: "je veux le titre ENTIER
   tout le temps") — this section USED TO also ship a geometric `max-width`
   clamp (`headerClampMaxWidth`, applied unconditionally at every zoom) that
   capped the header's on-screen footprint at its own frame's width. That
   clamp is REMOVED: at low zoom, a narrow/small zone's frame width divided
   by the (large) LOD scale factor collapsed to a few flow px, forcing the
   title's own name span to ellipsis-truncate down to a single letter
   ("Transverse" -> "T") — the exact bug this fix removes. The title caption
   (ProjectGroupNode.tsx's `canvas-zone-header`) is now sized to its own
   natural content (`width: max-content`, no clamp) and can legitimately grow
   past its own zone's edge; the horizontal collision this used to prevent
   (a title painting over a NEIGHBOURING zone's title/box) is now guarded by
   a wider same-row packing gap instead (geometry.ts's `ZONE_HORIZONTAL_GAP`
   — see that constant's own doc comment for the worked math) rather than by
   truncating the name.
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Below this zoom, a project/frame header's secondary badges (running-count
 * chip, approval-mode badge, urgent-count badge) drop out, leaving the
 * identity cluster (chevron/status-dot/title) alone — "reduce to
 * title-only" per the fix brief. Chosen comfortably above
 * {@link HEADER_MINIMAL_ZOOM} so there is a visible middle band between
 * "full header" and "title only".
 *
 * fix/canvas-legibility-toolbar-overlap — the urgent-count badge was
 * ORIGINALLY missing from this list: ProjectGroupNode.tsx gated it on
 * `headerTier !== 'minimal'` instead of `headerTier === 'full'` like its two
 * siblings, so it kept rendering through the whole 'reduced' band (this
 * constant down to {@link HEADER_MINIMAL_ZOOM}) — the actual bug behind
 * "count badge covers the title" at David's 0.21 repro. Fixed to the same
 * `=== 'full'` gate; this doc comment corrected to match so "secondary
 * badges" stays an accurate, complete list for the next reader.
 */
export const HEADER_CLAMP_ZOOM = 0.35;

/**
 * Below this (lower) zoom, even the reduced title-only header row is too
 * cramped to carry its own chrome (chevron, status dot, row padding/
 * border) — only the bare, still-LOD-compensated title text remains.
 */
export const HEADER_MINIMAL_ZOOM = 0.2;

/**
 * Below this zoom, a node's hover-reveal action buttons (HoverActionStrip.tsx
 * — small ~12px icon glyphs in a ~20px hit target) stop rendering entirely,
 * even on hover — unusably tiny at that screen size, and (per this
 * codebase's own "one subscription, not one per node" discipline, this
 * module's own header above) gated via a single broadcast data-attribute
 * (CanvasLodBroadcaster.tsx's `data-canvas-hover-chrome`, chrome/canvas.css's
 * matching rule) rather than a per-card zoom subscription.
 */
export const HOVER_ACTIONS_MIN_ZOOM = 0.3;

/* ══════════════════════════════════════════════════════════════════════
   fix/canvas-title-band-zoom — founder's refined W-CARDS rule, verbatim:
   "juste le titre et la zone de titre doivent s'adapter, actuellement si
   je dézoome le texte devient illisible et la zone de titre trop petite".
   The title text ITSELF already gets constant-screen-size compensation
   (`lodScale` above, applied to ProjectGroupNode.tsx's identity-cluster
   span) — but until this fix, the BOX that text sits in
   (`canvas-zone-header`, a fixed `ZONE_HEADER_HEIGHT` = 36 flow px with
   `overflow: hidden`) did NOT scale with it. At zoom 0.13, 36 flow px is
   only 36*0.13 ≈ 4.7 SCREEN px tall — the compensated text (rendered at a
   constant ~11.5 screen px via `transform: scale`) physically cannot fit
   inside a 4.7px box and gets clipped by `overflow: hidden`, exactly
   David's "zone de titre trop petite" repro. This is the header ROW's own
   companion compensation: instead of scaling existing content, it grows
   the row's own flow-space HEIGHT so its on-screen size holds at
   {@link ZONE_TITLE_BAND_TARGET_PX} down to {@link LOD_FLOOR_ZOOM}, the
   same floor/target shape as `lodScale` above (just producing a height in
   flow px instead of a dimensionless scale factor).

   fix/canvas-title-float — this function's own math is UNCHANGED by that
   later fix: the row still needs to grow its flow-space height to avoid
   clipping its own LOD-scaled content. What changed is WHERE that grown
   row lives: `ProjectGroupNode.tsx`'s `canvas-zone-header` used to grow
   DOWNWARD, inside the zone frame (pushing mission cards down to make
   room) — it now floats ABOVE the frame's own top edge instead
   (`position: absolute; bottom: calc(100% + gap)`), growing UPWARD into
   open canvas space. The caller (`CanvasLodBroadcaster.tsx`) now clamps
   this function's own `maxFlowPx` bound to `geometry.ts`'s
   `ZONE_TITLE_MAX_FLOW_HEIGHT` directly, instead of the old
   `ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT` expression (that
   expression's meaning changed too — see `ZONE_TITLE_BAND_HEIGHT`'s own
   doc comment in geometry.ts) — same numeric value (440), decoupled from
   a constant that no longer means "the header's ceiling".
   ══════════════════════════════════════════════════════════════════════ */

/** Header/title band target — constant screen px the zone header ROW
 *  (title + count chip + approval badge, one coherent line per the
 *  founder — "they are part of the band") should measure at once zoomed
 *  out far enough that its resting `ZONE_HEADER_HEIGHT` (geometry.ts, 36
 *  flow px) would otherwise shrink below comfortable reading height. A
 *  touch taller than {@link ZONE_LABEL_LOD_TARGET_PX} (11.5, the TEXT's own
 *  target) since this is the whole row's box, not just the glyph height —
 *  needs a little padding above/below the compensated text to still read
 *  as a "band" rather than the text touching the row's own edges. */
export const ZONE_TITLE_BAND_TARGET_PX = 44;

/**
 * The zone header row's own effective flow-space HEIGHT for a given live
 * `zoom`, so that `titleBandHeight(zoom, ...) * zoom` holds at
 * {@link ZONE_TITLE_BAND_TARGET_PX} screen px for every zoom down to
 * {@link LOD_FLOOR_ZOOM} — the same "map marker" trick as `lodScale`, but
 * returning an absolute flow-space size (a CSS `height`) instead of a
 * `transform: scale(...)` multiplier, because growing a clipped box's own
 * height is what actually stops it from clipping its (separately
 * compensated) text content — a transform on the text alone can't do that.
 *
 * `minFlowPx`/`maxFlowPx` clamp the result — geometry.ts's own doc comment
 * on `ZONE_TITLE_BAND_HEIGHT` has the full worked math for why those two
 * bounds are `ZONE_HEADER_HEIGHT` (36, the row's original resting height —
 * never shrink below the pre-fix design at high zoom) and
 * `ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT` (440, the FIXED flow-space
 * offset every mission-card child and LaneGuides already starts at,
 * reconcilerZones.ts/layout.ts — the header's own box can visually grow at
 * most that far without ever painting over a real child, at any zoom).
 */
export function titleBandHeight(zoom: number, minFlowPx: number, maxFlowPx: number): number {
  const flooredZoom = Math.max(zoom, LOD_FLOOR_ZOOM);
  const raw = ZONE_TITLE_BAND_TARGET_PX / flooredZoom;
  return Math.min(maxFlowPx, Math.max(minFlowPx, raw));
}
