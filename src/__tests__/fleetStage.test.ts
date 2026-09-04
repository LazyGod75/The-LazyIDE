import { describe, it, expect } from 'vitest';
import { deriveFleetStage, isUrgentMission } from '../lib/agents/fleetStage';
import type { Mission, PlanStep } from '../lib/agents/types';

function step(state: PlanStep['state']): PlanStep {
  return { label: 'x', state };
}

function baseMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'm1',
    title: 'Test mission',
    status: 'running',
    model: 'sonnet',
    ...overrides,
  };
}

describe('deriveFleetStage', () => {
  it('maps status "done" to merged', () => {
    expect(deriveFleetStage(baseMission({ status: 'done' }))).toBe('merged');
  });

  it('maps merged=true to merged regardless of status', () => {
    expect(deriveFleetStage(baseMission({ status: 'running', merged: true }))).toBe('merged');
  });

  it('maps status "review" to review', () => {
    expect(deriveFleetStage(baseMission({ status: 'review' }))).toBe('review');
  });

  it('maps a recorded judge verdict to test', () => {
    const mission = baseMission({
      judgeVerdict: { score: 0.9, passed: true, risk: 'low', reviewers: [], createdAt: 'now' },
    });
    expect(deriveFleetStage(mission)).toBe('test');
  });

  it('maps no plan steps to plan', () => {
    expect(deriveFleetStage(baseMission({ planSteps: [] }))).toBe('plan');
    expect(deriveFleetStage(baseMission({}))).toBe('plan');
  });

  it('maps all plan steps todo to plan', () => {
    const mission = baseMission({ planSteps: [step('todo'), step('todo')] });
    expect(deriveFleetStage(mission)).toBe('plan');
  });

  it('maps some plan steps done/in_progress to code', () => {
    expect(deriveFleetStage(baseMission({ planSteps: [step('done'), step('todo')] }))).toBe('code');
    expect(deriveFleetStage(baseMission({ planSteps: [step('in_progress'), step('todo')] }))).toBe('code');
  });

  it('maps all plan steps done (no judge yet) to test', () => {
    const mission = baseMission({ planSteps: [step('done'), step('done')] });
    expect(deriveFleetStage(mission)).toBe('test');
  });

  it('a failed mission still reflects how far it got (code, not a fixed column)', () => {
    const mission = baseMission({ status: 'failed', planSteps: [step('done'), step('todo')] });
    expect(deriveFleetStage(mission)).toBe('code');
  });

  it('a failed mission with a judge verdict lands in test', () => {
    const mission = baseMission({
      status: 'failed',
      judgeVerdict: { score: 0.2, passed: false, risk: 'high', reviewers: [], createdAt: 'now' },
    });
    expect(deriveFleetStage(mission)).toBe('test');
  });
});

describe('isUrgentMission', () => {
  it('is true for failed', () => {
    expect(isUrgentMission({ status: 'failed' })).toBe(true);
  });

  it('is true for review', () => {
    expect(isUrgentMission({ status: 'review' })).toBe(true);
  });

  it('is false for queued/running/done/cancelled', () => {
    expect(isUrgentMission({ status: 'queued' })).toBe(false);
    expect(isUrgentMission({ status: 'running' })).toBe(false);
    expect(isUrgentMission({ status: 'done' })).toBe(false);
    expect(isUrgentMission({ status: 'cancelled' })).toBe(false);
  });
});
