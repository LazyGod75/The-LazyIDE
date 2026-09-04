/* LazyManagerHistoryDrawer — unified 320px side drawer merging both
   orchestrator and coder session lists. Replaces the old separate
   dropdowns (ManagerHistoryButton + AssistantHeader's history dropdown)
   with a single, searchable, date-grouped panel.

   Backdrop + Escape-to-close mirrors MissionDetailDrawer.tsx's own proven
   pattern (see that file's doc comment): a full-bleed backdrop div calls
   onClose, the panel itself stops that click's propagation so clicking
   INSIDE the drawer never closes it. This replaces a fragile
   document-level "mousedown outside the drawer" listener, which raced with
   the header's own toggle button (closing on mousedown, then the button's
   click re-opening it before React had a chance to settle on the closed
   state). */

import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { formatZoneDigestAge } from '../../lib/journal/zoneDigest';
import type { UnifiedSession, ManagerMode } from './lazyManagerStore';

interface LazyManagerHistoryDrawerProps {
  sessions: UnifiedSession[];
  onOpenSession: (id: string, source: ManagerMode) => void;
  onDeleteSession: (id: string, source: ManagerMode) => void;
  onClose: () => void;
  disabled: boolean;
}

function modeChipLabel(source: ManagerMode, t: (key: string) => string): string {
  return source === 'orchestrator' ? t('lazyManager.mode.orchestrator') : t('lazyManager.mode.coder');
}

function modeChipColor(source: ManagerMode): { bg: string; color: string } {
  return source === 'orchestrator'
    ? { bg: 'rgba(124,92,255,0.15)', color: 'var(--color-accent-pale)' }
    : { bg: 'rgba(74,192,252,0.12)', color: '#74C0FC' };
}

function groupByDate(sessions: UnifiedSession[], t: (key: string) => string): Array<{ label: string; items: UnifiedSession[] }> {
  const now = Date.now();
  const today: UnifiedSession[] = [];
  const yesterday: UnifiedSession[] = [];
  const thisWeek: UnifiedSession[] = [];
  const older: UnifiedSession[] = [];

  for (const s of sessions) {
    const age = now - s.updatedAt;
    if (age < 86_400_000) today.push(s);
    else if (age < 2 * 86_400_000) yesterday.push(s);
    else if (age < 7 * 86_400_000) thisWeek.push(s);
    else older.push(s);
  }

  const groups: Array<{ label: string; items: UnifiedSession[] }> = [];
  if (today.length) groups.push({ label: t('lazyManager.history.today'), items: today });
  if (yesterday.length) groups.push({ label: t('lazyManager.history.yesterday'), items: yesterday });
  if (thisWeek.length) groups.push({ label: t('lazyManager.history.thisWeek'), items: thisWeek });
  if (older.length) groups.push({ label: t('lazyManager.history.older'), items: older });
  return groups;
}

export function LazyManagerHistoryDrawer({
  sessions,
  onOpenSession,
  onDeleteSession,
  onClose,
  disabled,
}: LazyManagerHistoryDrawerProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');

  // Escape closes — same affordance the backdrop click gives, for keyboard
  // users (matches MissionDetailDrawer.tsx's identical Escape handler).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const filtered = useMemo(() => {
    if (!query.trim()) return sessions;
    const q = query.toLowerCase();
    return sessions.filter(s =>
      s.preview.toLowerCase().includes(q) || s.id.toLowerCase().includes(q),
    );
  }, [sessions, query]);

  const groups = useMemo(() => groupByDate(filtered, t), [filtered, t]);

  return (
    <div
      data-testid="lazy-manager-history-backdrop"
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 200,
        background: 'rgba(6,6,10,0.35)',
      }}
    >
      <div
        data-testid="lazy-manager-history-drawer"
        onClick={e => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 320,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--color-panel-2, #0B0B12)',
          borderLeft: '1px solid var(--color-border-2)',
          boxShadow: '-8px 0 24px rgba(0,0,0,0.3)',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 16px 10px',
          borderBottom: '1px solid var(--color-border-2)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)', flex: 1 }}>
            {t('lazyManager.history.title')}
          </span>
          <button
            type="button"
            onClick={onClose}
            title={t('lazyManager.history.close')}
            style={{
              width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: 'rgba(255,255,255,0.35)', background: 'transparent',
              border: 'none', borderRadius: 5, fontFamily: 'inherit', flexShrink: 0,
              transition: 'color 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.8)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.35)'; }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div style={{ padding: '8px 16px', flexShrink: 0 }}>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('lazyManager.history.search')}
            style={{
              width: '100%', background: 'var(--color-input)', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8, padding: '7px 12px', color: 'var(--color-text)', fontSize: 12,
              fontFamily: 'inherit', outline: 'none',
            }}
          />
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 12px', scrollbarWidth: 'thin' }}>
          {groups.length === 0 ? (
            <div style={{ padding: '24px 16px', fontSize: 12, color: 'rgba(255,255,255,0.35)', textAlign: 'center' }}>
              {query.trim() ? t('lazyManager.history.noResults') : t('lazyManager.history.empty')}
            </div>
          ) : (
            groups.map(group => (
              <div key={group.label}>
                <div style={{
                  padding: '10px 16px 4px', fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.3)',
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                }}>
                  {group.label}
                </div>
                {group.items.map(session => {
                  const chip = modeChipColor(session.source);
                  return (
                    <div
                      key={session.id}
                      data-testid="lazy-manager-history-row"
                      title={disabled ? t('lazyManager.busyHint') : undefined}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px',
                        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
                        transition: 'background 0.12s',
                      }}
                      onMouseEnter={e => { if (!disabled) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.04)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                      onClick={() => {
                        if (disabled) return;
                        onOpenSession(session.id, session.source);
                        onClose();
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 11.5, color: '#D5D8E0', whiteSpace: 'nowrap', overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}>
                          {session.preview || t('lazyManager.history.untitled')}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                          <span style={{
                            fontSize: 9, fontWeight: 600, background: chip.bg, color: chip.color,
                            borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap',
                          }}>
                            {modeChipLabel(session.source, t)}
                          </span>
                          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
                            {formatZoneDigestAge(session.updatedAt, t)} · {t('lazyManager.history.messages', { count: session.messageCount })}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        data-testid="lazy-manager-history-delete"
                        onClick={e => { e.stopPropagation(); onDeleteSession(session.id, session.source); }}
                        title={t('lazyManager.history.delete')}
                        style={{
                          width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', color: 'rgba(255,255,255,0.25)', background: 'transparent',
                          border: 'none', borderRadius: 4, fontFamily: 'inherit', flexShrink: 0,
                          transition: 'color 0.12s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,80,80,0.8)'; }}
                        onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.25)'; }}
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
