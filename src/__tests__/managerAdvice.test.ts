/**
 * managerAdvice.test.ts — D13 graft (a): pure helpers behind the "Avis du
 * manager" card (trigger detection, prompt building, response parsing).
 * No LLM call involved — runManagerTurn itself is exercised by
 * managerEngine.test.ts / agentsStore.test.tsx.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldOfferManagerAdvice,
  buildManagerAdvicePrompt,
  extractAlternatePlan,
  buildRetryTaskWithRecommendation,
} from '../lib/agents/managerAdvice';
import type { Mission } from '../lib/agents/types';

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'm1',
    title: 'Fix the pricing table',
    status: 'running',
    model: 'sonnet',
    ...overrides,
  };
}

describe('shouldOfferManagerAdvice', () => {
  it('is true for a failed mission', () => {
    expect(shouldOfferManagerAdvice(makeMission({ status: 'failed' }))).toBe(true);
  });

  it('is true for a running mission with a real pending ask_user question', () => {
    const mission = makeMission({
      status: 'running',
      actionTimeline: [{ time: '10:00', text: 'Observation: Question for user: write server/auth.rs ?' }],
    });
    expect(shouldOfferManagerAdvice(mission)).toBe(true);
  });

  it('is false for a running mission with no pending question', () => {
    const mission = makeMission({
      status: 'running',
      actionTimeline: [{ time: '10:00', text: 'implements PricingTable.tsx' }],
    });
    expect(shouldOfferManagerAdvice(mission)).toBe(false);
  });

  it('is false for done/review/cancelled/queued missions', () => {
    expect(shouldOfferManagerAdvice(makeMission({ status: 'done' }))).toBe(false);
    expect(shouldOfferManagerAdvice(makeMission({ status: 'review' }))).toBe(false);
    expect(shouldOfferManagerAdvice(makeMission({ status: 'cancelled' }))).toBe(false);
    expect(shouldOfferManagerAdvice(makeMission({ status: 'queued' }))).toBe(false);
  });

  // QA B15: a rejected judge verdict leaves status 'review' (never
  // 'failed' — see approveGate.ts's isJudgeRejected doc comment), so this
  // case used to be silently unreachable even though it's the realistic,
  // common outcome of a rejected review.
  it('is true for a review mission the judge actually rejected', () => {
    const mission = makeMission({
      status: 'review',
      judgeVerdict: { score: 15, passed: false, risk: 'high', reviewers: [], createdAt: '2026-07-01T00:00:00.000Z' },
    });
    expect(shouldOfferManagerAdvice(mission)).toBe(true);
  });

  it('is still false for a review mission still awaiting a verdict', () => {
    expect(shouldOfferManagerAdvice(makeMission({ status: 'review', judgeVerdict: undefined }))).toBe(false);
  });

  it('is still false for a review mission the judge actually approved', () => {
    const mission = makeMission({
      status: 'review',
      judgeVerdict: { score: 92, passed: true, risk: 'low', reviewers: [], createdAt: '2026-07-01T00:00:00.000Z' },
    });
    expect(shouldOfferManagerAdvice(mission)).toBe(false);
  });
});

describe('buildManagerAdvicePrompt', () => {
  it('describes a failed mission and asks for a "Plan alternatif :" line', () => {
    const mission = makeMission({ status: 'failed', statusReason: 'tests failed' });
    const prompt = buildManagerAdvicePrompt(mission);
    expect(prompt).toContain('a échoué');
    expect(prompt).toContain(mission.title);
    expect(prompt).toContain(mission.id);
    expect(prompt).toContain('Plan alternatif :');
  });

  it('includes the real pending question for a blocked-running mission', () => {
    const mission = makeMission({
      status: 'running',
      actionTimeline: [{ time: '10:00', text: 'Observation: Question for user: write server/auth.rs ?' }],
    });
    const prompt = buildManagerAdvicePrompt(mission);
    expect(prompt).toContain('write server/auth.rs ?');
  });

  it('describes a judge-rejected review mission distinctly (QA B15), with its real score', () => {
    const mission = makeMission({
      status: 'review',
      judgeVerdict: { score: 15, passed: false, risk: 'high', reviewers: [], createdAt: '2026-07-01T00:00:00.000Z' },
    });
    const prompt = buildManagerAdvicePrompt(mission);
    expect(prompt).toContain('rejetée par le juge');
    expect(prompt).toContain('15');
    expect(prompt).toContain('Plan alternatif :');
  });

  // R14 (this task, real live repro): a 'review' mission whose evaluator
  // rail failed entirely (scoreUnavailable — no judge/reviewer ever
  // produced a real score) must NEVER be described to the manager LLM as
  // "rejetée par le juge" — that claims a rejection the system never
  // actually reached. See approveGate.ts's checkApproveGate for the same
  // distinction applied to the human-facing merge-block message.
  it('describes a scoreUnavailable review mission as evaluation-unavailable, never as a judge rejection', () => {
    const mission = makeMission({
      status: 'review',
      judgeVerdict: { score: 0, passed: false, risk: 'high', reviewers: [], createdAt: '2026-07-01T00:00:00.000Z', scoreUnavailable: true },
    });
    const prompt = buildManagerAdvicePrompt(mission);
    expect(prompt).not.toContain('rejetée par le juge');
    expect(prompt).toContain("l'évaluation n'a pas pu être menée à bien");
    expect(prompt).toContain('PAS un rejet du juge');
    expect(prompt).toContain('Plan alternatif :');
  });
});

describe('extractAlternatePlan', () => {
  it('extracts the text after the "Plan alternatif :" marker', () => {
    const response = 'Diagnostic court.\n\nPlan alternatif : relance avec haiku sur le module auth.';
    expect(extractAlternatePlan(response)).toBe('relance avec haiku sur le module auth.');
  });

  it('is case-insensitive on the marker', () => {
    const response = 'PLAN ALTERNATIF : fais ceci à la place.';
    expect(extractAlternatePlan(response)).toBe('fais ceci à la place.');
  });

  it('falls back to the full trimmed text when the marker is absent', () => {
    const response = '  Juste un texte libre, sans marqueur.  ';
    expect(extractAlternatePlan(response)).toBe('Juste un texte libre, sans marqueur.');
  });
});

describe('buildRetryTaskWithRecommendation', () => {
  it('appends the recommendation to the mission agentTask when present', () => {
    const mission = makeMission({ agentTask: 'Implement the pricing table' });
    const result = buildRetryTaskWithRecommendation(mission, 'Use haiku and split the diff smaller');
    expect(result).toContain('Implement the pricing table');
    expect(result).toContain('Use haiku and split the diff smaller');
  });

  it('falls back to the mission title when agentTask is absent', () => {
    const mission = makeMission({ agentTask: undefined });
    const result = buildRetryTaskWithRecommendation(mission, 'Retry with more context');
    expect(result).toContain(mission.title);
    expect(result).toContain('Retry with more context');
  });
});
