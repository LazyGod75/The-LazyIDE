import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
/**
 * serve-routes-recall.test.ts — /_api/recall (turn-mode scored recall over
 * the warm sidecar HTTP API).
 *
 * Strategy mirrors serve-routes.test.ts: spin up a REAL server against a
 * temp brain, hit routes via http.get. retrieval/router.js's route() is
 * mocked so the test controls exactly which hits/level come back, without
 * needing a populated FTS index or ONNX models (that real, non-mocked path
 * is covered separately by tests/inject-turn-real-brain.test.ts).
 *
 * This is the regression test for TASK 2's rewire: search.rs's
 * recall_from_warm_sidecar now calls this route instead of /_api/search, so
 * the per-turn assistant recall regains turn-mode's scoring/intent-routing/
 * budget/nudge pipeline instead of raw top-K snippets.
 */
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports that depend on them
// ---------------------------------------------------------------------------

vi.mock('../../indexer/fts.js', () => ({
  listAll: vi.fn(() => []),
  listAllReadonly: vi.fn(() => []),
  countAllNotes: vi.fn(() => 0),
  // serve.ts's boot-time auto-index-update path calls this when the index is
  // empty but note files exist — not under test here, stubbed to a no-op so
  // it doesn't log a spurious "mock export missing" warning.
  embedNotesForIndex: vi.fn(async () => {}),
}));

vi.mock('../../graph/backlinks.js', () => ({
  loadBacklinks: vi.fn(() => null),
}));

vi.mock('../../retrieval/router.js', () => ({
  route: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpGet(
  url: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

const MOCK_HIT_NOTE = {
  id: 'file-fixture-src-auth-ts',
  text: 'src/auth.ts — rotateRefreshToken, signAccessToken, validateSession',
  type: 'file-neuron' as const,
  created: '2026-07-03',
  tags: ['code', 'typescript'],
  facts: [],
  links: [],
};

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let brainDir: string;
let port: number;
let server: Server | undefined;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lazybrain-recall-route-test-'));
  brainDir = join(tmpDir, 'brain');
  // runServe's assertBrainExists guard requires <brain>/notes/ to exist —
  // mirrors serve-routes.test.ts's setup.
  mkdirSync(join(brainDir, 'notes'), { recursive: true });
  mkdirSync(join(brainDir, '_cache'), { recursive: true });

  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  process.env.LAZYBRAIN_CACHE_PATH = join(brainDir, '_cache');

  const { resetConfigForTests } = await import('../../util/config.js');
  resetConfigForTests();

  const { runServe } = await import('../serve.js');
  server = await runServe({ port: 0, bind: '127.0.0.1' });
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
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/_api/recall — turn-mode scored recall', () => {
  it('returns 400 when q is missing', async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/_api/recall`);
    expect(res.status).toBe(400);
  });

  it('returns scored, formatted text + level for a query that matches a hit', async () => {
    const { route } = await import('../../retrieval/router.js');
    vi.mocked(route).mockResolvedValue({
      hits: [
        {
          id: MOCK_HIT_NOTE.id,
          path: 'notes/2026-07/file-fixture-src-auth-ts.html',
          score: 0.9,
          level: 'L2',
          note: MOCK_HIT_NOTE,
        },
      ],
      levelUsed: 'L2',
      totalMs: 5,
    });

    const res = await httpGet(
      `http://127.0.0.1:${port}/_api/recall?q=${encodeURIComponent('how does auth work')}&cwd=${encodeURIComponent('/fixture-project')}`,
    );
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.text).not.toBe('');
    expect(json.text).toMatch(/auth/);
    expect(json.level).toBe('L2');
    expect(typeof json.tokens).toBe('number');
    expect(json.tokens).toBeGreaterThan(0);
    // Default nudge (no ?nudge= param) is 'skill' — matches the CLI default.
    expect(json.text).toMatch(/lazybrain-recall/i);
  });

  it('honors nudge=tool — the IDE always passes this explicitly', async () => {
    const { route } = await import('../../retrieval/router.js');
    vi.mocked(route).mockResolvedValue({
      hits: [
        {
          id: MOCK_HIT_NOTE.id,
          path: 'notes/2026-07/file-fixture-src-auth-ts.html',
          score: 0.9,
          level: 'L2',
          note: MOCK_HIT_NOTE,
        },
      ],
      levelUsed: 'L2',
      totalMs: 5,
    });

    const res = await httpGet(
      `http://127.0.0.1:${port}/_api/recall?q=${encodeURIComponent('how does auth work')}&nudge=tool`,
    );
    const json = JSON.parse(res.body);
    expect(json.text).toMatch(/brain_search|BRAIN_SEARCH/);
    expect(json.text).not.toMatch(/lazybrain-recall/i);
  });

  it('respects maxTokens', async () => {
    const { route } = await import('../../retrieval/router.js');
    vi.mocked(route).mockResolvedValue({
      hits: [
        {
          id: MOCK_HIT_NOTE.id,
          path: 'notes/2026-07/file-fixture-src-auth-ts.html',
          score: 0.9,
          level: 'L2',
          note: MOCK_HIT_NOTE,
        },
      ],
      levelUsed: 'L2',
      totalMs: 5,
    });

    const res = await httpGet(
      `http://127.0.0.1:${port}/_api/recall?q=${encodeURIComponent('how does auth work')}&maxTokens=500`,
    );
    const json = JSON.parse(res.body);
    expect(json.tokens).toBeLessThanOrEqual(500);
  });

  it('returns empty text (not an error) when route() finds nothing', async () => {
    const { route } = await import('../../retrieval/router.js');
    vi.mocked(route).mockResolvedValue({ hits: [], levelUsed: 'L2', totalMs: 3 });

    const res = await httpGet(
      `http://127.0.0.1:${port}/_api/recall?q=${encodeURIComponent('completely unrelated gibberish query')}`,
    );
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.text).toBe('');
  });

  // ── TASK 1 regression: "Queries (24h)" reads 0 despite real usage ───
  //
  // Root cause: every Rust spawn site for the warm sidecar daemon set
  // LAZYBRAIN_TELEMETRY=0 (src-tauri/src/commands/brain/sidecar/process.rs),
  // so `route()`/`runTurnInjectDetailed()` ran for real (recall genuinely
  // happened) but `logTelemetry()` no-op'd on every call — the counter was
  // never wired to the ONE process that answers live queries. Fixed by
  // flipping that env var to "1". The one exception is the sidecar's own
  // background warmup probe (warmup.rs's spawn_brain_recall_warmup, a
  // synthetic cache-priming call, not real user activity) — it now sends
  // `X-Lazy-Warmup: 1`, which this route reads to set `skipTelemetry` so the
  // counter is not inflated by the app's own bookkeeping. These two tests
  // cover that header contract at the HTTP boundary.

  function telemetryPath(): string {
    return join(brainDir, '_cache', 'telemetry.jsonl');
  }

  function readTelemetryEvents(): Array<{ event: string }> {
    if (!existsSync(telemetryPath())) return [];
    return readFileSync(telemetryPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string });
  }

  it('logs an inject telemetry event for a normal (non-warmup) recall request', async () => {
    const { route } = await import('../../retrieval/router.js');
    vi.mocked(route).mockResolvedValue({
      hits: [
        {
          id: MOCK_HIT_NOTE.id,
          path: 'notes/2026-07/file-fixture-src-auth-ts.html',
          score: 0.9,
          level: 'L2',
          note: MOCK_HIT_NOTE,
        },
      ],
      levelUsed: 'L2',
      totalMs: 5,
    });

    await httpGet(
      `http://127.0.0.1:${port}/_api/recall?q=${encodeURIComponent('how does auth work')}`,
    );

    const events = readTelemetryEvents();
    expect(events.some((e) => e.event === 'inject')).toBe(true);
  });

  it('does NOT log telemetry when the sidecar warmup probe sends X-Lazy-Warmup: 1', async () => {
    const { route } = await import('../../retrieval/router.js');
    vi.mocked(route).mockResolvedValue({
      hits: [
        {
          id: MOCK_HIT_NOTE.id,
          path: 'notes/2026-07/file-fixture-src-auth-ts.html',
          score: 0.9,
          level: 'L2',
          note: MOCK_HIT_NOTE,
        },
      ],
      levelUsed: 'L2',
      totalMs: 5,
    });

    await httpGet(
      `http://127.0.0.1:${port}/_api/recall?q=${encodeURIComponent('how does auth work')}`,
      { 'X-Lazy-Warmup': '1' },
    );

    // route() itself was called with skipTelemetry so its own 'query' event
    // (if it were the real, unmocked router) would also be suppressed.
    expect(vi.mocked(route).mock.calls[0]?.[0]).toMatchObject({ skipTelemetry: true });
    const events = readTelemetryEvents();
    expect(events.some((e) => e.event === 'inject' || e.event === 'query')).toBe(false);
  });
});
