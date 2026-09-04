/**
 * Tests for the journal-first mission lifecycle fixes (2026-08-04 mission,
 * real prod incident on Lazy-real-test):
 *
 *  - A: Mission.repoRoot is stamped by addMission with the mission's own
 *    resolved repo root, and the debounce-save journaling effect derives
 *    EACH changed mission's projectId from ITS OWN repoRoot instead of a
 *    single hoisted "currently active project" id.
 *  - B: findJournalMissionRow / tombstoneJournalMission — delete_mission/
 *    archive_mission honestly succeed (with a real journal tombstone,
 *    `archived: true`) for a mission that exists in the journal's
 *    missions_current projection but not in this session's live
 *    state.missions, instead of throwing "introuvable" for a mission the
 *    user can still see on the board.
 *  - C: resolveMissionWorktreeCandidates — drift-tolerant worktree
 *    discard, trying the mission's own project first and every other open
 *    project before giving up.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  AgentsStoreProvider,
  useAgentsStore,
  resolveMissionWorktreeCandidates,
  _resetZombieSweepGuardForTests,
} from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { parseManagerActions, runManagerTurn } from '../lib/agents/managerEngine';

const mockInvoke = vi.mocked(invoke);

function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

function clearTauriSimulation(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

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

vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return {
    ...actual,
    runManagerTurn: vi.fn(),
  };
});

vi.mock('../lib/agents/actionGate', () => ({
  evaluateActionGate: vi.fn(async () => ({ decision: 'allow', reason: 'test mock' })),
  evaluateActionGateSync: vi.fn(() => ({ decision: 'allow', reason: 'test mock' })),
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

async function dispatch(
  sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>,
  conversationId: string,
  actions: unknown[],
) {
  vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: actions as never, rawResponse: '' });
  await act(async () => {
    await sendManagerMessage(conversationId, 'do it', 'haiku');
  });
}

beforeEach(() => {
  vi.mocked(runManagerTurn).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

// ── C — sanity: the manager knows the two new capabilities exist ──────

describe('parseManagerActions — reject_plan and delete_mission.discardWorktree', () => {
  it('parses reject_plan', () => {
    const text = '<lazy_actions>\n[{"type": "reject_plan", "planId": "orch-1"}]\n</lazy_actions>';
    expect(parseManagerActions(text)).toEqual([{ type: 'reject_plan', planId: 'orch-1' }]);
  });

  it('parses delete_mission with an explicit discardWorktree flag', () => {
    const text = '<lazy_actions>\n[{"type": "delete_mission", "missionId": "M1", "discardWorktree": false}]\n</lazy_actions>';
    expect(parseManagerActions(text)).toEqual([{ type: 'delete_mission', missionId: 'M1', discardWorktree: false }]);
  });
});

// ── A — repoRoot identity ──────────────────────────────────────────────

describe('Mission.repoRoot — stamped by addMission, used per-mission by the journal debounce (A)', () => {
  beforeEach(() => {
    simulateTauri();
  });
  afterEach(() => {
    clearTauriSimulation();
  });

  it('stamps repoRoot with the resolved repo path once addMission resolves it', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Explicit target',
        repo: 'C:/other-project',
        worktree: '',
        modelLabel: 'sonnet',
        mode: 'agent',
        orchestrator: false,
      });
    });

    const mission = result.current.missions[result.current.missions.length - 1];
    expect(mission.repoRoot).toBe('C:/other-project');
  });

  it('debounce-save journals each mission with ITS OWN repoRoot-derived projectId, never a single hoisted active-project id', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Project A mission',
        repo: 'C:/proj-a',
        worktree: '',
        modelLabel: 'sonnet',
        mode: 'agent',
        orchestrator: false,
      });
    });
    await act(async () => {
      await result.current.addMission({
        title: 'Project B mission',
        repo: 'C:/proj-b',
        worktree: '',
        modelLabel: 'sonnet',
        mode: 'agent',
        orchestrator: false,
      });
    });

    mockInvoke.mockClear();

    // Wire shape (serializeEvent, journal.ts) is snake_case — project_id/
    // mission_id — never the camelCase JournalEventInput fields.
    type WireEvent = { type: string; project_id: string; mission_id?: string | null };
    const readUpdatedProjectIds = () => {
      const batchCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'journal_emit_batch');
      const singleCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'journal_emit');
      const allEvents: WireEvent[] = [
        ...batchCalls.flatMap(([, args]) => (args as { events: WireEvent[] }).events),
        ...singleCalls.map(([, args]) => (args as { event: WireEvent }).event),
      ];
      return allEvents.filter((e) => e.type === 'mission.updated').map((e) => e.project_id);
    };

    // Real (not fake) timers on purpose — this component mounts many other
    // internal timers (boot sweeps, polling) that fake-timer advancement
    // would also perturb. Poll for the terminal condition (both missions'
    // mission.updated events landed) instead of racing a fixed 1600ms sleep
    // against the 800ms save-debounce + the journal's own 500ms buffered-
    // flush window — that only left ~300ms of margin, tight enough to flake
    // under heavy parallel test-suite CPU contention (real timers slip
    // under load).
    //
    // Both missions' mission.updated events carry THEIR OWN project id
    // (near-identity of their own repo root, see projectId.ts), never a
    // single project id shared by both.
    await waitFor(() => {
      expect(readUpdatedProjectIds()).toEqual(expect.arrayContaining(['c:/proj-a', 'c:/proj-b']));
    }, { timeout: 8000 });
  }, 10000);

  it('BULLETPROOF CREATION fix (2026-08-04, "Lancée x2 mais aucune mission" incident): repoRoot is present on the mission from its very first appearance in state — never a second post-hoc patch step that could be skipped', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    let missionId = '';
    await act(async () => {
      missionId = await result.current.addMission({
        title: 'Atomic creation check',
        repo: 'C:/atomic-proj',
        worktree: '',
        modelLabel: 'sonnet',
        mode: 'agent',
        orchestrator: false,
      });
    });

    // Read state the INSTANT addMission's own Promise resolved — no extra
    // render/effect cycle awaited beyond that. repoRoot must already be
    // correct here: it is set directly in the mission's own object literal
    // at construction time now, never via a separate updateMissionRef.current(...)
    // call after the fact (the removed code path this test guards against
    // regressing).
    const mission = result.current.missions.find((m) => m.id === missionId);
    expect(mission).toBeDefined();
    expect(mission?.repoRoot).toBe('C:/atomic-proj');
  });
});

// ── B — journal-first tombstone for an orphan mission ──────────────────

describe('delete_mission / archive_mission — journal-first tombstone for a mission absent from the live store (B)', () => {
  beforeEach(() => {
    simulateTauri();
  });
  afterEach(() => {
    clearTauriSimulation();
  });

  function installOrphanRow(missionId: string, extra: Record<string, unknown> = {}) {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'journal_missions_current') {
        return [
          {
            mission_id: missionId,
            project_id: 'proj-orphan',
            status: 'done',
            data: JSON.stringify({
              id: missionId,
              title: 'Orphan mission',
              status: 'done',
              model: 'sonnet',
              merged: true, // skip worktree discard — covered separately below
              ...extra,
            }),
            updated_ms: Date.now() - 10 * 60_000, // 10 min old — past ZOMBIE_MIN_AGE_MS (5 min)
          },
        ];
      }
      return undefined;
    });
  }

  it('delete_mission succeeds honestly (never "introuvable") for a mission the live store never loaded, and tombstones the journal with the row\'s own project id', async () => {
    installOrphanRow('M-orphan-1');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'delete_mission', missionId: 'M-orphan-1' },
    ]);

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    // The failure path (missionNotFound) throws BEFORE any assistant
    // message with a real result is appended by the try/catch in
    // sendManagerMessage — an "actionFailed" message would be the tell.
    expect(lastMsg?.content ?? '').not.toMatch(/introuvable|not found/i);

    const emitCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'journal_emit');
    const tombstoneCall = emitCalls.find(([, args]) => {
      const event = (args as { event: { type: string; mission_id?: string; project_id: string; payload: string } }).event;
      return event.type === 'mission.updated' && event.mission_id === 'M-orphan-1';
    });
    expect(tombstoneCall).toBeDefined();
    const event = (tombstoneCall![1] as { event: { project_id: string; payload: string } }).event;
    expect(event.project_id).toBe('proj-orphan');
    const payload = JSON.parse(event.payload) as { mission: { archived: boolean } };
    expect(payload.mission.archived).toBe(true);
  });

  it('archive_mission succeeds honestly for a terminal orphan mission and tombstones it', async () => {
    installOrphanRow('M-orphan-2', { status: 'failed' });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'archive_mission', missionId: 'M-orphan-2' },
    ]);

    const emitCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'journal_emit');
    const tombstoneCall = emitCalls.find(([, args]) => {
      const event = (args as { event: { mission_id?: string } }).event;
      return event.mission_id === 'M-orphan-2';
    });
    expect(tombstoneCall).toBeDefined();
  });

  // ── BUG 3 fix (dogfood 2026-08-05, real M21 fixture stuck in review) ──
  // The manager used to dead-end trying to delete/archive an explicitly
  // named mission sitting in 'review' status — it reasoned it first had to
  // "abandon the merge decision" (no such action exists) and never emitted
  // anything. delete_mission's executor already fell through to the old
  // "non-terminal" destructive path for 'review' (no fix needed there,
  // covered here as a regression guard); archive_mission's executor used to
  // hard-block any non-terminal status via archiveNotTerminal — fixed to
  // also accept 'review' directly, implicitly abandoning the pending merge
  // decision, then following the same tombstone path as a terminal mission.
  it('delete_mission on a LIVE review-status mission succeeds directly — no dead end, tombstones archived:true', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({
        title: 'Review mission', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'review' } });
    });
    mockInvoke.mockClear();

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'delete_mission', missionId },
    ]);
    // deleteMission's own tombstone tail is async (resolveProjectRoot
    // .then(...), same as the STOP-ON-DELETE tests below) — flush it.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Real effect: the mission is actually gone — never stuck reasoning
    // about "abandoning the merge decision" first, no error surfaced.
    expect(result.current.missions.find((m) => m.id === missionId)).toBeUndefined();
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg?.content ?? '').not.toMatch(/introuvable|not found/i);

    const tombstoneCall = mockInvoke.mock.calls.find(([cmd, args]) => {
      if (cmd !== 'journal_emit') return false;
      const event = (args as { event: { type: string; mission_id?: string } }).event;
      return event.type === 'mission.updated' && event.mission_id === missionId;
    });
    expect(tombstoneCall).toBeDefined();
    const event = (tombstoneCall![1] as { event: { payload: string } }).event;
    const payload = JSON.parse(event.payload) as { mission: { archived: boolean } };
    expect(payload.mission.archived).toBe(true);
  });

  it('archive_mission on a LIVE review-status mission succeeds directly (BUG 3 fix — used to hard-block with archiveNotTerminal)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({
        title: 'Review mission 2', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'review' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'archive_mission', missionId },
    ]);

    // Real effect: archived, still present (archive is non-destructive,
    // unlike delete) — never the archiveNotTerminal error this used to hit.
    const mission = result.current.missions.find((m) => m.id === missionId);
    expect(mission?.archived).toBe(true);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg?.content ?? '').not.toMatch(/introuvable|not found|non[- ]terminal/i);
  });

  it('delete_mission still throws an honest "introuvable" when the mission exists NOWHERE (not live, not journaled)', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'journal_missions_current') return [];
      return undefined;
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'delete_mission', missionId: 'M-ghost' },
    ]);

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg?.content ?? '').toMatch(/introuvable|not found/i);
  });
});

// ── STOP-ON-DELETE (2026-08-05, real prod incident M25) ────────────────
//
// delete_mission/clear_canvas on a RUNNING mission used to only tombstone
// the journal row and drop it from React state — the underlying runtime
// (managed loop / native process) kept running untouched, kept spending,
// and its own progress writes kept landing on the journal with no
// `archived` flag, silently overwriting the tombstone the instant they
// arrived. deleteMission now stops the runtime for real (same stopFlag +
// killAgentRun primitive as stopMission) BEFORE tombstoning.

describe('deleteMission — STOP-ON-DELETE (real runtime stop before tombstone)', () => {
  beforeEach(() => {
    simulateTauri();
  });
  afterEach(() => {
    clearTauriSimulation();
  });

  it('deleting a RUNNING mission calls the real stop primitive (killAgentRun) and still tombstones the journal', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Live mission', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'running', worktree: 'agent/live-branch' } });
    });

    mockInvoke.mockClear();
    act(() => {
      result.current.deleteMission(missionId);
    });
    // deleteMission's own tombstone/kill tail is async (resolveProjectRoot
    // .then(...)) — flush it.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The mission is gone from live state immediately (optimistic removal,
    // unchanged from before this fix).
    expect(result.current.missions.find((m) => m.id === missionId)).toBeUndefined();

    // The real runtime-stop primitive fired — same invoke stopMission's own
    // kill-before-cleanup path uses.
    const killCall = mockInvoke.mock.calls.find(([cmd, args]) =>
      cmd === 'agent_run_kill' && (args as { id?: string } | undefined)?.id === missionId,
    );
    expect(killCall).toBeDefined();

    // The tombstone still lands, archived: true, same as before this fix.
    const tombstoneCall = mockInvoke.mock.calls.find(([cmd, args]) => {
      if (cmd !== 'journal_emit') return false;
      const event = (args as { event: { type: string; mission_id?: string } }).event;
      return event.type === 'mission.updated' && event.mission_id === missionId;
    });
    expect(tombstoneCall).toBeDefined();
    const event = (tombstoneCall![1] as { event: { payload: string } }).event;
    const payload = JSON.parse(event.payload) as { mission: { archived: boolean } };
    expect(payload.mission.archived).toBe(true);
  });

  it('deleting a mission in review (no live runtime) never calls killAgentRun', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Review mission', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'review', worktree: 'agent/review-branch' } });
    });

    mockInvoke.mockClear();
    act(() => {
      result.current.deleteMission(missionId);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const killCall = mockInvoke.mock.calls.find(([cmd, args]) =>
      cmd === 'agent_run_kill' && (args as { id?: string } | undefined)?.id === missionId,
    );
    expect(killCall).toBeUndefined();
  });
});

// ── C — drift-tolerant worktree discard ─────────────────────────────────
//
// agent_discard_worktree (Rust) is IDEMPOTENT — it resolves successfully
// even when the target directory does not exist. Every case below injects
// `exists` explicitly (never left to the real default, which would hit a
// real filesystem) so `discardFn`'s own resolve/reject alone can never be
// mistaken for proof a worktree was actually there.

describe('resolveMissionWorktreeCandidates — drift-tolerant worktree discard (C)', () => {
  it('discards at the primary root when it EXISTS there', async () => {
    const discardFn = vi.fn().mockResolvedValue(undefined);
    const exists = vi.fn().mockResolvedValue(true);
    const outcome = await resolveMissionWorktreeCandidates('agent/M1', 'C:/proj-a', ['C:/proj-b'], {
      discardFn,
      exists,
      tauriCheck: () => true,
    });
    expect(outcome).toEqual({ outcome: 'discarded', root: 'C:/proj-a' });
    expect(discardFn).toHaveBeenCalledTimes(1);
    expect(exists).toHaveBeenCalledTimes(1);
  });

  it('IDEMPOTENCE fix (real prod incident M5-M8): the primary root has NO directory — never calls discard there, falls through to the second open project where it actually exists', async () => {
    const discardFn = vi.fn().mockResolvedValue(undefined); // would "succeed" on ANY path — idempotent by design
    const exists = vi.fn(async (path: string) => path.startsWith('C:/proj-b'));
    const outcome = await resolveMissionWorktreeCandidates('agent/M2', 'C:/proj-a', ['C:/proj-b'], {
      discardFn,
      exists,
      tauriCheck: () => true,
    });
    expect(outcome).toEqual({ outcome: 'discarded', root: 'C:/proj-b' });
    // discardFn must NEVER have been called for the (non-existent) proj-a
    // candidate — only once, for proj-b.
    expect(discardFn).toHaveBeenCalledTimes(1);
    expect(discardFn).toHaveBeenCalledWith('C:/proj-b', expect.stringContaining('proj-b'), 'agent/M2');
    expect(exists).toHaveBeenCalledTimes(2);
  });

  it('reports an honest "introuvable" (not_found) when NO open project has the directory — never a false discard', async () => {
    const discardFn = vi.fn().mockResolvedValue(undefined); // idempotent — would lie if ever called and trusted
    const exists = vi.fn().mockResolvedValue(false);
    const outcome = await resolveMissionWorktreeCandidates('agent/M3', 'C:/proj-a', ['C:/proj-b', 'C:/proj-c'], {
      discardFn,
      exists,
      tauriCheck: () => true,
    });
    expect(outcome).toEqual({ outcome: 'not_found', checked: 3 });
    expect(discardFn).not.toHaveBeenCalled();
  });

  it('reports a real discard error distinctly from not_found (directory existed, the discard itself failed)', async () => {
    const discardFn = vi.fn().mockRejectedValue(new Error('permission denied'));
    const exists = vi.fn().mockResolvedValue(true);
    const outcome = await resolveMissionWorktreeCandidates('agent/M4', 'C:/proj-a', [], {
      discardFn,
      exists,
      tauriCheck: () => true,
    });
    expect(outcome).toEqual({ outcome: 'error', reason: 'permission denied' });
  });

  it('skips entirely when the mission has no worktree/branch — never probes existence at all', async () => {
    const discardFn = vi.fn();
    const exists = vi.fn();
    const outcome = await resolveMissionWorktreeCandidates(undefined, 'C:/proj-a', [], {
      discardFn,
      exists,
      tauriCheck: () => true,
    });
    expect(outcome).toEqual({ outcome: 'skipped' });
    expect(discardFn).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });

  it('skips entirely outside a real Tauri runtime', async () => {
    const discardFn = vi.fn();
    const exists = vi.fn();
    const outcome = await resolveMissionWorktreeCandidates('agent/M5', 'C:/proj-a', [], {
      discardFn,
      exists,
      tauriCheck: () => false,
    });
    expect(outcome).toEqual({ outcome: 'skipped' });
    expect(discardFn).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });

  it('dedupes candidate roots (primary also present in otherRoots) — never probes/attempts the same path twice', async () => {
    const discardFn = vi.fn().mockResolvedValue(undefined);
    const exists = vi.fn().mockResolvedValue(true);
    await resolveMissionWorktreeCandidates('agent/M6', 'C:/proj-a', ['C:/proj-a', 'C:/proj-b'], {
      discardFn,
      exists,
      tauriCheck: () => true,
    });
    expect(discardFn).toHaveBeenCalledTimes(1);
    expect(exists).toHaveBeenCalledTimes(1);
  });

  it('a failed existence probe is treated as "not there" for that candidate, never a crash', async () => {
    const discardFn = vi.fn().mockResolvedValue(undefined);
    const exists = vi.fn()
      .mockRejectedValueOnce(new Error('access denied'))
      .mockResolvedValueOnce(true);
    const outcome = await resolveMissionWorktreeCandidates('agent/M7', 'C:/proj-a', ['C:/proj-b'], {
      discardFn,
      exists,
      tauriCheck: () => true,
    });
    expect(outcome).toEqual({ outcome: 'discarded', root: 'C:/proj-b' });
  });
});

// ── B (boot fix) — cross-project zombie sweep ───────────────────────────

describe('Cross-project zombie sweep at boot (2026-08-04, mission M9 stuck "running 26%" forever)', () => {
  beforeEach(() => {
    simulateTauri();
    // The one-shot guard is MODULE-level by design (sweepRanThisBoot's own
    // doc comment — must survive a provider remount) — reset it per test so
    // unrelated test cases in this suite don't inherit "already ran" state
    // from one another.
    _resetZombieSweepGuardForTests();
  });
  afterEach(() => {
    clearTauriSimulation();
  });

  it('re-stamps a running mission as failed whenever it is absent from state.missions — REGARDLESS of project_id (correction: the active project is NOT exempt, applyReplayRecovery does not cover every case)', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'journal_missions_current') {
        return [
          {
            mission_id: 'M9',
            project_id: 'proj-foreign',
            status: 'running',
            data: JSON.stringify({ id: 'M9', title: 'Zombie mission', status: 'running', model: 'sonnet', progress: 26 }),
            updated_ms: Date.now() - 10 * 60_000, // 10 min old — past ZOMBIE_MIN_AGE_MS (5 min)
          },
          // Active-project row (project_id '.', matching this test's
          // resolveProjectRoot dot-fallback) — ALSO absent from
          // state.missions (applyReplayRecovery only covers what
          // loadMissionsFromJournal actually returned into its own list;
          // this row is a real gap, e.g. evicted/never loaded this
          // session) — must be swept exactly like the foreign one.
          {
            mission_id: 'M-active-proj',
            project_id: '.',
            status: 'running',
            data: JSON.stringify({ id: 'M-active-proj', title: 'Active project mission', status: 'running', model: 'sonnet' }),
            updated_ms: Date.now() - 10 * 60_000, // 10 min old — past ZOMBIE_MIN_AGE_MS (5 min)
          },
        ];
      }
      return undefined;
    });

    renderHook(() => useAgentsStore(), { wrapper });

    type WireEvent = { type: string; mission_id?: string; project_id: string; payload: string };
    const findEmit = (id: string) => {
      const emitCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'journal_emit');
      return emitCalls.find(([, args]) => (args as { event: WireEvent }).event.mission_id === id);
    };
    // Poll for both sweep-emitted events instead of racing a fixed 100ms
    // sleep against the mount-time sweepTick()'s own async chain
    // (resolveProjectRoot + journal fetch) — same flake shape as this
    // file's debounce-save test above.
    await waitFor(() => {
      expect(findEmit('M9')).toBeDefined();
      expect(findEmit('M-active-proj')).toBeDefined();
    });

    for (const [id, expectedProjectId, expectedProgress] of [
      ['M9', 'proj-foreign', 26],
      ['M-active-proj', '.', undefined],
    ] as const) {
      const call = findEmit(id);
      expect(call).toBeDefined();
      const event = (call![1] as { event: WireEvent }).event;
      expect(event.project_id).toBe(expectedProjectId);
      const payload = JSON.parse(event.payload) as { mission: { status: string; statusReason?: string; progress?: number } };
      expect(payload.mission.status).toBe('failed');
      expect(payload.mission.statusReason).toBeTruthy();
      if (expectedProgress !== undefined) expect(payload.mission.progress).toBe(expectedProgress);
    }
  });

  it('tombstones (archived: true) a malformed row instead of re-stamping it failed — real rows M3-testeur/M4-testeur, QA-script debris whose data never carried a real Mission snapshot', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'journal_missions_current') {
        return [
          {
            mission_id: 'M3-testeur',
            project_id: 'proj-foreign',
            status: 'running',
            // The real malformed shape: only a stray `missionId` key (not
            // even the right field name — a real Mission uses `id`), no
            // `title`/`status`/`model` at all.
            data: JSON.stringify({ missionId: 'M3-testeur' }),
            updated_ms: Date.now() - 10 * 60_000, // 10 min old — past ZOMBIE_MIN_AGE_MS (5 min)
          },
          {
            mission_id: 'M4-testeur',
            project_id: 'proj-foreign',
            status: 'queued',
            data: JSON.stringify({ missionId: 'M4-testeur' }),
            updated_ms: Date.now() - 10 * 60_000, // 10 min old — past ZOMBIE_MIN_AGE_MS (5 min)
          },
          // Control: a REAL mission (has a title) in the same batch must
          // still go through the ordinary re-stamp-as-failed path, never
          // tombstoned — this fix must stay narrow to genuinely titleless
          // rows.
          {
            mission_id: 'M9',
            project_id: 'proj-foreign',
            status: 'running',
            data: JSON.stringify({ id: 'M9', title: 'Zombie mission', status: 'running', model: 'sonnet' }),
            updated_ms: Date.now() - 10 * 60_000, // 10 min old — past ZOMBIE_MIN_AGE_MS (5 min)
          },
        ];
      }
      return undefined;
    });

    renderHook(() => useAgentsStore(), { wrapper });

    type WireEvent = { type: string; mission_id?: string; project_id: string; payload: string };
    const findEmit = (id: string) => {
      const emitCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'journal_emit');
      return emitCalls.find(([, args]) => (args as { event: WireEvent }).event.mission_id === id);
    };
    // Poll for all three sweep-emitted events — see the earlier test in
    // this describe block for why a fixed sleep here would race the
    // mount-time sweepTick()'s async chain.
    await waitFor(() => {
      expect(findEmit('M3-testeur')).toBeDefined();
      expect(findEmit('M4-testeur')).toBeDefined();
      expect(findEmit('M9')).toBeDefined();
    });

    for (const id of ['M3-testeur', 'M4-testeur']) {
      const call = findEmit(id);
      expect(call).toBeDefined();
      const event = (call![1] as { event: WireEvent }).event;
      const payload = JSON.parse(event.payload) as { mission: { archived?: boolean; status?: string } };
      expect(payload.mission.archived).toBe(true);
      // Never ALSO re-stamped failed — tombstone is the only outcome for a
      // titleless row.
      expect(payload.mission.status).not.toBe('failed');
    }

    const m9Call = findEmit('M9');
    expect(m9Call).toBeDefined();
    const m9Payload = JSON.parse((m9Call![1] as { event: WireEvent }).event.payload) as {
      mission: { archived?: boolean; status: string };
    };
    expect(m9Payload.mission.status).toBe('failed');
    expect(m9Payload.mission.archived).toBeUndefined();
  });

  it('AGE FLOOR fix (real prod incident 2026-08-05, M18/M19 re-stamped failed at progress 0 ~1min after launch): a FRESH running row (<5min old) absent from state.missions is NEVER touched', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'journal_missions_current') {
        return [
          {
            mission_id: 'M18',
            project_id: 'proj-foreign',
            status: 'queued',
            data: JSON.stringify({ id: 'M18', title: 'Just launched', status: 'queued', model: 'sonnet' }),
            updated_ms: Date.now() - 60_000, // 1 minute old — well under the 5min floor
          },
          {
            mission_id: 'M19',
            project_id: 'proj-foreign',
            status: 'running',
            data: JSON.stringify({ id: 'M19', title: 'Just launched too', status: 'running', model: 'sonnet' }),
            updated_ms: Date.now() - 30_000, // 30 seconds old
          },
        ];
      }
      return undefined;
    });

    renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    const emitCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'journal_emit');
    type WireEvent = { mission_id?: string };
    for (const id of ['M18', 'M19']) {
      expect(emitCalls.find(([, args]) => (args as { event: WireEvent }).event.mission_id === id)).toBeUndefined();
    }
  });

  it('MODULE-level guard fix (real prod incident 2026-08-05, ErrorBoundary crash/retry remount replayed the sweep): a second sweep effect run (simulated provider remount) is a no-op, even for a genuinely old zombie row', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'journal_missions_current') {
        return [
          {
            mission_id: 'M-remount-zombie',
            project_id: 'proj-foreign',
            status: 'running',
            data: JSON.stringify({ id: 'M-remount-zombie', title: 'Old zombie', status: 'running', model: 'sonnet' }),
            updated_ms: Date.now() - 10 * 60_000,
          },
        ];
      }
      return undefined;
    });

    // First mount: the sweep runs for real and consumes the module-level
    // guard (sweepRanThisBoot) — deliberately NOT reset here (unlike this
    // describe block's own beforeEach) to simulate a remount within the
    // SAME boot.
    const first = renderHook(() => useAgentsStore(), { wrapper });
    // Poll for the sweep to have emitted at all — a fixed sleep here would
    // race the mount-time sweepTick()'s async chain (see the earlier tests
    // in this describe block).
    await waitFor(() => {
      const emitCallsAfterFirst = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'journal_emit').length;
      expect(emitCallsAfterFirst).toBeGreaterThan(0); // sanity: the first mount really did sweep it
    });

    first.unmount();
    mockInvoke.mockClear();

    // Second mount (simulated ErrorBoundary crash/retry remount) — the
    // module-level guard must make this a complete no-op: zero new
    // journal_emit calls, even though the same old zombie row is still
    // sitting there in the mock.
    renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    const emitCallsAfterRemount = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'journal_emit');
    expect(emitCallsAfterRemount).toHaveLength(0);
  });
});
