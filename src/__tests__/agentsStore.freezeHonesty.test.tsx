/**
 * agentsStore.freezeHonesty.test.tsx
 *
 * v0.1.5 W2.4 — kill the silent mission freeze (M15 class).
 * addMission used to launch runMission with `.catch(() => {})`: any throw in
 * the pre-'running' window (brain recall, plan compile, start) was swallowed
 * and the mission stayed frozen in 'queued' forever with zero explanation.
 * Now any rejection flips the mission to status 'failed' with a statusReason
 * carrying the failing phase and the error message — and the happy path is
 * strictly unchanged. Mirrors the style of agentsStore.mergeHonesty.test.tsx.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { compilePlan } from '../lib/agents/stageContract';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/agentSessionGate', () => ({
  gateAgentSession: vi.fn(async () => ({ ok: true, rail: 'cli' })),
}));

// Keep runtime REAL (the pre-'running' window under test lives there) but
// make its compilePlan dependency controllable per test.
vi.mock('../lib/agents/stageContract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/stageContract')>();
  return { ...actual, compilePlan: vi.fn(actual.compilePlan) };
});

const actualStage = await vi.importActual<typeof import('../lib/agents/stageContract')>(
  '../lib/agents/stageContract',
);
const mockedCompilePlan = vi.mocked(compilePlan);

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

// Guard: the fix must not trade the freeze for an unhandled rejection.
const unhandledRejections: unknown[] = [];
const captureUnhandled = (reason: unknown) => {
  unhandledRejections.push(reason);
};

beforeEach(() => {
  // Web-platform mission persistence lives in localStorage; without a clear,
  // the mount-time load of a later test replaces the missions list with the
  // previous test's persisted missions and drops freshly added ones.
  localStorage.clear();
  unhandledRejections.length = 0;
  process.on('unhandledRejection', captureUnhandled);
  mockedCompilePlan.mockReset().mockImplementation(actualStage.compilePlan);
});

afterEach(() => {
  process.off('unhandledRejection', captureUnhandled);
});

async function addNamedMission(
  result: { current: ReturnType<typeof useAgentsStore> },
  title: string,
): Promise<void> {
  await act(async () => {
    await result.current.addMission({
      title,
      repo: '.',
      worktree: '',
      modelLabel: 'claude-sonnet-5',
      mode: 'agent',
      orchestrator: false,
    });
  });
}

describe('addMission — freeze honesty', () => {
  it('compilePlan throws -> mission ends failed with a phase-carrying statusReason, no unhandled rejection', async () => {
    mockedCompilePlan.mockImplementation(() => {
      throw new Error('boom kaput');
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await addNamedMission(result, 'Freeze repro');

    await waitFor(() => {
      const mission = result.current.missions.find((m) => m.title === 'Freeze repro')!;
      expect(mission.status).toBe('failed');
    });

    const mission = result.current.missions.find((m) => m.title === 'Freeze repro')!;
    expect(mission.statusReason).toBeTruthy();
    expect(mission.statusReason).toContain('plan-compile');
    expect(mission.statusReason).toContain('boom kaput');

    // Let any stray rejection surface before asserting none happened.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(unhandledRejections).toEqual([]);
  });

  it('happy path unchanged: mission reaches running with no statusReason', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await addNamedMission(result, 'Happy path');

    await waitFor(() => {
      const mission = result.current.missions.find((m) => m.title === 'Happy path')!;
      expect(mission.status).toBe('running');
    });

    const mission = result.current.missions.find((m) => m.title === 'Happy path')!;
    expect(mission.statusReason).toBeUndefined();
  });
});
