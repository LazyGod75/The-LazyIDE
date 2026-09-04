/**
 * canvasLaneModeBoot.test.tsx — W5b deliverable #4: the lane-mode BOOT GAP
 * documented (and fixed) in useCanvasLayout.ts's module header. Reproduces
 * the exact scenario the gap was about: the canvas store is hydrated with
 * `prefs.laneMode` ALREADY true (as if restored from a previous session's
 * persisted layout.json), never through the hook's own `setLaneMode(true)`
 * — so the snapshot must be taken from inside the lane-recompute effect
 * itself, not from `setLaneMode`'s own explicit snapshot line.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { useCanvasLayout } from '../components/agents/canvas/hooks/useCanvasLayout';
import { _resetCanvasStoreForTests, canvasStoreVanilla } from '../components/agents/canvas/canvasStore';
import { DEFAULT_CANVAS_PREFS, makeRef, type CanvasLayoutFileV1 } from '../components/agents/canvas/canvasTypes';
import type { MissionNodeData } from '../components/agents/canvas/canvasTypes';
import type { CanvasReactFlowNode } from '../components/agents/canvas/reconciler';
import type { FleetMission } from '../lib/agents/fleetMissions';

afterEach(cleanup);
beforeEach(() => _resetCanvasStoreForTests());

const PROJECT_REF = makeRef('project', 'p1');
const M1_REF = makeRef('mission', 'm1');
const M2_REF = makeRef('mission', 'm2');

const FREE_POSITIONS = {
  [M1_REF]: { x: 111, y: 222 },
  [M2_REF]: { x: 333, y: 444 },
};

function mission(id: string, stage: FleetMission['stage']): FleetMission {
  return { id, title: id, status: 'running', stage, model: 'sonnet', updatedMs: 1, urgent: false };
}

function missionNode(ref: string, id: string, stage: FleetMission['stage'], position: { x: number; y: number }): CanvasReactFlowNode {
  const data: MissionNodeData = { mission: mission(id, stage), projectId: 'p1', isActiveProject: true };
  return {
    id: ref,
    type: 'mission',
    position,
    parentId: PROJECT_REF,
    extent: 'parent',
    width: 240,
    height: 132,
    data,
  } as unknown as CanvasReactFlowNode;
}

function fixtureNodes(): CanvasReactFlowNode[] {
  return [
    { id: PROJECT_REF, type: 'project', position: { x: 0, y: 0 }, width: 400, height: 300, data: { projectId: 'p1' } } as unknown as CanvasReactFlowNode,
    missionNode(M1_REF, 'm1', 'plan', FREE_POSITIONS[M1_REF]!),
    missionNode(M2_REF, 'm2', 'code', FREE_POSITIONS[M2_REF]!),
  ];
}

function hydrateWithLaneModeOn(): void {
  const layout: CanvasLayoutFileV1 = {
    version: 1,
    positions: { ...FREE_POSITIONS },
    collapsed: {},
    prefs: { ...DEFAULT_CANVAS_PREFS, laneMode: true },
    notes: [],
  };
  canvasStoreVanilla.getState().hydrate(layout, null);
}

describe('useCanvasLayout — lane-mode boot gap (W5b #4)', () => {
  it('snapshots the persisted free positions BEFORE applying lanes when laneMode boots already ON', async () => {
    hydrateWithLaneModeOn();
    expect(canvasStoreVanilla.getState().prefs.laneMode).toBe(true);

    const nodes = fixtureNodes();
    const { result } = renderHook(() => useCanvasLayout({ nodes, edges: [] }));

    // The boot-gap effect fires on mount (laneMode already true) and
    // overwrites positions with lane coordinates.
    await waitFor(() => {
      expect(canvasStoreVanilla.getState().positions[M1_REF]).not.toEqual(FREE_POSITIONS[M1_REF]);
    });

    // Turning lane mode off must restore the ORIGINAL free positions —
    // proving the snapshot was captured from the persisted layout, not
    // lost because prefs.laneMode arrived true via hydrate() rather than
    // through this hook's own setLaneMode(true).
    await act(async () => {
      result.current.setLaneMode(false);
    });

    expect(canvasStoreVanilla.getState().positions[M1_REF]).toEqual(FREE_POSITIONS[M1_REF]);
    expect(canvasStoreVanilla.getState().positions[M2_REF]).toEqual(FREE_POSITIONS[M2_REF]);
    expect(canvasStoreVanilla.getState().prefs.laneMode).toBe(false);
  });

  it('a user-driven setLaneMode(true) still snapshots correctly (no regression from the boot-gap fix)', async () => {
    // Store boots with laneMode OFF this time — the ordinary toggle path.
    const layout: CanvasLayoutFileV1 = {
      version: 1,
      positions: { ...FREE_POSITIONS },
      collapsed: {},
      prefs: { ...DEFAULT_CANVAS_PREFS, laneMode: false },
      notes: [],
    };
    canvasStoreVanilla.getState().hydrate(layout, null);

    const nodes = fixtureNodes();
    const { result } = renderHook(() => useCanvasLayout({ nodes, edges: [] }));

    await act(async () => {
      result.current.setLaneMode(true);
    });
    await waitFor(() => {
      expect(canvasStoreVanilla.getState().positions[M1_REF]).not.toEqual(FREE_POSITIONS[M1_REF]);
    });

    await act(async () => {
      result.current.setLaneMode(false);
    });
    expect(canvasStoreVanilla.getState().positions[M1_REF]).toEqual(FREE_POSITIONS[M1_REF]);
    expect(canvasStoreVanilla.getState().positions[M2_REF]).toEqual(FREE_POSITIONS[M2_REF]);
  });
});
