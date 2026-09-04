/**
 * Speed fix: SQLite embedding cache — TDD tests
 *
 * Verifies that:
 *  1. upsertNoteEmbedding / loadAllStoredEmbeddings round-trip correctly.
 *  2. resolveCorpusVectors reads from cache (no WASM model call) when all
 *     note embeddings are present and hash-matched.
 *  3. resolveCorpusVectors computes and stores only the missing/stale entries.
 *  4. A query only embeds the query string (1 call), not the whole corpus,
 *     when the cache is warm.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers: spin up a real in-memory SQLite instance via a temp path so we
// don't touch the user's real brain.
// ---------------------------------------------------------------------------

const tempDir = join(tmpdir(), `lb-emb-test-${process.pid}-${Date.now()}`);
mkdirSync(tempDir, { recursive: true });
const tempDbPath = join(tempDir, 'fts.sqlite');

vi.mock('../src/util/config.js', () => ({
  getConfig: vi.fn(() => ({
    brainPath: tempDir,
    cachePath: tempDir,
    modelsPath: tempDir,
    logLevel: 'error',
    telemetry: false,
  })),
  resetConfigForTests: vi.fn(),
}));

vi.mock('../src/store/paths.js', () => ({
  indexPath: () => tempDbPath,
  notesDir: () => join(tempDir, 'notes'),
  batchesDir: () => join(tempDir, 'batches'),
  cachePath: () => join(tempDir, 'cache'),
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

// embeddings.js mock uses importOriginal so hashKey stays real,
// but embed() is tracked. We use a factory to avoid hoisting issues.
vi.mock('../src/indexer/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/indexer/embeddings.js')>();
  return {
    ...actual,
    embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(768).fill(0.42))),
    embedOne: vi.fn(async (_text: string) => new Float32Array(768).fill(0.5)),
  };
});

import { MODEL_ID, hashKey, embed as mockEmbedRef } from '../src/indexer/embeddings.js';
import { closeDb, loadAllStoredEmbeddings, upsertNoteEmbedding } from '../src/indexer/fts.js';

afterEach(() => {
  closeDb();
  if (existsSync(tempDbPath)) rmSync(tempDbPath);
  if (existsSync(`${tempDbPath}-shm`)) rmSync(`${tempDbPath}-shm`);
  if (existsSync(`${tempDbPath}-wal`)) rmSync(`${tempDbPath}-wal`);
});

// ---------------------------------------------------------------------------
// 1. Round-trip: upsert then load
// ---------------------------------------------------------------------------

describe('upsertNoteEmbedding / loadAllStoredEmbeddings — round-trip', () => {
  it('stores and retrieves a 768-dim vector correctly', () => {
    const id = 'note-roundtrip';
    const hash = hashKey('test embed text');
    const vec = new Float32Array(768);
    for (let i = 0; i < 768; i++) vec[i] = Math.sin(i * 0.1);

    upsertNoteEmbedding(id, hash, vec);
    const stored = loadAllStoredEmbeddings();

    expect(stored.has(id)).toBe(true);
    const entry = stored.get(id)!;
    expect(entry.id).toBe(id);
    expect(entry.embedTextHash).toBe(hash);
    expect(entry.vector).toBeInstanceOf(Float32Array);
    expect(entry.vector.length).toBe(768);

    // Verify floating-point round-trip precision (Float32 ≈ 7 sig-digits)
    for (let i = 0; i < 768; i++) {
      expect(Math.abs(entry.vector[i] - vec[i])).toBeLessThan(1e-6);
    }
  });

  it('returns empty Map when no embeddings have been stored', () => {
    const stored = loadAllStoredEmbeddings();
    expect(stored.size).toBe(0);
  });

  it('stores and retrieves modelId, and defaults to null when omitted (legacy row)', () => {
    const hash = hashKey('modelId text');
    const vec = new Float32Array(768).fill(0.3);

    upsertNoteEmbedding('note-with-model', hash, vec, MODEL_ID);
    upsertNoteEmbedding('note-legacy', hash, vec); // omitted -> defaults to null

    const stored = loadAllStoredEmbeddings();
    expect(stored.get('note-with-model')!.modelId).toBe(MODEL_ID);
    expect(stored.get('note-legacy')!.modelId).toBeNull();
  });

  it('overwrites previous embedding on upsert with new hash', () => {
    const id = 'note-overwrite';
    const hash1 = hashKey('original text');
    const hash2 = hashKey('updated text');
    const vec1 = new Float32Array(768).fill(0.1);
    const vec2 = new Float32Array(768).fill(0.9);

    upsertNoteEmbedding(id, hash1, vec1);
    upsertNoteEmbedding(id, hash2, vec2);

    const stored = loadAllStoredEmbeddings();
    expect(stored.size).toBe(1);
    const entry = stored.get(id)!;
    expect(entry.embedTextHash).toBe(hash2);
    expect(entry.vector[0]).toBeCloseTo(0.9, 4);
  });

  it('stores multiple notes and loads them all', () => {
    for (let n = 0; n < 10; n++) {
      const id = `note-${n}`;
      const text = `Embed text for note ${n}`;
      const hash = hashKey(text);
      const vec = new Float32Array(768).fill(n * 0.1);
      upsertNoteEmbedding(id, hash, vec);
    }

    const stored = loadAllStoredEmbeddings();
    expect(stored.size).toBe(10);
    for (let n = 0; n < 10; n++) {
      const id = `note-${n}`;
      expect(stored.has(id)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Router: corpus vectors served from cache, no WASM model at query-time
// ---------------------------------------------------------------------------

// Additional mocks needed for the router
vi.mock('../src/indexer/fts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/indexer/fts.js')>();
  return {
    ...actual,
    allDistinctTags: vi.fn(() => []),
    getTagNoteCount: vi.fn(() => 0),
    getNoteById: vi.fn(() => null),
    getNoteText: vi.fn(() => ''),
    listAll: vi.fn(() => []),
    notesAnsweringQuestion: vi.fn(() => []),
    notesByTagOrType: vi.fn(() => []),
    notesForErrorPattern: vi.fn(() => []),
    notesMatchingPathPrefix: vi.fn(() => []),
    notesMentioningEntity: vi.fn(() => []),
    notesWithWarningsOrNegative: vi.fn(() => []),
    searchFts: vi.fn(() => []),
    searchFtsSpread: vi.fn(() => []),
    recordAccessMany: vi.fn(),
    applyStructuralFieldBoost: actual.applyStructuralFieldBoost,
    // Keep REAL implementations for the embedding cache functions
    loadAllStoredEmbeddings: actual.loadAllStoredEmbeddings,
    upsertNoteEmbedding: actual.upsertNoteEmbedding,
    // listAllWithText returns 3 notes whose embeddings we will pre-populate
    listAllWithText: vi.fn(() => [
      {
        id: 'n1',
        path: 'a.html',
        type: 'decision',
        title: 'Auth',
        text: 'OAuth tokens auth',
        tags: 'auth',
        source: 's:1',
      },
      {
        id: 'n2',
        path: 'b.html',
        type: 'decision',
        title: 'DB',
        text: 'Postgres database',
        tags: 'db',
        source: 's:2',
      },
      {
        id: 'n3',
        path: 'c.html',
        type: 'decision',
        title: 'Cache',
        text: 'Redis cache perf',
        tags: 'perf',
        source: 's:3',
      },
    ]),
  };
});

vi.mock('../src/retrieval/hyde.js', () => ({
  embedQueryForRetrieval: vi.fn(async (_q: string) => new Float32Array(768).fill(0.5)),
}));

vi.mock('../src/indexer/reranker.js', () => ({
  rerank: vi.fn(async (_q: unknown, candidates: { id: string }[], k: number) =>
    candidates.slice(0, k).map((c) => ({ id: c.id, score: 0.9 })),
  ),
}));

vi.mock('../src/indexer/structural.js', () => ({
  structuralQuery: vi.fn(() => []),
}));

vi.mock('../src/retrieval/strip.js', () => ({
  stripNote: vi.fn(() => ({
    id: 'x',
    type: 'decision',
    title: 'T',
    tags: [],
    facts: [],
    links: [],
  })),
  stripTags: vi.fn((s: string) => s.replace(/<[^>]+>/g, '')),
}));

vi.mock('../src/graph/backlinks.js', () => ({ loadBacklinks: vi.fn(() => null) }));
vi.mock('../src/graph/pagerank.js', () => ({
  computePageRank: vi.fn(() => ({ scores: {} })),
  notesForCwd: vi.fn(() => []),
  recentNotes: vi.fn(() => []),
}));
vi.mock('../src/store/reader.js', () => ({
  readNote: vi.fn(() => ({ html: '<article></article>' })),
}));
vi.mock('../src/annotator/entities.js', () => ({
  resolveEntityKeysInQuery: vi.fn(() => []),
}));
vi.mock('../src/retrieval/mmr.js', () => ({
  mmr: vi.fn((inputs: { id: string }[], k: number) => inputs.slice(0, k).map((i) => i.id)),
}));

import { route } from '../src/retrieval/router.js';

// Pre-compute the exact embed text that router will build for the 3 notes
// (mirrors buildEmbedText in router.ts — title\ntags\nbody slice 1800)
function buildEmbedText(n: { title?: string; tags?: string; text?: string }): string {
  const title = (n.title ?? '').trim();
  const tags = (n.tags ?? '').trim();
  const body = (n.text ?? '').slice(0, 1800).trim();
  return [title, tags, body].filter(Boolean).join('\n');
}

const NOTES = [
  { id: 'n1', title: 'Auth', tags: 'auth', text: 'OAuth tokens auth' },
  { id: 'n2', title: 'DB', tags: 'db', text: 'Postgres database' },
  { id: 'n3', title: 'Cache', tags: 'perf', text: 'Redis cache perf' },
];

describe('resolveCorpusVectors — cache read path (no recompute)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Pre-populate SQLite with embeddings for all 3 notes, tagged with the
    // CURRENT model — a real warm-cache hit requires both the text hash AND
    // the model id to match (see model-versioning tests below for the case
    // where modelId is stale/missing).
    for (const n of NOTES) {
      const text = buildEmbedText(n);
      const hash = hashKey(text);
      const vec = new Float32Array(768).fill(0.42);
      upsertNoteEmbedding(n.id, hash, vec, MODEL_ID);
    }
  });

  it('does NOT call embed() for corpus when all note embeddings are in SQLite cache', async () => {
    const embedSpy = vi.mocked(mockEmbedRef);
    embedSpy.mockClear();

    await route({ query: 'OAuth tokens auth strategy', level: 'L3' });

    // embed() should NOT have been called for corpus texts
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it('returns valid hits even when corpus vectors come entirely from SQLite', async () => {
    const result = await route({ query: 'OAuth tokens auth strategy', level: 'L3' });
    expect(result.hits).toBeDefined();
    expect(Array.isArray(result.hits)).toBe(true);
  });

  it('computes only the 1 stale note when hash is stale (text changed)', async () => {
    const embedSpy = vi.mocked(mockEmbedRef);
    embedSpy.mockClear();

    // n2 has a stale hash — force it by upserting with a wrong hash
    upsertNoteEmbedding('n2', 'deadbeef', new Float32Array(768).fill(0.1));

    await route({ query: 'database query L3', level: 'L3' });

    // embed() must have been called exactly once for the 1 stale note
    expect(embedSpy).toHaveBeenCalledTimes(1);
    const calledWith = embedSpy.mock.calls[0][0] as string[];
    expect(calledWith).toHaveLength(1); // only n2

    // The stale entry should now be replaced with the correct hash
    const stored = loadAllStoredEmbeddings();
    const n2Entry = stored.get('n2');
    expect(n2Entry).toBeDefined();
    expect(n2Entry!.embedTextHash).not.toBe('deadbeef');
  });
});

// ---------------------------------------------------------------------------
// 2b. Model versioning: a text-hash match under a DIFFERENT model must still
//     be treated as stale (the footgun this fix closes).
// ---------------------------------------------------------------------------

describe('resolveCorpusVectors — model versioning', () => {
  const STALE_MODEL_ID = 'Xenova/bge-base-en-v1.5';

  beforeEach(() => {
    vi.clearAllMocks();
    // Pre-populate with a CORRECT text hash but a STALE model id — simulates
    // a brain indexed before the bge -> mpnet switch: same text, same hash,
    // different (old) model.
    for (const n of NOTES) {
      const text = buildEmbedText(n);
      const hash = hashKey(text);
      const vec = new Float32Array(768).fill(0.42);
      upsertNoteEmbedding(n.id, hash, vec, STALE_MODEL_ID);
    }
  });

  it('does NOT serve a hash-matched vector when modelId is stale — re-embeds all notes', async () => {
    const embedSpy = vi.mocked(mockEmbedRef);
    embedSpy.mockClear();

    await route({ query: 'OAuth tokens auth strategy', level: 'L3' });

    // Hash matched for all 3 notes, but model did not -> all 3 must be
    // recomputed, not silently served from the stale-model cache.
    expect(embedSpy).toHaveBeenCalledTimes(1);
    const calledWith = embedSpy.mock.calls[0][0] as string[];
    expect(calledWith).toHaveLength(3);
  });

  it('re-tags rows with the current MODEL_ID after re-embedding', async () => {
    await route({ query: 'OAuth tokens auth strategy', level: 'L3' });

    const stored = loadAllStoredEmbeddings();
    for (const n of NOTES) {
      expect(stored.get(n.id)!.modelId).toBe(MODEL_ID);
    }
  });

  it('a row with modelId=null (pre-migration legacy row) is also treated as stale', async () => {
    // Overwrite n1 with a legacy-style row: correct hash, no model info.
    const hash = hashKey(buildEmbedText(NOTES[0]));
    upsertNoteEmbedding('n1', hash, new Float32Array(768).fill(0.42)); // modelId omitted -> null

    const embedSpy = vi.mocked(mockEmbedRef);
    embedSpy.mockClear();

    await route({ query: 'OAuth tokens auth strategy', level: 'L3' });

    // n1 (null modelId) must be among the recomputed notes.
    const calledWith = embedSpy.mock.calls[0][0] as string[];
    expect(calledWith).toContain(buildEmbedText(NOTES[0]));
  });
});

describe('resolveCorpusVectors — cold cache (first run after index rebuild)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No embeddings in SQLite — simulates a fresh index rebuild
  });

  it('calls embed() once for all corpus notes when cache is empty', async () => {
    const embedSpy = vi.mocked(mockEmbedRef);
    embedSpy.mockClear();

    await route({ query: 'OAuth tokens auth strategy', level: 'L3' });

    // Should have called embed() once with all 3 note texts
    expect(embedSpy).toHaveBeenCalledTimes(1);
    const calledWith = embedSpy.mock.calls[0][0] as string[];
    expect(calledWith).toHaveLength(3);
  });

  it('stores all computed embeddings into SQLite after cold-path compute', async () => {
    await route({ query: 'database strategy', level: 'L3' });

    const stored = loadAllStoredEmbeddings();
    expect(stored.size).toBe(3);
    expect(stored.has('n1')).toBe(true);
    expect(stored.has('n2')).toBe(true);
    expect(stored.has('n3')).toBe(true);
  });
});

describe('hashKey — determinism', () => {
  it('returns the same hash for the same input', () => {
    const text = 'Auth\nauth\nOAuth tokens auth';
    const h1 = hashKey(text);
    const h2 = hashKey(text);
    expect(h1).toBe(h2);
  });

  it('returns different hashes for different inputs', () => {
    expect(hashKey('text one')).not.toBe(hashKey('text two'));
  });

  it('returns a hex string', () => {
    const h = hashKey('some text');
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });
});
