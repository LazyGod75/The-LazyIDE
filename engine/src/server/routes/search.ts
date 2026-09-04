import { route } from '../../retrieval/router.js';
import { getLogger } from '../../util/logger.js';
import { type BrainHandle, listBrains, withBrain } from '../brain-registry.js';
import { sendJsonCached } from '../cache.js';
import { mapDbError, sendError } from '../security.js';
import type { RouteHandler } from '../types.js';

export interface FederatedSearchHit {
  id: string;
  path: string;
  score: number;
  snippet: string;
  brainId: string;
  brainPath: string;
}

/**
 * Restrict which registered brains a federated search fans out to, based on
 * `scope` (spec §10 follow-up — replaces the old brittle
 * `brainPath.includes('/teams/')` string heuristic, which relied on no code
 * ever registering a brain at such a path and so always returned empty).
 *
 *   'team'     — brains explicitly labeled 'team' (registered team/dept
 *                clones — see src/lib/teams/teamSearch.ts) PLUS 'trunk'
 *                (the cross-project root-trunk brain, spec §5.3+§7: the same
 *                consolidated, org-wide-relevant knowledge layer a personal
 *                'all' recall already draws on, so team search surfaces it
 *                too — a search scoped to "team knowledge" should not omit
 *                the one brain that's explicitly cross-project by design).
 *   anything else ('all-open', ...) — every registered brain, unfiltered.
 */
function selectBrainsForScope(brains: BrainHandle[], scope: string): BrainHandle[] {
  if (scope === 'team') {
    return brains.filter((b) => b.label === 'team' || b.label === 'trunk');
  }
  return brains;
}

async function federatedSearch(
  query: string,
  topK: number,
  scope: string,
): Promise<{ hits: FederatedSearchHit[]; totalMs: number }> {
  const brains = selectBrainsForScope(listBrains(), scope);
  if (brains.length === 0) return { hits: [], totalMs: 0 };

  const perBrain = await Promise.allSettled(
    brains.map(async (brain: BrainHandle) => {
      try {
        const result = await withBrain(brain.brainId, () => route({ query, topK }));
        return result.hits.map((h) => ({
          id: h.id,
          path: h.path.replace(/\\/g, '/').replace(/^.*[/\\]brain[/\\]/, ''),
          score: h.score,
          snippet: h.snippet ?? '',
          brainId: brain.brainId,
          brainPath: brain.brainPath,
        }));
      } catch {
        return [] as FederatedSearchHit[];
      }
    }),
  );

  const allHits: FederatedSearchHit[] = [];
  for (const outcome of perBrain) {
    if (outcome.status === 'fulfilled') allHits.push(...outcome.value);
  }
  allHits.sort((a, b) => b.score - a.score);
  return { hits: allHits.slice(0, topK), totalMs: 0 };
}

// ---------------------------------------------------------------------------
// GET /_api/search?q=...&top=5
// ---------------------------------------------------------------------------

export const handleSearch: RouteHandler = (req, res, url) => {
  const log = getLogger();
  try {
    const q = url.searchParams.get('q');
    if (!q) {
      sendError(res, 400, 'Missing q parameter');
      return;
    }
    const topK = Math.min(Math.max(Number.parseInt(url.searchParams.get('top') ?? '5', 10), 1), 50);
    const scope = url.searchParams.get('scope') ?? 'current';

    if (scope === 'all-open' || scope === 'team') {
      federatedSearch(q, topK, scope)
        .then(({ hits, totalMs }) => {
          const data = {
            query: q,
            topK,
            scope,
            results: hits.map((h) => ({
              id: h.id,
              path: h.path,
              score: h.score,
              snippet: h.snippet,
              brainId: h.brainId,
              brainPath: h.brainPath,
            })),
            totalMs,
          };
          return sendJsonCached(req, res, 200, data);
        })
        .catch((err) => {
          if (mapDbError(res, err)) return;
          log.error({ err }, 'API error in /_api/search (federated)');
          sendError(res, 500, 'Federated search failed');
        });
      return;
    }

    route({ query: q, topK })
      .then((result) => {
        const data = {
          query: q,
          topK,
          scope,
          results: result.hits.map((h) => ({
            id: h.id,
            path: h.path.replace(/\\/g, '/').replace(/^.*[/\\]brain[/\\]/, ''),
            score: h.score,
            level: result.levelUsed,
            snippet: h.snippet,
          })),
          totalMs: result.totalMs,
        };
        return sendJsonCached(req, res, 200, data);
      })
      .catch((err) => {
        if (mapDbError(res, err)) return;
        log.error({ err }, 'API error in /_api/search');
        sendError(res, 500, 'Search failed');
      });
  } catch (err) {
    if (mapDbError(res, err)) return;
    log.error({ err }, 'API error in /_api/search');
    sendError(res, 500, 'Search error');
  }
};
