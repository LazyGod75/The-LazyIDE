/**
 * Unit tests for the health-score command.
 *
 * listAll / loadBacklinks / computePageRank are mocked so the scoring math
 * can be exercised deterministically without a real brain. writeHealthMeta's
 * file I/O is exercised for real against a scratch temp directory so the
 * <meta name="cerveau-health"> tag injection/patch logic (and its HTML
 * attribute escaping) is verified against actual file content.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklinksIndex } from '../../graph/backlinks.js';
import type { PageRankResult } from '../../graph/pagerank.js';
import type { IndexedNote } from '../../indexer/fts.js';

vi.mock('../../indexer/fts.js', () => ({
  listAll: vi.fn(),
}));
vi.mock('../../graph/backlinks.js', () => ({
  loadBacklinks: vi.fn(),
}));
vi.mock('../../graph/pagerank.js', () => ({
  computePageRank: vi.fn(),
}));

import { loadBacklinks } from '../../graph/backlinks.js';
import { computePageRank } from '../../graph/pagerank.js';
import { listAll } from '../../indexer/fts.js';
import { computeHealthScore } from '../health-score.js';

const mockListAll = listAll as ReturnType<typeof vi.fn>;
const mockLoadBacklinks = loadBacklinks as ReturnType<typeof vi.fn>;
const mockComputePageRank = computePageRank as ReturnType<typeof vi.fn>;

function makeNote(overrides: Partial<IndexedNote> & { id: string }): IndexedNote {
  return {
    path: `/fake/brain/notes/${overrides.id}.html`,
    text: 'text',
    title: overrides.id,
    type: 'episodic',
    tags: '',
    source: 'test',
    created: new Date().toISOString(),
    importance: null,
    valid_from: null,
    valid_until: null,
    mtime_ms: 0,
    triples: null,
    causes: null,
    replaces: null,
    replaced_by: null,
    supersedes: null,
    entities: null,
    ...overrides,
  };
}

function emptyBacklinks(): BacklinksIndex {
  return { outgoing: {}, incoming: {}, generated: new Date().toISOString(), total_edges: 0 };
}

function emptyPageRank(): PageRankResult {
  return {
    scores: {},
    alpha: 0.85,
    iterations: 0,
    seeded_by: 'global',
    generated: new Date().toISOString(),
  };
}

let brainDir: string;

beforeEach(() => {
  brainDir = mkdtempSync(join(tmpdir(), 'lazybrain-health-score-test-'));
  mockLoadBacklinks.mockReturnValue(emptyBacklinks());
  mockComputePageRank.mockReturnValue(emptyPageRank());
});

afterEach(() => {
  rmSync(brainDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('computeHealthScore — scoring', () => {
  it('returns a perfect score for an empty brain', async () => {
    mockListAll.mockReturnValue([]);
    const result = await computeHealthScore(brainDir);
    expect(result).toEqual({
      score: 100,
      orphans: 0,
      brokenLinks: 0,
      stale: 0,
      dupes: 0,
      totalNotes: 0,
      totalLinks: 0,
    });
  });

  it('counts orphans: notes with no inbound and no outbound edges', async () => {
    mockListAll.mockReturnValue([makeNote({ id: 'a' }), makeNote({ id: 'b' })]);
    mockLoadBacklinks.mockReturnValue(emptyBacklinks());
    const result = await computeHealthScore(brainDir);
    expect(result.orphans).toBe(2);
    expect(result.score).toBeLessThan(100);
  });

  it('does not count a note as orphan when it has an outgoing edge', async () => {
    mockListAll.mockReturnValue([makeNote({ id: 'a' }), makeNote({ id: 'b' })]);
    mockLoadBacklinks.mockReturnValue({
      outgoing: {
        a: [
          {
            from: 'a',
            to: 'b',
            type: 'link',
            auto: false,
            confidence: 'extracted',
            confidenceScore: 1,
          },
        ],
      },
      incoming: {
        b: [
          {
            from: 'a',
            to: 'b',
            type: 'link',
            auto: false,
            confidence: 'extracted',
            confidenceScore: 1,
          },
        ],
      },
      generated: new Date().toISOString(),
      total_edges: 1,
    });
    const result = await computeHealthScore(brainDir);
    expect(result.orphans).toBe(0);
    expect(result.brokenLinks).toBe(0);
  });

  it('counts a broken link when the edge target is not in the corpus', async () => {
    mockListAll.mockReturnValue([makeNote({ id: 'a' })]);
    mockLoadBacklinks.mockReturnValue({
      outgoing: {
        a: [
          {
            from: 'a',
            to: 'ghost-note',
            type: 'link',
            auto: false,
            confidence: 'extracted',
            confidenceScore: 1,
          },
        ],
      },
      incoming: {},
      generated: new Date().toISOString(),
      total_edges: 1,
    });
    const result = await computeHealthScore(brainDir);
    expect(result.brokenLinks).toBe(1);
  });

  it('counts duplicate titles (case-insensitive, >=5 chars)', async () => {
    mockListAll.mockReturnValue([
      makeNote({ id: 'a', title: 'Auth Bug Report' }),
      makeNote({ id: 'b', title: 'auth bug report' }),
      makeNote({ id: 'c', title: 'Unrelated Note Title' }),
    ]);
    const result = await computeHealthScore(brainDir);
    expect(result.dupes).toBe(1);
  });

  it('counts stale notes: old + low pagerank', async () => {
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    mockListAll.mockReturnValue([makeNote({ id: 'a', created: old })]);
    mockComputePageRank.mockReturnValue({
      scores: { a: 0.001 },
      alpha: 0.85,
      iterations: 1,
      seeded_by: 'global',
      generated: new Date().toISOString(),
    });
    const result = await computeHealthScore(brainDir);
    expect(result.stale).toBe(1);
  });

  // Task 3 (Settings > Memory legibility): totalNotes/totalLinks are the
  // denominators the UI needs to render "3047 of 53268 links (5.7%)"
  // instead of a bare, uninterpretable integer.
  it('reports totalNotes and totalLinks (denominators for the proportion UI)', async () => {
    mockListAll.mockReturnValue([
      makeNote({ id: 'a' }),
      makeNote({ id: 'b' }),
      makeNote({ id: 'c' }),
    ]);
    mockLoadBacklinks.mockReturnValue({
      outgoing: {
        a: [
          {
            from: 'a',
            to: 'b',
            type: 'link',
            auto: false,
            confidence: 'extracted',
            confidenceScore: 1,
          },
          {
            from: 'a',
            to: 'ghost',
            type: 'link',
            auto: false,
            confidence: 'extracted',
            confidenceScore: 1,
          },
        ],
      },
      incoming: {
        b: [
          {
            from: 'a',
            to: 'b',
            type: 'link',
            auto: false,
            confidence: 'extracted',
            confidenceScore: 1,
          },
        ],
      },
      generated: new Date().toISOString(),
      total_edges: 2,
    });
    const result = await computeHealthScore(brainDir);
    expect(result.totalNotes).toBe(3);
    expect(result.totalLinks).toBe(2);
    expect(result.brokenLinks).toBe(1);
  });
});

describe('computeHealthScore — writeHealthMeta', () => {
  it('no-ops when _index.html does not exist', async () => {
    mockListAll.mockReturnValue([]);
    await expect(computeHealthScore(brainDir)).resolves.toBeDefined();
    // No _index.html was created by computeHealthScore itself (that is build-index's job).
    expect(() => readFileSync(join(brainDir, '_index.html'), 'utf8')).toThrow();
  });

  it('injects a cerveau-health meta tag before </head> when _index.html exists', async () => {
    writeFileSync(
      join(brainDir, '_index.html'),
      '<!DOCTYPE html><html><head></head><body></body></html>',
      'utf8',
    );
    mockListAll.mockReturnValue([makeNote({ id: 'a' })]);
    const result = await computeHealthScore(brainDir);

    const html = readFileSync(join(brainDir, '_index.html'), 'utf8');
    expect(html).toContain('<meta name="cerveau-health" content="');
    // The embedded JSON must be HTML-attribute-escaped (no raw double quotes).
    const match = html.match(/<meta name="cerveau-health" content="([^"]*)">/);
    expect(match).not.toBeNull();
    const decoded = JSON.parse((match as RegExpMatchArray)[1].replace(/&quot;/g, '"'));
    expect(decoded).toEqual(result);
  });

  it('replaces an existing cerveau-health meta tag on re-run (idempotent)', async () => {
    writeFileSync(
      join(brainDir, '_index.html'),
      '<!DOCTYPE html><html><head><meta name="cerveau-health" content="stale"></head><body></body></html>',
      'utf8',
    );
    mockListAll.mockReturnValue([]);
    await computeHealthScore(brainDir);

    const html = readFileSync(join(brainDir, '_index.html'), 'utf8');
    const occurrences = html.match(/name="cerveau-health"/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(html).not.toContain('content="stale"');
  });
});
