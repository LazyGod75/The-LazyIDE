/* brainAdapter.ts — dateIdx wiring (time-travel) and cluster layout slot
   stability. Palette color resolution itself is covered in
   brainPalettes.test.ts.
*/

import { describe, it, expect } from 'vitest';
import {
  clusterLayoutSlot,
  getMockBrainData,
  getRealBrainData,
  buildWikiPayloadFromMeta,
} from '../lib/brain/brainAdapter';
import { TIME_BUCKET_COUNT } from '../components/brain/canvas/dateBucketing';
import type { BrainGraphData, BrainNoteMeta } from '../lib/platform/types';

describe('brainAdapter — getMockBrainData dateIdx', () => {
  it('assigns every mock node a dateIdx within [0, TIME_BUCKET_COUNT)', () => {
    const data = getMockBrainData();
    expect(data.nodes.length).toBeGreaterThan(0);
    for (const node of data.nodes) {
      expect(node.dateIdx).toBeGreaterThanOrEqual(0);
      expect(node.dateIdx).toBeLessThan(TIME_BUCKET_COUNT);
    }
  });

  it('is deterministic across calls (same node id -> same bucket every time)', () => {
    const first = getMockBrainData();
    const second = getMockBrainData();
    const firstById = new Map(first.nodes.map((n) => [n.id, n.dateIdx]));
    for (const node of second.nodes) {
      expect(node.dateIdx).toBe(firstById.get(node.id));
    }
  });
});

describe('brainAdapter — getRealBrainData dateIdx', () => {
  function graph(nodes: BrainGraphData['nodes']): BrainGraphData {
    return { nodes, edges: [] };
  }

  it('assigns every node a dateIdx within [0, TIME_BUCKET_COUNT)', () => {
    const data = getRealBrainData(
      graph([
        { id: 'a', title: 'A', type: 'decision', cluster: 'editor', importance: 0.9 },
        { id: 'b', title: 'B', type: 'bug', cluster: 'agents', importance: 0.2 },
      ]),
    );
    for (const node of data.nodes) {
      expect(node.dateIdx).toBeGreaterThanOrEqual(0);
      expect(node.dateIdx).toBeLessThan(TIME_BUCKET_COUNT);
    }
  });

  it('handles an empty graph without crashing', () => {
    expect(() => getRealBrainData(graph([]))).not.toThrow();
    expect(getRealBrainData(graph([])).nodes).toEqual([]);
  });

  // Regression: a project added via "Add project to brain" can carry its
  // full path root as the cluster id, while other notes for the SAME
  // project carry just its short name — previously these produced two
  // distinct, visually-identical-after-display-formatting cluster entries
  // (duplicate chips in BrainControls' filter list and legend).
  it('merges a path-derived cluster id with its short-name twin into one cluster', () => {
    const data = getRealBrainData(
      graph([
        { id: 'a', title: 'A', type: 'decision', cluster: 'lazy-backoffice', importance: 0.5 },
        {
          id: 'b',
          title: 'B',
          type: 'bug',
          cluster: 'C:\\Users\\user\\Documents\\cerveau\\Lazy\\lazy-backoffice',
          importance: 0.5,
        },
      ]),
    );
    expect(data.nodes.map((n) => n.cluster)).toEqual(['lazy-backoffice', 'lazy-backoffice']);
    expect(Object.keys(data.clusterStats)).toEqual(['lazy-backoffice']);
  });

  it('keeps short semantic cluster ids (editor/agents/…) unchanged', () => {
    const data = getRealBrainData(
      graph([{ id: 'a', title: 'A', type: 'decision', cluster: 'editor', importance: 0.5 }]),
    );
    expect(data.nodes[0].cluster).toBe('editor');
  });
});

describe('brainAdapter — clusterLayoutSlot', () => {
  it('gives every real IDE cluster a distinct, stable slot out of 7', () => {
    const editor = clusterLayoutSlot('editor');
    const agents = clusterLayoutSlot('agents');
    expect(editor.total).toBe(7);
    expect(agents.total).toBe(7);
    expect(editor.index).not.toBe(agents.index);
  });

  it('gives every legacy mock cluster a distinct, stable slot out of 5', () => {
    const auth = clusterLayoutSlot('Auth');
    const infra = clusterLayoutSlot('Infra');
    expect(auth.total).toBe(5);
    expect(infra.total).toBe(5);
    expect(auth.index).not.toBe(infra.index);
  });

  it('is a pure function of the cluster id alone — never depends on which other clusters are loaded', () => {
    expect(clusterLayoutSlot('brain')).toEqual(clusterLayoutSlot('brain'));
  });

  it('gives unrecognized cluster names a stable fallback slot instead of colliding at (0, N)', () => {
    const slot = clusterLayoutSlot('some-future-cluster');
    expect(slot.index).toBeGreaterThanOrEqual(0);
    expect(slot.index).toBeLessThan(slot.total);
    expect(clusterLayoutSlot('some-future-cluster')).toEqual(slot);
  });
});

// ── buildWikiPayloadFromMeta — WIKI METADATA MISMATCH FIX ────────────
//
// Regression coverage for the real bug: a node showed body "type episodic
// dans le cluster brain" while the pill said "concept" (the mapped display
// type) and BrainWiki's cluster box said "models" (the node's real graph
// cluster — a field this function never receives). The body text must
// never assert a type or a "cluster" that can visibly contradict what the
// pill / cluster box render for the same node.
describe('brainAdapter — buildWikiPayloadFromMeta metadata consistency', () => {
  function meta(overrides: Partial<BrainNoteMeta> = {}): BrainNoteMeta {
    return {
      id: 'n1',
      title: 'Some note',
      type: 'episodic',
      topic: 'brain',
      tags: '',
      importance: 0.5,
      created: null,
      ...overrides,
    };
  }

  it('body text uses the SAME mapped type as the `type` field (never the raw, unmapped type)', () => {
    const payload = buildWikiPayloadFromMeta(meta({ type: 'episodic' }));
    // 'episodic' is not a valid NodeType, so mapNodeType falls back to 'concept'.
    expect(payload.type).toBe('concept');
    expect(payload.body).toContain('concept');
    expect(payload.body).not.toContain('episodic');
  });

  it('body text labels meta.topic as "topic", never as "cluster" (a different, node-graph-derived field it does not have)', () => {
    const payload = buildWikiPayloadFromMeta(meta({ topic: 'brain' }));
    expect(payload.body).toContain('topic brain');
    expect(payload.body).not.toContain('cluster');
  });

  it('omits the topic clause entirely when meta.topic is null, instead of fabricating one', () => {
    const payload = buildWikiPayloadFromMeta(meta({ topic: null }));
    expect(payload.body).toBe('Neurone de type concept.');
  });

  it('a recognized type (e.g. "decision") passes through unchanged in both the pill and the body', () => {
    const payload = buildWikiPayloadFromMeta(meta({ type: 'decision', topic: 'editor' }));
    expect(payload.type).toBe('decision');
    expect(payload.body).toBe('Neurone de type decision · topic editor.');
  });

  it('surfaces the creation day as `when` for NoteMeta', () => {
    const payload = buildWikiPayloadFromMeta(meta({ created: '2026-03-14T09:00:00Z' }));
    expect(payload.when).toBe('2026-03-14');
  });

  it('omits `when` when created is null', () => {
    expect(buildWikiPayloadFromMeta(meta({ created: null })).when).toBeUndefined();
  });
});
