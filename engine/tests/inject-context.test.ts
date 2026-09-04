import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexedNote } from '../src/indexer/fts.js';
import type { StrippedNote } from '../src/retrieval/strip.js';

// Mock all external dependencies
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

// inject-context.ts imports profileTextForInjection from store/profile.js directly;
// profile-update.js re-exports it for other callers.  Mock both so either import path is covered.
vi.mock('../src/store/profile.js', () => ({
  profileTextForInjection: vi.fn(),
  profilePath: vi.fn(() => '/mock-brain/_user-profile.html'),
}));
vi.mock('../src/commands/profile-update.js', () => ({
  profileTextForInjection: vi.fn(),
}));

vi.mock('../src/util/telemetry.js', () => ({
  logTelemetry: vi.fn(),
  nowIso: vi.fn(() => '2026-05-24T10:00:00Z'),
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
  })),
}));

import { runInjectContext } from '../src/commands/inject-context.js';

import { profileTextForInjection } from '../src/commands/profile-update.js';
import { loadBacklinks } from '../src/graph/backlinks.js';
import { listAll } from '../src/indexer/fts.js';
import { retentionScore } from '../src/retrieval/decay.js';
import { route } from '../src/retrieval/router.js';
import { stripNote, stripNoteToPrompt } from '../src/retrieval/strip.js';
import { profileTextForInjection as profileTextForInjectionFromStore } from '../src/store/profile.js';
import { readNote } from '../src/store/reader.js';
import { alreadyInjected, recordInjected } from '../src/util/session-cache.js';
import { logTelemetry } from '../src/util/telemetry.js';

const mockListAll = vi.mocked(listAll);
vi.mocked(stripNote);
const mockStripNoteToPrompt = vi.mocked(stripNoteToPrompt);
vi.mocked(readNote);
const mockRoute = vi.mocked(route);
vi.mocked(retentionScore);
vi.mocked(loadBacklinks);
// inject-context.ts imports from store/profile.js; mock that implementation.
const mockProfileTextForInjection = vi.mocked(profileTextForInjectionFromStore);
// Keep the profile-update.js mock wired too so other tests that import from there still work.
vi.mocked(profileTextForInjection);
const mockLogTelemetry = vi.mocked(logTelemetry);
const mockAlreadyInjected = vi.mocked(alreadyInjected);
vi.mocked(recordInjected);

// Helper to create mock notes
function createMockNote(overrides?: Partial<IndexedNote>): IndexedNote {
  return {
    id: '2026-05-24-test-note',
    path: 'notes/test-note.html',
    title: 'Test Note',
    type: 'decision',
    created: '2026-05-24T10:00:00Z',
    tags: 'typescript testing',
    importance: 0.8,
    quality: 'refined',
    ...overrides,
  } as IndexedNote;
}

// Helper to create mock StrippedNote
function createMockStrippedNote(overrides?: Partial<StrippedNote>): StrippedNote {
  return {
    id: 'test-note',
    text: 'This is a test note.',
    type: 'decision',
    created: '2026-05-24',
    tags: ['typescript', 'testing'],
    facts: [{ text: 'Fact 1', confidence: 1 }],
    links: [],
    ...overrides,
  };
}

describe('isTrivialPrompt — tested via runTurnInject', () => {
  beforeEach(() => {
    mockListAll.mockReturnValue([]);
    mockRoute.mockResolvedValue({ hits: [], levelUsed: 'L1', totalMs: 5 });
    mockProfileTextForInjection.mockReturnValue('');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty string for trivial prompts like "ok"', async () => {
    const result = await runInjectContext({ mode: 'turn', query: 'ok' });
    expect(result).toBe('');
    expect(mockLogTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ duration_ms: expect.any(Number) }),
    );
  });

  it('returns empty string for "yes"', async () => {
    const result = await runInjectContext({ mode: 'turn', query: 'yes' });
    expect(result).toBe('');
  });

  it('returns empty string for "continue"', async () => {
    const result = await runInjectContext({ mode: 'turn', query: 'continue' });
    expect(result).toBe('');
  });

  it('returns empty string for "merci"', async () => {
    const result = await runInjectContext({ mode: 'turn', query: 'merci' });
    expect(result).toBe('');
  });

  it('returns empty string for short prompts under 12 chars', async () => {
    const result = await runInjectContext({ mode: 'turn', query: 'short' });
    expect(result).toBe('');
  });

  it('returns empty string for slash commands like /build', async () => {
    const result = await runInjectContext({ mode: 'turn', query: '/build' });
    expect(result).toBe('');
  });

  it('returns empty string for pure code/JSON blocks', async () => {
    const result = await runInjectContext({
      mode: 'turn',
      query: '{ "key": "value" }',
    });
    expect(result).toBe('');
  });

  it('does NOT treat a camelCase identifier as trivial — agents look up symbols by name', async () => {
    mockRoute.mockResolvedValue({
      hits: [
        {
          id: 'file-auth',
          path: 'notes/file-auth.html',
          score: 0.0000012,
          level: 'L2',
          note: createMockStrippedNote(),
        },
      ],
      levelUsed: 'L2_L3_HYBRID',
      totalMs: 5,
    });
    mockStripNoteToPrompt.mockReturnValue('src/auth.ts — rotateRefreshToken');
    mockAlreadyInjected.mockReturnValue(new Set());

    const result = await runInjectContext({ mode: 'turn', query: 'rotateRefreshToken' });
    expect(mockRoute).toHaveBeenCalled();
    expect(result).toContain('rotateRefreshToken');
  });

  it('does NOT treat memory triggers as trivial — "did we decide on X?"', async () => {
    mockRoute.mockResolvedValue({
      hits: [
        {
          id: 'test-1',
          path: 'notes/test-1.html',
          score: 5.0,
          level: 'L1',
          note: createMockStrippedNote(),
        },
      ],
      levelUsed: 'L1',
      totalMs: 5,
    });
    mockStripNoteToPrompt.mockReturnValue('Decided on TypeScript');
    mockAlreadyInjected.mockReturnValue(new Set());

    const result = await runInjectContext({
      mode: 'turn',
      query: 'did we decide on TypeScript?',
    });

    expect(result).not.toBe('');
    expect(mockRoute).toHaveBeenCalled();
  });

  it('does NOT treat #id references as trivial', async () => {
    mockRoute.mockResolvedValue({
      hits: [
        {
          id: 'test-id',
          path: 'notes/test.html',
          score: 5.0,
          level: 'L1',
          note: createMockStrippedNote(),
        },
      ],
      levelUsed: 'L1',
      totalMs: 5,
    });
    mockStripNoteToPrompt.mockReturnValue('Content');
    mockAlreadyInjected.mockReturnValue(new Set());

    await runInjectContext({
      mode: 'turn',
      query: '#some-decision-note-id',
    });

    expect(mockRoute).toHaveBeenCalled();
  });

  it('does NOT treat "remember ..." as trivial', async () => {
    mockRoute.mockResolvedValue({
      hits: [
        {
          id: 'test-1',
          path: 'notes/test-1.html',
          score: 5.0,
          level: 'L1',
          note: createMockStrippedNote(),
        },
      ],
      levelUsed: 'L1',
      totalMs: 5,
    });
    mockStripNoteToPrompt.mockReturnValue('Content');
    mockAlreadyInjected.mockReturnValue(new Set());

    await runInjectContext({
      mode: 'turn',
      query: 'remember what we discussed about caching?',
    });

    expect(mockRoute).toHaveBeenCalled();
  });
});

describe('runMarkerInject — ultra-minimal injection', () => {
  beforeEach(() => {
    mockProfileTextForInjection.mockReturnValue('');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns marker with note count when brain is empty', async () => {
    mockListAll.mockReturnValue([]);

    const result = await runInjectContext({ mode: 'marker' });

    expect(result).toContain('[BRAIN]');
    expect(result).toContain('0 notes');
  });

  it('returns marker with correct note count', async () => {
    mockListAll.mockReturnValue([
      createMockNote({ id: '2026-05-24-note-1' }),
      createMockNote({ id: '2026-05-24-note-2' }),
      createMockNote({ id: '2026-05-24-note-3' }),
    ]);

    const result = await runInjectContext({ mode: 'marker' });

    expect(result).toContain('[BRAIN]');
    expect(result).toContain('3 notes');
  });

  it('excludes user profile notes from count', async () => {
    mockListAll.mockReturnValue([
      createMockNote({ path: 'notes/test.html' }),
      createMockNote({ path: 'profile/_user-profile.html' }),
    ]);

    const result = await runInjectContext({ mode: 'marker' });

    expect(result).toContain('1 notes');
  });

  it('includes lazybrain CLI reference in marker', async () => {
    mockListAll.mockReturnValue([createMockNote()]);

    const result = await runInjectContext({ mode: 'marker' });

    expect(result).toContain('lazybrain-recall');
    expect(result).toContain('lazybrain search');
  });

  it('includes user profile when present', async () => {
    mockProfileTextForInjection.mockReturnValue('User level: Expert');
    mockListAll.mockReturnValue([]);

    const result = await runInjectContext({ mode: 'marker' });

    expect(result).toContain('[USER PROFILE]');
    expect(result).toContain('User level: Expert');
  });
});

describe('estimateTokens — token estimation', () => {
  beforeEach(() => {
    mockListAll.mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('estimates 400 chars as ~100 tokens (0.25 ratio)', async () => {
    mockProfileTextForInjection.mockReturnValue('a'.repeat(400));

    await runInjectContext({ mode: 'marker' });

    expect(mockLogTelemetry).toHaveBeenCalled();

    const callArgs = mockLogTelemetry.mock.calls[0][0];
    expect(callArgs).toHaveProperty('ts');
  });
});

describe('runInjectContext — mode routing', () => {
  beforeEach(() => {
    mockListAll.mockReturnValue([]);
    mockRoute.mockResolvedValue({ hits: [], levelUsed: 'L1', totalMs: 5 });
    mockProfileTextForInjection.mockReturnValue('');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes to runMarkerInject when mode=marker', async () => {
    await runInjectContext({ mode: 'marker' });

    expect(mockListAll).toHaveBeenCalled();
    expect(mockRoute).not.toHaveBeenCalled();
  });

  it('routes to runMarkerInject with highlights when mode=highlights', async () => {
    mockListAll.mockReturnValue([createMockNote()]);

    await runInjectContext({ mode: 'highlights' });

    expect(mockListAll).toHaveBeenCalled();
  });

  it('routes to runTurnInject when mode=turn', async () => {
    await runInjectContext({ mode: 'turn', query: 'what is the architecture?' });

    expect(mockRoute).toHaveBeenCalled();
  });
});

describe('runTurnInject — turn-specific behavior', () => {
  beforeEach(() => {
    mockListAll.mockReturnValue([]);
    mockRoute.mockResolvedValue({
      hits: [
        {
          id: 'test-1',
          path: 'notes/test-1.html',
          score: 5.0,
          level: 'L1',
          note: createMockStrippedNote(),
        },
      ],
      levelUsed: 'L1',
      totalMs: 5,
    });
    mockStripNoteToPrompt.mockReturnValue('Relevant content');
    mockAlreadyInjected.mockReturnValue(new Set());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('respects minScore threshold by level (L1=0.5)', async () => {
    mockRoute.mockResolvedValue({
      hits: [
        {
          id: 'test-1',
          path: 'notes/test-1.html',
          score: 0.3,
          level: 'L1',
          note: createMockStrippedNote(),
        },
      ],
      levelUsed: 'L1',
      totalMs: 5,
    });

    const result = await runInjectContext({
      mode: 'turn',
      query: 'test query',
    });

    expect(result).toBe('');
  });

  it('respects sessionId for differential injection', async () => {
    mockAlreadyInjected.mockReturnValue(new Set(['test-1']));

    const result = await runInjectContext({
      mode: 'turn',
      query: 'test query',
      sessionId: 'session-abc',
    });

    expect(result).toBe('');
  });

  it('respects maxTokens budget', async () => {
    mockRoute.mockResolvedValue({
      hits: [
        {
          id: 'test-1',
          path: 'notes/test-1.html',
          score: 5.0,
          level: 'L1',
          note: createMockStrippedNote(),
        },
        {
          id: 'test-2',
          path: 'notes/test-2.html',
          score: 5.0,
          level: 'L1',
          note: createMockStrippedNote(),
        },
      ],
      levelUsed: 'L1',
      totalMs: 5,
    });
    mockStripNoteToPrompt.mockReturnValue('x'.repeat(500));

    const result = await runInjectContext({
      mode: 'turn',
      query: 'test query',
      maxTokens: 50,
    });

    const sections = result.split('[RECALL]').filter((s) => s.trim()).length;
    expect(sections).toBeLessThanOrEqual(1);
  });
});

describe('edge cases and error handling', () => {
  beforeEach(() => {
    mockListAll.mockReturnValue([]);
    mockRoute.mockResolvedValue({ hits: [], levelUsed: 'L1', totalMs: 5 });
    mockProfileTextForInjection.mockReturnValue('');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('handles empty query gracefully in turn mode', async () => {
    const result = await runInjectContext({ mode: 'turn', query: '' });
    expect(result).toBe('');
  });

  it('logs telemetry on every injection', async () => {
    await runInjectContext({ mode: 'marker' });

    expect(mockLogTelemetry).toHaveBeenCalled();
    const call = mockLogTelemetry.mock.calls[0][0];
    expect(call).toHaveProperty('event', 'inject');
    expect(call).toHaveProperty('ts');
    expect(call).toHaveProperty('tokens');
    expect(call).toHaveProperty('sections');
    expect(call).toHaveProperty('duration_ms');
  });

  it('continues when router is called with valid query', async () => {
    mockRoute.mockResolvedValue({
      hits: [],
      levelUsed: 'L1',
      totalMs: 5,
    });

    const result = await runInjectContext({
      mode: 'turn',
      query: 'what is the architecture?',
    });

    expect(result).toBeDefined();
    expect(mockRoute).toHaveBeenCalled();
  });

  it('handles missing cwd parameter', async () => {
    const result = await runInjectContext({ mode: 'marker' });
    expect(result).toBeDefined();
  });

  it('handles undefined query in turn mode', async () => {
    const result = await runInjectContext({
      mode: 'turn',
      query: undefined,
    });
    expect(result).toBe('');
  });
});

describe('detectQueryIntent — routing and intent classification', () => {
  beforeEach(() => {
    mockListAll.mockReturnValue([]);
    mockRoute.mockResolvedValue({ hits: [], levelUsed: 'L1', totalMs: 5 });
    mockProfileTextForInjection.mockReturnValue('');
    mockAlreadyInjected.mockReturnValue(new Set());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls router for "why" questions', async () => {
    mockRoute.mockResolvedValue({
      hits: [
        {
          id: 'test-1',
          path: 'notes/test-1.html',
          score: 5.0,
          level: 'L1',
          note: createMockStrippedNote(),
        },
      ],
      levelUsed: 'L1',
      totalMs: 5,
    });
    mockStripNoteToPrompt.mockReturnValue('We chose React for performance.');

    await runInjectContext({
      mode: 'turn',
      query: 'why did we pick React?',
    });

    expect(mockRoute).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'why did we pick React?' }),
    );
  });

  it('calls router for "should" questions', async () => {
    mockRoute.mockResolvedValue({
      hits: [
        {
          id: 'test-1',
          path: 'notes/test-1.html',
          score: 5.0,
          level: 'L1',
          note: createMockStrippedNote(),
        },
      ],
      levelUsed: 'L1',
      totalMs: 5,
    });
    mockStripNoteToPrompt.mockReturnValue('Consider these risks...');
    mockAlreadyInjected.mockReturnValue(new Set());

    await runInjectContext({
      mode: 'turn',
      query: 'should we use Redis?',
    });

    expect(mockRoute).toHaveBeenCalled();
  });

  it('calls router for technical queries', async () => {
    mockRoute.mockResolvedValue({
      hits: [
        {
          id: 'test-1',
          path: 'notes/test-1.html',
          score: 5.0,
          level: 'L1',
          note: createMockStrippedNote(),
        },
      ],
      levelUsed: 'L1',
      totalMs: 5,
    });
    mockStripNoteToPrompt.mockReturnValue('OAuth2 PKCE');
    mockAlreadyInjected.mockReturnValue(new Set());

    await runInjectContext({
      mode: 'turn',
      query: 'auth oauth token',
    });

    expect(mockRoute).toHaveBeenCalled();
  });
});

describe('injectContext with profiles and special cases', () => {
  beforeEach(() => {
    mockListAll.mockReturnValue([]);
    mockRoute.mockResolvedValue({ hits: [], levelUsed: 'L1', totalMs: 5 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('includes profile text when provided', async () => {
    mockProfileTextForInjection.mockReturnValue('Expert developer');

    const result = await runInjectContext({ mode: 'marker' });

    expect(result).toContain('Expert developer');
  });

  it('handles highlights mode correctly', async () => {
    mockListAll.mockReturnValue([createMockNote()]);
    mockProfileTextForInjection.mockReturnValue('');

    const result = await runInjectContext({ mode: 'highlights' });

    expect(result).toContain('[BRAIN]');
  });

  it('measures execution time in telemetry', async () => {
    await runInjectContext({ mode: 'marker' });

    expect(mockLogTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        duration_ms: expect.any(Number),
      }),
    );
  });
});
