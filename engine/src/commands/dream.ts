/**
 * Dream command: offline brain maintenance.
 *
 * Like the brain consolidating memories during sleep, this command runs offline to:
 *   1. Process ALL unread conversations via the ConversationSource registry
 *   2. Expand stub notes (quality='stub') using Haiku to generate proper summaries
 *   3. Generate missing TLDRs for notes without section[data-section="tldr"]
 *   4. Detect contradictions between decision notes with same tags
 *   5. Find potential duplicates via embedding similarity
 *
 * Idempotent by design: always returns a report even if no work was done.
 * Uses SHA-256 fingerprints to skip unchanged conversations (incremental processing).
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { annotateSession } from '../annotator/heuristic.js';
import { embed } from '../indexer/embeddings.js';
import { embedNotesForIndex, indexNote, listAll } from '../indexer/fts.js';
import type { IndexedNote } from '../indexer/note-types.js';
import { stripNote } from '../retrieval/strip.js';
import {
  countAlphanumericWords,
  isAgentMetaText,
  isBuildOutputNoise,
  isConfigurableNoise,
  isDominatedByRepetition,
  isMostlyPunctuation,
} from '../sources/noise.js';
import type { ConversationRef, ConversationSource } from '../sources/types.js';
import { brainRoot } from '../store/paths.js';
import { readNote } from '../store/reader.js';
import { writeNote } from '../store/writer.js';
import { callClaudeCliJsonArray, isClaudeCliAvailable } from '../util/claude-cli.js';
import { getConfig } from '../util/config.js';
import {
  type FingerprintStore,
  hasChanged,
  loadFingerprints,
  recordProcessed,
  saveFingerprints,
} from '../util/fingerprints.js';
import { getLogger } from '../util/logger.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';
import { healNoiseExemptNotes } from './repair.js';
import { runSynthesize } from './synthesize.js';

export { isAgentMetaText, isPlaceholderNoise } from '../sources/noise.js';

/**
 * Returns true when a stub note's id indicates it has no meaningful title —
 * the slug is dominated by a datetime prefix with a trailing 8-hex suffix and
 * ONLY numeric/temporal tokens in between (no alphabetic words).
 *
 * The slug format is: YYYY-MM-DD-<title-slug>-HHHHHHHH
 * A "datetime-only" title slugifies to digits and dashes (e.g. "2026-06-10t14-23"
 * or "14-23-00"). A real title always contains at least one alphabetic segment.
 *
 * Examples that match (no alphabetic tokens in middle):
 *   "2026-06-10-2026-06-10t14-23-a1b2c3d4"
 *   "2026-06-10-14-23-00-a1b2c3d4"
 *   "2026-06-10-a1b2c3d4"          ← date only, no title at all
 *
 * Examples that do NOT match (alphabetic tokens present):
 *   "2026-06-10-we-decided-to-use-supabase-for-auth-a1b2c3d4"
 *   "2026-06-10-fix-issue-123-error-in-auth-a1b2c3d4"
 *
 * Only relevant when the note is already classified as a stub (factCount <= 1).
 */
export function isStubDatetimeHexId(id: string): boolean {
  const lower = id.trim().toLowerCase();

  // Must start with YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}/.test(lower)) return false;

  // Must end with a dash + exactly 8 hex chars
  if (!/[0-9a-f]{8}$/.test(lower)) return false;

  // Strip the leading date (10 chars: YYYY-MM-DD) and trailing hex suffix (9 chars: -HHHHHHHH)
  const inner = lower.slice(10, lower.length - 9);

  // The inner part must contain NO alphabetic-only word segments.
  // A token is alphabetic-only when it matches /^[a-z]+$/ after splitting on dashes.
  // Numeric-only tokens ("14", "23", "00", "2026") are allowed (they are date/time parts).
  // Mixed alphanumeric tokens ("a1b2c3d4" stripped already) are not present in inner.
  const tokens = inner.split('-').filter((t) => t.length > 0);
  const hasAlphaWord = tokens.some((t) => /^[a-z]+$/i.test(t));
  return !hasAlphaWord;
}
export {
  decodeProjectPath,
  findConversationFiles,
  extractTextFromMessage,
  extractConversationSummary,
  makeConversationSessionId,
} from '../sources/claude-code.js';

export interface DreamOptions {
  dryRun?: boolean;
  maxNotes?: number;
  enrich?: boolean;
  pretty?: boolean;
  synthesizeOnly?: boolean;
  topic?: string;
  /** When true, ignore fingerprints and reprocess all conversations. */
  force?: boolean;
  /** Restrict ingestion to one source: 'claude-code' | 'vibe'. */
  agent?: string;
}

interface DreamReport {
  startedAt: string;
  duration_ms: number;
  conversationsProcessed: number;
  conversationsSkipped: number;
  /**
   * Notes wrongly invalidated by a past noise-cleanup bug, restored (healed)
   * THIS pass — see healNoiseExemptNotes (repair.ts) and runNoiseHealing
   * below. Idempotent: 0 once a brain has no more wrongly-invalidated notes.
   */
  healedNotes: number;
  /** Kept for backward compat with existing consumers (pretty report / dream.test.ts). */
  noiseCleanedUp: number;
  /**
   * Same count as noiseCleanedUp — notes the noise-cleanup phase invalidated
   * THIS pass. Exposed under an explicit name alongside healedNotes so the
   * maintenance summary never silently hides a destructive action behind an
   * ambiguous label (see runNoiseCleanup's doc comment for the incident this
   * guards against).
   */
  invalidatedNotes: number;
  stubsExpanded: number;
  tldrsGenerated: number;
  contradictionsFound: number;
  duplicatesMerged: number;
}

interface TldrOutput {
  tldr: string;
  topic?: string;
}

interface DuplicatePair {
  id1: string;
  id2: string;
  similarity: number;
}

// Legacy tracking file path — kept only for one-time migration during first fingerprint run
function legacyTrackingFilePath(): string {
  try {
    const root = brainRoot();
    const cacheDir = join(root, '..', '_cache');
    return join(cacheDir, 'dream-processed.json');
  } catch {
    return join(
      process.env.USERPROFILE ?? process.env.HOME ?? '.',
      '.lazybrain-dream-processed.json',
    );
  }
}

/**
 * Migrate legacy dream-processed.json (Set<string>) into the fingerprint store.
 * This is a one-shot migration: after the first fingerprint-enabled run the legacy
 * file is irrelevant but is left in place to avoid breaking older LazyBrain versions.
 */
function migrateLegacyTrackedFiles(store: FingerprintStore): FingerprintStore {
  const legacyPath = legacyTrackingFilePath();
  if (!existsSync(legacyPath)) return store;

  let legacyPaths: string[] = [];
  try {
    const data = JSON.parse(readFileSync(legacyPath, 'utf-8')) as unknown;
    if (Array.isArray(data)) legacyPaths = data as string[];
  } catch {
    return store;
  }

  // Import each legacy path as a fingerprint with an unknown hash so hasChanged
  // will trigger a slow-path hash check on the next run and only skip files that
  // have not changed since they were last seen.
  let migrated = store;
  for (const fp of legacyPaths) {
    if (migrated.files[fp]) continue; // already fingerprinted
    if (!existsSync(fp)) continue;
    try {
      const s = statSync(fp);
      // Store a placeholder with an empty hash so the slow path always re-hashes
      // on the very next run, but at least the fast path recognises the file.
      migrated = {
        ...migrated,
        files: {
          ...migrated.files,
          [fp]: {
            filePath: fp,
            contentHash: '', // empty → slow path will rehash
            mtimeMs: s.mtimeMs,
            size: s.size,
            processedAt: new Date().toISOString(),
            notesCreated: [],
          },
        },
      };
    } catch {
      // Skip unreadable files
    }
  }
  return migrated;
}

/**
 * Show progress bar on stderr (not stdout).
 * Format: [████████░░░░░░░░░░] 40% [4/10] label text
 */
function showProgress(current: number, total: number, label: string): void {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const barLen = 20;
  const filled = Math.floor(pct / (100 / barLen));
  const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
  const labelStr = label.slice(0, 40).padEnd(40);
  process.stderr.write(
    `\r  ${bar} ${pct.toString().padStart(3)}% [${current}/${total}] ${labelStr}`,
  );
}

/**
 * Clear the progress bar line from stderr.
 */
function clearProgress(): void {
  process.stderr.write(`\r${' '.repeat(80)}\r`);
}

// ---------------------------------------------------------------------------
// Ingestion memory budget
//
// Real Claude Code session transcripts (especially long subagent runs)
// routinely reach 15-60 MB on disk. The historic fixed
// `DREAM_CONCURRENCY = 12` combined with an unbounded per-file read
// (see readConversationContentBounded in sources/claude-code.ts, which now
// caps that side too) meant a single ingestion batch could hold hundreds of
// MB to multiple GB of raw JSONL in memory at once — measured live at
// 3+ GB RSS with a full CPU core pegged for the duration. The helpers below
// make concurrency adaptive (shrinks as free memory drops) and add a hard
// back-off + early-exit under genuinely critical pressure, so dream degrades
// gracefully on a loaded machine instead of always assuming the same
// headroom is available.
// ---------------------------------------------------------------------------

/** Default concurrent conversation reads per batch (the historic constant). */
const DEFAULT_INGESTION_CONCURRENCY = 12;
/** Concurrency never drops below this, even under sustained pressure. */
const MIN_INGESTION_CONCURRENCY = 2;

/**
 * Free-RAM floor (MB) below which ingestion concurrency is throttled.
 * Deliberately matches the Lazy app's own "High" pressure RAM threshold
 * (src-tauri/src/commands/system_pressure.rs HIGH_RAM_THRESHOLD_MB) so a
 * dream run launched by the app — or directly from the CLI/cron with no app
 * running at all — degrades using the same definition of "the machine is
 * under pressure", without requiring an IPC channel between the two
 * processes (there is none today; this constant is the coordination point).
 */
const LOW_MEMORY_THRESHOLD_MB = 1500;

/** Free-RAM floor (MB) below which ingestion pauses entirely instead of
 * merely slowing down — genuinely critical pressure, not just "elevated". */
const CRITICAL_MEMORY_THRESHOLD_MB = 700;

/** How many times to back off (sleep + recheck) under critical pressure
 * before giving up on the rest of THIS run and checkpointing early. */
const CRITICAL_BACKOFF_MAX_RETRIES = 5;

function backoffSleepMs(): number {
  const override = Number(process.env.LAZYBRAIN_TEST_BACKOFF_MS);
  return Number.isFinite(override) && override >= 0 ? override : 2000;
}

/** Free system memory in MB. Test-overridable via LAZYBRAIN_TEST_FREE_MB so
 * the adaptive-concurrency and back-off logic is unit-testable without
 * actually starving the test machine of RAM. */
export function availableMemoryMb(): number {
  const override = Number(process.env.LAZYBRAIN_TEST_FREE_MB);
  if (Number.isFinite(override) && override > 0) return override;
  return freemem() / (1024 * 1024);
}

/**
 * Resolve how many conversation files to read concurrently for the NEXT
 * batch, given CURRENT free system memory. Re-evaluated before every batch
 * (not just once at startup) so a machine that tightens up mid-run is
 * throttled without needing to restart the whole ingestion phase.
 */
export function resolveIngestionConcurrency(): number {
  const override = Number(process.env.LAZYBRAIN_DREAM_CONCURRENCY);
  const baseline =
    Number.isFinite(override) && override > 0 ? override : DEFAULT_INGESTION_CONCURRENCY;
  return availableMemoryMb() < LOW_MEMORY_THRESHOLD_MB
    ? Math.max(MIN_INGESTION_CONCURRENCY, Math.floor(baseline / 4))
    : baseline;
}

/**
 * Back off (sleep, bounded retries) while free memory is below the critical
 * floor. Returns true once memory recovers (safe to proceed), or false when
 * it is STILL critical after CRITICAL_BACKOFF_MAX_RETRIES — callers must
 * treat false as "stop and checkpoint now", never spin forever.
 */
async function waitForCriticalMemoryToClear(): Promise<boolean> {
  for (let attempt = 0; attempt < CRITICAL_BACKOFF_MAX_RETRIES; attempt++) {
    if (availableMemoryMb() >= CRITICAL_MEMORY_THRESHOLD_MB) return true;
    await new Promise((resolve) => setTimeout(resolve, backoffSleepMs()));
  }
  return availableMemoryMb() >= CRITICAL_MEMORY_THRESHOLD_MB;
}

interface BatchIngestionResult {
  store: FingerprintStore;
  createdDelta: number;
  /** Freshly-indexed notes from this batch, for the caller to batch-embed. */
  indexedNotes: IndexedNote[];
}

/**
 * Process one concurrent batch of conversation files: read, annotate, filter
 * noise, write notes, and fold each file's outcome into the fingerprint
 * store. Extracted from processUnreadConversations so the adaptive batching
 * loop stays readable.
 *
 * Bug fix (2026-08): this used to call writeNote() only — the note's HTML
 * landed on disk but indexNote() was never called for it, so every
 * dream-ingested note (data-cerveau-source="session:dream-*") was invisible
 * to L2/FTS and L3/embeddings until some unrelated `lazybrain index-rebuild`
 * happened to sweep it up later. See reindex-missing.ts's doc comment and
 * the root-cause writeup for the audit that found this. indexNote() is
 * called synchronously right after writeNote(), inside the SAME per-file try
 * block that already checkpoints the fingerprint store immediately (not just
 * at the end of the whole phase) — so an interrupted run (crash/kill/OOM,
 * the documented hazard on this machine) leaves every note that was written
 * ALSO indexed, never a silent orphan.
 */
async function processConversationBatch(
  source: ConversationSource,
  batch: ConversationRef[],
  store: FingerprintStore,
  log: ReturnType<typeof getLogger>,
): Promise<BatchIngestionResult> {
  const results = await Promise.all(
    batch.map(async (ref) => {
      const noteIds: string[] = [];
      const indexedNotes: IndexedNote[] = [];
      try {
        const payloads = await source.readConversation(ref);
        for (const p of payloads) {
          if (!p.text || p.text.length <= 50) continue;
          const result = annotateSession({
            sessionId: p.sessionId,
            text: p.text.slice(0, 4000),
            timestamp: p.timestamp,
            cwd: p.cwd || undefined,
            filesModified: p.filesModified.length > 0 ? p.filesModified : undefined,
            filesRead: p.filesRead.length > 0 ? p.filesRead : undefined,
            agent: p.agent,
            sourceKind: p.sourceKind,
            sessionParent: p.sessionParent,
            gitCommit: p.gitCommit,
            gitBranch: p.gitBranch,
          });
          // Keep any chunk that produced a non-trivial note (html present and
          // the stripped text passes the noise filter). The factCount > 0 guard
          // was too strict — it silently dropped substantive chunks where the
          // heuristic extractor found 0 named facts but the text is still valuable.
          // The Phase-0.5 noise cleanup pass (detectNoise) handles junk afterwards.
          //
          // Additionally, skip stub notes (factCount <= 1) whose id is dominated
          // by a datetime prefix + hex suffix — these have no meaningful title and
          // carry no semantic content worth storing.
          if (!result.html) continue;
          if (detectNoise(result.html.slice(0, 500))) continue;
          if (result.factCount <= 1 && isStubDatetimeHexId(result.id)) continue;
          const written = writeNote(result.html);
          noteIds.push(result.id);
          try {
            indexedNotes.push(indexNote(readNote(written.path)));
          } catch (err) {
            log.warn(
              { path: written.path, err: (err as Error).message },
              'dream: conversation note reindex failed',
            );
          }
        }
      } catch (err) {
        log.warn(
          { file: ref.path, err: (err as Error).message },
          'dream: conversation processing failed',
        );
      }
      return { filePath: ref.path, noteIds, indexedNotes };
    }),
  );

  let nextStore = store;
  let createdDelta = 0;
  const indexedNotes: IndexedNote[] = [];
  for (const result of results) {
    nextStore = recordProcessed(result.filePath, result.noteIds, nextStore);
    if (result.noteIds.length > 0) createdDelta++;
    indexedNotes.push(...result.indexedNotes);
  }
  return { store: nextStore, createdDelta, indexedNotes };
}

/** Best-effort incremental fingerprint checkpoint — logs and continues on
 * failure rather than losing an otherwise-completed batch's progress. */
function checkpointFingerprints(store: FingerprintStore, log: ReturnType<typeof getLogger>): void {
  try {
    saveFingerprints(store);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'dream: incremental fingerprint checkpoint failed');
  }
}

async function processUnreadConversations(
  opts: DreamOptions,
): Promise<{ created: number; skipped: number }> {
  const log = getLogger();
  const { getSources } = await import('../sources/registry.js');
  const sources = getSources(opts.agent);

  let store: FingerprintStore = opts.force
    ? { version: '1.0.0', generatedAt: new Date().toISOString(), files: {} }
    : loadFingerprints();
  if (!opts.force) store = migrateLegacyTrackedFiles(store);

  let created = 0;
  let skippedTotal = 0;

  for (const source of sources) {
    let refs: ConversationRef[];
    try {
      refs = source.listConversations();
    } catch (err) {
      log.warn({ agent: source.agent, err: (err as Error).message }, 'dream: source scan failed');
      continue;
    }
    if (refs.length === 0) continue;

    const changedUnsorted = opts.force ? refs : refs.filter((r) => hasChanged(r.path, store));
    skippedTotal += refs.length - changedUnsorted.length;
    const changed = [...changedUnsorted].sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (opts.pretty) {
      process.stderr.write(
        `\n  [${source.agent}] ${refs.length} conversations: ${changed.length} new/changed, ${refs.length - changed.length} unchanged (skipped)\n\n`,
      );
    }

    if (opts.dryRun) {
      for (const ref of changed) {
        store = recordProcessed(ref.path, [], store);
        created++;
      }
      continue;
    }

    let progressCount = 0;
    let batchStart = 0;

    while (batchStart < changed.length) {
      if (availableMemoryMb() < CRITICAL_MEMORY_THRESHOLD_MB) {
        const recovered = await waitForCriticalMemoryToClear();
        if (!recovered) {
          log.warn(
            {
              source: source.agent,
              processed: progressCount,
              remaining: changed.length - progressCount,
            },
            'dream: ingestion paused — free memory still critical after backoff; ' +
              'checkpointed progress so far, deferring the rest to the next run',
          );
          break;
        }
      }

      const concurrency = resolveIngestionConcurrency();
      const batch = changed.slice(batchStart, batchStart + concurrency);
      batchStart += concurrency;

      const batchResult = await processConversationBatch(source, batch, store, log);
      store = batchResult.store;
      created += batchResult.createdDelta;

      // Batch-embed this batch's freshly-indexed notes now, not accumulated
      // across the whole phase — bounded memory (embed() further chunks
      // internally to EMBED_BATCH_SIZE=8, see embeddings.ts) and consistent
      // with graph.ts's code-scan pass, which embeds per batch for the same
      // reason.
      if (batchResult.indexedNotes.length > 0) {
        await embedNotesForIndex(batchResult.indexedNotes);
      }

      // Checkpoint immediately, not just once at the very end of the whole
      // phase — an interrupted run (kill, crash, or the critical-pressure
      // give-up above) resumes from here on the next `dream` invocation
      // instead of reprocessing everything already done in this run.
      if (!opts.dryRun) checkpointFingerprints(store, log);

      progressCount += batch.length;
      if (opts.pretty) {
        showProgress(progressCount, changed.length, source.agent);
      }
    }
    if (opts.pretty) clearProgress();
  }

  if (!opts.dryRun) checkpointFingerprints(store, log);

  return { created, skipped: skippedTotal };
}

/**
 * Extract text from HTML for processing.
 */
function extractText(html: string): string {
  try {
    return stripNote(html).text;
  } catch {
    return '';
  }
}

/**
 * Check if a note has a TLDR section.
 */
function hasTldr(html: string): boolean {
  return html.includes('data-section="tldr"') || html.includes('data-cerveau-tldr');
}

/**
 * Inject a TLDR section into HTML.
 */
function injectTldr(html: string, tldr: string): string {
  const { document } = parseHTML(`<!doctype html><body>${html}</body>`);
  const article = document.querySelector('article');
  if (!article) return html;

  // Create a TLDR section
  const tldrSection = document.createElement('section');
  tldrSection.setAttribute('data-section', 'tldr');
  const p = document.createElement('p');
  p.textContent = tldr;
  tldrSection.appendChild(p);

  // Insert after the first heading
  const firstHeading = article.querySelector('h1, h2, h3');
  if (firstHeading?.nextSibling) {
    firstHeading.nextSibling.parentElement?.insertBefore(tldrSection, firstHeading.nextSibling);
  } else {
    article.appendChild(tldrSection);
  }

  return article.outerHTML;
}

/**
 * Detect noise patterns in note text.
 * Returns true if the note appears to be low-quality noise.
 *
 * Defence-in-depth: also calls isConfigurableNoise (demo-fixture + user ignore
 * patterns) and isBuildOutputNoise (CI/build exit-code dumps) so notes are
 * protected by the same gates that guard chunks.
 */
export function detectNoise(text: string): boolean {
  const trimmed = text.trim();

  // Too short to be useful
  if (trimmed.length < 60) return true;

  // Demo-fixture content and user-configurable ignore patterns
  if (isConfigurableNoise(trimmed)) return true;

  // CI/build output fragments (exit-code dumps, numbered step lists)
  if (isBuildOutputNoise(trimmed)) return true;

  // Delegate to isAgentMetaText for all known boilerplate signatures
  // (scheduled-task wrappers, rate-limit residue, memory-agent meta, etc.)
  if (isAgentMetaText(trimmed)) return true;

  // Meaningful-content check: require at least 8 real alphanumeric words.
  // Catches garbage like `",.` or title/tldr that is essentially punctuation.
  if (countAlphanumericWords(trimmed) < 8) return true;

  // Mostly-punctuation / symbol check.
  // Catches content like `",.` or fragments that are all commas, dots, and brackets.
  if (isMostlyPunctuation(trimmed)) return true;

  // Pure JSON/log dumps
  const lines = trimmed.split('\n').filter(Boolean);
  const jsonLines = lines.filter(
    (l) => l.trim().startsWith('{') || l.trim().startsWith('['),
  ).length;
  if (lines.length > 2 && jsonLines / lines.length > 0.5) return true;

  // Pure tool output with session metadata
  if (trimmed.includes('session_id') && trimmed.includes('transcript_path')) return true;
  if (trimmed.includes('tool_name') && trimmed.includes('tool_input')) return true;

  // Pure file path dumps
  if (/^(Edit|Write|Read|Grep|Glob|Bash):?\s+\S+\s*$/m.test(trimmed) && trimmed.length < 200)
    return true;

  // Command output with no insight
  if (/^(npx|npm|node|tsx|vitest|git)\s/m.test(trimmed) && trimmed.length < 150) return true;

  // Repetitive content (same phrase repeated across lines)
  const uniqueLines = new Set(lines.map((l) => l.trim().slice(0, 50)));
  if (lines.length > 5 && uniqueLines.size < lines.length * 0.3) return true;

  // Boilerplate-dominated: single repeated block fills > 60% of the text
  if (isDominatedByRepetition(trimmed)) return true;

  // Trivial one-shot imperative with no follow-up substance:
  // e.g. "create a file called /tmp/lazybrain-test.txt with the text 'hello world' inside"
  // These appear as the ENTIRE content and contain no real insight.
  // Heuristic: single line (or very short multi-line), imperative verb at start, < 25 words total.
  if (
    lines.length <= 2 &&
    countAlphanumericWords(trimmed) < 25 &&
    /^(create|make|write|add|delete|remove|run|execute|open|close|touch|copy|move|rename|set|get|fetch|install|update|upgrade|build|start|stop|restart|deploy|send|push|pull|list|show|print|echo|cat|ls|mkdir|rm|cp|mv)\s+/i.test(
      trimmed,
    )
  )
    return true;

  return false;
}

// ---------------------------------------------------------------------------
// Phase helpers — each stays well under the 50-line function limit
// ---------------------------------------------------------------------------

type NoteEntry = ReturnType<typeof listAll>[number];

/**
 * Handle synthesize-only shortcut and return a completed report.
 * Returns `null` when the shortcut was NOT taken (normal flow continues).
 */
async function runSynthesizeOnlyShortcut(
  opts: DreamOptions,
  report: DreamReport,
  start: number,
): Promise<DreamReport | null> {
  if (!opts.synthesizeOnly) return null;

  const log = getLogger();
  log.info({ topic: opts.topic }, 'dream: synthesize-only mode');
  const synthReport = await runSynthesize({ dryRun: opts.dryRun, topic: opts.topic });
  log.info(
    { synthesized: synthReport.synthesized.length, skipped: synthReport.skipped.length },
    'dream: synthesize done',
  );
  if (synthReport.errors.length > 0) {
    log.warn({ errors: synthReport.errors }, 'dream: synthesize errors');
  }
  return { ...report, duration_ms: Date.now() - start };
}

/**
 * Phase 0: Ingest all unread conversations and update the report in-place.
 */
async function runConversationIngestion(
  opts: DreamOptions,
  report: DreamReport,
): Promise<DreamReport> {
  const { created, skipped } = await processUnreadConversations(opts);
  return { ...report, conversationsProcessed: created, conversationsSkipped: skipped };
}

/**
 * Tags that mark a note as structured provenance (written by an agent
 * mission, a skill capture, or otherwise machine-attributed) rather than
 * free-form prose. These notes carry their own truth value regardless of
 * length or wording — a sparse mission-kickoff note ("Modele: ... Worktree:
 * ...") looks exactly like the short, low-signal fragments detectNoise()
 * exists to catch, but it is real signal, not noise, and must never be
 * silently invalidated by this pass. detectNoise() itself stays tag-agnostic
 * (it only ever sees stripped text, see its call sites), so the exemption is
 * enforced here, at the one call site that has the note's tags available.
 */
const NOISE_EXEMPT_TAGS = ['mission', 'agent', 'skill'];

/** True when `tags` (the notes.tags space-separated column) contains any of
 *  NOISE_EXEMPT_TAGS. Exported for tests. */
export function hasNoiseExemptTag(tags: string | null | undefined): boolean {
  if (!tags) return false;
  const set = new Set(tags.split(/\s+/).filter(Boolean));
  return NOISE_EXEMPT_TAGS.some((t) => set.has(t));
}

/**
 * Phase 0.5 incremental checkpoint — bump when detectNoise / the meta-text /
 * placeholder rules change, so a rules update re-scans the full corpus once
 * instead of letting notes screened under old rules stay noise forever.
 */
const NOISE_RULES_VERSION = 1;

export interface NoiseCleanupState {
  lastRunMs: number;
  rulesVersion: number;
}

function noiseStatePath(): string {
  return join(getConfig().cachePath, 'dream-noise-state.json');
}

/**
 * Which notes Phase 0.5 must inspect this pass. A rules-version mismatch
 * (or missing checkpoint) scans the whole corpus; otherwise only notes
 * written since the last completed pass. Notes with no recorded mtime are
 * always included — a note we cannot date is a note we cannot skip.
 */
export function selectNoiseCleanupCandidates(
  notes: NoteEntry[],
  state: NoiseCleanupState,
): NoteEntry[] {
  if (state.rulesVersion !== NOISE_RULES_VERSION) return notes;
  return notes.filter((n) => !n.mtime_ms || n.mtime_ms > state.lastRunMs);
}

export function loadNoiseState(): NoiseCleanupState {
  try {
    const parsed = JSON.parse(readFileSync(noiseStatePath(), 'utf8')) as Partial<NoiseCleanupState>;
    return {
      lastRunMs: typeof parsed.lastRunMs === 'number' ? parsed.lastRunMs : 0,
      rulesVersion: typeof parsed.rulesVersion === 'number' ? parsed.rulesVersion : 0,
    };
  } catch {
    return { lastRunMs: 0, rulesVersion: 0 };
  }
}

export function saveNoiseState(state: NoiseCleanupState): void {
  try {
    writeFileSync(noiseStatePath(), JSON.stringify(state), 'utf8');
  } catch {
    // best-effort — worst case the next run's delta is wider than necessary
  }
}

/**
 * Phase 0.5: Invalidate low-quality (noise) notes. Returns number cleaned.
 *
 * Incremental by default: notes are scanned only when their file mtime is
 * newer than the last completed pass — a full-corpus readNote()+stripNote()
 * per dream run measured ~19s for 5k files even before the per-note work,
 * one of the passes that push dream past its 600s maintenance ceiling on a
 * mature brain. A rules-version bump or a missing state file falls back to
 * a full scan so rule changes still reach old notes. Notes with no recorded
 * mtime are always scanned (never silently skipped).
 */
async function runNoiseCleanup(opts: DreamOptions): Promise<number> {
  const log = getLogger();
  const runStartedMs = Date.now();
  const refreshedNotes = listAll({ includeExpired: false });
  const state = loadNoiseState();
  const candidates = selectNoiseCleanupCandidates(refreshedNotes, state);
  if (candidates.length < refreshedNotes.length) {
    log.debug(
      { scanned: candidates.length, total: refreshedNotes.length },
      'dream: noise cleanup scanning only notes changed since last pass',
    );
  }
  let noiseCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    const n = candidates[i];
    if (opts.pretty && i % 50 === 0) showProgress(i, candidates.length, 'Checking note quality');

    try {
      const note = readNote(n.path);
      const text = stripNote(note.html).text;
      if ((n.importance ?? 0) >= 0.7 || n.type === 'decision') continue;
      if (hasNoiseExemptTag(n.tags)) continue;
      if (!detectNoise(text)) continue;

      if (!opts.dryRun) {
        const invalidated = note.html.replace(
          /data-cerveau-tier="working"/,
          `data-cerveau-tier="working" data-cerveau-valid-until="${nowIso()}" data-cerveau-invalidated-by="dream-noise-cleanup"`,
        );
        writeFileSync(n.path, invalidated, 'utf-8');
      }
      noiseCount++;
    } catch {
      log.debug('dream: skipping unreadable note during noise cleanup');
    }
  }

  // Checkpoint uses the run's START time so notes written mid-pass (by a
  // concurrent capture, or by this loop's own invalidation write before its
  // mtime lands) are still re-scanned on the next pass. Dry-run does not
  // advance the checkpoint — a preview must not narrow the next real pass.
  if (!opts.dryRun) {
    saveNoiseState({ lastRunMs: runStartedMs, rulesVersion: NOISE_RULES_VERSION });
  }

  if (noiseCount > 0) {
    log.info({ invalidatedNotes: noiseCount }, 'dream: invalidated noise notes this pass');
  }
  if (opts.pretty) {
    clearProgress();
    if (noiseCount > 0) process.stderr.write(`  Cleaned ${noiseCount} noise notes\n`);
  }
  return noiseCount;
}

/**
 * Expand a single stub note. Returns true on success, false on failure.
 */
async function expandOneStub(stub: NoteEntry, opts: DreamOptions): Promise<boolean> {
  const log = getLogger();
  const note = readNote(stub.path);
  const text = extractText(note.html);
  if (text.length < 50) return false;

  const result = await callClaudeCliJsonArray<TldrOutput>(
    `Summarize this note in one sentence (tldr) and infer a topic path (e.g. "project/feature/module"):\n\n${text.slice(0, 2000)}`,
    {
      system:
        'Output a JSON array with one object: {"tldr": "one sentence summary", "topic": "hierarchical/topic/path"}. No prose.',
      model: 'haiku',
      timeoutMs: 15000,
    },
  );
  if (!result?.[0]?.tldr) return false;

  const updated = injectTldr(note.html, result[0].tldr);
  if (!opts.dryRun) writeFileSync(stub.path, updated, 'utf8');
  log.debug({ id: stub.id, tldr: result[0].tldr }, 'dream: stub expanded');
  return true;
}

/**
 * Phase 1: Expand stub notes using Haiku. Returns number expanded.
 */
async function runStubExpansion(
  opts: DreamOptions,
  allNotes: NoteEntry[],
  isCliAvailable: boolean,
): Promise<number> {
  const log = getLogger();
  const stubs = allNotes.filter((n) => n.quality === 'stub').slice(0, opts.maxNotes ?? 20);
  if (stubs.length === 0) return 0;

  if (opts.pretty) process.stderr.write(`\n  Expanding ${stubs.length} stubs\n\n`);
  log.info({ count: stubs.length }, 'dream: processing stubs');

  const CIRCUIT_BREAKER = 3;
  let consecutiveFailures = 0;
  let expanded = 0;

  for (let i = 0; i < stubs.length; i++) {
    if (consecutiveFailures >= CIRCUIT_BREAKER) {
      log.warn(
        { failures: consecutiveFailures },
        'dream: enrichment unavailable, skipping stub expansion phase',
      );
      if (opts.pretty) {
        process.stderr.write(
          `\n  Warning: enrichment unavailable after ${consecutiveFailures} consecutive failures, skipping stub expansion.\n`,
        );
      }
      break;
    }
    if (opts.pretty) showProgress(i + 1, stubs.length, 'Stub expansion');

    try {
      if (isCliAvailable && !opts.dryRun) {
        const ok = await expandOneStub(stubs[i], opts);
        if (ok) {
          expanded++;
          consecutiveFailures = 0;
        } else consecutiveFailures++;
      }
    } catch (err) {
      consecutiveFailures++;
      log.warn({ id: stubs[i].id, err: (err as Error).message }, 'dream: stub expansion failed');
    }
  }

  if (opts.pretty) clearProgress();
  return expanded;
}

/**
 * Determine enrichment intent and log user-facing hints. Returns the resolved flag.
 */
function resolveEnrichFlag(opts: DreamOptions, noTldrCount: number): boolean {
  if (opts.enrich) return true;
  if (noTldrCount > 0 && noTldrCount <= 200) {
    if (opts.pretty) {
      process.stderr.write(
        `\n  Auto-enriching ${noTldrCount} notes with Haiku (~$${(noTldrCount * 0.00025).toFixed(2)})\n\n`,
      );
    }
    return true;
  }
  if (noTldrCount > 200 && opts.pretty) {
    process.stderr.write(
      `\n  ${noTldrCount} notes need TLDRs. Run with --enrich to process (~$${(noTldrCount * 0.00025).toFixed(2)})\n`,
    );
  }
  return false;
}

/**
 * Generate a TLDR for one note. Returns true on success, false otherwise.
 */
async function generateOneTldr(note: NoteEntry, opts: DreamOptions): Promise<boolean> {
  const log = getLogger();
  const content = readNote(note.path);
  const text = extractText(content.html);
  if (text.length < 50) return false;

  const result = await callClaudeCliJsonArray<TldrOutput>(
    `Create a one-sentence TLDR for this note:\n\n${text.slice(0, 1500)}`,
    {
      system: 'Output a JSON array with one object: {"tldr": "one sentence summary"}. No prose.',
      model: 'haiku',
      timeoutMs: 15000,
    },
  );
  if (!result?.[0]?.tldr) return false;
  if (!opts.dryRun) {
    const updated = injectTldr(content.html, result[0].tldr);
    writeFileSync(note.path, updated, 'utf8');
  }
  log.debug({ id: note.id }, 'dream: TLDR generated');
  return true;
}

/**
 * Phase 2: Generate missing TLDRs. Returns number generated.
 */
async function runTldrGeneration(
  opts: DreamOptions,
  allNotes: NoteEntry[],
  isCliAvailable: boolean,
): Promise<number> {
  const log = getLogger();
  const noTldr = allNotes.filter((n) => {
    try {
      return !hasTldr(readNote(n.path).html);
    } catch {
      return false;
    }
  });

  const shouldEnrich = resolveEnrichFlag(opts, noTldr.length);
  if (!shouldEnrich || !isCliAvailable) return 0;

  const toProcess = noTldr.slice(0, opts.maxNotes ?? 200);
  log.info({ count: toProcess.length }, 'dream: generating missing TLDRs');

  const CIRCUIT_BREAKER = 3;
  let consecutiveFailures = 0;
  let generated = 0;

  for (let i = 0; i < toProcess.length; i++) {
    if (consecutiveFailures >= CIRCUIT_BREAKER) {
      log.warn(
        { failures: consecutiveFailures },
        'dream: enrichment unavailable, skipping TLDR generation phase',
      );
      if (opts.pretty) {
        process.stderr.write(
          `\n  Warning: enrichment unavailable after ${consecutiveFailures} consecutive failures, skipping TLDR generation.\n`,
        );
      }
      break;
    }
    if (opts.pretty) showProgress(i + 1, toProcess.length, 'Enriching with Haiku');

    try {
      const ok = await generateOneTldr(toProcess[i], opts);
      if (ok) {
        generated++;
        consecutiveFailures = 0;
      } else consecutiveFailures++;
    } catch (err) {
      consecutiveFailures++;
      log.warn(
        { id: toProcess[i].id, err: (err as Error).message },
        'dream: TLDR generation failed',
      );
    }
  }

  if (opts.pretty) clearProgress();
  return generated;
}

/**
 * Phase 3: Detect contradictions in decision notes. Returns contradiction count.
 */
function runContradictionDetection(allNotes: NoteEntry[], maxNotes: number): number {
  const log = getLogger();
  const decisions = allNotes
    .filter((n) => n.type === 'decision' && !n.valid_until)
    .slice(0, maxNotes);

  if (decisions.length <= 1) return 0;

  const tagGroups = new Map<string, typeof decisions>();
  for (const d of decisions) {
    const tags = (d.tags ?? '').split(/\s+/).filter(Boolean);
    for (const tag of tags) {
      const group = tagGroups.get(tag) ?? [];
      tagGroups.set(tag, [...group, d]);
    }
  }

  let found = 0;
  for (const [tag, group] of tagGroups) {
    if (group.length > 1) {
      found++;
      log.info({ tag, count: group.length }, 'dream: potential contradiction in decisions');
    }
  }
  return found;
}

/**
 * Collect embeddings for a set of candidate notes.
 * Returns parallel arrays: ids and their Float32Array embeddings.
 */
async function collectEmbeddings(
  candidates: NoteEntry[],
): Promise<{ ids: string[]; vectors: Float32Array[] }> {
  const textsToEmbed: string[] = [];
  const ids: string[] = [];

  for (const candidate of candidates) {
    try {
      const content = readNote(candidate.path);
      const text = extractText(content.html);
      if (text.length >= 100) {
        textsToEmbed.push(text.slice(0, 1000));
        ids.push(candidate.id);
      }
    } catch {
      /* skip */
    }
  }

  if (textsToEmbed.length <= 1) return { ids: [], vectors: [] };

  const embeds = await embed(textsToEmbed);
  if (!embeds || embeds.length === 0) return { ids: [], vectors: [] };

  return { ids, vectors: embeds };
}

/**
 * Phase 4: Find potential duplicates via embedding similarity. Returns count.
 */
async function runDuplicateDetection(allNotes: NoteEntry[], maxNotes: number): Promise<number> {
  const log = getLogger();
  if (allNotes.length <= 1) return 0;

  try {
    const candidates = allNotes.slice(0, Math.min(maxNotes * 2, allNotes.length));
    const { ids, vectors } = await collectEmbeddings(candidates);
    if (ids.length <= 1) return 0;

    const duplicates: DuplicatePair[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const sim = cosineSimilarity(vectors[i], vectors[j]);
        if (sim > 0.85) duplicates.push({ id1: ids[i], id2: ids[j], similarity: sim });
      }
    }

    if (duplicates.length > 0) {
      log.info({ count: duplicates.length }, 'dream: found potential duplicates');
    }
    return duplicates.length;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'dream: duplicate detection failed');
    return 0;
  }
}

/**
 * Phase 5: Run synthesize pass. Logs and prints progress.
 */
async function runSynthesizePhase(opts: DreamOptions): Promise<void> {
  const log = getLogger();
  log.info('dream: phase 5 — synthesize wiki pages');
  try {
    const synthReport = await runSynthesize({ dryRun: opts.dryRun });
    log.info(
      { synthesized: synthReport.synthesized.length, skipped: synthReport.skipped.length },
      'dream: synthesize done',
    );
    if (synthReport.errors.length > 0)
      log.warn({ errors: synthReport.errors }, 'dream: synthesize errors');
    if (opts.pretty) {
      process.stderr.write(`\n  Synthesized: ${synthReport.synthesized.length} pages`);
      process.stderr.write(`\n  Skipped (fresh): ${synthReport.skipped.length}\n`);
      if (synthReport.errors.length > 0)
        process.stderr.write(`  Errors: ${synthReport.errors.join(', ')}\n`);
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'dream: synthesize phase failed');
  }
}

/**
 * Print the pretty-mode summary report to stderr.
 */
function printPrettyReport(report: DreamReport, allNotes: NoteEntry[], opts: DreamOptions): void {
  const w = (s: string) => process.stderr.write(s);
  w('\n');
  w('  Dream report\n');
  w('  ════════════════════════════════════════════\n');
  w(`  Conversations read:    ${report.conversationsProcessed}\n`);
  w(`  Conversations skipped: ${report.conversationsSkipped} (unchanged, fingerprint match)\n`);
  w(
    `  Notes healed:          ${report.healedNotes} (wrongly invalidated by a past noise-cleanup bug)\n`,
  );
  w(`  Noise cleaned:         ${report.noiseCleanedUp}\n`);
  w(`  Notes enriched:        ${report.tldrsGenerated}\n`);
  w(`  Stubs expanded:        ${report.stubsExpanded}\n`);
  w(`  Contradictions found:  ${report.contradictionsFound}\n`);
  w(`  Duplicates detected:   ${report.duplicatesMerged}\n`);
  w(`  Duration:              ${(report.duration_ms / 1000).toFixed(1)}s\n`);
  w('  ════════════════════════════════════════════\n');

  const remainingNoTldr = allNotes.filter((n) => {
    try {
      return !hasTldr(readNote(n.path).html);
    } catch {
      return false;
    }
  }).length;

  if (remainingNoTldr > 0 && !opts.enrich) {
    const cost = (remainingNoTldr * 0.00025).toFixed(2);
    w('\n');
    w('  Next steps:\n');
    w(`  ${remainingNoTldr} notes still need TLDRs for better recall.\n`);
    w('  Run: lazybrain dream --enrich --pretty\n');
    w(`  Cost: ~$${cost} (Haiku via your Claude subscription)\n`);
    w('  This generates 1-sentence summaries and topic paths.\n');
  }

  if (report.contradictionsFound > 0) {
    w(`\n  ${report.contradictionsFound} potential contradictions found.\n`);
    w(
      '  Run: lazybrain query \'article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])\' --pretty\n',
    );
    w('  to review active decisions and resolve conflicts.\n');
  }
  w('\n');
}

// ---------------------------------------------------------------------------
// Main dream function — orchestrator only
// ---------------------------------------------------------------------------

/** Build the empty initial report. */
function makeEmptyReport(): DreamReport {
  return {
    startedAt: nowIso(),
    duration_ms: 0,
    conversationsProcessed: 0,
    conversationsSkipped: 0,
    healedNotes: 0,
    noiseCleanedUp: 0,
    invalidatedNotes: 0,
    stubsExpanded: 0,
    tldrsGenerated: 0,
    contradictionsFound: 0,
    duplicatesMerged: 0,
  };
}

/** Emit the dream telemetry event. */
function emitDreamTelemetry(noteCount: number): void {
  logTelemetry({
    event: 'compress',
    ts: nowIso(),
    in_count: noteCount,
    out_size_bytes: 0,
    compression_ratio: 0,
    model: 'dream',
  });
}

/**
 * Main dream function — orchestrator.
 */
export async function runDream(opts: DreamOptions): Promise<DreamReport> {
  const log = getLogger();
  const start = Date.now();
  const baseReport = makeEmptyReport();

  const maxNotes = opts.maxNotes ?? 20;
  const allNotes = listAll({ includeExpired: false });
  log.info({ total: allNotes.length, maxNotes }, 'dream: starting');

  const shortcutResult = await runSynthesizeOnlyShortcut(opts, baseReport, start);
  if (shortcutResult) return shortcutResult;

  const isCliAvailable = await isClaudeCliAvailable();
  const reportAfterIngestion = await runConversationIngestion(opts, baseReport);
  // Self-heal BEFORE noise cleanup: restore any note wrongly invalidated by a
  // past dream-noise-cleanup bug (fixed going forward via hasNoiseExemptTag,
  // above) before this same pass's cleanup step runs again. Bounded to the
  // index's already-invalidated notes (see healNoiseExemptNotes's doc
  // comment) and forever idempotent — automatic for every user, no manual
  // `repair` CLI invocation required.
  const healReport = healNoiseExemptNotes(NOISE_EXEMPT_TAGS, opts.dryRun === true);
  const noiseCount = await runNoiseCleanup(opts);
  const stubsExpanded = await runStubExpansion(opts, allNotes, isCliAvailable);
  const tldrsGenerated = await runTldrGeneration(opts, allNotes, isCliAvailable);
  const contradictionsFound = runContradictionDetection(allNotes, maxNotes);
  const duplicatesMerged = await runDuplicateDetection(allNotes, maxNotes);
  await runSynthesizePhase(opts);

  const report: DreamReport = {
    ...reportAfterIngestion,
    healedNotes: healReport.healed,
    noiseCleanedUp: noiseCount,
    invalidatedNotes: noiseCount,
    stubsExpanded,
    tldrsGenerated,
    contradictionsFound,
    duplicatesMerged,
    duration_ms: Date.now() - start,
  };

  log.info(
    { healedNotes: report.healedNotes, invalidatedNotes: report.invalidatedNotes },
    'dream: maintenance summary',
  );
  emitDreamTelemetry(allNotes.length);
  if (opts.pretty) printPrettyReport(report, allNotes, opts);
  return report;
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}
