import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../util/config.js';

// ---------------------------------------------------------------------------
// Pidfile / portfile helpers
// ---------------------------------------------------------------------------

function servePidPath(): string {
  return join(getConfig().cachePath, 'serve.pid');
}

function servePortPath(): string {
  return join(getConfig().cachePath, 'serve.port');
}

/** Write PID and port files to the cache directory. */
export function writeServeFiles(port: number): void {
  const cachePath = getConfig().cachePath;
  if (!existsSync(cachePath)) mkdirSync(cachePath, { recursive: true });
  writeFileSync(servePidPath(), String(process.pid), 'utf8');
  writeFileSync(servePortPath(), String(port), 'utf8');
}

/** Remove PID and port files (best-effort). */
export function cleanServeFiles(): void {
  for (const path of [servePidPath(), servePortPath()]) {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
}

/** Read the port from the serve portfile, or null if absent/invalid. */
export function readServePort(): number | null {
  try {
    const raw = readFileSync(servePortPath(), 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * POST /_api/shutdown to a running `lazybrain serve` and wait for it to close.
 * Returns 'stopped' if the request succeeded, 'no-server' if nothing is running,
 * or 'error:<message>' on unexpected failure.
 */
export async function stopServe(
  timeoutMs = 3000,
): Promise<'stopped' | 'no-server' | `error:${string}`> {
  const port = readServePort();
  if (!port) return 'no-server';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`http://127.0.0.1:${port}/_api/shutdown`, {
      method: 'POST',
      signal: controller.signal,
    });
    return 'stopped';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('aborted') || msg.includes('fetch failed')) {
      return 'stopped';
    }
    return `error:${msg}`;
  } finally {
    clearTimeout(timer);
    cleanServeFiles();
  }
}
