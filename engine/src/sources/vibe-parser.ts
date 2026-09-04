/**
 * Pure parsers for Mistral Vibe session artifacts.
 *
 * messages.jsonl: one LLMMessage JSON per line, serialized by Vibe with
 * model_dump(exclude_none=True, mode="json") — absent fields are MISSING,
 * not null. tool_calls[].function.arguments is a JSON-ENCODED STRING that
 * must be parsed a second time to reach file paths.
 *
 * Verified against mistral-vibe v2.14.0 (vibe/core/types.py,
 * vibe/core/session/session_logger.py).
 */

import { relativise } from '../util/tool-trace.js';
import { type SummaryItem, summarizeMessages } from './summarize.js';

export interface VibeFunctionCall {
  name?: string;
  arguments?: string | null;
}

export interface VibeToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: VibeFunctionCall;
}

export interface VibeMessage {
  role?: string;
  content?: string | null;
  injected?: boolean;
  tool_calls?: VibeToolCall[] | null;
  tool_call_id?: string | null;
  name?: string | null;
  message_id?: string | null;
}

export interface VibeSessionMeta {
  session_id?: string;
  parent_session_id?: string | null;
  start_time?: string;
  end_time?: string | null;
  git_commit?: string | null;
  git_branch?: string | null;
  title?: string | null;
  total_messages?: number;
  environment?: { working_directory?: string | null };
}

/**
 * Literal prefix Vibe prepends to post-compaction summaries
 * (vibe/core/prompts/compact_summary_prefix.md). The injected:true flag is
 * the robust half of the detection; the prefix narrows it to compaction.
 */
export const VIBE_COMPACT_SUMMARY_PREFIX = 'Another language model started to solve this problem';

/**
 * Vibe file tools and the argument key that carries the path.
 *
 * v2.14.0 renamed search_replace → edit. Both names are kept so sessions
 * recorded on older Vibe versions continue to produce correct file attribution.
 * write_file became create-only in v2.14 but the argument key ("path") did not change.
 */
const VIBE_READ_TOOLS: Record<string, string> = { read: 'file_path' };
const VIBE_WRITE_TOOLS: Record<string, string> = {
  edit: 'file_path',
  search_replace: 'file_path', // pre-v2.14 alias
  write_file: 'path',
};

export function parseVibeMessages(jsonl: string): VibeMessage[] {
  const out: VibeMessage[] = [];
  for (const rawLine of jsonl.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as VibeMessage;
      if (obj && typeof obj === 'object' && typeof obj.role === 'string') out.push(obj);
    } catch {
      /* skip corrupt line — Vibe appends with fsync but interrupts happen */
    }
  }
  return out;
}

export function parseVibeMeta(raw: string): VibeSessionMeta | null {
  try {
    const obj = JSON.parse(raw) as VibeSessionMeta;
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

export function isCompactionSummary(msg: VibeMessage): boolean {
  return (
    msg.role === 'user' &&
    msg.injected === true &&
    typeof msg.content === 'string' &&
    // Trim leading whitespace to tolerate minor formatting drift in Vibe's
    // injected message serialization while still matching the literal prefix
    // from vibe/core/prompts/compact_summary_prefix.md.
    msg.content
      .trimStart()
      .startsWith(VIBE_COMPACT_SUMMARY_PREFIX)
  );
}

/**
 * Returns the compaction summary text with the boilerplate prefix removed,
 * or null when this transcript contains none.
 */
export function findCompactionSummary(messages: VibeMessage[]): string | null {
  for (const msg of messages) {
    if (!isCompactionSummary(msg)) continue;
    // Strip leading whitespace before locating the first newline so the prefix
    // boundary is found correctly even when the content has leading spaces.
    const content = (msg.content ?? '').trimStart();
    const idx = content.indexOf('\n');
    const body = idx >= 0 ? content.slice(idx + 1) : content;
    const cleaned = body.trim();
    return cleaned.length > 0 ? cleaned : null;
  }
  return null;
}

/**
 * Extract project-relative file paths from tool calls.
 * arguments is a JSON STRING — parse failures drop that call, never throw.
 */
export function extractVibeToolFiles(
  messages: VibeMessage[],
  projectRoot: string,
): { filesModified: string[]; filesRead: string[] } {
  const modified = new Set<string>();
  const read = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
    for (const call of msg.tool_calls) {
      const name = call.function?.name ?? '';
      const rawArgs = call.function?.arguments;
      if (!name || typeof rawArgs !== 'string') continue;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        continue;
      }
      const readKey = VIBE_READ_TOOLS[name];
      const writeKey = VIBE_WRITE_TOOLS[name];
      const pick = (key: string | undefined): string | null => {
        if (!key) return null;
        const v = args[key];
        return typeof v === 'string' && v.length > 0 ? v : null;
      };
      const readPath = pick(readKey);
      if (readPath) {
        const rel = projectRoot ? relativise(readPath, projectRoot) : readPath;
        if (rel) read.add(rel);
      }
      const writePath = pick(writeKey);
      if (writePath) {
        const rel = projectRoot ? relativise(writePath, projectRoot) : writePath;
        if (rel) modified.add(rel);
      }
    }
  }

  return { filesModified: [...modified], filesRead: [...read] };
}

/**
 * Build the <=4000 char prose summary from a Vibe transcript.
 * Skips: role:tool results, injected messages (incl. compaction summaries —
 * those become their own payload), system (never in messages.jsonl anyway).
 */
export function extractVibeSummary(messages: VibeMessage[]): string {
  const items: SummaryItem[] = [];
  for (const msg of messages) {
    if (msg.injected === true) continue;
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    if (typeof msg.content !== 'string' || msg.content.length === 0) continue;
    items.push({ role: msg.role, text: msg.content });
  }
  return summarizeMessages(items);
}
