/**
 * canvasProjectRegistrySync.test.tsx — regression coverage for the
 * 2026-08-12 live repro (David, real app): the manager's `open_project`
 * action registered + activated a new project (localStorage and the FLUX
 * journal both confirmed it), but the Agent Canvas kept showing only the
 * project that was open at boot — the new zone never appeared, and a later,
 * UNRELATED action (a mission launch) was what finally forced a re-render,
 * at which point the canvas flipped to a completely different project set
 * and silently dropped the project that HAD been showing.
 *
 * Every existing canvas test (CanvasView.test.tsx, Cockpit.layout.test.tsx,
 * managerCanvasActions.test.tsx, scanProjectAfterOpenProject.test.tsx) either
 * passes `projects`/`fleetOverride` straight in as a fixture, or asserts on
 * `AppContext.openProjects` directly — none of them exercise the REAL
 * production wiring end to end: AppContext.registerProject (Rust-backed
 * registry) -> AppContext.openProjects -> Cockpit's live
 * `useFleetMissions()` -> CanvasView's `projects` prop -> the reconciler's
 * rendered project-zone nodes. This file closes that gap: it mounts the
 * real `<Cockpit>` tree with NO fleetOverride, drives a real `open_project`
 * manager action through the real registry-fake invoke mock, and asserts
 * the canvas's own rendered node set (not just AppContext state) reflects
 * the change immediately, in both directions — the new zone appears AND the
 * previously-open project's zone survives.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';
import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { AppProvider } from '../app/AppContext';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { Cockpit } from '../components/agents/cockpit/Cockpit';
import { ManagerHost } from '../components/lazyManager/ManagerHost';
import { ManagerHostRegistryProvider } from '../components/lazyManager/managerHostRegistry';
import { runManagerTurn } from '../lib/agents/managerEngine';
import { installReactFlowTestEnv } from './canvasTestEnv';

installReactFlowTestEnv();

const mockInvoke = vi.mocked(invoke);

function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}
function clearTauriSimulation(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

vi.mock('../lib/brain/capture', () => ({ captureAgentMission: vi.fn() }));
vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('../lib/agents/loopEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/loopEngine')>();
  return { ...actual, listLoops: vi.fn().mockResolvedValue([]) };
});
vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return { ...actual, runManagerTurn: vi.fn() };
});
vi.mock('../lib/agents/actionGate', () => ({
  evaluateActionGate: vi.fn(async () => ({ decision: 'allow', reason: 'test mock' })),
  evaluateActionGateSync: vi.fn(() => ({ decision: 'allow', reason: 'test mock' })),
}));

/** Same stateful project_register/project_set_active/project_list fake
 *  scanProjectAfterOpenProject.test.tsx already established, seeded with
 *  whatever projects are already "open at boot" (mirrors AppContext's own
 *  boot hydration reading a non-empty registry via `project_list`). */
function installProjectRegistryFake(
  seed: Array<{ id: string; root: string; active: boolean }> = [],
): { projects: Array<{ id: string; root: string; brainId: null; active: boolean }> } {
  const projects = seed.map((p) => ({ ...p, brainId: null as null }));
  let nextId = projects.length;
  mockInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
    if (cmd === 'project_register') {
      const path = (args as { path?: string } | undefined)?.path ?? '';
      const existing = projects.find((p) => p.root === path);
      if (existing) return existing;
      const entry = { id: `reg-${nextId}`, root: path, brainId: null as null, active: false };
      nextId += 1;
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
    // Every other read-model poll Cockpit's chrome mounts alongside the
    // canvas (FluxFooter's activity feed, LazyManagerComposer's @mention
    // agent list, ...) expects an ARRAY back, never `undefined` — same
    // "honest empty list, not a crash" contract those callers document.
    if (cmd === 'journal_activity_feed' || cmd === 'lazy_agents_list') return [];
    return undefined;
  });
  return { projects };
}

function ManagerProbe({ onReady }: { onReady: (store: ReturnType<typeof useAgentsStore>) => void }) {
  const store = useAgentsStore();
  onReady(store);
  return null;
}

function renderCockpitLive() {
  let latestStore: ReturnType<typeof useAgentsStore> | null = null;
  const utils = render(
    <I18nProvider>
      <ToastProvider>
        <AppProvider>
          <AgentsStoreProvider>
            <ManagerProbe onReady={(s) => { latestStore = s; }} />
            {/* Cockpit's ManagerOverlay registers into managerHostRegistry
                instead of instantiating <LazyManager> directly — see
                managerHostRegistry.tsx. Reproduced here (normally provided
                once by AppShell.tsx) so the real Cockpit tree still gets a
                rendered LazyManager. */}
            <ManagerHostRegistryProvider>
              <Cockpit onOpenLibrary={() => {}} onOpenReport={() => {}} objectivesOverride={[]} managerMessagesOverride={[]} />
              <ManagerHost activeHostId="cockpit" />
            </ManagerHostRegistryProvider>
          </AgentsStoreProvider>
        </AppProvider>
      </ToastProvider>
    </I18nProvider>,
  );
  return { ...utils, getStore: () => latestStore! };
}

async function dispatchOpenProject(store: ReturnType<typeof useAgentsStore>, path: string) {
  vi.mocked(runManagerTurn).mockResolvedValueOnce({
    responseText: 'ok',
    actions: [{ type: 'open_project', path }] as never,
    rawResponse: '',
  });
  await act(async () => {
    await store.sendManagerMessage(store.activeConversationId, 'open it', 'haiku');
  });
}

beforeEach(() => {
  vi.mocked(runManagerTurn).mockReset();
  mockInvoke.mockReset();
  simulateTauri();
});

afterEach(() => {
  clearTauriSimulation();
});

describe('Cockpit canvas — live project-registry sync (defect A regression, 2026-08-12)', () => {
  it('a project opened via the manager appears on the canvas immediately, and the project already open at boot is never dropped', async () => {
    const existingRoot = 'C:\\Users\\user\\Documents\\cerveau\\LazySite-internet';
    const newRoot = 'C:\\Users\\user\\Documents\\cerveau\\scratchpad\\uc-smoke-2026-08-12';
    installProjectRegistryFake([{ id: 'reg-existing', root: existingRoot, active: true }]);

    const { getStore } = renderCockpitLive();

    // Boot hydration: the project already open (registry non-empty) renders
    // its zone with NO extra action needed.
    expect(await screen.findByTestId('project-node-c:\\Users\\user\\Documents\\cerveau\\LazySite-internet')).toBeInTheDocument();

    // Real open_project action, exactly the manager's own executor path
    // (AppContext.registerProject, mocked Rust commands only).
    await dispatchOpenProject(getStore(), newRoot);

    // THE BUG: the canvas kept rendering only the boot-time zone here —
    // this must resolve without any further, unrelated action (no mission
    // launch, no tab switch) forcing a refresh.
    await waitFor(() => {
      expect(screen.getByTestId('project-node-c:\\Users\\user\\Documents\\cerveau\\scratchpad\\uc-smoke-2026-08-12')).toBeInTheDocument();
    });
    // THE OTHER HALF OF THE BUG: once it did catch up, the project that was
    // open before must still be there — never silently dropped.
    expect(screen.getByTestId('project-node-c:\\Users\\user\\Documents\\cerveau\\LazySite-internet')).toBeInTheDocument();
  });
});
