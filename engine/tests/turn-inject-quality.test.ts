/**
 * turn-inject-quality.test.ts — Regression tests for turn-inject output quality.
 *
 * Covers:
 *   1. Prompt matching a known note → useful pointer injected (note id + path).
 *   2. Gibberish / no-match prompt → empty output (no bare topic fragments).
 *   3. Feature-map fast-path produces content-rich output or falls back to search.
 *   4. Minimum-usefulness gate: bare `[proj/ map]` header alone is never emitted.
 *   5. When hits ARE injected, a skill-invocation header is prepended.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexedNote } from '../src/indexer/fts.js';
import type { StrippedNote } from '../src/retrieval/strip.js';

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

vi.mock('../src/store/profile.js', () => ({
  profileTextForInjection: vi.fn(),
  profilePath: vi.fn(() => '/mock-brain/_user-profile.html'),
}));

vi.mock('../src/commands/profile-update.js', () => ({
  profileTextForInjection: vi.fn(),
}));

vi.mock('../src/util/telemetry.js', () => ({
  logTelemetry: vi.fn(),
  nowIso: vi.fn(() => '2026-06-10T10:00:00Z'),
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
  getConfig: vi.fn(() => ({ brainPath: '/mock-brain' })),
}));

import { runInjectContext } from '../src/commands/inject-context.js';
import { listAll } from '../src/indexer/fts.js';
import { route } from '../src/retrieval/router.js';
import { stripNoteToPrompt } from '../src/retrieval/strip.js';
import { profileTextForInjection as profileFromStore } from '../src/store/profile.js';
import { alreadyInjected } from '../src/util/session-cache.js';

const mockListAll = vi.mocked(listAll);
const mockRoute = vi.mocked(route);
const mockStripNoteToPrompt = vi.mocked(stripNoteToPrompt);
const mockProfile = vi.mocked(profileFromStore);
const mockAlreadyInjected = vi.mocked(alreadyInjected);

function makeMockNote(overrides?: Partial<IndexedNote>): IndexedNote {
  return {
    id: 'file-gameon-app-details-muscle-map-jsx',
    path: 'notes/2026-06/file-gameon-app-details-muscle-map-jsx.html',
    title: 'GameOn_/app/details/muscle-map.jsx',
    type: 'file-neuron',
    created: '2026-06-08T00:00:00Z',
    tags: 'code javascript GameOn file-neuron',
    importance: 0.56,
    quality: 'refined',
    topic: 'gameon/app/details',
    ...overrides,
  } as IndexedNote;
}

function makeMockStripped(overrides?: Partial<StrippedNote>): StrippedNote {
  return {
    id: 'file-gameon-app-details-muscle-map-jsx',
    text: 'GameOn_/app/details/muscle-map.jsx — 4 functions, MuscleMapPage component',
    type: 'file-neuron',
    created: '2026-06-08',
    tags: ['code', 'javascript', 'GameOn'],
    facts: [],
    links: [],
    ...overrides,
  };
}

describe('turn-inject quality contract', () => {
  beforeEach(() => {
    mockProfile.mockReturnValue('');
    mockAlreadyInjected.mockReturnValue(new Set());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Test 1: matching prompt → useful pointer injected
  it('injects note id and path when retrieval finds a relevant hit', async () => {
    mockListAll.mockReturnValue([makeMockNote()]);
    mockRoute.mockResolvedValue({
      hits: [
        {
          id: 'file-gameon-app-details-muscle-map-jsx',
          path: 'notes/2026-06/file-gameon-app-details-muscle-map-jsx.html',
          score: 0.85,
          level: 'L2',
          note: makeMockStripped(),
        },
      ],
      levelUsed: 'L2',
      totalMs: 30,
    });
    mockStripNoteToPrompt.mockReturnValue(
      'GameOn_/app/details/muscle-map.jsx — MuscleMapPage component with 4 functions',
    );

    const result = await runInjectContext({
      mode: 'turn',
      query: 'comment est fait ma muscle map gameon',
      maxTokens: 500,
      minScore: 0.5,
    });

    // Must contain a note reference (id or path fragment)
    expect(result).not.toBe('');
    expect(result).toMatch(/muscle.?map/i);
    // Must NOT be a bare project-map header with no content
    expect(result).not.toMatch(/^\[gameon\/ map\]\s*$/m);
  });

  // Test 2: gibberish prompt → empty output
  it('returns empty output for a gibberish prompt with no retrieval hits', async () => {
    mockListAll.mockReturnValue([]);
    mockRoute.mockResolvedValue({
      hits: [],
      levelUsed: 'L2',
      totalMs: 10,
    });

    const result = await runInjectContext({
      mode: 'turn',
      query: 'asdflkjqwer zxcvbnm gibberish123',
      maxTokens: 500,
    });

    expect(result).toBe('');
  });

  // Test 3: bare feature-map header is never emitted alone
  it('does NOT emit a bare [proj/ map] header with no useful content', async () => {
    // Simulate a brain with a gameon project that has no real features
    mockListAll.mockReturnValue([
      makeMockNote({ topic: 'gameon', id: 'gameon-root', title: 'GameOn root' }),
    ]);
    mockRoute.mockResolvedValue({
      hits: [],
      levelUsed: 'L2',
      totalMs: 10,
    });

    const result = await runInjectContext({
      mode: 'turn',
      query: 'comment est fait ma muscle map gameon',
      maxTokens: 500,
      minScore: 0.5,
    });

    // Must not emit just a bare project header line
    if (result !== '') {
      // If something was emitted, it must contain actual content beyond a bare header
      const lines = result
        .trim()
        .split('\n')
        .filter((l) => l.trim());
      const hasUsefulContent = lines.some(
        (l) => l.match(/[a-zA-Z0-9]{4,}.*[a-zA-Z0-9]{4,}/) && !l.match(/^\[.*\/ map\]$/),
      );
      expect(hasUsefulContent).toBe(true);
    }
  });

  // Test 4: when hits injected, skill-invocation header is present
  it('prepends skill-invocation header when hits are injected', async () => {
    mockListAll.mockReturnValue([makeMockNote()]);
    mockRoute.mockResolvedValue({
      hits: [
        {
          id: 'file-gameon-app-details-muscle-map-jsx',
          path: 'notes/2026-06/file-gameon-app-details-muscle-map-jsx.html',
          score: 0.9,
          level: 'L2',
          note: makeMockStripped(),
        },
      ],
      levelUsed: 'L2',
      totalMs: 30,
    });
    mockStripNoteToPrompt.mockReturnValue(
      'GameOn_/app/details/muscle-map.jsx — MuscleMapPage component',
    );

    const result = await runInjectContext({
      mode: 'turn',
      query: 'comment est fait ma muscle map gameon',
      maxTokens: 500,
      minScore: 0.5,
    });

    // The skill invocation header must be present when hits exist
    expect(result).toMatch(/\[LAZYBRAIN\]/);
    expect(result).toMatch(/lazybrain-recall/i);
  });

  // Test 5: session-start [RECALL] line instructs skill-first
  it('session-start highlights mode includes skill-first [RECALL] instruction', async () => {
    mockListAll.mockReturnValue([makeMockNote()]);

    const result = await runInjectContext({
      mode: 'highlights',
      cwd: '/some/project',
    });

    expect(result).toMatch(/\[RECALL\]/);
    // Must say INVOKE the skill or use it first (skill-first instruction)
    expect(result).toMatch(/INVOKE|invoke|skill/i);
  });

  // ── nudge parameterization (provider-appropriate recall instruction) ────
  //
  // The IDE's native/managed chat providers have neither a Skill tool nor a
  // `lazybrain` CLI on PATH — only the brain_search tool / BRAIN_SEARCH:
  // directive (see src/lib/brain/brainTool.ts). `nudge: 'tool'` is what the
  // Rust side (search.rs) now passes for both the turn-mode recall call and
  // brain_fetch_startup_context, instead of the phantom skill instruction.

  it('turn mode: nudge "tool" mentions brain_search / BRAIN_SEARCH, never the skill', async () => {
    mockListAll.mockReturnValue([makeMockNote()]);
    mockRoute.mockResolvedValue({
      hits: [
        {
          id: 'file-gameon-app-details-muscle-map-jsx',
          path: 'notes/2026-06/file-gameon-app-details-muscle-map-jsx.html',
          score: 0.9,
          level: 'L2',
          note: makeMockStripped(),
        },
      ],
      levelUsed: 'L2',
      totalMs: 30,
    });
    mockStripNoteToPrompt.mockReturnValue(
      'GameOn_/app/details/muscle-map.jsx — MuscleMapPage component',
    );

    const result = await runInjectContext({
      mode: 'turn',
      query: 'comment est fait ma muscle map gameon',
      maxTokens: 500,
      minScore: 0.5,
      nudge: 'tool',
    });

    expect(result).toMatch(/\[LAZYBRAIN\]/);
    expect(result).toMatch(/brain_search|BRAIN_SEARCH/);
    expect(result).not.toMatch(/lazybrain-recall/i);
    expect(result).not.toMatch(/skill/i);
  });

  it('turn mode: nudge "none" omits any recall-instruction header', async () => {
    mockListAll.mockReturnValue([makeMockNote()]);
    mockRoute.mockResolvedValue({
      hits: [
        {
          id: 'file-gameon-app-details-muscle-map-jsx',
          path: 'notes/2026-06/file-gameon-app-details-muscle-map-jsx.html',
          score: 0.9,
          level: 'L2',
          note: makeMockStripped(),
        },
      ],
      levelUsed: 'L2',
      totalMs: 30,
    });
    mockStripNoteToPrompt.mockReturnValue(
      'GameOn_/app/details/muscle-map.jsx — MuscleMapPage component',
    );

    const result = await runInjectContext({
      mode: 'turn',
      query: 'comment est fait ma muscle map gameon',
      maxTokens: 500,
      minScore: 0.5,
      nudge: 'none',
    });

    expect(result).not.toMatch(/\[LAZYBRAIN\]/);
    expect(result).not.toMatch(/lazybrain-recall|brain_search|BRAIN_SEARCH/i);
    // The actual hit content must still be present — only the header is gone.
    expect(result).toMatch(/muscle.?map/i);
  });

  it('highlights mode: nudge "tool" mentions brain_query_css / brain_query, never brain_search or the skill', async () => {
    // `--mode highlights` is LazyManager's startup context ONLY (see
    // highlightsRecallNudge's doc comment) — unlike turn mode above, its
    // caller has no `brain_search` ChatTool and no `BRAIN_SEARCH:` text
    // directive. Both the `[BRAIN]` marker line (markerNudge) and the
    // `[RECALL]` footer (highlightsRecallNudge) were corrected (2026-08-16)
    // to name the real action vocabulary — brain_query_css / brain_query
    // (managerCorePrompt.ts items 10-11) — instead of a tool this caller
    // does not have.
    mockListAll.mockReturnValue([makeMockNote()]);

    const result = await runInjectContext({
      mode: 'highlights',
      cwd: '/some/project',
      nudge: 'tool',
    });

    expect(result).toMatch(/\[RECALL\]/);
    expect(result).toMatch(/brain_query_css|brain_query/);
    expect(result).not.toMatch(/brain_search/);
    expect(result).not.toMatch(/BRAIN_SEARCH/);
    expect(result).not.toMatch(/lazybrain-recall/i);
    expect(result).not.toMatch(/Skill tool/);
  });

  it('marker mode: nudge "none" produces a bare [BRAIN] line with no action clause', async () => {
    mockListAll.mockReturnValue([makeMockNote()]);

    const result = await runInjectContext({
      mode: 'marker',
      nudge: 'none',
    });

    expect(result).toMatch(/^\[BRAIN\] 1 notes? available\.\s*$/);
  });

  it('defaults to "skill" nudge when opts.nudge is omitted (back-compat for Claude Code hooks)', async () => {
    mockListAll.mockReturnValue([makeMockNote()]);

    const result = await runInjectContext({ mode: 'marker' });

    expect(result).toMatch(/INVOKE the lazybrain-recall skill/);
  });
});
