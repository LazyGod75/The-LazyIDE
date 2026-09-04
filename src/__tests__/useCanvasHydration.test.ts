/**
 * useCanvasHydration.test.ts — BUG 1 regression coverage (W6f, real-app P0
 * data-loss repro): the debounced autosave subscription
 * (canvasPersistence.ts's subscribeCanvasAutosave) must never be armed
 * before the persistence boot has actually hydrated the store, and
 * hydration itself must never be skipped just because `activeRoot` is
 * null/not-yet-hydrated at mount (a cold-boot race — the project registry
 * hydrates async, see AppContext.tsx) — PROVIDED this is a real Tauri boot.
 * `isTauriPlatform` is mocked `true` for those tests. A separate describe
 * block below proves the platform-gate itself: outside Tauri, this hook
 * must NEVER touch canvasStoreVanilla or arm autosave at all — canvas-
 * harness.tsx's screenshot fixture pre-seeds the store directly and
 * documents relying on exactly this (see useCanvasHydration.ts's own BUG 1
 * doc comment, point (b), discovered while verifying this wave's fix
 * wouldn't silently wipe that fixture). See canvasPersistence.test.ts's
 * "empty-overwrite guard" describe block for the companion save-boundary
 * tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCanvasHydration } from '../components/agents/canvas/hooks/useCanvasHydration';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { defaultCanvasLayout, defaultCanvasChains } from '../components/agents/canvas/canvasPersistence';
import { makeRef } from '../components/agents/canvas/canvasTypes';

const loadCanvasPersisted = vi.fn();
const subscribeCanvasAutosave = vi.fn();
let mockIsTauriPlatform = true;

vi.mock('../components/agents/canvas/canvasPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/agents/canvas/canvasPersistence')>();
  return {
    ...actual,
    isTauriPlatform: () => mockIsTauriPlatform,
    loadCanvasPersisted: (...args: unknown[]) => loadCanvasPersisted(...args),
    subscribeCanvasAutosave: (...args: unknown[]) => subscribeCanvasAutosave(...args),
  };
});

vi.mock('../lib/agents/agentsStorage', () => ({
  listAgents: vi.fn().mockResolvedValue([]),
}));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  loadCanvasPersisted.mockReset();
  subscribeCanvasAutosave.mockReset();
  subscribeCanvasAutosave.mockReturnValue(() => {});
  mockIsTauriPlatform = true; // every test below is a simulated Tauri boot unless stated otherwise
});

describe('useCanvasHydration — BUG 1 (W6f data-loss guard)', () => {
  it('never arms the autosave subscription before loadCanvasPersisted resolves (no-save-before-hydrate)', async () => {
    const gate = deferred<{ layout: ReturnType<typeof defaultCanvasLayout>; chainsFile: ReturnType<typeof defaultCanvasChains> }>();
    loadCanvasPersisted.mockReturnValue(gate.promise);

    const { result } = renderHook(() => useCanvasHydration('/repo', undefined));

    // Still in flight — the subscription must not exist yet, and
    // viewportInit must still be null (CanvasView.tsx blanks the canvas
    // rather than rendering with unhydrated defaults).
    expect(subscribeCanvasAutosave).not.toHaveBeenCalled();
    expect(result.current.viewportInit).toBeNull();

    gate.resolve({ layout: defaultCanvasLayout(), chainsFile: defaultCanvasChains() });
    await waitFor(() => expect(subscribeCanvasAutosave).toHaveBeenCalledTimes(1));

    // Armed only AFTER hydrate() actually ran — and the isHydrated getter
    // threaded through (4th arg) now proves it.
    const isHydratedArg = subscribeCanvasAutosave.mock.calls[0]?.[3] as (() => boolean) | undefined;
    expect(isHydratedArg?.()).toBe(true);
  });

  it('hydrates unconditionally even when activeRoot is null at mount (late-registry cold boot)', async () => {
    const layout = { ...defaultCanvasLayout(), positions: { [makeRef('mission', 'm1')]: { x: 5, y: 9 } } };
    const chainsFile = defaultCanvasChains();
    loadCanvasPersisted.mockResolvedValue({ layout, chainsFile });

    renderHook(() => useCanvasHydration(null, undefined));

    // '' — not skipped — is passed when no root is active yet (repoPath is
    // only consulted for the legacy migration lookup, see canvasPersistence
    // .ts's own header).
    await waitFor(() => expect(loadCanvasPersisted).toHaveBeenCalledWith(''));
    await waitFor(() => expect(canvasStoreVanilla.getState().positions).toEqual(layout.positions));

    // A null root at mount no longer means "never persist this session" —
    // the subscription still gets armed once hydration resolves (this is
    // exactly the W6e-reproduced bug this wave fixes).
    await waitFor(() => expect(subscribeCanvasAutosave).toHaveBeenCalledTimes(1));
  });

  it('retries a real project root that only becomes available after mount (activeRoot updates)', async () => {
    loadCanvasPersisted.mockResolvedValue({ layout: defaultCanvasLayout(), chainsFile: defaultCanvasChains() });

    const { rerender } = renderHook(({ root }: { root: string | null }) => useCanvasHydration(root, undefined), {
      initialProps: { root: null as string | null },
    });

    await waitFor(() => expect(loadCanvasPersisted).toHaveBeenCalledTimes(1));
    expect(loadCanvasPersisted).toHaveBeenCalledWith('');

    // Registry hydrates a moment later — the hook must not crash or
    // double-hydrate; the boot is a one-shot mount effect by design (the
    // fix here is that the ONE boot it does run is never skipped, not that
    // every root change re-triggers it — see the hook's own doc comment).
    rerender({ root: '/repo/late' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loadCanvasPersisted).toHaveBeenCalledTimes(1);
  });
});

describe('useCanvasHydration — boot viewport sanity guard (W-UX3 finding B)', () => {
  it('falls back to fitView when the persisted zoom is out of range (David repro: 188%)', async () => {
    const layout = { ...defaultCanvasLayout(), viewport: { x: 0, y: 0, zoom: 1.88 } };
    loadCanvasPersisted.mockResolvedValue({ layout, chainsFile: defaultCanvasChains() });

    const { result } = renderHook(() => useCanvasHydration('/repo', undefined));

    await waitFor(() => expect(result.current.viewportInit).toEqual({ fit: true }));
  });

  it('falls back to fitView when the persisted viewport is panned onto empty space', async () => {
    const layout = {
      ...defaultCanvasLayout(),
      positions: { [makeRef('mission', 'm1')]: { x: 2000, y: 2000 } },
      viewport: { x: -50_000, y: -50_000, zoom: 1 },
    };
    loadCanvasPersisted.mockResolvedValue({ layout, chainsFile: defaultCanvasChains() });

    const { result } = renderHook(() => useCanvasHydration('/repo', undefined));

    await waitFor(() => expect(result.current.viewportInit).toEqual({ fit: true }));
  });

  it('trusts a sane, in-range, on-content persisted viewport verbatim', async () => {
    const viewport = { x: -1900, y: -1900, zoom: 1 };
    const layout = {
      ...defaultCanvasLayout(),
      positions: { [makeRef('mission', 'm1')]: { x: 2000, y: 2000 } },
      viewport,
    };
    loadCanvasPersisted.mockResolvedValue({ layout, chainsFile: defaultCanvasChains() });

    const { result } = renderHook(() => useCanvasHydration('/repo', undefined));

    await waitFor(() => expect(result.current.viewportInit).toEqual({ fit: false, viewport }));
  });

  it('still falls back to fitView when there is no persisted viewport at all (unaffected pre-existing behavior)', async () => {
    loadCanvasPersisted.mockResolvedValue({ layout: defaultCanvasLayout(), chainsFile: defaultCanvasChains() });

    const { result } = renderHook(() => useCanvasHydration('/repo', undefined));

    await waitFor(() => expect(result.current.viewportInit).toEqual({ fit: true }));
  });
});

describe('useCanvasHydration — non-Tauri platform gate (canvas-harness.tsx safety)', () => {
  it('never calls loadCanvasPersisted/hydrate/subscribeCanvasAutosave outside Tauri, even with a real root', async () => {
    mockIsTauriPlatform = false;

    // Seed the store exactly like canvas-harness.tsx does — directly,
    // before/independent of this hook running — to prove hydrate() cannot
    // clobber it outside Tauri.
    canvasStoreVanilla.getState().addDraft({ id: 'seed-1', title: 'Seeded', task: 'seeded fixture', createdBy: 'user' });

    const { result } = renderHook(() => useCanvasHydration('/repo', undefined));

    await waitFor(() => expect(result.current.viewportInit).toEqual({ fit: true }));

    expect(loadCanvasPersisted).not.toHaveBeenCalled();
    expect(subscribeCanvasAutosave).not.toHaveBeenCalled();
    // The pre-seeded fixture draft survives untouched.
    expect(canvasStoreVanilla.getState().drafts).toHaveLength(1);
    expect(canvasStoreVanilla.getState().drafts[0].id).toBe('seed-1');
  });
});
