/**
 * resource-monitor.ts — periodic self-report for the long-lived `serve`
 * sidecar (P41 follow-up).
 *
 * The sidecar runs as one process per app session, often for hours, so a
 * slow accumulation (a growing cache, an unclosed handle) is invisible until
 * RSS is already large — that is exactly how P41 (726MB -> 3.7GB over 3h
 * near-idle; +2.4GB in 30min under load) went unnoticed. This logs one
 * structured line every interval with process memory plus the size of every
 * in-process cache known to grow with usage, so a future leak shows up as a
 * trend in Lazy.log instead of only as a support report. Grep for
 * "serve: resource snapshot" to see it.
 *
 * Deliberately cheap: every stat read here is an in-memory size (Map.size,
 * array length) or process.memoryUsage() — no disk or SQLite access — so
 * running this every 5 minutes never competes with real request work.
 */
import { embeddingCacheStats } from '../indexer/embeddings.js';
import { hydeCacheStats } from '../retrieval/hyde.js';
import { getLogger } from '../util/logger.js';
import { sessionCacheStats } from '../util/session-cache.js';
import { listBrains } from './brain-registry.js';

export const RESOURCE_SNAPSHOT_INTERVAL_MS = 5 * 60_000;

function toMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/** Log one resource snapshot line. Exported so it can be triggered on-demand (tests, manual debugging). */
export function logResourceSnapshot(): void {
  const mem = process.memoryUsage();
  const brains = listBrains();
  getLogger().info(
    {
      rssMb: toMb(mem.rss),
      heapUsedMb: toMb(mem.heapUsed),
      externalMb: toMb(mem.external),
      arrayBuffersMb: toMb(mem.arrayBuffers),
      embeddingCache: embeddingCacheStats(),
      hydeCache: hydeCacheStats(),
      sessions: sessionCacheStats(),
      brains: { total: brains.length, hot: brains.filter((b) => b.hot).length },
    },
    'serve: resource snapshot',
  );
}

/**
 * Start the periodic snapshot timer. Returns a disposer that stops it —
 * callers MUST invoke this on server close (see commands/serve.ts) so
 * repeated test runs (or repeated serve restarts in-process) don't
 * accumulate timers. The timer is also `.unref()`d so it never by itself
 * keeps the process alive past a clean shutdown.
 */
export function startResourceMonitor(
  intervalMs: number = RESOURCE_SNAPSHOT_INTERVAL_MS,
): () => void {
  const timer = setInterval(logResourceSnapshot, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
