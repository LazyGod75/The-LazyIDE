/**
 * Tests for the canvas-parity-close LazyManager parity actions:
 *   - save_macro / instantiate_macro parsing + prompt catalog,
 *   - executor dispatch through the SAME real primitives the UI palette/
 *     context-menu use (canvasMacros.ts's captureMacro/instantiateMacro,
 *     canvasStore's addMacro/instantiateMacroResult) — no parallel path.
 *
 * Same harness as managerW8cActions.test.tsx (runManagerTurn mocked, the
 * real AgentsStoreProvider executor dispatches parsed actions).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { parseManagerActions, buildManagerSystemPrompt, runManagerTurn } from '../lib/agents/managerEngine';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { _resetChainEngineForTests } from '../lib/agents/chainEngine';
import { makeRef } from '../components/agents/canvas/canvasTypes';

const mockInvoke = vi.mocked(invoke);

vi.mock('../lib/brain/capture', () => ({ captureAgentMission: vi.fn() }));
vi.mock('../lib/brain/decisions', () => ({ createDecision: vi.fn().mockResolvedValue('decision-1') }));

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return { ...actual, runMission: vi.fn().mockResolvedValue(undefined), mergeWorktree: vi.fn().mockResolvedValue(undefined), discardWorktree: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return { ...actual, runManagerTurn: vi.fn() };
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
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async () => undefined);
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

describe('parseManagerActions — save_macro / instantiate_macro', () => {
  it('parses save_macro', () => {
    const json = '{"type": "save_macro", "name": "Tester + reviewer", "refs": ["draft:abc-123", "draft:def-456"]}';
    const actions = parseManagerActions(`<lazy_actions>\n[${json}]\n</lazy_actions>`);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual(JSON.parse(json));
  });

  it('parses instantiate_macro', () => {
    const json = '{"type": "instantiate_macro", "name": "Tester + reviewer", "projectId": "demo-shop"}';
    const actions = parseManagerActions(`<lazy_actions>\n[${json}]\n</lazy_actions>`);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual(JSON.parse(json));
  });
});

describe('buildManagerSystemPrompt — save_macro/instantiate_macro catalog', () => {
  it('documents both new action types', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).toContain('"type": "save_macro"');
    expect(prompt).toContain('"type": "instantiate_macro"');
  });
});

describe('executeManagerAction — save_macro', () => {
  it('captures the pending-only refs into a new saved macro through the real captureMacro/addMacro primitives', async () => {
    canvasStoreVanilla.getState().addDraft({ id: 'd1', title: 'Draft One', task: 'do X', createdBy: 'user' });
    canvasStoreVanilla.getState().addDraft({ id: 'd2', title: 'Draft Two', task: 'do Y', createdBy: 'user' });
    canvasStoreVanilla.getState().addChain({ id: 'c1', sourceRef: makeRef('draft', 'd1'), targetRef: makeRef('draft', 'd2'), condition: 'success', createdBy: 'user' });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'save_macro', name: 'Tester + reviewer', refs: [makeRef('draft', 'd1'), makeRef('draft', 'd2')] },
    ]);

    const macros = canvasStoreVanilla.getState().macros;
    expect(macros).toHaveLength(1);
    expect(macros[0]!.name).toBe('Tester + reviewer');
    expect(macros[0]!.drafts.map((d) => d.id).sort()).toEqual(['d1', 'd2']);
    expect(macros[0]!.chains).toHaveLength(1);
  });

  it('never saves an empty macro when none of the given refs resolve to a draft/router/note', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'save_macro', name: 'Ghost', refs: [makeRef('mission', 'does-not-exist')] },
    ]);

    expect(canvasStoreVanilla.getState().macros).toHaveLength(0);
  });
});

describe('executeManagerAction — instantiate_macro', () => {
  function seedMacro(): void {
    canvasStoreVanilla.getState().addDraft({ id: 'd1', title: 'Draft One', task: 'do X', createdBy: 'user' });
    canvasStoreVanilla.getState().setPosition(makeRef('draft', 'd1'), { x: 0, y: 0 });
    canvasStoreVanilla.getState().addMacro({
      id: 'macro-1',
      name: 'Tester + reviewer',
      drafts: [{ id: 'd1', title: 'Draft One', task: 'do X', createdBy: 'user' }],
      routers: [],
      notes: [],
      chains: [],
      positions: { [makeRef('draft', 'd1')]: { x: 0, y: 0 } },
      createdAtMs: 1000,
    });
  }

  it('drops a fresh, independently-id\'d copy onto the board (found by name, case-insensitive)', async () => {
    seedMacro();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'instantiate_macro', name: 'tester + REVIEWER' }]);

    const state = canvasStoreVanilla.getState();
    // Original macro's own draft ('d1') is untouched; a SECOND, freshly-id'd
    // draft now exists from the instantiation.
    expect(state.drafts).toHaveLength(2);
    const instantiated = state.drafts.find((d) => d.id !== 'd1')!;
    expect(instantiated).toBeDefined();
    expect(instantiated.title).toBe('Draft One');
  });

  it('reports honestly and changes nothing for an unknown macro name', async () => {
    seedMacro();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'instantiate_macro', name: 'Does Not Exist' }]);

    expect(canvasStoreVanilla.getState().drafts).toHaveLength(1); // only the macro's own original draft
  });
});
