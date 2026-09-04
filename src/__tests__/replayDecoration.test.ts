/**
 * replayDecoration.test.ts — Agent Canvas W8d: pure fixtures for the
 * replay-view overlay (components/agents/canvas/replay/replayDecoration.ts).
 * No React — builds bare `CanvasReactFlowNode`/`CanvasReactFlowEdge`
 * literals directly, same convention canvasNodes.test.tsx's pure helpers
 * use for reconciler.ts's own node/edge shapes.
 */

import { describe, it, expect } from 'vitest';
import {
  decorateEdgeForReplay,
  decorateEdgesForReplay,
  decorateNodeForReplay,
  decorateNodesForReplay,
} from '../components/agents/canvas/replay/replayDecoration';
import type { FleetStateEntry } from '../components/agents/canvas/replay/replayModel';
import type { CanvasReactFlowEdge, CanvasReactFlowNode } from '../components/agents/canvas/reconciler';
import type { FleetMission } from '../lib/agents/fleetMissions';

function fleetMission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'm-1',
    title: 'Mission A',
    status: 'running',
    stage: 'code',
    model: 'sonnet',
    updatedMs: 1000,
    urgent: false,
    ...overrides,
  };
}

function missionNode(missionId: string, overrides: Partial<CanvasReactFlowNode> = {}): CanvasReactFlowNode {
  return {
    id: `mission:${missionId}`,
    type: 'mission',
    position: { x: 0, y: 0 },
    data: { mission: fleetMission({ id: missionId }), projectId: 'proj-1', isActiveProject: true },
    ...overrides,
  } as CanvasReactFlowNode;
}

function draftNode(draftId: string): CanvasReactFlowNode {
  return {
    id: `draft:${draftId}`,
    type: 'draft',
    position: { x: 0, y: 0 },
    data: { id: draftId, title: 'Draft', task: 'do it', createdBy: 'user' },
  } as CanvasReactFlowNode;
}

function projectNode(projectId: string): CanvasReactFlowNode {
  return {
    id: `project:${projectId}`,
    type: 'project',
    position: { x: 0, y: 0 },
    data: {
      projectId,
      root: '/repo',
      name: 'Repo',
      color: 'hsl(0,0%,0%)',
      collapsed: false,
      isActive: true,
      counts: { running: 0, urgent: 0, review: 0, failed: 0, done: 0, total: 0 },
      hasChildren: true,
    },
  } as CanvasReactFlowNode;
}

function snapshot(overrides: Partial<FleetStateEntry> = {}): FleetStateEntry {
  return {
    missionId: 'm-1',
    title: 'Mission A',
    status: 'review',
    stage: 'review',
    paused: false,
    existsSince: 1000,
    ...overrides,
  };
}

function chainEdge(id: string, overrides: Partial<CanvasReactFlowEdge> = {}): CanvasReactFlowEdge {
  return {
    id,
    type: 'chain',
    source: 'mission:m-1',
    target: 'mission:m-2',
    data: { condition: 'success' },
    ...overrides,
  } as CanvasReactFlowEdge;
}

describe('decorateNodeForReplay — mission/loop nodes', () => {
  it('hides a mission node whose id has no fleetState entry (not yet created at T)', () => {
    const node = missionNode('m-1');
    const decorated = decorateNodeForReplay(node, new Map());
    expect(decorated.className).toContain('canvas-replay-hidden');
    expect(decorated.data).toBe(node.data); // data untouched — hidden is CSS-only
  });

  it('overrides status/stage/paused from the fleet snapshot, leaving every other mission field untouched', () => {
    const node = missionNode('m-1', {
      data: { mission: fleetMission({ id: 'm-1', progress: 42, liveAction: 'writing tests' }), projectId: 'proj-1', isActiveProject: true },
    });
    const fleetState = new Map([['m-1', snapshot({ status: 'review', stage: 'review', paused: true })]]);
    const decorated = decorateNodeForReplay(node, fleetState);
    const data = decorated.data as { mission: FleetMission };
    expect(data.mission.status).toBe('review');
    expect(data.mission.stage).toBe('review');
    expect(data.mission.paused).toBe(true);
    // Live-only fields (never recorded per-instant by the journal) pass through untouched.
    expect(data.mission.progress).toBe(42);
    expect(data.mission.liveAction).toBe('writing tests');
    expect(decorated.className).toBeUndefined();
  });

  it('returns the SAME node reference when the snapshot already matches (referential stability)', () => {
    const node = missionNode('m-1', {
      data: { mission: fleetMission({ id: 'm-1', status: 'running', stage: 'code', paused: false }), projectId: 'proj-1', isActiveProject: true },
    });
    const fleetState = new Map([['m-1', snapshot({ status: 'running', stage: 'code', paused: false })]]);
    expect(decorateNodeForReplay(node, fleetState)).toBe(node);
  });
});

describe('decorateNodeForReplay — non-historical nodes', () => {
  it('dims a draft node unconditionally (drafts are never a historical fact)', () => {
    const decorated = decorateNodeForReplay(draftNode('d-1'), new Map());
    expect(decorated.className).toContain('canvas-replay-dim');
  });

  it('leaves a project zone node completely untouched', () => {
    const node = projectNode('proj-1');
    expect(decorateNodeForReplay(node, new Map())).toBe(node);
  });
});

describe('decorateNodesForReplay — batch', () => {
  it('decorates a mixed fleet: one visible, one hidden, one dimmed, one untouched', () => {
    const fleetState = new Map([['m-1', snapshot({ missionId: 'm-1', status: 'done', stage: 'merged' })]]);
    const nodes = [projectNode('proj-1'), missionNode('m-1'), missionNode('m-2'), draftNode('d-1')];
    const decorated = decorateNodesForReplay(nodes, fleetState);

    expect(decorated[0]).toBe(nodes[0]); // project untouched
    expect((decorated[1].data as { mission: FleetMission }).mission.status).toBe('done'); // m-1 visible+updated
    expect(decorated[2].className).toContain('canvas-replay-hidden'); // m-2 not in fleetState
    expect(decorated[3].className).toContain('canvas-replay-dim'); // draft dimmed
  });
});

describe('decorateEdgeForReplay/decorateEdgesForReplay — chain edges', () => {
  it('sets data.firing=true for a firing chain id and leaves non-chain edges untouched', () => {
    const firing = new Set(['chain-1']);
    const fired = decorateEdgeForReplay(chainEdge('chain-1'), firing);
    expect(fired.data?.firing).toBe(true);

    const notFired = decorateEdgeForReplay(chainEdge('chain-2'), firing);
    expect(notFired.data?.firing).toBeUndefined();

    const hierarchyEdge = { id: 'h-1', type: 'hierarchy', source: 'a', target: 'b', data: {} } as CanvasReactFlowEdge;
    expect(decorateEdgeForReplay(hierarchyEdge, firing)).toBe(hierarchyEdge);
  });

  it('clears a previously-live firing flag when replay is not currently pulsing that chain', () => {
    const liveFiring = chainEdge('chain-1', { data: { condition: 'success', firing: true } });
    const decorated = decorateEdgeForReplay(liveFiring, new Set());
    expect(decorated.data?.firing).toBeUndefined();
  });

  it('decorateEdgesForReplay batches the whole edge list', () => {
    const edges = [chainEdge('chain-1'), chainEdge('chain-2')];
    const decorated = decorateEdgesForReplay(edges, new Set(['chain-2']));
    expect(decorated[0].data?.firing).toBeUndefined();
    expect(decorated[1].data?.firing).toBe(true);
  });
});
