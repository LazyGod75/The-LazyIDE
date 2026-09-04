/**
 * forkFromReplay.test.ts — fork-from-replay v1 (lib/agents/forkFromReplay.ts).
 * Pure fixtures, no React, no journalQuery mock — same synthetic
 * `JournalEventRow[]` convention as replayModel.test.ts/missionHistory.test.ts,
 * the two modules this file's derivations reuse.
 */

import { describe, it, expect } from 'vitest';
import { buildForkContextFacts, buildForkDraft, buildForkPreamble } from '../lib/agents/forkFromReplay';
import type { JournalEventRow, JournalEventType } from '../lib/journal/eventTypes';

// ── Fixtures (mirrors replayModel.test.ts's own row/missionRow helpers) ──

let seqCounter = 0;

function row(tsMs: number, type: JournalEventType, overrides: Partial<JournalEventRow> = {}): JournalEventRow {
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

/** Events straddling T=4000: everything up to review_requested happens AT
 *  OR BEFORE T; a second gate role, a second (later) intervention, and the
 *  mission's completion all happen strictly AFTER T. */
function straddlingEvents(missionId = 'm-1'): JournalEventRow[] {
  return [
    missionRow(missionId, 1000, 'mission.created', { title: 'Mission A' }),
    missionRow(missionId, 1500, 'mission.started', { model: 'sonnet' }),
    missionRow(missionId, 2000, 'mission.intervened', { note: 'note before T' }),
    missionRow(missionId, 3000, 'gate.passed', { role: 'tester', score: 90 }),
    missionRow(missionId, 4000, 'mission.review_requested', { proofCount: 1 }),
    // ── strictly AFTER atMs=4000 — must never influence the derived facts ──
    missionRow(missionId, 4500, 'mission.intervened', { note: 'note after T' }),
    missionRow(missionId, 5000, 'gate.passed', { role: 'reviewer', score: 80 }),
    missionRow(missionId, 6000, 'mission.completed', { durationMs: 5000 }),
  ];
}

const AT_MS = 4000;

describe('buildForkContextFacts — strictly events with ts_ms <= atMs', () => {
  it('reports only stages CLOSED by atMs — "code" (closed by the gate event) but never "review" (still open at T)', () => {
    const facts = buildForkContextFacts('m-1', AT_MS, straddlingEvents());
    expect(facts.completedStages).toContain('code');
    expect(facts.completedStages).not.toContain('review');
    expect(facts.completedStages).not.toContain('merged'); // completion is AFTER T
  });

  it('never includes a gate verdict observed strictly after atMs', () => {
    const facts = buildForkContextFacts('m-1', AT_MS, straddlingEvents());
    expect(facts.gateVerdicts).toEqual([{ role: 'tester', passed: true }]);
    expect(facts.gateVerdicts.some((v) => v.role === 'reviewer')).toBe(false);
  });

  it('reports the last intervention note AT OR BEFORE atMs, never a later one', () => {
    const facts = buildForkContextFacts('m-1', AT_MS, straddlingEvents());
    expect(facts.lastIntervention).toBe('note before T');
  });

  it('reflects an EARLIER atMs honestly — nothing completed yet before mission.started', () => {
    const facts = buildForkContextFacts('m-1', 1200, straddlingEvents());
    expect(facts.completedStages).toEqual([]);
    expect(facts.lastIntervention).toBeUndefined();
    expect(facts.gateVerdicts).toEqual([]);
  });

  it('scopes to the CURRENT generation only (recycled mission id — mirrors missionHistory.ts convention)', () => {
    const oldGeneration = [
      missionRow('m-1', 100, 'mission.created', { title: 'Old run' }),
      missionRow('m-1', 200, 'gate.passed', { role: 'security', score: 99 }),
      missionRow('m-1', 300, 'mission.completed', {}),
    ];
    const events = [...oldGeneration, ...straddlingEvents()];
    const facts = buildForkContextFacts('m-1', AT_MS, events);
    // The OLD generation's 'security' verdict must never blend into the
    // current generation's facts.
    expect(facts.gateVerdicts.some((v) => v.role === 'security')).toBe(false);
  });
});

describe('buildForkPreamble — plain, non-i18n prompt text', () => {
  it('mentions the fork instant and every fact present, never a placeholder for an absent one', () => {
    const facts = buildForkContextFacts('m-1', AT_MS, straddlingEvents());
    const preamble = buildForkPreamble(facts, AT_MS);
    // Also includes 'test' — a single gate event still closes a zero-width
    // 'test' span (deriveStageSpans' own convention, same as its 'merged'
    // marker) — honest, not a bug: the only stage genuinely still OPEN at T
    // is 'review' (mission.review_requested has no terminal event yet).
    expect(preamble).toContain('Completed by this point: plan, code, test.');
    expect(preamble).toContain('tester=passed');
    expect(preamble).toContain('note before T');
    expect(preamble).not.toContain('note after T');
    expect(preamble).not.toContain('reviewer=');
  });

  it('reports an honest "nothing completed" line when no stage has closed yet', () => {
    const facts = buildForkContextFacts('m-1', 1200, straddlingEvents());
    const preamble = buildForkPreamble(facts, 1200);
    expect(preamble).toContain('No stage had completed yet');
  });
});

describe('buildForkDraft — the seeded DraftSpec', () => {
  it('sets isolated:true and forkOf provenance to exactly {missionId, atMs}', () => {
    const seed = buildForkDraft('m-1', AT_MS, straddlingEvents(), { title: 'Mission A' });
    expect(seed.isolated).toBe(true);
    expect(seed.forkOf).toEqual({ missionId: 'm-1', atMs: AT_MS });
  });

  it('appends a "(fork @HH:MM)" title suffix onto the source mission title', () => {
    const seed = buildForkDraft('m-1', AT_MS, straddlingEvents(), { title: 'Mission A' });
    expect(seed.title).toMatch(/^Mission A \(fork @\d{2}:\d{2}\)$/);
  });

  it('uses agentTask (not the bare title) as the original task when present', () => {
    const seed = buildForkDraft('m-1', AT_MS, straddlingEvents(), { title: 'Mission A', agentTask: 'Fix the login bug' });
    expect(seed.task).toContain('Fix the login bug');
  });

  it('falls back to the title as the original task when agentTask is absent (honest degrade, mirrors duplicateAsDraft)', () => {
    const seed = buildForkDraft('m-1', AT_MS, straddlingEvents(), { title: 'Mission A' });
    expect(seed.task).toContain('Mission A');
  });

  it('never leaks a post-atMs fact into the composed task text', () => {
    const seed = buildForkDraft('m-1', AT_MS, straddlingEvents(), { title: 'Mission A', agentTask: 'Fix the login bug' });
    expect(seed.task).not.toContain('note after T');
    expect(seed.task).not.toContain('reviewer=');
  });

  it('carries agentName/model through from the source mission', () => {
    const seed = buildForkDraft('m-1', AT_MS, straddlingEvents(), { title: 'Mission A', agentName: 'code-reviewer', model: 'opus' });
    expect(seed.agentName).toBe('code-reviewer');
    expect(seed.model).toBe('opus');
  });

  it('never sets an id or projectId — the caller owns id-minting/placement', () => {
    const seed = buildForkDraft('m-1', AT_MS, straddlingEvents(), { title: 'Mission A' });
    expect(seed).not.toHaveProperty('id');
    expect(seed.projectId).toBeUndefined();
  });

  it('createdBy is always "user" (the human triggered the fork from the replay UI)', () => {
    const seed = buildForkDraft('m-1', AT_MS, straddlingEvents(), { title: 'Mission A' });
    expect(seed.createdBy).toBe('user');
  });
});
