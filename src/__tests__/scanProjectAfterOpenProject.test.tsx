/**
 * scanProjectAfterOpenProject.test.tsx — regression coverage for the
 * 2026-08-05 prod bug (diagnosed live by LazyManager itself): `open_project`
 * registers a path, the zone appears on the canvas, but the VERY NEXT
 * `scan_project` call rejects that same project with "not a currently open
 * project".
 *
 * Root cause: `resolveProjectRootById`/`resolveDraftProjectId`
 * (canvas/canvasDigest.ts) compared an ALREADY-normalized directory key
 * (`projectIdFromRoot(p.root)` — lowercase drive letter) against the RAW
 * `projectId`/path argument a caller supplies, unnormalized. In the real
 * repro, the manager reused the exact path it had just passed to
 * `open_project` (still "C:\..." uppercase-drive, exactly as the user typed
 * it) as `scan_project`'s `projectId` — a byte-for-byte equality check that
 * can never match a normalized key.
 *
 * This file drives the REAL end-to-end path: sendManagerMessage dispatches
 * `open_project` (real AppContext.registerProject, mocked Tauri commands),
 * then a SEPARATE sendManagerMessage dispatches `scan_project` with that
 * exact same raw path as `projectId` — proving the fix at the one place a
 * silent regression would actually be user-visible again, not just at the
 * unit level (see canvasDigest.test.ts for the direct
 * resolveProjectRootById/resolveDraftProjectId coverage).
 *
 * Harness copied verbatim from managerOpenProjectAction.test.tsx (open_project
 * wiring) + managerGroundedActions.test.tsx (grounded-turn observation
 * inspection) — no new pattern invented.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { AppProvider, useAppContext } from '../app/AppContext';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';

const mockInvoke = vi.mocked(invoke);

function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}
function clearTauriSimulation(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

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

function appWrapper({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider>
      <I18nProvider>
        <ToastProvider>
          <AgentsStoreProvider>{children}</AgentsStoreProvider>
        </ToastProvider>
      </I18nProvider>
    </AppProvider>
  );
}

function useCombined() {
  return { app: useAppContext(), store: useAgentsStore() };
}

async function dispatch(
  sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>,
  conversationId: string,
  ...turns: Array<{ actions: unknown[]; responseText?: string }>
) {
  for (const turn of turns) {
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: turn.responseText ?? 'ok',
      actions: turn.actions as never,
      rawResponse: '',
    });
  }
  await act(async () => {
    await sendManagerMessage(conversationId, 'do it', 'haiku');
  });
}

/** Stateful project_register/project_set_active/project_list fake — mirrors
 *  the real Rust registry closely enough for this test: registering a path
 *  stores it VERBATIM (no case/slash normalization on write, exactly like
 *  the real `project_register` backed by `std::fs::canonicalize`), and
 *  `project_list` reflects whatever was registered. */
function installProjectRegistryFake(): { registered: string[] } {
  const registered: string[] = [];
  const projects: Array<{ id: string; root: string; brainId: null; active: boolean }> = [];
  mockInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
    if (cmd === 'project_register') {
      const path = (args as { path?: string } | undefined)?.path ?? '';
      registered.push(path);
      const entry = { id: 'reg-1', root: path, brainId: null, active: false };
      projects.push(entry);
      return entry;
    }
    if (cmd === 'project_set_active') {
      const id = (args as { id?: string } | undefined)?.id ?? '';
      for (const p of projects) p.active = p.id === id;
      return undefined;
    }
    if (cmd === 'project_list') return projects;
    if (cmd === 'journal_missions_current') return [];
    // Every other command (fs/git/codegraph probes inside buildProjectDigest)
    // degrades gracefully in its own caller — see projectDigest.ts's "never
    // throws" contract — so an honest rejection here is safe.
    throw new Error(`unmocked invoke: ${cmd}`);
  });
  return { registered };
}

beforeEach(() => {
  vi.mocked(runManagerTurn).mockReset();
  mockInvoke.mockReset();
  simulateTauri();
});

afterEach(() => {
  clearTauriSimulation();
});

describe('scan_project right after open_project — same raw path, different drive-letter case only on the STORED side', () => {
  it('does NOT reject the just-opened project as "not a currently open project"', async () => {
    const rawPath = 'C:\\Users\\user\\Documents\\cerveau\\LazySite-internet';
    installProjectRegistryFake();

    const { result } = renderHook(() => useCombined(), { wrapper: appWrapper });

    // Turn A: open_project (mutating action, single runManagerTurn call).
    await dispatch(result.current.store.sendManagerMessage, result.current.store.activeConversationId, {
      actions: [{ type: 'open_project', path: rawPath }],
    });
    await waitFor(() => expect(result.current.app.openProjects).toHaveLength(1));

    // Turn B: scan_project, reusing the EXACT same raw path as projectId —
    // the real repro (the manager echoing its own just-used open_project
    // argument). scan_project is a grounding action, so this dispatch needs
    // TWO queued runManagerTurn results: the main turn proposing scan_project,
    // then the grounded follow-up that receives the observation.
    await dispatch(
      result.current.store.sendManagerMessage,
      result.current.store.activeConversationId,
      { actions: [{ type: 'scan_project', projectId: rawPath }], responseText: 'Scanning that project now.' },
      { actions: [], responseText: 'Here is what I found.' },
    );

    expect(runManagerTurn).toHaveBeenCalledTimes(3);
    const groundedCallArgs = vi.mocked(runManagerTurn).mock.calls[2][0];
    const observationMsg = groundedCallArgs.messages.find((m) => m.content.includes('[SYSTEM OBSERVATION'));
    expect(observationMsg).toBeDefined();
    // The bug: this used to contain "not a currently open project".
    expect(observationMsg?.content).not.toContain('not a currently open project');
    // The fix: a real digest was produced instead.
    expect(observationMsg?.content).toContain('scan_project(');
  });
});

describe('scan_project — a project that really is not open is still rejected', () => {
  it('keeps the honest "not a currently open project" rejection for an unknown id', async () => {
    installProjectRegistryFake(); // nothing registered — directory stays empty

    const { result } = renderHook(() => useCombined(), { wrapper: appWrapper });

    await dispatch(
      result.current.store.sendManagerMessage,
      result.current.store.activeConversationId,
      { actions: [{ type: 'scan_project', projectId: 'c:\\nowhere\\ghost-project' }], responseText: 'Scanning.' },
      { actions: [], responseText: 'Done.' },
    );

    expect(runManagerTurn).toHaveBeenCalledTimes(2);
    const groundedCallArgs = vi.mocked(runManagerTurn).mock.calls[1][0];
    const observationMsg = groundedCallArgs.messages.find((m) => m.content.includes('[SYSTEM OBSERVATION'));
    expect(observationMsg?.content).toContain('not a currently open project');
  });
});
