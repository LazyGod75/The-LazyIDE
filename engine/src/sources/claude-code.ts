/**
 * claude-code.ts
 *
 * ConversationSource implementation for Claude Code (Anthropic) conversation
 * transcripts stored under ~/.claude/projects/<encoded-path>/<session>.jsonl.
 *
 * Extracted from src/commands/dream.ts so that the registry can wire multiple
 * sources without coupling dream.ts to Claude Code specifics.
 *
 * Import direction (acyclic):
 *   claude-code → { types, summarize, noise, dream-tool-trace } + node builtins
 *   dream → registry → claude-code   (never the reverse)
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractToolTraceFiles } from '../util/tool-trace.js';
import {
  hasMeaningfulContent,
  isAgentMetaText,
  isBuildOutputNoise,
  isConfigurableNoise,
} from './noise.js';
import type { ConversationPayload, ConversationRef, ConversationSource } from './types.js';

// ---------------------------------------------------------------------------
// Session id (golden-locked: must stay "dream-<8hex>" forever)
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic, collision-resistant session id from a conversation
 * file path. Using the file path as the identity source guarantees:
 *
 * - Two DIFFERENT conversations (different paths) → different session ids
 *   → different note ids even when the summary text is identical.
 * - The SAME conversation re-processed → identical session id every run
 *   → same note id → fingerprint-skip and idempotent re-runs still work.
 *
 * Format: "dream-<8hex>" where <8hex> = first 8 chars of SHA-256(filePath).
 * The 8-char hex suffix gives 4 billion buckets — collision probability for
 * the typical ~1000-conversation corpus is ~1.2 × 10^-4 (negligible).
 */
export function makeConversationSessionId(filePath: string): string {
  const hash = createHash('sha256').update(filePath).digest('hex').slice(0, 8);
  return `dream-${hash}`;
}

// ---------------------------------------------------------------------------
// Path decoding
// ---------------------------------------------------------------------------

/**
 * Decode project directory name back to a path hint.
 *
 * Claude encodes project cwd into the directory name by replacing each
 * path separator with a single dash:
 *   "C:\Users\..." → "C--Users-..." (colon→dash, backslash→dash)
 *
 * The leading two-dash sequence is the Windows drive letter encoding:
 *   "C--" means "C:" + "\" (colon + backslash) → decoded as "C:/"
 *
 * Using "^([A-Za-z])-" (one dash) was wrong: it consumed only the first dash,
 * leaving a second leading dash that became an extra "/" after the global
 * replace, producing "C://Users/..." instead of "C:/Users/...".
 *
 * Examples:
 *   "C--Users-johndoe-Projects-myapp" → "C:/Users/johndoe/Projects/myapp"
 *   "home-user-projects-myapp-myapp-" → "home/user/projects/myapp/myapp/"
 */
export function decodeProjectPath(dirName: string): string {
  return (
    dirName
      // Windows drive letter: "X--" → "X:/" (two dashes = colon + path separator)
      .replace(/^([A-Za-z])--/, '$1:/')
      // All remaining dashes are path separators
      .replace(/-/g, '/')
  );
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Find JSONL conversation files in a project directory (shallow 2-level scan).
 */
export function findConversationFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json'))) {
        files.push(full);
      } else if (entry.isDirectory()) {
        // Limit recursion depth to subdirs
        try {
          for (const sub of readdirSync(full, { withFileTypes: true })) {
            if (sub.isFile() && (sub.name.endsWith('.jsonl') || sub.name.endsWith('.json'))) {
              files.push(join(full, sub.name));
            }
          }
        } catch {
          /* skip unreadable subdirs */
        }
      }
    }
  } catch {
    /* skip unreadable dirs */
  }
  return files;
}

// ---------------------------------------------------------------------------
// Message text extraction
// ---------------------------------------------------------------------------

/**
 * Extract text from a message object (supports both string and structured content).
 */
export function extractTextFromMessage(obj: Record<string, unknown>): string | null {
  if (typeof obj.content === 'string') return obj.content;
  if (!Array.isArray(obj.content)) return null;

  const texts: string[] = [];
  for (const block of obj.content) {
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      texts.push(b.text);
    }
  }
  return texts.join(' ').trim() || null;
}

// ---------------------------------------------------------------------------
// Conversation summary
// ---------------------------------------------------------------------------

export interface ConversationSummary {
  /** Prose text — up to 4000 chars of the most valuable conversation content. */
  text: string;
  /** Project-relative forward-slash paths touched by Edit / Write calls. */
  filesModified: string[];
  /** Project-relative forward-slash paths touched by Read calls. */
  filesRead: string[];
}

/**
 * A single chunk extracted from a conversation, ready for note generation.
 * Chunking produces multiple payloads from a large conversation so that
 * coverage scales with conversation size instead of collapsing to 1 note.
 */
export interface ConversationChunk {
  text: string;
  filesModified: string[];
  filesRead: string[];
}

function categorizeMessage(
  text: string,
  decisions: string[],
  errors: string[],
  facts: string[],
  general: string[],
): void {
  if (
    /\b(decided|decision|chose|choosing|switched|migration|use .+ instead|we('ll| will) use|going with|opted for)\b/i.test(
      text,
    )
  ) {
    decisions.push(text);
  } else if (/\b(error|bug|fix|broken|failed|crash|issue|exception|traceback)\b/i.test(text)) {
    errors.push(text);
  } else if (
    /\b(because|reason|important|always|never|warning|careful|don't|avoid|must|should|need to|has to)\b/i.test(
      text,
    )
  ) {
    facts.push(text);
  } else if (text.length > 40) {
    general.push(text);
  }
}

/**
 * Extract conversation summary from JSONL transcript (single-chunk legacy API).
 * Extracts BOTH human AND assistant messages, categorizing by decision/error/fact/general.
 * Also scans tool_use blocks to extract file paths (AUTHORITATIVE via parseToolPayload).
 *
 * @param content     Raw JSONL content of the conversation file.
 * @param projectRoot Absolute path to the project (used to relativise tool paths).
 */
export function extractConversationSummary(
  content: string,
  projectRoot: string,
): ConversationSummary {
  const chunks = extractConversationChunks(content, projectRoot, 1);
  if (chunks.length === 0) {
    const { filesModified, filesRead } = extractToolTraceFiles(content, projectRoot);
    return { text: '', filesModified, filesRead };
  }
  return chunks[0];
}

/**
 * Split a JSONL conversation into multiple chunks for comprehensive coverage.
 *
 * Strategy:
 * - Scan all messages, collect categorized text segments.
 * - Group into chunks of ~TARGET_CHARS each (default 6000).
 * - Each chunk produces one note → one conversation yields 1..MAX_CHUNKS_PER_CONV notes.
 * - Small conversations (< TARGET_CHARS of content) still yield exactly 1 chunk.
 * - File paths are shared across all chunks from the same conversation.
 *
 * @param content           Raw JSONL content.
 * @param projectRoot       Project root for tool-trace path resolution.
 * @param maxChunks         Cap on chunks per conversation (default: 25).
 * @param targetCharsPerChunk Soft target for content per chunk (default: 6000).
 */
export function extractConversationChunks(
  content: string,
  projectRoot: string,
  maxChunks = 25,
  targetCharsPerChunk = 6000,
): ConversationChunk[] {
  const lines = content.split('\n').filter(Boolean);

  // Collect all message segments with their category
  const segments: Array<{ text: string; category: 'decision' | 'error' | 'fact' | 'general' }> = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;

      const msgType = (obj.type as string) ?? (obj.role as string) ?? '';
      const isUser = msgType === 'user' || msgType === 'human';
      const isAssistant = msgType === 'assistant';

      if (!isUser && !isAssistant) continue;

      const message = obj.message as Record<string, unknown> | undefined;
      const textSource = message ?? obj;
      const text = extractTextFromMessage(textSource);
      if (!text || text.length < 20) continue;

      // Drop obvious agent meta-commentary before any further processing.
      if (isAgentMetaText(text)) continue;

      const truncated = isUser ? text.slice(0, 500) : text.slice(0, 600);

      if (isAssistant) {
        if (truncated.startsWith('{') || truncated.startsWith('[') || truncated.startsWith('```'))
          continue;
        if (/^(Running|Reading|Searching|Checking|Let me)/i.test(truncated)) continue;
      }

      // Categorize and push
      const decisions: string[] = [];
      const errors: string[] = [];
      const facts: string[] = [];
      const general: string[] = [];
      categorizeMessage(truncated, decisions, errors, facts, general);

      for (const t of decisions) segments.push({ text: t, category: 'decision' });
      for (const t of errors) segments.push({ text: t, category: 'error' });
      for (const t of facts) segments.push({ text: t, category: 'fact' });
      for (const t of general) segments.push({ text: t, category: 'general' });
    } catch {
      /* skip malformed lines */
    }
  }

  if (segments.length === 0) return [];

  // File paths shared across all chunks
  const { filesModified, filesRead } = extractToolTraceFiles(content, projectRoot);

  // Build chunks by iterating segments sequentially and cutting at targetCharsPerChunk.
  // Sequential order preserves conversational flow. When total content fits within one
  // targetCharsPerChunk the result is a single chunk (small conversations).
  const chunks: ConversationChunk[] = [];
  let currentBucket: string[] = [];
  let currentChars = 0;

  const flushChunk = (): void => {
    if (currentBucket.length === 0) return;
    const text = currentBucket.join('\n\n').slice(0, 4000);
    // Apply meaningful-content gate: drop the chunk if it is noise at the aggregate level.
    // isAgentMetaText catches boilerplate signatures (scheduled-task wrappers, rate-limit
    // residue, etc.); hasMeaningfulContent enforces minimum word count and rejects
    // punctuation-only or repetition-dominated content.
    // isConfigurableNoise drops demo-fixture references and user-defined ignore patterns.
    // isBuildOutputNoise drops CI gate exit-code dumps and numbered step lists.
    if (
      text.length > 50 &&
      !isAgentMetaText(text) &&
      hasMeaningfulContent(text) &&
      !isConfigurableNoise(text) &&
      !isBuildOutputNoise(text)
    ) {
      chunks.push({ text, filesModified, filesRead });
    }
    currentBucket = [];
    currentChars = 0;
  };

  for (const seg of segments) {
    // Start a new chunk when adding this segment would exceed the target,
    // but only if the current bucket already has content (never emit empty chunks).
    if (currentChars + seg.text.length > targetCharsPerChunk && currentBucket.length > 0) {
      flushChunk();
      if (chunks.length >= maxChunks) break;
    }
    currentBucket.push(seg.text);
    currentChars += seg.text.length + 2; // +2 for the join separator
  }
  // Flush the final bucket (last / only chunk for small conversations)
  if (chunks.length < maxChunks) {
    flushChunk();
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Bounded file read (memory-safety guard)
// ---------------------------------------------------------------------------

/**
 * Hard cap, in bytes, on how much of a single conversation transcript is ever
 * loaded into memory. Overridable via LAZYBRAIN_MAX_CONVERSATION_BYTES (for
 * testing / tuning). Default 6 MiB.
 *
 * Why this exists: real Claude Code session transcripts (especially long
 * subagent runs) routinely reach 15-60 MB on disk (measured on a real, heavily
 * used machine: dozens of files in the 15-35 MB range, one at 58 MB, across
 * ~4000 conversation files total). `readConversation` used to `readFile()` the
 * WHOLE file unconditionally, and dream.ts processes
 * `resolveIngestionConcurrency()` (see dream.ts) files concurrently — so a
 * batch of the most-recently-modified (i.e. most active, typically largest)
 * transcripts could hold hundreds of MB to multiple GB of raw JSONL text in
 * memory at once, compounded by the ~2x overhead of `content.split('\n')` and
 * per-line JSON.parse() object churn. This was the dominant contributor to the
 * measured 3+ GB `dream` memory spike.
 *
 * extractConversationChunks only ever keeps at most
 * maxChunks(25) * targetCharsPerChunk(6000) ≈ 150 KB of signal per
 * conversation — reading 58 MB to extract 150 KB is ~400x waste. Capping the
 * read (from the END of the file — the most recent, most relevant messages)
 * bounds worst-case per-file memory to a small, predictable constant
 * regardless of how large the transcript grows on disk.
 */
const MAX_CONVERSATION_READ_BYTES = (() => {
  const override = Number(process.env.LAZYBRAIN_MAX_CONVERSATION_BYTES);
  return Number.isFinite(override) && override > 0 ? override : 6 * 1024 * 1024;
})();

/**
 * Read a conversation transcript's content, capped at
 * MAX_CONVERSATION_READ_BYTES. Files under the cap are read in full
 * (unchanged behavior). Files over the cap are tail-read: only the last
 * MAX_CONVERSATION_READ_BYTES are loaded (the most recent messages — the ones
 * most likely to matter), snapped forward past the first (possibly truncated)
 * line so JSON.parse never chokes on a partial JSONL record.
 *
 * Exported for direct unit testing of the truncation boundary.
 */
export async function readConversationContentBounded(
  filePath: string,
  maxBytes: number = MAX_CONVERSATION_READ_BYTES,
): Promise<string> {
  const size = statSync(filePath).size;
  if (size <= maxBytes) {
    return readFile(filePath, 'utf-8');
  }

  const start = size - maxBytes;
  const handle = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    await handle.read(buf, 0, maxBytes, start);
    const text = buf.toString('utf-8');
    // Drop the first (likely truncated, unparsable) line so the remaining
    // content is clean JSONL starting at a real record boundary.
    const firstNewline = text.indexOf('\n');
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// ClaudeCodeSource
// ---------------------------------------------------------------------------

export interface ClaudeCodeSourceOptions {
  /** Override the user profile dir (tests). Defaults to USERPROFILE/HOME. */
  userProfile?: string;
}

export class ClaudeCodeSource implements ConversationSource {
  readonly agent = 'claude-code' as const;
  private readonly userProfile: string | undefined;

  constructor(opts: ClaudeCodeSourceOptions = {}) {
    // Store the explicit override if provided; otherwise defer to env vars at call time.
    this.userProfile = opts.userProfile;
  }

  private resolveUserProfile(): string {
    return this.userProfile ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
  }

  listConversations(): ConversationRef[] {
    const claudeDir = join(this.resolveUserProfile(), '.claude', 'projects');
    if (!existsSync(claudeDir)) return [];

    // Default: skip the engine's own project (lazybrain) to avoid self-referential noise.
    // Opt-in include: set LAZYBRAIN_DREAM_INCLUDE_SELF=1 to include it (dogfood/demo).
    const includeSelf = (process.env.LAZYBRAIN_DREAM_INCLUDE_SELF ?? '').trim() === '1';

    const refs: ConversationRef[] = [];
    for (const proj of readdirSync(claudeDir, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const projectRoot = decodeProjectPath(proj.name);
      if (/lazybrain/i.test(proj.name) && !includeSelf) {
        continue;
      }
      const projPath = join(claudeDir, proj.name);
      for (const f of findConversationFiles(projPath)) {
        try {
          const stat = statSync(f);
          refs.push({
            path: f,
            mtimeMs: stat.mtimeMs,
            projectRoot,
            agent: 'claude-code',
            kind: 'transcript',
          });
        } catch {
          /* skip unreadable files */
        }
      }
    }
    return refs;
  }

  async readConversation(ref: ConversationRef): Promise<ConversationPayload[]> {
    const content = await readConversationContentBounded(ref.path);
    const chunks = extractConversationChunks(content, ref.projectRoot);
    if (chunks.length === 0) return [];

    const baseSessionId = makeConversationSessionId(ref.path);
    const timestamp = new Date(ref.mtimeMs).toISOString();

    return chunks.map((chunk, index) => ({
      // Each chunk gets a unique sessionId so notes don't collide.
      // Chunk 0 keeps the original id for backward compat with existing fingerprints.
      sessionId: index === 0 ? baseSessionId : `${baseSessionId}-c${index}`,
      text: chunk.text,
      timestamp,
      cwd: ref.projectRoot,
      filesModified: chunk.filesModified,
      filesRead: chunk.filesRead,
      agent: 'claude-code' as const,
      sourceKind: 'transcript' as const,
    }));
  }
}
