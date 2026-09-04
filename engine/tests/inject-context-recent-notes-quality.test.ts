/**
 * Coverage for the `[RECENT NOTES]`/`[KEY FEATURES]` content-quality fix
 * (2026-08-16): a topic-overview note's raw body (infobox stats line, TOC
 * wikilink markup, a `[lead]` marker, and — observed on a real ~6000-note
 * brain — a corrupted raw JSON/type-union fragment) used to leak into
 * `[RECENT NOTES]` because summaryLineFor re-parsed HTML with
 * `stripSection(html, 'section[data-section="tldr"]')`, whose selector-miss
 * fallback chain (tldr → summary → raw head-slice of the WHOLE document)
 * dumps exactly that chrome when a note has no tldr section.
 *
 * The fix (sections.ts):
 *   - summaryLineFor now reads the already-indexed `section_tldr` SQL column
 *     directly (never re-parses HTML), filtered through looksLikeProse.
 *   - `topic-overview` and `concept` notes are excluded from RECENT
 *     NOTES/KEY FEATURES candidacy entirely (generated indexes, not events —
 *     see appendRecentNotesBlock's GENERATED_INDEX_TYPES doc comment).
 *   - A candidate with no usable summary is skipped in favor of the next
 *     one; if none qualify, the block is omitted rather than emitting a
 *     header with chrome under it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IndexedNote } from '../src/indexer/fts.js';

vi.mock('../src/indexer/fts.js', () => ({
  listAll: vi.fn(),
  notesForCwdCount: vi.fn(() => ({ count: 0, activeDecisions: 0, topTags: [] })),
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
    throw new Error('sections.ts must not read note HTML for RECENT NOTES/KEY FEATURES anymore');
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

import { listAll } from '../src/indexer/fts.js';
import { runMarkerInject } from '../src/commands/inject-context/sections.js';

const mockListAll = vi.mocked(listAll);

const CWD = 'C:\\Users\\user\\Documents\\cerveau\\lazy';

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
    topic: 'lazy/code',
    ...overrides,
  } as IndexedNote;
}

describe('runMarkerInject highlights — RECENT NOTES content quality', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('never surfaces a topic-overview note, even when it is the most recent and has a lead paragraph', () => {
    mockListAll.mockReturnValue([
      note({
        id: 'topic-overview-lazy',
        type: 'topic-overview',
        title: 'Lazy',
        created: '2026-08-16T00:00:00Z',
        // topic-overview notes never carry a tldr section in real HTML, but
        // even if one somehow did, the type exclusion must still apply.
        section_tldr: 'Some overview text.',
      }),
      note({
        id: 'real-note',
        type: 'file-neuron',
        title: 'shared.js',
        created: '2026-08-10T00:00:00Z',
        section_tldr: 'javascript file with 9 functions (328 lines)',
      }),
    ]);

    const result = runMarkerInject(true, CWD, 'tool', 2000);

    expect(result).toContain('[RECENT NOTES]');
    expect(result).toContain('javascript file with 9 functions');
    // The topic-overview note (dated 2026-08-16, more recent than the
    // file-neuron) must never appear as a RECENT NOTES entry, and its
    // section_tldr content must never surface anywhere.
    expect(result).not.toContain('2026-08-16 Lazy');
    expect(result).not.toContain('Some overview text.');
  });

  it('never surfaces a concept note (templated "<kind> concept — <title>" one-liner carries no real signal)', () => {
    mockListAll.mockReturnValue([
      note({
        id: 'concept-bug-contents',
        type: 'concept',
        title: 'Contents',
        created: '2026-08-16T00:00:00Z',
        section_tldr: 'bug concept — Contents',
      }),
      note({
        id: 'real-note',
        type: 'file-neuron',
        title: 'api-client.js',
        created: '2026-08-10T00:00:00Z',
        section_tldr: 'javascript file with 13 functions (221 lines)',
      }),
    ]);

    const result = runMarkerInject(true, CWD, 'tool', 2000);

    expect(result).toContain('[RECENT NOTES]');
    expect(result).toContain('javascript file with 13 functions');
    // The concept note (dated 2026-08-16, more recent than the file-neuron)
    // must never appear as a RECENT NOTES entry, and its templated tldr
    // one-liner must never surface anywhere.
    expect(result).not.toContain('2026-08-16 Contents');
    expect(result).not.toContain('bug concept');
  });

  it('skips a note whose tldr is a raw wikilink/schema fragment and prefers the next candidate', () => {
    mockListAll.mockReturnValue([
      note({
        id: 'corrupted-note',
        type: 'file-neuron',
        title: 'Corrupted',
        created: '2026-08-16T00:00:00Z',
        // Same shape as the real leaked fragment:
        // 0,"kind""decision" | "fact" | "error" | "learning"}
        section_tldr: '0,"kind""decision" | "fact" | "error" | "learning"}',
      }),
      note({
        id: 'toc-note',
        type: 'file-neuron',
        title: 'TOC-ish',
        created: '2026-08-15T00:00:00Z',
        section_tldr: '[1 Concepts→#concepts]',
      }),
      note({
        id: 'clean-note',
        type: 'file-neuron',
        title: 'clean.ts',
        created: '2026-08-14T00:00:00Z',
        section_tldr: 'typescript file with 4 functions (80 lines)',
      }),
    ]);

    const result = runMarkerInject(true, CWD, 'tool', 2000);

    expect(result).toContain('[RECENT NOTES]');
    expect(result).toContain('typescript file with 4 functions');
    expect(result).not.toContain('"kind""decision"');
    expect(result).not.toContain('→#concepts');
  });

  it('omits the block entirely when no candidate has a usable prose summary', () => {
    mockListAll.mockReturnValue([
      note({
        id: 'no-tldr-1',
        type: 'file-neuron',
        title: 'No tldr 1',
        created: '2026-08-16T00:00:00Z',
        section_tldr: null,
      }),
      note({
        id: 'no-tldr-2',
        type: 'file-neuron',
        title: 'No tldr 2',
        created: '2026-08-15T00:00:00Z',
        section_tldr: undefined,
      }),
    ]);

    const result = runMarkerInject(true, CWD, 'tool', 2000);

    expect(result).not.toContain('[RECENT NOTES]');
    expect(result).not.toContain('[RECENT CONVERSATIONS]');
  });
});
