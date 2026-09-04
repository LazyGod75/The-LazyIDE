/* harnessLearning.test.ts — unit tests for the harness-compiles loop.
   Covers the PURE functions only (seed-worthiness, rule transition).
*/
import { describe, it, expect } from 'vitest';
import {
  candidateToRuleBody,
  isCandidateSeedWorthy,
  decideRuleTransition,
  LEARNED_RULE_PRIORITY,
} from '../harnessLearning';
import type { ImprovementCandidate } from '../frictionMiner';

const candidate = (partial: Partial<ImprovementCandidate>): ImprovementCandidate => ({
  id: 'friction-failed-x',
  projectId: 'projA',
  title: 'Recurring failure',
  rationale: '3 missions failed for the same reason in this project.',
  where: 'mission-execution',
  why: 'reason-x',
  suggestedTask: 'Investigate and fix the recurring failure cause: reason-x',
  evidence: ['M1', 'M2', 'M3', 'mission.failed'],
  severity: 'high',
  ...partial,
});

describe('candidateToRuleBody', () => {
  it('prefers the suggested task when it is a concrete instruction', () => {
    const body = candidateToRuleBody(candidate({ suggestedTask: 'Always run tests before merging' }));
    expect(body).toBe('Always run tests before merging');
  });

  it('falls back to the rationale when the suggested task is too short', () => {
    const body = candidateToRuleBody(candidate({ suggestedTask: 'Fix it' }));
    expect(body).toContain('missions failed');
  });
});

describe('isCandidateSeedWorthy', () => {
  it('seeds medium+ frictions backed by recurring evidence', () => {
    expect(isCandidateSeedWorthy(candidate({ severity: 'high' }))).toBe(true);
    expect(isCandidateSeedWorthy(candidate({ severity: 'medium' }))).toBe(true);
  });

  it('never seeds a single anecdotal failure', () => {
    expect(isCandidateSeedWorthy(candidate({ severity: 'low' }))).toBe(false);
    expect(isCandidateSeedWorthy(candidate({ evidence: ['M1'] }))).toBe(false);
  });
});

describe('decideRuleTransition', () => {
  it('promotes trial to proven only after 2+ helped and 0 harmed', () => {
    expect(decideRuleTransition('trial', { helped: 1, harmed: 0 }).next).toBe('trial');
    expect(decideRuleTransition('trial', { helped: 2, harmed: 0 }).next).toBe('proven');
    expect(decideRuleTransition('trial', { helped: 2, harmed: 1 }).next).toBe('trial');
  });

  it('evicts trial after 2+ harmed', () => {
    expect(decideRuleTransition('trial', { helped: 0, harmed: 2 }).next).toBe('evicted');
    expect(decideRuleTransition('trial', { helped: 2, harmed: 2 }).next).toBe('evicted');
  });

  it('evicts proven only after a 3+ harm streak', () => {
    expect(decideRuleTransition('proven', { helped: 5, harmed: 2 }).next).toBe('proven');
    expect(decideRuleTransition('proven', { helped: 5, harmed: 3 }).next).toBe('evicted');
  });

  it('never changes an evicted rule', () => {
    const r = decideRuleTransition('evicted', { helped: 9, harmed: 0 });
    expect(r.next).toBe('evicted');
    expect(r.changed).toBe(false);
  });
});

describe('learned rule metadata', () => {
  it('learned rules carry a stable priority', () => {
    expect(LEARNED_RULE_PRIORITY).toBe(70);
  });
});
