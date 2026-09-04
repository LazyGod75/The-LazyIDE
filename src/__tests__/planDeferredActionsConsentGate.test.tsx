/**
 * planDeferredActionsConsentGate.test.tsx — consent-bypass fix for actions
 * deferred alongside a `generate_plan` in the SAME manager turn.
 *
 * Defect (traced in agentsStore.tsx's sendManagerMessage/executePlan): a
 * mutative action bundled in the SAME turn as `generate_plan` (e.g.
 * create_project, classified `sensitive` in actionClassifier.ts — its own
 * comment says the manager must always ask before creating a directory) used
 * to be recorded on `proposal.deferredActions` and replayed by executePlan
 * with ZERO gate evaluation at all — it ran completely unattended the
 * instant the user clicked "Valider & lancer", regardless of autonomy mode.
 * It was also reported as a plain SUCCESS in the chip row the whole time it
 * sat waiting (`actionStatuses.push(true)`).
 *
 * This file drives the REAL sendManagerMessage/executePlan path against the
 * REAL (unmocked) actionGate — same convention as pendingApprovals.test.tsx
 * — combined with the multi-command `invoke` mock planProposalLifecycle.
 * test.tsx uses so orchestrator persistence round-trips across the
 * propose -> validate turns.
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
import { _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
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

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

const ACTIVE_ROOT = '/root/backoffice';
const NEW_PROJECT_PATH = '/root/new-project';
const mockedInvoke = vi.mocked(invoke);

function enableTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}
function disableTauri(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

/** Same convention as planProposalLifecycle.test.tsx's own
 *  installMultiProjectMocks: a controllable `invoke` mock covering
 *  `get_project_root`/`project_list` (real backend truth every
 *  resolve*ProjectId/Root helper reads from) plus a `write_file`/`read_file`/
 *  `fs_create_dir`-backed in-memory fs so orchestratorState.ts's real
 *  persistence round-trips ACROSS turns (generate_plan writes it, executePlan
 *  reads it back), plus `project_create` for create_project's own executor. */
function installProjectMocks(): void {
  const fsStore = new Map<string, string>();
  mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
    if (cmd === 'get_project_root') return Promise.resolve(ACTIVE_ROOT);
    if (cmd === 'project_list') {
      return Promise.resolve([{ id: 'p1', root: ACTIVE_ROOT, brainId: null, active: true }]);
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
    if (cmd === 'project_create') {
      return Promise.resolve({ id: 'new-project', root: NEW_PROJECT_PATH, brainId: null, active: false, gitInitNote: null });
    }
    return Promise.resolve(undefined);
  });
}

async function dispatch(
  sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>,
  conversationId: string,
  actions: unknown[],
) {
  vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: actions as never, rawResponse: '' });
  await act(async () => {
    await sendManagerMessage(conversationId, 'do it', 'haiku');
  });
}

function proposePlanWithCreateProject() {
  return [
    { type: 'generate_plan', objective: 'Ship it', steps: [{ id: 's1', description: 'Step 1' }] },
    { type: 'create_project', path: NEW_PROJECT_PATH },
  ];
}

const mockedRunMission = vi.mocked(runMission);

/** Same convention as planProposalLifecycle.test.tsx's own
 *  settleMissionsImmediately — makes execute_plan's own mission launch
 *  resolve to a real, terminal 'done' status instead of hitting the
 *  unmocked real runtime, only needed by the "allow" test below (the
 *  ask/deny tests never reach plan launch at all — that is the point). */
function settleMissionsImmediately(): void {
  mockedRunMission.mockImplementation((mission: Mission, _root: string, opts: { onUpdate: (u: MissionUpdate) => void }) => {
    opts.onUpdate({ id: mission.id, patch: { status: 'done', worktree: `agent/${mission.id}-mock` } });
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  _resetChainEngineForTests();
  vi.mocked(runManagerTurn).mockReset();
  mockedInvoke.mockReset();
  mockedRunMission.mockReset();
  mockedRunMission.mockResolvedValue(undefined);
  enableTauri();
  installProjectMocks();
});

afterEach(() => {
  disableTauri();
});

describe('deferred actions bundled with generate_plan — consent-bypass fix', () => {
  it('a sensitive action (create_project) never executes without approval when the plan is validated', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    // Default autonomyLevel is 'supervised' -> create_project (sensitive) asks.
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, proposePlanWithCreateProject());

    const proposedMsg = result.current.managerMessages.find((m) => m.proposal);
    const planId = proposedMsg?.proposal?.planId;
    expect(planId).toBeDefined();
    // Not gated at proposal time — only recorded as deferred.
    expect(result.current.pendingApprovals).toHaveLength(0);
    expect(proposedMsg?.proposal?.deferredActions).toHaveLength(1);
    expect(proposedMsg?.proposal?.deferredActions?.[0]!.type).toBe('create_project');
    // PERSISTED-INDEX DEADLOCK FIX — deferredActionIndexes[i] is
    // deferredActions[i]'s real position in `actions` (generate_plan is
    // index 0, create_project index 1); recorded as a plain number so it
    // survives the localStorage round-trip the "PERSISTED SHAPE REGRESSION"
    // test below exercises end-to-end.
    expect(proposedMsg?.proposal?.deferredActionIndexes).toEqual([1]);

    await act(async () => {
      await result.current.executePlan(planId!, undefined);
    });

    // Never executed for real — the gate said 'ask', not 'allow'.
    expect(mockedInvoke).not.toHaveBeenCalledWith('project_create', expect.anything());
    // A REAL pendingApprovals entry now exists — the SAME queue/UI a normal
    // gate-deferred action uses, never a parallel, unguarded path.
    expect(result.current.pendingApprovals).toHaveLength(1);
    expect(result.current.pendingApprovals[0]!.action.type).toBe('create_project');

    // Never raced ahead: the plan itself did not launch while the sibling
    // action from the same turn is still an unresolved human decision.
    const refreshedMsg = result.current.managerMessages.find((m) => m.id === proposedMsg!.id);
    expect(refreshedMsg?.proposal?.state).toBe('pending');
    expect(refreshedMsg?.proposal?.errorMessage).toMatch(/approval/i);
  });

  it('is never reported as succeeded — the chip reads "deferred" before validation, then "awaiting approval" after, never true', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, proposePlanWithCreateProject());

    const proposedMsg = result.current.managerMessages.find((m) => m.proposal);
    const planId = proposedMsg!.proposal!.planId!;
    const createIdx = proposedMsg!.actions!.findIndex((a) => a.type === 'create_project');
    expect(createIdx).toBeGreaterThanOrEqual(0);
    // Honest "not executed yet" status BEFORE validation — never `true`.
    expect(proposedMsg!.actionStatuses![createIdx]).toBe('deferred');

    await act(async () => {
      await result.current.executePlan(planId, undefined);
    });

    const refreshedMsg = result.current.managerMessages.find((m) => m.id === proposedMsg!.id);
    // Cross-referenced against the real pendingApprovals queue by
    // LazyManagerMessageList.tsx's own `isPending` check — `false` here,
    // never `true`, is the honest "not a completed success" signal.
    expect(refreshedMsg?.actionStatuses?.[createIdx]).toBe(false);
    const pendingForThisAction = result.current.pendingApprovals.find(
      (p) => p.messageId === refreshedMsg!.id && p.actionIndex === createIdx,
    );
    expect(pendingForThisAction).toBeDefined();
  });

  it('a PROPOSAL_SAFE_ACTIONS member (canvas_note) emitted alongside a plan still executes immediately — no regression', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'generate_plan', objective: 'Ship it', steps: [{ id: 's1', description: 'Step 1' }] },
      { type: 'canvas_note', text: 'context note' },
    ]);

    const proposedMsg = result.current.managerMessages.find((m) => m.proposal);
    const noteIdx = proposedMsg!.actions!.findIndex((a) => a.type === 'canvas_note');
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    // Executed immediately, exactly like before this fix — never deferred.
    expect(proposedMsg!.actionStatuses![noteIdx]).toBe(true);
    expect(proposedMsg!.proposal!.deferredActions ?? []).toHaveLength(0);
  });

  it('a deferred action ALLOWED by the gate (yolo mode) still executes for real on validation', async () => {
    settleMissionsImmediately();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    act(() => {
      result.current.setAutonomyLevel('yolo');
    });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, proposePlanWithCreateProject());

    const proposedMsg = result.current.managerMessages.find((m) => m.proposal);
    const planId = proposedMsg!.proposal!.planId!;

    await act(async () => {
      await result.current.executePlan(planId, undefined);
    });

    // yolo auto-allows a sensitive tier -> the real Rust call fires this time.
    expect(mockedInvoke).toHaveBeenCalledWith('project_create', { path: NEW_PROJECT_PATH });
    expect(result.current.pendingApprovals).toHaveLength(0);
    const createIdx = proposedMsg!.actions!.findIndex((a) => a.type === 'create_project');
    const refreshedMsg = result.current.managerMessages.find((m) => m.id === proposedMsg!.id);
    expect(refreshedMsg?.actionStatuses?.[createIdx]).toBe(true);
    // Never blocked — the plan itself was allowed to proceed and launch.
    expect(refreshedMsg?.proposal?.state).toBe('accepted');
  });

  // DEADLOCK REGRESSION (real user repro, 2026-08-18): "Validate & run" ->
  // gate asks -> user approves the queued entry -> "Validate & run" again
  // used to re-ask from scratch (a brand new pendingApprovals row for the
  // SAME action) and revert to 'pending' again, forever — approving never
  // actually cleared the block. See executePlan's own "DEADLOCK FIX" doc
  // comment (agentsStore.tsx) for the actionStatuses/pendingApprovals memory
  // this closes.
  it('a sensitive deferred action still blocks the FIRST validation and is not executed', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, proposePlanWithCreateProject());

    const proposedMsg = result.current.managerMessages.find((m) => m.proposal);
    const planId = proposedMsg!.proposal!.planId!;

    await act(async () => {
      await result.current.executePlan(planId, undefined);
    });

    expect(mockedInvoke).not.toHaveBeenCalledWith('project_create', expect.anything());
    expect(result.current.pendingApprovals).toHaveLength(1);
    const refreshedMsg = result.current.managerMessages.find((m) => m.id === proposedMsg!.id);
    expect(refreshedMsg?.proposal?.state).toBe('pending');
    expect(refreshedMsg?.proposal?.errorMessage).toMatch(/approval/i);
  });

  it('REGRESSION: after the user approves the deferred action, a SECOND validation launches the plan and does not re-ask', async () => {
    settleMissionsImmediately();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, proposePlanWithCreateProject());

    const proposedMsg = result.current.managerMessages.find((m) => m.proposal);
    const planId = proposedMsg!.proposal!.planId!;
    const createIdx = proposedMsg!.actions!.findIndex((a) => a.type === 'create_project');

    // First validate: gate says 'ask' -> blocks, queues one approval.
    await act(async () => {
      await result.current.executePlan(planId, undefined);
    });
    expect(result.current.pendingApprovals).toHaveLength(1);
    const pendingId = result.current.pendingApprovals[0]!.id;

    // User resolves it via the normal approval card.
    await act(async () => {
      await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });
    expect(mockedInvoke.mock.calls.filter((c) => c[0] === 'project_create')).toHaveLength(1);
    expect(result.current.pendingApprovals).toHaveLength(0);
    const afterApproveMsg = result.current.managerMessages.find((m) => m.id === proposedMsg!.id);
    expect(afterApproveMsg?.actionStatuses?.[createIdx]).toBe(true);

    // Second validate: must NOT re-ask (no new pendingApprovals entry), must
    // NOT re-execute create_project a second time, and must actually LAUNCH
    // the plan this time.
    await act(async () => {
      await result.current.executePlan(planId, undefined);
    });

    expect(mockedInvoke.mock.calls.filter((c) => c[0] === 'project_create')).toHaveLength(1);
    expect(result.current.pendingApprovals).toHaveLength(0);
    const finalMsg = result.current.managerMessages.find((m) => m.id === proposedMsg!.id);
    expect(finalMsg?.proposal?.state).toBe('accepted');
    // Stale "still need your approval" banner must be gone now that there
    // is nothing left to resolve.
    expect(finalMsg?.proposal?.errorMessage).toBeUndefined();
  });

  // PERSISTED-SHAPE REGRESSION (real user repro, live app, verbatim proposal
  // id msg-1787079828784-ccs5p2): the test just above proves the deadlock
  // fix works — but it runs entirely in-memory, so `proposal.deferredActions[0]`
  // and `message.actions[0]` never stop being the SAME object reference. The
  // live bug only manifested after a REAL localStorage round-trip (any
  // save+reload — including just navigating away and back): a deferred
  // `clear_canvas` already showing `actionStatuses: [true, true]` (genuinely
  // executed, approved on a prior pass) still re-blocked "Valider & lancer"
  // forever, because the replay loop's object-reference lookup into
  // `proposalMsg.actions` silently returned -1 for every entry once
  // `JSON.parse` (managerPersistence.ts's sanitizeMessage/sanitizeProposal)
  // had rebuilt `actions` and `proposal.deferredActions` as two independent
  // object graphs. This test drives the REAL round-trip: create + approve
  // the deferred action against a live provider tree, let the debounced
  // autosave (agentsStore.tsx's autosaveSeenRef effect, 400ms) actually
  // reach `localStorage`, then unmount and mount a BRAND NEW provider —
  // exactly what a real app restart does — before validating a second time.
  it('PERSISTED-SHAPE REGRESSION: an already-approved deferred action survives a real localStorage round-trip and does not re-block validation', async () => {
    settleMissionsImmediately();
    const first = renderHook(() => useAgentsStore(), { wrapper });
    const conversationId = first.result.current.activeConversationId;

    // Matches the live repro's own actionTypes order exactly:
    // ["clear_canvas", "generate_plan"].
    await dispatch(first.result.current.sendManagerMessage, conversationId, [
      { type: 'clear_canvas' },
      { type: 'generate_plan', objective: 'Ship it', steps: [{ id: 's1', description: 'Step 1' }] },
    ]);

    const proposedMsg = first.result.current.managerMessages.find((m) => m.proposal);
    const planId = proposedMsg!.proposal!.planId!;
    expect(proposedMsg!.actions!.map((a) => a.type)).toEqual(['clear_canvas', 'generate_plan']);
    expect(proposedMsg!.proposal!.deferredActions).toHaveLength(1);
    expect(proposedMsg!.proposal!.deferredActions![0]!.type).toBe('clear_canvas');
    expect(proposedMsg!.proposal!.deferredActionIndexes).toEqual([0]);

    // First validate: clear_canvas is 'sensitive' (default mode) -> gate
    // asks in the default 'supervised' autonomy -> blocks, queues one
    // approval, exactly like the live repro's own errorMessage.
    await act(async () => {
      await first.result.current.executePlan(planId, undefined);
    });
    expect(first.result.current.pendingApprovals).toHaveLength(1);
    const pendingId = first.result.current.pendingApprovals[0]!.id;

    // User approves it for real via the normal approval card.
    await act(async () => {
      await first.result.current.approvePendingAction(conversationId, pendingId);
    });
    const approvedMsg = first.result.current.managerMessages.find((m) => m.id === proposedMsg!.id);
    // Exact persisted shape from the live repro: both entries executed.
    expect(approvedMsg?.actionStatuses).toEqual([true, true]);
    expect(first.result.current.pendingApprovals).toHaveLength(0);

    // Let the debounced autosave effect actually reach localStorage before
    // simulating a restart — real timers, no fake-timer shortcut, so this
    // exercises the SAME 400ms debounce (agentsStore.tsx) a real app does.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    first.unmount();

    // Simulate a real app restart: a BRAND NEW provider tree. Its
    // useManagerPersistence() re-reads `lazy.managerSessions` from
    // localStorage via JSON.parse (managerPersistence.ts's loadSessions),
    // producing genuinely disconnected objects — the ONLY thing that
    // reproduces the real bug (same-process object identity never breaks,
    // even across saveMessages/loadManagerSession calls — see saveMessages's
    // own implementation, which reuses the SAME message objects it was
    // passed; only a FRESH mount's initial loadSessions() call parses
    // storage back out). The boot effect's "single-conversation fallback"
    // re-keys the restored session onto its OWN persisted id.
    const second = renderHook(() => useAgentsStore(), { wrapper });
    expect(second.result.current.activeConversationId).toBe(conversationId);
    const reloadedMsg = second.result.current.managerMessages.find((m) => m.id === proposedMsg!.id);
    expect(reloadedMsg?.actionStatuses).toEqual([true, true]);
    expect(reloadedMsg?.proposal?.state).toBe('pending');
    // THE BUG's exact precondition: after the round-trip, `deferredActions[0]`
    // is no longer the SAME object as `actions[0]` — reference matching is
    // structurally broken here, which is exactly why deferredActionIndexes
    // (a plain number) exists.
    expect(reloadedMsg?.proposal?.deferredActions?.[0]).not.toBe(reloadedMsg?.actions?.[0]);
    expect(reloadedMsg?.proposal?.deferredActionIndexes).toEqual([0]);

    // Second validation, against this reloaded state: must launch the plan
    // — must NOT re-ask (actionStatuses[0] is already true), must NOT
    // re-execute clear_canvas a second time, must NOT revert to 'pending'
    // with a stale "still need your approval" error ever again.
    await act(async () => {
      await second.result.current.executePlan(planId, undefined);
    });

    expect(second.result.current.pendingApprovals).toHaveLength(0);
    const finalMsg = second.result.current.managerMessages.find((m) => m.id === proposedMsg!.id);
    expect(finalMsg?.proposal?.state).toBe('accepted');
    expect(finalMsg?.proposal?.errorMessage).toBeUndefined();

    second.unmount();
  });

  it('after the user REJECTS the deferred action, a second validation launches the plan WITHOUT ever executing it', async () => {
    settleMissionsImmediately();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, proposePlanWithCreateProject());

    const proposedMsg = result.current.managerMessages.find((m) => m.proposal);
    const planId = proposedMsg!.proposal!.planId!;
    const createIdx = proposedMsg!.actions!.findIndex((a) => a.type === 'create_project');

    await act(async () => {
      await result.current.executePlan(planId, undefined);
    });
    expect(result.current.pendingApprovals).toHaveLength(1);
    const pendingId = result.current.pendingApprovals[0]!.id;

    act(() => {
      result.current.rejectPendingAction(result.current.activeConversationId, pendingId);
    });
    expect(result.current.pendingApprovals).toHaveLength(0);

    // Second validate: the plan must not stay stuck waiting on a decision
    // that was already made (Reject IS a decision) — chosen semantics: a
    // rejected deferred action behaves exactly like a gate `deny` (see
    // executePlan's own "DEADLOCK FIX" doc comment) — it never runs, but it
    // does not block the rest of the plan from launching either. Blocking
    // forever with no "un-reject" affordance would just trade one deadlock
    // for another.
    await act(async () => {
      await result.current.executePlan(planId, undefined);
    });

    expect(mockedInvoke).not.toHaveBeenCalledWith('project_create', expect.anything());
    expect(result.current.pendingApprovals).toHaveLength(0);
    const finalMsg = result.current.managerMessages.find((m) => m.id === proposedMsg!.id);
    expect(finalMsg?.proposal?.state).toBe('accepted');
    expect(finalMsg?.proposal?.errorMessage).toBeUndefined();
    // Rejected stays rejected — never silently flips to a completed success.
    expect(finalMsg?.actionStatuses?.[createIdx]).toBe(false);
  });

  it('a plan with NO deferred actions still validates in a single click — no regression', async () => {
    settleMissionsImmediately();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'generate_plan', objective: 'Ship it', steps: [{ id: 's1', description: 'Step 1' }] },
    ]);

    const proposedMsg = result.current.managerMessages.find((m) => m.proposal);
    const planId = proposedMsg!.proposal!.planId!;
    expect(proposedMsg?.proposal?.deferredActions ?? []).toHaveLength(0);

    await act(async () => {
      await result.current.executePlan(planId, undefined);
    });

    expect(result.current.pendingApprovals).toHaveLength(0);
    const finalMsg = result.current.managerMessages.find((m) => m.id === proposedMsg!.id);
    expect(finalMsg?.proposal?.state).toBe('accepted');
    expect(finalMsg?.proposal?.errorMessage).toBeUndefined();
  });
});

/**
 * NO-PLANID PROPOSAL FIX — a `generate_plan` action can itself finish
 * sendManagerMessage's action loop with NO real orchestrator id: this
 * message's own `proposal` object is built unconditionally the moment
 * `generatePlanAction` exists in `actionsToExecute` (state: 'pending', real
 * steps, an estimate — everything BUT `planId`), so any path that keeps
 * `generate_plan` from ever reaching `createOrchestrator` (a gate `deny`, a
 * gate `ask`, a non-throwing `{ failed: true }` outcome, or a thrown
 * exception) used to leave that proposal permanently `pending` with no
 * `planId` and no explanation — a card whose "Valider & lancer" reports
 * `disabled: false`, accepts clicks, and does nothing (its own click handler
 * is guarded by `if (proposal.planId)`, GraphProposalCard.tsx). This test
 * drives the most directly reachable of the four paths (manual autonomy asks
 * for EVERY action, including this SAFE-tier one — see actionGate.ts's
 * computeGateDecision, which checks `mode === 'manual'` before the tier
 * check even runs) and asserts the fix: `planId` still never gets set for a
 * plan that was never really created, but `errorMessage` now explains why,
 * and the real approval is queued/actionable — never a silent half-state.
 */
describe('generate_plan itself gated before creation — NO-PLANID PROPOSAL FIX', () => {
  it('a generate_plan asked for approval (manual autonomy) never leaves a silent no-planId pending proposal', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    act(() => {
      result.current.setAutonomyLevel('manual');
    });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'generate_plan', objective: 'Ship it', steps: [{ id: 's1', description: 'Step 1' }] },
    ]);

    const proposedMsg = result.current.managerMessages.find((m) => m.proposal);
    expect(proposedMsg?.proposal?.state).toBe('pending');
    // The defect's own precondition: no planId at all.
    expect(proposedMsg?.proposal?.planId).toBeUndefined();
    // The fix: the real reason is recorded on the SAME proposal, never a
    // silent pending state with nothing to explain it.
    expect(proposedMsg?.proposal?.errorMessage).toBeTruthy();
    expect(proposedMsg?.proposal?.errorMessage).toMatch(/generate_plan/);
    // Surfaced to the manager too — a real, queued, actionable approval for
    // generate_plan itself (never silently dropped).
    expect(result.current.pendingApprovals).toHaveLength(1);
    expect(result.current.pendingApprovals[0]!.action.type).toBe('generate_plan');
  });
});
