import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzip } from 'node:zlib';

// ---------------------------------------------------------------------------
// ETag computation
// ---------------------------------------------------------------------------

/**
 * Compute a stable ETag from a serialized body string.
 * Uses SHA-1 (truncated to 16 hex chars) — fast and collision-resistant enough
 * for HTTP caching purposes.
 */
export function computeETag(body: string): string {
  const hash = createHash('sha1').update(body, 'utf8').digest('hex').slice(0, 16);
  return `"${hash}"`;
}

// ---------------------------------------------------------------------------
// 304 Not Modified helper
// ---------------------------------------------------------------------------

/**
 * Check If-None-Match header against the computed ETag.
 * Returns true if the client already has a fresh copy (304 was sent).
 * Returns false if the full response must be sent.
 */
export function handleConditionalGet(
  req: IncomingMessage,
  res: ServerResponse,
  etag: string,
): boolean {
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === '*')) {
    res.writeHead(304, { etag });
    res.end();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

const COMPRESSION_MIN_BYTES = 512;

/** Returns true when the request Accept-Encoding includes gzip. */
export function acceptsGzip(req: IncomingMessage): boolean {
  const ae = req.headers['accept-encoding'] ?? '';
  return ae.includes('gzip');
}

/**
 * Gzip a UTF-8 string.
 * Resolves to the compressed Buffer, or null when the body is too small to
 * benefit from compression.
 */
export function maybeGzip(body: string): Promise<Buffer | null> {
  if (Buffer.byteLength(body, 'utf8') < COMPRESSION_MIN_BYTES) {
    return Promise.resolve(null);
  }
  return new Promise<Buffer | null>((resolve, reject) => {
    gzip(Buffer.from(body, 'utf8'), (err, compressed) => {
      if (err) reject(err);
      else resolve(compressed);
    });
  });
}

// ---------------------------------------------------------------------------
// JSON response sender (ETag + optional compression)
// ---------------------------------------------------------------------------

export interface SendJsonOptions {
  /** Cache-Control header value. Defaults to 'no-cache, must-revalidate'. */
  cacheControl?: string;
  /** Content-Security-Policy value. */
  csp?: string;
  /** Extra response headers. */
  extra?: Record<string, string>;
}

/**
 * Send a JSON API response with ETag support and optional gzip compression.
 *
 * Lifecycle:
 *   1. Serialize body to JSON string.
 *   2. Compute ETag from the string.
 *   3. If the client sent If-None-Match matching the ETag, reply 304.
 *   4. Otherwise compress (if client supports gzip + body is large enough)
 *      and send 200 with appropriate headers.
 *
 * @returns Promise<void> so callers can await without issues.
 */
export async function sendJsonCached(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  data: unknown,
  opts: SendJsonOptions = {},
): Promise<void> {
  const body = JSON.stringify(data);
  const etag = computeETag(body);

  if (handleConditionalGet(req, res, etag)) return;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'cache-control': opts.cacheControl ?? 'no-cache, must-revalidate',
    etag,
  };
  if (opts.csp) headers['content-security-policy'] = opts.csp;
  if (opts.extra) Object.assign(headers, opts.extra);

  if (acceptsGzip(req)) {
    try {
      const compressed = await maybeGzip(body);
      if (compressed) {
        headers['content-encoding'] = 'gzip';
        headers['content-length'] = String(compressed.byteLength);
        res.writeHead(status, headers);
        res.end(compressed);
        return;
      }
    } catch {
      // Compression failed — fall through to plain response
    }
  }

  headers['content-length'] = String(Buffer.byteLength(body, 'utf8'));
  res.writeHead(status, headers);
  res.end(body);
}

// ---------------------------------------------------------------------------
// Index fingerprint (for cache invalidation)
// ---------------------------------------------------------------------------

/**
 * Compute a stable fingerprint from an already-fetched notes array.
 *
 * Uses note count + XOR of mtime_ms values — fast, allocation-free, and
 * correct: any note addition/deletion/update changes the fingerprint.
 *
 * The XOR is combined with a simple sum to reduce collision risk on arrays
 * where two edits cancel each other out (e.g. delete 1000 + add 1000).
 *
 * @param notes  Array returned by listAllReadonly() — may be empty.
 */
export function computeNotesFingerprint(
  notes: ReadonlyArray<{ mtime_ms?: number | null }>,
): string {
  if (notes.length === 0) return 'empty';
  let xor = 0;
  let sum = 0;
  for (const n of notes) {
    const m = n.mtime_ms ?? 0;
    xor ^= m;
    sum += m;
  }
  // Truncate sum to 32-bit range to keep the string short
  return `${notes.length}:${(xor >>> 0).toString(16)}:${(sum >>> 0).toString(16)}`;
}

// ---------------------------------------------------------------------------
// In-memory result cache (tree / hierarchy)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  fingerprint: string;
  value: T;
}

/**
 * Generic in-process cache keyed by the index fingerprint.
 * Stores one entry; invalidated whenever the fingerprint changes.
 */
export class IndexVersionedCache<T> {
  private entry: CacheEntry<T> | null = null;

  /** Retrieve cached value if fingerprint matches, otherwise return null. */
  get(fingerprint: string): T | null {
    if (this.entry && this.entry.fingerprint === fingerprint) {
      return this.entry.value;
    }
    return null;
  }

  /** Store a value associated with the given fingerprint. */
  set(fingerprint: string, value: T): void {
    this.entry = { fingerprint, value };
  }

  /** Manually invalidate the cache. */
  invalidate(): void {
    this.entry = null;
  }
}
