/* managerAmbientRecall — D87 optional/light manager memory.

   Default path is a cheap explicit brain_query NUDGE (no sidecar search).
   Ambient brain.recall stays opt-in, skipped on trivial turns, and bounded
   by a short timeout so it cannot stall TTFT.
*/

import { getPlatform } from '../platform/index.js';
import { withTimeout } from '../brain/withTimeout.js';

export const LIGHT_AMBIENT_RECALL_TIMEOUT_MS = 250;
export const LIGHT_AMBIENT_RECALL_MAX_CHARS = 1200;

const TRIVIAL_UTTERANCE_RE =
  /^(ok|okay|merci|thanks|thx|yes|no|oui|non|d['’]accord|got it|cool|sure)[.!?]*$/i;

const MEMORY_SEEKING_RE =
  /\b(remember|rappel|souviens|souvient|last time|la derni[eè]re fois|why did we|pourquoi on a|prior (decision|choice)|d[eé]cision|how did we|comment on a|from (the )?brain|au brain|earlier this (mission|project)|what (was|were) the last|what did we (decide|pick))\b/i;

export function isTrivialManagerUtterance(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  return t.length <= 12 && TRIVIAL_UTTERANCE_RE.test(t);
}

export function isMemorySeekingUtterance(text: string): boolean {
  return MEMORY_SEEKING_RE.test(text);
}

export function buildExplicitBrainQueryNudge(opts: {
  lastUserMessage?: string;
  brainQueryResult?: string;
  structuralQueryResult?: string;
  brainRecall?: string;
}): string | undefined {
  const msg = opts.lastUserMessage ?? '';
  if (!msg || isTrivialManagerUtterance(msg)) return undefined;
  if (opts.brainQueryResult?.trim() || opts.structuralQueryResult?.trim() || opts.brainRecall?.trim()) {
    return undefined;
  }
  if (!isMemorySeekingUtterance(msg)) return undefined;
  return 'Memory-seeking turn: no grounded Brain Query Result is in this prompt. Emit brain_query (or brain_query_css for an exact set) before answering from impression — nothing searches the brain on your behalf.';
}

export async function maybeLightAmbientRecall(opts: {
  query: string;
  enabled?: boolean;
  timeoutMs?: number;
  recall?: (query: string) => Promise<string>;
}): Promise<string | undefined> {
  if (!opts.enabled) return undefined;
  if (isTrivialManagerUtterance(opts.query) || !isMemorySeekingUtterance(opts.query)) return undefined;
  const recall = opts.recall ?? defaultPlatformRecall;
  try {
    const text = await withTimeout(
      Promise.resolve(recall(opts.query)),
      opts.timeoutMs ?? LIGHT_AMBIENT_RECALL_TIMEOUT_MS,
      'light-ambient-recall',
    );
    const trimmed = text.trim().slice(0, LIGHT_AMBIENT_RECALL_MAX_CHARS);
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

async function defaultPlatformRecall(query: string): Promise<string> {
  try {
    const result = await getPlatform().brain.recall(query);
    return result.injectedContext ?? '';
  } catch {
    return '';
  }
}

export async function enrichManagerContextForTurn<T extends {
  ambientRecallEnabled?: boolean;
  brainRecall?: string;
  lastUserMessage?: string;
  federatedRecallDigest?: string;
}>(
  ctx: T,
  lastUserMessage: string,
  deps?: {
    lightRecall?: (query: string) => Promise<string | undefined>;
    federated?: (query: string) => Promise<string | undefined>;
  },
): Promise<T> {
  const next: T = { ...ctx, lastUserMessage: ctx.lastUserMessage ?? lastUserMessage };
  if (ctx.ambientRecallEnabled && !next.brainRecall) {
    const recalled = await (deps?.lightRecall
      ?? ((q) => maybeLightAmbientRecall({ query: q, enabled: true })))(lastUserMessage);
    if (recalled) next.brainRecall = recalled;
  }
  if (!next.federatedRecallDigest && deps?.federated) {
    const digest = await deps.federated(lastUserMessage);
    if (digest) next.federatedRecallDigest = digest;
  }
  return next;
}
