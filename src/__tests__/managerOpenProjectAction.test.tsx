/**
 * managerOpenProjectAction.test.tsx — the LazyManager's `open_project`
 * action (2026-08-01 QA fix): the manager used to have NO way to open/
 * register a project by path — a user naming a folder that was not
 * currently open hit a dead end (a doomed mission launched against the
 * wrong cwd/brain, then told to go do it themselves in the cockpit UI).
 *
 * This action reuses AppContext.registerProject VERBATIM — the exact same
 * register-then-activate primitive the welcome screen's folder picker uses
 * (see AppContext.tsx's own doc comment) — no parallel/divergent
 * implementation. Covers: parsing, prompt-catalog documentation, the
 * "management unavailable" honesty path (no AppProvider ancestor), the
 * happy path (register + activate), idempotence (re-opening an already-open
 * root just activates it, never a duplicate registry entry), and honest
 * failure surfaces for a non-existent path / a path that is a file rather
 * than a directory.
 *
 * actionGate is mocked to always allow here (same convention as
 * managerCanvasCleanupActions.test.tsx) — this file is about the ACTION's
 * own behavior once it executes; the approval-gate wiring itself (sensitive
 * tier, deferred under supervised/manual mode) is covered separately in
 * managerOpenProjectGate.test.tsx, which deliberately does NOT mock the
 * gate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { AppProvider, useAppContext } from '../app/AppContext';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { parseManagerActions, buildManagerSystemPrompt, runManagerTurn } from '../lib/agents/managerEngine';

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

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

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

beforeEach(() => {
  vi.mocked(runManagerTurn).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

async function dispatch(sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>, conversationId: string, actions: unknown[]) {
  vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: actions as never, rawResponse: '' });
  await act(async () => {
    await sendManagerMessage(conversationId, 'do it', 'haiku');
  });
}

// ── Parsing ────────────────────────────────────────────────────────────

describe('parseManagerActions — open_project', () => {
  it('parses a bare open_project action', () => {
    const text = '<lazy_actions>\n[{"type": "open_project", "path": "C:\\\\Users\\\\user\\\\Documents\\\\GameOn\\\\BackOfficeGameON"}]\n</lazy_actions>';
    const actions = parseManagerActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ type: 'open_project', path: 'C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON' });
  });
});

describe('buildManagerSystemPrompt — documents open_project', () => {
  it('includes the action in the catalog', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).toContain('"type": "open_project"');
    expect(prompt).toContain('open_project');
  });
});

// ── executor — no AppProvider ancestor ──────────────────────────────────

describe('executeManagerAction — open_project (no AppProvider ancestor)', () => {
  it('reports honestly when project management is unavailable', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'open_project', path: 'C:\\some\\path' }]);
    expect(screen.getByText('Project management is not available here')).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });
});

// ── executor — with a real AppProvider ancestor ─────────────────────────

describe('executeManagerAction — open_project (with a real AppProvider ancestor)', () => {
  beforeEach(() => {
    simulateTauri();
  });

  afterEach(() => {
    clearTauriSimulation();
  });

  it('registers AND activates the path — the exact same primitive the folder picker uses', async () => {
    const registered: string[] = [];
    const activated: string[] = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'project_register') {
        const path = (args as { path?: string } | undefined)?.path ?? '';
        registered.push(path);
        return { id: 'reg-new', root: path, brainId: null, active: false };
      }
      if (cmd === 'project_set_active') {
        activated.push((args as { id?: string } | undefined)?.id ?? '');
        return undefined;
      }
      if (cmd === 'project_list') {
        return [{ id: 'reg-new', root: 'C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON', brainId: null, active: true }];
      }
      return undefined;
    });

    const { result } = renderHook(() => useCombined(), { wrapper: appWrapper });

    await dispatch(result.current.store.sendManagerMessage, result.current.store.activeConversationId, [
      { type: 'open_project', path: 'C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON' },
    ]);

    await waitFor(() => expect(result.current.app.openProjects).toHaveLength(1));
    expect(registered).toEqual(['C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON']);
    expect(activated).toEqual(['reg-new']);
    expect(result.current.app.openProjects[0].active).toBe(true);
  });

  it('is idempotent — opening an ALREADY-open path activates it, never duplicates the registry', async () => {
    const projects = [
      { id: 'reg-active', root: 'active-root', brainId: null, active: true },
      { id: 'reg-other', root: 'other-root', brainId: null, active: false },
    ];
    const activateCalls: string[] = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'project_register') {
        // Mirrors the real Rust command: re-registering an already-open
        // (canonicalized) root returns the SAME entry, never a new one.
        return { id: 'reg-other', root: 'other-root', brainId: null, active: false };
      }
      if (cmd === 'project_set_active') {
        activateCalls.push((args as { id?: string } | undefined)?.id ?? '');
        for (const p of projects) p.active = p.id === (args as { id?: string } | undefined)?.id;
        return undefined;
      }
      if (cmd === 'project_list') return projects;
      return undefined;
    });

    const { result } = renderHook(() => useCombined(), { wrapper: appWrapper });
    await waitFor(() => expect(result.current.app.openProjects).toHaveLength(2));

    await dispatch(result.current.store.sendManagerMessage, result.current.store.activeConversationId, [{ type: 'open_project', path: 'other-root' }]);

    await waitFor(() => expect(activateCalls).toContain('reg-other'));
    // Still exactly 2 entries — no duplicate was ever created.
    expect(result.current.app.openProjects).toHaveLength(2);
    expect(result.current.app.openProjects.find((p) => p.id === 'reg-other')?.active).toBe(true);
  });

  it('reports an honest failure for a non-existent path — never a fabricated success', async () => {
    localStorage.setItem('lazy.locale', 'en');
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'project_register') {
        throw new Error("project_register: 'C:\\ghost\\nowhere' is not a directory");
      }
      if (cmd === 'project_list') return [];
      return undefined;
    });

    const { result } = renderHook(() => useCombined(), { wrapper: appWrapper });

    await dispatch(result.current.store.sendManagerMessage, result.current.store.activeConversationId, [{ type: 'open_project', path: 'C:\\ghost\\nowhere' }]);

    expect(result.current.app.openProjects).toHaveLength(0);
    expect(
      screen.getByText('Could not open project "C:\\ghost\\nowhere": project_register: \'C:\\ghost\\nowhere\' is not a directory'),
    ).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });

  it('reports an honest failure for a path that is a FILE, not a directory', async () => {
    localStorage.setItem('lazy.locale', 'en');
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'project_register') {
        throw new Error("project_register: 'C:\\Users\\user\\notes.txt' is not a directory");
      }
      if (cmd === 'project_list') return [];
      return undefined;
    });

    const { result } = renderHook(() => useCombined(), { wrapper: appWrapper });

    await dispatch(result.current.store.sendManagerMessage, result.current.store.activeConversationId, [{ type: 'open_project', path: 'C:\\Users\\user\\notes.txt' }]);

    expect(result.current.app.openProjects).toHaveLength(0);
    expect(
      screen.getByText(
        'Could not open project "C:\\Users\\user\\notes.txt": project_register: \'C:\\Users\\user\\notes.txt\' is not a directory',
      ),
    ).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });
});
