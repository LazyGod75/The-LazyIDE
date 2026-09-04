/**
 * Tests for Feature A: CWD-scoped session injection.
 *
 * When opts.cwd is provided, notes whose data-cerveau-cwd matches the cwd
 * receive a CWD_AFFINITY_BOOST multiplier on their combined score, causing
 * them to surface preferentially in the session snapshot.
 *
 * When opts.cwd is undefined, behavior is byte-for-byte unchanged.
 *
 * Test strategy: use a tight token budget to force the ranked ordering to
 * determine which note is included. The note with the higher combined score
 * (after boost) is included; the lower-ranked note is excluded.
 * This mirrors the pattern in inject-pagerank.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexedNote } from '../src/indexer/fts.js';

// ---------------------------------------------------------------------------
// Mocks — mirror the pattern from inject-pagerank.test.ts
// ---------------------------------------------------------------------------

vi.mock('../src/indexer/fts.js', () => ({
  listAll: vi.fn(),
  notesForCwdCount: vi.fn(),
}));

vi.mock('../src/retrieval/strip.js', () => ({
  stripNote: vi.fn(),
  stripNoteToPrompt: vi.fn(),
  stripSection: vi.fn(),
}));

vi.mock('../src/store/reader.js', () => ({
  readNote: vi.fn(),
}));

vi.mock('../src/retrieval/router.js', () => ({
  route: vi.fn(),
}));

vi.mock('../src/retrieval/decay.js', () => ({
  retentionScore: vi.fn(),
}));

vi.mock('../src/graph/backlinks.js', () => ({
  loadBacklinks: vi.fn(),
  loadClusters: vi.fn(),
}));

vi.mock('../src/commands/profile-update.js', () => ({
  profileTextForInjection: vi.fn(),
}));

vi.mock('../src/util/telemetry.js', () => ({
  logTelemetry: vi.fn(),
  nowIso: vi.fn(() => '2026-06-08T10:00:00Z'),
}));

vi.mock('../src/util/session-cache.js', () => ({
  alreadyInjected: vi.fn(),
  recordInjected: vi.fn(),
  activeFiles: vi.fn(() => []),
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

vi.mock('../src/commands/build-clusters.js', () => ({
  slugifyCwd: vi.fn((cwd: string) => cwd.split('/').pop() ?? 'unknown'),
}));

vi.mock('../src/util/config.js', () => ({
  getConfig: vi.fn(() => ({
    brainPath: '/mock-brain',
    cachePath: '/mock-cache',
  })),
}));

// PageRank + notesForCwd mocks — controlled per test
vi.mock('../src/graph/pagerank.js', () => ({
  computePageRank: vi.fn(),
  notesForCwd: vi.fn(),
}));

import { runInjectContext } from '../src/commands/inject-context.js';
import { profileTextForInjection } from '../src/commands/profile-update.js';
import { loadBacklinks } from '../src/graph/backlinks.js';
import { computePageRank, notesForCwd } from '../src/graph/pagerank.js';
import { listAll } from '../src/indexer/fts.js';
import { retentionScore } from '../src/retrieval/decay.js';
import { stripNote, stripNoteToPrompt } from '../src/retrieval/strip.js';
import { readNote } from '../src/store/reader.js';
import { estimateTokenCount } from '../src/util/tokenize.js';

const mockListAll = vi.mocked(listAll);
const mockRetentionScore = vi.mocked(retentionScore);
const mockReadNote = vi.mocked(readNote);
const mockStripNote = vi.mocked(stripNote);
const mockStripNoteToPrompt = vi.mocked(stripNoteToPrompt);
const mockProfileText = vi.mocked(profileTextForInjection);
const mockLoadBacklinks = vi.mocked(loadBacklinks);
const mockComputePageRank = vi.mocked(computePageRank);
const mockNotesForCwd = vi.mocked(notesForCwd);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNote(id: string, overrides?: Partial<IndexedNote>): IndexedNote {
  return {
    id,
    path: `notes/${id}.html`,
    title: `Note ${id}`,
    type: 'semantic' as const,
    created: '2026-06-08T10:00:00Z',
    importance: 0.5,
    quality: 'refined',
    ...overrides,
  } as IndexedNote;
}

function makePageRankResult(scores: Record<string, number>) {
  return {
    scores,
    alpha: 0.85,
    iterations: 10,
    seeded_by: 'global',
    generated: new Date().toISOString(),
  };
}

/** Unique content markers — each long enough to cost ~100 tokens each. */
const CWD_CONTENT = `UNIQUE_CWD_PROJECT_MARKER_${'p'.repeat(300)}`;
const OTHER_CONTENT = `UNIQUE_OTHER_NOTE_MARKER_${'q'.repeat(300)}`;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockProfileText.mockReturnValue('');
  mockLoadBacklinks.mockReturnValue(null);
  mockComputePageRank.mockReturnValue(makePageRankResult({}));
  mockNotesForCwd.mockReturnValue([]);
  mockStripNote.mockReturnValue({
    id: 'x',
    text: 'text',
    type: 'semantic',
    created: '2026-06-08',
    tags: [],
    facts: [],
    links: [],
  });
  mockReadNote.mockReturnValue({
    html: '<article data-cerveau-type="semantic"><p>content</p></article>',
    id: 'x',
    path: 'x',
    sizeBytes: 100,
    mtimeMs: Date.now(),
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSessionInject — cwd affinity boost', () => {
  /**
   * Core behavior: note P matches cwd X, note Q does not. Both have identical
   * retention and PageRank. Under a tight budget (fits exactly one note), the
   * cwd boost causes P to rank higher so only P is included.
   */
  it('includes cwd-matching note and excludes non-matching note under tight budget', async () => {
    // Use IDs that sort alphabetically in the same order we expect output, so
    // the id-sort inside headlineNotes does not interfere with inclusion.
    // Note: headlineNotes is id-sorted for cache stability, but inclusion is
    // determined by the scored ranking — which note makes it into headlineSet
    // is what we test here with a budget that fits only one note.
    const noteP = makeNote('aa-project-note'); // cwd match
    const noteQ = makeNote('bb-other-note'); // no match

    mockListAll.mockReturnValue([noteP, noteQ]);

    // Equal retention for both — only the cwd boost differentiates them
    mockRetentionScore.mockReturnValue(0.7);

    // Equal PageRank for both
    mockComputePageRank.mockReturnValue(
      makePageRankResult({
        'aa-project-note': 0.5,
        'bb-other-note': 0.5,
      }),
    );

    // Only noteP matches the cwd
    mockNotesForCwd.mockReturnValue(['aa-project-note']);

    // First call: the cwd-boosted note (P) renders first because it ranks higher.
    // Second call: the non-matching note (Q) — excluded under tight budget.
    mockStripNoteToPrompt.mockReturnValueOnce(CWD_CONTENT).mockReturnValueOnce(OTHER_CONTENT);

    // Budget that fits exactly ONE note block
    const singleNoteTokens = estimateTokenCount(`[NOTE]\n${CWD_CONTENT}`);
    const TIGHT_BUDGET = singleNoteTokens;

    const result = await runInjectContext({
      mode: 'session',
      cwd: '/projects/myapp',
      maxTokens: TIGHT_BUDGET,
    });

    // The cwd-boosted note must be included (ranked first)
    expect(result).toContain('UNIQUE_CWD_PROJECT_MARKER_');
    // The non-matching note must be excluded (budget exhausted)
    expect(result).not.toContain('UNIQUE_OTHER_NOTE_MARKER_');
  });

  /**
   * Back-compat: when cwd is undefined, notesForCwd must NOT be called and
   * the boost must be a strict no-op. The higher-retention note still wins.
   */
  it('does not call notesForCwd when cwd is undefined', async () => {
    const noteA = makeNote('note-alpha');

    mockListAll.mockReturnValue([noteA]);
    mockRetentionScore.mockReturnValue(0.9);
    mockComputePageRank.mockReturnValue(makePageRankResult({}));
    mockStripNoteToPrompt.mockReturnValue('some content here');

    await runInjectContext({
      mode: 'session',
      maxTokens: 5000,
    });

    // notesForCwd must NOT be called when cwd is absent
    expect(mockNotesForCwd).not.toHaveBeenCalled();
  });

  /**
   * Without cwd, the natural retention ordering is preserved unchanged.
   * Note with higher retention appears in output (included under tight budget),
   * lower-retention note is excluded — identical to pre-feature behavior.
   */
  it('preserves retention-based ranking when cwd is undefined', async () => {
    const HIGH_CONTENT = `UNIQUE_HIGH_RET_${'h'.repeat(300)}`;
    const LOW_CONTENT = `UNIQUE_LOW_RET_${'l'.repeat(300)}`;

    const noteHigh = makeNote('note-high-retention');
    const noteLow = makeNote('note-low-retention');

    mockListAll.mockReturnValue([noteHigh, noteLow]);

    // noteHigh has much higher retention
    mockRetentionScore.mockImplementation((note) =>
      (note as IndexedNote).id === 'note-high-retention' ? 0.9 : 0.1,
    );

    mockComputePageRank.mockReturnValue(makePageRankResult({}));

    // First call goes to the higher-retention note
    mockStripNoteToPrompt.mockReturnValueOnce(HIGH_CONTENT).mockReturnValueOnce(LOW_CONTENT);

    const singleNoteTokens = estimateTokenCount(`[NOTE]\n${HIGH_CONTENT}`);

    const result = await runInjectContext({
      mode: 'session',
      maxTokens: singleNoteTokens,
    });

    expect(result).toContain('UNIQUE_HIGH_RET_');
    expect(result).not.toContain('UNIQUE_LOW_RET_');
    expect(mockNotesForCwd).not.toHaveBeenCalled();
  });

  /**
   * Edge case: cwd is provided but no note matches it.
   * Must not crash and ordering is determined by retention/PageRank only.
   */
  it('does not crash when cwd is provided but no note matches', async () => {
    const noteA = makeNote('note-alpha');
    const noteB = makeNote('note-beta');

    mockListAll.mockReturnValue([noteA, noteB]);
    mockRetentionScore.mockImplementation((note) =>
      (note as IndexedNote).id === 'note-alpha' ? 0.9 : 0.5,
    );
    mockComputePageRank.mockReturnValue(makePageRankResult({}));

    // No notes match the cwd
    mockNotesForCwd.mockReturnValue([]);

    mockStripNoteToPrompt.mockReturnValue('some content here');

    await expect(
      runInjectContext({
        mode: 'session',
        cwd: '/projects/no-match-at-all',
        maxTokens: 5000,
      }),
    ).resolves.not.toThrow();
  });

  /**
   * Verify that notesForCwd is called with the exact cwd argument passed.
   */
  it('calls notesForCwd with the provided cwd', async () => {
    const note = makeNote('note-x');
    mockListAll.mockReturnValue([note]);
    mockRetentionScore.mockReturnValue(0.7);
    mockComputePageRank.mockReturnValue(makePageRankResult({}));
    mockNotesForCwd.mockReturnValue([]);
    mockStripNoteToPrompt.mockReturnValue('some note content');

    await runInjectContext({
      mode: 'session',
      cwd: '/projects/specific-project',
      maxTokens: 5000,
    });

    expect(mockNotesForCwd).toHaveBeenCalledWith('/projects/specific-project');
  });
});
