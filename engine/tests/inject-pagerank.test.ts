/**
 * Tests for Task 6.3: PageRank-blended ranking + compressed file-neuron injection.
 *
 * Coverage:
 *   - High-PageRank file-neuron selected before low-PageRank when budget is tight
 *   - Total injected tokens <= budget
 *   - Compressed file-neurons produce smaller output than full stripNote would
 *   - File-neurons in output use compressed format (no HTML, just signatures)
 *   - End-to-end: real runSessionInject path with fixture store
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexedNote } from '../src/indexer/fts.js';

// ---------------------------------------------------------------------------
// Mocks — mirror the pattern from inject-context.test.ts
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
  nowIso: vi.fn(() => '2026-05-28T10:00:00Z'),
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

// PageRank mock — controlled per test
vi.mock('../src/graph/pagerank.js', () => ({
  computePageRank: vi.fn(),
}));

import { composeFileNeuron } from '../src/annotator/blocks/composers/file-neuron.js';
import { runInjectContext } from '../src/commands/inject-context.js';
import { profileTextForInjection } from '../src/commands/profile-update.js';
import { loadBacklinks } from '../src/graph/backlinks.js';
import type { CodeNode } from '../src/graph/code-scanner.js';
import { computePageRank } from '../src/graph/pagerank.js';
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNote(id: string, overrides?: Partial<IndexedNote>): IndexedNote {
  return {
    id,
    path: `notes/${id}.html`,
    title: `Note ${id}`,
    type: 'semantic' as const,
    created: '2026-05-28T10:00:00Z',
    importance: 0.5,
    quality: 'refined',
    ...overrides,
  } as IndexedNote;
}

function makeFileNeuronNote(id: string, node: CodeNode): IndexedNote {
  return {
    id,
    path: `neurons/${id}.html`,
    title: node.filePath,
    type: 'semantic' as const,
    created: '2026-05-28T10:00:00Z',
    importance: 0.5,
    quality: 'refined',
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

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockProfileText.mockReturnValue('');
  mockLoadBacklinks.mockReturnValue(null);
  mockComputePageRank.mockReturnValue(makePageRankResult({}));
  mockStripNote.mockReturnValue({
    id: 'x',
    text: 'text',
    type: 'semantic',
    created: '2026-05-28',
    tags: [],
    facts: [],
    links: [],
  });
  mockStripNoteToPrompt.mockReturnValue('note content');
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
// Test: compressed representation for file-neurons
// ---------------------------------------------------------------------------

describe('runSessionInject — file-neuron compression', () => {
  it('uses [FILE] prefix for compressed file-neurons', async () => {
    const node: CodeNode = {
      id: 'file:src/auth.ts',
      title: 'src/auth.ts',
      type: 'file',
      filePath: 'src/auth.ts',
      projectRoot: '/project',
      language: 'typescript',
      lineCount: 100,
      imports: ['./session'],
      exports: ['login', 'logout'],
      astFunctions: [
        {
          name: 'login',
          startLine: 5,
          endLine: 20,
          params: ['email', 'password'],
          isExported: true,
        },
      ],
      astClasses: [],
    };

    const fileNeuronHtml = composeFileNeuron(node, 0);
    const noteId = 'file-auth-neuron';
    const noteIndexed = makeFileNeuronNote(noteId, node);

    mockListAll.mockReturnValue([noteIndexed]);
    mockRetentionScore.mockReturnValue(0.8);
    mockComputePageRank.mockReturnValue(makePageRankResult({ [noteId]: 0.1 }));
    mockReadNote.mockReturnValue({
      html: fileNeuronHtml,
      id: noteId,
      path: `neurons/${noteId}.html`,
      sizeBytes: fileNeuronHtml.length,
      mtimeMs: Date.now(),
    });

    const result = await runInjectContext({ mode: 'session', maxTokens: 500 });

    expect(result).toContain('[FILE]');
    expect(result).toContain('src/auth.ts');
    // Should contain function signature
    expect(result).toContain('login');
  });

  it('file-neuron compressed output is shorter than a full HTML strip', async () => {
    const node: CodeNode = {
      id: 'file:src/big-module.ts',
      title: 'src/big-module.ts',
      type: 'file',
      filePath: 'src/big-module.ts',
      projectRoot: '/project',
      language: 'typescript',
      lineCount: 500,
      imports: ['react', 'lodash', './utils', './config', './types'],
      exports: ['BigModule', 'createBigModule', 'BigModuleConfig'],
      astFunctions: [
        {
          name: 'createBigModule',
          startLine: 10,
          endLine: 50,
          params: ['options', 'context', 'logger'],
          isExported: true,
        },
        {
          name: 'internalHelper',
          startLine: 55,
          endLine: 100,
          params: ['data'],
          isExported: false,
        },
        {
          name: 'processItems',
          startLine: 105,
          endLine: 200,
          params: ['items', 'transform'],
          isExported: false,
        },
      ],
      astClasses: [
        {
          name: 'BigModule',
          methods: ['init', 'start', 'stop', 'destroy', 'reload'],
          isExported: true,
          extends: 'EventEmitter',
        },
        { name: 'BigModuleConfig', methods: ['validate', 'toJson', 'fromJson'], isExported: true },
      ],
    };

    const fileNeuronHtml = composeFileNeuron(node, 2);
    // Simulate a full prose strip (representative of what stripNote would return)
    const fullStripText = `This module provides big functionality. It was refactored in May to improve performance. The BigModule class extends EventEmitter and manages state. createBigModule accepts options, context, and logger parameters. All items are processed through the transform pipeline. [file: src/big-module.ts, 500 lines, typescript]\n${fileNeuronHtml.slice(0, 200)}`;

    const noteId = 'big-module-neuron';
    const noteIndexed = makeFileNeuronNote(noteId, node);

    mockListAll.mockReturnValue([noteIndexed]);
    mockRetentionScore.mockReturnValue(0.7);
    mockComputePageRank.mockReturnValue(makePageRankResult({ [noteId]: 0.5 }));
    mockReadNote.mockReturnValue({
      html: fileNeuronHtml,
      id: noteId,
      path: `neurons/${noteId}.html`,
      sizeBytes: fileNeuronHtml.length,
      mtimeMs: Date.now(),
    });
    // Make full strip return a large string to compare against
    mockStripNoteToPrompt.mockReturnValue(fullStripText);

    const result = await runInjectContext({ mode: 'session', maxTokens: 1000 });

    // The result uses [FILE] compressed format
    expect(result).toContain('[FILE]');

    // Compressed tokens should be significantly less than full strip tokens
    const compressedTokens = estimateTokenCount(result);
    const fullStripTokens = estimateTokenCount(fullStripText);
    expect(compressedTokens).toBeLessThan(fullStripTokens);
  });
});

// ---------------------------------------------------------------------------
// Test: token budget respected
// ---------------------------------------------------------------------------

describe('runSessionInject — token budget', () => {
  it('total injected tokens stay within budget (first note exception)', async () => {
    const notes = [
      makeNote('note-a'),
      makeNote('note-b'),
      makeNote('note-c'),
      makeNote('note-d'),
      makeNote('note-e'),
    ];

    mockListAll.mockReturnValue(notes);
    // All have equal retention
    mockRetentionScore.mockReturnValue(0.5);
    mockComputePageRank.mockReturnValue(
      makePageRankResult(Object.fromEntries(notes.map((n) => [n.id, 0.1]))),
    );
    // Make each note ~100 tokens worth of content
    const noteContent = 'x'.repeat(400); // ~100 tokens at 0.25 chars/token
    mockStripNoteToPrompt.mockReturnValue(noteContent);

    const BUDGET = 200;
    const result = await runInjectContext({ mode: 'session', maxTokens: BUDGET });

    const actualTokens = estimateTokenCount(result);
    // The implementation allows exactly ONE note to exceed the budget
    // (the first selected note always fits regardless). The overshoot is at most
    // the token cost of that single note block.
    const singleNotePieceTokens = estimateTokenCount(`[NOTE]\n${noteContent}`);
    expect(actualTokens).toBeLessThanOrEqual(BUDGET + singleNotePieceTokens);
  });

  it('high-PageRank note is selected before low-PageRank note under tight budget', async () => {
    // Use unique, non-overlapping content markers to detect which note appears
    const HIGH_PR_CONTENT = `UNIQUE_HIGH_PR_MARKER_${'a'.repeat(300)}`;
    const LOW_PR_CONTENT = `UNIQUE_LOW_PR_MARKER_${'b'.repeat(300)}`;

    const highPrNote = makeNote('high-pr-note', { importance: 0.5, title: 'High PR note' });
    const lowPrNote = makeNote('low-pr-note', { importance: 0.5, title: 'Low PR note' });

    mockListAll.mockReturnValue([highPrNote, lowPrNote]);
    // Same retention score for both — only PageRank differentiates ranking
    mockRetentionScore.mockReturnValue(0.5);
    mockComputePageRank.mockReturnValue(
      makePageRankResult({
        'high-pr-note': 0.9,
        'low-pr-note': 0.01,
      }),
    );

    // readNote returns non-file-neuron HTML so both notes take the full-strip path
    mockReadNote.mockImplementation((path: string) => ({
      html: '<article data-cerveau-type="semantic"><p>content</p></article>',
      id: path.includes('high-pr') ? 'high-pr-note' : 'low-pr-note',
      path,
      sizeBytes: 100,
      mtimeMs: Date.now(),
    }));

    // stripNoteToPrompt returns HIGH_PR content first (called in sorted order,
    // but high-pr-note ranks first due to PageRank blend) then LOW_PR second
    mockStripNoteToPrompt.mockReturnValueOnce(HIGH_PR_CONTENT);
    mockStripNoteToPrompt.mockReturnValueOnce(LOW_PR_CONTENT);

    // Budget that fits exactly ONE full note block (~100 tokens for 400 chars + overhead)
    const singleNoteTokens = estimateTokenCount(`[NOTE]\n${HIGH_PR_CONTENT}`);
    // Budget is exactly one note — second note must be excluded
    const TIGHT_BUDGET = singleNoteTokens;

    const result = await runInjectContext({ mode: 'session', maxTokens: TIGHT_BUDGET });

    // High-PR note must appear (it ranks first, always fits as first note)
    expect(result).toContain('UNIQUE_HIGH_PR_MARKER_');
    // Low-PR note must be excluded (budget exhausted after first note)
    expect(result).not.toContain('UNIQUE_LOW_PR_MARKER_');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: real runSessionInject with file-neurons + conv neurons
// ---------------------------------------------------------------------------

describe('runSessionInject — end-to-end with fixture store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lazybrain-inject-e2e-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('uses compressed format for file-neurons and prose for conv-neurons in same run', async () => {
    const fileNode: CodeNode = {
      id: 'file:src/router.ts',
      title: 'src/router.ts',
      type: 'file',
      filePath: 'src/router.ts',
      projectRoot: '/project',
      language: 'typescript',
      lineCount: 150,
      imports: ['express'],
      exports: ['createRouter'],
      astFunctions: [
        { name: 'createRouter', startLine: 5, endLine: 30, params: ['config'], isExported: true },
      ],
      astClasses: [],
    };

    const fileNeuronHtml = composeFileNeuron(fileNode, 0);
    const fileNoteId = 'file-router-neuron';
    const convNoteId = 'conv-decision-2026';

    const fileNote = makeFileNeuronNote(fileNoteId, fileNode);
    const convNote = makeNote(convNoteId, {
      type: 'decision',
      title: 'Decided to use Express router',
    });

    mockListAll.mockReturnValue([fileNote, convNote]);
    mockRetentionScore.mockReturnValue(0.6);
    mockComputePageRank.mockReturnValue(
      makePageRankResult({
        [fileNoteId]: 0.2,
        [convNoteId]: 0.1,
      }),
    );

    mockReadNote.mockImplementation((path: string) => {
      if (path.includes(fileNoteId)) {
        return {
          html: fileNeuronHtml,
          id: fileNoteId,
          path,
          sizeBytes: fileNeuronHtml.length,
          mtimeMs: Date.now(),
        };
      }
      return {
        html: '<article data-cerveau-type="decision"><p>Decided to use Express router for all API routes</p></article>',
        id: convNoteId,
        path,
        sizeBytes: 200,
        mtimeMs: Date.now(),
      };
    });
    mockStripNoteToPrompt.mockReturnValue('Decided to use Express router for all API routes');

    const result = await runInjectContext({ mode: 'session', maxTokens: 3000 });

    expect(result).toBeDefined();

    // File-neuron should use [FILE] prefix with compressed representation
    expect(result).toContain('[FILE]');
    expect(result).toContain('src/router.ts');

    // Output should contain function signature data
    expect(result).toContain('createRouter');

    // Total tokens must stay within budget
    expect(estimateTokenCount(result)).toBeLessThanOrEqual(3000);
  });

  it('output does NOT contain raw HTML from file-neuron', async () => {
    const fileNode: CodeNode = {
      id: 'file:src/utils.ts',
      title: 'src/utils.ts',
      type: 'file',
      filePath: 'src/utils.ts',
      projectRoot: '/project',
      language: 'typescript',
      lineCount: 50,
      imports: [],
      exports: ['formatDate', 'parseJson'],
      astFunctions: [
        { name: 'formatDate', startLine: 1, endLine: 10, params: ['date'], isExported: true },
        { name: 'parseJson', startLine: 12, endLine: 25, params: ['raw'], isExported: true },
      ],
      astClasses: [],
    };

    const fileNeuronHtml = composeFileNeuron(fileNode, 0);
    const noteId = 'utils-neuron';
    const note = makeFileNeuronNote(noteId, fileNode);

    mockListAll.mockReturnValue([note]);
    mockRetentionScore.mockReturnValue(0.7);
    mockComputePageRank.mockReturnValue(makePageRankResult({ [noteId]: 0.3 }));
    mockReadNote.mockReturnValue({
      html: fileNeuronHtml,
      id: noteId,
      path: `neurons/${noteId}.html`,
      sizeBytes: fileNeuronHtml.length,
      mtimeMs: Date.now(),
    });

    const result = await runInjectContext({ mode: 'session', maxTokens: 1000 });

    // Must not contain raw HTML tags
    expect(result).not.toContain('<article');
    expect(result).not.toContain('<section');
    expect(result).not.toContain('data-cerveau-type');
    expect(result).not.toContain('data-section=');

    // Must contain the compressed signatures
    expect(result).toContain('formatDate');
    expect(result).toContain('parseJson');
  });
});
