/* ManagerOverlay — the right-edge floating glass panel that hosts
   LazyManager (P1-3 full-bleed redesign: the fixed 460px right COLUMN
   is gone — see Cockpit.tsx's header comment). Responsibilities:

     1. Always-visible + collapsible chrome (design spec: the manager is
        NEVER fully hidden). Collapsed state renders a thin persistent tab
        pinned to the right edge — clicking it re-expands the panel to
        whichever non-collapsed width (normal/expanded) was last open.
     2. THREE width states (product ask: "le truc de chat se deplie pour
        prendre plus de place... a ce moment la conversation passe au
        premier plan et s'agrandit PAR-DESSUS le canvas (retractable) ;
        puis, au lancement, l'attention bascule vers le canvas"):
          - 'collapsed' (44px)       — thin tab, panel hidden.
          - 'normal'    (360px)      — default chat width.
          - 'expanded'  (dynamic,    — discussion/proposal width: reads
                see computeExpandedOverlayWidth) comfortably, superposed
                over the canvas, WITHOUT ever covering it entirely (a
                canvas gutter of at least MIN_VISIBLE_CANVAS_FRACTION is
                always kept on the left — see that function's doc
                comment for the exact formula and small-window behavior).
     3. Two independent triggers for 'expanded' <-> 'normal', both funneled
        through ONE state machine here:
          - MANUAL: the header's widen/narrow button (LazyManagerHeader,
            wired through LazyManager's onToggleWidth prop) or the 'E'
            keyboard shortcut (Cockpit.tsx, mirrors its existing bare 'C'
            cockpit-mode shortcut) via the 'manager:toggleOverlayWidth'
            bus event.
          - AUTOMATIC: 'manager:expandOverlay'/'manager:shrinkOverlay' bus
            events, emitted by GraphProposalCard (a plan proposal becomes
            pending -> expand; gets resolved/modified -> shrink) and by
            agentsStore's executePlan/revisePlan (execution actually
            starts -> shrink). This is the REAL, structured signal this
            overlay branches on (ManagerMessage.proposal.state, the exact
            field GraphProposalCard itself renders from) — never text
            sniffing.
        Manual choice takes priority over automatic EXPAND requests for
        the SAME still-pending proposal (tracked by `manualOverrideKeyRef`
        vs. the live `currentProposalKeyRef` derived from
        useAgentsStoreOptional().managerMessages — real state, not a
        guess) — see handleToggleExpand's doc comment for the exact
        precedence rule. Automatic SHRINK is a hard, non-overridable phase
        transition (product spec: "au lancement, l'attention bascule vers
        le canvas" is stated unconditionally) and always wins, clearing
        any manual override for that proposal.
     4. The tri-state value persists across sessions (localStorage) — but
        only the states the USER deliberately chose (collapse/reopen,
        manual widen/narrow); an automatic expand/shrink driven by a
        proposal that won't exist on the next launch is never saved as a
        baseline preference (see persistWidthState's doc comment).

   Data attributes on the overlay root expose the live width state for
   cameraInsets.ts DOM reads (unchanged contract: 'manager-overlay' /
   'manager-overlay-expand' test ids, real rendered width). */

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { bumpRenderCount } from '../../../lib/perf/renderCounters';
import type { FleetMission, FleetProject } from '../../../lib/agents/fleetMissions';
import type { ManagerMessage, AutonomyMode } from '../../../lib/agents/types';
import type { ManagerSignal } from './managerSignals';
import { useManagerHostSource } from '../../lazyManager/managerHostRegistry';
import { ManagerAutonomyBar } from './ManagerAutonomyBar';
import { useAgentsStoreOptional } from '../agentsStore';
import { on, emit, _debugLogOverlayWidth } from '../../../lib/bus';
import { isEditableTarget } from '../canvas/hooks/useCanvasKeyboard';

export type OverlayWidthState = 'normal' | 'expanded' | 'collapsed';

export interface ManagerOverlayProps {
  projects: FleetProject[];
  /** Set by a caller (e.g. "Plan de rattrapage") to prefill the input once —
   *  forwarded verbatim to LazyManager. */
  draftPrefill: string | null;
  onDraftConsumed: () => void;
  messagesOverride?: ManagerMessage[];
  signals: ManagerSignal[];
  onAnswerSignal: (mission: FleetMission, projectId: string, question: string, answer: string) => void;
  onSignalAction: (mission: FleetMission, actionKey: string) => void;
  autonomyLevel: AutonomyMode;
  onAutonomyChange: (mode: AutonomyMode) => void;
}

const OVERLAY_WIDTH_NORMAL = 360;
// fix/canvas-collapse-reservation — exported so tests can assert the
// collapsed reservation symbolically (e.g. "the emitted overlay width
// equals COLLAPSED_WIDTH") instead of re-hardcoding a copy of this number
// that could silently drift out of sync with the real constant.
export const COLLAPSED_WIDTH = 44;
// fix/canvas-collapse-reservation round 2 — exported for the SAME reason as
// COLLAPSED_WIDTH above: Cockpit.tsx's own initial-reservation guess (see
// `resolveInitialOverlayWidth` below) must add the identical offset the
// live `manager:overlayWidthChange` listener already does, or the very
// first paint and the first bus-corrected paint would disagree by this
// amount — a real, if smaller, version of the exact masking bug this fix
// exists to close.
export const OVERLAY_RIGHT_OFFSET = 16;
const OVERLAY_EXPAND_TRANSITION_MS = 300;
/** 2026-08-06 (founder: "le chat doit etre agrandissable en cliquant et
 *  tirant sur les bords comme quand je sors le terminal dans vscode") —
 *  free drag-resize floor: the panel can be dragged narrower than 'normal'
 *  (360px) but never into unreadability. */
const MIN_CUSTOM_WIDTH = 300;

/** Target share of the window's width the 'expanded' panel reaches for
 *  (product ask: "nettement plus large"). Only a target — the two clamps
 *  below (readability cap, canvas-visibility ceiling) can pull it down. */
const EXPANDED_WIDTH_FRACTION = 0.65;
/** Best-effort floor so 'expanded' always reads as meaningfully wider than
 *  'normal' (360px) even on a modest window — NOT a hard guarantee: the
 *  canvas-visibility ceiling below still wins on a genuinely tiny window
 *  (point 4's "comportement raisonnable en dessous d'une certaine largeur"),
 *  since never-fully-covering-the-canvas is the one non-negotiable rule. */
const EXPANDED_MIN_WIDTH_FLOOR = 480;
/** Readability ceiling on ultra-wide monitors — a multi-thousand-px-wide
 *  chat column reads worse, not better, past this point. */
const EXPANDED_MAX_WIDTH_CAP = 920;
/** Hard invariant (point 4: "sans jamais couvrir la totalite de l'ecran"):
 *  the canvas keeps at least this fraction of the window visible on the
 *  left at all times while 'expanded', matching the founder's own example
 *  ("garde une bande de canvas visible, par exemple 30-40% a gauche"). */
const MIN_VISIBLE_CANVAS_FRACTION = 0.32;

/**
 * Pure width formula for the 'expanded' state (exported for unit testing).
 * Reactive to the window's current width (see the `useEffect` resize
 * listener below) — unlike the old one-shot `Math.min(720, 55vw)` constant
 * computed once at module load, which never adjusted after that first
 * read and so drifted from reality on any later window resize.
 *
 * Order of clamps: start from the `EXPANDED_WIDTH_FRACTION` target, floor
 * it (best-effort) at `EXPANDED_MIN_WIDTH_FLOOR`, then hard-cap it at BOTH
 * `EXPANDED_MAX_WIDTH_CAP` and the canvas-visibility ceiling
 * (`windowWidth * (1 - MIN_VISIBLE_CANVAS_FRACTION)`) — the ceiling always
 * wins over the floor, so the never-fully-covering-the-canvas invariant
 * holds even on a pathologically narrow window.
 */
export function computeExpandedOverlayWidth(windowWidth: number): number {
  const safeWidth = Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : 1280;
  const visibilityCeiling = safeWidth * (1 - MIN_VISIBLE_CANVAS_FRACTION);
  const flooredTarget = Math.max(
    safeWidth * EXPANDED_WIDTH_FRACTION,
    Math.min(EXPANDED_MIN_WIDTH_FLOOR, visibilityCeiling),
  );
  return Math.round(Math.min(flooredTarget, EXPANDED_MAX_WIDTH_CAP, visibilityCeiling));
}

/**
 * P2-19 fix: the max horizontal space this overlay ever occupies from the
 * page's right edge (its expanded width + its own right offset) — exported
 * so FluxFooter's wrapper (Cockpit.tsx) can reserve this much room instead of
 * spanning `right: 0` and rendering its ticker text UNDER this panel.
 *
 * The true worst case across every window size is `EXPANDED_MAX_WIDTH_CAP`
 * (computeExpandedOverlayWidth never exceeds it) — Cockpit.tsx only uses
 * this as the INITIAL default before the first real
 * 'manager:overlayWidthChange' bus event lands, so a static worst-case
 * constant here is still correct.
 */
export const MANAGER_OVERLAY_MAX_RESERVED_WIDTH = EXPANDED_MAX_WIDTH_CAP + OVERLAY_RIGHT_OFFSET;

/** Current rendered width for a given state — used by cameraInsets.ts
 *  consumers that need the numeric px value without a DOM read.
 *  `expandedWidth` defaults to the readability cap when the caller has no
 *  live measurement (keeps this function's prior single-argument shape
 *  working for any external caller). */
export function overlayWidthFor(state: OverlayWidthState, expandedWidth: number = EXPANDED_MAX_WIDTH_CAP): number {
  if (state === 'expanded') return expandedWidth;
  if (state === 'collapsed') return COLLAPSED_WIDTH;
  return OVERLAY_WIDTH_NORMAL;
}

/**
 * fix/canvas-collapse-reservation round 2 (David's round-9 report: the
 * collapse-transition fix landed, but a FRESH LAUNCH with a persisted
 * custom drag width still reserved that stale custom width, not the
 * collapsed one — "1440 - 836 (the custom width) - ~80 (rail) ~= 524",
 * matching the measured 504px container almost exactly). His own
 * instruction: "Make both paths use one function that resolves the
 * effective width from (state, custom, expanded) so they cannot disagree."
 *
 * THE single source of truth for "what width is this overlay actually
 * showing right now" — collapsed always wins outright (a custom drag width
 * is a preference about the EXPANDED size, never meant to apply while
 * collapsed — see this same precedence bug's round-1 fix, just above in
 * this file's own `currentWidth` computation, which now calls this
 * directly instead of duplicating the ternary). Exported so
 * `resolveInitialOverlayWidth` below (Cockpit.tsx's own initial-render
 * guess) and the live `currentWidth` computation are PROVABLY the same
 * decision, not two hand-synchronized copies that can drift apart again.
 */
export function resolveEffectiveOverlayWidth(
  widthState: OverlayWidthState,
  customWidth: number | null,
  expandedWidth: number,
): number {
  if (widthState === 'collapsed') return COLLAPSED_WIDTH;
  return customWidth ?? overlayWidthFor(widthState, expandedWidth);
}

const WIDTH_STORAGE_KEY = 'lazy.manager.overlayWidth';
/** Separate key remembering the last MANUALLY chosen non-collapsed width
 *  (normal/expanded) — read when the user reopens from the collapsed tab,
 *  so reopening restores their actual preference instead of always
 *  forcing 'normal'. */
const LAST_OPEN_WIDTH_STORAGE_KEY = 'lazy.manager.overlayWidth.lastOpen';
/** 2026-08-06 drag-resize: pixel width chosen by dragging the panel's left
 *  edge (VS Code terminal style). Persisted as a deliberate user choice;
 *  `null` means "no custom width — follow the state machine". */
const CUSTOM_WIDTH_STORAGE_KEY = 'lazy.manager.overlayWidth.custom';

function readPersistedWidthState(): OverlayWidthState {
  try {
    const saved = localStorage.getItem(WIDTH_STORAGE_KEY);
    if (saved === 'collapsed' || saved === 'normal' || saved === 'expanded') return saved;
  } catch { /* SSR / unavailable */ }
  return 'normal';
}

function readLastOpenWidthState(): 'normal' | 'expanded' {
  try {
    if (localStorage.getItem(LAST_OPEN_WIDTH_STORAGE_KEY) === 'expanded') return 'expanded';
  } catch { /* SSR / unavailable */ }
  return 'normal';
}

/** Hard ceiling for a custom drag-resized width: the same canvas-visibility
 *  invariant as 'expanded' (at least MIN_VISIBLE_CANVAS_FRACTION of the
 *  window stays visible on the left), minus the panel's own right offset. */
function customWidthCeiling(windowWidth: number): number {
  const safeWidth = Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : 1280;
  return Math.max(MIN_CUSTOM_WIDTH, Math.round(safeWidth * (1 - MIN_VISIBLE_CANVAS_FRACTION) - OVERLAY_RIGHT_OFFSET));
}

function readPersistedCustomWidth(): number | null {
  try {
    const raw = localStorage.getItem(CUSTOM_WIDTH_STORAGE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.round(Math.min(Math.max(n, MIN_CUSTOM_WIDTH), customWidthCeiling(window.innerWidth)));
  } catch { /* SSR / unavailable */ }
  return null;
}

function persistCustomWidth(width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(CUSTOM_WIDTH_STORAGE_KEY);
    else localStorage.setItem(CUSTOM_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch { /* ignore */ }
}

/**
 * fix/canvas-collapse-reservation round 2 — Cockpit.tsx's own INITIAL
 * `managerOverlayWidth` guess (before `<ManagerOverlay>` has even mounted,
 * let alone had a chance to emit `manager:overlayWidthChange`) used to be a
 * hardcoded worst-case constant (`MANAGER_OVERLAY_MAX_RESERVED_WIDTH`,
 * still a fine, honest fallback for the "state truly unreadable" case
 * below) — correct for its ORIGINAL single consumer (FluxFooter, which
 * only cares about never being covered, so over-reserving is always safe)
 * but wrong for the canvas's `reservedRightPx`, the SAME state variable's
 * second consumer added later: a stale, too-generous guess just means the
 * canvas starts cramped for however long it takes the bus event to correct
 * it — normally near-instant, but if that correction is ever delayed,
 * skipped, or (the round-9 repro) never actually needed at all because the
 * FIRST real state already resolves to something else entirely, the canvas
 * is stuck framing against the wrong number with nothing left to correct
 * it. Reading the SAME persisted values `<ManagerOverlay>` itself reads on
 * its own mount, resolved through the SAME {@link resolveEffectiveOverlayWidth}
 * function, means Cockpit's very first render already agrees with whatever
 * `<ManagerOverlay>` is about to render too — provably, not by two
 * independently-written reads staying in sync by convention.
 */
export function resolveInitialOverlayWidth(windowWidth: number = typeof window !== 'undefined' ? window.innerWidth : 1280): number {
  if (typeof window === 'undefined') return MANAGER_OVERLAY_MAX_RESERVED_WIDTH - OVERLAY_RIGHT_OFFSET;
  const widthState = readPersistedWidthState();
  const customWidth = readPersistedCustomWidth();
  const expandedWidth = computeExpandedOverlayWidth(windowWidth);
  return resolveEffectiveOverlayWidth(widthState, customWidth, expandedWidth);
}

/**
 * Persists a DELIBERATE user choice only — never an automatic bus-driven
 * expand/shrink. An automatically expanded state exists to show a specific,
 * ephemeral proposal; saving it as the baseline would reopen the app next
 * session at that width with no proposal to justify it. Every manual call
 * site below (collapse, reopen, widen/narrow) calls this explicitly instead
 * of a blanket "persist on every widthState change" effect.
 */
function persistWidthState(state: OverlayWidthState): void {
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, state);
    if (state !== 'collapsed') localStorage.setItem(LAST_OPEN_WIDTH_STORAGE_KEY, state);
  } catch { /* ignore */ }
}

function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={direction === 'left' ? 'M14 6l-6 6 6 6' : 'M10 6l6 6-6 6'}
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Perf audit 2026-08-15 (item 3): renamed so it can be wrapped in `memo()`
// below — see that wrapper's own comment for scope/limits.
function ManagerOverlayImpl({
  projects,
  draftPrefill,
  onDraftConsumed,
  messagesOverride,
  signals,
  onAnswerSignal,
  onSignalAction,
  autonomyLevel,
  onAutonomyChange,
}: ManagerOverlayProps) {
  bumpRenderCount('ManagerOverlay');
  const { t } = useI18n();
  const agents = useAgentsStoreOptional();
  const [widthState, setWidthState] = useState<OverlayWidthState>(readPersistedWidthState);
  const [prefillText, setPrefillText] = useState<string | null>(null);
  const [expandedWidth, setExpandedWidth] = useState<number>(() =>
    computeExpandedOverlayWidth(typeof window !== 'undefined' ? window.innerWidth : 1280),
  );
  // 2026-08-06 drag-resize (VS Code terminal style): a pixel width chosen
  // by dragging the panel's left edge. `null` = no custom width, the state
  // machine (normal/expanded) decides. Persisted as a deliberate choice.
  const [customWidth, setCustomWidth] = useState<number | null>(() =>
    typeof window !== 'undefined' ? readPersistedCustomWidth() : null,
  );
  const [isResizing, setIsResizing] = useState(false);

  // Reactive to window resize — the old formula was computed once at module
  // load and never revisited, so it drifted from reality after any resize.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      setExpandedWidth(computeExpandedOverlayWidth(window.innerWidth));
      // Keep a persisted custom width valid after a window resize: clamp it
      // to the new ceiling (the canvas-visibility invariant still holds).
      setCustomWidth((prev) => (prev === null ? null : Math.min(prev, customWidthCeiling(window.innerWidth))));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── Drag-resize (2026-08-06) ─────────────────────────────────────────
  // Pointer capture on the left-edge handle; window listeners while the
  // drag is live so the cursor leaving the handle never drops the gesture.
  const onResizeHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    if (!isResizing) return;
    const onMouseMove = (e: MouseEvent) => {
      const next = window.innerWidth - e.clientX - OVERLAY_RIGHT_OFFSET;
      setCustomWidth(Math.round(Math.min(Math.max(next, MIN_CUSTOM_WIDTH), customWidthCeiling(window.innerWidth))));
    };
    const onMouseUp = () => {
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Persist only on release (a deliberate choice, same rule as every
      // other manual width decision in this file).
      setCustomWidth((prev) => {
        persistCustomWidth(prev);
        return prev;
      });
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isResizing]);

  const resetCustomWidth = useCallback(() => {
    setCustomWidth(null);
    persistCustomWidth(null);
  }, []);

  // ── Real signal for "is a decision outstanding right now" ────────────
  // Reads the SAME field GraphProposalCard renders from
  // (ManagerMessage.proposal.state) — real store state, not a guess or a
  // text-sniffing heuristic. Used to (a) gate collapsing the panel entirely
  // while a proposal awaits validation, and (b) scope a manual width
  // override to "for as long as THIS proposal stays pending" so the next,
  // unrelated proposal still gets a fresh automatic expand.
  const managerMessages = agents?.managerMessages ?? [];
  const pendingProposalMsg = managerMessages.find((m) => m.proposal?.state === 'pending');
  const hasPendingProposal = Boolean(pendingProposalMsg);
  const currentProposalKey = pendingProposalMsg ? (pendingProposalMsg.proposal?.planId ?? pendingProposalMsg.id) : 'none';
  // Ref (not state) so the bus listener closures below always read the
  // LATEST value without needing to resubscribe on every managerMessages
  // change (resubscribing would risk a brief window with NO listener
  // registered — the old one torn down, the new one not yet set up — right
  // when a child's effect, e.g. GraphProposalCard's own expand/shrink emit,
  // fires). Synced via `useLayoutEffect`, not written during render (that
  // trips the `react-hooks/refs` rule and risks a stale read under
  // concurrent rendering) — layout effects for the WHOLE tree always flush
  // before any passive `useEffect` anywhere in it, so this ref is guaranteed
  // fresh by the time GraphProposalCard's passive effect runs, even though
  // GraphProposalCard is a descendant (child effects normally run first).
  const currentProposalKeyRef = useRef(currentProposalKey);
  useLayoutEffect(() => {
    currentProposalKeyRef.current = currentProposalKey;
  }, [currentProposalKey]);
  /** Which proposal key the user's last manual widen/narrow applies to —
   *  `null` means no active override. */
  const manualOverrideKeyRef = useRef<string | null>(null);

  // 2026-08 fourth verification pass (founder: "it worked for one plan
  // tonight but did NOT fire for another" — auto-expand flakiness) — same
  // ref-instead-of-dependency pattern as `currentProposalKeyRef` just above
  // (see that ref's own comment for why: a dependency array entry means the
  // listener-registration effect below tears down and rebuilds ALL FOUR bus
  // listeners every time it changes). `widthState` used to be exactly that
  // kind of dependency, purely so `offToggle`/`offPrefill`'s closures could
  // read a fresh value — but `setWidthState` fires on every shrink AND every
  // expand, so a prior proposal's ordinary shrink (accepting/revising it)
  // tore down and rebuilt the listeners on every single state change. A
  // `manager:expandOverlay` emitted by a freshly-mounted GraphProposalCard
  // for a BRAND NEW proposal, landing in the brief gap between "old
  // listener removed" and "new listener attached", was silently dropped —
  // the panel stayed at whatever width it already had. Root-caused via a
  // targeted investigation (no live repro available), matching the exact
  // reported symptom.
  const widthStateRef = useRef(widthState);
  useLayoutEffect(() => {
    widthStateRef.current = widthState;
  }, [widthState]);

  // fix/canvas-manager-collapse — same ref-instead-of-dependency discipline
  // as `widthStateRef` just above, for the SAME reason: the keyboard
  // shortcut effect below registers its window listener ONCE and reads this
  // ref at keypress time, rather than tearing the listener down and
  // reinstalling it every time a proposal's pending state flips.
  const hasPendingProposalRef = useRef(hasPendingProposal);
  useLayoutEffect(() => {
    hasPendingProposalRef.current = hasPendingProposal;
  }, [hasPendingProposal]);

  // Persist collapse/reopen/manual-width choices to localStorage — never an
  // automatic bus-driven change (see persistWidthState's doc comment).
  // 2026-08-06: a drag-chosen custom width (VS Code terminal style) always
  // wins over the state machine's own width; `null` falls back to it.
  //
  // fix/canvas-collapse-reservation (David's round-8 report, real packaged
  // app: collapsed the overlay — `manager-overlay` confirmed gone from the
  // DOM, only `manager-overlay-expand` left — yet the canvas container
  // stayed exactly as narrow as before, a "large empty black band" where
  // the panel used to be). Root cause: `customWidth ?? ...` used to apply
  // UNCONDITIONALLY, even while `widthState === 'collapsed'` — a value the
  // user set by dragging the resize handle at ANY point, ever, then
  // persisted to localStorage (`readPersistedCustomWidth`, restored on
  // every future launch) permanently overrides collapse (and every other
  // width-state transition) once it exists, since neither `handleCollapse`
  // nor the 'M' shortcut's collapse branch ever clear it — collapsing only
  // ever swapped which JSX renders (the full panel vs. the collapsed tab),
  // never touched the WIDTH this line computes, which is the ONLY value
  // `manager:overlayWidthChange` below ever emits.
  //
  // fix/canvas-collapse-reservation round 2 (David's round-9 report: the
  // round-8 fix closed the COLLAPSE-TRANSITION path, but a fresh app
  // LAUNCH with a persisted custom width still reserved that stale custom
  // width, matching his own measured "1440 - 836 - ~80 ~= 524" almost
  // exactly against a "collapsed" localStorage value) — now delegates to
  // {@link resolveEffectiveOverlayWidth}, the SAME function Cockpit.tsx's
  // OWN initial-render guess (`resolveInitialOverlayWidth`) calls, so this
  // component's LIVE width and Cockpit's very FIRST paint can never
  // disagree — one decision, read from two places, not two hand-written
  // copies of the same ternary.
  const currentWidth = resolveEffectiveOverlayWidth(widthState, customWidth, expandedWidth);
  useEffect(() => {
    emit('manager:overlayWidthChange', { width: currentWidth });
  }, [widthState, expandedWidth, customWidth, currentWidth]);

  /**
   * Manual widen/narrow toggle — the header button (LazyManagerHeader) and
   * the 'E' keyboard shortcut (Cockpit.tsx, via 'manager:toggleOverlayWidth')
   * both funnel through this one handler. Records which proposal (if any)
   * this choice applies to, so a LATER, unrelated proposal still gets a
   * fresh automatic expand (see the 'manager:expandOverlay' listener below)
   * — the override is scoped to "this proposal's lifetime", not permanent.
   */
  const handleToggleExpand = useCallback(() => {
    setWidthState((prev) => {
      const next: OverlayWidthState = prev === 'expanded' ? 'normal' : 'expanded';
      manualOverrideKeyRef.current = currentProposalKeyRef.current;
      persistWidthState(next);
      return next;
    });
  }, []);

  // Listen for expand/shrink events from GraphProposalCard / message list,
  // the manual-toggle keyboard shortcut, and manager:prefill from canvas
  // context menu. Registered ONCE (see `widthStateRef`'s own comment just
  // above for why `widthState` is deliberately NOT a dependency here
  // anymore) — every handler below reads `widthStateRef.current` instead
  // of closing over the `widthState` render value, so this effect never
  // needs to tear down and rebuild the listeners just because the width
  // changed, closing the exact window that could silently drop a
  // `manager:expandOverlay` for a brand new proposal.
  useEffect(() => {
    const offExpand = on('manager:expandOverlay', () => {
      // Manual choice primes over an automatic widen request for the SAME
      // still-pending proposal — but a NEW proposal (different key) always
      // gets a fresh automatic expand regardless of a stale prior override.
      const blocked = manualOverrideKeyRef.current === currentProposalKeyRef.current;
      _debugLogOverlayWidth('ManagerOverlay receipt', {
        event: 'manager:expandOverlay',
        blocked,
        manualOverrideKey: manualOverrideKeyRef.current,
        currentProposalKey: currentProposalKeyRef.current,
      });
      if (blocked) return;
      setWidthState('expanded');
    });
    const offShrink = on('manager:shrinkOverlay', () => {
      // Hard, non-overridable phase transition (product spec: "au
      // lancement, l'attention bascule vers le canvas" is unconditional) —
      // always applied, and clears any manual override since the proposal
      // it applied to is now resolved. Deliberately NOT gated on
      // `currentProposalKeyRef` the way `manager:expandOverlay` above is —
      // agentsStore.tsx's executePlan/revisePlan emit this SYNCHRONOUSLY
      // right after their own `setState`, before React has re-rendered (and
      // therefore before this ref's own `useLayoutEffect` has had a chance
      // to refresh it for that update) — gating on it here would gate this
      // "hard, non-overridable" shrink on a value that is STILL STALE at the
      // exact moment it matters, silently swallowing a real launch. The
      // trace below still records `currentProposalKeyRef` at receipt time so
      // a live repro can tell a genuinely-stale-card shrink (see
      // GraphProposalCard.tsx's own fifth-verification-pass fix, which
      // addresses this at the EMIT side instead) apart from this expected
      // path, without risking a false block here.
      _debugLogOverlayWidth('ManagerOverlay receipt', {
        event: 'manager:shrinkOverlay',
        currentProposalKey: currentProposalKeyRef.current,
      });
      manualOverrideKeyRef.current = null;
      setWidthState('normal');
    });
    const offToggle = on('manager:toggleOverlayWidth', () => {
      if (widthStateRef.current === 'collapsed') return; // reopen first — nothing to toggle
      handleToggleExpand();
    });
    const offPrefill = on('manager:prefill', (payload) => {
      if (payload.expand && widthStateRef.current === 'collapsed') {
        setWidthState('normal');
        persistWidthState('normal');
      }
      if (payload.text) setPrefillText(payload.text);
    });
    return () => { offExpand(); offShrink(); offToggle(); offPrefill(); };
  }, [handleToggleExpand]);

  const collapsed = widthState === 'collapsed';

  // Gate collapse on the REAL "decision outstanding" signal (not on
  // widthState === 'expanded', which used to conflate "is expanded" with
  // "has a pending proposal" — no longer equivalent now that a manual widen
  // can happen for reasons unrelated to any proposal at all).
  const handleCollapse = () => {
    if (hasPendingProposal) return;
    manualOverrideKeyRef.current = null;
    setWidthState('collapsed');
    persistWidthState('collapsed');
  };

  // fix/canvas-manager-collapse — shared with the collapsed tab's own
  // onClick below (was inlined there only; extracted so the keyboard
  // shortcut effect can call the IDENTICAL restore logic rather than a
  // second, driftable copy of it).
  const handleRestore = useCallback(() => {
    const restored = readLastOpenWidthState();
    manualOverrideKeyRef.current = null;
    setWidthState(restored);
    persistWidthState(restored);
  }, []);

  // fix/canvas-manager-collapse — bare 'M' keyboard shortcut (mirrors
  // Cockpit.tsx's own bare 'C'/'E' shortcuts — same "not typing in a field"
  // guard, `useCanvasKeyboard.ts`'s `isEditableTarget`, reused rather than a
  // third copy of the same check). Toggles collapse <-> restore using the
  // SAME `handleRestore` helper above and the SAME collapse logic
  // `handleCollapse` runs — never a second, divergent code path. Registered
  // ONCE (`[]` deps, same "never tear down and rebuild a window listener on
  // every state tick" discipline `widthStateRef`'s own doc comment already
  // established in this file for the bus-listener effect above) — reads
  // `widthStateRef.current`/`hasPendingProposalRef.current` instead of the
  // render-time `collapsed`/`hasPendingProposal` values so it always sees
  // the CURRENT state without needing to reinstall.
  useEffect(() => {
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'm' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      if (widthStateRef.current === 'collapsed') {
        handleRestore();
      } else if (!hasPendingProposalRef.current) {
        manualOverrideKeyRef.current = null;
        setWidthState('collapsed');
        persistWidthState('collapsed');
      }
    };
    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, [handleRestore]);

  // Registers this host's live props + DOM container with the single
  // <ManagerHost> (mounted once at the AppShell root) instead of
  // instantiating <LazyManager> here directly — see managerHostRegistry.tsx's
  // header comment for why: two direct instantiations (this one and
  // CodeSpace's) used to both stay mounted forever once both spaces had been
  // visited (SpacesLayer's keep-alive design), running every LazyManager
  // effect twice. Called unconditionally (before the `collapsed` early
  // return below) since hooks can't be conditional — while collapsed, the
  // container ref callback below simply never gets attached to a DOM node,
  // so <ManagerHost> has nothing to portal into and LazyManager renders
  // nowhere, matching this component's pre-fix behavior (collapsed also
  // never rendered LazyManager).
  const managerContainerRef = useManagerHostSource('cockpit', {
    projects,
    draftPrefill: prefillText ?? draftPrefill,
    onDraftConsumed: () => {
      setPrefillText(null);
      onDraftConsumed();
    },
    messagesOverride,
    signals,
    onAnswerSignal,
    onSignalAction,
    onCollapse: handleCollapse,
    collapseDisabled: hasPendingProposal,
    widthState,
    onToggleWidth: handleToggleExpand,
  });

  if (collapsed) {
    return (
      <button
        type="button"
        data-testid="manager-overlay-expand"
        data-overlay-width={COLLAPSED_WIDTH}
        aria-label={t('cockpit.manager.expand')}
        title={`${t('cockpit.manager.expand')} (M)`}
        onClick={handleRestore}
        style={{
          position: 'absolute',
          right: 16,
          top: 16,
          bottom: 16,
          width: COLLAPSED_WIDTH,
          zIndex: 40,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          paddingTop: 14,
          paddingBottom: 14,
          borderRadius: 12,
          background: 'var(--color-panel)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          border: '1px solid var(--color-border)',
          boxShadow: '0 18px 50px rgba(0,0,0,0.45)',
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            flexShrink: 0,
            background: 'linear-gradient(135deg, var(--color-accent), var(--color-assistant-cyan))',
            color: '#fff',
            fontWeight: 800,
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          M
        </span>
        {signals.length > 0 && (
          <span
            data-testid="manager-overlay-signal-badge"
            style={{
              minWidth: 15,
              height: 15,
              borderRadius: 8,
              padding: '0 3px',
              background: 'var(--color-warning)',
              color: '#1A1200',
              fontSize: 8,
              fontFamily: 'var(--font-mono)',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {signals.length > 9 ? '9+' : signals.length}
          </span>
        )}
        <span style={{ marginTop: 'auto', color: 'var(--color-text-muted)', display: 'flex' }}>
          <ChevronIcon direction="left" />
        </span>
      </button>
    );
  }

  return (
    <div
      data-testid="manager-overlay"
      data-overlay-width={currentWidth}
      data-overlay-state={widthState}
      style={{
        position: 'absolute',
        right: 16,
        top: 16,
        bottom: 16,
        width: currentWidth,
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 12,
        background: 'var(--color-panel)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid var(--color-border)',
        boxShadow: '0 18px 50px rgba(0,0,0,0.45)',
        overflow: 'hidden',
        minHeight: 0,
        // 2026-08-06: no width transition while the user is actively
        // dragging the edge — a 300ms ease on every mousemove would lag the
        // panel behind the cursor and read as broken.
        transition: isResizing ? 'none' : `width ${OVERLAY_EXPAND_TRANSITION_MS}ms ease`,
      }}
    >
      {/* 2026-08-06 drag-resize handle (founder: "agrandissable en cliquant
          et tirant sur les bords comme le terminal dans vscode") — a wide,
          invisible hit area on the left edge, ew-resize cursor, drag to
          resize freely between MIN_CUSTOM_WIDTH and the canvas-visibility
          ceiling; double-click resets to the state machine's width. */}
      <div
        data-testid="manager-overlay-resize-handle"
        onMouseDown={onResizeHandleMouseDown}
        onDoubleClick={resetCustomWidth}
        title={t('cockpit.manager.resizeHint')}
        style={{
          position: 'absolute',
          left: -5,
          top: 0,
          bottom: 0,
          width: 10,
          cursor: 'ew-resize',
          zIndex: 50,
          touchAction: 'none',
        }}
      />
      {/* fix/canvas-manager-collapse (David's measured repro, real packaged
          app: manager-overlay is 836px wide in a 1440px window — 42% of the
          screen, permanently — and the ONLY control found on it was the
          resize handle; no collapse/minimise affordance anywhere reachable,
          so fitting several project zones into the remaining ~730px forces
          an illegibly low "fit" zoom no amount of fitView math can fix on
          its own). `onCollapse`/`collapseDisabled` were ALREADY threaded
          into <LazyManager> below (its own header is presumably meant to
          render a trigger for them) — this button is a SECOND, independent,
          GUARANTEED-visible affordance at the overlay's own level, so
          reclaiming the canvas never depends on whatever LazyManager's own
          internal chrome happens to render. Top-right corner (the same
          corner the collapsed tab's own chevron sits in, see the `collapsed`
          branch above) — same `handleCollapse` this file already defines,
          same real localStorage persistence (`persistWidthState`) an
          expand/reopen already restores from, same hard gate
          (`hasPendingProposal`) that keeps a pending decision from being
          hidden mid-review. Keyboard-reachable too — see the
          `manager:toggleCollapse`-independent window keydown effect below
          (bare 'M', mirrors Cockpit.tsx's own bare 'C'/'E' shortcuts). */}
      <button
        type="button"
        data-testid="manager-overlay-collapse-trigger"
        className="nodrag"
        onClick={handleCollapse}
        disabled={hasPendingProposal}
        title={hasPendingProposal ? t('cockpit.manager.busyHint') : `${t('cockpit.manager.collapse')} (M)`}
        aria-label={t('cockpit.manager.collapse')}
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          zIndex: 51,
          width: 24,
          height: 24,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 7,
          border: '1px solid var(--color-border)',
          background: 'var(--color-panel-2)',
          color: 'var(--color-text-muted)',
          cursor: hasPendingProposal ? 'default' : 'pointer',
          opacity: hasPendingProposal ? 0.4 : 1,
        }}
      >
        <ChevronIcon direction="right" />
      </button>
      {/* Portal target for the single <ManagerHost>-owned LazyManager
          instance — see managerHostRegistry.tsx. Styled to match exactly
          what LazyManager's own root div used to occupy directly here
          (flex: 1, minHeight: 0) so the drag handle / collapse button
          above and the autonomy bar below keep their same layout. */}
      <div
        ref={managerContainerRef}
        data-testid="manager-overlay-body"
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}
      />
      {/* Compact autonomy control (friction F5) — persistent footer strip
          below the chat panel, see ManagerAutonomyBar.tsx's own header
          comment for why it lives here instead of AutonomySelector's old
          spot in the left rail's KPIs popover. */}
      <div style={{ borderTop: '1px solid var(--color-border-2)', paddingTop: 10, flexShrink: 0 }}>
        <ManagerAutonomyBar value={autonomyLevel} onChange={onAutonomyChange} />
      </div>
    </div>
  );
}

/**
 * Perf audit 2026-08-15 (item 3): same measured render-churn fix as
 * CanvasView.tsx/CockpitLeftRail.tsx's own `memo` exports — see CanvasView's
 * comment for the full mechanism. `onDraftConsumed` used to be an inline
 * arrow function in Cockpit.tsx's JSX (now a stable `useCallback` there
 * too) — without that, this `memo` wrap would have been a no-op. Still
 * re-renders on every fleet poll tick because `projects` is
 * `fleet.projects`, a fresh reference every ~2.5s regardless of memo (see
 * fleetMissions.ts, untouched by this change).
 */
export const ManagerOverlay = memo(ManagerOverlayImpl);
