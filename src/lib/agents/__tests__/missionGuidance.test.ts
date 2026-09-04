/* missionGuidance.test.ts — unit tests for task-selection guardrails (G8)
   and the guided-workflow recommender (G7). */
import { describe, it, expect } from 'vitest';
import { classifyMissionFit, recommendGuidedWorkflow } from '../missionGuidance';

describe('classifyMissionFit', () => {
  it('flags high-taste UI work as poor-fit', () => {
    const v = classifyMissionFit('Refine the landing page animation and visual polish');
    expect(v.fit).toBe('poor-fit');
  });

  it('flags architecture decisions as poor-fit', () => {
    const v = classifyMissionFit('Choose the database schema design for the new billing service');
    expect(v.fit).toBe('poor-fit');
  });

  it('flags open-ended tasks as risky', () => {
    const v = classifyMissionFit('Improve the codebase');
    expect(v.fit).toBe('risky');
  });

  it('blesses mechanical tasks as good-fit', () => {
    const v = classifyMissionFit('Refactor class components to hooks and update the tests');
    expect(v.fit).toBe('good-fit');
  });

  it('rejects empty tasks', () => {
    expect(classifyMissionFit('   ').fit).toBe('poor-fit');
  });
});

describe('recommendGuidedWorkflow', () => {
  it('recommends a single run for a unit task', () => {
    const w = recommendGuidedWorkflow('Fix the login bug in auth.ts');
    expect(w.recommended).toBe(false);
    expect(w.steps).toContain('run');
  });

  it('recommends the full funnel for a large-scope task', () => {
    const w = recommendGuidedWorkflow('Refactor toutes les pages de l’application vers le nouveau design');
    expect(w.recommended).toBe(true);
    expect(w.steps).toEqual(['grill', 'spec', 'decompose', 'run', 'review']);
  });

  it('recommends the funnel for open-ended tasks', () => {
    const w = recommendGuidedWorkflow('Improve the onboarding flow');
    expect(w.recommended).toBe(true);
  });
});
