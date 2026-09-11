import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEmbedder } from '../indexer/embeddings.js';
import { countAllNotesReadonly } from '../indexer/fts.js';
import { checkAuth } from '../server/auth.js';
import { BrainNotFoundError, enterBrain } from '../server/brain-registry.js';
import { applyCorsHeaders } from '../server/cors.js';
import { cleanServeFiles, writeServeFiles } from '../server/pid.js';
import { startResourceMonitor } from '../server/resource-monitor.js';
import { handleListBrains, handleOpenBrain } from '../server/routes/brains.js';
import { handleGlobalGraph, handleGraph, handleGraphLayout } from '../server/routes/graph.js';
import {
  handleBacklinks,
  handleNeighbors,
  handleNodeById,
  handleNoteById,
  handleNoteMeta,
  handleNotes,
  handleResolve,
} from '../server/routes/notes.js';
import { handleRecall } from '../server/routes/recall.js';
import { handleSearch } from '../server/routes/search.js';
import { handleBrainFile, handleUiRoute } from '../server/routes/static.js';
import { handleSynthesisIndex, handleSynthesisTopic } from '../server/routes/synthesis.js';
import { handleHierarchy, handleTopics, handleTree } from '../server/routes/tree.js';
import { sendError } from '../server/security.js';
import { batchesDir, brainRoot, notesDir } from '../store/paths.js';
import { assertBrainExists } from '../util/brain-guard.js';
import { getLogger } from '../util/logger.js';
import { runIncrementalUpdate } from './index-update.js';

// Re-export public helpers so existing callers are unaffected.
export { readServePort, stopServe } from '../server/pid.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServeCliOptions {
  port?: number;
  token?: string;
  bind?: string;
}

export function runServe(opts: ServeCliOptions): Promise<import('node:http').Server> {
  return new Promise((resolveServer, reject) => {
    const port = opts.port ?? 4242;
    const bind = opts.bind ?? '127.0.0.1';
    const root = brainRoot();
    const log = getLogger();

    // BRAIN-NOT-FOUND guard: refuse to start if the brain directory has no notes/
    // subdirectory. Starting silently on an empty dir would hide misconfigurations.
    try {
      assertBrainExists();
    } catch (err) {
      reject(err);
      return;
    }

    // Resolve path to brain-ui directory.
    // __dirname = src/commands, so go up 2 levels to project root, then down to examples.
    const uiDir = resolve(__dirname, '..', '..', 'examples', 'brain-ui');
    const uiIndexPath = join(uiDir, 'index.html');
    const uiIndexExists = existsSync(uiIndexPath);

    if (!existsSync(uiDir)) {
      log.error(
        { uiDir },
        'brain-ui directory not found — the UI will be unavailable. ' +
          'If running from npm, ensure "examples/" is listed in package.json "files". ' +
          'If running from source, check that examples/brain-ui/ exists.',
      );
    }

    const ui = { uiDir, uiIndexPath, uiIndexExists };

    const server = createServer((req, res) => {
      // CORS: apply headers first so they land on every response, including
      // 401s from checkAuth below — then short-circuit preflight OPTIONS
      // requests before auth. A preflight never carries the Authorization
      // header, so if auth ran first every preflight would 401 with no CORS
      // headers and the browser would report an opaque CORS error instead
      // of the real one. See ../server/cors.ts for the allowed-origin list.
      applyCorsHeaders(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (!checkAuth(req, res, opts.token)) return;

      const url = new URL(req.url ?? '/', `http://${bind}:${port}`);
      const rel = decodeURIComponent(url.pathname);

      // Multi-tenant brain routing (T0.8): every data route below accepts an
      // optional ?brainId= query param. Absent brainId keeps this request on
      // the default env-configured brain — byte-for-byte the pre-existing
      // single-brain behavior. An unrecognized brainId 404s here instead of
      // reaching any handler below. See server/brain-registry.ts.
      try {
        enterBrain(url.searchParams.get('brainId') ?? undefined);
      } catch (err) {
        if (err instanceof BrainNotFoundError) {
          sendError(res, 404, err.message);
          return;
        }
        throw err;
      }

      // POST /_api/shutdown — graceful stop
      if (rel === '/_api/shutdown' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        setImmediate(() => {
          server.close();
          cleanServeFiles();
        });
        return;
      }

      // POST /brains/open — register (or re-attach to) a brain by path
      if (rel === '/brains/open' && req.method === 'POST') {
        void handleOpenBrain(req, res);
        return;
      }

      // GET /brains — list every registered brain (hot/cold state)
      if (rel === '/brains' && req.method === 'GET') {
        handleListBrains(req, res);
        return;
      }

      // GET /_api/notes
      if (rel === '/_api/notes') {
        handleNotes(req, res, url);
        return;
      }

      // GET /_api/notes/:id/backlinks
      const backlinksMatch = rel.match(/^\/_api\/notes\/([^/]+)\/backlinks$/);
      if (backlinksMatch) {
        handleBacklinks(req, res, decodeURIComponent(backlinksMatch[1]));
        return;
      }

      // GET /_api/notes/:id/neighbors
      const neighborsMatch = rel.match(/^\/_api\/notes\/([^/]+)\/neighbors$/);
      if (neighborsMatch) {
        handleNeighbors(req, res, decodeURIComponent(neighborsMatch[1]));
        return;
      }

      // GET /_api/hierarchy
      if (rel === '/_api/hierarchy') {
        handleHierarchy(req, res);
        return;
      }

      // GET /_api/search
      if (rel.startsWith('/_api/search')) {
        handleSearch(req, res, url);
        return;
      }

      // GET /_api/recall — turn-mode scored recall (per-turn assistant memory)
      if (rel.startsWith('/_api/recall')) {
        handleRecall(req, res, url);
        return;
      }

      // GET /_api/global-graph
      if (rel === '/_api/global-graph') {
        handleGlobalGraph(req, res);
        return;
      }

      // GET /_api/graph and /_api/graph.json — single shared handler, both routes kept
      if (rel === '/_api/graph') {
        handleGraph(req, res, '/_api/graph');
        return;
      }
      if (rel === '/_api/graph.json') {
        handleGraph(req, res, '/_api/graph.json');
        return;
      }

      // GET /_api/graph-layout.json — slim layout-only payload for home panel + graph.html
      if (rel === '/_api/graph-layout.json') {
        handleGraphLayout(req, res);
        return;
      }

      // GET /_api/topics/:path
      const topicsMatch = rel.match(/^\/_api\/topics\/(.+)$/);
      if (topicsMatch) {
        handleTopics(req, res, decodeURIComponent(topicsMatch[1]));
        return;
      }

      // GET /_api/tree
      if (rel === '/_api/tree') {
        handleTree(req, res);
        return;
      }

      // GET /_api/synthesis/index (must precede the general synthesis prefix check)
      if (rel === '/_api/synthesis/index') {
        handleSynthesisIndex(req, res);
        return;
      }

      // GET /_api/synthesis/:topic
      if (rel.startsWith('/_api/synthesis/')) {
        const topic = decodeURIComponent(rel.slice('/_api/synthesis/'.length));
        handleSynthesisTopic(req, res, topic);
        return;
      }

      // GET /_api/resolve
      if (rel === '/_api/resolve') {
        handleResolve(req, res, url);
        return;
      }

      // GET /_api/note-meta/:id
      const noteMetaMatch = rel.match(/^\/_api\/note-meta\/(.+)$/);
      if (noteMetaMatch) {
        handleNoteMeta(req, res, decodeURIComponent(noteMetaMatch[1]));
        return;
      }

      // GET /_api/note/:id
      const noteByIdMatch = rel.match(/^\/_api\/note\/(.+)$/);
      if (noteByIdMatch) {
        handleNoteById(req, res, decodeURIComponent(noteByIdMatch[1]));
        return;
      }

      // GET /_api/node/:id — legacy alias
      const nodeMatch = rel.match(/^\/_api\/node\/([^/]+)$/);
      if (nodeMatch) {
        handleNodeById(req, res, decodeURIComponent(nodeMatch[1]));
        return;
      }

      // Brain-ui SPA files (static assets shared by every brain — not brain-scoped)
      if (handleUiRoute(req, res, rel, ui)) return;

      // Brain static files (notes HTML, etc.) — recomputed per request (not
      // the startup-time `root` closure below) so ?brainId= is respected here too.
      handleBrainFile(req, res, rel, brainRoot());
    });

    server.listen(port, bind, () => {
      const boundPort = (server.address() as import('node:net').AddressInfo).port;
      writeServeFiles(boundPort);
      log.info({ port: boundPort, bind, root }, 'lazybrain serve listening');
      // Human-readable startup line so the terminal immediately shows the URL.
      // Kept alongside the structured pino log (both are useful).
      process.stdout.write(
        `LazyBrain wiki running at http://${bind}:${boundPort} — Ctrl+C to stop.\n`,
      );

      // Warm the embedder immediately after boot (fire-and-forget). Loading the
      // ONNX bi-encoder model was the suspected dominant cost of the first
      // semantic (L3/L4) query, originally estimated at "up to ~24s cold" —
      // that number was never re-measured after being written and turned out
      // to be wrong: re-profiled 2026-08-16 against this exact code path
      // (fresh Node process, q8-quantized MODEL_ID, model pre-cached under
      // ~/.lazybrain/models, both from long-cached and freshly-copied model
      // files) at a consistent ~1.0-1.1s cold / 0ms warm (memoized). A full
      // spawn-to-first-real-recall run (child process spawn through the
      // sidecar's own HTTP `/_api/recall`) measured ~1.1-1.7s total for the
      // first call, 6-15ms for the second — see the brain-sidecar cold-start
      // investigation for method. Kicking the load off here, off the request
      // path, still means that cost is usually paid before the first real
      // query arrives instead of during it — just a ~1s cost, not ~24s. Never
      // blocks startup and never throws: getEmbedder() already degrades to
      // null + a one-time stderr hint when models are unavailable, so
      // failures here are silent by design.
      const embedderWarmupStart = Date.now();
      getEmbedder()
        .then((embedder) => {
          if (embedder) {
            const ms = Date.now() - embedderWarmupStart;
            log.info({ ms }, `[serve] embedder warmed in ${ms}ms`);
          }
        })
        .catch(() => {
          // Swallow — warmup must never crash or destabilize the server.
        });

      // Auto-build: if the index is empty but note files exist, trigger incremental update.
      setImmediate(() => {
        try {
          if (countAllNotesReadonly({ includeExpired: true }) === 0) {
            const hasNoteFiles = existsSync(notesDir()) || existsSync(batchesDir());
            if (hasNoteFiles) {
              log.info(
                'serve: index is empty but note files exist — running incremental index update',
              );
              // Fire-and-forget: runIncrementalUpdate() is async (it now also
              // batch-embeds newly-indexed notes — see embed-index.ts), but
              // this whole auto-build must never block server startup, so it
              // stays a .then/.catch chain rather than an awaited call.
              runIncrementalUpdate()
                .then((result) => {
                  log.info(
                    { indexed: result.indexed, failed: result.failed },
                    'serve: auto index-update complete',
                  );
                })
                .catch((buildErr) => {
                  log.warn(
                    { err: (buildErr as Error).message },
                    'serve: auto index-update failed — run `lazybrain index-rebuild` manually',
                  );
                });
            }
          }
        } catch {
          // Never block server startup on index check errors
        }
      });

      // Named signal handlers — removed when the server closes to avoid leaks in tests.
      const onExit = (): void => {
        cleanServeFiles();
      };
      const onSigInt = (): void => {
        cleanServeFiles();
        server.close();
      };
      const onSigTerm = (): void => {
        cleanServeFiles();
        server.close();
      };

      process.on('exit', onExit);
      process.on('SIGINT', onSigInt);
      process.on('SIGTERM', onSigTerm);

      // P41 follow-up: periodic RSS + cache-size self-report so future
      // sidecar memory growth is diagnosable from Lazy.log instead of only
      // surfacing as a support report. Stopped on close alongside the signal
      // handlers above so repeated serve restarts in tests never accumulate
      // timers — see server/resource-monitor.ts.
      const stopResourceMonitor = startResourceMonitor();

      server.once('close', () => {
        stopResourceMonitor();
        process.removeListener('exit', onExit);
        process.removeListener('SIGINT', onSigInt);
        process.removeListener('SIGTERM', onSigTerm);
      });

      resolveServer(server);
    });
    server.on('error', reject);
  });
}
