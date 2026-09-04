/**
 * Tests for canvas/hooks/useCanvasFollowActive.ts (P47 deliverable #2 —
 * « Suivre l'activité »): default-on for a project with exactly one running
 * mission, debounced panel-aware setCenter on a running/review transition,
 * the 30s pause-after-manual-move gate, and the replay/disabled bail-outs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RefObject } from 'react';
import type { FleetProject } from '../lib/agents/fleetMissions';
import { useCanvasFollowActive } from '../components/agents/canvas/hooks/useCanvasFollowActive';

const FOLLOW_TEST_DEBOUNCE_MS = 2_000;

function project(missions: FleetProject['missions']): FleetProject {
  return { projectId: 'proj-1', root: '/fixtures/proj-1', name: 'proj-1', missions };
}

function makeInstance() {
  const node = { id: 'mission:m-1', position: { x: 100, y: 200 }, measured: { width: 220, height: 140 } };
  const setCenter = vi.fn();
  const getNode = vi.fn().mockReturnValue(node);
  const getZoom = vi.fn().mockReturnValue(1);
  return { setCenter, getNode, getZoom };
}

function makeParams(overrides: Partial<Parameters<typeof useCanvasFollowActive>[0]> = {}) {
  const instance = makeInstance();
  const reactFlowInstanceRef = { current: instance } as unknown as Parameters<typeof useCanvasFollowActive>[0]['reactFlowInstanceRef'];
  // A REAL jsdom element (not a plain object stub) — measureDockedPanelInsets
  // (cameraInsets.ts) calls real Element methods (`.closest`/`.querySelector`)
  // on it; only `getBoundingClientRect` is overridden (jsdom's own default
  // has no real layout engine, see that function's own doc comment).
  const containerEl = document.createElement('div');
  containerEl.getBoundingClientRect = () => ({ width: 1200, height: 800 }) as DOMRect;
  const containerRef = { current: containerEl } as RefObject<HTMLElement | null>;
  return {
    instance,
    params: {
      projects: [],
      activeFleetProjectId: 'proj-1',
      reactFlowInstanceRef,
      containerRef,
      ...overrides,
    } as Parameters<typeof useCanvasFollowActive>[0],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCanvasFollowActive — default state', () => {
  it('defaults ON when the active project has exactly one running mission', () => {
    const { params } = makeParams({ projects: [project([{ id: 'm-1', title: 'A', status: 'running' } as FleetProject['missions'][number]])] });
    const { result } = renderHook(() => useCanvasFollowActive(params));
    expect(result.current.enabled).toBe(true);
  });

  it('defaults OFF with zero running missions', () => {
    const { params } = makeParams({ projects: [project([{ id: 'm-1', title: 'A', status: 'queued' } as FleetProject['missions'][number]])] });
    const { result } = renderHook(() => useCanvasFollowActive(params));
    expect(result.current.enabled).toBe(false);
  });

  it('defaults OFF with two-or-more running missions', () => {
    const { params } = makeParams({
      projects: [
        project([
          { id: 'm-1', title: 'A', status: 'running' } as FleetProject['missions'][number],
          { id: 'm-2', title: 'B', status: 'running' } as FleetProject['missions'][number],
        ]),
      ],
    });
    const { result } = renderHook(() => useCanvasFollowActive(params));
    expect(result.current.enabled).toBe(false);
  });

  it('toggle() flips the state regardless of the computed default, and that manual choice is never overridden later', () => {
    const { params } = makeParams({ projects: [project([{ id: 'm-1', title: 'A', status: 'running' } as FleetProject['missions'][number]])] });
    const { result, rerender } = renderHook((p) => useCanvasFollowActive(p), { initialProps: params });
    expect(result.current.enabled).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.enabled).toBe(false);

    // A later re-render (e.g. mission count changes) must not silently
    // re-enable it — the user's own click always wins.
    rerender({ ...params, projects: [project([{ id: 'm-1', title: 'A', status: 'running' } as FleetProject['missions'][number]])] });
    expect(result.current.enabled).toBe(false);
  });
});

describe('useCanvasFollowActive — transition-driven follow', () => {
  it('does nothing on the mission\'s FIRST observation, even if already running/review (no yank on project-open)', () => {
    const { params, instance } = makeParams({
      projects: [project([{ id: 'm-1', title: 'A', status: 'running' } as FleetProject['missions'][number]])],
    });
    renderHook(() => useCanvasFollowActive(params));
    act(() => vi.advanceTimersByTime(FOLLOW_TEST_DEBOUNCE_MS));
    expect(instance.setCenter).not.toHaveBeenCalled();
  });

  // `m-anchor` stays 'running' throughout so `enabled` defaults to true at
  // mount (spec: "exactly one running mission") without itself being the
  // transition under test — `m-1` is the one that actually moves.
  it('a queued -> running transition calls setCenter after the 2s debounce, keeping the current zoom', () => {
    const { params, instance } = makeParams({
      projects: [
        project([
          { id: 'm-anchor', title: 'Anchor', status: 'running' } as FleetProject['missions'][number],
          { id: 'm-1', title: 'A', status: 'queued' } as FleetProject['missions'][number],
        ]),
      ],
    });
    const { result, rerender } = renderHook((p) => useCanvasFollowActive(p), { initialProps: params });
    expect(result.current.enabled).toBe(true);

    rerender({
      ...params,
      projects: [
        project([
          { id: 'm-anchor', title: 'Anchor', status: 'running' } as FleetProject['missions'][number],
          { id: 'm-1', title: 'A', status: 'running' } as FleetProject['missions'][number],
        ]),
      ],
    });
    expect(instance.setCenter).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(FOLLOW_TEST_DEBOUNCE_MS));
    expect(instance.setCenter).toHaveBeenCalledTimes(1);
    expect(instance.setCenter).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), expect.objectContaining({ zoom: 1 }));
  });

  it('a running -> review transition also triggers follow', () => {
    const { params, instance } = makeParams({
      projects: [project([{ id: 'm-1', title: 'A', status: 'running' } as FleetProject['missions'][number]])],
    });
    const { rerender } = renderHook((p) => useCanvasFollowActive(p), { initialProps: params });

    rerender({ ...params, projects: [project([{ id: 'm-1', title: 'A', status: 'review' } as FleetProject['missions'][number]])] });
    act(() => vi.advanceTimersByTime(FOLLOW_TEST_DEBOUNCE_MS));
    expect(instance.setCenter).toHaveBeenCalledTimes(1);
  });

  it('debounces a burst of transitions into a single setCenter (2s of quiet after the LAST one)', () => {
    const { params, instance } = makeParams({
      projects: [
        project([
          { id: 'm-anchor', title: 'Anchor', status: 'running' } as FleetProject['missions'][number],
          { id: 'm-1', title: 'A', status: 'queued' } as FleetProject['missions'][number],
          { id: 'm-2', title: 'B', status: 'queued' } as FleetProject['missions'][number],
        ]),
      ],
    });
    const { result, rerender } = renderHook((p) => useCanvasFollowActive(p), { initialProps: params });
    expect(result.current.enabled).toBe(true);

    rerender({
      ...params,
      projects: [
        project([
          { id: 'm-anchor', title: 'Anchor', status: 'running' } as FleetProject['missions'][number],
          { id: 'm-1', title: 'A', status: 'running' } as FleetProject['missions'][number],
          { id: 'm-2', title: 'B', status: 'queued' } as FleetProject['missions'][number],
        ]),
      ],
    });
    act(() => vi.advanceTimersByTime(1_000)); // not yet 2s

    rerender({
      ...params,
      projects: [
        project([
          { id: 'm-anchor', title: 'Anchor', status: 'running' } as FleetProject['missions'][number],
          { id: 'm-1', title: 'A', status: 'running' } as FleetProject['missions'][number],
          { id: 'm-2', title: 'B', status: 'running' } as FleetProject['missions'][number],
        ]),
      ],
    });
    act(() => vi.advanceTimersByTime(1_000)); // 2s since m-1's transition, but only 1s since m-2's
    expect(instance.setCenter).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1_000)); // 2s since m-2's transition
    expect(instance.setCenter).toHaveBeenCalledTimes(1);
  });

  it('never follows while disabled (default OFF here: 0 running missions at boot)', () => {
    const { params, instance } = makeParams({
      projects: [project([{ id: 'm-1', title: 'A', status: 'queued' } as FleetProject['missions'][number]])],
    });
    const { result, rerender } = renderHook((p) => useCanvasFollowActive(p), { initialProps: params });
    expect(result.current.enabled).toBe(false);

    rerender({ ...params, projects: [project([{ id: 'm-1', title: 'A', status: 'running' } as FleetProject['missions'][number]])] });
    act(() => vi.advanceTimersByTime(FOLLOW_TEST_DEBOUNCE_MS));
    expect(instance.setCenter).not.toHaveBeenCalled();
  });

  it('never follows while replay is active, even with an already-enabled toggle', () => {
    const { params, instance } = makeParams({
      replayActive: true,
      projects: [
        project([
          { id: 'm-anchor', title: 'Anchor', status: 'running' } as FleetProject['missions'][number],
          { id: 'm-1', title: 'A', status: 'queued' } as FleetProject['missions'][number],
        ]),
      ],
    });
    const { result, rerender } = renderHook((p) => useCanvasFollowActive(p), { initialProps: params });
    expect(result.current.enabled).toBe(true);

    rerender({
      ...params,
      projects: [
        project([
          { id: 'm-anchor', title: 'Anchor', status: 'running' } as FleetProject['missions'][number],
          { id: 'm-1', title: 'A', status: 'running' } as FleetProject['missions'][number],
        ]),
      ],
    });
    act(() => vi.advanceTimersByTime(FOLLOW_TEST_DEBOUNCE_MS));
    expect(instance.setCenter).not.toHaveBeenCalled();
  });

  it('a real user pane move (non-null event) pauses following for 30s — a transition during the pause never centers', () => {
    const { params, instance } = makeParams({
      projects: [
        project([
          { id: 'm-anchor', title: 'Anchor', status: 'running' } as FleetProject['missions'][number],
          { id: 'm-1', title: 'A', status: 'queued' } as FleetProject['missions'][number],
        ]),
      ],
    });
    const { result, rerender } = renderHook((p) => useCanvasFollowActive(p), { initialProps: params });
    expect(result.current.enabled).toBe(true);

    act(() => result.current.onPaneMoveStart(new MouseEvent('mousedown')));
    rerender({
      ...params,
      projects: [
        project([
          { id: 'm-anchor', title: 'Anchor', status: 'running' } as FleetProject['missions'][number],
          { id: 'm-1', title: 'A', status: 'running' } as FleetProject['missions'][number],
        ]),
      ],
    });
    act(() => vi.advanceTimersByTime(FOLLOW_TEST_DEBOUNCE_MS));
    expect(instance.setCenter).not.toHaveBeenCalled();
  });

  it('a PROGRAMMATIC pane move (null event, e.g. this hook\'s own setCenter) never pauses following', () => {
    const { params, instance } = makeParams({
      projects: [
        project([
          { id: 'm-anchor', title: 'Anchor', status: 'running' } as FleetProject['missions'][number],
          { id: 'm-1', title: 'A', status: 'queued' } as FleetProject['missions'][number],
        ]),
      ],
    });
    const { result, rerender } = renderHook((p) => useCanvasFollowActive(p), { initialProps: params });

    act(() => result.current.onPaneMoveStart(null));
    rerender({
      ...params,
      projects: [
        project([
          { id: 'm-anchor', title: 'Anchor', status: 'running' } as FleetProject['missions'][number],
          { id: 'm-1', title: 'A', status: 'running' } as FleetProject['missions'][number],
        ]),
      ],
    });
    act(() => vi.advanceTimersByTime(FOLLOW_TEST_DEBOUNCE_MS));
    expect(instance.setCenter).toHaveBeenCalledTimes(1);
  });

  it('following resumes once the 30s pause elapses', () => {
    const { params, instance } = makeParams({
      projects: [
        project([
          { id: 'm-anchor', title: 'Anchor', status: 'running' } as FleetProject['missions'][number],
          { id: 'm-1', title: 'A', status: 'queued' } as FleetProject['missions'][number],
        ]),
      ],
    });
    const { result, rerender } = renderHook((p) => useCanvasFollowActive(p), { initialProps: params });

    act(() => result.current.onPaneMoveStart(new MouseEvent('mousedown')));
    act(() => vi.advanceTimersByTime(30_000));

    rerender({
      ...params,
      projects: [
        project([
          { id: 'm-anchor', title: 'Anchor', status: 'running' } as FleetProject['missions'][number],
          { id: 'm-1', title: 'A', status: 'running' } as FleetProject['missions'][number],
        ]),
      ],
    });
    act(() => vi.advanceTimersByTime(FOLLOW_TEST_DEBOUNCE_MS));
    expect(instance.setCenter).toHaveBeenCalledTimes(1);
  });
});
