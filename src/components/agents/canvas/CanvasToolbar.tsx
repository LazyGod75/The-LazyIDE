/* CanvasToolbar.tsx — top-left overlay toolbar for the Agent Canvas (W1c,
   plan §W1c "toolbar skeleton"). Deliberately minimal: fit/zoom/minimap
   toggle + the "Bibliothèque" chip AgentGrid's own header used to carry
   (spec §9: AgentGrid's zoom controls are superseded by real canvas zoom).
   W2b extends this with auto-layout/lane-mode/search/status-filters/
   focus-pannes/shortcuts per the plan's file-ownership map ("canvas/*
   components: W1b creates, W2a/W2b extend distinct files").

   Rendered as a child of `<ReactFlow>` (via `<Panel>`) so `useReactFlow()`/
   `useViewport()` resolve against the live instance without any prop
   drilling from CanvasView — the same pattern MiniMap/Controls/Background
   already rely on.

   ── R1b single-row redesign (real-gesture triage #11 + "tout doit se lire
      sur le canvas") ───────────────────────────────────────────────────
   The toolbar used to wrap onto a SECOND row (status-filter chips + "Focus
   pannes" + the eye/keyboard/Bibliothèque buttons) whenever its `flexWrap`
   ran out of room — eating ~40px of canvas height AND duplicating status
   information the task wants readable directly on nodes/zones instead
   (R1c/R2's continuing job, not this toolbar's). This pass:
     - deletes the status-filter chips outright (the underlying
       `useCanvasFilter.ts` hook/predicate is untouched — a future node/zone
       click can still drive the SAME `statusFilters`/`toggleStatusFilter`
       state; this toolbar just stops being the only affordance for it);
     - turns « Focus pannes » into a compact conditional alert icon-button
       (only rendered while `failureCount > 0`, red badge showing the
       count) instead of an always-visible pill;
     - folds « Masquer mergées » (eye), the shortcuts-panel trigger
       (keyboard), and « Bibliothèque » into one trailing "⋯" overflow menu.
   Net: one row, no wrap, ~40px of canvas height reclaimed.
*/

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Panel, useReactFlow, useViewport, getNodesBounds, getViewportForBounds } from '@xyflow/react';
import { useI18n } from '../../../i18n';
import { emit } from '../../../lib/bus';
import { useDismissable } from '../../common/useDismissable';
import { ShortcutsIcon } from './ShortcutsPanel';
import { DryRunOverlay } from './dryrun/DryRunOverlay';
import { useDryRunPreview } from './dryrun/useDryRunPreview';
import { useAgentsStoreOptional } from '../agentsStore';
import type { ApprovalMode } from '../../../lib/agents/types';
import { ensureApprovalModesLoaded, getApprovalMode, subscribeApprovalModes } from '../../../lib/agents/approvalMode';
import { ApprovalModeBadge } from './chrome/ApprovalModeBadge';
import { ApprovalModePopover } from './chrome/ApprovalModePopover';
import { StatusGlyph, statusAccentColor, type NodeLiveness } from './chrome/nodeChrome';
import {
  ARRANGE_MIN_READABLE_ZOOM,
  CANVAS_FIT_TOP_RESERVE_PX,
  DEFAULT_HORIZONTAL_GUTTER_PX,
  computeSafeMinZoom,
  insetFitViewPadding,
  measureDockedPanelInsets,
  selectWholeCanvasFitNodes,
} from './cameraInsets';
import { makeRef } from './canvasTypes';
import { TRANSVERSE_PROJECT_ID } from './reconciler';
import { classifyMissionModel } from '../../../lib/agents/runtime';
import { usdToCredits } from '../../../lib/billing/credits';

interface CanvasToolbarProps {
  minimapEnabled: boolean;
  onToggleMinimap: () => void;
  onOpenLibrary: () => void;
  /** W2a additions — undo/redo (zundo temporal, spec §5 "Ctrl+Z/
   *  Ctrl+Shift+Z"), the snap-to-grid toggle (spec §5 "Snap & guides"),
   *  and the palette drawer's open/close trigger (CanvasPalette.tsx's own
   *  doc comment: this button is the single source of truth for it). */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  snapEnabled: boolean;
  onToggleSnap: () => void;
  paletteOpen: boolean;
  onTogglePalette: () => void;
  /** W2b — auto-layout (« Ranger » / Ctrl+L, spec §5), lane mode (spec
   *  §4.3), zoom-to-selection (spec §5), search (spec §5 "Search/filter"),
   *  and the shortcuts overlay trigger (spec §5). */
  onRunLayout: () => void;
  /**
   * scratch/_canvas-label-design.md §3.3 item 5 — « Ranger » (Tidy):
   * re-packs every zone box, pinned included, without touching any mission's
   * position inside its zone (unlike `onRunLayout`'s heavier elkjs-based
   * "Auto-layout", which also re-lays-out zone children) — see
   * `useCanvasLayout.ts`'s `tidyZones` for the full rationale. Lives in the
   * same demoted `autoLayoutGroup` overflow-menu entry as `onRunLayout`
   * (fix/canvas-toolbar-oscillation's static split — see
   * `TOOLBAR_DEMOTABLE_PRIORITY`'s own doc comment above), never in the
   * always-visible row.
   */
  onTidyZones: () => void;
  laneModeEnabled: boolean;
  onToggleLaneMode: () => void;
  hasSelection: boolean;
  onZoomToSelection: () => void;
  /**
   * fix/canvas-ux R6a BLOQUANT #1c — the id of the single currently-selected
   * DRAFT node, or `null` (zero or more than one selected, or the selection
   * isn't a draft). Backs a contextual « Lancer » chip that's reachable at
   * EVERY zoom level (including `dot`, where DraftNode.tsx stays a passive
   * glyph by design — clicking a dot still selects it, React Flow's default
   * node click) — the cheap always-reachable fallback for the primary
   * launch gesture, on top of the per-card affordances DraftNode.tsx itself
   * now always renders (compact icon-button / full text button).
   */
  selectedDraftId: string | null;
  onLaunchSelectedDraft: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  /**
   * R1b — « Focus pannes » is now a conditional alert icon-button: `0`
   * hides it outright (nothing to focus, nothing to show — matches
   * useCanvasFilter's own honest-empty convention), `> 0` renders it with a
   * red badge showing the count. `onFocusFailures` keeps its original
   * behavior verbatim (filter + fitView on the matched nodes).
   */
  failureCount: number;
  onFocusFailures: () => void;
  onOpenShortcuts: () => void;
  /** W5b — « Masquer mergées » (spec §4.4 "merged nodes ... can be
   *  filtered out"). Wired straight to `prefs.hideMerged`, which
   *  reconciler.ts's `missionToChildCandidate` already honors — this is
   *  purely the missing toolbar affordance for a pref that was already
   *  fully wired end to end. Now lives inside the "⋯" overflow menu (R1b). */
  hideMergedEnabled: boolean;
  onToggleHideMerged: () => void;
  /**
   * R11 — the plain-wheel scroll behavior (CanvasPrefs.wheelMode's own doc
   * comment): `'zoom'` (new default) makes a bare wheel/trackpad scroll
   * zoom the canvas; `'scroll'` restores the earlier trackpad-first scheme
   * (plain scroll pans, ctrl+wheel/pinch zooms). Lives in the "⋯" overflow
   * menu alongside « Masquer mergées » — same always-available, rarely-
   * toggled toggle shape.
   */
  wheelMode: 'zoom' | 'scroll';
  onToggleWheelMode: () => void;
  /**
   * W8d Replay — the « Replay » entry point (also bound to the 'R' key,
   * see useCanvasKeyboard.ts). While active, every editing/mutation button
   * in this toolbar (undo/redo, snap, palette, auto-layout, lane mode,
   * dry-run, hide-merged) gets a subtle disabled overlay — the brief's
   * "block palette/context-menu edits while replaying" — since the fleet
   * data underneath must stay exactly as it really was while the user
   * scrubs through history. View-only controls (fit/zoom/minimap/search/
   * focus-failures/shortcuts) stay fully live.
   */
  replayActive: boolean;
  onToggleReplay: () => void;
  /**
   * R2b chromePlan §5 — « Rapport » overflow-menu entry, emitting the SAME
   * `report:open` bus event ProjectGroupNode.tsx's own zone-header link
   * already fires (never a second report-opening code path). Optional +
   * absent renders no menu row at all: there is no "active project" report
   * to jump to outside a real open project (CanvasView.tsx only supplies
   * this once `activeFleetProjectId` resolves — the Transverse/no-project
   * case is an honest omission, not a disabled button with nothing to do).
   */
  onOpenReport?: () => void;
  /**
   * W-CLOSE row 4 (canvas scorecard "Kestra flow-as-code" gap, pragmatic v1
   * — see canvasExportImport.ts's own module header) — « Exporter le
   * canvas » overflow-menu entry. Read-only (never gated by `replayActive`,
   * same rationale as fit/zoom/search below): a snapshot of the CURRENT
   * live canvas facts, taken whenever the user clicks it.
   */
  onExportCanvas: () => void;
  /**
   * W-CLOSE row 4 — « Importer un canvas » overflow-menu entry: receives the
   * raw `File` the browser's native file picker returned (CanvasToolbar owns
   * the `<input type="file">` DOM plumbing; CanvasView reads/parses/merges
   * it). A real mutation (merges content into the live canvas) — gated by
   * `replayActive` like every other editing action in this toolbar.
   */
  onImportCanvasFile: (file: File) => void;
  /** P8.3 — Export canvas graph as YAML workflow. */
  onExportYaml: () => void;
  /** P8.3 — Import a YAML workflow file. */
  onImportYamlFile: (file: File) => void;
  /** P8.4 — Export canvas to git directory structure. */
  onGitExport: () => void;
  /** P7.6 — Export canvas graph as MCP server config. */
  onExportMcp: () => void;
  /**
   * P47 deliverable #2 — « Suivre l'activité »: while ON, the camera
   * smoothly recenters (panel-aware, keeps zoom) on the active project's
   * mission whenever one transitions into running/review
   * (useCanvasFollowActive.ts owns the debounce/pause/transition logic;
   * this toolbar only renders the toggle affordance and reflects its
   * state).
   */
  followActiveEnabled: boolean;
  onToggleFollowActive: () => void;
}

/** P47 — the plain "⤢ Fit view" button's own vertical breathing-room
 *  fraction, matching CanvasView.tsx's own FIT_VIEW_VERTICAL_PADDING (0.2). */
const FIT_VERTICAL_PADDING = 0.2;

// R11 UI polish (f) — one consistent 28px square for every icon-only toolbar
// button (was 26x22, a slightly-squashed rectangle) plus a uniform 120ms
// transition on the properties any toggle/hover state below actually
// changes (background/color), matching the same duration every other
// interactive canvas surface (chrome/canvas.css) now shares.
//
// fix/canvas-toolbar-squeeze (David's measured repro, real packaged app:
// reserving the ManagerOverlay's lane shrank this row's own available width
// from ~1066px to ~848px — with no `flexShrink: 0` floor, flexbox's DEFAULT
// shrink behavior compressed every child proportionally instead of the row
// overflowing: the fit button measured 17px wide, was 28; text labels
// wrapped vertically mid-word, "Auto-layou / t" — the exact disease another
// wave fixed in LazyManager's own chips that same morning, a global
// `button { word-break: break-word }` rule letting an item squeeze below
// one word's width). `flexShrink: 0` is the floor: nothing in this row may
// ever compress below its own natural size again. fix/canvas-toolbar-
// oscillation Option B — what used to keep the row from overflowing once
// nothing can shrink was a live ResizeObserver-driven demotion mechanism;
// it oscillated continuously on a real machine and was reverted (see
// TOOLBAR_ALWAYS_VISIBLE_KEYS's own doc comment below), so the row now
// simply never contains more than its fixed, always-visible subset —
// everything else lives permanently in the "⋯" overflow menu instead.
// `whiteSpace`/`wordBreak` still defeat the global word-break rule
// explicitly, regardless of its own origin/scope — this floor is unrelated
// to the overflow mechanism and stays exactly as it was.
const BUTTON_STYLE: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: 'var(--color-text-secondary)',
  fontSize: 15,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'inherit',
  transition: 'background-color 120ms ease, color 120ms ease',
  flexShrink: 0,
  whiteSpace: 'nowrap',
  wordBreak: 'keep-all',
};

/** R11 UI polish (f) — the accent-tinted background an ACTIVE toggle button
 *  (minimap/snap/palette/lane-mode/dry-run) gains alongside its pre-existing
 *  accent text color, so "this is currently ON" reads as a clear filled
 *  affordance instead of relying on a text-color-only change that's easy to
 *  miss at a glance. Spread onto `BUTTON_STYLE` only when the toggle's own
 *  boolean is true — never changes the OFF look. */
const ACTIVE_TOGGLE_STYLE: CSSProperties = {
  background: 'color-mix(in srgb, var(--color-accent) 14%, transparent)',
};

/**
 * fix/canvas-toolbar-oscillation — Option B, David's own explicit fallback.
 * Two live fix attempts at a WIDTH-REACTIVE demotion mechanism (a
 * ResizeObserver-driven overflow set, then the same set plus a
 * canvas-view-derived maxWidth and hysteresis on top of it) both failed to
 * hold on a real machine: instrumented 100ms sampling caught the toolbar
 * cycling through 5 distinct button counts forever with zero user
 * interaction, on BOTH attempts, and the product owner independently
 * confirmed seeing it "buggy and flickering". "A layout that never measures
 * itself cannot oscillate" — so this priority order is now a FIXED,
 * load-time-only constant, never fed into any ResizeObserver or width
 * computation again. Index 0 is the least essential (first choice for
 * always-demoted); the LAST entries are the ones kept always-visible — see
 * TOOLBAR_ALWAYS_VISIBLE_KEYS below, which decides the split ONCE, not per
 * render. No entry ever moves between the two sets at runtime. David's own
 * explicit floor — fit / zoom / search — never appears here at all; neither
 * does the overflow-toggle itself (it IS the escape valve) nor the two
 * contextual/urgent controls (focus-failures, launch-selected-draft), which
 * stay essential rather than risk hiding a time-sensitive alert.
 */
const TOOLBAR_DEMOTABLE_PRIORITY = [
  'legend',
  'minimap',
  'undoRedo',
  'snap',
  'palette',
  'autoLayoutGroup',
  'zoomToSelection',
  'followActive',
  'replayToggle',
] as const;

type ToolbarDemotableKey = (typeof TOOLBAR_DEMOTABLE_PRIORITY)[number];

/**
 * The always-visible subset — rendered inline, unconditionally, regardless
 * of actual available width. Everything in TOOLBAR_DEMOTABLE_PRIORITY but
 * NOT in this set renders inline, unconditionally, inside the "⋯" overflow
 * menu instead (see `demotedMenuItems` below). Chosen as the three
 * cheapest/most-used controls (234px combined, well under any realistic
 * toolbar budget) so the always-visible row never has to fight for room —
 * the whole point of a static split is that it never needs to — PLUS
 * `legend`, kept always-visible for a structural reason rather than a
 * priority one: it is the only demotable control with its own positioned
 * popover (`CanvasLegendPopover`, anchored to this exact button via
 * `legendTriggerRef`); moving it into the overflow menu would leave
 * `legendOpen` toggleable with no popover left to anchor to. 268px
 * combined — still comfortably small.
 */
const TOOLBAR_ALWAYS_VISIBLE_KEYS = new Set<ToolbarDemotableKey>([
  'legend',
  'zoomToSelection',
  'followActive',
  'replayToggle',
]);

// Cheap, one-time invariant: every always-visible key must be a real
// TOOLBAR_DEMOTABLE_PRIORITY entry — catches a typo in the Set literal
// above at module-load time instead of silently rendering nothing for a
// misspelled key. Also what keeps TOOLBAR_DEMOTABLE_PRIORITY itself a real,
// used value rather than dead documentation now that neither array feeds a
// ResizeObserver any more.
for (const key of TOOLBAR_ALWAYS_VISIBLE_KEYS) {
  if (!TOOLBAR_DEMOTABLE_PRIORITY.includes(key)) {
    throw new Error(`CanvasToolbar: TOOLBAR_ALWAYS_VISIBLE_KEYS contains unknown key "${key}"`);
  }
}

const GROUP_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  background: 'var(--color-panel-3)',
  borderRadius: 8,
  padding: 2,
  // fix/canvas-toolbar-squeeze — same shrink floor as BUTTON_STYLE, one
  // level up: a GROUP (undo+redo, zoom -/pct/+, auto-layout+lane-mode+...)
  // must never compress either, only its individual buttons ever do (and
  // they no longer can).
  flexShrink: 0,
};

/** R11 UI polish (f) — a thin vertical divider between logical toolbar
 *  clusters (view controls / undo-redo+snap+palette / layout tools /
 *  selection+search+alerts), so the single unbroken row (R1b's own
 *  "never wraps" redesign) still reads as distinct groups at a glance
 *  instead of one long unbroken strip of buttons. */
function ToolbarSeparator() {
  return <div aria-hidden="true" style={{ width: 1, height: 18, background: 'var(--color-border-3)', flexShrink: 0 }} />;
}

/** Small red count badge, corner-anchored on a button — shared shape for
 *  the « Focus pannes » alert icon and the overflow "⋯" menu (a future
 *  wave could reuse this for other counted-alert affordances; kept a
 *  plain inline function rather than a new file for one 12-line shape). */
function CountBadge({ count }: { count: number }) {
  return (
    <span
      data-testid="canvas-toolbar-count-badge"
      style={{
        position: 'absolute',
        top: -4,
        right: -4,
        minWidth: 14,
        height: 14,
        padding: '0 3px',
        borderRadius: 7,
        background: 'var(--color-danger)',
        color: '#14141C',
        fontSize: 9,
        fontWeight: 800,
        fontFamily: 'var(--font-mono)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
      }}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/** Plain inline "⋯" glyph — never an emoji icon (design-system convention,
 *  see chrome/nodeChrome.tsx's TypeGlyph header). */
function OverflowIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="3.2" cy="8" r="1.4" fill="currentColor" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" />
      <circle cx="12.8" cy="8" r="1.4" fill="currentColor" />
    </svg>
  );
}

/** fix/canvas-legibility — small "key/legend" glyph (a book/list shape),
 *  never an emoji, same convention as every other toolbar icon here. */
function LegendGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="4.5" r="1.3" fill="currentColor" />
      <circle cx="4" cy="8" r="1.3" fill="currentColor" />
      <circle cx="4" cy="11.5" r="1.3" fill="currentColor" />
      <path d="M7.2 4.5h6M7.2 8h6M7.2 11.5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** W-CLEAR-FINISHED — a plain checkmark-in-tray glyph, never an emoji (same
 *  convention as every other toolbar icon here). */
function ClearFinishedGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 5.5h11l-1 8h-9l-1-8Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5.5 5.5 6.3 2.5h3.4l0.8 3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6 9l1.4 1.4L10.5 7.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** P47 deliverable #2 — a small crosshair/target glyph for the « Suivre
 *  l'activité » toggle, never an emoji (same convention as every other
 *  toolbar icon here). */
function FollowActiveGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="4.4" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" />
      <path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

const LEGEND_STATUSES: readonly NodeLiveness[] = ['running', 'queued', 'paused', 'review', 'failed', 'merged'];

interface CanvasLegendPopoverProps {
  open: boolean;
  onClose: () => void;
  /** Ref to the toggle button that opens/closes this popover — ignored by
   *  the outside-pointerdown handler so re-clicking that same button closes
   *  the popover instead of closing-then-reopening it (button and popover
   *  are DOM siblings here, not nested, so the naive listener sees the
   *  button as "outside"). See useDismissable.ts's header comment for the
   *  exact race this prevents. */
  triggerRef?: RefObject<HTMLElement | null>;
}

/**
 * fix/canvas-legibility — the toolbar's status legend: David's QA finding
 * "colors have no legend, no icons readable" — this is the direct answer,
 * mapping every {@link NodeLiveness} to its glyph + accent color + label in
 * one place, reachable at any zoom level (unlike a per-node tooltip, which
 * only ever explains ONE node at a time). Same click-away/Escape-close
 * idiom as {@link OverflowMenu} above (a plain absolutely-positioned panel,
 * not a heavier popover library — no new package.json dependency).
 */
function CanvasLegendPopover({ open, onClose, triggerRef }: CanvasLegendPopoverProps) {
  const { t } = useI18n();
  const panelRef = useDismissable<HTMLDivElement>({
    open,
    onClose,
    ignoreRefs: triggerRef ? [triggerRef] : undefined,
  });

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      data-testid="canvas-legend-popover"
      role="dialog"
      aria-label={t('canvas.legend.title')}
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        marginTop: 4,
        zIndex: 10,
        minWidth: 160,
        padding: '8px 10px',
        borderRadius: 9,
        background: 'var(--color-panel-2)',
        border: '1px solid rgba(255,255,255,0.14)',
        boxShadow: '0 10px 28px rgba(0,0,0,0.28)',
        fontFamily: 'var(--font-ui)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div data-testid="canvas-legend-title" style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {t('canvas.legend.title')}
      </div>
      {LEGEND_STATUSES.map((liveness) => (
        <div key={liveness} data-testid={`canvas-legend-status-${liveness}`} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <StatusGlyph liveness={liveness} size={11} color={statusAccentColor(liveness)} />
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusAccentColor(liveness), flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: 'var(--color-text)' }}>{t(`canvas.legend.status.${liveness}`)}</span>
        </div>
      ))}
    </div>
  );
}

interface OverflowMenuProps {
  open: boolean;
  onClose: () => void;
  hideMergedEnabled: boolean;
  onToggleHideMerged: () => void;
  wheelMode: 'zoom' | 'scroll';
  onToggleWheelMode: () => void;
  onOpenShortcuts: () => void;
  onOpenLibrary: () => void;
  onOpenReport?: () => void;
  onExportCanvas: () => void;
  onImportCanvasFile: (file: File) => void;
  onExportYaml: () => void;
  onImportYamlFile: (file: File) => void;
  onGitExport: () => void;
  onExportMcp: () => void;
  replayActive: boolean;
  editingDisabledStyle: CSSProperties;
  editingTitleSuffix: string;
  /**
   * W-MODES-ui — « Mode d'approbation par défaut » entry: the CURRENT
   * global default (approvalMode.ts's `getApprovalMode()` with no
   * projectId — CanvasToolbar.tsx owns the live subscription, this menu
   * stays a pure display + trigger). Clicking hands the row's own screen
   * rect up to `onOpenApprovalModeSelector` — CanvasToolbar renders the
   * actual `ApprovalModePopover` itself (portaled, outside this
   * conditionally-unmounted menu) rather than this component owning that
   * popover's open state, so the popover survives the overflow menu
   * closing right after the click (see CanvasToolbar's own doc comment on
   * why the two must not share a mount point).
   */
  approvalMode: ApprovalMode;
  onOpenApprovalModeSelector: (anchorRect: DOMRect) => void;
  /** Ref to the "⋯" toggle button that opens/closes this menu — ignored by
   *  the outside-pointerdown handler so re-clicking that same button closes
   *  the menu instead of closing-then-reopening it (button and menu are DOM
   *  siblings here, not nested, so the naive listener sees the button as
   *  "outside"). See useDismissable.ts's header comment for the exact race
   *  this prevents. */
  triggerRef?: RefObject<HTMLElement | null>;
  /**
   * fix/canvas-toolbar-squeeze — pre-built menu rows for whatever main-row
   * controls `TOOLBAR_DEMOTABLE_PRIORITY` currently has demoted (David's
   * own explicit ask: "move controls into the overflow menu ... instead of
   * squeezing every button"). Built by the caller (CanvasToolbar itself
   * already owns every one of these controls' onClick/active-state
   * closures) rather than this component re-deriving them — this menu
   * stays a pure renderer, never a second source of truth for what each
   * demoted control actually does. `undefined`/empty renders nothing extra
   * — the menu's own pre-existing static entries are unaffected either way.
   */
  demotedItems?: ReactNode;
}

/** R1b — the trailing "⋯" overflow menu: « Masquer mergées », the
 *  shortcuts-panel trigger, and « Bibliothèque », folded out of the main
 *  row (module header). A plain absolutely-positioned list, same shape as
 *  CanvasContextMenu.tsx's menu (click-away + Escape close) — deliberately
 *  NOT reusing that component directly (it's node/edge/pane-target shaped,
 *  a poor fit for "a handful of static toolbar actions"). */
function OverflowMenu({
  open,
  onClose,
  hideMergedEnabled,
  onToggleHideMerged,
  wheelMode,
  onToggleWheelMode,
  onOpenShortcuts,
  onOpenLibrary,
  onOpenReport,
  onExportCanvas,
  onImportCanvasFile,
  onExportYaml,
  onImportYamlFile,
  onGitExport,
  onExportMcp,
  replayActive,
  editingDisabledStyle,
  editingTitleSuffix,
  approvalMode,
  onOpenApprovalModeSelector,
  triggerRef,
  demotedItems,
}: OverflowMenuProps) {
  const { t } = useI18n();
  const menuRef = useDismissable<HTMLDivElement>({
    open,
    onClose,
    ignoreRefs: triggerRef ? [triggerRef] : undefined,
  });
  const importInputRef = useRef<HTMLInputElement>(null);
  const yamlInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  return (
    <div
      ref={menuRef}
      data-testid="canvas-toolbar-overflow-menu"
      role="menu"
      style={{
        position: 'absolute',
        top: '100%',
        right: 0,
        marginTop: 4,
        zIndex: 10,
        minWidth: 180,
        padding: 4,
        borderRadius: 9,
        background: 'var(--color-panel-2)',
        border: '1px solid rgba(255,255,255,0.14)',
        boxShadow: '0 10px 28px rgba(0,0,0,0.28)',
        fontFamily: 'var(--font-ui)',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      {/* fix/canvas-toolbar-squeeze — demoted main-row controls, when any
          are currently overflowed, precede this menu's own pre-existing
          static entries, separated by a divider — see this component's own
          `demotedItems` prop doc comment. */}
      {demotedItems && (
        <>
          <div data-testid="canvas-toolbar-demoted-items" role="group" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {demotedItems}
          </div>
          <div style={{ height: 1, background: 'var(--color-border-3)', margin: '4px 0' }} />
        </>
      )}
      <button
        type="button"
        data-testid="canvas-toolbar-hide-merged"
        role="menuitem"
        onClick={() => {
          onToggleHideMerged();
        }}
        disabled={replayActive}
        aria-pressed={hideMergedEnabled}
        style={{
          ...MENU_ITEM_STYLE,
          color: hideMergedEnabled ? 'var(--color-accent)' : 'var(--color-text)',
          ...(hideMergedEnabled ? ACTIVE_TOGGLE_STYLE : {}),
          ...editingDisabledStyle,
        }}
        title={t('canvas.toolbar.hideMerged') + editingTitleSuffix}
      >
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M2 8c1.6-3 4-4.5 6-4.5S12.4 5 14 8c-1.6 3-4 4.5-6 4.5S3.6 11 2 8Z" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="8" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.4" />
          {hideMergedEnabled && <path d="M2.5 2.5 13.5 13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
        </svg>
        {t('canvas.toolbar.hideMerged')}
      </button>
      {/* R11 — plain-wheel scroll behavior toggle (CanvasPrefs.wheelMode's
          own doc comment). Never gated by `replayActive`: it's a view
          preference, not a canvas mutation. */}
      <button
        type="button"
        data-testid="canvas-toolbar-wheel-mode"
        role="menuitem"
        onClick={() => {
          onToggleWheelMode();
        }}
        aria-pressed={wheelMode === 'scroll'}
        style={{
          ...MENU_ITEM_STYLE,
          color: wheelMode === 'scroll' ? 'var(--color-accent)' : 'var(--color-text)',
          ...(wheelMode === 'scroll' ? ACTIVE_TOGGLE_STYLE : {}),
        }}
        title={t('canvas.toolbar.wheelModeTitle')}
      >
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <rect x="4.5" y="1.5" width="7" height="13" rx="3.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 4.2v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        {t('canvas.toolbar.wheelMode')}: {t(wheelMode === 'zoom' ? 'canvas.toolbar.wheelModeZoom' : 'canvas.toolbar.wheelModeScroll')}
      </button>
      {/* W-MODES-ui — global default approval mode selector: same 3-option
          ApprovalModePopover the zone-header badge opens, anchored to
          THIS row (CanvasToolbar renders it, see OverflowMenuProps'
          `onOpenApprovalModeSelector` doc comment for why). */}
      <button
        type="button"
        data-testid="canvas-toolbar-approval-mode-default"
        role="menuitem"
        onClick={(e) => {
          onOpenApprovalModeSelector(e.currentTarget.getBoundingClientRect());
          onClose();
        }}
        style={{ ...MENU_ITEM_STYLE, justifyContent: 'space-between' }}
        title={t('canvas.zone.approvalMode.selectorTitle')}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path d="M8 1.5 13.5 4v4.8c0 3.3-2.3 5.6-5.5 6.7-3.2-1.1-5.5-3.4-5.5-6.7V4L8 1.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
          {t('canvas.toolbar.approvalModeDefault')}
        </span>
        <ApprovalModeBadge mode={approvalMode} testId="canvas-toolbar-approval-mode-default-badge" />
      </button>
      <button
        type="button"
        data-testid="canvas-toolbar-shortcuts"
        role="menuitem"
        onClick={() => {
          onOpenShortcuts();
          onClose();
        }}
        style={MENU_ITEM_STYLE}
        title={t('canvas.toolbar.shortcutsTitle')}
      >
        <ShortcutsIcon size={14} />
        {t('canvas.shortcuts.title')}
      </button>
      <button
        type="button"
        data-testid="open-library-chip"
        role="menuitem"
        onClick={() => {
          onOpenLibrary();
          onClose();
        }}
        style={MENU_ITEM_STYLE}
      >
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M2 3.5h4.6L8 5h6v7.5H2V3.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
        {t('cockpit.grid.library')}
      </button>
      {/* R2b chromePlan §5 — « Rapport » for the ACTIVE project, emitting
          the pre-existing `report:open` bus event (ProjectGroupNode.tsx's
          zone-header link fires the identical event; this is a second
          entry point onto the SAME contract, not a new one). */}
      {onOpenReport && (
        <button
          type="button"
          data-testid="canvas-toolbar-open-report"
          role="menuitem"
          onClick={() => {
            onOpenReport();
            onClose();
          }}
          style={MENU_ITEM_STYLE}
          title={t('canvas.node.openReport')}
        >
          <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path d="M3 13V7M8 13V3M13 13V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t('canvas.node.openReport')}
        </button>
      )}
      {/* W-CLOSE row 4 — "flow-as-code" v1 (canvasExportImport.ts's own doc
          comment for why this is a Blob download / file-picker upload, not
          the sandboxed project-scoped fs commands the rest of this app
          uses). Export is read-only (never gated by replayActive); import
          is a real mutation (gated, like every other editing entry above). */}
      <button
        type="button"
        data-testid="canvas-toolbar-export"
        role="menuitem"
        onClick={() => {
          onExportCanvas();
          onClose();
        }}
        style={MENU_ITEM_STYLE}
        title={t('canvas.toolbar.exportTitle')}
      >
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 12.5h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t('canvas.toolbar.exportCanvas')}
      </button>
      <button
        type="button"
        data-testid="canvas-toolbar-import"
        role="menuitem"
        disabled={replayActive}
        onClick={() => importInputRef.current?.click()}
        style={{ ...MENU_ITEM_STYLE, ...editingDisabledStyle }}
        title={t('canvas.toolbar.importTitle') + editingTitleSuffix}
      >
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M8 10V2M4.5 5.5 8 2l3.5 3.5M2.5 12.5h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t('canvas.toolbar.importCanvas')}
      </button>
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        data-testid="canvas-toolbar-import-input"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // reset so re-picking the SAME filename re-fires onChange next time
          if (file) onImportCanvasFile(file);
          onClose();
        }}
      />
      {/* P8.3 — YAML workflow export/import (yamlWorkflowImport.ts) */}
      <div style={{ height: 1, background: 'var(--color-border-3)', margin: '4px 0' }} />
      <button
        type="button"
        data-testid="canvas-toolbar-export-yaml"
        role="menuitem"
        onClick={() => {
          onExportYaml();
          onClose();
        }}
        style={MENU_ITEM_STYLE}
        title={t('canvas.toolbar.exportYamlTitle')}
      >
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M2 3.5h4.6L8 5h6v7.5H2V3.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M5 8h6M5 10h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        {t('canvas.toolbar.exportYaml')}
      </button>
      <button
        type="button"
        data-testid="canvas-toolbar-import-yaml"
        role="menuitem"
        disabled={replayActive}
        onClick={() => yamlInputRef.current?.click()}
        style={{ ...MENU_ITEM_STYLE, ...editingDisabledStyle }}
        title={t('canvas.toolbar.importYaml')}
      >
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M8 10V2M4.5 5.5 8 2l3.5 3.5M2.5 12.5h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t('canvas.toolbar.importYaml')}
      </button>
      <input
        ref={yamlInputRef}
        type="file"
        accept=".yaml,.yml,application/yaml,text/yaml"
        data-testid="canvas-toolbar-import-yaml-input"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onImportYamlFile(file);
          onClose();
        }}
      />
      {/* P8.4 — Canvas to Git export (canvasGitExport.ts) */}
      <button
        type="button"
        data-testid="canvas-toolbar-git-export"
        role="menuitem"
        onClick={() => {
          onGitExport();
          onClose();
        }}
        style={MENU_ITEM_STYLE}
        title={t('canvas.toolbar.gitExportTitle')}
      >
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <circle cx="4.5" cy="3" r="2" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="4.5" cy="13" r="2" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="11.5" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M4.5 5v6M6.5 8h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        {t('canvas.toolbar.gitExport')}
      </button>
      {/* P7.6 — Export canvas as MCP server config (graphMcpPublisher.ts) */}
      <button
        type="button"
        data-testid="canvas-toolbar-export-mcp"
        role="menuitem"
        onClick={() => {
          onExportMcp();
          onClose();
        }}
        style={MENU_ITEM_STYLE}
        title={t('canvas.toolbar.exportMcpTitle')}
      >
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5 6h6M5 8h4M5 10h6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
        {t('canvas.toolbar.exportMcp')}
      </button>
    </div>
  );
}

const MENU_ITEM_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  textAlign: 'left',
  fontSize: 12,
  fontWeight: 600,
  padding: '6px 10px',
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: 'var(--color-text)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
  transition: 'background-color 120ms ease, color 120ms ease',
};

export function CanvasToolbar({
  minimapEnabled,
  onToggleMinimap,
  onOpenLibrary,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  snapEnabled,
  onToggleSnap,
  paletteOpen,
  onTogglePalette,
  onRunLayout,
  onTidyZones,
  laneModeEnabled,
  onToggleLaneMode,
  hasSelection,
  onZoomToSelection,
  selectedDraftId,
  onLaunchSelectedDraft,
  searchQuery,
  onSearchChange,
  failureCount,
  onFocusFailures,
  onOpenShortcuts,
  hideMergedEnabled,
  onToggleHideMerged,
  wheelMode,
  onToggleWheelMode,
  replayActive,
  onToggleReplay,
  onOpenReport,
  onExportCanvas,
  onImportCanvasFile,
  onExportYaml,
  onImportYamlFile,
  onGitExport,
  onExportMcp,
  followActiveEnabled,
  onToggleFollowActive,
}: CanvasToolbarProps) {
  const { t } = useI18n();
  const { zoomIn, zoomOut, getNodes, setViewport } = useReactFlow();
  const { zoom } = useViewport();
  const [overflowOpen, setOverflowOpen] = useState(false);
  // Founder bug fix audit (2026-07-22): forwarded to OverflowMenu's
  // `triggerRef` so its outside-pointerdown handler ignores re-clicks on
  // this "⋯" toggle button — see useDismissable.ts's header comment. This
  // is the founder's day-one "⋯ Plus d'outils" complaint.
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  // P47 — this toolbar renders inside `<ReactFlow>` (module header), itself
  // a sibling of ManagerOverlay/CockpitLeftRail under `cockpit-fullbleed-
  // root` (see cameraInsets.ts's own doc comment) — any node in that tree
  // qualifies as the `measureDockedPanelInsets` anchor, so this component's
  // own root div works without any extra prop drilling from CanvasView.
  const toolbarRootRef = useRef<HTMLDivElement | null>(null);
  // fix/canvas-collapse-reservation (David's round-8 report, after
  // fix/canvas-fit-stale-container already made "fit" measure the LIVE
  // container correctly: "the maths is right, the input is wrong" — the
  // canvas container itself stayed the OLD, narrower width after the
  // manager overlay collapsed, so a correct fit computation still landed on
  // the same cramped zoom until the user clicked the button again). The fit
  // computation itself (measure `canvas-view`'s current rect, resolve the
  // top-level node bounds, apply the SAME `getViewportForBounds` +
  // `setViewport` pair fix/canvas-fit-stale-container introduced) is
  // extracted here so it can run from TWO triggers instead of one: the
  // button's own onClick (unchanged), and a `ResizeObserver` on that SAME
  // container (below) — "the view is usable immediately rather than after
  // the user clicks fit again" (David's own words) means the canvas must
  // react to ITS OWN container actually changing size, not wait for a
  // second deliberate click.
  const runFit = useCallback(() => {
    const insets = measureDockedPanelInsets(toolbarRootRef.current);
    // fix/canvas-toolbar-fit-floor — floors the top padding at
    // CANVAS_FIT_TOP_RESERVE_PX (toolbar footprint + the floating zone-title
    // plaque's own screen footprint above the node box) regardless of what
    // the real DOM measurement above resolves to this call — see that
    // constant's own doc comment for the real-app repro this closes: the
    // first row of zone PLAQUES landing under the toolbar even once the
    // node boxes themselves cleared it.
    const padding = insetFitViewPadding(insets, FIT_VERTICAL_PADDING, DEFAULT_HORIZONTAL_GUTTER_PX, CANVAS_FIT_TOP_RESERVE_PX);
    const containerEl = toolbarRootRef.current?.closest('[data-testid="canvas-view"]');
    const containerRect = containerEl instanceof HTMLElement ? containerEl.getBoundingClientRect() : { width: 0, height: 0 };
    // fix/canvas-fit-instrumentation — bounds fed to the viewport
    // computation are TOP-LEVEL zone nodes only: `getNodesBounds` on the
    // FULL node list (including parent-relative CHILD nodes) silently
    // treats each child's relative `.position` as if it were already
    // absolute, inflating/distorting the box for some node arrangements —
    // confirmed directly: a synthetic parent+child pair at
    // (1000,2000)+(24,36) round-trips through the unfiltered call as
    // {x:24,y:36,width:1276,height:2264} instead of the real ~300x300 the
    // parent's own box implies.
    //
    // fix/canvas-transverse-fit-outlier — top-level ALSO excludes the
    // synthetic Transverse zone (falling back to every top-level node when
    // it's the only content) — see `selectWholeCanvasFitNodes`'s own doc
    // comment (cameraInsets.ts) for the measured regression this closes: a
    // Transverse zone at a stale/far position has no ceiling on how far it
    // can drag the WHOLE canvas's zoom down, since `computeSafeMinZoom`
    // below deliberately never clips real content off-screen to hold a
    // floor. "Fit view" now frames the user's open PROJECT zones — the
    // primary work surface a fit click is for — not every orphaned/
    // not-yet-assigned node still reachable by panning.
    const transverseRef = makeRef('project', TRANSVERSE_PROJECT_ID);
    const topLevelNodes = selectWholeCanvasFitNodes(getNodes(), transverseRef);
    const modelBounds = getNodesBounds(topLevelNodes);
    const minZoom = computeSafeMinZoom(modelBounds, containerRect, padding, ARRANGE_MIN_READABLE_ZOOM, getViewportForBounds);
    // fix/canvas-fit-stale-container — never delegate to React Flow's own
    // `fitView()`, which resolves against ITS OWN internally-tracked
    // width/height rather than the `containerRect` just measured above.
    // `getViewportForBounds` (the SAME pure function `computeSafeMinZoom`
    // just called) computes the actual target viewport from that SAME
    // fresh measurement; `setViewport` applies it directly.
    const targetViewport = getViewportForBounds(modelBounds, containerRect.width, containerRect.height, minZoom, 2, padding);
    void setViewport(targetViewport);
  }, [getNodes, setViewport]);
  // Re-measure/re-fit whenever the canvas-view container's OWN box
  // actually changes size — manager overlay collapse/expand (the round-8
  // repro), a drag-resize of the overlay, or a plain window resize all flow
  // through here uniformly, since they all change the SAME element's real
  // rendered width. `ResizeObserver`'s callback fires once immediately on
  // `observe()` with the size at that moment — skipped via `isFirstRunRef`
  // so mounting never triggers an unsolicited fit (the app's own initial
  // arrange/fit path, useCanvasLayout.ts's `fitViewAfterLayout`, already
  // owns that moment); every observation AFTER the first is a real change.
  const isFirstResizeRef = useRef(true);
  useEffect(() => {
    const containerEl = toolbarRootRef.current?.closest('[data-testid="canvas-view"]');
    if (!(containerEl instanceof HTMLElement) || typeof ResizeObserver === 'undefined') return;
    isFirstResizeRef.current = true;
    const observer = new ResizeObserver(() => {
      if (isFirstResizeRef.current) {
        isFirstResizeRef.current = false;
        return;
      }
      runFit();
    });
    observer.observe(containerEl);
    return () => observer.disconnect();
  }, [runFit]);
  // fix/canvas-toolbar-oscillation Option B — no measurement here at all
  // any more. Two prior attempts in this same spot (a ResizeObserver on the
  // demotable region alone, then a second ResizeObserver on `canvas-view`
  // feeding a computed `maxWidth` plus hysteresis) both produced a live,
  // continuous, zero-interaction oscillation on a real machine, confirmed by
  // instrumented sampling AND by the product owner's own report. Every
  // button's visibility is now decided once, at module load, by
  // TOOLBAR_ALWAYS_VISIBLE_KEYS above — never by anything this component
  // measures about its own rendered size. See that constant's doc comment
  // for the full history and the reasoning ("a layout that never measures
  // itself cannot oscillate").
  // fix/canvas-legibility — the status legend popover (own open state,
  // independent of the "⋯" overflow menu above — a quick-reference panel
  // the user may want open WHILE using other toolbar controls, unlike the
  // overflow menu's own action-list shape).
  const [legendOpen, setLegendOpen] = useState(false);
  // 2026-08-09 (real-user request: "mets le bouton ⚡ Command dans la barre
  // en haut du canvas et enlève le bouton flottant"). Reads the SAME
  // persisted `lazy.cockpitMode` the Cockpit's floating toggle used (see
  // Cockpit.tsx), so both surfaces agree; the toolbar button is the only
  // affordance left after the floating one is removed.
  const [cockpitMode, setCockpitMode] = useState<'command' | 'construction'>(() => {
    try { return (localStorage.getItem('lazy.cockpitMode') as 'command' | 'construction') || 'construction'; }
    catch { return 'construction'; }
  });
  useEffect(() => {
    try { localStorage.setItem('lazy.cockpitMode', cockpitMode); } catch { /* ignore */ }
  }, [cockpitMode]);
  const toggleCockpitMode = useCallback(() => {
    setCockpitMode((m) => {
      const next = m === 'command' ? 'construction' : 'command';
      emit('cockpit:modeChange', { mode: next });
      return next;
    });
  }, []);
  // Founder bug fix audit (2026-07-22): forwarded to CanvasLegendPopover's
  // `triggerRef` so its outside-pointerdown handler ignores re-clicks on
  // this toggle button — see useDismissable.ts's header comment.
  const legendTriggerRef = useRef<HTMLButtonElement>(null);
  // W8a deliverable #3 — dry-run chain preview: self-contained (reads the
  // live graph via useReactFlow, renders its own overlay), mounted HERE per
  // the brief (not CanvasView). The pane context-menu entry reaches it
  // through dryrun/dryRunSignal.ts.
  const dryRun = useDryRunPreview();
  // W-MODES-ui — global default approval mode: approvalMode.ts is a
  // module-singleton store (same shape as objectivesStore.ts, not itself
  // reactive React state — see fleetMissions.ts's own approvalModeVersion
  // doc comment for the identical pattern), so this local state + the
  // subscribeApprovalModes listener below is what makes the overflow menu's
  // badge live (a manager set_approval_mode action, or another canvas
  // tab/window, must be reflected here too, not just this popover's own
  // onSelect).
  const agentsStore = useAgentsStoreOptional();
  // W-CLEAR-FINISHED — canvas-wide "Nettoyer les terminées" (recon finding:
  // the existing "Archiver les terminées" only ever lives per-zone,
  // CanvasContextMenu.tsx's `projectEntries`). Reads `agentsStore.missions`
  // DIRECTLY rather than the reconciled `nodes` list the per-zone action
  // uses (CanvasContextMenu.tsx's own `terminalMissionIdsInZone`) — that
  // list only ever contains CURRENTLY-RENDERED mission nodes, which misses
  // every mission sitting inside a COLLAPSED zone (reconcilerZones.ts's
  // `isCollapsed -> placed: []`) or a project the canvas doesn't currently
  // have open at all. `archiveTerminalMissions` (agentsStore.tsx) itself
  // filters ONLY by `missionIds`/`archived`/`status` against its OWN full
  // `state.missions` — never scoped to `activeProjectId` — so passing it
  // every terminal, not-yet-archived mission id across the ENTIRE fleet
  // here is the actually-correct "across all zones" behavior, a strictly
  // wider (and more honest) reach than the per-zone action's own currently-
  // rendered-only scope.
  const terminalMissionIds = useMemo(
    () =>
      (agentsStore?.missions ?? [])
        .filter((m) => !m.archived && (m.status === 'done' || m.status === 'failed' || m.status === 'cancelled'))
        .map((m) => m.id),
    [agentsStore?.missions],
  );

  const fleetRunning = useMemo(
    () => (agentsStore?.missions ?? []).filter((m) => !m.archived && m.status === 'running' && !m.paused).length,
    [agentsStore?.missions],
  );
  const fleetReview = useMemo(
    () => (agentsStore?.missions ?? []).filter((m) => !m.archived && m.status === 'review').length,
    [agentsStore?.missions],
  );
  // LazyCredits, never $ (owner's standing rule, 2026-08-22: the fleet
  // summary used to render a raw `$86.28` while every per-mission chip on
  // the very same canvas speaks credits). Rail-aware like CostChip: spend
  // routed through the user's own CLI subscription (classifyMissionModel
  // === 'native') is ZERO debited — it shows as an explicit "0" with an
  // abonnement note instead of silently inflating the total.
  const fleetCost = useMemo(() => {
    let debitedUsd = 0;
    let nativeUsd = 0;
    for (const m of agentsStore?.missions ?? []) {
      const c = m.agentMetrics?.costUsd ?? 0;
      if (!c) continue;
      if (classifyMissionModel(m.model) === 'native') nativeUsd += c;
      else debitedUsd += c;
    }
    return { debitedCredits: usdToCredits(debitedUsd), nativeCredits: usdToCredits(nativeUsd), any: debitedUsd + nativeUsd > 0 };
  }, [agentsStore?.missions]);
  const [globalApprovalMode, setGlobalApprovalMode] = useState<ApprovalMode>(() => getApprovalMode());
  const [approvalAnchorRect, setApprovalAnchorRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    void ensureApprovalModesLoaded().then(() => setGlobalApprovalMode(getApprovalMode()));
    return subscribeApprovalModes(() => setGlobalApprovalMode(getApprovalMode()));
  }, []);
  // W8d Replay — editing controls below get this disabled treatment; a
  // shared style/title suffix keeps every gate visually/semantically
  // identical instead of six ad hoc copies.
  const editingDisabledStyle: CSSProperties = replayActive ? { opacity: 0.35, cursor: 'default' } : {};
  const editingTitleSuffix = replayActive ? ` (${t('canvas.replay.editingDisabled')})` : '';

  // fix/canvas-toolbar-squeeze — one plain menu row per demoted control,
  // reusing the SAME onClick/active-state closures the main row's own
  // buttons use — never a second implementation of what a control does,
  // only where it renders. `undoRedo`/`autoLayoutGroup` demote MULTIPLE
  // actual controls at once (they were already grouped in the main row), so
  // they contribute more than one row each.
  // fix/canvas-toolbar-oscillation Option B — every key NOT in
  // TOOLBAR_ALWAYS_VISIBLE_KEYS lands here, permanently, regardless of
  // width. This is not a fallback path; it is the ONLY place these six
  // controls ever render.
  const demotedMenuItems: ReactNode = (
    <>
      {!TOOLBAR_ALWAYS_VISIBLE_KEYS.has('minimap') && (
        <button type="button" data-testid="canvas-toolbar-minimap-toggle-demoted" role="menuitem" onClick={onToggleMinimap} aria-pressed={minimapEnabled} style={{ ...MENU_ITEM_STYLE, color: minimapEnabled ? 'var(--color-accent)' : 'var(--color-text)' }}>
          ▦ {t('canvas.minimap.toggle')}
        </button>
      )}
      {!TOOLBAR_ALWAYS_VISIBLE_KEYS.has('legend') && (
        <button type="button" data-testid="canvas-toolbar-legend-toggle-demoted" role="menuitem" onClick={() => setLegendOpen((v) => !v)} aria-pressed={legendOpen} style={{ ...MENU_ITEM_STYLE, color: legendOpen ? 'var(--color-accent)' : 'var(--color-text)' }}>
          <LegendGlyph /> {t('canvas.legend.toggleTitle')}
        </button>
      )}
      {!TOOLBAR_ALWAYS_VISIBLE_KEYS.has('undoRedo') && (
        <>
          <button type="button" data-testid="canvas-toolbar-undo-demoted" role="menuitem" onClick={onUndo} disabled={!canUndo || replayActive} style={{ ...MENU_ITEM_STYLE, opacity: canUndo ? 1 : 0.5, ...editingDisabledStyle }}>
            ↺ {t('canvas.toolbar.undo')}
          </button>
          <button type="button" data-testid="canvas-toolbar-redo-demoted" role="menuitem" onClick={onRedo} disabled={!canRedo || replayActive} style={{ ...MENU_ITEM_STYLE, opacity: canRedo ? 1 : 0.5, ...editingDisabledStyle }}>
            ↻ {t('canvas.toolbar.redo')}
          </button>
        </>
      )}
      {!TOOLBAR_ALWAYS_VISIBLE_KEYS.has('snap') && (
        <button type="button" data-testid="canvas-toolbar-snap-toggle-demoted" role="menuitem" onClick={onToggleSnap} disabled={replayActive} aria-pressed={snapEnabled} style={{ ...MENU_ITEM_STYLE, color: snapEnabled ? 'var(--color-accent)' : 'var(--color-text)', ...editingDisabledStyle }}>
          # {t('canvas.toolbar.snapToGrid')}
        </button>
      )}
      {!TOOLBAR_ALWAYS_VISIBLE_KEYS.has('palette') && (
        <button type="button" data-testid="canvas-toolbar-palette-toggle-demoted" role="menuitem" onClick={onTogglePalette} disabled={replayActive} aria-pressed={paletteOpen} style={{ ...MENU_ITEM_STYLE, color: paletteOpen ? 'var(--color-accent)' : 'var(--color-text)', ...editingDisabledStyle }}>
          + {t('canvas.toolbar.palette')}
        </button>
      )}
      {!TOOLBAR_ALWAYS_VISIBLE_KEYS.has('autoLayoutGroup') && (
        <>
          <button type="button" data-testid="canvas-toolbar-auto-layout-demoted" role="menuitem" onClick={onRunLayout} disabled={replayActive} style={{ ...MENU_ITEM_STYLE, ...editingDisabledStyle }}>
            {t('canvas.toolbar.autoLayout')}
          </button>
          {/* scratch/_canvas-label-design.md §3.3 item 5 — « Ranger »: the
              lighter, zone-boxes-only sibling of the auto-layout button
              above (see `onTidyZones`'s own prop doc comment). */}
          <button
            type="button"
            data-testid="canvas-toolbar-tidy-zones-demoted"
            role="menuitem"
            onClick={onTidyZones}
            disabled={replayActive}
            style={{ ...MENU_ITEM_STYLE, ...editingDisabledStyle }}
            title={t('canvas.toolbar.tidyZonesTitle') + editingTitleSuffix}
          >
            {t('canvas.toolbar.tidyZones')}
          </button>
          <button type="button" data-testid="canvas-toolbar-lane-mode-demoted" role="menuitem" onClick={onToggleLaneMode} disabled={replayActive} aria-pressed={laneModeEnabled} style={{ ...MENU_ITEM_STYLE, color: laneModeEnabled ? 'var(--color-accent)' : 'var(--color-text)', ...editingDisabledStyle }}>
            {t('canvas.toolbar.laneMode')}
          </button>
          <button type="button" data-testid="canvas-toolbar-dry-run-demoted" role="menuitem" onClick={dryRun.start} disabled={replayActive} aria-pressed={dryRun.session !== null} style={{ ...MENU_ITEM_STYLE, color: dryRun.session ? 'var(--color-accent)' : 'var(--color-text)', ...editingDisabledStyle }}>
            {t('canvas.dryrun.simulate')}
          </button>
          <button type="button" data-testid="canvas-toolbar-cockpit-mode-demoted" role="menuitem" onClick={toggleCockpitMode} style={{ ...MENU_ITEM_STYLE, color: cockpitMode === 'command' ? 'var(--color-accent)' : 'var(--color-text)' }}>
            {cockpitMode === 'command' ? t('cockpit.mode.construction') : t('cockpit.mode.command')}
          </button>
        </>
      )}
      {!TOOLBAR_ALWAYS_VISIBLE_KEYS.has('zoomToSelection') && (
        <button type="button" data-testid="canvas-toolbar-zoom-to-selection-demoted" role="menuitem" onClick={onZoomToSelection} disabled={!hasSelection} style={{ ...MENU_ITEM_STYLE, opacity: hasSelection ? 1 : 0.5 }}>
          ⌖ {t('canvas.toolbar.zoomToSelection')}
        </button>
      )}
      {!TOOLBAR_ALWAYS_VISIBLE_KEYS.has('followActive') && (
        <button type="button" data-testid="canvas-toolbar-follow-active-demoted" role="menuitem" onClick={onToggleFollowActive} aria-pressed={followActiveEnabled} style={{ ...MENU_ITEM_STYLE, color: followActiveEnabled ? 'var(--color-accent)' : 'var(--color-text)' }}>
          <FollowActiveGlyph /> {t('canvas.follow.toggle')}
        </button>
      )}
      {!TOOLBAR_ALWAYS_VISIBLE_KEYS.has('replayToggle') && (
        <button type="button" data-testid="canvas-toolbar-replay-toggle-demoted" role="menuitem" onClick={onToggleReplay} aria-pressed={replayActive} style={{ ...MENU_ITEM_STYLE, color: replayActive ? 'var(--color-danger)' : 'var(--color-text)' }}>
          {t('canvas.replay.toggle')}
        </button>
      )}
    </>
  );

  return (
    <>
      {dryRun.session && !replayActive && <DryRunOverlay session={dryRun.session} onReplay={dryRun.replay} onClose={dryRun.stop} />}
      <Panel position="top-left">
      <div
        ref={toolbarRootRef}
        data-testid="canvas-toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'nowrap',
          gap: 6,
          padding: 4,
          borderRadius: 10,
          background: '#14141c',
          border: '1px solid var(--color-border)',
          boxShadow: '0 10px 28px rgba(0,0,0,0.28)',
          position: 'relative',
        }}
      >
        <button
          type="button"
          data-testid="canvas-toolbar-fit"
          // W-CAMERA — deferred one frame (same rationale as
          // useCanvasLayout.ts's post-arrange `fitViewAfterLayout`
          // call/useCanvasManagerEvents.ts's `doFocus`): a direct-user-action
          // fitView firing in the SAME tick as a just-applied position/data
          // change can race React Flow's own node-dimension effect and
          // resolve against not-yet-measured nodes.
          //
          // P47 — panel-aware: without this, "fit view" itself can settle
          // the whole fleet under the docked ManagerOverlay's right edge.
          //
          // fix/canvas-fit-fill-ratio (David's measured repro: "fit"
          // collapsing to 18% zoom / 7% fill for 8 project zones) — this
          // plain "fit everything" button used to call `fitView` with NO
          // `minZoom` at all, unlike its sibling whole-canvas fit
          // (useCanvasLayout.ts's `fitViewAfterLayout`/cameraInsets.ts's
          // `resolveArrangeFitTarget`), which already floors a whole-canvas
          // arrange fit at `ARRANGE_MIN_READABLE_ZOOM` — "never so far out
          // it's illegible" (that constant's own doc comment). Two
          // independent "frame everything" implementations had silently
          // drifted apart: one honored the readability floor, the other
          // didn't. Converged onto the SAME floor here rather than inventing
          // a second one — an oversized world bbox can still ask to zoom out
          // past it, but never further than the whole-canvas floor every
          // other "fit everything" call site already respects.
          //
          // fix/canvas-usable-rect (David's forensics: a busier canvas whose
          // content genuinely needed to zoom out further than
          // ARRANGE_MIN_READABLE_ZOOM got its zoom forced UP to that floor
          // anyway, and getViewportForBounds's own asymmetric-padding
          // correction cannot shrink over-sized content to fit both sides at
          // once — it centers on the plain viewport instead, and the side
          // with the bigger padding demand (the left rail's inset, now
          // bigger than the right's) spills off-screen: "fit" clipped
          // content off the LEFT edge, measured "-59") — `computeSafeMinZoom`
          // computes the REAL floor to pass: the requested
          // ARRANGE_MIN_READABLE_ZOOM, or the content's own natural
          // (fully-visible, unclamped) fit zoom, whichever is smaller.
          // Content staying fully visible always wins over the softer "stay
          // comfortably readable" preference — see that function's own doc
          // comment for the full math.
          onClick={() => {
            // Deferred one frame — same rationale as this button's own
            // long-standing "W-CAMERA" comment above: a direct-user-action
            // fit firing in the SAME tick as a just-applied position/data
            // change can race React Flow's own node-dimension effect and
            // resolve against not-yet-measured nodes. `runFit` itself
            // (declared above, shared with the auto-refit ResizeObserver
            // effect) does the actual measure-and-apply work.
            requestAnimationFrame(runFit);
          }}
          title={t('canvas.toolbar.fit')}
          aria-label={t('canvas.toolbar.fit')}
          style={BUTTON_STYLE}
        >
          ⤢
        </button>
        <div style={GROUP_STYLE}>
          <button
            type="button"
            data-testid="canvas-toolbar-zoom-out"
            onClick={() => zoomOut()}
            aria-label={t('cockpit.grid.zoomOut')}
            style={BUTTON_STYLE}
          >
            −
          </button>
          <span
            data-testid="canvas-toolbar-zoom-pct"
            style={{ width: 40, textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-secondary)' }}
          >
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            data-testid="canvas-toolbar-zoom-in"
            onClick={() => zoomIn()}
            aria-label={t('cockpit.grid.zoomIn')}
            style={BUTTON_STYLE}
          >
            +
          </button>
        </div>
        {/* fix/canvas-toolbar-oscillation Option B — this wrapping div no
            longer participates in any width measurement (no ResizeObserver
            reads it, nothing writes a computed `maxWidth` above it). Its
            children are now a FIXED set — only `zoomToSelection`,
            `followActive`, `replayToggle` ever render here; the other six
            TOOLBAR_DEMOTABLE_PRIORITY keys never do, at any width. Kept
            `flexShrink: 0` on the individual controls (BUTTON_STYLE) so
            labels still never split mid-word — the ORIGINAL defect this
            whole mechanism was built to fix, and the one thing this revert
            preserves. */}
        <div
          data-testid="canvas-toolbar-demotable-region"
          style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}
        >
          {/* fix/canvas-toolbar-oscillation Option B — minimap, the
              undo/redo group, snap, palette, and the auto-layout group are
              now ALWAYS in the "⋯" overflow menu (see `demotedMenuItems`
              above) and never render here — not "hidden until there's
              room", permanently absent from this row, by the fixed
              TOOLBAR_ALWAYS_VISIBLE_KEYS split. `legend` stays here (see
              that constant's own doc comment) since its popover needs a
              real anchor. */}
          {TOOLBAR_ALWAYS_VISIBLE_KEYS.has('legend') && (
            <div style={{ position: 'relative' }}>
              <button
                ref={legendTriggerRef}
                type="button"
                data-testid="canvas-toolbar-legend-toggle"
                onClick={() => setLegendOpen((v) => !v)}
                title={t('canvas.legend.toggleTitle')}
                aria-label={t('canvas.legend.toggleTitle')}
                aria-pressed={legendOpen}
                style={{
                  ...BUTTON_STYLE,
                  color: legendOpen ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                  ...(legendOpen ? ACTIVE_TOGGLE_STYLE : {}),
                }}
              >
                <LegendGlyph />
              </button>
              <CanvasLegendPopover open={legendOpen} onClose={() => setLegendOpen(false)} triggerRef={legendTriggerRef} />
            </div>
          )}
          {TOOLBAR_ALWAYS_VISIBLE_KEYS.has('zoomToSelection') && (
            <button
              type="button"
              data-testid="canvas-toolbar-zoom-to-selection"
              onClick={onZoomToSelection}
              disabled={!hasSelection}
              title={t('canvas.toolbar.zoomToSelectionTitle')}
              aria-label={t('canvas.toolbar.zoomToSelection')}
              style={{ ...BUTTON_STYLE, opacity: hasSelection ? 1 : 0.4, cursor: hasSelection ? 'pointer' : 'default' }}
            >
              ⌖
            </button>
          )}

          {/* fix/canvas-ux R6a BLOQUANT #1c — contextual « Lancer » chip,
              reachable regardless of zoom (see selectedDraftId's own doc
              comment on CanvasToolbarProps). Entirely absent otherwise —
              same "no disabled placeholder, just don't render it" convention
              as « Focus pannes » above. Essential/contextual, never demoted
              — see TOOLBAR_DEMOTABLE_PRIORITY's own doc comment. */}
          {selectedDraftId && (
            <button
              type="button"
              data-testid="canvas-toolbar-launch-selected-draft"
              onClick={onLaunchSelectedDraft}
              title={t('canvas.node.launch')}
              aria-label={t('canvas.node.launch')}
              style={{ ...BUTTON_STYLE, width: 'auto', padding: '0 8px', fontSize: 11, fontWeight: 700, color: 'var(--color-accent)' }}
            >
              ▶ {t('canvas.node.launch')}
            </button>
          )}

          {TOOLBAR_ALWAYS_VISIBLE_KEYS.has('followActive') && (
            /* P47 deliverable #2 — « Suivre l'activité »: north-star ask
               ("l'utilisateur doit voir ses agents travailler") — a
               persistent, reachable toggle when there's room; demoted into
               the overflow menu (never deleted) under real space pressure. */
            <button
              type="button"
              data-testid="canvas-toolbar-follow-active"
              onClick={onToggleFollowActive}
              title={t('canvas.follow.toggleTitle')}
              aria-label={t('canvas.follow.toggle')}
              aria-pressed={followActiveEnabled}
              style={{
                ...BUTTON_STYLE,
                width: 'auto',
                padding: '0 8px',
                gap: 4,
                fontSize: 11,
                fontWeight: 700,
                color: followActiveEnabled ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                ...(followActiveEnabled ? ACTIVE_TOGGLE_STYLE : {}),
              }}
            >
              <FollowActiveGlyph />
              {t('canvas.follow.toggle')}
            </button>
          )}

          {TOOLBAR_ALWAYS_VISIBLE_KEYS.has('replayToggle') && (
            /* W8d — Replay entry point (also 'R', see useCanvasKeyboard.ts).
               Always enabled while reachable: it's the only way OUT of
               replay too — highest priority in TOOLBAR_DEMOTABLE_PRIORITY,
               demoted last. */
            <button
              type="button"
              data-testid="canvas-toolbar-replay-toggle"
              onClick={onToggleReplay}
              title={`${t('canvas.replay.toggle')} (R)`}
              aria-label={t('canvas.replay.toggle')}
              aria-pressed={replayActive}
              style={{ ...BUTTON_STYLE, width: 'auto', padding: '0 8px', fontSize: 11, fontWeight: 700, color: replayActive ? 'var(--color-danger)' : 'var(--color-text-secondary)' }}
            >
              {t('canvas.replay.toggle')}
            </button>
          )}
        </div>
        <ToolbarSeparator />

        {/* Fleet Metrics Summary Bar */}
        {(fleetRunning > 0 || fleetReview > 0 || failureCount > 0 || fleetCost.any) && (
          <div
            data-testid="canvas-toolbar-fleet-summary"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '2px 8px',
              borderRadius: 6,
              background: 'var(--color-panel-3)',
              border: '1px solid var(--color-border-3)',
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              fontWeight: 700,
              color: 'var(--color-text-secondary)',
              flexShrink: 0,
            }}
          >
            {fleetRunning > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--canvas-state-running)' }}>
                <span className="canvas-blink" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--canvas-state-running)', flexShrink: 0 }} />
                {fleetRunning} actif{fleetRunning > 1 ? 's' : ''}
              </span>
            )}
            {fleetReview > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--canvas-state-review)' }}>
                <span>⚖️</span>
                {fleetReview} en revue
              </span>
            )}
            {failureCount > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--canvas-state-failed)' }}>
                <span>⚠️</span>
                {failureCount} échec{failureCount > 1 ? 's' : ''}
              </span>
            )}
            {fleetCost.any && (
              <span style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>
                {/* LazyCredits, never $ — debited credits first; a native-rail
                // (Claude/GPT subscription) run shows "0 Cr. abonnement"
                // instead of silently counting its spend as real money.
                // One shared usdToCredits conversion, same unit key as
                // CostChip/liveMetricsLabel/AgentRoster — no second formula,
                // no contradiction between chips on the same canvas. */}
                {fleetCost.debitedCredits > 0
                  ? `${fleetCost.debitedCredits.toLocaleString()} ${t('canvas.node.creditsUnit')}`
                  : `0 ${t('canvas.node.creditsUnit')} · ${t('canvas.node.subscription')}`}
              </span>
            )}
          </div>
        )}

        <ToolbarSeparator />

        {/* R1b — search (status-filter chips REMOVED, module header) */}
        <input
          type="text"
          data-testid="canvas-toolbar-search"
          className="nodrag"
          placeholder={t('canvas.toolbar.search')}
          aria-label={t('canvas.toolbar.search')}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          style={{
            width: 128,
            // fix/canvas-toolbar-squeeze — "keep zoom/fit/search reachable"
            // (David's own explicit floor): a fixed `width` alone still
            // shrinks under flex pressure (flex-shrink defaults to 1
            // regardless of an explicit width) — this is the one non-button
            // essential control in the row, so it gets the same floor.
            flexShrink: 0,
            fontSize: 11.5,
            padding: '4px 8px',
            borderRadius: 6,
            border: '1px solid var(--color-border-3)',
            background: 'var(--color-panel-3)',
            color: 'var(--color-text)',
            fontFamily: 'inherit',
          }}
        />

        {/* W-CLEAR-FINISHED — canvas-wide bulk archive, always rendered
            (unlike « Focus pannes » below, which hides outright at 0):
            disabled state IS the "nothing to clear" signal here, matching
            undo/redo/zoom-to-selection's own disabled-not-hidden
            convention just above. */}
        <button
          type="button"
          data-testid="canvas-toolbar-clear-finished"
          onClick={() => agentsStore?.archiveTerminalMissions(terminalMissionIds)}
          disabled={terminalMissionIds.length === 0}
          title={t('canvas.toolbar.clearFinishedTitle', { count: terminalMissionIds.length })}
          aria-label={t('canvas.toolbar.clearFinished')}
          style={{
            ...BUTTON_STYLE,
            opacity: terminalMissionIds.length > 0 ? 1 : 0.4,
            cursor: terminalMissionIds.length > 0 ? 'pointer' : 'default',
          }}
        >
          <ClearFinishedGlyph />
        </button>

        {/* R1b — « Focus pannes » as a compact conditional alert icon
            (module header): entirely absent when there's nothing to
            focus, matching the honest-empty convention the toast fallback
            in CanvasView.handleFocusFailures already established. */}
        {failureCount > 0 && (
          <button
            type="button"
            data-testid="canvas-toolbar-focus-failures"
            onClick={onFocusFailures}
            title={t('canvas.toolbar.focusFailuresTitle')}
            aria-label={`${t('canvas.toolbar.focusFailures')} (${failureCount})`}
            style={{ ...BUTTON_STYLE, position: 'relative', color: 'var(--color-danger)' }}
          >
            <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 1.6 14.8 13.4H1.2L8 1.6Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              <path d="M8 6.4v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <circle cx="8" cy="11.2" r="0.9" fill="currentColor" />
            </svg>
            <CountBadge count={failureCount} />
          </button>
        )}

        {/* R1b — trailing overflow menu: hide-merged / shortcuts / library
            (module header). */}
        <button
          ref={overflowTriggerRef}
          type="button"
          data-testid="canvas-toolbar-overflow-toggle"
          onClick={() => setOverflowOpen((v) => !v)}
          title={t('canvas.toolbar.moreOptions')}
          aria-label={t('canvas.toolbar.moreOptions')}
          aria-haspopup="menu"
          aria-expanded={overflowOpen}
          style={{ ...BUTTON_STYLE, color: overflowOpen ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}
        >
          <OverflowIcon />
        </button>
        <OverflowMenu
          open={overflowOpen}
          onClose={() => setOverflowOpen(false)}
          triggerRef={overflowTriggerRef}
          hideMergedEnabled={hideMergedEnabled}
          onToggleHideMerged={onToggleHideMerged}
          wheelMode={wheelMode}
          onToggleWheelMode={onToggleWheelMode}
          onOpenShortcuts={onOpenShortcuts}
          onOpenLibrary={onOpenLibrary}
          onOpenReport={onOpenReport}
          onExportCanvas={onExportCanvas}
          onImportCanvasFile={onImportCanvasFile}
          onExportYaml={onExportYaml}
          onImportYamlFile={onImportYamlFile}
          onGitExport={onGitExport}
          onExportMcp={onExportMcp}
          replayActive={replayActive}
          editingDisabledStyle={editingDisabledStyle}
          editingTitleSuffix={editingTitleSuffix}
          approvalMode={globalApprovalMode}
          onOpenApprovalModeSelector={setApprovalAnchorRect}
          /* fix/canvas-toolbar-oscillation Option B — demoted items are a
             fixed, non-empty set by construction (six of the nine
             TOOLBAR_DEMOTABLE_PRIORITY keys are never in
             TOOLBAR_ALWAYS_VISIBLE_KEYS), so this is unconditional now — no
             `.size > 0` guard against an empty reactive set left over from
             the old mechanism. */
          demotedItems={demotedMenuItems}
        />
      </div>
    </Panel>
    {/* W-MODES-ui — rendered here (NOT inside OverflowMenu, which unmounts
        the instant `overflowOpen` flips false right after the triggering
        click) so the popover survives the overflow menu closing — see
        OverflowMenuProps' `onOpenApprovalModeSelector` doc comment. */}
    {approvalAnchorRect && (
      <ApprovalModePopover
        anchorRect={approvalAnchorRect}
        currentMode={globalApprovalMode}
        testIdPrefix="toolbar-approval-mode"
        onClose={() => setApprovalAnchorRect(null)}
        onSelect={(mode) => {
          void agentsStore?.changeApprovalMode(mode);
        }}
      />
    )}
    </>
  );
}
