/* codeOutputSanitizer — turns a raw model response for a code-transform
   request (Ctrl+K inline-edit, auto-fix) into either clean replacement code
   or an explicit, fail-safe rejection.

   Why this exists: agentic backends — especially the Claude Code CLI
   subscription path (see claudeCodeProvider.ts / src-tauri/src/commands/
   chat.rs) — sometimes answer a "return only the replacement code"
   instruction with tool-call narration instead of code, e.g.:
     → Read `foo.ts`
     Done. Added a comment above add().
   Treating that narration as literal replacement code corrupts the file
   (HIGH defect — QA-captured under the "Claude Code (abonnement)" backend:
   accepting the inline-edit diff replaced a real function with prose).

   Contract:
   - Pure code responses pass through unchanged (trimmed).
   - Fenced (```lang ... ```) responses are unwrapped to their inner code,
     even if the model added narration around the fence.
   - Responses that read as prose/narration are REJECTED —
     sanitizeModelCodeOutput returns `{ ok: false, reason }` rather than
     guessing at a repair. A no-op-with-error is strictly better than
     corrupting the buffer.

   The narration heuristics are deliberately conservative in the direction
   of NOT rejecting legitimate code: a single stray line that happens to
   start like a narration phrase (e.g. a comment "// I'll clean this up")
   must not condemn an otherwise-valid snippet — see
   looksLikeAgenticNarration.
*/

export interface SanitizeSuccess {
  ok: true;
  code: string;
}

export interface SanitizeFailure {
  ok: false;
  reason: string;
}

export type SanitizeResult = SanitizeSuccess | SanitizeFailure;

// ── Fenced code extraction ───────────────────────────────────────────

// Matches the FIRST ```lang\n...\n``` block anywhere in the text (not just
// at the string boundaries) so a narrated preamble/postamble around a fence
// doesn't prevent extracting the clean code inside it.
const FENCE_RE = /```[^\S\r\n]*[\w+-]*\r?\n([\s\S]*?)```/;

function extractFencedCode(text: string): string | null {
  const match = FENCE_RE.exec(text);
  return match ? match[1] : null;
}

// ── Narration detection ──────────────────────────────────────────────

// The exact "→ Tool `file`" annotation the Claude Code CLI backend injects
// into the stream whenever the model calls a tool (see chat.rs's
// `format!("\n→ {} {}\n", name, label)`). Real code never opens a line
// with it, so a single occurrence is decisive on its own.
const TOOL_ANNOTATION_LINE_RE = /^→\s/;

// Weaker narration signals — sentence openers a genuinely agentic reply
// commonly starts a line with. Only trusted when they dominate the response
// (see looksLikeAgenticNarration) so a single stray comment line can't
// condemn real code.
const NARRATION_OPENERS: RegExp[] = [
  /^I'll\s/,
  /^I've\s/,
  /^Done\.(\s|$)/,
  /^The file\s/,
  /^Let me\s/,
  /^I need to\s/,
  /^Here's\s/,
  /^Here is\s/,
];

// Common code "shapes" — used to give legitimate code the benefit of the
// doubt even when it contains an incidental narration-like line.
const CODE_SHAPE_PATTERNS: RegExp[] = [
  /[{};]\s*$/m,
  /^\s*(import|export|function|const|let|var|class|def|return|if|for|while|type|interface|public|private|protected|static|async)\b/m,
  /=>/,
  /^\s*[)\]}]/m,
];

function hasCodeShape(text: string): boolean {
  return CODE_SHAPE_PATTERNS.some((re) => re.test(text));
}

function countNarrationLines(lines: string[]): number {
  return lines.filter(
    (line) => TOOL_ANNOTATION_LINE_RE.test(line) || NARRATION_OPENERS.some((re) => re.test(line)),
  ).length;
}

/** True when `text` reads as agentic narration rather than code. */
function looksLikeAgenticNarration(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;

  // An explicit tool-call annotation line is decisive on its own.
  if (lines.some((line) => TOOL_ANNOTATION_LINE_RE.test(line))) return true;

  // Other openers are weaker: only trust them when they dominate the
  // response AND there is no offsetting code shape anywhere in it.
  const hits = countNarrationLines(lines);
  if (hits === 0) return false;
  return hits / lines.length >= 0.5 && !hasCodeShape(text);
}

// ── Plain-prose fallback ─────────────────────────────────────────────

// Catches non-agentic refusals/explanations from well-behaved (non-tool-
// using) backends that don't happen to use any of the NARRATION_OPENERS
// phrasing above, e.g. "I'm not able to determine what change you want."
// Bails immediately on any code-typical punctuation so it never second-
// guesses a terse but valid snippet.
const PROSE_PUNCTUATION_RE = /[{}();`]/;
const PROSE_STOPWORD_RE =
  /\b(the|is|are|was|were|will|have|has|had|already|now|above|please|sorry|cannot|unable|note|instead|because|should|would|could)\b/i;

function looksLikePlainProse(text: string): boolean {
  if (PROSE_PUNCTUATION_RE.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 5) return false;
  const stopwordHits = words.filter((w) => PROSE_STOPWORD_RE.test(w)).length;
  return stopwordHits >= 2 && /[.!?:]$/.test(text.trim());
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Sanitize a raw model response for a code-transform request.
 *
 * - Fenced response -> the fenced block's content (fails if that content is
 *   itself empty or narration).
 * - Unfenced response that looks like code -> returned as-is (trimmed).
 * - Unfenced response that looks like prose/narration -> rejected.
 */
export function sanitizeModelCodeOutput(raw: string): SanitizeResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, reason: 'The model returned an empty response.' };
  }

  const fenced = extractFencedCode(trimmed);
  if (fenced !== null) {
    const fencedTrimmed = fenced.trim();
    if (!fencedTrimmed) {
      return { ok: false, reason: 'The model returned an empty code block.' };
    }
    if (looksLikeAgenticNarration(fencedTrimmed)) {
      return {
        ok: false,
        reason: 'The model returned narration instead of code, even inside a code fence.',
      };
    }
    return { ok: true, code: fencedTrimmed };
  }

  if (looksLikeAgenticNarration(trimmed) || looksLikePlainProse(trimmed)) {
    return {
      ok: false,
      reason: 'The model responded with narration/explanation instead of code — the edit was not applied.',
    };
  }

  return { ok: true, code: trimmed };
}
