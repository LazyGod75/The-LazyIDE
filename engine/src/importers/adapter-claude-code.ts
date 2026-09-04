/**
 * Import adapter for Claude Code transcripts.
 *
 * Wraps the existing ClaudeCodeSource (src/sources/claude-code.ts) so that
 * the import command can reuse the battle-tested JSONL parsing logic.
 * This adapter is VALIDATED — it reads real ~/.claude/projects/**\/*.jsonl files.
 *
 * Quality gate: raw transcripts include IDE-internal scaffolding — agent
 * system/persona prompts logged as ordinary "user" turns, fully autonomous
 * mission runs with no human in the loop, trivial one-line exchanges — that
 * produce low-value notes. scanTranscriptSignal() below (a) skips whole
 * transcripts that are scaffolding-only, human-turn-free, or too trivial,
 * and (b) derives note titles from the first genuine human turn, never
 * from agent reasoning. Titles cannot come from chunk text: extractConversa-
 * tionChunks (sources/claude-code.ts) buckets segments by category
 * (decision/error/fact/general), not chronological speaker order, so a
 * chunk's first line is just as likely to be assistant reasoning as
 * something a human wrote.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  decodeProjectPath,
  extractConversationChunks,
  extractTextFromMessage,
  findConversationFiles,
  makeConversationSessionId,
} from '../sources/claude-code.js';
import { scrubText } from './scrub.js';
import type { ImportAdapter, ImportedConversation } from './types.js';

export class ClaudeCodeImportAdapter implements ImportAdapter {
  readonly source = 'claude-code' as const;

  private claudeDir(): string {
    const profile = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
    return join(profile, '.claude', 'projects');
  }

  isAvailable(): boolean {
    return existsSync(this.claudeDir());
  }

  list(since?: string): ImportedConversation[] {
    const dir = this.claudeDir();
    if (!existsSync(dir)) return [];

    const sinceMs = since ? new Date(since).getTime() : 0;
    const results: ImportedConversation[] = [];

    for (const proj of readdirSync(dir, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const projectRoot = decodeProjectPath(proj.name);
      const projPath = join(dir, proj.name);

      for (const filePath of findConversationFiles(projPath)) {
        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs < sinceMs) continue;

          const content = readFileSync(filePath, 'utf-8');

          // Quality gate: skip transcripts that are pure agent scaffolding
          // (no genuine human turn — e.g. an autonomous mission whose only
          // "user" message is a system/persona prompt) or too trivial to be
          // worth a note (e.g. a two-line greeting). See scanTranscriptSignal.
          const { humanTurn, substantiveChars } = scanTranscriptSignal(content);
          if (!humanTurn || substantiveChars < MIN_SUBSTANTIVE_CHARS) continue;

          const chunks = extractConversationChunks(content, projectRoot, 25, 6000);
          if (chunks.length === 0) continue;

          const baseSessionId = makeConversationSessionId(filePath);
          const timestamp = new Date(stat.mtimeMs).toISOString();
          const topic = deriveTopic(projectRoot);
          const humanTitle = deriveTitle(humanTurn, baseSessionId);

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const text = scrubText(stripHarnessMarkup(chunk.text));
            const contentHash = hashContent(text);

            results.push({
              contentHash,
              title: i === 0 ? humanTitle : `${humanTitle} (part ${i + 1})`,
              text,
              timestamp,
              source: `import:claude-code`,
              topic,
              cwd: projectRoot,
              filesModified: chunk.filesModified,
              filesRead: chunk.filesRead,
            });
          }
        } catch {
          // Skip unreadable files — best effort
        }
      }
    }

    return results;
  }
}

function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Claude Code CLI harness/system envelope tags that can appear verbatim
 * inside a transcript message (slash-command invocations and injected
 * system reminders) — this is CLI scaffolding, never real conversation
 * content, and must never leak into a note's title or summary. Both the
 * paired form (tag + its content, e.g. an injected `<system-reminder>`
 * block) and stray/self-closing tags are stripped.
 */
const HARNESS_TAGS = [
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'system-reminder',
  'task-notification',
];

const HARNESS_TAG_PATTERNS = HARNESS_TAGS.flatMap((tag) => [
  new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'gi'),
  new RegExp(`</?${tag}[^>]*>`, 'gi'),
]);

/** Strip harness/system envelope markup — see HARNESS_TAGS above. Exported for tests. */
export function stripHarnessMarkup(text: string): string {
  let result = text;
  for (const pattern of HARNESS_TAG_PATTERNS) {
    result = result.replace(pattern, ' ');
  }
  return result
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Quality gate — scaffolding / triviality filtering (see file header doc)
// ---------------------------------------------------------------------------

/**
 * Agent-scaffolding prompts (Lazy's own internal agent personas/task
 * instructions) that get logged as ordinary "user" turns by the transcript
 * logger, even though they are IDE-internal plumbing, never something a
 * human typed. Observed verbatim in real transcripts (Lazy's own harness
 * concatenates a system instruction into a single CLI turn behind a literal
 * "[System]" marker):
 *   "[System]\nYou are an autonomous coding agent. You MUST use the
 *    write_file tool to create or modify files..."
 *   "[System]\nYou are an autonomous evaluator. Assess the given diff/task
 *    and output a concise JSON verdict..."
 */
const SCAFFOLDING_PROMPT_RE = /^(?:\[system\]\s*)?you are an? autonomous\b/i;

function isScaffoldingPrompt(text: string): boolean {
  return SCAFFOLDING_PROMPT_RE.test(text.trimStart());
}

/**
 * Minimum total human+assistant prose (chars, after harness-stripping and
 * secret-scrubbing, scaffolding prompts excluded) for a transcript to be
 * worth a note. Below this the exchange is too trivial (e.g. a two-line
 * greeting with no real content) to carry any recall value.
 */
const MIN_SUBSTANTIVE_CHARS = 150;

interface TranscriptSignal {
  /** First genuine (non-scaffolding) human message, cleaned. Null when the
   *  transcript has no human turn at all (e.g. a fully autonomous mission
   *  whose only "user" message is a system/persona prompt). */
  humanTurn: string | null;
  /** Total scrubbed human+assistant prose length, scaffolding excluded. */
  substantiveChars: number;
}

/**
 * Single-pass scan of a raw JSONL transcript for the import quality-gate
 * signal. Deliberately independent of extractConversationChunks (sources/
 * claude-code.ts), which discards speaker order/role while bucketing
 * segments by category — that makes it unusable for "was there a human
 * turn" or "what did the human actually ask", which this function answers.
 */
function scanTranscriptSignal(content: string): TranscriptSignal {
  const lines = content.split('\n').filter(Boolean);
  let humanTurn: string | null = null;
  let substantiveChars = 0;

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const msgType = (obj.type as string) ?? (obj.role as string) ?? '';
    const isUser = msgType === 'user' || msgType === 'human';
    const isAssistant = msgType === 'assistant';
    if (!isUser && !isAssistant) continue; // system-role or unknown: never counted, never a title source

    const message = obj.message as Record<string, unknown> | undefined;
    const rawText = extractTextFromMessage(message ?? obj);
    if (!rawText) continue;

    const cleaned = scrubText(stripHarnessMarkup(rawText)).trim();
    if (cleaned.length < 10 || isScaffoldingPrompt(cleaned)) continue;

    substantiveChars += cleaned.length;
    if (isUser && humanTurn === null) humanTurn = cleaned;
  }

  return { humanTurn, substantiveChars };
}

function deriveTitle(text: string, fallback: string): string {
  const first = text.split('\n').find((l) => l.trim().length > 10);
  if (!first) return fallback;
  return first.trim().slice(0, 80);
}

function deriveTopic(projectRoot: string): string {
  if (!projectRoot) return 'import/claude-code';
  const parts = projectRoot.replace(/\\/g, '/').split('/').filter(Boolean);
  const lastTwo = parts.slice(-2).join('/');
  return lastTwo ? `import/claude-code/${lastTwo}` : 'import/claude-code';
}
