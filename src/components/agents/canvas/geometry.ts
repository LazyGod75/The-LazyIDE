/* geometry.ts — single source of truth for the Agent Canvas's placement
   grid, zone chrome, and lane-mode geometry (W6b geometry fix wave).

   Before this file, reconciler.ts (zone/child placement) and layout.ts
   (elkjs zone packing + lane layout) each independently duplicated the
   SAME pixel values "by convention" (see layout.ts's prior header comment
   for the rationale — avoiding a reconciler -> layout import cycle, since
   layout.ts already imports FROM reconciler.ts for its node/edge types).
   That convention is exactly how the values drifted out of sync with the
   ACTUAL rendered card size (nodeChrome.tsx's NodeCard had no fixed
   width/max-height at all), which is the root cause of the W6b geometry
   bugs: overlapping zones, overlapping full cards at zoom >= ZOOM_COMPACT,
   a zone tint box too small for its own children, and a lane mode with no
   real lane width.

   This module breaks that cycle instead of perpetuating it: plain
   numeric/derived exports only, zero React, zero imports from
   reconciler.ts/layout.ts/canvasTypes.ts — safe for reconciler.ts's own
   "pure functions only: no React, no I/O" contract, and importable from
   nodeChrome.tsx (a React module) without creating a cycle either.

   fix/canvas-title-band-zoom — the one exception is `./chrome/lod.ts`: a
   leaf module with zero imports of its own (never imports FROM this file,
   so no cycle), holding the LOD screen-size-compensation constants/
   functions every zoom-adaptive element on the canvas shares. Importing its
   {@link ZONE_TITLE_BAND_TARGET_PX}/`LOD_FLOOR_ZOOM` here single-sources
   the title band's worst-case math (below) instead of duplicating the "44"
   and "0.1" as a second, driftable magic number in this file.
*/

import { LOD_FLOOR_ZOOM, ZONE_LABEL_CONTENT_PX, ZONE_LABEL_LOD_TARGET_PX, ZONE_TITLE_BAND_TARGET_PX, lodScale } from './chrome/lod';

// ── Full-card footprint (spec §4.5 "full" zoom cards — mission/loop/
//    schedule/draft, nodeChrome.tsx's NodeCard). NoteNode is deliberately
//    excluded: it never grows past a small fixed footprint (a short text
//    write-surface, not an action card with unbounded optional rows), so
//    it was never part of the unbounded-height problem this fixes.
//
//    R2b visual overhaul (docs/superpowers/specs/2026-07-15-canvas-visual-
//    brief.txt's nodeSpec) — 260px fixed width replaces the old 300px: the
//    brief's mined value (Flowise/Langflow card width), denser and more
//    legible against the flat #1a1d23-equivalent card background. Height
//    grows slightly (210 -> 236) to fit the new 44px header row + 28px
//    stage-rail band (72px combined chrome vs. the old ~40px), so real
//    body content (live-action line, progress bar, meta chips) still has
//    room without the max-height clip kicking in constantly. ────────────
export const FULL_CARD_WIDTH = 260;
export const FULL_CARD_MAX_HEIGHT = 236;

/** nodeSpec's minimum card height formula: `max(88, stageRailHeight(28) +
 *  headerHeight(44) + 2*padding(12))` = 88px baseline for a 0/1-output
 *  node; router nodes with >1 branch add ROUTER_MIN_HEIGHT_STEP per extra
 *  output anchor beyond the first (Flowise `getMinimumNodeHeight`,
 *  adapted). A floor, not a cap — real content (live-action text, gate
 *  forms) still grows the card past this via normal flex sizing; only
 *  `FULL_CARD_MAX_HEIGHT` above clips. */
export const NODE_MIN_HEIGHT = 88;
export const ROUTER_MIN_HEIGHT_STEP = 20;

/** nodeSpec's exact chrome measurements — single source of truth for the
 *  header row height / stage-rail band height / card padding every node
 *  kind's card shell (chrome/nodeChrome.tsx) reads, instead of each card
 *  re-declaring its own magic numbers. */
export const NODE_HEADER_HEIGHT = 44;
export const NODE_STAGE_RAIL_HEIGHT = 28;
export const NODE_PADDING_X = 12;
export const NODE_PADDING_BOTTOM = 8;

// ── Placement grid cell — reconciler.ts's per-child grid slot. Must fit
//    the LARGEST possible render of any zoom level (the 'full' card,
//    zoom >= ZOOM_COMPACT is the biggest of the three buckets) plus a
//    fixed margin, so two adjacent slots' cards never touch at any zoom.
//
//    Design pass (dezoom legibility, founder screenshots at 20-30% zoom:
//    "cartes entassees dans des zones geantes vides") — CELL_MARGIN shrunk
//    30 -> 18: FULL_CARD_MAX_HEIGHT is a hard `overflow:hidden` clip
//    (nodeChrome.tsx's NodeCard), not a "typical" size, so cards can never
//    touch even at a much smaller margin than before; the old 30px gap was
//    comfort padding, not a correctness floor. Tighter cells mean a zone's
//    own bounding box hugs its real children more closely instead of
//    reserving visibly excess air between them. ──────────────────────────
// Exported (not just a local const) so tests that want to assert "a real
// breathing-room margin, not just 1px" (layout.test.ts's own laneLayout
// suite) can reference this value symbolically instead of re-hardcoding a
// copy that silently drifts out of sync whenever this constant is tuned.
export const CELL_MARGIN = 28;
export const GRID_CELL_WIDTH = FULL_CARD_WIDTH + CELL_MARGIN; // 288
export const GRID_CELL_HEIGHT = FULL_CARD_MAX_HEIGHT + CELL_MARGIN; // 264

// ── Zone chrome ──────────────────────────────────────────────────────
/** Design pass (dezoom legibility) — 32 -> 24: a zone's own outer
 *  padding on every side (`computeBoundingBox`'s right/bottom pad,
 *  `gridSlotPosition`'s left pad). Kept comfortably above the minimum this
 *  file's own R-ZONE declutter test assumes (`ZONE_PADDING*2 +
 *  FULL_CARD_WIDTH > 300` — 24*2+260=308, still true) — tighter, never
 *  cramped against a card's own edge. */
export const ZONE_PADDING = 40;
/** R2b chromePlan §5 — 36px zone header, at rest (zoom ~1). Originally
 *  this was the in-flow header row's own fixed height; fix/canvas-title-
 *  float moved that row OUT of the frame entirely (see `ZONE_TITLE_BAND_
 *  HEIGHT`'s own doc comment below for the full "why"), so today this
 *  constant does double duty, at the SAME value on purpose:
 *   (1) the floating title row's own RESTING flow-space height
 *       (`ProjectGroupNode.tsx`'s `canvas-zone-header`, `chrome/lod.ts`'s
 *       `titleBandHeight` lower clamp) — the row never shrinks below this
 *       even zoomed in past 100%;
 *   (2) the small top content-inset `reconcilerZones.ts`'s `gridSlotPosition`
 *       and `layout.ts`'s `laneLayout`/`layoutZone` start a zone's children
 *       at, now that there's no in-flow header to clear.
 *  These are two independent concerns that happen to share one historical
 *  number — a deliberate reuse (one less magic number), not a hidden
 *  coupling: either could be split into its own constant later without
 *  affecting the other. */
export const ZONE_HEADER_HEIGHT = 36;

/** fix/canvas-title-float (founder, 4th reported occurrence of this exact
 *  bug, verbatim: "pourquoi je vois des agents sur le titre de la zone
 *  projet, je peux même pas lire le nom" + the fix he asked for, verbatim:
 *  "mets le nom et la zone du titre juste AU-DESSUS de la zone") — every
 *  prior attempt at this fix (see HISTORY below) reserved a gap INSIDE the
 *  frame, below the header and above row 0, and grew that reservation every
 *  time a new repro landed. That approach never actually closes the bug: a
 *  child's position can be a STALE persisted value from before whatever
 *  reservation existed at the time it was saved (`reconcilerZones.ts`'s own
 *  hard rule, "an existing position is NEVER moved"), so growing the
 *  reserved band can never retroactively fix an already-placed card that
 *  sits inside the new, bigger band. `nodes/ProjectGroupNode.tsx`'s zone
 *  title (name + its identity row: running-count chip, approval-mode
 *  badge) no longer lives INSIDE this frame at all — it's rendered as a
 *  separate, absolutely-positioned label floating ABOVE the frame's own top
 *  edge (`canvas-zone-header`'s `position: absolute; bottom: calc(100% +
 *  gap)`, anchored to the frame's own top-left) — see that file's own doc
 *  comment for the full rendering approach. Structurally, this can never
 *  regress the same way again: nothing rendered INSIDE the frame's own
 *  rectangle can ever occupy the same pixels as a label that isn't
 *  geometrically part of that rectangle, regardless of any stale/legacy
 *  child position.
 *
 *  This constant's OLD job — capping how tall the header could grow
 *  INSIDE the frame — no longer exists (there is no header inside the
 *  frame to cap). It is kept at a small, honest value (rather than deleted)
 *  purely as the last few pixels of top content-inset `gridSlotPosition`
 *  adds on top of `ZONE_HEADER_HEIGHT` below — see that function's own
 *  call site: children now start at `ZONE_HEADER_HEIGHT +
 *  ZONE_TITLE_BAND_HEIGHT` = 36, filling the box from very near its real
 *  top, instead of the previous 440px dead gap this fix removes.
 *
 *  The title's own WORST-CASE flow-space footprint (this constant's old
 *  reason to be 404) still exists and still needs guarding against — just
 *  against a DIFFERENT hazard now: the title floats OUT of its own frame
 *  and UP into the space above it, so what it can collide with is
 *  whatever sits in THAT space (another zone's own bottom edge), not this
 *  zone's own children. That worst-case number now lives in {@link
 *  ZONE_TITLE_MAX_FLOW_HEIGHT} below, sized identically (`TARGET / LOD_FLOOR_ZOOM`)
 *  but consumed by the inter-zone vertical-spacing guard ({@link
 *  ZONE_VERTICAL_GAP}) instead of by this in-frame offset.
 *
 *  HISTORY: 300px (sized to fit `nodes/ZoneAggregateSummary.tsx`'s
 *  dormant aggregate-tier digest chip, before W-CARDS forced
 *  `ZOOM_AGGREGATE` to 0) -> 56px (a plain breathing-room margin once that
 *  chip stopped being the reason) -> 404px (fix/canvas-title-band-zoom:
 *  grown to cap the header's OWN in-frame LOD-driven height growth — see
 *  `chrome/lod.ts`'s `titleBandHeight`) -> this (fix/canvas-title-float:
 *  the header stopped growing INSIDE the frame at all). Each step fixed a
 *  real, narrower bug than the last, but growing an IN-FRAME reservation
 *  was never going to survive a stale persisted child position — the
 *  actual reason David kept re-reporting the same symptom. */
export const ZONE_TITLE_BAND_HEIGHT = 0;

/** fix/canvas-title-float — the floating zone-title row's own worst-case
 *  flow-space HEIGHT (`ProjectGroupNode.tsx`'s `canvas-zone-header`, and
 *  `chrome/lod.ts`'s `titleBandHeight`, which this value now caps at
 *  instead of the old `ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT`
 *  expression — that expression means something else now, see
 *  `ZONE_TITLE_BAND_HEIGHT`'s own doc comment above). Same worked math as
 *  before: the row must hold `ZONE_TITLE_BAND_TARGET_PX` (44) screen px at
 *  the canvas's own real zoom floor (`LOD_FLOOR_ZOOM`, 0.25) — anything less
 *  and the row (and the title inside it) is provably clipped at the
 *  canvas's own minimum zoom. `44 / 0.25 = 176`. */
export const ZONE_TITLE_MAX_FLOW_HEIGHT = ZONE_TITLE_BAND_TARGET_PX / LOD_FLOOR_ZOOM; // 176

/** fix/canvas-title-float — fixed breathing gap (flow px, deliberately NOT
 *  itself zoom-compensated: a hairline visual gap between two boxes, not
 *  text that needs to stay readable) between the floating title's own top
 *  edge and whatever sits directly above it. `ProjectGroupNode.tsx`
 *  positions the row at `bottom: calc(100% + ZONE_TITLE_GAP_ABOVE px)`
 *  relative to its own frame — i.e. this far above the frame's own top
 *  border, at every zoom, regardless of how tall the row itself grows. */
export const ZONE_TITLE_GAP_ABOVE = 16;

/** fix/canvas-title-float — vertical gap between two zones STACKED in the
 *  same column (`reconcilerZones.ts`'s `packAutoPlacedZones` / `layout.ts`'s
 *  `layoutAll`, both row-to-row shelf-packing cursor advances). Distinct
 *  from {@link ZONE_GAP} (still used for the SAME-ROW horizontal gap
 *  between zones, and the lane-gutter-to-first-lane-column gap) — neither
 *  of those is ever in the floating title's vertical path, since the
 *  title's own on-screen width is clamped to its OWN zone's frame width
 *  (`chrome/lod.ts`'s `headerClampMaxWidth`, plus the row's own direct
 *  `maxWidth` — see `ProjectGroupNode.tsx`) and can never bleed sideways
 *  into a same-row neighbour.
 *
 *  THE SPACING MATH (requirement: a title floating above zone B must never
 *  land on zone A's bottom edge, at ANY zoom down to the canvas's real
 *  floor): zone B's own floating title can grow to {@link
 *  ZONE_TITLE_MAX_FLOW_HEIGHT} flow px tall, floating upward
 *  starting {@link ZONE_TITLE_GAP_ABOVE} (16) px above zone B's own top
 *  edge — so the title's own top edge can reach as high as
 *  `ZONE_TITLE_MAX_FLOW_HEIGHT + ZONE_TITLE_GAP_ABOVE` flow px above zone
 *  B's top, at the canvas's zoom floor. Zone A
 *  (the row directly above zone B in the shelf-pack) must end at least
 *  that far above zone B's top for the two to never touch — i.e. the
 *  packer's row-to-row cursor advance (zone A's bottom + this gap = zone
 *  B's top) must be >= that sum. Sized to EXACTLY that sum (not a padded round
 *  number) so the invariant is provably tight rather than "probably
 *  enough" — see canvasLod.test.ts's own worked-math coverage. */
export const ZONE_VERTICAL_GAP = ZONE_TITLE_MAX_FLOW_HEIGHT + ZONE_TITLE_GAP_ABOVE; // 192

/** Empty-zone footprint (defect #6 "living empty zones" fix) — a project
 *  with zero CURRENT missions now renders a real digest body (last
 *  activity line, up to 3 recent-mission ghost rows, merged-today count, a
 *  « Lancer un agent » CTA — see nodes/ProjectGroupNode.tsx) instead of a
 *  single centered hint line, so it needs real room: generous minimums
 *  (previously 320x200, a size only large enough for one line of muted
 *  text) rather than the smallest box that technically fits a hint.
 *  Lives here (not reconcilerZones.ts, which only consumed it before this
 *  fix) so it is governed by the same single-source-of-truth convention
 *  as every other zone/card constant in this module.
 *
 *  Design pass (dezoom legibility) — trimmed from 380x260: the digest body
 *  (1 activity line + up to 3 mission rows + a merged-today line + a CTA)
 *  still fits comfortably at this size (EmptyZoneDigest's own '14px 16px'
 *  padding + ~24px per row), it just no longer reserves more idle canvas
 *  real estate than that content needs — a genuinely-idle zone should read
 *  as calm/compact, not as a giant empty rectangle next to a busy one. */
export const EMPTY_ZONE_WIDTH = 340;
export const EMPTY_ZONE_HEIGHT = 224;
/** Fixed gap between the lane gutter and the first lane column (lane mode,
 *  spec CRITICAL 4) — an internal zone-chrome spacing concern the floating
 *  title caption never reaches (it floats OUTSIDE the frame entirely).
 *
 *  fix/canvas-title-float — VERTICAL (row-to-row) zone spacing uses {@link
 *  ZONE_VERTICAL_GAP} instead, sized to also clear the floating zone-title's
 *  own worst-case footprint (see that constant's own doc comment).
 *
 *  fix/canvas-title-full-name — this constant USED TO also govern the
 *  same-row HORIZONTAL gap between two packed zones (packAutoPlacedZones'/
 *  layoutAll's own cursorX advance) — that job moved to {@link
 *  ZONE_HORIZONTAL_GAP} below once the title caption's own `headerClampMaxWidth`
 *  clamp was removed (the founder's explicit rule: the full project name,
 *  always, never truncated — see ProjectGroupNode.tsx's own header comment):
 *  the caption can now grow past its own (possibly narrow) zone's width, so
 *  the same-row gap needs to be sized against the CAPTION's own worst-case
 *  width instead of this small, purely-internal lane value. */
export const ZONE_GAP = 60;

/** Assumed generous ceiling on a REAL project name's length in characters —
 *  covers virtually every real repo/folder name this app has ever shown
 *  (e.g. "training-week-generator" = 24, "lazy-backoffice-internet" = 25,
 *  even ZoneAggregateSummary.tsx's own cited real example,
 *  "lazy-e2e-soak-scratch-1784236548334" = 36). A name longer than this is
 *  the explicitly-permitted "pathological" case (ProjectGroupNode.tsx's
 *  floating title caption) that may extend further right, over empty
 *  canvas, rather than being guarded against by {@link ZONE_HORIZONTAL_GAP}
 *  below — this is a SPACING assumption, never a validation limit (a real
 *  project can still be named longer than this). */
export const ZONE_TITLE_TYPICAL_MAX_NAME_CHARS = 40;

/**
 * fix/canvas-zone-title-overlap (David's measured repro, 2026-08-14: at 18%
 * zoom, "uc-smoke-2026-08-12" overprints "uc-smoke-b", and one zone's own
 * "0 active"/"Merge: manua…" badges land under a neighbour's title) — a
 * HARD, zoom-invariant cap on how many characters of a zone's name the
 * floating header (`ProjectGroupNode.tsx`'s `canvas-zone-header`) ever
 * paints, truncated with a MIDDLE ellipsis (`lib/truncateMiddle.ts`'s
 * `truncateMiddle` — never a silent cut, and never an END ellipsis: see
 * that module's own header for why a real project's discriminating suffix
 * — `-b`/`-c`/a trailing date — must survive truncation). Deliberately NOT
 * the same knob as {@link ZONE_TITLE_TYPICAL_MAX_NAME_CHARS} above (that one
 * sizes a SPACING GUARD around the founder's "full name, never truncated"
 * rule for the packing gaps between zones): this is the opposite decision
 * for the header ITSELF, reversed by explicit product direction — no
 * adaptive hiding at zoom (the hard constraint every other zoom-adaptive
 * element on this canvas already follows, chrome/lod.ts's module header),
 * so the reserved region's SIZE must be a fixed character count, never a
 * function of the live zoom or of how much room happens to be free.
 *
 * scratch/_canvas-label-design.md §3.1 — raised 22 -> 28: once the plaque's
 * budget goes to the NAME first (see {@link ZONE_TITLE_CHROME_WIDTH_PX}
 * below, shrunk from 160 to ~40 now that the counter chip/approval badge no
 * longer compete with the name inside the same contre-scaled cluster — they
 * moved into the zone's own in-frame header band, ProjectGroupNode.tsx), one
 * more character no longer costs as much flow-space at the zoom floor (the
 * compensation itself is also bounded now — see chrome/lod.ts's
 * `LOD_FLOOR_ZOOM`), so a slightly more generous cap still keeps the
 * header's worst-case on-screen footprint bounded while covering more real
 * names (`ZONE_TITLE_TYPICAL_MAX_NAME_CHARS`'s own cited examples:
 * "uc-smoke-2026-08-12" = 20, "training-week-generator" = 24) in full.
 *
 * Why a character cap and not a flow-space `maxWidth` in CSS: this header's
 * WHOLE identity cluster already sits inside a `transform:
 * scale(var(--canvas-lod-zone-label-scale))` (chrome/lod.ts's `lodScale`) —
 * a flow-space CSS width bound would itself get multiplied by that same
 * scale factor, so a "260 flow-px" cap would balloon at low zoom — the
 * opposite of bounded. A character count composes correctly with `lodScale`
 * instead: `lodScale`'s entire job is holding each character's ON-SCREEN
 * width roughly constant across zoom, so a fixed character count is what
 * actually yields a fixed SCREEN-space footprint, at every zoom,
 * unconditionally.
 */
export const ZONE_TITLE_RESERVED_NAME_CHARS = 28;

/** Conservative (generous) average glyph width for the title's own bold
 *  font (`ZONE_LABEL_CONTENT_PX`, chrome/lod.ts's 12.5px) as a fraction of
 *  its own font-size — proportional sans-serif BOLD text averages roughly
 *  0.5-0.6x its font-size per character; the higher end is used here,
 *  erring toward OVER-estimating width (the safe direction for a spacing
 *  guard: a too-generous estimate wastes a little canvas space, a
 *  too-stingy one under-spaces two zones).
 *
 *  fix/canvas-zone-title-full-at-floor: 0.56 → 0.62 after the live app at
 *  26% zoom still ellipsized "debounce" by exactly 2 layout px (real span
 *  scrollWidth 61 vs clientWidth 59 ⇒ ~7.6px/char actual vs 7.0 estimated).
 *  Lowercase-with-descenders bold titles in this app's own font run wider
 *  than the generic 0.5-0.6 heuristic; 0.62 covers the measured worst case
 *  with slack. */
export const ZONE_TITLE_AVG_CHAR_WIDTH_RATIO = 0.62;

/**
 * Fixed NON-name chrome the title caption always carries alongside the name
 * text itself (ProjectGroupNode.tsx's `canvas-zone-header`, the EXPANDED-
 * zone identity cluster): outer row padding (12px * 2 = 24), chevron glyph +
 * its gap (~8 + 8), status dot + its gap — a flat estimate, not a live DOM
 * measurement, same "erring wide" discipline as {@link
 * ZONE_TITLE_AVG_CHAR_WIDTH_RATIO}.
 *
 * scratch/_canvas-label-design.md §3.1 ("plaque nom-d'abord") — shrunk from
 * 160: the running-count chip (~50px), the approval-mode badge (~34px), and
 * their own lead-in gaps used to live INSIDE this same contre-scaled
 * cluster, taxing the name's own budget before a single character of the
 * name was drawn — the root cause diagnosed in that design doc (§1.3, "le
 * chrome passe avant le nom"): at the fit zoom a real 8-zone profile lands
 * on, that ~160px tax alone left a NEGATIVE budget for the name, which is
 * why headers rendered "uc"/"Laz" instead of a real name. Those two badges
 * (plus the report-icon button) now render in the zone's own in-frame
 * header band instead (`ProjectGroupNode.tsx`'s zone-header-band, at canvas
 * scale like a mission card — never contre-scaled, never hidden) — the
 * plaque itself carries only the color dot + chevron + name + the
 * "needs-you" badge (shown only when count > 0), so the budget this
 * constant reserves is genuinely just point+padding+chevron now. */
export const ZONE_TITLE_CHROME_WIDTH_PX = 40;

/** The title caption's own worst-case NATURAL (zoom=1, unscaled) content
 *  width: a typical-max-length project name plus its surrounding chrome —
 *  the "at rest" size `chrome/lod.ts`'s `--canvas-lod-zone-label-scale`
 *  transform then multiplies by, up to {@link lodScale}'s own floor-zoom
 *  factor (see {@link ZONE_TITLE_MAX_FLOW_WIDTH} below). */
export const ZONE_TITLE_CONTENT_MAX_WIDTH_PX =
  ZONE_TITLE_TYPICAL_MAX_NAME_CHARS * ZONE_LABEL_CONTENT_PX * ZONE_TITLE_AVG_CHAR_WIDTH_RATIO + ZONE_TITLE_CHROME_WIDTH_PX; // 40*12.5*0.56 + 160 = 440

/**
 * fix/canvas-title-full-name — the title caption's own worst-case FLOW-space
 * width, at the canvas's real zoom floor, for a typical-max-length project
 * name: the same "map marker" shape as {@link ZONE_TITLE_MAX_FLOW_HEIGHT}
 * above (a worst-case-at-the-floor-zoom footprint), just for WIDTH instead
 * of HEIGHT, and against an assumed-typical name length instead of a fixed
 * line-height target (width naturally depends on text length; a single
 * line's height doesn't). Reuses {@link lodScale} evaluated at {@link
 * LOD_FLOOR_ZOOM} — the EXACT same maximum compensation factor the title's
 * own `transform: scale(var(--canvas-lod-zone-label-scale))` (chrome/lod.ts,
 * ProjectGroupNode.tsx) ever reaches — rather than re-deriving a duplicate
 * copy of that arithmetic (9.2 = 11.5 / (12.5 * 0.1), same numbers
 * canvasLod.test.ts's own `lodScale` coverage already locks in).
 * `440 * 9.2 = 4048`.
 */
export const ZONE_TITLE_MAX_FLOW_WIDTH =
  ZONE_TITLE_CONTENT_MAX_WIDTH_PX * lodScale(LOD_FLOOR_ZOOM, ZONE_LABEL_CONTENT_PX, ZONE_LABEL_LOD_TARGET_PX);

/**
 * fix/canvas-title-full-name (founder, verbatim: "je veux le titre ENTIER
 * tout le temps" — the full project name, always, never truncated) —
 * SAME-ROW horizontal gap between two AUTO-packed zones
 * (`reconcilerZones.ts`'s `packAutoPlacedZones`, `layout.ts`'s `layoutAll`,
 * both same-row cursorX advances), replacing the plain {@link ZONE_GAP} for
 * this specific purpose. Removing the title caption's own `headerClampMaxWidth`
 * zone-width clamp (the actual cause of the single-letter-truncation bug —
 * see ProjectGroupNode.tsx's own header comment) means the caption's
 * flow-space footprint can now grow past its own (possibly narrow) zone's
 * right edge, floating over open canvas — so the SAME-ROW gap must be wide
 * enough that a typical-max-length title floating above the LEFT zone
 * (anchored to ITS OWN top-left, growing rightward) can never reach the
 * RIGHT zone's own left edge (title-over-box collision) or its own floating
 * title (title-over-title collision), at any zoom down to the canvas's
 * real floor.
 *
 * Sized to the task brief's own "simpler and robust" alternative: instead of
 * netting out the LEFT zone's own (variable, sometimes small) width — which
 * would require trusting a "minimum possible zone width" that could drift —
 * the gap alone covers the title's ENTIRE worst-case reach ({@link
 * ZONE_TITLE_MAX_FLOW_WIDTH}), independent of the left zone's own width (a
 * zero-width left zone is the worst case this guards against, same
 * "provably tight, not just probably enough" discipline {@link
 * ZONE_VERTICAL_GAP} already uses for the vertical axis). A name longer than
 * {@link ZONE_TITLE_TYPICAL_MAX_NAME_CHARS} is the explicitly-permitted
 * "pathological" case that may extend further right, onto empty canvas,
 * rather than being guarded against here — the same trade-off the founder's
 * own brief accepts explicitly ("allow the caption to extend rightward over
 * EMPTY canvas ... rather than truncate").
 *
 * Distinct from {@link ZONE_GAP} (unchanged, still governs ONLY the
 * lane-mode gutter-to-first-lane-column gap — an internal zone-chrome
 * concern the title caption never reaches, so it keeps its original,
 * smaller value).
 */
export const ZONE_HORIZONTAL_GAP = ZONE_TITLE_MAX_FLOW_WIDTH;

/**
 * P2-16 fix (real QA repro: two open projects placed ~10 000 flow px apart,
 * "fit" collapsing to ~17% zoom — screenshot qa-manager-2026-07-25/shots/
 * 002-010-projects-open.png) — {@link ZONE_HORIZONTAL_GAP} above is
 * mathematically airtight (a title can never reach a same-row neighbour, at
 * ANY zoom down to the canvas's absolute technical floor, for a name up to
 * the typical-max length) but that airtightness is bought by guarding a zoom
 * ({@link LOD_FLOOR_ZOOM}, 0.1) and a name length ({@link
 * ZONE_TITLE_TYPICAL_MAX_NAME_CHARS}, 40) the COMMON case never actually
 * reaches: "fit" only zooms out as far as the content requires, so a gap
 * sized for the theoretical worst case inflates the content itself, which
 * then forces "fit" to zoom out further than any REAL title ever needed
 * protecting against — the exact feedback loop behind the reported defect.
 *
 * `zoneSameRowPackGap` breaks that loop for the actual same-row packing
 * advance (`packAutoPlacedZones`'s/`layoutAll`'s own cursorX step) by sizing
 * the gap against THIS zone's own REAL name length (never the generic
 * 40-char ceiling — "espacement proportionne au contenu reel": a zone named
 * "Lazy" needs far less clearance than one with a 40-char name) — still
 * clamped at {@link ZONE_TITLE_TYPICAL_MAX_NAME_CHARS} for a pathologically
 * long name, same "permitted pathological case" trade-off that constant's
 * own doc comment already accepts — evaluated at {@link
 * ZONE_SPACING_PRACTICAL_ZOOM} (0.5) instead of the absolute zoom floor: the
 * same zoom this fix's own acceptance target aims to keep "fit" at for a
 * couple of modest zones, a self-consistent choice (guard titles down to the
 * zoom real multi-project browsing should still land on, not the technical
 * minimum a user could theoretically drag the wheel to).
 *
 * scratch/_canvas-label-design.md §3.3 — David's own "unify the practical
 * zoom" instruction: this used to be a value distinct from `cameraInsets.ts`'s
 * `ARRANGE_MIN_READABLE_ZOOM` (0.35, the fit's own readability floor) for no
 * real reason — "one constant, the zoom people actually use", not two
 * numbers that happen to both mean roughly that. Lowered 0.5 -> 0.35 to
 * match it (duplicated as a value, not a cross-import — `cameraInsets.ts`
 * lives one layer up and already documents this same "duplicate the
 * constant, not the module dependency" convention this file's own header
 * uses for `layout.ts`/`reconcilerZones.ts`). Still used by
 * `zoneMinWidthForTitle` below (the per-zone WIDTH floor) — the packing
 * GAPS themselves ({@link ZONE_PACK_HORIZONTAL_GAP}/{@link ZONE_VERTICAL_GAP}
 * below) no longer need a "practical vs. absolute" distinction at all: see
 * those constants' own doc comments for why.
 */
export const ZONE_SPACING_PRACTICAL_ZOOM = 0.35;

/**
 * scratch/_canvas-label-design.md §3.1/§3.3 — retired the NAME-LENGTH-
 * proportional same-row packing gap this constant's own history describes
 * below, in favor of one small flat constant. Two things changed together
 * to make that safe:
 *   1. `ProjectGroupNode.tsx`'s round-2 "geometric containment" fix
 *      (`canvas-zone-header`'s outer `maxWidth: width` + `overflow: hidden`,
 *      unchanged by this design) already guarantees a title can NEVER paint
 *      past its own zone's own right edge, at any zoom, by construction — a
 *      title-vs-neighbour collision the old proportional gap existed to
 *      prevent is now geometrically impossible regardless of gap size.
 *   2. The compensation itself is now BOUNDED (chrome/lod.ts's
 *      `LOD_FLOOR_ZOOM`, 0.1 -> 0.25, "the tldraw model") — even the title's
 *      own WORST-CASE flow-space reach shrank from ~4048px
 *      (`ZONE_TITLE_MAX_FLOW_WIDTH` at the old floor) to a small fraction of
 *      that, so the old gap's entire premise (a title's on-screen width can
 *      balloon without bound as zoom approaches the floor) no longer holds.
 * A flat, small, purely-visual breathing gap between two packed zone boxes —
 * same job {@link ZONE_GAP} does for the lane gutter, just for the zone-to-
 * zone same-row packing advance instead. Kept as a function (not a bare
 * constant) so `reconcilerZones.ts`'s `packAutoPlacedZones`/`layout.ts`'s
 * `layoutAll`/`migrateBloatedZoneRowPositions` keep their existing call
 * shape — the `zoneName` parameter is now unused (kept for that same
 * call-site stability, not because the gap still depends on it).
 *
 * HISTORY: this used to scale with a zone's own real name length, evaluated
 * at {@link ZONE_SPACING_PRACTICAL_ZOOM} (P2-16 fix, replacing an even
 * bigger flat worst-case gap sized against the technical zoom floor) —
 * "espacement proportionne au contenu reel". Superseded here: containment
 * (point 1 above) made proportional sizing unnecessary, and the bounded
 * compensation (point 2) made the old worst-case math moot even as a
 * fallback.
 */
export const ZONE_PACK_HORIZONTAL_GAP_FLOW_PX = 64;

export function zoneSameRowPackGap(_zoneName: string): number {
  return ZONE_PACK_HORIZONTAL_GAP_FLOW_PX;
}

/**
 * scratch/_canvas-label-design.md §3.2/§3.3 — the ROW-TO-ROW (vertical)
 * packing advance now uses {@link ZONE_VERTICAL_GAP} directly: bounding the
 * LOD compensation (`chrome/lod.ts`'s `LOD_FLOOR_ZOOM`, 0.25 now) already
 * shrank that constant from the old airtight-at-the-absolute-floor 456 down
 * to 192 (`ZONE_TITLE_MAX_FLOW_HEIGHT` 176 + `ZONE_TITLE_GAP_ABOVE` 16) —
 * small enough to use as the routine packing gap directly, with no separate
 * "practical zoom" evaluation needed. "Plus de formule au pire cas": the
 * invariant ("a title floating above zone B never reaches zone A's bottom
 * edge") now holds by simple arithmetic at EVERY zoom, not just a
 * practical-zoom approximation of it.
 *
 * Kept as a function (not inlined at call sites) purely for call-site
 * stability across `reconcilerZones.ts`/`layout.ts` — see
 * {@link zoneSameRowPackGap}'s own doc comment for the same rationale on the
 * horizontal axis.
 *
 * HISTORY: this used to independently evaluate `titleBandHeight` at {@link
 * ZONE_SPACING_PRACTICAL_ZOOM} (fix/canvas-fit-fill-ratio) specifically to
 * be smaller than the airtight {@link ZONE_VERTICAL_GAP} — superseded once
 * bounding {@link LOD_FLOOR_ZOOM} made the airtight bound itself small.
 */
export function zoneRowPackGap(): number {
  return ZONE_VERTICAL_GAP;
}

/**
 * scratch/_canvas-label-design.md §3.3.1 — viewport-aspect-aware zone
 * packing (the design doc's own "vrai correctif"): replaces a hardcoded
 * "3 (or however many) zones per row" with a column count that targets the
 * app window's own aspect ratio (~1440x844 ≈ 1.7), so N zones pack into a
 * roughly window-shaped rectangle instead of an arbitrarily tall, narrow
 * one. `Math.round` (not `Math.ceil`) — matches the design doc's own worked
 * table exactly (8 -> 4 cols/2 rows, 30 -> 7 cols, 100 -> 13 cols; `ceil`
 * would give 4/8/14, overshooting the 30- and 100-zone cases). Floored at 1
 * column so a single zone (or an empty pack) never divides by zero
 * downstream. `viewportAspect` is a parameter (not a hardcoded 1.7) so a
 * caller with a real measured container aspect could pass it later — every
 * current caller uses the default, matching the design doc's own reference
 * viewport.
 */
export function packColumnsForZoneCount(zoneCount: number, viewportAspect: number = 1.7): number {
  if (zoneCount <= 0) return 1;
  return Math.max(1, Math.round(Math.sqrt(zoneCount * viewportAspect)));
}

/**
 * fix/canvas-zone-title-clip (David's measured repro, round 3 of the
 * floating-title saga, real packaged app: with the round-2 "geometric
 * containment" fix live — `ProjectGroupNode.tsx`'s outer `canvas-zone-
 * header` clamped to `maxWidth: width` + `overflow: hidden` — all 8 zone
 * headers read `uc`, `La`, `uc`, `uc`, `laz`, `La`, `La`, `de`: 2-3
 * characters, no ellipsis, every zone indistinguishable). Root cause: CSS
 * `overflow: hidden` on an ancestor clips a transformed descendant's
 * PAINTED (post-`transform: scale`) extent, not its pre-transform layout
 * size — the SAME reason {@link ZONE_TITLE_RESERVED_NAME_CHARS}'s own doc
 * comment gives for why a flow-space CSS width bound "would itself get
 * multiplied by that same scale factor ... the opposite of bounded", just
 * not yet applied to this OUTER box. At low zoom the identity cluster's
 * `lodScale` factor is large (up to 9.2x at {@link LOD_FLOOR_ZOOM}), so a
 * typical zone's modest flow-space width survives only `zoneWidth /
 * scaleFactor` pre-scale flow px — a handful of px, mostly consumed by
 * fixed chrome, leaving 2-3 characters for the name.
 *
 * David's own requirement (verbatim): "a header must never paint outside
 * its zone AND must stay identifiable ... the zone's own width has to
 * accommodate a usable name at the zoom levels people actually use ... the
 * answer is likely in the layout (minimum zone width / how zones are
 * packed), not in ever-tighter clipping of the label." This function is
 * that layout fix: the per-zone minimum WIDTH (flow px) needed so THIS
 * zone's own real name (clamped at {@link ZONE_TITLE_RESERVED_NAME_CHARS}
 * — the header's own established truncation cap; a name longer than that
 * already truncates with a MIDDLE ellipsis via `lib/truncateMiddle.ts`, so
 * sizing past the cap would waste canvas space no header ever uses) fits
 * inside the outer clip's own budget WITHOUT triggering it — evaluated at
 * {@link LOD_FLOOR_ZOOM}, the technical zoom FLOOR (CanvasView's own
 * `minZoom` derives from that same constant, so it is the worst case a user
 * can actually REACH).
 *
 * fix/canvas-zone-title-full-at-floor (David, live app at 26% zoom:
 * "la moitié des noms des zones dans le canva sont coupés" — every zone
 * header read "lazy-bac…"/"uc-smoke-2…" with an ellipsis): the OLD
 * evaluation tier was {@link ZONE_SPACING_PRACTICAL_ZOOM} (0.35). At any
 * zoom BELOW it — 26% is reachable and common after a fleet-wide fit — the
 * live lodScale factor exceeds the budgeted one by up to 0.35/0.25 = 1.4x,
 * and the name span (the row's only shrinkable flex item) absorbed the
 * entire shortfall. The previously documented "accepted residual" was
 * wrong: sizing the floor at the REACHABLE worst case costs exactly that
 * 1.4x once, statically, in pack width — versus re-paying it on screen as
 * a truncated name every session (fit lands wherever the content bounding
 * box dictates, not where our idea of "practical" is). The full-name
 * guarantee now holds at EVERY reachable zoom, by construction: below
 * LOD_FLOOR_ZOOM nothing can go (minZoom), at/above it the compensation
 * only shrinks.
 *
 * Same documented behaviour as before for names past
 * {@link ZONE_TITLE_RESERVED_NAME_CHARS}: those already truncate with a
 * MIDDLE ellipsis via `lib/truncateMiddle.ts`, so the floor sizes the
 * capped form — and any residual ellipsis is always announced
 * (`ProjectGroupNode.tsx`'s name span carries its own `overflow: hidden` +
 * `textOverflow: ellipsis`), never a silent hard clip.
 *
 * Worked example (the exact case David's own repro used):
 * "uc-smoke-2026-08-12" is 19 characters (under the 28-char cap) —
 * `(19*12.5*0.56 + 40) * lodScale(0.25, 12.5, 11.5) = (133+40) * 3.68 =
 * 173 * 3.68 ≈ 637` flow px (was ≈455 at the old 0.35 tier). A zone this
 * wide renders that name in FULL at ANY reachable zoom — the entire reason
 * for this fix.
 */
export function zoneMinWidthForTitle(zoneName: string): number {
  const chars = Math.min(zoneName.length, ZONE_TITLE_RESERVED_NAME_CHARS);
  const contentWidth = chars * ZONE_LABEL_CONTENT_PX * ZONE_TITLE_AVG_CHAR_WIDTH_RATIO + ZONE_TITLE_CHROME_WIDTH_PX;
  // fix/canvas-zone-title-full-at-floor — LOD_FLOOR_ZOOM, not
  // ZONE_SPACING_PRACTICAL_ZOOM: see this function's doc comment above.
  // CanvasView's minZoom derives from LOD_FLOOR_ZOOM, so this is the
  // largest compensation factor a user can ever force.
  return Math.ceil(contentWidth * lodScale(LOD_FLOOR_ZOOM, ZONE_LABEL_CONTENT_PX, ZONE_LABEL_LOD_TARGET_PX));
}

/** {@link zoneMinWidthForTitle}'s own FLAT worst-case value — every zone's
 *  name clamped to the full {@link ZONE_TITLE_RESERVED_NAME_CHARS} (22),
 *  i.e. `zoneMinWidthForTitle` evaluated on any name at or past the cap.
 *  Exported (not just inlined at call sites) so tests that want to assert
 *  "at least this wide, regardless of the specific name" — or a caller
 *  sizing a zone before a real name is known — can reference this
 *  symbolically instead of re-deriving the same arithmetic. `≈578`. */
export const ZONE_MIN_WIDTH_FOR_TITLE = zoneMinWidthForTitle('x'.repeat(ZONE_TITLE_RESERVED_NAME_CHARS));

// ── Lane mode (spec §4.3 CRITICAL 4): 5 stage lanes + a left gutter
//    column. Lane/gutter width both equal to the SAME placement cell width
//    so a full-card child dropped into a lane never overflows its column
//    (loop/schedule nodes — the gutter's own occupants — are exactly as
//    wide as mission/draft nodes, see FULL_CARD_WIDTH above). ───────────
export const LANE_COUNT = 5; // PLAN / CODE / TEST / REVUE / MERGE
export const LANE_GUTTER_WIDTH = GRID_CELL_WIDTH;
export const LANE_COLUMN_WIDTH = GRID_CELL_WIDTH;
export const LANE_ROW_HEIGHT = GRID_CELL_HEIGHT;
/** Height reserved for the PLAN/CODE/TEST/REVUE/MERGE column-header strip
 *  rendered inside the zone body (ProjectGroupNode.tsx), BELOW the zone's
 *  own name/count header (`ZONE_HEADER_HEIGHT`) and ABOVE the first row of
 *  lane content — without this, row 0's cards would render flush against
 *  the zone header with no room for the lane labels. */
export const LANE_HEADER_STRIP_HEIGHT = 28;
/** Zone-relative x where the first (PLAN) lane column starts — the gutter
 *  column occupies `[ZONE_PADDING, LANE_GUTTER_WIDTH)`, then a `ZONE_GAP`
 *  gap, then the lanes. */
export const LANE_START_X = LANE_GUTTER_WIDTH + ZONE_GAP;

/** Zone-relative x of lane `index` (0 = PLAN … 4 = MERGE). */
export function laneColumnX(index: number): number {
  return LANE_START_X + index * LANE_COLUMN_WIDTH;
}

/** Total zone BODY width a fully-widened lane-mode zone needs: gutter +
 *  gap + 5 lane columns + right padding (spec CRITICAL 4 "widens to
 *  exactly 5 lane columns ... + a left gutter column"). Zones in lane mode
 *  always widen to (at least) this, regardless of how few children they
 *  actually hold — an empty MERGE lane must still read as a lane, not
 *  collapse away. */
export const LANE_MODE_ZONE_WIDTH = LANE_START_X + LANE_COUNT * LANE_COLUMN_WIDTH + ZONE_PADDING;
