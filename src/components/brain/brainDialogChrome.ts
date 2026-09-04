/* Overlay/panel styles + Escape-to-close for Brain GitHub dialogs. */

import { useEffect, type CSSProperties, type RefObject } from 'react';

export const BRAIN_DIALOG_OVERLAY: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.7)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

export const BRAIN_DIALOG_PANEL: CSSProperties = {
  background: '#18181E',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 12,
  padding: '24px',
  width: 440,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

export const BRAIN_GHOST_BUTTON: CSSProperties = {
  padding: '7px 16px',
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(255,255,255,0.05)',
  color: 'rgba(255,255,255,0.6)',
  fontFamily: 'inherit',
};

export function useDialogEscape(
  panelRef: RefObject<HTMLDivElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    const panel = panelRef.current;
    panel?.addEventListener('keydown', handleKeyDown);
    panel?.querySelector<HTMLElement>('button, input')?.focus();
    return () => panel?.removeEventListener('keydown', handleKeyDown);
  }, [onClose, panelRef]);
}
