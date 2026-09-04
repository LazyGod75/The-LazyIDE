/* artifactEnvelopeLeak.ts — shared <artifact> result-envelope leak stripper
   (2026-08 QA, extracted the same way reasoningLeak.ts was: a self-contained
   sibling module rather than growing managerEngine.ts, so the single call
   site there only ever needs a one-line import + a one-line call — see this
   repo's own precedent for why: reasoningLeak.ts's header explains the same
   "factor it out so call sites share one rule instead of drifting" reason,
   and managerEngine.ts is currently being edited concurrently for unrelated
   model-rail/billing work, so keeping this fix's footprint there minimal
   avoids stepping on that in-flight change).

   Real leak (Cockpit manager panel, live):
     ...ce qui doit être corrigé. <artifact type="application/json"
     id="query-m7"> {"type": "query_miss...
   and, from the same root cause, a stray closing fragment observed
   elsewhere in the same session (a mission list preview):
     M7"} </artifact> ~3 crédits

   Some backends wrap a structured result in a raw `<artifact type="..."
   id="...">{...json payload...}</artifact>` envelope. This is NOT Lazy's
   own <lazy_actions> convention (managerEngine.ts's stripActionBlock) and
   never legitimately reaches a manager-facing surface — same leak CLASS as
   the native `<function_calls>`/`<invoke>` tool-call XML managerEngine.ts's
   sanitizeManagerDisplayText already strips (its own LEAKED_TOOL_CALL_TAGS
   / stripCompleteTagBlocks / stripUnclosedTrailingTag), so this module
   reuses that exact same two-pass technique (complete block, then
   unterminated trailing block) instead of inventing a parallel one, plus a
   third pass for the "closing tag survived, opening tag did not" shape
   (mirrors managerEngine.ts's stripBareActionsJsonForDisplay handling of
   the analogous malformed <lazy_actions> case, 2026-08-12 QA — that one
   wraps a JSON ARRAY, this one wraps a JSON OBJECT).
*/

const ARTIFACT_TAG = 'artifact';

/** Remove every complete `<artifact ...>...</artifact>` block, whatever its
 *  payload — mirrors managerEngine.ts's stripCompleteTagBlocks. */
function stripCompleteArtifactBlocks(text: string): string {
  return text.replace(new RegExp(`<${ARTIFACT_TAG}\\b[^>]*>[\\s\\S]*?<\\/${ARTIFACT_TAG}>`, 'g'), '');
}

/** Defensive: an unterminated block (stream cut off before the closing tag,
 *  e.g. hit a token limit) must not leak the raw opening tag + partial JSON
 *  either — trim from the first unmatched opening tag onward. Mirrors
 *  managerEngine.ts's stripUnclosedTrailingTag. */
function stripUnclosedTrailingArtifactTag(text: string): string {
  return text.replace(new RegExp(`<${ARTIFACT_TAG}\\b[^>]*>[\\s\\S]*$`), '');
}

/** "Opening tag missing/mismatched, only the closing tag survived" shape
 *  (mirrors managerEngine.ts's stripBareActionsJsonForDisplay <lazy_actions>
 *  handling, 2026-08-12 QA): a well-formed JSON OBJECT — the <artifact>
 *  envelope's own payload shape (<lazy_actions> wraps an ARRAY, <artifact>
 *  wraps an OBJECT) — glued directly to a stray `</artifact>` closing tag is
 *  stripped together with it. Any closing tag still left over with nothing
 *  JSON-object-shaped immediately before it is dropped on its own, same
 *  convention as stripActionBlock — real prose before/after a stray tag is
 *  never touched. By the time this runs, stripCompleteArtifactBlocks /
 *  stripUnclosedTrailingArtifactTag above have already consumed every
 *  properly-opened <artifact> block, so any `</artifact>` still present
 *  here is, by construction, already stray. */
function stripStrayArtifactClosingFragment(text: string): string {
  let out = text.replace(/\{[\s\S]*?\}\s*<\/artifact>/g, '');
  out = out.replace(/<\/artifact>/g, '');
  return out;
}

/** Strip every shape of a leaked <artifact> result envelope from `text` for
 *  display: a complete block, an unterminated (truncated mid-stream) block,
 *  and a stray closing tag left over with no matching opening (with or
 *  without a well-formed JSON object payload immediately before it).
 *  Idempotent — running it twice is a no-op. Real surrounding prose is
 *  always kept untouched. */
export function stripArtifactEnvelope(text: string): string {
  let out = stripCompleteArtifactBlocks(text);
  out = stripUnclosedTrailingArtifactTag(out);
  out = stripStrayArtifactClosingFragment(out);
  return out.trim();
}
