/* truncateMiddle.ts — MIDDLE-ellipsis truncation (canvas zone-title design,
   scratch/_canvas-label-design.md §3.1, "Troncature résiduelle = ellipsis
   MÉDIANE, pas finale").

   ROOT PROBLEM: David's real project names are distinguished by their own
   SUFFIX (`uc-smoke-b` vs `uc-smoke-c` vs `uc-smoke-2026-08-12`, a date/
   variant tag appended at the end). The canvas zone header's own PRIOR
   truncator (`components/lazyManager/truncateLabel.ts`'s `truncateLabel`,
   an END-ellipsis) destroys exactly that discriminating suffix once a name
   needs truncating — `uc-smoke-2026-08-12` and `uc-smoke-2026-08-13` would
   both read as `uc-smoke-2026-0…`, indistinguishable at a glance, the
   opposite of what a "which zone is this" label needs to do.

   FIX: keep a prefix AND a suffix, ellipsis in the middle —
   `truncateMiddle('uc-smoke-2026-08-12', 11)` -> `'uc-sm…08-12'` (design
   doc's own worked example). Deliberately a NEW, separate module from
   `lazyManager/truncateLabel.ts` (not a shared rename/move): that file's
   own header flags it as carrying David's own in-flight uncommitted work
   at the time of this fix — see this repo's canvas-title fix history for
   the same "never touch a file mid-flight under someone else" convention
   already documented on ProjectGroupNode.tsx's `truncateLabel` import.
   `truncateLabel`'s own END-ellipsis is still correct and unchanged for
   every OTHER canvas/manager label (task summaries, chat text) where the
   BEGINNING carries the identifying information — this module only serves
   the specific "the end matters" case the zone title now needs.
*/

const ELLIPSIS = '…';

/**
 * Middle-truncates `text` to at most `maxLen` characters, keeping a prefix
 * AND a suffix with a single ELLIPSIS between them — never destroys the
 * discriminating tail of a name the way a plain end-truncation would.
 * Returns `text` unchanged when it already fits within `maxLen`.
 *
 * Split: `ceil(keep/2)` characters kept at the start, `floor(keep/2)` kept
 * at the end (`keep = maxLen - 1`, the ellipsis itself) — a one-character
 * bias toward the PREFIX when `keep` is odd, so a short name still reads
 * with a recognizable opening (matches the design doc's own worked
 * example: `maxLen=11` on a 20-char name keeps 5 characters each side).
 * `maxLen <= 1` degrades to a bare ellipsis (or the empty string for
 * `maxLen <= 0`) rather than producing a negative-length slice.
 */
export function truncateMiddle(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 0) return '';
  if (maxLen === 1) return ELLIPSIS;

  const keep = maxLen - ELLIPSIS.length;
  const prefixLen = Math.ceil(keep / 2);
  const suffixLen = Math.floor(keep / 2);
  const prefix = text.slice(0, prefixLen);
  const suffix = suffixLen > 0 ? text.slice(text.length - suffixLen) : '';
  return `${prefix}${ELLIPSIS}${suffix}`;
}
