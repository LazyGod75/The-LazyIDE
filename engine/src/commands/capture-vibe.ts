/**
 * Incremental live capture for Mistral Vibe.
 *
 * Called by the daemon /capture-vibe endpoint, itself triggered by Vibe's
 * post_agent_turn hook. Reads the session's append-only messages.jsonl,
 * processes ONLY messages beyond the per-transcript cursor, and stores one
 * note per new turn batch. The cursor lives in <cache>/vibe-cursors.json.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { annotateSession } from '../annotator/heuristic.js';
import { recordCapture, shouldCapture } from '../capture/validator.js';
import { indexNote } from '../indexer/fts.js';
import { makeSourceSessionId } from '../sources/types.js';
import {
  extractVibeSummary,
  extractVibeToolFiles,
  parseVibeMessages,
  parseVibeMeta,
} from '../sources/vibe-parser.js';
import { readNote } from '../store/reader.js';
import { writeNote } from '../store/writer.js';
import { getConfig } from '../util/config.js';
import { getLogger } from '../util/logger.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';
import { estimateTokenCount } from '../util/tokenize.js';
import { runIncrementalEnrich } from './enrich.js';

export interface CaptureVibeOptions {
  transcriptPath: string;
  cwd?: string;
  sessionId?: string;
  pretty?: boolean;
}

interface VibeCursorStore {
  [transcriptPath: string]: { processedCount: number };
}

function cursorPath(): string {
  return join(getConfig().cachePath, 'vibe-cursors.json');
}

function loadCursors(): VibeCursorStore {
  try {
    const raw = readFileSync(cursorPath(), 'utf8');
    const parsed = JSON.parse(raw) as VibeCursorStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveCursors(store: VibeCursorStore): void {
  writeFileSync(cursorPath(), JSON.stringify(store, null, 2), 'utf8');
}

function safeReadSync(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export async function runCaptureVibe(opts: CaptureVibeOptions): Promise<string> {
  const log = getLogger();
  const start = Date.now();

  if (!opts.transcriptPath || !existsSync(opts.transcriptPath)) {
    return JSON.stringify({ status: 'noop', reason: 'missing transcript' });
  }

  const messages = parseVibeMessages(readFileSync(opts.transcriptPath, 'utf8'));
  const cursors = loadCursors();
  const processed = cursors[opts.transcriptPath]?.processedCount ?? 0;
  const fresh = messages.slice(processed);

  if (fresh.length === 0) {
    return JSON.stringify({ status: 'noop', reason: 'no new messages' });
  }

  const meta = parseVibeMeta(safeReadSync(join(dirname(opts.transcriptPath), 'meta.json')));
  const cwd = opts.cwd ?? meta?.environment?.working_directory ?? undefined;

  // Self-ingest guard: never capture lazybrain's own development sessions.
  if (cwd && /cerveau|lazybrain/i.test(cwd)) {
    cursors[opts.transcriptPath] = { processedCount: messages.length };
    saveCursors(cursors);
    return JSON.stringify({ status: 'skipped', reason: 'self_ingest_guard' });
  }

  const text = extractVibeSummary(fresh);
  const { filesModified, filesRead } = extractVibeToolFiles(fresh, cwd ?? '');

  // Tool-only turns produce no prose — synthesize a minimal factual line so
  // file attribution is preserved (mirrors capture.ts synthesizeProse).
  const effectiveText =
    text.length >= 40
      ? text
      : filesModified.length > 0 || filesRead.length > 0
        ? [
            filesModified.length ? `vibe edit: modified ${filesModified.join(', ')}` : '',
            filesRead.length ? `read ${filesRead.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('. ')
        : '';

  // Always advance the cursor — even when we skip — so noise is not re-read.
  cursors[opts.transcriptPath] = { processedCount: messages.length };
  saveCursors(cursors);

  if (!effectiveText) {
    return JSON.stringify({ status: 'skipped', reason: 'no_substance' });
  }

  const validation = shouldCapture(effectiveText);
  if (!validation.ok) {
    logTelemetry({
      event: 'capture_skipped',
      ts: nowIso(),
      session: opts.sessionId ?? 'vibe',
      reason: validation.reason,
      tokens_in: estimateTokenCount(effectiveText),
    });
    return JSON.stringify({ status: 'skipped', reason: validation.reason });
  }

  const sessionKey = meta?.session_id ?? opts.sessionId ?? opts.transcriptPath;
  const annotated = annotateSession({
    sessionId: makeSourceSessionId('vibe', `${opts.transcriptPath}#${processed}`),
    text: effectiveText.slice(0, 4000),
    timestamp: new Date().toISOString(),
    cwd,
    filesModified: filesModified.length ? filesModified : undefined,
    filesRead: filesRead.length ? filesRead : undefined,
    agent: 'vibe',
    sourceKind: 'transcript',
    sessionParent: meta?.parent_session_id ?? undefined,
    gitCommit: meta?.git_commit ?? undefined,
    gitBranch: meta?.git_branch ?? undefined,
  });

  const result = writeNote(annotated.html, { overwrite: true });
  indexNote(readNote(result.path));
  recordCapture(validation.hash);

  logTelemetry({
    event: 'capture',
    ts: nowIso(),
    session: sessionKey,
    tokens_in: estimateTokenCount(effectiveText),
    tokens_out_html: estimateTokenCount(annotated.html),
    strip_ratio: 0,
    duration_ms: Date.now() - start,
  });
  log.debug({ id: result.id, fresh: fresh.length }, 'capture-vibe: stored note');

  // Same auto-run wiring as capture.ts — resilient/throttled, never breaks capture.
  await runIncrementalEnrich();

  scheduleAgentsMdRefresh(cwd);

  return JSON.stringify({
    status: 'ok',
    id: result.id,
    processedMessages: fresh.length,
    facts: annotated.factCount,
  });
}

/**
 * Debounced AGENTS.md refresh: after new knowledge lands, regenerate the
 * project-level projection so the NEXT Vibe session opens fresh. Vibe only
 * reads AGENTS.md at session start, so sub-interval staleness is invisible;
 * the marker-file debounce (default 300s) keeps per-turn cost at one stat().
 * Fire-and-forget: a refresh failure must never fail the capture.
 */
function scheduleAgentsMdRefresh(cwd: string | undefined): void {
  if (!cwd) return;
  try {
    const intervalS = Number(process.env.LAZYBRAIN_VIBE_REFRESH_SECONDS ?? '300');
    const marker = join(getConfig().cachePath, 'vibe-agentsmd-refresh.txt');
    const nowEpoch = Math.floor(Date.now() / 1000);
    let last = 0;
    try {
      last = Number(readFileSync(marker, 'utf8').trim()) || 0;
    } catch {
      /* first run */
    }
    if (nowEpoch - last < intervalS) return;
    writeFileSync(marker, String(nowEpoch), 'utf8');
    void import('./export-agents-md.js')
      .then(({ runExportAgentsMd }) => runExportAgentsMd({ target: 'project', cwd }))
      .catch(() => {
        /* fire-and-forget */
      });
  } catch {
    /* never fail the capture */
  }
}
