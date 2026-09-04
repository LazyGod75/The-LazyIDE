/* salvageReAct — recover a THOUGHT/ACTION/FINAL block from a messy LLM turn.

   BYOK / CLI brains (especially terse models) often wrap the ReAct block in
   a preamble ("Sure, I'll open the browser…") or emit FINAL without ACTION.
   The managed loop already parses ACTION anywhere on a line; this helper
   strips leading prose and promotes a bare FINAL so the bot's report is
   not lost to consecutive-failure.
*/

const MARKER = /^(?:\*{0,2})(THOUGHT|ACTION|FINAL)(?:\*{0,2})\s*:/im;

/** Return the original text when it already looks like ReAct; otherwise
 *  the substring starting at the first THOUGHT/ACTION/FINAL marker.
 *  Promotes a bare `FINAL:` (no ACTION line) into `ACTION: FINAL`. */
export function salvageReAct(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const match = MARKER.exec(trimmed);
  if (!match || match.index === undefined) return text;
  const block = trimmed.slice(match.index).trim();
  if (/^ACTION\s*:/im.test(block)) return block;
  if (/^FINAL\s*:/im.test(block)) {
    const body = block.replace(/^FINAL\s*:/im, '').trim();
    return `ACTION: FINAL\nARGS: ${JSON.stringify({ summary: body })}`;
  }
  return block;
}

/** True when `text` contains at least one ReAct marker. */
export function hasReActMarker(text: string): boolean {
  return MARKER.test(text);
}
