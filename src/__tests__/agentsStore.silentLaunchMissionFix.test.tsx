/**
 * agentsStore.silentLaunchMissionFix.test.tsx — regression coverage for THE
 * #1 remaining founder-reported bug (4 documented occurrences, 2026-08-07):
 * a launch_mission action goes through approval, the chat chip reads
 * "Lancée : ...", the approval card flips to "Approuvée" — then NOTHING:
 * no journal row, no mission, no error, silence.
 *
 * Root causes fixed (both in agentsStore.tsx):
 *
 *   1. addMission had NO engine-readiness preflight for the mission's own
 *      chosen model — only the agent:launch bus-event listener (composer's
 *      "Lancer comme agent" button, see its own "Preflight (FIX B)" doc
 *      comment) ever called getEngineReadiness() before reaching addMission;
 *      the manager's OWN launch_mission executor case called addMission
 *      directly with no readiness gate at all. A not-ready engine (Lazy Pro
 *      plan active but 0 credits, or an explicitly-requested native model
 *      with no CLI detected) sailed through real worktree creation and brain
 *      recall before failing deep inside planAndAct's own mismatch branch,
 *      if the failure surfaced at all. Fixed with a THIRD row-first
 *      preflight inside addMission (same shape as the pre-existing
 *      session-cap / out-of-scope-path checks right above it): the mission
 *      row is created FIRST, then immediately patched to status:'failed'
 *      with a precise statusReason when the resolved model's rail isn't
 *      ready — same visible outcome as the pre-existing scope-guard case
 *      (mission M66).
 *
 *   2. approvePendingAction treated ANY non-throwing executeManagerAction
 *      result as success — including a real `{ failed: true, message }`
 *      outcome (the established soft-failure convention launch_mission's
 *      own resolveDraftProjectId branch, generate_plan, and execute_plan all
 *      already used) — flipping the card to "Approuvée" and removing the
 *      entry even though the action genuinely did nothing. Fixed by
 *      re-throwing on `outcome?.failed` so the SAME battle-tested catch
 *      block (stays pending, red chip, real reason, canForce) handles it.
 *
 * Harness mirrors pendingApprovals.test.tsx (gate-deferred action +
 * approvePendingAction, actionGate left REAL so launch_mission's own
 * SENSITIVE_ACTIONS classification actually defers it under the default
 * 'supervised' autonomy mode) and agentsStore.test.tsx's
 * simulateTauri()/setManagedAvailability() helpers (mode-aware model
 * resolution needs a simulated Tauri runtime).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { AppProvider } from '../app/AppContext';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import { runMission, isManagedModelReady, isNativeModelReady } from '../lib/agents/runtime';
import { setManagedAvailability } from '../lib/models/index';
import { _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';

const mockInvoke = vi.mocked(invoke);

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

// isManagedModelReady/isNativeModelReady replaced with controllable spies
// (default: both ready). classifyMissionModel and everything else in
// runtime.ts stays REAL, so route-kind classification (managed vs native —
// whether the resolved model id contains '/') is the actual production
// logic, never re-implemented here.
vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    isManagedModelReady: vi.fn(() => true),
    isNativeModelReady: vi.fn(() => true),
  };
});

function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

function clearProviderModeSimulation(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  setManagedAvailability(false);
  localStorage.clear();
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

async function dispatch(
  sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>,
  conversationId: string,
  actions: unknown[],
) {
  vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: actions as never, rawResponse: '' });
  await act(async () => {
    await sendManagerMessage(conversationId, 'lance la mission', 'claude-sonnet-5');
  });
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  vi.mocked(runManagerTurn).mockReset();
  vi.mocked(runMission).mockClear();
  vi.mocked(isManagedModelReady).mockReturnValue(true);
  vi.mocked(isNativeModelReady).mockReturnValue(true);
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

afterEach(() => {
  clearProviderModeSimulation();
});

describe('launch_mission via approval — engine-readiness preflight (row-first, never silent)', () => {
  it('Pro rail with 0 credits: mission row is created FAILED with the exact founder-specified reason — never silence', async () => {
    simulateTauri();
    vi.mocked(isManagedModelReady).mockReturnValue(false);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', engine: 'pro' },
    ]);
    expect(result.current.pendingApprovals).toHaveLength(1);
    const pendingId = result.current.pendingApprovals[0]!.id;

    let outcome!: { ok: boolean };
    await act(async () => {
      outcome = await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });

    // The launch action itself "went through" (a real, inspectable mission
    // exists) — same honest shape as the pre-existing scope-guard case: the
    // approval resolves, and the FAILURE lives loudly on the mission row.
    expect(outcome.ok).toBe(true);
    expect(result.current.pendingApprovals).toHaveLength(0);
    expect(result.current.missions.length).toBe(countBefore + 1);

    const mission = result.current.missions[result.current.missions.length - 1]!;
    expect(mission.status).toBe('failed');
    expect(mission.statusReason).toBe(
      "Lancement refusé : le moteur Pro n'a plus de crédits — choisis un autre moteur.",
    );
    // Never reached dispatch — proves this is the EARLY row-first preflight,
    // not the pre-existing deep planAndAct mismatch path.
    expect(vi.mocked(runMission)).not.toHaveBeenCalled();
  });

  it('native rail with no CLI detected: mission row is created FAILED with a precise reason — never silence', async () => {
    simulateTauri();
    vi.mocked(isNativeModelReady).mockReturnValue(false);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', model: 'sonnet', engine: 'cli' },
    ]);
    expect(result.current.pendingApprovals).toHaveLength(1);
    const pendingId = result.current.pendingApprovals[0]!.id;

    await act(async () => {
      await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });

    expect(result.current.missions.length).toBe(countBefore + 1);
    const mission = result.current.missions[result.current.missions.length - 1]!;
    expect(mission.status).toBe('failed');
    expect(mission.statusReason).toBe(
      'Lancement refusé : le CLI Claude/Codex est introuvable — choisis un autre moteur.',
    );
    expect(vi.mocked(runMission)).not.toHaveBeenCalled();
  });

  it('happy path unchanged: a ready engine still launches for real (queued row, Approuvée, runMission dispatched)', async () => {
    simulateTauri(); // both readiness mocks default to ready (see beforeEach)

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', model: 'sonnet', engine: 'cli' },
    ]);
    expect(result.current.pendingApprovals).toHaveLength(1);
    const pendingId = result.current.pendingApprovals[0]!.id;

    let outcome!: { ok: boolean };
    await act(async () => {
      outcome = await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });

    expect(outcome.ok).toBe(true);
    expect(result.current.pendingApprovals).toHaveLength(0);
    expect(result.current.missions.length).toBe(countBefore + 1);
    const mission = result.current.missions[result.current.missions.length - 1]!;
    expect(mission.status).toBe('queued');
    expect(mission.statusReason).toBeUndefined();
    expect(vi.mocked(runMission)).toHaveBeenCalledTimes(1);
  });
});

describe('launch_mission via approval — executor throw mid-launch (never silent)', () => {
  it('an unknown modelId throws BEFORE addMission — approval stays pending with the real reason, no mission created', async () => {
    simulateTauri();
    setManagedAvailability(true);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;
    const messagesBefore = result.current.managerMessages.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', modelId: 'not-a-real/model-id' },
    ]);
    expect(result.current.pendingApprovals).toHaveLength(1);
    const pendingId = result.current.pendingApprovals[0]!.id;

    let outcome!: { ok: boolean; reason?: string };
    await act(async () => {
      outcome = await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('not-a-real/model-id');
    // NEVER removed as if resolved positively.
    expect(result.current.pendingApprovals).toHaveLength(1);
    expect(result.current.pendingApprovals[0]!.lastFailure?.reason).toContain('not-a-real/model-id');
    // No mission was silently created on some fallback default model.
    expect(result.current.missions.length).toBe(countBefore);
    // The manager reads the real reason on its next turn (managerMessages
    // feeds straight into the next sendManagerMessage's conversation history).
    const messages = result.current.managerMessages;
    expect(messages.length).toBeGreaterThan(messagesBefore);
    expect(messages.map((m) => m.content).join(' | ')).toContain('not-a-real/model-id');
  });
});

describe('launch_mission via approval — a real {failed:true} outcome must never read as Approuvée', () => {
  it('an unresolved projectId name (resolveDraftProjectId) stays pending with the real reason instead of flipping to Approuvée', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', projectId: 'totally-unknown-project-xyz' },
    ]);
    expect(result.current.pendingApprovals).toHaveLength(1);
    const pendingId = result.current.pendingApprovals[0]!.id;

    let outcome!: { ok: boolean; reason?: string };
    await act(async () => {
      outcome = await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('totally-unknown-project-xyz');
    // NEVER removed / flipped to "Approuvée" on a real {failed:true} outcome.
    expect(result.current.pendingApprovals).toHaveLength(1);
    expect(result.current.pendingApprovals[0]!.lastFailure?.reason).toContain('totally-unknown-project-xyz');
    const msg = result.current.managerMessages.find((m) => m.actions?.some((a) => a.type === 'launch_mission'));
    expect(msg?.actionStatuses?.[0]).toBe(false);
    expect(result.current.missions.length).toBe(countBefore);
  });
});

// BUG 1 fix (LazyManager QA, 2026-08-07): launch_mission at a KNOWN-but-not-
// OPEN project (name matches AppContext's `lazy.projects.recent` MRU list)
// must auto-open it inline instead of dead-ending with "is not open — cannot
// launch a mission at it". Needs AppProvider (registerProject lives there)
// on top of the usual wrapper — the other describe blocks above never wrap
// AppProvider, so appContext is null and this path is a no-op for them.
function wrapperWithApp({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AppProvider>
          <AgentsStoreProvider>{children}</AgentsStoreProvider>
        </AppProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

describe('launch_mission at a known-but-closed project — auto-open via recents (BUG 1 fix)', () => {
  it('a projectId name matching a recent (closed) root is auto-opened and the mission launches for real', async () => {
    simulateTauri();
    const root = 'C:\\Users\\user\\Documents\\cerveau\\LazySite-internet';
    localStorage.setItem(
      'lazy.projects.recent',
      JSON.stringify([{ root, lastOpenedMs: Date.now() }]),
    );
    // Registry starts EMPTY — resolveDraftProjectId's first pass must find
    // nothing (the project is genuinely not open yet) so the auto-open
    // branch is the ONLY way `project_register` gets called; only after
    // that call does `project_list` start reporting the project as open,
    // same as the real Rust registry's own before/after behavior.
    let registered = false;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'project_register') {
        registered = true;
        return { id: 'proj-1', root, active: false };
      }
      if (cmd === 'project_set_active') return undefined;
      if (cmd === 'project_list') return registered ? [{ id: 'proj-1', root, active: true }] : [];
      return undefined;
    });

    const { result } = renderHook(() => useAgentsStore(), { wrapper: wrapperWithApp });
    const countBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', model: 'sonnet', engine: 'cli', projectId: 'LazySite-internet' },
    ]);
    expect(result.current.pendingApprovals).toHaveLength(1);
    const pendingId = result.current.pendingApprovals[0]!.id;

    let outcome!: { ok: boolean; reason?: string };
    await act(async () => {
      outcome = await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });

    // Never blocked — the project was opened inline and the mission launched.
    expect(outcome.ok).toBe(true);
    expect(result.current.pendingApprovals).toHaveLength(0);
    expect(result.current.missions.length).toBe(countBefore + 1);
    const mission = result.current.missions[result.current.missions.length - 1]!;
    expect(mission.status).not.toBe('failed');
    expect(mockInvoke).toHaveBeenCalledWith('project_register', { path: root });
  });

  it('a name with no recent match still gets the honest, unchanged failure (never a guessed root)', async () => {
    simulateTauri();
    localStorage.removeItem('lazy.projects.recent');
    // wrapperWithApp mounts AppProvider, whose own boot effect calls
    // listProjects() ('project_list') and expects an array back — return []
    // rather than the file's default `undefined` (which the other describe
    // blocks' bare-AgentsStoreProvider wrapper never exercises) so that
    // effect doesn't reject.
    mockInvoke.mockImplementation(async (cmd: string) => (cmd === 'project_list' ? [] : undefined));

    const { result } = renderHook(() => useAgentsStore(), { wrapper: wrapperWithApp });
    const countBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', projectId: 'never-seen-before-project' },
    ]);
    expect(result.current.pendingApprovals).toHaveLength(1);
    const pendingId = result.current.pendingApprovals[0]!.id;

    let outcome!: { ok: boolean; reason?: string };
    await act(async () => {
      outcome = await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('never-seen-before-project');
    expect(result.current.missions.length).toBe(countBefore);
  });
});
