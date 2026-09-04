/**
 * agentsStore.loadRace.test.tsx
 *
 * Regression coverage for the "mission-vanish race": the mount effect that
 * loads persisted missions used to merge them into state via
 * `missions: mergeMissions(getInitialMissions(), recovered)` — replacing
 * prev.missions OUTRIGHT. Any mission added via addMission() while that load
 * was still in flight lived only in prev.missions and had no representation
 * in `recovered` (loaded from disk), so it was silently dropped the instant
 * the load resolved — with zero trace, no error, nothing.
 *
 * Real-app QA repro: submit a mission ~5s after boot (persisted-load still
 * racing) -> it vanishes; ~20s after boot (load already settled) -> fine.
 *
 * The fix makes the merge UNION-preserving: any mission present in
 * prev.missions but absent (by id) from the freshly merged result is kept,
 * appended at the end (the same ordering convention addMission itself uses
 * for new missions).
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import type { Mission } from '../lib/agents/types';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
  };
});

// Deferred promise so the test controls EXACTLY when platform.missions.load
// resolves — required to reproduce the real race, where addMission() runs to
// completion strictly BEFORE the persisted-load promise settles.
let resolveLoad: ((value: unknown) => void) | null = null;

function makeLoadDeferred(): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    resolveLoad = resolve;
  });
}

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    getPlatform: () => {
      const real = actual.getPlatform();
      return {
        ...real,
        missions: {
          ...real.missions,
          load: vi.fn(() => makeLoadDeferred()),
          save: vi.fn().mockResolvedValue(undefined),
        },
      };
    },
  };
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('agentsStore — mount-load merge race (mission-vanish bug)', () => {
  it('preserves a mission added via addMission() while the persisted-missions load is still in flight', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    // Add a mission BEFORE the persisted load resolves — reproduces the
    // real-app "~5s after boot" window from the QA repro.
    await act(async () => {
      await result.current.addMission({
        title: 'Added during load race',
        repo: '.',
        worktree: '',
        modelLabel: 'Sonnet 4.6',
        mode: 'agent',
        orchestrator: false,
      });
    });
    const raceMissionId = result.current.missions[result.current.missions.length - 1].id;
    expect(result.current.missions.some((m) => m.id === raceMissionId)).toBe(true);

    // Now let the persisted-missions load resolve with an unrelated real
    // mission from a "previous session".
    const persistedMission: Mission = {
      id: 'M42',
      title: 'Persisted from a previous session',
      status: 'done',
      model: 'Sonnet 4.6',
    };
    await act(async () => {
      expect(resolveLoad).not.toBeNull();
      resolveLoad!([persistedMission]);
      await flushMicrotasks();
    });

    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M42')).toBe(true);
    });

    // THE bug: the mission added during the race must still be present —
    // this assertion is what fails on the pre-fix code (the merge replaces
    // prev.missions outright, dropping it).
    expect(result.current.missions.some((m) => m.id === raceMissionId)).toBe(true);
  });
});
