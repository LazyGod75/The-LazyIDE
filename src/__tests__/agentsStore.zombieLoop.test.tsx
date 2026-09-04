/**
 * agentsStore.zombieLoop.test.tsx — P51 ZOMBIE LOOP fix coverage.
 *
 * Before this fix, merge/archive/delete never touched the loop registry
 * (loops.json) — only the explicit loop-detail actions (toggleLoop/
 * deleteLoop) ever called disableLoop/unregisterLoop. A loop mission that
 * got merged, archived, or deleted through ANY other path (a normal
 * "Merger" click, the manager's approve_mission tool, the canvas's
 * "Archiver"/"Supprimer" actions) kept its loop enabled in the registry,
 * so the scheduler kept firing new iterations against a mission that no
 * longer meaningfully existed — the opposite of "never saturate the
 * user's machine, no manual unblocking ever".
 *
 * These tests exercise the REAL loopEngine persistence (an in-memory fake
 * filesystem behind the real WebPlatform, so state genuinely round-trips)
 * through the store's public approveMission/archiveMission/deleteMission —
 * the same real choke points a user's click goes through, not a
 * reimplementation of the fix's own logic.
 *
 * Boot re-stamp coverage (seedJournaledMissions) lives in its own describe
 * block below.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { mergeWorktree } from '../lib/agents/runtime';
import { emitBuffered } from '../lib/journal/journal';
import { registerLoop, getLoop, createLoopConfig } from '../lib/agents/loopEngine';
import { WebPlatform } from '../lib/platform/web';
import type { JudgeVerdict, Mission } from '../lib/agents/types';

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

// emitBuffered wrapped in a spy over the REAL implementation — needed to
// assert the loop.stopped payload shape without disabling the real journal
// buffering behavior every other call site in this file relies on.
vi.mock('../lib/journal/journal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/journal/journal')>();
  return {
    ...actual,
    emitBuffered: vi.fn(actual.emitBuffered),
  };
});

// Real WebPlatform (every non-fs surface — missions/git/brain/tests/etc. —
// behaves exactly as any other non-Tauri test run) with `.fs` replaced by a
// real in-memory implementation, so loopEngine's readLoops/writeLoops
// genuinely round-trip (a trivial always-reject mock would not prove
// disableLoop/unregisterLoop actually persisted). Same "in-memory fake fs"
// technique as loopScheduler.test.ts.
const fsFiles = new Map<string, string>();
const fakePlatform = {
  ...WebPlatform,
  fs: {
    ...WebPlatform.fs,
    readFile: async (path: string): Promise<string> => {
      const content = fsFiles.get(path);
      if (content === undefined) throw new Error('not found');
      return content;
    },
    writeFile: async (path: string, content: string): Promise<void> => {
      fsFiles.set(path, content);
    },
    createDir: async (): Promise<void> => {},
  },
};

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    getPlatform: () => fakePlatform,
  };
});

const mockedMergeWorktree = vi.mocked(mergeWorktree);

// Boot/registration paths (resolveProjectRoot, create_loop) all resolve to
// '.' in this jsdom test environment (no real Tauri invoke available — see
// resolveProjectRoot's own catch-fallback) — loops are registered under
// that exact repoPath so getLoop/disableLoop below agree with what the
// store itself resolves.
const ROOT = '.';

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

function passingVerdict(): JudgeVerdict {
  return {
    score: 95,
    passed: true,
    risk: 'low',
    reviewers: [
      { role: 'tester', verdict: 'approve', summary: '' },
      { role: 'reviewer', verdict: 'approve', summary: '' },
      { role: 'security', verdict: 'approve', summary: '' },
    ],
    createdAt: new Date().toISOString(),
  };
}

async function addQueuedMission(
  result: { current: ReturnType<typeof useAgentsStore> },
  title: string,
): Promise<string> {
  await act(async () => {
    await result.current.addMission({
      title,
      repo: '.',
      worktree: 'agent/m-zombie',
      modelLabel: 'claude-sonnet-5',
      mode: 'agent',
      orchestrator: false,
    });
  });
  return result.current.missions[result.current.missions.length - 1].id;
}

beforeEach(() => {
  fsFiles.clear();
  localStorage.clear();
  mockedMergeWorktree.mockReset().mockResolvedValue('mock-merge-sha');
  vi.mocked(emitBuffered).mockClear();
});

afterEach(() => {
  localStorage.clear();
});

describe('ZOMBIE LOOP fix — approveMission (merge) disables the loop', () => {
  it('disables the mission\'s own registered loop once the merge really succeeds', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Loop mission — merge success');

    await registerLoop(ROOT, {
      missionId,
      title: 'Loop mission — merge success',
      agentTask: 'Do the loop thing',
      loopConfig: createLoopConfig('1h'),
    });
    expect((await getLoop(ROOT, missionId))?.loopConfig.enabled).toBe(true);

    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'review', judgeVerdict: passingVerdict() } });
    });

    await act(async () => {
      await result.current.approveMission(missionId, ROOT);
    });

    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('done');
    const loopAfter = await getLoop(ROOT, missionId);
    expect(loopAfter?.loopConfig.enabled).toBe(false);

    const stoppedCall = vi.mocked(emitBuffered).mock.calls.find(
      ([evt]) => evt.type === 'loop.stopped' && evt.missionId === missionId,
    );
    expect(stoppedCall).toBeDefined();
    expect((stoppedCall![0].payload as { reason: string }).reason).toBe('merged');
  });

  it('never emits loop.stopped for an ordinary mission that was never a loop', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Plain mission — no loop');

    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'review', judgeVerdict: passingVerdict() } });
    });
    await act(async () => {
      await result.current.approveMission(missionId, ROOT);
    });

    const stoppedCall = vi.mocked(emitBuffered).mock.calls.find(([evt]) => evt.type === 'loop.stopped');
    expect(stoppedCall).toBeUndefined();
  });
});

describe('ZOMBIE LOOP fix — archiveMission disables the loop', () => {
  it('disables the mission\'s own registered loop when it is archived', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Loop mission — archive');

    await registerLoop(ROOT, {
      missionId,
      title: 'Loop mission — archive',
      agentTask: 'Do the loop thing',
      loopConfig: createLoopConfig('1h'),
    });

    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'done' } });
    });

    await act(async () => {
      result.current.archiveMission(missionId);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.missions.find((m) => m.id === missionId)!.archived).toBe(true);
    const loopAfter = await getLoop(ROOT, missionId);
    expect(loopAfter?.loopConfig.enabled).toBe(false);

    const stoppedCall = vi.mocked(emitBuffered).mock.calls.find(
      ([evt]) => evt.type === 'loop.stopped' && evt.missionId === missionId,
    );
    expect(stoppedCall).toBeDefined();
    expect((stoppedCall![0].payload as { reason: string }).reason).toBe('archived');
  });
});

describe('ZOMBIE LOOP fix — deleteMission unregisters the loop', () => {
  it('unregisters (not merely disables) the mission\'s own registered loop when it is deleted', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Loop mission — delete');

    await registerLoop(ROOT, {
      missionId,
      title: 'Loop mission — delete',
      agentTask: 'Do the loop thing',
      loopConfig: createLoopConfig('1h'),
    });

    await act(async () => {
      result.current.deleteMission(missionId);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.missions.some((m) => m.id === missionId)).toBe(false);
    // Unregistered entirely — not just disabled — so a stale entry can
    // never come back even if some future build re-enables by id.
    expect(await getLoop(ROOT, missionId)).toBeNull();

    const stoppedCall = vi.mocked(emitBuffered).mock.calls.find(
      ([evt]) => evt.type === 'loop.stopped' && evt.missionId === missionId,
    );
    expect(stoppedCall).toBeDefined();
    expect((stoppedCall![0].payload as { reason: string }).reason).toBe('deleted');
  });
});

describe('BOOT RE-STAMP fix — seedJournaledMissions', () => {
  it('does not re-emit mission.updated for a pre-existing mission on the first debounce-save cycle after boot', async () => {
    const preExisting: Mission = {
      id: 'M-preexisting-1',
      title: 'Pre-existing mission from a previous session',
      status: 'done',
      model: 'sonnet',
      worktree: '.',
      progress: 100,
      planSteps: [],
      actionTimeline: [],
    };
    localStorage.setItem('lazy:missions', JSON.stringify([preExisting]));

    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useAgentsStore(), { wrapper });

      // Let the boot load's real Promise chain (resolveProjectRoot ->
      // platform.missions.load -> setState) settle, then let the
      // debounce-save effect's own 800ms timer fire at least once.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(result.current.missions.some((m) => m.id === 'M-preexisting-1')).toBe(true);

      const updatedCalls = vi.mocked(emitBuffered).mock.calls.filter(([evt]) => evt.type === 'mission.updated');
      expect(updatedCalls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still journals mission.updated for a REAL later change to that same pre-existing mission', async () => {
    const preExisting: Mission = {
      id: 'M-preexisting-2',
      title: 'Pre-existing mission from a previous session',
      status: 'done',
      model: 'sonnet',
      worktree: '.',
      progress: 100,
      planSteps: [],
      actionTimeline: [],
    };
    localStorage.setItem('lazy:missions', JSON.stringify([preExisting]));

    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useAgentsStore(), { wrapper });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      vi.mocked(emitBuffered).mockClear();

      await act(async () => {
        result.current.archiveMission('M-preexisting-2');
        await vi.advanceTimersByTimeAsync(1000);
      });

      const updatedCalls = vi.mocked(emitBuffered).mock.calls.filter(
        ([evt]) => evt.type === 'mission.updated' && evt.missionId === 'M-preexisting-2',
      );
      expect(updatedCalls.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
