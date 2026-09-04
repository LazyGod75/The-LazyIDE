/**
 * Tests for loopEngine: cadence parsing, loop config creation,
 * stop condition evaluation, and tick logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createLoopConfig,
  parseCadence,
  cadenceLabel,
  shouldStopLoop,
  registerLoop,
  listLoops,
  skipNextRun,
  tick,
  markIterationFired,
  recordLoopApproval,
  recordLoopFailure,
  artifactOwnerIdForLoop,
  consecutiveLoopFailures,
  HARD_ITERATION_CAP,
  CONSECUTIVE_FAILURE_LIMIT,
  MIN_ITERATION_DELAY_MS,
  type PersistedLoop,
} from '../lib/agents/loopEngine';
import type { LoopConfig, Mission } from '../lib/agents/types';

// ── Mock platform ──────────────────────────────────────────────────
// Stable fn references (not re-created per getPlatform() call) so tests can
// assert on call arguments — needed by the path-join regression block below.

const readFile = vi.fn().mockRejectedValue(new Error('not found'));
const writeFile = vi.fn().mockResolvedValue(undefined);
const createDir = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    fs: { readFile, writeFile, createDir },
  })),
}));

beforeEach(() => {
  readFile.mockClear().mockRejectedValue(new Error('not found'));
  writeFile.mockClear().mockResolvedValue(undefined);
  createDir.mockClear().mockResolvedValue(undefined);
});

// ── Tests ──────────────────────────────────────────────────────────

describe('parseCadence', () => {
  it('parses standard cadence codes', () => {
    expect(parseCadence('5m')).toBe('5m');
    expect(parseCadence('15m')).toBe('15m');
    expect(parseCadence('1h')).toBe('1h');
    expect(parseCadence('6h')).toBe('6h');
    expect(parseCadence('1d')).toBe('1d');
  });

  it('parses alternative formats', () => {
    expect(parseCadence('5min')).toBe('5m');
    expect(parseCadence('hourly')).toBe('1h');
    expect(parseCadence('daily')).toBe('1d');
    expect(parseCadence('1jour')).toBe('1d');
  });

  it('returns null for unknown cadence', () => {
    expect(parseCadence('3m')).toBeNull();
    expect(parseCadence('weekly')).toBeNull();
    expect(parseCadence('')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(parseCadence('5M')).toBe('5m');
    expect(parseCadence('DAILY')).toBe('1d');
  });
});

describe('cadenceLabel', () => {
  it('returns human-readable labels', () => {
    expect(cadenceLabel('5m')).toBe('5 minutes');
    expect(cadenceLabel('1h')).toBe('1 heure');
    expect(cadenceLabel('1d')).toBe('1 jour');
  });
});

describe('createLoopConfig', () => {
  it('creates a config with default manual stop condition', () => {
    const cfg = createLoopConfig('1h');
    expect(cfg.cadence).toBe('1h');
    expect(cfg.enabled).toBe(true);
    expect(cfg.stopCondition.kind).toBe('manual');
    expect(cfg.iterationCount).toBe(0);
    expect(cfg.iterationMissionIds).toEqual([]);
    expect(cfg.nextRunAt).toBeDefined();
  });

  it('creates a config with custom stop condition', () => {
    const cfg = createLoopConfig('15m', { kind: 'maxIterations', count: 5 });
    expect(cfg.stopCondition.kind).toBe('maxIterations');
    expect((cfg.stopCondition as { count: number }).count).toBe(5);
  });

  it('sets nextRunAt in the future', () => {
    const cfg = createLoopConfig('5m');
    const nextRun = new Date(cfg.nextRunAt!).getTime();
    expect(nextRun).toBeGreaterThan(Date.now() - 1000);
  });
});

describe('skipNextRun (Agent Canvas W5a — « Passer la prochaine »)', () => {
  function loopConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
    return {
      cadence: '5m',
      stopCondition: { kind: 'manual' },
      enabled: true,
      iterationCount: 0,
      iterationMissionIds: [],
      ...overrides,
    };
  }

  it('advances nextRunAt by exactly one cadence from the current nextRunAt', () => {
    const base = Date.parse('2026-07-14T10:00:00.000Z');
    const cfg = loopConfig({ cadence: '5m', nextRunAt: new Date(base).toISOString() });
    const next = skipNextRun(cfg);
    expect(new Date(next.nextRunAt!).getTime()).toBe(base + 5 * 60 * 1000);
  });

  it('bases the advance on now when nextRunAt is absent', () => {
    const before = Date.now();
    const next = skipNextRun(loopConfig({ cadence: '1h', nextRunAt: undefined }));
    const after = Date.now();
    const delta = new Date(next.nextRunAt!).getTime();
    expect(delta).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(delta).toBeLessThanOrEqual(after + 60 * 60 * 1000);
  });

  it('never mutates the input config (immutable, returns a new object)', () => {
    const base = Date.parse('2026-07-14T10:00:00.000Z');
    const cfg = loopConfig({ nextRunAt: new Date(base).toISOString() });
    const frozen = { ...cfg };
    skipNextRun(cfg);
    expect(cfg).toEqual(frozen);
  });

  it('leaves every other field untouched', () => {
    const cfg = loopConfig({ cadence: '1d', iterationCount: 4, enabled: true });
    const next = skipNextRun(cfg);
    expect(next.cadence).toBe('1d');
    expect(next.iterationCount).toBe(4);
    expect(next.enabled).toBe(true);
  });
});

describe('shouldStopLoop', () => {
  const baseLoop: PersistedLoop = {
    missionId: 'M1',
    title: 'Test loop',
    agentTask: 'Do something',
    loopConfig: {
      cadence: '1h',
      stopCondition: { kind: 'manual' },
      enabled: true,
      iterationCount: 0,
      iterationMissionIds: [],
    },
    createdAt: new Date().toISOString(),
  };

  it('returns false for manual stop condition', () => {
    expect(shouldStopLoop(baseLoop, [])).toBe(false);
  });

  it('returns true when maxIterations is reached', () => {
    const loop: PersistedLoop = {
      ...baseLoop,
      loopConfig: {
        ...baseLoop.loopConfig,
        iterationCount: 5,
        stopCondition: { kind: 'maxIterations', count: 5 },
      },
    };
    expect(shouldStopLoop(loop, [])).toBe(true);
  });

  it('returns false when maxIterations not yet reached', () => {
    const loop: PersistedLoop = {
      ...baseLoop,
      loopConfig: {
        ...baseLoop.loopConfig,
        iterationCount: 3,
        stopCondition: { kind: 'maxIterations', count: 5 },
      },
    };
    expect(shouldStopLoop(loop, [])).toBe(false);
  });

  it('returns true when untilDate has passed', () => {
    const loop: PersistedLoop = {
      ...baseLoop,
      loopConfig: {
        ...baseLoop.loopConfig,
        stopCondition: { kind: 'untilDate', date: '2020-01-01T00:00:00Z' },
      },
    };
    expect(shouldStopLoop(loop, [])).toBe(true);
  });

  it('returns false when untilDate is in the future', () => {
    const loop: PersistedLoop = {
      ...baseLoop,
      loopConfig: {
        ...baseLoop.loopConfig,
        stopCondition: { kind: 'untilDate', date: '2099-01-01T00:00:00Z' },
      },
    };
    expect(shouldStopLoop(loop, [])).toBe(false);
  });

  it('returns true when untilPass condition is met', () => {
    const missions: Mission[] = [
      {
        id: 'M2',
        title: 'iter 1',
        status: 'done',
        model: 'Haiku',
        worktree: '.',
        progress: 100,
        planSteps: [],
        actionTimeline: [],
        loopParentId: 'M1',
        judgeVerdict: { score: 90, passed: true, risk: 'low', reviewers: [], createdAt: '' },
      } as unknown as Mission,
    ];
    const loop: PersistedLoop = {
      ...baseLoop,
      loopConfig: {
        ...baseLoop.loopConfig,
        stopCondition: { kind: 'untilPass', minScore: 80 },
      },
    };
    expect(shouldStopLoop(loop, missions)).toBe(true);
  });

  it('returns false when untilPass condition is not met', () => {
    const missions: Mission[] = [
      {
        id: 'M2',
        title: 'iter 1',
        status: 'done',
        model: 'Haiku',
        worktree: '.',
        progress: 100,
        planSteps: [],
        actionTimeline: [],
        loopParentId: 'M1',
        judgeVerdict: { score: 50, passed: false, risk: 'high', reviewers: [], createdAt: '' },
      } as unknown as Mission,
    ];
    const loop: PersistedLoop = {
      ...baseLoop,
      loopConfig: {
        ...baseLoop.loopConfig,
        stopCondition: { kind: 'untilPass', minScore: 80 },
      },
    };
    expect(shouldStopLoop(loop, missions)).toBe(false);
  });
});

// ── tick — ZOMBIE LOOP fix: defensive auto-disable ──────────────────
// Belt-and-suspenders for a registry a build predating the REAL fix
// (agentsStore.tsx's approveMission/archiveMission/deleteMission now
// disable/unregister a mission's loop directly) left behind, or a race:
// tick() itself must never fire another iteration for a loop whose own
// tracked mission already reached a terminal state (done/archived), and
// must disable it right there instead. Conservative: a mission tick()
// cannot find in the snapshot it was given is left alone — never a false
// positive.

/** Shared across the tick()/markIterationFired/consecutiveLoopFailures
 *  describe blocks below — a single failed iteration mission for loop
 *  parent `loopParentId` (defaults to 'M1', the shared anchor mission id
 *  every fixture in this section uses). */
function failedIteration(iteration: number, loopParentId = 'M1'): Mission {
  return {
    id: `${loopParentId}-iter-${iteration}`,
    title: `iter ${iteration}`,
    status: 'failed',
    model: 'sonnet',
    worktree: '.',
    progress: 100,
    planSteps: [],
    actionTimeline: [],
    loopParentId,
    loopIteration: iteration,
  } as Mission;
}

describe('tick — ZOMBIE LOOP fix: defensive auto-disable', () => {
  function dueLoop(missionId: string, overrides: Partial<PersistedLoop> = {}): PersistedLoop {
    return {
      missionId,
      title: 'Loop mission',
      agentTask: 'Do something',
      loopConfig: {
        cadence: '1h',
        stopCondition: { kind: 'manual' },
        enabled: true,
        nextRunAt: new Date(Date.now() - 1000).toISOString(), // already due
        iterationCount: 0,
        iterationMissionIds: [],
      },
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function baseMission(overrides: Partial<Mission> = {}): Mission {
    return {
      id: 'M1',
      title: 'Loop mission',
      status: 'done',
      model: 'sonnet',
      worktree: '.',
      progress: 100,
      planSteps: [],
      actionTimeline: [],
      ...overrides,
    } as Mission;
  }

  it('skips (never fires) and disables an enabled loop whose own mission has status "done"', async () => {
    readFile.mockResolvedValue(JSON.stringify({ loops: [dueLoop('M1')], version: '1.0.0' }));

    const result = await tick('/repo', [baseMission({ status: 'done' })]);

    expect(result.loopsToFire).toEqual([]);
    expect(result.loopsAutoDisabled.map((l) => l.missionId)).toEqual(['M1']);
    const lastWrite = JSON.parse(writeFile.mock.calls[writeFile.mock.calls.length - 1][1] as string);
    expect(lastWrite.loops[0].loopConfig.enabled).toBe(false);
  });

  it('skips and disables an enabled loop whose own mission is archived', async () => {
    readFile.mockResolvedValue(JSON.stringify({ loops: [dueLoop('M1')], version: '1.0.0' }));

    const result = await tick('/repo', [baseMission({ status: 'review', archived: true })]);

    expect(result.loopsToFire).toEqual([]);
    expect(result.loopsAutoDisabled.map((l) => l.missionId)).toEqual(['M1']);
  });

  it('still fires a due loop whose mission is NOT terminal', async () => {
    readFile.mockResolvedValue(JSON.stringify({ loops: [dueLoop('M1')], version: '1.0.0' }));

    const result = await tick('/repo', [baseMission({ status: 'running' })]);

    expect(result.loopsToFire.map((l) => l.missionId)).toEqual(['M1']);
    expect(result.loopsAutoDisabled).toEqual([]);
  });

  it('never a false positive: a mission tick() cannot find in the snapshot is left alone (still fires)', async () => {
    readFile.mockResolvedValue(JSON.stringify({ loops: [dueLoop('M1')], version: '1.0.0' }));

    const result = await tick('/repo', []); // no missions known at all

    expect(result.loopsToFire.map((l) => l.missionId)).toEqual(['M1']);
    expect(result.loopsAutoDisabled).toEqual([]);
  });

  it('defaults `missions` to an empty snapshot when the caller passes none — byte-identical to pre-fix behavior', async () => {
    readFile.mockResolvedValue(JSON.stringify({ loops: [dueLoop('M1')], version: '1.0.0' }));

    const result = await tick('/repo');

    expect(result.loopsToFire.map((l) => l.missionId)).toEqual(['M1']);
    expect(result.loopsAutoDisabled).toEqual([]);
  });

  // ── Trust-critical defect #2 ────────────────────────────────────────
  // Real QA capture: "Mission M1 — itération 20/19/.../4", all fired in the
  // SAME second, while M1 (the loop's own anchor mission) sat in a terminal
  // `failed` state. Before this fix, tick()'s auto-disable only recognized
  // 'done'/archived as terminal — a loop tracking a FAILED mission stayed
  // enabled forever.

  it('skips and disables an enabled loop whose own mission has status "failed" — refuses to re-fire against a proven-failing body', async () => {
    readFile.mockResolvedValue(JSON.stringify({ loops: [dueLoop('M1')], version: '1.0.0' }));

    const result = await tick('/repo', [baseMission({ status: 'failed' })]);

    expect(result.loopsToFire).toEqual([]);
    expect(result.loopsAutoDisabled.map((l) => l.missionId)).toEqual(['M1']);
    expect(result.loopsAutoDisabled[0].stopReason).toBe('mission_failed');
    const lastWrite = JSON.parse(writeFile.mock.calls[writeFile.mock.calls.length - 1][1] as string);
    expect(lastWrite.loops[0].loopConfig.enabled).toBe(false);
  });

  it('skips and disables an enabled loop whose own mission has status "cancelled"', async () => {
    readFile.mockResolvedValue(JSON.stringify({ loops: [dueLoop('M1')], version: '1.0.0' }));

    const result = await tick('/repo', [baseMission({ status: 'cancelled' })]);

    expect(result.loopsToFire).toEqual([]);
    expect(result.loopsAutoDisabled.map((l) => l.missionId)).toEqual(['M1']);
    expect(result.loopsAutoDisabled[0].stopReason).toBe('mission_failed');
  });

  it('enforces a SYSTEM hard iteration cap even under stopCondition "manual" (no user-configured limit)', async () => {
    readFile.mockResolvedValue(
      JSON.stringify({
        loops: [dueLoop('M1', { loopConfig: { ...dueLoop('M1').loopConfig, iterationCount: HARD_ITERATION_CAP } })],
        version: '1.0.0',
      }),
    );

    const result = await tick('/repo', [baseMission({ status: 'running' })]);

    expect(result.loopsToFire).toEqual([]);
    expect(result.loopsAutoDisabled.map((l) => l.missionId)).toEqual(['M1']);
    expect(result.loopsAutoDisabled[0].stopReason).toBe('hard_iteration_cap');
  });

  it('does NOT trip the hard cap one iteration below it', async () => {
    readFile.mockResolvedValue(
      JSON.stringify({
        loops: [dueLoop('M1', { loopConfig: { ...dueLoop('M1').loopConfig, iterationCount: HARD_ITERATION_CAP - 1 } })],
        version: '1.0.0',
      }),
    );

    const result = await tick('/repo', [baseMission({ status: 'running' })]);

    expect(result.loopsToFire.map((l) => l.missionId)).toEqual(['M1']);
    expect(result.loopsAutoDisabled).toEqual([]);
  });

  it('disables the loop once consecutive failed iterations reach CONSECUTIVE_FAILURE_LIMIT, refusing to fire another identical attempt', async () => {
    readFile.mockResolvedValue(JSON.stringify({ loops: [dueLoop('M1')], version: '1.0.0' }));
    const missions = [
      baseMission({ status: 'running' }),
      ...Array.from({ length: CONSECUTIVE_FAILURE_LIMIT }, (_, i) => failedIteration(i + 1)),
    ];

    const result = await tick('/repo', missions);

    expect(result.loopsToFire).toEqual([]);
    expect(result.loopsAutoDisabled.map((l) => l.missionId)).toEqual(['M1']);
    expect(result.loopsAutoDisabled[0].stopReason).toBe('repeated_failures');
  });

  it('still fires when the consecutive-failure streak is ONE below the limit', async () => {
    readFile.mockResolvedValue(JSON.stringify({ loops: [dueLoop('M1')], version: '1.0.0' }));
    const missions = [
      baseMission({ status: 'running' }),
      ...Array.from({ length: CONSECUTIVE_FAILURE_LIMIT - 1 }, (_, i) => failedIteration(i + 1)),
    ];

    const result = await tick('/repo', missions);

    expect(result.loopsToFire.map((l) => l.missionId)).toEqual(['M1']);
    expect(result.loopsAutoDisabled).toEqual([]);
  });
});

// ── Trust-critical defect #2 — markIterationFired: minimum delay +
// exponential backoff after failed iterations ────────────────────────────
// The task's own non-negotiable verification rule: assert the actual
// TIMING/backoff, not just an iteration count.

describe('markIterationFired — minimum delay + exponential backoff (trust-critical defect #2)', () => {
  function loopWithCadence(cadence: string, overrides: Partial<PersistedLoop> = {}): PersistedLoop {
    return {
      missionId: 'M1',
      title: 'Loop mission',
      agentTask: 'Do something',
      loopConfig: { ...createLoopConfig(cadence as never), iterationCount: 0, iterationMissionIds: [] },
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('schedules the next run exactly ONE cadence away when there is no failure streak (healthy loop, unchanged behavior)', async () => {
    const before = Date.now();
    readFile.mockResolvedValue(JSON.stringify({ loops: [loopWithCadence('1h')], version: '1.0.0' }));

    await markIterationFired('/repo', 'M1', 'child-1', []);

    const persisted = JSON.parse(writeFile.mock.calls[writeFile.mock.calls.length - 1][1] as string);
    const nextRunMs = new Date(persisted.loops[0].loopConfig.nextRunAt).getTime();
    // 1h = 3_600_000ms — allow a small tolerance for real wall-clock time
    // elapsed between `before` and the call.
    expect(nextRunMs - before).toBeGreaterThanOrEqual(3_600_000);
    expect(nextRunMs - before).toBeLessThan(3_600_000 + 2_000);
  });

  it('backs off exponentially: one prior consecutive failure schedules the next run at roughly 2x cadence', async () => {
    const before = Date.now();
    readFile.mockResolvedValue(JSON.stringify({ loops: [loopWithCadence('1h')], version: '1.0.0' }));
    const missions = [failedIteration(1)]; // one prior failed iteration for M1

    await markIterationFired('/repo', 'M1', 'child-2', missions);

    const persisted = JSON.parse(writeFile.mock.calls[writeFile.mock.calls.length - 1][1] as string);
    const nextRunMs = new Date(persisted.loops[0].loopConfig.nextRunAt).getTime();
    const delayMs = nextRunMs - before;
    expect(delayMs).toBeGreaterThanOrEqual(2 * 3_600_000);
    expect(delayMs).toBeLessThan(2 * 3_600_000 + 2_000);
  });

  it('backs off further: two prior consecutive failures schedule the next run at roughly 4x cadence', async () => {
    const before = Date.now();
    readFile.mockResolvedValue(JSON.stringify({ loops: [loopWithCadence('1h')], version: '1.0.0' }));
    const missions = [failedIteration(2), failedIteration(1)];

    await markIterationFired('/repo', 'M1', 'child-3', missions);

    const persisted = JSON.parse(writeFile.mock.calls[writeFile.mock.calls.length - 1][1] as string);
    const nextRunMs = new Date(persisted.loops[0].loopConfig.nextRunAt).getTime();
    const delayMs = nextRunMs - before;
    expect(delayMs).toBeGreaterThanOrEqual(4 * 3_600_000);
    expect(delayMs).toBeLessThan(4 * 3_600_000 + 2_000);
  });

  it('a non-failed iteration anywhere in the streak resets backoff to the base cadence (streak resets, not just caps)', async () => {
    const before = Date.now();
    readFile.mockResolvedValue(JSON.stringify({ loops: [loopWithCadence('1h')], version: '1.0.0' }));
    // Most recent iteration (#3) succeeded — the two failures before it
    // (#1, #2) are NOT a trailing streak anymore.
    const missions = [
      { ...failedIteration(3), status: 'done' as const },
      failedIteration(2),
      failedIteration(1),
    ];

    await markIterationFired('/repo', 'M1', 'child-4', missions);

    const persisted = JSON.parse(writeFile.mock.calls[writeFile.mock.calls.length - 1][1] as string);
    const nextRunMs = new Date(persisted.loops[0].loopConfig.nextRunAt).getTime();
    const delayMs = nextRunMs - before;
    expect(delayMs).toBeGreaterThanOrEqual(3_600_000);
    expect(delayMs).toBeLessThan(3_600_000 + 2_000);
  });

  it('enforces MIN_ITERATION_DELAY_MS as an absolute floor even for a very fast custom cadence', async () => {
    const before = Date.now();
    // "1s" cadence resolves to 1000ms — well below MIN_ITERATION_DELAY_MS.
    readFile.mockResolvedValue(JSON.stringify({ loops: [loopWithCadence('1s')], version: '1.0.0' }));

    await markIterationFired('/repo', 'M1', 'child-5', []);

    const persisted = JSON.parse(writeFile.mock.calls[writeFile.mock.calls.length - 1][1] as string);
    const nextRunMs = new Date(persisted.loops[0].loopConfig.nextRunAt).getTime();
    const delayMs = nextRunMs - before;
    expect(delayMs).toBeGreaterThanOrEqual(MIN_ITERATION_DELAY_MS);
  });
});

// ── consecutiveLoopFailures (pure) ───────────────────────────────────

describe('consecutiveLoopFailures', () => {
  it('returns 0 when there are no iteration missions at all', () => {
    expect(consecutiveLoopFailures([], 'M1')).toBe(0);
  });

  it('counts a trailing run of failed iterations, most recent first', () => {
    const missions = [failedIteration(1), failedIteration(2), failedIteration(3)];
    expect(consecutiveLoopFailures(missions, 'M1')).toBe(3);
  });

  it('stops counting at the first non-failed iteration encountered (most recent first)', () => {
    const missions = [
      { ...failedIteration(3), status: 'done' as const },
      failedIteration(2),
      failedIteration(1),
    ];
    expect(consecutiveLoopFailures(missions, 'M1')).toBe(0);
  });

  it('ignores iterations belonging to a DIFFERENT loop', () => {
    const missions = [failedIteration(1, 'M2')];
    expect(consecutiveLoopFailures(missions, 'M1')).toBe(0);
  });
});

// ── Persistence: verbatim-safe path join ────────────────────────────
// Regression coverage: readLoops/writeLoops/readLoopState/writeLoopState
// built the '.lazy/loops.json' / '.lazy/loop-state.json' paths via string
// concatenation (`${repoPath}/.lazy`, `${repoPath}/${LOOPS_FILE}`) instead of
// the shared joinPath() helper — same bug class as missionQueue.ts/
// artifacts.ts (see src/lib/paths.ts's header comment). A Windows
// '\\?\'-prefixed repoPath then produces a mixed-separator path the Rust fs
// commands reject as "outside project root" even though '.lazy' exists on
// disk.

// ── Section 4 gate: recordLoopApproval / recordLoopFailure / circuit breaker ──
// Same convention as the `tick` describe block above: readFile is primed
// directly with the exact loops.json fixture each test needs (this file's
// mock is a stub, not a stateful fake fs — a prior registerLoop() call is
// NOT "seen" by a later readFile call unless the test wires it that way).

function gatedLoop(missionId: string, overrides: Partial<PersistedLoop> = {}): PersistedLoop {
  return {
    missionId,
    title: 'Gated loop',
    agentTask: 'Do it',
    loopConfig: createLoopConfig('1h'),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('recordLoopApproval / recordLoopFailure — trial/validated/autonomous lifecycle', () => {
  it('does NOT promote on an approval before the threshold, but does on the one that reaches it', async () => {
    readFile.mockResolvedValue(
      JSON.stringify({
        loops: [gatedLoop('L1', { loopConfig: { ...createLoopConfig('1h'), regimeState: 'trial', trialApprovedCount: 0, trialPromotionThreshold: 2 } })],
        version: '1.0.0',
      }),
    );

    const first = await recordLoopApproval('/repo', 'L1');
    expect(first?.promoted).toBe(false);
    expect(first?.loop.loopConfig.regimeState).toBe('trial');
    expect(first?.loop.loopConfig.trialApprovedCount).toBe(1);

    // Second approval reads the ALREADY-PERSISTED state (simulates the real
    // read-after-write sequence recordLoopApproval's own updateLoop call
    // produces).
    readFile.mockResolvedValue(
      JSON.stringify({
        loops: [gatedLoop('L1', { loopConfig: { ...createLoopConfig('1h'), regimeState: 'trial', trialApprovedCount: 1, trialPromotionThreshold: 2 } })],
        version: '1.0.0',
      }),
    );
    const second = await recordLoopApproval('/repo', 'L1');
    expect(second?.promoted).toBe(true);
    expect(second?.loop.loopConfig.regimeState).toBe('validated');

    const persisted = JSON.parse(writeFile.mock.calls[writeFile.mock.calls.length - 1][1] as string);
    expect(persisted.loops[0].loopConfig.regimeState).toBe('validated');
  });

  it('returns null for a loop with no gated regime at all (no promotion mechanics apply)', async () => {
    readFile.mockResolvedValue(JSON.stringify({ loops: [gatedLoop('L2')], version: '1.0.0' })); // no regimeState
    expect(await recordLoopApproval('/repo', 'L2')).toBeNull();
    expect(await recordLoopFailure('/repo', 'L2')).toBeNull();
  });

  it('returns null for a missionId that is not a registered loop at all — the structural guarantee behind "no promotion for a single task"', async () => {
    readFile.mockRejectedValue(new Error('not found')); // no loops.json at all
    expect(await recordLoopApproval('/repo', 'not-a-loop')).toBeNull();
    expect(await recordLoopFailure('/repo', 'not-a-loop')).toBeNull();
  });

  it('demotes a validated loop back to trial on the first failure and persists it', async () => {
    readFile.mockResolvedValue(
      JSON.stringify({
        loops: [gatedLoop('L3', { loopConfig: { ...createLoopConfig('1h'), regimeState: 'validated', trialApprovedCount: 2, trialPromotionThreshold: 2 } })],
        version: '1.0.0',
      }),
    );

    const outcome = await recordLoopFailure('/repo', 'L3');
    expect(outcome?.demoted).toBe(true);
    expect(outcome?.loop.loopConfig.regimeState).toBe('trial');
    expect(outcome?.loop.loopConfig.trialApprovedCount).toBe(0);

    const persisted = JSON.parse(writeFile.mock.calls[writeFile.mock.calls.length - 1][1] as string);
    expect(persisted.loops[0].loopConfig.regimeState).toBe('trial');
  });

  it('a failure while already in trial never promotes/regresses further', async () => {
    readFile.mockResolvedValue(
      JSON.stringify({
        loops: [gatedLoop('L4', { loopConfig: { ...createLoopConfig('1h'), regimeState: 'trial', trialApprovedCount: 0, trialPromotionThreshold: 3 } })],
        version: '1.0.0',
      }),
    );
    const outcome = await recordLoopFailure('/repo', 'L4');
    expect(outcome?.demoted).toBe(false);
    expect(outcome?.loop.loopConfig.regimeState).toBe('trial');
  });
});

describe('artifactOwnerIdForLoop', () => {
  it('defaults to the loop\'s own missionId when no templateArtifactRef is set', () => {
    expect(artifactOwnerIdForLoop({ missionId: 'L1', loopConfig: createLoopConfig('1h') })).toBe('L1');
  });

  it('uses the explicit templateArtifactRef when set (a separate one-time validation mission froze it)', () => {
    expect(
      artifactOwnerIdForLoop({ missionId: 'L1', loopConfig: { ...createLoopConfig('1h'), templateArtifactRef: 'M-validation' } }),
    ).toBe('M-validation');
  });
});

describe('loopEngine persistence — verbatim-safe path join', () => {
  it('registerLoop() persists via a verbatim-safe joined path using backslash throughout, never a literal "/"', async () => {
    const repoPath = String.raw`\\?\C:\Users\user\Documents\cerveau\qa-project`;

    await registerLoop(repoPath, {
      missionId: 'M1',
      title: 'Loop mission',
      agentTask: 'Do something',
      loopConfig: createLoopConfig('1h'),
    });

    expect(createDir).toHaveBeenCalledWith(
      String.raw`\\?\C:\Users\user\Documents\cerveau\qa-project\.lazy`,
    );
    const [writtenPath] = writeFile.mock.calls[0] as [string, string];
    expect(writtenPath).toBe(
      String.raw`\\?\C:\Users\user\Documents\cerveau\qa-project\.lazy\loops.json`,
    );
    expect(writtenPath).not.toContain('/');
  });

  it('listLoops() reads via the same verbatim-safe joined path', async () => {
    const repoPath = String.raw`\\?\C:\repo`;
    await listLoops(repoPath);

    expect(readFile).toHaveBeenCalledWith(String.raw`\\?\C:\repo\.lazy\loops.json`);
  });

  it('still works with a POSIX repoPath (no behavior change)', async () => {
    await registerLoop('/repo', {
      missionId: 'M2',
      title: 'Loop mission',
      agentTask: 'Do something',
      loopConfig: createLoopConfig('1h'),
    });

    expect(createDir).toHaveBeenCalledWith('/repo/.lazy');
    expect(writeFile).toHaveBeenCalledWith('/repo/.lazy/loops.json', expect.any(String));
  });
});
