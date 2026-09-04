/**
 * nightShift.test.ts — T3.4 audit follow-up coverage: the standing loop's
 * idle/budget/cadence contract (src/lib/brain/nightShift.ts).
 *
 * journal.ts, consolidation.ts and costStore.ts are mocked — this suite
 * exercises tick()'s OWN gating logic (currentWindowStartIso/isUserActive/
 * hasRunningMission/the budget check), not the task runners' real behavior
 * (consolidation's own responsibility) or the journal client itself
 * (already covered by journal.test.ts).
 *
 * journalQuery is mocked with ONE shared fixture array (`journalRows`) used
 * by both the idle-check and the running-mission-check — nightShift filters
 * client-side by actor/type, so a single fixture list can stand in for "the
 * recent journal" for either query without argument-sensitive mocking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JournalEventRow } from '../lib/journal/eventTypes';
import type { journalQuery } from '../lib/journal/journal';

// ── Journal mock ──────────────────────────────────────────────────────
let journalRows: JournalEventRow[] = [];
const mockedJournalQuery = vi.fn<typeof journalQuery>(async () => journalRows);
const mockedEmitBuffered = vi.fn();

vi.mock('../lib/journal/journal', () => ({
  journalQuery: (...args: Parameters<typeof journalQuery>) => mockedJournalQuery(...args),
  emitBuffered: (...args: unknown[]) => mockedEmitBuffered(...args),
  emitEvent: vi.fn().mockResolvedValue(undefined),
}));

// ── Consolidation mock — task runners are somebody else's responsibility;
// here they're stand-ins whose "cost" is driven by `costUsd` below so the
// budget contract can be exercised deterministically. ────────────────────
const runConsolidationPipelineMock = vi.fn();
const promoteToRootTrunkMock = vi.fn();

vi.mock('../lib/brain/consolidation', () => ({
  runConsolidationPipeline: (...args: unknown[]) => runConsolidationPipelineMock(...args),
  promoteToRootTrunk: (...args: unknown[]) => promoteToRootTrunkMock(...args),
}));

// ── Cost store mock — controllable totalCostUsd so a cycle's spend delta
// (getCostState before/after) is deterministic. ─────────────────────────
let costUsd = 0;
vi.mock('../lib/models/costStore', () => ({
  getCostState: () => ({
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalBrainTokensSaved: 0,
    totalCostUsd: costUsd,
  }),
}));

import {
  startNightShift,
  runNightShiftCycle,
  resetNightShiftForTests,
  DEFAULT_NIGHT_SHIFT_CONFIG,
} from '../lib/brain/nightShift';
import type { NightShiftConfig } from '../lib/brain/nightShift';

// ── Fixtures ─────────────────────────────────────────────────────────

function userActivityRow(tsMs: number): JournalEventRow {
  return {
    seq: tsMs,
    ts_ms: tsMs,
    project_id: 'proj-1',
    mission_id: null,
    agent_id: null,
    run_id: null,
    actor: 'user',
    type: 'mission.created',
    payload: '{}',
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  };
}

function missionLifecycleRow(missionId: string, type: 'mission.started' | 'mission.completed', tsMs: number): JournalEventRow {
  return {
    seq: tsMs,
    ts_ms: tsMs,
    project_id: 'proj-1',
    mission_id: missionId,
    agent_id: null,
    run_id: null,
    actor: 'agent',
    type,
    payload: '{}',
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  };
}

function testConfig(overrides: Partial<NightShiftConfig> = {}): NightShiftConfig {
  return { ...DEFAULT_NIGHT_SHIFT_CONFIG, ...overrides };
}

function enableTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

function disableTauri(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

const baselineConsolidationResult = {
  consolidation: { missionsProcessed: 1, neuronsCaptured: 1, errors: [] as string[] },
  promotion: { neuronsPromoted: 0, errors: [] as string[] },
};

beforeEach(() => {
  vi.useFakeTimers();
  journalRows = [];
  costUsd = 0;

  mockedJournalQuery.mockClear();
  mockedEmitBuffered.mockClear();

  runConsolidationPipelineMock.mockReset();
  runConsolidationPipelineMock.mockImplementation(async () => baselineConsolidationResult);
  promoteToRootTrunkMock.mockReset();
  promoteToRootTrunkMock.mockImplementation(async () => ({ neuronsPromoted: 0, errors: [] }));

  localStorage.clear();
  resetNightShiftForTests();
  enableTauri();
});

afterEach(() => {
  vi.useRealTimers();
  disableTauri();
  vi.restoreAllMocks();
});

// ── runNightShiftCycle — the mechanism (no gating) ───────────────────

describe('runNightShiftCycle', () => {
  it('runs all configured tasks unconditionally, ignoring user activity', async () => {
    journalRows = [userActivityRow(Date.now())];

    const report = await runNightShiftCycle(testConfig({ tasks: ['consolidate'] }));

    expect(runConsolidationPipelineMock).toHaveBeenCalledTimes(1);
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0].task).toBe('consolidate');
  });

  it('tags each result with a loop.iteration event carrying a summary (briefing contract)', async () => {
    await runNightShiftCycle(testConfig({ tasks: ['consolidate'] }));

    expect(mockedEmitBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'loop.iteration',
        payload: expect.objectContaining({ summary: expect.stringContaining('consolidate') }),
      }),
    );
  });
});

// ── startNightShift — the policy (idle/budget/cadence gates) ─────────

describe('startNightShift — idle gate', () => {
  it('does not run a cycle while a user-actor event is within the idle window', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 2, 0, 0));
    journalRows = [userActivityRow(Date.now() - 5 * 60 * 1000)]; // 5min ago — active

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = startNightShift(testConfig({ intervalMs: 60_000, tasks: ['consolidate'] }));

    await vi.advanceTimersByTimeAsync(60_000);
    stop();

    expect(runConsolidationPipelineMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('user active'));
  });

  it('runs a cycle once the user has been inactive for the idle window', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 2, 0, 0));
    journalRows = []; // no user activity at all

    const stop = startNightShift(testConfig({ intervalMs: 60_000, tasks: ['consolidate'] }));
    await vi.advanceTimersByTimeAsync(60_000);
    stop();

    expect(runConsolidationPipelineMock).toHaveBeenCalledTimes(1);
  });
});

describe('startNightShift — mission-running gate', () => {
  it('does not run a cycle while a mission has started with no terminal event yet', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 2, 0, 0));
    journalRows = [missionLifecycleRow('M1', 'mission.started', Date.now() - 1000)];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = startNightShift(testConfig({ intervalMs: 60_000, tasks: ['consolidate'] }));
    await vi.advanceTimersByTimeAsync(60_000);
    stop();

    expect(runConsolidationPipelineMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('mission is currently running'));
  });

  it('allows a tick once the running mission has a terminal event', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 2, 0, 0));
    journalRows = [
      missionLifecycleRow('M1', 'mission.started', Date.now() - 5000),
      missionLifecycleRow('M1', 'mission.completed', Date.now() - 1000),
    ];

    const stop = startNightShift(testConfig({ intervalMs: 60_000, tasks: ['consolidate'] }));
    await vi.advanceTimersByTimeAsync(60_000);
    stop();

    expect(runConsolidationPipelineMock).toHaveBeenCalledTimes(1);
  });
});

describe('startNightShift — budget gate', () => {
  it('launches while spend is under the budget, then blocks once the cap is reached', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 2, 0, 0));
    journalRows = [];
    runConsolidationPipelineMock.mockImplementationOnce(async () => {
      costUsd += 6; // exceeds the default $5 cap in one cycle
      return baselineConsolidationResult;
    });

    const stop = startNightShift(testConfig({ intervalMs: 60_000, tasks: ['consolidate'] }));

    await vi.advanceTimersByTimeAsync(60_000); // first tick: under budget ($0), runs
    expect(runConsolidationPipelineMock).toHaveBeenCalledTimes(1);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 60_000); // clear the hourly cadence gate too
    expect(runConsolidationPipelineMock).toHaveBeenCalledTimes(1); // still 1 — now blocked by budget
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('budget'));

    stop();
  });
});

describe('startNightShift — night window reset', () => {
  it('resets spend once the clock rolls into the next night window', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 22, 30, 0)); // inside tonight's window (22:00-08:00)
    journalRows = [];
    runConsolidationPipelineMock.mockImplementation(async () => {
      costUsd += 6; // every run pushes this window over the $5 cap
      return baselineConsolidationResult;
    });

    const stop = startNightShift(testConfig({ intervalMs: 30 * 60 * 1000, tasks: ['consolidate'] }));

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000); // first run this window (over budget after this)
    expect(runConsolidationPipelineMock).toHaveBeenCalledTimes(1);

    // Jump ~25h forward — past the hourly cadence gate AND into the NEXT
    // night's window (tomorrow 22:00+), where spend must have reset to 0.
    await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
    expect(runConsolidationPipelineMock).toHaveBeenCalledTimes(2);

    stop();
  });
});

describe('startNightShift — at most once per hour', () => {
  it('collapses sub-hourly polls into at most one cycle per hour', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 2, 0, 0));
    journalRows = [];

    const stop = startNightShift(testConfig({ intervalMs: 15 * 60 * 1000, tasks: ['consolidate'] }));

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000); // t=15min: first real run
    expect(runConsolidationPipelineMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000); // t=30min: cadence blocks (15min elapsed)
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000); // t=45min: cadence blocks (30min elapsed)
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000); // t=60min: cadence blocks (45min elapsed)
    expect(runConsolidationPipelineMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000); // t=75min: 60min since first run — allowed
    expect(runConsolidationPipelineMock).toHaveBeenCalledTimes(2);

    stop();
  });
});

describe('startNightShift — unchanged no-op guards', () => {
  it('is a no-op outside Tauri', async () => {
    disableTauri();
    journalRows = [];
    const stop = startNightShift(testConfig({ intervalMs: 60_000, tasks: ['consolidate'] }));
    await vi.advanceTimersByTimeAsync(60_000);
    stop();
    expect(runConsolidationPipelineMock).not.toHaveBeenCalled();
  });

  it('is a no-op when disabled', async () => {
    journalRows = [];
    const stop = startNightShift(testConfig({ intervalMs: 60_000, tasks: ['consolidate'], enabled: false }));
    await vi.advanceTimersByTimeAsync(60_000);
    stop();
    expect(runConsolidationPipelineMock).not.toHaveBeenCalled();
  });
});
