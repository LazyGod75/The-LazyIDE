/* zoneDigest.test.ts — src/lib/journal/zoneDigest.ts's pure "living empty
   zone" read-model. Synthetic JournalEventRow fixtures only (no I/O).

   Includes MAJEUR regression coverage (R3 dogfood): zoneDigest.ts derives
   `recentMissions` from buildProjectArchive and `mergedTodayCount` from
   buildProjectReport (both missionHistory.ts/projectReport.ts) — this file
   verifies the generation-scoping fix (mission ids get recycled across
   unrelated runs) flows through to this read-model too, without needing to
   duplicate any scoping logic locally.
*/

import { describe, it, expect } from 'vitest';
import { buildZoneDigest, formatZoneDigestAge, zoneDigestStatusLabelKey } from '../lib/journal/zoneDigest';
import type { JournalEventRow, JournalEventType } from '../lib/journal/eventTypes';

let seqCounter = 0;

function row(
  type: JournalEventType,
  tsMs: number,
  payload: Record<string, unknown> = {},
  overrides: Partial<JournalEventRow> = {},
): JournalEventRow {
  seqCounter += 1;
  return {
    seq: seqCounter,
    ts_ms: tsMs,
    project_id: 'proj-1',
    mission_id: 'm-1',
    agent_id: null,
    run_id: null,
    actor: 'system',
    type,
    payload: JSON.stringify(payload),
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    ...overrides,
  };
}

const NOW = new Date(2026, 6, 14, 12, 0, 0).getTime(); // 2026-07-14 local noon
const TODAY_10AM = new Date(2026, 6, 14, 10, 0, 0).getTime();
const YESTERDAY = new Date(2026, 6, 13, 10, 0, 0).getTime();

function fakeT(key: string, params?: Record<string, string | number>): string {
  return params ? `${key}:${JSON.stringify(params)}` : key;
}

describe('formatZoneDigestAge', () => {
  it('reports "just now" for a sub-minute gap', () => {
    expect(formatZoneDigestAge(NOW - 5_000, fakeT, NOW)).toBe('canvas.zone.digest.justNow');
  });

  it('reports minutes for a sub-hour gap', () => {
    expect(formatZoneDigestAge(NOW - 5 * 60_000, fakeT, NOW)).toBe(
      'canvas.zone.digest.minutesAgo:{"count":5}',
    );
  });

  it('reports hours for a sub-day gap', () => {
    expect(formatZoneDigestAge(NOW - 3 * 3_600_000, fakeT, NOW)).toBe(
      'canvas.zone.digest.hoursAgo:{"count":3}',
    );
  });

  it('reports days beyond a day', () => {
    expect(formatZoneDigestAge(NOW - 2 * 86_400_000, fakeT, NOW)).toBe(
      'canvas.zone.digest.daysAgo:{"count":2}',
    );
  });
});

describe('zoneDigestStatusLabelKey', () => {
  it('maps every known terminal type to its own key', () => {
    expect(zoneDigestStatusLabelKey('mission.completed')).toBe('canvas.zone.digest.status.completed');
    expect(zoneDigestStatusLabelKey('mission.failed')).toBe('canvas.zone.digest.status.failed');
  });

  it('falls back to "completed" for a type not in the map (never undefined)', () => {
    expect(zoneDigestStatusLabelKey('mission.reverted')).toBe('canvas.zone.digest.status.reverted');
  });
});

describe('buildZoneDigest', () => {
  it('reports the single most recent event across all types/missions as lastActivity', () => {
    const events = [
      row('mission.created', 1_000, {}, { mission_id: 'm-a' }),
      row('mission.started', 2_000, {}, { mission_id: 'm-a' }),
      row('project.opened', 500, { root: '/repo' }, { mission_id: null }),
    ];
    const digest = buildZoneDigest(events, NOW);
    expect(digest.lastActivity).toEqual({ type: 'mission.started', atMs: 2_000 });
  });

  it('returns null lastActivity and an empty digest for an empty project', () => {
    const digest = buildZoneDigest([], NOW);
    expect(digest.lastActivity).toBeNull();
    expect(digest.recentMissions).toEqual([]);
    expect(digest.mergedTodayCount).toBe(0);
  });

  // ── MAJEUR (R3 dogfood) — generation scoping ──────────────────────────

  it('never shows a recycled id\'s current (in-review) generation as a "Terminée" ghost row, even though an older generation of the same id completed', () => {
    const events = [
      row('mission.created', YESTERDAY - 2000, { title: 'Yesterday (old generation)' }, { mission_id: 'M9' }),
      row('mission.completed', YESTERDAY, {}, { mission_id: 'M9' }),
      row('mission.created', TODAY_10AM - 2000, { title: 'Today (current generation)' }, { mission_id: 'M9' }),
      row('mission.review_requested', TODAY_10AM - 1000, { proofCount: 1 }, { mission_id: 'M9' }),
    ];
    const digest = buildZoneDigest(events, NOW);

    const m9Ghosts = digest.recentMissions.filter((m) => m.missionId === 'M9');
    // Only the genuinely-finished (yesterday) generation shows as a ghost
    // row — the still-in-review current generation has no terminal event and
    // must never borrow the older generation's "Terminée" status.
    expect(m9Ghosts).toHaveLength(1);
    expect(m9Ghosts[0]).toMatchObject({ title: 'Yesterday (old generation)', terminalType: 'mission.completed' });

    // mergedTodayCount comes from buildProjectReport — the still-in-review
    // current generation must not count, and the old generation didn't
    // complete today either.
    expect(digest.mergedTodayCount).toBe(0);
  });

  it('counts mergedTodayCount correctly when a recycled id\'s CURRENT generation completes today (distinct from an older, already-completed generation)', () => {
    // fix/canvas-ux R9 MAJEUR — real merges (mission.approved), matching
    // projectReport.ts's buildProjectReport corrected "mergedToday only for
    // an actual mission.approved" semantics this digest re-exports verbatim.
    const events = [
      row('mission.created', YESTERDAY - 2000, { title: 'Yesterday run' }, { mission_id: 'M9' }),
      row('mission.completed', YESTERDAY - 500, {}, { mission_id: 'M9' }),
      row('mission.approved', YESTERDAY, {}, { mission_id: 'M9' }),
      row('mission.created', TODAY_10AM - 2000, { title: 'Today run (recycled id)' }, { mission_id: 'M9' }),
      row('mission.completed', TODAY_10AM - 500, {}, { mission_id: 'M9' }),
      row('mission.approved', TODAY_10AM, {}, { mission_id: 'M9' }),
    ];
    const digest = buildZoneDigest(events, NOW);
    expect(digest.mergedTodayCount).toBe(1);
  });

  it('caps recentMissions at 3, newest-first, across distinct mission ids', () => {
    const events = [
      row('mission.created', 1_000, { title: 'A' }, { mission_id: 'm-a' }),
      row('mission.completed', 2_000, {}, { mission_id: 'm-a' }),
      row('mission.created', 3_000, { title: 'B' }, { mission_id: 'm-b' }),
      row('mission.completed', 4_000, {}, { mission_id: 'm-b' }),
      row('mission.created', 5_000, { title: 'C' }, { mission_id: 'm-c' }),
      row('mission.failed', 6_000, { reason: 'x' }, { mission_id: 'm-c' }),
      row('mission.created', 7_000, { title: 'D' }, { mission_id: 'm-d' }),
      row('mission.cancelled', 8_000, {}, { mission_id: 'm-d' }),
    ];
    const digest = buildZoneDigest(events, NOW);
    expect(digest.recentMissions).toHaveLength(3);
    expect(digest.recentMissions.map((m) => m.missionId)).toEqual(['m-d', 'm-c', 'm-b']);
  });

  // ── Brain visibility (brain-integration wave) ────────────────────────

  it('reports null lastBrainActivity and 0 brainNeuronsToday when the project has no brain.* events', () => {
    const events = [row('mission.created', 1_000, {}, { mission_id: 'm-a' })];
    const digest = buildZoneDigest(events, NOW);
    expect(digest.lastBrainActivity).toBeNull();
    expect(digest.brainNeuronsToday).toBe(0);
  });

  it('surfaces the most recent brain.* event as lastBrainActivity even when a LATER non-brain event exists', () => {
    const events = [
      row('brain.captured', 1_000, { neuronId: 'n1', kind: 'note' }, { mission_id: null }),
      row('mission.created', 5_000, {}, { mission_id: 'm-a' }), // later, but not brain
    ];
    const digest = buildZoneDigest(events, NOW);
    // lastActivity (type-agnostic) picks the truly-latest row...
    expect(digest.lastActivity).toEqual({ type: 'mission.created', atMs: 5_000 });
    // ...but lastBrainActivity independently tracks the latest BRAIN row.
    expect(digest.lastBrainActivity).toEqual({ type: 'brain.captured', atMs: 1_000 });
  });

  it('counts brainNeuronsToday from brain.captured + brain.decision_created only, scoped to today', () => {
    const events = [
      row('brain.captured', TODAY_10AM, { neuronId: 'n1', kind: 'note' }, { mission_id: null }),
      row('brain.decision_created', TODAY_10AM + 1000, { question: 'q', answer: 'a' }, { mission_id: null }),
      // Reads/promotions/reuses never create a NEW neuron — must not count.
      row('brain.recalled', TODAY_10AM + 2000, { query: 'q', nodeIds: ['n1'] }, { mission_id: null }),
      row('brain.decision_hit', TODAY_10AM + 3000, { decisionId: 'n1', question: 'q' }, { mission_id: null }),
      row('brain.promoted', TODAY_10AM + 4000, { neuronId: 'n1', scope: 'org' }, { mission_id: null }),
      // Yesterday's capture must not count toward TODAY's total.
      row('brain.captured', YESTERDAY, { neuronId: 'n0', kind: 'note' }, { mission_id: null }),
    ];
    const digest = buildZoneDigest(events, NOW);
    expect(digest.brainNeuronsToday).toBe(2);
  });
});
