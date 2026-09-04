/**
 * Regression test for the softmax-collapse bug in rerank() (src/indexer/
 * reranker.ts).
 *
 * The cross-encoder model (Xenova/ms-marco-MiniLM-L-6-v2) is a single-output
 * regression head — its config has `id2label: {"0": "LABEL_0"}`, one
 * relevance logit per (query, document) pair, not a class distribution. The
 * old code ran inference through the `pipeline('text-classification', ...)`
 * wrapper, whose default post-processing applies `softmax(batch.data)`
 * unconditionally (see node_modules/@huggingface/transformers/src/
 * pipelines.js, TextClassificationPipeline._call). Softmax over a single
 * value is mathematically always exactly 1.0, regardless of the underlying
 * logit — so every candidate scored identically and rerank()'s sort
 * preserved L3's input order untouched. No error was thrown and nothing
 * logged: L4 silently never reranked anything.
 *
 * Confirmed empirically against the real cached model before the fix: raw
 * logits for two genuinely different candidates were -5.98 and -7.35, but
 * running the same pairs through the text-classification pipeline returned
 * 1.0 for both.
 *
 * This file asserts, at the unit level with a mocked model:
 *   1. rerank() reads the RAW logit (no softmax) and sorts by it — distinct
 *      candidates that score differently produce a different order than the
 *      input order.
 *   2. if the model ever again returns identical scores for distinct
 *      candidates, rerank() treats that as a failure and routes through the
 *      same visible (warn + telemetry) fallback as a load/inference error,
 *      instead of silently returning an all-equal ranking. This single
 *      assertion is the guard that would have caught the original bug from
 *      day one.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';

const tmpBase = mkdtempSync(join(tmpdir(), 'lb-reranker-raw-logits-'));

const tokenizerFactoryMock = vi.hoisted(() => vi.fn());
const modelFactoryMock = vi.hoisted(() => vi.fn());
const warnMock = vi.hoisted(() => vi.fn());
const logTelemetryMock = vi.hoisted(() => vi.fn());

vi.mock('@huggingface/transformers', () => ({
  env: { allowLocalModels: true, allowRemoteModels: false, localModelPath: '', cacheDir: '' },
  AutoTokenizer: { from_pretrained: tokenizerFactoryMock },
  AutoModelForSequenceClassification: { from_pretrained: modelFactoryMock },
}));

vi.mock('../src/util/config.js', () => ({
  getConfig: vi.fn(() => ({
    brainPath: tmpBase,
    cachePath: tmpBase,
    modelsPath: tmpBase,
    logLevel: 'error',
    telemetry: false,
  })),
  resetConfigForTests: vi.fn(),
}));

vi.mock('../src/util/logger.js', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: warnMock,
    info: vi.fn(),
    error: vi.fn(),
  })),
  resetLoggerForTests: vi.fn(),
}));

vi.mock('../src/util/telemetry.js', () => ({
  logTelemetry: logTelemetryMock,
  nowIso: vi.fn(() => '2026-08-14T00:00:00.000Z'),
}));

import { rerank, resetRerankerForTests } from '../src/indexer/reranker.js';

const candidates = [
  { id: 'decoy', text: 'Python is a popular programming language used for scripting.' },
  { id: 'true-match', text: 'Use try/except blocks to handle exceptions gracefully in Python.' },
];

beforeEach(() => {
  process.env.LAZYBRAIN_ALLOW_REMOTE_MODELS = '1';
  tokenizerFactoryMock.mockReset();
  modelFactoryMock.mockReset();
  warnMock.mockClear();
  logTelemetryMock.mockClear();
  resetRerankerForTests();
});

it('scores distinct candidates from the RAW logit, not a softmax-collapsed 1.0, and sorts by it', async () => {
  const fakeTokenizer = vi.fn(() => ({ input_ids: [], attention_mask: [] }));
  // Real values recorded from the model before this fix: distinct raw
  // logits, in [decoy, true-match] input order — the true match scores
  // higher (less negative) once L4 actually reads the real signal.
  const fakeModel = vi.fn().mockResolvedValue({
    logits: { dims: [2, 1], data: [-7.35, -5.98] },
  });
  tokenizerFactoryMock.mockResolvedValueOnce(fakeTokenizer);
  modelFactoryMock.mockResolvedValueOnce(fakeModel);

  const result = await rerank('python error handling', candidates, 2);

  // The core assertion this whole defect hinges on: scores must differ.
  expect(result[0].score).not.toBe(result[1].score);
  // And the reported score is the raw logit itself — never 1.0/collapsed.
  const byId = new Map(result.map((r) => [r.id, r.score]));
  expect(byId.get('decoy')).toBe(-7.35);
  expect(byId.get('true-match')).toBe(-5.98);
  // Higher (less negative) raw logit ranks first.
  expect(result[0].id).toBe('true-match');

  // A real, successful rerank must not trip the fallback-visibility path.
  expect(warnMock).not.toHaveBeenCalled();
  expect(logTelemetryMock).not.toHaveBeenCalled();
});

it('treats identical scores for distinct candidates as a failure, not a valid ranking', async () => {
  const fakeTokenizer = vi.fn(() => ({ input_ids: [], attention_mask: [] }));
  // Reproduces the exact shape of the original bug: two genuinely different
  // candidates, but the model call returns the same score for both (e.g. a
  // softmax-collapsed 1.0, or any other constant-score regression).
  const fakeModel = vi.fn().mockResolvedValue({
    logits: { dims: [2, 1], data: [1, 1] },
  });
  tokenizerFactoryMock.mockResolvedValueOnce(fakeTokenizer);
  modelFactoryMock.mockResolvedValueOnce(fakeModel);

  const result = await rerank('python error handling', candidates, 2);

  // Falls back to identity ranking (input order), same shape as a
  // load/inference failure — never silently returns an all-equal ranking.
  expect(result.map((r) => r.id)).toEqual(['decoy', 'true-match']);
  expect(result[0].score).toBeGreaterThan(result[1].score);

  // And, critically, this is surfaced — not silent.
  expect(warnMock).toHaveBeenCalledTimes(1);
  expect(logTelemetryMock).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'rerank_fallback',
      reason: expect.stringMatching(/identical/i),
    }),
  );
});

it('does not flag single-candidate or same-text inputs as a fallback (identical score is legitimate there)', async () => {
  const fakeTokenizer = vi.fn(() => ({ input_ids: [], attention_mask: [] }));
  const fakeModel = vi.fn().mockResolvedValue({
    logits: { dims: [1, 1], data: [-3.2] },
  });
  tokenizerFactoryMock.mockResolvedValueOnce(fakeTokenizer);
  modelFactoryMock.mockResolvedValueOnce(fakeModel);

  const result = await rerank('query', [candidates[0]], 1);

  expect(result).toEqual([{ id: 'decoy', score: -3.2 }]);
  expect(warnMock).not.toHaveBeenCalled();
  expect(logTelemetryMock).not.toHaveBeenCalled();
});
