/**
 * replayPerf.test.ts — Agent Canvas W8d: Replay perf at fleet scale. Mirrors
 * canvasPerf.test.ts's own fixture shape (8 projects / 150 missions / 30
 * chains) so this exercises `fleetStateAt`/`decorateNodesForReplay`/
 * `decorateEdgesForReplay` at the SAME "target 150+ nodes fluid" bar (spec
 * §5's Performance section), proving the binary-search design (module
 * headers of replayModel.ts/replayDecoration.ts) actually holds up instead
 * of degrading into a per-frame O(events) scan once the fleet gets big.
 */

import { describe, it, expect } from 'vitest';
import { buildFleetTimeline, fleetStateAt, firesBetween } from '../components/agents/canvas/replay/replayModel';
import { decorateEdgesForReplay, decorateNodesForReplay } from '../components/agents/canvas/replay/replayDecoration';
import type { CanvasReactFlowEdge, CanvasReactFlowNode } from '../components/agents/canvas/reconciler';
import type { FleetMission } from '../lib/agents/fleetMissions';
import type { JournalEventRow, JournalEventType } from '../lib/journal/eventTypes';

const PROJECT_COUNT = 8;
const TOTAL_MISSIONS = 150;
const CHAIN_COUNT = 30;
const WINDOW_START_MS = 0;
const WINDOW_END_MS = 200_000;

function missionEvents(seqStart: number, index: number): JournalEventRow[] {
  const missionId = `mission-${index}`;
  const created = seqStart;
  const base: Omit<JournalEventRow, 'seq' | 'ts_ms' | 'type' | 'payload'> = {
    project_id: `proj-${index % PROJECT_COUNT}`,
    mission_id: missionId,
    agent_id: null,
    run_id: null,
    actor: 'system',
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  };
  const rows: JournalEventRow[] = [
    { ...base, seq: created, ts_ms: 1000 * index, type: 'mission.created', payload: JSON.stringify({ title: `Mission ${index}` }) },
    { ...base, seq: created + 1, ts_ms: 1000 * index + 100, type: 'mission.started', payload: '{}' },
  ];
  // Every 3rd mission also completes — gives fleetStateAt a real mix of
  // still-running vs. terminal missions to binary-search over, same
  // "never a suspiciously uniform fixture" convention canvasPerf.test.ts's
  // own doc comment uses.
  if (index % 3 === 0) {
    rows.push({ ...base, seq: created + 2, ts_ms: 1000 * index + 500, type: 'mission.completed' as JournalEventType, payload: '{}' });
  }
  return rows;
}

function buildEvents(): JournalEventRow[] {
  const events: JournalEventRow[] = [];
  let seq = 0;
  for (let i = 0; i < TOTAL_MISSIONS; i += 1) {
    const rows = missionEvents(seq, i);
    events.push(...rows);
    seq += rows.length;
  }
  for (let i = 0; i < CHAIN_COUNT; i += 1) {
    const source = `mission-${i % TOTAL_MISSIONS}`;
    const target = `mission-${(i + 1) % TOTAL_MISSIONS}`;
    events.push({
      seq: seq + i,
      ts_ms: 1000 * i + 250,
      project_id: `proj-${i % PROJECT_COUNT}`,
      mission_id: source,
      agent_id: null,
      run_id: null,
      actor: 'system',
      type: 'chain.fired',
      payload: JSON.stringify({ chainId: `chain-${i}`, sourceMissionId: source, targetRef: `mission:${target}`, projectId: `proj-${i % PROJECT_COUNT}` }),
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
    });
  }
  return events;
}

function fleetMission(id: string): FleetMission {
  return { id, title: id, status: 'running', stage: 'code', model: 'sonnet', updatedMs: 0, urgent: false };
}

function buildNodes(): CanvasReactFlowNode[] {
  const nodes: CanvasReactFlowNode[] = [];
  for (let i = 0; i < PROJECT_COUNT; i += 1) {
    nodes.push({
      id: `project:proj-${i}`,
      type: 'project',
      position: { x: 0, y: 0 },
      data: {
        projectId: `proj-${i}`,
        root: `/repo-${i}`,
        name: `Repo ${i}`,
        color: 'hsl(0,0%,0%)',
        collapsed: false,
        isActive: false,
        counts: { running: 0, urgent: 0, review: 0, failed: 0, done: 0, total: 0 },
        hasChildren: true,
      },
    } as CanvasReactFlowNode);
  }
  for (let i = 0; i < TOTAL_MISSIONS; i += 1) {
    nodes.push({
      id: `mission:mission-${i}`,
      type: 'mission',
      position: { x: 0, y: 0 },
      data: { mission: fleetMission(`mission-${i}`), projectId: `proj-${i % PROJECT_COUNT}`, isActiveProject: false },
    } as CanvasReactFlowNode);
  }
  return nodes;
}

function buildEdges(): CanvasReactFlowEdge[] {
  const edges: CanvasReactFlowEdge[] = [];
  for (let i = 0; i < CHAIN_COUNT; i += 1) {
    edges.push({
      id: `chain-${i}`,
      type: 'chain',
      source: `mission:mission-${i % TOTAL_MISSIONS}`,
      target: `mission:mission-${(i + 1) % TOTAL_MISSIONS}`,
      data: { condition: 'success' },
    } as CanvasReactFlowEdge);
  }
  return edges;
}

describe('Replay — perf at fleet scale (8 projects / 150 missions / 30 chains)', () => {
  it('builds the timeline and decorates a full 150-node/30-edge graph well under a generous CI-safe bound', () => {
    const events = buildEvents();
    const timeline = buildFleetTimeline(events, WINDOW_START_MS, WINDOW_END_MS);
    const nodes = buildNodes();
    const edges = buildEdges();

    // Warm up once (JIT/module init) before timing — same convention as
    // canvasPerf.test.ts's own perf assertion.
    fleetStateAt(timeline, 100_000);
    decorateNodesForReplay(nodes, fleetStateAt(timeline, 100_000));

    const ITERATIONS = 20;
    const started = performance.now();
    for (let i = 0; i < ITERATIONS; i += 1) {
      const tMs = (i * 7919) % WINDOW_END_MS; // pseudo-scattered scrub positions, not a monotonic sweep
      const fleetState = fleetStateAt(timeline, tMs);
      const firing = new Set(firesBetween(timeline, Math.max(0, tMs - 5000), tMs).map((f) => f.chainId));
      decorateNodesForReplay(nodes, fleetState);
      decorateEdgesForReplay(edges, firing);
    }
    const elapsedMs = performance.now() - started;
    const perCallMs = elapsedMs / ITERATIONS;

    expect(perCallMs).toBeLessThan(20);
  });

  it('produces a fleet snapshot with an honest, bounded mission count (never more than the fixture created)', () => {
    const events = buildEvents();
    const timeline = buildFleetTimeline(events, WINDOW_START_MS, WINDOW_END_MS);
    const fleetState = fleetStateAt(timeline, WINDOW_END_MS);
    expect(fleetState.size).toBeLessThanOrEqual(TOTAL_MISSIONS);
    expect(fleetState.size).toBeGreaterThan(0);
  });
});
