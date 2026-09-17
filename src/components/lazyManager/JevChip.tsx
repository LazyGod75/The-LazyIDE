/* JevChip — the Jev-mode indicator/toggle in the LazyManager header.

   Three honest states, all discoverable in one click:
     no key        → dimmed chip; popover explains + links to Settings ▸ Jev
     key, mode off → neutral chip; popover explains + an Enable button
     key, mode on  → accent chip; popover lists what the mode does + Disable

   Re-reads live on every 'jev:stateChange' bus event, so saving/removing
   the key in Settings updates the chip without a restart.
*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { on, emit } from '../../lib/bus';
import { isJevConfigured, isJevModeOn, setJevModeEnabled } from '../../lib/jev/jevMode';
import { useI18n } from '../../i18n';

export function JevChip() {
  const { t } = useI18n();
  const [configured, setConfigured] = useState(isJevConfigured());
  const [enabled, setEnabled] = useState(isJevModeOn());
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => on('jev:stateChange', (p) => {
    setConfigured(p.configured);
    setEnabled(p.enabled);
  }), []);

  // Outside-click / Escape close — same convention as the header's own
  // acceptance popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const goSettings = useCallback(() => {
    setOpen(false);
    emit('nav:navigateSpace', { space: 'settings', tab: 'jev' });
  }, []);

  const toggleMode = useCallback(() => {
    setJevModeEnabled(!enabled);
  }, [enabled]);

  const chipStyle = enabled
    ? {
        background: 'rgba(124,92,255,0.14)',
        color: 'var(--color-accent-light)',
        border: '1px solid rgba(124,92,255,0.4)',
      }
    : configured
      ? {
          background: 'transparent',
          color: 'var(--color-text-muted)',
          border: '1px solid var(--color-border-2)',
        }
      : {
          background: 'transparent',
          color: 'var(--color-text-disabled)',
          border: '1px dashed var(--color-border-2)',
        };

  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        data-testid="jev-chip"
        onClick={() => setOpen((v) => !v)}
        title={t('lazyManager.jev.tooltip')}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          fontSize: 11.5, fontWeight: 600, padding: '3px 9px',
          borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
          ...chipStyle,
        }}
      >
        <span style={{
          width: 6, height: 6, borderRadius: 3,
          background: enabled ? 'var(--color-accent-light)' : 'var(--color-text-disabled)',
        }} />
        Jev
      </button>

      {open && (
        <div
          data-testid="jev-chip-popover"
          style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 60,
            width: 300, padding: '12px 14px', borderRadius: 10,
            background: 'var(--color-panel)', border: '1px solid var(--color-border)',
            boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
            display: 'flex', flexDirection: 'column', gap: 10,
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-text)' }}>
            {t('lazyManager.jev.popoverTitle')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            {t('lazyManager.jev.popoverDesc')}
          </div>
          <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <li style={LI}>{t('lazyManager.jev.featAskJev')}</li>
            <li style={LI}>{t('lazyManager.jev.featWakeup')}</li>
            <li style={LI}>{t('lazyManager.jev.featLazybot')}</li>
            <li style={LI}>{t('lazyManager.jev.featReview')}</li>
            <li style={LI}>{t('lazyManager.jev.featRecall')}</li>
          </ul>
          <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
            {!configured ? (
              <button type="button" onClick={goSettings} style={BTN_PRIMARY} data-testid="jev-chip-configure">
                {t('lazyManager.jev.configure')}
              </button>
            ) : (
              <button type="button" onClick={toggleMode} style={enabled ? BTN_NEUTRAL : BTN_PRIMARY} data-testid="jev-chip-toggle">
                {enabled ? t('lazyManager.jev.disable') : t('lazyManager.jev.enable')}
              </button>
            )}
            <button type="button" onClick={goSettings} style={BTN_NEUTRAL}>
              {t('lazyManager.jev.openSettings')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const LI: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--color-text-muted)',
  lineHeight: 1.4,
};

const BTN_PRIMARY: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 7, cursor: 'pointer',
  fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
  background: 'rgba(124,92,255,0.2)', border: '1px solid rgba(124,92,255,0.5)',
  color: '#B8A9FF',
};

const BTN_NEUTRAL: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 7, cursor: 'pointer',
  fontSize: 12, fontWeight: 500, fontFamily: 'inherit',
  background: 'transparent', border: '1px solid var(--color-border-2)',
  color: 'var(--color-text-muted)',
};
