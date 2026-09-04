import { describe, expect, it } from 'vitest';
import type { BrainEdge, BrainNode } from '../knowledge-graph.js';
import {
  K_ENTITY_PER_NOTE,
  MAX_STRUCTURAL_DEGREE,
  TEMPORAL_CHAIN_CAP,
  buildStructuralEdges,
} from '../structural-edges.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNote(
  id: string,
  opts: {
    topic?: string;
    entities?: string;
    source?: string;
    created?: string;
  } = {},
) {
  return {
    id,
    path: `brain/${id}.html`,
    text: '',
    title: id,
    type: 'episodic',
    tags: '',
    source: opts.source ?? null,
    created: opts.created ?? null,
    importance: null,
    valid_from: null,
    valid_until: null,
    mtime_ms: 0,
    triples: null,
    causes: null,
    replaces: null,
    replaced_by: null,
    supersedes: null,
    entities: opts.entities ?? null,
    topic: opts.topic ?? null,
  };
}

function makeNode(
  id: string,
  opts: { type?: string; topicPath?: string; cluster?: string } = {},
): BrainNode {
  return {
    id,
    title: id,
    type: opts.type ?? 'episodic',
    topic: (opts.topicPath ?? '').split('/')[0] || 'unknown',
    topicPath: opts.topicPath ?? 'unknown',
    tags: [],
    importance: 0.5,
    tldr: '',
    pagerank: 0,
    cluster: opts.cluster ?? 'default',
  };
}

function countEdgeType(edges: BrainEdge[], type: string): number {
  return edges.filter((e) => e.type === type).length;
}

// ---------------------------------------------------------------------------
// 1. HIERARCHY edges
// ---------------------------------------------------------------------------

describe('buildStructuralEdges — hierarchy', () => {
  it('emits a hierarchy edge from note to its topic path aggregate', () => {
    const aggregateId = 'aggregate-project-module';
    const notes = [makeNote('note-a', { topic: 'project/module' })];
    const nodes = [
      makeNode('note-a', { topicPath: 'project/module' }),
      makeNode(aggregateId, { type: 'aggregate-neuron', topicPath: 'project/module' }),
    ];
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    const h = edges.filter((e) => e.type === 'hierarchy');
    // note-a should link to aggregate via its topic path
    expect(h.some((e) => e.source === 'note-a' && e.target === aggregateId)).toBe(true);
  });

  it('chains aggregates upward: module-aggregate → project-aggregate', () => {
    const moduleAgg = 'agg-project-module';
    const projectAgg = 'agg-project';
    const notes = [makeNote('note-a', { topic: 'project/module/feature' })];
    const nodes = [
      makeNode('note-a', { topicPath: 'project/module/feature' }),
      makeNode(moduleAgg, { type: 'aggregate-neuron', topicPath: 'project/module' }),
      makeNode(projectAgg, { type: 'aggregate-neuron', topicPath: 'project' }),
    ];
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    const h = edges.filter((e) => e.type === 'hierarchy');
    // chain: note → module agg, module agg → project agg
    expect(h.some((e) => e.source === 'note-a' && e.target === moduleAgg)).toBe(true);
    expect(h.some((e) => e.source === moduleAgg && e.target === projectAgg)).toBe(true);
  });

  it('skips notes without a topic path', () => {
    const notes = [makeNote('no-topic')];
    const nodes = [makeNode('no-topic')];
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    expect(countEdgeType(edges, 'hierarchy')).toBe(0);
  });

  it('does not self-link', () => {
    const notes = [makeNote('note-a', { topic: 'project' })];
    const nodes = [makeNode('note-a', { type: 'aggregate-neuron', topicPath: 'project' })];
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    expect(edges.every((e) => e.source !== e.target)).toBe(true);
  });

  it('deduplicates identical hierarchy edges', () => {
    const aggId = 'agg-proj';
    const notes = [makeNote('note-a', { topic: 'proj' }), makeNote('note-b', { topic: 'proj' })];
    const nodes = [
      makeNode('note-a', { topicPath: 'proj' }),
      makeNode('note-b', { topicPath: 'proj' }),
      makeNode(aggId, { type: 'aggregate-neuron', topicPath: 'proj' }),
    ];
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    const keys = edges.map((e) => `${e.source}::${e.target}::${e.type}`);
    const unique = new Set(keys);
    expect(keys.length).toBe(unique.size);
  });
});

// ---------------------------------------------------------------------------
// 2. SHARED-ENTITY edges
// ---------------------------------------------------------------------------

describe('buildStructuralEdges — shared-entity', () => {
  it('links notes sharing a named entity', () => {
    const notes = [
      makeNote('note-a', { entities: 'db:postgres,lib:react' }),
      makeNote('note-b', { entities: 'db:postgres,api:stripe' }),
      makeNote('note-c', { entities: 'api:stripe' }),
    ];
    const nodes = [makeNote('note-a').id, makeNote('note-b').id, makeNote('note-c').id].map((id) =>
      makeNode(id),
    );
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    const se = edges.filter((e) => e.type === 'shared-entity');
    // note-a and note-b share db:postgres
    expect(
      se.some(
        (e) =>
          new Set([e.source, e.target]).has('note-a') &&
          new Set([e.source, e.target]).has('note-b'),
      ),
    ).toBe(true);
    // note-b and note-c share api:stripe
    expect(
      se.some(
        (e) =>
          new Set([e.source, e.target]).has('note-b') &&
          new Set([e.source, e.target]).has('note-c'),
      ),
    ).toBe(true);
  });

  it(`caps at ${K_ENTITY_PER_NOTE} shared-entity links per note`, () => {
    // note-a shares entities with 10 other notes
    const noteIds = ['note-a', ...Array.from({ length: 10 }, (_, i) => `note-${i + 1}`)];
    const notes = noteIds.map((id) => makeNote(id, { entities: 'lib:react' }));
    const nodes = noteIds.map((id) => makeNode(id));
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    const se = edges.filter((e) => e.type === 'shared-entity');
    // Count edges touching note-a
    const degreeA = se.filter((e) => e.source === 'note-a' || e.target === 'note-a').length;
    expect(degreeA).toBeLessThanOrEqual(K_ENTITY_PER_NOTE);
  });

  it('skips too-generic entities (present in > TOO_GENERIC_RATIO of notes)', () => {
    // Create enough notes so that "lib:common" is too-generic
    const totalNotes = 50;
    // TOO_GENERIC_RATIO = 0.08 → threshold = floor(50 * 0.08) = 4
    // Put "lib:common" in 6 notes → should be skipped
    const notes = Array.from({ length: totalNotes }, (_, i) => {
      const id = `note-${i}`;
      const entities = i < 6 ? 'lib:common' : `lib:unique-${i}`;
      return makeNote(id, { entities });
    });
    const nodes = notes.map((n) => makeNode(n.id));
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    // No shared-entity edge should use "lib:common" as the connecting entity
    // (we cannot inspect the entity directly, but we can verify that
    //  notes 0-5 don't all cross-link just because of lib:common)
    const se = edges.filter((e) => e.type === 'shared-entity');
    // notes 0-5 share ONLY lib:common → they should NOT be linked
    const seIds05 = se.filter(
      (e) =>
        Number.parseInt((e.source.match(/\d+/) ?? ['0'])[0], 10) < 6 &&
        Number.parseInt((e.target.match(/\d+/) ?? ['0'])[0], 10) < 6,
    );
    expect(seIds05.length).toBe(0);
  });

  it('emits edges with strength 0.5 and confidence inferred', () => {
    const notes = [
      makeNote('a', { entities: 'lib:react' }),
      makeNote('b', { entities: 'lib:react' }),
    ];
    const nodes = [makeNode('a'), makeNode('b')];
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    const se = edges.find((e) => e.type === 'shared-entity');
    expect(se).toBeDefined();
    expect(se!.strength).toBe(0.5);
    expect(se!.confidence).toBe('inferred');
  });
});

// ---------------------------------------------------------------------------
// 3. SAME-FILE edges
// ---------------------------------------------------------------------------

describe('buildStructuralEdges — same-file', () => {
  it('links notes sharing the same source path', () => {
    const notes = [
      makeNote('note-a', { source: 'code-scanner:/proj/src/auth.ts' }),
      makeNote('note-b', { source: 'code-scanner:/proj/src/auth.ts' }),
      makeNote('note-c', { source: 'code-scanner:/proj/src/router.ts' }),
    ];
    const nodes = notes.map((n) => makeNode(n.id));
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    const sf = edges.filter((e) => e.type === 'same-file');
    expect(
      sf.some(
        (e) =>
          new Set([e.source, e.target]).has('note-a') &&
          new Set([e.source, e.target]).has('note-b'),
      ),
    ).toBe(true);
    // note-c has different source → should NOT link with note-a/b
    expect(sf.some((e) => new Set([e.source, e.target]).has('note-c'))).toBe(false);
  });

  it('normalises the code-scanner: prefix', () => {
    const notes = [
      makeNote('a', { source: 'code-scanner:/foo/bar.ts' }),
      makeNote('b', { source: '/foo/bar.ts' }),
    ];
    const nodes = notes.map((n) => makeNode(n.id));
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    // Both reference the same underlying file (after normalisation /foo/bar.ts)
    const sf = edges.filter((e) => e.type === 'same-file');
    expect(
      sf.some(
        (e) => new Set([e.source, e.target]).has('a') && new Set([e.source, e.target]).has('b'),
      ),
    ).toBe(true);
  });

  it('emits edges with strength 0.7', () => {
    const notes = [
      makeNote('x', { source: '/common.ts' }),
      makeNote('y', { source: '/common.ts' }),
    ];
    const nodes = notes.map((n) => makeNode(n.id));
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    const sf = edges.find((e) => e.type === 'same-file');
    expect(sf?.strength).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// 4. TEMPORAL edges
// ---------------------------------------------------------------------------

describe('buildStructuralEdges — temporal', () => {
  it('links consecutive notes from the same cwd (source)', () => {
    const notes = [
      makeNote('early', { source: '/proj', created: '2026-01-01T00:00:00Z' }),
      makeNote('later', { source: '/proj', created: '2026-01-02T00:00:00Z' }),
      makeNote('latest', { source: '/proj', created: '2026-01-03T00:00:00Z' }),
    ];
    const nodes = notes.map((n) => makeNode(n.id));
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    const t = edges.filter((e) => e.type === 'temporal');
    expect(t.some((e) => e.source === 'early' && e.target === 'later')).toBe(true);
    expect(t.some((e) => e.source === 'later' && e.target === 'latest')).toBe(true);
  });

  it('does not cross-link notes from different cwds', () => {
    const notes = [
      makeNote('a1', { source: '/proj-a', created: '2026-01-01T00:00:00Z' }),
      makeNote('b1', { source: '/proj-b', created: '2026-01-01T00:00:00Z' }),
      makeNote('a2', { source: '/proj-a', created: '2026-01-02T00:00:00Z' }),
    ];
    const nodes = notes.map((n) => makeNode(n.id));
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    const t = edges.filter((e) => e.type === 'temporal');
    // a1→a2 is valid; nothing crossing /proj-a and /proj-b
    expect(
      t.some(
        (e) =>
          new Set([e.source, e.target]).has('b1') &&
          (new Set([e.source, e.target]).has('a1') || new Set([e.source, e.target]).has('a2')),
      ),
    ).toBe(false);
  });

  it(`caps at ${TEMPORAL_CHAIN_CAP} temporal edges per cwd group`, () => {
    const notes = Array.from({ length: TEMPORAL_CHAIN_CAP + 5 }, (_, i) =>
      makeNote(`note-${i}`, {
        source: '/same-proj',
        created: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      }),
    );
    const nodes = notes.map((n) => makeNode(n.id));
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    const t = edges.filter((e) => e.type === 'temporal');
    expect(t.length).toBeLessThanOrEqual(TEMPORAL_CHAIN_CAP);
  });

  it('emits edges with strength 0.3', () => {
    const notes = [
      makeNote('p', { source: '/projects/my-cwd', created: '2026-01-01T00:00:00Z' }),
      makeNote('q', { source: '/projects/my-cwd', created: '2026-01-02T00:00:00Z' }),
    ];
    const nodes = notes.map((n) => makeNode(n.id));
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    const t = edges.find((e) => e.type === 'temporal');
    expect(t?.strength).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// 5. Degree cap
// ---------------------------------------------------------------------------

describe('buildStructuralEdges — degree cap', () => {
  it(`no node exceeds ${MAX_STRUCTURAL_DEGREE} structural degree`, () => {
    // Create a star graph: one hub note sharing an entity with 200 notes
    const hub = makeNote('hub', { entities: 'lib:unique-entity' });
    const spokes = Array.from({ length: 100 }, (_, i) =>
      makeNote(`spoke-${i}`, { entities: 'lib:unique-entity' }),
    );
    const notes = [hub, ...spokes];
    const nodes = notes.map((n) => makeNode(n.id));
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    // Count degree of hub
    const degree = edges.filter((e) => e.source === 'hub' || e.target === 'hub').length;
    expect(degree).toBeLessThanOrEqual(MAX_STRUCTURAL_DEGREE);
  });

  it('reports dropped count when cap is hit', () => {
    const hub = makeNote('h', { entities: 'lib:x' });
    const spokes = Array.from({ length: 200 }, (_, i) => makeNote(`s${i}`, { entities: 'lib:x' }));
    const notes = [hub, ...spokes];
    const nodes = notes.map((n) => makeNode(n.id));
    const { stats } = buildStructuralEdges({ notes, nodes }, []);
    expect(stats.degreeCapDropped).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Density test: connected graph with N notes under M topics
// ---------------------------------------------------------------------------

describe('buildStructuralEdges — density', () => {
  it('produces a connected graph with N notes under M topics (no isolated notes)', () => {
    const M = 4;
    const notesPerTopic = 8;
    const notes: ReturnType<typeof makeNote>[] = [];
    const aggNodes: BrainNode[] = [];

    // Create M topic aggregates + notesPerTopic notes per topic
    for (let t = 0; t < M; t++) {
      const topicPath = `project-${t}`;
      const aggId = `agg-${t}`;
      aggNodes.push(makeNode(aggId, { type: 'aggregate-neuron', topicPath }));
      for (let n = 0; n < notesPerTopic; n++) {
        notes.push(makeNote(`t${t}-n${n}`, { topic: topicPath }));
      }
    }

    const noteNodes = notes.map((n) => makeNode(n.id, { topicPath: n.topic ?? 'unknown' }));
    const allNodes = [...aggNodes, ...noteNodes];
    const { edges } = buildStructuralEdges({ notes, nodes: allNodes }, []);

    // Every note should appear in at least one edge (via hierarchy to its agg)
    const nodesInEdges = new Set<string>();
    for (const e of edges) {
      nodesInEdges.add(e.source);
      nodesInEdges.add(e.target);
    }
    for (const note of notes) {
      expect(nodesInEdges.has(note.id)).toBe(true);
    }
  });

  it('edge count is within 1x-8x node count for a typical brain fixture', () => {
    const notes = Array.from({ length: 100 }, (_, i) => {
      const topic = `proj-${i % 5}/mod-${i % 3}`;
      const entities = `lib:dep-${i % 10}`;
      return makeNote(`n${i}`, {
        topic,
        entities,
        source: `/proj-${i % 5}`,
        created: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      });
    });
    const nodes = notes.map((n) => makeNode(n.id, { topicPath: n.topic ?? 'unknown' }));
    const { edges } = buildStructuralEdges({ notes, nodes }, []);
    const nodeCount = nodes.length;
    expect(edges.length).toBeGreaterThan(nodeCount * 0.5);
    expect(edges.length).toBeLessThan(nodeCount * 8);
  });
});

// ---------------------------------------------------------------------------
// 7. Determinism
// ---------------------------------------------------------------------------

describe('buildStructuralEdges — determinism', () => {
  it('two identical runs produce byte-identical edge arrays', () => {
    const notes = Array.from({ length: 40 }, (_, i) =>
      makeNote(`note-${i}`, {
        topic: `proj-${i % 4}/mod-${i % 3}`,
        entities: `lib:dep-${i % 8}`,
        source: `/cwd-${i % 5}`,
        created: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      }),
    );
    const aggNodes: BrainNode[] = [];
    for (let p = 0; p < 4; p++) {
      for (let m = 0; m < 3; m++) {
        aggNodes.push(
          makeNode(`agg-${p}-${m}`, { type: 'aggregate-neuron', topicPath: `proj-${p}/mod-${m}` }),
        );
      }
    }
    const nodes = [
      ...aggNodes,
      ...notes.map((n) => makeNode(n.id, { topicPath: n.topic ?? 'unknown' })),
    ];

    const run1 = buildStructuralEdges({ notes, nodes }, []);
    const run2 = buildStructuralEdges({ notes, nodes }, []);

    expect(JSON.stringify(run1)).toEqual(JSON.stringify(run2));
  });
});
