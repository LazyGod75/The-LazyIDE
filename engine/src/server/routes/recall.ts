/**
 * server/routes/recall.ts — GET /_api/recall
 *
 * Turn-mode recall over HTTP: the SAME scoring/intent-routing/token-budget/
 * session-dedup pipeline as `lazybrain inject-context --mode turn` (see
 * runTurnInjectDetailed in commands/inject-context.ts), served by the WARM
 * sidecar process instead of paying a fresh cold CLI subprocess per call.
 *
 * Added because /_api/search (routes/search.ts) only exposes the raw
 * router.ts `route()` call — none of the turn-mode-specific layers (trivial-
 * prompt short-circuit, feature-map fast path, per-level score floors,
 * active-file boost, intent-routed selective stripping, token budget, recall
 * nudge, session dedup) — so the Rust side (src-tauri/src/commands/brain/
 * search.rs) had no warm-sidecar way to reach them and fell back to raw
 * `search --strip --top 6` for per-turn recall. See recall_from_warm_sidecar
 * in that file for the caller.
 */
import { runTurnInjectDetailed } from '../../commands/inject-context.js';
import { parseNudgeStyle } from '../../commands/inject-context/markers.js';
import { getLogger } from '../../util/logger.js';
import { sendJsonCached } from '../cache.js';
import { mapDbError, sendError } from '../security.js';
import type { RouteHandler } from '../types.js';

// ---------------------------------------------------------------------------
// GET /_api/recall?q=...&cwd=...&top=...&maxTokens=...&sessionId=...&nudge=...
// ---------------------------------------------------------------------------

export const handleRecall: RouteHandler = (req, res, url) => {
  const log = getLogger();
  try {
    const q = url.searchParams.get('q');
    if (!q) {
      sendError(res, 400, 'Missing q parameter');
      return;
    }
    const cwd = url.searchParams.get('cwd') ?? undefined;
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    const maxTokens = Number.parseInt(url.searchParams.get('maxTokens') ?? '1500', 10);
    // The IDE (Rust caller) always sends its own nudge explicitly — see
    // search.rs's recall_from_warm_sidecar, which passes nudge=tool. A
    // missing/unrecognized value still degrades to the engine-wide default
    // ('skill') rather than throwing, matching every other CLI/route option
    // in this codebase.
    const nudge = parseNudgeStyle(url.searchParams.get('nudge'));
    // The sidecar's own background cache-priming probe (see
    // src-tauri/src/commands/brain/sidecar/warmup.rs's
    // spawn_brain_recall_warmup) sends this header on its one synthetic
    // recall per sidecar lifecycle. It is not real user activity, so it
    // must not inflate Settings > Memory's "Queries (24h)" diagnostic —
    // see InjectContextCliOptions.skipTelemetry's doc comment for the full
    // rationale.
    const skipTelemetry = req.headers['x-lazy-warmup'] === '1';

    runTurnInjectDetailed({
      query: q,
      cwd,
      sessionId,
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined,
      nudge,
      skipTelemetry,
    })
      .then((result) => {
        const data = {
          query: q,
          text: result.text,
          level: result.levelUsed,
          tokens: result.tokens,
        };
        return sendJsonCached(req, res, 200, data);
      })
      .catch((err) => {
        if (mapDbError(res, err)) return;
        log.error({ err }, 'API error in /_api/recall');
        sendError(res, 500, 'Recall failed');
      });
  } catch (err) {
    if (mapDbError(res, err)) return;
    log.error({ err }, 'API error in /_api/recall');
    sendError(res, 500, 'Recall error');
  }
};
