/**
 * replayModel.test.ts — Agent Canvas W8d: pure fixtures for the fleet
 * Replay read-model (components/agents/canvas/replay/replayModel.ts). No
 * React, no journalQuery mock — every case builds synthetic
 * `JournalEventRow[]` rows directly, exactly like missionHistory.test.ts's
 * own convention for the module this one reuses derivations from.
 */

import { describe, it, expect } from 'vitest';
import {
  buildFleetTimeline,
  computeWindowStartMs,
  densityBuckets,
  firesBetween,
  fleetStateAt,
  lastKeyframeAtOrBefore,
} from '../components/agents/canvas/replay/replayModel';
import type { JournalEventRow, JournalEventType } from '../lib/journal/eventTypes';

// ── Fixtures ──────────────────────────────────────────────────────────

let seqCounter = 0;

function row(
  tsMs: number,
  type: JournalEventType,
  overrides: Partial<JournalEventRow> = {},
): JournalEventRow {
  seqCounter += 1;
  return {
    seq: seqCounter,
    ts_ms: tsMs,
    project_id: 'proj-1',
    mission_id: null,
    agent_id: null,
    run_id: null,
    actor: 'system',
    type,
    payload: '{}',
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    ...overrides,
  };
}

function missionRow(missionId: string, tsMs: number, type: JournalEventType, payload: Record<string, unknown> = {}): JournalEventRow {
  return row(tsMs, type, { mission_id: missionId, payload: JSON.stringify(payload) });
}

function chainFiredRow(tsMs: number, chainId: string, sourceMissionId: string, targetRef: string): JournalEventRow {
  return row(tsMs, 'chain.fired', {
    mission_id: sourceMissionId,
    payload: JSON.stringify({ chainId, sourceMissionId, targetRef, projectId: 'proj-1' }),
  });
}

/** Full "one mission's real lifecycle" fixture: created(1000) -> started(2000)
 *  -> gate.passed(3000) -> review_requested(4000) -> completed(5000). */
function fullLifecycleEvents(missionId = 'm-1'): JournalEventRow[] {
  return [
    missionRow(missionId, 1000, 'mission.created', { title: 'Mission A' }),
    missionRow(missionId, 2000, 'mission.started', { model: 'sonnet' }),
    missionRow(missionId, 3000, 'gate.passed', { role: 'tester', score: 90 }),
    missionRow(missionId, 4000, 'mission.review_requested', { proofCount: 1 }),
    missionRow(missionId, 5000, 'mission.completed', { durationMs: 4000 }),
  ];
}

describe('computeWindowStartMs', () => {
  it('"24h" subtracts exactly one day', () => {
    const now = Date.UTC(2026, 6, 15, 10, 30, 0);
    expect(computeWindowStartMs('24h', now)).toBe(now - 24 * 60 * 60 * 1000);
  });

  it('"7d" subtracts exactly seven days', () => {
    const now = Date.UTC(2026, 6, 15, 10, 30, 0);
    expect(computeWindowStartMs('7d', now)).toBe(now - 7 * 24 * 60 * 60 * 1000);
  });

  it('"today" resolves to local midnight of `now`', () => {
    const now = new Date(2026, 6, 15, 14, 45, 30).getTime();
    const midnight = new Date(2026, 6, 15, 0, 0, 0, 0).getTime();
    expect(computeWindowStartMs('today', now)).toBe(midnight);
  });
});

describe('buildFleetTimeline + fleetStateAt — status/stage keyframe timeline', () => {
  it('reflects each real lifecycle boundary honestly, never interpolating between them', () => {
    const events = fullLifecycleEvents();
    const timeline = buildFleetTimeline(events, 0, 10_000);

    // Before creation: absent entirely (hidden-before-created).
    expect(fleetStateAt(timeline, 500).has('m-1')).toBe(false);

    // At creation: queued/plan.
    const atCreation = fleetStateAt(timeline, 1000).get('m-1');
    expect(atCreation).toMatchObject({ status: 'queued', stage: 'plan' });

    // After started, before any gate event: running/code.
    const afterStart = fleetStateAt(timeline, 2500).get('m-1');
    expect(afterStart).toMatchObject({ status: 'running', stage: 'code' });

    // After the gate event fires: stage advances to 'test' even though
    // status is still 'running' (no review_requested/terminal event yet) —
    // status and stage are independently derived axes, never coupled.
    const afterGate = fleetStateAt(timeline, 3500).get('m-1');
    expect(afterGate).toMatchObject({ status: 'running', stage: 'test' });

    // After review_requested: status flips to 'review', stage to 'review'.
    const afterReview = fleetStateAt(timeline, 4500).get('m-1');
    expect(afterReview).toMatchObject({ status: 'review', stage: 'review' });

    // After completion: done/merged, and it STAYS done/merged for any later T.
    const afterDone = fleetStateAt(timeline, 5000).get('m-1');
    expect(afterDone).toMatchObject({ status: 'done', stage: 'merged' });
    const wellAfterDone = fleetStateAt(timeline, 9999).get('m-1');
    expect(wellAfterDone).toMatchObject({ status: 'done', stage: 'merged' });
  });

  it('never appears for a mission with zero events inside the window', () => {
    const events = fullLifecycleEvents(); // entirely at ts 1000..5000
    const timeline = buildFleetTimeline(events, 6000, 10_000); // window starts AFTER every event
    expect(timeline.tracks.size).toBe(0);
    expect(fleetStateAt(timeline, 8000).size).toBe(0);
  });

  it('a second mission created later stays hidden until its own creation instant', () => {
    const events = [...fullLifecycleEvents('m-1'), missionRow('m-2', 6000, 'mission.created', { title: 'Mission B' })];
    const timeline = buildFleetTimeline(events, 0, 10_000);

    expect(fleetStateAt(timeline, 5500).has('m-2')).toBe(false);
    expect(fleetStateAt(timeline, 5500).has('m-1')).toBe(true);
    const state = fleetStateAt(timeline, 6000).get('m-2');
    expect(state).toMatchObject({ status: 'queued', stage: 'plan', existsSince: 6000 });
  });

  it('maps mission.rejected to a "review" status (never a dead-end failure)', () => {
    const events = [
      missionRow('m-1', 1000, 'mission.created', { title: 'A' }),
      missionRow('m-1', 2000, 'mission.started', {}),
      missionRow('m-1', 3000, 'mission.review_requested', { proofCount: 1 }),
      missionRow('m-1', 4000, 'mission.rejected', { reason: 'needs work' }),
    ];
    const timeline = buildFleetTimeline(events, 0, 10_000);
    expect(fleetStateAt(timeline, 4000).get('m-1')).toMatchObject({ status: 'review' });
  });

  it('tracks paused/resumed as an independent boolean overlay', () => {
    const events = [
      missionRow('m-1', 1000, 'mission.created', { title: 'A' }),
      missionRow('m-1', 2000, 'mission.started', {}),
      missionRow('m-1', 2500, 'mission.paused', { reason: 'human takeover' }),
      missionRow('m-1', 2800, 'mission.resumed', {}),
    ];
    const timeline = buildFleetTimeline(events, 0, 10_000);
    expect(fleetStateAt(timeline, 2000).get('m-1')?.paused).toBe(false);
    expect(fleetStateAt(timeline, 2600).get('m-1')?.paused).toBe(true);
    expect(fleetStateAt(timeline, 2900).get('m-1')?.paused).toBe(false);
  });

  it('the title is honestly null when mission.created never appears in the window', () => {
    const events = [
      missionRow('m-1', 5000, 'mission.created', { title: 'Late window' }),
      missionRow('m-1', 6000, 'mission.started', {}),
    ];
    // Window starts AFTER mission.created (e.g. a mission that already
    // existed before "today" but is still running) — the windowing
    // boundary effect documented in replayModel.ts's header.
    const timeline = buildFleetTimeline(events, 5500, 10_000);
    const track = timeline.tracks.get('m-1');
    expect(track?.title).toBeNull();
    expect(track?.createdAtMs).toBe(6000); // earliest IN-WINDOW event, not the real creation ts
  });
});

describe('firesBetween', () => {
  it('returns real chain.fired entries strictly after t0 and at-or-before t1', () => {
    const events = [
      missionRow('m-1', 1000, 'mission.created', { title: 'A' }),
      chainFiredRow(2000, 'chain-1', 'm-1', 'mission:m-2'),
      chainFiredRow(4000, 'chain-2', 'm-1', 'mission:m-3'),
      chainFiredRow(6000, 'chain-3', 'm-1', 'mission:m-4'),
    ];
    const timeline = buildFleetTimeline(events, 0, 10_000);

    expect(firesBetween(timeline, 0, 1999).map((f) => f.chainId)).toEqual([]);
    expect(firesBetween(timeline, 0, 2000).map((f) => f.chainId)).toEqual(['chain-1']);
    expect(firesBetween(timeline, 2000, 6000).map((f) => f.chainId)).toEqual(['chain-2', 'chain-3']); // t0 exclusive
    expect(firesBetween(timeline, 2000, 2000).map((f) => f.chainId)).toEqual([]); // no movement, no re-fire
  });

  it('returns [] for an inverted (backward) range instead of replaying old fires', () => {
    const events = [chainFiredRow(2000, 'chain-1', 'm-1', 'mission:m-2')];
    const timeline = buildFleetTimeline(events, 0, 10_000);
    expect(firesBetween(timeline, 5000, 1000)).toEqual([]);
  });

  it('ignores pending_cross_project/resumed kinds — only a real local launch pulses', () => {
    const events = [
      row(2000, 'chain.pending_cross_project', {
        mission_id: 'm-1',
        payload: JSON.stringify({ chainId: 'chain-x', sourceMissionId: 'm-1', targetRef: 'draft:d1', projectId: 'proj-2' }),
      }),
    ];
    const timeline = buildFleetTimeline(events, 0, 10_000);
    expect(firesBetween(timeline, 0, 10_000)).toEqual([]);
    // ...but it's still preserved in the raw chainFires audit trail.
    expect(timeline.chainFires).toHaveLength(1);
  });
});

describe('lastKeyframeAtOrBefore + densityBuckets', () => {
  it('returns the most recent keyframe at or before T, undefined before the first one', () => {
    const events = fullLifecycleEvents();
    const timeline = buildFleetTimeline(events, 0, 10_000);

    expect(lastKeyframeAtOrBefore(timeline, 500)).toBeUndefined();
    // At exactly ts=1000, BOTH the 'created' keyframe and the 'plan' stage
    // keyframe land on the same instant (a mission's plan span starts at
    // mission.created) — either is an honest answer for "last keyframe at
    // or before 1000", so this only asserts one of the two, not a specific
    // tie-break order.
    expect(['created', 'stage']).toContain(lastKeyframeAtOrBefore(timeline, 1000)?.kind);
    expect(lastKeyframeAtOrBefore(timeline, 5000)?.kind).toBe('status');
    expect(lastKeyframeAtOrBefore(timeline, 5000)?.status).toBe('done');
  });

  it('an empty window (no events) reports an empty keyframe feed honestly', () => {
    const timeline = buildFleetTimeline([], 0, 10_000);
    expect(timeline.keyframes).toHaveLength(0);
    expect(lastKeyframeAtOrBefore(timeline, 5000)).toBeUndefined();
  });

  it('buckets every keyframe into its proportional time slot, summing to the total keyframe count', () => {
    const events = fullLifecycleEvents();
    const timeline = buildFleetTimeline(events, 0, 10_000);
    const buckets = densityBuckets(timeline, 10);
    expect(buckets).toHaveLength(10);
    const total = buckets.reduce((a, b) => a + b, 0);
    expect(total).toBe(timeline.keyframes.length);
    expect(total).toBeGreaterThan(0);
  });
});

// ── Brain-integration wave: brain.* rows get their own 'brain' keyframe ──

describe('buildFleetTimeline — brain.* keyframes', () => {
  it('splits a brain.recalled row into its own "brain" kind, carrying a real nodeIds.length count', () => {
    const events = [row(1_000, 'brain.recalled', { payload: JSON.stringify({ query: 'auth flow', nodeIds: ['n1', 'n2', 'n3'] }) })];
    const timeline = buildFleetTimeline(events, 0, 10_000);

    expect(timeline.keyframes).toHaveLength(1);
    expect(timeline.keyframes[0]).toMatchObject({
      kind: 'brain',
      missionId: null,
      eventType: 'brain.recalled',
      brainCount: 3,
    });
    expect(timeline.keyframes[0].brainDetail).toBeUndefined();
  });

  it('carries brain.captured\'s real kind as brainDetail (never composed/guessed)', () => {
    const events = [row(1_000, 'brain.captured', { payload: JSON.stringify({ neuronId: 'n1', kind: 'learning' }) })];
    const timeline = buildFleetTimeline(events, 0, 10_000);

    expect(timeline.keyframes[0]).toMatchObject({ kind: 'brain', eventType: 'brain.captured', brainDetail: 'learning' });
    expect(timeline.keyframes[0].brainCount).toBeUndefined();
  });

  it('carries brain.promoted\'s real scope as brainDetail', () => {
    const events = [row(1_000, 'brain.promoted', { payload: JSON.stringify({ neuronId: 'n1', scope: 'org' }) })];
    const timeline = buildFleetTimeline(events, 0, 10_000);
    expect(timeline.keyframes[0]).toMatchObject({ kind: 'brain', eventType: 'brain.promoted', brainDetail: 'org' });
  });

  it('carries brain.decision_created/decision_hit\'s real question as brainDetail', () => {
    const events = [
      row(1_000, 'brain.decision_created', { payload: JSON.stringify({ question: 'which auth strategy?', answer: 'PKCE' }) }),
      row(2_000, 'brain.decision_hit', { payload: JSON.stringify({ decisionId: 'd1', question: 'which auth strategy?' }) }),
    ];
    const timeline = buildFleetTimeline(events, 0, 10_000);
    expect(timeline.keyframes[0]).toMatchObject({ eventType: 'brain.decision_created', brainDetail: 'which auth strategy?' });
    expect(timeline.keyframes[1]).toMatchObject({ eventType: 'brain.decision_hit', brainDetail: 'which auth strategy?' });
  });

  it('degrades to no brainCount/brainDetail (never fabricated) for a malformed payload, but keeps the "brain" kind', () => {
    const events = [row(1_000, 'brain.captured', { payload: 'not json' })];
    const timeline = buildFleetTimeline(events, 0, 10_000);
    expect(timeline.keyframes[0].kind).toBe('brain');
    expect(timeline.keyframes[0].brainCount).toBeUndefined();
    expect(timeline.keyframes[0].brainDetail).toBeUndefined();
  });

  it('never conflates a brain.* row with the generic "system" bucket a non-brain mission-less row still gets', () => {
    const events = [
      row(1_000, 'brain.captured', { payload: JSON.stringify({ neuronId: 'n1', kind: 'note' }) }),
      row(2_000, 'project.opened', { payload: JSON.stringify({ root: '/repo' }) }),
    ];
    const timeline = buildFleetTimeline(events, 0, 10_000);
    expect(timeline.keyframes.map((k) => k.kind)).toEqual(['brain', 'system']);
  });
});
