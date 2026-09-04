/**
 * Unit tests for health-detail.ts — the read-only dry-run breakdown behind
 * Settings > Memory's "view details" action (TASK 2: remediation UI).
 *
 * Mirrors health-score.test.ts's mocking strategy so the orphan/broken-link/
 * duplicate DETECTION stays provably identical to the counts health-score.ts
 * already reports (same fixtures, same expected counts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklinksIndex } from '../../graph/backlinks.js';
import type { IndexedNote } from '../../indexer/fts.js';

vi.mock('../../indexer/fts.js', () => ({
  listAll: vi.fn(),
}));
vi.mock('../../graph/backlinks.js', () => ({
  loadBacklinks: vi.fn(),
}));

import { loadBacklinks } from '../../graph/backlinks.js';
import { listAll } from '../../indexer/fts.js';
import { HEALTH_DETAIL_LIMIT, computeHealthDetail } from '../health-detail.js';

const mockListAll = listAll as ReturnType<typeof vi.fn>;
const mockLoadBacklinks = loadBacklinks as ReturnType<typeof vi.fn>;

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

beforeEach(() => {
  mockLoadBacklinks.mockReturnValue(emptyBacklinks());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('computeHealthDetail — orphans', () => {
  it('lists notes with no inbound and no outbound edges, with id + title', () => {
    mockListAll.mockReturnValue([
      makeNote({ id: 'a', title: 'Lonely note A' }),
      makeNote({ id: 'b', title: 'Lonely note B' }),
    ]);
    const result = computeHealthDetail('orphans');
    expect(result.category).toBe('orphans');
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.orphans).toEqual([
      { id: 'a', title: 'Lonely note A' },
      { id: 'b', title: 'Lonely note B' },
    ]);
  });

  it('excludes a note with an outgoing edge', () => {
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
    const result = computeHealthDetail('orphans');
    expect(result.total).toBe(0);
    expect(result.orphans).toEqual([]);
  });

  it('caps the returned list at HEALTH_DETAIL_LIMIT and marks truncated', () => {
    const notes = Array.from({ length: HEALTH_DETAIL_LIMIT + 25 }, (_, i) =>
      makeNote({ id: `n${i}` }),
    );
    mockListAll.mockReturnValue(notes);
    const result = computeHealthDetail('orphans');
    expect(result.total).toBe(HEALTH_DETAIL_LIMIT + 25);
    expect(result.shown).toBe(HEALTH_DETAIL_LIMIT);
    expect(result.orphans).toHaveLength(HEALTH_DETAIL_LIMIT);
    expect(result.truncated).toBe(true);
  });
});

describe('computeHealthDetail — brokenLinks', () => {
  it('lists edges whose target is not in the corpus', () => {
    mockListAll.mockReturnValue([makeNote({ id: 'a', title: 'Source note' })]);
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
    const result = computeHealthDetail('brokenLinks');
    expect(result.total).toBe(1);
    expect(result.brokenLinks).toEqual([
      { fromId: 'a', fromTitle: 'Source note', toId: 'ghost-note' },
    ]);
  });

  it('excludes an edge whose target IS in the corpus', () => {
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
      incoming: {},
      generated: new Date().toISOString(),
      total_edges: 1,
    });
    const result = computeHealthDetail('brokenLinks');
    expect(result.total).toBe(0);
  });
});

describe('computeHealthDetail — duplicates', () => {
  it('groups notes sharing a case-insensitive title (>= 5 chars) and counts extra copies', () => {
    mockListAll.mockReturnValue([
      makeNote({ id: 'a', title: 'Auth Bug Report' }),
      makeNote({ id: 'b', title: 'auth bug report' }),
      makeNote({ id: 'c', title: 'Auth Bug Report' }),
      makeNote({ id: 'd', title: 'Unrelated Note Title' }),
    ]);
    const result = computeHealthDetail('duplicates');
    // 3 copies of the same title -> 2 "extra" copies, matching health-score.ts's dupe count formula.
    expect(result.total).toBe(2);
    expect(result.duplicates).toEqual([{ title: 'Auth Bug Report', noteIds: ['a', 'b', 'c'] }]);
  });

  it('skips titles shorter than 5 characters, matching health-score.ts', () => {
    mockListAll.mockReturnValue([
      makeNote({ id: 'a', title: 'Hi' }),
      makeNote({ id: 'b', title: 'Hi' }),
    ]);
    const result = computeHealthDetail('duplicates');
    expect(result.total).toBe(0);
    expect(result.duplicates).toEqual([]);
  });
});
