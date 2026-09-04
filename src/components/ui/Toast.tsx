/* Toast — lightweight notification system.
   ToastProvider + useToast hook + Toast component.
   Bottom-right, dark/violet, auto-dismiss (3s default).
   Non-blocking.

   The context object and the useToast/useToastSafe hooks live in
   ToastContext.ts, NOT in this file — see that file's header for why
   ("useToast must be used inside ToastProvider" firing during Vite HMR).
   This file re-exports them so the ~40 existing `from '.../ui/Toast'`
   imports across the app keep working unchanged; only the creation site of
   the context moved.
*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { ToastContext, type ToastAction, type ToastItem, type ToastType } from './ToastContext';

export type { ToastType, ToastItem, ToastAction } from './ToastContext';
// eslint-disable-next-line react-refresh/only-export-components
export { useToast, useToastSafe } from './ToastContext';

// ── Single Toast item ──────────────────────────────────────────────

const TYPE_COLORS: Record<ToastType, { bg: string; border: string; icon: string; text: string }> = {
  success: {
    bg: 'rgba(34,197,94,0.08)',
    border: 'rgba(34,197,94,0.25)',
    icon: '✓',
    text: '#66E27A',
  },
  error: {
    bg: 'rgba(239,68,68,0.1)',
    border: 'rgba(239,68,68,0.3)',
    icon: '✕',
    text: '#FCA5A5',
  },
  warning: {
    bg: 'rgba(255,199,107,0.08)',
    border: 'rgba(255,199,107,0.25)',
    icon: '!',
    text: '#FFC76B',
  },
  info: {
    bg: 'rgba(124,92,255,0.10)',
    border: 'rgba(124,92,255,0.3)',
    icon: 'i',
    text: '#A78BFF',
  },
};

function ToastEntry({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const [visible, setVisible] = useState(false);
  const colors = TYPE_COLORS[item.type];
  const { t } = useI18n();

  const handleDismiss = useCallback(() => {
    setVisible(false);
    setTimeout(() => onDismiss(item.id), 300);
  }, [item.id, onDismiss]);

  // Animate in
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  // Auto-dismiss (duration <= 0 makes the toast sticky, e.g. an action prompt)
  useEffect(() => {
    const duration = item.duration ?? 3000;
    if (duration <= 0) return;
    const t = setTimeout(handleDismiss, duration);
    return () => clearTimeout(t);
  }, [item.id, item.duration, handleDismiss]);

  const handleAction = useCallback(() => {
    item.action?.onClick();
    handleDismiss();
  }, [item.action, handleDismiss]);

  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        background: '#16161D',
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${colors.text}`,
        borderRadius: 8,
        minWidth: 240,
        maxWidth: 360,
        boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
        transform: visible ? 'translateX(0)' : 'translateX(calc(100% + 20px))',
        opacity: visible ? 1 : 0,
        transition: 'transform 0.25s cubic-bezier(0.16,1,0.3,1), opacity 0.25s ease',
        willChange: 'transform, opacity',
        backdropFilter: 'blur(8px)',
      } as React.CSSProperties}
    >
      {/* Icon badge */}
      <div
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: `${colors.text}20`,
          border: `1px solid ${colors.text}40`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          fontWeight: 700,
          color: colors.text,
          flexShrink: 0,
          fontFamily: 'monospace',
        }}
      >
        {colors.icon}
      </div>

      {/* Message */}
      <span
        style={{
          fontSize: 12,
          color: '#E6E8EF',
          lineHeight: 1.4,
          flex: 1,
        }}
      >
        {item.message}
      </span>

      {/* Optional action button (e.g. "Restart") */}
      {item.action && (
        <button
          onClick={handleAction}
          style={{
            background: `${colors.text}1A`,
            border: `1px solid ${colors.text}40`,
            color: colors.text,
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 1,
            padding: '5px 10px',
            borderRadius: 6,
            flexShrink: 0,
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
          }}
        >
          {item.action.label}
        </button>
      )}

      {/* Dismiss button — keyboard accessible */}
      <button
        aria-label={t('common.close')}
        onClick={handleDismiss}
        style={{
          background: 'none',
          border: 'none',
          color: 'rgba(255,255,255,0.35)',
          cursor: 'pointer',
          fontSize: 14,
          lineHeight: 1,
          padding: '0 2px',
          flexShrink: 0,
          fontFamily: 'monospace',
        }}
      >
        x
      </button>
    </div>
  );
}

// ── ToastProvider ──────────────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counterRef = useRef(0);

  const toast = useCallback(
    (message: string, type: ToastType = 'info', duration?: number, action?: ToastAction) => {
      counterRef.current += 1;
      const id = `toast-${Date.now()}-${counterRef.current}`;
      setToasts(prev => [...prev, { id, message, type, duration, action }]);
    },
    [],
  );

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}

      {/* Toast container — bottom-right */}
      <div
        aria-live="polite"
        aria-atomic="false"
        style={{
          position: 'fixed',
          bottom: 20,
          right: 20,
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          alignItems: 'flex-end',
          pointerEvents: 'none',
        }}
      >
        {toasts.map(item => (
          <div key={item.id} style={{ pointerEvents: 'auto' }}>
            <ToastEntry item={item} onDismiss={dismiss} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
