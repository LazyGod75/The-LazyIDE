/**
 * materializedPlanRepair.test.ts — hydrate-time repair for ALREADY-
 * MATERIALIZED (accepted) plan drafts/joins whose `projectId` disagrees
 * with the project the plan's own missions actually ran in
 * (materializedPlanRepair.ts's own module header). Pure, dependency-
 * injected tests — no Tauri, no real fs, same style as
 * canvasProposalCleanup.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  resolvePlanRealProjectId,
  findMismatchedPlanNodes,
  repairMaterializedPlanProjects,
  type MaterializedPlanRepairDeps,
  type OpenProjectHandle,
} from '../lib/agents/graph/materializedPlanRepair';
import type { DraftSpec, JoinSpec } from '../components/agents/canvas/canvasTypes';
import type { OrchestratorState, OrchestratorPlanStep } from '../lib/agents/types';

function makeStep(overrides: Partial<OrchestratorPlanStep> & { id: string }): OrchestratorPlanStep {
  return {
    description: overrides.id,
    status: 'pending',
    missionIds: [],
    dependsOn: [],
    autonomyLevel: 'supervised',
    ...overrides,
  };
}

function makeOrch(overrides?: Partial<OrchestratorState>): OrchestratorState {
  return {
    id: 'plan-1',
    name: 'Test plan',
    projectId: 'proj-lazy', // deliberately the WRONG zone in most fixtures below
    targetProjectIds: [],
    objective: 'Do the thing',
    steps: [],
    currentStep: 0,
    status: 'executing',
    budget: { spentCents: 0 },
    childMissionIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    autonomyLevel: 'supervised',
    ...overrides,
  };
}

function makeDraft(overrides: Partial<DraftSpec> & { id: string }): DraftSpec {
  return { title: overrides.id, task: 'do something', createdBy: 'manager', ...overrides };
}

describe('resolvePlanRealProjectId', () => {
  it('resolves the single real project every launched mission agrees on', () => {
    const orch = makeOrch({ childMissionIds: ['M1', 'M2'] });
    const missionProjectIds = new Map([['M1', 'proj-backoffice'], ['M2', 'proj-backoffice']]);
    expect(resolvePlanRealProjectId(orch, missionProjectIds)).toBe('proj-backoffice');
  });

  it('returns undefined for a plan with no launched missions yet — never guessed', () => {
    const orch = makeOrch({ childMissionIds: [] });
    expect(resolvePlanRealProjectId(orch, new Map())).toBeUndefined();
  });

  it('returns undefined when no launched mission is resolvable in the journal (race/mock env)', () => {
    const orch = makeOrch({ childMissionIds: ['M1'] });
    expect(resolvePlanRealProjectId(orch, new Map())).toBeUndefined();
  });

  it('returns undefined on conflicting evidence across missions — never picks one arbitrarily', () => {
    const orch = makeOrch({ childMissionIds: ['M1', 'M2'] });
    const missionProjectIds = new Map([['M1', 'proj-a'], ['M2', 'proj-b']]);
    expect(resolvePlanRealProjectId(orch, missionProjectIds)).toBeUndefined();
  });
});

describe('findMismatchedPlanNodes', () => {
  it('flags a still-materialized step draft whose projectId disagrees with the real project', () => {
    const orch = makeOrch({
      childMissionIds: ['M1'],
      steps: [
        makeStep({ id: 'plan-1-step-0', status: 'done', missionIds: ['M1'] }),
        makeStep({ id: 'plan-1-step-1', dependsOn: ['plan-1-step-0'] }),
      ],
    });
    const canvasState = {
      // step-0 already launched — no surviving draft (remapDraftToMission
      // removed it) — never flagged, nothing to fix there.
      drafts: [makeDraft({ id: 'plan-1-step-1', projectId: 'proj-lazy' })],
      joins: [] as JoinSpec[],
    };
    const result = findMismatchedPlanNodes(orch, 'proj-backoffice', canvasState);
    expect(result.draftIds).toEqual(['plan-1-step-1']);
    expect(result.joinIds).toEqual([]);
  });

  it('never flags a draft already correctly homed', () => {
    const orch = makeOrch({
      childMissionIds: ['M1'],
      steps: [makeStep({ id: 'plan-1-step-0' })],
    });
    const canvasState = {
      drafts: [makeDraft({ id: 'plan-1-step-0', projectId: 'proj-backoffice' })],
      joins: [] as JoinSpec[],
    };
    const result = findMismatchedPlanNodes(orch, 'proj-backoffice', canvasState);
    expect(result.draftIds).toEqual([]);
  });

  it('flags a mismatched join produced by a joinGroup of steps', () => {
    const orch = makeOrch({
      childMissionIds: ['M1'],
      steps: [
        makeStep({ id: 'plan-1-step-0', status: 'done', missionIds: ['M1'] }),
        makeStep({ id: 'plan-1-a', joinGroup: 'grp', dependsOn: ['plan-1-step-0'] }),
        makeStep({ id: 'plan-1-b', joinGroup: 'grp', dependsOn: ['plan-1-step-0'] }),
      ],
    });
    const canvasState = {
      drafts: [
        makeDraft({ id: 'plan-1-a', projectId: 'proj-lazy' }),
        makeDraft({ id: 'plan-1-b', projectId: 'proj-lazy' }),
      ],
      joins: [{ id: 'grp', sourceRefs: [], mode: 'all_success' as const, projectId: 'proj-lazy' }],
    };
    const result = findMismatchedPlanNodes(orch, 'proj-backoffice', canvasState);
    expect(result.draftIds.sort()).toEqual(['plan-1-a', 'plan-1-b']);
    expect(result.joinIds).toEqual(['grp']);
  });
});

describe('repairMaterializedPlanProjects', () => {
  function makeDeps(overrides?: Partial<MaterializedPlanRepairDeps>): {
    deps: MaterializedPlanRepairDeps;
    updatedDrafts: Array<{ id: string; projectId?: string }>;
    updatedJoins: Array<{ id: string; projectId?: string }>;
  } {
    const updatedDrafts: Array<{ id: string; projectId?: string }> = [];
    const updatedJoins: Array<{ id: string; projectId?: string }> = [];
    const deps: MaterializedPlanRepairDeps = {
      listOpenProjects: async (): Promise<OpenProjectHandle[]> => [{ projectId: 'proj-backoffice', root: '/root/backoffice' }],
      listOrchestrators: async () => [],
      fetchMissionProjectIds: async () => new Map(),
      getCanvasState: () => ({ drafts: [], joins: [] }),
      updateDraft: (id, patch) => updatedDrafts.push({ id, ...patch }),
      updateJoin: (id, patch) => updatedJoins.push({ id, ...patch }),
      ...overrides,
    };
    return { deps, updatedDrafts, updatedJoins };
  }

  it('re-homes a mid-execution plan whose remaining step lives in the wrong zone (the real-founder repro)', async () => {
    const orch = makeOrch({
      id: 'plan-backoffice',
      projectId: 'proj-lazy', // corrupted at creation time — the exact incident
      childMissionIds: ['M1'],
      steps: [
        makeStep({ id: 'plan-backoffice-step-0', status: 'done', missionIds: ['M1'] }),
        makeStep({ id: 'plan-backoffice-step-1', dependsOn: ['plan-backoffice-step-0'] }),
      ],
    });
    const { deps, updatedDrafts } = makeDeps({
      listOrchestrators: async (root) => (root === '/root/backoffice' ? [orch] : []),
      fetchMissionProjectIds: async () => new Map([['M1', 'proj-backoffice']]),
      getCanvasState: () => ({
        drafts: [makeDraft({ id: 'plan-backoffice-step-1', projectId: 'proj-lazy' })],
        joins: [],
      }),
    });

    const result = await repairMaterializedPlanProjects(deps);

    expect(updatedDrafts).toEqual([{ id: 'plan-backoffice-step-1', projectId: 'proj-backoffice' }]);
    expect(result.repaired).toEqual([
      { planId: 'plan-backoffice', projectId: 'proj-backoffice', draftIds: ['plan-backoffice-step-1'], joinIds: [] },
    ]);
  });

  it('never touches a plan with zero launched missions — no evidence, never guessed', async () => {
    const orch = makeOrch({
      id: 'plan-fresh',
      projectId: 'proj-lazy',
      childMissionIds: [],
      steps: [makeStep({ id: 'plan-fresh-step-0' })],
    });
    const { deps, updatedDrafts } = makeDeps({
      listOrchestrators: async () => [orch],
      getCanvasState: () => ({
        drafts: [makeDraft({ id: 'plan-fresh-step-0', projectId: 'proj-lazy' })],
        joins: [],
      }),
    });

    const result = await repairMaterializedPlanProjects(deps);
    expect(updatedDrafts).toEqual([]);
    expect(result.repaired).toEqual([]);
  });

  it('never touches a plan already correctly homed', async () => {
    const orch = makeOrch({
      id: 'plan-ok',
      projectId: 'proj-backoffice',
      childMissionIds: ['M1'],
      steps: [
        makeStep({ id: 'plan-ok-step-0', status: 'done', missionIds: ['M1'] }),
        makeStep({ id: 'plan-ok-step-1', dependsOn: ['plan-ok-step-0'] }),
      ],
    });
    const { deps, updatedDrafts } = makeDeps({
      listOrchestrators: async () => [orch],
      fetchMissionProjectIds: async () => new Map([['M1', 'proj-backoffice']]),
      getCanvasState: () => ({
        drafts: [makeDraft({ id: 'plan-ok-step-1', projectId: 'proj-backoffice' })],
        joins: [],
      }),
    });

    const result = await repairMaterializedPlanProjects(deps);
    expect(updatedDrafts).toEqual([]);
    expect(result.repaired).toEqual([]);
  });

  it('never opens any project when none are open — honest early exit', async () => {
    const { deps, updatedDrafts } = makeDeps({ listOpenProjects: async () => [] });
    const result = await repairMaterializedPlanProjects(deps);
    expect(updatedDrafts).toEqual([]);
    expect(result.repaired).toEqual([]);
  });

  it('a read failure on listOrchestrators is never treated as evidence — the plan is left alone', async () => {
    const { deps, updatedDrafts } = makeDeps({
      listOrchestrators: async () => {
        throw new Error('fs read failed');
      },
    });
    const result = await repairMaterializedPlanProjects(deps);
    expect(updatedDrafts).toEqual([]);
    expect(result.repaired).toEqual([]);
  });
});
