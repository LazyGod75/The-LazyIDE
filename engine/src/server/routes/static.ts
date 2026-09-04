import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { handleConditionalGet } from '../cache.js';
import { CSP_STATIC, CSP_UI, MIME } from '../security.js';

// ---------------------------------------------------------------------------
// ETag helper for file-based assets
//
// We use the mtime + size fingerprint as ETag — no file read needed.
// Short max-age so updates are picked up within 60 seconds.
// ---------------------------------------------------------------------------

const STATIC_CACHE_CONTROL = 'public, max-age=60, must-revalidate';

function fileETag(mtimeMs: number, size: number): string {
  return `"${mtimeMs.toString(36)}-${size.toString(36)}"`;
}

// ---------------------------------------------------------------------------
// UI asset prefixes served from the brain-ui directory
// ---------------------------------------------------------------------------

const UI_ASSET_PREFIXES = ['/styles/', '/components/', '/lib/'];

// ---------------------------------------------------------------------------
// Serve brain-ui SPA files (index.html, graph.html, and static assets)
// ---------------------------------------------------------------------------

export interface UiPaths {
  uiDir: string;
  uiIndexPath: string;
  uiIndexExists: boolean;
}

export function handleUiRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  rel: string,
  ui: UiPaths,
): boolean {
  // Home → index.html
  if ((rel === '/' || rel === '') && ui.uiIndexExists) {
    res.writeHead(200, { 'content-type': MIME['.html'], 'content-security-policy': CSP_UI });
    createReadStream(ui.uiIndexPath).pipe(res);
    return true;
  }

  // graph.html
  if (rel === '/graph.html') {
    const graphPath = join(ui.uiDir, 'graph.html');
    if (existsSync(graphPath)) {
      res.writeHead(200, { 'content-type': MIME['.html'], 'content-security-policy': CSP_UI });
      createReadStream(graphPath).pipe(res);
      return true;
    }
  }

  // Root-level static assets (favicon, etc.)
  const ROOT_ASSETS = ['/favicon.svg', '/favicon.ico'];
  if (ROOT_ASSETS.includes(rel)) {
    const assetPath = join(ui.uiDir, rel.replace(/^\//, ''));
    if (existsSync(assetPath)) {
      const assetStat = statSync(assetPath);
      const assetETag = fileETag(assetStat.mtimeMs, assetStat.size);
      if (handleConditionalGet(_req, res, assetETag)) return true;
      const assetMime = MIME[extname(assetPath).toLowerCase()] ?? 'image/svg+xml';
      res.writeHead(200, {
        'content-type': assetMime,
        'content-security-policy': CSP_UI,
        'cache-control': STATIC_CACHE_CONTROL,
        etag: assetETag,
      });
      createReadStream(assetPath).pipe(res);
      return true;
    }
  }

  // SPA static assets
  if (UI_ASSET_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
    if (rel.includes('..')) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden');
      return true;
    }
    const assetRelPath = rel.replace(/^\//, '');
    const assetPath = resolve(ui.uiDir, assetRelPath);
    if (!assetPath.startsWith(resolve(ui.uiDir))) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden');
      return true;
    }
    if (!existsSync(assetPath)) {
      res.writeHead(404);
      res.end('Not Found');
      return true;
    }
    const assetStat = statSync(assetPath);
    const assetETag = fileETag(assetStat.mtimeMs, assetStat.size);
    if (handleConditionalGet(_req, res, assetETag)) return true;
    const assetMime = MIME[extname(assetPath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': assetMime,
      'content-security-policy': CSP_UI,
      'cache-control': STATIC_CACHE_CONTROL,
      etag: assetETag,
    });
    createReadStream(assetPath).pipe(res);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Serve brain static files (notes HTML, etc.) with path traversal protection
// ---------------------------------------------------------------------------

export function handleBrainFile(
  _req: IncomingMessage,
  res: ServerResponse,
  rel: string,
  root: string,
): void {
  const safeRel = normalize(rel).replace(/^[/\\]+/, '');
  const resolved = resolve(root, safeRel);

  if (!resolved.startsWith(resolve(root))) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  let target = resolved;
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    target = join(resolved, 'index.html');
  }

  if (!existsSync(target)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const targetStat = statSync(target);
  const etag = fileETag(targetStat.mtimeMs, targetStat.size);
  if (handleConditionalGet(_req, res, etag)) return;

  const mime = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': mime,
    'content-security-policy': CSP_STATIC,
    'cache-control': STATIC_CACHE_CONTROL,
    etag,
  });
  createReadStream(target).pipe(res);
}
