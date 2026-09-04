/* TerminalsSpace — dedicated multi-terminal space.
   Manages a list of terminal sessions.
   Each session renders a TerminalView (mock PTY).
   Max 400 lines.
*/

import { useState, useCallback } from 'react';
import { TerminalView } from '../components/terminal/TerminalView';
import { useI18n } from '../i18n';
import { useAppContext } from '../app/AppContext';

// ── Types ─────────────────────────────────────────────────────────

interface TerminalSession {
  readonly id: string;
  readonly label: string;
}

// ── Helpers ───────────────────────────────────────────────────────

let sessionCounter = 1;

function createSession(): TerminalSession {
  const id = `term-${Date.now()}-${sessionCounter}`;
  const label = `Terminal ${sessionCounter}`;
  sessionCounter += 1;
  return { id, label };
}

// ── Tab bar ───────────────────────────────────────────────────────

interface TabBarProps {
  sessions: ReadonlyArray<TerminalSession>;
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
}

function TabBar({ sessions, activeId, onSelect, onAdd, onClose }: TabBarProps) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        background: 'var(--color-panel-3)',
        height: 38,
        flexShrink: 0,
        overflowX: 'auto',
      }}
    >
      {sessions.map(s => {
        const isActive = s.id === activeId;
        return (
          <div
            key={s.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              borderRight: '1px solid rgba(255,255,255,0.05)',
              background: isActive ? 'var(--color-panel)' : 'transparent',
              borderTop: `2px solid ${isActive ? '#7C5CFF' : 'transparent'}`,
              flexShrink: 0,
            }}
          >
            <button
              onClick={() => onSelect(s.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '0 12px',
                fontSize: 11,
                color: isActive ? '#D5D8E0' : 'rgba(255,255,255,0.35)',
                fontWeight: isActive ? 500 : undefined,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                height: '100%',
              }}
            >
              <span style={{ marginRight: 6, opacity: 0.5, fontSize: 10 }}>▶</span>
              {s.label}
            </button>

            {sessions.length > 1 && (
              <button
                onClick={e => { e.stopPropagation(); onClose(s.id); }}
                title={t('terminals.close')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 20,
                  height: 20,
                  marginRight: 4,
                  fontSize: 10,
                  color: 'rgba(255,255,255,0.2)',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}

      {/* Add terminal button */}
      <button
        onClick={onAdd}
        title={t('terminals.newTerminal')}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          fontSize: 16,
          color: 'rgba(255,255,255,0.3)',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          lineHeight: 1,
          fontFamily: 'inherit',
        }}
      >
        +
      </button>

      <div style={{ flex: 1 }} />

      {/* Status indicator */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0 14px',
          gap: 6,
          fontSize: 11,
          color: 'rgba(255,255,255,0.2)',
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: '#66E27A',
            display: 'inline-block',
          }}
        />
        {t('terminals.sessionCount', { count: sessions.length })}
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────

function EmptyState({ onAdd }: { onAdd: () => void }) {
  const { t } = useI18n();
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        color: 'rgba(255,255,255,0.2)',
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 14,
          background: 'rgba(255, 123, 176, 0.08)',
          border: '1px solid rgba(255, 123, 176, 0.18)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 24,
          color: '#FF7BB0',
        }}
      >
        &gt;_
      </div>
      <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.3)', margin: 0 }}>
        {t('terminals.noTerminal')}
      </p>
      <button
        onClick={onAdd}
        style={{
          padding: '7px 16px',
          fontSize: 12,
          background: 'rgba(255,255,255,0.07)',
          color: 'rgba(255,255,255,0.6)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 6,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {t('terminals.addNew')}
      </button>
    </div>
  );
}

// ── TerminalsSpace ────────────────────────────────────────────────

export function TerminalsSpace() {
  const { projectRoot } = useAppContext();
  const [sessions, setSessions] = useState<ReadonlyArray<TerminalSession>>(
    () => [createSession()]
  );
  const [activeId, setActiveId] = useState<string>(() => sessions[0].id);

  const handleAdd = useCallback(() => {
    const s = createSession();
    setSessions(prev => [...prev, s]);
    setActiveId(s.id);
  }, []);

  const handleClose = useCallback((id: string) => {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id);
      if (next.length === 0) return prev; // keep at least 1
      return next;
    });
    setActiveId(prev => {
      if (prev !== id) return prev;
      const remaining = sessions.filter(s => s.id !== id);
      return remaining[remaining.length - 1]?.id ?? '';
    });
  }, [sessions]);

  if (sessions.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <EmptyState onAdd={handleAdd} />
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--color-bg)',
      }}
    >
      <TabBar
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onAdd={handleAdd}
        onClose={handleClose}
      />

      {/* Render all sessions, show/hide via display to preserve PTY state */}
      {sessions.map(s => (
        <div
          key={s.id}
          style={{
            flex: 1,
            overflow: 'hidden',
            display: s.id === activeId ? 'flex' : 'none',
          }}
        >
          <TerminalView terminalId={s.id} cwd={projectRoot} />
        </div>
      ))}
    </div>
  );
}
