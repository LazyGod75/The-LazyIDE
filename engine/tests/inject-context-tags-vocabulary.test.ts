/**
 * Coverage for the `[TAGS]` vocabulary block (inject-context highlights mode,
 * item 3 of the startup-injection spec: "les differentes balises") and its
 * priority in the budget ordering relative to `[RECENT NOTES]`/KEY FEATURES.
 *
 * noteVocabularyCensus itself (the real SQL query) is covered against a real
 * fixture DB in src/indexer/__tests__/note-vocabulary-census.test.ts — this
 * file only proves sections.ts renders/scopes/orders its output correctly,
 * so noteVocabularyCensus is mocked here (same mocking style as the sibling
 * inject-context-project-scoping.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexedNote } from '../src/indexer/fts.js';

vi.mock('../src/indexer/fts.js', () => ({
  listAll: vi.fn(),
  notesForCwdCount: vi.fn(),
  noteVocabularyCensus: vi.fn(() => ({ types: [], tags: [] })),
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

import { highlightsRecallNudge } from '../src/commands/inject-context/markers.js';
import {
  buildTagVocabularyBlock,
  runMarkerInject,
} from '../src/commands/inject-context/sections.js';
import { listAll, noteVocabularyCensus } from '../src/indexer/fts.js';

const mockCensus = vi.mocked(noteVocabularyCensus);
const mockListAll = vi.mocked(listAll);

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

describe('buildTagVocabularyBlock', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders types and tags with real counts, in a single compact line', () => {
    mockCensus.mockReturnValue({
      types: [
        { value: 'decision', count: 12 },
        { value: 'episodic', count: 340 },
      ],
      tags: [
        { value: 'bug', count: 45 },
        { value: 'typescript', count: 30 },
      ],
    });

    const block = buildTagVocabularyBlock('/some/project');

    // Tag values are VERBATIM (not abbreviateTag'd) — see this function's
    // doc comment: an abbreviated "ts" would not match any note's real
    // data-cerveau-tags="...typescript..." attribute, breaking the
    // brain_query_css selector the [RECALL] footer tells the model to build
    // from this exact line (proven against the real brain: 0 hits).
    expect(block).toBe('[TAGS] types: decision:12 episodic:340 | tags: bug:45 typescript:30');
  });

  it('never abbreviates a tag value — the census value must match the real data-cerveau-tags attribute verbatim', () => {
    mockCensus.mockReturnValue({
      types: [],
      tags: [
        { value: 'typescript', count: 267 },
        { value: 'javascript', count: 71 },
        { value: 'database', count: 5 },
      ],
    });

    const block = buildTagVocabularyBlock('/some/project');

    expect(block).toContain('typescript:267');
    expect(block).toContain('javascript:71');
    expect(block).toContain('database:5');
    expect(block).not.toContain('ts:267');
    expect(block).not.toContain('js:71');
    expect(block).not.toContain('db:5');
  });

  it('returns empty string when the census is empty (never emits an empty [TAGS] header)', () => {
    mockCensus.mockReturnValue({ types: [], tags: [] });

    expect(buildTagVocabularyBlock('/some/project')).toBe('');
    expect(buildTagVocabularyBlock(undefined)).toBe('');
  });

  it('never includes a zero-count entry — the census function is trusted to already exclude them', () => {
    // noteVocabularyCensus is contracted to only return real, non-zero
    // populations (proven in note-vocabulary-census.test.ts) — this test
    // guards that buildTagVocabularyBlock does not itself re-introduce a
    // zero by, e.g., padding a fixed-size list.
    mockCensus.mockReturnValue({
      types: [{ value: 'decision', count: 1 }],
      tags: [],
    });

    const block = buildTagVocabularyBlock('/some/project');

    expect(block).toBe('[TAGS] types: decision:1');
    expect(block).not.toContain(':0');
  });

  it('scopes the census to the project slug derived from cwd', () => {
    mockCensus.mockReturnValue({ types: [], tags: [] });

    buildTagVocabularyBlock('C:\\Users\\user\\Documents\\cerveau\\lazy');

    expect(mockCensus).toHaveBeenCalledWith('lazy');
  });

  it('passes undefined (brain-wide census) when no cwd is given', () => {
    mockCensus.mockReturnValue({ types: [], tags: [] });

    buildTagVocabularyBlock(undefined);

    expect(mockCensus).toHaveBeenCalledWith(undefined);
  });
});

describe('appendHighlights budget ordering — [TAGS] outranks a 3rd RECENT NOTES entry', () => {
  beforeEach(() => {
    mockCensus.mockReturnValue({
      types: [{ value: 'decision', count: 3 }],
      tags: [{ value: 'auth', count: 5 }],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('keeps [TAGS] under a budget too tight for RECENT NOTES/KEY FEATURES', async () => {
    const { estimateTokenCount } = await import('../src/util/tokenize.js');
    const manyNotes = Array.from({ length: 40 }, (_, i) =>
      note({
        id: `lazy-note-${i}`,
        topic: `lazy/code/module-${i}`,
        title: `Lazy feature ${i} with a fairly long descriptive title to inflate size`,
        created: `2026-08-${String((i % 27) + 1).padStart(2, '0')}T00:00:00Z`,
      }),
    );
    mockListAll.mockReturnValue(manyNotes);

    // Derive the exact token count through marker + mainPage + [TAGS] (i.e.
    // everything BEFORE RECENT NOTES/KEY FEATURES would be appended) from an
    // unbounded run, then set the budget to exactly that — `underBudget()`
    // (strict `<`) then lets [TAGS] survive (it was already included when
    // the count was taken) while blocking the next optional section.
    //
    // The caller-facing budget also has to cover the final [RECALL] footer,
    // which appendHighlights reserves up front (2026-08-16, so its
    // guaranteed-unconditional append never overshoots the caller's real
    // ceiling) — add its cost back so the INTERNAL gated budget (what this
    // test is actually targeting) still lands exactly at throughTags.
    const unbounded = runMarkerInject(true, 'C:\\Users\\user\\Documents\\cerveau\\lazy');
    const tagsIdx = unbounded.indexOf('[TAGS]');
    expect(tagsIdx).toBeGreaterThan(-1);
    const nextSectionIdx = unbounded.indexOf('\n', tagsIdx + '[TAGS]'.length);
    const throughTags = unbounded.slice(0, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    const footerCost = estimateTokenCount(highlightsRecallNudge('skill'));
    const budget = estimateTokenCount(throughTags) + footerCost;

    const result = runMarkerInject(
      true,
      'C:\\Users\\user\\Documents\\cerveau\\lazy',
      'skill',
      budget,
    );

    expect(result).toContain('[TAGS]');
    expect(result).not.toContain('[RECENT NOTES]');
  });

  it('still appends the final recall nudge even when [TAGS] itself is dropped by an extremely tight budget', () => {
    mockListAll.mockReturnValue([note({ topic: 'lazy/code' })]);

    const result = runMarkerInject(true, 'C:\\Users\\user\\Documents\\cerveau\\lazy', 'skill', 1);

    expect(result).toMatch(/\[RECALL\]/);
  });
});
