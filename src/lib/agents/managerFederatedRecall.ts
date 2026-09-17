/* managerFederatedRecall — D92 read-only cross-project digest for LazyManager.

   Does not write bot/solari state. Search is skipped unless the user turn
   looks cross-project, and is bounded by a short timeout.
*/

import {
  federatedRecall,
  buildCrossProjectContext,
  type FederatedRecallResult,
} from '../brain/federatedRecall.js';
import { withTimeout } from '../brain/withTimeout.js';
import { isTrivialManagerUtterance } from './managerAmbientRecall.js';
import { jevRerankRecallHits } from '../jev/jevEnhancements.js';

export const MANAGER_FEDERATED_TIMEOUT_MS = 300;
export const MANAGER_FEDERATED_MAX_HITS = 3;

const CROSS_PROJECT_RE =
  /\b(other project|autre projet|cross[- ]project|l['’]autre projet|another (repo|project|codebase)|dans l['’]autre)\b/i;

export function looksLikeCrossProjectQuery(text: string): boolean {
  if (isTrivialManagerUtterance(text)) return false;
  return CROSS_PROJECT_RE.test(text);
}

export function formatManagerFederatedDigest(result: FederatedRecallResult): string | undefined {
  const body = buildCrossProjectContext(result).trim();
  if (!body) return undefined;
  return `${body}\nRead-only: do not write or overwrite other project brains.`;
}

export async function maybeFederatedRecallForManager(
  query: string,
  opts?: {
    fetch?: (query: string, limit?: number) => Promise<FederatedRecallResult>;
    timeoutMs?: number;
    force?: boolean;
    /** projectId for the jev.judgment journal event — optional; the rerank
     *  works (and journals under '*') without it. */
    projectId?: string;
  },
): Promise<string | undefined> {
  if (!opts?.force && !looksLikeCrossProjectQuery(query)) return undefined;
  const fetch = opts?.fetch ?? federatedRecall;
  try {
    const result = await withTimeout(
      Promise.resolve(fetch(query, MANAGER_FEDERATED_MAX_HITS)),
      opts?.timeoutMs ?? MANAGER_FEDERATED_TIMEOUT_MS,
      'manager-federated-recall',
    );
    // Optional Jev rerank (src/lib/jev/) — drops hits the judgment finds
    // irrelevant to the actual request. Fail-open inside: any error or an
    // all-dropped result returns the hits unchanged. Entirely skipped when
    // Jev mode is off.
    const reranked = await jevRerankRecallHits(query, result.hits, opts?.projectId ?? '*');
    const finalResult: FederatedRecallResult = reranked === result.hits
      ? result
      : {
          hits: [...reranked],
          text: reranked
            .map((h) => `[#${h.id}] (from ${h.sourceProject ?? 'cross-project'}) ${h.title}: ${h.snippet}`)
            .join('\n'),
        };
    return formatManagerFederatedDigest(finalResult);
  } catch {
    return undefined;
  }
}
