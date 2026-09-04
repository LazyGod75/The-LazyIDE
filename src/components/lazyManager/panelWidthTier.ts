/* panelWidthTier.ts — real breakpoints for the LazyManager PANEL's own
   width (not the app viewport). The panel docks into a fraction of the
   window — e.g. ~500px wide in the Code space — so a viewport media query
   would be blind to the actual crowding; only the panel's own measured
   width tells the real story.

   Real user report, 2026-08-14 (viewport 1440x844, panel docked to ~500px):
   Row 1 of the header fell back to `flexWrap` ad-hoc reflow
   (LazyManagerHeader.tsx) — "+ Nouvelle" stayed on the first line while
   History/the status dot dropped onto an orphaned second line with a big
   gap, and the model picker jumped to its own row with a different visual
   weight than at full width. That reads as a squeezed version of the wide
   layout, not a deliberate one.

   Three named tiers — each consumed as a DELIBERATE, complete layout by
   LazyManagerHeader.tsx / LazyManagerConversationTabs.tsx, never as "let
   flexWrap sort it out":
     - wide    (>= WIDE_MIN_WIDTH):    current single-row header design,
       unchanged — the primary layout; this fix must never regress it.
     - compact (COMPACT_MIN_WIDTH..WIDE_MIN_WIDTH-1): the real ~500px
       docked width lands here today. Row 1 becomes two EXPLICIT rows
       (identity, then the action cluster as one atomic group) instead of
       an accidental wrap, and the model picker gets its own full-width
       row with the same visual weight as the mode toggle beside it.
     - narrow  (< COMPACT_MIN_WIDTH): same two-row shape as compact, with
       tighter conversation-tab widths so a single tab can't hog the
       little room there is.

   Numbers are anchored to the real defect (the observed ~500px break)
   rather than a guessed round figure — see this file's own test for the
   tier boundaries pinned per width. */

export type PanelWidthTier = 'wide' | 'compact' | 'narrow';

/** Below this, Row 1's identity block (avatar + name + engine badge) and
 *  its action cluster ("+ Nouvelle" + History + status dot + overflow)
 *  can no longer both sit comfortably on one line — the real ~500px
 *  docked width this fix was filed against lands just under it. */
export const WIDE_MIN_WIDTH = 560;

/** Below this, panel width is tight enough that a single conversation tab
 *  should not claim as much room as it does at `compact` — see
 *  LazyManagerConversationTabs.tsx's per-tier `maxWidth`. */
export const COMPACT_MIN_WIDTH = 340;

/**
 * Classifies a measured panel width into one of the three deliberate
 * layout tiers above. `undefined` — not yet measured (the very first
 * render before a ResizeObserver has reported) or a caller that renders a
 * component directly with no tier override — resolves to `'wide'`, the
 * layout every existing caller/test already assumes and the width most
 * LazyManager hosts (the cockpit overlay's normal/expanded states)
 * actually run at. Never the narrowest tier: that would flash a compact
 * layout on every mount before the first real measurement lands.
 */
export function getPanelWidthTier(width: number | undefined): PanelWidthTier {
  if (width === undefined) return 'wide';
  if (width >= WIDE_MIN_WIDTH) return 'wide';
  if (width >= COMPACT_MIN_WIDTH) return 'compact';
  return 'narrow';
}
