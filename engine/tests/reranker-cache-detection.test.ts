/**
 * Regression tests for reranker (L4) bugs found in src/indexer/reranker.ts:
 *
 * 1. isRerankerCached() only checked the "flat" on-disk cache layout
 *    (<modelsPath>/Xenova--ms-marco-MiniLM-L-6-v2/). transformers.js can
 *    also cache a model in the "nested" layout
 *    (<modelsPath>/Xenova/ms-marco-MiniLM-L-6-v2/), which is what
 *    embeddings.ts's isModelCached() already handled (see
 *    tests/embeddings-notice.test.ts). Because reranker.ts had its own
 *    incomplete copy of that check, a model cached ONLY in the nested layout
 *    (the common case on a machine that already ran download-models) was
 *    never found — loadReranker() always threw "model not in local cache",
 *    and the cross-encoder reranker (L4) was never used in the default
 *    configuration, even though the model was present on disk.
 *
 * 2. When that (or any other) load/inference failure happened, rerank()
 *    degraded to identity ranking — returning the candidates back in their
 *    input order — with no error, no log line, and no telemetry. This file
 *    also asserts the fallback is now observable: a one-time stderr warning
 *    plus a 'rerank_fallback' telemetry event on every occurrence.
 *
 * The mocked module surface is AutoTokenizer.from_pretrained /
 * AutoModelForSequenceClassification.from_pretrained rather than the old
 * `pipeline('text-classification', ...)` call — reranker.ts now loads the
 * tokenizer and model directly and reads the model's raw logits instead of
 * routing them through the text-classification pipeline's softmax
 * post-processing (see reranker-raw-logits.test.ts for that regression).
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — declared before the tested modules are imported so vitest
// hoists them above the actual import resolution (same pattern as
// tests/reranker-concurrency.test.ts).
// ---------------------------------------------------------------------------

const tokenizerFactoryMock = vi.hoisted(() => vi.fn());
const modelFactoryMock = vi.hoisted(() => vi.fn());
const warnMock = vi.hoisted(() => vi.fn());
const logTelemetryMock = vi.hoisted(() => vi.fn());

vi.mock('@huggingface/transformers', () => ({
  env: { allowLocalModels: true, allowRemoteModels: false, localModelPath: '', cacheDir: '' },
  AutoTokenizer: { from_pretrained: tokenizerFactoryMock },
  AutoModelForSequenceClassification: { from_pretrained: modelFactoryMock },
}));

let currentModelsPath = '';

vi.mock('../src/util/config.js', () => ({
  getConfig: vi.fn(() => ({
    brainPath: '',
    cachePath: '',
    // Read lazily via a getter-backed closure so each test can point the
    // SUT at its own tmp directory without re-mocking the module.
    get modelsPath() {
      return currentModelsPath;
    },
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

import { getReranker, isRerankerCached, rerank, resetRerankerForTests } from '../src/indexer/reranker.js';

const FLAT_DIR = 'Xenova--ms-marco-MiniLM-L-6-v2';
const NESTED_DIR = join('Xenova', 'ms-marco-MiniLM-L-6-v2');

describe('isRerankerCached — both on-disk cache layouts', () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'lb-reranker-cache-layout-'));
    currentModelsPath = tmpBase;
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('returns false when the model is not cached in either layout', () => {
    expect(isRerankerCached(tmpBase)).toBe(false);
  });

  it('returns true for the flat layout (Xenova--model-name)', () => {
    mkdirSync(join(tmpBase, FLAT_DIR), { recursive: true });
    expect(isRerankerCached(tmpBase)).toBe(true);
  });

  it('returns true for the nested layout (Xenova/model-name) — the bug this regresses', () => {
    // This is the exact layout the profiling agent found on a real machine:
    // the model IS present, but the old flat-only check reported it absent.
    mkdirSync(join(tmpBase, NESTED_DIR), { recursive: true });
    expect(isRerankerCached(tmpBase)).toBe(true);
  });
});

describe('getReranker() — end to end regression: nested-only cache must load, not throw', () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'lb-reranker-nested-e2e-'));
    currentModelsPath = tmpBase;
    delete process.env.LAZYBRAIN_ALLOW_REMOTE_MODELS;
    delete process.env.LAZYBRAIN_EMBEDDINGS;
    tokenizerFactoryMock.mockReset();
    modelFactoryMock.mockReset();
    warnMock.mockClear();
    logTelemetryMock.mockClear();
    resetRerankerForTests();
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
    delete process.env.LAZYBRAIN_ALLOW_REMOTE_MODELS;
  });

  it('resolves the cross-encoder when the model is cached only in the nested layout, with remote downloads unset (default)', async () => {
    mkdirSync(join(tmpBase, NESTED_DIR), { recursive: true });
    const fakeTokenizer = vi.fn();
    const fakeModel = vi.fn();
    tokenizerFactoryMock.mockResolvedValueOnce(fakeTokenizer);
    modelFactoryMock.mockResolvedValueOnce(fakeModel);

    const result = await getReranker();

    expect(result.tokenizer).toBe(fakeTokenizer);
    expect(result.model).toBe(fakeModel);
    expect(tokenizerFactoryMock).toHaveBeenCalledTimes(1);
    expect(modelFactoryMock).toHaveBeenCalledTimes(1);
  });

  it('still throws when the model is genuinely absent from both layouts (sanity check the fix does not over-match)', async () => {
    // No directories created — model absent in both layouts.
    await expect(getReranker()).rejects.toThrow('Reranker model not in local cache');
    expect(tokenizerFactoryMock).not.toHaveBeenCalled();
    expect(modelFactoryMock).not.toHaveBeenCalled();
  });
});

describe('rerank() — a load/inference failure is signalled, never silent', () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'lb-reranker-fallback-visibility-'));
    currentModelsPath = tmpBase;
    delete process.env.LAZYBRAIN_ALLOW_REMOTE_MODELS;
    delete process.env.LAZYBRAIN_EMBEDDINGS;
    tokenizerFactoryMock.mockReset();
    modelFactoryMock.mockReset();
    warnMock.mockClear();
    logTelemetryMock.mockClear();
    resetRerankerForTests();
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
    delete process.env.LAZYBRAIN_ALLOW_REMOTE_MODELS;
  });

  const candidates = [
    { id: 'note-a', text: 'alpha content' },
    { id: 'note-b', text: 'beta content' },
    { id: 'note-c', text: 'gamma content' },
  ];

  it('falls back to identity ranking (no throw) when the model is absent, and warns + logs telemetry', async () => {
    // Model absent from both layouts, remote downloads unset -> getReranker()
    // rejects internally; rerank() must not propagate that rejection.
    const result = await rerank('query text', candidates, 3);

    // Identity fallback: same ids, same order as input, decreasing scores.
    expect(result.map((r) => r.id)).toEqual(['note-a', 'note-b', 'note-c']);
    expect(result[0].score).toBeGreaterThan(result[1].score);

    // Visible: one warning...
    expect(warnMock).toHaveBeenCalledTimes(1);
    const [, warnMsg] = warnMock.mock.calls[0] as [unknown, string];
    expect(warnMsg).toMatch(/reranker.*unavailable/i);

    // ...and a structured telemetry event every occurrence.
    expect(logTelemetryMock).toHaveBeenCalledTimes(1);
    expect(logTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'rerank_fallback', candidates: 3 }),
    );
  });

  it('falls back to identity ranking when the model loads but inference itself throws', async () => {
    mkdirSync(join(tmpBase, NESTED_DIR), { recursive: true });
    const fakeTokenizer = vi.fn(() => ({ input_ids: [], attention_mask: [] }));
    const failingModel = vi.fn().mockRejectedValue(new Error('onnx inference failed'));
    tokenizerFactoryMock.mockResolvedValueOnce(fakeTokenizer);
    modelFactoryMock.mockResolvedValueOnce(failingModel);

    const result = await rerank('query text', candidates, 3);

    expect(result.map((r) => r.id)).toEqual(['note-a', 'note-b', 'note-c']);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(logTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'rerank_fallback', candidates: 3 }),
    );
  });

  it('warns only once across repeated failures, but logs telemetry every time', async () => {
    await rerank('query one', candidates, 3);
    await rerank('query two', candidates, 3);
    await rerank('query three', candidates, 3);

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(logTelemetryMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT warn or log telemetry on a successful rerank (only the failure path is instrumented)', async () => {
    mkdirSync(join(tmpBase, NESTED_DIR), { recursive: true });
    const fakeTokenizer = vi.fn(() => ({ input_ids: [], attention_mask: [] }));
    // Raw logits — note-a highest (most relevant), note-b lowest.
    const workingModel = vi.fn().mockResolvedValue({
      logits: { dims: [3, 1], data: [2.5, -1.0, 0.3] },
    });
    tokenizerFactoryMock.mockResolvedValueOnce(fakeTokenizer);
    modelFactoryMock.mockResolvedValueOnce(workingModel);

    const result = await rerank('query text', candidates, 3);

    expect(result[0].id).toBe('note-a'); // logit 2.5, ranked first
    expect(warnMock).not.toHaveBeenCalled();
    expect(logTelemetryMock).not.toHaveBeenCalled();
  });
});
