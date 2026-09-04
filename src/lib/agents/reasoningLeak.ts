/* reasoningLeak.ts — shared reasoning-channel leak stripper (fix/canvas-ux
   R10 extraction; hardened for the LazyManager "lance le localhost du site"
   leak). Managed/reasoning-model backends can spill their raw
   chain-of-thought into otherwise-user-facing text as whole `[reasoning]…`
   lines (observed live in the manager's "Standup du matin" reply —
   managerEngine.ts's sanitizeManagerDisplayText — and again in evaluator.ts's
   reviewer/security/judge summaries, same root cause: both read a managed
   provider's raw stream text directly).

   Originally a private helper inside managerEngine.ts (stripReasoningLines).
   Factored out here so BOTH call sites use the exact same rule instead of
   two copies silently drifting apart — evaluator.ts's ReviewerVerdict.summary
   is user-facing (Cockpit's "Rejeter avec feedback" popover, gate.failed's
   journal reason) exactly like the manager's chat bubble is.

   A manager/reviewer reply NEVER legitimately starts a line with this
   marker, so the whole line is dropped outright when it does — this part is
   stronger than capture.ts's stripLeakedReasoning (which only handles a
   MID-WORD leak). The assumption that a leak marker never has real answer
   text ahead of it on the same line turned out to be false, though: a
   confirmed live leak (root cause: chat.rs's extract_text_from_stream_json
   forwarding a non-assistant CLI harness re-prompt line, since fixed) showed
   the harness's own "...produce a user-visible response." re-prompt text
   glued directly to a following "@[reasoning]" marker on ONE rendered line,
   with no separating newline — two unrelated stream chunks concatenated
   with nothing in between. The mid-line pass below is the defense-in-depth
   for exactly that shape: it keeps real content on the line before a
   marker/fragment and drops everything from there on, same convention
   capture.ts's stripLeakedReasoning already uses for its mid-word case. */

/** Reasoning-channel leak marker: a line beginning (after optional leading
 *  whitespace and an optional ANSI escape byte) with `[reasoning]`. Matches
 *  even a bare marker with nothing else on the line — unlike MID_LINE_MARKER
 *  below, this has no "glued to a word character" requirement, so it also
 *  catches an isolated `[reasoning]` line. */
// eslint-disable-next-line no-control-regex -- intentional: the ANSI escape byte is the actual wire marker
const REASONING_LINE = /^\s*\x1b?\[reasoning\]/;

/** Reasoning-channel leak marker occurring ANYWHERE in a line, not just at
 *  the start (see the module doc comment above for the live leak shape this
 *  covers). The ESC-prefixed and `@`-prefixed forms are unconditional —
 *  neither occurs in organic prose. The bare `[reasoning]` form requires the
 *  marker to be glued to a word character on at least one side (no
 *  surrounding whitespace), mirroring capture.ts's stripLeakedReasoning
 *  heuristic, so a legitimate prose mention — quoted, or written as "the
 *  `[reasoning]` marker" — is never stripped. */
// eslint-disable-next-line no-control-regex -- intentional: the ANSI escape byte is the actual wire marker
const MID_LINE_MARKER = /\x1b\[reasoning\]|@\[reasoning\]|(?<=\w)\[reasoning\]|\[reasoning\](?=\w)/;

/** Known internal harness re-prompt fragments that must never reach a
 *  user-facing surface — the Claude Code CLI's own synthetic "no visible
 *  output, please continue" nudge (a "user"-role re-prompt line that
 *  chat.rs's extract_text_from_stream_json used to forward as if the model
 *  had said it; see that function's fix for the actual root cause). Kept as
 *  plain lowercase substrings (matched case-insensitively, since exact CLI
 *  wording/casing is not a stable contract) rather than folded into one
 *  regex, so a newly observed fragment can be appended here without
 *  touching the matching logic below. */
const HARNESS_REPROMPT_FRAGMENTS = [
  'response had no visible output',
  'please continue and produce a user-visible response',
] as const;

/** Index of the first mid-line leak marker or known harness fragment in
 *  `line`, or -1 when the line is clean. */
function findMidLineLeakIndex(line: string): number {
  const markerMatch = line.match(MID_LINE_MARKER);
  const candidates: number[] = [];
  if (markerMatch && typeof markerMatch.index === 'number') {
    candidates.push(markerMatch.index);
  }
  const lower = line.toLowerCase();
  for (const fragment of HARNESS_REPROMPT_FRAGMENTS) {
    const idx = lower.indexOf(fragment);
    if (idx !== -1) candidates.push(idx);
  }
  return candidates.length > 0 ? Math.min(...candidates) : -1;
}

/** Drops everything from the first mid-line marker/fragment onward, keeping
 *  real content that precedes it on the same line. Returns null when that
 *  leaves nothing — the marker/fragment was the first thing on the line —
 *  so the caller can drop the line outright instead of leaving a blank
 *  artifact behind. A line with no leak passes through unchanged. */
function truncateMidLineLeak(line: string): string | null {
  const idx = findMidLineLeakIndex(line);
  if (idx === -1) return line;
  const kept = line.slice(0, idx).trimEnd();
  return kept === '' ? null : kept;
}

/** Drops every whole reasoning-channel line from `text`, then — for every
 *  surviving line — drops everything from the first mid-line leak marker or
 *  harness re-prompt fragment onward. Real content is kept untouched,
 *  including blank lines that were already blank (so this never re-flows
 *  real paragraph structure) and any text that precedes a mid-line leak on
 *  its own line. Idempotent — running it twice is a no-op. */
export function stripReasoningLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !REASONING_LINE.test(line))
    .map(truncateMidLineLeak)
    .filter((line): line is string => line !== null)
    .join('\n');
}
