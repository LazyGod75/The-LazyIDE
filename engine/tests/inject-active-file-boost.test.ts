/**
 * Tests for Feature C: Active working set boost in runTurnInject.
 *
 * When the active file set for the session contains a path, notes whose
 * data-cerveau-cwd is a prefix of that path (or whose data-code-file basename
 * matches) receive ACTIVE_FILE_BOOST on their score, causing them to rank
 * higher under a tight token budget.
 *
 * When active set is empty / sessionId absent, behavior is byte-for-byte
 * unchanged (deterministic regression guard).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedHit } from '../src/retrieval/router.js';
import type { StrippedNote } from '../src/retrieval/strip.js';

// ---------------------------------------------------------------------------
// Mocks — mirror the pattern from inject-context.test.ts and inject-pagerank.test.ts
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

// NOTE: session-cache is NOT mocked here — we use the real module so that
// recordTouchedFiles / activeFiles state is exercised end-to-end with the
// inject path.

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

vi.mock('../src/graph/pagerank.js', () => ({
  computePageRank: vi.fn(),
  notesForCwd: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports AFTER mock declarations
// ---------------------------------------------------------------------------

import { runInjectContext } from '../src/commands/inject-context.js';
import { profileTextForInjection } from '../src/commands/profile-update.js';
import { loadBacklinks } from '../src/graph/backlinks.js';
import { computePageRank } from '../src/graph/pagerank.js';
import { listAll } from '../src/indexer/fts.js';
import { route } from '../src/retrieval/router.js';
import { stripNoteToPrompt } from '../src/retrieval/strip.js';
import { readNote } from '../src/store/reader.js';
import { clearAllSessions, recordTouchedFiles } from '../src/util/session-cache.js';
import { estimateTokenCount } from '../src/util/tokenize.js';

const mockListAll = vi.mocked(listAll);
const mockRoute = vi.mocked(route);
const mockStripNoteToPrompt = vi.mocked(stripNoteToPrompt);
const mockReadNote = vi.mocked(readNote);
const mockProfileText = vi.mocked(profileTextForInjection);
const mockLoadBacklinks = vi.mocked(loadBacklinks);
const mockComputePageRank = vi.mocked(computePageRank);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTIVE_CONTENT = `ACTIVE_FILE_HIT_${'a'.repeat(300)}`;
const OTHER_CONTENT = `OTHER_NOTE_HIT_${'b'.repeat(300)}`;

function makeStrippedNote(overrides?: Partial<StrippedNote>): StrippedNote {
  return {
    id: 'note-x',
    text: 'some text',
    type: 'semantic' as const,
    created: '2026-06-08T10:00:00Z',
    tags: [],
    facts: [],
    links: [],
    ...overrides,
  };
}

/**
 * Build a hit whose raw HTML note (served via readNote mock) carries the given
 * data-cerveau-cwd attribute. The hit itself has hydrateNote=true so hit.note
 * is populated.
 */
function makeHit(
  id: string,
  score: number,
  cwd: string | null,
  codeFile?: string | null,
): ResolvedHit {
  const cwdAttr = cwd ? `data-cerveau-cwd="${cwd}"` : '';
  const codeFileAttr = codeFile ? `data-code-file="${codeFile}"` : '';
  return {
    id,
    path: `notes/${id}.html`,
    score,
    level: 'L2' as const,
    note: makeStrippedNote({ id }),
    // raw HTML is returned by the readNote mock (used in selectiveStripForTurn
    // and by the active-file matcher)
    _rawHtml: `<article id="${id}" data-cerveau-type="semantic" ${cwdAttr} ${codeFileAttr}></article>`,
  } as ResolvedHit & { _rawHtml: string };
}

function setupReadNoteMock(hits: Array<ResolvedHit & { _rawHtml?: string }>): void {
  mockReadNote.mockImplementation((p: string) => {
    const hit = hits.find((h) => h.path === p);
    return {
      html: hit?._rawHtml ?? '<article></article>',
      id: hit?.id ?? 'unknown',
      path: p,
      sizeBytes: 100,
      mtimeMs: Date.now(),
    };
  });
}

function makePageRankResult() {
  return {
    scores: {},
    alpha: 0.85,
    iterations: 10,
    seeded_by: 'global',
    generated: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockListAll.mockReturnValue([]);
  mockProfileText.mockReturnValue('');
  mockLoadBacklinks.mockReturnValue(null);
  mockComputePageRank.mockReturnValue(makePageRankResult());
});

afterEach(() => {
  vi.clearAllMocks();
  clearAllSessions();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runTurnInject — active file boost', () => {
  /**
   * Core behavior: note A's cwd matches an active file path, note B's does not.
   * Both have equal route scores. Under a tight budget, A should rank higher.
   */
  it('boosts note whose data-cerveau-cwd is a prefix of an active file path', async () => {
    const hitA = makeHit('note-active', 3.0, '/projects/myapp');
    const hitB = makeHit('note-other', 3.0, '/projects/other');

    mockRoute.mockResolvedValue({
      hits: [hitA, hitB],
      levelUsed: 'L2' as const,
      totalMs: 10,
    });

    setupReadNoteMock([hitA, hitB]);

    // First call (boosted note A), second call (non-boosted note B)
    mockStripNoteToPrompt.mockReturnValueOnce(ACTIVE_CONTENT).mockReturnValueOnce(OTHER_CONTENT);

    const SESSION = 'test-session-boost';
    // Active file lives under /projects/myapp
    recordTouchedFiles(SESSION, ['/projects/myapp/src/foo.ts']);

    const singleNoteTokens = estimateTokenCount(`[RECALL]\n${ACTIVE_CONTENT}`);
    const TIGHT_BUDGET = singleNoteTokens;

    const result = await runInjectContext({
      mode: 'turn',
      query: 'what is the active working set feature',
      sessionId: SESSION,
      maxTokens: TIGHT_BUDGET,
      minScore: 0,
    });

    expect(result).toContain('ACTIVE_FILE_HIT_');
    expect(result).not.toContain('OTHER_NOTE_HIT_');
  });

  /**
   * Baseline: with no active files, order is determined by route score alone.
   * Higher score note is included.
   */
  it('preserves route score ordering when active set is empty', async () => {
    const HIGH_CONTENT = `HIGH_SCORE_CONTENT_${'h'.repeat(300)}`;
    const LOW_CONTENT = `LOW_SCORE_CONTENT_${'l'.repeat(300)}`;

    const hitHigh = makeHit('note-high', 5.0, '/projects/other');
    const hitLow = makeHit('note-low', 3.0, '/projects/other');

    mockRoute.mockResolvedValue({
      hits: [hitHigh, hitLow],
      levelUsed: 'L2' as const,
      totalMs: 10,
    });

    setupReadNoteMock([hitHigh, hitLow]);
    mockStripNoteToPrompt.mockReturnValueOnce(HIGH_CONTENT).mockReturnValueOnce(LOW_CONTENT);

    const SESSION = 'test-session-empty';
    // No recordTouchedFiles call — active set is empty

    const singleNoteTokens = estimateTokenCount(`[RECALL]\n${HIGH_CONTENT}`);

    const result = await runInjectContext({
      mode: 'turn',
      query: 'something about the codebase architecture',
      sessionId: SESSION,
      maxTokens: singleNoteTokens,
      minScore: 0,
    });

    expect(result).toContain('HIGH_SCORE_CONTENT_');
    expect(result).not.toContain('LOW_SCORE_CONTENT_');
  });

  /**
   * Back-compat: when sessionId is absent, behavior is entirely unchanged.
   */
  it('does not apply boost when sessionId is undefined', async () => {
    const HIGH_CONTENT = `HIGH_NO_SESSION_${'h'.repeat(300)}`;
    const LOW_CONTENT = `LOW_NO_SESSION_${'l'.repeat(300)}`;

    const hitHigh = makeHit('note-high-ns', 5.0, '/projects/irrelevant');
    const hitLow = makeHit('note-low-ns', 3.0, '/projects/irrelevant');

    mockRoute.mockResolvedValue({
      hits: [hitHigh, hitLow],
      levelUsed: 'L2' as const,
      totalMs: 10,
    });

    setupReadNoteMock([hitHigh, hitLow]);
    mockStripNoteToPrompt.mockReturnValueOnce(HIGH_CONTENT).mockReturnValueOnce(LOW_CONTENT);

    const singleNoteTokens = estimateTokenCount(`[RECALL]\n${HIGH_CONTENT}`);

    const result = await runInjectContext({
      mode: 'turn',
      query: 'some query about the architecture of the system',
      sessionId: undefined,
      maxTokens: singleNoteTokens,
      minScore: 0,
    });

    // Higher-scored note should still win with no boost applied
    expect(result).toContain('HIGH_NO_SESSION_');
    expect(result).not.toContain('LOW_NO_SESSION_');
  });

  /**
   * data-code-file basename matching: active file basename matches note's
   * data-code-file basename.
   */
  it('boosts note whose data-code-file basename matches active file basename', async () => {
    // note-codefile has data-code-file="src/retrieval/router.ts"
    // active file path: /projects/app/src/retrieval/router.ts
    const hitMatch = makeHit('note-codefile', 3.0, null, 'src/retrieval/router.ts');
    const hitOther = makeHit('note-plain', 3.0, null, null);

    mockRoute.mockResolvedValue({
      hits: [hitMatch, hitOther],
      levelUsed: 'L2' as const,
      totalMs: 10,
    });

    setupReadNoteMock([hitMatch, hitOther]);
    mockStripNoteToPrompt.mockReturnValueOnce(ACTIVE_CONTENT).mockReturnValueOnce(OTHER_CONTENT);

    const SESSION = 'test-session-codefile';
    recordTouchedFiles(SESSION, ['/projects/app/src/retrieval/router.ts']);

    const singleNoteTokens = estimateTokenCount(`[RECALL]\n${ACTIVE_CONTENT}`);

    const result = await runInjectContext({
      mode: 'turn',
      query: 'how does the router handle L2 fallback',
      sessionId: SESSION,
      maxTokens: singleNoteTokens,
      minScore: 0,
    });

    expect(result).toContain('ACTIVE_FILE_HIT_');
    expect(result).not.toContain('OTHER_NOTE_HIT_');
  });
});
