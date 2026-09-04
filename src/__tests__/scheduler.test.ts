/**
 * scheduler.test.ts — T1.1 coverage for the provider-aware concurrency
 * scheduler (src/lib/agents/scheduler.ts).
 *
 * The journal client is mocked (vi.mock('../lib/journal/journal')) so these
 * tests assert scheduling DECISIONS (launch now vs queue, which pool, when
 * backoff applies) rather than journal delivery mechanics — those are
 * already covered by journal.test.ts / journalEmitters.test.ts.
 *
 * launchFn mocks are controllable: each test creates a `deferred()` promise
 * per mission so it can resolve/reject it at a chosen point and observe the
 * scheduler's reaction (slot release, backoff, drain).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { Mission, MissionContract } from '../lib/agents/types';
import { emitEvent, journalQuery } from '../lib/journal/journal';

// journalQuery is exercised indirectly here (via preflight.ts's
// checkConflicts, T1.6's wire-in) — resolving [] by default means every
// test's conflict math comes from missions' DECLARED contract.scopePaths
// alone, never historical touches (that path has its own dedicated coverage
// in preflight.test.ts).
vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
  journalQuery: vi.fn().mockResolvedValue([]),
}));

// @tauri-apps/api/core and @tauri-apps/api/event are already globally
// mocked (src/__tests__/setup.ts) — invoke is cast here (same convention as
// cliBackendProvider.test.ts) purely to assert on set_missions_active calls
// (founder north star wiring) below.

import {
  resolveProvider,
  dispatch,
  reportRateLimit,
  poolStatus,
  resetSchedulerForTests,
  releaseMissionSlot,
  getRunningMissionIds,
  missionQueueWait,
  LS_AGENTS_POOLS,
} from '../lib/agents/scheduler';
import { LS_AGENTS_MAX_PARALLEL } from '../components/settings/AgentsPanel';
import { setSystemPressureForTests, resetSystemPressureForTests } from '../lib/agents/systemPressure';

const mockedEmitEvent = vi.mocked(emitEvent);
const mockedJournalQuery = vi.mocked(journalQuery);
const mockedInvoke = vi.mocked(invoke);

/** Toggles `window.__TAURI_INTERNALS__` — same convention runtimeDispatch.
 *  test.ts's own setTauriRuntime helper uses — so isTauri() (scheduler.ts /
 *  systemPressure.ts) reports true only for the tests that need it. Absent
 *  by default (src/__tests__/setup.ts deletes it), so every pre-existing
 *  test above keeps its exact original behavior: `invoke` never called for
 *  set_missions_active. */
function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) w['__TAURI_INTERNALS__'] = {};
  else delete w['__TAURI_INTERNALS__'];
}

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'M1',
    title: 'Test mission',
    status: 'queued',
    model: 'claude-sonnet-5',
    ...overrides,
  };
}

/** Minimal valid MissionContract (T1.6 tests only care about scopePaths). */
function makeContract(scopePaths: string[]): MissionContract {
  return {
    objective: 'test',
    model: 'claude-sonnet-5',
    permissionMode: 'acceptEdits',
    budgetCapUsd: 5,
    proofs: [],
    gates: { evaluators: true, humanApprove: true },
    shareToTeam: false,
    scopePaths,
  };
}

/** A promise plus its resolve/reject, for controllable launchFn mocks. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void } {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flushes pending microtasks (promise .then/.catch/.finally chains) so
 *  assertions after resolve()/reject() see the scheduler's reaction. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  resetSchedulerForTests();
  resetSystemPressureForTests();
  setTauriRuntime(false);
  vi.clearAllMocks();
});

afterEach(() => {
  resetSchedulerForTests();
  resetSystemPressureForTests();
  setTauriRuntime(false);
  vi.useRealTimers();
});

// ── resolveProvider ──────────────────────────────────────────────────

describe('resolveProvider', () => {
  it('resolves a native (non-"/") model id to claude-cli by default', () => {
    expect(resolveProvider(makeMission({ model: 'claude-sonnet-5' }))).toBe('claude-cli');
  });

  it('resolves an OpenRouter-shaped ("/") model id to managed', () => {
    expect(resolveProvider(makeMission({ model: 'anthropic/claude-sonnet-5' }))).toBe('managed');
  });

  it('resolves a native model id to a byok:<hash> pool when accessMode is byok', () => {
    localStorage.setItem('lazy.accessSettings', JSON.stringify({ accessMode: 'byok', byokProvider: 'anthropic' }));
    localStorage.setItem('lazy.apikey.anthropic', 'sk-ant-secret-key-value');

    const pool = resolveProvider(makeMission({ model: 'claude-sonnet-5' }));

    expect(pool).toMatch(/^byok:[0-9a-f]{8}$/);
    expect(pool).not.toContain('sk-ant-secret-key-value');
  });

  it('derives a stable hash: the same BYOK key always maps to the same pool', () => {
    localStorage.setItem('lazy.accessSettings', JSON.stringify({ accessMode: 'byok', byokProvider: 'anthropic' }));
    localStorage.setItem('lazy.apikey.anthropic', 'sk-ant-same-key');

    const first = resolveProvider(makeMission({ model: 'claude-sonnet-5' }));
    const second = resolveProvider(makeMission({ model: 'claude-haiku-4-5' }));

    expect(first).toBe(second);
  });

  it('derives DIFFERENT pools for different BYOK keys', () => {
    localStorage.setItem('lazy.accessSettings', JSON.stringify({ accessMode: 'byok', byokProvider: 'anthropic' }));

    localStorage.setItem('lazy.apikey.anthropic', 'key-one');
    const poolOne = resolveProvider(makeMission({ model: 'claude-sonnet-5' }));

    localStorage.setItem('lazy.apikey.anthropic', 'key-two');
    const poolTwo = resolveProvider(makeMission({ model: 'claude-sonnet-5' }));

    expect(poolOne).not.toBe(poolTwo);
  });

  // Money incident (2026-08-14) — Settings > Modeles "Abonnement (CLI
  // d'agent)" claims "aucun coute Lazy" the instant it shows ACTIF. A NEW
  // mission created after that switch must be scheduled against the
  // claude-cli pool, never the billed 'managed' pool this exact scheduler
  // uses to gate/charge Lazy Pro credits — this is the concurrency layer
  // that actually decides which provider a launch bills against, downstream
  // of resolveManagerModelId's own id resolution (see managerEngine.test.ts's
  // "resolveManagerModelId" describe block for that layer's coverage).
  it('routes a NEW mission to the claude-cli pool, never managed, once the CLI rail is explicitly selected in Settings', () => {
    localStorage.setItem('lazy.accessSettings', JSON.stringify({ accessMode: 'cli', cliTool: 'claude' }));

    // A bare native id is exactly what resolveManagerModelId (managerEngine.ts)
    // hands a launch_mission action once the ambient mode reads 'claude-code'
    // (this rail) — see that module's mode === 'claude-code' branch.
    const pool = resolveProvider(makeMission({ model: 'claude-sonnet-5' }));

    expect(pool).toBe('claude-cli');
    expect(pool).not.toBe('managed');
  });

  // Live repro (2026-09-02): a deepseek-chat LazyBot, CLI selected in
  // Settings, landed in 'claude-cli' and waited behind a pool it never used.
  it('routes a BYOK-catalog model (its provider key set) to that key\'s own byok pool, whatever the ambient mode', () => {
    localStorage.setItem('lazy.accessSettings', JSON.stringify({ accessMode: 'cli', cliTool: 'claude' }));
    localStorage.setItem('lazy.apikey.deepseek', 'sk-deepseek-secret');

    const pool = resolveProvider(makeMission({ model: 'deepseek-chat', botId: 'bot_1' }));

    expect(pool).toMatch(/^byok:[0-9a-f]{8}$/);
    expect(pool).not.toContain('sk-deepseek-secret');
    // Same key → same pool as any other deepseek model; a different key → a different pool.
    expect(resolveProvider(makeMission({ model: 'deepseek-reasoner' }))).toBe(pool);
    localStorage.setItem('lazy.apikey.deepseek', 'sk-other');
    expect(resolveProvider(makeMission({ model: 'deepseek-chat' }))).not.toBe(pool);
  });

  it('a BYOK-catalog model WITHOUT its key stays on the native/CLI route (nothing to run it on the key)', () => {
    localStorage.setItem('lazy.accessSettings', JSON.stringify({ accessMode: 'cli', cliTool: 'claude' }));
    expect(resolveProvider(makeMission({ model: 'deepseek-chat' }))).toBe('claude-cli');
  });
});

// ── Cap enforcement ──────────────────────────────────────────────────

describe('dispatch — per-pool cap enforcement', () => {
  it('respects the default claude-cli cap of 2: a 3rd concurrent mission is queued, not launched', async () => {
    const d1 = deferred();
    const d2 = deferred();
    const d3 = deferred();
    const fn1 = vi.fn().mockReturnValue(d1.promise);
    const fn2 = vi.fn().mockReturnValue(d2.promise);
    const fn3 = vi.fn().mockReturnValue(d3.promise);

    await dispatch(makeMission({ id: 'M1', model: 'claude-sonnet-5' }), fn1);
    await dispatch(makeMission({ id: 'M2', model: 'claude-sonnet-5' }), fn2);
    await dispatch(makeMission({ id: 'M3', model: 'claude-sonnet-5' }), fn3);

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
    expect(fn3).not.toHaveBeenCalled();

    const status = poolStatus().find((p) => p.pool === 'claude-cli');
    expect(status).toMatchObject({ running: 2, cap: 2, queued: 1 });

    // Freeing a slot drains the queued mission.
    d1.resolve();
    await flush();
    expect(fn3).toHaveBeenCalledTimes(1);
  });

  it('emits scheduler.queued with reason pool_full when a mission is queued', async () => {
    const fn1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fn2 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fn3 = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    await dispatch(makeMission({ id: 'M1' }), fn1, { projectId: 'proj-1' });
    await dispatch(makeMission({ id: 'M2' }), fn2, { projectId: 'proj-1' });
    await dispatch(makeMission({ id: 'M3' }), fn3, { projectId: 'proj-1' });

    expect(mockedEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'scheduler.queued',
        projectId: 'proj-1',
        missionId: 'M3',
        payload: { reason: 'pool_full', pool: 'claude-cli', depth: 1 },
      }),
    );
    // Never double-emits mission.queued — the scheduler's own event type is
    // additive, never that lifecycle type (agentsStore.tsx owns that).
    expect(mockedEmitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mission.queued' }),
    );
  });

  it('respects a per-pool override from localStorage lazy.agents.pools', async () => {
    localStorage.setItem(LS_AGENTS_POOLS, JSON.stringify({ 'claude-cli': 1 }));
    const fn1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fn2 = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    await dispatch(makeMission({ id: 'M1' }), fn1);
    await dispatch(makeMission({ id: 'M2' }), fn2);

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).not.toHaveBeenCalled();
  });

  it('applies the byok:* wildcard override to every byok:<hash> pool', async () => {
    localStorage.setItem(LS_AGENTS_POOLS, JSON.stringify({ 'byok:*': 1 }));
    localStorage.setItem('lazy.accessSettings', JSON.stringify({ accessMode: 'byok', byokProvider: 'anthropic' }));
    localStorage.setItem('lazy.apikey.anthropic', 'shared-key');

    const fn1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fn2 = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    await dispatch(makeMission({ id: 'M1', model: 'claude-sonnet-5' }), fn1);
    await dispatch(makeMission({ id: 'M2', model: 'claude-sonnet-5' }), fn2);

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).not.toHaveBeenCalled();
  });
});

describe('dispatch — global cap enforcement across pools', () => {
  it('enforces lazy.agents.maxParallel across DIFFERENT pools even when each pool has room', async () => {
    localStorage.setItem(LS_AGENTS_MAX_PARALLEL, '2');

    const fnNative = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fnManaged1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fnManaged2 = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    await dispatch(makeMission({ id: 'M1', model: 'claude-sonnet-5' }), fnNative);
    await dispatch(makeMission({ id: 'M2', model: 'anthropic/claude-sonnet-5' }), fnManaged1);
    // Managed's OWN pool cap (4) has room, but the GLOBAL cap (2) is already
    // saturated by M1+M2 — M3 must queue despite its pool being far from cap.
    await dispatch(makeMission({ id: 'M3', model: 'anthropic/claude-sonnet-5' }), fnManaged2);

    expect(fnNative).toHaveBeenCalledTimes(1);
    expect(fnManaged1).toHaveBeenCalledTimes(1);
    expect(fnManaged2).not.toHaveBeenCalled();
  });

  it('0 means unlimited', async () => {
    localStorage.setItem(LS_AGENTS_MAX_PARALLEL, '0');
    const fn1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fn2 = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    await dispatch(makeMission({ id: 'M1', model: 'anthropic/claude-sonnet-5' }), fn1);
    await dispatch(makeMission({ id: 'M2', model: 'anthropic/claude-sonnet-5' }), fn2);

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });
});

describe('dispatch — hardware default when maxParallel is unset', () => {
  const originalConcurrency = navigator.hardwareConcurrency;
  afterEach(() => {
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      configurable: true,
      value: originalConcurrency,
    });
  });

  it('with nothing configured, the hardware 3–8 default binds even when a pool still has room', async () => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 4 });
    const fns = [vi.fn(), vi.fn(), vi.fn(), vi.fn()].map((fn) =>
      fn.mockReturnValue(new Promise<void>(() => {})),
    );
    for (const [i, fn] of fns.entries()) {
      await dispatch(makeMission({ id: `M${i}`, model: 'anthropic/claude-sonnet-5' }), fn);
    }
    expect(fns[0]).toHaveBeenCalledTimes(1);
    expect(fns[1]).toHaveBeenCalledTimes(1);
    expect(fns[2]).toHaveBeenCalledTimes(1);
    expect(fns[3]).not.toHaveBeenCalled();
  });
});

// ── Queue draining: FIFO within priority ──────────────────────────────

describe('dispatch — queue drains FIFO within priority', () => {
  it('drains queued missions in enqueue order when priorities are equal', async () => {
    const holdA = deferred();
    const fnA = vi.fn().mockReturnValue(holdA.promise);
    const fnB = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fnC = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fnD = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    await dispatch(makeMission({ id: 'A' }), fnA); // launches (slot 1/2)
    await dispatch(makeMission({ id: 'B' }), fnB); // launches (slot 2/2)
    await dispatch(makeMission({ id: 'C' }), fnC); // queued (1st in line)
    await dispatch(makeMission({ id: 'D' }), fnD); // queued (2nd in line)

    expect(fnC).not.toHaveBeenCalled();
    expect(fnD).not.toHaveBeenCalled();

    holdA.resolve();
    await flush();

    // C was queued first — it must drain before D.
    expect(fnC).toHaveBeenCalledTimes(1);
    expect(fnD).not.toHaveBeenCalled();
  });

  it('drains the higher-priority queued mission first, regardless of enqueue order', async () => {
    const holdA = deferred();
    const fnA = vi.fn().mockReturnValue(holdA.promise);
    const fnB = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fnLow = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fnHigh = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    await dispatch(makeMission({ id: 'A' }), fnA);
    await dispatch(makeMission({ id: 'B' }), fnB);
    // Enqueued in this order: low priority first, high priority second.
    await dispatch(makeMission({ id: 'low' }), fnLow, { priority: 0 });
    await dispatch(makeMission({ id: 'high' }), fnHigh, { priority: 10 });

    holdA.resolve();
    await flush();

    expect(fnHigh).toHaveBeenCalledTimes(1);
    expect(fnLow).not.toHaveBeenCalled();
  });
});

// ── Backoff ──────────────────────────────────────────────────────────

describe('reportRateLimit', () => {
  it('can be called directly (not only via a rejected launchFn) to pause a pool', () => {
    reportRateLimit('claude-cli');

    const status = poolStatus().find((p) => p.pool === 'claude-cli');
    expect(status?.backoffUntilMs).toBeGreaterThan(Date.now());
  });
});

describe('dispatch — 429/rate-limit backoff', () => {
  it('reportRateLimit pauses the pool: a numerically-free slot still queues while backed off', async () => {
    const holdA = deferred();
    const fnA = vi.fn().mockReturnValue(holdA.promise);
    await dispatch(makeMission({ id: 'A', model: 'claude-sonnet-5' }), fnA);

    holdA.reject(new Error('429 Too Many Requests'));
    await flush();

    // A settled (failed) — the pool is now empty (0 running) but backed off.
    expect(poolStatus().find((p) => p.pool === 'claude-cli')?.running).toBe(0);

    const fnB = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(makeMission({ id: 'B', model: 'claude-sonnet-5' }), fnB);

    expect(fnB).not.toHaveBeenCalled();
    expect(poolStatus().find((p) => p.pool === 'claude-cli')?.backoffUntilMs).toBeGreaterThan(Date.now());
  });

  it('a rejection whose message does not look rate-limit-shaped does NOT trigger backoff', async () => {
    const holdA = deferred();
    const fnA = vi.fn().mockReturnValue(holdA.promise);
    await dispatch(makeMission({ id: 'A', model: 'claude-sonnet-5' }), fnA);

    holdA.reject(new Error('worktree creation failed: disk full'));
    await flush();

    const fnB = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(makeMission({ id: 'B', model: 'claude-sonnet-5' }), fnB);

    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it('resumes draining a backed-off pool once the exponential window elapses', async () => {
    vi.useFakeTimers();
    try {
      const holdA = deferred();
      const fnA = vi.fn().mockReturnValue(holdA.promise);
      await dispatch(makeMission({ id: 'A', model: 'claude-sonnet-5' }), fnA);

      holdA.reject(new Error('rate limit exceeded'));
      await flush();

      const fnQueued = vi.fn().mockReturnValue(new Promise<void>(() => {}));
      await dispatch(makeMission({ id: 'queued', model: 'claude-sonnet-5' }), fnQueued);
      expect(fnQueued).not.toHaveBeenCalled(); // pool backed off (30s base window)

      await vi.advanceTimersByTimeAsync(30_001);

      // No standalone timer drives the scheduler (see scheduler.ts's header) —
      // the next dispatch() call anywhere opportunistically drains everything
      // eligible first, including this unrelated probe mission's own pool.
      const fnProbe = vi.fn().mockReturnValue(new Promise<void>(() => {}));
      await dispatch(makeMission({ id: 'probe', model: 'claude-sonnet-5' }), fnProbe);

      expect(fnQueued).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset on success: a clean run after a failure clears backoff so the NEXT failure starts at the 30s base again', async () => {
    vi.useFakeTimers();
    try {
      const holdA = deferred();
      const fnA = vi.fn().mockReturnValue(holdA.promise);
      await dispatch(makeMission({ id: 'A', model: 'claude-sonnet-5' }), fnA);
      holdA.reject(new Error('429'));
      await flush();
      expect(poolStatus().find((p) => p.pool === 'claude-cli')?.backoffUntilMs).toBeDefined();

      // A second mission in the pool succeeds cleanly.
      const holdB = deferred();
      const fnB = vi.fn().mockReturnValue(holdB.promise);
      // The pool is still backed off, so B queues rather than launching —
      // advance past the window first so it can actually run.
      await dispatch(makeMission({ id: 'B', model: 'claude-sonnet-5' }), fnB);
      await vi.advanceTimersByTimeAsync(30_001);
      await dispatch(makeMission({ id: 'probe', model: 'claude-sonnet-5' }), vi.fn().mockReturnValue(new Promise<void>(() => {})));
      expect(fnB).toHaveBeenCalledTimes(1);

      holdB.resolve();
      await flush();
      expect(poolStatus().find((p) => p.pool === 'claude-cli')?.backoffUntilMs).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dispatch — pools are independent', () => {
  it('a backed-off claude-cli pool does not block the managed pool', async () => {
    const holdA = deferred();
    const fnA = vi.fn().mockReturnValue(holdA.promise);
    await dispatch(makeMission({ id: 'A', model: 'claude-sonnet-5' }), fnA);
    holdA.reject(new Error('429'));
    await flush();

    const fnManaged = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(makeMission({ id: 'M', model: 'anthropic/claude-sonnet-5' }), fnManaged);

    expect(fnManaged).toHaveBeenCalledTimes(1);
  });
});

// ── Conflict pre-flight wire-in (T1.6, spec §7.2) ──────────────────────

describe('dispatch — conflict pre-flight (T1.6)', () => {
  it('absent scopeInfo: a mission with declared scopePaths still launches immediately (today\'s behavior, byte-identical)', async () => {
    const running = makeMission({ id: 'R', contract: makeContract(['src/lib']) });
    const fnRunning = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(running, fnRunning);

    const candidate = makeMission({ id: 'C', model: 'anthropic/claude-sonnet-5', contract: makeContract(['src/lib/foo.ts']) });
    const fnCandidate = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    // No opts.scopeInfo at all — even though candidate/running scopes DO
    // overlap, dispatch() must never know or care without scopeInfo.
    await dispatch(candidate, fnCandidate);

    expect(fnCandidate).toHaveBeenCalledTimes(1);
    expect(mockedEmitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scheduler.queued', payload: expect.objectContaining({ reason: 'scope_conflict' }) }),
    );
  });

  it('queues a conflicting mission with reason scope_conflict instead of launching it', async () => {
    const running = makeMission({ id: 'R', model: 'anthropic/claude-sonnet-5', contract: makeContract(['src/lib']) });
    const fnRunning = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(running, fnRunning); // occupies the managed pool

    const candidate = makeMission({ id: 'C', model: 'anthropic/claude-sonnet-5', contract: makeContract(['src/lib/foo.ts']) });
    const fnCandidate = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(candidate, fnCandidate, {
      projectId: 'proj-1',
      scopeInfo: { runningMissions: [running] },
    });

    expect(fnCandidate).not.toHaveBeenCalled();
    expect(mockedEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'scheduler.queued',
        projectId: 'proj-1',
        missionId: 'C',
        payload: { reason: 'scope_conflict', pool: 'managed', depth: 1, conflictsWith: ['R'] },
      }),
    );
  });

  it('drains the scope-conflicted mission once the conflicting mission settles', async () => {
    const holdRunning = deferred();
    const running = makeMission({ id: 'R', model: 'anthropic/claude-sonnet-5', contract: makeContract(['src/lib']) });
    const fnRunning = vi.fn().mockReturnValue(holdRunning.promise);
    await dispatch(running, fnRunning);

    const candidate = makeMission({ id: 'C', model: 'anthropic/claude-sonnet-5', contract: makeContract(['src/lib/foo.ts']) });
    const fnCandidate = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(candidate, fnCandidate, { scopeInfo: { runningMissions: [running] } });
    expect(fnCandidate).not.toHaveBeenCalled();

    // R settles — the ONLY mission C conflicted with is no longer running.
    holdRunning.resolve();
    await flush();

    expect(fnCandidate).toHaveBeenCalledTimes(1);
  });

  it('does not queue two disjoint missions against each other', async () => {
    const running = makeMission({ id: 'R', model: 'anthropic/claude-sonnet-5', contract: makeContract(['docs']) });
    const fnRunning = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(running, fnRunning);

    const candidate = makeMission({ id: 'C', model: 'anthropic/claude-sonnet-5', contract: makeContract(['src/lib']) });
    const fnCandidate = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(candidate, fnCandidate, { scopeInfo: { runningMissions: [running] } });

    expect(fnCandidate).toHaveBeenCalledTimes(1);
  });

  it('opts.overrideConflicts launches anyway despite a detected overlap', async () => {
    const running = makeMission({ id: 'R', model: 'anthropic/claude-sonnet-5', contract: makeContract(['src/lib']) });
    const fnRunning = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(running, fnRunning);

    const candidate = makeMission({ id: 'C', model: 'anthropic/claude-sonnet-5', contract: makeContract(['src/lib/foo.ts']) });
    const fnCandidate = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(candidate, fnCandidate, {
      scopeInfo: { runningMissions: [running] },
      overrideConflicts: true,
    });

    expect(fnCandidate).toHaveBeenCalledTimes(1);
  });

  it('a full pool still queues with reason pool_full, never scope_conflict, even when scopeInfo is present but scopes are disjoint', async () => {
    localStorage.setItem(LS_AGENTS_POOLS, JSON.stringify({ managed: 1 }));
    const running = makeMission({ id: 'R', model: 'anthropic/claude-sonnet-5', contract: makeContract(['docs']) });
    const fnRunning = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(running, fnRunning);

    const candidate = makeMission({ id: 'C', model: 'anthropic/claude-sonnet-5', contract: makeContract(['src/lib']) });
    const fnCandidate = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(candidate, fnCandidate, { scopeInfo: { runningMissions: [running] } });

    expect(fnCandidate).not.toHaveBeenCalled();
    expect(mockedEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'scheduler.queued',
        payload: { reason: 'pool_full', pool: 'managed', depth: 1 },
      }),
    );
    expect(mockedJournalQuery).not.toHaveBeenCalled(); // never reached the conflict check at all
  });
});

// ── FOUNDER NORTH STAR: pressure-aware admission ───────────────────────

describe('dispatch — pressure-aware admission (founder north star)', () => {
  it('at "high" pressure, admits NO new launches even when the pool/global cap has room', async () => {
    setSystemPressureForTests({ level: 'high' });
    const fn1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    await dispatch(makeMission({ id: 'M1', model: 'claude-sonnet-5' }), fn1);

    expect(fn1).not.toHaveBeenCalled();
    expect(mockedEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'scheduler.queued',
        missionId: 'M1',
        payload: expect.objectContaining({ reason: 'pool_full' }),
      }),
    );
  });

  it('at "high" pressure, an ALREADY-running mission is unaffected — only NEW launches are refused', async () => {
    const fn1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(makeMission({ id: 'M1', model: 'claude-sonnet-5' }), fn1); // launches while normal
    expect(fn1).toHaveBeenCalledTimes(1);

    setSystemPressureForTests({ level: 'high' });

    const fn2 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(makeMission({ id: 'M2', model: 'claude-sonnet-5' }), fn2);
    expect(fn2).not.toHaveBeenCalled(); // M1 keeps running untouched; M2 is a NEW launch, refused
  });

  it('at "elevated" pressure, halves the configured global cap (floored)', async () => {
    localStorage.setItem(LS_AGENTS_MAX_PARALLEL, '4');
    setSystemPressureForTests({ level: 'elevated' });

    const fnNative = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fnManaged1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fnManaged2 = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    await dispatch(makeMission({ id: 'M1', model: 'claude-sonnet-5' }), fnNative);
    await dispatch(makeMission({ id: 'M2', model: 'anthropic/claude-sonnet-5' }), fnManaged1);
    // Effective cap is floor(4/2) = 2, already saturated by M1+M2 despite
    // the managed pool's own cap (4) having plenty of room.
    await dispatch(makeMission({ id: 'M3', model: 'anthropic/claude-sonnet-5' }), fnManaged2);

    expect(fnNative).toHaveBeenCalledTimes(1);
    expect(fnManaged1).toHaveBeenCalledTimes(1);
    expect(fnManaged2).not.toHaveBeenCalled();
  });

  it('"elevated" never drops the effective cap below 1', async () => {
    localStorage.setItem(LS_AGENTS_MAX_PARALLEL, '1');
    setSystemPressureForTests({ level: 'elevated' });

    const fn1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(makeMission({ id: 'M1', model: 'claude-sonnet-5' }), fn1);

    expect(fn1).toHaveBeenCalledTimes(1); // floor(1/2)=0 -> max(1,0)=1, still admits one
  });

  // Agent ≠ LazyBot: a bot runs on a Solari cloud computer — local pressure
  // is not a reason to hold it. Live repro (2026-09-02): an unrelated
  // brain-indexing process pushed pressure to 'high' and a deepseek-chat
  // LazyBot sat "pool_full" with NOTHING running.
  it('at "high" pressure, still admits a LazyBot mission (cloud-only, no local process)', async () => {
    setSystemPressureForTests({ level: 'high' });
    const fnBot = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fnAgent = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    await dispatch(makeMission({ id: 'B1', model: 'anthropic/claude-sonnet-5', botId: 'bot_solaritest' }), fnBot);
    await dispatch(makeMission({ id: 'M1', model: 'claude-sonnet-5' }), fnAgent);

    expect(fnBot).toHaveBeenCalledTimes(1);
    expect(fnAgent).not.toHaveBeenCalled();
    expect(mockedEmitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scheduler.queued', missionId: 'B1' }),
    );
  });

  it('a LazyBot still honors the CONFIGURED global cap and its pool cap', async () => {
    localStorage.setItem(LS_AGENTS_MAX_PARALLEL, '1');
    setSystemPressureForTests({ level: 'high' });
    const fn1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fn2 = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    await dispatch(makeMission({ id: 'B1', model: 'anthropic/claude-sonnet-5', botId: 'bot_a' }), fn1);
    await dispatch(makeMission({ id: 'B2', model: 'anthropic/claude-sonnet-5', botId: 'bot_b' }), fn2);

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).not.toHaveBeenCalled();
    expect(mockedEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scheduler.queued', missionId: 'B2', payload: expect.objectContaining({ reason: 'pool_full' }) }),
    );
  });

  it('a mission queued during "high" pressure drains once pressure returns to normal', async () => {
    setSystemPressureForTests({ level: 'high' });
    const fn1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(makeMission({ id: 'M1', model: 'claude-sonnet-5' }), fn1);
    expect(fn1).not.toHaveBeenCalled();

    setSystemPressureForTests({ level: 'normal' });
    // No standalone timer drives the scheduler (see this file's own header)
    // — the next dispatch() call anywhere opportunistically drains
    // everything eligible first.
    await dispatch(makeMission({ id: 'probe' }), vi.fn().mockReturnValue(new Promise<void>(() => {})));

    expect(fn1).toHaveBeenCalledTimes(1);
  });

  it('an older/absent Rust build (pressure always normal) behaves byte-identical to today', async () => {
    // getSystemPressure() defaults to 'normal' without any real Tauri
    // event/command ever answering (see systemPressure.ts's own
    // graceful-degradation contract) — nothing in this suite's setup opts
    // into that path explicitly, this test just documents the contract.
    const fn1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fn2 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(makeMission({ id: 'M1', model: 'claude-sonnet-5' }), fn1);
    await dispatch(makeMission({ id: 'M2', model: 'claude-sonnet-5' }), fn2);

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });
});

// ── FOUNDER NORTH STAR: told, not silent (scheduler.throttled) ─────────

describe('dispatch — scheduler.throttled journal event (founder north star: adaptation must be TOLD)', () => {
  /** Any dispatch() call lazily registers scheduler.ts's OWN
   *  systemPressure.ts subscription (ensurePressureWatch) — primed here via
   *  a harmless dispatch (already covered elsewhere) so each test below can
   *  drive pressure transitions directly afterward and observe the emitted
   *  scheduler.throttled event in isolation. */
  async function primeSubscription(): Promise<void> {
    await dispatch(makeMission({ id: 'prime' }), vi.fn().mockReturnValue(new Promise<void>(() => {})));
    mockedEmitEvent.mockClear();
  }

  it('emits scheduler.throttled the first time pressure trips to "elevated"', async () => {
    await primeSubscription();

    setSystemPressureForTests({ level: 'elevated' });

    expect(mockedEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scheduler.throttled', actor: 'system', payload: { level: 'elevated' } }),
    );
  });

  it('does not re-emit for a repeated tick at the SAME level', async () => {
    await primeSubscription();
    setSystemPressureForTests({ level: 'elevated' });
    mockedEmitEvent.mockClear();

    setSystemPressureForTests({ level: 'elevated', cpuPercent: 55 }); // same level, different numbers

    expect(mockedEmitEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'scheduler.throttled' }));
  });

  it('emits again when escalating from "elevated" to "high"', async () => {
    await primeSubscription();
    setSystemPressureForTests({ level: 'elevated' });
    mockedEmitEvent.mockClear();

    setSystemPressureForTests({ level: 'high' });

    expect(mockedEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scheduler.throttled', payload: { level: 'high' } }),
    );
  });

  it('never emits for "normal" itself, and resets so a later re-trip emits again', async () => {
    await primeSubscription();
    setSystemPressureForTests({ level: 'high' });
    mockedEmitEvent.mockClear();

    setSystemPressureForTests({ level: 'normal' });
    expect(mockedEmitEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'scheduler.throttled' }));

    setSystemPressureForTests({ level: 'elevated' });
    expect(mockedEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scheduler.throttled', payload: { level: 'elevated' } }),
    );
  });
});

// ── FOUNDER NORTH STAR: set_missions_active wiring ──────────────────────

describe('dispatch — set_missions_active wiring (resilient if the command is missing)', () => {
  it('calls set_missions_active(true) on the very first launch, and (false) once every mission has settled', async () => {
    setTauriRuntime(true);
    const held = deferred();
    const fn1 = vi.fn().mockReturnValue(held.promise);

    await dispatch(makeMission({ id: 'M1', model: 'claude-sonnet-5' }), fn1);
    expect(mockedInvoke).toHaveBeenCalledWith('set_missions_active', { active: true });

    mockedInvoke.mockClear();
    held.resolve();
    await flush();

    expect(mockedInvoke).toHaveBeenCalledWith('set_missions_active', { active: false });
  });

  it('does not call set_missions_active again for a SECOND concurrent mission (already active)', async () => {
    setTauriRuntime(true);
    const fn1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(makeMission({ id: 'M1', model: 'claude-sonnet-5' }), fn1);
    mockedInvoke.mockClear();

    const fn2 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(makeMission({ id: 'M2', model: 'anthropic/claude-sonnet-5' }), fn2);

    expect(mockedInvoke).not.toHaveBeenCalledWith('set_missions_active', expect.anything());
  });

  it('never calls set_missions_active outside a real Tauri app', async () => {
    setTauriRuntime(false);
    const fn1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    await dispatch(makeMission({ id: 'M1', model: 'claude-sonnet-5' }), fn1);

    expect(mockedInvoke).not.toHaveBeenCalledWith('set_missions_active', expect.anything());
  });

  it('root-cause fix side-effect check: an EARLY releaseMissionSlot call does NOT report (false) — the Rust brain-consolidator gate stays TRUE until launchFn genuinely settles', async () => {
    setTauriRuntime(true);
    const held = deferred();
    const fnA = vi.fn().mockReturnValue(held.promise);
    await dispatch(makeMission({ id: 'A', model: 'claude-sonnet-5' }), fnA);
    expect(mockedInvoke).toHaveBeenCalledWith('set_missions_active', { active: true });

    mockedInvoke.mockClear();
    // Early release (mirrors agentsStore.tsx's applyRunUpdate hook) — the
    // POOL slot frees for scheduling purposes, but runtime.ts's real
    // post-'review' tail (orchestrator fan-out / evaluation) is still doing
    // genuine work under the hood, so the brain-consolidator must NOT be
    // told "no missions active" yet.
    releaseMissionSlot('A');
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_missions_active', expect.anything());

    // Only once launchFn's OWN promise truly settles does the gate flip.
    held.resolve();
    await flush();
    expect(mockedInvoke).toHaveBeenCalledWith('set_missions_active', { active: false });
  });
});

// ── ROOT-CAUSE FIX: releaseMissionSlot (early, idempotent release) ─────
//
// Real production defect (2026-07-28): a validated plan's next mission
// (M47) was queued for 'pool_full' 15s after the PREVIOUS mission (M46)
// had already reached 'review', then never started again for 2+ hours.
// Root cause: launchNow only freed a pool slot once launchFn's promise
// settled — but agentsStore.tsx wraps the ENTIRE runMission() call
// (including runtime.ts's post-'review' orchestrator fan-out / evaluation
// tail) as that promise, so a slow or stuck tail starved the pool for
// every unrelated mission. releaseMissionSlot lets a caller (agentsStore.
// tsx, the moment a mission's status leaves 'running') free the slot
// EARLY, decoupled from launchFn's eventual settlement.

describe('releaseMissionSlot — root-cause fix: early, idempotent release', () => {
  it('frees a running mission\'s slot immediately, decoupled from its launchFn ever settling, and drains a queued mission behind it', async () => {
    localStorage.setItem(LS_AGENTS_POOLS, JSON.stringify({ 'claude-cli': 1 }));

    const fnA = vi.fn().mockReturnValue(new Promise<void>(() => {})); // never settles — simulates a stuck post-completion tail (orchestrator fan-out / evaluation)
    await dispatch(makeMission({ id: 'A', model: 'claude-sonnet-5' }), fnA);
    expect(fnA).toHaveBeenCalledTimes(1);

    const fnB = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(makeMission({ id: 'B', model: 'claude-sonnet-5' }), fnB);
    expect(fnB).not.toHaveBeenCalled(); // queued — pool (cap 1) already full

    // A's launchFn is STILL pending (never resolves) — releaseMissionSlot
    // frees its slot anyway, exactly like agentsStore.tsx's early-release
    // hook does the moment a mission's status leaves 'running'.
    releaseMissionSlot('A');

    expect(fnB).toHaveBeenCalledTimes(1);
    expect(poolStatus().find((p) => p.pool === 'claude-cli')?.running).toBe(1); // B now occupies the (still cap-1) slot
  });

  it('is idempotent: calling it twice, or launchFn settling AFTER an early release, never double-frees the pool count', async () => {
    const held = deferred();
    const fnA = vi.fn().mockReturnValue(held.promise);
    await dispatch(makeMission({ id: 'A', model: 'claude-sonnet-5' }), fnA);
    expect(poolStatus().find((p) => p.pool === 'claude-cli')?.running).toBe(1);

    releaseMissionSlot('A'); // early release (e.g. mission reached 'review')
    expect(poolStatus().find((p) => p.pool === 'claude-cli')).toBeUndefined(); // pool now empty, not just "at 0"

    releaseMissionSlot('A'); // a second early call (e.g. a duplicate status patch) — must be a pure no-op
    expect(poolStatus().find((p) => p.pool === 'claude-cli')).toBeUndefined();

    // A's launchFn FINALLY settles — launchNow's own .finally() must not
    // double-decrement (which would otherwise drive the pool count negative).
    held.resolve();
    await flush();
    expect(poolStatus().find((p) => p.pool === 'claude-cli')).toBeUndefined();

    // A fresh mission still launches normally afterward — proves the pool's
    // bookkeeping stayed sane (not stuck negative or otherwise corrupted).
    const fnB = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(makeMission({ id: 'B', model: 'claude-sonnet-5' }), fnB);
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it('is a safe no-op for a mission id the scheduler never tracked (already released, or never launched)', () => {
    expect(() => releaseMissionSlot('never-existed')).not.toThrow();
  });
});

describe('getRunningMissionIds — reconciliation input for the "reverse leak" guard', () => {
  it('reflects every currently-tracked running mission id, and empties once released', async () => {
    const fnA = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fnB = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(makeMission({ id: 'A', model: 'claude-sonnet-5' }), fnA);
    await dispatch(makeMission({ id: 'B', model: 'anthropic/claude-sonnet-5' }), fnB);

    expect(getRunningMissionIds().sort()).toEqual(['A', 'B']);

    releaseMissionSlot('A');
    expect(getRunningMissionIds()).toEqual(['B']);
  });

  it('returns a plain snapshot array — mutating it never affects scheduler state', async () => {
    const fnA = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(makeMission({ id: 'A', model: 'claude-sonnet-5' }), fnA);

    const snapshot = getRunningMissionIds();
    snapshot.push('injected');

    expect(getRunningMissionIds()).toEqual(['A']);
  });
});

// ── ROOT-CAUSE FIX: visibility — "never silent" ─────────────────────────

describe('missionQueueWait — why a mission is waiting, and for how long', () => {
  it('reports pool/reason/waitedMs for a currently queued (pool_full) mission', async () => {
    const fn1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fn2 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const fn3 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(makeMission({ id: 'M1' }), fn1);
    await dispatch(makeMission({ id: 'M2' }), fn2);
    await dispatch(makeMission({ id: 'M3' }), fn3); // queued — cap 2 already saturated

    const wait = missionQueueWait('M3');
    expect(wait).toMatchObject({ pool: 'claude-cli', reason: 'pool_full' });
    expect(wait?.waitedMs).toBeGreaterThanOrEqual(0);
  });

  it('returns undefined for a mission that is not (or no longer) queued', async () => {
    const fn1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await dispatch(makeMission({ id: 'M1' }), fn1); // launches immediately — never queued

    expect(missionQueueWait('M1')).toBeUndefined();
    expect(missionQueueWait('never-existed')).toBeUndefined();
  });
});

// ── ROOT-CAUSE FIX: periodic safety-net sweep ───────────────────────────

describe('periodic safety-net sweep — recovers a stalled queue without a NEW dispatch() call', () => {
  it('drains a queued mission once a backed-off pool\'s window elapses, with NO new dispatch()/settle event to trigger it — only the periodic sweep', async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(LS_AGENTS_POOLS, JSON.stringify({ 'claude-cli': 1 }));

      const held = deferred();
      const fnA = vi.fn().mockReturnValue(held.promise);
      await dispatch(makeMission({ id: 'A', model: 'claude-sonnet-5' }), fnA);

      held.reject(new Error('429 rate limit'));
      await flush();
      expect(poolStatus().find((p) => p.pool === 'claude-cli')?.backoffUntilMs).toBeGreaterThan(Date.now());

      const fnQueued = vi.fn().mockReturnValue(new Promise<void>(() => {}));
      await dispatch(makeMission({ id: 'queued', model: 'claude-sonnet-5' }), fnQueued);
      // Queued despite the pool being numerically EMPTY (A already settled
      // and released its own slot) — canLaunch still refuses while backed off.
      expect(fnQueued).not.toHaveBeenCalled();

      // No dispatch()/settle call follows — only real time passing. Mirrors
      // the real defect's exact shape: nothing else ever calls dispatch()
      // again for this pool once the plan's single remaining step is the
      // only queued entry. Before this fix, the backoff window expiring
      // would never be noticed by anything.
      await vi.advanceTimersByTimeAsync(30_001); // BACKOFF_BASE_MS + periodic sweep tick

      expect(fnQueued).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits scheduler.stalled exactly once after the wait threshold, never repeating on later ticks', async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(LS_AGENTS_POOLS, JSON.stringify({ 'claude-cli': 1 }));
      const fn1 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
      const fn2 = vi.fn().mockReturnValue(new Promise<void>(() => {}));
      await dispatch(makeMission({ id: 'M1' }), fn1);
      await dispatch(makeMission({ id: 'M2' }), fn2); // queued — cap (1) already saturated by M1
      expect(fn2).not.toHaveBeenCalled();

      mockedEmitEvent.mockClear();

      // Under 3 minutes: no signal yet.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockedEmitEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'scheduler.stalled' }));

      // Crosses STALLED_QUEUE_WAIT_MS (3 min) — exactly one signal.
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(mockedEmitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'scheduler.stalled',
          missionId: 'M2',
          payload: expect.objectContaining({ pool: 'claude-cli', reason: 'pool_full' }),
        }),
      );
      const stalledCallsAfterFirst = mockedEmitEvent.mock.calls.filter(
        (args) => (args[0] as { type?: string }).type === 'scheduler.stalled',
      ).length;
      expect(stalledCallsAfterFirst).toBe(1);

      // Further sweep ticks must NOT re-emit for the same still-queued entry.
      await vi.advanceTimersByTimeAsync(60_000);
      const stalledCallsLater = mockedEmitEvent.mock.calls.filter(
        (args) => (args[0] as { type?: string }).type === 'scheduler.stalled',
      ).length;
      expect(stalledCallsLater).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
