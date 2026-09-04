import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../util/config.js';
import { getLogger } from '../util/logger.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';
import { runCapture } from './capture.js';
import { runCompress } from './compress.js';
import { runExtract } from './extract.js';
import { runGraph } from './graph.js';
import { type InjectFormat, type InjectMode, runInjectContext } from './inject-context.js';
import { runNeighbours } from './neighbours.js';
import { runSearch } from './search.js';

const DEFAULT_PORT = 37788;
const DEFAULT_IDLE_MS = 30 * 60 * 1000; // 30 min
const CACHE_MAX_ENTRIES = 64;
const CACHE_TTL_MS = 60_000;
const BRAIN_MTIME_CACHE_MS = 5_000;

interface CacheEntry {
  value: string;
  storedAt: number;
}

const responseCache = new Map<string, CacheEntry>();

let brainMtimeCache: { value: number; computedAt: number } | null = null;

function computeBrainMtime(): number {
  const now = Date.now();
  if (brainMtimeCache && now - brainMtimeCache.computedAt < BRAIN_MTIME_CACHE_MS) {
    return brainMtimeCache.value;
  }
  const root = join(getConfig().brainPath, 'notes');
  let maxMtime = 0;
  if (existsSync(root)) {
    for (const month of readdirSync(root)) {
      const monthDir = join(root, month);
      try {
        for (const f of readdirSync(monthDir)) {
          const s = statSync(join(monthDir, f));
          if (s.mtimeMs > maxMtime) maxMtime = s.mtimeMs;
        }
      } catch {
        // ignore unreadable dirs
      }
    }
  }
  brainMtimeCache = { value: maxMtime, computedAt: now };
  return maxMtime;
}

function invalidateBrainMtime(): void {
  brainMtimeCache = { value: Date.now(), computedAt: Date.now() };
  responseCache.clear();
}

function cacheGet(key: string): string | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  // LRU: refresh order
  responseCache.delete(key);
  responseCache.set(key, entry);
  return entry.value;
}

function cacheSet(key: string, value: string): void {
  if (responseCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey !== undefined) responseCache.delete(oldestKey);
  }
  responseCache.set(key, { value, storedAt: Date.now() });
}

function cacheKey(endpoint: string, parts: Array<string | number | undefined>): string {
  const raw = `${endpoint}|${parts.map((p) => (p === undefined ? '' : String(p))).join('|')}`;
  return createHash('sha1').update(raw).digest('hex');
}

export interface DaemonCliOptions {
  port?: number;
  idleTimeoutMs?: number;
  pretty?: boolean;
}

interface DaemonState {
  startedAt: number;
  lastActivityAt: number;
  hits: number;
  cacheHits: number;
  cacheMisses: number;
  port: number;
}

function pidPath(): string {
  return join(getConfig().cachePath, 'daemon.pid');
}

function portPath(): string {
  return join(getConfig().cachePath, 'daemon.port');
}

function lockPath(): string {
  return join(getConfig().cachePath, 'daemon.lock');
}

export function readDaemonPort(): number | null {
  try {
    const raw = readFileSync(portPath(), 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function readDaemonPid(): number | null {
  try {
    const raw = readFileSync(pidPath(), 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function pingDaemon(port: number, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start the daemon in the foreground (blocks until idle timeout or SIGTERM).
 * Used by `lazybrain daemon start --foreground` and by the auto-start spawn.
 */
export async function startDaemonForeground(opts: DaemonCliOptions): Promise<void> {
  const cfg = getConfig();
  const log = getLogger();
  if (!existsSync(cfg.cachePath)) mkdirSync(cfg.cachePath, { recursive: true });

  // Lock: refuse if another daemon is running
  const existingPort = readDaemonPort();
  const existingPid = readDaemonPid();
  if (existingPort && existingPid && isProcessAlive(existingPid)) {
    const alive = await pingDaemon(existingPort, 500);
    if (alive) {
      log.warn({ port: existingPort, pid: existingPid }, 'daemon already running');
      return;
    }
  }

  const port = opts.port ?? DEFAULT_PORT;
  const idle = opts.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const state: DaemonState = {
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    hits: 0,
    cacheHits: 0,
    cacheMisses: 0,
    port,
  };

  const server = createServer((req, res) => handleRequest(req, res, state));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      writeFileSync(pidPath(), String(process.pid), 'utf8');
      writeFileSync(portPath(), String(port), 'utf8');
      log.info({ port, pid: process.pid }, 'lazybrain daemon listening');
      resolve();
    });
  });

  const cleanup = (): void => {
    server.close();
    try {
      unlinkSync(pidPath());
    } catch {
      /* */
    }
    try {
      unlinkSync(portPath());
    } catch {
      /* */
    }
    try {
      unlinkSync(lockPath());
    } catch {
      /* */
    }
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  // Idle check every 60s
  const idleTimer = setInterval(() => {
    if (Date.now() - state.lastActivityAt > idle) {
      log.info({ hits: state.hits }, 'daemon idle, shutting down');
      cleanup();
    }
  }, 60_000);
  idleTimer.unref();

  // Block forever (server is keeping us alive)
  await new Promise<void>(() => {});
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: DaemonState,
): Promise<void> {
  state.lastActivityAt = Date.now();
  state.hits += 1;

  const url = req.url ?? '/';
  if (req.method === 'GET' && url === '/health') {
    const cacheTotal = state.cacheHits + state.cacheMisses;
    let brainStats: { notes: number; mtime_ms: number } | null = null;
    try {
      const root = join(getConfig().brainPath, 'notes');
      let count = 0;
      if (existsSync(root)) {
        for (const month of readdirSync(root)) {
          try {
            for (const f of readdirSync(join(root, month))) {
              if (f.endsWith('.html')) count += 1;
            }
          } catch {
            // skip
          }
        }
      }
      brainStats = { notes: count, mtime_ms: computeBrainMtime() };
    } catch {
      // best-effort
    }
    return sendJson(res, 200, {
      ok: true,
      port: state.port,
      uptime_ms: Date.now() - state.startedAt,
      hits: state.hits,
      cache_hits: state.cacheHits,
      cache_misses: state.cacheMisses,
      cache_hit_ratio: cacheTotal ? +(state.cacheHits / cacheTotal).toFixed(3) : 0,
      cache_size: responseCache.size,
      brain: brainStats,
    });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: `invalid body: ${(err as Error).message}` });
  }

  try {
    switch (url) {
      case '/inject-context': {
        const mode = (optStrField(body, 'mode') as InjectMode | undefined) ?? 'session';
        const format = (optStrField(body, 'format') as InjectFormat | undefined) ?? 'full';
        const maxTokens = numField(body, 'max_tokens', mode === 'turn' ? 150 : 3000);
        const query = optStrField(body, 'query') ?? '';
        const minScore =
          typeof body.min_score === 'number' ? (body.min_score as number) : undefined;
        const cwd = optStrField(body, 'cwd');
        const sessionId = optStrField(body, 'session_id');
        // Q3: turn-mode is *not* cacheable when a sessionId is present — the
        // differential filter (alreadyInjected) makes each turn unique. Skip
        // the response cache for that case so we never serve stale outputs.
        const useCache = mode !== 'turn' || !sessionId;
        const key = cacheKey('inject', [
          mode,
          format,
          maxTokens,
          query,
          minScore,
          cwd,
          computeBrainMtime(),
        ]);
        if (useCache) {
          const cached = cacheGet(key);
          if (cached !== null) {
            state.cacheHits += 1;
            logTelemetry({
              event: 'cache_hit',
              ts: nowIso(),
              endpoint: 'inject-context',
              key_hash: key.slice(0, 8),
            });
            return sendText(res, 200, cached);
          }
        }
        state.cacheMisses += 1;
        const text = await runInjectContext({
          maxTokens,
          preferRecent: !!body.prefer_recent,
          preferImportant: !!body.prefer_important,
          mode,
          format,
          query,
          minScore,
          cwd,
          sessionId,
        });
        if (useCache) cacheSet(key, text);
        return sendText(res, 200, text);
      }
      case '/search': {
        const query = strField(body, 'query');
        const top = numField(body, 'top', 5);
        const strip = !!body.strip;
        const searchMode = (body.mode as 'l1' | 'l2' | 'l3' | 'l4' | 'auto' | undefined) ?? 'auto';
        const cwd = optStrField(body, 'cwd');
        const sourcePrefix = optStrField(body, 'source_prefix');
        const key = cacheKey('search', [
          query,
          top,
          strip ? 1 : 0,
          searchMode,
          cwd,
          sourcePrefix,
          computeBrainMtime(),
        ]);
        const cached = cacheGet(key);
        if (cached !== null) {
          state.cacheHits += 1;
          logTelemetry({
            event: 'cache_hit',
            ts: nowIso(),
            endpoint: 'search',
            key_hash: key.slice(0, 8),
          });
          return sendText(res, 200, cached);
        }
        state.cacheMisses += 1;
        const text = await runSearch({
          query,
          top,
          strip,
          mode: searchMode,
          cwd,
          sourcePrefix: sourcePrefix ?? undefined,
        });
        cacheSet(key, text);
        return sendText(res, 200, text);
      }
      case '/capture': {
        const raw = optStrField(body, 'raw') ?? '';
        const session = optStrField(body, 'session');
        const async = !!body.async;
        const flushSync = !!body.flush_sync;
        const out = await runCaptureInProcess(raw, session, { async, flushSync });
        // Any write path may have produced new notes → invalidate read cache.
        invalidateBrainMtime();
        return sendText(res, 200, out);
      }
      case '/compress': {
        const out = runCompress({
          session: optStrField(body, 'session'),
          olderThanDays: numField(body, 'older_than_days', 7),
          purgeNoise: !!body.purge_noise,
          purgeSource: optStrField(body, 'purge_source'),
        });
        return sendText(res, 200, out);
      }
      case '/maintenance': {
        // Sprint Final — single-call weekly maintenance.
        // Runs sequentially so the daemon stays responsive on other requests.
        const compressOut = runCompress({ olderThanDays: 7 });
        const purgeOut = runCompress({ purgeNoise: true });
        const { runProfileUpdate } = await import('./profile-update.js');
        const profileOut = runProfileUpdate({});
        const graphOut = await runGraph({});
        // Full weekly reconciliation of conv→file-neuron enrichment. Placed
        // right after runGraph deliberately: a bare code-scan re-write
        // (runGraph, just above) preserves existing per-file enrichment via
        // codeNodesToNotes' existingEnrichmentById, but this pass is what
        // re-attaches enrichment for any conversation notes that were never
        // picked up by the incremental per-capture path (capture.ts) — e.g.
        // notes imported/migrated some other way, or a missed edge case in
        // the incremental checkpoint. Reprocesses the entire corpus, unlike
        // the incremental path — see enrich.ts's runIncrementalEnrich.
        const { runEnrich } = await import('./enrich.js');
        const enrichOut = await runEnrich({});
        const { runInterlink } = await import('./interlink.js');
        const interlinkOut = await runInterlink({ limit: 50 });
        const { runBuildIndex } = await import('./build-index.js');
        const indexOut = await runBuildIndex({});
        const { runBuildClusters } = await import('./build-clusters.js');
        const clustersOut = await runBuildClusters({});
        invalidateBrainMtime();
        const tryParse = (s: string): unknown => {
          try {
            return JSON.parse(s);
          } catch {
            return s;
          }
        };
        return sendJson(res, 200, {
          compress: tryParse(compressOut),
          purge_noise: tryParse(purgeOut),
          profile: tryParse(profileOut),
          graph: tryParse(graphOut),
          enrich: enrichOut,
          interlink: tryParse(interlinkOut),
          build_index: indexOut,
          build_clusters: clustersOut,
        });
      }
      case '/graph': {
        const out = await runGraph({});
        return sendText(res, 200, out);
      }
      case '/extract': {
        const batchSize = numField(body, 'batch_size', 10);
        const out = await runExtract({ batchSize });
        invalidateBrainMtime();
        return sendText(res, 200, out);
      }
      case '/neighbours':
      case '/graph-id': {
        const id = strField(body, 'id');
        return sendText(res, 200, runNeighbours({ id }));
      }
      case '/capture-vibe': {
        const transcriptPath = optStrField(body, 'transcript_path') ?? '';
        const cwd = optStrField(body, 'cwd');
        const sessionId = optStrField(body, 'session_id');
        const { runCaptureVibe } = await import('./capture-vibe.js');
        const out = await runCaptureVibe({ transcriptPath, cwd, sessionId });
        invalidateBrainMtime();
        return sendText(res, 200, out);
      }
      case '/shutdown': {
        sendJson(res, 200, { ok: true });
        setImmediate(() => process.exit(0));
        return;
      }
      default:
        return sendJson(res, 404, { error: 'unknown endpoint' });
    }
  } catch (err) {
    if (mapDbError(res, err)) return;
    const msg = err instanceof Error ? err.message : String(err);
    return sendJson(res, 500, { error: msg });
  }
}

async function runCaptureInProcess(
  raw: string,
  session: string | undefined,
  opts: { async: boolean; flushSync: boolean },
): Promise<string> {
  // We have to feed the CLI from stdin in the existing impl; for the daemon we
  // pass the raw text via an in-memory buffer by writing to a temp file path.
  // Simpler: use the existing runCapture with --from-file by writing temp file.
  if (opts.flushSync) {
    return await runCapture({ flushSync: true, session });
  }
  if (!raw) {
    return JSON.stringify({ status: 'noop', reason: 'empty input' });
  }
  // Write to a transient temp file so runCapture can read it
  const tmpDir = join(getConfig().cachePath, 'capture-queue');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const tmpFile = join(
    tmpDir,
    `inflight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  writeFileSync(tmpFile, raw, 'utf8');
  try {
    return await runCapture({ fromFile: tmpFile, session, async: opts.async });
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* */
    }
  }
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      total += c.length;
      if (total > 5_000_000) {
        req.destroy(new Error('body too large'));
      }
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(err as Error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/**
 * Map a database error to an HTTP status + JSON body.
 * SQLITE_BUSY → 503 with a Retry-After header (index rebuild in progress).
 * Everything else → 500 (existing behavior).
 *
 * Returns null when err is not a recognised DB error (caller should use its
 * own fallback logic).
 */
export function mapDbError(res: ServerResponse, err: unknown): boolean {
  const code = err != null ? (err as NodeJS.ErrnoException).code : undefined;
  if (code === 'SQLITE_BUSY') {
    res.writeHead(503, {
      'content-type': 'application/json',
      'retry-after': '3',
    });
    res.end(JSON.stringify({ error: 'Index is being rebuilt — retry in a few seconds' }));
    return true;
  }
  return false;
}

function strField(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string') throw new Error(`missing string field "${key}"`);
  return v;
}

function optStrField(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === 'string' ? v : undefined;
}

function numField(body: Record<string, unknown>, key: string, fallback: number): number {
  const v = body[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return fallback;
}

/**
 * Spawn the daemon in detached mode, return when it's responding to /health
 * (or after a few seconds).
 */
export async function ensureDaemonRunning(port = DEFAULT_PORT): Promise<boolean> {
  const existing = readDaemonPort();
  if (existing) {
    if (await pingDaemon(existing, 600)) return true;
  }
  // Spawn detached daemon
  const exeUrl = new URL('../../bin/lazybrain.js', import.meta.url);
  const exePath = fileURLToPath(exeUrl);
  // Fall back to global `lazybrain` command if dist not present
  const cmd = existsSync(exePath) ? process.execPath : 'lazybrain';
  const args = existsSync(exePath)
    ? [exePath, 'daemon', 'start', '--foreground', '--port', String(port)]
    : ['daemon', 'start', '--foreground', '--port', String(port)];

  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
    shell: existsSync(exePath) ? false : process.platform === 'win32',
  });
  child.unref();

  // Wait up to 5s for daemon to start
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await pingDaemon(port, 400)) return true;
    await sleep(150);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function runDaemonStatus(opts: DaemonCliOptions): string {
  const port = readDaemonPort();
  const pid = readDaemonPid();
  const alive = pid !== null && isProcessAlive(pid);
  const payload = { port, pid, alive };
  if (opts.pretty) {
    return alive ? `daemon: running pid=${pid} port=${port}` : 'daemon: not running';
  }
  return JSON.stringify(payload, null, 2);
}

export async function runDaemonStop(opts: DaemonCliOptions): Promise<string> {
  const port = readDaemonPort();
  if (!port) return JSON.stringify({ status: 'noop', reason: 'no port file' });
  try {
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' });
  } catch {
    // ignore
  }
  try {
    unlinkSync(pidPath());
  } catch {
    /* */
  }
  try {
    unlinkSync(portPath());
  } catch {
    /* */
  }
  return opts.pretty ? 'daemon stopped' : JSON.stringify({ status: 'stopped' });
}
