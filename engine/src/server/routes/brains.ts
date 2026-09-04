/**
 * server/routes/brains.ts — brain-registry management routes (T0.8).
 *
 *   POST /brains/open  { brainPath: string, label?: 'project'|'team'|'trunk' }
 *                                             -> { brainId: string, label: string }
 *   GET  /brains                             -> { brains: [...] }
 *
 * These manage the registry itself (which brains this process knows about),
 * as opposed to the data routes (search/notes/graph/...), which read a
 * brain's content and accept an optional `?brainId=` to pick which one.
 *
 * `label` (spec §5.3/§10 follow-up) defaults to 'project' when absent or
 * unrecognized — see brain-registry.ts's `normalizeBrainLabel`/`openBrain`.
 * It drives federated search scoping in routes/search.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getLogger } from '../../util/logger.js';
import { listBrains, normalizeBrainLabel, openBrain } from '../brain-registry.js';
import { sendError, sendJson } from '../security.js';

const MAX_BODY_BYTES = 1_000_000;

/** Minimal JSON body reader — mirrors the pattern in commands/daemon.ts. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(err as Error);
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// POST /brains/open
// ---------------------------------------------------------------------------

export async function handleOpenBrain(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const log = getLogger();
  try {
    const body = await readJsonBody(req);
    const brainPath = typeof body.brainPath === 'string' ? body.brainPath.trim() : '';
    if (!brainPath) {
      sendError(res, 400, 'Missing brainPath');
      return;
    }
    // Silently falls back to 'project' (new entry) or the entry's existing
    // label (re-open) for anything absent/unrecognized — same lenient
    // clamp-not-reject style as this route's topK/scope parsing elsewhere
    // in server/routes/search.ts.
    const label = normalizeBrainLabel(body.label);
    const { brainId, label: resolvedLabel } = await openBrain(brainPath, { label });
    sendJson(res, 200, { brainId, label: resolvedLabel });
  } catch (err) {
    log.error({ err }, 'API error in POST /brains/open');
    sendError(res, 500, 'Failed to open brain');
  }
}

// ---------------------------------------------------------------------------
// GET /brains
// ---------------------------------------------------------------------------

export function handleListBrains(_req: IncomingMessage, res: ServerResponse): void {
  const log = getLogger();
  try {
    const brains = listBrains().map((b) => ({
      brainId: b.brainId,
      brainPath: b.brainPath,
      label: b.label,
      hot: b.hot,
      lastUsedMs: b.lastUsedMs,
    }));
    sendJson(res, 200, { brains });
  } catch (err) {
    log.error({ err }, 'API error in GET /brains');
    sendError(res, 500, 'Failed to list brains');
  }
}
