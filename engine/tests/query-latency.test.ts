/**
 * Performance regression tests: default query path must be local-only.
 *
 * Root cause that prompted this fix: `embedQueryForRetrieval()` (called by
 * runL3 and runL2L3Hybrid) was auto-triggering HyDE by spawning
 * `claude --print` for every query with ≥ 4 words, causing 90–440s latency
 * when the subprocess timed out (12 s per attempt, multiple retries).
 *
 * These tests assert that the default query path NEVER calls `callClaudeCli`
 * or `isClaudeCliAvailable`, and that `shouldAutoHyde` always returns false.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// shouldAutoHyde — must always return false
// ---------------------------------------------------------------------------

import { embedQueryForRetrieval, isHydeEnabled, shouldAutoHyde } from '../src/retrieval/hyde.js';

// Mock embedOne so embedQueryForRetrieval completes instantly without the WASM model.
vi.mock('../src/indexer/embeddings.js', () => ({
  MODEL_ID: 'Xenova/paraphrase-multilingual-mpnet-base-v2',
  embedOne: vi.fn(async (_text: string) => new Float32Array(768).fill(0.1)),
  embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(768).fill(0.1))),
  topKCosine: vi.fn((_q: Float32Array, corpus: Array<{ id: string }>, k: number) =>
    corpus.slice(0, k).map((c, i) => ({ id: c.id, score: 1 - i * 0.1 })),
  ),
  hashKey: vi.fn((text: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
  }),
  isEmbedderUnavailable: vi.fn(() => false),
}));

// Spy on callClaudeCli to assert it is never invoked on the default path.
vi.mock('../src/util/claude-cli.js', () => ({
  callClaudeCli: vi.fn(async () => null),
  callClaudeCliJsonArray: vi.fn(async () => null),
  isClaudeCliAvailable: vi.fn(async () => true), // CLI "available" — must NOT matter
  llmAvailable: vi.fn(async () => false), // default: all LLM features off
}));

vi.mock('../src/util/logger.js', () => ({
  getLogger: vi.fn(() => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() })),
}));

describe('shouldAutoHyde — always false by default', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.LAZYBRAIN_HYDE;
  });

  it('returns false for a 4-word query (previously a candidate)', async () => {
    const result = await shouldAutoHyde('auth strategy jwt tokens');
    expect(result).toBe(false);
  });

  it('returns false for a 10-word query that was previously auto-triggered', async () => {
    const result = await shouldAutoHyde(
      'how do I implement calorie tracking with nutrition data service',
    );
    expect(result).toBe(false);
  });

  it('returns false even when CLI is reported as available', async () => {
    const { isClaudeCliAvailable } = await import('../src/util/claude-cli.js');
    vi.mocked(isClaudeCliAvailable).mockResolvedValue(true);
    const result = await shouldAutoHyde('semantic query about architecture patterns');
    expect(result).toBe(false);
  });

  it('returns false for a CSS selector query', async () => {
    const result = await shouldAutoHyde('[data-cerveau-type="decision"]');
    expect(result).toBe(false);
  });

  it('returns false for an empty query', async () => {
    const result = await shouldAutoHyde('');
    expect(result).toBe(false);
  });

  it('returns false when LAZYBRAIN_HYDE is not set', async () => {
    expect(process.env.LAZYBRAIN_HYDE).toBeUndefined();
    const result = await shouldAutoHyde('long semantic query with many words and context');
    expect(result).toBe(false);
  });

  it('returns false when LAZYBRAIN_HYDE=0 (explicit opt-out)', async () => {
    process.env.LAZYBRAIN_HYDE = '0';
    try {
      const result = await shouldAutoHyde('long semantic query');
      expect(result).toBe(false);
    } finally {
      delete process.env.LAZYBRAIN_HYDE;
    }
  });
});

// ---------------------------------------------------------------------------
// embedQueryForRetrieval — must NOT call callClaudeCli by default
// ---------------------------------------------------------------------------

describe('embedQueryForRetrieval — no claude-cli on default path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.LAZYBRAIN_HYDE;
  });

  it('does not call callClaudeCli for a short query', async () => {
    const { callClaudeCli } = await import('../src/util/claude-cli.js');
    await embedQueryForRetrieval('auth tokens');
    expect(vi.mocked(callClaudeCli)).not.toHaveBeenCalled();
  });

  it('does not call callClaudeCli for a long query (≥4 words, was previously auto-HyDE)', async () => {
    const { callClaudeCli } = await import('../src/util/claude-cli.js');
    await embedQueryForRetrieval('how do I implement calorie tracking with nutrition data service');
    expect(vi.mocked(callClaudeCli)).not.toHaveBeenCalled();
  });

  it('does not call callClaudeCli for a 8-word semantic query', async () => {
    const { callClaudeCli } = await import('../src/util/claude-cli.js');
    await embedQueryForRetrieval('authentication strategy with JWT and refresh tokens security');
    expect(vi.mocked(callClaudeCli)).not.toHaveBeenCalled();
  });

  it('returns a Float32Array (local embedding)', async () => {
    const vec = await embedQueryForRetrieval('some query');
    expect(vec).toBeInstanceOf(Float32Array);
  });
});

// ---------------------------------------------------------------------------
// isHydeEnabled — only true when LAZYBRAIN_HYDE=1
// ---------------------------------------------------------------------------

describe('isHydeEnabled — requires explicit opt-in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.LAZYBRAIN_HYDE;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns false when LAZYBRAIN_HYDE is not set', async () => {
    // llmAvailable mock returns false by default
    const result = await isHydeEnabled();
    expect(result).toBe(false);
  });

  it('returns false when LAZYBRAIN_HYDE=0', async () => {
    process.env.LAZYBRAIN_HYDE = '0';
    try {
      const result = await isHydeEnabled();
      expect(result).toBe(false);
    } finally {
      delete process.env.LAZYBRAIN_HYDE;
    }
  });
});

// ---------------------------------------------------------------------------
// route() default path — no claude-cli calls for typical queries
// ---------------------------------------------------------------------------

vi.mock('../src/indexer/fts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/indexer/fts.js')>();
  return {
    ...actual,
    applyStructuralFieldBoost: actual.applyStructuralFieldBoost,
    allDistinctTags: vi.fn(() => []),
    getTagNoteCount: vi.fn(() => 0),
    getNoteById: vi.fn(() => null),
    getNoteText: vi.fn(() => ''),
    listAll: vi.fn(() => []),
    listAllWithText: vi.fn(() => [
      {
        id: 'n1',
        path: 'a.html',
        type: 'decision',
        title: 'Auth',
        text: 'OAuth tokens',
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
        text: 'Redis cache',
        tags: 'perf',
        source: 's:3',
      },
    ]),
    notesByTagOrType: vi.fn(() => []),
    notesMatchingPathPrefix: vi.fn(() => []),
    notesWithWarningsOrNegative: vi.fn(() => []),
    notesForErrorPattern: vi.fn(() => []),
    notesAnsweringQuestion: vi.fn(() => []),
    notesMentioningEntity: vi.fn(() => []),
    searchFts: vi.fn(() => [
      { id: 'n1', path: 'a.html', bm25: 0.9, snippet: '<p>auth tokens</p>' },
    ]),
    searchFtsSpread: vi.fn(() => [
      { id: 'n1', path: 'a.html', bm25: 0.9, snippet: '<p>auth tokens</p>' },
    ]),
    recordAccessMany: vi.fn(),
    loadAllStoredEmbeddings: vi.fn(() => new Map()),
    upsertNoteEmbedding: vi.fn(),
  };
});

vi.mock('../src/indexer/reranker.js', () => ({
  rerank: vi.fn(async (_q: string, candidates: Array<{ id: string }>, k: number) =>
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

vi.mock('../src/util/telemetry.js', () => ({
  logTelemetry: vi.fn(),
  nowIso: vi.fn(() => new Date().toISOString()),
}));

vi.mock('../src/annotator/entities.js', () => ({
  resolveEntityKeysInQuery: vi.fn(() => []),
}));

vi.mock('../src/retrieval/mmr.js', () => ({
  mmr: vi.fn((inputs: Array<{ id: string }>, k: number) => inputs.slice(0, k).map((i) => i.id)),
}));

import { route } from '../src/retrieval/router.js';

describe('route() default path — no claude-cli calls', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.LAZYBRAIN_HYDE;
    delete process.env.LAZYBRAIN_MULTI_QUERY;

    // Reset hyde cache between tests by re-importing (vitest handles module isolation)
    const cli = await import('../src/util/claude-cli.js');
    vi.mocked(cli.callClaudeCli).mockResolvedValue(null);
    vi.mocked(cli.isClaudeCliAvailable).mockResolvedValue(true); // available but must NOT be called
    vi.mocked(cli.llmAvailable).mockResolvedValue(false);
  });

  it('L2 path (2-token query) does not call callClaudeCli', async () => {
    const { callClaudeCli } = await import('../src/util/claude-cli.js');
    await route({ query: 'auth supabase', level: 'auto' });
    expect(vi.mocked(callClaudeCli)).not.toHaveBeenCalled();
  });

  it('L2_L3_HYBRID path (7-token query) does not call callClaudeCli', async () => {
    const { callClaudeCli } = await import('../src/util/claude-cli.js');
    await route({ query: 'authentication strategy with JWT and refresh tokens', level: 'auto' });
    expect(vi.mocked(callClaudeCli)).not.toHaveBeenCalled();
  });

  it('L3 explicit path does not call callClaudeCli', async () => {
    const { callClaudeCli } = await import('../src/util/claude-cli.js');
    await route({ query: 'semantic fuzzy query about architecture design', level: 'L3' });
    expect(vi.mocked(callClaudeCli)).not.toHaveBeenCalled();
  });

  it('L4 explicit path does not call callClaudeCli', async () => {
    const { callClaudeCli } = await import('../src/util/claude-cli.js');
    await route({ query: 'deep reranking query', level: 'L4' });
    expect(vi.mocked(callClaudeCli)).not.toHaveBeenCalled();
  });

  it('L3 path returns valid hits without claude-cli', async () => {
    const result = await route({
      query: 'how do I implement calorie tracking with nutrition data service',
      level: 'L3',
    });
    expect(result.hits).toBeDefined();
    expect(Array.isArray(result.hits)).toBe(true);
    expect(result.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('escalation from L2 to L2_L3_HYBRID stays below 5 seconds (embedding caching)', async () => {
    const start = Date.now();
    await route({
      query: 'authentication strategy with JWT and refresh tokens security best practices',
      level: 'auto',
    });
    const elapsed = Date.now() - start;
    // With mocked embeddings this should be instantaneous; sanity check < 5s
    expect(elapsed).toBeLessThan(5000);
  });

  it('isClaudeCliAvailable is not called on the L2 path', async () => {
    const { isClaudeCliAvailable } = await import('../src/util/claude-cli.js');
    await route({ query: 'auth tokens', level: 'L2' });
    expect(vi.mocked(isClaudeCliAvailable)).not.toHaveBeenCalled();
  });
});
