/**
 * agentsStore.staleRunIdempotent.test.tsx — regression coverage for the
 * "M5" defect described in the founder's live repro (2026-08-15): a mission
 * that had already merged cleanly (status 'done', merged: true) through one
 * runMission dispatch was later reported "a échoué" in the fleet signal —
 * an already-successful mission getting silently regressed to 'failed'.
 *
 * Root cause: applyRunUpdate (agentsStore.tsx) is the SHARED onUpdate
 * callback passed to every runMission(...) call site. It applied ANY patch
 * unconditionally, with no awareness of the mission's own current state —
 * unlike updateMission's own terminal-transition guards, or
 * approveMissionInner's stale-approval idempotency fix (4464446,
 * agentsStore.staleApprovalIdempotent.test.tsx), there was NO protection
 * against a SLOWER, superseded runMission call (a duplicate dispatch, a
 * race between two relaunch attempts, or any other concurrent run for the
 * SAME mission id) still streaming its own onUpdate patches — including its
 * own catch-driven status:'failed' flip — long after the mission already
 * reached its real terminal state (done + merged) through a different,
 * faster run.
 *
 * Fixed in agentsStore.tsx's applyRunUpdate: a patch that would move a
 * mission's status AWAY from 'done' is now refused once the mission is
 * already done+merged — mirroring the exact idempotent-no-op shape
 * approveMissionInner already uses for the analogous stale-approval case.
 *
 * Harness: addMission's own runMission call site with runMission mocked as
 * a controllable vi.fn() so the test can (1) capture the exact onUpdate
 * closure addMission wired up, (2) move the mission to done+merged through
 * a SEPARATE call (mirroring a real, faster merge landing through
 * approveMission/auto-merge), then (3) invoke the captured onUpdate
 * directly with a stale, late patch — exactly what a slower/duplicate
 * runMission run would still be able to do without this fix.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runMission } from '../lib/agents/runtime';
import type { MissionUpdate } from '../lib/agents/runtime';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
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

/** Pulls the `onUpdate` closure addMission's own runMission dispatch wired
 *  up for its most recent call — the exact function a real (or, for this
 *  regression, a stale/superseded) runMission run streams patches through. */
function lastOnUpdate(): (update: MissionUpdate) => void {
  const calls = vi.mocked(runMission).mock.calls;
  const last = calls[calls.length - 1];
  return (last[2] as { onUpdate: (update: MissionUpdate) => void }).onUpdate;
}

beforeEach(() => {
  vi.mocked(runMission).mockClear();
});

afterEach(() => {
  vi.mocked(runMission).mockReset().mockResolvedValue(undefined);
});

describe('applyRunUpdate — stale-run idempotency (real user report, "M5" incident)', () => {
  it('a stale status:"failed" patch from a superseded run is ignored once the mission is already done+merged', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    let missionId = '';
    await act(async () => {
      missionId = await result.current.addMission({
        title: 'One-line prop edit',
        repo: '.',
        worktree: 'agent/m5-test',
        modelLabel: 'claude-sonnet-5',
        mode: 'agent',
        orchestrator: false,
      });
    });

    const onUpdate = lastOnUpdate();

    // The mission merges for real through a DIFFERENT, faster path (a
    // direct "Merger" click, or auto-merge — either way, updateMission is
    // the choke point that flips it).
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'done', merged: true } });
    });
    expect(result.current.missions.find((m) => m.id === missionId)?.status).toBe('done');

    // The SLOWER, now-superseded run (the one whose onUpdate we captured
    // above) finally settles and streams its own late, stale failure patch.
    act(() => {
      onUpdate({ id: missionId, patch: { status: 'failed', statusReason: 'stale timeout' } });
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
    expect(mission.statusReason).not.toBe('stale timeout');
  });

  it('a non-status patch (e.g. a stray progress update) from a superseded run is also ignored once done+merged', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    let missionId = '';
    await act(async () => {
      missionId = await result.current.addMission({
        title: 'Another mission',
        repo: '.',
        worktree: 'agent/m5b-test',
        modelLabel: 'claude-sonnet-5',
        mode: 'agent',
        orchestrator: false,
      });
    });

    const onUpdate = lastOnUpdate();

    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'done', merged: true } });
    });

    act(() => {
      onUpdate({ id: missionId, patch: { status: 'running', progress: 42, liveAction: 'still going?' } });
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
  });

  it('control: a patch is applied normally for a mission that is NOT yet done+merged', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    let missionId = '';
    await act(async () => {
      missionId = await result.current.addMission({
        title: 'Still running mission',
        repo: '.',
        worktree: 'agent/m5c-test',
        modelLabel: 'claude-sonnet-5',
        mode: 'agent',
        orchestrator: false,
      });
    });

    const onUpdate = lastOnUpdate();

    act(() => {
      onUpdate({ id: missionId, patch: { status: 'review', diffAdded: 3, diffRemoved: 1 } });
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('review');
    expect(mission.diffAdded).toBe(3);
  });

  it('control: status:"done" repeated (not a regression) still applies normally once already done+merged', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    let missionId = '';
    await act(async () => {
      missionId = await result.current.addMission({
        title: 'Redundant done patch',
        repo: '.',
        worktree: 'agent/m5d-test',
        modelLabel: 'claude-sonnet-5',
        mode: 'agent',
        orchestrator: false,
      });
    });

    const onUpdate = lastOnUpdate();

    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'done', merged: true } });
    });

    act(() => {
      onUpdate({ id: missionId, patch: { status: 'done', progress: 100 } });
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.progress).toBe(100);
  });
});
