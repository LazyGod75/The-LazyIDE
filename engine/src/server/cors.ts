import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Origins allowed to call the sidecar's /_api/* endpoints directly from a
 * browser context.
 *
 * The Lazy desktop app's WebView fetches the sidecar HTTP API directly
 * (e.g. GET /_api/tree, /_api/synthesis/index) rather than through Rust IPC.
 * On Windows/Linux, Tauri's WebView serves the frontend from the
 * `http://tauri.localhost` pseudo-origin (the `https` form and the raw
 * `tauri://localhost` custom scheme also occur across platforms/versions).
 * Local dev servers on localhost/127.0.0.1 are trusted too. Every other
 * origin gets no CORS headers, so the browser enforces same-origin as usual.
 */
const ALLOWED_ORIGIN_PATTERNS: readonly RegExp[] = [
  /^https?:\/\/tauri\.localhost$/,
  /^tauri:\/\/localhost$/,
  /^https?:\/\/localhost(?::\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/,
];

/** Returns true when origin is one of the trusted app/dev origins above. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

/**
 * Set CORS response headers when the request's Origin is trusted.
 *
 * Must be called before auth and route dispatch on every request: a CORS
 * preflight (OPTIONS) request never carries the Authorization header, so if
 * auth ran first every preflight would 401 with no CORS headers and the
 * browser would report an opaque "blocked by CORS policy" error instead of
 * the real response/status.
 *
 * The specific origin is echoed back rather than "*": requests carry an
 * Authorization header, and "*" is invalid for header-bearing/credentialed
 * requests per the Fetch spec. No-op for disallowed origins (nothing is
 * set, so the browser's default same-origin policy applies).
 */
export function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin)) return;

  res.setHeader('Access-Control-Allow-Origin', origin as string);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}
