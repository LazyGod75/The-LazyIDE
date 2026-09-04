/**
 * Minimal HTTP router built on node:http.
 *
 * Features:
 * - register(method, pattern, handler): named :param segments
 * - Query string parsing
 * - Body parsing: application/x-www-form-urlencoded and application/json
 *   capped at MAX_BODY_BYTES (1 MB)
 * - 404 / 405 / 500 handling (500 never leaks internals)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AuditEntry } from '../domain/types.js';
import type { Session, User } from '../domain/types.js';
import type { EngineFacade } from './engine-facade.js';

// ---------------------------------------------------------------------------
// Stores bundle passed to every handler
// ---------------------------------------------------------------------------

export interface StoreBundle {
  readonly dataDir: string;
}

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

export interface HandlerContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly params: Record<string, string>;
  readonly query: Record<string, string>;
  readonly body: Record<string, string>;
  readonly user?: User;
  readonly session?: Session;
  readonly stores: StoreBundle;
  readonly engine: EngineFacade;
  readonly audit: (entry: Omit<AuditEntry, 'ts'>) => void;
}

export type Handler = (ctx: HandlerContext) => Promise<void>;

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

interface Route {
  readonly method: string;
  readonly segments: ReadonlyArray<{ literal: string | null; param: string | null }>;
  readonly handler: Handler;
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class Router {
  private readonly _routes: Route[] = [];

  /**
   * Register a route. Pattern may contain :paramName segments.
   * Example: register('GET', '/t/:slug/wiki', handler)
   */
  register(method: string, pattern: string, handler: Handler): void {
    const parts = pattern.split('/').filter(Boolean);
    const segments = parts.map((p) =>
      p.startsWith(':') ? { literal: null, param: p.slice(1) } : { literal: p, param: null },
    );
    this._routes.push({ method: method.toUpperCase(), segments, handler });
  }

  /**
   * Match a request and return the handler + params, or null.
   */
  match(
    method: string,
    pathname: string,
  ): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    const matchedMethod: Handler[] = [];

    for (const route of this._routes) {
      if (route.segments.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let ok = true;

      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.literal !== null) {
          if (seg.literal !== part) {
            ok = false;
            break;
          }
        } else if (seg.param !== null) {
          params[seg.param] = decodeURIComponent(part);
        }
      }

      if (!ok) continue;

      if (route.method === method.toUpperCase()) {
        return { handler: route.handler, params };
      }
      matchedMethod.push(route.handler);
    }

    if (matchedMethod.length > 0) return null; // path matched but wrong method → 405
    return null;
  }

  /**
   * Check whether the path matches ANY route (for 405 vs 404 distinction).
   */
  pathExists(pathname: string): boolean {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this._routes) {
      if (route.segments.length !== parts.length) continue;
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.literal !== null && seg.literal !== part) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

function parseQuery(search: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!search) return result;
  const raw = search.startsWith('?') ? search.slice(1) : search;
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) {
      result[decodeURIComponent(pair)] = '';
    } else {
      const k = decodeURIComponent(pair.slice(0, eq));
      const v = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
      result[k] = v;
    }
  }
  return result;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseBody(req: IncomingMessage): Promise<Record<string, string>> {
  const contentType = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
  if (contentType === 'application/x-www-form-urlencoded') {
    const buf = await readBody(req);
    return parseQuery(buf.toString('utf-8'));
  }
  if (contentType === 'application/json') {
    const buf = await readBody(req);
    try {
      const parsed: unknown = JSON.parse(buf.toString('utf-8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const result: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          result[k] = String(v);
        }
        return result;
      }
    } catch {
      // ignore parse error — return empty body
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface ServerDeps {
  readonly stores: StoreBundle;
  readonly engine: EngineFacade;
  readonly audit: (entry: Omit<AuditEntry, 'ts'>) => void;
  readonly authMiddleware: (
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<{ user?: User; session?: Session }>;
}

export function createAppServer(router: Router, deps: ServerDeps) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const query = parseQuery(url.search);

    let body: Record<string, string> = {};
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      try {
        body = await parseBody(req);
      } catch (_e) {
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('Request body too large');
        return;
      }
    }

    const matched = router.match(req.method ?? 'GET', pathname);
    if (!matched) {
      const status = router.pathExists(pathname) ? 405 : 404;
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(status === 405 ? 'Method Not Allowed' : 'Not Found');
      return;
    }

    const { user, session } = await deps.authMiddleware(req, res);
    if (res.writableEnded) return; // middleware sent a redirect/error

    const ctx: HandlerContext = {
      req,
      res,
      params: matched.params,
      query,
      body,
      user,
      session,
      stores: deps.stores,
      engine: deps.engine,
      audit: deps.audit,
    };

    try {
      await matched.handler(ctx);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
      process.stderr.write(`[500] ${req.method} ${pathname}: ${String(err)}\n`);
    }
  });

  return server;
}
