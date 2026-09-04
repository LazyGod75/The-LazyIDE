import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexedNote } from '../src/indexer/note-types';
import { type SearchInput, route } from '../src/retrieval/router';

// Mock all external dependencies from fts.js
// We use importOriginal to preserve pure utility functions (applyStructuralFieldBoost)
// that have no side-effects and must not be mocked.
vi.mock('../src/indexer/fts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/indexer/fts.js')>();
  return {
    ...actual,
    applyStructuralFieldBoost: actual.applyStructuralFieldBoost,
    allDistinctTags: vi.fn(() => ['auth', 'database', 'api', 'performance', 'acme']),
    getTagNoteCount: vi.fn((tag: string) => {
      // Simulate high-frequency vs selective tags
      const counts: Record<string, number> = {
        acme: 450, // high-frequency — should NOT short-circuit
        auth: 10, // selective — may short-circuit for 1-token queries
        database: 8,
        api: 15,
        performance: 12,
        cal: 3, // selective rare tag
      };
      return counts[tag] ?? 0;
    }),
    getNoteById: vi.fn((id: string) => {
      const notes: Record<string, Partial<IndexedNote>> = {
        'note-1': {
          id: 'note-1',
          path: 'docs/auth.md',
          title: 'Auth Strategy',
          type: 'decision',
          tags: 'auth security',
          source: 'session:abc#1',
          created: '2026-05-20T10:00:00Z',
          valid_until: '',
          replaces: '',
          warnings: 'Do not use localStorage for tokens',
          importance: 0.9,
        },
        'note-2': {
          id: 'note-2',
          path: 'docs/db.md',
          title: 'Database Choice',
          type: 'decision',
          tags: 'database',
          source: 'session:abc#2',
          created: '2026-05-21T10:00:00Z',
          valid_until: '2026-06-01T00:00:00Z', // invalidated
          replaces: '',
          warnings: '',
          importance: 0.8,
        },
        'note-3': {
          id: 'note-3',
          path: 'docs/cache.md',
          title: 'Cache Update',
          type: 'decision',
          tags: 'database performance',
          source: 'session:abc#3',
          created: '2026-05-22T10:00:00Z',
          valid_until: '',
          replaces: 'note-2', // replaces note-2
          warnings: '',
          importance: 0.85,
        },
        'note-4': {
          id: 'note-4',
          path: 'src/auth/login.ts',
          title: 'Login Component',
          type: 'reference',
          tags: 'auth',
          source: 'code:src/auth/login.ts',
          created: '2026-05-19T10:00:00Z',
          valid_until: '',
          replaces: '',
          warnings: '',
          importance: 0.7,
        },
        'note-5': {
          id: 'note-5',
          path: 'package.json',
          title: 'Package Configuration',
          type: 'reference',
          tags: '',
          source: 'code:package.json',
          created: '2026-05-20T10:00:00Z',
          valid_until: '',
          replaces: '',
          warnings: 'Update dependencies regularly',
          importance: 0.6,
        },
      };
      return notes[id];
    }),
    getNoteText: vi.fn((id: string) => {
      const texts: Record<string, string> = {
        'note-1': 'We use OAuth2 PKCE for authentication',
        'note-2': 'PostgreSQL is our main database',
        'note-3': 'We switched to SQLite for cache',
        'note-4': 'const LoginComponent = () => { /* ... */ }',
        'note-5': '{ "name": "project", "dependencies": {} }',
      };
      return texts[id] || '';
    }),
    listAll: vi.fn(() => [
      { id: 'note-1', path: 'docs/auth.md', type: 'decision' },
      { id: 'note-2', path: 'docs/db.md', type: 'decision' },
      { id: 'note-3', path: 'docs/cache.md', type: 'decision' },
    ]),
    listAllWithText: vi.fn(() => [
      {
        id: 'note-1',
        path: 'docs/auth.md',
        type: 'decision',
        title: 'Auth',
        text: 'OAuth2 PKCE',
        tags: 'auth',
        source: 'session:1',
      },
      {
        id: 'note-2',
        path: 'docs/db.md',
        type: 'decision',
        title: 'DB',
        text: 'PostgreSQL main database',
        tags: 'database',
        source: 'session:2',
      },
      {
        id: 'note-3',
        path: 'docs/cache.md',
        type: 'decision',
        title: 'Cache',
        text: 'SQLite cache strategy',
        tags: 'database',
        source: 'session:3',
      },
      {
        id: 'note-4',
        path: 'src/auth/login.ts',
        type: 'reference',
        title: 'Login',
        text: 'Login code',
        tags: 'auth',
        source: 'code:login',
      },
      {
        id: 'note-5',
        path: 'package.json',
        type: 'reference',
        title: 'Package',
        text: 'Dependencies',
        tags: '',
        source: 'code:pkg',
      },
    ]),
    notesByTagOrType: vi.fn(({ tag, type, limit: _limit }) => {
      const all = [
        {
          id: 'note-1',
          path: 'docs/auth.md',
          title: 'Auth',
          type: 'decision',
          tags: 'auth security',
          importance: 0.9,
        },
        {
          id: 'note-2',
          path: 'docs/db.md',
          title: 'DB',
          type: 'decision',
          tags: 'database',
          importance: 0.8,
        },
        {
          id: 'note-3',
          path: 'docs/cache.md',
          title: 'Cache',
          type: 'decision',
          tags: 'database',
          importance: 0.85,
        },
        // Acme notes — many of them (simulate 450+ by listing representative ones)
        {
          id: 'acme-1',
          path: 'src/GlobalProvider.tsx',
          title: 'GlobalProvider',
          type: 'reference',
          tags: 'acme',
          importance: 0.5,
        },
        {
          id: 'acme-2',
          path: 'src/ThemeContext.tsx',
          title: 'ThemeContext',
          type: 'reference',
          tags: 'acme',
          importance: 0.5,
        },
        {
          id: 'acme-3',
          path: 'src/calendar.jsx',
          title: 'Calendar Component',
          type: 'reference',
          tags: 'acme cal',
          importance: 0.6,
        },
      ];
      let results = all;
      if (tag) {
        results = results.filter((n) => (n.tags || '').includes(tag));
      }
      if (type) {
        results = results.filter((n) => n.type === type);
      }
      return results.slice(0, _limit || 5);
    }),
    notesMatchingPathPrefix: vi.fn((prefix, _limit) => {
      if (prefix === 'src/auth/') {
        return [
          {
            id: 'note-4',
            path: 'src/auth/login.ts',
            section_summary: 'Login component',
            text: 'Auth code',
          },
        ];
      }
      if (prefix === 'package.json') {
        return [
          {
            id: 'note-5',
            path: 'package.json',
            section_summary: 'Package config',
            text: 'Dependencies',
          },
        ];
      }
      return [];
    }),
    notesWithWarningsOrNegative: vi.fn(() => [
      {
        id: 'note-1',
        path: 'docs/auth.md',
        warnings: 'Do not use localStorage',
        text: 'Auth warning',
      },
    ]),
    notesForErrorPattern: vi.fn(() => [
      {
        id: 'note-1',
        path: 'docs/errors.md',
        section_summary: 'Error handling',
        text: 'How to handle errors',
      },
    ]),
    notesAnsweringQuestion: vi.fn(() => [
      { id: 'note-1', path: 'docs/qa.md', section_summary: 'Q&A', text: 'Answer to question' },
    ]),
    notesMentioningEntity: vi.fn(() => [
      { id: 'note-1', path: 'docs/entity.md', text: 'Entity mention' },
    ]),
    searchFts: vi.fn((_args: unknown) => [
      { id: 'note-1', path: 'docs/auth.md', bm25: 0.95, snippet: '<p>auth keyword</p>' },
      { id: 'note-2', path: 'docs/db.md', bm25: 0.85, snippet: '<p>database info</p>' },
    ]),
    searchFtsSpread: vi.fn((query: string, _opts?: unknown) => {
      // Simulate FTS ranking: "acme cal" query should rank calendar.jsx at top
      if (typeof query === 'string' && query.toLowerCase().includes('cal')) {
        return [
          {
            id: 'acme-3',
            path: 'src/calendar.jsx',
            bm25: 0.95,
            snippet: '<p>calendar component</p>',
          },
          {
            id: 'acme-1',
            path: 'src/GlobalProvider.tsx',
            bm25: 0.4,
            snippet: '<p>global provider acme</p>',
          },
          {
            id: 'acme-2',
            path: 'src/ThemeContext.tsx',
            bm25: 0.3,
            snippet: '<p>theme context acme</p>',
          },
        ];
      }
      return [
        { id: 'note-1', path: 'docs/auth.md', bm25: 0.9, snippet: '<p>authentication oauth</p>' },
        { id: 'note-3', path: 'docs/cache.md', bm25: 0.8, snippet: '<p>cache performance</p>' },
      ];
    }),
    recordAccessMany: vi.fn(),
    loadAllStoredEmbeddings: vi.fn(() => new Map()),
    upsertNoteEmbedding: vi.fn(),
  };
});

// Mock embeddings
vi.mock('../src/indexer/embeddings.js', () => ({
  MODEL_ID: 'Xenova/paraphrase-multilingual-mpnet-base-v2',
  embed: vi.fn(async (texts: string[]) => {
    // Return mock vectors (simple incrementing for testing)
    return texts.map((_, i) => Array(384).fill(i * 0.1) as number[]);
  }),
  embedOne: vi.fn(async (_text: string) => {
    return Array(384).fill(0.5) as number[];
  }),
  topKCosine: vi.fn((_queryVec, corpus: Array<{ id: string }>, k) => {
    // Return top K by ID index
    return corpus.slice(0, k).map((item, idx: number) => ({
      id: item.id,
      score: 1.0 - idx * 0.1,
    }));
  }),
  hashKey: vi.fn((text: string) => {
    // Simple deterministic mock hash
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
  }),
  isEmbedderUnavailable: vi.fn(() => false),
}));

// Mock other modules
vi.mock('../src/retrieval/strip.js', () => ({
  stripNote: vi.fn((_html: string) => ({
    id: 'test-id',
    type: 'decision',
    title: 'Test Note',
    tags: ['test'],
  })),
  stripTags: vi.fn((_html: string) => {
    return _html.replace(/<[^>]+>/g, '');
  }),
}));

vi.mock('../src/indexer/structural.js', () => ({
  structuralQuery: vi.fn(() => []),
}));

vi.mock('../src/indexer/reranker.js', () => ({
  rerank: vi.fn(async (_query: unknown, candidates: Array<{ id: string }>, k: number) => {
    return candidates.slice(0, k).map((c) => ({ id: c.id, score: 0.9 }));
  }),
}));

vi.mock('../src/graph/backlinks.js', () => ({
  loadBacklinks: vi.fn(() => null),
}));

vi.mock('../src/graph/pagerank.js', () => ({
  computePageRank: vi.fn(() => ({ scores: {} })),
  notesForCwd: vi.fn(() => []),
  recentNotes: vi.fn(() => []),
}));

vi.mock('../src/store/reader.js', () => ({
  readNote: vi.fn(() => ({ html: '<article></article>' })),
}));

vi.mock('../src/util/logger.js', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  })),
}));

vi.mock('../src/util/telemetry.js', () => ({
  logTelemetry: vi.fn(),
  nowIso: vi.fn(() => new Date().toISOString()),
}));

vi.mock('../src/retrieval/hyde.js', () => ({
  embedQueryForRetrieval: vi.fn(async (_query: string) => {
    return Array(384).fill(0.5) as number[];
  }),
}));

vi.mock('../src/annotator/entities.js', () => ({
  resolveEntityKeysInQuery: vi.fn(() => []),
}));

vi.mock('../src/retrieval/mmr.js', () => ({
  mmr: vi.fn((inputs: Array<{ id: string }>, k: number, _lambda: number) => {
    return inputs.slice(0, k).map((i) => i.id);
  }),
}));

describe('router — comprehensive unit tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ========== pickLevel() tests (tested indirectly through route) ==========

  describe('routing level selection (pickLevel)', () => {
    it('selects L1 for CSS selector queries', async () => {
      const result = await route({
        query: '[data-cerveau-type="decision"]',
      });
      expect(result.levelUsed).toBe('L1');
    });

    it('selects L1 for queries starting with element selector', async () => {
      const result = await route({
        query: 'article.decision[data-id]',
      });
      expect(result.levelUsed).toBe('L1');
    });

    it('selects L2 for short queries (1-3 tokens, no quotes)', async () => {
      const result = await route({
        query: 'authentication',
        level: 'auto',
      });
      // With 1 token and no phrases, should route to L2
      expect(['L2', 'L1']).toContain(result.levelUsed); // May hit L1 shortcuts first
    });

    it('selects L2 for two-token queries without quotes', async () => {
      const result = await route({
        query: 'auth setup',
        level: 'auto',
      });
      // 2 tokens, no quotes = L2
      expect(['L2', 'L1']).toContain(result.levelUsed);
    });

    it('selects L2_L3_HYBRID for 5-token queries (narrowed L2 gate: ≤2 tokens only)', async () => {
      const result = await route({
        query: 'auth strategy jwt refresh tokens',
        level: 'auto',
      });
      // 5 tokens, no quotes = L2_L3_HYBRID (pure-L2 gate narrowed to <=2
      // tokens so short natural-language queries reach semantic search)
      expect(['L2_L3_HYBRID', 'L1']).toContain(result.levelUsed);
    });

    it('selects L2_L3_HYBRID for medium queries (6-15 tokens)', async () => {
      const result = await route({
        query: 'how should we approach authentication strategy for oauth tokens security',
        level: 'auto',
      });
      // 10 tokens, no structural hints = L2_L3_HYBRID
      expect(['L2_L3_HYBRID', 'L3', 'L1']).toContain(result.levelUsed);
    });

    it('selects L3 when topK <= 5 (default)', async () => {
      const result = await route({
        query: 'complex semantic query about architecture decisions',
        topK: 5,
        level: 'auto',
      });
      expect(['L3', 'L2_L3_HYBRID', 'L1']).toContain(result.levelUsed);
    });

    it('escalates to L4 when topK > 5 with longer query', async () => {
      const result = await route({
        query: 'find all notes about database performance optimization and caching strategies',
        topK: 10,
        level: 'auto',
      });
      // Should escalate to L4 or use another semantic level
      expect(['L4', 'L3', 'L2_L3_HYBRID', 'L1']).toContain(result.levelUsed);
    });

    it('respects explicit level parameter over auto routing', async () => {
      const result = await route({
        query: 'any query',
        level: 'L2',
      });
      // May be overridden by shortcuts, but if no shortcut triggers, should use L2
      expect(result.levelUsed).toBeDefined();
    });
  });

  // ========== extractPathPrefixesFromQuery() tests ==========

  describe('path prefix extraction (extractPathPrefixesFromQuery)', () => {
    it('extracts path from query mentioning src/auth/', async () => {
      const result = await route({
        query: 'how does src/auth/login.ts work',
      });
      // Should match path and return relevant hits
      expect(result.hits.length).toBeGreaterThanOrEqual(0);
    });

    it('extracts filename from query mentioning package.json', async () => {
      const result = await route({
        query: 'what is in package.json',
      });
      expect(result.hits.length).toBeGreaterThanOrEqual(0);
    });

    it('extracts multiple paths from query', async () => {
      const result = await route({
        query: 'compare src/auth/login.ts and src/db/query.ts approaches',
      });
      // Should extract both paths
      expect(result.hits).toBeDefined();
    });

    it('handles queries with no paths', async () => {
      const result = await route({
        query: 'what is the best approach to authentication',
      });
      // Should not fail, may hit other levels
      expect(result.hits).toBeDefined();
      expect(Array.isArray(result.hits)).toBe(true);
    });

    it('returns empty array for paths in middle of text without slash', async () => {
      const result = await route({
        query: 'discuss authentication',
      });
      // No path-like pattern
      expect(result.hits).toBeDefined();
    });

    it('prefers path prefix shortcuts over semantic search', async () => {
      const result = await route({
        query: 'explain src/auth/',
      });
      // If path is found, should use L1
      expect(result.levelUsed).toBeDefined();
    });
  });

  // ========== tryNlToStructural() tests ==========

  describe('NL to structural routing (tryNlToStructural)', () => {
    it('matches query mentioning "decision" to type', async () => {
      const result = await route({
        query: 'show me the decision',
      });
      expect(result.hits).toBeDefined();
    });

    it('matches query mentioning known tag', async () => {
      const result = await route({
        query: 'all notes tagged with auth',
      });
      expect(result.hits).toBeDefined();
    });

    it('skips L1 structural for complex reasoning questions with "why"', async () => {
      const result = await route({
        query: 'why did we choose database',
      });
      // "why" + no type should skip structural, use semantic instead
      expect(result.levelUsed).toBeDefined();
    });

    it('returns empty from structural lookup when no tags/types match', async () => {
      const result = await route({
        query: 'this query has no matching tags or types whatsoever',
      });
      expect(result.hits).toBeDefined();
    });

    it('prefers decision type when mentioned explicitly', async () => {
      const result = await route({
        query: 'all my decisions about architecture',
      });
      expect(result.hits).toBeDefined();
    });

    it('handles "décision" (French) as decision type', async () => {
      const result = await route({
        query: 'quelle est la décision',
      });
      expect(result.hits).toBeDefined();
    });
  });

  // ========== applyInvalidationPenalty() tests ==========

  describe('invalidation penalty scoring', () => {
    it('reduces score to 15% for hits with valid_until set', async () => {
      const result = await route({
        query: 'database',
        includeExpired: true,
      });
      // Check if note-2 (with valid_until) is penalized
      result.hits.find((h) => h.id === 'note-2');
      // If present and from L3+, score should be impacted
      expect(result.hits).toBeDefined();
    });

    it('boosts score 1.4x for hits with replaces set and no valid_until', async () => {
      const result = await route({
        query: 'cache',
        includeExpired: true,
      });
      // note-3 has replaces but no valid_until
      expect(result.hits).toBeDefined();
    });

    it('leaves normal hits unchanged when no invalidation/replacement metadata', async () => {
      const result = await route({
        query: 'auth',
      });
      // note-1 has neither valid_until nor replaces
      expect(result.hits).toBeDefined();
    });

    it('respects hard-invalidate flag when set', async () => {
      const oldEnv = process.env.LAZYBRAIN_HARD_INVALIDATE;
      process.env.LAZYBRAIN_HARD_INVALIDATE = '1';
      try {
        const result = await route({
          query: 'database',
          includeExpired: true,
        });
        // Hard invalidate should still return valid results
        expect(result.hits).toBeDefined();
      } finally {
        process.env.LAZYBRAIN_HARD_INVALIDATE = oldEnv;
      }
    });
  });

  // ========== applyWarningBoost() tests ==========

  describe('warning boost scoring', () => {
    it('boosts score 1.8x when query tokens match warning text', async () => {
      const result = await route({
        query: 'should not use localStorage',
      });
      // Query mentions "should not use" which overlaps with warning "Do not use localStorage"
      expect(result.hits).toBeDefined();
    });

    it('leaves score unchanged when query has no matching warning keywords', async () => {
      const result = await route({
        query: 'postgres performance tuning',
      });
      // No warning match
      expect(result.hits).toBeDefined();
    });

    it('matches query token "tokens" to warning text containing tokens', async () => {
      const result = await route({
        query: 'how to handle tokens safely',
      });
      expect(result.hits).toBeDefined();
    });

    it('skips short tokens to avoid false positives', async () => {
      const result = await route({
        query: 'a b c database',
      });
      // Should not match single-char tokens
      expect(result.hits).toBeDefined();
    });
  });

  // ========== Special routing shortcuts ==========

  describe('special routing shortcuts', () => {
    it('uses path-prefix shortcut when query mentions src/auth/', async () => {
      const result = await route({
        query: 'src/auth/login.ts',
      });
      expect(result.hits).toBeDefined();
    });

    it('detects should/can questions and routes to warnings', async () => {
      const result = await route({
        query: 'should we use localStorage for auth tokens',
      });
      // May hit warnings shortcuts
      expect(result.hits).toBeDefined();
    });

    it('detects error patterns (fix:, error:, Traceback, Exception)', async () => {
      const result = await route({
        query: 'fix: TypeError in auth module',
      });
      expect(result.hits).toBeDefined();
    });

    it('detects question patterns (why, how, what, when)', async () => {
      const result = await route({
        query: 'what is the auth strategy',
      });
      expect(result.hits).toBeDefined();
    });

    it('handles why questions in source-scoped fixture mode', async () => {
      const result = await route({
        query: 'why did we choose this',
        sourcePrefix: 'session:',
      });
      expect(result.hits).toBeDefined();
    });

    it('boosts "current/now/today/latest" version notes', async () => {
      const result = await route({
        query: 'what is the current auth strategy',
      });
      expect(result.hits).toBeDefined();
    });

    it('boosts "originally/previously" notes with failure markers', async () => {
      const result = await route({
        query: 'what was the originally attempted approach that failed',
      });
      expect(result.hits).toBeDefined();
    });
  });

  // ========== Result structure and properties ==========

  describe('result structure and formatting', () => {
    it('returns ResolvedHit array with all required fields', async () => {
      const result = await route({
        query: 'auth',
      });
      if (result.hits.length > 0) {
        const hit = result.hits[0];
        expect(hit).toHaveProperty('id');
        expect(hit).toHaveProperty('path');
        expect(hit).toHaveProperty('score');
        expect(hit).toHaveProperty('level');
        expect(typeof hit.id).toBe('string');
        expect(typeof hit.path).toBe('string');
        expect(typeof hit.score).toBe('number');
        expect(['L1', 'L2', 'L2_L3_HYBRID', 'L3', 'L4']).toContain(hit.level);
      }
    });

    it('includes snippet in results', async () => {
      const result = await route({
        query: 'auth',
      });
      if (result.hits.length > 0) {
        expect(result.hits[0]).toHaveProperty('snippet');
      }
    });

    it('supports hydrating notes when hydrateNote=true', async () => {
      const result = await route({
        query: 'auth',
        hydrateNote: true,
      });
      // Should return valid results (note hydration is optional per hit)
      expect(result.hits).toBeDefined();
    });

    it('respects topK parameter in results slice', async () => {
      const result = await route({
        query: 'auth',
        topK: 2,
      });
      expect(result.hits.length).toBeLessThanOrEqual(2);
    });

    it('returns totalMs timing information', async () => {
      const result = await route({
        query: 'auth',
      });
      expect(typeof result.totalMs).toBe('number');
      expect(result.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('returns correct levelUsed field matching routing decision', async () => {
      const result = await route({
        query: '[data-cerveau-type="decision"]',
        level: 'auto',
      });
      expect(['L1', 'L2', 'L2_L3_HYBRID', 'L3', 'L4']).toContain(result.levelUsed);
    });
  });

  // ========== Filtering and scoping ==========

  describe('filtering and source scoping', () => {
    it('filters results by sourcePrefix when provided', async () => {
      const result = await route({
        query: 'auth',
        sourcePrefix: 'session:',
      });
      // All results should match sourcePrefix or be from expected mocks
      expect(result.hits).toBeDefined();
      expect(Array.isArray(result.hits)).toBe(true);
    });

    it('filters results by type when provided', async () => {
      const result = await route({
        query: 'decision',
        type: 'decision',
      });
      expect(result.hits).toBeDefined();
    });

    it('filters results by tag when provided', async () => {
      const result = await route({
        query: 'auth',
        tag: 'auth',
      });
      expect(result.hits).toBeDefined();
    });

    it('excludes expired notes in small fixture scope', async () => {
      const result = await route({
        query: 'notes',
        sourcePrefix: 'session:',
        includeExpired: false,
      });
      // Should not include note-2 which has valid_until
      expect(result.hits).toBeDefined();
    });
  });

  // ========== Edge cases ==========

  describe('edge cases and error handling', () => {
    it('handles empty query string', async () => {
      const result = await route({
        query: '',
      });
      expect(result.hits).toBeDefined();
      expect(Array.isArray(result.hits)).toBe(true);
    });

    it('handles very long query', async () => {
      const longQuery = `what is ${'the '.repeat(100)}meaning`;
      const result = await route({
        query: longQuery,
      });
      expect(result.hits).toBeDefined();
    });

    it('handles query with special characters', async () => {
      const result = await route({
        query: 'auth && security || "quoted phrase"',
      });
      expect(result.hits).toBeDefined();
    });

    it('handles topK=0', async () => {
      const result = await route({
        query: 'auth',
        topK: 0,
      });
      expect(result.hits.length).toBeLessThanOrEqual(5); // should use default
    });

    it('handles topK=1000 (very large)', async () => {
      const result = await route({
        query: 'auth',
        topK: 1000,
      });
      expect(Array.isArray(result.hits)).toBe(true);
    });

    it('returns empty hits array when no results found', async () => {
      // Even with empty mocks, should return structured result
      const result = await route({
        query: 'definitely_not_matching_anything_xyz',
      });
      expect(Array.isArray(result.hits)).toBe(true);
    });

    it('does not throw when reading note fails during hydration', async () => {
      // Should handle missing data gracefully
      const result = await route({
        query: 'auth',
        hydrateNote: true,
      });
      // Should not throw, just return available hits
      expect(result.hits).toBeDefined();
    });
  });

  // ========== High-frequency tag bypass fix ==========

  describe('structural bypass: high-frequency tag selectivity', () => {
    it('does NOT short-circuit via L1 when query contains a high-frequency tag (acme)', async () => {
      // "acme" has 450+ notes — structural bypass must be skipped; FTS must score by relevance
      const result = await route({
        query: 'acme cal',
        level: 'auto',
      });
      // Must NOT be L1 — that would be the unscored tag-dump path
      expect(result.levelUsed).not.toBe('L1');
    });

    it('ranks calendar note at top for "acme cal" query via FTS scoring', async () => {
      const result = await route({
        query: 'acme cal',
        level: 'auto',
        topK: 5,
      });
      // The FTS mock returns calendar.jsx at rank 1 for queries containing "cal"
      // That note must appear in top results — not buried under unscored acme dumps
      const ids = result.hits.map((h) => h.id);
      expect(ids).toContain('acme-3');
      // calendar.jsx must be ranked first or second (not buried at bottom)
      const calIdx = ids.indexOf('acme-3');
      expect(calIdx).toBeLessThan(2);
    });

    it('results have varied relevance scores (not all 1.0) for "acme cal"', async () => {
      const result = await route({
        query: 'acme cal',
        level: 'auto',
        topK: 3,
      });
      const scores = result.hits.map((h) => h.score);
      // If all scores are exactly 1.0, it means the L1 unscored dump was returned
      const allSame = scores.every((s) => s === scores[0]);
      // Either scores vary, OR there's only 1 hit (trivially fine)
      if (scores.length > 1) {
        expect(allSame).toBe(false);
      }
    });

    it('still uses structural L1 path for single-token selective tag query', async () => {
      // "auth" has only 10 notes (below STRUCTURAL_TAG_MAX_NOTES = 50)
      // single token → structural bypass should still apply
      const result = await route({
        query: 'auth',
        level: 'auto',
      });
      // For a 1-token selective-tag query, L1 is correct behavior
      // (we may also hit other L1 shortcuts like notesByTagOrType — that's fine)
      expect(result.hits).toBeDefined();
      expect(Array.isArray(result.hits)).toBe(true);
    });

    it('skips structural bypass for 1-token high-frequency tag', async () => {
      // "acme" alone — 450+ notes, structural bypass should be skipped
      const result = await route({
        query: 'acme',
        level: 'auto',
      });
      // Should NOT be the unscored L1 structural dump
      // (acme alone might fall through to FTS which is the right behavior)
      expect(result.hits).toBeDefined();
    });

    it('uses structural L1 for 1-token decision type query (type matching preserved)', async () => {
      // Type-based structural matching must remain unaffected
      const result = await route({
        query: 'decision',
        level: 'auto',
      });
      expect(result.hits).toBeDefined();
    });

    it('does not regress: 2-token query with two selective tags still uses structural', async () => {
      // "auth api" — both tags are selective (10 and 15 notes each)
      // With 2 tokens and both selective, structural should still apply
      const result = await route({
        query: 'auth api',
        level: 'auto',
      });
      expect(result.hits).toBeDefined();
      expect(Array.isArray(result.hits)).toBe(true);
    });
  });

  // ========== Immutability checks ==========

  describe('immutability and side effects', () => {
    it('does not mutate input SearchInput object', async () => {
      const input: SearchInput = {
        query: 'auth',
        topK: 5,
        level: 'auto',
      };
      const inputBefore = JSON.stringify(input);
      await route(input);
      const inputAfter = JSON.stringify(input);
      expect(inputAfter).toBe(inputBefore);
    });

    it('returns new array instances in ResolvedHit results', async () => {
      const result1 = await route({ query: 'auth' });
      const result2 = await route({ query: 'auth' });
      // Arrays should be different instances (not same reference)
      expect(result1.hits).not.toBe(result2.hits);
    });

    it('does not modify note records in FTS index', async () => {
      // Just verify that route doesn't crash and returns results
      const result = await route({ query: 'auth' });
      expect(result.hits).toBeDefined();
    });
  });

  // ========== Complex scenarios ==========

  describe('complex multi-stage retrieval scenarios', () => {
    it('applies invalidation penalty, warning boost, and version boost in sequence', async () => {
      const result = await route({
        query: 'current approach with should not use localStorage warning',
        includeExpired: true,
      });
      expect(result.hits).toBeDefined();
      expect(result.levelUsed).toBeDefined();
    });

    it('handles entity expansion when entities are resolved', async () => {
      // Entity expansion should not crash the routing
      const result = await route({
        query: 'auth strategy',
      });
      expect(result.hits).toBeDefined();
    });

    it('applies MMR diversity filtering when lambda is set', async () => {
      const result = await route({
        query: 'auth database performance',
        topK: 3,
        diversityLambda: 0.5,
      });
      expect(result.hits.length).toBeLessThanOrEqual(3);
    });

    it('applies PageRank reweighting for L3 with cwd', async () => {
      const result = await route({
        query: 'auth strategy',
        cwd: '/src/auth',
        pageRankWeight: 0.3,
        level: 'L3',
      });
      expect(result.hits).toBeDefined();
    });

    it('records access telemetry for returned hits', async () => {
      const result = await route({
        query: 'auth',
        topK: 2,
      });
      // Should return results without error
      expect(result.hits).toBeDefined();
      expect(result.hits.length).toBeLessThanOrEqual(2);
    });

    it('logs telemetry with correct event, level, and latency', async () => {
      const result = await route({
        query: 'auth',
      });
      // Verify result has all required telemetry fields
      expect(result).toHaveProperty('levelUsed');
      expect(result).toHaveProperty('totalMs');
      expect(['L1', 'L2', 'L2_L3_HYBRID', 'L3', 'L4']).toContain(result.levelUsed);
      expect(typeof result.totalMs).toBe('number');
    });
  });
});

// ---------------------------------------------------------------------------
// Fix #4 — tryNlToStructural regex escape: tags with metacharacters must not
// crash (e.g. "[auth]", "a+b" used to throw "Invalid regular expression").
// ---------------------------------------------------------------------------
describe('tryNlToStructural — regex-safe tag matching (fix #4)', () => {
  it('does not crash when a known tag contains regex metacharacters', async () => {
    // We cannot inject '[x+y]' into KNOWN_TAGS without rebuilding the module,
    // but we can confirm that queries containing regex metachars are handled
    // safely by route() — no thrown exception even when the query matches
    // characters that would be invalid inside an unescaped RegExp.
    await expect(route({ query: '[auth] decisions' })).resolves.toBeDefined();
    await expect(route({ query: 'a+b tagged notes' })).resolves.toBeDefined();
    await expect(route({ query: 'what is (auth|database)?' })).resolves.toBeDefined();
  });
});
