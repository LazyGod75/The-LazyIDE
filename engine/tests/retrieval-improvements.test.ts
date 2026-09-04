/**
 * TDD tests for retrieval quality improvements:
 *
 * Item 1 — inject-context turn mode surfaces file-neurons via compress path.
 * Item 2 — structural field boost: exact module/path token outranks free-text body match.
 * Item 3 — honest fallback kind: conversations without keywords render as "activity",
 *           not "decision".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Item 1 — inject-context surfaces file-neurons in turn mode
// ---------------------------------------------------------------------------

// All mocks must be declared before the dynamic import of inject-context.
vi.mock('../src/indexer/fts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/indexer/fts.js')>();
  return {
    ...actual,
    listAll: vi.fn(() => []),
    notesForCwdCount: vi.fn(() => ({ count: 0, activeDecisions: 0 })),
  };
});

vi.mock('../src/retrieval/strip.js', () => ({
  stripNote: vi.fn(() => ({
    id: 'stripped',
    type: 'file-neuron',
    title: 'test',
    tags: [],
    facts: [],
    links: [],
  })),
  stripNoteToPrompt: vi.fn(() => 'stripped prompt'),
  stripSection: vi.fn(() => null),
  stripTags: vi.fn((s: string) => s),
}));

vi.mock('../src/store/reader.js', () => ({
  readNote: vi.fn(() => ({
    html: '<article data-cerveau-type="file-neuron" data-code-file="src/router.ts"><h1>src/router.ts</h1></article>',
    id: 'file-router',
    path: 'notes/file-router.html',
    mtimeMs: 0,
  })),
}));

vi.mock('../src/retrieval/router.js', () => ({
  route: vi.fn(),
}));

vi.mock('../src/retrieval/decay.js', () => ({
  retentionScore: vi.fn(() => 0.9),
}));

vi.mock('../src/graph/backlinks.js', () => ({
  loadBacklinks: vi.fn(() => null),
  loadClusters: vi.fn(() => null),
}));

vi.mock('../src/commands/profile-update.js', () => ({
  profileTextForInjection: vi.fn(() => ''),
}));

vi.mock('../src/util/telemetry.js', () => ({
  logTelemetry: vi.fn(),
  nowIso: vi.fn(() => '2026-05-29T00:00:00Z'),
}));

vi.mock('../src/util/session-cache.js', () => ({
  alreadyInjected: vi.fn(() => new Set<string>()),
  recordInjected: vi.fn(),
  activeFiles: vi.fn(() => []),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn(() => false), readFileSync: vi.fn() };
});

vi.mock('../src/store/paths.js', () => ({
  brainRoot: vi.fn(() => '/brain'),
}));

vi.mock('../src/commands/build-clusters.js', () => ({
  slugifyCwd: vi.fn((cwd: string) => cwd.split('/').pop() ?? 'unknown'),
}));

vi.mock('../src/util/config.js', () => ({
  getConfig: vi.fn(() => ({ brainPath: '/mock-brain' })),
}));

// parseFileNeuronHtml must parse the file-neuron HTML — use a real-ish stub
vi.mock('../src/graph/file-neuron-parse.js', () => ({
  parseFileNeuronHtml: vi.fn((html: string) => {
    if (!html.includes('data-cerveau-type="file-neuron"')) return null;
    return {
      id: 'file:src/router.ts',
      title: 'src/router.ts',
      type: 'file',
      filePath: 'src/router.ts',
      projectRoot: '/project',
      language: 'typescript',
      lineCount: 120,
      imports: [],
      exports: ['route'],
      astFunctions: [
        { name: 'route', startLine: 10, endLine: 80, params: ['input'], isExported: true },
      ],
      astClasses: [],
    };
  }),
}));

vi.mock('../src/retrieval/compress-file-neuron.js', () => ({
  compressFileNeuron: vi.fn(
    () => 'src/router.ts (120L, typescript)\nexports: route\nfunctions:\n  route(input) :10',
  ),
}));

vi.mock('../src/graph/pagerank.js', () => ({
  computePageRank: vi.fn(() => ({ scores: {} })),
}));

import { runInjectContext } from '../src/commands/inject-context.js';
import { parseFileNeuronHtml } from '../src/graph/file-neuron-parse.js';
import { compressFileNeuron } from '../src/retrieval/compress-file-neuron.js';
import { route } from '../src/retrieval/router.js';

const mockRoute = vi.mocked(route);
const mockParseFileNeuronHtml = vi.mocked(parseFileNeuronHtml);
vi.mocked(compressFileNeuron);

describe('Item 1 — turn inject surfaces file-neurons via compression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRoute.mockResolvedValue({
      hits: [
        {
          id: 'file-router',
          path: 'notes/file-router.html',
          score: 8.0,
          level: 'L2',
          note: {
            id: 'file-router',
            type: 'file-neuron',
            text: '',
            tags: [],
            facts: [],
            links: [],
          },
        },
      ],
      levelUsed: 'L2',
      totalMs: 5,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls parseFileNeuronHtml when a hit note is a file-neuron', async () => {
    await runInjectContext({
      mode: 'turn',
      query: 'how does the router work',
      maxTokens: 500,
    });
    expect(mockParseFileNeuronHtml).toHaveBeenCalled();
  });

  it('uses compressFileNeuron output in the injected result for file-neuron hits', async () => {
    const result = await runInjectContext({
      mode: 'turn',
      query: 'how does the router work',
      maxTokens: 500,
    });
    // The compressed output must appear in the result
    expect(result).toContain('src/router.ts');
  });

  it('uses [FILE] prefix for file-neuron hits instead of [RECALL]', async () => {
    const result = await runInjectContext({
      mode: 'turn',
      query: 'how does the router work',
      maxTokens: 500,
    });
    // file-neuron sections should be labeled [FILE], not [RECALL]
    expect(result).toContain('[FILE]');
  });

  it('falls back to stripped text when parseFileNeuronHtml returns null', async () => {
    mockParseFileNeuronHtml.mockReturnValue(null);
    const { stripNoteToPrompt } = await import('../src/retrieval/strip.js');
    vi.mocked(stripNoteToPrompt).mockReturnValue('fallback stripped content');

    const result = await runInjectContext({
      mode: 'turn',
      query: 'how does the router work',
      maxTokens: 500,
    });
    // Should still return something (the fallback strip)
    expect(result).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// Item 2 — structural field boost in FTS scoring
// ---------------------------------------------------------------------------

/**
 * The structural field boost is applied as a post-processing step after FTS/BM25
 * returns raw scores. Notes whose `topic` or `tags` exactly contain a token from
 * the query receive a score multiplier.
 *
 * We test this via the exported applyStructuralFieldBoost helper.
 */
import { applyStructuralFieldBoost } from '../src/indexer/fts.js';

describe('Item 2 — applyStructuralFieldBoost', () => {
  it('is exported as a function from fts.js', () => {
    expect(typeof applyStructuralFieldBoost).toBe('function');
  });

  it('boosts a hit whose topic exactly contains a query token', () => {
    const hits = [
      { id: 'a', score: 1.0, topic: 'myproject/auth/oauth', tags: 'typescript', codeFile: null },
      { id: 'b', score: 1.0, topic: 'myproject/billing', tags: 'stripe', codeFile: null },
    ];
    const boosted = applyStructuralFieldBoost(hits, 'auth');
    const authHit = boosted.find((h) => h.id === 'a');
    const billingHit = boosted.find((h) => h.id === 'b');
    expect(authHit!.score).toBeGreaterThan(billingHit!.score);
  });

  it('boosts a hit whose data-code-file exactly matches a query token', () => {
    const hits = [
      { id: 'fn', score: 1.0, topic: null, tags: 'code', codeFile: 'src/retrieval/router.ts' },
      { id: 'unrelated', score: 1.0, topic: 'other', tags: 'code', codeFile: null },
    ];
    const boosted = applyStructuralFieldBoost(hits, 'router');
    const fnHit = boosted.find((h) => h.id === 'fn');
    const unrelatedHit = boosted.find((h) => h.id === 'unrelated');
    expect(fnHit!.score).toBeGreaterThan(unrelatedHit!.score);
  });

  it('does NOT boost a hit when the token only appears in the free-text body (not topic/codeFile)', () => {
    // 'auth' does not appear in any structural field here
    const hitsNoMatch = [
      { id: 'body-only', score: 1.0, topic: 'myproject/unrelated', tags: 'other', codeFile: null },
    ];
    const boosted = applyStructuralFieldBoost(hitsNoMatch, 'auth');
    expect(boosted[0].score).toBe(1.0); // no boost
  });

  it('boost is multiplicative and increases score above 1 for strong matches', () => {
    const hits = [
      { id: 'exact', score: 2.0, topic: 'router', tags: 'code', codeFile: 'src/router.ts' },
    ];
    const boosted = applyStructuralFieldBoost(hits, 'router');
    expect(boosted[0].score).toBeGreaterThan(2.0);
  });

  it('returns hits in descending score order after boost', () => {
    const hits = [
      { id: 'low', score: 0.5, topic: 'unrelated', tags: 'misc', codeFile: null },
      { id: 'high', score: 0.8, topic: 'router', tags: 'code', codeFile: 'src/router.ts' },
    ];
    const boosted = applyStructuralFieldBoost(hits, 'router');
    expect(boosted[0].id).toBe('high');
  });

  it('handles empty hits array gracefully', () => {
    const boosted = applyStructuralFieldBoost([], 'anything');
    expect(boosted).toEqual([]);
  });

  it('handles multi-token query — boosts if any token matches structural field', () => {
    const hits = [
      { id: 'match', score: 1.0, topic: 'myproject/auth', tags: 'typescript', codeFile: null },
      { id: 'nomatch', score: 1.0, topic: 'myproject/billing', tags: 'stripe', codeFile: null },
    ];
    const boosted = applyStructuralFieldBoost(hits, 'auth token');
    expect(boosted.find((h) => h.id === 'match')!.score).toBeGreaterThan(
      boosted.find((h) => h.id === 'nomatch')!.score,
    );
  });
});

// ---------------------------------------------------------------------------
// Item 3 — honest fallback kind: "activity" instead of mislabeled "decision"
// ---------------------------------------------------------------------------

import { composeFileNeuron } from '../src/annotator/blocks/composers/file-neuron.js';
import type { FileNeuronEnrichment } from '../src/annotator/blocks/composers/file-neuron.js';
import type { ItemKind } from '../src/commands/conv-file-enrichment.js';
import type { CodeNode } from '../src/graph/code-scanner.js';

const MINIMAL_NODE: CodeNode = {
  id: 'file:src/index.ts',
  title: 'src/index.ts',
  type: 'file',
  filePath: 'src/index.ts',
  projectRoot: '/project',
  language: 'typescript',
  lineCount: 42,
  imports: [],
  exports: ['main'],
};

describe('Item 3 — "activity" kind in ItemKind type', () => {
  it('ItemKind includes "activity"', () => {
    // TypeScript enforcement — this must compile without error
    const kind: ItemKind = 'activity';
    expect(kind).toBe('activity');
  });

  it('composeFileNeuron renders data-section="activity" when activities are provided', () => {
    const enrichment: FileNeuronEnrichment = {
      activities: [
        {
          text: 'Worked on router refactoring',
          confidence: 0.5,
          date: '2026-05-29',
          sourceConvLink: '#conv-xyz',
        },
      ],
    };
    const html = composeFileNeuron(MINIMAL_NODE, 0, enrichment);
    expect(html).toContain('data-section="activity"');
  });

  it('activity section renders the source conversation link', () => {
    const enrichment: FileNeuronEnrichment = {
      activities: [
        {
          text: 'Touched during session xyz',
          confidence: 0.4,
          date: '2026-05-29',
          sourceConvLink: '#conv-xyz',
        },
      ],
    };
    const html = composeFileNeuron(MINIMAL_NODE, 0, enrichment);
    expect(html).toContain('#conv-xyz');
  });

  it('activity section uses a low-key heading distinct from decision/bug', () => {
    const enrichment: FileNeuronEnrichment = {
      activities: [
        {
          text: 'File was read during refactoring session',
          confidence: 0.3,
          date: '2026-05-28',
          sourceConvLink: '#conv-abc',
        },
      ],
    };
    const html = composeFileNeuron(MINIMAL_NODE, 0, enrichment);
    // Should not use the same heading as "Decisions" or "Bugs"
    expect(html).not.toContain('<h3>Decisions</h3>');
    expect(html).not.toContain('<h3>Bugs</h3>');
    // The activity section heading should convey "touched in conversations"
    expect(html).toMatch(/touched|referenced|conversations?/i);
  });

  it('composeFileNeuron omits activity section when activities array is empty', () => {
    const enrichment: FileNeuronEnrichment = {
      activities: [],
    };
    const html = composeFileNeuron(MINIMAL_NODE, 0, enrichment);
    expect(html).not.toContain('data-section="activity"');
  });

  it('no activity section when activities is absent', () => {
    const html = composeFileNeuron(MINIMAL_NODE, 0, {});
    expect(html).not.toContain('data-section="activity"');
  });

  it('conv-file-enrichment accepts "activity" as a valid ItemKind at compile time', () => {
    // This test validates that 'activity' is a valid ItemKind value.
    // The TypeScript compiler would reject this assignment if 'activity' were not in the type.
    const activityKind: ItemKind = 'activity';
    expect(activityKind).toBe('activity');
  });
});
