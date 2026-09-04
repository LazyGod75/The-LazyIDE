/**
 * Tests for graceful L3→L2 fallback when ONNX embedding models are absent.
 *
 * Strategy: mock the FTS module to return a predictable set of notes, force
 * the embedder into the "unavailable" state, then assert that route() still
 * returns L2 results instead of throwing or returning empty results.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — declared before the tested modules are imported so that
// vitest hoists them above the actual import resolution.
// ---------------------------------------------------------------------------

const MOCK_FTS_HITS = [
  {
    id: 'note-alpha',
    path: 'notes/2026-01/alpha.html',
    title: 'Alpha Note',
    snippet: 'alpha content',
    bm25: 1.5,
  },
  {
    id: 'note-beta',
    path: 'notes/2026-01/beta.html',
    title: 'Beta Note',
    snippet: 'beta content',
    bm25: 1.2,
  },
];

vi.mock('../../indexer/fts.js', () => ({
  searchFts: vi.fn(() => MOCK_FTS_HITS),
  searchFtsSpread: vi.fn(() => MOCK_FTS_HITS),
  listAll: vi.fn(() => []),
  listAllWithText: vi.fn(() => []),
  loadAllStoredEmbeddings: vi.fn(() => new Map()),
  allDistinctTags: vi.fn(() => []),
  getTagNoteCount: vi.fn(() => 0),
  getNoteById: vi.fn(() => null),
  getNoteText: vi.fn(() => ''),
  notesMatchingPathPrefix: vi.fn(() => []),
  notesWithWarningsOrNegative: vi.fn(() => []),
  notesForErrorPattern: vi.fn(() => []),
  notesAnsweringQuestion: vi.fn(() => []),
  notesByTagOrType: vi.fn(() => []),
  notesMentioningEntity: vi.fn(() => []),
  applyStructuralFieldBoost: vi.fn((hits: unknown[]) => hits),
  recordAccessMany: vi.fn(),
  upsertNoteEmbedding: vi.fn(),
}));

vi.mock('../../indexer/structural.js', () => ({
  structuralQuery: vi.fn(() => []),
}));

vi.mock('../../indexer/reranker.js', () => ({
  rerank: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../annotator/entities.js', () => ({
  resolveEntityKeysInQuery: vi.fn(() => []),
}));

vi.mock('../../graph/backlinks.js', () => ({
  loadBacklinks: vi.fn(() => null),
}));

vi.mock('../../graph/pagerank.js', () => ({
  computePageRank: vi.fn(() => ({ scores: {} })),
  notesForCwd: vi.fn(() => []),
  recentNotes: vi.fn(() => []),
}));

vi.mock('../../store/reader.js', () => ({
  readNote: vi.fn(() => ({ html: '<article></article>' })),
}));

vi.mock('../../retrieval/hyde.js', () => ({
  embedQueryForRetrieval: vi.fn(() => Promise.resolve(new Float32Array(768))),
}));

// ---------------------------------------------------------------------------
// Real imports (after mocks are hoisted)
// ---------------------------------------------------------------------------

import {
  forceEmbedderUnavailableForTests,
  resetEmbedderForTests,
} from '../../indexer/embeddings.js';
import { route } from '../router.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('router L3→L2 fallback when ONNX models are absent', () => {
  beforeEach(() => {
    forceEmbedderUnavailableForTests();
  });

  afterEach(() => {
    resetEmbedderForTests();
  });

  it('returns FTS hits instead of crashing when level=L3 and embedder unavailable', async () => {
    // route() still reports levelUsed='L3' (the routing decision), but the
    // internal runL3() fell back to runL2() — so hits come from FTS, not ONNX.
    // The critical assertion is: we get results (no crash / empty set) and the
    // individual hits carry level='L2' stamped by runL2().
    const result = await route({ query: 'alpha test query', level: 'L3', topK: 5 });

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].id).toBe('note-alpha');
    // Hits produced by the L2 fallback carry level='L2'
    expect(result.hits[0].level).toBe('L2');
  });

  it('returns FTS hits when level=L2_L3_HYBRID and embedder unavailable', async () => {
    const result = await route({
      query: 'long query with many tokens that triggers hybrid mode',
      level: 'L2_L3_HYBRID',
      topK: 5,
    });

    expect(result.hits.length).toBeGreaterThan(0);
    // All hits must originate from the L2 FTS fallback
    for (const hit of result.hits) {
      expect(hit.level).toBe('L2');
    }
  });

  it('auto-routing short query still returns results when embedder unavailable', async () => {
    // Short queries (≤5 tokens) are routed to L2 by pickLevel anyway — confirm
    // results are returned correctly when embedder is unavailable.
    const result = await route({ query: 'alpha note', level: 'auto', topK: 5 });

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.levelUsed).toBe('L2');
  });

  it('long auto-routed query returns FTS results when embedder unavailable', async () => {
    // A query with 6+ tokens is routed to L2_L3_HYBRID by pickLevel; with embedder
    // unavailable the hybrid path must degrade to pure FTS results.
    const result = await route({
      query: 'how does the authentication token refresh mechanism work exactly',
      level: 'auto',
      topK: 5,
    });

    expect(result.hits.length).toBeGreaterThan(0);
    // All returned hits must be L2 FTS hits (level stamp from runL2)
    for (const hit of result.hits) {
      expect(hit.level).toBe('L2');
    }
  });
});
