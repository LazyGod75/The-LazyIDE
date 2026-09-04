/**
 * agentsStore.zombieRestamp.test.tsx — THE SYSTEMIC BUG fix (2026-08-06):
 * journal rows stuck at status 'running'/'queued' with NO live run behind
 * them ("zombies") used to accumulate forever after an app reload/restart.
 *
 * The pre-existing cross-project sweep (missionJournalTombstone.test.tsx's
 * own "Cross-project zombie sweep at boot" describe block) runs exactly
 * ONCE per app boot (sweepRanThisBoot) — a row younger than ZOMBIE_MIN_AGE_MS
 * at that SINGLE instant is correctly skipped (the M18/M19 anti-regression)
 * but is NEVER re-evaluated again for the rest of the session. This suite
 * covers the NEW periodic re-stamp effect that closes that gap, gated on
 * the live `stopFlags` registry (never mere absence from state.missions)
 * plus a boot-grace window, and the complementary loud archive_mission
 * refusal for a still-active mission.
 *
 * PRIMING PATTERN used by every sweep-effect test below: a throwaway first
 * mount with an EMPTY `journal_missions_current` response consumes the
 * one-shot cross-project sweep's module-level `sweepRanThisBoot` guard
 * harmlessly (nothing for it to act on) before the REAL mount (with the
 * actual zombie row under test) ever happens — this isolates each test to
 * ONLY the new periodic effect under test, regardless of what earlier
 * tests (in this file or otherwise) already did to that module-level flag.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';

const mockInvoke = vi.mocked(invoke);

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

function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}
function clearTauriSimulation(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

interface FakeJournalRow {
  mission_id: string;
  project_id: string;
  status: string;
  data: string;
  updated_ms: number;
}

// This suite's setup.ts does NOT auto-unmount @testing-library/react
// hooks between tests (confirmed: no `cleanup()` wired in src/__tests__/
// setup.ts, unlike some other RTL setups) — a renderHook left mounted
// leaks its periodic-sweep `setInterval` into every LATER test in this
// file, corrupting their timing. Every render this file creates (throwaway
// AND real) registers itself here; a global afterEach unmounts all of them
// unconditionally, regardless of what an individual test does.
const activeRenders: Array<{ unmount: () => void }> = [];
function trackedRenderHook() {
  const rendered = renderHook(() => useAgentsStore(), { wrapper });
  activeRenders.push(rendered);
  return rendered;
}

/** Throwaway-mount-then-real-mount priming — see this file's own top doc
 *  comment for why this is needed (isolates each test from the one-shot
 *  cross-project sweep's module-level one-shot guard). Caller must already
 *  have `vi.useFakeTimers()` active so `Date.now()` inside `rows` (computed
 *  by the caller BEFORE calling this) reflects the controlled fake clock. */
async function mountWithZombieRows(rows: FakeJournalRow[]) {
  mockInvoke.mockImplementation(async (cmd: string) => (cmd === 'journal_missions_current' ? [] : undefined));
  const throwaway = trackedRenderHook();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  throwaway.unmount();

  mockInvoke.mockImplementation(async (cmd: string) => (cmd === 'journal_missions_current' ? rows : undefined));
  return trackedRenderHook();
}

function journalEmitCallsFor(missionId: string) {
  type WireEvent = { mission_id?: string; payload: string };
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === 'journal_emit')
    .map(([, args]) => (args as { event: WireEvent }).event)
    .filter((event) => event.mission_id === missionId);
}

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
  vi.mocked(runManagerTurn).mockReset();
  simulateTauri();
});

afterEach(() => {
  for (const rendered of activeRenders.splice(0)) {
    rendered.unmount();
  }
  clearTauriSimulation();
  vi.useRealTimers();
});

describe('Periodic zombie re-stamp — running row, no registry entry, past the age floor', () => {
  it('re-stamps it "interrompue" (failed + recoveredOnRestart reason) once a real sweep tick fires', async () => {
    vi.useFakeTimers();
    const rows: FakeJournalRow[] = [
      {
        mission_id: 'M-periodic-1',
        project_id: 'proj-foreign',
        status: 'running',
        // 4 minutes old at mount — under the one-shot sweep's own 5-minute
        // floor (so ITS immediate, ungated check skips this row, leaving
        // only the new periodic effect to ever act on it).
        data: JSON.stringify({ id: 'M-periodic-1', title: 'Old zombie', status: 'running', model: 'sonnet' }),
        updated_ms: Date.now() - 4 * 60_000,
      },
    ];
    await mountWithZombieRows(rows);

    // 130s: past the 90s boot grace AND past the first real (post-grace)
    // interval tick at 120s. By then the row's EFFECTIVE age (4min + the
    // elapsed advance) is also past ZOMBIE_MIN_AGE_MS (5min).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130_000);
    });

    const calls = journalEmitCallsFor('M-periodic-1');
    expect(calls.length).toBeGreaterThan(0);
    const payload = JSON.parse(calls[0].payload) as { mission: { status: string; statusReason?: string } };
    expect(payload.mission.status).toBe('failed');
    expect(payload.mission.statusReason).toBeTruthy();
  });

  // NOTE: the positive "'queued' WITH startedAt gets re-stamped" case is
  // implemented (see the `if (row.status === 'queued' && !data.startedAt)
  // continue;` gate in agentsStore.tsx's periodic sweep) and was manually
  // verified via an instrumented debug run — a row shaped exactly like this
  // one (status 'queued', a real `startedAt`, old `updated_ms`, absent from
  // state.missions) correctly evaluates as age-eligible, and is left alone
  // ONLY because a pre-existing, unrelated boot-resilience mechanism in
  // this same store (the auto-retry effect, `autoRetryDispatchedRef` — see
  // its own doc comment above line 8500) legitimately claims a 'queued'
  // row shaped this way first, registering a REAL stopFlags entry before
  // this suite's own sweep tick ever runs — i.e. the registry check does
  // exactly its job. Isolating a test from that other, pre-existing
  // mechanism (mocking/neutralizing it) was out of this fix's time-box;
  // the negative case below (no startedAt) still proves the gate itself
  // exists and correctly excludes an ordinary still-waiting queued row.

  it('never touches an ORDINARY still-queued row with no startedAt (nothing dispatched yet — the scheduler may still pick it up)', async () => {
    vi.useFakeTimers();
    const rows: FakeJournalRow[] = [
      {
        mission_id: 'M-periodic-queued-plain',
        project_id: 'proj-foreign',
        status: 'queued',
        data: JSON.stringify({ id: 'M-periodic-queued-plain', title: 'Ordinary queued', status: 'queued', model: 'sonnet' }),
        updated_ms: Date.now() - 4 * 60_000,
      },
    ];
    await mountWithZombieRows(rows);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(130_000);
    });

    expect(journalEmitCallsFor('M-periodic-queued-plain')).toHaveLength(0);
  });
});

describe('Periodic zombie re-stamp — a live registry entry always wins', () => {
  it('never touches a running mission that has a real stopFlags entry (a genuine in-session launch), regardless of how stale its journal row looks', async () => {
    vi.useFakeTimers();
    const { result } = trackedRenderHook();

    await act(async () => {
      await result.current.addMission({
        title: 'Genuinely live mission',
        repo: '.',
        worktree: '',
        modelLabel: 'claude-sonnet-5',
        mode: 'agent',
        orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'running' } });
    });

    // The journal row for this SAME mission looks exactly like a zombie
    // (old updated_ms) — only the live registry (stopFlags, populated by
    // the real addMission launch above) should be why this is left alone.
    mockInvoke.mockImplementation(async (cmd: string) =>
      cmd === 'journal_missions_current'
        ? [
            {
              mission_id: missionId,
              project_id: '.',
              status: 'running',
              data: JSON.stringify({ id: missionId, title: 'Genuinely live mission', status: 'running', model: 'sonnet' }),
              updated_ms: Date.now() - 20 * 60_000,
            },
          ]
        : undefined,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(130_000);
    });

    expect(journalEmitCallsFor(missionId).some((event) => {
      const payload = JSON.parse(event.payload) as { mission?: { status?: string } };
      return payload.mission?.status === 'failed';
    })).toBe(false);
    expect(result.current.missions.find((m) => m.id === missionId)?.status).toBe('running');
    expect(result.current.missions.find((m) => m.id === missionId)?.statusReason).toBeFalsy();
  });
});

describe('Periodic zombie re-stamp — age floor', () => {
  it('never touches a row still younger than ZOMBIE_MIN_AGE_MS, even after the boot grace and an interval tick have both passed', async () => {
    vi.useFakeTimers();
    const rows: FakeJournalRow[] = [
      {
        mission_id: 'M-periodic-fresh',
        project_id: 'proj-foreign',
        status: 'running',
        // 1 minute old at mount; +130s of advance below = ~3.2min
        // effective age — comfortably still under the 5min floor.
        data: JSON.stringify({ id: 'M-periodic-fresh', title: 'Fresh mission', status: 'running', model: 'sonnet' }),
        updated_ms: Date.now() - 60_000,
      },
    ];
    await mountWithZombieRows(rows);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(130_000);
    });

    expect(journalEmitCallsFor('M-periodic-fresh')).toHaveLength(0);
  });
});

describe('Periodic zombie re-stamp — boot grace', () => {
  it('never touches an otherwise-eligible zombie row while still within the 90s boot grace', async () => {
    vi.useFakeTimers();
    const rows: FakeJournalRow[] = [
      {
        mission_id: 'M-periodic-grace',
        project_id: 'proj-foreign',
        status: 'running',
        // Already 10 minutes old at mount — an otherwise-obvious zombie —
        // isolating this test to ONLY the boot-grace criterion.
        data: JSON.stringify({ id: 'M-periodic-grace', title: 'Old but within grace', status: 'running', model: 'sonnet' }),
        updated_ms: Date.now() - 10 * 60_000,
      },
    ];
    await mountWithZombieRows(rows);

    // 60s: one full interval tick, but still short of the 90s boot grace.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(journalEmitCallsFor('M-periodic-grace')).toHaveLength(0);
  });
});

describe('archive_mission — loud refusal for a still-active mission (THE SYSTEMIC BUG fix)', () => {
  async function dispatch(
    sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>,
    conversationId: string,
    actions: unknown[],
  ) {
    vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: actions as never, rawResponse: '' });
    await act(async () => {
      await sendManagerMessage(conversationId, 'archive it', 'haiku');
    });
  }

  const LOUD_MESSAGE = 'Mission encore active — archivage refusé. Utilise la suppression pour retirer une mission en cours.';

  it('refuses a LIVE running mission with the loud, actionable message instead of a generic "not terminal"', async () => {
    mockInvoke.mockResolvedValue(undefined);
    const { result } = trackedRenderHook();

    await act(async () => {
      await result.current.addMission({
        title: 'Active mission', repo: '.', worktree: '', modelLabel: 'claude-sonnet-5', mode: 'agent', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'running' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'archive_mission', missionId },
    ]);

    expect(result.current.missions.find((m) => m.id === missionId)?.archived).toBeFalsy();
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg?.content).toContain(LOUD_MESSAGE);
  });

  it('refuses a QUEUED orphan mission (absent from state.missions, found via the journal) with the SAME loud message — never the misleading "introuvable"', async () => {
    mockInvoke.mockImplementation(async (cmd: string) =>
      cmd === 'journal_missions_current'
        ? [
            {
              mission_id: 'M-orphan-active',
              project_id: '.',
              status: 'queued',
              data: JSON.stringify({ id: 'M-orphan-active', title: 'Orphan but active', status: 'queued', model: 'sonnet' }),
              updated_ms: Date.now(),
            },
          ]
        : undefined,
    );
    const { result } = trackedRenderHook();

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'archive_mission', missionId: 'M-orphan-active' },
    ]);

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg?.content).toContain(LOUD_MESSAGE);
    expect(lastMsg?.content ?? '').not.toMatch(/introuvable|not found/i);
  });
});
