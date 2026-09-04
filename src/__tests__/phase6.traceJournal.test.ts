/**
 * Phase 6 tests — graph lifecycle bus events, trace journal, runControl.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { on, type BusEvents } from '../lib/bus';
import {
  pauseGraphRun,
  resumeGraphRun,
  cancelGraphRun,
  isRunActive,
  isRunTerminal,
  isRunPaused,
} from '../lib/agents/graph/runControl';
import { defaultGraphDefaults, defaultBrainPolicy, type GraphIR, type GraphRun } from '../lib/agents/graph/types';
import { initGraphRun } from '../lib/agents/graph/graphIr';
import {
  appendTraceEntry,
  buildTraceEntry,
  readTraceEntries,
  parseTraceEntries,
  _clearAllTraceBuffersForTests,
  type TraceEntry,
} from '../lib/agents/graph/traceJournal';

// ── Helpers ────────────────────────────────────────────────────────

function makeIR(): GraphIR {
  const now = Date.now();
  return {
    id: 'test-graph',
    version: 1,
    name: 'Test',
    objective: 'Test objective',
    projectId: 'p1',
    defaults: defaultGraphDefaults(),
    nodes: [
      { id: 'n1', kind: 'task', label: 'Task A', description: 'Do A', brain: defaultBrainPolicy(), contract: { agentName: 'Coder', model: 'claude-sonnet', effort: 'medium' } },
      { id: 'n2', kind: 'task', label: 'Task B', description: 'Do B', brain: defaultBrainPolicy(), contract: { agentName: 'Coder', model: 'claude-sonnet', effort: 'medium' } },
    ],
    edges: [],
    createdAt: now,
    updatedAt: now,
    source: 'plan',
  };
}

function makeRun(): GraphRun {
  const ir = makeIR();
  const run = initGraphRun(ir.id, ir);
  run.status = 'running';
  return run;
}

// ── Bus event tests ────────────────────────────────────────────────

describe('Phase 6 — graph lifecycle bus events', () => {
  // D4 fix (item 2, 2026-08-15 audit): pauseGraphRun/resumeGraphRun/
  // cancelGraphRun are now PURE — they return a NEW GraphRun instead of
  // mutating the one passed in. See runControl.ts's own header comment.
  // These tests were updated to read the RETURN VALUE, not the original
  // reference (which now stays untouched by design).

  it('graph.run_cancelled is emitted on cancelGraphRun', () => {
    const run = makeRun();
    const events: BusEvents['graph.run_cancelled'][] = [];
    const unsub = on('graph.run_cancelled', (p) => events.push(p));

    const cancelled = cancelGraphRun(run);

    expect(events).toHaveLength(1);
    expect(events[0].runId).toBe(run.runId);
    expect(cancelled.status).toBe('cancelled');
    expect(run.status).toBe('running'); // original untouched
    unsub();
  });

  it('graph.interrupt is emitted on pauseGraphRun', () => {
    const run = makeRun();
    const events: BusEvents['graph.interrupt'][] = [];
    const unsub = on('graph.interrupt', (p) => events.push(p));

    const paused = pauseGraphRun(run);

    expect(events).toHaveLength(1);
    expect(events[0].runId).toBe(run.runId);
    expect(events[0].reason).toBe('paused by user');
    expect(paused.status).toBe('paused');
    expect(run.status).toBe('running'); // original untouched
    unsub();
  });

  it('pauseGraphRun is a no-op when not running', () => {
    const run = makeRun();
    run.status = 'done';

    const events: BusEvents['graph.interrupt'][] = [];
    const unsub = on('graph.interrupt', (p) => events.push(p));

    const result = pauseGraphRun(run);

    expect(events).toHaveLength(0);
    expect(result).toBe(run); // same reference — genuinely a no-op
    expect(result.status).toBe('done');
    unsub();
  });

  it('resumeGraphRun transitions paused → running', () => {
    const run = makeRun();
    run.status = 'paused';
    run.nodeRuns['n1'].status = 'blocked';

    const resumed = resumeGraphRun(run);

    expect(resumed.status).toBe('running');
    expect(resumed.nodeRuns['n1'].status).toBe('pending');
    expect(run.nodeRuns['n1'].status).toBe('blocked'); // original untouched
  });

  it('resumeGraphRun transitions interrupted → running', () => {
    const run = makeRun();
    run.status = 'interrupted';

    const resumed = resumeGraphRun(run);

    expect(resumed.status).toBe('running');
  });
});

// ── runControl helper tests ────────────────────────────────────────

describe('Phase 6 — runControl helpers', () => {
  it('isRunActive returns true only for running', () => {
    const run = makeRun();
    expect(isRunActive(run)).toBe(true);
    run.status = 'paused';
    expect(isRunActive(run)).toBe(false);
    run.status = 'done';
    expect(isRunActive(run)).toBe(false);
  });

  it('isRunTerminal returns true for done/failed/cancelled', () => {
    const run = makeRun();
    expect(isRunTerminal(run)).toBe(false);
    run.status = 'done';
    expect(isRunTerminal(run)).toBe(true);
    run.status = 'failed';
    expect(isRunTerminal(run)).toBe(true);
    run.status = 'cancelled';
    expect(isRunTerminal(run)).toBe(true);
  });

  it('isRunPaused returns true for paused and interrupted', () => {
    const run = makeRun();
    expect(isRunPaused(run)).toBe(false);
    run.status = 'paused';
    expect(isRunPaused(run)).toBe(true);
    run.status = 'interrupted';
    expect(isRunPaused(run)).toBe(true);
  });
});

// ── Trace journal tests ────────────────────────────────────────────

describe('Phase 6 — trace journal', () => {
  beforeEach(() => {
    _clearAllTraceBuffersForTests();
  });

  afterEach(() => {
    _clearAllTraceBuffersForTests();
  });

  it('appendTraceEntry stores entry in buffer (non-Tauri)', async () => {
    const entry: TraceEntry = {
      ts: Date.now(),
      runId: 'r1',
      graphId: 'g1',
      nodeId: 'n1',
      nodeKind: 'task',
      nodeLabel: 'Task A',
      status: 'done',
      outcome: 'success',
      attempt: 1,
      missionIds: ['m1'],
    };

    appendTraceEntry('/tmp/test', entry);

    // Give the async inner function a tick to complete
    await new Promise((r) => setTimeout(r, 10));

    const entries = await readTraceEntries('/tmp/test');
    expect(entries).toHaveLength(1);
    expect(entries[0].runId).toBe('r1');
    expect(entries[0].nodeId).toBe('n1');
    expect(entries[0].outcome).toBe('success');
  });

  it('buildTraceEntry constructs entry from run + node + nodeRun', () => {
    const ir = makeIR();
    const run = initGraphRun(ir.id, ir);
    run.sourcePlanId = 'plan-1';

    const node = ir.nodes[0];
    const nr = run.nodeRuns['n1'];
    nr.status = 'done';
    nr.outcome = 'success';
    nr.attempt = 1;
    nr.missionIds = ['m1'];
    nr.startedAt = 1000;
    nr.completedAt = 2000;
    nr.costUsd = 0.05;

    const entry = buildTraceEntry(run, node, nr);

    expect(entry.runId).toBe(run.runId);
    expect(entry.graphId).toBe('test-graph');
    expect(entry.sourcePlanId).toBe('plan-1');
    expect(entry.nodeId).toBe('n1');
    expect(entry.nodeKind).toBe('task');
    expect(entry.nodeLabel).toBe('Task A');
    expect(entry.status).toBe('done');
    expect(entry.outcome).toBe('success');
    expect(entry.attempt).toBe(1);
    expect(entry.missionIds).toEqual(['m1']);
    expect(entry.durationMs).toBe(1000);
    expect(entry.costUsd).toBe(0.05);
    expect(entry.stepContract).toEqual({ agent: 'Coder', model: 'claude-sonnet', effort: 'medium' });
  });

  it('buildTraceEntry infers outcome from status when outcome is undefined', () => {
    const ir = makeIR();
    const run = initGraphRun(ir.id, ir);
    const node = ir.nodes[0];
    const nr = run.nodeRuns['n1'];
    nr.status = 'failed';
    nr.outcome = undefined;

    const entry = buildTraceEntry(run, node, nr);
    expect(entry.outcome).toBe('failure');
  });

  it('parseTraceEntries parses valid JSONL', () => {
    const jsonl = [
      JSON.stringify({ ts: 1, runId: 'r1', graphId: 'g1', nodeId: 'n1', nodeKind: 'task', nodeLabel: 'A', status: 'done', outcome: 'success', attempt: 1, missionIds: [] }),
      JSON.stringify({ ts: 2, runId: 'r1', graphId: 'g1', nodeId: 'n2', nodeKind: 'task', nodeLabel: 'B', status: 'failed', outcome: 'failure', attempt: 1, missionIds: [] }),
    ].join('\n');

    const entries = parseTraceEntries(jsonl);
    expect(entries).toHaveLength(2);
    expect(entries[0].nodeId).toBe('n1');
    expect(entries[1].nodeId).toBe('n2');
  });

  it('parseTraceEntries skips malformed lines', () => {
    const jsonl = [
      JSON.stringify({ ts: 1, runId: 'r1', graphId: 'g1', nodeId: 'n1', nodeKind: 'task', nodeLabel: 'A', status: 'done', outcome: 'success', attempt: 1, missionIds: [] }),
      'this is not json',
      '',
      JSON.stringify({ ts: 2, runId: 'r1', graphId: 'g1', nodeId: 'n2', nodeKind: 'task', nodeLabel: 'B', status: 'done', outcome: 'success', attempt: 1, missionIds: [] }),
    ].join('\n');

    const entries = parseTraceEntries(jsonl);
    expect(entries).toHaveLength(2);
  });

  it('multiple entries accumulate in buffer', async () => {
    const base: TraceEntry = {
      ts: Date.now(),
      runId: 'r1',
      graphId: 'g1',
      nodeId: 'n1',
      nodeKind: 'task',
      nodeLabel: 'A',
      status: 'done',
      outcome: 'success',
      attempt: 1,
      missionIds: [],
    };

    appendTraceEntry('/tmp/multi', base);
    appendTraceEntry('/tmp/multi', { ...base, nodeId: 'n2' });
    appendTraceEntry('/tmp/multi', { ...base, nodeId: 'n3' });

    await new Promise((r) => setTimeout(r, 10));

    const entries = await readTraceEntries('/tmp/multi');
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.nodeId)).toEqual(['n1', 'n2', 'n3']);
  });
});
