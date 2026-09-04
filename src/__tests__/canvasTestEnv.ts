/**
 * canvasTestEnv.ts — jsdom shims for mounting a REAL `<ReactFlow>` tree in
 * vitest (W1c). jsdom has no layout engine: every element reports a 0x0
 * `getBoundingClientRect`/`offsetWidth`/`offsetHeight`, and `ResizeObserver`
 * doesn't exist at all. React Flow needs both to measure its pane and
 * compute `fitView()`'s zoom — without this shim, `fitView` clamps to a
 * degenerate zoom (well under `ZOOM_COMPACT`), which silently hides every
 * MissionNode "full card" quick-action button in a test, not just visually
 * shrinks the canvas.
 *
 * Call `installReactFlowTestEnv()` once per test FILE (module scope, not
 * inside a `describe`/`it`) that mounts `<CanvasView/>` or a bare
 * `<ReactFlow/>` — see CanvasView.test.tsx / Cockpit.focusAndKpi.test.tsx
 * for the two real call sites. Deliberately NOT added to the shared
 * `src/__tests__/setup.ts` (out of this wave's file-ownership bounds and
 * most tests never touch React Flow at all).
 */

const PANE_WIDTH = 1200;
const PANE_HEIGHT = 800;

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

export function installReactFlowTestEnv(): void {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    // jsdom has no real ResizeObserver implementation — this stub's shape
    // (observe/unobserve/disconnect, no-arg constructor) is structurally
    // compatible with the DOM lib's ResizeObserver type, so no cast needed.
    globalThis.ResizeObserver = ResizeObserverStub;
  }

  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: PANE_WIDTH });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: PANE_HEIGHT });
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return {
      width: PANE_WIDTH,
      height: PANE_HEIGHT,
      top: 0,
      left: 0,
      right: PANE_WIDTH,
      bottom: PANE_HEIGHT,
      x: 0,
      y: 0,
      toJSON() {
        return this;
      },
    } as DOMRect;
  };
}
