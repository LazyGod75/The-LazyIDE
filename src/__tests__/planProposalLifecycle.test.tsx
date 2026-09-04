/**
 * planProposalLifecycle.test.tsx — real lifecycle for `generate_plan`
 * proposal previews (2026-08-02 fix).
 *
 * The founder moved something on the canvas and believed the drag had
 * duplicated the graph. It hadn't: proposed plans had no lifecycle at
 * all — every `generate_plan` appended a full preview graph and nothing
 * ever removed a superseded/rejected/abandoned one, and a plan's preview
 * always materialized into whatever project happened to be ACTIVE rather
 * than the project it actually targeted. Live state: 49 stale draft nodes
 * from 5 un-launched proposals, 3 of them stacked inside the wrong zone.
 *
 * This file drives the REAL `sendManagerMessage`/`executePlan`/`rejectPlan`
 * path end to end (same AgentsStoreProvider harness as
 * mergeManagerActionsSupersede.test.tsx's own integration block) and
 * asserts on the REAL canvasStore state, never a mocked stand-in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import { runMission } from '../lib/agents/runtime';
import type { MissionUpdate } from '../lib/agents/runtime';
import type { Mission } from '../lib/agents/types';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { _resetChainEngineForTests } from '../lib/agents/chainEngine';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return {
    ...actual,
    runManagerTurn: vi.fn(),
  };
});

vi.mock('../lib/agents/actionGate', () => ({
  evaluateActionGate: vi.fn(async () => ({ decision: 'allow', reason: 'test mock' })),
  evaluateActionGateSync: vi.fn(() => ({ decision: 'allow', reason: 'test mock' })),
}));

const { mockRecallForDirective } = vi.hoisted(() => ({
  mockRecallForDirective: vi.fn(async (_query: string) => '(no memory hits found)'),
}));

vi.mock('../lib/models/brainSearchLoop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/brainSearchLoop')>();
  return {
    ...actual,
    recallForDirective: mockRecallForDirective,
  };
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

function enableTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}
function disableTauri(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

interface FakeProject {
  id: string;
  root: string;
  active: boolean;
}

const mockedInvoke = vi.mocked(invoke);
const mockedRunMission = vi.mocked(runMission);

/**
 * Installs a controllable `invoke` mock covering everything the plan
 * lifecycle touches: `get_project_root` (the ACTIVE root), `project_list`
 * (every currently OPEN project — real backend truth `resolveDraftProjectId`/
 * `resolveProjectRootById`/`resolveOrchestratorRoot` all read from), and a
 * `write_file`/`read_file`/`fs_create_dir`-backed in-memory fs so
 * orchestratorState.ts's real persistence round-trips ACROSS turns instead
 * of vanishing (the shared setup.ts default, `invoke` always resolving
 * undefined, would otherwise make every orchestrator "not found" the
 * instant a second action tries to read it back).
 */
function installMultiProjectMocks(activeRoot: string, projects: FakeProject[]): Map<string, string> {
  const fsStore = new Map<string, string>();
  mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
    if (cmd === 'get_project_root') return Promise.resolve(activeRoot);
    if (cmd === 'project_list') {
      return Promise.resolve(projects.map((p) => ({ id: p.id, root: p.root, brainId: null, active: p.active })));
    }
    if (cmd === 'write_file') {
      const { path, content } = args as { path: string; content: string };
      fsStore.set(path, content);
      return Promise.resolve(undefined);
    }
    if (cmd === 'read_file') {
      const { path } = args as { path: string };
      const content = fsStore.get(path);
      return content !== undefined ? Promise.resolve(content) : Promise.reject(new Error('cannot find the file'));
    }
    if (cmd === 'fs_create_dir') return Promise.resolve(undefined);
    return Promise.resolve(undefined);
  });
  return fsStore;
}

function settleMissionsImmediately(): void {
  mockedRunMission.mockImplementation((mission: Mission, _root: string, opts: { onUpdate: (u: MissionUpdate) => void }) => {
    // `worktree` mirrors real runtime.ts (Step A always sets it to the
    // mission's own branch before 'done') — plans below use a real
    // dependsOn chain, and runGraph's dependency-branch inheritance
    // (resolveInheritedBranches) reads the upstream step's
    // `mission.worktree` to launch the downstream step. Without it, the
    // downstream step would fail with a "missing upstream branch" error
    // instead of exercising what this file actually tests.
    opts.onUpdate({ id: mission.id, patch: { status: 'done', worktree: `agent/${mission.id}-mock` } });
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  _resetChainEngineForTests();
  vi.mocked(runManagerTurn).mockReset();
  mockRecallForDirective.mockReset();
  mockRecallForDirective.mockResolvedValue('(no memory hits found)');
  mockedInvoke.mockReset();
  mockedRunMission.mockReset();
  mockedRunMission.mockResolvedValue(undefined);
  enableTauri();
});

afterEach(() => {
  disableTauri();
});

const ACTIVE_ROOT = '/root/backoffice';

describe('generate_plan proposal supersession — scoped per conversation', () => {
  it('a second plan proposed in the SAME conversation auto-rejects the first — the canvas never holds both full graphs', async () => {
    installMultiProjectMocks(ACTIVE_ROOT, [{ id: 'p1', root: ACTIVE_ROOT, active: true }]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const convId = result.current.activeConversationId;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Plan A ready.',
      actions: [{ type: 'generate_plan', objective: 'Plan A', steps: [
        { id: 'a1', description: 'Step A1' },
        { id: 'a2', description: 'Step A2' },
      ] }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(convId, 'plan A please', 'haiku');
    });
    const msgA = result.current.managerMessages.find((m) => m.proposal?.objective === 'Plan A');
    const planIdA = msgA?.proposal?.planId;
    expect(planIdA).toBeDefined();
    expect(canvasStoreVanilla.getState().drafts.filter((d) => d.proposedPlanId === planIdA)).toHaveLength(2);

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Plan B ready.',
      actions: [{ type: 'generate_plan', objective: 'Plan B', steps: [
        { id: 'b1', description: 'Step B1' },
      ] }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(convId, 'actually plan B instead', 'haiku');
    });
    const msgB = result.current.managerMessages.find((m) => m.proposal?.objective === 'Plan B');
    const planIdB = msgB?.proposal?.planId;
    expect(planIdB).toBeDefined();

    // Chosen semantics: silent auto-reject — plan A's preview is GONE from
    // the canvas, plan B's is the only one present. The canvas never ends
    // up holding both full graphs.
    const drafts = canvasStoreVanilla.getState().drafts;
    expect(drafts.filter((d) => d.proposedPlanId === planIdA)).toHaveLength(0);
    expect(drafts.filter((d) => d.proposedPlanId === planIdB)).toHaveLength(1);

    // Plan A's chat card honestly reflects what happened — 'rejected', not
    // left dangling in 'pending' forever.
    const refreshedMsgA = result.current.managerMessages.find((m) => m.id === msgA!.id);
    expect(refreshedMsgA?.proposal?.state).toBe('rejected');
    const refreshedMsgB = result.current.managerMessages.find((m) => m.id === msgB!.id);
    expect(refreshedMsgB?.proposal?.state).toBe('pending');
  });

  it('two DIFFERENT conversations each hold their own live proposal — supersession never crosses conversations', async () => {
    installMultiProjectMocks(ACTIVE_ROOT, [{ id: 'p1', root: ACTIVE_ROOT, active: true }]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const convA = result.current.activeConversationId;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Plan A ready.',
      actions: [{ type: 'generate_plan', objective: 'Conversation A plan', steps: [{ id: 'a1', description: 'Step A1' }] }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(convA, 'plan for A', 'haiku');
    });
    const planIdA = result.current.managerMessages.find((m) => m.proposal?.objective === 'Conversation A plan')?.proposal?.planId;

    act(() => { result.current.newManagerConversation(); });
    const convB = result.current.activeConversationId;
    expect(convB).not.toBe(convA);

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Plan B ready.',
      actions: [{ type: 'generate_plan', objective: 'Conversation B plan', steps: [{ id: 'b1', description: 'Step B1' }] }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(convB, 'plan for B', 'haiku');
    });
    const planIdB = result.current.conversations[convB]!.messages.find((m) => m.proposal?.objective === 'Conversation B plan')?.proposal?.planId;

    // BOTH previews coexist — multi-conversation means two live proposals
    // at once is legitimate, never superseded across conversations.
    const drafts = canvasStoreVanilla.getState().drafts;
    expect(drafts.filter((d) => d.proposedPlanId === planIdA)).toHaveLength(1);
    expect(drafts.filter((d) => d.proposedPlanId === planIdB)).toHaveLength(1);

    const convAMsg = result.current.conversations[convA]!.messages.find((m) => m.proposal?.planId === planIdA);
    expect(convAMsg?.proposal?.state).toBe('pending');
  });
});

describe('rejectPlan — removes the preview from the canvas (real primitive, not just the chat card)', () => {
  it('rejecting a pending proposal removes its drafts/chains from the canvas', async () => {
    installMultiProjectMocks(ACTIVE_ROOT, [{ id: 'p1', root: ACTIVE_ROOT, active: true }]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Plan ready.',
      actions: [{ type: 'generate_plan', objective: 'Plan to reject', steps: [
        { id: 's1', description: 'Step 1' },
        { id: 's2', description: 'Step 2', dependsOn: ['s1'] },
      ] }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'plan it', 'haiku');
    });
    const planId = result.current.managerMessages.find((m) => m.proposal)?.proposal?.planId;
    expect(planId).toBeDefined();
    expect(canvasStoreVanilla.getState().drafts.filter((d) => d.proposedPlanId === planId)).toHaveLength(2);
    expect(canvasStoreVanilla.getState().chains.filter((c) => c.proposedPlanId === planId)).toHaveLength(1);

    await act(async () => {
      await result.current.rejectPlan(planId!);
    });

    expect(canvasStoreVanilla.getState().drafts.filter((d) => d.proposedPlanId === planId)).toHaveLength(0);
    expect(canvasStoreVanilla.getState().chains.filter((c) => c.proposedPlanId === planId)).toHaveLength(0);
    const finalMsg = result.current.managerMessages.find((m) => m.proposal?.planId === planId);
    expect(finalMsg?.proposal?.state).toBe('rejected');
  });
});

describe('executePlan — launching converts the preview IN PLACE, never a ghost duplicate', () => {
  it('accepting a plan leaves zero leftover proposed drafts and creates real missions instead — no duplicate node count', async () => {
    installMultiProjectMocks(ACTIVE_ROOT, [{ id: 'p1', root: ACTIVE_ROOT, active: true }]);
    settleMissionsImmediately();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const draftsBefore = canvasStoreVanilla.getState().drafts.length;
    const missionsBefore = result.current.missions.length;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Plan ready.',
      actions: [{ type: 'generate_plan', objective: 'Plan to launch', steps: [
        { id: 's1', description: 'Step 1' },
        { id: 's2', description: 'Step 2', dependsOn: ['s1'] },
      ] }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'plan it', 'haiku');
    });
    const planId = result.current.managerMessages.find((m) => m.proposal)?.proposal?.planId;
    expect(canvasStoreVanilla.getState().drafts.length).toBe(draftsBefore + 2);

    await act(async () => {
      await result.current.executePlan(planId!, undefined);
    });

    // Real missions launched — identity continuity, not a second copy.
    expect(result.current.missions.length).toBe(missionsBefore + 2);
    // No leftover dashed "proposed" draft for this plan.
    expect(canvasStoreVanilla.getState().drafts.filter((d) => d.proposedPlanId === planId)).toHaveLength(0);
    // No net GROWTH in draft count beyond baseline — a launched step's
    // draft was remapped to a mission node, never left behind as a ghost.
    expect(canvasStoreVanilla.getState().drafts.length).toBe(draftsBefore);
  });
});

describe('generate_plan — targets the REAL project, never the active one by default', () => {
  it('a plan naming a project OTHER than the active one materializes in THAT project\'s zone', async () => {
    const otherRoot = '/root/site';
    installMultiProjectMocks(ACTIVE_ROOT, [
      { id: 'p1', root: ACTIVE_ROOT, active: true },
      { id: 'p2', root: otherRoot, active: false },
    ]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Plan ready.',
      actions: [{
        type: 'generate_plan',
        objective: 'Site homepage redesign',
        projectId: 'site', // basename of otherRoot — resolved by name, not id
        steps: [{ id: 's1', description: 'Redesign homepage' }],
      }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'plan the site redesign', 'haiku');
    });

    const planId = result.current.managerMessages.find((m) => m.proposal)?.proposal?.planId;
    const drafts = canvasStoreVanilla.getState().drafts.filter((d) => d.proposedPlanId === planId);
    expect(drafts).toHaveLength(1);
    // Materialized under the TARGET project (otherRoot's own id), never the
    // active one (ACTIVE_ROOT).
    expect(drafts[0]!.projectId).toBe(otherRoot);
    expect(drafts[0]!.projectId).not.toBe(ACTIVE_ROOT);
  });

  it('two plans targeting DIFFERENT projects never share a zone', async () => {
    const rootB = '/root/site';
    const rootC = '/root/marketing';
    installMultiProjectMocks(ACTIVE_ROOT, [
      { id: 'p1', root: ACTIVE_ROOT, active: true },
      { id: 'p2', root: rootB, active: false },
      { id: 'p3', root: rootC, active: false },
    ]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const convA = result.current.activeConversationId;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Plan B ready.',
      actions: [{ type: 'generate_plan', objective: 'Site plan', projectId: 'site', steps: [{ id: 's1', description: 'Site step' }] }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(convA, 'plan the site', 'haiku');
    });
    const planIdB = result.current.managerMessages.find((m) => m.proposal?.objective === 'Site plan')?.proposal?.planId;

    // A second conversation (never superseded — see the supersession
    // describe block above) proposes a plan targeting a THIRD project.
    act(() => { result.current.newManagerConversation(); });
    const convC = result.current.activeConversationId;
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Plan C ready.',
      actions: [{ type: 'generate_plan', objective: 'Marketing plan', projectId: 'marketing', steps: [{ id: 'c1', description: 'Marketing step' }] }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(convC, 'plan the marketing site', 'haiku');
    });
    const planIdC = result.current.conversations[convC]!.messages.find((m) => m.proposal?.objective === 'Marketing plan')?.proposal?.planId;

    const draftB = canvasStoreVanilla.getState().drafts.find((d) => d.proposedPlanId === planIdB);
    const draftC = canvasStoreVanilla.getState().drafts.find((d) => d.proposedPlanId === planIdC);
    expect(draftB?.projectId).toBe(rootB);
    expect(draftC?.projectId).toBe(rootC);
    expect(draftB?.projectId).not.toBe(draftC?.projectId);
  });
});
