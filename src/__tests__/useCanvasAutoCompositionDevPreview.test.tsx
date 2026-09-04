/**
 * useCanvasAutoCompositionDevPreview.test.tsx — targeted regression coverage
 * for three devPreview-related fixes to useCanvasAutoComposition.ts's (a)
 * dev-server auto-detect probe, sitting next to devPreview.test.ts rather
 * than inside the existing useCanvasAutoComposition.test.tsx (out of scope
 * for this change):
 *
 *   1. qa.preview.diag instrumentation removal — the hook must never emit
 *      that journal event again (it used to fire on every render/tick).
 *   2. Preview lifecycle fix — a preview auto-added for FINISHED web work
 *      (no running mission) still gets an ownerRef, via previewSurface.ts's
 *      findDeliverableMissionRef fallback.
 *   3. Retry-under-pressure fix — a FINISHED-work project whose probe
 *      declines for a TRANSIENT reason (system pressure / deferred memory
 *      retry) keeps retrying, bounded, instead of giving up on the first
 *      decline.
 *
 * ensureDevServerForProject/getDevServerSkipReason are mocked (real
 * orchestration needs a real Tauri filesystem this test env doesn't have —
 * same reason useCanvasAutoComposition.test.tsx's own tests never reach the
 * real orchestration path either); findDeliverableMissionRef itself is also
 * covered directly, unmocked, as a plain unit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// vi.hoisted — vi.mock factories below are hoisted above EVERY other
// statement in this file (including plain `const`s), and devPreview.ts's
// own `importOriginal()` call (in the mock right below) eagerly loads the
// real module graph, which imports journal.ts — ALSO mocked below — before
// a plain `const mockEmitEvent = vi.fn()` would have run. A plain const
// crashes with "Cannot access before initialization"; vi.hoisted runs
// before every vi.mock factory, guaranteeing these are ready either way.
const { mockIsTauriPlatformFn, mockEnsureDevServerForProject, mockGetDevServerSkipReason, mockEmitEvent } = vi.hoisted(() => ({
  mockIsTauriPlatformFn: { current: true },
  mockEnsureDevServerForProject: vi.fn(),
  mockGetDevServerSkipReason: vi.fn(),
  mockEmitEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../components/agents/canvas/canvasPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/agents/canvas/canvasPersistence')>();
  return { ...actual, isTauriPlatform: () => mockIsTauriPlatformFn.current };
});

// Real orchestration needs a real Tauri filesystem (getPlatform().fs.*),
// which this test env doesn't have — mocked so the ownerRef-fallback and
// retry-under-pressure behaviors can be exercised deterministically without
// depending on how the real fs boundary happens to fail here.
vi.mock('../lib/agents/devPreview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/devPreview')>();
  return {
    ...actual,
    ensureDevServerForProject: mockEnsureDevServerForProject,
    getDevServerSkipReason: mockGetDevServerSkipReason,
  };
});

vi.mock('../lib/journal/journal', () => ({ emitEvent: mockEmitEvent }));

import { useCanvasAutoComposition } from '../components/agents/canvas/hooks/useCanvasAutoComposition';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { makeRef } from '../components/agents/canvas/canvasTypes';
import { findDeliverableMissionRef } from '../components/agents/canvas/previewSurface';
import type { FleetMission, FleetProject } from '../lib/agents/fleetMissions';

function fm(id: string, status: FleetMission['status']): FleetMission {
  return { id, title: id, status, stage: 'code', model: 'haiku 4.5', updatedMs: Date.now(), urgent: false };
}

function project(projectId: string, missions: FleetMission[]): FleetProject {
  return { projectId, root: `/fixtures/${projectId}`, name: projectId, missions };
}

function makeRefs() {
  const container = document.createElement('div');
  Object.defineProperty(container, 'getBoundingClientRect', {
    value: () => ({ width: 1280, height: 800, x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 800 }),
  });
  const instance = {
    getNode: vi.fn(),
    getViewport: vi.fn().mockReturnValue({ x: 0, y: 0, zoom: 1 }),
    setViewport: vi.fn(),
  };
  return {
    containerRef: { current: container },
    reactFlowInstanceRef: { current: instance as never },
  };
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  localStorage.clear();
  mockIsTauriPlatformFn.current = true;
  mockEnsureDevServerForProject.mockReset();
  mockGetDevServerSkipReason.mockReset();
  mockEmitEvent.mockClear();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network error')));
  // Same non-colliding origin as useCanvasAutoComposition.test.tsx's own
  // beforeEach — jsdom's default origin would otherwise collide with a
  // candidate-port url and trip the (unrelated) self-origin guard.
  vi.stubGlobal('location', { ...window.location, origin: 'http://localhost:19999' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('findDeliverableMissionRef (previewSurface.ts)', () => {
  it('resolves the most recently updated review/done mission that has a worktree', () => {
    const ref = findDeliverableMissionRef([
      { id: 'm1', status: 'done', worktree: 'agent/m1', updatedMs: 1_000 },
      { id: 'm2', status: 'review', worktree: 'agent/m2', updatedMs: 2_000 },
    ]);
    expect(ref).toBe(makeRef('mission', 'm2'));
  });

  it('excludes a finished mission with no worktree', () => {
    expect(findDeliverableMissionRef([{ id: 'm1', status: 'done', updatedMs: 1_000 }])).toBeUndefined();
  });

  it('excludes a running/queued mission even when it has a worktree', () => {
    const ref = findDeliverableMissionRef([{ id: 'm1', status: 'running', worktree: 'agent/m1', updatedMs: 1_000 }]);
    expect(ref).toBeUndefined();
  });

  it('returns undefined for an empty list', () => {
    expect(findDeliverableMissionRef([])).toBeUndefined();
  });

  it('resolves a loop mission (loopConfig present) to a loop:<id> ref, matching findRunningMissionRef', () => {
    const ref = findDeliverableMissionRef([
      { id: 'l1', status: 'done', worktree: 'agent/l1', updatedMs: 1_000, loopConfig: { cadenceSec: 60 } },
    ]);
    expect(ref).toBe(makeRef('loop', 'l1'));
  });
});

describe('(a) dev-server auto-detect — ownerRef fallback for finished work', () => {
  it('links a preview auto-added for FINISHED web work (no running mission) to the mission that produced it', async () => {
    mockEnsureDevServerForProject.mockResolvedValue({ url: 'http://localhost:8080', port: 8080, reused: false });
    mockGetDevServerSkipReason.mockReturnValue(undefined);

    const refs = makeRefs();
    renderHook(() =>
      useCanvasAutoComposition({
        projects: [project('p1', [{ ...fm('m1', 'done'), worktree: 'agent/m1' }])],
        ...refs,
      }),
    );

    await waitFor(() => {
      const preview = canvasStoreVanilla.getState().surfaces.find((s) => s.kind === 'preview' && s.projectId === 'p1');
      expect(preview?.ownerRef).toBe(makeRef('mission', 'm1'));
    });
  });
});

describe('(a) dev-server auto-detect — retry under transient pressure', () => {
  it('keeps retrying, bounded, while a FINISHED-work project declines for a transient reason', async () => {
    vi.useFakeTimers();
    mockEnsureDevServerForProject.mockResolvedValue(null);
    mockGetDevServerSkipReason.mockReturnValue('pressure_high');

    const refs = makeRefs();
    renderHook(() =>
      useCanvasAutoComposition({
        projects: [project('p1', [{ ...fm('m1', 'review'), worktree: 'agent/m1' }])],
        ...refs,
      }),
    );

    await vi.advanceTimersByTimeAsync(0); // flush the initial synchronous tick()
    expect(mockEnsureDevServerForProject).toHaveBeenCalledTimes(1);

    // PORT_PROBE_INTERVAL_MS (4s) * FINISHED_WORK_PRESSURE_RETRY_LIMIT (30
    // — see the hook's own doc comment on that constant) = the full bounded
    // retry window; every tick in it must still call through.
    await vi.advanceTimersByTimeAsync(4_000 * 30);
    expect(mockEnsureDevServerForProject).toHaveBeenCalledTimes(31); // 1 immediate + 30 bounded retries

    // Well past the bound — the probe must have given up honestly by now,
    // never polling forever under sustained pressure.
    await vi.advanceTimersByTimeAsync(4_000 * 5);
    expect(mockEnsureDevServerForProject).toHaveBeenCalledTimes(31);
  });

  it('stops on the FIRST decline (no retry) when the null result carries no skip reason at all', async () => {
    vi.useFakeTimers();
    mockEnsureDevServerForProject.mockResolvedValue(null);
    mockGetDevServerSkipReason.mockReturnValue(undefined);

    const refs = makeRefs();
    renderHook(() =>
      useCanvasAutoComposition({
        projects: [project('p1', [{ ...fm('m1', 'review'), worktree: 'agent/m1' }])],
        ...refs,
      }),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(mockEnsureDevServerForProject).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000 * 3);
    expect(mockEnsureDevServerForProject).toHaveBeenCalledTimes(1); // never retried — a genuinely empty result
  });

  it('stops retrying once the bound is hit even if pressure never eases (spawn_deferred_memory reason too)', async () => {
    vi.useFakeTimers();
    mockEnsureDevServerForProject.mockResolvedValue(null);
    mockGetDevServerSkipReason.mockReturnValue('spawn_deferred_memory');

    const refs = makeRefs();
    renderHook(() =>
      useCanvasAutoComposition({
        projects: [project('p1', [{ ...fm('m1', 'done'), worktree: 'agent/m1' }])],
        ...refs,
      }),
    );

    await vi.advanceTimersByTimeAsync(4_000 * 31);
    const callsAtBound = mockEnsureDevServerForProject.mock.calls.length;
    expect(callsAtBound).toBe(31);

    await vi.advanceTimersByTimeAsync(4_000 * 10);
    expect(mockEnsureDevServerForProject.mock.calls.length).toBe(callsAtBound); // honest stop, not a tight loop
  });
});

describe('no qa.preview.diag journal spam (removed instrumentation)', () => {
  it('never emits a qa.preview.diag event across renders, rerenders and probe ticks', async () => {
    mockEnsureDevServerForProject.mockResolvedValue(null);
    mockGetDevServerSkipReason.mockReturnValue(undefined);

    const refs = makeRefs();
    const { rerender } = renderHook(
      ({ projects }: { projects: FleetProject[] }) => useCanvasAutoComposition({ projects, ...refs }),
      { initialProps: { projects: [project('p1', [fm('m1', 'running')])] } },
    );
    rerender({ projects: [project('p1', [fm('m1', 'done')])] });
    rerender({ projects: [project('p1', [{ ...fm('m2', 'review'), worktree: 'agent/m2' }])] });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockEmitEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'qa.preview.diag' }));
  });
});
