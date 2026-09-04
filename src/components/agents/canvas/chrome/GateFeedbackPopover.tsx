/* GateFeedbackPopover.tsx — fix/canvas-ux R4d (dogfood defect #1, BLOQUANT):
   the review gate's reject-with-feedback textarea (and the ask_user answer
   textarea) used to render INLINE inside MissionNode's card body
   (nodes/MissionNode.tsx), which nodeChrome.tsx's `NodeCard` caps at
   `maxHeight: FULL_CARD_MAX_HEIGHT` with `overflow: hidden` (geometry.ts) —
   a FIXED footprint the reconciler's placement grid depends on (growing the
   card would mean threading a new footprint through reconciler.ts's
   collision math, geometry.ts's GRID_CELL_HEIGHT, etc.). Opening the
   textarea pushed the submit button past that fixed height, and
   `overflow: hidden` silently clipped it — unclickable at every zoom (R3
   dogfood screenshots d13/d14/d19).

   Fix: render the feedback/answer form as a POPOVER portaled to
   `document.body`, anchored to the gate row's own screen rect — same
   pattern chrome/EdgeDropNodePicker.tsx (screen-space `position: fixed`
   anchored at a screen point) and components/account/AccountPopover.tsx
   (`createPortal` + outside-click/Escape-to-cancel) already establish. Zero
   card growth, zero footprint/collision implications, and — since a
   portaled `position: fixed` element sits OUTSIDE React Flow's zoomed/
   panned viewport transform entirely — the submit button's real screen
   hit-box is never scaled by canvas zoom, so it stays clickable at every
   zoom level by construction (not just "at the zoom level someone
   happened to test").

   fix/canvas-ux R6a BLOQUANT #2 (final dogfood f23/f24): that fix only ever
   clamped the LEFT edge — `top` was unconditionally `anchorRect.bottom + 6`
   — so a gate row near the BOTTOM of a short viewport (real repro: 844px
   viewport, submit button rendered at y=851) pushed the popover itself
   below the fold, reintroducing the exact "unclickable submit button" bug
   this file was built to eliminate, just via the vertical axis instead of
   the horizontal one. Now uses chrome/popoverPosition.ts's shared flip/clamp
   (measures the REAL rendered box, flips above the anchor when there isn't
   room below, clamps both axes as a final safety net) — same treatment
   applied to chrome/EdgeDropNodePicker.tsx and CanvasContextMenu.tsx.
*/

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePopoverPosition } from './popoverPosition';

export type GateFeedbackAccent = 'purple' | 'amber';

const ACCENT_COLORS: Record<GateFeedbackAccent, { border: string; background: string }> = {
  purple: { border: 'rgba(124,92,255,0.35)', background: '#1C1C2A' },
  amber: { border: 'rgba(251,185,36,0.4)', background: '#1C1C2A' },
};

export interface GateFeedbackPopoverProps {
  /** Screen-space rect of the triggering gate row (getBoundingClientRect at
   *  the moment the caller opened this popover) — anchors the popover just
   *  below it, same convention as AccountPopover's `anchorRect` prop. */
  anchorRect: DOMRect;
  accent: GateFeedbackAccent;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  placeholder: string;
  submitLabel: string;
  cancelLabel: string;
  inputTestId: string;
  submitTestId: string;
  cancelTestId: string;
}

const POPOVER_WIDTH = 260;

/**
 * Reject-feedback / ask_user-answer textarea, portaled above every card and
 * every canvas zoom transform. Closes on outside-click and Escape (same
 * behavior the inline form's own Cancel button already offered) — never a
 * silent no-op: `onCancel` always resets the caller's local text state too.
 */
export function GateFeedbackPopover({
  anchorRect,
  accent,
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  submitLabel,
  cancelLabel,
  inputTestId,
  submitTestId,
  cancelTestId,
}: GateFeedbackPopoverProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const colors = ACCENT_COLORS[accent];

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Stabilized via ref (2026-08-15, same fix as useDismissable.ts's own doc
  // comment describes in full): `onCancel` is a fresh lambda from the
  // caller on every render, and — worse than most other popovers here —
  // this one re-renders on every keystroke the user types into its own
  // textarea (`value`/`onChange` are controlled by the caller). With
  // `onCancel` in the effect's deps, the `window` listeners were torn down
  // and reinstalled on every keystroke while composing feedback, not just
  // on mount/unmount, risking a real Escape/outside-click landing in the
  // gap and being silently dropped.
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    function handlePointerDown(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onCancelRef.current();
    }
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancelRef.current();
      }
    }
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const submitDisabled = !value.trim();
  const { left, top } = usePopoverPosition(
    containerRef,
    { anchorTop: anchorRect.top, anchorBottom: anchorRect.bottom, preferredLeft: anchorRect.left },
    [anchorRect.top, anchorRect.bottom, anchorRect.left, anchorRect.right],
  );

  return createPortal(
    <div
      ref={containerRef}
      data-testid="gate-feedback-popover"
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        left,
        top,
        width: POPOVER_WIDTH,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 8,
        borderRadius: 10,
        background: colors.background,
        border: `1px solid ${colors.border}`,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        zIndex: 2200,
        fontFamily: 'inherit',
      }}
    >
      <textarea
        ref={textareaRef}
        data-testid={inputTestId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        style={{
          width: '100%',
          fontSize: 11.5,
          padding: '6px 8px',
          borderRadius: 6,
          border: '1px solid var(--color-border-3)',
          background: 'var(--color-panel-3)',
          color: 'var(--color-text)',
          fontFamily: 'inherit',
          resize: 'vertical',
        }}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          data-testid={submitTestId}
          disabled={submitDisabled}
          onClick={onSubmit}
          style={{
            flex: 1,
            fontSize: 11,
            fontWeight: 700,
            padding: '5px 8px',
            borderRadius: 6,
            border: 'none',
            cursor: submitDisabled ? 'default' : 'pointer',
            fontFamily: 'inherit',
            background: 'var(--color-danger)',
            color: '#14141C',
            opacity: submitDisabled ? 0.5 : 1,
          }}
        >
          {submitLabel}
        </button>
        <button
          type="button"
          data-testid={cancelTestId}
          onClick={onCancel}
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '5px 10px',
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.18)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            background: 'transparent',
            color: 'var(--color-text-muted)',
          }}
        >
          {cancelLabel}
        </button>
      </div>
    </div>,
    document.body,
  );
}
