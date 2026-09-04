/* dedupeMessageText.ts — display-side mitigation for a diagnosed manager
   stutter (real user report, verbatim, 2026-07-28): "Carrousel d'images ou
   vraie vidéo Remotion animée ? Ça détermine tout le pipeline de
   production." rendered TWICE, back-to-back, inside the SAME assistant
   bubble; same defect independently observed for "Raccourci desktop vers un
   dashboard web, ou vraie appli Electron séparée ?".

   ROOT CAUSE (diagnosed, NOT fixable here — see this task's final report):
   agentsStore.tsx's `turnDisplayText` builds a message's content as
   `[prose, ...infoParts].join('\n\n')`, deduping each `info` action's text
   against `prose` (one direction) or `prose` against `info` (the other
   direction) — but it NEVER compares two `info` actions against EACH OTHER.
   When a turn emits two `info` actions with identical (or near-identical)
   text — observed live, the clarifying question restated as its own
   `info` action twice in one turn — both survive the loop and get pushed
   into `parts`, printing the same paragraph twice joined by a blank line.
   Fixing this at the source means editing `turnDisplayText` in
   agentsStore.tsx, which is out of this task's locked perimeter (a sibling
   task just modified that file's gate/approval plumbing) — see the mission
   report for the exact patch this file's own diff comment describes.

   MITIGATION (this file): collapse an immediately-adjacent, byte-identical
   (after trim) paragraph before rendering. Deliberately conservative —
   compares ONLY adjacent paragraphs (split on a blank line, matching
   turnDisplayText's own `'\n\n'` join), and ONLY an exact match — so a
   message with two legitimately different consecutive paragraphs is never
   altered. A single-paragraph message (the overwhelming common case) is
   returned completely untouched. */

/**
 * Collapses an immediately-adjacent, exact-duplicate paragraph in `content`.
 * Paragraphs are split on one-or-more blank lines (`\n{2,}`), the same
 * separator `turnDisplayText` (agentsStore.tsx) joins with. Only a
 * byte-identical (after trim) NEIGHBOR is dropped — never a fuzzy/substring
 * match, and never two non-adjacent repeats of the same paragraph (a
 * legitimate "as I said earlier, X" callback is not this defect).
 */
export function dedupeAdjacentParagraphs(content: string): string {
  if (!content.includes('\n')) return content; // single line — nothing to compare, skip the split/join for the common case
  const paragraphs = content.split(/\n{2,}/);
  if (paragraphs.length < 2) return content;

  const deduped: string[] = [];
  let previousTrimmed: string | null = null;
  for (const raw of paragraphs) {
    const trimmed = raw.trim();
    if (trimmed.length > 0 && trimmed === previousTrimmed) continue;
    // Pushes the TRIMMED paragraph, not the raw split fragment — a
    // paragraph's own leading/trailing whitespace carries no meaning in a
    // chat bubble, and keeping it would make byte-identical comparison (and
    // this function's own output) sensitive to whitespace noise a model
    // might introduce around an otherwise-duplicate paragraph.
    deduped.push(trimmed.length > 0 ? trimmed : raw);
    previousTrimmed = trimmed;
  }
  return deduped.join('\n\n');
}
