/**
 * tree.test.ts — /_api/tree tree-building logic (buildTree / isActive).
 *
 * Covers two real bugs found while investigating why a real brain's Wiki
 * tab showed 35 flat code-scan aggregates and ZERO topic projects despite
 * ~220 notes carrying data-cerveau-topic:
 *
 *   1. isActive(): `valid_until` is a review WINDOW (decision notes are
 *      stamped created+90d at write time), not an "already invalidated"
 *      flag. A note is still active while valid_until is unset OR still in
 *      the future — only a valid_until that has already passed means the
 *      note is truly superseded.
 *   2. buildTree(): a pure-knowledge brain (no `graph --cwd` scan, only
 *      notes carrying data-cerveau-topic) must produce a project -> topic ->
 *      note tree, and knowledge-bearing projects must sort ahead of noisy
 *      code-scan-only aggregates so the real content isn't buried.
 */
import { describe, expect, it } from 'vitest';
import { type NoteEntry, type TreeChild, buildTree, isActive } from '../tree.js';

// ---------------------------------------------------------------------------
// Fixture factory — IndexedNote has many required (if nullable) columns;
// centralise sane defaults so each test only overrides what it cares about.
// ---------------------------------------------------------------------------

function makeNote(overrides: Partial<NoteEntry>): NoteEntry {
  return {
    id: 'note-1',
    path: '/brain/notes/note-1.html',
    text: '',
    title: 'Note 1',
    type: 'episodic',
    tags: '',
    source: null,
    created: '2026-07-01T00:00:00.000Z',
    importance: 0.5,
    valid_from: null,
    valid_until: null,
    mtime_ms: 1_000,
    triples: null,
    causes: null,
    replaces: null,
    replaced_by: null,
    supersedes: null,
    entities: null,
    topic: null,
    ...overrides,
  };
}

const NOW = '2026-07-08T00:00:00.000Z';

// ---------------------------------------------------------------------------
// isActive — temporal validity window
// ---------------------------------------------------------------------------

describe('isActive — valid_until is a review window, not an invalidated flag', () => {
  it('is active when valid_until is unset', () => {
    expect(isActive(makeNote({ valid_until: null }), NOW)).toBe(true);
  });

  it('is active when valid_until is an empty string', () => {
    expect(isActive(makeNote({ valid_until: '' }), NOW)).toBe(true);
  });

  it('is active when valid_until is still in the future (e.g. a decision note inside its 90-day window)', () => {
    expect(isActive(makeNote({ valid_until: '2026-09-29T00:00:00.000Z' }), NOW)).toBe(true);
  });

  it('is NOT active once valid_until has already passed', () => {
    expect(isActive(makeNote({ valid_until: '2026-01-01T00:00:00.000Z' }), NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildTree — knowledge (topic) projects
// ---------------------------------------------------------------------------

describe('buildTree — pure knowledge brain (no code scan)', () => {
  it('builds a project -> topic -> note tree from data-cerveau-topic alone', () => {
    const notes: NoteEntry[] = [
      makeNote({ id: 'n1', title: 'Auth note 1', type: 'decision', topic: 'cerveau/auth' }),
      makeNote({ id: 'n2', title: 'Auth note 2', type: 'episodic', topic: 'cerveau/auth' }),
      makeNote({ id: 'n3', title: 'Testing note', type: 'reference', topic: 'cerveau/testing' }),
      makeNote({ id: 'n4', title: 'Root note', type: 'episodic', topic: 'cerveau' }),
      makeNote({ id: 'n5', title: 'Perf note', type: 'decision', topic: 'gameon/performance' }),
    ];

    const { projects } = buildTree(notes, NOW);

    expect(projects.map((p) => p.id).sort()).toEqual(['cerveau', 'gameon']);

    const cerveau = projects.find((p) => p.id === 'cerveau')!;
    expect(cerveau.type).toBe('project');
    const authTopic = cerveau.children.find((c) => c.id === 'cerveau/auth');
    expect(authTopic).toBeDefined();
    expect(authTopic!.type).toBe('topic');
    expect(authTopic!.children.map((c) => c.id).sort()).toEqual(['n1', 'n2']);
    const testingTopic = cerveau.children.find((c) => c.id === 'cerveau/testing');
    expect(testingTopic!.children.map((c) => c.id)).toEqual(['n3']);
    // n4's topic ends exactly at the project's own segment -> direct leaf,
    // not wrapped in another topic branch.
    expect(cerveau.children.some((c) => c.noteId === 'n4' && c.type !== 'topic')).toBe(true);

    const gameon = projects.find((p) => p.id === 'gameon')!;
    const perfTopic = gameon.children.find((c) => c.id === 'gameon/performance');
    expect(perfTopic!.children.map((c) => c.id)).toEqual(['n5']);
  });

  it('excludes notes whose valid_until has already passed, includes ones still in their window', () => {
    const notes: NoteEntry[] = [
      makeNote({
        id: 'still-active',
        topic: 'cerveau/auth',
        valid_until: '2026-09-29T00:00:00.000Z',
      }),
      makeNote({ id: 'expired', topic: 'cerveau/auth', valid_until: '2026-01-01T00:00:00.000Z' }),
    ];

    const { projects } = buildTree(notes, NOW);
    const authTopic = projects
      .find((p) => p.id === 'cerveau')!
      .children.find((c) => c.id === 'cerveau/auth')!;
    expect(authTopic.children.map((c) => c.id)).toEqual(['still-active']);
  });

  it('excludes notes with no topic and generated/aggregate note types', () => {
    const notes: NoteEntry[] = [
      makeNote({ id: 'no-topic', topic: null }),
      makeNote({ id: 'blank-topic', topic: '   ' }),
      makeNote({ id: 'overview', topic: 'cerveau', type: 'topic-overview' }),
      makeNote({ id: 'index', topic: 'cerveau', type: 'brain-index' }),
    ];

    const { projects } = buildTree(notes, NOW);
    expect(projects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildTree — code-scan aggregates + knowledge notes together
// ---------------------------------------------------------------------------

describe('buildTree — code aggregates alongside knowledge notes', () => {
  it('prioritizes knowledge-bearing projects ahead of pure code-scan noise', () => {
    const notes: NoteEntry[] = [
      // Two code-scan-only projects, no topic notes at all — the flat noise
      // seen on the real brain (root aggregate, zero children). Project key
      // is derived from the topic's first segment; node id is the rootAgg
      // note's own id (see buildProjectNode).
      makeNote({ id: 'agg-zzz', type: 'aggregate-neuron', topic: 'aggregate-zzz-project' }),
      makeNote({ id: 'agg-aaa', type: 'aggregate-neuron', topic: 'aggregate-aaa-project' }),
      // One knowledge-only project that alphabetically sorts AFTER both
      // code-scan projects by key — it must still surface first.
      makeNote({ id: 'know-1', type: 'decision', topic: 'zzknowledge/topic' }),
    ];

    const { projects } = buildTree(notes, NOW);
    // Rank (has knowledge content) wins over alphabetical key order: the
    // knowledge project surfaces first even though 'zzknowledge' would sort
    // last purely alphabetically against 'aggregate-*'.
    expect(projects.map((p) => p.id)).toEqual(['zzknowledge', 'agg-aaa', 'agg-zzz']);
    expect(projects[0]!.children.length).toBeGreaterThan(0);
    expect(projects[1]!.children).toEqual([]); // zero-children code-scan noise
    expect(projects[2]!.children).toEqual([]);
  });

  it('merges a project scanned from code with its knowledge notes into one node', () => {
    const notes: NoteEntry[] = [
      makeNote({
        id: 'root-agg',
        type: 'aggregate-neuron',
        topic: 'myproject',
        title: 'myproject',
      }),
      makeNote({ id: 'file-1', type: 'file-neuron', topic: 'myproject', title: 'file-1' }),
      makeNote({ id: 'decision-1', type: 'decision', topic: 'myproject/auth' }),
    ];

    const { projects } = buildTree(notes, NOW);
    expect(projects).toHaveLength(1);
    const project = projects[0]!;
    expect(project.id).toBe('root-agg'); // rootAgg note id, not the label
    expect(project.noteId).toBe('root-agg');
    const ids = project.children.map((c: TreeChild) => c.id);
    expect(ids).toContain('file-1');
    expect(ids).toContain('myproject/auth');
  });
});
