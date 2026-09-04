/* searchReplaceProtocol.ts — parses the SEARCH/REPLACE (edit_file/
   multi_edit) and FILE+fence (write_file) ReAct shapes that carry file
   CONTENT OUTSIDE of ARGS JSON.

   2026-08-15 (M6 incident root-cause fix — see scratch/_harness-research.md
   and managedAgent.ts's module header "V7"/M6 notes): the production
   failure this fixes was a one-line React edit that ran ~50 minutes and
   burned ~480 credits producing ZERO code, because a raw newline inside a
   multi-line write_file/edit_file `content` string broke JSON.parse. The
   prior fix (5bbd05d, V7) made the JSON parser TOLERANT of that shape
   (sanitizeJsonStringControlChars + a balanced-brace rescan in
   managedAgent.ts's parseReActAction). This module removes the structural
   cause instead: for the three tools that carry multi-line file content
   (edit_file, multi_edit, write_file), the model is instructed (see
   managedAgentPolicy.ts's buildAgentSystemPrompt "FILE EDITS" section) to
   emit the content in a SEARCH/REPLACE or fenced-code block, which is never
   round-tripped through JSON.parse at all — mirrors the common pattern of
   moving str_replace_editor OUT of the IPython/JSON-serializing layer for
   exactly this reason, and the SEARCH/REPLACE edit format.

   This is an ADDITIONAL accepted shape, not a replacement: a model that
   still emits old-style single-line ARGS JSON for these tools keeps
   working exactly as before — managedAgent.ts's parseReActAction only
   tries this parser FIRST for edit_file/multi_edit/write_file, and falls
   through to the existing ARGS/JSON extraction when it returns null (no
   FILE:/SEARCH marker present). Every non-file action is entirely
   unaffected — the JSON ACTION/ARGS protocol is untouched for them.

   Pure, dependency-free, fully unit-tested (see
   __tests__/searchReplaceProtocol.test.ts).
*/

export interface SearchReplaceEdit {
  oldString: string;
  newString: string;
}

/** Parses one `FILE: <path>` line followed by one or more
 *  `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` blocks (edit_file: exactly
 *  one; multi_edit: one or more, applied in order). Returns null when the
 *  `FILE:` line or at least one complete block isn't present — the caller
 *  falls back to ARGS/JSON in that case. */
export function parseSearchReplaceBlocks(
  text: string,
): { path: string; edits: SearchReplaceEdit[] } | null {
  const fileMatch = text.match(/^\*{0,2}FILE\*{0,2}:\s*(.+)$/mi);
  if (!fileMatch || fileMatch.index === undefined) return null;
  const path = fileMatch[1].trim().replace(/\*+$/, '').trim();
  if (!path) return null;

  const afterFile = text.slice(fileMatch.index + fileMatch[0].length);
  const blockRe = /<{7}\s*SEARCH\r?\n([\s\S]*?)\r?\n={7}\r?\n([\s\S]*?)\r?\n>{7}\s*REPLACE/g;
  const edits: SearchReplaceEdit[] = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(afterFile)) !== null) {
    edits.push({ oldString: m[1], newString: m[2] });
  }
  if (edits.length === 0) return null;
  return { path, edits };
}

/** Parses one `FILE: <path>` line followed by a single fenced code block
 *  (write_file — whole-file create/rewrite, no search/replace needed).
 *  The fence's language tag (if any) is ignored; content is taken verbatim
 *  between the fence lines. Returns null when absent. */
export function parseFileContentBlock(text: string): { path: string; content: string } | null {
  const fileMatch = text.match(/^\*{0,2}FILE\*{0,2}:\s*(.+)$/mi);
  if (!fileMatch || fileMatch.index === undefined) return null;
  const path = fileMatch[1].trim().replace(/\*+$/, '').trim();
  if (!path) return null;

  const afterFile = text.slice(fileMatch.index + fileMatch[0].length);
  const fenceMatch = afterFile.match(/```[a-zA-Z0-9_+-]*\r?\n([\s\S]*?)\r?\n```/);
  if (!fenceMatch) return null;
  return { path, content: fenceMatch[1] };
}

/** Tools whose file content must never be routed through JSON — see this
 *  module's header. */
export const FILE_CONTENT_ACTIONS = new Set(['edit_file', 'multi_edit', 'write_file']);

/**
 * Top-level entry point used by managedAgent.ts's parseReActAction: given
 * the lowercased action name and the raw text FOLLOWING the ACTION line
 * (never the whole turn — the caller scopes this so a stray "FILE:"-looking
 * line inside THOUGHT prose can never be picked up), returns tool args
 * compatible with the EXISTING editFile/multiEdit/writeFile handler
 * contract (toolRuntime.ts's handlers/files.ts — old_string/new_string/
 * edits/content keys, unchanged), or null when the SEARCH/REPLACE shape
 * isn't present (caller falls back to ARGS/JSON).
 */
export function parseFileToolAction(
  actionLower: string,
  textAfterAction: string,
): Record<string, unknown> | null {
  if (actionLower === 'edit_file') {
    const parsed = parseSearchReplaceBlocks(textAfterAction);
    if (!parsed || parsed.edits.length === 0) return null;
    const { oldString, newString } = parsed.edits[0];
    return { path: parsed.path, old_string: oldString, new_string: newString };
  }

  if (actionLower === 'multi_edit') {
    const parsed = parseSearchReplaceBlocks(textAfterAction);
    if (!parsed) return null;
    return {
      path: parsed.path,
      edits: parsed.edits.map((e) => ({ old_string: e.oldString, new_string: e.newString })),
    };
  }

  if (actionLower === 'write_file') {
    const parsed = parseFileContentBlock(textAfterAction);
    if (!parsed) return null;
    return { path: parsed.path, content: parsed.content };
  }

  return null;
}
