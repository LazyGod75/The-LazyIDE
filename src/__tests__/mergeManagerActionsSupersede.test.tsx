/**
 * mergeManagerActionsSupersede.test.tsx — 2026-07-28 bug fix: "last mutating
 * pass wins".
 *
 * Real user report (verbatim, 2026-07-28): asking the LazyManager "mes
 * utilisateurs se plaignent que l'app rame" made it produce, IN THE SAME
 * TURN, two different graphs — first a totally off-topic billing chain (6
 * drafts + chainings, justified in its own prose by "sur le modele deja
 * utilise pour les fonctionnalites notifications/parrainage"), then
 * immediately after, the correct one ("Audit perf" -> "Correctifs perf" ->
 * "Verif build post-perf", 3 drafts + chainings) — and BOTH graphs executed
 * onto the canvas (9 drafts total, 6 of them parasitic).
 *
 * Root cause: mergeManagerActions (agentsStore.tsx) took the plain UNION of
 * turn-1's actions and the grounded follow-up turn-2's actions, deduping
 * only byte-identical repeats. When turn-2 corrects turn-1's plan, the two
 * turns' distinct mutating actions (create_draft, chain_agents, ...) both
 * ran, because the grounded pass is meant to SUPERSEDE turn-1's decision,
 * not append to it.
 *
 * Fix: mergeManagerActions now applies "last mutating pass wins" — grounding
 * actions (brain_query/query_mission/web_search/... — see groundingDedupKey)
 * and pure display markers (info/list_agents/list_missions/canvas_overview)
 * are kept from every pass (they only build context or narrate, so keeping
 * every pass's copy is harmless); but a REAL mutating action only executes
 * from the LAST pass that proposed one — an earlier pass's mutating actions
 * are abandoned the moment a later pass emits its own.
 *
 * This file covers both levels:
 *   - Unit tests directly on mergeManagerActions/isMutantManagerAction (no
 *     rendering, no mocks) — the 5 required scenarios.
 *   - One end-to-end integration test (same AgentsStoreProvider harness as
 *     managerGroundedActions.test.tsx) reproducing the exact bug report and
 *     asserting only the 3 correct drafts land on the canvas.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  AgentsStoreProvider,
  useAgentsStore,
  mergeManagerActions,
  isMutantManagerAction,
} from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { _resetChainEngineForTests } from '../lib/agents/chainEngine';
import type { ManagerAction } from '../lib/agents/types';

// ── Pure unit tests: mergeManagerActions / isMutantManagerAction ──────────

describe('mergeManagerActions — last mutating pass wins (2026-07-28 fix)', () => {
  it('turn-1 emits 6 off-topic mutating actions, turn-2 emits 3 correct ones: only the 3 from turn-2 execute', () => {
    const turn1: ManagerAction[] = [
      { type: 'create_draft', task: 'Schema DB billing', title: 'Schema DB — billing' },
      { type: 'create_draft', task: 'API billing', title: 'API — billing' },
      { type: 'create_draft', task: 'UI liste factures', title: 'UI — liste factures' },
      { type: 'create_draft', task: 'UI detail facture', title: 'UI — detail facture' },
      { type: 'create_draft', task: 'Tests E2E billing', title: 'Tests E2E — billing' },
      { type: 'create_draft', task: 'Revue securite billing', title: 'Revue securite — billing' },
    ];
    const turn2: ManagerAction[] = [
      { type: 'create_draft', task: 'Audit perf', title: 'Audit perf — app qui rame' },
      { type: 'create_draft', task: 'Correctifs perf', title: 'Correctifs perf' },
      { type: 'create_draft', task: 'Verif build post-perf', title: 'Verif build post-perf' },
    ];

    const result = mergeManagerActions(turn1, turn2);

    expect(result.actions).toEqual(turn2);
    expect(result.supersededMutantCount).toBe(6);
  });

  it('turn-1 emits grounding actions only, turn-2 emits 3 mutating actions: all 3 execute, nothing superseded', () => {
    const turn1: ManagerAction[] = [{ type: 'brain_query', query: 'perf notifications pattern' }];
    const turn2: ManagerAction[] = [
      { type: 'create_draft', task: 'Audit perf', title: 'Audit perf' },
      { type: 'create_draft', task: 'Correctifs perf', title: 'Correctifs perf' },
      { type: 'create_draft', task: 'Verif build', title: 'Verif build' },
    ];

    const result = mergeManagerActions(turn1, turn2);

    expect(result.actions).toEqual([...turn1, ...turn2]);
    expect(result.supersededMutantCount).toBe(0);
  });

  it('turn-1 emits 2 mutating actions, turn-2 emits none: turn-1s 2 actions still execute', () => {
    const turn1: ManagerAction[] = [
      { type: 'create_draft', task: 'a', title: 'A' },
      { type: 'create_draft', task: 'b', title: 'B' },
    ];
    // turn-2 only reports back (an info action) — no mutating action of its own.
    const turn2: ManagerAction[] = [{ type: 'info', message: 'Deja decide ci-dessus.' }];

    const result = mergeManagerActions(turn1, turn2);

    expect(result.actions.filter(isMutantManagerAction)).toEqual(turn1);
    expect(result.actions).toContainEqual(turn2[0]);
    expect(result.supersededMutantCount).toBe(0);
  });

  it('single pass (turn-2 empty): behavior unchanged, nothing superseded, nothing dropped', () => {
    const turn1: ManagerAction[] = [
      { type: 'brain_query', query: 'x' },
      { type: 'create_draft', task: 'y', title: 'Y' },
    ];

    const result = mergeManagerActions(turn1, []);

    expect(result.supersededMutantCount).toBe(0);
    expect(result.actions).toHaveLength(turn1.length);
    expect(result.actions).toEqual(expect.arrayContaining(turn1));
  });

  it('never abandons grounding actions, even when a later pass supersedes the mutating ones', () => {
    const turn1: ManagerAction[] = [
      { type: 'query_mission', missionId: 'm1' },
      { type: 'create_draft', task: 'wrong', title: 'Wrong' },
    ];
    const turn2: ManagerAction[] = [
      { type: 'web_search', query: 'something' },
      { type: 'create_draft', task: 'right', title: 'Right' },
    ];

    const result = mergeManagerActions(turn1, turn2);

    // Both turns' grounding actions survive...
    expect(result.actions).toContainEqual(turn1[0]);
    expect(result.actions).toContainEqual(turn2[0]);
    // ...but only turn-2's mutating action executes.
    expect(result.actions).not.toContainEqual(turn1[1]);
    expect(result.actions).toContainEqual(turn2[1]);
    expect(result.supersededMutantCount).toBe(1);
  });
});

describe('isMutantManagerAction', () => {
  it('classifies every grounding and display-only action type as non-mutant', () => {
    const nonMutantActions: ManagerAction[] = [
      { type: 'brain_query', query: 'q' },
      { type: 'brain_query_css', selector: '.x' },
      { type: 'brain_neighbours', id: 'n1' },
      { type: 'query_mission', missionId: 'm' },
      { type: 'get_agent_output', missionId: 'm' },
      { type: 'web_search', query: 'q' },
      { type: 'web_fetch', url: 'https://example.com' },
      { type: 'briefing_query' },
      { type: 'decision_lookup', question: 'q' },
      { type: 'info', message: 'hi' },
      { type: 'list_agents' },
      { type: 'list_missions' },
      { type: 'canvas_overview' },
    ];

    for (const action of nonMutantActions) {
      expect(isMutantManagerAction(action)).toBe(false);
    }
  });

  it('classifies real side-effect actions as mutant', () => {
    const mutantActions: ManagerAction[] = [
      { type: 'create_draft', task: 't' },
      { type: 'chain_agents', sourceRef: 'draft:x', target: { draftId: 'd' } },
      { type: 'launch_mission', task: 't' },
      { type: 'clear_canvas', scope: 'drafts' },
    ];

    for (const action of mutantActions) {
      expect(isMutantManagerAction(action)).toBe(true);
    }
  });
});

// ── Integration test: the real bug, end-to-end through sendManagerMessage ──

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

beforeEach(() => {
  _resetCanvasStoreForTests();
  _resetChainEngineForTests();
  vi.mocked(runManagerTurn).mockReset();
  mockRecallForDirective.mockReset();
  mockRecallForDirective.mockResolvedValue('(no memory hits found)');
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async () => undefined);
  enableTauri();
});

afterEach(() => {
  disableTauri();
});

describe('sendManagerMessage — grounded pass supersedes an off-topic first pass (real bug reproduction)', () => {
  it('executes ONLY the 3 correct perf drafts+chains, dropping the 6 off-topic billing ones', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    // Turn 1: the manager (wrongly) reaches for the billing pattern, citing
    // memory of the notifications/parrainage features as its justification
    // — a brain_query grounding action triggers the follow-up loop.
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Je me base sur le modele deja utilise pour notifications/parrainage.',
      actions: [
        { type: 'brain_query', query: 'billing pattern notifications parrainage' },
        { type: 'create_draft', alias: 'a1', task: 'Schema DB billing', title: 'Schema DB — billing' },
        { type: 'create_draft', alias: 'a2', task: 'API billing', title: 'API — billing' },
        { type: 'create_draft', alias: 'a3', task: 'UI liste factures', title: 'UI — liste factures' },
        { type: 'create_draft', alias: 'a4', task: 'UI detail facture', title: 'UI — detail facture' },
        { type: 'create_draft', alias: 'a5', task: 'Tests E2E billing', title: 'Tests E2E — billing' },
        { type: 'create_draft', alias: 'a6', task: 'Revue securite billing', title: 'Revue securite — billing' },
        { type: 'chain_agents', sourceAlias: 'a1', target: { targetAlias: 'a2' }, condition: 'success' },
      ],
      rawResponse: '',
    });
    // Turn 2 (grounded): the memory recall shows no billing precedent — the
    // manager corrects itself onto the actually-requested perf graph.
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: "En realite la demande porte sur la lenteur de l'app, pas la facturation.",
      actions: [
        { type: 'create_draft', alias: 'b1', task: 'Audit perf', title: 'Audit perf — app qui rame' },
        { type: 'create_draft', alias: 'b2', task: 'Correctifs perf', title: 'Correctifs perf' },
        { type: 'create_draft', alias: 'b3', task: 'Verif build post-perf', title: 'Verif build post-perf' },
        { type: 'chain_agents', sourceAlias: 'b1', target: { targetAlias: 'b2' }, condition: 'success' },
        { type: 'chain_agents', sourceAlias: 'b2', target: { targetAlias: 'b3' }, condition: 'success' },
      ],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, "mes utilisateurs se plaignent que l'app rame", 'haiku');
    });

    expect(runManagerTurn).toHaveBeenCalledTimes(2);

    const drafts = canvasStoreVanilla.getState().drafts;
    expect(drafts).toHaveLength(3);
    expect(drafts.map((d) => d.title).sort()).toEqual(
      ['Audit perf — app qui rame', 'Correctifs perf', 'Verif build post-perf'].sort(),
    );

    // Only the 2 perf chainings exist — the billing chain never ran.
    const chains = canvasStoreVanilla.getState().chains;
    expect(chains).toHaveLength(2);
  });
});

describe('sendManagerMessage — single pass, no grounding (regression guard)', () => {
  it('executes turn-1 actions unchanged when nothing triggers a grounded follow-up', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Lancement en cours.',
      actions: [{ type: 'launch_mission', agentName: 'coder', task: 'Fix the perf issue', model: 'haiku' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance un correctif perf', 'haiku');
    });

    expect(runManagerTurn).toHaveBeenCalledTimes(1);
    expect(result.current.missions.length).toBe(countBefore + 1);
  });
});
