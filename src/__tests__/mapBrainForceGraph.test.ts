import { describe, it, expect } from 'vitest';
import { getMockBrainData } from '../lib/brain/brainAdapter';
import {
  cameraForZoom,
  DEFAULT_BRAIN_ZOOM,
  hubId,
  isHubId,
  LAYOUT_SCALE,
  mapAdaptedToForceGraph,
  VAULT,
  zoomFromCamera,
} from '../components/brain/mapBrainForceGraph';
import { DEFAULT_PALETTE } from '../components/brain/canvas/palettes';

describe('mapAdaptedToForceGraph', () => {
  it('pins every core node at layout-scale and adds one hub per cluster', () => {
    const data = getMockBrainData();
    const mapped = mapAdaptedToForceGraph(data, DEFAULT_PALETTE);
    const cores = mapped.nodes.filter((n) => n.mass === 'core');
    const hubs = mapped.nodes.filter((n) => n.mass === 'hub');
    const clusters = new Set(data.nodes.map((n) => n.cluster));

    expect(cores).toHaveLength(data.nodes.length);
    expect(hubs).toHaveLength(clusters.size);
    for (const n of cores) {
      expect(n.source?.id).toBe(n.id);
      expect(Number.isFinite(n.fx)).toBe(true);
      expect(Math.abs(n.fx)).toBeLessThan(LAYOUT_SCALE * 3);
    }
    for (const h of hubs) {
      expect(isHubId(h.id)).toBe(true);
      expect(h.source).toBeUndefined();
    }
  });

  it('builds synapse links for graph edges and spoke links to hubs', () => {
    const data = getMockBrainData();
    const mapped = mapAdaptedToForceGraph(data, DEFAULT_PALETTE);
    const synapses = mapped.links.filter((l) => l.rel === 'synapse');
    const spokes = mapped.links.filter((l) => l.rel === 'spoke');
    expect(synapses.length).toBe(data.links.length);
    expect(spokes.length).toBe(data.nodes.length);
    expect(spokes.every((l) => isHubId(String(l.target)))).toBe(true);
  });

  it('returns an empty payload for an empty graph (no phantom hub)', () => {
    const data = getMockBrainData();
    const empty = { ...data, nodes: [], links: [] };
    const mapped = mapAdaptedToForceGraph(empty, DEFAULT_PALETTE);
    expect(mapped.nodes).toEqual([]);
    expect(mapped.links).toEqual([]);
  });

  it('hubId is the prefix that isHubId recognises', () => {
    expect(isHubId(hubId('editor'))).toBe(true);
    expect(isHubId('editor')).toBe(false);
  });
});

describe('cameraForZoom', () => {
  it('is the vault at the default zoom and moves closer as zoom increases', () => {
    const atDefault = cameraForZoom(DEFAULT_BRAIN_ZOOM, VAULT);
    expect(atDefault).toEqual(VAULT);
    const closer = cameraForZoom(1, VAULT);
    expect(Math.hypot(closer.x, closer.y, closer.z)).toBeLessThan(
      Math.hypot(VAULT.x, VAULT.y, VAULT.z),
    );
  });

  it('round-trips cameraForZoom through zoomFromCamera', () => {
    const atDefault = cameraForZoom(DEFAULT_BRAIN_ZOOM, VAULT);
    expect(zoomFromCamera(atDefault, VAULT)).toBeCloseTo(DEFAULT_BRAIN_ZOOM, 5);
    const closer = cameraForZoom(1, VAULT);
    expect(zoomFromCamera(closer, VAULT)).toBeCloseTo(1, 5);
  });
});
