/* truncateLabel.ts — ambiguity-free truncation for LazyManager action-chip
   labels (real, observed QA defect, 2026-08-12).

   ROOT CAUSE: LazyManagerMessageList.tsx's actionSummary() built every
   dynamic chip label with a bare `.slice(0, N)` and no truncation marker at
   all. For plain text this merely looked abrupt ("Dans index.js à la racine
   du pro"), but for a filesystem path it was actively misleading:
   `C:\Users\user\Documents\cerveau\scratchpad\uc-smoke-2026-08-12`
     .slice(0, 32)
   produces EXACTLY `C:\Users\user\Documents\cerveau` — a real, different,
   entirely plausible-looking directory with no ellipsis, no "...", nothing
   to signal the label was cut. The user asked to open the scratchpad
   sub-folder; the chip read as though a completely different (wrong, but
   real-looking) folder had been opened instead.

   FIX: two small, pure, always-unambiguous truncators.
     - truncateLabel: generic end-truncation with a trailing "…" — used for
       every non-path field (task/query/url/objective/trigger/name/text).
     - truncatePathLabel: MIDDLE-truncation for filesystem paths — keeps a
       recognizable root/drive prefix AND the full final path segment (the
       part a human actually needs to recognize "is this the right folder?")
       visible, with "…" replacing the squeezed-out middle. Never produced
       without the "…" once truncation actually happens — see the "always
       shows a truncation indicator" tests in truncateLabel.test.ts. */

const ELLIPSIS = '\u2026';

/**
 * End-truncates `text` to at most `maxLen` characters, appending ELLIPSIS
 * whenever anything was actually cut so the result is never mistaken for
 * the complete original. Returns `text` unchanged when it already fits.
 */
export function truncateLabel(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const keep = Math.max(0, maxLen - ELLIPSIS.length);
  return `${text.slice(0, keep)}${ELLIPSIS}`;
}

/** Matches the LAST run of path separators (backslash or forward slash) so
 *  the final segment can be recovered regardless of platform style — a
 *  Windows path (`\`) and a POSIX path (`/`) are both handled identically. */
const LAST_SEPARATOR_RE = /[\\/]([^\\/]*)$/;

/**
 * Middle-truncates a filesystem `path` to at most `maxLen` characters,
 * preserving a recognizable root prefix AND the full final path segment
 * (e.g. `C:\Users\…\scratchpad\uc-smoke-2026-08-12`) — the two pieces a
 * human actually reads to tell "is this the folder I meant?". Falls back to
 * plain truncateLabel when the string has no path separator at all (nothing
 * meaningful to preserve in the middle), or when even the root+ellipsis+
 * final-segment shape cannot fit `maxLen` (the final segment itself is then
 * end-truncated so the overall result still never exceeds maxLen). Returns
 * `path` unchanged when it already fits — never touches a path that doesn't
 * need truncating.
 */
export function truncatePathLabel(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;

  const match = path.match(LAST_SEPARATOR_RE);
  if (!match) return truncateLabel(path, maxLen);

  const sep = match[0][0]; // the separator character actually used ('\' or '/')
  const lastSegment = match[1];
  const rootEnd = path.indexOf(sep);
  // Keep whatever precedes the FIRST separator as the root/drive prefix
  // (e.g. "C:" or an empty string for a POSIX path starting at "/").
  const root = rootEnd >= 0 ? path.slice(0, rootEnd) : '';

  const middle = `${root}${sep}${ELLIPSIS}${sep}`;
  if (middle.length + lastSegment.length <= maxLen) {
    return `${middle}${lastSegment}`;
  }

  // Even root + "…" + the full final segment doesn't fit — keep the
  // separator+ellipsis marker and end-truncate the final segment itself, so
  // the result still always carries a visible truncation indicator and
  // never exceeds maxLen.
  const marker = `${ELLIPSIS}${sep}`;
  const budget = Math.max(0, maxLen - marker.length);
  return `${marker}${truncateLabel(lastSegment, budget)}`;
}
