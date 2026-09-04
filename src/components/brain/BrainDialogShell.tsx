/* Shared overlay chrome for Brain publish/import dialogs. */

import type { RefObject, ReactNode } from 'react';
import {
  BRAIN_DIALOG_OVERLAY,
  BRAIN_DIALOG_PANEL,
  BRAIN_GHOST_BUTTON,
  useDialogEscape,
} from './brainDialogChrome';

export function BrainDialogShell({
  titleId,
  panelRef,
  onClose,
  children,
}: {
  titleId: string;
  panelRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  useDialogEscape(panelRef, onClose);
  return (
    <div
      style={BRAIN_DIALOG_OVERLAY}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={BRAIN_DIALOG_PANEL}
      >
        {children}
      </div>
    </div>
  );
}

export function GhostButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} style={BRAIN_GHOST_BUTTON}>
      {children}
    </button>
  );
}

export function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '7px 16px',
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: 'none',
        background: disabled ? 'rgba(124,92,255,0.4)' : '#7C5CFF',
        color: '#fff',
        fontFamily: 'inherit',
        opacity: disabled ? 0.7 : 1,
      }}
    >
      {children}
    </button>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>{children}</div>
  );
}
