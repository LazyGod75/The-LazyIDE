#!/usr/bin/env node
/**
 * LazyBrain hook shim for Mistral Vibe (post_agent_turn).
 *
 * Declared in hooks.toml as:
 *   [[hooks]]
 *   name = "lazybrain-capture"
 *   type = "post_agent_turn"
 *   command = "node \"<abs path to this file>\""
 *   timeout = 15.0
 *
 * Reads Vibe's HookInvocation JSON from stdin:
 *   { session_id, transcript_path, cwd, hook_event_name }
 * and POSTs it to the LazyBrain daemon /capture-vibe endpoint.
 *
 * IRON RULES (Vibe exit-code protocol):
 *  - NEVER write to stdout: exit code 2 + stdout would be re-injected into the
 *    conversation as a user message and retried up to 3 times.
 *  - ALWAYS exit 0, even on errors. Diagnostics go to stderr only.
 *
 * Env:
 *   LAZYBRAIN_PORT                       daemon port (default 37788)
 *   LAZYBRAIN_VIBE_HOOK_ASSUME_DAEMON=1  skip health check/spawn (tests)
 *   LAZYBRAIN_VIBE_HOOK_NO_SPAWN=1       never spawn the daemon (tests)
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const PORT = Number(process.env.LAZYBRAIN_PORT ?? '37788');
const TIMEOUT_MS = Number(process.env.LAZYBRAIN_HTTP_TIMEOUT ?? '8') * 1000;

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const LB_REPO = join(HOOK_DIR, '..', '..', '..');
const DIST_ENTRY = join(LB_REPO, 'dist', 'bin', 'lazybrain.js');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 300);
  });
}

function httpPost(url, body, timeoutMs) {
  return new Promise((resolve) => {
    const buf = Buffer.from(body, 'utf8');
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': buf.length },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      },
    );
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.write(buf);
    req.end();
  });
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureDaemon() {
  if (process.env.LAZYBRAIN_VIBE_HOOK_ASSUME_DAEMON === '1') return;
  const healthUrl = `http://127.0.0.1:${PORT}/health`;
  if (await httpGet(healthUrl, 1000)) return;
  if (process.env.LAZYBRAIN_VIBE_HOOK_NO_SPAWN === '1') return;
  if (!existsSync(DIST_ENTRY)) return;
  const child = spawn(
    process.execPath,
    [DIST_ENTRY, 'daemon', 'start', '--foreground', '--port', String(PORT)],
    { detached: true, stdio: 'ignore', cwd: LB_REPO },
  );
  child.unref();
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    if (await httpGet(healthUrl, 1000)) return;
  }
}

async function main() {
  const payload = await readStdin();
  let parsed = {};
  try {
    parsed = JSON.parse(payload || '{}');
  } catch {
    /* ignore */
  }
  const transcriptPath = parsed.transcript_path ?? '';
  if (!transcriptPath) return; // session logging disabled — nothing to do

  await ensureDaemon();
  const body = JSON.stringify({
    transcript_path: transcriptPath,
    cwd: parsed.cwd ?? '',
    session_id: parsed.session_id ?? '',
  });
  await httpPost(`http://127.0.0.1:${PORT}/capture-vibe`, body, TIMEOUT_MS);
}

main()
  .catch((err) => {
    process.stderr.write(`lazybrain vibe-hook: ${err?.message ?? err}\n`);
  })
  .finally(() => process.exit(0));
