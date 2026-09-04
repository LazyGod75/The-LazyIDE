/**
 * managerGroundedActions.test.tsx — R4b fix: "THE MANAGER MUST NEVER LIE".
 *
 * Root cause (proven via R3's dogfood run, reproduced 3x): sendManagerMessage
 * (agentsStore.tsx) executed ONLY the first manager turn's actions. When a
 * composite order triggers a grounding action (brain_query/query_mission/...)
 * in turn 1, the manager's SECOND, grounded turn (which sees the real
 * grounded data and THEN decides what to actually do) had its own actions
 * parsed for display — they rendered as chips — but never dispatched through
 * executeManagerAction. Live symptom: "manager reply claims drafts were
 * created but only 0 new draft(s) exist on canvas — grounded-turn actions
 * discarded (agentsStore.tsx sendManagerMessage executes first-turn actions
 * only)".
 *
 * Fix: runGroundedFollowUp now returns the follow-up turn's own actions
 * (GroundedFollowUpResult.actions), and sendManagerMessage merges them with
 * turn-1's actions (mergeManagerActions — turn-1 unchanged, turn-2 minus any
 * byte-identical repeat) through the SAME aliasMap/executor path. This file
 * also covers the two related trust fixes shipped alongside it:
 *   - reject_mission surviving a grounded exchange (it was a casualty of the
 *     same bug — W8c wired it end-to-end, but it never got a chance to run
 *     when the manager looked the mission up first).
 *   - any action that fails to dispatch (unrecognized type, executor throw)
 *     surfaces a visible manager-rail message instead of a silent no-op.
 *
 * Same harness as managerW8cActions.test.tsx / managerCanvasActions.test.tsx
 * (runManagerTurn mocked per-call, the real AgentsStoreProvider executor
 * dispatches parsed actions against the real canvas store).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { _resetChainEngineForTests } from '../lib/agents/chainEngine';

const mockInvoke = vi.mocked(invoke);

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

// Phase 2: mock the universal action gate to always allow — these tests
// cover action dispatch behavior, not gate decisions (which have dedicated
// tests in actionGate.test.ts).
vi.mock('../lib/agents/actionGate', () => ({
  evaluateActionGate: vi.fn(async () => ({ decision: 'allow', reason: 'test mock' })),
  evaluateActionGateSync: vi.fn(() => ({ decision: 'allow', reason: 'test mock' })),
}));

// brain_query's grounding round-trip calls recallForDirective — stub it so
// these tests never touch a real brain.
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

// web_search/web_fetch's grounding round-trip calls executeTool — stub it so
// these tests never touch the real network (P1-7 fix coverage below).
const { mockExecuteTool } = vi.hoisted(() => ({
  mockExecuteTool: vi.fn(async (_tool: string, _args: unknown) => '(mock tool result)'),
}));

vi.mock('../lib/tools/toolRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tools/toolRuntime')>();
  return {
    ...actual,
    executeTool: mockExecuteTool,
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

/** Same Tauri sentinel fake managerW8cActions.test.tsx uses — the canvas
 *  create_draft/chain_agents executor cases work regardless, but seedMission
 *  below needs a real journal_emit fake so addMission/updateMission settle. */
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
  mockRecallForDirective.mockReset();
  mockRecallForDirective.mockResolvedValue('(no memory hits found)');
  mockExecuteTool.mockReset();
  mockExecuteTool.mockResolvedValue('(mock tool result)');
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async () => undefined);
  enableTauri();
});

afterEach(() => {
  disableTauri();
});

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

describe('sendManagerMessage — grounded-turn (turn-2) actions actually execute', () => {
  it('creates + chains both drafts from the GROUNDED follow-up turn, not just turn-1\'s brain_query', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    // Turn 1: the manager checks memory FIRST — matches the real composite-
    // order shape R3 reproduced (a lone grounding action, no material work
    // yet).
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'La mémoire ne remonte pas de décisions SEO spécifiques. Je crée la chaîne directement.',
      actions: [{ type: 'brain_query', query: 'seo meta title decisions' }],
      rawResponse: '',
    });
    // Turn 2 (grounded follow-up): NOW the manager actually creates + chains
    // the two drafts — these are the actions the bug discarded.
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Deux drafts créés et chaînés.',
      actions: [
        { type: 'create_draft', alias: 'a', task: 'SEO meta pass', title: 'SEO — meta & title tags' },
        { type: 'create_draft', alias: 'b', task: 'Build check + résumé', title: 'Build check' },
        { type: 'chain_agents', sourceAlias: 'a', target: { targetAlias: 'b' }, condition: 'success' },
        { type: 'arrange_canvas' },
        { type: 'focus_canvas', refAlias: 'a' },
      ],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 
        'Crée un draft SEO, chaîne un build-check après lui, range le canvas et centre la vue.',
        'haiku',
      );
    });

    expect(runManagerTurn).toHaveBeenCalledTimes(2);

    // The drafts were ACTUALLY created on the real canvas store — the crux
    // of the fix (before it: 0 drafts, chips rendered, nothing happened).
    const drafts = canvasStoreVanilla.getState().drafts;
    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.title)).toEqual(['SEO — meta & title tags', 'Build check']);

    // Chained — sourceAlias "a" / targetAlias "b" resolved to the REAL ids
    // minted for turn-2's OWN drafts, proving the aliasMap spans the whole
    // reply (a turn-2-only alias registered in turn 2 and consumed later in
    // that SAME turn-2 action list).
    const chains = canvasStoreVanilla.getState().chains;
    expect(chains).toHaveLength(1);
    const [d1, d2] = drafts;
    expect(chains[0].sourceRef).toBe(`draft:${d1.id}`);
    expect(chains[0].targetRef).toBe(`draft:${d2.id}`);

    // The rendered chips now match what actually ran — brain_query (turn 1)
    // followed by every turn-2 action, in order.
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.actions?.map((a) => a.type)).toEqual([
      'brain_query', 'create_draft', 'create_draft', 'chain_agents', 'arrange_canvas', 'focus_canvas',
    ]);
  });

  it('does not double-execute a turn-2 action that byte-identically repeats a turn-1 one', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Checking memory and noting this down.',
      actions: [
        { type: 'brain_query', query: 'topic' },
        { type: 'canvas_note', text: 'reminder' },
      ],
      rawResponse: '',
    });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Done.',
      actions: [
        { type: 'canvas_note', text: 'reminder' }, // identical repeat of turn-1's
      ],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'note this down after checking memory', 'haiku');
    });

    // Only ONE note landed — the identical turn-2 repeat was filtered, not
    // executed a second time (guard against double-executing turn-1
    // actions).
    expect(canvasStoreVanilla.getState().notes).toHaveLength(1);
  });

  it('still runs turn-1-only actions unchanged when no grounding happens at all (no regression)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Launching that now.',
      actions: [{ type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', model: 'haiku' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance @coder sur fix the bug', 'haiku');
    });

    expect(runManagerTurn).toHaveBeenCalledTimes(1);
    expect(result.current.missions.length).toBe(countBefore + 1);
  });
});

describe('sendManagerMessage — reject_mission survives a grounded exchange', () => {
  it('dispatches retryMission(feedback) even when reject_mission is a turn-2 (grounded) action', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'review', worktree: 'agent/wt-1' });
    const missionsBefore = result.current.missions.length;

    // Turn 1: the manager looks the mission up first (query_mission is a
    // grounding action — never answer status questions from memory).
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Let me pull up that mission first.',
      actions: [{ type: 'query_mission', missionId }],
      rawResponse: '',
    });
    // Turn 2 (grounded): now the manager rejects it with feedback.
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Rejecting with feedback.',
      actions: [{ type: 'reject_mission', missionId, feedback: 'the expiry check is missing — add it' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, `rejette ${missionId} avec ce feedback`, 'haiku');
    });

    await waitFor(() => expect(result.current.missions.length).toBe(missionsBefore + 1));
    const clone = result.current.missions[result.current.missions.length - 1];
    expect(clone.id).not.toBe(missionId);
    expect(clone.status).toBe('queued');
    expect(clone.agentTask).toContain('original task');
    expect(clone.agentTask).toContain('the expiry check is missing — add it');
  });
});

describe('sendManagerMessage — action dispatch failures surface honestly', () => {
  it('surfaces a visible manager-rail message for an unrecognized action type instead of a silent no-op', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Doing the thing.',
      actions: [{ type: 'not_a_real_action', foo: 'bar' } as never],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'do the unknown thing', 'haiku');
    });

    const failureMsg = result.current.managerMessages.find(
      (m) => m.role === 'assistant' && m.content.includes('not_a_real_action'),
    );
    expect(failureMsg).toBeDefined();
  });

  it('surfaces a failure for ONE bad action while still running the others in the same reply', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Doing several things.',
      actions: [
        { type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', model: 'haiku' },
        { type: 'totally_unknown_action' } as never,
      ],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'do several things', 'haiku');
    });

    // The valid action still ran...
    expect(result.current.missions.length).toBe(countBefore + 1);
    // ...and the bad one surfaced honestly instead of being swallowed.
    const failureMsg = result.current.managerMessages.find(
      (m) => m.role === 'assistant' && m.content.includes('totally_unknown_action'),
    );
    expect(failureMsg).toBeDefined();
  });
});

// ── P1-7: web_search/web_fetch grounding actions must not fake-fail ───
//
// Real bug (proven live): web_search/web_fetch are resolved upstream by
// runGroundedFollowUp (executeTool call, before executeManagerAction's
// switch even runs) exactly like brain_query/query_mission/... — but were
// MISSING from that switch's exhaustive grounding-action no-op group, so
// they fell into the `default:` case and threw "Unknown manager action
// type: web_search/web_fetch", surfacing as a fake action-execution failure
// even though the search/fetch itself had already succeeded and the
// manager's visible reply already reflected it.
describe('sendManagerMessage — web_search/web_fetch grounding actions execute cleanly (P1-7)', () => {
  it('does not surface "Unknown manager action type" for a web_search action', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Let me check the web for that.',
      actions: [{ type: 'web_search', query: 'latest Remotion release notes' }],
      rawResponse: '',
    });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Here is what I found.',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'cherche les notes de release Remotion', 'haiku');
    });

    expect(runManagerTurn).toHaveBeenCalledTimes(2);
    const failureMsg = result.current.managerMessages.find(
      (m) => m.role === 'assistant' && m.content.includes('Unknown manager action type'),
    );
    expect(failureMsg).toBeUndefined();
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toBe('Here is what I found.');
  });

  it('does not surface "Unknown manager action type" for a web_fetch action', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Let me fetch that page.',
      actions: [{ type: 'web_fetch', url: 'https://example.com/remotion-changelog' }],
      rawResponse: '',
    });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Here is the summary.',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'résume cette page', 'haiku');
    });

    expect(runManagerTurn).toHaveBeenCalledTimes(2);
    const failureMsg = result.current.managerMessages.find(
      (m) => m.role === 'assistant' && m.content.includes('Unknown manager action type'),
    );
    expect(failureMsg).toBeUndefined();
  });
});
