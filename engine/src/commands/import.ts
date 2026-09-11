/**
 * import command: batch-import conversation history from external sources.
 *
 * CONTRACT-G2:
 *   node lazybrain import --source <claude-code|cursor|chatgpt-export|claude-export|auto>
 *                         --input <path>  (required for file-based sources)
 *                         --brain <path>  (overrides LAZYBRAIN_BRAIN_PATH_CLI)
 *                         [--dry-run]
 *                         [--use-llm]
 *                         [--since <iso>]
 *                         [--limit <n>]
 *
 *   Prints JSON: { source, scanned, imported, skipped, estItems, estTokens, sampleTitles, backend }
 *
 * Deduplication: content-hash stored per note (see dedupStorePath below).
 * Re-running the same source is safe — already-imported conversations are
 * skipped by content hash, never re-written, so this command is idempotent.
 * Secret scrub: applied before writing (API keys, tokens, bearer headers, JWTs).
 * dry-run: counts + estimates only; NO writes, NO LLM.
 *
 * Vendored from LazyBrain (src/commands/import.ts) into the Lazy engine —
 * see engine/src/importers/ for the adapters. ONE deliberate behavior fix
 * over the LazyBrain original: `--use-llm` is now actually honored (the
 * original destructured `useLlm` from opts but never read it, so every
 * import silently used the heuristic annotator regardless of the flag).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { annotateSession } from '../annotator/heuristic.js';
import type { AnnotateOutput } from '../annotator/heuristic.js';
import { annotateWithLlm, resolveExtractorBackend } from '../annotator/llm.js';
import { ChatGptExportAdapter } from '../importers/adapter-chatgpt-export.js';
import { ClaudeCodeImportAdapter } from '../importers/adapter-claude-code.js';
import { ClaudeExportAdapter } from '../importers/adapter-claude-export.js';
import { CursorImportAdapter } from '../importers/adapter-cursor.js';
import type { ImportAdapter, ImportResult, ImportedConversation } from '../importers/types.js';
import { writeNote } from '../store/writer.js';
import { mapLimit, resolveConcurrencyEnv } from '../util/concurrency.js';
import { getConfig } from '../util/config.js';
import { estimateTokenCount } from '../util/tokenize.js';

export interface ImportOptions {
  source: string;
  input?: string;
  dryRun?: boolean;
  useLlm?: boolean;
  since?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Concurrency — how many conversations get annotated in parallel
// ---------------------------------------------------------------------------

const IMPORT_CONCURRENCY_DEFAULT = 5;
const IMPORT_CONCURRENCY_MIN = 1;
const IMPORT_CONCURRENCY_MAX = 12;

/**
 * Per-conversation annotation (--use-llm) is the slow step: each one is a
 * `claude` CLI child process taking ~10-60s (see util/claude-cli.ts). Running
 * these sequentially made a ~440-conversation import take ~2h. Each call is
 * an independent OS process with no shared state, so bounded concurrency is
 * safe from that side; the cap exists to stay conservative against the
 * user's own Claude Code CLI concurrency / rate limits, not because of any
 * correctness risk. Override with LAZYBRAIN_IMPORT_CONCURRENCY, clamped to
 * [1, 12].
 */
function resolveImportConcurrency(): number {
  return resolveConcurrencyEnv(
    process.env.LAZYBRAIN_IMPORT_CONCURRENCY,
    IMPORT_CONCURRENCY_DEFAULT,
    IMPORT_CONCURRENCY_MIN,
    IMPORT_CONCURRENCY_MAX,
  );
}

// ---------------------------------------------------------------------------
// Dedup store — persisted alongside the brain cache
// ---------------------------------------------------------------------------

/**
 * Dedup hashes live INSIDE the brain's own cache dir (config.cachePath),
 * never in a path manually reconstructed relative to the brain. A prior
 * version resolved this to join(brainRoot(), '..', '_cache', ...) — the
 * parent/sibling of the brain directory — which meant two different brain
 * directories sharing the same parent silently shared ONE dedup store and
 * could skip each other's imports. See util/config.ts for why cachePath is
 * always inside the brain (and one-way-safe against brain/_cache deletion).
 */
function dedupStorePath(): string {
  try {
    return join(getConfig().cachePath, '.import-hashes.json');
  } catch {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
    return join(home, '.lazybrain', '.import-hashes.json');
  }
}

function loadDedupHashes(): Set<string> {
  const path = dedupStorePath();
  if (!existsSync(path)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (Array.isArray(raw)) return new Set(raw as string[]);
  } catch {
    // corrupted — start fresh
  }
  return new Set();
}

function saveDedupHashes(hashes: Set<string>): void {
  try {
    const path = dedupStorePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([...hashes]), 'utf-8');
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

function buildAdapter(source: string, input?: string): ImportAdapter {
  switch (source) {
    case 'claude-code':
      return new ClaudeCodeImportAdapter();
    case 'cursor':
      return new CursorImportAdapter();
    case 'chatgpt-export':
      if (!input) throw new Error('--input <path> is required for chatgpt-export');
      return new ChatGptExportAdapter(input);
    case 'claude-export':
      if (!input) throw new Error('--input <path> is required for claude-export');
      return new ClaudeExportAdapter(input);
    default:
      throw new Error(
        `Unknown source "${source}". Use: claude-code|cursor|chatgpt-export|claude-export|auto`,
      );
  }
}

function buildAutoAdapters(input?: string): ImportAdapter[] {
  const adapters: ImportAdapter[] = [new ClaudeCodeImportAdapter(), new CursorImportAdapter()];

  if (input && existsSync(input)) {
    const peek = safeReadStart(input, 200);
    // Pick the most likely adapter based on schema clues
    if (peek.includes('chat_messages')) {
      adapters.push(new ClaudeExportAdapter(input));
    } else if (peek.includes('"mapping"') || peek.includes('"gizmo_id"')) {
      adapters.push(new ChatGptExportAdapter(input));
    } else {
      // Try both — dedup handles overlaps
      adapters.push(new ChatGptExportAdapter(input));
      adapters.push(new ClaudeExportAdapter(input));
    }
  }

  return adapters;
}

function safeReadStart(filePath: string, chars: number): string {
  try {
    return readFileSync(filePath, 'utf-8').slice(0, chars);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Note writing
// ---------------------------------------------------------------------------

async function conversationToNote(
  conv: ImportedConversation,
  useLlm: boolean,
): Promise<string | null> {
  try {
    const input = {
      sessionId: `import-${conv.contentHash.slice(0, 8)}`,
      text: conv.text.slice(0, 4000),
      timestamp: conv.timestamp,
      cwd: conv.cwd,
      filesModified: conv.filesModified,
      filesRead: conv.filesRead,
      agent: conv.source,
      sourceKind: 'history',
    };
    // useLlm: try LLM-augmented annotation first (annotateWithLlm falls back
    // to the heuristic result internally on any failure — never throws, so
    // this never blocks the import). Only spend the extra latency/cost when
    // the caller actually asked for it.
    const result: AnnotateOutput = useLlm ? await annotateWithLlm(input) : annotateSession(input);
    if (!result.html) return null;

    // Tag with the import source and content fingerprint
    return result.html
      .replace(/data-cerveau-source="[^"]*"/, `data-cerveau-source="${esc(conv.source)}"`)
      .replace(
        /(<article[^>]*)>/,
        `$1 data-cerveau-fingerprint="${conv.contentHash.slice(0, 16)}">`,
      );
  } catch {
    return null;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function runImport(opts: ImportOptions): Promise<ImportResult> {
  const { source, input, dryRun = false, useLlm = false, since, limit } = opts;

  const adapters = source === 'auto' ? buildAutoAdapters(input) : [buildAdapter(source, input)];

  const dedupHashes = loadDedupHashes();
  const newHashes = new Set<string>(dedupHashes);

  // Collect all conversations from all available adapters
  const allConvs: ImportedConversation[] = [];
  for (const adapter of adapters) {
    if (!adapter.isAvailable()) continue;
    const convs = adapter.list(since);
    allConvs.push(...convs);
  }

  // Apply per-run limit
  const candidates = limit != null ? allConvs.slice(0, limit) : allConvs;
  const scanned = candidates.length;

  // Token estimation (always computed, even in dry-run)
  const totalText = candidates.map((c) => c.text).join('');
  const estTokens = estimateTokenCount(totalText);

  let importedCount = 0;
  let skippedCount = 0;
  const sampleTitles: string[] = [];

  // Real (non-dry-run) LLM runs: report which backend will annotate the
  // notes so callers (Rust/UI) never have to guess whether --use-llm
  // silently degraded to heuristic-only. dry-run never calls the LLM, so
  // the backend is irrelevant there.
  const backend = !dryRun && useLlm ? resolveExtractorBackend() : undefined;

  // Pass 1 (cheap, synchronous, sequential): resolve every dedup hit and
  // every dry-run item instantly — neither spends an LLM call nor a write.
  // Filtering these out up front means the concurrent pass below only ever
  // spends a concurrency slot on a conversation that actually needs
  // annotating, and a dedup hit is still counted before any LLM cost would
  // have been spent on it, exactly as before.
  const needsWork: ImportedConversation[] = [];
  for (const conv of candidates) {
    if (dedupHashes.has(conv.contentHash)) {
      skippedCount++;
      continue;
    }
    if (dryRun) {
      importedCount++;
      if (sampleTitles.length < 5) sampleTitles.push(conv.title);
      continue;
    }
    needsWork.push(conv);
  }

  // Pass 2 (the slow part, bounded concurrency): annotate up to
  // resolveImportConcurrency() conversations at once — each is an
  // independent `claude` CLI child process (see util/claude-cli.ts), so
  // there is no shared state across the annotate calls themselves.
  //
  // Concurrency safety of the write/bookkeeping tail below: writeNote()
  // (store/writer.ts) is fully synchronous (existsSync/writeFileSync, no
  // internal await), and so are newHashes.add / the counters /
  // sampleTitles.push. Node never interleaves synchronous code — a call can
  // only be preempted at an `await` — so once a given conversation's
  // `await conversationToNote(...)` resolves, its write + bookkeeping tail
  // runs to completion atomically before any other in-flight conversation's
  // continuation can run. No explicit mutex/queue is needed; per-item writes
  // are already serialized by the JS event loop. mapLimit's chunking (see
  // util/concurrency.ts) additionally bounds how many conversations can be
  // "in flight, not yet written" at once to resolveImportConcurrency(),
  // instead of the whole import — a crash mid-run loses at most one
  // concurrency-window's worth of progress, not everything.
  await mapLimit(needsWork, resolveImportConcurrency(), async (conv) => {
    const html = await conversationToNote(conv, useLlm);
    if (!html) {
      skippedCount++;
      return;
    }

    try {
      writeNote(html, { overwrite: false });
      newHashes.add(conv.contentHash);
      importedCount++;
      if (sampleTitles.length < 5) sampleTitles.push(conv.title);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      // ConflictError = note already exists by id — dedup but count as skipped
      if (msg.includes('already exists')) {
        newHashes.add(conv.contentHash);
      }
      skippedCount++;
    }
  });

  if (!dryRun) {
    saveDedupHashes(newHashes);
  }

  return {
    source: adapters.map((a) => a.source).join('+'),
    scanned,
    imported: importedCount,
    skipped: skippedCount,
    estItems: scanned,
    estTokens,
    sampleTitles,
    ...(backend ? { backend } : {}),
  };
}
