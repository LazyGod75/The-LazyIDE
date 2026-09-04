/* File-domain tool handlers: read/grep/write/edit/rename/delete/glob/
   read_dir. Extracted verbatim from toolRuntime.ts's executeTool switch —
   see that file's header for the shared executeTool contract. */

import { invoke } from '@tauri-apps/api/core';
import { stripVerbatimPrefix } from '../../paths.js';
import { runBrainQueryCss } from '../../brain/brainTool.js';
import { isMissingFileReadError } from '../../fsErrors.js';
import { findSearchMatch } from '../../agents/searchReplaceMatch.js';
import { rejectIfSyntaxBroken } from '../syntaxGuard.js';
import { resolvePath } from './shared.js';
import type { ToolExecutionContext } from './types.js';

/** Byte cap passed to the Rust `read_file` command for tool-OBSERVATION
 *  reads (the read_file/grep_file tool cases below) — these only ever
 *  display a window of the content to the model and never write it back,
 *  so a bounded lossy read is safe.
 *
 *  Do NOT reuse this for write-path reads (write_file's undo snapshot,
 *  edit_file, multi_edit below) — truncating those and then writing the
 *  truncated content back would silently corrupt any file larger than the
 *  cap. Those call sites intentionally omit max_bytes and rely on the
 *  Rust-side DEFAULT_MAX_READ_BYTES (20 MB) ceiling instead. */
const TOOL_READ_MAX_BYTES = 512_000;

/** Marker appended by the Rust `read_file` command (src-tauri/src/commands/
 *  fs.rs) when max_bytes truncated the file. Parsed out here so tool
 *  callers can surface the truncation to the model regardless of which
 *  line window was requested. */
const TRUNCATION_MARKER_RE = /\n\n\[TRUNCATED: showing first (\d+) of (\d+) bytes\]$/;

function extractTruncationMarker(content: string): { raw: string; note: string } | null {
  const match = TRUNCATION_MARKER_RE.exec(content);
  if (!match) return null;
  return { raw: match[0], note: `showing first ${match[1]} of ${match[2]} bytes` };
}

/** Strip a trailing truncation marker (if present) so line-splitting/
 *  windowing logic operates on file content only. */
function stripTruncationMarker(content: string, marker: { raw: string } | null): string {
  return marker ? content.slice(0, content.length - marker.raw.length) : content;
}

// isMissingFileReadError (whether a `read_file` rejection means "target
// simply does not exist yet" vs. a real failure that must abort instead of
// silently proceeding) now lives in lib/fsErrors.ts — shared with
// lib/agents/orchestratorState.ts's identical need, see that module's doc
// comment for the full contract and the locale bug this consolidation fixes.

/** Simple glob pattern matcher (* → [^/]*, ** → .*, ? → .). */
function simpleGlobMatch(pattern: string, name: string): boolean {
  let regexStr = pattern
    .replace(/\*\*/g, '{{DBLSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\{\{DBLSTAR\}\}/g, '.*');
  if (!regexStr.endsWith('$')) regexStr += '$';
  if (!regexStr.startsWith('^')) regexStr = '^' + regexStr;
  try {
    return new RegExp(regexStr).test(name);
  } catch {
    return name === pattern;
  }
}

// ── Undo state ────────────────────────────────────────────────────

/** Per-file undo state: maps file path → previous content (one level deep). */
const undoStack = new Map<string, string>();

// ── Syntax guardrail + search/replace error reporting (harness hardening,
//    tasks #2/#3 — rejectIfSyntaxBroken lives in syntaxGuard.ts) ────────

/** Builds a "here's what the real file actually contains" snippet for a
 *  total search-match failure (all three findSearchMatch tiers missed) —
 *  task #2's explicit requirement: "feed the error AND a snippet of the
 *  real file content back to the model", not just a bare rejection that
 *  invites the model to retry the identical failing call. Prefers a window
 *  around the first line of `oldStr` (loosely located via a plain
 *  substring search of just that line, trimmed) when findable; falls back
 *  to the start of the file otherwise. */
function buildMismatchSnippet(content: string, oldStr: string): string {
  const lines = content.split('\n');
  const firstSearchLine = oldStr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);

  if (firstSearchLine) {
    const idx = lines.findIndex((l) => l.includes(firstSearchLine));
    if (idx !== -1) {
      const start = Math.max(0, idx - 3);
      const end = Math.min(lines.length, idx + 8);
      const windowed = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
      return `Nearby content in the real file (lines ${start + 1}-${end}):\n${windowed}`;
    }
  }

  const headEnd = Math.min(40, lines.length);
  const head = lines.slice(0, headEnd).map((l, i) => `${i + 1}: ${l}`).join('\n');
  return `Start of the real file (lines 1-${headEnd}):\n${head}`;
}

// ── Handlers ──────────────────────────────────────────────────────

export async function readFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const path = resolvePath(rootPath, String(args.path ?? ''));
  const content = await invoke<string>('read_file', { path: stripVerbatimPrefix(path), maxBytes: TOOL_READ_MAX_BYTES });
  const truncationMarker = extractTruncationMarker(content);
  const body = stripTruncationMarker(content, truncationMarker);
  const lines = body.split('\n');
  const total = lines.length;
  const DEFAULT_WINDOW = 100;
  const startLine = args.start_line !== undefined ? Math.max(1, Number(args.start_line)) : 1;
  const endLine = args.end_line !== undefined
    ? Math.min(Number(args.end_line), total)
    : Math.min(startLine + DEFAULT_WINDOW - 1, total);
  const sliced = lines.slice(startLine - 1, endLine).join('\n');
  const remaining = total - endLine;
  const header = `--- lines ${startLine}-${endLine} of ${total} ---`;
  const footer = remaining > 0 ? `\n--- ${remaining} lines remaining ---` : '';
  const truncationNote = truncationMarker
    ? `\nNOTE: file truncated on read (${truncationMarker.note}) — this window may not reach the true end of the file.`
    : '';

  let brainHint = '';
  try {
    const relPath = String(args.path ?? '');
    const brainHits = await runBrainQueryCss(
      `article[data-cerveau-type='decision']:not([data-cerveau-valid-until]) data[value*='${relPath}']`,
      3,
    );
    if (brainHits && brainHits !== '0 matches' && !brainHits.startsWith('(')) {
      brainHint = `\n🧠 Brain: ${brainHits.slice(0, 200)}`;
    }
  } catch { /* brain enrichment is best-effort */ }

  return `${header}\n${sliced}${footer}${truncationNote}${brainHint}`;
}

export async function grepFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const path = resolvePath(rootPath, String(args.path ?? ''));
  const patternStr = String(args.pattern ?? '');
  let regex: RegExp;
  try {
    regex = new RegExp(patternStr);
  } catch (err) {
    return `Invalid pattern: ${String(err)}`;
  }
  const content = await invoke<string>('read_file', { path: stripVerbatimPrefix(path), maxBytes: TOOL_READ_MAX_BYTES });
  const truncationMarker = extractTruncationMarker(content);
  const body = stripTruncationMarker(content, truncationMarker);
  const truncationNote = truncationMarker
    ? `\nNOTE: file truncated on read (${truncationMarker.note}) — matches beyond this point are not included.`
    : '';
  // Structural grep — enrich matches with enclosing symbol context.
  try {
    const { structuralGrep, formatStructuralGrepResult } = await import('../structuralGrep.js');
    const result = await structuralGrep(body, regex, String(args.path));
    return formatStructuralGrepResult(result, patternStr, String(args.path), truncationNote);
  } catch {
    // Fallback to plain grep if structural grep fails
    const lines = body.split('\n');
    const matches: string[] = [];
    lines.forEach((line, idx) => {
      if (regex.test(line)) {
        matches.push(`L${idx + 1}: ${line}`);
      }
    });
    const count = matches.length;
    if (count === 0) {
      return `No matches for "${patternStr}" in ${String(args.path)}${truncationNote}`;
    }
    if (count <= 50) {
      return `Match lines for "${patternStr}" in ${String(args.path)}:\n${matches.join('\n')}${truncationNote}`;
    }
    return `${count} matches for "${patternStr}" in ${String(args.path)}; first 50 shown:\n${matches.slice(0, 50).join('\n')}${truncationNote}`;
  }
}

export async function writeFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const path = resolvePath(rootPath, String(args.path ?? ''));
  const newContent = String(args.content ?? '');
  try {
    const prev = await invoke<string>('read_file', { path: stripVerbatimPrefix(path) });
    undoStack.set(path, prev);
  } catch (err) {
    // Only a genuinely-missing target is safe to treat as "create new
    // file". Any OTHER read failure — most importantly the 20MB
    // read-ceiling refusal — must abort instead of silently writing
    // over an existing file with no undo snapshot (see
    // isMissingFileReadError's doc comment for the CRITICAL data-loss
    // bug this guards against).
    if (!isMissingFileReadError(err)) {
      return `ERROR: cannot write ${String(args.path)} — the existing file could not be read to snapshot for undo (${String(err)}), so it was NOT overwritten. If it is larger than the read ceiling, split the change into smaller edits.`;
    }
    // else: file doesn't exist yet — no undo state, proceed as create.
  }
  const syntaxError = await rejectIfSyntaxBroken(String(args.path ?? ''), newContent);
  if (syntaxError) return syntaxError;
  await invoke<void>('write_file', { path, content: newContent });
  return `Successfully wrote ${String(args.path)}`;
}

export async function editFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const path = resolvePath(rootPath, String(args.path ?? ''));
  const oldStr = String(args.old_string ?? '');
  const newStr = String(args.new_string ?? '');
  const content = await invoke<string>('read_file', { path: stripVerbatimPrefix(path) });

  // Matching cascade (task #2): exact -> indentation-normalized ->
  // blank-line-stripped — see searchReplaceMatch.ts's header for the
  // rationale. On total failure, feed the real file content
  // back instead of just failing (task #2's explicit requirement).
  const match = findSearchMatch(content, oldStr);
  if (!match) {
    const snippet = buildMismatchSnippet(content, oldStr);
    return `ERROR: old_string not found in ${String(args.path)} (tried exact, indentation-normalized, and blank-line-stripped matching).\n${snippet}`;
  }
  const updated = content.slice(0, match.index) + newStr + content.slice(match.index + match.length);

  // Syntax guardrail (task #3) — reject BEFORE writing when the edit would
  // break syntax; see rejectIfSyntaxBroken's doc comment.
  const syntaxError = await rejectIfSyntaxBroken(String(args.path ?? ''), updated);
  if (syntaxError) return syntaxError;

  undoStack.set(path, content);
  await invoke<void>('write_file', { path, content: updated });
  const strategyNote = match.strategy !== 'exact' ? ` (matched via ${match.strategy})` : '';
  return `Successfully edited ${String(args.path)} (${oldStr.length} chars → ${newStr.length} chars)${strategyNote}`;
}

export async function multiEdit(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const path = resolvePath(rootPath, String(args.path ?? ''));
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length === 0) return 'ERROR: No edits provided';
  const content = await invoke<string>('read_file', { path: stripVerbatimPrefix(path) });
  let updated = content;
  const strategies: string[] = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i] as Record<string, unknown>;
    const oldStr = String(edit.old_string ?? '');
    const newStr = String(edit.new_string ?? '');
    const match = findSearchMatch(updated, oldStr);
    if (!match) {
      const snippet = buildMismatchSnippet(updated, oldStr);
      return `ERROR: edit ${i + 1} old_string not found in ${String(args.path)} (tried exact, indentation-normalized, and blank-line-stripped matching). No edits applied (atomic).\n${snippet}`;
    }
    updated = updated.slice(0, match.index) + newStr + updated.slice(match.index + match.length);
    strategies.push(match.strategy);
  }

  const syntaxError = await rejectIfSyntaxBroken(String(args.path ?? ''), updated);
  if (syntaxError) return syntaxError;

  undoStack.set(path, content);
  await invoke<void>('write_file', { path, content: updated });
  const nonExact = strategies.filter((s) => s !== 'exact').length;
  const strategyNote = nonExact > 0 ? ` (${nonExact} matched via a fallback tier)` : '';
  return `Successfully applied ${edits.length} edits to ${String(args.path)}${strategyNote}`;
}

export async function undoEdit(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const path = resolvePath(rootPath, String(args.path ?? ''));
  const prev = undoStack.get(path);
  if (!prev) return `Nothing to undo for ${String(args.path)}`;
  await invoke<void>('write_file', { path, content: prev });
  undoStack.delete(path);
  return `Reverted ${String(args.path)} to previous state`;
}

export function hasUndoSnapshot(path: string): boolean {
  return undoStack.has(path);
}

export async function renameFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const oldPath = resolvePath(rootPath, String(args.old_path ?? ''));
  const newPath = resolvePath(rootPath, String(args.new_path ?? ''));
  await invoke<void>('fs_rename', { oldPath, newPath });
  return `Renamed ${String(args.old_path)} → ${String(args.new_path)}`;
}

export async function deleteFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const path = resolvePath(rootPath, String(args.path ?? ''));
  await invoke<void>('fs_remove', { path });
  return `Deleted ${String(args.path)}`;
}

export async function globFiles(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const basePath = args.path ? resolvePath(rootPath, String(args.path)) : rootPath;
  const pattern = String(args.pattern ?? '*');
  const entries = await invoke<Array<{ name: string; path: string; kind: string }>>('read_dir', { path: basePath });
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'file') {
      const nameMatch = simpleGlobMatch(pattern, entry.name);
      if (nameMatch) results.push(entry.name);
    }
  }
  if (results.length === 0) return `No files matching "${pattern}" in ${String(args.path ?? '.')}`;
  return `Files matching "${pattern}" (${results.length}):\n${results.slice(0, 50).join('\n')}`;
}

export async function findFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const pattern = String(args.pattern ?? '**/*');
  const basePath = args.path ? resolvePath(rootPath, String(args.path)) : rootPath;
  try {
    const entries = await invoke<Array<{ name: string; path: string; kind: string }>>('read_dir', { path: basePath });
    const results: string[] = [];
    for (const entry of entries) {
      if (entry.kind === 'file' && simpleGlobMatch(pattern.replace(/^.*\//, ''), entry.name)) {
        results.push(entry.path.replace(rootPath + '/', ''));
      }
    }
    if (results.length === 0) return `No files matching "${pattern}"`;
    return `Files matching "${pattern}" (${results.length}):\n${results.slice(0, 50).join('\n')}`;
  } catch (err) {
    return `ERROR: find_file failed: ${String(err)}`;
  }
}

export async function readDir(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const path = resolvePath(rootPath, String(args.path ?? '.'));
  const entries = await invoke<Array<{ name: string; path: string; kind: string }>>('read_dir', { path });
  const listing = entries.map(e => `${e.kind === 'dir' ? 'd' : 'f'} ${e.name}`).join('\n');
  return `Directory ${String(args.path)}:\n${listing}`;
}
