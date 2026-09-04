/**
 * canvasProposalCleanup.test.ts — hydrate-time migration for stale/mis-homed
 * plan-proposal previews (canvasProposalCleanup.ts's own module header).
 *
 * Real founder state this fixes (2026-08-01/02): 49 stale preview nodes from
 * 5 un-launched `generate_plan` proposals, some materialized into the WRONG
 * project's zone. Pure, dependency-injected tests — no Tauri, no real fs.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  collectProposedPlanGroups,
  inferReHomeTarget,
  cleanupStaleProposedPreviews,
  type OpenProjectRef,
  type CleanupStaleProposalsDeps,
} from '../components/agents/canvas/canvasProposalCleanup';
import type { DraftSpec, JoinSpec } from '../components/agents/canvas/canvasTypes';
import type { OrchestratorState } from '../lib/agents/types';

function makeDraft(overrides: Partial<DraftSpec> & { id: string }): DraftSpec {
  return {
    title: overrides.id,
    task: 'do something',
    createdBy: 'manager',
    ...overrides,
  };
}

function makeJoin(overrides: Partial<JoinSpec> & { id: string }): JoinSpec {
  return {
    sourceRefs: [],
    mode: 'all_success',
    ...overrides,
  };
}

function makeOrch(overrides?: Partial<OrchestratorState>): OrchestratorState {
  return {
    id: 'orch-1',
    name: 'Test plan',
    projectId: 'proj-a',
    targetProjectIds: [],
    objective: 'Do the thing',
    steps: [],
    currentStep: 0,
    status: 'planning',
    budget: { spentCents: 0 },
    childMissionIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    autonomyLevel: 'supervised',
    ...overrides,
  };
}

describe('collectProposedPlanGroups', () => {
  it('groups drafts/joins by proposedPlanId, reading projectId off a tagged draft', () => {
    const groups = collectProposedPlanGroups({
      drafts: [
        makeDraft({ id: 'd1', proposedPlanId: 'plan-a', projectId: 'proj-a' }),
        makeDraft({ id: 'd2', proposedPlanId: 'plan-a', projectId: 'proj-a' }),
        makeDraft({ id: 'd3' }), // no proposedPlanId — real/normal draft, never grouped
      ],
      joins: [],
    });
    expect(groups).toEqual([{ planId: 'plan-a', projectId: 'proj-a' }]);
  });

  it('reads projectId off a tagged join when no draft carries one', () => {
    const groups = collectProposedPlanGroups({
      drafts: [],
      joins: [makeJoin({ id: 'j1', proposedPlanId: 'plan-b', projectId: 'proj-b' })],
    });
    expect(groups).toEqual([{ planId: 'plan-b', projectId: 'proj-b' }]);
  });

  it('returns an empty projectId (never guessed) for a plan with no resolvable project on any tagged node', () => {
    const groups = collectProposedPlanGroups({
      drafts: [makeDraft({ id: 'd1', proposedPlanId: 'plan-c' })],
      joins: [],
    });
    expect(groups).toEqual([{ planId: 'plan-c', projectId: '' }]);
  });

  it('separates multiple distinct plans into distinct groups', () => {
    const groups = collectProposedPlanGroups({
      drafts: [
        makeDraft({ id: 'd1', proposedPlanId: 'plan-a', projectId: 'proj-a' }),
        makeDraft({ id: 'd2', proposedPlanId: 'plan-b', projectId: 'proj-b' }),
      ],
      joins: [],
    });
    expect(groups.sort((a, b) => a.planId.localeCompare(b.planId))).toEqual([
      { planId: 'plan-a', projectId: 'proj-a' },
      { planId: 'plan-b', projectId: 'proj-b' },
    ]);
  });
});

// ── inferReHomeTarget — POST-INCIDENT regression coverage (2026-08-02) ──
//
// Real incident: the FIRST version matched on a bare project NAME. Live,
// this swept an ALREADY-correctly-homed 11-node plan (and others) into a
// project literally named `Lazy`, because every real objective in this
// product naturally contains the word "Lazy" ("finir le backoffice de
// Lazy", "améliorer le site vitrine de Lazy", "promouvoir Lazy") and there
// is an open project with that exact name. Matching now requires the
// OTHER project's real, absolute ROOT PATH to appear verbatim in the text
// — a product/project NAME alone (however exact) is never enough.
describe('inferReHomeTarget', () => {
  const openProjects: OpenProjectRef[] = [
    { projectId: 'proj-backoffice', root: 'C:\\Users\\user\\Documents\\cerveau\\lazy-backoffice', name: 'lazy-backoffice' },
    { projectId: 'proj-site', root: 'C:\\Users\\user\\Documents\\cerveau\\LazySite-internet', name: 'LazySite-internet' },
    { projectId: 'proj-marketing', root: 'C:\\Users\\user\\Documents\\cerveau\\lazy-marketng', name: 'lazy-marketng' },
    { projectId: 'proj-lazy', root: 'C:\\Users\\user\\Documents\\cerveau\\Lazy', name: 'Lazy' },
  ];

  it('THE INCIDENT, reproduced with the founder\'s real strings: a plan correctly homed in backoffice, whose objective names the PRODUCT ("Lazy") which also happens to be an open project, is NEVER re-homed', () => {
    const orch = makeOrch({
      projectId: 'proj-backoffice',
      name: 'Backoffice plan',
      objective: 'finir le backoffice de Lazy',
    });
    expect(inferReHomeTarget(orch, openProjects)).toBeUndefined();
  });

  it('the founder\'s "site vitrine" objective (also names the product "Lazy") is NEVER re-homed either — no bare-name match at all', () => {
    const orch = makeOrch({
      projectId: 'proj-backoffice', // wrong zone in reality, but no PATH is present in the text
      name: 'Site plan',
      objective: 'améliorer le site vitrine de Lazy',
    });
    expect(inferReHomeTarget(orch, openProjects)).toBeUndefined();
  });

  it('a bare "promouvoir Lazy" objective matches nothing — the product name alone is never a signal', () => {
    const orch = makeOrch({ projectId: 'proj-backoffice', name: 'Marketing plan', objective: 'promouvoir Lazy' });
    expect(inferReHomeTarget(orch, openProjects)).toBeUndefined();
  });

  it('matches ONLY when the objective embeds the OTHER project\'s real absolute root path', () => {
    const orch = makeOrch({
      projectId: 'proj-backoffice',
      name: 'Site plan',
      objective: 'Ship the homepage redesign for C:\\Users\\user\\Documents\\cerveau\\LazySite-internet',
    });
    expect(inferReHomeTarget(orch, openProjects)?.projectId).toBe('proj-site');
  });

  it('is tolerant to slash direction/case (same path, different spelling) — still a real path match, not a name match', () => {
    const orch = makeOrch({
      projectId: 'proj-backoffice',
      name: 'Site plan',
      objective: 'work inside c:/users/david/documents/cerveau/lazysite-internet please',
    });
    expect(inferReHomeTarget(orch, openProjects)?.projectId).toBe('proj-site');
  });

  it('returns undefined when the CURRENT project\'s own root path is itself present — never overrides a real self-mention', () => {
    const orch = makeOrch({
      projectId: 'proj-backoffice',
      name: 'Backoffice fix',
      objective: 'Repair C:\\Users\\user\\Documents\\cerveau\\lazy-backoffice\\admin panel',
    });
    expect(inferReHomeTarget(orch, openProjects)).toBeUndefined();
  });

  it('returns undefined when MORE THAN ONE other project\'s root path is present — ambiguous, never guessed', () => {
    const orch = makeOrch({
      projectId: 'proj-backoffice',
      name: 'Cross-project sync',
      objective: 'Sync C:\\Users\\user\\Documents\\cerveau\\LazySite-internet content into C:\\Users\\user\\Documents\\cerveau\\lazy-marketng campaigns',
    });
    expect(inferReHomeTarget(orch, openProjects)).toBeUndefined();
  });

  it('refuses a root path shorter than the minimum match length, even if it technically appears', () => {
    const shortOpenProjects: OpenProjectRef[] = [
      { projectId: 'proj-a', root: 'C:/a', name: 'a' },
      { projectId: 'proj-b', root: 'C:/b/site', name: 'site' },
    ];
    const orch = makeOrch({ projectId: 'proj-a', name: 'plan', objective: 'do stuff at C:/a and elsewhere' });
    expect(inferReHomeTarget(orch, shortOpenProjects)).toBeUndefined();
  });
});

describe('cleanupStaleProposedPreviews', () => {
  function makeDeps(overrides?: Partial<CleanupStaleProposalsDeps>): {
    deps: CleanupStaleProposalsDeps;
    rejected: string[];
    retagged: Array<{ planId: string; projectId: string }>;
    relocated: Array<{ fromRoot: string; toRoot: string; orchId: string; newProjectId: string }>;
  } {
    const rejected: string[] = [];
    const retagged: Array<{ planId: string; projectId: string }> = [];
    const relocated: Array<{ fromRoot: string; toRoot: string; orchId: string; newProjectId: string }> = [];
    const deps: CleanupStaleProposalsDeps = {
      getCanvasState: () => ({ drafts: [], joins: [] }),
      rejectProposedPlan: (planId) => rejected.push(planId),
      retagProposedPlanProject: (planId, projectId) => retagged.push({ planId, projectId }),
      listOpenProjects: async () => [{ projectId: 'proj-a', root: '/root/a', name: 'proj-a' }],
      getOrchestrator: async () => undefined,
      relocateOrchestrator: async (fromRoot, toRoot, orch, newProjectId) => {
        relocated.push({ fromRoot, toRoot, orchId: orch.id, newProjectId });
      },
      ...overrides,
    };
    return { deps, rejected, retagged, relocated };
  }

  it('removes a preview whose orchestrator no longer exists', async () => {
    const { deps, rejected } = makeDeps({
      getCanvasState: () => ({
        drafts: [makeDraft({ id: 'd1', proposedPlanId: 'plan-gone', projectId: 'proj-a' })],
        joins: [],
      }),
      getOrchestrator: async () => undefined,
    });
    const result = await cleanupStaleProposedPreviews(deps);
    expect(rejected).toEqual(['plan-gone']);
    expect(result.cleaned).toEqual([{ planId: 'plan-gone', projectId: 'proj-a', reason: 'orchestrator-missing' }]);
  });

  it('removes a preview whose orchestrator moved on past "planning" without ever clearing the stamp', async () => {
    const { deps, rejected } = makeDeps({
      getCanvasState: () => ({
        drafts: [makeDraft({ id: 'd1', proposedPlanId: 'plan-advanced', projectId: 'proj-a' })],
        joins: [],
      }),
      getOrchestrator: async () => makeOrch({ id: 'plan-advanced', projectId: 'proj-a', status: 'executing' }),
    });
    const result = await cleanupStaleProposedPreviews(deps);
    expect(rejected).toEqual(['plan-advanced']);
    expect(result.cleaned).toEqual([{ planId: 'plan-advanced', projectId: 'proj-a', reason: 'orchestrator-advanced' }]);
  });

  it('leaves a still-planning, correctly-homed proposal alone — never deleted, never touched', async () => {
    const { deps, rejected, retagged } = makeDeps({
      getCanvasState: () => ({
        drafts: [makeDraft({ id: 'd1', proposedPlanId: 'plan-live', projectId: 'proj-a' })],
        joins: [],
      }),
      getOrchestrator: async () => makeOrch({ id: 'plan-live', projectId: 'proj-a', status: 'planning', name: 'plan', objective: 'do it' }),
    });
    const result = await cleanupStaleProposedPreviews(deps);
    expect(rejected).toEqual([]);
    expect(retagged).toEqual([]);
    expect(result.cleaned).toEqual([]);
  });

  it('never guesses a projectId for a group with none resolvable — leaves it alone', async () => {
    const { deps, rejected } = makeDeps({
      getCanvasState: () => ({
        drafts: [makeDraft({ id: 'd1', proposedPlanId: 'plan-x' })], // no projectId anywhere
        joins: [],
      }),
      getOrchestrator: vi.fn(),
    });
    const result = await cleanupStaleProposedPreviews(deps);
    expect(rejected).toEqual([]);
    expect(deps.getOrchestrator).not.toHaveBeenCalled();
    expect(result.cleaned).toEqual([]);
  });

  it('leaves a group alone whose project is not open this session — retried later, never deleted on ambiguity', async () => {
    const { deps, rejected } = makeDeps({
      getCanvasState: () => ({
        drafts: [makeDraft({ id: 'd1', proposedPlanId: 'plan-y', projectId: 'proj-not-open' })],
        joins: [],
      }),
      listOpenProjects: async () => [{ projectId: 'proj-a', root: '/root/a', name: 'proj-a' }],
      getOrchestrator: vi.fn(),
    });
    const result = await cleanupStaleProposedPreviews(deps);
    expect(rejected).toEqual([]);
    expect(deps.getOrchestrator).not.toHaveBeenCalled();
    expect(result.cleaned).toEqual([]);
  });

  it('DEFAULT (enableReHome omitted): a still-planning proposal is NEVER re-homed, even when the objective embeds an unambiguous absolute path to another open project — re-home is opt-in only (post-incident fix)', async () => {
    const orch = makeOrch({
      id: 'plan-site',
      projectId: 'proj-backoffice',
      status: 'planning',
      name: 'Site plan',
      objective: 'Ship the homepage for C:\\root\\site',
    });
    const { deps, retagged, relocated, rejected } = makeDeps({
      getCanvasState: () => ({
        drafts: [makeDraft({ id: 'd1', proposedPlanId: 'plan-site', projectId: 'proj-backoffice' })],
        joins: [],
      }),
      listOpenProjects: async () => [
        { projectId: 'proj-backoffice', root: 'C:\\root\\backoffice', name: 'lazy-backoffice' },
        { projectId: 'proj-site', root: 'C:\\root\\site', name: 'LazySite-internet' },
      ],
      getOrchestrator: async (root) => (root === 'C:\\root\\backoffice' ? orch : undefined),
      // enableReHome intentionally NOT set — this is the real production default.
    });
    const result = await cleanupStaleProposedPreviews(deps);
    expect(rejected).toEqual([]);
    expect(retagged).toEqual([]);
    expect(relocated).toEqual([]);
    expect(result.cleaned).toEqual([]);
  });

  it('enableReHome:true — re-homes a still-planning proposal whose objective embeds a DIFFERENT open project\'s real absolute path, relocating the orchestrator record too', async () => {
    const orch = makeOrch({
      id: 'plan-site',
      projectId: 'proj-backoffice',
      status: 'planning',
      name: 'Site plan',
      objective: 'Ship the homepage for C:\\root\\site',
    });
    const { deps, retagged, relocated, rejected } = makeDeps({
      enableReHome: true,
      getCanvasState: () => ({
        drafts: [makeDraft({ id: 'd1', proposedPlanId: 'plan-site', projectId: 'proj-backoffice' })],
        joins: [],
      }),
      listOpenProjects: async () => [
        { projectId: 'proj-backoffice', root: 'C:\\root\\backoffice', name: 'lazy-backoffice' },
        { projectId: 'proj-site', root: 'C:\\root\\site', name: 'LazySite-internet' },
      ],
      getOrchestrator: async (root) => (root === 'C:\\root\\backoffice' ? orch : undefined),
    });
    const result = await cleanupStaleProposedPreviews(deps);
    expect(rejected).toEqual([]); // re-homed, not deleted
    expect(retagged).toEqual([{ planId: 'plan-site', projectId: 'proj-site' }]);
    expect(relocated).toEqual([{ fromRoot: 'C:\\root\\backoffice', toRoot: 'C:\\root\\site', orchId: 'plan-site', newProjectId: 'proj-site' }]);
    expect(result.cleaned).toEqual([
      { planId: 'plan-site', projectId: 'proj-backoffice', reason: 'rehomed', newProjectId: 'proj-site' },
    ]);
  });

  it('enableReHome:true — never re-homes a plan whose objective only names the PRODUCT ("Lazy"), the exact incident this all fixes', async () => {
    const orch = makeOrch({
      id: 'plan-backoffice',
      projectId: 'proj-backoffice',
      status: 'planning',
      name: 'Backoffice plan',
      objective: 'finir le backoffice de Lazy',
    });
    const { deps, retagged, relocated, rejected } = makeDeps({
      enableReHome: true,
      getCanvasState: () => ({
        drafts: [makeDraft({ id: 'd1', proposedPlanId: 'plan-backoffice', projectId: 'proj-backoffice' })],
        joins: [],
      }),
      listOpenProjects: async () => [
        { projectId: 'proj-backoffice', root: 'C:\\root\\lazy-backoffice', name: 'lazy-backoffice' },
        { projectId: 'proj-lazy', root: 'C:\\root\\Lazy', name: 'Lazy' },
      ],
      getOrchestrator: async () => orch,
    });
    const result = await cleanupStaleProposedPreviews(deps);
    // Correctly homed to begin with, and stays exactly there — no false move.
    expect(rejected).toEqual([]);
    expect(retagged).toEqual([]);
    expect(relocated).toEqual([]);
    expect(result.cleaned).toEqual([]);
  });

  it('enableReHome:true — never re-homes a plan that already has real child missions (already launched work) — leaves it alone', async () => {
    const orch = makeOrch({
      id: 'plan-launched',
      projectId: 'proj-backoffice',
      status: 'planning', // hypothetical inconsistency — still guarded by childMissionIds
      name: 'Site plan',
      objective: 'Ship the homepage for C:\\root\\site',
      childMissionIds: ['M1'],
    });
    const { deps, retagged, relocated, rejected } = makeDeps({
      enableReHome: true,
      getCanvasState: () => ({
        drafts: [makeDraft({ id: 'd1', proposedPlanId: 'plan-launched', projectId: 'proj-backoffice' })],
        joins: [],
      }),
      listOpenProjects: async () => [
        { projectId: 'proj-backoffice', root: 'C:\\root\\backoffice', name: 'lazy-backoffice' },
        { projectId: 'proj-site', root: 'C:\\root\\site', name: 'LazySite-internet' },
      ],
      getOrchestrator: async () => orch,
    });
    const result = await cleanupStaleProposedPreviews(deps);
    expect(rejected).toEqual([]);
    expect(retagged).toEqual([]);
    expect(relocated).toEqual([]);
    expect(result.cleaned).toEqual([]);
  });

  it('a read failure on getOrchestrator is never treated as evidence of absence — the preview is left alone', async () => {
    const { deps, rejected } = makeDeps({
      getCanvasState: () => ({
        drafts: [makeDraft({ id: 'd1', proposedPlanId: 'plan-z', projectId: 'proj-a' })],
        joins: [],
      }),
      getOrchestrator: async () => {
        throw new Error('fs read failed');
      },
    });
    const result = await cleanupStaleProposedPreviews(deps);
    expect(rejected).toEqual([]);
    expect(result.cleaned).toEqual([]);
  });

  it('never touches a draft with no proposedPlanId at all (real, non-proposal canvas content)', async () => {
    const { deps, rejected } = makeDeps({
      getCanvasState: () => ({
        drafts: [makeDraft({ id: 'real-draft', projectId: 'proj-a' })],
        joins: [],
      }),
      getOrchestrator: vi.fn(),
    });
    const result = await cleanupStaleProposedPreviews(deps);
    expect(rejected).toEqual([]);
    expect(deps.getOrchestrator).not.toHaveBeenCalled();
    expect(result.cleaned).toEqual([]);
  });

  // ── Stale-proposal sweep (2026-08-04) — real founder state: 21 orphaned
  // drafts from plans re-proposed several times, each still 'planning'
  // forever with no automatic or manager-side way to clear any of them.
  describe('stale-proposal sweep — age', () => {
    it('purges a still-planning proposal older than 24h, reason proposal-stale', async () => {
      const now = Date.now();
      const orch = makeOrch({
        id: 'plan-old',
        projectId: 'proj-a',
        status: 'planning',
        createdAt: now - 25 * 60 * 60 * 1000,
      });
      const { deps, rejected } = makeDeps({
        getCanvasState: () => ({
          drafts: [makeDraft({ id: 'd1', proposedPlanId: 'plan-old', projectId: 'proj-a' })],
          joins: [],
        }),
        getOrchestrator: async () => orch,
      });
      const result = await cleanupStaleProposedPreviews(deps, now);
      expect(rejected).toEqual(['plan-old']);
      expect(result.cleaned).toEqual([{ planId: 'plan-old', projectId: 'proj-a', reason: 'proposal-stale' }]);
    });

    it('does NOT purge a still-planning proposal created just under 24h ago', async () => {
      const now = Date.now();
      const orch = makeOrch({
        id: 'plan-recent',
        projectId: 'proj-a',
        status: 'planning',
        createdAt: now - 23 * 60 * 60 * 1000,
      });
      const { deps, rejected } = makeDeps({
        getCanvasState: () => ({
          drafts: [makeDraft({ id: 'd1', proposedPlanId: 'plan-recent', projectId: 'proj-a' })],
          joins: [],
        }),
        getOrchestrator: async () => orch,
      });
      const result = await cleanupStaleProposedPreviews(deps, now);
      expect(rejected).toEqual([]);
      expect(result.cleaned).toEqual([]);
    });
  });

  describe('stale-proposal sweep — same-project duplicate (the 21-orphaned-drafts incident)', () => {
    it('keeps only the most recently created still-planning proposal when two target the same project', async () => {
      const now = Date.now();
      const older = makeOrch({
        id: 'plan-a-old',
        projectId: 'proj-a',
        status: 'planning',
        createdAt: now - 2 * 60 * 60 * 1000,
      });
      const newer = makeOrch({
        id: 'plan-a-new',
        projectId: 'proj-a',
        status: 'planning',
        createdAt: now - 1 * 60 * 60 * 1000,
      });
      const { deps, rejected } = makeDeps({
        getCanvasState: () => ({
          drafts: [
            makeDraft({ id: 'd1', proposedPlanId: 'plan-a-old', projectId: 'proj-a' }),
            makeDraft({ id: 'd2', proposedPlanId: 'plan-a-new', projectId: 'proj-a' }),
          ],
          joins: [],
        }),
        getOrchestrator: async (_root, planId) => (planId === 'plan-a-old' ? older : newer),
      });
      const result = await cleanupStaleProposedPreviews(deps, now);
      expect(rejected).toEqual(['plan-a-old']);
      expect(result.cleaned).toEqual([
        { planId: 'plan-a-old', projectId: 'proj-a', reason: 'proposal-superseded' },
      ]);
    });

    it('leaves two still-planning proposals alone when they target DIFFERENT projects', async () => {
      const now = Date.now();
      const a = makeOrch({ id: 'plan-a', projectId: 'proj-a', status: 'planning', createdAt: now - 60_000 });
      const b = makeOrch({ id: 'plan-b', projectId: 'proj-b', status: 'planning', createdAt: now - 120_000 });
      const { deps, rejected } = makeDeps({
        getCanvasState: () => ({
          drafts: [
            makeDraft({ id: 'd1', proposedPlanId: 'plan-a', projectId: 'proj-a' }),
            makeDraft({ id: 'd2', proposedPlanId: 'plan-b', projectId: 'proj-b' }),
          ],
          joins: [],
        }),
        listOpenProjects: async () => [
          { projectId: 'proj-a', root: '/root/a', name: 'a' },
          { projectId: 'proj-b', root: '/root/b', name: 'b' },
        ],
        getOrchestrator: async (root) => (root === '/root/a' ? a : b),
      });
      const result = await cleanupStaleProposedPreviews(deps, now);
      expect(rejected).toEqual([]);
      expect(result.cleaned).toEqual([]);
    });

    it('reports an aged duplicate as proposal-stale (age sweep runs first), never double-purging the survivor', async () => {
      // Reproduces the real "21 orphaned drafts" shape more closely: one
      // ancient proposal (>24h) plus one fresh re-ask for the SAME project.
      // The ancient one is purged by the AGE sweep; the fresh one survives
      // untouched (only one live proposal remains for that project, so the
      // duplicate sweep never fires for it).
      const now = Date.now();
      const ancient = makeOrch({
        id: 'plan-ancient',
        projectId: 'proj-a',
        status: 'planning',
        createdAt: now - 48 * 60 * 60 * 1000,
      });
      const fresh = makeOrch({
        id: 'plan-fresh',
        projectId: 'proj-a',
        status: 'planning',
        createdAt: now - 60_000,
      });
      const { deps, rejected } = makeDeps({
        getCanvasState: () => ({
          drafts: [
            makeDraft({ id: 'd1', proposedPlanId: 'plan-ancient', projectId: 'proj-a' }),
            makeDraft({ id: 'd2', proposedPlanId: 'plan-fresh', projectId: 'proj-a' }),
          ],
          joins: [],
        }),
        getOrchestrator: async (_root, planId) => (planId === 'plan-ancient' ? ancient : fresh),
      });
      const result = await cleanupStaleProposedPreviews(deps, now);
      expect(rejected).toEqual(['plan-ancient']);
      expect(result.cleaned).toEqual([
        { planId: 'plan-ancient', projectId: 'proj-a', reason: 'proposal-stale' },
      ]);
    });
  });
});
