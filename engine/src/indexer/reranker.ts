import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  env,
} from '@huggingface/transformers';
import { getConfig } from '../util/config.js';
import { getLogger } from '../util/logger.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';
import { isEmbeddingsDisabledByEnv, isModelCached } from './embeddings.js';

const MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2';

/**
 * The transformers.js `PreTrainedTokenizer`/`PreTrainedModel` call signatures
 * are typed `(...args: any[]): any` upstream (see node_modules/@huggingface/
 * transformers/types/{tokenizers,models}.d.ts) — the library makes instances
 * callable via a runtime Proxy that TS cannot describe generically. These
 * narrow function types describe exactly the shapes this file relies on, so
 * the `any` stays confined to the two `as unknown as` casts in scorePairs()
 * below instead of leaking through the rest of the module.
 */
interface BatchEncoding {
  input_ids: unknown;
  attention_mask: unknown;
  token_type_ids?: unknown;
}
type TokenizeCall = (
  text: string[],
  opts: { text_pair: string[]; padding: boolean; truncation: boolean },
) => BatchEncoding;
interface LogitsTensor {
  dims: number[];
  data: ArrayLike<number>;
}
type ModelForwardCall = (inputs: BatchEncoding) => Promise<{ logits: LogitsTensor }>;

interface CrossEncoder {
  tokenizer: PreTrainedTokenizer;
  model: PreTrainedModel;
}

let crossEncoder: CrossEncoder | null = null;
// In-flight load, memoized separately from the resolved `crossEncoder` — same
// cold-start race as embeddings.ts getEmbedder() (see the comment there):
// without this, two callers landing before the first from_pretrained() load
// resolves would each start their own ONNX load. Concurrent callers now
// await the SAME promise; see getReranker() below.
let pipePromise: Promise<CrossEncoder> | null = null;

/**
 * Returns true when the cross-encoder reranker model already exists in the
 * local cache. Delegates to embeddings.ts's isModelCached() — the canonical
 * check for BOTH on-disk layouts transformers.js may have used:
 *   - Flat:   <cacheDir>/Xenova--model-name/
 *   - Nested: <cacheDir>/Xenova/model-name/
 *
 * Previously this function only checked the flat layout itself (duplicated,
 * incomplete logic). On any cache populated in the nested layout — the
 * common case on a dev machine that already has the multilingual embedder
 * cached — the reranker model was never found, loadReranker() always threw
 * "model not in local cache", and every L4 query silently fell back to
 * identity ranking (see rerankFallback() below for how that failure is now
 * surfaced instead of swallowed).
 */
export function isRerankerCached(modelsPath: string): boolean {
  return isModelCached(modelsPath, MODEL_ID);
}

/**
 * Concurrency: mirrors getEmbedder()'s in-flight promise memoization (see
 * embeddings.ts). A caller that arrives while a load is already underway
 * awaits the SAME promise instead of starting a second pipeline() load. On
 * failure (model not cached, or pipeline() rejects) `pipePromise` is reset
 * so the next call retries — this reranker has no sticky "unavailable" flag
 * (unlike the embedder), so retry-on-next-call is the pre-existing contract
 * and must keep working after this change.
 */
export async function getReranker(): Promise<CrossEncoder> {
  if (crossEncoder) return crossEncoder;
  if (!pipePromise) {
    pipePromise = loadReranker().catch((err: unknown) => {
      pipePromise = null;
      throw err;
    });
  }
  return pipePromise;
}

async function loadReranker(): Promise<CrossEncoder> {
  if (isEmbeddingsDisabledByEnv()) {
    // Real kill switch (mirrors embeddings.ts's getEmbedder()): behave
    // exactly like this function's own "model not cached" degraded path —
    // throw so the caller (rerank(), L4) falls back — just triggered by
    // explicit user choice (LAZYBRAIN_EMBEDDINGS=0/false) instead of a
    // missing model directory.
    throw new Error(
      'Reranker disabled via LAZYBRAIN_EMBEDDINGS=0. Semantic rerank (L4) unavailable.',
    );
  }

  const cfg = getConfig();
  env.localModelPath = cfg.modelsPath;
  env.cacheDir = cfg.modelsPath;

  // Apply the same three-state remote-download policy as the embedder.
  const envVal = process.env.LAZYBRAIN_ALLOW_REMOTE_MODELS;
  const remoteAllowed = envVal === '1';
  const remoteUnset = envVal === undefined || envVal === '';

  if (remoteUnset && !isRerankerCached(cfg.modelsPath)) {
    // Model absent and downloads not opted-in — throw so caller falls back.
    throw new Error(
      'Reranker model not in local cache. Run `npm run download-models` or set LAZYBRAIN_ALLOW_REMOTE_MODELS=1.',
    );
  }

  env.allowRemoteModels = remoteAllowed;

  // Load the tokenizer and model DIRECTLY instead of going through the
  // `pipeline('text-classification', ...)` wrapper.
  //
  // This cross-encoder has a single-output regression head — its config
  // has `id2label: {"0": "LABEL_0"}`, one logit per (query, document) pair,
  // not a class distribution. transformers.js's text-classification
  // pipeline unconditionally runs `softmax(batch.data)` over that logits
  // tensor as post-processing (see TextClassificationPipeline._call in
  // node_modules/@huggingface/transformers/src/pipelines.js), and softmax
  // over a single value is mathematically always exactly 1.0 regardless of
  // the underlying logit. Every candidate therefore scored identically
  // (score: 1) and rerank()'s sort preserved L3's input order — L4 never
  // actually reranked anything, with no thrown error and no visible signal.
  // Confirmed empirically: the raw logits genuinely differ per candidate
  // (e.g. -5.98 vs -7.35), but running the exact same pairs through the
  // pipeline returned 1.0 for both. Going straight to the model's logits
  // (see scorePairs() below) keeps the real relevance signal instead of
  // squashing it.
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(MODEL_ID),
    AutoModelForSequenceClassification.from_pretrained(MODEL_ID, { dtype: 'q8' }),
  ]);
  crossEncoder = { tokenizer, model };
  return crossEncoder;
}

/**
 * Score every (query, candidate) pair and return the RAW relevance logit for
 * each — no softmax, no other post-processing. See loadReranker() above for
 * why: this cross-encoder has exactly one output value per pair, and that
 * value already IS the ranking signal.
 *
 * Batched in a single forward pass (tokenizer pads `texts` to the batch's
 * longest sequence), mirroring how the old text-classification pipeline call
 * batched the same pairs.
 */
async function scorePairs(ce: CrossEncoder, query: string, texts: string[]): Promise<number[]> {
  const tokenize = ce.tokenizer as unknown as TokenizeCall;
  const forward = ce.model as unknown as ModelForwardCall;

  const inputs = tokenize(
    texts.map(() => query),
    { text_pair: texts, padding: true, truncation: true },
  );
  const { logits } = await forward(inputs);

  // logits.dims is [batch, num_labels]. This model is single-output
  // (num_labels === 1) by construction (see loadReranker() comment) — assert
  // it rather than silently misreading a differently-shaped tensor if the
  // model ever changes underneath this code.
  const numLabels = logits.dims[1] ?? 1;
  if (numLabels !== 1) {
    throw new Error(
      `reranker model returned ${numLabels} labels per pair, expected 1 (single relevance logit)`,
    );
  }

  const data = logits.data;
  return texts.map((_, i) => Number(data[i]));
}

/** True when at least two candidates have genuinely different text. */
function hasDistinctTexts(items: { text: string }[]): boolean {
  if (items.length < 2) return false;
  const first = items[0].text;
  return items.some((c) => c.text !== first);
}

/** True when every score in the list is bitwise-identical. */
function allScoresIdentical(scores: number[]): boolean {
  if (scores.length < 2) return true;
  return scores.every((s) => s === scores[0]);
}

export interface RerankInput {
  id: string;
  text: string;
}

export interface RerankHit {
  id: string;
  score: number;
}

/**
 * Set once a reranker load/inference failure has been logged, so a corpus
 * that keeps missing the model doesn't flood the log with a warning on every
 * single query — mirrors embeddings.ts's noticePrinted/embedderUnavailable
 * dedup pattern. Telemetry (rerank_fallback) is still logged on every
 * occurrence — it's the cheap, structured, always-on signal; the stderr
 * warning is the one-time human-visible nudge.
 */
let fallbackWarned = false;

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The core failure this guards against: a cross-encoder that silently never
 * loads (e.g. the flat/nested cache-layout bug this file used to have) makes
 * rerank() fall back to identity ranking — returning L3's input order back
 * out, unchanged, scored to look like a real ranking. That looked exactly
 * like success: no thrown error, no log line, no visible signal that L4
 * reranking never actually ran. Every fallback now goes through here so it
 * is always observable — a one-time stderr warning (loud enough to notice,
 * quiet enough not to spam) plus a telemetry event on every occurrence (see
 * TelemetryEvent's 'rerank_fallback' variant, util/telemetry.ts) for anyone
 * auditing retrieval quality after the fact.
 */
function rerankFallback(
  filtered: { id: string; text: string }[],
  topK: number,
  reason: string,
): RerankHit[] {
  if (!fallbackWarned) {
    getLogger().warn(
      { reason },
      'lazybrain: cross-encoder reranker (L4) unavailable — falling back to identity ranking ' +
        '(L3 order returned unchanged, no semantic rerank applied). Run `npm run download-models` ' +
        'or check LAZYBRAIN_ALLOW_REMOTE_MODELS / LAZYBRAIN_EMBEDDINGS.',
    );
    fallbackWarned = true;
  }
  logTelemetry({
    event: 'rerank_fallback',
    ts: nowIso(),
    reason,
    candidates: filtered.length,
  });
  return filtered.slice(0, topK).map((c, i) => ({ id: c.id, score: 1 - i / filtered.length }));
}

/**
 * Cross-encoder re-rank: takes top-N from cheap retrieval, returns top-K by relevance.
 * 30-50ms per pair on CPU with quantized ONNX, batched.
 */
export async function rerank(
  query: string,
  candidates: RerankInput[],
  topK: number,
): Promise<RerankHit[]> {
  if (candidates.length === 0) return [];
  // Maximum-paranoia coercion: the @huggingface/transformers tokenizer throws cryptic
  // "text.split is not a function" errors when ANY pair has a non-string value.
  const safeQuery = typeof query === 'string' && query.length > 0 ? query : ' ';
  const filtered = candidates
    .filter((c) => typeof c.text === 'string' && c.text.length > 0)
    .map((c) => ({ id: c.id, text: String(c.text) }));
  if (filtered.length === 0) return [];

  let ce: CrossEncoder;
  try {
    ce = await getReranker();
  } catch (err) {
    // Model absent/disabled/failed to load — previously this rejected all
    // the way up through l4.ts/router.ts uncaught, or (once caught by some
    // outer layer) vanished with no record. Route it through the same
    // visible fallback as an inference failure below.
    return rerankFallback(filtered, topK, getErrorMessage(err));
  }

  let scores: number[];
  try {
    scores = await scorePairs(
      ce,
      safeQuery,
      filtered.map((c) => c.text),
    );
  } catch (err) {
    return rerankFallback(filtered, topK, getErrorMessage(err));
  }

  // Guard against the exact silent-failure shape that hid the softmax bug in
  // the first place: a "successful" rerank (no throw) that scored every
  // distinct candidate identically would sort right back to L3's input order
  // with no signal anything was wrong. If that happens now, treat it as a
  // failure and route through the same visible fallback as a load/inference
  // error — never silently return an all-equal ranking.
  if (hasDistinctTexts(filtered) && allScoresIdentical(scores)) {
    return rerankFallback(
      filtered,
      topK,
      'reranker returned identical scores for distinct candidates',
    );
  }

  const out: RerankHit[] = filtered.map((c, i) => ({
    id: c.id,
    score: scores[i] ?? 0,
  }));
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topK);
}

export function resetRerankerForTests(): void {
  crossEncoder = null;
  pipePromise = null;
  fallbackWarned = false;
}
