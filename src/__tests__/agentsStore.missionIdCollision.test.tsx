/**
 * agentsStore.missionIdCollision.test.tsx
 *
 * Regression coverage for the "mission id collision" bug: nextMissionId()
 * used to seed its counter from SEED_MISSIONS.length ONLY and never looked at
 * anything else — so the FIRST mission created in ANY session always minted
 * the exact same id ("M15"), blind to whatever the store already held.
 *
 * Real-app QA repro: a fresh "M15" collided with an existing (persisted)
 * mission's "M15" — clicking the new card opened the OTHER mission's detail,
 * since every mission lookup in the store (stop/pause/approve/discard,
 * LazyManager's resolveMissionQueryTarget, mission-detail selection, ...) is
 * id-keyed via `.find((m) => m.id === id)`, which resolves to whichever
 * matching entry appears FIRST — normally the older/persisted one, since
 * persisted missions are prepended and new ones are appended.
 *
 * The fix ratchets id generation past the max numeric suffix found in the
 * store's CURRENT mission list (persisted + demos + in-flight) at mint time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// Hoisted + module-scoped so EVERY call to the mocked getPlatform() below
// (both the component's own internal call and any the test makes) shares the
// exact SAME mock function instance — a fresh `vi.fn()` created inside the
// getPlatform() factory body would only be visible to whichever call site
// created it, so overriding resolution from the test would silently not
// reach the component's own mount-effect call.
const { mockMissionsLoad, mockMissionsSave } = vi.hoisted(() => ({
  mockMissionsLoad: vi.fn(),
  mockMissionsSave: vi.fn(),
}));

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
          load: mockMissionsLoad,
          save: mockMissionsSave,
        },
      };
    },
  };
});

// Persisted missions already occupying ids up to M20 — equivalent to what a
// real previous session would have saved to disk before this app instance
// started, and what the mount-load merge (agentsStore.loadRace coverage)
// folds into the store.
const PERSISTED_UP_TO_M20: Mission[] = [
  { id: 'M18', title: 'Old mission 18', status: 'done', model: 'Sonnet 4.6' },
  { id: 'M19', title: 'Old mission 19', status: 'review', model: 'Sonnet 4.6' },
  { id: 'M20', title: 'Old mission 20', status: 'cancelled', model: 'Sonnet 4.6' },
];

beforeEach(() => {
  mockMissionsLoad.mockReset().mockResolvedValue(PERSISTED_UP_TO_M20);
  mockMissionsSave.mockReset().mockResolvedValue(undefined);
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

function idNumber(id: string): number {
  return Number(/^M(\d+)$/.exec(id)?.[1] ?? NaN);
}

describe('agentsStore — mission id collision-proofing', () => {
  it('mints an id that collides with nothing when persisted missions already occupy ids up to M20', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    // Wait for the mount-load merge to fold the persisted M18-M20 missions in.
    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M20')).toBe(true);
    });

    await act(async () => {
      await result.current.addMission({
        title: 'New mission after persisted M20',
        repo: '.',
        worktree: '',
        modelLabel: 'Sonnet 4.6',
        mode: 'agent',
        orchestrator: false,
      });
    });

    const newMission = result.current.missions[result.current.missions.length - 1];

    // Collides with nothing already in the store.
    const idCounts = new Map<string, number>();
    for (const m of result.current.missions) {
      idCounts.set(m.id, (idCounts.get(m.id) ?? 0) + 1);
    }
    expect(idCounts.get(newMission.id)).toBe(1);

    // Specifically must be numbered past the persisted max (20) — this is
    // what fails on the pre-fix code, which always mints "M15" regardless of
    // what's already in the store, colliding with nothing here only by luck
    // (M15 isn't among M18-M20) but colliding for real whenever the
    // persisted max reaches 15+ in a real multi-session store.
    expect(idNumber(newMission.id)).toBeGreaterThan(20);
  });

  it('mints distinct ids for two rapid addMission calls', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M20')).toBe(true);
    });
    const before = result.current.missions.length;

    await act(async () => {
      await Promise.all([
        result.current.addMission({
          title: 'Rapid 1',
          repo: '.',
          worktree: '',
          modelLabel: 'Sonnet 4.6',
          mode: 'agent',
          orchestrator: false,
        }),
        result.current.addMission({
          title: 'Rapid 2',
          repo: '.',
          worktree: '',
          modelLabel: 'Sonnet 4.6',
          mode: 'agent',
          orchestrator: false,
        }),
      ]);
    });

    expect(result.current.missions.length).toBe(before + 2);
    const created = result.current.missions.slice(-2);
    expect(created[0].id).not.toBe(created[1].id);
  });

  it('directly reproduces the QA scenario: a persisted mission already owns "M15"', async () => {
    // Regression guard tied to the EXACT id QA observed colliding — proves
    // the fix isn't merely "numbered past 20" by coincidence of the fixture
    // above, but genuinely collision-proof against any persisted id,
    // including the specific one the old hardcoded-offset formula always
    // minted first.
    const withM15: Mission[] = [
      ...PERSISTED_UP_TO_M20,
      { id: 'M15', title: 'Old mission 15 (the QA collision id)', status: 'done', model: 'Sonnet 4.6' },
    ];
    mockMissionsLoad.mockReset().mockResolvedValue(withM15);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M15')).toBe(true);
    });

    await act(async () => {
      await result.current.addMission({
        title: 'New mission that must not collide with M15',
        repo: '.',
        worktree: '',
        modelLabel: 'Sonnet 4.6',
        mode: 'agent',
        orchestrator: false,
      });
    });

    const newMission = result.current.missions[result.current.missions.length - 1];
    const withSameId = result.current.missions.filter((m) => m.id === newMission.id);
    expect(withSameId).toHaveLength(1);
  });
});
