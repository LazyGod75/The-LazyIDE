/**
 * recoveryReplay.test.ts — T0.5 coverage for agentsStore.tsx's boot effect:
 * journal-first loading (missionsProjection.loadMissionsFromJournal) and
 * replay-recovery (applyReplayRecovery) — the replacement for the old
 * force-fail-everything-running-or-queued pass, scoped to missions loaded
 * FROM THE JOURNAL only (the legacy missions.json fallback keeps its own
 * unmodified behavior, covered by the existing agentsStore.loadRace.test.tsx
 * and the "#11 fix" this file does not touch).
 *
 * invoke('journal_missions_current', ...) is mocked directly (not the
 * missionsProjection module) so this exercises the real wire path: the
 * Rust-shaped rows -> JSON.parse(data) -> Mission[] -> applyReplayRecovery.
 *
 * createElement (not JSX) — this file is .ts, matching this task's brief.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { emitBuffered } from '../lib/journal/journal';
import { runMission } from '../lib/agents/runtime';
import { STALE_QUEUE_THRESHOLD_MS } from '../lib/agents/missionQueue';
import type { Mission } from '../lib/agents/types';

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
const mockedEmitBuffered = vi.mocked(emitBuffered);
const mockedRunMission = vi.mocked(runMission);

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

interface MissionCurrentRowFixture {
  mission_id: string;
  project_id: string;
  status: string;
  data: string;
  updated_ms: number;
}

function missionRow(mission: Mission): MissionCurrentRowFixture {
  return {
    mission_id: mission.id,
    project_id: 'proj-1',
    status: mission.status,
    data: JSON.stringify(mission),
    updated_ms: Date.now(),
  };
}

/** Configures invoke so 'journal_missions_current' returns exactly `rows`
 *  and every other command falls through to the harmless default. */
function stubJournalRows(rows: MissionCurrentRowFixture[]): void {
  mockedInvoke.mockImplementation((cmd: unknown) => {
    if (cmd === 'journal_missions_current') return Promise.resolve(rows);
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockedInvoke.mockResolvedValue(undefined);
  mockMissionsLoad.mockResolvedValue(null);
  setTauriRuntime(true);
});

afterEach(() => {
  setTauriRuntime(false);
});

describe('agentsStore boot — journal-first loading (T0.5)', () => {
  it('loads the mission list from the journal and never touches the legacy missions.json load', async () => {
    const mission: Mission = { id: 'M9001', title: 'From the journal', status: 'done', model: 'Sonnet 4.6' };
    stubJournalRows([missionRow(mission)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M9001')).toBe(true);
    });

    expect(mockMissionsLoad).not.toHaveBeenCalled();
  });

  it('falls back to missions.json when running outside Tauri (no journal to consult)', async () => {
    setTauriRuntime(false);
    mockMissionsLoad.mockResolvedValue([
      { id: 'M9002', title: 'From legacy missions.json', status: 'done', model: 'Sonnet 4.6' } as Mission,
    ]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M9002')).toBe(true);
    });

    expect(mockedInvoke).not.toHaveBeenCalledWith('journal_missions_current', expect.anything());
  });
});

describe('agentsStore boot — replay recovery (T0.5)', () => {
  it('marks a running mission "failed" and records a mission.failed(reason: interrupted) event', async () => {
    const runningMission: Mission = {
      id: 'M9003',
      title: 'Was running when the app died',
      status: 'running',
      model: 'Sonnet 4.6',
      liveAction: 'Thinking…',
      actionTimeline: [{ time: '10:00', text: 'still going', isLive: true }],
    };
    stubJournalRows([missionRow(runningMission)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      const m = result.current.missions.find((mm) => mm.id === 'M9003');
      expect(m?.status).toBe('failed');
    });

    const recovered = result.current.missions.find((mm) => mm.id === 'M9003')!;
    expect(recovered.liveAction).toBeUndefined();
    expect(recovered.actionTimeline?.every((e) => e.isLive === false)).toBe(true);
    // Item 4 fix (real user QA, 2026-08-01): this used to leave
    // `statusReason` unset entirely, so a genuinely orphaned mission read as
    // "failed for no reason" — never an empty/undefined explanation.
    expect(recovered.statusReason).toBeTruthy();
    expect(recovered.statusReason).toBe(recovered.actionTimeline?.at(-1)?.text);

    expect(mockedEmitBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mission.failed',
        missionId: 'M9003',
        actor: 'system',
        payload: { reason: 'interrupted' },
      }),
    );
  });

  // RE-FLAG LOOP fix (live QA 2026-09-02): mission.failed is status-only —
  // journal.rs's projection leaves the row's `data` snapshot at
  // status:'running', and seedJournaledMissions keeps the debounce-save from
  // journaling the flip, so every boot/project switch/remount re-discovered
  // the same missions as "interrupted" and woke the manager up with
  // "M93 failed" again (10× in 50 min). The recovered snapshot must be
  // journaled explicitly, right there in the boot pass.
  it('journals the recovered snapshot (mission.updated, status failed) so the next boot does not re-flag it', async () => {
    const runningMission: Mission = {
      id: 'M9103',
      title: 'Interrupted, must settle in the journal',
      status: 'running',
      model: 'Sonnet 4.6',
      repoRoot: '/repo/lazy',
      liveAction: 'Thinking…',
      actionTimeline: [{ time: '10:00', text: 'still going', isLive: true }],
    };
    stubJournalRows([missionRow(runningMission)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await waitFor(() => {
      expect(result.current.missions.find((mm) => mm.id === 'M9103')?.status).toBe('failed');
    });

    await waitFor(() => {
      const snapshotWrites = mockedEmitBuffered.mock.calls
        .map(([evt]) => evt)
        .filter((evt) => evt.type === 'mission.updated' && evt.missionId === 'M9103');
      expect(snapshotWrites).toHaveLength(1);
      const snapshot = (snapshotWrites[0]!.payload as { mission: Mission }).mission;
      expect(snapshot.status).toBe('failed');
      expect(snapshot.liveAction).toBeUndefined();
      expect(snapshot.statusReason).toBeTruthy();
      expect(snapshot.actionTimeline?.every((e) => e.isLive === false)).toBe(true);
    });
  });

  it('does not journal a snapshot for a mission the recovery pass left untouched (boot re-stamp guard intact)', async () => {
    const settled: Mission = { id: 'M9104', title: 'Already done', status: 'done', model: 'Sonnet 4.6' };
    stubJournalRows([missionRow(settled)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await waitFor(() => {
      expect(result.current.missions.some((mm) => mm.id === 'M9104')).toBe(true);
    });
    // Give the 800 ms debounce-save cycle a chance to (wrongly) fire.
    await new Promise((r) => setTimeout(r, 1_000));

    expect(
      mockedEmitBuffered.mock.calls.some(([evt]) => evt.type === 'mission.updated' && evt.missionId === 'M9104'),
    ).toBe(false);
  });

  it('leaves a queued mission queued — no force-fail, no mission.failed event', async () => {
    const queuedMission: Mission = {
      id: 'M9004',
      title: 'Never actually started',
      status: 'queued',
      model: 'Sonnet 4.6',
    };
    stubJournalRows([missionRow(queuedMission)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M9004')).toBe(true);
    });

    const stillQueued = result.current.missions.find((mm) => mm.id === 'M9004')!;
    expect(stillQueued.status).toBe('queued');
    expect(mockedEmitBuffered).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mission.failed', missionId: 'M9004' }),
    );
  });

  it('recovers a "review" mission that still carries live flags (crashed mid status-transition)', async () => {
    const staleReview: Mission = {
      id: 'M9005',
      title: 'Crashed mid-evaluation',
      status: 'review',
      model: 'Sonnet 4.6',
      liveAction: 'Évaluation en cours…',
      actionTimeline: [{ time: '10:00', text: 'still evaluating', isLive: true }],
    };
    stubJournalRows([missionRow(staleReview)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      const m = result.current.missions.find((mm) => mm.id === 'M9005');
      expect(m?.status).toBe('failed');
    });

    expect(mockedEmitBuffered).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mission.failed', missionId: 'M9005', payload: { reason: 'interrupted' } }),
    );
    // Item 4 fix — same honest-reason guarantee as M9003 above.
    const recoveredReview = result.current.missions.find((mm) => mm.id === 'M9005')!;
    expect(recoveredReview.statusReason).toBeTruthy();
  });

  // DEAD-END FIX (real user report, live repro — M27/M28, LazySite-internet):
  // a 'review' mission interrupted mid-evaluation that ALREADY carries a
  // real, non-empty diff (proof runtime.ts's Step D already ran and
  // captured a genuine, committed deliverable before the crash) must stay
  // 'review' — never a bare 'failed' dead end — so the deliverable is still
  // reachable for Approve/Merge.
  it('recovers a "review" mission with live flags AND a real diff -> stays "review" (deliverable preserved), never "failed"', async () => {
    const staleReviewWithDiff: Mission = {
      id: 'M9012',
      title: 'Crashed mid-evaluation, real work already committed',
      status: 'review',
      model: 'Sonnet 4.6',
      liveAction: 'Évaluation en cours…',
      actionTimeline: [{ time: '10:00', text: 'still evaluating', isLive: true }],
      diffFiles: [{ filename: 'src/components/demos/BrainGraphDemo/Scene.tsx', added: 1, removed: 0 }],
      diffAdded: 1,
      diffRemoved: 0,
    };
    stubJournalRows([missionRow(staleReviewWithDiff)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M9012')).toBe(true);
    });

    const recovered = result.current.missions.find((mm) => mm.id === 'M9012')!;
    expect(recovered.status).toBe('review');
    expect(recovered.liveAction).toBeUndefined();
    expect(recovered.actionTimeline?.every((e) => e.isLive === false)).toBe(true);
    expect(recovered.statusReason).toBeTruthy();
    // The deliverable itself is untouched — still there to Approve/Merge.
    expect(recovered.diffFiles).toHaveLength(1);
    expect(recovered.diffAdded).toBe(1);

    // Never reported as a failure — nothing failed, real work just needs a
    // human (or auto-merge) to look at it.
    expect(mockedEmitBuffered).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mission.failed', missionId: 'M9012' }),
    );
  });

  // Counterpart: a mission that reached 'review' but whose diff really is
  // empty (emptyDeliverable, or simply no diff data ever recorded) has
  // nothing to salvage — unchanged, still flips to 'failed' exactly like
  // M9005 above.
  it('recovers a "review" mission with live flags but an explicitly empty deliverable -> still "failed" (nothing to salvage)', async () => {
    const staleReviewEmpty: Mission = {
      id: 'M9013',
      title: 'Crashed mid-evaluation, but never produced anything',
      status: 'review',
      model: 'Sonnet 4.6',
      liveAction: 'Évaluation en cours…',
      actionTimeline: [{ time: '10:00', text: 'still evaluating', isLive: true }],
      diffFiles: [],
      diffAdded: 0,
      diffRemoved: 0,
      emptyDeliverable: true,
    };
    stubJournalRows([missionRow(staleReviewEmpty)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      const m = result.current.missions.find((mm) => mm.id === 'M9013');
      expect(m?.status).toBe('failed');
    });

    expect(mockedEmitBuffered).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mission.failed', missionId: 'M9013', payload: { reason: 'interrupted' } }),
    );
  });

  it('leaves a genuinely-settled "review" mission (no live flags) untouched', async () => {
    const settledReview: Mission = {
      id: 'M9006',
      title: 'Ready for human review',
      status: 'review',
      model: 'Sonnet 4.6',
      actionTimeline: [{ time: '10:00', text: 'evaluation complete', isLive: false }],
    };
    stubJournalRows([missionRow(settledReview)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M9006')).toBe(true);
    });

    const stillReview = result.current.missions.find((mm) => mm.id === 'M9006')!;
    expect(stillReview.status).toBe('review');
    expect(mockedEmitBuffered).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mission.failed', missionId: 'M9006' }),
    );
  });

  it('leaves "done"/"failed"/"cancelled" missions loaded from the journal untouched', async () => {
    const done: Mission = { id: 'M9007', title: 'Done', status: 'done', model: 'Sonnet 4.6' };
    const failed: Mission = { id: 'M9008', title: 'Failed', status: 'failed', model: 'Sonnet 4.6' };
    const cancelled: Mission = { id: 'M9009', title: 'Cancelled', status: 'cancelled', model: 'Sonnet 4.6' };
    stubJournalRows([missionRow(done), missionRow(failed), missionRow(cancelled)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M9009')).toBe(true);
    });

    expect(result.current.missions.find((m) => m.id === 'M9007')?.status).toBe('done');
    expect(result.current.missions.find((m) => m.id === 'M9008')?.status).toBe('failed');
    expect(result.current.missions.find((m) => m.id === 'M9009')?.status).toBe('cancelled');
    expect(mockedEmitBuffered).not.toHaveBeenCalled();
  });
});

// ── Boot-time queued-mission relaunch (2026-08-02 fix) ──────────────────
//
// Root cause: scheduler.ts's pool/queue state is a fresh, empty,
// module-level singleton on every boot, and schedulerDispatch was
// otherwise only ever called at the MOMENT a mission is first created
// (addMission) — never again for a mission still 'queued' from a PREVIOUS
// session. A queued mission therefore sat in state.missions forever after
// any restart: not running, not failed, no scheduler entry, no
// statusReason — a silent zombie. Verified here by asserting the mocked
// runMission is actually invoked for a boot-loaded 'queued' mission
// (previously: never called at all — see the manual revert check this
// suite's author ran before/after the fix, described in the task report).
describe('agentsStore boot — queued-mission relaunch (2026-08-02 fix)', () => {
  it('relaunches a freshly-queued (non-stale) mission through runMission at boot', async () => {
    const queuedMission: Mission = {
      id: 'M9010',
      title: 'Queued when the app last closed',
      status: 'queued',
      model: 'Sonnet 4.6',
      createdAt: Date.now(),
    };
    stubJournalRows([missionRow(queuedMission)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M9010')).toBe(true);
    });

    await waitFor(() => {
      expect(mockedRunMission).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'M9010' }),
        expect.any(String),
        expect.objectContaining({ permissionMode: expect.any(String) }),
      );
    });
  });

  it('does NOT relaunch a queueStale (24h+) queued mission, and stamps an honest statusReason instead', async () => {
    const staleQueuedMission: Mission = {
      id: 'M9011',
      title: 'Queued over 24h ago, never started',
      status: 'queued',
      model: 'Sonnet 4.6',
      createdAt: Date.now() - (STALE_QUEUE_THRESHOLD_MS + 60_000),
    };
    stubJournalRows([missionRow(staleQueuedMission)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M9011')).toBe(true);
    });

    const stale = result.current.missions.find((m) => m.id === 'M9011')!;
    expect(stale.status).toBe('queued');
    expect(stale.queueStale).toBe(true);
    // Never-silent: a mission the app deliberately does not auto-resume
    // must still say why, instead of an empty statusReason.
    expect(stale.statusReason).toBeTruthy();
    expect(mockedRunMission).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'M9011' }),
      expect.anything(),
      expect.anything(),
    );
  });
});
