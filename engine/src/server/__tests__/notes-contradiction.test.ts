import type { IncomingMessage, ServerResponse } from 'node:http';
/**
 * Tests for the contradiction-detection signal serialized by the notes routes.
 *
 * Verifies that /_api/note-meta/:id and /_api/notes expose `saliencyKind` and
 * `conflictWith` (parsed from the DB `saliency_kind` / `conflict_with` columns
 * written by graph/contradictions.ts + indexer/note-index.ts). Without this the
 * frontend wiki view can never render a contradiction warning.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleNoteMeta, handleNotes } from '../../server/routes/notes.js';

// ---------------------------------------------------------------------------
// Mock the FTS index — one note that conflicts with another, one that does not
// ---------------------------------------------------------------------------

const CONFLICTING_NOTE = {
  id: 'note-sqlite',
  path: '/brain/notes/note-sqlite.html',
  title: 'Decision: switch to SQLite',
  type: 'decision',
  tags: 'database decision',
  topic: 'backend',
  created: '2026-07-04',
  importance: 0.6,
  valid_until: '',
  mtime_ms: Date.now(),
  saliency_kind: 'contradiction',
  conflict_with: 'note-postgres,note-mysql',
};

const PLAIN_NOTE = {
  id: 'note-plain',
  path: '/brain/notes/note-plain.html',
  title: 'A note with no contradiction',
  type: 'reference',
  tags: 'misc',
  topic: null,
  created: '2026-07-03',
  importance: 0.5,
  valid_until: '',
  mtime_ms: Date.now(),
  saliency_kind: null,
  conflict_with: null,
};

vi.mock('../../indexer/fts.js', () => ({
  listAllReadonly: vi.fn(() => [CONFLICTING_NOTE, PLAIN_NOTE]),
  getReadonlyDb: vi.fn(() => {
    throw new Error('not needed in this test');
  }),
}));

vi.mock('../../util/logger.js', () => ({
  getLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));

// ---------------------------------------------------------------------------
// Minimal mock res builder (same shape as notes-pagination.test.ts)
// ---------------------------------------------------------------------------

type MockRes = {
  statusCode: number;
  headers: Record<string, string>;
  body: string | Buffer | null;
  writeHead: (status: number, h?: Record<string, string>) => void;
  end: (data?: string | Buffer) => void;
};

function makeMockRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    headers: {},
    body: null,
    writeHead(status, h = {}) {
      this.statusCode = status;
      Object.assign(this.headers, h);
    },
    end(data) {
      this.body = data ?? null;
    },
  };
  return res;
}

function makeReq(url: string): IncomingMessage {
  return { headers: {}, url } as unknown as IncomingMessage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/_api/note-meta — contradiction signal', () => {
  it('serializes saliencyKind and conflictWith (as an id array) for a conflicting note', () => {
    const res = makeMockRes();
    handleNoteMeta(makeReq('/_api/note-meta/note-sqlite'), res as unknown as ServerResponse, 'note-sqlite');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(body.saliencyKind).toBe('contradiction');
    expect(body.conflictWith).toEqual(['note-postgres', 'note-mysql']);
  });

  it('returns saliencyKind null and an empty conflictWith array for a plain note', () => {
    const res = makeMockRes();
    handleNoteMeta(makeReq('/_api/note-meta/note-plain'), res as unknown as ServerResponse, 'note-plain');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(body.saliencyKind).toBeNull();
    expect(body.conflictWith).toEqual([]);
  });
});

describe('/_api/notes — contradiction signal', () => {
  it('includes saliencyKind and conflictWith on each listed note', async () => {
    const res = makeMockRes();
    handleNotes(
      makeReq('/_api/notes'),
      res as unknown as ServerResponse,
      new URL('http://localhost/_api/notes'),
    );
    // handleNotes serializes via the async sendJsonCached path.
    await new Promise((r) => setTimeout(r, 20));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string) as Array<{
      id: string;
      saliencyKind: string | null;
      conflictWith: string[];
    }>;
    const sqlite = body.find((n) => n.id === 'note-sqlite');
    const plain = body.find((n) => n.id === 'note-plain');
    expect(sqlite?.saliencyKind).toBe('contradiction');
    expect(sqlite?.conflictWith).toEqual(['note-postgres', 'note-mysql']);
    expect(plain?.saliencyKind).toBeNull();
    expect(plain?.conflictWith).toEqual([]);
  });
});
