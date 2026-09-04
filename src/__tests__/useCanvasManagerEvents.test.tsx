/**
 * Tests for canvas/hooks/useCanvasManagerEvents.ts — the LazyManager
 * choreography listeners (Agent Canvas W4, spec §8.2): 'canvas:arrange'
 * dispatches to the real runLayoutAll(scope)/setLaneMode(enabled) callbacks,
 * 'canvas:focus' calls fitView + pulses the ref, 'canvas:highlight' pulses
 * a set of refs and auto-clears after its own duration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { emit } from '../lib/bus';
import { useCanvasManagerEvents } from '../components/agents/canvas/hooks/useCanvasManagerEvents';

function makeParams() {
  const fitView = vi.fn();
  const runLayoutAll = vi.fn().mockResolvedValue(undefined);
  const setLaneMode = vi.fn();
  const reactFlowInstanceRef = { current: { fitView } } as unknown as Parameters<typeof useCanvasManagerEvents>[0]['reactFlowInstanceRef'];
  return { fitView, runLayoutAll, setLaneMode, reactFlowInstanceRef };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCanvasManagerEvents — canvas:arrange', () => {
  it('mode "auto" (or absent) calls runLayoutAll with the given scope', () => {
    const p = makeParams();
    renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:arrange', { scope: 'proj-1', mode: 'auto' }));
    expect(p.runLayoutAll).toHaveBeenCalledWith('proj-1');

    act(() => emit('canvas:arrange', {}));
    expect(p.runLayoutAll).toHaveBeenCalledWith(undefined);
    expect(p.setLaneMode).not.toHaveBeenCalled();
  });

  it('mode "lanes" calls setLaneMode(true), never runLayoutAll', () => {
    const p = makeParams();
    renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:arrange', { mode: 'lanes' }));

    expect(p.setLaneMode).toHaveBeenCalledWith(true);
    expect(p.runLayoutAll).not.toHaveBeenCalled();
  });

  it('mode "free" calls setLaneMode(false)', () => {
    const p = makeParams();
    renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:arrange', { mode: 'free' }));

    expect(p.setLaneMode).toHaveBeenCalledWith(false);
  });
});

describe('useCanvasManagerEvents — canvas:focus', () => {
  it('calls fitView on the ref with a 400ms glide and pulses it, deferred one frame', () => {
    const p = makeParams();
    const { result } = renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:focus', { ref: 'mission:M1' }));
    // W-CAMERA — doFocus is now deferred through scheduleFrame even with no
    // pending arrange (same rationale as useCanvasLayout.ts's post-arrange
    // fitViewAfterLayout call); jsdom has no real requestAnimationFrame here,
    // so scheduleFrame falls back to a ~16ms setTimeout (see the
    // camera-after-arrange race tests below for the same fallback).
    expect(p.fitView).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(16));

    expect(p.fitView).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: 'mission:M1' }], duration: 400 }));
    expect(result.current.managerHighlightIds.has('mission:M1')).toBe(true);
  });

  it('clears the focus pulse after its own duration (2s)', () => {
    const p = makeParams();
    const { result } = renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:focus', { ref: 'mission:M1' }));
    act(() => vi.advanceTimersByTime(16));
    expect(result.current.managerHighlightIds.has('mission:M1')).toBe(true);

    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current.managerHighlightIds.has('mission:M1')).toBe(false);
  });

  // Bug fix (start_preview): a plain bounding-box fitView could leave the
  // camera at the canvas's own global zoom floor — a live preview
  // rendering as an unreadable speck. A caller (start_preview) that needs a
  // guaranteed readable floor sets 'canvas:focus'`s optional `minZoom`,
  // forwarded verbatim to fitView.
  it('forwards an explicit minZoom to fitView, guaranteeing a readable floor', () => {
    const p = makeParams();
    renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:focus', { ref: 'preview:P1', minZoom: 1 }));
    act(() => vi.advanceTimersByTime(16));

    expect(p.fitView).toHaveBeenCalledWith(
      expect.objectContaining({ nodes: [{ id: 'preview:P1' }], minZoom: 1, maxZoom: 1.1 }),
    );
  });

  // fix/canvas-manager-camera — replaces the old "omits minZoom, stays
  // undefined" expectation: an un-floored fitView let a degenerate bbox
  // resolve all the way down to React Flow's own 0.1 technical floor (round
  // 3 QA's "zoom stuck at 11%"). A caller that never sets `minZoom` now
  // gets a genuinely readable default floor instead of no floor at all.
  it('floors minZoom to a readable default (FOCUS_MIN_READABLE_ZOOM) when the emitter does not set one', () => {
    const p = makeParams();
    renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:focus', { ref: 'mission:M1' }));
    act(() => vi.advanceTimersByTime(16));

    expect(p.fitView).toHaveBeenCalledWith(expect.objectContaining({ minZoom: 0.6 }));
  });
});

describe('useCanvasManagerEvents — target not yet reconciled (fix/canvas-manager-camera)', () => {
  it('retries across frames until the target node exists, never fitting an empty bbox', () => {
    const p = makeParams();
    const getNode = vi.fn();
    // Absent for the first two checks (not yet reconciled), present after.
    getNode.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined).mockReturnValue({ id: 'draft:D1' });
    (p.reactFlowInstanceRef.current as unknown as { getNode: typeof getNode }).getNode = getNode;
    renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:focus', { ref: 'draft:D1' }));
    act(() => vi.advanceTimersByTime(16)); // 1st check: not ready, retries
    expect(p.fitView).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(16)); // 2nd check: not ready, retries
    expect(p.fitView).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(16)); // 3rd check: ready, fits

    expect(p.fitView).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: 'draft:D1' }] }));
  });

  it('gives up after the retry budget and still fits on the original ref (honest "we tried")', () => {
    const p = makeParams();
    const getNode = vi.fn().mockReturnValue(undefined); // never ready
    (p.reactFlowInstanceRef.current as unknown as { getNode: typeof getNode }).getNode = getNode;
    renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:focus', { ref: 'draft:GONE' }));
    act(() => vi.advanceTimersByTime(16 * 10));

    expect(p.fitView).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: 'draft:GONE' }] }));
  });
});

describe('useCanvasManagerEvents — focuses the whole ensemble created this turn (fix/canvas-manager-camera)', () => {
  it('fits ALL refs from a just-arrived canvas:highlight batch, not just the single focus ref', () => {
    const p = makeParams();
    renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:highlight', { refs: ['draft:D1', 'draft:D2', 'router:R1'] }));
    act(() => emit('canvas:focus', { ref: 'draft:D1' }));
    act(() => vi.advanceTimersByTime(16));

    expect(p.fitView).toHaveBeenCalledWith(
      expect.objectContaining({ nodes: [{ id: 'draft:D1' }, { id: 'draft:D2' }, { id: 'router:R1' }] }),
    );
  });

  it('ignores a stale highlight batch that does not include the focus ref', () => {
    const p = makeParams();
    renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:highlight', { refs: ['draft:D1', 'draft:D2'] }));
    act(() => emit('canvas:focus', { ref: 'mission:M9' }));
    act(() => vi.advanceTimersByTime(16));

    expect(p.fitView).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: 'mission:M9' }] }));
  });

  it('ignores a single-ref highlight batch (no ensemble to widen to)', () => {
    const p = makeParams();
    renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:highlight', { refs: ['draft:D1'] }));
    act(() => emit('canvas:focus', { ref: 'draft:D1' }));
    act(() => vi.advanceTimersByTime(16));

    expect(p.fitView).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: 'draft:D1' }] }));
  });
});

describe('useCanvasManagerEvents — camera-after-arrange race (fix/canvas-ux R9 BLOQUANT #1a)', () => {
  it('defers fitView until the pending arrange resolves, never fitting the stale pre-layout position', async () => {
    const p = makeParams();
    let resolveLayout: () => void = () => {};
    p.runLayoutAll.mockImplementation(
      () => new Promise<void>((resolve) => { resolveLayout = resolve; }),
    );
    renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:arrange', {}));
    act(() => emit('canvas:focus', { ref: 'draft:D1' }));

    // The elk layout hasn't resolved yet — focus must NOT fit on the stale
    // (pre-arrange) position.
    expect(p.fitView).not.toHaveBeenCalled();

    await act(async () => {
      resolveLayout();
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(40); // scheduleFrame's jsdom fallback (2x ~16ms)
    });

    expect(p.fitView).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: 'draft:D1' }] }));
  });

  it('fits after a deferred frame when focus arrives with no pending arrange', () => {
    const p = makeParams();
    renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:focus', { ref: 'draft:D1' }));
    expect(p.fitView).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(16));

    expect(p.fitView).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: 'draft:D1' }] }));
  });

  it('a lane-mode arrange never blocks the next focus (setLaneMode has no async promise to await)', () => {
    const p = makeParams();
    renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:arrange', { mode: 'lanes' }));
    act(() => emit('canvas:focus', { ref: 'draft:D1' }));
    act(() => vi.advanceTimersByTime(16));

    expect(p.fitView).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: 'draft:D1' }] }));
  });
});

describe('useCanvasManagerEvents — canvas:focus is panel-aware (P47)', () => {
  // fix/canvas-overlay-occlusion — ManagerOverlay's width is no longer
  // folded into fitView padding at all (measureDockedPanelInsets's
  // panelWidth is always 0 now): CanvasView.tsx reserves that overlay's
  // live width as real DOM space instead (reservedRightPx), so a mounted
  // manager-overlay sibling no longer changes this padding — see
  // cameraInsets.ts's measureDockedPanelInsets doc comment for the full
  // rationale. CockpitLeftRail is UNCHANGED (still a floating, unreserved
  // overlay) — this test now proves the overlay specifically is excluded.
  it('no longer insets fitView\'s padding for a docked ManagerOverlay sibling (that space is reserved structurally by CanvasView now, not compensated for here)', () => {
    const p = makeParams();
    const root = document.createElement('div');
    root.setAttribute('data-testid', 'cockpit-fullbleed-root');
    const canvas = document.createElement('div');
    const overlay = document.createElement('div');
    overlay.setAttribute('data-testid', 'manager-overlay');
    overlay.getBoundingClientRect = () => ({ width: 360 }) as DOMRect;
    root.append(canvas, overlay);
    const containerRef = { current: canvas };

    renderHook(() => useCanvasManagerEvents({ ...p, containerRef }));
    act(() => emit('canvas:focus', { ref: 'mission:M1' }));
    act(() => vi.advanceTimersByTime(16));

    expect(p.fitView).toHaveBeenCalledWith(
      expect.objectContaining({ padding: expect.objectContaining({ right: '24px' }) }),
    );
  });

  it('falls back to no inset (base gutter only) when containerRef is omitted, matching every pre-existing caller', () => {
    const p = makeParams();
    renderHook(() => useCanvasManagerEvents(p));
    act(() => emit('canvas:focus', { ref: 'mission:M1' }));
    act(() => vi.advanceTimersByTime(16));

    expect(p.fitView).toHaveBeenCalledWith(
      expect.objectContaining({ padding: expect.objectContaining({ right: '24px', left: '24px' }) }),
    );
  });
});

describe('useCanvasManagerEvents — canvas:highlight', () => {
  it('pulses every given ref', () => {
    const p = makeParams();
    const { result } = renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:highlight', { refs: ['draft:D1', 'mission:M1'] }));

    expect(result.current.managerHighlightIds.has('draft:D1')).toBe(true);
    expect(result.current.managerHighlightIds.has('mission:M1')).toBe(true);
  });

  it('auto-clears after ~2.5s, leaving other still-pulsing refs untouched', () => {
    const p = makeParams();
    const { result } = renderHook(() => useCanvasManagerEvents(p));

    act(() => emit('canvas:highlight', { refs: ['draft:D1'] }));
    act(() => vi.advanceTimersByTime(1_000));
    act(() => emit('canvas:highlight', { refs: ['draft:D2'] }));

    act(() => vi.advanceTimersByTime(1_600)); // D1's 2.5s elapses, D2's does not yet
    expect(result.current.managerHighlightIds.has('draft:D1')).toBe(false);
    expect(result.current.managerHighlightIds.has('draft:D2')).toBe(true);

    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.managerHighlightIds.has('draft:D2')).toBe(false);
  });

  it('ignores an empty refs array', () => {
    const p = makeParams();
    const { result } = renderHook(() => useCanvasManagerEvents(p));
    act(() => emit('canvas:highlight', { refs: [] }));
    expect(result.current.managerHighlightIds.size).toBe(0);
  });
});
