#!/usr/bin/env node
/**
 * LazyBrain hook dispatcher — cross-platform Node.js dispatcher.
 *
 * Default dispatcher for all platforms (Windows, macOS, Linux).
 * No bash, no curl — pure Node.js built-ins, zero extra dependencies.
 * _run.sh is kept as a legacy fallback for users who explicitly prefer bash.
 *
 * Usage: node _run.mjs <event-name>
 * Reads the Claude Code JSON payload from stdin, POSTs to the daemon, prints
 * hookSpecificOutput JSON when a context injection is returned.
 */

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const EVENT = process.argv[2] ?? '';
const PORT = Number(process.env.LAZYBRAIN_PORT ?? '37788');
const TIMEOUT_MS = Number(process.env.LAZYBRAIN_HTTP_TIMEOUT ?? '4') * 1000;

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const LB_REPO = join(HOOK_DIR, '..', '..', '..');
const DIST_ENTRY = join(LB_REPO, 'dist', 'bin', 'lazybrain.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read all of stdin as a string. */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    // If stdin has no data (e.g. empty pipe), resolve after a short grace period.
    setTimeout(() => resolve(data), 200);
  });
}

/** HTTP POST via Node's built-in http module (no external deps). */
function httpPost(url, body, timeoutMs) {
  return new Promise((resolve) => {
    const bodyBuf = Buffer.from(body, 'utf8');
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': bodyBuf.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(''); });
    req.write(bodyBuf);
    req.end();
  });
}

/** Lightweight GET to check daemon health. */
function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

/** Sleep for ms milliseconds. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Auto-build dist if missing (first run or after git pull). */
function ensureBuilt() {
  if (!existsSync(DIST_ENTRY)) {
    spawnSync('npm', ['run', 'build'], { cwd: LB_REPO, stdio: 'ignore', shell: true });
  }
}

/** Spawn the daemon detached (fire-and-forget). */
function spawnDaemon() {
  const child = spawn(
    process.execPath,
    [DIST_ENTRY, 'daemon', 'start', '--foreground', '--port', String(PORT)],
    { detached: true, stdio: 'ignore', cwd: LB_REPO },
  );
  child.unref();
}

/** Wait up to 6 s for the daemon to become healthy. */
async function waitForDaemon() {
  const healthUrl = `http://127.0.0.1:${PORT}/health`;
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    if (await httpGet(healthUrl, 1000)) return true;
  }
  return false;
}

/** Ensure the daemon is running, starting it if needed. */
async function ensureDaemon() {
  const healthUrl = `http://127.0.0.1:${PORT}/health`;
  if (await httpGet(healthUrl, 1000)) return;
  ensureBuilt();
  spawnDaemon();
  await waitForDaemon();
}

/**
 * Spawn an incremental index update in the background, fully detached.
 * Does not block the current process.
 *
 * Uses `index-update` (SHA/mtime fingerprint diff) rather than `index-rebuild`
 * (full scan) — on a 1000-note brain this typically touches < 10 notes and
 * finishes in seconds instead of minutes.
 */
function spawnIndexRebuildDetached() {
  if (!existsSync(DIST_ENTRY)) return;
  const child = spawn(
    process.execPath,
    [DIST_ENTRY, 'index-update'],
    { detached: true, stdio: 'ignore', cwd: LB_REPO },
  );
  child.unref();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!EVENT) process.exit(0);

  await ensureDaemon();

  const BASE_URL = `http://127.0.0.1:${PORT}`;
  const payload = await readStdin();

  let cwd = '';
  let sessionId = 'unknown';
  try {
    const parsed = JSON.parse(payload || '{}');
    cwd = parsed.cwd ?? '';
    sessionId = parsed.session_id ?? 'unknown';
  } catch { /* ignore parse errors */ }
  if (!cwd) cwd = process.cwd();

  const jsonEscape = (s) => JSON.stringify(s);

  switch (EVENT) {
    case 'session-start': {
      // Auto-start the wiki serve (port 4242) — fire-and-forget.
      const servePort = Number(process.env.LAZYBRAIN_SERVE_PORT ?? '4242');
      httpGet(`http://127.0.0.1:${servePort}/`, 1000).then((ok) => {
        if (!ok && existsSync(DIST_ENTRY)) {
          const c = spawn(process.execPath, [DIST_ENTRY, 'serve', '--port', String(servePort)], {
            detached: true,
            stdio: 'ignore',
          });
          c.unref();
        }
      });

      const mode = process.env.LAZYBRAIN_INJECT_MODE ?? 'highlights';
      let body;
      switch (mode) {
        case 'marker':  body = `{"mode":"marker","cwd":${jsonEscape(cwd)}}`; break;
        case 'compact': body = `{"mode":"session","format":"compact","max_tokens":2000,"cwd":${jsonEscape(cwd)}}`; break;
        case 'full':    body = `{"mode":"session","format":"full","max_tokens":3000,"cwd":${jsonEscape(cwd)}}`; break;
        default:        body = `{"mode":"highlights","cwd":${jsonEscape(cwd)}}`; break;
      }
      const ctx = await httpPost(`${BASE_URL}/inject-context`, body, TIMEOUT_MS);
      if (ctx) {
        process.stdout.write(
          `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":${jsonEscape(ctx)}}}`,
        );
      }
      break;
    }

    case 'user-prompt-submit': {
      let prompt = '';
      try { prompt = JSON.parse(payload || '{}').prompt ?? JSON.parse(payload || '{}').user_prompt ?? ''; } catch { /* */ }
      if (!prompt) process.exit(0);
      const body = `{"mode":"turn","query":${jsonEscape(prompt)},"max_tokens":500,"cwd":${jsonEscape(cwd)},"session_id":${jsonEscape(sessionId)}}`;
      const ctx = await httpPost(`${BASE_URL}/inject-context`, body, TIMEOUT_MS);
      if (ctx) {
        process.stdout.write(
          `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":${jsonEscape(ctx)}}}`,
        );
      }
      break;
    }

    case 'post-tool-use': {
      const body = `{"raw":${jsonEscape(payload)},"session":${jsonEscape(sessionId)},"async":true}`;
      await httpPost(`${BASE_URL}/capture`, body, 2000);
      break;
    }

    case 'pre-compact': {
      await httpPost(`${BASE_URL}/capture`, '{"flush_sync":true}', 15000);
      break;
    }

    case 'stop': {
      // FAST PATH: persist captured conversation so nothing is lost.
      // Bounded timeout so end-of-turn is never delayed.
      await httpPost(`${BASE_URL}/capture`, '{"flush_sync":true}', 8000);

      // Heavy work (graph rebuild, wiki synthesis, compression) MUST NOT block
      // end-of-turn. Everything below is debounced via marker files and spawned
      // fully detached so the user's session ends instantly.
      const brainPath = process.env.LAZYBRAIN_BRAIN_PATH;
      if (brainPath) {
        const cacheDir = join(dirname(brainPath), '_cache');
        try { mkdirSync(cacheDir, { recursive: true }); } catch { /* */ }

        const nowEpoch = Math.floor(Date.now() / 1000);

        // Light incremental refresh: at most once per LAZYBRAIN_REFRESH_SECONDS
        // (default 900 = 15 min). Runs fully detached; never blocks the turn.
        const refreshInterval = Number(process.env.LAZYBRAIN_REFRESH_SECONDS ?? '900');
        const refreshMark = join(cacheDir, 'last-refresh.txt');
        let lastRefresh = 0;
        try { lastRefresh = Number(readFileSync(refreshMark, 'utf8').trim()) || 0; } catch { /* */ }
        if (nowEpoch - lastRefresh >= refreshInterval) {
          try { writeFileSync(refreshMark, String(nowEpoch), 'utf8'); } catch { /* */ }
          // Fire-and-forget via the daemon; does not block.
          httpPost(`${BASE_URL}/graph`, '{}', 180000).catch(() => {});
        }

        // Weekly deep maintenance (purge-noise + synthesize + compress) in one
        // daemon call, gated to fire at most once per ~7 days, also detached.
        const maintenanceMark = join(cacheDir, 'last-maintenance.txt');
        let lastMaintenance = 0;
        try { lastMaintenance = Number(readFileSync(maintenanceMark, 'utf8').trim()) || 0; } catch { /* */ }
        if (nowEpoch - lastMaintenance >= 7 * 86400) {
          try { writeFileSync(maintenanceMark, String(nowEpoch), 'utf8'); } catch { /* */ }
          httpPost(`${BASE_URL}/maintenance`, '{}', 300000).catch(() => {});
        }
      }

      // Incremental index update: spawned detached so it never blocks the user.
      // The Stop hook timeout (15 s) covers only the fast capture path above;
      // index-update runs fully asynchronously and is not bounded by that limit.
      spawnIndexRebuildDetached();

      // Optional Haiku batch extraction (opt-in), fully detached.
      if (process.env.LAZYBRAIN_EXTRACTOR === 'haiku') {
        httpPost(`${BASE_URL}/extract`, '{"batch_size":10}', 30000).catch(() => {});
      }
      break;
    }

    default:
      process.exit(0);
  }
}

main().catch(() => process.exit(0));
