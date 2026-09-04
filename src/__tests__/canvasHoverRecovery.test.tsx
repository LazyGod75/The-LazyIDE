/**
 * canvasHoverRecovery.test.tsx — fix/canvas-ux R6a MAJEUR #7: after opening
 * AND closing the Rapport overlay, 'R' and the toolbar's Replay toggle both
 * went dead. Root cause: a full-screen overlay stacked on top of the canvas
 * fires a real `mouseleave` on it (hit-test target changed) but its removal
 * fires NO compensating `mouseenter`/`mousemove` (browsers only dispatch
 * pointer events for actual input-device movement) — `hoveredRef` got stuck
 * `false`, and useCanvasKeyboard.ts's single listener bails out on every
 * shortcut whenever that ref reads `false`.
 *
 * Proves the fix (hooks/useCanvasHoverRecovery.ts): a window-level 'click'
 * listener recomputes the REAL hover state via `document.elementFromPoint`
 * at the click's own screen point — by the time it runs (bubble phase,
 * after the click's own React handler already removed the overlay), the
 * hit-test at that same point correctly resolves to whatever is now there.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import {
  resolveHoverFromPoint,
  useCanvasHoverRecovery,
} from '../components/agents/canvas/hooks/useCanvasHoverRecovery';

// jsdom does not implement `document.elementFromPoint` at all (the property
// is simply absent — no real layout engine, canvasTestEnv.ts's own header
// notes the same limitation elsewhere), so `vi.spyOn` can't attach to it.
// `configurable: true` lets each test redefine it freely.
function stubElementFromPoint(returnValue: Element | null): void {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => returnValue,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  cleanup();
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});

describe('resolveHoverFromPoint (pure hit-test)', () => {
  it('is false when the container is null (not yet mounted)', () => {
    stubElementFromPoint(document.body);
    expect(resolveHoverFromPoint(null, 10, 10)).toBe(false);
  });

  it('is true when the point hit-tests to the container itself', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    stubElementFromPoint(container);
    expect(resolveHoverFromPoint(container, 10, 10)).toBe(true);
    container.remove();
  });

  it('is true when the point hit-tests to a DESCENDANT of the container (the overlay is gone, canvas revealed)', () => {
    const container = document.createElement('div');
    const child = document.createElement('span');
    container.appendChild(child);
    document.body.appendChild(container);
    stubElementFromPoint(child);
    expect(resolveHoverFromPoint(container, 10, 10)).toBe(true);
    container.remove();
  });

  it('is false when the point hit-tests to something OUTSIDE the container (an overlay is still on top)', () => {
    const container = document.createElement('div');
    const overlay = document.createElement('div');
    document.body.appendChild(container);
    document.body.appendChild(overlay);
    stubElementFromPoint(overlay);
    expect(resolveHoverFromPoint(container, 10, 10)).toBe(false);
    container.remove();
    overlay.remove();
  });
});

describe('useCanvasHoverRecovery — self-heals hoveredRef on the next window click', () => {
  it('flips hoveredRef back to true once the overlay is gone and a click lands over the canvas', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const containerRef = { current: container };
    const hoveredRef = { current: false }; // stuck false — overlay covered it earlier

    renderHook(() => useCanvasHoverRecovery(containerRef, hoveredRef));

    // The overlay is gone now (elementFromPoint resolves into the canvas) —
    // the click that closed it (e.g. its "Fermer" button) bubbles to window.
    stubElementFromPoint(container);
    window.dispatchEvent(new MouseEvent('click', { clientX: 42, clientY: 99, bubbles: true }));

    expect(hoveredRef.current).toBe(true);
    container.remove();
  });

  it('keeps hoveredRef false when the click lands somewhere still outside the canvas', () => {
    const container = document.createElement('div');
    const elsewhere = document.createElement('div');
    document.body.appendChild(container);
    document.body.appendChild(elsewhere);
    const containerRef = { current: container };
    const hoveredRef = { current: false };

    renderHook(() => useCanvasHoverRecovery(containerRef, hoveredRef));

    stubElementFromPoint(elsewhere);
    window.dispatchEvent(new MouseEvent('click', { clientX: 5, clientY: 5, bubbles: true }));

    expect(hoveredRef.current).toBe(false);
    container.remove();
    elsewhere.remove();
  });

  it('removes its window listener on unmount', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const containerRef = { current: container };
    const hoveredRef = { current: false };

    const { unmount } = renderHook(() => useCanvasHoverRecovery(containerRef, hoveredRef));
    unmount();

    stubElementFromPoint(container);
    window.dispatchEvent(new MouseEvent('click', { clientX: 1, clientY: 1, bubbles: true }));

    // No listener left to flip it — stays at its last value.
    expect(hoveredRef.current).toBe(false);
    container.remove();
  });
});
