/* useCanvasKeyboard.ts — the canvas's single window-level keydown listener
   (W2b refactor of CanvasView.tsx — deliverable #0, extended per W2b's own
   deliverables #2/#3/#5 with layout/zoom-to-selection/shortcuts-panel
   shortcuts). Exactly ONE `keydown` listener for the whole canvas — every
   shortcut branches out of this single effect, matching the ORIGINAL
   CanvasView.tsx doc comment on why (palette search box / note textarea /
   quick-create fields must NOT be hijacked mid-typing: `isEditableTarget`
   bails out first, since `nodrag`/`className="nodrag"` only stops React
   Flow's own drag/pan handling, not a window-level listener).

   `handlers` is read through a ref updated every render (not put directly
   in the effect's own dependency array) so CanvasView.tsx doesn't need to
   memoize a giant callback-map object just to avoid tearing down and
   re-installing the window listener on every render — the listener itself
   is only (re)installed when the REF objects it targets change, which for
   `useRef`-created refs is never after mount.
*/

import { useEffect, useRef, type RefObject } from 'react';
import type { ReactFlowInstance } from '@xyflow/react';
import { canvasStoreVanilla } from '../canvasStore';
import type { FlowPoint } from '../canvasPlacement';
import type { CanvasReactFlowEdge, CanvasReactFlowNode } from '../reconciler';
import type { ArrowDirection } from '../canvasArrowNav';

/** True when a keyboard event's target is a text-entry field (or
 *  contenteditable) — every canvas shortcut bails out here first so typing
 *  in the palette search box, a note's textarea, the quick-create modal's
 *  fields, or the toolbar's search input behaves like ordinary text input
 *  instead of triggering a canvas-level shortcut. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Maps a raw `KeyboardEvent.key` to an {@link ArrowDirection}, or `null` for
 *  any other key — the one place this hook's arrow-key branch (below) needs
 *  to know the mapping. */
function arrowKeyToDirection(key: string): ArrowDirection | null {
  if (key === 'ArrowUp') return 'up';
  if (key === 'ArrowDown') return 'down';
  if (key === 'ArrowLeft') return 'left';
  if (key === 'ArrowRight') return 'right';
  return null;
}

export interface CanvasKeyboardHandlers {
  onCopy: () => void;
  onPasteAt: (point: FlowPoint) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAddNoteAt: (point: FlowPoint) => void;
  /** No longer invoked by this hook (2026-08-15: Tab used to call this with
   *  `preventDefault()`, which killed native keyboard focus traversal
   *  whenever the pointer hovered the canvas — see the doc comment above
   *  the `!isReplaying` block below). Kept in the handlers shape so callers
   *  don't need a separate wiring path for the toolbar's own palette
   *  toggle button, which still calls it directly. */
  onTogglePalette: () => void;
  /** Escape: cancels an armed "Chaîner depuis…" AND clears any active
   *  search/status-filter (spec §5 "Escape clears"). */
  onEscape: () => void;
  /** Ctrl+L / toolbar « Ranger » (spec §5 "Auto-layout ... button + Ctrl+L"). */
  onLayoutAll: () => void;
  /** Shift+F (spec §5 "zoom-to-selection"). */
  onZoomToSelection: () => void;
  /** `?` — opens the shortcuts overlay panel. */
  onToggleShortcuts: () => void;
  /** Ctrl+K (W5b, parity checklist "keyboard-first node creation... command
   *  bar") — OPENS the command bar (idempotent, not a toggle: pressing
   *  Ctrl+K again while it's already open just keeps it open — the
   *  overlay owns its own Escape-to-close). */
  onOpenCommandBar: () => void;
  /** 'O' with exactly one selected mission/loop node (W5b, parity
   *  checklist "per-node click-to-inspect input/output"). */
  onOpenSelectedMission: () => void;
  /** 'L' — same selection rule, opens the Logs section. */
  onLogsSelectedMission: () => void;
  /** 'D' — same selection rule, opens the Diff section. */
  onDiffSelectedMission: () => void;
  /** 'H' (W9 — see lib/bus.ts's `MissionFocusSection` doc comment, which
   *  flagged this exact wiring gap) — same selection rule, opens the
   *  History section (canvas/history/RunHistoryDrawer.tsx via
   *  MissionDetail.tsx's `focusSection` effect). View-only (never mutates
   *  canvas state), so it lives alongside O/L/D below — NOT gated by
   *  `replayActive`, same rationale as those three. */
  onHistorySelectedMission: () => void;
  /** 'R' (W8d Replay, spec "entry points ... + keyboard R") — enter/exit
   *  Replay mode. Always available (never gated — it's how you LEAVE
   *  replay too), unlike every mutation shortcut below. */
  onToggleReplay: () => void;
  /** Space, ONLY while replay is active (`replayActive`, see below) —
   *  play/pause the scrub playhead. A no-op call outside replay is safe
   *  (CanvasView's handler itself checks `active`), but the key is only
   *  even DISPATCHED while active so a stray Space elsewhere on the canvas
   *  keeps its ordinary (no-op) behavior. */
  onReplayPlayPause: () => void;
  /** ArrowLeft/ArrowRight, only while replay is active — step the playhead
   *  one tick back/forward (spec "arrows (step) when replay active"). */
  onReplayStepBack: () => void;
  onReplayStepForward: () => void;
  /**
   * W-CLOSE row 1 (n8n parity, "keyboard-first node navigation" should-have
   * gap) — bare ArrowUp/Down/Left/Right with exactly one non-project node
   * selected: moves selection to the nearest node in that direction
   * (canvasArrowNav.ts's spatial-nav heuristic). A no-op when zero or more
   * than one node is selected (view-only otherwise — never invents a
   * selection). Gated out entirely while Replay is active, same rationale as
   * every other Tab/N/Delete-class shortcut in this file (see the
   * `!isReplaying` block below) — kept simple and uniform across all four
   * directions rather than allowing Up/Down only (ArrowLeft/Right are
   * already claimed by Replay's own scrub-step transport while replaying).
   */
  onArrowNav: (direction: ArrowDirection) => void;
  /**
   * W-CLOSE row 1 — Shift+Arrow: nudges every currently-selected node's
   * position by one grid step in that direction (a real canvasStore mutation
   * — `setPositions`), same gating as onArrowNav above.
   */
  onNudgeSelection: (direction: ArrowDirection) => void;
}

export interface UseCanvasKeyboardParams {
  hoveredRef: RefObject<boolean>;
  reactFlowInstanceRef: RefObject<ReactFlowInstance<CanvasReactFlowNode, CanvasReactFlowEdge> | null>;
  lastMouseClientRef: RefObject<{ x: number; y: number }>;
  resolveFlowPoint: (clientX: number, clientY: number) => FlowPoint | null;
  handlers: CanvasKeyboardHandlers;
  /**
   * W8d Replay — true while Replay mode is active. Every MUTATION shortcut
   * (undo/redo, copy/paste/duplicate, delete, add-note, auto-layout,
   * command bar) is gated out entirely while true — "block edits while
   * replaying", per the brief — since the live canvas underneath must stay
   * exactly as the real fleet last left it while the user is scrubbing
   * through history. View-only shortcuts (zoom, zoom-to-selection,
   * shortcuts panel, per-node inspect) and the new Replay transport keys
   * stay live. Defaults to `false` (every pre-existing caller/test keeps
   * its current behavior untouched).
   */
  replayActive?: boolean;
}

export function useCanvasKeyboard({
  hoveredRef,
  reactFlowInstanceRef,
  lastMouseClientRef,
  resolveFlowPoint,
  handlers,
  replayActive = false,
}: UseCanvasKeyboardParams): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  const resolveFlowPointRef = useRef(resolveFlowPoint);
  useEffect(() => {
    resolveFlowPointRef.current = resolveFlowPoint;
  }, [resolveFlowPoint]);

  const replayActiveRef = useRef(replayActive);
  useEffect(() => {
    replayActiveRef.current = replayActive;
  }, [replayActive]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (!hoveredRef.current) return;
      const instance = reactFlowInstanceRef.current;
      const h = handlersRef.current;
      const resolvePoint = resolveFlowPointRef.current;
      const isReplaying = replayActiveRef.current;

      if ((e.ctrlKey || e.metaKey) && !isEditableTarget(e.target)) {
        const key = e.key.toLowerCase();
        // R1b defect #1 — mined navigationScheme keyboard-zoom bundle
        // (Langflow's CanvasControlsDropdown split): Ctrl/Cmd+0 RESETS to
        // 100% (was fitView — that's now Ctrl/Cmd+1's job, matching the
        // "0 = actual size, 1 = fit" convention every mined repo agreed on)
        // and Ctrl/Cmd+1 fits the view. Both registered here (the single
        // raw `window` keydown listener, not react-hotkeys-hook — see this
        // hook's own module header) rather than a second listener, so
        // every canvas shortcut still funnels through one place.
        if (key === '0') {
          e.preventDefault();
          instance?.zoomTo(1, { duration: 200 });
        } else if (key === '1') {
          e.preventDefault();
          instance?.fitView({ duration: 200 });
        } else if (key === '=' || key === '+') {
          e.preventDefault();
          instance?.zoomIn();
        } else if (isReplaying) {
          // Every remaining Ctrl/Cmd shortcut below is a MUTATION
          // (undo/redo, copy/paste/duplicate, auto-layout, command bar) —
          // gated out entirely while Replay is active (W8d, "block editing
          // actions" — the live canvas underneath must stay exactly as the
          // real fleet last left it while scrubbing through history).
        } else if (key === '-') {
          e.preventDefault();
          instance?.zoomOut();
        } else if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          canvasStoreVanilla.temporal.getState().undo();
        } else if (key === 'z' || key === 'y') {
          // Ctrl+Shift+Z or Ctrl+Y — both are common redo bindings.
          e.preventDefault();
          canvasStoreVanilla.temporal.getState().redo();
        } else if (key === 'c') {
          e.preventDefault();
          h.onCopy();
        } else if (key === 'v') {
          e.preventDefault();
          const point = resolvePoint(lastMouseClientRef.current.x, lastMouseClientRef.current.y);
          if (point) h.onPasteAt(point);
        } else if (key === 'd') {
          e.preventDefault();
          h.onDuplicate();
        } else if (key === 'l') {
          e.preventDefault();
          h.onLayoutAll();
        } else if (key === 'k') {
          e.preventDefault();
          h.onOpenCommandBar();
        }
        return;
      }

      if (isEditableTarget(e.target)) return;

      // W8d Replay transport — 'R' always toggles (it's the way OUT too);
      // Space/arrows only make sense once a session is active.
      if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        h.onToggleReplay();
        return;
      }
      if (isReplaying && e.key === ' ') {
        e.preventDefault();
        h.onReplayPlayPause();
        return;
      }
      if (isReplaying && e.key === 'ArrowLeft') {
        e.preventDefault();
        h.onReplayStepBack();
        return;
      }
      if (isReplaying && e.key === 'ArrowRight') {
        e.preventDefault();
        h.onReplayStepForward();
        return;
      }

      if (e.key === 'Escape') {
        h.onEscape();
        return;
      }

      // Every remaining shortcut below either mutates the canvas or opens an
      // editing surface (N->note, Delete) — gated while replaying, same
      // rationale as the Ctrl-modified branch above. The view-only
      // shortcuts further down (Shift+F, O/L/D inspect, ?) stay live: they
      // never change canvas state.
      //
      // David's repro (2026-08-15): Tab USED to be bound here
      // (`e.preventDefault(); h.onTogglePalette();`), which made it a dead
      // key the instant the pointer hovered the canvas (`hoveredRef` gates
      // this whole listener) — `preventDefault()` on Tab suppresses the
      // browser's native focus traversal, and nothing here opened any
      // visible replacement UI. That left keyboard/screen-reader users with
      // no way to move focus at all while hovering the canvas. Tab is no
      // longer handled here — native focus traversal always works now. The
      // palette itself is still reachable via
      // `canvas-toolbar-palette-toggle-demoted` (CanvasToolbar's "⋯" menu)
      // and, if a keyboard shortcut is wanted again, should get a NON-Tab
      // binding (Ctrl/Cmd+K already opens the command bar — see
      // `onOpenCommandBar` above).
      if (!isReplaying) {
        if (e.key.toLowerCase() === 'n') {
          const point = resolvePoint(lastMouseClientRef.current.x, lastMouseClientRef.current.y);
          if (point) h.onAddNoteAt(point);
          return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          h.onDelete();
          return;
        }
        // W-CLOSE row 1 (n8n parity — see onArrowNav's own doc comment on
        // CanvasKeyboardHandlers for why this whole feature, nav AND nudge
        // alike, is gated behind `!isReplaying` rather than splitting
        // per-direction: ArrowLeft/Right are already Replay's own scrub-step
        // keys, so allowing Up/Down-only nav during replay would be a
        // confusing, direction-dependent exception rather than a clean
        // "editing is off during replay" rule.
        const arrowDirection = arrowKeyToDirection(e.key);
        if (arrowDirection) {
          e.preventDefault();
          if (e.shiftKey) h.onNudgeSelection(arrowDirection);
          else h.onArrowNav(arrowDirection);
          return;
        }
      }

      if (e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        h.onZoomToSelection();
        return;
      }
      if (e.key.toLowerCase() === 'o') {
        h.onOpenSelectedMission();
        return;
      }
      if (e.key.toLowerCase() === 'l') {
        h.onLogsSelectedMission();
        return;
      }
      if (e.key.toLowerCase() === 'd') {
        h.onDiffSelectedMission();
        return;
      }
      if (e.key.toLowerCase() === 'h') {
        h.onHistorySelectedMission();
        return;
      }
      if (e.key === '?') {
        h.onToggleShortcuts();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hoveredRef, reactFlowInstanceRef, lastMouseClientRef]);
}
