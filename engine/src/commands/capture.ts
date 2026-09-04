import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { annotateSession } from '../annotator/heuristic.js';
import { annotateWithLlm } from '../annotator/llm.js';
import { type ParsedToolPayload, parseToolPayload } from '../capture/payload-parser.js';
import { recordCapture, shouldCapture } from '../capture/validator.js';
import { annotateContradictions, detectContradictions } from '../graph/contradictions.js';
import { indexNote } from '../indexer/fts.js';
import { readNote } from '../store/reader.js';
import { writeNote } from '../store/writer.js';
import { getConfig } from '../util/config.js';
import { getLogger } from '../util/logger.js';
import { recordTouchedFiles } from '../util/session-cache.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';
import { estimateTokenCount } from '../util/tokenize.js';
import { isAgentMetaText } from './dream.js';
import { runIncrementalEnrich } from './enrich.js';

export interface CaptureCliOptions {
  fromStdin?: boolean;
  fromFile?: string;
  session?: string;
  cwd?: string;
  async?: boolean; // queue and exit fast (PostToolUse)
  flushSync?: boolean; // synchronous flush of queue (PreCompact)
  useLlm?: boolean;
  pretty?: boolean;
}

const QUEUE_DIRNAME = 'capture-queue';

export async function runCapture(opts: CaptureCliOptions): Promise<string> {
  if (opts.flushSync) {
    // PreCompact: flush is the last chance to persist this session's notes
    // before context is discarded — force the incremental enrich past the
    // throttle so it reflects everything just flushed.
    const result = await flushQueue(opts);
    await runIncrementalEnrich({ force: true });
    return result;
  }

  let text: string;
  if (opts.fromFile) {
    text = readFileSync(opts.fromFile, 'utf8');
  } else {
    text = await readStdin();
  }
  text = text.trim();
  if (!text) {
    return JSON.stringify({ status: 'noop', reason: 'empty input' });
  }

  if (opts.async) {
    return enqueue(text, opts);
  }

  const result = await processOne(text, opts);
  // Auto-run conv→file-neuron enrichment after every capture (not only via
  // the weekly /maintenance job) — see enrich.ts's runIncrementalEnrich for
  // the incremental/throttle/resilience design. Never breaks capture:
  // runIncrementalEnrich catches and logs its own failures.
  await runIncrementalEnrich();
  return result;
}

async function processOne(text: string, opts: CaptureCliOptions): Promise<string> {
  const sessionId = opts.session ?? `unknown-${Date.now()}`;
  const start = Date.now();
  const log = getLogger();

  // Denoise gate: reject observer / agent-meta text before any further processing.
  // This prevents claude-mem observer residue from entering the knowledge store.
  if (isAgentMetaText(text)) {
    log.debug({ session: sessionId }, 'capture: skipped — agent-meta text (denoise gate)');
    logTelemetry({
      event: 'capture_skipped',
      ts: nowIso(),
      session: sessionId,
      reason: 'agent_meta',
      tokens_in: estimateTokenCount(text),
    });
    return JSON.stringify({ status: 'skipped', reason: 'agent_meta' });
  }

  // Tool payloads get parsed first so we can preserve file refs even when the
  // raw JSON would be rejected as noise. The synthetic prose is then validated.
  const parsed = parseToolPayload(text);

  // Feature C: record touched files in the active working set so the next
  // inject turn can boost notes that belong to these files. Modified files
  // take precedence (passed first). Non-blocking — synchronous in-memory only.
  if (parsed && (parsed.filesModified.length > 0 || parsed.filesRead.length > 0)) {
    recordTouchedFiles(sessionId, [...parsed.filesModified, ...parsed.filesRead]);
  }

  const validationText = synthesizeProse(parsed, text);
  const validation = shouldCapture(validationText);
  if (!validation.ok) {
    logTelemetry({
      event: 'capture_skipped',
      ts: nowIso(),
      session: sessionId,
      reason: validation.reason,
      tokens_in: estimateTokenCount(text),
    });
    return JSON.stringify({ status: 'skipped', reason: validation.reason });
  }

  const annotated = opts.useLlm
    ? await annotateWithLlm({ sessionId, text, cwd: opts.cwd })
    : annotateSession({
        sessionId,
        text: parsed?.prose && parsed.prose.length > 0 ? parsed.prose : text,
        cwd: opts.cwd,
        tool: parsed?.tool,
        filesModified: parsed?.filesModified,
        filesRead: parsed?.filesRead,
      });

  const result = writeNote(annotated.html, { overwrite: true });
  indexNote(readNote(result.path));
  recordCapture(validation.hash);

  // Contradiction detection (annotates new note, never modifies the old ones)
  let conflicts = 0;
  try {
    const hits = detectContradictions(annotated.html, result.id);
    if (hits.length > 0) {
      conflicts = annotateContradictions(result.path, hits);
      indexNote(readNote(result.path));
    }
  } catch {
    // contradiction detection is best-effort
  }

  logTelemetry({
    event: 'capture',
    ts: nowIso(),
    session: sessionId,
    tokens_in: estimateTokenCount(text),
    tokens_out_html: estimateTokenCount(annotated.html),
    strip_ratio: 0,
    duration_ms: Date.now() - start,
  });

  return opts.pretty
    ? `Captured ${result.id} (${annotated.factCount} facts, tags: ${annotated.tags.join(',')}${conflicts ? `, conflicts: ${conflicts}` : ''})`
    : JSON.stringify({
        id: result.id,
        facts: annotated.factCount,
        tags: annotated.tags,
        conflicts,
      });
}

function enqueue(text: string, opts: CaptureCliOptions): string {
  const cfg = getConfig();
  const dir = join(cfg.cachePath, QUEUE_DIRNAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${(opts.session ?? 'na').slice(0, 8)}.txt`);
  const payload = JSON.stringify({ session: opts.session, cwd: opts.cwd, text });
  writeFileSync(file, payload, 'utf8');
  return JSON.stringify({ status: 'queued', file });
}

async function flushQueue(opts: CaptureCliOptions): Promise<string> {
  const cfg = getConfig();
  const dir = join(cfg.cachePath, QUEUE_DIRNAME);
  if (!existsSync(dir)) return JSON.stringify({ status: 'noop', flushed: 0 });
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .sort();
  let flushed = 0;
  const errors: string[] = [];
  const log = getLogger();
  for (const f of files) {
    const path = join(dir, f);
    try {
      const raw = readFileSync(path, 'utf8');
      const { session, cwd, text } = JSON.parse(raw) as {
        session?: string;
        cwd?: string;
        text: string;
      };
      await processOne(text, { ...opts, session, cwd, async: false });
      unlinkSync(path);
      flushed += 1;
    } catch (err) {
      const msg = (err as Error).message;
      log.error({ file: f, err: msg }, 'flush capture error');
      errors.push(`${f}: ${msg}`);
    }
  }
  return JSON.stringify({ status: 'ok', flushed, errors });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/**
 * When a parsed tool payload is available, build the "prose" we run through the
 * validator: tool name + file basenames + truncated response. This lets the
 * validator approve real Edit/Write/Bash events (which carry actionable file
 * refs) even though the raw JSON envelope is noisy.
 */
function synthesizeProse(parsed: ParsedToolPayload | null, fallback: string): string {
  if (!parsed) return fallback;
  const parts: string[] = [];
  parts.push(`Tool ${parsed.tool}`);
  if (parsed.filesModified.length) parts.push(`modified ${parsed.filesModified.join(', ')}`);
  if (parsed.filesRead.length) parts.push(`read ${parsed.filesRead.join(', ')}`);
  if (parsed.prose) parts.push(parsed.prose);
  const synthetic = parts.join('. ');
  return synthetic.length >= 40 ? synthetic : fallback;
}
