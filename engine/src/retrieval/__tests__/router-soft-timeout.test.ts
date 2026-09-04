/**
 * Tests for the semantic-dispatch soft timeout (dispatchSemanticWithSoftTimeout,
 * router.ts) — 2026-08 recall-latency remediation, item 5: "a slow query
 * should degrade to a partial/narrow result with a clear note, not a bare
 * timeout."
 *
 * Strategy: force the embedder call (embedQueryForRetrieval, used by both
 * L3 and L2_L3_HYBRID) to hang forever, so the semantic side of the dispatch
 * never resolves on its own. Assert route() still returns real, fast,
 * keyword-only (L2) results — via the internal soft budget — instead of
 * hanging until an external caller's timeout fires.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// The load-bearing mock: embedQueryForRetrieval never resolves, simulating a
// stuck/slow embedder call — the exact class of async-bound stall
// dispatchSemanticWithSoftTimeout is designed to protect against.
vi.mock('../../retrieval/hyde.js', () => ({
  embedQueryForRetrieval: vi.fn(() => new Promise<Float32Array>(() => {})),
}));

import { route } from '../router.js';

describe('semantic dispatch soft timeout (degrade instead of bare hang)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('degrades L2_L3_HYBRID to L2 results after the soft budget instead of hanging forever', async () => {
    const resultPromise = route({
      query: 'long natural language query that routes to hybrid mode',
      level: 'L2_L3_HYBRID',
      topK: 5,
      skipTelemetry: true,
    });

    // Advance past SEMANTIC_SOFT_BUDGET_MS (8s) — the embedder promise never
    // resolves on its own, so this is the ONLY thing that can unblock route().
    await vi.advanceTimersByTimeAsync(8_100);

    const result = await resultPromise;

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].id).toBe('note-alpha');
    // Truthful level: these hits actually came from L2, not the originally
    // requested hybrid level.
    expect(result.levelUsed).toBe('L2');
    for (const hit of result.hits) {
      expect(hit.level).toBe('L2');
    }
    // The degradation must be visible to the caller, not silent.
    expect(result.degraded).toBeDefined();
    expect(result.degraded?.fromLevel).toBe('L2_L3_HYBRID');
    expect(result.degraded?.timeoutMs).toBe(8_000);
  });

  it('does not set degraded when the semantic dispatch resolves before the soft budget', async () => {
    // Re-mock a fast-resolving embedder for this test only.
    const hyde = await import('../../retrieval/hyde.js');
    vi.mocked(hyde.embedQueryForRetrieval).mockResolvedValueOnce(new Float32Array(768));

    const result = await route({
      query: 'alpha note',
      level: 'L2',
      topK: 5,
      skipTelemetry: true,
    });

    expect(result.degraded).toBeUndefined();
    expect(result.levelUsed).toBe('L2');
  });
});
