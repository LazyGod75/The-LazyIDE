/* HoverActionStrip.tsx — W8a deliverable #1: a small floating icon-button
   strip that fades in on card hover (n8n-inspired UX, REIMPLEMENTED here
   from scratch: plain inline SVG icons + CSS opacity transition, no n8n
   code/markup/assets referenced or copied).

   Rendered by nodeChrome.tsx's `NodeCard` (its `hoverActions` prop) inside
   mission/loop/draft cards at COMPACT and FULL zoom only (never at `dot`
   zoom — the dot-zoom branch of every node card returns before it ever
   builds a NodeCard, so this never even mounts there).

   Every button here calls straight into CanvasActionsContext handlers
   (onOpenMission/onUrgentAction/onToggleLoop/onSkipLoopNextRun/
   onLaunchDraft/onEditDraft) — the SAME real primitives the existing
   full-card quick actions and CanvasContextMenu.tsx already call. The two
   actions CanvasActionsContext does not expose (mission Stop, draft
   Delete) are wired the exact same way CanvasContextMenu.tsx already wires
   them: `useAgentsStoreOptional().stopMission` / `useCanvasStore`'s
   `removeDraft` — real, pre-existing primitives, never a new one.
*/

import type { ReactNode } from 'react';

export interface HoverAction {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  /**
   * R11 (corner-collision fix, MissionNode.tsx's own header) — overrides the
   * default `hover-action-${key}` test id. Used so an action folded INTO
   * this strip (e.g. the mission card's "agrandir" expand chevron) can keep
   * its PRE-EXISTING test id (`mission-node-expand-${missionId}`) — every
   * caller/test that queried that id before the chevron moved into this
   * strip keeps working unchanged. Absent for every other action (the
   * common case) — falls back to the default below.
   */
  testId?: string;
}

interface HoverActionStripProps {
  actions: readonly HoverAction[];
  groupLabel: string;
}

const ICON_SIZE = 12;

/** Small icon-button — 20x20 hit target, transparent until hovered/focused
 *  (the strip itself already only shows on card hover; this per-button
 *  hover just gives a little extra affordance). */
function HoverIconButton({ action }: { action: HoverAction }) {
  return (
    <button
      type="button"
      data-testid={action.testId ?? `hover-action-${action.key}`}
      className="nodrag canvas-hover-action-btn"
      title={action.label}
      aria-label={action.label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        action.onSelect();
      }}
      style={{
        width: 20,
        height: 20,
        borderRadius: 5,
        border: 'none',
        background: 'rgba(20,20,28,0.55)',
        color: action.danger ? 'var(--color-danger)' : 'var(--color-text-secondary)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
      }}
    >
      {action.icon}
    </button>
  );
}

/** The fading-in strip itself — positioned by the caller (nodeChrome.tsx's
 *  NodeCard puts it at top-right via CSS, see `.canvas-hover-actions`).
 *  `role="group"` + `groupLabel` gives the cluster a single accessible
 *  name instead of each icon button floating unlabeled in the a11y tree. */
export function HoverActionStrip({ actions, groupLabel }: HoverActionStripProps) {
  if (actions.length === 0) return null;
  return (
    <div
      className="canvas-hover-actions nodrag"
      role="group"
      aria-label={groupLabel}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ display: 'flex', gap: 3 }}
    >
      {actions.map((action) => (
        <HoverIconButton key={action.key} action={action} />
      ))}
    </div>
  );
}

// ── Icons (plain inline SVG — never an emoji, see design-system convention
//    noted throughout nodeChrome.tsx). ────────────────────────────────────

export function OpenIcon() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6.5 3H3v10h10V9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 3h4v4M13 3 7 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LogsIcon() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" />
    </svg>
  );
}

export function RetryIcon() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 8a5 5 0 0 1 8.6-3.5M13 8a5 5 0 0 1-8.6 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M11.6 2.6v2.4H9.2M4.4 13.4V11H6.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlayIcon() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 3.2v9.6l8-4.8-8-4.8Z" fill="currentColor" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4" y="3.2" width="2.6" height="9.6" rx="0.8" fill="currentColor" />
      <rect x="9.4" y="3.2" width="2.6" height="9.6" rx="0.8" fill="currentColor" />
    </svg>
  );
}

export function SkipIcon() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 3.5v9l7-4.5-7-4.5Z" fill="currentColor" />
      <rect x="11.5" y="3.5" width="1.8" height="9" fill="currentColor" />
    </svg>
  );
}

export function EditIcon() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10.5 2.5 13.5 5.5 5.5 13.5H2.5v-3l8-7.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** R11 (corner-collision fix) — the "agrandir" live-panel expand glyph,
 *  moved here verbatim from MissionNode.tsx's old standalone header button
 *  (same diagonal-corners-expanding shape) now that the action itself lives
 *  inside this strip instead of a second top-right element. */
export function ExpandIcon() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.5 2.5H2.5v4M9.5 13.5h4v-4M2.5 2.5 6.8 6.8M13.5 13.5 9.2 9.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DeleteIcon() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 4.5h9M6 4.5v-1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M4.5 4.5v8a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
