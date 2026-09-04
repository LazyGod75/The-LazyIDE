/**
 * OrchestratorTree.test.ts — groupStepsIntoWaves (chantier 3, plan-first
 * canvas fix: OrchestratorTree used to render one flat ordered list,
 * destroying dependsOn's parallelism information). Pure function, no React
 * needed — see OrchestratorTree.tsx's own doc comment.
 */
import { describe, it, expect } from 'vitest';
import { groupStepsIntoWaves } from '../components/agents/orchestrator/OrchestratorTree';
import type { OrchestratorPlanStep } from '../lib/agents/types';

function step(overrides: Partial<OrchestratorPlanStep> & { id: string }): OrchestratorPlanStep {
  return {
    description: overrides.id,
    status: 'pending',
    missionIds: [],
    dependsOn: [],
    autonomyLevel: 'supervised',
    ...overrides,
  };
}

describe('groupStepsIntoWaves', () => {
  it('a strictly sequential plan produces one step per wave, in order', () => {
    const steps = [
      step({ id: 'a' }),
      step({ id: 'b', dependsOn: ['a'] }),
      step({ id: 'c', dependsOn: ['b'] }),
    ];
    const waves = groupStepsIntoWaves(steps);
    expect(waves.map((w) => w.map((s) => s.id))).toEqual([['a'], ['b'], ['c']]);
  });

  it('two steps depending on the SAME upstream step land in the same wave (parallel fan-out)', () => {
    const steps = [
      step({ id: 'a' }),
      step({ id: 'b', dependsOn: ['a'] }),
      step({ id: 'c', dependsOn: ['a'] }),
    ];
    const waves = groupStepsIntoWaves(steps);
    expect(waves).toHaveLength(2);
    expect(waves[0].map((s) => s.id)).toEqual(['a']);
    expect(waves[1].map((s) => s.id).sort()).toEqual(['b', 'c']);
  });

  it('a fan-in step (join) lands one wave past the LATEST of its dependencies', () => {
    const steps = [
      step({ id: 'a' }),
      step({ id: 'b' }), // no deps — same wave as 'a'
      step({ id: 'c', dependsOn: ['b'] }), // one wave past 'b'
      step({ id: 'd', dependsOn: ['a', 'c'] }), // past the LATEST dep (c), not 'a'
    ];
    const waves = groupStepsIntoWaves(steps);
    expect(waves.map((w) => w.map((s) => s.id).sort())).toEqual([['a', 'b'], ['c'], ['d']]);
  });

  it('every step is accounted for exactly once, and no wave is empty', () => {
    const steps = [
      step({ id: 'a' }),
      step({ id: 'b', dependsOn: ['a'] }),
      step({ id: 'c', dependsOn: ['a'] }),
      step({ id: 'd', dependsOn: ['b', 'c'] }),
    ];
    const waves = groupStepsIntoWaves(steps);
    const allIds = waves.flatMap((w) => w.map((s) => s.id));
    expect(allIds.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(waves.every((w) => w.length > 0)).toBe(true);
  });

  it('a dependsOn reference to an unknown step id degrades to "no dependency" rather than throwing', () => {
    const steps = [step({ id: 'a', dependsOn: ['ghost-does-not-exist'] })];
    expect(() => groupStepsIntoWaves(steps)).not.toThrow();
    expect(groupStepsIntoWaves(steps)).toEqual([[steps[0]]]);
  });

  it('an empty plan produces no waves', () => {
    expect(groupStepsIntoWaves([])).toEqual([]);
  });
});
