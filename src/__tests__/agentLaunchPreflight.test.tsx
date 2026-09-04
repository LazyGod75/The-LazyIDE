/**
 * agentLaunchPreflight.test.tsx
 *
 * FIX B (code review, v0.1.5 entitlement wave): the `agent:launch` bus
 * subscriber used to call addMission() unconditionally. The composer's
 * "Lancer comme agent" button and ReviewSpace's Ask Reviewer/Tester
 * quick-launch buttons have no preflight UI of their own (unlike
 * NewMissionModal/Composer's inline panel) — so a not-ready engine (no CLI,
 * no BYOK key, Pro inactive/out of credits) silently created a mission that
 * could never actually run.
 *
 * Fix: the bus subscriber now calls getEngineReadiness() first.
 *   - Not ready -> no mission is created, and exactly one toast surfaces the
 *     localized reason (reusing engine.reason.<reason>, the same key
 *     NewMissionModal/Composer already use for their inline panels).
 *   - Ready -> unchanged behaviour (mission created, nav to Agents space).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { emit, on } from '../lib/bus';
import { en } from '../i18n/locales/en';
import { runMission } from '../lib/agents/runtime';
import type { EngineReadiness } from '../lib/models/entitlement';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

// Keep runMission out of the picture entirely — this suite only cares
// whether addMission is invoked at all, not what the run itself does. The
// ready-path test below waits for this mock to actually be called (rather
// than a fixed setTimeout tick) so addMission's fire-and-forget promise
// chain (resolveProjectRoot -> ... -> runMission().catch()) always reaches
// this .catch() attachment BEFORE the test ends — otherwise, under load, a
// dangling continuation can outlive the test and throw once mocks are torn
// down elsewhere.
vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedRunMission = vi.mocked(runMission);

// vi.mock factories are hoisted above module-level code, so mocks a factory
// references must come from vi.hoisted (TDZ otherwise) — same pattern as
// agentsStore.test.tsx.
const { mockGetEngineReadiness, mockToast } = vi.hoisted(() => ({
  mockGetEngineReadiness: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock('../lib/models/entitlement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/entitlement')>();
  return { ...actual, getEngineReadiness: mockGetEngineReadiness };
});

// Bypass the real Toast context so the toast call itself is directly
// observable, regardless of which reason string/locale renders it.
vi.mock('../components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/ui')>();
  return { ...actual, useToast: () => ({ toast: mockToast }) };
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

const READY: EngineReadiness = { mode: 'cli', ready: true };
const NOT_READY_PRO_INACTIVE: EngineReadiness = {
  mode: 'pro',
  ready: false,
  reason: 'pro-inactive',
};

beforeEach(() => {
  localStorage.clear();
  // Pin the locale so the toast message assertion is deterministic
  // regardless of the test runner's navigator.language.
  localStorage.setItem('lazy.locale', 'en');
  mockGetEngineReadiness.mockReset();
  mockToast.mockClear();
  mockedRunMission.mockClear();
});

describe('agent:launch bus subscriber — engine preflight (FIX B)', () => {
  it('not ready: creates no mission and fires exactly one localized toast', async () => {
    mockGetEngineReadiness.mockReturnValue(NOT_READY_PRO_INACTIVE);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionsBefore = result.current.missions.length;

    const navSpy = vi.fn();
    const unsubNav = on('nav:navigateSpace', navSpy);

    await act(async () => {
      emit('agent:launch', {
        task: 'Fix the flaky login test',
        title: 'Fix the flaky login test',
        model: 'Sonnet 4.6',
      });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.missions.length).toBe(missionsBefore);
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(en['engine.reason.pro-inactive'], 'error');
    expect(navSpy).not.toHaveBeenCalled();

    unsubNav();
  });

  it('ready: creates the mission as before (unchanged behaviour), no toast', async () => {
    mockGetEngineReadiness.mockReturnValue(READY);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionsBefore = result.current.missions.length;

    const navSpy = vi.fn();
    const unsubNav = on('nav:navigateSpace', navSpy);

    await act(async () => {
      emit('agent:launch', {
        task: 'Fix the flaky login test',
        title: 'Fix the flaky login test',
        model: 'Sonnet 4.6',
      });
      await new Promise((r) => setTimeout(r, 0));
    });

    // addMission has been async since commit 967318d (repoRoot resolution
    // precedes the setState that makes the mission visible), so the mission
    // lands on a later tick than the emit+setTimeout(0) above — wait for it.
    await waitFor(() => {
      expect(result.current.missions.length).toBe(missionsBefore + 1);
    });
    const newMission = result.current.missions[result.current.missions.length - 1];
    expect(newMission.agentTask).toBe('Fix the flaky login test');
    expect(mockToast).not.toHaveBeenCalled();
    expect(navSpy).toHaveBeenCalledWith('agents');

    // Let addMission's fire-and-forget chain actually reach runMission()
    // before the test ends — see the runtime mock's doc comment above.
    await waitFor(() => {
      expect(mockedRunMission).toHaveBeenCalled();
    });

    unsubNav();
  });
});
