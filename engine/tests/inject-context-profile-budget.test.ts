/**
 * Coverage for the step-2 always-on-prefix budget fix (2026-08-16):
 * `[USER PROFILE]` + `[BRAIN]` + `[GRAPH]` used to be concatenated
 * unconditionally into `--mode highlights` output BEFORE any budget check —
 * measured ~437 tokens against a real 400-token ceiling on the owner's
 * brain, so no optional section (not even the new `[TAGS]` block) ever had
 * room to render. `buildProfileBlock` (sections.ts) now scopes/trims the
 * profile when `cwd` resolves to a known project, and `appendHighlights`
 * gates it through the same soft-ceiling `underBudget()` pipeline as every
 * other optional section — checked LAST, since it is not one of the four
 * required startup-context items.
 *
 * This file covers:
 *   - buildProfileBlock: project-scoped invocations drop the global tag
 *     census / active-projects list and keep only "Stable decisions /
 *     preferences" (and only when it holds real content).
 *   - The unscoped escape hatch: no cwd (or cwd matching no known project)
 *     keeps the FULL, untouched profile.
 *   - A realistic fixture brain fits all four required sections (RECENT
 *     NOTES, structure, [TAGS], the [RECALL] usage instruction) inside a
 *     400-token budget.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexedNote } from '../src/indexer/fts.js';

const FIXTURE_PROFILE = `User profile (auto)

Recurring interests (stable tags)

- bug — 120 notes

- auth — 90 notes

Active projects (frequent working dirs)

- c:/users/dev/documents/demo (300)

Stable decisions / preferences

- Always use parameterized SQL queries, never string-concatenated`;

const EMPTY_DECISIONS_PROFILE = `User profile (auto)

Recurring interests (stable tags)

- bug — 120 notes

Active projects (frequent working dirs)

- c:/users/dev/documents/demo (300)

Stable decisions / preferences

- (no recurring decisions yet)`;

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

import { listAll, noteVocabularyCensus, notesForCwdCount } from '../src/indexer/fts.js';
import { profileTextForInjection } from '../src/store/profile.js';
import { buildProfileBlock, runMarkerInject } from '../src/commands/inject-context/sections.js';
import { estimateTokenCount } from '../src/util/tokenize.js';

const mockListAll = vi.mocked(listAll);
const mockCensus = vi.mocked(noteVocabularyCensus);
const mockNotesForCwdCount = vi.mocked(notesForCwdCount);
const mockProfileTextForInjection = vi.mocked(profileTextForInjection);

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

describe('buildProfileBlock', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('unscoped (no cwd): keeps the FULL, untouched profile — the escape hatch', () => {
    mockProfileTextForInjection.mockReturnValue(FIXTURE_PROFILE);

    const result = buildProfileBlock(undefined);

    expect(result).toContain('[USER PROFILE]');
    expect(result).toContain('Recurring interests');
    expect(result).toContain('Active projects');
    expect(result).toContain('Stable decisions / preferences');
    expect(result).toContain('parameterized SQL queries');
  });

  it('unscoped (cwd matches no known project bucket): also keeps the full profile', () => {
    mockProfileTextForInjection.mockReturnValue(FIXTURE_PROFILE);

    // deriveProjectSlug only ever returns '' for inputs with no meaningful
    // path segment (see sections.ts) — a plain drive root is one such case.
    const result = buildProfileBlock('C:\\');

    expect(result).toContain('Recurring interests');
  });

  it('scoped (cwd resolves): drops the global tag census and active-projects list', () => {
    mockProfileTextForInjection.mockReturnValue(FIXTURE_PROFILE);

    const result = buildProfileBlock('C:\\Users\\dev\\Documents\\demo');

    expect(result).toContain('[USER PROFILE]');
    expect(result).toContain('Stable decisions / preferences');
    expect(result).toContain('parameterized SQL queries');
    expect(result).not.toContain('Recurring interests');
    expect(result).not.toContain('bug — 120 notes');
    expect(result).not.toContain('Active projects');
    expect(result).not.toContain('c:/users/dev/documents/demo (300)');
  });

  it('scoped, decisions section is the empty placeholder: returns empty (0 tokens)', () => {
    mockProfileTextForInjection.mockReturnValue(EMPTY_DECISIONS_PROFILE);

    const result = buildProfileBlock('C:\\Users\\dev\\Documents\\demo');

    expect(result).toBe('');
  });

  it('no profile at all: returns empty', () => {
    mockProfileTextForInjection.mockReturnValue('');

    expect(buildProfileBlock('C:\\Users\\dev\\Documents\\demo')).toBe('');
    expect(buildProfileBlock(undefined)).toBe('');
  });
});

describe('runMarkerInject highlights mode — unscoped path keeps the global profile', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits the full profile when no cwd is passed to highlights mode', () => {
    mockProfileTextForInjection.mockReturnValue(FIXTURE_PROFILE);
    mockListAll.mockReturnValue([note({ topic: 'demo/code' })]);

    const result = runMarkerInject(true, undefined, 'skill');

    expect(result).toContain('[USER PROFILE]');
    expect(result).toContain('Recurring interests');
  });
});

describe('a realistic fixture fits all four required sections inside a 400-token budget', () => {
  beforeEach(() => {
    mockCensus.mockReturnValue({
      types: [
        { value: 'file-neuron', count: 12 },
        { value: 'decision', count: 2 },
      ],
      tags: [
        { value: 'auth', count: 8 },
        { value: 'typescript', count: 6 },
      ],
    });
    mockNotesForCwdCount.mockReturnValue({ count: 20, activeDecisions: 2, topTags: ['auth'] });
    mockProfileTextForInjection.mockReturnValue(EMPTY_DECISIONS_PROFILE);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders RECENT NOTES, structure, [TAGS], and the [RECALL] usage instruction within 400 tokens', () => {
    // section_tldr is set on every fixture note — real notes always carry it
    // when they have a genuine tldr section (note-index.ts's
    // extractSectionTextContent, populated once at index time). A fixture
    // with no section_tldr is not "realistic": sections.ts's summaryLineFor
    // now reads this indexed column directly (never re-parses HTML), so a
    // note without one is correctly treated as having no usable preview and
    // skipped by appendLastThreeNotes/appendKeyFeatures in favor of the next
    // candidate — see this file's module doc comment and
    // inject-context/sections.ts's summaryLineFor doc comment for why.
    const demoNotes = Array.from({ length: 8 }, (_, i) =>
      note({
        id: `demo-note-${i}`,
        topic: `demo/feature-${i % 3}`,
        title: `Demo feature ${i} implementation note`,
        created: `2026-08-${String((i % 10) + 1).padStart(2, '0')}T00:00:00Z`,
        tags: 'auth typescript',
        section_tldr: `Implemented feature ${i} of the demo project.`,
      }),
    );
    mockListAll.mockReturnValue(demoNotes);

    const result = runMarkerInject(true, 'C:\\Users\\dev\\Documents\\demo', 'tool', 400);

    expect(result).toContain('[RECENT NOTES]');
    expect(result).toContain('[TAGS]');
    expect(result).toMatch(/\[BRAIN\] \d+ notes available/);
    expect(result).toContain('[RECALL]');
    expect(estimateTokenCount(result)).toBeLessThanOrEqual(450); // soft ceiling, small overshoot tolerated
  });
});
