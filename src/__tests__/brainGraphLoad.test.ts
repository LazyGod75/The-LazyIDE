import { describe, it, expect } from 'vitest';
import { emptyAdaptedBrain, deriveClusterFromId, mapSidecarGraphPayload, loadAdaptedBrainGraph } from '../lib/brain/brainGraphLoad';
import type { BrainGraphData } from '../lib/platform/types';

function graph(nodes = 2): BrainGraphData {
  return {
    nodes: Array.from({ length: nodes }, (_, i) => ({
      id: `n${i}`,
      title: `Node ${i}`,
      type: 'concept',
      cluster: 'brain',
      importance: 0.5,
    })),
    edges: nodes > 1 ? [{ source: 'n0', target: 'n1', type: 'related' }] : [],
  };
}

describe('deriveClusterFromId', () => {
  it('maps known prefixes and falls back to unknown', () => {
    expect(deriveClusterFromId('src/lib/brain/foo')).toBe('brain');
    expect(deriveClusterFromId('totally-other')).toBe('unknown');
  });
});

describe('mapSidecarGraphPayload', () => {
  const raw = {
    nodes: [
      { id: 'a', title: 'A', type: null, topic: 'Editor/Auth', importance: 0.8, cluster: 'explicit', created: '2026-01-01' },
      { id: 'b', title: 'B', type: 'decision', topic: null, importance: 0.2 },
    ],
    edges: [{ from: 'a', to: 'b', type: 'relates' }],
  };

  it('prefers the payload cluster field on the web path', () => {
    const mapped = mapSidecarGraphPayload(raw, true);
    expect(mapped.nodes[0].cluster).toBe('explicit');
    expect(mapped.nodes[1].cluster).toBe('unknown');
    expect(mapped.edges[0]).toEqual({ source: 'a', target: 'b', type: 'relates' });
  });

  it('derives cluster from topic/id on the Tauri HTTP fallback path', () => {
    const mapped = mapSidecarGraphPayload(raw, false);
    expect(mapped.nodes[0].cluster).toBe('editor');
  });
});

describe('emptyAdaptedBrain', () => {
  it('is an empty vault, not a mock dataset', () => {
    const empty = emptyAdaptedBrain();
    expect(empty.nodes).toEqual([]);
    expect(empty.links).toEqual([]);
  });
});

describe('loadAdaptedBrainGraph', () => {
  it('uses live /_api/graph on web when the fetch succeeds', async () => {
    const result = await loadAdaptedBrainGraph({
      isTauri: false,
      scope: 'project',
      platform: { brain: { graph: async () => graph(0), graphAll: async () => graph(0) } },
      sidecarTimeoutMs: 50,
      fetchWebGraph: async () => new Response(JSON.stringify({
        nodes: [{ id: 'w', title: 'Web', type: 'concept', topic: 'brain/x', importance: 1 }],
        edges: [],
      }), { status: 200 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('live');
    expect(result.adapted.nodes).toHaveLength(1);
  });

  it('falls back to platform.brain.graph as live when /_api/graph fails', async () => {
    const result = await loadAdaptedBrainGraph({
      isTauri: false,
      scope: 'project',
      platform: { brain: { graph: async () => graph(3), graphAll: async () => graph(0) } },
      sidecarTimeoutMs: 50,
      fetchWebGraph: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('live');
    expect(result.adapted.nodes).toHaveLength(3);
  });

  it('returns failure when web fetch and platform graph both fail', async () => {
    const result = await loadAdaptedBrainGraph({
      isTauri: false,
      scope: 'project',
      platform: {
        brain: {
          graph: async () => { throw new Error('mock down'); },
          graphAll: async () => graph(0),
        },
      },
      sidecarTimeoutMs: 50,
      fetchWebGraph: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(result).toEqual({ ok: false });
  });

  it('uses graphAll on Tauri all-brains scope', async () => {
    const result = await loadAdaptedBrainGraph({
      isTauri: true,
      scope: 'all',
      platform: { brain: { graph: async () => graph(1), graphAll: async () => graph(4) } },
      sidecarTimeoutMs: 200,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('live');
    expect(result.adapted.nodes).toHaveLength(4);
  });

  it('falls through to sidecar HTTP when the Tauri invoke fails (project scope)', async () => {
    const result = await loadAdaptedBrainGraph({
      isTauri: true,
      scope: 'project',
      platform: {
        brain: {
          graph: async () => { throw new Error('sidecar down'); },
          graphAll: async () => { throw new Error('sidecar down'); },
        },
      },
      sidecarTimeoutMs: 200,
      getConnection: async () => ({ port: 45123, token: 'sidecar-secret-xyz' }),
      fetchSidecarGraph: async (port, token) => {
        expect(port).toBe(45123);
        expect(token).toBe('sidecar-secret-xyz');
        return new Response(JSON.stringify({
          nodes: [{ id: 'h', title: 'Http', type: 'concept', topic: 'tauri/x', importance: 1 }],
          edges: [],
        }), { status: 200 });
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.adapted.nodes[0].id).toBe('h');
  });

  it('uses sidecar HTTP without waiting out a hanging Tauri invoke (project scope)', async () => {
    const started = Date.now();
    const result = await loadAdaptedBrainGraph({
      isTauri: true,
      scope: 'project',
      platform: {
        brain: {
          graph: () => new Promise(() => {}),
          graphAll: () => new Promise(() => {}),
        },
      },
      sidecarTimeoutMs: 2000,
      getConnection: async () => ({ port: 37990, token: 'sidecar-secret-xyz' }),
      fetchSidecarGraph: async () => new Response(JSON.stringify({
        nodes: [{ id: 'fast', title: 'Fast', type: 'concept', topic: 'brain/x', importance: 1 }],
        edges: [],
      }), { status: 200 }),
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.adapted.nodes[0].id).toBe('fast');
  });
});
