/**
 * Tests for canvasFrameSelection.ts — the pure bbox math behind
 * CanvasContextMenu.tsx's "Encadrer la sélection" (W-CLOSE row 2).
 */

import { describe, it, expect } from 'vitest';
import { computeFrameSelectionBBox, type FrameableNode } from '../components/agents/canvas/canvasFrameSelection';

const resolveProjectId = (parentId: string | undefined) => (parentId === 'project:transverse' ? undefined : parentId?.replace('project:', ''));

describe('computeFrameSelectionBBox', () => {
  it('returns null for an empty selection', () => {
    expect(computeFrameSelectionBBox([], resolveProjectId, 20, 24)).toBeNull();
  });

  it('sizes the bbox to enclose all selected nodes plus padding + title bar reservation', () => {
    const selected: FrameableNode[] = [
      { id: 'a', parentId: 'project:p1', position: { x: 0, y: 0 }, width: 100, height: 60 },
      { id: 'b', parentId: 'project:p1', position: { x: 200, y: 100 }, width: 100, height: 60 },
    ];
    const bbox = computeFrameSelectionBBox(selected, resolveProjectId, 20, 24)!;
    expect(bbox.projectId).toBe('p1');
    // minX=0, minY=0, maxX=300, maxY=160
    expect(bbox.x).toBe(0 - 20);
    expect(bbox.y).toBe(0 - 20 - 24);
    expect(bbox.width).toBe(300 + 20 * 2);
    expect(bbox.height).toBe(160 + 20 * 2 + 24);
  });

  it('resolves Transverse (project:transverse parentId) to an undefined projectId', () => {
    const selected: FrameableNode[] = [{ id: 'a', parentId: 'project:transverse', position: { x: 0, y: 0 }, width: 50, height: 50 }];
    const bbox = computeFrameSelectionBBox(selected, resolveProjectId, 10, 10)!;
    expect(bbox.projectId).toBeUndefined();
  });

  it('uses the FIRST selected node\'s zone as anchor, excluding nodes from a different zone from the bbox', () => {
    const selected: FrameableNode[] = [
      { id: 'a', parentId: 'project:p1', position: { x: 0, y: 0 }, width: 100, height: 60 },
      // a node from a DIFFERENT zone — excluded from the bbox math entirely,
      // never crashes, never silently reframes the wrong zone.
      { id: 'b', parentId: 'project:p2', position: { x: 5000, y: 5000 }, width: 100, height: 60 },
    ];
    const bbox = computeFrameSelectionBBox(selected, resolveProjectId, 0, 0)!;
    expect(bbox.projectId).toBe('p1');
    expect(bbox.width).toBe(100); // only node 'a' counted, not the far-away 'b'
    expect(bbox.height).toBe(60);
  });

  it('handles a single selected node (no parentId — Transverse via absence)', () => {
    const selected: FrameableNode[] = [{ id: 'a', position: { x: 10, y: 10 }, width: 40, height: 30 }];
    const bbox = computeFrameSelectionBBox(selected, resolveProjectId, 5, 5)!;
    expect(bbox.projectId).toBeUndefined();
    expect(bbox.x).toBe(5);
    expect(bbox.y).toBe(0);
    expect(bbox.width).toBe(50);
    expect(bbox.height).toBe(45);
  });
});
