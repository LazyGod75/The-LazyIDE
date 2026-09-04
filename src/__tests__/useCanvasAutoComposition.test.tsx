/**
 * useCanvasAutoComposition.test.tsx — W-UX3 core deliverable 3
 * ("auto-composition": dev-server auto-detect, work auto-focus,
 * mission-complete flash + preview refresh). See the hook's own module
 * header for scope; these tests drive it with fake fleet snapshots and a
 * stubbed fetch/ReactFlow instance — never a real port probe.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, fireEvent } from '@testing-library/react';

// The dev-port probe is gated to the real Tauri app (web/harness mode has
// no dev server to detect and Chromium logs refused fetches as console
// errors) — simulate a Tauri boot so describe('(a) …') below exercises the
// real probing path. Same mock seam useCanvasHydration.test.ts uses.
let mockIsTauriPlatform = true;
vi.mock('../components/agents/canvas/canvasPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/agents/canvas/canvasPersistence')>();
  return { ...actual, isTauriPlatform: () => mockIsTauriPlatform };
});

// 2026-08-05 foreign-server-adoption incident fix — resolveWebDeliverableRoot/
// readRootDeliverableIndexHtml both default to `realDeps` (getPlatform().fs.*)
// when called with no explicit deps, exactly like every other test in this
// file relies on `ensureDevServerForProject` doing (see this file's own
// header: "never a real port probe"). Under jsdom/WebPlatform, `fs.readFile`
// NEVER rejects (returns '' for an unseeded path — see web.ts's `webFs`) —
// calling either function for real here would make EVERY project look like
// it has a resolvable deliverable, which would wrongly skip the passive
// candidate-port loop every pre-existing "(a) dev-server auto-detect" test
// below exercises. Mocked to the same "nothing found" default those tests
// already implicitly assumed; the two dedicated describe blocks further
// down override this per test.
const { mockResolveWebDeliverableRoot, mockReadRootDeliverableIndexHtml } = vi.hoisted(() => ({
  mockResolveWebDeliverableRoot: vi.fn(),
  mockReadRootDeliverableIndexHtml: vi.fn(),
}));
vi.mock('../lib/agents/devPreview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/devPreview')>();
  return {
    ...actual,
    resolveWebDeliverableRoot: mockResolveWebDeliverableRoot,
    readRootDeliverableIndexHtml: mockReadRootDeliverableIndexHtml,
  };
});

import { useCanvasAutoComposition, isPastAutoFocusGate } from '../components/agents/canvas/hooks/useCanvasAutoComposition';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { makeRef, PREVIEW_FOCUS_MIN_ZOOM } from '../components/agents/canvas/canvasTypes';
import { emit, on } from '../lib/bus';
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
  const setViewport = vi.fn();
  const instance = {
    getNode: vi.fn(),
    getViewport: vi.fn().mockReturnValue({ x: 0, y: 0, zoom: 1 }),
    setViewport,
  };
  return {
    containerRef: { current: container },
    reactFlowInstanceRef: { current: instance as never },
    instance,
    setViewport,
  };
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  localStorage.clear();
  mockIsTauriPlatform = true;
  mockResolveWebDeliverableRoot.mockReset().mockResolvedValue(null);
  mockReadRootDeliverableIndexHtml.mockReset().mockResolvedValue(null);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network error')));
  // Preview-surface-correctness fix — jsdom's own default origin
  // (http://localhost:3000) happens to collide with the FIRST candidate
  // port every "(a) dev-server auto-detect" test below already asserts on,
  // which would make the self-origin guard (isSelfOriginUrl) fire
  // incidentally in every one of them, not just the dedicated guard test.
  // Pin a non-colliding origin here so every pre-existing test keeps
  // exercising its OWN concern unaffected; the guard's own describe block
  // below stubs a COLLIDING origin explicitly, on top of this default.
  vi.stubGlobal('location', { ...window.location, origin: 'http://localhost:19999' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('isPastAutoFocusGate — pure idle-gate check (fix/canvas-agents-visibility)', () => {
  it('is false right after a gesture, true once AUTO_FOCUS_IDLE_GATE_MS has elapsed', () => {
    const gestureAt = 1_000_000;
    expect(isPastAutoFocusGate(gestureAt, gestureAt)).toBe(false);
    expect(isPastAutoFocusGate(gestureAt, gestureAt + 4_999)).toBe(false);
    expect(isPastAutoFocusGate(gestureAt, gestureAt + 5_000)).toBe(true);
    expect(isPastAutoFocusGate(gestureAt, gestureAt + 10_000)).toBe(true);
  });
});

describe('"camera qui présente" — one-shot auto-focus on a newly auto-added preview', () => {
  it('emits canvas:focus (ref + PREVIEW_FOCUS_MIN_ZOOM) exactly once when an auto-preview is created, never again on a later tick', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const refs = makeRefs();
    const focusEvents: Array<{ ref: string; minZoom?: number }> = [];
    const unsub = on('canvas:focus', (payload) => focusEvents.push(payload));

    const { rerender } = renderHook(
      ({ projects }: { projects: FleetProject[] }) => useCanvasAutoComposition({ projects, ...refs }),
      { initialProps: { projects: [project('p1', [fm('m1', 'running')])] } },
    );

    await waitFor(() => {
      expect(canvasStoreVanilla.getState().surfaces).toHaveLength(1);
    });
    const preview = canvasStoreVanilla.getState().surfaces[0];
    expect(focusEvents).toEqual([{ ref: makeRef('preview', preview.id), minZoom: PREVIEW_FOCUS_MIN_ZOOM }]);

    // A later re-render/tick for the SAME already-created surface must never
    // fire a second focus — one-shot, never a loop.
    rerender({ projects: [project('p1', [fm('m1', 'running')])] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(focusEvents).toHaveLength(1);

    unsub();
  });

  it('never fires canvas:focus when the auto-preview is created within AUTO_FOCUS_IDLE_GATE_MS of a real user gesture', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const refs = makeRefs();
    const focusEvents: unknown[] = [];
    const unsub = on('canvas:focus', (payload) => focusEvents.push(payload));

    renderHook(() => useCanvasAutoComposition({ projects: [project('p1', [fm('m1', 'running')])], ...refs }));
    // A real gesture right after mount — the surface is still about to be
    // created (the probe hasn't resolved yet), so its creation lands well
    // inside the idle gate.
    fireEvent.pointerDown(refs.containerRef.current);

    await waitFor(() => {
      expect(canvasStoreVanilla.getState().surfaces).toHaveLength(1);
    });
    expect(focusEvents).toHaveLength(0);

    unsub();
  });
});

describe('(c) mission-complete flash + preview refresh', () => {
  it('flags a running→done transition in justCompletedIds (ref-keyed, mission:<id>) and clears it after the flash window', async () => {
    vi.useFakeTimers();
    const refs = makeRefs();
    const { result, rerender } = renderHook(
      ({ projects }: { projects: FleetProject[] }) => useCanvasAutoComposition({ projects, ...refs }),
      { initialProps: { projects: [project('p1', [fm('m1', 'running')])] } },
    );

    expect(result.current.justCompletedIds.size).toBe(0);

    rerender({ projects: [project('p1', [fm('m1', 'done')])] });
    expect(result.current.justCompletedIds.has(makeRef('mission', 'm1'))).toBe(true);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current.justCompletedIds.size).toBe(0);
  });

  it('never flags a mission whose FIRST observed status is already done (no flash on boot/hydration)', () => {
    const refs = makeRefs();
    const { result } = renderHook(() => useCanvasAutoComposition({ projects: [project('p1', [fm('m1', 'done')])], ...refs }));
    expect(result.current.justCompletedIds.size).toBe(0);
  });

  it('bumps refreshRequestedAtMs on preview surfaces in the SAME zone when a mission completes — other zones untouched', () => {
    canvasStoreVanilla.getState().addSurface({ id: 'prev-p1', kind: 'preview', projectId: 'p1', url: 'http://localhost:5173' });
    canvasStoreVanilla.getState().addSurface({ id: 'prev-p2', kind: 'preview', projectId: 'p2', url: 'http://localhost:3000' });

    const refs = makeRefs();
    const { rerender } = renderHook(
      ({ projects }: { projects: FleetProject[] }) => useCanvasAutoComposition({ projects, ...refs }),
      { initialProps: { projects: [project('p1', [fm('m1', 'running')])] } },
    );

    rerender({ projects: [project('p1', [fm('m1', 'done')])] });

    const surfaces = canvasStoreVanilla.getState().surfaces;
    expect(surfaces.find((s) => s.id === 'prev-p1')?.refreshRequestedAtMs).toBeGreaterThan(0);
    expect(surfaces.find((s) => s.id === 'prev-p2')?.refreshRequestedAtMs).toBeUndefined();
  });

  it('is fully suspended while replay is active (W8d posture)', () => {
    const refs = makeRefs();
    const { result, rerender } = renderHook(
      ({ projects, replayActive }: { projects: FleetProject[]; replayActive: boolean }) =>
        useCanvasAutoComposition({ projects, replayActive, ...refs }),
      { initialProps: { projects: [project('p1', [fm('m1', 'running')])], replayActive: true } },
    );

    rerender({ projects: [project('p1', [fm('m1', 'done')])], replayActive: true });
    expect(result.current.justCompletedIds.size).toBe(0);
  });
});

describe('(a) dev-server auto-detect', () => {
  it('auto-adds ONE preview node (autoAdded: true) in the running zone when a known dev port answers', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({}); // first candidate port answers
    const refs = makeRefs();
    renderHook(() => useCanvasAutoComposition({ projects: [project('p1', [fm('m1', 'running')])], ...refs }));

    await waitFor(() => {
      const previews = canvasStoreVanilla.getState().surfaces.filter((s) => s.kind === 'preview' && s.projectId === 'p1');
      expect(previews).toHaveLength(1);
    });
    const preview = canvasStoreVanilla.getState().surfaces.find((s) => s.kind === 'preview' && s.projectId === 'p1')!;
    expect(preview.autoAdded).toBe(true);
    expect(preview.url).toBe('http://localhost:3000'); // first candidate in CANDIDATE_DEV_PORTS
  });

  it('never auto-adds for a project whose auto-preview was previously dismissed (remembered pref)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({});
    localStorage.setItem('lazy.canvas.autoPreviewDismissed', JSON.stringify(['p1']));

    const refs = makeRefs();
    renderHook(() => useCanvasAutoComposition({ projects: [project('p1', [fm('m1', 'running')])], ...refs }));

    // Give the (never-scheduled) probe a beat to prove absence honestly.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(canvasStoreVanilla.getState().surfaces).toHaveLength(0);
  });

  it('never auto-adds a SECOND preview when the zone already has one', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({});
    canvasStoreVanilla.getState().addSurface({ id: 'existing', kind: 'preview', projectId: 'p1', url: 'http://localhost:5173' });

    const refs = makeRefs();
    renderHook(() => useCanvasAutoComposition({ projects: [project('p1', [fm('m1', 'running')])], ...refs }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(canvasStoreVanilla.getState().surfaces.filter((s) => s.kind === 'preview')).toHaveLength(1);
  });

  it('never probes ports for a project with no running mission', async () => {
    const fetchSpy = fetch as ReturnType<typeof vi.fn>;
    const refs = makeRefs();
    renderHook(() => useCanvasAutoComposition({ projects: [project('p1', [fm('m1', 'queued'), fm('m2', 'done')])], ...refs }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never probes ports outside the real Tauri app (web/harness: no dev server, no console noise)', async () => {
    mockIsTauriPlatform = false;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const refs = makeRefs();
    renderHook(() => useCanvasAutoComposition({ projects: [project('p1', [fm('m1', 'running')])], ...refs }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetch).not.toHaveBeenCalled();
    expect(canvasStoreVanilla.getState().surfaces).toHaveLength(0);
  });

  // Regression — an in-flight tick() used to have no way to notice it had
  // been stopped: only `clearInterval` (future ticks) fired on stop, so a
  // probe already mid-await when the mission finished could still resolve
  // "reachable" and call addSurface well after the fact (this is exactly
  // how a stray extra preview surface from one test's stale tick() used to
  // bleed into a LATER test in this very file — see ProjectPortProbeState's
  // own doc comment in the hook).
  it('an in-flight probe that resolves AFTER its mission already finished does not add a stray preview', async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    const refs = makeRefs();
    const { rerender } = renderHook(
      ({ projects }: { projects: FleetProject[] }) => useCanvasAutoComposition({ projects, ...refs }),
      { initialProps: { projects: [project('p1', [fm('m1', 'running')])] } },
    );

    // Let the initial tick reach its in-flight candidate-port fetch call.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The mission finishes WHILE that probe is still in flight.
    rerender({ projects: [project('p1', [fm('m1', 'done')])] });

    // The stale probe now resolves "reachable" — AFTER being stopped.
    resolveFetch({});
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(canvasStoreVanilla.getState().surfaces).toHaveLength(0);
  });
});

// Preview-surface-correctness fix — real incident: a probe found the Lazy
// IDE's OWN dev server (this app's own tauri.conf.json devUrl, 5173)
// answering and wrongly attributed it as a DIFFERENT project's preview (see
// previewSurface.ts's isSelfOriginUrl doc comment for the full root cause).
describe('(a) dev-server auto-detect — self-origin guard', () => {
  it('never attributes this app\'s own dev origin to a project preview — falls through to the NEXT candidate port instead of giving up the whole probe', async () => {
    // Stub window.location so the app's OWN origin collides with the FIRST
    // candidate port (3000 — see the sibling "first candidate wins" test
    // above for why that's the one that would otherwise win).
    vi.stubGlobal('location', { ...window.location, origin: 'http://localhost:3000' });
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({}); // every candidate port "answers"

    const refs = makeRefs();
    renderHook(() => useCanvasAutoComposition({ projects: [project('p1', [fm('m1', 'running')])], ...refs }));

    await waitFor(() => {
      const previews = canvasStoreVanilla.getState().surfaces.filter((s) => s.kind === 'preview' && s.projectId === 'p1');
      expect(previews).toHaveLength(1);
    });
    const preview = canvasStoreVanilla.getState().surfaces.find((s) => s.kind === 'preview' && s.projectId === 'p1')!;
    // 3000 (this test's stubbed self-origin) must never be adopted; the next
    // real candidate (3001) is adopted instead — the probe recovers rather
    // than giving up entirely over one self-collision.
    expect(preview.url).toBe('http://localhost:3001');
  });
});

// 2026-08-05 foreign-server-adoption incident — real incident: the passive
// candidate-port sniff attributed project "Lazy-real-test" a preview at
// http://localhost:3000 that was actually ANOTHER open project's
// (lazy-backoffice) Next.js dev server, because 3000 answered and wasn't
// this app's own self origin. Fix (a): a project whose own static
// deliverable is resolvable must never fall through to the blind sniff at
// all. Fix (b): even in the genuine last resort, a reachable candidate is
// content-fingerprinted against the project's OWN root index.html (when
// one resolves) before ever being adopted.
describe('(a) dev-server auto-detect — foreign-server-adoption guard', () => {
  it('never adopts a foreign candidate port when the project has its own resolvable static deliverable — the real orchestration serves it instead', async () => {
    // The real orchestration (ensureDevServerForProject) is unmocked in this
    // file and always resolves null in this test env (no real Tauri fs — see
    // this file's own header) — exactly the condition under which the OLD
    // code fell straight through to the passive sniff. `resolveWebDeliverableRoot`
    // says this project DOES have its own deliverable (a foreign 3000 must
    // never be adopted instead).
    mockResolveWebDeliverableRoot.mockResolvedValue('/fixtures/p1');
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({}); // a foreign server answers on every candidate port

    const refs = makeRefs();
    renderHook(() => useCanvasAutoComposition({ projects: [project('p1', [fm('m1', 'running')])], ...refs }));

    // Give the probe several ticks to prove the absence honestly (never
    // flakes into adopting 3000 given more time).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(canvasStoreVanilla.getState().surfaces).toHaveLength(0);
    expect(mockResolveWebDeliverableRoot).toHaveBeenCalledWith('/fixtures/p1', []);
  });

  it('does not adopt a candidate whose content mismatches the project\'s own root index.html — tries the next candidate', async () => {
    mockResolveWebDeliverableRoot.mockResolvedValue(null); // no worktree-scoped deliverable
    mockReadRootDeliverableIndexHtml.mockResolvedValue('<!doctype html><title>My Real Site</title>');
    (fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (String(url).includes('/index.html')) {
        // Every candidate's fetched body is a DIFFERENT, foreign site.
        return Promise.resolve({ ok: true, text: () => Promise.resolve('<!doctype html><title>Some Orphaned Site</title>') });
      }
      return Promise.resolve({}); // plain reachability probe — every port "answers"
    });

    const refs = makeRefs();
    renderHook(() => useCanvasAutoComposition({ projects: [project('p1', [fm('m1', 'running')])], ...refs }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    // Every CANDIDATE_DEV_PORTS entry answered but fingerprinted as foreign
    // content — none of them may be adopted.
    expect(canvasStoreVanilla.getState().surfaces).toHaveLength(0);
  });

  it('still adopts a candidate whose content MATCHES the project\'s own root index.html', async () => {
    mockResolveWebDeliverableRoot.mockResolvedValue(null);
    const html = '<!doctype html><title>My Real Site</title>';
    mockReadRootDeliverableIndexHtml.mockResolvedValue(html);
    (fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (String(url).includes('/index.html')) return Promise.resolve({ ok: true, text: () => Promise.resolve(html) });
      return Promise.resolve({});
    });

    const refs = makeRefs();
    renderHook(() => useCanvasAutoComposition({ projects: [project('p1', [fm('m1', 'running')])], ...refs }));

    await waitFor(() => {
      const previews = canvasStoreVanilla.getState().surfaces.filter((s) => s.kind === 'preview' && s.projectId === 'p1');
      expect(previews).toHaveLength(1);
    });
    const preview = canvasStoreVanilla.getState().surfaces.find((s) => s.kind === 'preview' && s.projectId === 'p1')!;
    expect(preview.url).toBe('http://localhost:3000'); // first candidate, content confirmed
  });

  it('adopts a candidate as before when the project has neither a worktree-scoped deliverable nor a root index.html (genuine last resort, unchanged)', async () => {
    mockResolveWebDeliverableRoot.mockResolvedValue(null);
    mockReadRootDeliverableIndexHtml.mockResolvedValue(null);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const refs = makeRefs();
    renderHook(() => useCanvasAutoComposition({ projects: [project('p1', [fm('m1', 'running')])], ...refs }));

    await waitFor(() => {
      const previews = canvasStoreVanilla.getState().surfaces.filter((s) => s.kind === 'preview' && s.projectId === 'p1');
      expect(previews).toHaveLength(1);
    });
    const preview = canvasStoreVanilla.getState().surfaces.find((s) => s.kind === 'preview' && s.projectId === 'p1')!;
    expect(preview.url).toBe('http://localhost:3000');
  });
});

// Preview lifecycle fix — "linked to the agents/missions working on it":
// buildSurfaceEdges (reconcilerEdges.ts) only draws the dotted surface-edge
// when SurfaceSpec.ownerRef is set; previewSurface.test.ts covers that
// edge-building end to end from a plain ownerRef, so these tests focus on
// this hook's own responsibility — computing and keeping ownerRef current.
describe('(a) dev-server auto-detect — ownerRef', () => {
  it('links a newly auto-added preview to the project\'s running mission', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const refs = makeRefs();
    renderHook(() => useCanvasAutoComposition({ projects: [project('p1', [fm('m1', 'running')])], ...refs }));

    await waitFor(() => {
      const preview = canvasStoreVanilla.getState().surfaces.find((s) => s.kind === 'preview' && s.projectId === 'p1');
      expect(preview?.ownerRef).toBe(makeRef('mission', 'm1'));
    });
  });

  it('re-syncs an EXISTING preview\'s ownerRef once a DIFFERENT mission becomes the one running', () => {
    canvasStoreVanilla.getState().addSurface({
      id: 'prev-p1',
      kind: 'preview',
      projectId: 'p1',
      url: 'http://localhost:5173',
      ownerRef: makeRef('mission', 'm1'),
    });
    const refs = makeRefs();
    const { rerender } = renderHook(
      ({ projects }: { projects: FleetProject[] }) => useCanvasAutoComposition({ projects, ...refs }),
      { initialProps: { projects: [project('p1', [fm('m1', 'running')])] } },
    );

    rerender({ projects: [project('p1', [fm('m1', 'done'), fm('m2', 'running')])] });

    const preview = canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'prev-p1');
    expect(preview?.ownerRef).toBe(makeRef('mission', 'm2'));
  });

  it('leaves ownerRef untouched once nothing is running anymore (nothing fresher to replace it with)', () => {
    canvasStoreVanilla.getState().addSurface({
      id: 'prev-p1',
      kind: 'preview',
      projectId: 'p1',
      url: 'http://localhost:5173',
      ownerRef: makeRef('mission', 'm1'),
    });
    const refs = makeRefs();
    const { rerender } = renderHook(
      ({ projects }: { projects: FleetProject[] }) => useCanvasAutoComposition({ projects, ...refs }),
      { initialProps: { projects: [project('p1', [fm('m1', 'running')])] } },
    );

    rerender({ projects: [project('p1', [fm('m1', 'done')])] });

    const preview = canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'prev-p1');
    expect(preview?.ownerRef).toBe(makeRef('mission', 'm1'));
  });
});

// Preview lifecycle fix — the canvas must not go on showing a preview
// polling a port devPreview.ts just killed (bus.ts's own
// 'devPreview:serverStopped' doc comment has the full wiring rationale).
describe('devPreview:serverStopped', () => {
  it('removes the project\'s preview surface when it is still pointed at the exact url that stopped', () => {
    canvasStoreVanilla.getState().addSurface({ id: 'prev-p1', kind: 'preview', projectId: 'p1', url: 'http://localhost:3000' });
    const refs = makeRefs();
    renderHook(() => useCanvasAutoComposition({ projects: [project('p1', [])], ...refs }));

    act(() => emit('devPreview:serverStopped', { projectId: 'p1', url: 'http://localhost:3000' }));

    expect(canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'prev-p1')).toBeUndefined();
  });

  it('leaves the preview alone when its url no longer matches the stopped server (the user repointed it)', () => {
    canvasStoreVanilla.getState().addSurface({ id: 'prev-p1', kind: 'preview', projectId: 'p1', url: 'http://localhost:9999' });
    const refs = makeRefs();
    renderHook(() => useCanvasAutoComposition({ projects: [project('p1', [])], ...refs }));

    act(() => emit('devPreview:serverStopped', { projectId: 'p1', url: 'http://localhost:3000' }));

    expect(canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'prev-p1')).toBeDefined();
  });

  it('is a no-op for a project with no preview surface at all', () => {
    const refs = makeRefs();
    renderHook(() => useCanvasAutoComposition({ projects: [project('p1', [])], ...refs }));

    expect(() => act(() => emit('devPreview:serverStopped', { projectId: 'p1', url: 'http://localhost:3000' }))).not.toThrow();
  });
});

describe('(b) work auto-focus', () => {
  function offscreenNode(id: string) {
    // Node far outside the 1280x800 container at zoom 1, viewport (0,0).
    return { id, position: { x: 10_000, y: 10_000 }, measured: { width: 260, height: 140 } };
  }

  it('pans (same zoom, setViewport — never fitView/rezoom) to a mission that just started running fully off-viewport', () => {
    const refs = makeRefs();
    refs.instance.getNode.mockReturnValue(offscreenNode(makeRef('mission', 'm1')));

    const { rerender } = renderHook(
      ({ projects }: { projects: FleetProject[] }) => useCanvasAutoComposition({ projects, ...refs }),
      { initialProps: { projects: [project('p1', [fm('m1', 'queued')])] } },
    );

    rerender({ projects: [project('p1', [fm('m1', 'running')])] });

    expect(refs.setViewport).toHaveBeenCalledTimes(1);
    const [viewport] = refs.setViewport.mock.calls[0]!;
    expect(viewport.zoom).toBe(1); // translate only — the current zoom is preserved
  });

  it('leaves the camera alone when the node is already (even partially) visible', () => {
    const refs = makeRefs();
    refs.instance.getNode.mockReturnValue({
      id: makeRef('mission', 'm1'),
      position: { x: 1200, y: 400 }, // right edge partially on the 1280-wide screen
      measured: { width: 260, height: 140 },
    });

    const { rerender } = renderHook(
      ({ projects }: { projects: FleetProject[] }) => useCanvasAutoComposition({ projects, ...refs }),
      { initialProps: { projects: [project('p1', [fm('m1', 'queued')])] } },
    );
    rerender({ projects: [project('p1', [fm('m1', 'running')])] });

    expect(refs.setViewport).not.toHaveBeenCalled();
  });

  it('never yanks the camera when 3+ missions are already running fleet-wide', () => {
    const refs = makeRefs();
    refs.instance.getNode.mockReturnValue(offscreenNode(makeRef('mission', 'm3')));

    const { rerender } = renderHook(
      ({ projects }: { projects: FleetProject[] }) => useCanvasAutoComposition({ projects, ...refs }),
      { initialProps: { projects: [project('p1', [fm('m1', 'running'), fm('m2', 'running'), fm('m3', 'queued')])] } },
    );
    rerender({ projects: [project('p1', [fm('m1', 'running'), fm('m2', 'running'), fm('m3', 'running')])] });

    expect(refs.setViewport).not.toHaveBeenCalled();
  });

  it('never yanks the camera within 5s of a real user gesture on the canvas', () => {
    const refs = makeRefs();
    refs.instance.getNode.mockReturnValue(offscreenNode(makeRef('mission', 'm1')));

    const { rerender } = renderHook(
      ({ projects }: { projects: FleetProject[] }) => useCanvasAutoComposition({ projects, ...refs }),
      { initialProps: { projects: [project('p1', [fm('m1', 'queued')])] } },
    );

    // A REAL gesture on the container right before the transition.
    act(() => {
      refs.containerRef.current.dispatchEvent(new Event('wheel'));
    });
    rerender({ projects: [project('p1', [fm('m1', 'running')])] });

    expect(refs.setViewport).not.toHaveBeenCalled();
  });
});
