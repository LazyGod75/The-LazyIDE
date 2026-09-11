/**
 * serve-cors.test.ts — CORS headers + preflight OPTIONS handling on the
 * sidecar HTTP server.
 *
 * Regression test for the Brain Wiki tab being permanently empty in the
 * desktop app: the WebView frontend (origin `http://tauri.localhost`)
 * fetches /_api/tree and /_api/synthesis/index directly, and the browser's
 * CORS preflight (OPTIONS, no Authorization header) was hitting checkAuth
 * first and getting a bare 401 with no CORS headers — so the browser
 * reported "blocked by CORS policy" and the real request never went out.
 *
 * Two layers:
 *  - Pure unit tests for isAllowedOrigin() (fast, exhaustive over the
 *    allowed-origin patterns).
 *  - Integration tests against a REAL server (mirrors serve-routes.test.ts)
 *    proving the actual request-handling order: CORS headers must be set
 *    and OPTIONS must short-circuit BEFORE auth runs.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAllowedOrigin } from '../../server/cors.js';

// ---------------------------------------------------------------------------
// Pure unit tests — isAllowedOrigin()
// ---------------------------------------------------------------------------

describe('isAllowedOrigin', () => {
  it('allows the exact WebView origin used on Windows/Linux', () => {
    expect(isAllowedOrigin('http://tauri.localhost')).toBe(true);
  });

  it('allows the https and custom-scheme tauri origin variants', () => {
    expect(isAllowedOrigin('https://tauri.localhost')).toBe(true);
    expect(isAllowedOrigin('tauri://localhost')).toBe(true);
  });

  it('allows localhost and 127.0.0.1 dev origins, with or without a port', () => {
    expect(isAllowedOrigin('http://localhost')).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4242')).toBe(true);
  });

  it('rejects unrelated origins', () => {
    expect(isAllowedOrigin('http://evil.com')).toBe(false);
    expect(isAllowedOrigin('https://tauri.localhost.evil.com')).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1.evil.com')).toBe(false);
  });

  it('rejects missing origin', () => {
    expect(isAllowedOrigin(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real server, real request-handling order
// ---------------------------------------------------------------------------

vi.mock('../../indexer/fts.js', () => ({
  listAll: vi.fn(() => []),
  listAllReadonly: vi.fn(() => []),
  countAllNotes: vi.fn(() => 0),
  embedNotesForIndex: vi.fn(async () => {}),
}));

vi.mock('../../graph/backlinks.js', () => ({
  loadBacklinks: vi.fn(() => null),
}));

const TOKEN = 'testtok123';

function request(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let tmpDir: string;
let brainDir: string;
let port: number;
let server: Server | undefined;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lazybrain-cors-test-'));
  brainDir = join(tmpDir, 'brain');
  mkdirSync(join(brainDir, 'notes'), { recursive: true });
  mkdirSync(join(brainDir, 'knowledge-nodes'), { recursive: true });
  mkdirSync(join(brainDir, '_cache'), { recursive: true });

  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  process.env.LAZYBRAIN_CACHE_PATH = join(brainDir, '_cache');

  const { resetConfigForTests } = await import('../../util/config.js');
  resetConfigForTests();

  const { runServe } = await import('../serve.js');
  server = await runServe({ port: 0, bind: '127.0.0.1', token: TOKEN });
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((res) => {
    if (server) {
      server.close(() => res());
      server = undefined;
    } else {
      res();
    }
  });

  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  rmSync(tmpDir, { recursive: true, force: true });

  const { resetConfigForTests } = await import('../../util/config.js');
  resetConfigForTests();
});

describe('CORS preflight (OPTIONS) — must short-circuit before auth', () => {
  it('returns 204 with CORS headers for an allowed origin, no Authorization needed', async () => {
    const { status, headers } = await request(`http://127.0.0.1:${port}/_api/tree`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://tauri.localhost',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(status).toBe(204);
    expect(headers['access-control-allow-origin']).toBe('http://tauri.localhost');
    expect(headers['access-control-allow-headers']).toMatch(/authorization/i);
    expect(headers['access-control-allow-methods']).toMatch(/GET/);
    expect(headers.vary).toBe('Origin');
  });

  it('does not echo Access-Control-Allow-Origin for a disallowed origin', async () => {
    const { status, headers } = await request(`http://127.0.0.1:${port}/_api/tree`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.com', 'Access-Control-Request-Method': 'GET' },
    });
    // OPTIONS still short-circuits to 204 (no route logic runs on it either
    // way), but crucially without an allow-origin header, so the browser
    // will refuse to send the real follow-up request.
    expect(status).toBe(204);
    expect(headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CORS headers on real requests', () => {
  it('GET with a valid token and allowed origin gets a 200 and the CORS header', async () => {
    const { status, headers } = await request(`http://127.0.0.1:${port}/_api/tree`, {
      headers: { Origin: 'http://tauri.localhost', Authorization: `Bearer ${TOKEN}` },
    });
    expect(status).toBe(200);
    expect(headers['access-control-allow-origin']).toBe('http://tauri.localhost');
  });

  it('GET with a disallowed origin gets no CORS header even with a valid token', async () => {
    const { status, headers } = await request(`http://127.0.0.1:${port}/_api/tree`, {
      headers: { Origin: 'http://evil.com', Authorization: `Bearer ${TOKEN}` },
    });
    expect(status).toBe(200);
    expect(headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a 401 (missing/invalid Authorization) still carries the CORS header for an allowed origin', async () => {
    // This is the crux of the original bug: without the fix, checkAuth ran
    // before any CORS header was set, so this response reached the browser
    // as an unreadable CORS failure rather than a readable 401.
    const { status, headers } = await request(`http://127.0.0.1:${port}/_api/tree`, {
      headers: { Origin: 'http://tauri.localhost' }, // no Authorization
    });
    expect(status).toBe(401);
    expect(headers['access-control-allow-origin']).toBe('http://tauri.localhost');
  });
});
