/**
 * Tests for contestEngine.ts (W-CONTEST — best-of-N contest runtime).
 * Harness mirrors joinEngine.test.ts/chainEngine.test.ts exactly:
 * `@tauri-apps/api/core`/`event` are globally mocked by setup.ts; `invoke`
 * is configured per test via `installInvokeFake`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  initContestEngine,
  onMissionTerminalForContest,
  reconcileContests,
  rankContestants,
  _resetContestEngineForTests,
  type ContestEngineDeps,
  type MissionEntry,
} from '../lib/agents/contestEngine';
import { _resetChainEngineForTests } from '../lib/agents/chainEngine';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import type { ContestSpec } from '../components/agents/canvas/canvasTypes';
import type { JudgeVerdict, Mission } from '../lib/agents/types';

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

// ── Fixtures (same shapes as chainEngine.test.ts / joinEngine.test.ts) ──

function verdict(overrides: Partial<JudgeVerdict> & { score: number; passed: boolean }): JudgeVerdict {
  return { risk: 'low', reviewers: [], createdAt: '2026-01-01T00:00:00Z', ...overrides };
}

function mission(overrides: Partial<Mission> & { id: string }): Mission {
  return { title: `Mission ${overrides.id}`, status: 'running', model: 'sonnet', ...overrides };
}

function contest(overrides: Partial<ContestSpec> & { id: string; missionIds: string[] }): ContestSpec {
  return { draftTemplateId: 'd1', status: 'running', createdAtMs: 1, ...overrides };
}

interface JournalRow {
  mission_id: string;
  project_id: string;
  status: string;
  data: string;
  updated_ms: number;
}

function journalRow(m: Mission, projectId: string, updatedMs: number): JournalRow {
  return { mission_id: m.id, project_id: projectId, status: m.status, data: JSON.stringify(m), updated_ms: updatedMs };
}

function installInvokeFake(rows: JournalRow[]): { rows: JournalRow[] } {
  const box = { rows };
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'journal_missions_current') return box.rows;
    if (cmd === 'canvas_state_save') return undefined;
    if (cmd === 'canvas_state_load') return null;
    if (cmd === 'journal_emit') return 1;
    if (cmd === 'journal_emit_batch') return 1;
    throw new Error(`unexpected invoke: ${cmd}`);
  });
  return box;
}

function makeDeps(overrides: Partial<ContestEngineDeps> = {}): ContestEngineDeps & { archiveMission: ReturnType<typeof vi.fn> } {
  return {
    archiveMission: vi.fn(),
    getActiveProjectId: vi.fn(async () => 'proj-1'),
    ...overrides,
  } as ContestEngineDeps & { archiveMission: ReturnType<typeof vi.fn> };
}

function enableTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

function disableTauri(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  _resetChainEngineForTests();
  _resetContestEngineForTests();
  mockInvoke.mockReset();
  mockListen.mockReset();
  mockListen.mockResolvedValue(() => undefined);
  installInvokeFake([]);
  enableTauri();
});

afterEach(() => {
  disableTauri();
});

// ── Pure ranking logic ──────────────────────────────────────────────────

describe('rankContestants (pure)', () => {
  function entry(m: Mission, updatedMs: number): MissionEntry {
    return { mission: m, updatedMs };
  }

  it('a real passing score always wins, even over a more RECENT unscored success', () => {
    const entries = [
      entry(mission({ id: 'm1', status: 'done', judgeVerdict: verdict({ score: 70, passed: true }) }), 500),
      entry(mission({ id: 'm2', status: 'done' }), 1000), // more recent, but no verdict at all
    ];
    const { winnerId } = rankContestants(entries);
    expect(winnerId).toBe('m1');
  });

  it('never ranks a scoreUnavailable (fabricated) verdict above a real scored one, regardless of the placeholder number', () => {
    const entries = [
      // scoreUnavailable carries a numeric placeholder (99) that must NEVER be trusted.
      entry(mission({ id: 'm1', status: 'done', judgeVerdict: verdict({ score: 99, passed: true, scoreUnavailable: true }) }), 100),
      entry(mission({ id: 'm2', status: 'done', judgeVerdict: verdict({ score: 10, passed: true }) }), 200),
    ];
    const { winnerId, ranking } = rankContestants(entries);
    expect(winnerId).toBe('m2');
    // The ranking entry itself never surfaces the placeholder as a real score.
    expect(ranking.find((r) => r.missionId === 'm1')!.score).toBeUndefined();
    expect(ranking.find((r) => r.missionId === 'm2')!.score).toBe(10);
  });

  it('a REJECTED verdict (passed: false) is never winner-eligible even with a real high score', () => {
    const entries = [
      entry(mission({ id: 'm1', status: 'done', judgeVerdict: verdict({ score: 95, passed: false }) }), 100),
      entry(mission({ id: 'm2', status: 'done', judgeVerdict: verdict({ score: 40, passed: true }) }), 200),
    ];
    const { winnerId } = rankContestants(entries);
    expect(winnerId).toBe('m2');
  });

  it('tie-breaks equal real scores by LOWER costUsd first', () => {
    const entries = [
      entry(mission({ id: 'm1', status: 'done', judgeVerdict: verdict({ score: 80, passed: true }), agentMetrics: { durationMs: 1000, inputTokens: 1, outputTokens: 1, costUsd: 5, toolCount: 1 } }), 100),
      entry(mission({ id: 'm2', status: 'done', judgeVerdict: verdict({ score: 80, passed: true }), agentMetrics: { durationMs: 1000, inputTokens: 1, outputTokens: 1, costUsd: 3, toolCount: 1 } }), 200),
    ];
    const { winnerId } = rankContestants(entries);
    expect(winnerId).toBe('m2'); // cheaper, same score
  });

  it('tie-breaks equal score AND cost by SHORTER duration', () => {
    const entries = [
      entry(mission({ id: 'm1', status: 'done', judgeVerdict: verdict({ score: 80, passed: true }), agentMetrics: { durationMs: 9000, inputTokens: 1, outputTokens: 1, costUsd: 3, toolCount: 1 } }), 100),
      entry(mission({ id: 'm2', status: 'done', judgeVerdict: verdict({ score: 80, passed: true }), agentMetrics: { durationMs: 500, inputTokens: 1, outputTokens: 1, costUsd: 3, toolCount: 1 } }), 200),
    ];
    const { winnerId } = rankContestants(entries);
    expect(winnerId).toBe('m2'); // faster, same score + cost
  });

  it('falls back to the most recent SUCCESS when nobody has a real score', () => {
    const entries = [
      entry(mission({ id: 'm1', status: 'done' }), 100),
      entry(mission({ id: 'm2', status: 'done' }), 500), // most recent success
      entry(mission({ id: 'm3', status: 'failed' }), 900),
    ];
    const { winnerId } = rankContestants(entries);
    expect(winnerId).toBe('m2');
  });

  it('honest no-winner case: nobody scored AND nobody succeeded — every contestant stays in the ranking', () => {
    const entries = [
      entry(mission({ id: 'm1', status: 'failed' }), 100),
      entry(mission({ id: 'm2', status: 'cancelled' }), 200),
    ];
    const { winnerId, ranking } = rankContestants(entries);
    expect(winnerId).toBeUndefined();
    expect(ranking.map((r) => r.missionId).sort()).toEqual(['m1', 'm2']);
  });
});

// ── Live path (onMissionTerminalForContest) ─────────────────────────────

describe('contest engine — live path (onMissionTerminalForContest)', () => {
  it('does not complete the contest while one contestant is still running', async () => {
    const deps = makeDeps();
    canvasStoreVanilla.getState().addContest(contest({ id: 'k1', missionIds: ['m1', 'm2'] }));
    initContestEngine(deps);

    installInvokeFake([journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100)]);
    onMissionTerminalForContest(mission({ id: 'm1', status: 'done' }));
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.archiveMission).not.toHaveBeenCalled();
    expect(canvasStoreVanilla.getState().contests.find((c) => c.id === 'k1')!.status).toBe('running');
  });

  it('completes once ALL contestants are terminal: archives every loser, leaves the winner untouched', async () => {
    const deps = makeDeps();
    canvasStoreVanilla.getState().addContest(contest({ id: 'k1', missionIds: ['m1', 'm2'] }));
    initContestEngine(deps);

    installInvokeFake([
      journalRow(mission({ id: 'm1', status: 'done', judgeVerdict: verdict({ score: 90, passed: true }) }), 'proj-1', 100),
      journalRow(mission({ id: 'm2', status: 'done', judgeVerdict: verdict({ score: 60, passed: true }) }), 'proj-1', 200),
    ]);
    onMissionTerminalForContest(mission({ id: 'm2', status: 'done' }));
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.archiveMission).toHaveBeenCalledTimes(1);
    expect(deps.archiveMission).toHaveBeenCalledWith('m2');
    expect(deps.archiveMission).not.toHaveBeenCalledWith('m1');

    const finished = canvasStoreVanilla.getState().contests.find((c) => c.id === 'k1')!;
    expect(finished.status).toBe('completed');
    expect(finished.winnerId).toBe('m1');
  });

  it('a mission not referenced by any running contest never touches contests at all', async () => {
    const deps = makeDeps();
    canvasStoreVanilla.getState().addContest(contest({ id: 'k1', missionIds: ['m1', 'm2'] }));
    initContestEngine(deps);

    installInvokeFake([journalRow(mission({ id: 'other', status: 'done' }), 'proj-1', 100)]);
    onMissionTerminalForContest(mission({ id: 'other', status: 'done' }));
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.archiveMission).not.toHaveBeenCalled();
    expect(canvasStoreVanilla.getState().contests.find((c) => c.id === 'k1')!.status).toBe('running');
  });

  it('a cancelled contestant counts as terminal (never hangs the contest forever)', async () => {
    const deps = makeDeps();
    canvasStoreVanilla.getState().addContest(contest({ id: 'k1', missionIds: ['m1', 'm2'] }));
    initContestEngine(deps);

    installInvokeFake([
      journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100),
      journalRow(mission({ id: 'm2', status: 'cancelled' }), 'proj-1', 200),
    ]);
    onMissionTerminalForContest(mission({ id: 'm2', status: 'cancelled' }));
    await new Promise((r) => setTimeout(r, 20));

    const finished = canvasStoreVanilla.getState().contests.find((c) => c.id === 'k1')!;
    expect(finished.status).toBe('completed');
    expect(finished.winnerId).toBe('m1'); // only real success
    expect(deps.archiveMission).toHaveBeenCalledWith('m2');
  });
});

// ── Restart / reconcile ──────────────────────────────────────────────────

describe('contest engine — restart / reconcile', () => {
  it('a fresh boot whose contestants are ALREADY terminal in the journal completes the contest once via reconcileContests', async () => {
    const deps = makeDeps();
    canvasStoreVanilla.getState().addContest(contest({ id: 'k1', missionIds: ['m1', 'm2'] }));
    installInvokeFake([
      journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100),
      journalRow(mission({ id: 'm2', status: 'failed' }), 'proj-1', 200),
    ]);

    initContestEngine(deps); // runs one startup reconcileContests() internally
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.archiveMission).toHaveBeenCalledWith('m2');
    const finished = canvasStoreVanilla.getState().contests.find((c) => c.id === 'k1')!;
    expect(finished.status).toBe('completed');
    expect(finished.winnerId).toBe('m1');
  });

  it('never re-completes (never double-archives) an already-completed contest on a later reconcile', async () => {
    const deps = makeDeps();
    canvasStoreVanilla.getState().addContest(contest({ id: 'k1', missionIds: ['m1', 'm2'] }));
    installInvokeFake([
      journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100),
      journalRow(mission({ id: 'm2', status: 'failed' }), 'proj-1', 200),
    ]);
    initContestEngine(deps);
    await new Promise((r) => setTimeout(r, 20));
    expect(deps.archiveMission).toHaveBeenCalledTimes(1);

    await reconcileContests();
    await reconcileContests();
    expect(deps.archiveMission).toHaveBeenCalledTimes(1); // still just once — status is now 'completed'
  });

  it('does not complete on reconcile when a contestant is not yet terminal', async () => {
    const deps = makeDeps();
    canvasStoreVanilla.getState().addContest(contest({ id: 'k1', missionIds: ['m1', 'm2'] }));
    installInvokeFake([journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100)]);
    initContestEngine(deps);
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.archiveMission).not.toHaveBeenCalled();
    expect(canvasStoreVanilla.getState().contests.find((c) => c.id === 'k1')!.status).toBe('running');
  });
});
