/**
 * Model-versioning tests for the on-disk embeddings.bin cache (embeddings.ts).
 *
 * Context: the embedding model changed (bge-base -> paraphrase-multilingual-
 * mpnet, both 768-dim). Before this fix, embeddings.bin keyed vectors purely
 * by a hash of the TEXT, so a cache built under the old model would silently
 * serve stale vectors to the new model — same dimension, no crash, wrong
 * cosine similarity. embeddings.ts now prefixes the file with a small header
 * ("LBC2" magic + model id) so a model mismatch (or a pre-header legacy
 * file) is detected cheaply and the whole cache is discarded rather than
 * trusted.
 *
 * Coverage:
 *   1. A vector cached under a DIFFERENT model id is NOT served — embed()
 *      recomputes instead of returning the stale bytes.
 *   2. A fresh embed computed under the CURRENT model is persisted and IS
 *      served back on a subsequent (simulated cross-process) load.
 *   3. A pre-versioning legacy file (no header at all) is treated as absent
 *      — no crash, transparent recompute.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DIM = 768;
const CACHE_MAGIC = Buffer.from('LBC2', 'ascii');

// ---------------------------------------------------------------------------
// Fixture builders — mirror the private binary format in embeddings.ts.
// Duplicated intentionally: loadCache/saveCache/CACHE_MAGIC are not exported,
// so a black-box test constructs the bytes directly, the same way a
// different process/version of the code would have written them.
// ---------------------------------------------------------------------------

function buildLegacyBinBuffer(entries: Array<{ key: string; vec: Float32Array }>): Buffer {
  let size = 4;
  for (const e of entries) size += 1 + Buffer.byteLength(e.key, 'utf8') + DIM * 4;
  const buf = Buffer.alloc(size);
  let offset = 0;
  buf.writeUInt32LE(entries.length, offset);
  offset += 4;
  for (const e of entries) {
    const keyBytes = Buffer.from(e.key, 'utf8');
    buf.writeUInt8(keyBytes.length, offset);
    offset += 1;
    keyBytes.copy(buf, offset);
    offset += keyBytes.length;
    for (let j = 0; j < DIM; j++) {
      buf.writeFloatLE(e.vec[j] ?? 0, offset);
      offset += 4;
    }
  }
  return buf;
}

function buildVersionedBinBuffer(
  modelId: string,
  entries: Array<{ key: string; vec: Float32Array }>,
): Buffer {
  const modelIdBytes = Buffer.from(modelId, 'utf8');
  let size = CACHE_MAGIC.length + 2 + modelIdBytes.length + 4;
  for (const e of entries) size += 1 + Buffer.byteLength(e.key, 'utf8') + DIM * 4;
  const buf = Buffer.alloc(size);
  let offset = 0;
  CACHE_MAGIC.copy(buf, offset);
  offset += CACHE_MAGIC.length;
  buf.writeUInt16LE(modelIdBytes.length, offset);
  offset += 2;
  modelIdBytes.copy(buf, offset);
  offset += modelIdBytes.length;
  buf.writeUInt32LE(entries.length, offset);
  offset += 4;
  for (const e of entries) {
    const keyBytes = Buffer.from(e.key, 'utf8');
    buf.writeUInt8(keyBytes.length, offset);
    offset += 1;
    keyBytes.copy(buf, offset);
    offset += keyBytes.length;
    for (let j = 0; j < DIM; j++) {
      buf.writeFloatLE(e.vec[j] ?? 0, offset);
      offset += 4;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const tmpBase = mkdtempSync(join(tmpdir(), 'lb-bin-cache-test-'));
const cacheFilePath = join(tmpBase, 'embeddings.bin');

const innerEmbedderMock = vi.hoisted(() => vi.fn());

vi.mock('@huggingface/transformers', () => ({
  env: { allowLocalModels: true, allowRemoteModels: false, localModelPath: '', cacheDir: '' },
  pipeline: vi.fn(async () => innerEmbedderMock),
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

const loggerInfoSpy = vi.fn();
vi.mock('../src/util/logger.js', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: loggerInfoSpy,
    error: vi.fn(),
  })),
}));

vi.mock('../src/util/telemetry.js', () => ({
  logTelemetry: vi.fn(),
  nowIso: vi.fn(() => new Date().toISOString()),
}));

import { MODEL_ID, embed, hashKey, resetEmbedderForTests } from '../src/indexer/embeddings.js';

const STALE_MODEL_ID = 'Xenova/bge-base-en-v1.5';

beforeEach(() => {
  process.env.LAZYBRAIN_ALLOW_REMOTE_MODELS = '1';
  resetEmbedderForTests();
  innerEmbedderMock.mockReset();
  innerEmbedderMock.mockImplementation(async (texts: string[]) => {
    const data = new Float32Array(texts.length * DIM).fill(0.123);
    return { data };
  });
  loggerInfoSpy.mockClear();
  if (existsSync(cacheFilePath)) rmSync(cacheFilePath);
});

afterEach(() => {
  if (existsSync(cacheFilePath)) rmSync(cacheFilePath);
});

// ---------------------------------------------------------------------------
// 1. Stale-model cache is not served
// ---------------------------------------------------------------------------

describe('embed() — vector cached under a different model is NOT served', () => {
  it('recomputes instead of returning the stale-model vector', async () => {
    const text = 'shared embed text';
    const key = hashKey(text);
    const staleVec = new Float32Array(DIM).fill(0.999); // deliberately distinct from mock output
    mkdirSync(tmpBase, { recursive: true });
    writeFileSync(cacheFilePath, buildVersionedBinBuffer(STALE_MODEL_ID, [{ key, vec: staleVec }]));

    const [result] = await embed([text]);

    // The mocked embedder MUST have been called — proves the stale-model
    // entry was rejected as a cache hit, not silently returned.
    expect(innerEmbedderMock).toHaveBeenCalledTimes(1);
    // The returned vector is the freshly computed one (0.123), not the
    // stale model-A vector (0.999) that was sitting in the file.
    expect(result[0]).toBeCloseTo(0.123, 5);
    expect(result[0]).not.toBeCloseTo(0.999, 5);
  });

  it('logs an informative one-time message naming old and new model ids', async () => {
    const key = hashKey('some text');
    writeFileSync(
      cacheFilePath,
      buildVersionedBinBuffer(STALE_MODEL_ID, [{ key, vec: new Float32Array(DIM) }]),
    );

    await embed(['some text']);

    const messages = loggerInfoSpy.mock.calls.map((c) => String(c[1] ?? ''));
    expect(messages.some((m) => m.includes('embedding cache invalidated'))).toBe(true);
    const payloads = loggerInfoSpy.mock.calls.map((c) => c[0]);
    expect(
      payloads.some((p) => p?.previousModelId === STALE_MODEL_ID && p?.modelId === MODEL_ID),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Fresh embed under the current model is cached AND served later
// ---------------------------------------------------------------------------

describe('embed() — fresh vector under current model is cached and served', () => {
  it('persists the vector and serves it on a subsequent (simulated new-process) load', async () => {
    const text = 'fresh text under current model';

    const [first] = await embed([text]);
    expect(innerEmbedderMock).toHaveBeenCalledTimes(1);

    // Simulate a new process picking up the same on-disk cache: reset the
    // in-memory module state (NOT the file) and call embed() again.
    resetEmbedderForTests();
    innerEmbedderMock.mockClear();

    const [second] = await embed([text]);

    // Served from disk cache — the (mocked) model must NOT be invoked again.
    expect(innerEmbedderMock).not.toHaveBeenCalled();
    expect(Array.from(second)).toEqual(Array.from(first));

    // The persisted file now carries the current model's header.
    const raw = readFileSync(cacheFilePath);
    expect(raw.subarray(0, CACHE_MAGIC.length).equals(CACHE_MAGIC)).toBe(true);
    const modelIdLen = raw.readUInt16LE(CACHE_MAGIC.length);
    const storedModelId = raw
      .subarray(CACHE_MAGIC.length + 2, CACHE_MAGIC.length + 2 + modelIdLen)
      .toString('utf8');
    expect(storedModelId).toBe(MODEL_ID);
  });
});

// ---------------------------------------------------------------------------
// 3. Pre-versioning legacy cache (no header) is treated as absent, no crash
// ---------------------------------------------------------------------------

describe('embed() — legacy (unversioned) cache file', () => {
  it('is treated as absent and recomputed without throwing', async () => {
    const text = 'legacy format text';
    const key = hashKey(text);
    const legacyVec = new Float32Array(DIM).fill(0.777);
    writeFileSync(cacheFilePath, buildLegacyBinBuffer([{ key, vec: legacyVec }]));

    await expect(embed([text])).resolves.not.toThrow();
    const [result] = await embed([text]);

    expect(innerEmbedderMock.mock.calls.length).toBeGreaterThan(0);
    expect(result[0]).toBeCloseTo(0.123, 5);
    expect(result[0]).not.toBeCloseTo(0.777, 5);
  });

  it('logs an informative one-time message about the legacy cache', async () => {
    writeFileSync(cacheFilePath, buildLegacyBinBuffer([]));

    await embed(['anything']);

    const messages = loggerInfoSpy.mock.calls.map((c) => String(c[1] ?? ''));
    expect(messages.some((m) => m.includes('embedding cache invalidated'))).toBe(true);
  });

  it('handles a truncated/corrupt file gracefully (pre-existing warn path)', async () => {
    // 2 bytes: not even enough for the magic marker.
    writeFileSync(cacheFilePath, Buffer.from([0x4c, 0x42]));

    await expect(embed(['whatever'])).resolves.not.toThrow();
  });
});
