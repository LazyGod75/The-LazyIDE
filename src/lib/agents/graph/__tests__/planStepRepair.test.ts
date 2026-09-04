/**
 * Tests for graph/planStepRepair.ts (P0 crash, round 3, P2) — the pure
 * repair pass agentsStore.tsx's `generate_plan` case runs BEFORE
 * createOrchestrator persists a plan's steps. See that module's own
 * header for the full mechanism this closes.
 */

import { describe, it, expect } from 'vitest';
import { repairPlanSteps } from '../planStepRepair';
import type { OrchestratorPlanStepInput } from '../../types';

function idFactory(): (prefix: string) => string {
  let counter = 0;
  return (prefix: string) => {
    counter += 1;
    return `${prefix}-fresh${counter}`;
  };
}

describe('repairPlanSteps', () => {
  it('is a no-op for a well-formed plan (unique ids, valid dependsOn)', () => {
    const steps: OrchestratorPlanStepInput[] = [
      { id: 'audit', description: 'Audit the codebase' },
      { id: 'fix', description: 'Fix findings', dependsOn: ['audit'] },
    ];
    const result = repairPlanSteps(steps, new Set(), idFactory());
    expect(result.notes).toEqual([]);
    expect(result.steps).toEqual(steps);
  });

  it('leaves a step with no explicit id untouched (createOrchestrator\'s own fallback already guarantees uniqueness)', () => {
    const steps: OrchestratorPlanStepInput[] = [{ description: 'Do something' }];
    const result = repairPlanSteps(steps, new Set(), idFactory());
    expect(result.steps).toEqual(steps);
    expect(result.notes).toEqual([]);
  });

  it('renames the SECOND step when two steps in the SAME plan reuse an id, and keeps a sibling dependsOn edge alive by following the rename', () => {
    const steps: OrchestratorPlanStepInput[] = [
      { id: 'audit', description: 'First audit' },
      { id: 'audit', description: 'Second audit (typo/model slip)' },
      { id: 'fix', description: 'Fix', dependsOn: ['audit'] },
    ];
    const result = repairPlanSteps(steps, new Set(), idFactory());

    expect(result.steps[0].id).toBe('audit'); // first occupant untouched
    expect(result.steps[1].id).toBe('step-fresh1');
    expect(result.steps[1].description).toBe('Second audit (typo/model slip)'); // repaired, not dropped
    // A same-plan self-collision has no way to disambiguate which "audit"
    // a sibling's dependsOn meant (unlike a cross-plan collision via
    // takenIds — see the next test — where there is only ever ONE "audit"
    // inside this plan to begin with, so no ambiguity exists there): the
    // rename is applied uniformly, keeping the dependency edge ALIVE
    // (pointing at whichever step actually needed it) rather than
    // arbitrarily left on the id that happened to keep its original name.
    expect(result.steps[2].dependsOn).toEqual(['step-fresh1']);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('THE ACTUAL BUG: a step id colliding with something already live on the canvas (a DIFFERENT, earlier plan) gets renamed via takenIds', () => {
    const steps: OrchestratorPlanStepInput[] = [{ id: 'audit', description: 'Audit again, different plan' }];
    const takenIds = new Set(['audit']); // an EARLIER plan's still-pending "audit" draft
    const result = repairPlanSteps(steps, takenIds, idFactory());

    expect(result.steps[0].id).not.toBe('audit');
    expect(result.steps[0].id).toBe('step-fresh1');
    expect(result.notes[0]).toContain('audit');
  });

  it('drops a dependsOn entry that references a step id nothing in this plan actually defines', () => {
    const steps: OrchestratorPlanStepInput[] = [
      { id: 'a', description: 'A' },
      { id: 'b', description: 'B', dependsOn: ['a', 'ghost-step'] },
    ];
    const result = repairPlanSteps(steps, new Set(), idFactory());

    expect(result.steps[1].dependsOn).toEqual(['a']);
    expect(result.notes.some((n) => n.includes('ghost-step'))).toBe(true);
  });

  it('a dependsOn naming a step that itself got renamed (both in this SAME plan) follows the rename instead of being dropped', () => {
    const steps: OrchestratorPlanStepInput[] = [
      { id: 'audit', description: 'First' },
      { id: 'audit', description: 'Second' }, // collides -> renamed to step-fresh1
      { id: 'wave2', description: 'Waits on the audit step', dependsOn: ['step-fresh1'] },
    ];
    // A model would never predict "step-fresh1" itself, but this locks in
    // the mechanism regardless: once a rename happens, a dependsOn entry
    // that already names the NEW id (e.g. a multi-turn revise_plan the
    // model echoed back) still resolves — it is a real, defined id after
    // repair, never dropped as dangling.
    const result = repairPlanSteps(steps, new Set(), idFactory());
    expect(result.steps[2].dependsOn).toEqual(['step-fresh1']);
  });

  it('never mutates the input array', () => {
    const steps: OrchestratorPlanStepInput[] = [
      { id: 'audit', description: 'First' },
      { id: 'audit', description: 'Second' },
    ];
    const snapshot = JSON.parse(JSON.stringify(steps));
    repairPlanSteps(steps, new Set(), idFactory());
    expect(steps).toEqual(snapshot);
  });
});
