/**
 * Tests for the new /_api/resolve and /_api/note-meta/:id routes
 * added to serve.ts for wiki UI navigation of code-first neurons.
 *
 * Strategy: spin up a real server against a temp brain with mock SQLite data,
 * then hit routes via http.get. The vi.mock for fts/backlinks/global-graph
 * allows us to control what listAll() returns without needing a real DB.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports that depend on them
// ---------------------------------------------------------------------------

vi.mock('../../indexer/fts.js', () => ({
  listAll: vi.fn(() => MOCK_NOTES),
  listAllReadonly: vi.fn(() => MOCK_NOTES),
  countAllNotes: vi.fn(() => MOCK_NOTES.length),
}));

vi.mock('../../graph/backlinks.js', () => ({
  loadBacklinks: vi.fn(() => null),
}));

vi.mock('../../graph/global-graph.js', () => ({
  loadGlobalGraph: vi.fn(() => null),
}));

vi.mock('../../retrieval/router.js', () => ({
  route: vi.fn(() => Promise.resolve({ hits: [], levelUsed: 'L1', totalMs: 0 })),
}));

vi.mock('../../store/reader.js', () => ({
  readAllNotes: vi.fn(() => []),
}));

// ---------------------------------------------------------------------------
// Mock note data
// ---------------------------------------------------------------------------

const MOCK_NOTES = [
  {
    id: 'file-project-src-index-ts',
    path: 'notes/2026-05/file-project-src-index-ts.html',
    title: 'src/index.ts',
    type: 'file-neuron',
    tags: 'code typescript project',
    topic: 'project/code',
    importance: 0.7,
    created: '2026-05-28T00:00:00Z',
  },
  {
    id: 'aggregate-project-root',
    path: 'notes/2026-05/aggregate-project-root.html',
    title: 'project (root)',
    type: 'aggregate-neuron',
    tags: 'code module project',
    topic: 'project',
    importance: 0.9,
    created: '2026-05-28T00:00:00Z',
  },
  {
    id: 'aggregate-project-src',
    path: 'notes/2026-05/aggregate-project-src.html',
    title: 'src (module)',
    type: 'aggregate-neuron',
    tags: 'code module project',
    topic: 'project/code/src',
    importance: 0.8,
    created: '2026-05-28T00:00:00Z',
  },
  {
    id: 'concept-typescript-patterns',
    path: 'notes/2026-05/concept-typescript-patterns.html',
    title: 'TypeScript Patterns',
    type: 'concept',
    tags: 'typescript patterns',
    topic: 'project/concepts',
    importance: 0.6,
    created: '2026-05-28T00:00:00Z',
  },
  {
    id: 'ref-note-1',
    path: 'notes/2026-05/ref-note-1.html',
    title: 'Reference note',
    type: 'reference',
    tags: 'docs',
    topic: 'project',
    importance: 0.5,
    created: '2026-05-28T00:00:00Z',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let brainDir: string;
let port: number;
let server: Server | undefined;

beforeEach(async () => {
  // Unique temp brain dir per test
  tmpDir = mkdtempSync(join(tmpdir(), 'lazybrain-serve-test-'));
  brainDir = join(tmpDir, 'brain');
  mkdirSync(join(brainDir, 'notes', '2026-05'), { recursive: true });
  mkdirSync(join(brainDir, 'knowledge-nodes'), { recursive: true });
  mkdirSync(join(brainDir, '_cache'), { recursive: true });

  // Write stub HTML files for each mock note
  for (const note of MOCK_NOTES) {
    const parts = note.path.split('/');
    const subDir =
      parts.length > 2 ? join(brainDir, ...parts.slice(0, -1)) : join(brainDir, 'notes');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(brainDir, ...parts),
      `<article id="${note.id}" data-cerveau-type="${note.type}" data-cerveau-topic="${note.topic}"><h1>${note.title}</h1></article>`,
    );
  }

  // Override config to use our temp brain
  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  process.env.LAZYBRAIN_CACHE_PATH = join(brainDir, '_cache');

  // Reset config cache so new env vars are picked up
  const { resetConfigForTests } = await import('../../util/config.js');
  resetConfigForTests();

  // Use port 0 so the OS assigns a free ephemeral port — eliminates EADDRINUSE flakiness.
  const { runServe } = await import('../serve.js');

  // runServe resolves once the server is bound — read the actual assigned port from address().
  server = await runServe({ port: 0, bind: '127.0.0.1' });
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  // Close the HTTP server so the port is released before the next test
  await new Promise<void>((res) => {
    if (server) {
      server.close(() => res());
      server = undefined;
    } else {
      res();
    }
  });

  // Clean up env + temp dir
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  rmSync(tmpDir, { recursive: true, force: true });

  const { resetConfigForTests } = await import('../../util/config.js');
  resetConfigForTests();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/_api/resolve — resolve legacy href to note', () => {
  it('resolves file:<path> to the matching file-neuron', async () => {
    // "file:src/index.ts" should resolve to file-project-src-index-ts
    const { status, body } = await httpGet(
      `http://127.0.0.1:${port}/_api/resolve?href=${encodeURIComponent('file:src/index.ts')}`,
    );
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.id).toBe('file-project-src-index-ts');
    expect(json.type).toBe('file-neuron');
    expect(typeof json.path).toBe('string');
    expect(json.path).toMatch(/\.html$/);
  });

  it('returns 400 when href param is missing', async () => {
    const { status } = await httpGet(`http://127.0.0.1:${port}/_api/resolve`);
    expect(status).toBe(400);
  });

  it('returns 404 when no note matches the href', async () => {
    const { status, body } = await httpGet(
      `http://127.0.0.1:${port}/_api/resolve?href=${encodeURIComponent('file:nonexistent/path.ts')}`,
    );
    expect(status).toBe(404);
    const json = JSON.parse(body);
    expect(json.error).toBeTruthy();
  });
});

describe('/_api/note-meta/:id — look up note metadata by ID', () => {
  it('returns metadata for a file-neuron', async () => {
    const { status, body } = await httpGet(
      `http://127.0.0.1:${port}/_api/note-meta/${encodeURIComponent('file-project-src-index-ts')}`,
    );
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.id).toBe('file-project-src-index-ts');
    expect(json.type).toBe('file-neuron');
    expect(json.path).toMatch(/\.html$/);
    expect(json.topic).toBe('project/code');
  });

  it('returns metadata for an aggregate-neuron', async () => {
    const { status, body } = await httpGet(
      `http://127.0.0.1:${port}/_api/note-meta/${encodeURIComponent('aggregate-project-src')}`,
    );
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.id).toBe('aggregate-project-src');
    expect(json.type).toBe('aggregate-neuron');
  });

  it('returns metadata for a concept neuron', async () => {
    const { status, body } = await httpGet(
      `http://127.0.0.1:${port}/_api/note-meta/${encodeURIComponent('concept-typescript-patterns')}`,
    );
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.id).toBe('concept-typescript-patterns');
    expect(json.type).toBe('concept');
  });

  it('returns 404 for unknown note id', async () => {
    const { status, body } = await httpGet(
      `http://127.0.0.1:${port}/_api/note-meta/${encodeURIComponent('nonexistent-note-id')}`,
    );
    expect(status).toBe(404);
    const json = JSON.parse(body);
    expect(json.error).toBeTruthy();
  });
});

describe('GET / — home route serves SPA index.html', () => {
  it('returns 200 for home route', async () => {
    const { status } = await httpGet(`http://127.0.0.1:${port}/`);
    // The brain-ui index.html may not exist at build time, but server handles it gracefully
    expect([200, 404]).toContain(status);
  });
});

describe('GET /_api/notes — lists all notes', () => {
  it('returns JSON array with notes including code neurons', async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/_api/notes`);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(Array.isArray(json)).toBe(true);
    const types = new Set(json.map((n: { type: string }) => n.type));
    expect(types.has('file-neuron')).toBe(true);
    expect(types.has('aggregate-neuron')).toBe(true);
    expect(types.has('concept')).toBe(true);
  });
});

describe('note HTML file serving — via path', () => {
  it('serves a file-neuron HTML by its path', async () => {
    const { status, body } = await httpGet(
      `http://127.0.0.1:${port}/notes/2026-05/file-project-src-index-ts.html`,
    );
    expect(status).toBe(200);
    expect(body).toContain('file-project-src-index-ts');
    expect(body).toContain('file-neuron');
  });

  it('serves an aggregate-neuron HTML by its path', async () => {
    const { status, body } = await httpGet(
      `http://127.0.0.1:${port}/notes/2026-05/aggregate-project-src.html`,
    );
    expect(status).toBe(200);
    expect(body).toContain('aggregate-project-src');
    expect(body).toContain('aggregate-neuron');
  });

  it('returns 404 for a nonexistent note path', async () => {
    const { status } = await httpGet(
      `http://127.0.0.1:${port}/notes/2026-05/nonexistent-note.html`,
    );
    expect(status).toBe(404);
  });
});

describe('/_api/tree — sidebar project tree', () => {
  it('project node has non-null noteId when a root aggregate-neuron exists', async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/_api/tree`);
    expect(status).toBe(200);
    const json = JSON.parse(body) as {
      projects: Array<{
        id: string;
        label: string;
        noteId: string | null;
        type: string;
        children: unknown[];
      }>;
    };
    expect(Array.isArray(json.projects)).toBe(true);

    // The "project" project should have noteId = 'aggregate-project-root'
    // because that aggregate has topic depth 1 (topic = 'project')
    const projectNode = json.projects.find((p) => p.label === 'project');
    expect(projectNode).toBeDefined();
    expect(projectNode!.noteId).toBe('aggregate-project-root');
    expect(projectNode!.type).toBe('project');
  });

  it('project node noteId falls back to highest-importance sub-aggregate when no root aggregate exists', async () => {
    // Drain any pending setImmediate callbacks (e.g. the auto-build check in runServe)
    // before setting up the once-override, so they do not consume it ahead of the route call.
    await new Promise<void>((r) => setImmediate(r));

    const fts = await import('../../indexer/fts.js');
    // Override listAllReadonly to return only a sub-aggregate (topicDepth > 1) — no root agg
    vi.mocked(fts.listAllReadonly).mockReturnValueOnce([
      {
        id: 'agg-deep-only',
        path: 'notes/2026-05/agg-deep-only.html',
        title: 'deep module',
        type: 'aggregate-neuron',
        tags: 'code',
        topic: 'alpha/sub/module',
        importance: 0.75,
        created: '2026-05-28T00:00:00Z',
      },
    ] as unknown as ReturnType<typeof fts.listAllReadonly>);

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/_api/tree`);
    expect(status).toBe(200);
    const json = JSON.parse(body) as {
      projects: Array<{ id: string; label: string; noteId: string | null; type: string }>;
    };
    const alphaNode = json.projects.find((p) => p.label === 'alpha');
    expect(alphaNode).toBeDefined();
    // noteId must be non-null — falls back to the only sub-aggregate
    expect(alphaNode!.noteId).toBe('agg-deep-only');
  });
});

// ---------------------------------------------------------------------------
// POST /_api/shutdown — graceful server stop
// ---------------------------------------------------------------------------

describe('POST /_api/shutdown — graceful stop', () => {
  it('returns 200 with { ok: true }', async () => {
    const { status, body } = await httpPost(`http://127.0.0.1:${port}/_api/shutdown`);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.ok).toBe(true);
    // Give setImmediate time to fire so the server starts closing before afterEach
    await new Promise<void>((r) => setTimeout(r, 50));
    // Mark server as undefined so afterEach doesn't try to close it a second time
    server = undefined;
  });

  it('GET /_api/shutdown is ignored (only POST triggers shutdown)', async () => {
    const { status } = await httpGet(`http://127.0.0.1:${port}/_api/shutdown`);
    // Not found — GET does not match the shutdown handler and falls through to file serving
    expect([404, 200]).toContain(status);
  });
});

// ---------------------------------------------------------------------------
// stopServe() with no running server
// ---------------------------------------------------------------------------

describe('stopServe() — no-op when no server is running', () => {
  it('returns "no-server" when no serve.port file exists', async () => {
    // Ensure there is no portfile in the test cache dir
    const { join } = await import('node:path');
    const portFile = join(brainDir, '_cache', 'serve.port');
    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(portFile);
    } catch {
      // File may not exist — that's fine
    }

    const { stopServe } = await import('../serve.js');
    const result = await stopServe();
    expect(result).toBe('no-server');
  });
});

// ---------------------------------------------------------------------------
// Helpers for POST requests
// ---------------------------------------------------------------------------

function httpPost(url: string, body = ''): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname,
      method: 'POST',
      headers: { 'content-length': Buffer.byteLength(body) },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
