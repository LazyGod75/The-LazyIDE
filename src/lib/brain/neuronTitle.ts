/* neuronTitle — display-layer sanitizer for neuron titles.

   ROOT CAUSE (Brain space defect, 2026-08): a neuron derived from a mission
   prompt can carry raw HTML markup straight from that prompt (e.g. a mission
   asking to write a file containing `<title>Lazy demo</title>`), and some
   upstream step then hard-truncates the resulting title at a fixed character
   offset with no regard for where that offset lands — landing mid-tag and
   with no ellipsis: "...avec un <title>Lazy demo</titl". Both the leaked
   markup and the raw cut are display bugs: nothing recovers text that was
   already cut off upstream, but the render layer must never show a `<tag>`
   fragment, and any truncation IT performs must land on a word boundary and
   carry a real ellipsis character.

   Every neuron-title render site (Brain detail panel, "new items" timeline
   strip, wiki cluster tree, search results dropdown — see BrainWiki.tsx,
   BrainTimeline.tsx, WikiTree.tsx, BrainControls.tsx) must go through
   `formatNeuronTitle` rather than rendering the raw field directly. */

const ELLIPSIS = '…';

/** Matches a well-formed tag (`<title>`, `</title>`, `<br/>`, ...) — always
    has both the opening `<` and a closing `>`. */
const COMPLETE_TAG_RE = /<[^<>]*>/g;

/** Matches a dangling, unclosed tag fragment at the very end of the string
    (the shape a mid-tag hard-truncation leaves behind, e.g. `</titl`). */
const TRAILING_PARTIAL_TAG_RE = /<[^<>]*$/;

/**
 * Strips HTML-like markup from `raw` so no `<tag>` fragment — complete or
 * dangling — ever reaches the DOM as visible text. Collapses the whitespace
 * left behind by a removed tag and trims the result.
 */
function stripMarkup(raw: string): string {
  return raw
    .replace(COMPLETE_TAG_RE, ' ')
    .replace(TRAILING_PARTIAL_TAG_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Truncates `text` to at most `maxLen` characters, cutting at the last
 * whitespace boundary at or before the limit — never mid-word — and
 * appending a single ELLIPSIS character whenever anything was actually cut.
 * Falls back to a hard cut only when the text's first "word" alone already
 * exceeds the budget (nothing else to break on). Returns `text` unchanged
 * when it already fits within `maxLen`.
 */
function truncateAtWordBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 0) return '';
  const budget = maxLen - ELLIPSIS.length;
  if (budget <= 0) return ELLIPSIS;

  const slice = text.slice(0, budget);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}${ELLIPSIS}`;
}

/**
 * Formats a neuron title for display: strips any HTML-like markup (defect
 * a), then truncates to `maxLen` characters on a word boundary with a real
 * ellipsis (defect b). Safe against `null`/`undefined` (renders as an empty
 * string) so callers at the display boundary never need their own guard.
 */
export function formatNeuronTitle(raw: string | null | undefined, maxLen: number): string {
  const clean = stripMarkup(raw ?? '');
  return truncateAtWordBoundary(clean, maxLen);
}
