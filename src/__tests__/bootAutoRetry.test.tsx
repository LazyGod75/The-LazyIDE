/**
 * bootAutoRetry.test.tsx — boot-resilience auto-retry (product requirement:
 * "agents must succeed, the app recovers on its own"). A mission the boot
 * recovery pass flips to 'failed' with `agents.recoveredOnRestart` never
 * progresses again by itself (see agentsStore.tsx's applyReplayRecovery doc
 * comment) — the agent process that was driving it is gone, and nothing
 * restarts it automatically. When such a mission's own contract explicitly
 * opted OUT of human approval (`contract.gates.humanApprove === false`),
 * the boot-resilience effect (agentsStore.tsx, declared right after
 * retryMission itself) SCHEDULES exactly ONE automatic `retryMission` call
 * for it, fired only after `AUTO_RETRY_GRACE_PERIOD_MS` (60s) has elapsed —
 * real incident, 2026-08-04: the human/manager must keep a real window to
 * delete a mission they do NOT want relaunched before it silently comes
 * back on its own. The `autoRetriedAfterRestart` stamp still guarantees the
 * retry can never fire twice for the same mission, including across
 * further app restarts, since it is a real, persisted Mission field.
 *
 * Same journal-stub harness as queueStaleness.test.ts, plus fake timers
 * (shouldAdvanceTime: true — timers behave normally in real time AND can be
 * jumped forward instantly via advanceTimersByTimeAsync) to exercise the
 * grace period without a real 60s wait.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore, AUTO_RETRY_GRACE_PERIOD_MS } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { en } from '../i18n/locales/en';
import type { Mission, MissionContract } from '../lib/agents/types';

vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
  emitBuffered: vi.fn(),
}));

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

const { mockMissionsLoad } = vi.hoisted(() => ({ mockMissionsLoad: vi.fn() }));

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    getPlatform: () => {
      const real = actual.getPlatform();
      return {
        ...real,
        missions: { ...real.missions, load: mockMissionsLoad, save: vi.fn().mockResolvedValue(undefined) },
      };
    },
  };
});

const mockedInvoke = vi.mocked(invoke);

function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) {
    w['__TAURI_INTERNALS__'] = {};
  } else {
    delete w['__TAURI_INTERNALS__'];
  }
}

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(
    I18nProvider,
    null,
    React.createElement(ToastProvider, null, React.createElement(AgentsStoreProvider, null, children)),
  );
}

function missionRow(mission: Mission) {
  return {
    mission_id: mission.id,
    project_id: 'proj-1',
    status: mission.status,
    data: JSON.stringify(mission),
    updated_ms: Date.now(),
  };
}

function stubJournalRows(rows: ReturnType<typeof missionRow>[]): void {
  mockedInvoke.mockImplementation((cmd: unknown) => {
    if (cmd === 'journal_missions_current') return Promise.resolve(rows);
    return Promise.resolve(undefined);
  });
}

/** A minimal, valid MissionContract whose gates opt OUT of human approval —
 *  the one condition the boot-resilience effect requires before it will
 *  ever SCHEDULE an auto-retry for a restart-interrupted mission. */
function unattendedContract(overrides?: Partial<MissionContract>): MissionContract {
  return {
    objective: 'test',
    model: 'Sonnet 4.6',
    permissionMode: 'acceptEdits',
    budgetCapUsd: 5,
    proofs: [],
    gates: { evaluators: true, humanApprove: false },
    shareToTeam: false,
    ...overrides,
  };
}

async function advanceThroughGracePeriod(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AUTO_RETRY_GRACE_PERIOD_MS);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockedInvoke.mockResolvedValue(undefined);
  mockMissionsLoad.mockResolvedValue(null);
  setTauriRuntime(true);
  // shouldAdvanceTime: real time and the fake clock stay bridged, so
  // waitFor's own internal polling keeps working; AUTO_RETRY_GRACE_PERIOD_MS
  // (60s) is still jumped forward instantly via advanceTimersByTimeAsync
  // rather than actually waited out.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  setTauriRuntime(false);
});

describe('agentsStore boot — auto-retry restart-interrupted missions (unattended contracts, 60s grace period)', () => {
  it('does NOT retry immediately — the original stays alone until the grace period elapses', async () => {
    const interrupted: Mission = {
      id: 'M50',
      title: 'Unattended task',
      status: 'running',
      model: 'Sonnet 4.6',
      createdAt: Date.now(),
      contract: unattendedContract(),
    };
    stubJournalRows([missionRow(interrupted)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      const m = result.current.missions.find((mm) => mm.id === 'M50');
      expect(m?.status).toBe('failed');
    });

    // Grace period still pending — no retry clone yet, no stamp yet.
    expect(result.current.missions).toHaveLength(1);
    expect(result.current.missions[0].autoRetriedAfterRestart).toBeFalsy();
  });

  it('auto-retries once the 60s grace period elapses', async () => {
    const interrupted: Mission = {
      id: 'M50',
      title: 'Unattended task',
      status: 'running',
      model: 'Sonnet 4.6',
      createdAt: Date.now(),
      contract: unattendedContract(),
    };
    stubJournalRows([missionRow(interrupted)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.find((m) => m.id === 'M50')?.status).toBe('failed');
    });

    await advanceThroughGracePeriod();

    await waitFor(() => {
      expect(result.current.missions).toHaveLength(2);
    });

    const original = result.current.missions.find((m) => m.id === 'M50')!;
    expect(original.status).toBe('failed');
    expect(original.autoRetriedAfterRestart).toBe(true);
    expect(original.actionTimeline?.some((e) => e.text === en['agents.autoRetriedAfterRestart'])).toBe(true);

    const clone = result.current.missions.find((m) => m.id !== 'M50')!;
    expect(clone.status).toBe('queued');
    // T1.7 fields-reset fix (retryMission) applies here too — a brand-new
    // clone must be eligible for its OWN future one-shot auto-retry.
    expect(clone.autoRetriedAfterRestart).toBeFalsy();
    // Lineage depth cap (2026-08-05 fix, Mission.autoRetryLineageDepth) —
    // this clone is depth 1 (source M50 was depth 0/absent), never
    // inherited verbatim from a plain `{...original}` spread.
    expect(clone.autoRetryLineageDepth).toBe(1);
  });

  it('never auto-retries a mission that is ALREADY an auto-retry clone (autoRetryLineageDepth >= 1) — the real M9->M13 incident: one automatic relaunch per lineage, full stop', async () => {
    const cloneInterruptedAgain: Mission = {
      id: 'M55',
      title: 'Second-generation clone, interrupted in turn',
      status: 'running',
      model: 'Sonnet 4.6',
      createdAt: Date.now(),
      contract: unattendedContract(),
      // Simulates a mission produced by an EARLIER auto-retry (retryMission
      // called with isAutoRetry: true, per the test above): its own
      // autoRetriedAfterRestart was reset to undefined on creation — T1.7,
      // same as any other clone — but its lineage depth carries forward.
      // This is exactly the gap that produced the real incident: depth is
      // the only field below that still tells this mission apart from a
      // genuinely first-time one.
      autoRetryLineageDepth: 1,
    };
    stubJournalRows([missionRow(cloneInterruptedAgain)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.find((m) => m.id === 'M55')?.status).toBe('failed');
    });

    await advanceThroughGracePeriod();

    // Still exactly one mission — no auto-retry clone, even though
    // autoRetriedAfterRestart alone reads falsy on this mission (the exact
    // condition that used to let the chain continue: M9 -> M10 -> M11 ->
    // M12 -> M13, 5 clones in one night).
    expect(result.current.missions).toHaveLength(1);
    const original = result.current.missions.find((m) => m.id === 'M55')!;
    expect(original.autoRetriedAfterRestart).toBeFalsy();
  });

  it('cancels the scheduled retry when the mission is deleted during the grace period — never relaunches a mission the human removed', async () => {
    const interrupted: Mission = {
      id: 'M54',
      title: 'To be deleted before it comes back',
      status: 'running',
      model: 'Sonnet 4.6',
      createdAt: Date.now(),
      contract: unattendedContract(),
    };
    stubJournalRows([missionRow(interrupted)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.find((m) => m.id === 'M54')?.status).toBe('failed');
    });

    act(() => {
      result.current.deleteMission('M54');
    });
    expect(result.current.missions).toHaveLength(0);

    await advanceThroughGracePeriod();

    // Still nothing — the scheduled retryMission call never fired.
    expect(result.current.missions).toHaveLength(0);
  });

  it('does NOT auto-retry when the contract requires human approval — unchanged behavior', async () => {
    const interrupted: Mission = {
      id: 'M51',
      title: 'Supervised task',
      status: 'running',
      model: 'Sonnet 4.6',
      createdAt: Date.now(),
      contract: unattendedContract({ gates: { evaluators: true, humanApprove: true } }),
    };
    stubJournalRows([missionRow(interrupted)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.find((m) => m.id === 'M51')?.status).toBe('failed');
    });

    await advanceThroughGracePeriod();

    expect(result.current.missions).toHaveLength(1);
    const original = result.current.missions.find((m) => m.id === 'M51')!;
    expect(original.autoRetriedAfterRestart).toBeFalsy();
  });

  it('does NOT auto-retry when the mission carries no contract at all — unchanged behavior', async () => {
    const interrupted: Mission = {
      id: 'M52',
      title: 'No-contract task',
      status: 'running',
      model: 'Sonnet 4.6',
      createdAt: Date.now(),
    };
    stubJournalRows([missionRow(interrupted)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.find((m) => m.id === 'M52')?.status).toBe('failed');
    });

    await advanceThroughGracePeriod();

    expect(result.current.missions).toHaveLength(1);
  });

  it('never retries twice — a mission already stamped autoRetriedAfterRestart from an earlier boot is left alone (no restart -> retry -> restart loop)', async () => {
    const alreadyRetried: Mission = {
      id: 'M53',
      title: 'Already handled on a previous boot',
      status: 'failed',
      statusReason: en['agents.recoveredOnRestart'],
      model: 'Sonnet 4.6',
      createdAt: Date.now(),
      contract: unattendedContract(),
      autoRetriedAfterRestart: true,
    };
    stubJournalRows([missionRow(alreadyRetried)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M53')).toBe(true);
    });

    await advanceThroughGracePeriod();

    // Still exactly one mission — no second automatic retry clone.
    expect(result.current.missions).toHaveLength(1);
  });
});
