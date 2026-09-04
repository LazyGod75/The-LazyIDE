/**
 * queueStaleness.test.ts — R4b fix: "ghost queue runs" read-model half.
 *
 * agentsStore.tsx's boot effect deliberately leaves a journal-loaded
 * 'queued' mission untouched (see applyReplayRecovery/isInterruptedMission's
 * doc comments — a queued mission never actually started, so nothing an app
 * restart interrupted). That is correct for a FRESH queued mission, but a
 * real-app QA incident found stale 'queued' entries from as far back as
 * July 4th still sitting in the queue file weeks later
 * (LazySite-internet's .lazy/mission-queue.json: M10/M11/M12/M15/M18/M21).
 * applyQueueStaleness (agentsStore.tsx) now flags any such mission —
 * 'queued', createdAt older than missionQueue.ts's STALE_QUEUE_THRESHOLD_MS
 * (24h) — with `queueStale: true` at boot, purely a read-model addition
 * (status/history untouched, nothing force-failed).
 *
 * Same harness as recoveryReplay.test.ts (invoke('journal_missions_current')
 * mocked directly — exercises the real wire path through to
 * applyReplayRecovery/applyQueueStaleness).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
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

describe('agentsStore boot — queue staleness (ghost queue runs fix)', () => {
  it('flags a queued mission created 11 days ago as queueStale, status untouched', async () => {
    const ancientQueued: Mission = {
      id: 'M10',
      title: 'Never actually started (July 4 vintage)',
      status: 'queued',
      model: 'Sonnet 4.6',
      createdAt: Date.now() - 11 * 24 * 60 * 60 * 1000,
    };
    stubJournalRows([missionRow(ancientQueued)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M10')).toBe(true);
    });

    const loaded = result.current.missions.find((m) => m.id === 'M10')!;
    expect(loaded.status).toBe('queued'); // never force-failed — history preserved
    expect(loaded.queueStale).toBe(true);
  });

  it('does NOT flag a queued mission created moments ago', async () => {
    const freshQueued: Mission = {
      id: 'M99',
      title: 'Just created',
      status: 'queued',
      model: 'Sonnet 4.6',
      createdAt: Date.now(),
    };
    stubJournalRows([missionRow(freshQueued)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M99')).toBe(true);
    });

    const loaded = result.current.missions.find((m) => m.id === 'M99')!;
    expect(loaded.queueStale).toBeFalsy();
  });

  it('does NOT flag a non-queued mission regardless of age', async () => {
    const ancientDone: Mission = {
      id: 'M8',
      title: 'Long done',
      status: 'done',
      model: 'Sonnet 4.6',
      createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    };
    stubJournalRows([missionRow(ancientDone)]);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M8')).toBe(true);
    });

    const loaded = result.current.missions.find((m) => m.id === 'M8')!;
    expect(loaded.queueStale).toBeFalsy();
  });
});
