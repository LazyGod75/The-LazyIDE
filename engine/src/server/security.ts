import type { ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// MIME type map
// ---------------------------------------------------------------------------

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Content-Security-Policy strings
// ---------------------------------------------------------------------------

/** Strict CSP for API JSON responses. */
export const CSP_API = "default-src 'self'";

/**
 * Strict CSP for the brain-ui SPA. vis-network is now vendored locally, so
 * no CDN allowlist is needed. connect-src is restricted to 'self' (the server
 * only fetches /_api/* endpoints). style-src retains 'unsafe-inline' because
 * the SPA components generate dynamic inline styles (e.g. color values computed
 * at runtime from cluster palette data) that cannot be moved to stylesheets
 * without a significant refactor.
 */
export const CSP_UI =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";

/**
 * CSP for individual note HTML pages. Notes are static content with no
 * script execution needed; script-src 'none' prevents any JS from running.
 * style-src retains 'unsafe-inline' for note-embedded styles (e.g. code
 * highlighting classes injected by the pipeline).
 */
export const CSP_NOTE = "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'";

/** Restrictive CSP for brain-static file serving (no scripts). */
export const CSP_STATIC = "default-src 'self'; script-src 'none'";

// ---------------------------------------------------------------------------
// JSON response helpers
// ---------------------------------------------------------------------------

/** Write a JSON success response. */
export function sendJson(res: ServerResponse, status: number, data: unknown, csp?: string): void {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (csp) headers['content-security-policy'] = csp;
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

/** Write a JSON error response. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

// ---------------------------------------------------------------------------
// DB error mapping
// ---------------------------------------------------------------------------

/**
 * Inspect err for known database error codes and write an appropriate HTTP
 * response.  Returns true when err was handled, false otherwise.
 *
 * SQLITE_BUSY → 503 with Retry-After: 3 (index rebuild in progress).
 */
export function mapDbError(res: ServerResponse, err: unknown): boolean {
  const code = err != null ? (err as NodeJS.ErrnoException).code : undefined;
  if (code === 'SQLITE_BUSY') {
    res.writeHead(503, {
      'content-type': 'application/json',
      'retry-after': '3',
    });
    res.end(JSON.stringify({ error: 'Index is being rebuilt — retry in a few seconds' }));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Path traversal guard
// ---------------------------------------------------------------------------

/**
 * Returns true if the resolved path is safely inside the root directory.
 * Writes a 403 and returns false if the path escapes the root.
 */
export function assertSafePath(
  res: ServerResponse,
  resolvedPath: string,
  rootPath: string,
): boolean {
  if (!resolvedPath.startsWith(rootPath)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden');
    return false;
  }
  return true;
}
