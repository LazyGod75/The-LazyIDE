import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  IndexVersionedCache,
  acceptsGzip,
  computeETag,
  computeNotesFingerprint,
  handleConditionalGet,
  maybeGzip,
  sendJsonCached,
} from '../cache.js';

// ---------------------------------------------------------------------------
// Helpers to build minimal mock req/res objects
// ---------------------------------------------------------------------------

function makeMockReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers, url: '/' } as unknown as IncomingMessage;
}

type MockRes = {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer | string | null;
  writeHead: (status: number, h?: Record<string, string>) => void;
  end: (data?: Buffer | string) => void;
};

function makeMockRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    headers: {},
    body: null,
    writeHead(status: number, h: Record<string, string> = {}) {
      this.statusCode = status;
      Object.assign(this.headers, h);
    },
    end(data?: Buffer | string) {
      this.body = data ?? null;
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// computeETag
// ---------------------------------------------------------------------------

describe('computeETag', () => {
  it('returns a quoted string', () => {
    const etag = computeETag('hello world');
    expect(etag.startsWith('"')).toBe(true);
    expect(etag.endsWith('"')).toBe(true);
  });

  it('is stable (same input → same output)', () => {
    const body = JSON.stringify({ a: 1, b: [2, 3] });
    expect(computeETag(body)).toBe(computeETag(body));
  });

  it('differs for different bodies', () => {
    expect(computeETag('aaa')).not.toBe(computeETag('bbb'));
  });

  it('has 16 hex chars inside quotes', () => {
    const inner = computeETag('test').slice(1, -1);
    expect(inner).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(inner)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleConditionalGet
// ---------------------------------------------------------------------------

describe('handleConditionalGet', () => {
  it('returns false and does NOT send 304 when If-None-Match is absent', () => {
    const req = makeMockReq({});
    const res = makeMockRes();
    const result = handleConditionalGet(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      '"abc123"',
    );
    expect(result).toBe(false);
    expect(res.statusCode).toBe(0); // writeHead not called
  });

  it('sends 304 and returns true when If-None-Match matches ETag', () => {
    const etag = '"abc123def456789a"';
    const req = makeMockReq({ 'if-none-match': etag });
    const res = makeMockRes();
    const result = handleConditionalGet(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      etag,
    );
    expect(result).toBe(true);
    expect(res.statusCode).toBe(304);
  });

  it('sends 304 when If-None-Match is wildcard *', () => {
    const req = makeMockReq({ 'if-none-match': '*' });
    const res = makeMockRes();
    const result = handleConditionalGet(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      '"any"',
    );
    expect(result).toBe(true);
    expect(res.statusCode).toBe(304);
  });

  it('returns false when If-None-Match does not match', () => {
    const req = makeMockReq({ 'if-none-match': '"stale-tag"' });
    const res = makeMockRes();
    const result = handleConditionalGet(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      '"fresh-tag"',
    );
    expect(result).toBe(false);
    expect(res.statusCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// acceptsGzip
// ---------------------------------------------------------------------------

describe('acceptsGzip', () => {
  it('returns true when Accept-Encoding includes gzip', () => {
    const req = makeMockReq({ 'accept-encoding': 'gzip, deflate, br' });
    expect(acceptsGzip(req as IncomingMessage)).toBe(true);
  });

  it('returns false when Accept-Encoding is absent', () => {
    const req = makeMockReq({});
    expect(acceptsGzip(req as IncomingMessage)).toBe(false);
  });

  it('returns false when Accept-Encoding does not include gzip', () => {
    const req = makeMockReq({ 'accept-encoding': 'br, deflate' });
    expect(acceptsGzip(req as IncomingMessage)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// maybeGzip
// ---------------------------------------------------------------------------

describe('maybeGzip', () => {
  it('returns null for short bodies (below 512 bytes)', async () => {
    const result = await maybeGzip('short');
    expect(result).toBeNull();
  });

  it('returns a Buffer for large bodies (>= 512 bytes)', async () => {
    const largeBody = 'x'.repeat(600);
    const result = await maybeGzip(largeBody);
    expect(result).toBeInstanceOf(Buffer);
    // Compressed must be non-empty
    expect((result as Buffer).length).toBeGreaterThan(0);
  });

  it('compressed output starts with gzip magic bytes', async () => {
    const largeBody = JSON.stringify(
      Array.from({ length: 100 }, (_, i) => ({ id: i, title: `Note ${i}` })),
    );
    const compressed = await maybeGzip(largeBody);
    expect(compressed).not.toBeNull();
    // gzip magic: 0x1f 0x8b
    expect((compressed as Buffer)[0]).toBe(0x1f);
    expect((compressed as Buffer)[1]).toBe(0x8b);
  });
});

// ---------------------------------------------------------------------------
// sendJsonCached — ETag / 304 path
// ---------------------------------------------------------------------------

describe('sendJsonCached — ETag and 304', () => {
  it('sends 200 with ETag on first request', async () => {
    const req = makeMockReq({});
    const res = makeMockRes();
    await sendJsonCached(req as IncomingMessage, res as unknown as ServerResponse, 200, {
      hello: 'world',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBeDefined();
    expect(res.headers['content-type']).toBe('application/json');
  });

  it('sends 304 on subsequent request with matching ETag', async () => {
    const req1 = makeMockReq({});
    const res1 = makeMockRes();
    const data = { items: [1, 2, 3] };
    await sendJsonCached(req1 as IncomingMessage, res1 as unknown as ServerResponse, 200, data);
    const etag = res1.headers.etag;
    expect(etag).toBeDefined();

    const req2 = makeMockReq({ 'if-none-match': etag });
    const res2 = makeMockRes();
    await sendJsonCached(req2 as IncomingMessage, res2 as unknown as ServerResponse, 200, data);
    expect(res2.statusCode).toBe(304);
    // 304 body should be empty
    expect(res2.body).toBeNull();
  });

  it('includes Cache-Control header', async () => {
    const req = makeMockReq({});
    const res = makeMockRes();
    await sendJsonCached(req as IncomingMessage, res as unknown as ServerResponse, 200, {});
    expect(res.headers['cache-control']).toBe('no-cache, must-revalidate');
  });

  it('respects custom Cache-Control option', async () => {
    const req = makeMockReq({});
    const res = makeMockRes();
    await sendJsonCached(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      200,
      {},
      {
        cacheControl: 'public, max-age=60',
      },
    );
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it('sets CSP header when provided', async () => {
    const req = makeMockReq({});
    const res = makeMockRes();
    await sendJsonCached(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      200,
      {},
      {
        csp: "default-src 'self'",
      },
    );
    expect(res.headers['content-security-policy']).toBe("default-src 'self'");
  });

  it('sets extra headers (e.g. X-Total-Count)', async () => {
    const req = makeMockReq({});
    const res = makeMockRes();
    await sendJsonCached(req as IncomingMessage, res as unknown as ServerResponse, 200, [], {
      extra: { 'x-total-count': '42' },
    });
    expect(res.headers['x-total-count']).toBe('42');
  });

  it('sends gzip-encoded response when client accepts gzip and body is large', async () => {
    const largeData = Array.from({ length: 200 }, (_, i) => ({ id: i, title: `Note number ${i}` }));
    const req = makeMockReq({ 'accept-encoding': 'gzip' });
    const res = makeMockRes();
    await sendJsonCached(req as IncomingMessage, res as unknown as ServerResponse, 200, largeData);
    expect(res.headers['content-encoding']).toBe('gzip');
    // Body is a Buffer (compressed)
    expect(res.body).toBeInstanceOf(Buffer);
  });

  it('sends plain response when client does not accept gzip', async () => {
    const data = { hello: 'world' };
    const req = makeMockReq({});
    const res = makeMockRes();
    await sendJsonCached(req as IncomingMessage, res as unknown as ServerResponse, 200, data);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(typeof res.body).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// computeNotesFingerprint
// ---------------------------------------------------------------------------

describe('computeNotesFingerprint', () => {
  it('returns "empty" for an empty array', () => {
    expect(computeNotesFingerprint([])).toBe('empty');
  });

  it('returns a non-empty string for a non-empty array', () => {
    const fp = computeNotesFingerprint([{ mtime_ms: 1000 }, { mtime_ms: 2000 }]);
    expect(typeof fp).toBe('string');
    expect(fp).not.toBe('empty');
  });

  it('is stable (same input → same output)', () => {
    const notes = [{ mtime_ms: 100 }, { mtime_ms: 200 }, { mtime_ms: 300 }];
    expect(computeNotesFingerprint(notes)).toBe(computeNotesFingerprint(notes));
  });

  it('changes when a note is added', () => {
    const fp1 = computeNotesFingerprint([{ mtime_ms: 100 }]);
    const fp2 = computeNotesFingerprint([{ mtime_ms: 100 }, { mtime_ms: 200 }]);
    expect(fp1).not.toBe(fp2);
  });

  it('changes when a note mtime changes', () => {
    const fp1 = computeNotesFingerprint([{ mtime_ms: 100 }, { mtime_ms: 200 }]);
    const fp2 = computeNotesFingerprint([{ mtime_ms: 100 }, { mtime_ms: 999 }]);
    expect(fp1).not.toBe(fp2);
  });

  it('handles null mtime_ms gracefully', () => {
    const fp = computeNotesFingerprint([{ mtime_ms: null }, { mtime_ms: 500 }]);
    expect(typeof fp).toBe('string');
    expect(fp).not.toBe('empty');
  });
});

// ---------------------------------------------------------------------------
// IndexVersionedCache
// ---------------------------------------------------------------------------

describe('IndexVersionedCache', () => {
  it('returns null before any value is stored', () => {
    const cache = new IndexVersionedCache<string>();
    expect(cache.get('fp1')).toBeNull();
  });

  it('returns the stored value for the same fingerprint', () => {
    const cache = new IndexVersionedCache<string>();
    cache.set('fp1', 'result-a');
    expect(cache.get('fp1')).toBe('result-a');
  });

  it('returns null when fingerprint changes (cache invalidated)', () => {
    const cache = new IndexVersionedCache<string>();
    cache.set('fp1', 'result-a');
    expect(cache.get('fp2')).toBeNull();
  });

  it('serves new value after fingerprint changes and new set', () => {
    const cache = new IndexVersionedCache<string>();
    cache.set('fp1', 'result-a');
    cache.set('fp2', 'result-b');
    expect(cache.get('fp2')).toBe('result-b');
    expect(cache.get('fp1')).toBeNull(); // old fingerprint no longer matches
  });

  it('invalidate() clears the cache', () => {
    const cache = new IndexVersionedCache<string>();
    cache.set('fp1', 'result-a');
    cache.invalidate();
    expect(cache.get('fp1')).toBeNull();
  });

  it('works with object values', () => {
    const cache = new IndexVersionedCache<{ count: number }>();
    cache.set('v1', { count: 42 });
    const result = cache.get('v1');
    expect(result).toEqual({ count: 42 });
  });
});
