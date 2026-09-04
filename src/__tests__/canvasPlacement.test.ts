/**
 * Tests for canvasPlacement.ts — pure drop/paste/duplicate/alignment
 * geometry helpers (spec §5 creation + editing, "Snap & guides").
 */

import { describe, it, expect } from 'vitest';
import {
  computeAlignmentGuides,
  distanceToSegment,
  duplicatePosition,
  findChainNearPoint,
  pastePositions,
  toZoneRelative,
  zoneAtPoint,
  zoneGeometriesFromNodes,
  type ZoneGeometry,
} from '../components/agents/canvas/canvasPlacement';
import type { CanvasReactFlowNode } from '../components/agents/canvas/reconciler';

function projectNode(id: string, x: number, y: number, width: number, height: number): CanvasReactFlowNode {
  return {
    id: `project:${id}`,
    type: 'project',
    position: { x, y },
    width,
    height,
    data: { projectId: id } as unknown as CanvasReactFlowNode['data'],
  } as CanvasReactFlowNode;
}

function childNode(id: string, parentId: string, x: number, y: number): CanvasReactFlowNode {
  return {
    id,
    type: 'draft',
    parentId,
    position: { x, y },
    data: {} as unknown as CanvasReactFlowNode['data'],
  } as CanvasReactFlowNode;
}

describe('zoneGeometriesFromNodes / zoneAtPoint', () => {
  const zones: ZoneGeometry[] = zoneGeometriesFromNodes([
    projectNode('p1', 0, 0, 400, 300),
    projectNode('p2', 600, 0, 400, 300),
  ]);

  it('extracts one geometry per project node', () => {
    expect(zones).toHaveLength(2);
    expect(zones[0]).toMatchObject({ projectId: 'p1', position: { x: 0, y: 0 }, size: { width: 400, height: 300 } });
  });

  it('finds the zone containing a point', () => {
    expect(zoneAtPoint(zones, { x: 100, y: 100 })?.projectId).toBe('p1');
    expect(zoneAtPoint(zones, { x: 650, y: 50 })?.projectId).toBe('p2');
  });

  it('returns undefined for a point outside every zone', () => {
    expect(zoneAtPoint(zones, { x: 5000, y: 5000 })).toBeUndefined();
  });
});

describe('toZoneRelative', () => {
  it('subtracts the zone origin', () => {
    const zone: ZoneGeometry = { projectId: 'p1', position: { x: 50, y: 20 }, size: { width: 400, height: 300 } };
    expect(toZoneRelative({ x: 120, y: 80 }, zone)).toEqual({ x: 70, y: 60 });
  });
});

describe('pastePositions', () => {
  it('places the first item exactly at the base position', () => {
    const [first] = pastePositions({ x: 100, y: 100 }, 3);
    expect(first).toEqual({ x: 100, y: 100 });
  });

  it('staggers subsequent items so they never overlap the previous one', () => {
    const positions = pastePositions({ x: 100, y: 100 }, 3);
    expect(positions[1]).not.toEqual(positions[0]);
    expect(positions[2]).not.toEqual(positions[1]);
  });
});

describe('duplicatePosition', () => {
  it('offsets from the original so the copy is not stacked exactly on top', () => {
    const original = { x: 40, y: 40 };
    const dup = duplicatePosition(original);
    expect(dup).not.toEqual(original);
    expect(dup.x).toBeGreaterThan(original.x);
    expect(dup.y).toBeGreaterThan(original.y);
  });
});

describe('computeAlignmentGuides', () => {
  it('returns a vertical guide when the dragged node x aligns with a sibling within threshold', () => {
    const nodes = [projectNode('p1', 0, 0, 400, 300), childNode('draft:a', 'project:p1', 100, 50), childNode('draft:b', 'project:p1', 400, 400)];
    const guides = computeAlignmentGuides({ id: 'draft:b', parentId: 'project:p1', position: { x: 102, y: 400 } }, nodes);
    expect(guides.x).toBe(100);
  });

  it('returns a horizontal guide when the dragged node y aligns with a sibling within threshold', () => {
    const nodes = [projectNode('p1', 0, 0, 400, 300), childNode('draft:a', 'project:p1', 100, 50), childNode('draft:b', 'project:p1', 400, 400)];
    const guides = computeAlignmentGuides({ id: 'draft:b', parentId: 'project:p1', position: { x: 400, y: 54 } }, nodes);
    expect(guides.y).toBe(50);
  });

  it('returns no guides when nothing aligns within threshold', () => {
    const nodes = [projectNode('p1', 0, 0, 400, 300), childNode('draft:a', 'project:p1', 100, 50)];
    const guides = computeAlignmentGuides({ id: 'draft:b', parentId: 'project:p1', position: { x: 400, y: 400 } }, nodes);
    expect(guides).toEqual({ x: undefined, y: undefined });
  });

  it('ignores siblings from a different parent zone', () => {
    const nodes = [
      projectNode('p1', 0, 0, 400, 300),
      projectNode('p2', 600, 0, 400, 300),
      childNode('draft:a', 'project:p2', 100, 50),
    ];
    const guides = computeAlignmentGuides({ id: 'draft:b', parentId: 'project:p1', position: { x: 100, y: 50 } }, nodes);
    expect(guides).toEqual({ x: undefined, y: undefined });
  });
});

describe('distanceToSegment & findChainNearPoint (Smart Edge Splitting)', () => {
  it('detects point close to line segment', () => {
    const p = { x: 50, y: 50 };
    const a = { x: 0, y: 50 };
    const b = { x: 100, y: 50 };
    expect(distanceToSegment(p, a, b)).toBe(0);
  });

  it('finds closest chain within drop threshold', () => {
    const nodes = [
      childNode('draft:a', 'project:p1', 0, 100),
      childNode('draft:b', 'project:p1', 200, 100),
    ];
    const chains = [
      { id: 'c1', sourceRef: 'draft:a', targetRef: 'draft:b', condition: 'success' },
    ];
    const hit = findChainNearPoint({ x: 230, y: 180 }, chains, nodes, 50);
    expect(hit?.id).toBe('c1');
  });

  it('returns null when drop point is too far from any edge', () => {
    const nodes = [
      childNode('draft:a', 'project:p1', 0, 100),
      childNode('draft:b', 'project:p1', 200, 100),
    ];
    const chains = [
      { id: 'c1', sourceRef: 'draft:a', targetRef: 'draft:b', condition: 'success' },
    ];
    const hit = findChainNearPoint({ x: 1000, y: 1000 }, chains, nodes, 50);
    expect(hit).toBeNull();
  });
});
