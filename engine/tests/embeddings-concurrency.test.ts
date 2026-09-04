/**
 * Regression tests for the cold-start concurrency bug in getEmbedder()
 * (src/indexer/embeddings.ts).
 *
 * Bug: getEmbedder() cached only the RESOLVED pipeline (`pipe`), not the
 * in-flight load. Two callers landing before the first pipeline() load
 * resolved — e.g. the serve.ts boot warmup racing the user's first recall —
 * each started their own ~283MB ONNX pipeline() load: double allocation and
 * double CPU during the exact cold-start window.
 *
 * Fix: the in-flight promise is now memoized in `pipePromise`. Coverage:
 *  1. N concurrent getEmbedder() callers trigger the underlying pipeline()
 *     factory exactly ONCE, and all of them resolve to the SAME pipe.
 *  2. A load that rejects outside the internal pipeline() try/catch (e.g.
 *     getConfig() throwing) resets pipePromise so the next call retries
 *     instead of replaying a cached rejection forever.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpBase = mkdtempSync(join(tmpdir(), 'lb-embed-concurrency-test-'));

// The fake resolved pipeline object — distinct identity so we can assert
// every concurrent caller received the SAME instance (not independently
// constructed copies).
const innerEmbedderMock = vi.hoisted(() => vi.fn());
// The transformers.js pipeline() factory itself — this is the expensive
// ~283MB ONNX load. The whole point of the fix is that this must be called
// exactly once no matter how many callers race getEmbedder().
const pipelineFactoryMock = vi.hoisted(() => vi.fn());

vi.mock('@huggingface/transformers', () => ({
  env: { allowLocalModels: true, allowRemoteModels: false, localModelPath: '', cacheDir: '' },
  pipeline: pipelineFactoryMock,
}));

const getConfigMock = vi.hoisted(() => vi.fn());
vi.mock('../src/util/config.js', () => ({
  getConfig: getConfigMock,
  resetConfigForTests: vi.fn(),
}));

vi.mock('../src/util/logger.js', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../src/util/telemetry.js', () => ({
  logTelemetry: vi.fn(),
  nowIso: vi.fn(() => new Date().toISOString()),
}));

import { getEmbedder, resetEmbedderForTests } from '../src/indexer/embeddings.js';

/** A promise whose resolution is controlled from outside, to pin down the
 * exact moment the mocked pipeline() load "finishes" relative to when
 * concurrent getEmbedder() calls are issued. */
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
  // remoteAllowed path: skips the isModelCached() precondition entirely, so
  // these tests exercise pure load-memoization behavior without needing a
  // real on-disk model directory.
  process.env.LAZYBRAIN_ALLOW_REMOTE_MODELS = '1';
  getConfigMock.mockReset();
  getConfigMock.mockImplementation(() => ({
    brainPath: tmpBase,
    cachePath: tmpBase,
    modelsPath: tmpBase,
    logLevel: 'error',
    telemetry: false,
  }));
  pipelineFactoryMock.mockReset();
  resetEmbedderForTests();
});

afterEach(() => {
  delete process.env.LAZYBRAIN_ALLOW_REMOTE_MODELS;
});

describe('getEmbedder — in-flight promise memoization (cold-start dedupe)', () => {
  it('N concurrent callers trigger the underlying pipeline() factory exactly once', async () => {
    const deferred = createDeferred<typeof innerEmbedderMock>();
    pipelineFactoryMock.mockImplementation(() => deferred.promise);

    const N = 5;
    // Issue all N calls back-to-back with no await between them — this is
    // the cold-start race from the bug report: the serve.ts warmup call and
    // the first-recall call both land before pipeline() resolves.
    const calls = Array.from({ length: N }, () => getEmbedder());

    // Even before the pipeline() load resolves, exactly one factory call
    // must have been made — the other N-1 callers must have joined the
    // in-flight promise instead of starting their own load.
    expect(pipelineFactoryMock).toHaveBeenCalledTimes(1);

    deferred.resolve(innerEmbedderMock);
    const results = await Promise.all(calls);

    // Still exactly one factory call after everything settles.
    expect(pipelineFactoryMock).toHaveBeenCalledTimes(1);
    // Every concurrent caller resolved to the SAME pipe instance.
    for (const result of results) {
      expect(result).toBe(innerEmbedderMock);
    }
  });

  it('a resolved load is served from `pipe` on subsequent calls without re-invoking pipeline()', async () => {
    pipelineFactoryMock.mockResolvedValueOnce(innerEmbedderMock);

    const first = await getEmbedder();
    const second = await getEmbedder();

    expect(first).toBe(innerEmbedderMock);
    expect(second).toBe(innerEmbedderMock);
    expect(pipelineFactoryMock).toHaveBeenCalledTimes(1);
  });

  it('a load that rejects outside the pipeline() try/catch resets pipePromise so the next call retries', async () => {
    // pipeline()-load failures are caught internally by loadEmbedder() and
    // converted into a sticky `embedderUnavailable=true` (by design — see
    // the getEmbedder() docstring: "warning is logged only once"). The
    // promise-memoization safety net this test targets is for failures
    // that escape that inner try/catch entirely, such as getConfig()
    // throwing during the pre-pipeline() setup phase.
    getConfigMock.mockImplementationOnce(() => {
      throw new Error('config boom');
    });

    await expect(getEmbedder()).rejects.toThrow('config boom');

    // The next call must retry from scratch (fresh getConfig() + pipeline()
    // call), not replay the cached rejection.
    pipelineFactoryMock.mockResolvedValueOnce(innerEmbedderMock);
    const result = await getEmbedder();

    expect(result).toBe(innerEmbedderMock);
    expect(pipelineFactoryMock).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers during a load that rejects all see the same rejection, then a later call retries', async () => {
    const deferred = createDeferred<typeof innerEmbedderMock>();
    pipelineFactoryMock.mockImplementation(() => deferred.promise);

    const callA = getEmbedder();
    const callB = getEmbedder();
    expect(pipelineFactoryMock).toHaveBeenCalledTimes(1);

    deferred.reject(new Error('onnx load failed'));

    // Both concurrent callers awaited the SAME in-flight promise — but this
    // particular rejection point (inside pipeline()'s own await) is caught
    // by loadEmbedder()'s internal try/catch, so getEmbedder() resolves to
    // null (sticky embedderUnavailable) rather than rejecting.
    await expect(callA).resolves.toBeNull();
    await expect(callB).resolves.toBeNull();

    // Sticky by design: a later call does NOT retry pipeline() again once
    // embedderUnavailable is set — this preserves the pre-existing
    // "warn once" contract and must not regress.
    pipelineFactoryMock.mockClear();
    const third = await getEmbedder();
    expect(third).toBeNull();
    expect(pipelineFactoryMock).not.toHaveBeenCalled();
  });
});
