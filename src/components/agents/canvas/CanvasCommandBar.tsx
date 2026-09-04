/* CanvasCommandBar.tsx — Ctrl+K centered command palette (W5b, parity
   checklist "Keyboard-first node creation and navigation (search, arrow-key
   select, command bar)" — n8n's own Ctrl+K global command bar is the cited
   reference). Opened by useCanvasKeyboard.ts's Ctrl+K branch while the
   canvas is hovered (the hook's existing `hoveredRef` gate — no special
   case needed here), closed by Escape or selecting an entry.

   Fuzzy-searches THREE sources in one flat list:
     - every library agent (same `listAgents()` read CanvasPalette.tsx
       already uses — read-only picker, no duplicated agent-loading logic);
     - a synthetic "Draft vierge" entry (CanvasPalette's own BLANK_ITEM
       equivalent);
     - canvas commands (Ranger/Mode lanes/Recentrer/Focus pannes/Basculer
       minimap-snap-palette) — each just a thin call into the SAME callback
       CanvasView.tsx already wires to its toolbar button, never a second
       implementation of the action itself.

   Agent/draft selection creates a DraftSpec via `onAddDraft` — the EXACT
   same prop signature and call site CanvasPalette's click-to-add already
   uses (CanvasView.tsx passes `editing.handlePaletteAddDraft` to both), so
   there is only ever one "turn a palette/command-bar pick into a draft"
   code path.

   Rendered as an overlay sibling of `<ReactFlow>` (like
   CanvasQuickCreateModal.tsx), not a React Flow `<Panel>` — Panel only
   offers corner anchors, never a true center, and this component needs no
   live viewport/RF context.

   ── fix/canvas-command-bar-stuck-overlay (David's forensics, real packaged
      app: a click-through-proof full-viewport overlay bricked the app —
      canvas-command-bar-overlay measured `position: fixed`, `inset: 0`
      (0,0 -> 1440x844, the ENTIRE viewport), `zIndex: 2100`, covering the
      top navigation too; two Escape presses did not remove it; every click
      anywhere landed on this transparent layer instead) ──────────────────
   Two independent hardenings, both "impossible by construction" rather
   than a repro-specific patch (the trigger itself was never pinned down —
   see below for the one real structural bug this DID surface):

   1. `position: 'fixed'` (viewport-relative) -> `position: 'absolute'`
      inside this component's own nearest positioned ancestor
      (CanvasView.tsx's own outer `canvas-view` div, `position: relative`,
      the SAME anchor CanvasCommandBar already renders as a sibling of
      `<ReactFlow>` inside). `canvas-view`'s own box starts BELOW the top
      navigation by construction (AppShell.tsx's own column layout, TopNav
      then the space body) — so this overlay can no longer spatially reach
      the nav at all, regardless of z-index, regardless of any future
      z-index inflation elsewhere. `zIndex` dropped from 2100 (a value only
      ever "safe" if you assume nothing more local also wants a high
      z-index) to 40 — comfortably above this canvas's own chrome
      (ManagerOverlay/CockpitLeftRail use 40 too, Panel-hosted toolbar
      content lower) without any global-app pretensions.

   2. Escape must ALWAYS close this overlay, unconditionally, regardless of
      what currently has DOM focus. The bug this DID surface (real,
      structural, not hypothetical): the OLD code relied entirely on the
      overlay's own `onKeyDown` (React's synthetic bubbling — only fires
      when the keydown's origin is a DESCENDANT of this div, i.e. only
      while the search `<input>` — or something else inside — still has
      focus) plus useCanvasKeyboard.ts's SEPARATE window-level handler,
      which explicitly bails on any "editable target" (`isEditableTarget`)
      BEFORE its own Escape branch, and even when it doesn't bail, its
      Escape branch (`onEscape`) has no idea this overlay exists — it
      cancels an armed chain-source / clears a search filter, never
      `commandBarOpen`. The instant ANYTHING outside this overlay steals
      focus while it is open (D's own forensics: only reproduced in a busy
      session with restored conversations and live missions — exactly the
      kind of state that fires toasts/async updates that can call
      `.focus()` elsewhere), BOTH Escape paths go dead simultaneously and
      nothing in the app can ever close it again. Fixed by attaching a
      CAPTURE-phase `window` keydown listener the moment `open` becomes
      true (this component's own `useEffect`, independent of focus, of
      useCanvasKeyboard.ts, and of React's synthetic-event bubbling
      entirely) — every mount of this overlay gets its own unconditional
      dismissal path, by construction, never a focus-dependent one.
*/

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useI18n } from '../../../i18n';
import { listAgents, type StoredAgent } from '../../../lib/agents/agentsStorage';
import { MetaChip } from './chrome/nodeChrome';
import type { PaletteDraftPayload } from './CanvasPalette';

export interface CanvasCommandBarProps {
  open: boolean;
  onClose: () => void;
  /** Drops a freshly-picked agent/draft into the active project zone
   *  (undefined -> Transverse) — mirrors CanvasPalette's own prop. */
  activeProjectId?: string;
  onAddDraft: (payload: PaletteDraftPayload, projectId?: string) => void;
  onRunLayout: () => void;
  onToggleLaneMode: () => void;
  onRecenter: () => void;
  onFocusFailures: () => void;
  onToggleMinimap: () => void;
  onToggleSnap: () => void;
  onTogglePalette: () => void;
}

interface CommandBarEntry {
  id: string;
  kind: 'agent' | 'draft' | 'command';
  label: string;
  hint?: string;
  onSelect: () => void;
}

type T = (key: string) => string;

// Every entry-building function below takes `t` explicitly (rather than
// calling `useI18n()` internally) — none of them are components, so a hook
// call would be illegal; the one component call site (CanvasCommandBar
// below) resolves `t` once via its own `useI18n()` and threads it through.

function blankDraftEntry(t: T, onAddDraft: CanvasCommandBarProps['onAddDraft'], projectId?: string): CommandBarEntry {
  return {
    id: 'draft-blank',
    kind: 'draft',
    label: t('canvas.commandBar.blankDraft'),
    onSelect: () => onAddDraft({ title: t('canvas.draft.untitled'), task: '' }, projectId),
  };
}

function agentEntry(stored: StoredAgent, onAddDraft: CanvasCommandBarProps['onAddDraft'], projectId?: string): CommandBarEntry {
  const { agent } = stored;
  const title = agent.displayName || agent.name;
  return {
    id: `agent-${agent.id}`,
    kind: 'agent',
    label: title,
    hint: agent.modelTier,
    onSelect: () => onAddDraft({ title, task: '', agentName: agent.name, model: agent.modelTier }, projectId),
  };
}

function commandEntries(t: T, props: CanvasCommandBarProps): CommandBarEntry[] {
  return [
    { id: 'cmd-layout', kind: 'command', label: t('canvas.commandBar.cmdLayout'), hint: 'Ctrl+L', onSelect: props.onRunLayout },
    { id: 'cmd-lanes', kind: 'command', label: t('canvas.commandBar.cmdLanes'), onSelect: props.onToggleLaneMode },
    // fix/canvas-ux R9 BLOQUANT #1b — stale hint left over from the R1b
    // Ctrl+0/Ctrl+1 split (useCanvasKeyboard.ts, ShortcutsPanel.tsx's own
    // already-correct 'Ctrl+1'/canvas.toolbar.fit entry): before that split,
    // Ctrl+0 WAS the fitView shortcut, so this hint was accurate; R1b
    // reassigned Ctrl+0 to "reset zoom to 100%" (`zoomTo(1)`, no pan change
    // at all) and moved the real `fitView()` recenter to Ctrl+1, but this
    // command-bar entry's `hint` string was never updated to match. A user
    // (or an e2e driver reading this exact command bar to learn the
    // shortcut) pressing "Ctrl+0" to "recenter" only resets zoom and keeps
    // whatever pan the viewport already had — including a badly-panned one
    // left over from a stale focus_canvas (R9 BLOQUANT #1a) that then gets
    // persisted across restarts (canvasPersistence.ts) — so a node can sit
    // fully above the canvas pane's own clipped top edge with no visible
    // affordance to actually recenter on it. The command's own onSelect
    // (`props.onRecenter` -> `reactFlowInstanceRef.current?.fitView()`)
    // was always correct; only this display hint was stale.
    { id: 'cmd-recenter', kind: 'command', label: t('canvas.contextMenu.recenter'), hint: 'Ctrl+1', onSelect: props.onRecenter },
    { id: 'cmd-focus-failures', kind: 'command', label: t('canvas.toolbar.focusFailures'), onSelect: props.onFocusFailures },
    { id: 'cmd-minimap', kind: 'command', label: t('canvas.commandBar.cmdMinimap'), onSelect: props.onToggleMinimap },
    { id: 'cmd-snap', kind: 'command', label: t('canvas.commandBar.cmdSnap'), onSelect: props.onToggleSnap },
    { id: 'cmd-palette', kind: 'command', label: t('canvas.commandBar.cmdPalette'), hint: 'Tab', onSelect: props.onTogglePalette },
  ];
}

function matchesQuery(entry: CommandBarEntry, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return entry.label.toLowerCase().includes(needle) || (entry.hint ?? '').toLowerCase().includes(needle);
}

function kindLabel(t: T, kind: CommandBarEntry['kind']): string {
  if (kind === 'agent') return t('canvas.commandBar.kindAgent');
  if (kind === 'draft') return t('canvas.commandBar.kindDraft');
  return t('canvas.commandBar.kindCommand');
}

export function CanvasCommandBar(props: CanvasCommandBarProps) {
  const { t } = useI18n();
  const { open, onClose, activeProjectId, onAddDraft } = props;
  const [agents, setAgents] = useState<StoredAgent[]>([]);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    inputRef.current?.focus();
  }, [open]);

  // fix/canvas-command-bar-stuck-overlay — the ONLY reliable dismissal
  // path: independent of DOM focus (unlike the local onKeyDown below, which
  // only ever fires while focus is still somewhere inside this overlay) and
  // independent of useCanvasKeyboard.ts's own unrelated window-level Escape
  // branch (which has no notion of `commandBarOpen` at all — see this
  // file's own header for the exact bug this closes). Capture phase so it
  // runs before any other listener could otherwise `stopPropagation()` it
  // away. Attached/detached purely by `open` — every mount of this overlay
  // (there is no other way to render it) gets this listener, unconditionally.
  useEffect(() => {
    if (!open) return;
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onWindowKeyDown, true);
    return () => window.removeEventListener('keydown', onWindowKeyDown, true);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listAgents().then((result) => {
      if (!cancelled) setAgents(result);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const entries = useMemo<CommandBarEntry[]>(() => {
    return [
      blankDraftEntry(t, onAddDraft, activeProjectId),
      ...commandEntries(t, props),
      ...agents.map((stored) => agentEntry(stored, onAddDraft, activeProjectId)),
    ];
    // `props` itself is a fresh object every render — only its individual
    // callback fields (all `useCallback`-stable in CanvasView.tsx) matter
    // for this memo, so they're listed explicitly rather than spreading a
    // dependency on `props`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    t,
    agents,
    activeProjectId,
    onAddDraft,
    props.onRunLayout,
    props.onToggleLaneMode,
    props.onRecenter,
    props.onFocusFailures,
    props.onToggleMinimap,
    props.onToggleSnap,
    props.onTogglePalette,
  ]);

  const filtered = useMemo(() => entries.filter((entry) => matchesQuery(entry, query)), [entries, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function selectEntry(entry: CommandBarEntry | undefined): void {
    if (!entry) return;
    entry.onSelect();
    onClose();
  }

  function handleKeyDown(e: ReactKeyboardEvent): void {
    // fix/canvas-command-bar-stuck-overlay — Escape is no longer handled
    // here at all: the window-level capture-phase listener (this
    // component's own effect above) is now the SINGLE source of truth for
    // dismissal, so it never depends on this local (focus-bubbling-
    // dependent) handler still being reachable, and never double-fires
    // `onClose` for the common case where both WOULD have caught the same
    // keypress.
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      selectEntry(filtered[activeIndex]);
    }
  }

  if (!open) return null;

  return (
    <div
      data-testid="canvas-command-bar-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
      style={{
        // fix/canvas-command-bar-stuck-overlay — absolute, not fixed: scoped
        // to CanvasView.tsx's own `canvas-view` container (this component's
        // nearest `position: relative` ancestor), which starts below the
        // top navigation by construction — see this file's own header for
        // why this alone makes "covers the nav, eats every click app-wide"
        // structurally impossible rather than merely unlikely.
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '14vh',
        // Comfortably above this canvas's own local chrome (ManagerOverlay/
        // CockpitLeftRail both use 40 too) — never needed to compete with
        // anything outside `canvas-view`'s own box any more.
        zIndex: 40,
      }}
    >
      <div
        data-testid="canvas-command-bar"
        role="dialog"
        aria-modal="true"
        aria-label={t('canvas.commandBar.ariaLabel')}
        style={{
          width: 420,
          maxHeight: '55vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 12,
          background: 'var(--color-panel-2)',
          border: '1px solid rgba(255,255,255,0.14)',
          boxShadow: '4px 4px 0 rgba(0,0,0,0.4)',
          overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          type="text"
          data-testid="canvas-command-bar-search"
          placeholder={t('canvas.commandBar.searchPlaceholder')}
          aria-label={t('canvas.commandBar.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            fontSize: 13,
            padding: '11px 14px',
            border: 'none',
            borderBottom: '1px solid var(--color-border-3)',
            background: 'transparent',
            color: 'var(--color-text)',
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        <div data-testid="canvas-command-bar-list" role="listbox" style={{ overflowY: 'auto', padding: 6 }}>
          {filtered.length === 0 && (
            <p data-testid="canvas-command-bar-empty" style={{ margin: '10px 8px', fontSize: 11.5, color: 'var(--color-text-disabled)' }}>
              {t('canvas.commandBar.empty')}
            </p>
          )}
          {filtered.map((entry, index) => {
            const active = index === activeIndex;
            return (
              <div
                key={entry.id}
                data-testid={`canvas-command-bar-item-${entry.id}`}
                role="option"
                aria-selected={active}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectEntry(entry)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 9px',
                  borderRadius: 7,
                  cursor: 'pointer',
                  background: active ? 'var(--color-accent-soft, rgba(124,92,255,0.16))' : 'transparent',
                }}
              >
                <span
                  style={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                    color: 'var(--color-text-disabled)',
                    minWidth: 52,
                    flexShrink: 0,
                  }}
                >
                  {kindLabel(t, entry.kind)}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: 'var(--color-text)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {entry.label}
                </span>
                {entry.hint && <MetaChip testId={`canvas-command-bar-hint-${entry.id}`}>{entry.hint}</MetaChip>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
