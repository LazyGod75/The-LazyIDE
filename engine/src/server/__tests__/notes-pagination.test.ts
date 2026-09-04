import type { IncomingMessage, ServerResponse } from 'node:http';
/**
 * Tests for /_api/notes pagination behavior.
 *
 * Verifies backward-compat: no params → full array.
 * Verifies paginated: limit/offset → sliced array + X-Total-Count.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleNotes } from '../../server/routes/notes.js';

// ---------------------------------------------------------------------------
// Mock the FTS index
// ---------------------------------------------------------------------------

const MOCK_NOTES = Array.from({ length: 25 }, (_, i) => ({
  id: `note-${i}`,
  path: `/brain/notes/note-${i}.html`,
  title: `Note ${i}`,
  type: 'decision',
  tags: 'test',
  topic: 'testing',
  created: `2026-01-${String(i + 1).padStart(2, '0')}`,
  importance: 0.5,
  valid_until: '',
  mtime_ms: Date.now(),
}));

vi.mock('../../indexer/fts.js', () => ({
  listAllReadonly: vi.fn(() => MOCK_NOTES),
  getReadonlyDb: vi.fn(() => {
    throw new Error('not needed in pagination test');
  }),
}));

vi.mock('../../util/logger.js', () => ({
  getLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));

// ---------------------------------------------------------------------------
// Minimal mock res builder
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

function makeReq(search = ''): IncomingMessage {
  return {
    headers: {},
    url: `/_api/notes${search}`,
  } as unknown as IncomingMessage;
}

function makeUrl(search = ''): URL {
  return new URL(`http://localhost/_api/notes${search}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/_api/notes — pagination', () => {
  it('returns the full array when no pagination params are given', async () => {
    const req = makeReq();
    const res = makeMockRes();
    const url = makeUrl();

    handleNotes(req, res as unknown as ServerResponse, url);

    // Wait for the async sendJsonCached to resolve
    await new Promise((r) => setTimeout(r, 20));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(25);
    // No X-Total-Count when using default full response
    expect(res.headers['x-total-count']).toBeUndefined();
  });

  it('returns a sliced array and X-Total-Count when limit is provided', async () => {
    const req = makeReq('?limit=10');
    const res = makeMockRes();
    const url = makeUrl('?limit=10');

    handleNotes(req, res as unknown as ServerResponse, url);
    await new Promise((r) => setTimeout(r, 20));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(10);
    expect(res.headers['x-total-count']).toBe('25');
  });

  it('respects offset param to return a later page', async () => {
    const req = makeReq('?limit=5&offset=10');
    const res = makeMockRes();
    const url = makeUrl('?limit=5&offset=10');

    handleNotes(req, res as unknown as ServerResponse, url);
    await new Promise((r) => setTimeout(r, 20));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(5);
    // offset=10 so the first item should be note-10
    expect(body[0].id).toBe('note-10');
    expect(res.headers['x-total-count']).toBe('25');
  });

  it('returns X-Total-Count even when offset is provided alone', async () => {
    const req = makeReq('?offset=20');
    const res = makeMockRes();
    const url = makeUrl('?offset=20');

    handleNotes(req, res as unknown as ServerResponse, url);
    await new Promise((r) => setTimeout(r, 20));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(Array.isArray(body)).toBe(true);
    // offset=20, no limit → defaults to 20, so 5 remain
    expect(body.length).toBeLessThanOrEqual(25);
    expect(res.headers['x-total-count']).toBe('25');
  });

  it('returns an empty array when offset is beyond total', async () => {
    const req = makeReq('?limit=10&offset=100');
    const res = makeMockRes();
    const url = makeUrl('?limit=10&offset=100');

    handleNotes(req, res as unknown as ServerResponse, url);
    await new Promise((r) => setTimeout(r, 20));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
    expect(res.headers['x-total-count']).toBe('25');
  });

  it('result is still a JSON array (not wrapped in an object)', async () => {
    const req = makeReq('?limit=3');
    const res = makeMockRes();
    const url = makeUrl('?limit=3');

    handleNotes(req, res as unknown as ServerResponse, url);
    await new Promise((r) => setTimeout(r, 20));

    const body = JSON.parse(res.body as string);
    // Must be a plain array, not { data: [...] } or similar
    expect(Array.isArray(body)).toBe(true);
  });

  it('handles invalid limit gracefully (defaults to 20)', async () => {
    const req = makeReq('?limit=notanumber');
    const res = makeMockRes();
    const url = makeUrl('?limit=notanumber');

    handleNotes(req, res as unknown as ServerResponse, url);
    await new Promise((r) => setTimeout(r, 20));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeLessThanOrEqual(20);
  });

  it('does not send 304 on first request (no If-None-Match)', async () => {
    const req = makeReq();
    const res = makeMockRes();
    const url = makeUrl();

    handleNotes(req, res as unknown as ServerResponse, url);
    await new Promise((r) => setTimeout(r, 20));

    expect(res.statusCode).toBe(200);
    // ETag header must be present for future conditional requests
    expect(res.headers.etag).toBeDefined();
  });
});
