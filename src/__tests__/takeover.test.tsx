/**
 * T1.8 — Takeover (baton-pass) tests.
 *
 * Verifies:
 *   - takeoverMission sets takenOver=true on a running mission
 *   - returnFromTakeover clears takenOver and emits takeover_returned
 *   - takeoverMission is a no-op on non-running missions
 *
 * Mocking follows revertMission.test.tsx's harness pattern.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string, _args?: Record<string, unknown>) => {
    if (cmd === 'agent_create_worktree') return Promise.resolve('/fake/wt');
    if (cmd === 'agent_merge_worktree') return Promise.resolve('fake-merge-sha');
    if (cmd === 'agent_discard_worktree') return Promise.resolve(undefined);
    if (cmd === 'agent_run') return Promise.resolve(undefined);
    if (cmd === 'agent_run_kill') return Promise.resolve(undefined);
    if (cmd === 'agent_worktree_diff') return Promise.resolve('diff --git a/foo b/foo\n+human edits');
    if (cmd === 'get_project_root') return Promise.resolve('/fake/repo');
    return Promise.resolve(undefined);
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock('../lib/platform', () => ({
  getPlatform: () => 'desktop',
  isTauri: () => true,
}));

const emitSpy = vi.fn();
vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn((e: { type: string }) => { emitSpy(e.type); return Promise.resolve(0); }),
  emitBuffered: vi.fn(() => Promise.resolve(0)),
}));

vi.mock('../lib/journal/projectId', () => ({
  projectIdFromRoot: vi.fn(() => 'test-project'),
}));

vi.mock('../lib/brain/capture', () => ({ captureAgentMission: vi.fn() }));
vi.mock('../lib/agents/missionQueue', () => ({
  enqueue: vi.fn(() => Promise.resolve()),
  updateQueuedMission: vi.fn(),
  recoverStaleMissions: vi.fn(),
}));
vi.mock('../lib/agents/runtime', () => ({
  runMission: vi.fn(() => Promise.resolve()),
  mergeWorktree: vi.fn(() => Promise.resolve()),
  discardWorktree: vi.fn(() => Promise.resolve()),
  isManagedAgentAvailable: vi.fn(() => false),
  // addMission's launch preflight (agentsStore.tsx) calls these two whenever
  // isTauri() is simulated and the mission's model classifies to a rail. They
  // must exist on the mock or vitest throws "No export is defined" the moment
  // the route resolves — a failure that only shows up under some file
  // orderings, because the model that reaches classifyMissionModel depends on
  // module-level provider state other suites may have set. Default both ready,
  // as agentsStore.silentLaunchMissionFix.test.tsx does.
  isNativeModelReady: vi.fn(() => true),
  isManagedModelReady: vi.fn(() => true),
  killAgentRun: vi.fn(() => Promise.resolve()),
  worktreeDiff: vi.fn(() => Promise.resolve('diff --git a/foo b/foo\n+human edits')),
  // scheduler.ts's resolveProvider (exercised now that addMission's launch
  // path is no longer aborted early by the updateQueuedMission fix below)
  // imports this directly from runtime — mirrors the real implementation
  // (runtime.ts) so routing stays realistic under test.
  classifyMissionModel: vi.fn((model: string | undefined) =>
    model ? (model.includes('/') ? 'managed' : 'native') : undefined,
  ),
}));
vi.mock('../lib/platform/tauri', () => ({ gitRevertMerge: vi.fn(() => Promise.resolve()) }));
vi.mock('../lib/models/usageHistory', () => ({ recordMissionCompleted: vi.fn() }));
vi.mock('../lib/bus', () => ({ on: vi.fn(() => () => undefined), emit: vi.fn() }));

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

beforeEach(() => { emitSpy.mockClear(); });
afterEach(() => { delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']; });

describe('T1.8: Takeover (baton-pass)', () => {
  it('takeoverMission sets takenOver=true on a running mission', async () => {
    simulateTauri();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    // Add a mission
    await act(async () => {
      result.current.addMission({
        title: 'Running mission', repo: '/fake/repo', worktree: 'test-branch',
        modelLabel: 'claude-sonnet', orchestrator: false,
      });
    });

    const missionId = result.current.missions[result.current.missions.length - 1].id;

    // Flip to running
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'running', progress: 50 } });
    });

    // Takeover
    await act(async () => {
      await result.current.takeoverMission(missionId);
    });

    const mission = result.current.missions.find((m) => m.id === missionId);
    expect(mission?.takenOver).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith('mission.takeover_started');
  });

  it('returnFromTakeover clears takenOver and emits takeover_returned', async () => {
    simulateTauri();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      result.current.addMission({
        title: 'Running mission 2', repo: '/fake/repo', worktree: 'test-branch-2',
        modelLabel: 'claude-sonnet', orchestrator: false,
      });
    });

    const missionId = result.current.missions[result.current.missions.length - 1].id;

    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'running', progress: 50 } });
    });

    await act(async () => {
      await result.current.takeoverMission(missionId);
    });

    await act(async () => {
      await result.current.returnFromTakeover(missionId);
    });

    const mission = result.current.missions.find((m) => m.id === missionId);
    expect(mission?.takenOver).toBe(false);
    expect(emitSpy).toHaveBeenCalledWith('mission.takeover_returned');
  });

  it('takeoverMission is a no-op on non-running missions', async () => {
    simulateTauri();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      result.current.addMission({
        title: 'Queued mission', repo: '/fake/repo', worktree: 'queued-branch',
        modelLabel: 'claude-sonnet', orchestrator: false,
      });
    });

    const missionId = result.current.missions[result.current.missions.length - 1].id;

    await act(async () => {
      await result.current.takeoverMission(missionId);
    });

    const mission = result.current.missions.find((m) => m.id === missionId);
    expect(mission?.takenOver).toBeUndefined();
    expect(emitSpy).not.toHaveBeenCalledWith('mission.takeover_started');
  });
});
