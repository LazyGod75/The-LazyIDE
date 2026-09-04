/* projectReport.test.ts — src/lib/journal/projectReport.ts's pure per-project
   report derivation. Synthetic JournalEventRow fixtures only (no I/O). */

import { describe, it, expect } from 'vitest';
import { buildProjectReport, isProofArtifactLike } from '../lib/journal/projectReport';
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

describe('isProofArtifactLike', () => {
  it('accepts each valid kind with its required fields', () => {
    expect(isProofArtifactLike({ kind: 'screenshot', path: '/a.png', label: 'UI' })).toBe(true);
    expect(isProofArtifactLike({ kind: 'test_run', command: 'npm test', exitCode: 0, outputPath: '/o.txt' })).toBe(true);
    expect(isProofArtifactLike({ kind: 'e2e_recording', path: '/rec.webm' })).toBe(true);
    expect(isProofArtifactLike({ kind: 'command_output', command: 'ls', outputPath: '/o.txt' })).toBe(true);
    expect(isProofArtifactLike({ kind: 'behavior_diff', before: 'a', after: 'b' })).toBe(true);
  });

  it('rejects a known kind missing a required field, and unknown kinds', () => {
    expect(isProofArtifactLike({ kind: 'screenshot', path: '/a.png' })).toBe(false); // no label
    expect(isProofArtifactLike({ kind: 'test_run', command: 'npm test' })).toBe(false);
    expect(isProofArtifactLike({ kind: 'video', path: '/x' })).toBe(false);
    expect(isProofArtifactLike('screenshot')).toBe(false);
  });
});

describe('buildProjectReport', () => {
  it('only includes missions with a SUCCESS terminal event (completed/approved)', () => {
    const events = [
      row('mission.created', 1_000, { title: 'Done one' }, { mission_id: 'm-done' }),
      row('mission.completed', TODAY_10AM, {}, { mission_id: 'm-done' }),
      row('mission.created', 1_000, { title: 'Failed one' }, { mission_id: 'm-fail' }),
      row('mission.failed', 3_000, { reason: 'x' }, { mission_id: 'm-fail' }),
      row('mission.created', 1_000, { title: 'Still running' }, { mission_id: 'm-run' }),
    ];
    const report = buildProjectReport(events, NOW);
    expect(report.completedMissions.map((m) => m.missionId)).toEqual(['m-done']);
  });

  it('mission.approved also qualifies as completed', () => {
    const events = [
      row('mission.created', 1_000, { title: 'Approved' }, { mission_id: 'm-a' }),
      row('mission.approved', 2_000, { approvedBy: 'david' }, { mission_id: 'm-a' }),
    ];
    const report = buildProjectReport(events, NOW);
    expect(report.completedMissions[0].terminalType).toBe('mission.approved');
  });

  // ── W-MODES: autoMerged ──────────────────────────────────────────

  it('autoMerged is true when the mission.approved payload carries actor: "auto"', () => {
    const events = [
      row('mission.created', 1_000, { title: 'Auto-merged' }, { mission_id: 'm-auto' }),
      row('mission.approved', 2_000, { actor: 'auto', mode: 'auto_green' }, { mission_id: 'm-auto' }),
    ];
    const report = buildProjectReport(events, NOW);
    expect(report.completedMissions[0].autoMerged).toBe(true);
  });

  it('autoMerged is absent (not false) for a normal human approval', () => {
    const events = [
      row('mission.created', 1_000, { title: 'Human-merged' }, { mission_id: 'm-human' }),
      row('mission.approved', 2_000, { approvedBy: 'david' }, { mission_id: 'm-human' }),
    ];
    const report = buildProjectReport(events, NOW);
    expect(report.completedMissions[0].autoMerged).toBeUndefined();
  });

  it('autoMerged is absent for a review-only completion (mission.completed, never approved)', () => {
    const events = [
      row('mission.created', 1_000, { title: 'Review only' }, { mission_id: 'm-review' }),
      row('mission.completed', 2_000, {}, { mission_id: 'm-review' }),
    ];
    const report = buildProjectReport(events, NOW);
    expect(report.completedMissions[0].autoMerged).toBeUndefined();
  });

  it('derives mergedToday from the LOCAL calendar day of the REAL merge (mission.approved) vs nowMs', () => {
    // fix/canvas-ux R9 MAJEUR — mission.approved, not mission.completed (see
    // buildProjectReport's own updated header): mission.completed only
    // means the agent run finished (now in 'review'), never that a human
    // actually merged it.
    const events = [
      row('mission.created', TODAY_10AM - 1000, { title: 'Today' }, { mission_id: 'm-today' }),
      row('mission.completed', TODAY_10AM - 500, {}, { mission_id: 'm-today' }),
      row('mission.approved', TODAY_10AM, {}, { mission_id: 'm-today' }),
      row('mission.created', YESTERDAY - 1000, { title: 'Yesterday' }, { mission_id: 'm-yest' }),
      row('mission.completed', YESTERDAY - 500, {}, { mission_id: 'm-yest' }),
      row('mission.approved', YESTERDAY, {}, { mission_id: 'm-yest' }),
    ];
    const report = buildProjectReport(events, NOW);
    const today = report.completedMissions.find((m) => m.missionId === 'm-today');
    const yest = report.completedMissions.find((m) => m.missionId === 'm-yest');
    expect(today?.mergedToday).toBe(true);
    expect(yest?.mergedToday).toBe(false);
    expect(report.mergedTodayCount).toBe(1);
  });

  it('mission.completed alone (agent run finished, never approved) is a genuine "completed" entry but NEVER counts as mergedToday — the exact fix/canvas-ux R9 divergence (Bandeau "1" vs Rapport "3")', () => {
    const events = [
      row('mission.created', TODAY_10AM - 1000, { title: 'Awaiting review' }, { mission_id: 'm-review-only' }),
      row('mission.completed', TODAY_10AM, {}, { mission_id: 'm-review-only' }),
    ];
    const report = buildProjectReport(events, NOW);
    const entry = report.completedMissions.find((m) => m.missionId === 'm-review-only');
    expect(entry).toBeDefined();
    expect(entry?.terminalType).toBe('mission.completed');
    expect(entry?.mergedToday).toBe(false);
    expect(report.mergedTodayCount).toBe(0);
  });

  it('when a mission has BOTH mission.completed (reached review) and a later mission.approved (real merge), the approval wins as terminalType/completedAtMs regardless of array order', () => {
    const events = [
      row('mission.created', TODAY_10AM - 2000, { title: 'Reviewed then merged' }, { mission_id: 'm-both' }),
      row('mission.completed', TODAY_10AM - 1000, {}, { mission_id: 'm-both' }),
      row('mission.approved', TODAY_10AM, {}, { mission_id: 'm-both' }),
    ];
    const report = buildProjectReport(events, NOW);
    const entry = report.completedMissions.find((m) => m.missionId === 'm-both');
    expect(entry?.terminalType).toBe('mission.approved');
    expect(entry?.completedAtMs).toBe(TODAY_10AM);
    expect(entry?.mergedToday).toBe(true);
  });

  it('reads artifacts from the LATEST full Mission snapshot (mission.updated wins over created), dropping malformed entries', () => {
    const validProof = { kind: 'screenshot', path: '/shots/a.png', label: 'Login screen' };
    const malformed = { kind: 'test_run', command: 'npm test' }; // missing exitCode/outputPath
    const events = [
      row('mission.created', 1_000, { title: 'M', mission: { id: 'm-p', title: 'M', proofs: [] } }, { mission_id: 'm-p' }),
      row(
        'mission.updated',
        1_500,
        { mission: { id: 'm-p', title: 'M (updated)', proofs: [validProof, malformed] } },
        { mission_id: 'm-p' },
      ),
      row('mission.completed', 2_000, {}, { mission_id: 'm-p' }),
    ];
    const report = buildProjectReport(events, NOW);
    expect(report.completedMissions[0].artifacts).toEqual([validProof]);
    expect(report.completedMissions[0].title).toBe('M (updated)');
  });

  it('reports [] artifacts (never fabricated) when no snapshot ever carried proofs', () => {
    const events = [
      row('mission.created', 1_000, { title: 'No proofs' }, { mission_id: 'm-np' }),
      row('mission.completed', 2_000, {}, { mission_id: 'm-np' }),
    ];
    const report = buildProjectReport(events, NOW);
    expect(report.completedMissions[0].artifacts).toEqual([]);
    expect(report.completedMissions[0].title).toBe('No proofs');
  });

  it('aggregates totals across completed missions (cost/tokens/real agent duration) and sorts newest-first', () => {
    // durationMs is REAL agent time (agentMetrics.durationMs from each
    // mission's latest snapshot), never the wall-clock created->completed
    // span — see CompletedMissionReport.durationMs's doc comment. m-1st's
    // wall-clock span here is 1_000ms but its real agent time is 900ms
    // (e.g. it sat briefly before the agent actually started); m-2nd's is
    // 1_100ms. A wall-clock-based total would report 2_000ms; the honest
    // agent-time total is 2_000ms too by coincidence of these fixture
    // numbers being chosen to sum the same — the important assertion is
    // that it comes from agentMetrics, not from timestamps (see the
    // dedicated "never wall-clock" test below for a fixture where they
    // differ and would catch a regression back to wall-clock).
    const events = [
      row('mission.created', 1_000, { title: 'First' }, { mission_id: 'm-1st' }),
      row(
        'spend.tokens',
        1_500,
        { tokensIn: 100, tokensOut: 40, costUsd: 0.5, source: 'real' },
        { mission_id: 'm-1st', tokens_in: 100, tokens_out: 40, cost_usd: 0.5 },
      ),
      row(
        'mission.updated',
        1_800,
        { mission: { id: 'm-1st', title: 'First', agentMetrics: { durationMs: 900, inputTokens: 100, outputTokens: 40, costUsd: 0.5, toolCount: 2 } } },
        { mission_id: 'm-1st' },
      ),
      row('mission.completed', 2_000, {}, { mission_id: 'm-1st' }),
      row('mission.created', 5_000, { title: 'Second' }, { mission_id: 'm-2nd' }),
      row(
        'spend.tokens',
        5_500,
        { tokensIn: 50, tokensOut: 10, costUsd: 0.25, source: 'real' },
        { mission_id: 'm-2nd', tokens_in: 50, tokens_out: 10, cost_usd: 0.25 },
      ),
      row(
        'mission.updated',
        5_800,
        { mission: { id: 'm-2nd', title: 'Second', agentMetrics: { durationMs: 1_100, inputTokens: 50, outputTokens: 10, costUsd: 0.25, toolCount: 1 } } },
        { mission_id: 'm-2nd' },
      ),
      row('mission.completed', 6_000, {}, { mission_id: 'm-2nd' }),
    ];
    const report = buildProjectReport(events, NOW);
    expect(report.completedMissions.map((m) => m.missionId)).toEqual(['m-2nd', 'm-1st']);
    expect(report.completedMissions.find((m) => m.missionId === 'm-1st')?.durationMs).toBe(900);
    expect(report.completedMissions.find((m) => m.missionId === 'm-2nd')?.durationMs).toBe(1_100);
    // No mission.started event in this fixture -> costIsApiEquivalent stays
    // undefined for both missions, so neither rail-split total picks them
    // up (an honest omission, not a guess — see ProjectReportTotals's own
    // doc comment); the raw combined costUsd is unaffected.
    expect(report.totals).toEqual({
      costUsd: 0.75,
      costUsdManaged: 0,
      costUsdApiEquivalent: 0,
      tokensIn: 150,
      tokensOut: 50,
      durationMs: 2_000,
    });
  });

  it('BUGFIX (M12 dogfood, MAJEUR #6a): durationMs is real agent time, NEVER the wall-clock span — a mission queued/paused for a long time must not inflate the total', () => {
    const events = [
      // Wall-clock span is ~11 days (matches the real reported bug: 16032
      // wall-clock minutes for what was actually a few minutes of real
      // agent work) but the mission's OWN recorded agent time is tiny.
      row('mission.created', 0, { title: 'Sat queued for days' }, { mission_id: 'm-slow-wallclock' }),
      row(
        'mission.updated',
        500,
        { mission: { id: 'm-slow-wallclock', title: 'Sat queued for days', agentMetrics: { durationMs: 45_000, inputTokens: 10, outputTokens: 5, costUsd: 0.01, toolCount: 1 } } },
        { mission_id: 'm-slow-wallclock' },
      ),
      row('mission.completed', 11 * 24 * 60 * 60 * 1000, {}, { mission_id: 'm-slow-wallclock' }),
    ];
    const report = buildProjectReport(events, NOW);
    expect(report.completedMissions[0].durationMs).toBe(45_000);
    expect(report.totals.durationMs).toBe(45_000);
    // The wall-clock span (~950_400_000ms) must never appear anywhere.
    expect(report.totals.durationMs).toBeLessThan(11 * 24 * 60 * 60 * 1000);
  });

  it('reports durationMs as null (honest absence, never a wall-clock fallback) when a completed mission never recorded agentMetrics', () => {
    const events = [
      row('mission.created', 1_000, { title: 'No metrics ever recorded' }, { mission_id: 'm-no-metrics' }),
      row('mission.completed', 9_000, {}, { mission_id: 'm-no-metrics' }),
    ];
    const report = buildProjectReport(events, NOW);
    expect(report.completedMissions[0].durationMs).toBeNull();
    expect(report.totals.durationMs).toBe(0);
  });

  // ── M12 dogfood fix (undercount honesty): cacheReadInputTokens ──────────

  it('extracts cacheReadInputTokens from the latest snapshot\'s agentMetrics', () => {
    const events = [
      row('mission.created', 1_000, { title: 'Cached run' }, { mission_id: 'm-cached' }),
      row(
        'mission.updated',
        1_500,
        {
          mission: {
            id: 'm-cached',
            title: 'Cached run',
            agentMetrics: { durationMs: 500, inputTokens: 22, outputTokens: 140, costUsd: 0.05, toolCount: 22, cacheReadInputTokens: 11400 },
          },
        },
        { mission_id: 'm-cached' },
      ),
      row('mission.completed', 2_000, {}, { mission_id: 'm-cached' }),
    ];
    const report = buildProjectReport(events, NOW);
    expect(report.completedMissions[0].cacheReadInputTokens).toBe(11400);
  });

  it('reports cacheReadInputTokens as null (never a fabricated 0) when the snapshot never recorded it', () => {
    const events = [
      row('mission.created', 1_000, { title: 'No cache metric' }, { mission_id: 'm-no-cache' }),
      row('mission.completed', 2_000, {}, { mission_id: 'm-no-cache' }),
    ];
    const report = buildProjectReport(events, NOW);
    expect(report.completedMissions[0].cacheReadInputTokens).toBeNull();
  });

  it('carries per-mission chain fires through from the mission history', () => {
    const events = [
      row('mission.created', 1_000, { title: 'Chained' }, { mission_id: 'm-c' }),
      row('mission.completed', 2_000, {}, { mission_id: 'm-c' }),
      row(
        'chain.fired',
        2_100,
        { chainId: 'ch1', sourceMissionId: 'm-c', targetRef: 'draft:d9', projectId: 'proj-1' },
        { mission_id: 'm-c' },
      ),
    ];
    const report = buildProjectReport(events, NOW);
    expect(report.completedMissions[0].chainFires).toHaveLength(1);
    expect(report.completedMissions[0].chainFires[0]).toMatchObject({ chainId: 'ch1', kind: 'fired' });
  });

  it('returns an empty report for an empty event list', () => {
    const report = buildProjectReport([], NOW);
    expect(report.completedMissions).toEqual([]);
    expect(report.totals).toEqual({
      costUsd: 0,
      costUsdManaged: 0,
      costUsdApiEquivalent: 0,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
    });
    expect(report.mergedTodayCount).toBe(0);
  });
});

// ── MAJEUR (R3 dogfood): mission-id recycling — completedMissions keyed by
// (id, generation). Real repro: today's M9 (still in review) was shown as
// "Terminée" + counted in "1 mergée aujourd'hui" because an OLDER generation
// of the same recycled id had completed on July 11. completedMissions must
// key by (missionId, generation) — a generation that is not itself terminal
// can never inherit a sibling generation's status.

describe('buildProjectReport — generation scoping for a recycled mission id (MAJEUR fix)', () => {
  it('a recycled id whose CURRENT generation is not terminal never appears as Terminée, even though an OLDER generation of the same id completed', () => {
    const events = [
      // Older generation (yesterday): completed successfully.
      row('mission.created', YESTERDAY - 2000, { title: 'Yesterday (old generation)' }, { mission_id: 'M9' }),
      row('mission.completed', YESTERDAY, {}, { mission_id: 'M9' }),
      // Current generation (today): a NEW, unrelated mission that reused
      // "M9" — still in review, no terminal event yet.
      row('mission.created', TODAY_10AM - 2000, { title: 'Today (current generation)' }, { mission_id: 'M9' }),
      row('mission.review_requested', TODAY_10AM - 1000, { proofCount: 1 }, { mission_id: 'M9' }),
    ];
    const report = buildProjectReport(events, NOW);

    const m9Entries = report.completedMissions.filter((m) => m.missionId === 'M9');
    // Only the OLDER, genuinely-finished generation appears — never the
    // current, still-in-review generation borrowing its "Terminée" status.
    expect(m9Entries).toHaveLength(1);
    expect(m9Entries[0]).toMatchObject({ generation: 0, title: 'Yesterday (old generation)', mergedToday: false });
  });

  it('keys completedMissions by (id, generation): two independently-completed generations of a recycled id BOTH appear as separate rows', () => {
    // fix/canvas-ux R9 MAJEUR — real merges (mission.approved), not just
    // mission.completed, so this test's own "mergedToday" assertions stay
    // meaningful under buildProjectReport's corrected semantics.
    const events = [
      row('mission.created', YESTERDAY - 2000, { title: 'Yesterday run' }, { mission_id: 'M9' }),
      row('mission.completed', YESTERDAY - 500, {}, { mission_id: 'M9' }),
      row('mission.approved', YESTERDAY, {}, { mission_id: 'M9' }),
      row('mission.created', TODAY_10AM - 2000, { title: 'Today run (recycled id)' }, { mission_id: 'M9' }),
      row('mission.completed', TODAY_10AM - 500, {}, { mission_id: 'M9' }),
      row('mission.approved', TODAY_10AM, {}, { mission_id: 'M9' }),
    ];
    const report = buildProjectReport(events, NOW);

    const m9Entries = report.completedMissions
      .filter((m) => m.missionId === 'M9')
      .sort((a, b) => a.generation - b.generation);
    expect(m9Entries).toHaveLength(2);
    expect(m9Entries[0]).toMatchObject({ generation: 0, title: 'Yesterday run', mergedToday: false });
    expect(m9Entries[1]).toMatchObject({ generation: 1, title: 'Today run (recycled id)', mergedToday: true });
    // Only today's generation counts toward "mergée aujourd'hui" — the
    // yesterday generation, though also completed, is not from today.
    expect(report.mergedTodayCount).toBe(1);
  });
});

// ── Tokens in/out — regression pin against the dogfood's "178 in / 13080
// out shown inverted" evidence. Traced end-to-end (journal row ->
// deriveTokenAggregate -> buildProjectReport): tokensIn/tokensOut are never
// swapped anywhere in this pipeline — this test pins the exact reported
// figures so a future change can't silently invert them again.

describe('buildProjectReport — tokens in/out are never inverted (dogfood evidence pin)', () => {
  it('a spend.tokens row with tokens_in=178, tokens_out=13080 reports tokensIn=178 and tokensOut=13080 — not swapped', () => {
    const events = [
      row('mission.created', 1_000, { title: 'Token pin' }, { mission_id: 'm-tok' }),
      row(
        'spend.tokens',
        1_500,
        { tokensIn: 178, tokensOut: 13080, costUsd: 0.9, source: 'real' },
        { mission_id: 'm-tok', tokens_in: 178, tokens_out: 13080, cost_usd: 0.9 },
      ),
      row('mission.completed', 2_000, {}, { mission_id: 'm-tok' }),
    ];
    const report = buildProjectReport(events, NOW);
    expect(report.completedMissions[0].tokensIn).toBe(178);
    expect(report.completedMissions[0].tokensOut).toBe(13080);
  });
});
