/**
 * canvasKeyboardShortcuts.test.tsx — W5b deliverables #1/#2: the Ctrl+K
 * command-bar branch and the O/L/D per-node inspect branches added to
 * useCanvasKeyboard.ts's single window keydown listener. Exercises the
 * hook directly (renderHook) with a real `window` keydown dispatch, the
 * same "real listener, synthetic KeyboardEvent" approach the hook's own
 * `isEditableTarget` contract requires (an `<input>`/`<textarea>` target
 * must suppress every branch below).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useCanvasKeyboard, type CanvasKeyboardHandlers } from '../components/agents/canvas/hooks/useCanvasKeyboard';
import type { ReactFlowInstance } from '@xyflow/react';
import type { CanvasReactFlowEdge, CanvasReactFlowNode } from '../components/agents/canvas/reconciler';

afterEach(cleanup);

function noopHandlers(overrides: Partial<CanvasKeyboardHandlers> = {}): CanvasKeyboardHandlers {
  return {
    onCopy: vi.fn(),
    onPasteAt: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onAddNoteAt: vi.fn(),
    onTogglePalette: vi.fn(),
    onEscape: vi.fn(),
    onLayoutAll: vi.fn(),
    onZoomToSelection: vi.fn(),
    onToggleShortcuts: vi.fn(),
    onOpenCommandBar: vi.fn(),
    onOpenSelectedMission: vi.fn(),
    onLogsSelectedMission: vi.fn(),
    onDiffSelectedMission: vi.fn(),
    onHistorySelectedMission: vi.fn(),
    onToggleReplay: vi.fn(),
    onReplayPlayPause: vi.fn(),
    onReplayStepBack: vi.fn(),
    onReplayStepForward: vi.fn(),
    onArrowNav: vi.fn(),
    onNudgeSelection: vi.fn(),
    ...overrides,
  };
}

function mountKeyboard(handlers: CanvasKeyboardHandlers, hovered = true, replayActive = false) {
  const hoveredRef = { current: hovered };
  const reactFlowInstanceRef = { current: null };
  const lastMouseClientRef = { current: { x: 0, y: 0 } };
  const resolveFlowPoint = vi.fn(() => ({ x: 0, y: 0 }));
  renderHook(() =>
    useCanvasKeyboard({ hoveredRef, reactFlowInstanceRef, lastMouseClientRef, resolveFlowPoint, handlers, replayActive }),
  );
  return { hoveredRef };
}

function fireKey(key: string, opts: Partial<KeyboardEventInit> = {}, target: EventTarget = window): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(event);
}

// R1b defect #1 — Ctrl+0 (reset zoom to 100%) / Ctrl+1 (fit view) keyboard
// zoom bundle (docs/superpowers/specs/2026-07-15-canvas-visual-brief.txt's
// navigationScheme: "0 = actual size, 1 = fit"). Ctrl+0 used to call
// `fitView()` (now Ctrl+1's job) — these tests pin the NEW split so a
// future regression can't silently swap them back.
// Only the 4 methods this hook actually calls (zoomTo/fitView/zoomIn/
// zoomOut) are implemented — @xyflow/react's ReactFlowInstance has ~20
// other methods (getNodes/setNodes/addNodes/...) this suite never
// exercises, so the mock is cast rather than fully implemented.
function mockReactFlowInstance(): ReactFlowInstance<CanvasReactFlowNode, CanvasReactFlowEdge> {
  return { zoomTo: vi.fn(), fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn() } as unknown as ReactFlowInstance<
    CanvasReactFlowNode,
    CanvasReactFlowEdge
  >;
}

describe('useCanvasKeyboard — Ctrl+0/Ctrl+1 keyboard zoom (R1b defect #1)', () => {
  it('Ctrl+0 resets zoom to 100% via zoomTo(1, ...), never fitView', () => {
    const handlers = noopHandlers();
    const hoveredRef = { current: true };
    const reactFlowInstanceRef = { current: mockReactFlowInstance() };
    const lastMouseClientRef = { current: { x: 0, y: 0 } };
    const resolveFlowPoint = vi.fn(() => ({ x: 0, y: 0 }));
    renderHook(() =>
      useCanvasKeyboard({ hoveredRef, reactFlowInstanceRef, lastMouseClientRef, resolveFlowPoint, handlers }),
    );
    fireKey('0', { ctrlKey: true });
    expect(reactFlowInstanceRef.current.zoomTo).toHaveBeenCalledWith(1, expect.any(Object));
    expect(reactFlowInstanceRef.current.fitView).not.toHaveBeenCalled();
  });

  it('Ctrl+1 fits the view via fitView(), never zoomTo', () => {
    const handlers = noopHandlers();
    const hoveredRef = { current: true };
    const reactFlowInstanceRef = { current: mockReactFlowInstance() };
    const lastMouseClientRef = { current: { x: 0, y: 0 } };
    const resolveFlowPoint = vi.fn(() => ({ x: 0, y: 0 }));
    renderHook(() =>
      useCanvasKeyboard({ hoveredRef, reactFlowInstanceRef, lastMouseClientRef, resolveFlowPoint, handlers }),
    );
    fireKey('1', { ctrlKey: true });
    expect(reactFlowInstanceRef.current.fitView).toHaveBeenCalledTimes(1);
    expect(reactFlowInstanceRef.current.zoomTo).not.toHaveBeenCalled();
  });
});

describe('useCanvasKeyboard — Ctrl+K opens the command bar', () => {
  it('Ctrl+K calls onOpenCommandBar while the canvas is hovered', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers);
    fireKey('k', { ctrlKey: true });
    expect(handlers.onOpenCommandBar).toHaveBeenCalledTimes(1);
  });

  it('is a no-op while the canvas is NOT hovered (matches every other shortcut)', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers, false);
    fireKey('k', { ctrlKey: true });
    expect(handlers.onOpenCommandBar).not.toHaveBeenCalled();
  });

  it('does not fire while typing in an editable field', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers);
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireKey('k', { ctrlKey: true }, input);
    expect(handlers.onOpenCommandBar).not.toHaveBeenCalled();
    input.remove();
  });
});

describe('useCanvasKeyboard — O/L/D/H per-node inspect shortcuts', () => {
  it('O calls onOpenSelectedMission, L calls onLogsSelectedMission, D calls onDiffSelectedMission, H calls onHistorySelectedMission', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers);
    fireKey('o');
    fireKey('l');
    fireKey('d');
    fireKey('h');
    expect(handlers.onOpenSelectedMission).toHaveBeenCalledTimes(1);
    expect(handlers.onLogsSelectedMission).toHaveBeenCalledTimes(1);
    expect(handlers.onDiffSelectedMission).toHaveBeenCalledTimes(1);
    expect(handlers.onHistorySelectedMission).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+L still runs auto-layout, never the Logs shortcut (different branches)', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers);
    fireKey('l', { ctrlKey: true });
    expect(handlers.onLayoutAll).toHaveBeenCalledTimes(1);
    expect(handlers.onLogsSelectedMission).not.toHaveBeenCalled();
  });

  it('does not fire O/L/D/H while typing in an editable field', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers);
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireKey('o', {}, input);
    fireKey('l', {}, input);
    fireKey('d', {}, input);
    fireKey('h', {}, input);
    expect(handlers.onOpenSelectedMission).not.toHaveBeenCalled();
    expect(handlers.onLogsSelectedMission).not.toHaveBeenCalled();
    expect(handlers.onDiffSelectedMission).not.toHaveBeenCalled();
    expect(handlers.onHistorySelectedMission).not.toHaveBeenCalled();
    input.remove();
  });

  it('H (History) stays live during Replay — view-only, same convention as O/L/D', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers, true, /* replayActive */ true);
    fireKey('h');
    expect(handlers.onHistorySelectedMission).toHaveBeenCalledTimes(1);
  });

  it('is a no-op while the canvas is NOT hovered (matches every other shortcut)', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers, false);
    fireKey('h');
    expect(handlers.onHistorySelectedMission).not.toHaveBeenCalled();
  });
});

describe('useCanvasKeyboard — W8d Replay transport (R / Space / arrows) + edit gating', () => {
  it('R always toggles Replay, even without the ctrl/cmd modifier and regardless of replayActive', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers, true, false);
    fireKey('r');
    expect(handlers.onToggleReplay).toHaveBeenCalledTimes(1);
  });

  it('Space is a no-op while replay is inactive; ArrowLeft/ArrowRight drive arrow-nav instead of replay-step', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers, true, false);
    fireKey(' ');
    fireKey('ArrowLeft');
    fireKey('ArrowRight');
    expect(handlers.onReplayPlayPause).not.toHaveBeenCalled();
    expect(handlers.onReplayStepBack).not.toHaveBeenCalled();
    expect(handlers.onReplayStepForward).not.toHaveBeenCalled();
    // W-CLOSE row 1 — outside Replay, bare arrow keys are claimed by
    // spatial-nav instead (see the dedicated describe block below).
    expect(handlers.onArrowNav).toHaveBeenCalledWith('left');
    expect(handlers.onArrowNav).toHaveBeenCalledWith('right');
  });

  it('Space/ArrowLeft/ArrowRight drive play-pause/step while replay IS active', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers, true, true);
    fireKey(' ');
    fireKey('ArrowLeft');
    fireKey('ArrowRight');
    expect(handlers.onReplayPlayPause).toHaveBeenCalledTimes(1);
    expect(handlers.onReplayStepBack).toHaveBeenCalledTimes(1);
    expect(handlers.onReplayStepForward).toHaveBeenCalledTimes(1);
  });

  it('gates every mutation shortcut (Ctrl+Z, Ctrl+D, Ctrl+L, Tab, N, Delete, arrow-nav) while replay is active', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers, true, true);
    fireKey('z', { ctrlKey: true });
    fireKey('d', { ctrlKey: true });
    fireKey('l', { ctrlKey: true });
    fireKey('k', { ctrlKey: true });
    fireKey('Tab');
    fireKey('n');
    fireKey('Delete');
    fireKey('ArrowUp'); // never claimed by Replay's own transport — proves the gate covers it too
    fireKey('ArrowUp', { shiftKey: true });
    expect(handlers.onDuplicate).not.toHaveBeenCalled();
    expect(handlers.onLayoutAll).not.toHaveBeenCalled();
    expect(handlers.onOpenCommandBar).not.toHaveBeenCalled();
    expect(handlers.onTogglePalette).not.toHaveBeenCalled();
    expect(handlers.onAddNoteAt).not.toHaveBeenCalled();
    expect(handlers.onDelete).not.toHaveBeenCalled();
    expect(handlers.onArrowNav).not.toHaveBeenCalled();
    expect(handlers.onNudgeSelection).not.toHaveBeenCalled();
  });

  it('view-only shortcuts (Shift+F, O/L/D inspect, ?) still work while replay is active', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers, true, true);
    fireKey('f', { shiftKey: true });
    fireKey('o');
    fireKey('?');
    expect(handlers.onZoomToSelection).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenSelectedMission).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleShortcuts).toHaveBeenCalledTimes(1);
  });
});

// W-CLOSE row 1 (n8n parity, "keyboard-first node navigation" should-have
// gap) — bare arrow keys move selection (canvasArrowNav.ts's spatial-nav
// heuristic, exercised on its own in canvasArrowNav.test.ts); this suite only
// proves the KEYBOARD WIRING: direction mapping, Shift = nudge instead of
// nav, the editable-target guard, and replay gating (also covered from the
// replay describe block above).
// David's repro (2026-08-15): with the pointer hovering the canvas, Tab
// used to call `e.preventDefault()` and `h.onTogglePalette()` — the
// preventDefault killed the browser's native focus traversal entirely
// (document.activeElement never moved across 5 Tab presses in the real
// app), while nothing observable opened (no [role=dialog], no command bar,
// no quick-create in the DOM). Net effect: Tab was a dead key that also
// broke keyboard/screen-reader navigation the instant the mouse hovered
// the canvas. Tab must never call preventDefault, and must not be wired to
// onTogglePalette (or anything else) from this hook any more — the palette
// stays reachable via CanvasToolbar's own button
// (`canvas-toolbar-palette-toggle-demoted`).
describe('useCanvasKeyboard — Tab is not hijacked (2026-08-15 regression)', () => {
  it('does not call preventDefault on Tab', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers);
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not call onTogglePalette on Tab', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers);
    fireKey('Tab');
    expect(handlers.onTogglePalette).not.toHaveBeenCalled();
  });

  it('does not call onTogglePalette on Tab even while replay is active', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers, true, true);
    fireKey('Tab');
    expect(handlers.onTogglePalette).not.toHaveBeenCalled();
  });

  it('does not call preventDefault on Tab typed into an editable field either', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers);
    const input = document.createElement('input');
    document.body.appendChild(input);
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(handlers.onTogglePalette).not.toHaveBeenCalled();
    input.remove();
  });
});

describe('useCanvasKeyboard — W-CLOSE row 1 arrow-key spatial nav', () => {
  it('maps each bare arrow key to onArrowNav with the right direction', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers, true, false);
    fireKey('ArrowUp');
    fireKey('ArrowDown');
    fireKey('ArrowLeft');
    fireKey('ArrowRight');
    expect(handlers.onArrowNav).toHaveBeenNthCalledWith(1, 'up');
    expect(handlers.onArrowNav).toHaveBeenNthCalledWith(2, 'down');
    expect(handlers.onArrowNav).toHaveBeenNthCalledWith(3, 'left');
    expect(handlers.onArrowNav).toHaveBeenNthCalledWith(4, 'right');
    expect(handlers.onNudgeSelection).not.toHaveBeenCalled();
  });

  it('Shift+Arrow calls onNudgeSelection instead of onArrowNav', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers, true, false);
    fireKey('ArrowUp', { shiftKey: true });
    expect(handlers.onNudgeSelection).toHaveBeenCalledWith('up');
    expect(handlers.onArrowNav).not.toHaveBeenCalled();
  });

  it('respects the editable-target guard — an arrow key typed into an input is not hijacked', () => {
    const handlers = noopHandlers();
    mountKeyboard(handlers, true, false);
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireKey('ArrowRight', {}, input);
    expect(handlers.onArrowNav).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });
});
