/**
 * Tests for the W8c LazyManager parity actions (deliverable #5) + the
 * approve/reject-with-feedback gate primitives (deliverable #2):
 *   - parseManagerActions for pin_chain / unpin_chain / refire_chain /
 *     approve_mission / reject_mission / create_router,
 *   - the prompt catalog documenting all six,
 *   - executor dispatch through the SAME real primitives the UI uses
 *     (canvasStore's pinChainOutput/addRouter, chainEngine's
 *     refireChainDownstream, agentsStore's approveMission/retryMission),
 *   - gate v2: the approve path still runs the UNTOUCHED checkApproveGate
 *     (blocked without a verdict, force bypasses), reject-with-feedback
 *     requeues a clone with the feedback appended AND records a REAL
 *     `mission.rejected` journal event against the ORIGINAL mission id.
 *
 * Same harness as managerCanvasActions.test.tsx (runManagerTurn mocked, the
 * real AgentsStoreProvider executor dispatches parsed actions).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { parseManagerActions, buildManagerSystemPrompt, runManagerTurn } from '../lib/agents/managerEngine';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { _resetChainEngineForTests } from '../lib/agents/chainEngine';
import { makeRef, type DraftSpec } from '../components/agents/canvas/canvasTypes';
import { createDecision } from '../lib/brain/decisions';

const mockInvoke = vi.mocked(invoke);
const mockedCreateDecision = vi.mocked(createDecision);

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

// Brain-integration wave â€” reject_mission's feedback must be recorded as a
// decision neuron (createDecision), the same primitive missionQuestion.ts's
// recordMissionAnswer uses for the ask_user answer flow. Mocked wholesale
// (rather than exercising the real getPlatform().brain.capture path) so this
// suite only asserts the WIRING â€” agentsStore.tsx's retryMission calls it
// with the right question/answer â€” not decisions.ts's own internals (see
// decisions.test.ts for those).
vi.mock('../lib/brain/decisions', () => ({
  createDecision: vi.fn().mockResolvedValue('decision-1'),
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

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

function draft(overrides: Partial<DraftSpec> & { id: string }): DraftSpec {
  return { title: `Draft ${overrides.id}`, task: 'do the thing', createdBy: 'user', ...overrides };
}

/** Every `journal_emit` event row captured by the invoke fake, for the
 *  journal-trail assertions below. */
interface CapturedEvent {
  type: string;
  mission_id: string | null;
  payload: string;
}
let capturedEvents: CapturedEvent[] = [];

/** AgentsStoreProvider's chain-engine effect now calls the real
 *  initChainEngine, which is a no-op outside Tauri (chainEngine.ts's own
 *  isTauri() guard) â€” the refire_chain suite below needs the real engine
 *  wired (currentDeps set), so this locally fakes the Tauri sentinel
 *  exactly like nightShift.test.ts's enableTauri()/disableTauri() does
 *  (setup.ts deletes it globally so isTauri() defaults to false). */
function enableTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

function disableTauri(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  _resetChainEngineForTests();
  vi.mocked(runManagerTurn).mockReset();
  mockedCreateDecision.mockClear();
  capturedEvents = [];
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'journal_emit') {
      const event = (args as { event: CapturedEvent }).event;
      capturedEvents.push(event);
      return 1;
    }
    // `read_dir` keeps setup.ts's global default (`[]`, a real array) so the
    // Tauri fs.readDir .map() never throws and approveMission's worktree
    // existence probe reads the virtual worktree as present.
    if (cmd === 'read_dir') return [];
    return undefined;
  });
  enableTauri();
});

afterEach(() => {
  disableTauri();
});

async function dispatch(sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>, conversationId: string, actions: unknown[]) {
  vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: actions as never, rawResponse: '' });
  await act(async () => {
    await sendManagerMessage(conversationId, 'do it', 'haiku');
  });
}

/** Launches a real mission through the store's own addMission, then patches
 *  it to the requested status/fields â€” the same real Mission every executor
 *  case then finds in `state.missions`. */
async function seedMission(
  result: { current: ReturnType<typeof useAgentsStore> },
  patch: Record<string, unknown> = {},
): Promise<string> {
  let id = '';
  await act(async () => {
    id = await result.current.addMission({
      title: 'Seeded mission',
      agentTask: 'original task',
      repo: '.',
      worktree: '',
      modelLabel: 'sonnet',
      orchestrator: false,
    });
  });
  if (Object.keys(patch).length > 0) {
    await act(async () => {
      result.current.updateMission({ id, patch: patch as never });
    });
  }
  return id;
}

// â”€â”€ Parsing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('parseManagerActions â€” W8c actions', () => {
  const cases: Array<{ name: string; json: string }> = [
    { name: 'pin_chain', json: '{"type": "pin_chain", "chainId": "chain-1"}' },
    { name: 'unpin_chain', json: '{"type": "unpin_chain", "chainId": "chain-1"}' },
    { name: 'refire_chain', json: '{"type": "refire_chain", "chainId": "chain-1"}' },
    { name: 'approve_mission', json: '{"type": "approve_mission", "missionId": "M12"}' },
    { name: 'approve_mission (force)', json: '{"type": "approve_mission", "missionId": "M12", "force": true}' },
    { name: 'reject_mission', json: '{"type": "reject_mission", "missionId": "M12", "feedback": "fix the expiry check"}' },
    {
      name: 'create_router',
      json: '{"type": "create_router", "branches": [{"label": "ok", "condition": {"kind": "outcome", "value": "success"}}, {"label": "ko", "condition": {"kind": "default"}}], "alias": "r"}',
    },
  ];

  for (const { name, json } of cases) {
    it(`parses ${name}`, () => {
      const actions = parseManagerActions(`<lazy_actions>\n[${json}]\n</lazy_actions>`);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toEqual(JSON.parse(json));
    });
  }
});

describe('buildManagerSystemPrompt â€” W8c catalog', () => {
  it('documents all six new action types, including the worked router example', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    for (const action of ['pin_chain', 'unpin_chain', 'refire_chain', 'approve_mission', 'reject_mission', 'create_router']) {
      expect(prompt).toContain(`"type": "${action}"`);
    }
    expect(prompt).toContain('Worked example (router)');
  });
});

// â”€â”€ Executor dispatch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('executeManagerAction â€” pin_chain / unpin_chain', () => {
  it('pins a chain whose source mission is DONE, and records a chain.pinned journal event', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'done' });
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain({
      id: 'c1',
      sourceRef: makeRef('mission', missionId),
      targetRef: makeRef('draft', 'd1'),
      condition: 'success',
      createdBy: 'user',
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'pin_chain', chainId: 'c1' }]);

    const pinned = canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.pinnedContext;
    expect(pinned).toBeDefined();
    expect(pinned!.sourceTitle).toBe('Seeded mission');
    expect(pinned!.text).toContain('## CONTEXTE AMONT');

    await waitFor(() => {
      const evt = capturedEvents.find((e) => e.type === 'chain.pinned');
      expect(evt).toBeDefined();
      expect(evt!.mission_id).toBe(missionId);
      expect(JSON.parse(evt!.payload)).toMatchObject({ chainId: 'c1', sourceMissionId: missionId });
    });
  });

  it('refuses honestly when the source mission is not done yet â€” no pin, no event', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result); // stays queued
    canvasStoreVanilla.getState().addChain({
      id: 'c1',
      sourceRef: makeRef('mission', missionId),
      targetRef: makeRef('draft', 'd1'),
      condition: 'success',
      createdBy: 'user',
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'pin_chain', chainId: 'c1' }]);

    expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.pinnedContext).toBeUndefined();
    expect(capturedEvents.some((e) => e.type === 'chain.pinned')).toBe(false);
  });

  it('unpin_chain clears a pinned chain through the same store primitive', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    canvasStoreVanilla.getState().addChain({
      id: 'c1',
      sourceRef: makeRef('mission', 'm1'),
      targetRef: makeRef('draft', 'd1'),
      condition: 'success',
      createdBy: 'user',
      pinnedContext: { text: 'X', pinnedAtMs: 1, sourceTitle: 'T' },
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'unpin_chain', chainId: 'c1' }]);

    expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.pinnedContext).toBeUndefined();
  });
});

describe('executeManagerAction â€” refire_chain', () => {
  it('re-fires a pinned chain\'s draft target via the real chainEngine (new mission, draft kept)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1', task: 'replayable work' }));
    canvasStoreVanilla.getState().addChain({
      id: 'c1',
      sourceRef: makeRef('mission', 'm-old'),
      targetRef: makeRef('draft', 'd1'),
      condition: 'success',
      createdBy: 'user',
      pinnedContext: { text: '\n\n## PINNED CONTEXT', pinnedAtMs: 1, sourceTitle: 'Old run' },
    });
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'refire_chain', chainId: 'c1' }]);

    await waitFor(() => expect(result.current.missions.length).toBe(missionsBefore + 1));
    const launched = result.current.missions[result.current.missions.length - 1];
    expect(launched.agentTask).toContain('replayable work');
    expect(launched.agentTask).toContain('PINNED CONTEXT');
    // The draft is deliberately NOT consumed â€” the replay stays repeatable.
    expect(canvasStoreVanilla.getState().drafts.some((d) => d.id === 'd1')).toBe(true);
    // And the automatic-fire high-water mark is untouched.
    expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.lastFiredAtMs).toBeUndefined();
  });

  it('reports honestly instead of launching when the chain is not pinned', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain({
      id: 'c1',
      sourceRef: makeRef('mission', 'm-old'),
      targetRef: makeRef('draft', 'd1'),
      condition: 'success',
      createdBy: 'user',
    });
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'refire_chain', chainId: 'c1' }]);

    expect(result.current.missions.length).toBe(missionsBefore);
  });
});

describe('executeManagerAction â€” approve_mission (gate v2, approve path untouched)', () => {
  it('a review mission WITHOUT a judge verdict stays blocked by the real checkApproveGate', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'review', worktree: 'agent/wt-1' });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId }]);

    // Still in review â€” the gate refused, nothing was merged/faked.
    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('review');
  });

  it('force preserves the existing force semantics: bypasses the gate and merges (web/mock mode)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'review', worktree: 'agent/wt-1' });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId, force: true }]);

    await waitFor(() => {
      const m = result.current.missions.find((x) => x.id === missionId)!;
      expect(m.status).toBe('done');
      expect(m.merged).toBe(true);
    });
  });

  it('refuses honestly for a mission that is not in review (no false success)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result); // queued
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId }]);
    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('queued');
  });
});

describe('executeManagerAction â€” reject_mission (gate v2, reject-with-feedback)', () => {
  it('requeues a clone with the feedback appended AND records mission.rejected against the ORIGINAL id', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'review', worktree: 'agent/wt-1' });
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'reject_mission', missionId, feedback: 'the expiry validation is missing â€” add it' },
    ]);

    await waitFor(() => expect(result.current.missions.length).toBe(missionsBefore + 1));
    const clone = result.current.missions[result.current.missions.length - 1];
    expect(clone.id).not.toBe(missionId);
    expect(clone.status).toBe('queued');
    expect(clone.agentTask).toContain('original task');
    expect(clone.agentTask).toContain('the expiry validation is missing â€” add it');
    // Fresh clone: no stale verdict/timeline rides along (retryMission's
    // existing reset list, unchanged).
    expect(clone.judgeVerdict).toBeUndefined();

    // Journal trail: a REAL mission.rejected (existing vocabulary â€” no
    // invented event type) against the ORIGINAL mission id.
    await waitFor(() => {
      const evt = capturedEvents.find((e) => e.type === 'mission.rejected');
      expect(evt).toBeDefined();
      expect(evt!.mission_id).toBe(missionId);
      expect(JSON.parse(evt!.payload)).toEqual({ reason: 'the expiry validation is missing â€” add it' });
    });
  });

  it('a plain retryMission (no feedback) emits NO mission.rejected and leaves the task untouched', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'failed' });
    const missionsBefore = result.current.missions.length;

    await act(async () => {
      result.current.retryMission(missionId);
    });

    await waitFor(() => expect(result.current.missions.length).toBe(missionsBefore + 1));
    const clone = result.current.missions[result.current.missions.length - 1];
    expect(clone.agentTask).toBe('original task');
    expect(capturedEvents.some((e) => e.type === 'mission.rejected')).toBe(false);
  });

  // â”€â”€ Brain-integration wave: reject-with-feedback â†’ decision neuron â”€â”€â”€â”€â”€â”€
  // "the brain learns David's review standards" â€” the feedback must be
  // recorded the same way answer_question's answers are (a decision neuron),
  // not just baked into the retry clone's task and a mission.rejected event.

  it('records a decision neuron pairing the review context (title + verdict) with the feedback', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, {
      status: 'review',
      worktree: 'agent/wt-1',
      title: 'Add expiry check',
      judgeVerdict: { score: 40, passed: false, risk: 'medium', reviewers: [], createdAt: new Date().toISOString() },
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'reject_mission', missionId, feedback: 'the expiry validation is missing â€” add it' },
    ]);

    await waitFor(() => expect(mockedCreateDecision).toHaveBeenCalledTimes(1));
    const call = mockedCreateDecision.mock.calls[0][0];
    expect(call.answer).toBe('the expiry validation is missing â€” add it');
    expect(call.question).toContain('Add expiry check');
    expect(call.question).toContain('score 40/100');
    expect(call.question).toContain('FAILED');
    expect(call.scope).toBe('project');
  });

  it('degrades honestly to "no judge verdict recorded" when the rejected mission never got a verdict', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'review', worktree: 'agent/wt-1', title: 'No verdict yet' });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'reject_mission', missionId, feedback: 'use approach B instead' },
    ]);

    await waitFor(() => expect(mockedCreateDecision).toHaveBeenCalledTimes(1));
    const call = mockedCreateDecision.mock.calls[0][0];
    expect(call.question).toContain('no judge verdict recorded');
  });

  it('a plain retryMission (no feedback) never records a decision neuron', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'failed' });

    await act(async () => {
      result.current.retryMission(missionId);
    });

    await waitFor(() => expect(result.current.missions.length).toBeGreaterThan(0));
    expect(mockedCreateDecision).not.toHaveBeenCalled();
  });
});

// â”€â”€ Retry-with-edit friction fix â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Real friction, verbatim: "je clone M1 (failed) avec la mÃªme tÃ¢che
// reformulÃ©e puisque retry_mission ne permet pas de changer le texte de la
// tÃ¢che" â€” retry_mission gains an optional "modifications.task" so a bad
// instruction can be corrected IN PLACE (one mission id, one history)
// instead of forcing a clone_mission detour that leaves a failed original
// next to a fresh near-duplicate on the same step.
describe('executeManagerAction â€” retry_mission with modifications.task (retry-with-edit)', () => {
  it('runs the corrected text, records the previous wording, and creates exactly ONE new mission (no clone_mission-style duplicate)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'failed' });
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'retry_mission', missionId, modifications: { task: 'corrected task text' } },
    ]);

    // Exactly one new mission â€” never two (that would be the clone_mission
    // friction this fix removes: a failed original next to a duplicate).
    await waitFor(() => expect(result.current.missions.length).toBe(missionsBefore + 1));
    expect(result.current.missions.length).toBe(missionsBefore + 1);

    const retried = result.current.missions[result.current.missions.length - 1];
    expect(retried.id).not.toBe(missionId);
    expect(retried.status).toBe('queued');
    // Runs the NEW text â€” never the stale original wording.
    expect(retried.agentTask).toBe('corrected task text');
    // Records the amendment honestly: the previous (already-judged) wording
    // stays visible, never silently erased.
    expect(retried.taskAmendedFrom).toBe('original task');

    // The original mission itself is untouched (still there, still failed) â€”
    // a retry amends via a fresh mission, it does not rewrite history.
    const original = result.current.missions.find((m) => m.id === missionId);
    expect(original?.status).toBe('failed');
    expect(original?.agentTask).toBe('original task');
  });

  it('an unchanged modifications.task (identical to the current task) is not treated as an amendment', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'failed' });
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'retry_mission', missionId, modifications: { task: 'original task' } },
    ]);

    await waitFor(() => expect(result.current.missions.length).toBe(missionsBefore + 1));
    const retried = result.current.missions[result.current.missions.length - 1];
    expect(retried.agentTask).toBe('original task');
    expect(retried.taskAmendedFrom).toBeUndefined();
  });

  it('a plain retry_mission with no modifications never sets taskAmendedFrom', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'failed' });
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'retry_mission', missionId },
    ]);

    await waitFor(() => expect(result.current.missions.length).toBe(missionsBefore + 1));
    const retried = result.current.missions[result.current.missions.length - 1];
    expect(retried.agentTask).toBe('original task');
    expect(retried.taskAmendedFrom).toBeUndefined();
  });

  it('modifications.model reroutes the retry independently of the task correction', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'failed' });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'retry_mission', missionId, modifications: { task: 'corrected task text', model: 'opus' } },
    ]);

    await waitFor(() => expect(result.current.missions.length).toBeGreaterThan(0));
    const retried = result.current.missions[result.current.missions.length - 1];
    expect(retried.agentTask).toBe('corrected task text');
    expect(retried.taskAmendedFrom).toBe('original task');
    expect(retried.model.toLowerCase()).toContain('opus');
  });

  // Continuation Doctrine REVERSAL (2026-08-02, real incident — lazy-
  // backoffice M9/M10: the manager was explicitly asked to relaunch both
  // steps from a corrected baseBranch, chose retry_mission over
  // launch_mission, and the retry silently kept each original mission's
  // empty base — the requested re-root never took effect and NOTHING told
  // the manager or the user it had been dropped). baseBranch is a mission-
  // CREATION parameter (Mission.baseBranch's own doc comment, types.ts) — a
  // retry never changes it; requesting a real change is now refused
  // outright and loudly (see retryMission's own doc comment, agentsStore.tsx),
  // never a silent no-op. This REPLACES the prior "modifications.baseBranch
  // reroutes the retry" behavior the M9/M10 incident showed was the wrong
  // doctrine — see managerEngine.ts's Continuation Doctrine for the full
  // rule ("baseBranch applies at CREATION; to re-root, launch a NEW mission").
  it('modifications.baseBranch requesting a DIFFERENT branch than the original is refused, loudly — no new mission, original untouched', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'failed', baseBranch: 'agent/M6-old-branch' });
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'retry_mission', missionId, modifications: { baseBranch: 'agent/M6-integrer-le-scaffold-existant-' } },
    ]);

    // No silent reroute AND no silent no-op — the retry itself never happens.
    expect(result.current.missions.length).toBe(missionsBefore);
    const original = result.current.missions.find((m) => m.id === missionId);
    expect(original?.baseBranch).toBe('agent/M6-old-branch');
    expect(original?.status).toBe('failed');

    // The refusal is a REAL, visible signal in the transcript — never a
    // swallowed failure the user/manager has no way to notice.
    const transcript = result.current.managerMessages.map((m) => m.content).join(' | ');
    expect(transcript).toContain(missionId);
  });

  it('a mistaken top-level "baseBranch" on retry_mission (mirroring launch_mission\'s own shape, an easy mix-up) is caught and refused too — never silently dropped', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'failed', baseBranch: 'agent/M6-old-branch' });
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      // No "modifications" wrapper — the top-level shape launch_mission's
      // own "baseBranch" example uses, a plausible manager mistake.
      { type: 'retry_mission', missionId, baseBranch: 'agent/M6-integrer-le-scaffold-existant-' },
    ]);

    expect(result.current.missions.length).toBe(missionsBefore);
    const original = result.current.missions.find((m) => m.id === missionId);
    expect(original?.baseBranch).toBe('agent/M6-old-branch');
  });

  it('modifications.baseBranch identical to the original\'s own baseBranch is not a real change — the retry proceeds normally (no false refusal)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'failed', baseBranch: 'agent/M6-integrer-le-scaffold-existant-' });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'retry_mission', missionId, modifications: { baseBranch: 'agent/M6-integrer-le-scaffold-existant-' } },
    ]);

    await waitFor(() => expect(result.current.missions.length).toBeGreaterThan(0));
    const retried = result.current.missions[result.current.missions.length - 1];
    expect(retried.id).not.toBe(missionId);
    expect(retried.status).toBe('queued');
    expect(retried.baseBranch).toBe('agent/M6-integrer-le-scaffold-existant-');
  });

  it('a plain retry_mission with no modifications.baseBranch keeps the original mission\'s own baseBranch (no regression)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'failed', baseBranch: 'agent/M6-integrer-le-scaffold-existant-' });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'retry_mission', missionId },
    ]);

    await waitFor(() => expect(result.current.missions.length).toBeGreaterThan(0));
    const retried = result.current.missions[result.current.missions.length - 1];
    expect(retried.baseBranch).toBe('agent/M6-integrer-le-scaffold-existant-');
  });
});

describe('executeManagerAction â€” create_router', () => {
  it('creates a router with ordered labeled branches through the real canvasStore primitive', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      {
        type: 'create_router',
        branches: [
          { label: 'tests passed', condition: { kind: 'outcome', value: 'success' } },
          { label: 'flaky', condition: { kind: 'contains', value: 'timeout' } },
          { label: 'failed', condition: { kind: 'default' } },
        ],
      },
    ]);

    const routers = canvasStoreVanilla.getState().routers;
    expect(routers).toHaveLength(1);
    expect(routers[0].branches.map((b) => b.label)).toEqual(['tests passed', 'flaky', 'failed']);
    expect(routers[0].branches.map((b) => b.condition)).toEqual([
      { kind: 'outcome', value: 'success' },
      { kind: 'contains', value: 'timeout' },
      { kind: 'default' },
    ]);
    // Every branch got a real minted id.
    expect(new Set(routers[0].branches.map((b) => b.id)).size).toBe(3);
  });

  it('a same-reply alias lets chain_agents target the freshly-created router', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'create_router', alias: 'r', branches: [{ label: 'ok', condition: { kind: 'default' } }, { label: 'ko', condition: { kind: 'default' } }] },
      { type: 'chain_agents', sourceRef: makeRef('mission', 'M1'), target: { targetAlias: 'r' }, condition: 'always' },
    ]);

    const routers = canvasStoreVanilla.getState().routers;
    const chains = canvasStoreVanilla.getState().chains;
    expect(routers).toHaveLength(1);
    expect(chains).toHaveLength(1);
    expect(chains[0].targetRef).toBe(makeRef('router', routers[0].id));
  });
});
