/**
 * missionScopeGuardLaunch.test.tsx — integration coverage for Part C of the
 * "wrong-context mission" QA fix (2026-08-01): addMission must no longer
 * silently launch a mission whose task names an absolute path OUTSIDE the
 * resolved project root against that WRONG root's cwd/worktree/brain.
 *
 * Real repro this closes: a user asked the manager to finish a project at
 * an absolute path that was not the active project; the mission launched
 * anyway and ran (recon, brain_search, everything) against the ACTIVE
 * project's cwd/brain instead — wrong context all the way down, only
 * discovered once the judge rejected the mission.
 *
 * `get_project_root` is deliberately made to HANG (never()) and the fake
 * timer advanced past PROJECT_ROOT_RESOLVE_TIMEOUT_MS, same technique
 * agentsStore.missionLaunchStall.test.tsx's own "addMission — launch
 * proceeds when resolveProjectRoot falls back" suite already proves
 * reliable — resolveProjectRoot degrades deterministically to the
 * caller-supplied `input.repo` fallback (see resolveProjectRoot's own doc
 * comment) instead of racing several concurrent bare `resolveProjectRoot()`
 * calls addMission's OWN bookkeeping (queue/journal) fires independently
 * against a real `get_project_root` resolution — a real but orthogonal
 * source of test flake this suite does not need to fight to prove the
 * guard's behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';

const never = () => new Promise<never>(() => {});

const { mockInvoke, mockRunMission, mockEmitEvent } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockRunMission: vi.fn(),
  mockEmitEvent: vi.fn((_e: unknown) => Promise.resolve(0)),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
  emit: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/brain/capture', () => ({ captureAgentMission: vi.fn() }));

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: mockRunMission,
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../lib/journal/journal', () => ({
  emitEvent: mockEmitEvent,
  emitBuffered: vi.fn(() => Promise.resolve(0)),
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

function baseMissionInput(overrides: Partial<Parameters<ReturnType<typeof useAgentsStore>['addMission']>[0]> = {}) {
  return {
    title: 'Scope guard repro',
    repo: 'C:\\Users\\user\\Documents\\cerveau\\LazySite-internet',
    worktree: '',
    modelLabel: 'claude-sonnet-5',
    mode: 'agent' as const,
    orchestrator: false,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  // Deliberately hangs — every resolveProjectRoot() call (addMission's own
  // AND any incidental bare call from queue/journal bookkeeping) degrades to
  // ITS OWN caller-supplied fallback (or '.' when none was given) once
  // PROJECT_ROOT_RESOLVE_TIMEOUT_MS fires, instead of racing a real
  // get_project_root resolution across several concurrent callers.
  mockInvoke.mockReset().mockImplementation((cmd: string) => (cmd === 'get_project_root' ? never() : Promise.resolve(undefined)));
  mockRunMission.mockReset().mockResolvedValue(undefined);
  mockEmitEvent.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

async function addMissionPastTimeout(
  result: { current: ReturnType<typeof useAgentsStore> },
  input: Partial<Parameters<ReturnType<typeof useAgentsStore>['addMission']>[0]>,
): Promise<void> {
  vi.useFakeTimers();
  let addMissionPromise!: Promise<string>;
  act(() => {
    addMissionPromise = result.current.addMission(baseMissionInput(input));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(11_000);
  });
  await act(async () => {
    await addMissionPromise;
  });
  vi.useRealTimers();
}

describe('addMission — refuses a task targeting a path outside the active project', () => {
  it('blocks the launch, never calls runMission, and leaves an honest statusReason', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await addMissionPastTimeout(result, {
      title: 'Finish BackOfficeGameON',
      agentTask: 'Finish the project at C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON — it needs a missing export fixed.',
    });

    const mission = result.current.missions.find((m) => m.title === 'Finish BackOfficeGameON')!;
    expect(mission).toBeDefined();
    expect(mission.status).toBe('failed');
    expect(mission.statusReason).toContain('C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON');
    expect(mission.statusReason).toContain('LazySite-internet');
    expect(mockRunMission).not.toHaveBeenCalled();
    expect(mockEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mission.blocked',
        missionId: mission.id,
        payload: { reason: 'out_of_scope_path' },
      }),
    );
  });

  it('never fires for a task confined to the active project (no false positive on ordinary work)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await addMissionPastTimeout(result, {
      title: 'Fix README typos',
      agentTask: 'Read C:\\Users\\user\\Documents\\cerveau\\LazySite-internet\\README.md and fix typos.',
    });

    const mission = result.current.missions.find((m) => m.title === 'Fix README typos')!;
    expect(mission.status).not.toBe('failed');
    expect(mockRunMission).toHaveBeenCalledTimes(1);
  });

  it('never fires when the task carries no absolute path at all (the common case)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await addMissionPastTimeout(result, { title: 'Ordinary task', agentTask: 'Fix the typos in the README.' });

    const mission = result.current.missions.find((m) => m.title === 'Ordinary task')!;
    expect(mission.status).not.toBe('failed');
    expect(mockRunMission).toHaveBeenCalledTimes(1);
  });

  // Extra-readable-roots fix (2026-08-18, real repro: a 12-step Lazy-Docs
  // plan — M66/M67/M68 — every step of which declared
  // extraReadableProjectIds: ["Lazy"] and was blocked at launch anyway,
  // zero worktrees created). Mission.extraReadableRoots (already-resolved
  // absolute roots — see its own doc comment, types.ts) is set directly
  // here rather than via extraReadableProjectIds resolution, matching how
  // addMission itself receives it (already resolved, by the SGR
  // launchMission callback / launch_mission executor — agentsStore.tsx).

  it('launches when the task path lies under a DECLARED extraReadableRoots entry', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await addMissionPastTimeout(result, {
      title: 'Document the Lazy tree',
      agentTask: 'Lire directement sur disque l\'arbre reel de C:\\Users\\user\\Documents\\cerveau\\Lazy\\src et documenter.',
      extraReadableRoots: ['C:\\Users\\user\\Documents\\cerveau\\Lazy'],
    });

    const mission = result.current.missions.find((m) => m.title === 'Document the Lazy tree')!;
    expect(mission).toBeDefined();
    expect(mission.status).not.toBe('failed');
    expect(mockRunMission).toHaveBeenCalledTimes(1);
  });

  it('still blocks the identical task path when extraReadableRoots is NOT declared', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await addMissionPastTimeout(result, {
      title: 'Document the Lazy tree (no declaration)',
      agentTask: 'Lire directement sur disque l\'arbre reel de C:\\Users\\user\\Documents\\cerveau\\Lazy\\src et documenter.',
    });

    const mission = result.current.missions.find((m) => m.title === 'Document the Lazy tree (no declaration)')!;
    expect(mission).toBeDefined();
    expect(mission.status).toBe('failed');
    expect(mockRunMission).not.toHaveBeenCalled();
    expect(mockEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mission.blocked',
        missionId: mission.id,
        payload: { reason: 'out_of_scope_path' },
      }),
    );
  });

  it('still blocks a task path in a THIRD, undeclared project even with a different extraReadableRoots entry declared', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await addMissionPastTimeout(result, {
      title: 'Wrong target despite declaration',
      agentTask: 'Finish the project at C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON — it needs a missing export fixed.',
      extraReadableRoots: ['C:\\Users\\user\\Documents\\cerveau\\Lazy'],
    });

    const mission = result.current.missions.find((m) => m.title === 'Wrong target despite declaration')!;
    expect(mission).toBeDefined();
    expect(mission.status).toBe('failed');
    expect(mission.statusReason).toContain('C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON');
    expect(mockRunMission).not.toHaveBeenCalled();
    expect(mockEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mission.blocked',
        missionId: mission.id,
        payload: { reason: 'out_of_scope_path' },
      }),
    );
  });
});
