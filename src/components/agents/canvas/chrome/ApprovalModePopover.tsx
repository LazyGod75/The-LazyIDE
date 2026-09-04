/* ApprovalModePopover.tsx — W-MODES-ui: the 3-option approval-mode selector,
   shared by BOTH click targets the spec calls for:
     - ProjectGroupNode.tsx's zone-header badge (per-project override,
       `changeApprovalMode(mode, projectId)`);
     - CanvasToolbar.tsx's "⋯" overflow menu "Mode d'approbation par défaut"
       entry (the global default, `changeApprovalMode(mode)` with no
       projectId).

   Same portaled-popover / viewport-clamp pattern as GateFeedbackPopover.tsx
   (chrome/popoverPosition.ts's usePopoverPosition — see that module's
   header for the flip/clamp rationale this reuses verbatim): a
   `position: fixed` box portaled to `document.body`, anchored to the
   trigger's own screen rect, closing on outside-click/Escape, never
   clipped by a canvas card's `overflow: hidden` or scaled by canvas zoom.
*/

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ApprovalMode } from '../../../../lib/agents/types';
import { useI18n } from '../../../../i18n';
import { usePopoverPosition } from './popoverPosition';
import { APPROVAL_MODES, APPROVAL_MODE_DESC_KEY, APPROVAL_MODE_LABEL_KEY } from './ApprovalModeBadge';

export interface ApprovalModePopoverProps {
  /** Screen-space rect of the triggering badge/menu-item, measured via
   *  getBoundingClientRect at the moment the caller opened this popover —
   *  same convention as GateFeedbackPopover's own `anchorRect` prop. */
  anchorRect: DOMRect;
  currentMode: ApprovalMode;
  onSelect: (mode: ApprovalMode) => void;
  onClose: () => void;
  /** Distinguishes the zone-badge popover from the toolbar's global-default
   *  popover in tests/DOM — e.g. 'zone-approval-mode' vs
   *  'toolbar-approval-mode'. */
  testIdPrefix: string;
}

const POPOVER_WIDTH = 268;

export function ApprovalModePopover({ anchorRect, currentMode, onSelect, onClose, testIdPrefix }: ApprovalModePopoverProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);

  // Stabilized via ref (2026-08-15, same fix as useDismissable.ts's own
  // doc comment describes in full): `onClose` is a fresh lambda from the
  // caller on every render, and this component is always mounted while
  // shown (no `open` prop to gate on) — putting it in the effect's deps
  // meant the `window` listeners were torn down/reinstalled on every
  // re-render of this popover, not just on mount/unmount, risking a real
  // keydown landing in the gap and being silently dropped.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    function handlePointerDown(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onCloseRef.current();
    }
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      }
    }
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const { left, top } = usePopoverPosition(
    containerRef,
    { anchorTop: anchorRect.top, anchorBottom: anchorRect.bottom, preferredLeft: anchorRect.left },
    [anchorRect.top, anchorRect.bottom, anchorRect.left, anchorRect.right],
  );

  return createPortal(
    <div
      ref={containerRef}
      data-testid={`${testIdPrefix}-popover`}
      role="dialog"
      aria-modal="true"
      aria-label={t('canvas.zone.approvalMode.selectorTitle')}
      style={{
        position: 'fixed',
        left,
        top,
        width: POPOVER_WIDTH,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 6,
        borderRadius: 10,
        background: '#1C1C2A',
        border: '1px solid rgba(255,255,255,0.14)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        zIndex: 2200,
        fontFamily: 'var(--font-ui)',
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', padding: '4px 6px 2px' }}>
        {t('canvas.zone.approvalMode.selectorTitle')}
      </div>
      {APPROVAL_MODES.map((mode) => {
        const active = mode === currentMode;
        return (
          <button
            key={mode}
            type="button"
            data-testid={`${testIdPrefix}-option-${mode}`}
            role="menuitemradio"
            aria-checked={active}
            onClick={() => {
              onSelect(mode);
              onClose();
            }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              textAlign: 'left',
              padding: '6px 8px',
              borderRadius: 7,
              border: active ? '1px solid var(--color-accent)' : '1px solid transparent',
              background: active ? 'color-mix(in srgb, var(--color-accent) 14%, transparent)' : 'transparent',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: active ? 'var(--color-accent)' : 'var(--color-text)' }}>
              {t(APPROVAL_MODE_LABEL_KEY[mode])}
            </span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.35 }}>
              {t(APPROVAL_MODE_DESC_KEY[mode])}
            </span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
