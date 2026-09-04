/**
 * loopScheduler.test.ts
 *
 * Regression coverage for the loop runaway defect: a 300s-cadence loop used
 * to spawn 5 child missions in ~6 minutes, every one labeled "iter #1", with
 * iterationMissionIds ending up holding only the LAST child id. Root cause
 * (see loopScheduler.ts's module header): the old scheduler effect depended
 * on `[state.missions]`, so it tore down/rebuilt its interval AND re-ran
 * loadLoopsOnStartup() on every mission mutation — racing loadLoopsOnStartup
 * against markIterationFired's read-modify-write of loops.json and clobbering
 * iterationCount/iterationMissionIds back to their pre-fire values.
 *
 * These tests exercise the REAL loopEngine persistence (against an in-memory
 * fake filesystem, so state genuinely round-trips across ticks — a trivial
 * always-reject mock would not have caught this class of bug) with fake
 * timers, proving the fixed scheduler fires exactly once per cadence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startLoopScheduler, type LoopFireEvent } from '../lib/agents/loopScheduler';
import { createLoopConfig, registerLoop } from '../lib/agents/loopEngine';
import type { Mission } from '../lib/agents/types';

// ── In-memory fake filesystem — reads see prior writes, unlike a trivial
// always-reject mock. This is what makes the race reproducible/verifiable. ──

const files = new Map<string, string>();

const readFile = vi.fn(async (path: string): Promise<string> => {
  const content = files.get(path);
  if (content === undefined) throw new Error('not found');
  return content;
});
const writeFile = vi.fn(async (path: string, content: string): Promise<void> => {
  files.set(path, content);
});
const createDir = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/platform', () => ({
  getPlatform: () => ({ fs: { readFile, writeFile, createDir } }),
}));

const REPO = '/repo';

function readLoopsFile(): {
  loops: { loopConfig: { iterationCount: number; iterationMissionIds: string[]; nextRunAt?: string; enabled: boolean } }[];
} {
  return JSON.parse(files.get('/repo/.lazy/loops.json')!);
}

beforeEach(() => {
  files.clear();
  readFile.mockClear();
  writeFile.mockClear();
  createDir.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startLoopScheduler — one fire per cadence (runaway regression)', () => {
  it('a 300s-cadence loop fires exactly 4 times over a simulated 20 minutes, with correct iterationCount/iterationMissionIds', async () => {
    await registerLoop(REPO, {
      missionId: 'M12',
      title: 'Loop: watch tests',
      agentTask: 'Watch and fix tests',
      model: 'haiku',
      loopConfig: createLoopConfig('300s'),
    });

    const fired: LoopFireEvent[] = [];
    let missions: Mission[] = [];
    let counter = 12;

    const stop = startLoopScheduler({
      getRepoPath: async () => REPO,
      getMissions: () => missions,
      nextMissionId: () => `M${++counter}`,
      defaultModelId: () => 'haiku',
      onFire: (event) => {
        fired.push(event);
        missions = [...missions, event.childMission];
      },
    });

    await vi.advanceTimersByTimeAsync(0); // let the one-shot startup load settle
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000); // 20 simulated minutes
    stop();

    expect(fired.length).toBe(4);
    expect(fired.map((f) => f.childMission.loopIteration)).toEqual([1, 2, 3, 4]);
    expect(fired.map((f) => f.childMission.id)).toEqual(['M13', 'M14', 'M15', 'M16']);
    fired.forEach((f) => {
      expect(typeof f.childMission.loopIteration).toBe('number');
    });

    const persisted = readLoopsFile();
    expect(persisted.loops[0].loopConfig.iterationCount).toBe(4);
    expect(persisted.loops[0].loopConfig.iterationMissionIds).toEqual(['M13', 'M14', 'M15', 'M16']);
  });

  it('stops scheduling immediately once stop() is called — no fires after pause/delete', async () => {
    await registerLoop(REPO, {
      missionId: 'M30',
      title: 'Loop: x',
      agentTask: 'x',
      loopConfig: createLoopConfig('60s'),
    });

    const fired: LoopFireEvent[] = [];
    const stop = startLoopScheduler({
      getRepoPath: async () => REPO,
      getMissions: () => [],
      nextMissionId: (() => {
        let n = 30;
        return () => `M${++n}`;
      })(),
      defaultModelId: () => 'haiku',
      onFire: (e) => fired.push(e),
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired.length).toBe(1);

    stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fired.length).toBe(1);
  });

  it('ZOMBIE LOOP fix: never fires (and disables) a due loop whose own mission is already done', async () => {
    await registerLoop(REPO, {
      missionId: 'M50',
      title: 'Loop: stale',
      agentTask: 'x',
      loopConfig: createLoopConfig('60s'),
    });

    const doneMission: Mission = {
      id: 'M50',
      title: 'Loop: stale',
      status: 'done',
      model: 'haiku',
      worktree: '.',
      progress: 100,
      planSteps: [],
      actionTimeline: [],
    };

    const fired: LoopFireEvent[] = [];
    const stop = startLoopScheduler({
      getRepoPath: async () => REPO,
      getMissions: () => [doneMission],
      nextMissionId: () => 'M51',
      defaultModelId: () => 'haiku',
      onFire: (e) => fired.push(e),
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    stop();

    expect(fired.length).toBe(0);
    expect(readLoopsFile().loops[0].loopConfig.enabled).toBe(false);
  });

  // ── Trust-critical defect #2 ──────────────────────────────────────────
  // Real QA capture: "Mission M1 — itération 20/19/.../4", all fired in the
  // SAME second, while M1 itself sat in a terminal `failed` state. The
  // scheduler must never fire another iteration for a loop whose own
  // tracked mission already failed, and must surface WHY via onAutoDisabled.

  it('never fires (and disables, with reason "mission_failed") a due loop whose own mission already failed', async () => {
    await registerLoop(REPO, {
      missionId: 'M60',
      title: 'Loop: failing anchor',
      agentTask: 'x',
      loopConfig: createLoopConfig('60s'),
    });

    const failedMission: Mission = {
      id: 'M60',
      title: 'Loop: failing anchor',
      status: 'failed',
      model: 'haiku',
      worktree: '.',
      progress: 100,
      planSteps: [],
      actionTimeline: [],
    };

    const fired: LoopFireEvent[] = [];
    const autoDisabled: Array<{ missionId: string; reason: string }> = [];
    const stop = startLoopScheduler({
      getRepoPath: async () => REPO,
      getMissions: () => [failedMission],
      nextMissionId: () => 'M61',
      defaultModelId: () => 'haiku',
      onFire: (e) => fired.push(e),
      onAutoDisabled: (loop, reason) => autoDisabled.push({ missionId: loop.missionId, reason }),
    });

    // Simulate several cadence windows elapsing — a runaway loop would fire
    // repeatedly here if the guard were absent; the fixed scheduler must
    // fire ZERO times across all of them, not just the first.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    stop();

    expect(fired.length).toBe(0);
    expect(readLoopsFile().loops[0].loopConfig.enabled).toBe(false);
    expect(autoDisabled).toEqual([{ missionId: 'M60', reason: 'mission_failed' }]);
  });

  it('threads the loop\'s permissionMode through to onFire, defaulting to acceptEdits', async () => {
    await registerLoop(REPO, {
      missionId: 'M40',
      title: 'Loop: default perm',
      agentTask: 'Do it',
      loopConfig: createLoopConfig('60s'),
      // No permissionMode set — must default to 'acceptEdits'.
    });
    await registerLoop(REPO, {
      missionId: 'M41',
      title: 'Loop: plan perm',
      agentTask: 'Do it',
      permissionMode: 'plan',
      loopConfig: createLoopConfig('60s'),
    });

    const fired: LoopFireEvent[] = [];
    startLoopScheduler({
      getRepoPath: async () => REPO,
      getMissions: () => [],
      nextMissionId: (() => {
        let n = 42;
        return () => `M${++n}`;
      })(),
      defaultModelId: () => 'haiku',
      onFire: (e) => fired.push(e),
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fired.length).toBe(2);
    const byLoop = Object.fromEntries(fired.map((f) => [f.loop.missionId, f.permissionMode]));
    expect(byLoop['M40']).toBe('acceptEdits');
    expect(byLoop['M41']).toBe('plan');
  });
});
