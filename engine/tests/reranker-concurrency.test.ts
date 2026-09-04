/**
 * Regression tests for the cold-start concurrency bug in getReranker()
 * (src/indexer/reranker.ts) — the identical single-value-cache pattern as
 * getEmbedder() in embeddings.ts (see tests/embeddings-concurrency.test.ts
 * for the full bug writeup). getReranker() cached only the RESOLVED
 * cross-encoder (tokenizer + model), not the in-flight load, so two callers
 * racing before the first from_pretrained() load resolved would each start
 * their own ONNX load.
 *
 * Unlike getEmbedder(), getReranker() has no sticky "unavailable" flag: a
 * failed load (model not cached, or from_pretrained() rejects) is expected to
 * let the NEXT call retry from scratch — that pre-existing contract must keep
 * working after adding in-flight memoization.
 *
 * The mocked module surface is AutoTokenizer.from_pretrained /
 * AutoModelForSequenceClassification.from_pretrained rather than the old
 * `pipeline('text-classification', ...)` call — reranker.ts now loads the
 * tokenizer and model directly so it can read raw cross-encoder logits
 * instead of routing them through the text-classification pipeline's softmax
 * post-processing (see reranker-raw-logits.test.ts for that regression).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpBase = mkdtempSync(join(tmpdir(), 'lb-reranker-concurrency-test-'));

// Stand-ins for the resolved tokenizer/model. Distinct identity lets us
// assert every concurrent caller received the SAME instances.
const innerTokenizerMock = vi.hoisted(() => vi.fn());
const innerModelMock = vi.hoisted(() => vi.fn());
// The transformers.js from_pretrained() factories — the expensive ONNX loads
// that must happen at most once per cold start no matter how many callers
// race getReranker().
const tokenizerFactoryMock = vi.hoisted(() => vi.fn());
const modelFactoryMock = vi.hoisted(() => vi.fn());

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

import { getReranker, resetRerankerForTests } from '../src/indexer/reranker.js';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  // remoteAllowed path: skips the isRerankerCached() precondition, so these
  // tests exercise pure load-memoization behavior without an on-disk model.
  process.env.LAZYBRAIN_ALLOW_REMOTE_MODELS = '1';
  tokenizerFactoryMock.mockReset();
  modelFactoryMock.mockReset();
  resetRerankerForTests();
});

afterEach(() => {
  delete process.env.LAZYBRAIN_ALLOW_REMOTE_MODELS;
});

describe('getReranker — in-flight promise memoization (cold-start dedupe)', () => {
  it('N concurrent callers trigger the underlying from_pretrained factories exactly once each', async () => {
    const tokenizerDeferred = createDeferred<typeof innerTokenizerMock>();
    const modelDeferred = createDeferred<typeof innerModelMock>();
    tokenizerFactoryMock.mockImplementation(() => tokenizerDeferred.promise);
    modelFactoryMock.mockImplementation(() => modelDeferred.promise);

    const N = 5;
    const calls = Array.from({ length: N }, () => getReranker());

    expect(tokenizerFactoryMock).toHaveBeenCalledTimes(1);
    expect(modelFactoryMock).toHaveBeenCalledTimes(1);

    tokenizerDeferred.resolve(innerTokenizerMock);
    modelDeferred.resolve(innerModelMock);
    const results = await Promise.all(calls);

    expect(tokenizerFactoryMock).toHaveBeenCalledTimes(1);
    expect(modelFactoryMock).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.tokenizer).toBe(innerTokenizerMock);
      expect(result.model).toBe(innerModelMock);
    }
  });

  it('a resolved load is served from cache on subsequent calls without re-invoking from_pretrained', async () => {
    tokenizerFactoryMock.mockResolvedValueOnce(innerTokenizerMock);
    modelFactoryMock.mockResolvedValueOnce(innerModelMock);

    const first = await getReranker();
    const second = await getReranker();

    expect(first.tokenizer).toBe(innerTokenizerMock);
    expect(first.model).toBe(innerModelMock);
    expect(second.tokenizer).toBe(innerTokenizerMock);
    expect(second.model).toBe(innerModelMock);
    expect(tokenizerFactoryMock).toHaveBeenCalledTimes(1);
    expect(modelFactoryMock).toHaveBeenCalledTimes(1);
  });

  it('a rejected load resets pipePromise so the next call retries and can succeed', async () => {
    tokenizerFactoryMock.mockResolvedValue(innerTokenizerMock);
    modelFactoryMock.mockRejectedValueOnce(new Error('onnx load failed'));

    await expect(getReranker()).rejects.toThrow('onnx load failed');

    // Unlike the embedder, the reranker has no sticky unavailable flag —
    // the very next call must retry from_pretrained() fresh, not replay the
    // cached rejection.
    modelFactoryMock.mockResolvedValueOnce(innerModelMock);
    const result = await getReranker();

    expect(result.tokenizer).toBe(innerTokenizerMock);
    expect(result.model).toBe(innerModelMock);
    expect(modelFactoryMock).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers during a load that rejects all see the same rejection, then a later call retries', async () => {
    const modelDeferred = createDeferred<typeof innerModelMock>();
    tokenizerFactoryMock.mockResolvedValue(innerTokenizerMock);
    modelFactoryMock.mockImplementation(() => modelDeferred.promise);

    const callA = getReranker();
    const callB = getReranker();
    expect(modelFactoryMock).toHaveBeenCalledTimes(1);

    modelDeferred.reject(new Error('onnx load failed'));

    await expect(callA).rejects.toThrow('onnx load failed');
    await expect(callB).rejects.toThrow('onnx load failed');

    modelFactoryMock.mockResolvedValueOnce(innerModelMock);
    const third = await getReranker();

    expect(third.model).toBe(innerModelMock);
    expect(modelFactoryMock).toHaveBeenCalledTimes(2);
  });
});
