/**
 * Regression coverage for the manager-startup-context "structure of the
 * brain" gap analysis (2026-08-16): a shared multi-project brain's
 * `inject-context --mode highlights` used to render EVERY project's
 * structure unconditionally (measured: 29 top-level project buckets, ~2.9k
 * tokens against a real ~7000-note brain) and matched "the current
 * project" by a bare string prefix, which let slug "lazy" also match
 * unrelated topics "lazybrain", "lazysite-internet", "lazy-backoffice".
 *
 * Covers:
 *   - buildMainPage(notes, cwd) scopes to the matching project bucket only,
 *     with a one-line count of how many other projects exist.
 *   - buildMainPage falls back to the full unscoped listing when cwd is
 *     absent or matches no known project bucket (no regression).
 *   - runMarkerInject's LAST SESSION/KEY FEATURES no longer leak a
 *     same-prefix sibling project's notes into the current project's block.
 *   - runMarkerInject's highlights mode honors an explicit maxTokens budget
 *     by skipping optional sections once the budget is reached, instead of
 *     silently ignoring it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexedNote } from '../src/indexer/fts.js';

vi.mock('../src/indexer/fts.js', () => ({
  listAll: vi.fn(),
  notesForCwdCount: vi.fn(),
}));

vi.mock('../src/store/profile.js', () => ({
  profileTextForInjection: vi.fn(() => ''),
  profilePath: vi.fn(() => '/mock-brain/_user-profile.html'),
}));

vi.mock('../src/graph/knowledge-graph.js', () => ({
  loadKnowledgeGraph: vi.fn(() => null),
}));

vi.mock('../src/graph/backlinks.js', () => ({
  loadBacklinks: vi.fn(() => null),
  loadClusters: vi.fn(),
}));

vi.mock('../src/store/reader.js', () => ({
  readNote: vi.fn(() => {
    throw new Error('not needed for these fixtures');
  }),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
  };
});

vi.mock('../src/store/paths.js', () => ({
  brainRoot: vi.fn(() => '/brain'),
}));

vi.mock('../src/util/telemetry.js', () => ({
  logTelemetry: vi.fn(),
  nowIso: vi.fn(() => '2026-08-16T00:00:00Z'),
}));

import { loadKnowledgeGraph } from '../src/graph/knowledge-graph.js';
import { listAll } from '../src/indexer/fts.js';
import { buildMainPage, runMarkerInject } from '../src/commands/inject-context/sections.js';

const mockListAll = vi.mocked(listAll);
const mockLoadKnowledgeGraph = vi.mocked(loadKnowledgeGraph);

function note(overrides: Partial<IndexedNote>): IndexedNote {
  return {
    id: `note-${Math.random().toString(36).slice(2)}`,
    path: 'notes/x.html',
    title: 'Note',
    type: 'file-neuron',
    created: '2026-08-01T00:00:00Z',
    tags: '',
    importance: 0.5,
    quality: 'refined',
    ...overrides,
  } as IndexedNote;
}

describe('buildMainPage — project scoping', () => {
  const notes: IndexedNote[] = [
    note({ id: 'a', topic: 'lazy/code/typescript', title: 'Lazy feature A', created: '2026-08-01T00:00:00Z' }),
    note({ id: 'b', topic: 'lazybrain/code/typescript', title: 'LazyBrain feature B', created: '2026-08-02T00:00:00Z' }),
    note({ id: 'c', topic: 'trading/code/python', title: 'Trading feature C', created: '2026-08-03T00:00:00Z' }),
  ];

  it('scopes to the matching project bucket and reports how many others exist', () => {
    const result = buildMainPage(notes, 'C:\\Users\\user\\Documents\\cerveau\\lazy');

    expect(result).toMatch(/^lazy\//m);
    expect(result).not.toMatch(/lazybrain\//);
    expect(result).not.toMatch(/trading\//);
    expect(result).toMatch(/\+2 other projects in brain/);
  });

  it('falls back to the full unscoped listing when cwd matches no project bucket', () => {
    const result = buildMainPage(notes, 'C:\\Users\\user\\Documents\\cerveau\\some-unrelated-dir');

    expect(result).toMatch(/lazy\//);
    expect(result).toMatch(/lazybrain\//);
    expect(result).toMatch(/trading\//);
  });

  it('falls back to the full unscoped listing when no cwd is given', () => {
    const result = buildMainPage(notes);

    expect(result).toMatch(/lazy\//);
    expect(result).toMatch(/lazybrain\//);
    expect(result).toMatch(/trading\//);
  });
});

describe('buildMainPage — [STUBS] short-id collision', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows each distinct stub once even when two different ids collide on their shortId() display form', () => {
    // Real-brain motivation (2026-08-16): two distinct topic-overview stub
    // notes truncate to the identical 32-char shortId() display form
    // (date-strip + 32-char slice + trailing-hyphen-fragment strip is lossy
    // past that length), so the OLD [STUBS] line named
    // "#topic-overview-cerveau-code" twice among 5 entries — a duplicate
    // that isn't even fetchable as two different notes.
    const stubs: IndexedNote[] = [
      note({
        id: '2026-08-14-topic-overview-cerveau-code-alpha',
        quality: 'stub',
        created: '2026-08-14T00:00:00Z',
      }),
      note({
        id: '2026-08-15-topic-overview-cerveau-code-beta',
        quality: 'stub',
        created: '2026-08-15T00:00:00Z',
      }),
      note({ id: 'distinct-stub-a', quality: 'stub', created: '2026-08-15T00:00:00Z' }),
    ];
    mockListAll.mockReturnValue(stubs);

    const result = buildMainPage([]);

    const stubsLine = result.split('\n').find((l) => l.startsWith('[STUBS]'));
    expect(stubsLine).toBeDefined();
    // Only ONE of the two colliding ids is shown, plus the distinct one —
    // never the same displayed id twice, and the count matches what is
    // actually shown.
    const occurrences = (stubsLine?.match(/#topic-overview-cerveau-code/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(stubsLine).toContain('2 notes need expansion');
  });
});

describe('runMarkerInject — cross-project leak fix + budget gating', () => {
  beforeEach(() => {
    mockLoadKnowledgeGraph.mockReturnValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
    mockLoadKnowledgeGraph.mockReturnValue(null);
  });

  it('LAST SESSION / KEY FEATURES only include the current project, not a same-prefix sibling', () => {
    mockListAll.mockReturnValue([
      note({
        id: 'lazy-note',
        topic: 'lazy/code/typescript',
        title: 'Lazy own feature title',
        created: '2026-08-10T00:00:00Z',
      }),
      note({
        id: 'lazybrain-note',
        topic: 'lazybrain/code/typescript',
        title: 'LazyBrain sibling feature title',
        created: '2026-08-11T00:00:00Z',
      }),
    ]);

    const result = runMarkerInject(true, 'C:\\Users\\user\\Documents\\cerveau\\lazy');

    expect(result).toContain('Lazy own feature title');
    expect(result).not.toContain('LazyBrain sibling feature title');
  });

  it('respects an explicit maxTokens budget by skipping optional sections instead of ignoring it', () => {
    const manyNotes = Array.from({ length: 40 }, (_, i) =>
      note({
        id: `lazy-note-${i}`,
        topic: `lazy/code/module-${i}`,
        title: `Lazy feature ${i} with a fairly long descriptive title to inflate size`,
        created: `2026-08-${String((i % 27) + 1).padStart(2, '0')}T00:00:00Z`,
      }),
    );
    mockListAll.mockReturnValue(manyNotes);

    const unbounded = runMarkerInject(true, 'C:\\Users\\user\\Documents\\cerveau\\lazy');
    const bounded = runMarkerInject(true, 'C:\\Users\\user\\Documents\\cerveau\\lazy', 'skill', 60);

    expect(bounded.length).toBeLessThan(unbounded.length);
    // The marker line and the final recall nudge must survive even under a tight budget.
    expect(bounded).toMatch(/\[BRAIN\] \d+ notes available/);
  });

  it('states "(+N other projects…)" only once, not once per structural block', () => {
    // Real-brain motivation (2026-08-16): buildGraphLines (topic tree, right
    // under the [BRAIN] marker) and buildMainPage (project/feature summary)
    // both used to append the identical "(+N other projects in brain…)"
    // sentence unconditionally — the same fact stated twice back to back.
    mockListAll.mockReturnValue([
      note({ id: 'lazy-note', topic: 'lazy/code', title: 'Lazy note' }),
      note({ id: 'lazybrain-note', topic: 'lazybrain/code', title: 'LazyBrain note' }),
      note({ id: 'trading-note', topic: 'trading/code', title: 'Trading note' }),
    ]);
    mockLoadKnowledgeGraph.mockReturnValue({
      topicTree: [
        { name: 'lazy', noteCount: 1, hubIds: [], children: [] },
        { name: 'lazybrain', noteCount: 1, hubIds: [], children: [] },
        { name: 'trading', noteCount: 1, hubIds: [], children: [] },
      ],
    } as unknown as ReturnType<typeof loadKnowledgeGraph>);

    const result = runMarkerInject(true, 'C:\\Users\\user\\Documents\\cerveau\\lazy');

    const occurrences = (result.match(/other projects in brain/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});
