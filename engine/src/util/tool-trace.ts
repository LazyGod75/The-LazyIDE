/**
 * tool-trace.ts — Pure helpers for extracting file paths from tool-use traces.
 *
 * These utilities are shared between:
 *   - src/commands/dream-tool-trace.ts (dream pipeline)
 *   - src/sources/claude-code.ts       (conversation source)
 *   - src/sources/vibe-parser.ts       (vibe source)
 *
 * Moved here from src/commands/dream-tool-trace.ts to eliminate the
 * sources → commands layer inversion.
 */

import { parseToolPayload } from '../capture/payload-parser.js';

export interface ToolTraceResult {
  filesModified: string[];
  filesRead: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Transform a JSONL tool_use content block (from assistant messages) into the
 * hook-payload JSON string that parseToolPayload() understands.
 *
 * JSONL format:  { type: 'tool_use', name: 'Edit', input: { file_path: '...' } }
 * Hook format:   { tool_name: 'Edit', tool_input: { file_path: '...' } }
 */
function toolUseBlockToHookJson(block: Record<string, unknown>): string {
  return JSON.stringify({
    tool_name: block.name,
    tool_input: block.input ?? {},
    tool_response: {},
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Relativise an absolute file path against a project root.
 * Returns null when the path does not start with the root.
 *
 * Both inputs are normalised to forward-slash before the prefix check,
 * so Windows backslashes do not break comparisons.
 */
export function relativise(filePath: string, projectRoot: string): string | null {
  // Backslash → slash, collapse consecutive slashes (mirrors cwd-normalizer internals).
  const normPath = filePath.replace(/\\/g, '/').replace(/\/+/g, '/');
  const normRoot = projectRoot.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');

  const lowerPath = normPath.toLowerCase();
  const lowerRoot = normRoot.toLowerCase();

  if (!lowerPath.startsWith(`${lowerRoot}/`) && lowerPath !== lowerRoot) {
    return null;
  }

  const rel = normPath.slice(normRoot.length).replace(/^\//, '');
  return rel || null;
}

/**
 * Walk every JSONL line, find assistant tool_use blocks, run each through
 * parseToolPayload(), and accumulate de-duplicated, relative, forward-slash
 * file paths.
 *
 * @param jsonl       Raw JSONL content of a conversation file.
 * @param projectRoot Absolute path to the project the conversation belongs to.
 */
export function extractToolTraceFiles(jsonl: string, projectRoot: string): ToolTraceResult {
  const modifiedSet = new Set<string>();
  const readSet = new Set<string>();

  for (const rawLine of jsonl.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // skip malformed lines
    }

    // We only care about assistant messages that contain tool_use blocks.
    const msgType = (obj.type as string) ?? (obj.role as string) ?? '';
    if (msgType !== 'assistant') continue;

    const message = (obj.message ?? obj) as Record<string, unknown>;
    const content = message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (
        !block ||
        typeof block !== 'object' ||
        (block as Record<string, unknown>).type !== 'tool_use'
      ) {
        continue;
      }

      const hookJson = toolUseBlockToHookJson(block as Record<string, unknown>);
      const parsed = parseToolPayload(hookJson);
      if (!parsed) continue;

      for (const absPath of parsed.filesModified) {
        const rel = relativise(absPath, projectRoot);
        if (rel) modifiedSet.add(rel);
      }

      for (const absPath of parsed.filesRead) {
        const rel = relativise(absPath, projectRoot);
        if (rel) readSet.add(rel);
      }
    }
  }

  return {
    filesModified: [...modifiedSet],
    filesRead: [...readSet],
  };
}
