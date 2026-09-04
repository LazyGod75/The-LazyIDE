import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../util/config.js';

export type ValidationResult =
  | { ok: true; hash: string }
  | { ok: false; reason: ValidationRejection };

export type ValidationRejection =
  | 'too_short'
  | 'repetitive'
  | 'json_only_noise'
  | 'duplicate'
  | 'low_value_tool';

const MIN_USEFUL_CHARS = 40;
const REPETITION_LEN = 20;
const DEDUP_WINDOW_DAYS = 7;
const HASH_STORE = 'capture-hashes.jsonl';

interface HashEntry {
  hash: string;
  ts: number;
}

let cachedEntries: HashEntry[] | null = null;
let cachedAt = 0;

function hashStorePath(): string {
  return join(getConfig().cachePath, HASH_STORE);
}

function loadEntries(): HashEntry[] {
  const now = Date.now();
  if (cachedEntries && now - cachedAt < 5000) return cachedEntries;

  const path = hashStorePath();
  if (!existsSync(path)) {
    cachedEntries = [];
    cachedAt = now;
    return cachedEntries;
  }

  const cutoff = now - DEDUP_WINDOW_DAYS * 86_400_000;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  const entries: HashEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as HashEntry;
      if (entry.ts >= cutoff) entries.push(entry);
    } catch {
      // skip malformed
    }
  }
  cachedEntries = entries;
  cachedAt = now;
  return entries;
}

function persistEntry(entry: HashEntry, entries: HashEntry[]): void {
  const path = hashStorePath();
  // Rewrite file periodically to prune old entries; otherwise append.
  if (entries.length % 50 === 0) {
    writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  } else {
    writeFileSync(
      path,
      `${readFileSync(path, 'utf8').replace(/\n?$/, '\n') + JSON.stringify(entry)}\n`,
      'utf8',
    );
  }
}

export function normalizeForHash(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function contentHash(text: string): string {
  return createHash('sha1').update(normalizeForHash(text)).digest('hex');
}

function isRepetitive(text: string): boolean {
  return new RegExp(`(.)\\1{${REPETITION_LEN - 1},}`).test(text);
}

/**
 * Detect payloads that are *just* a JSON dump with no human prose.
 * Used to reject raw hook payloads like `{"session_id":"...","tool_response":...}`.
 *
 * Returns true only when the entire input is a JSON dump with no human prose:
 *   - Text starts with `{` or `[` (clear JSON container)
 *   - AND the ratio of JSON-structural chars (`{`, `}`, `[`, `]`, `"`, `:`, `,`) to
 *     total chars exceeds 0.7 (pure JSON dominance), OR no prose value ≥ 50 chars found.
 *
 * Inline code snippets like `{ ok: false, error }` embedded in prose sentences
 * are NOT rejected because the surrounding text does NOT start with `{`/`[`.
 */
const HOOK_PAYLOAD_MARKERS = [
  /"session_id"\s*:/,
  /"tool_name"\s*:/,
  /"tool_response"\s*:/,
  /"transcript_path"\s*:/,
  /"hook_event_name"\s*:/,
];

/** Count JSON structural characters as a fraction of total chars. */
function jsonStructuralRatio(text: string): number {
  let structural = 0;
  for (const ch of text) {
    if (
      ch === '{' ||
      ch === '}' ||
      ch === '[' ||
      ch === ']' ||
      ch === '"' ||
      ch === ':' ||
      ch === ','
    ) {
      structural += 1;
    }
  }
  return text.length > 0 ? structural / text.length : 0;
}

export function isJsonOnlyNoise(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;

  // Quick signature check: obvious Claude Code hook payloads (possibly truncated)
  // should be rejected without depending on JSON.parse succeeding.
  const markerHits = HOOK_PAYLOAD_MARKERS.filter((re) => re.test(trimmed)).length;
  if (markerHits >= 2) return true;

  // If JSON structural chars dominate (> 0.7), it's clearly a machine payload.
  if (jsonStructuralRatio(trimmed) > 0.7) return true;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false; // not valid JSON → fall through to normal capture
  }

  return !hasProseValue(parsed);
}

function hasProseValue(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (typeof value === 'string') {
    return value.length >= 50 && /\S\s\S+\s\S+/.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((v) => hasProseValue(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => hasProseValue(v, depth + 1));
  }
  return false;
}

/**
 * Detect low-value tool captures: pure file operations with no insight.
 * Returns true when the capture is just a tool name + file path with no meaningful prose.
 *
 * Rejects:
 * 1. Read-only tools (Read, Grep, Glob, NotebookRead) with < 150 chars of prose
 * 2. Pure file operation descriptions: "Tool Read. read /path/file.ts" with nothing else
 * 3. Log/JSON dumps (60%+ structural chars or JSON lines in output)
 * 4. Pure command invocations (npx, npm, git) with < 200 chars and no semantic output
 */
function isLowValueCapture(text: string): boolean {
  const trimmed = text.trim();

  // Read-only tools with minimal prose: "Tool Read. read file.ts" pattern
  const readOnlyMatch = trimmed.match(/^Tool\s+(Read|Grep|Glob|NotebookRead|Bash)\s*\./);
  if (readOnlyMatch && trimmed.length < 150) {
    return true;
  }

  // Pure file operation descriptions with no human insight
  // Pattern: "Tool X. [modified|read] /path/file" and nothing more
  if (/^Tool\s+\w+\.\s+(modified|read)\s+\S+\s*$/.test(trimmed)) {
    return true;
  }

  // Log/status dumps: mostly JSON lines
  const lines = trimmed.split('\n').filter(Boolean);
  if (lines.length > 3) {
    const jsonLines = lines.filter(
      (line) => line.trim().startsWith('{') || line.trim().startsWith('['),
    ).length;
    if (jsonLines / lines.length > 0.6) {
      return true;
    }
  }

  // Pure tool output with no human insight: "Tool Bash. git status" etc.
  if (
    /^Tool\s+(Bash|Read|Grep)\.\s+(npx|npm|node|tsx|vitest|git|curl|find|grep|ls)\s+\S+/.test(
      trimmed,
    ) &&
    trimmed.length < 200
  ) {
    return true;
  }

  return false;
}

export function shouldCapture(text: string): ValidationResult {
  const trimmed = text.trim();

  if (process.env.LAZYBRAIN_BENCH === '1') {
    return { ok: true, hash: contentHash(trimmed) };
  }

  if (trimmed.length < MIN_USEFUL_CHARS) {
    return { ok: false, reason: 'too_short' };
  }

  if (isRepetitive(trimmed)) {
    return { ok: false, reason: 'repetitive' };
  }

  if (isJsonOnlyNoise(trimmed)) {
    return { ok: false, reason: 'json_only_noise' };
  }

  if (isLowValueCapture(trimmed)) {
    return { ok: false, reason: 'low_value_tool' };
  }

  const hash = contentHash(trimmed);
  const entries = loadEntries();
  if (entries.some((e) => e.hash === hash)) {
    return { ok: false, reason: 'duplicate' };
  }

  return { ok: true, hash };
}

export function recordCapture(hash: string): void {
  const entries = loadEntries();
  const entry: HashEntry = { hash, ts: Date.now() };
  entries.push(entry);
  cachedEntries = entries;
  cachedAt = Date.now();
  try {
    persistEntry(entry, entries);
  } catch {
    // best-effort; capture should still succeed
  }
}

export function resetValidatorCacheForTests(): void {
  cachedEntries = null;
  cachedAt = 0;
}
