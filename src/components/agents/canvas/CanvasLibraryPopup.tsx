/* CanvasLibraryPopup — a floating popup on the right side of the canvas
   showing the agent library with 2 tabs: general library + favorites.
   Reuses ECC_AGENTS and favorites logic from AgentLibrary.tsx but in a
   compact popup form, not a full page.

   Triggered by a circular button on the right edge of the canvas.
*/

import { useCallback, useMemo, useState, type RefObject } from 'react';
import type { LazyAgent } from '../../../lib/agents/agentDef';
import { eccToLazyAgent } from '../../../lib/agents/eccAgents';
import { ECC_AGENTS } from '../../../lib/agents/eccAgents';
import type { EccAgent } from '../../../lib/agents/eccAgents';
import { useI18n } from '../../../i18n';
import { useDismissable } from '../../common/useDismissable';

const FAV_KEY = 'lazy.agent.favorites';

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveFavorites(favs: Set<string>): void {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favs]));
  } catch {
    // ignore
  }
}

interface CanvasLibraryPopupProps {
  open: boolean;
  onClose: () => void;
  onRunAgent: (agent: LazyAgent, task: string) => void;
  /** Ref to the round toggle button that opens/closes this popup
   *  (CanvasFloatingButtons.tsx's "Agent Library" button) — ignored by the
   *  outside-pointerdown handler so a re-click doesn't close-then-reopen it.
   *  See useDismissable.ts's header comment for the exact race this
   *  prevents (this popup's own full-bleed backdrop already makes the race
   *  unreachable in a real browser, since it sits above the trigger button —
   *  this is defense-in-depth + dedup onto the shared hook, not a required
   *  fix). */
  triggerRef?: RefObject<HTMLElement | null>;
}

export function CanvasLibraryPopup({ open, onClose, onRunAgent, triggerRef }: CanvasLibraryPopupProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'general' | 'favorites'>('general');
  const [favorites, setFavorites] = useState<Set<string>>(() => loadFavorites());
  const [searchQuery, setSearchQuery] = useState('');
  const [runAgent, setRunAgent] = useState<EccAgent | null>(null);
  const [runTask, setRunTask] = useState('');
  const panelRef = useDismissable<HTMLDivElement>({
    open,
    onClose,
    ignoreRefs: triggerRef ? [triggerRef] : undefined,
  });

  const toggleFavorite = useCallback((name: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      saveFavorites(next);
      return next;
    });
  }, []);

  const filteredEcc = useMemo(() => {
    if (!searchQuery.trim()) return ECC_AGENTS;
    const q = searchQuery.toLowerCase();
    return ECC_AGENTS.filter((a) =>
      a.name.includes(q) ||
      a.displayName.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      a.tags.some((tag) => tag.includes(q))
    );
  }, [searchQuery]);

  const favoriteEccAgents = useMemo(
    () => ECC_AGENTS.filter((a) => favorites.has(a.name)),
    [favorites],
  );

  const handleRun = useCallback((ecc: EccAgent) => {
    setRunAgent(ecc);
    setRunTask(`Run the ${ecc.displayName} agent.`);
  }, []);

  const confirmRun = useCallback(() => {
    if (!runAgent) return;
    const agent = eccToLazyAgent(runAgent);
    onRunAgent(agent, runTask);
    setRunAgent(null);
    setRunTask('');
    onClose();
  }, [runAgent, runTask, onRunAgent, onClose]);

  if (!open) return null;

  const agentsToShow = tab === 'favorites' ? favoriteEccAgents : filteredEcc;

  return (
    <>
      {/* Backdrop */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.35)',
          zIndex: 1099,
        }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      />
      {/* Popup panel */}
      <div
        ref={panelRef}
        data-testid="canvas-library-popup"
        role="dialog"
        aria-label={t('agents.library.title')}
        style={{
          position: 'fixed',
          top: '50%',
          right: 16,
          transform: 'translateY(-50%)',
          width: 420,
          maxHeight: '70vh',
          zIndex: 1100,
          background: 'var(--color-panel-2)',
          border: '1px solid rgba(255,255,255,0.14)',
          borderRadius: 12,
          boxShadow: '4px 4px 0 rgba(0,0,0,0.4)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '12px 16px 8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#E2E2F0' }}>
            {t('agents.library.title')}
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'rgba(255,255,255,0.5)',
              fontSize: 16,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            ×
          </button>
        </div>

        {/* Search */}
        <div style={{ padding: '8px 16px' }}>
          <input
            type="text"
            placeholder={t('agents.library.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: '100%',
              background: 'var(--color-bg)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 7,
              padding: '6px 12px',
              color: '#E2E2F0',
              fontSize: 12,
              fontFamily: 'inherit',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex',
          gap: 4,
          padding: '0 16px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}>
          {([
            { id: 'general' as const, label: t('agents.library.tabGeneral'), count: filteredEcc.length },
            { id: 'favorites' as const, label: t('agents.library.tabFavorites'), count: favoriteEccAgents.length },
          ]).map((tabDef) => (
            <button
              key={tabDef.id}
              type="button"
              onClick={() => setTab(tabDef.id)}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: tab === tabDef.id ? 600 : 400,
                color: tab === tabDef.id ? '#E2E2F0' : 'rgba(255,255,255,0.40)',
                background: 'none',
                border: 'none',
                borderBottom: tab === tabDef.id ? '2px solid var(--color-accent)' : '2px solid transparent',
                cursor: 'pointer',
                fontFamily: 'inherit',
                marginBottom: -1,
              }}
            >
              {tabDef.label} ({tabDef.count})
            </button>
          ))}
        </div>

        {/* Agent list */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}>
          {agentsToShow.length === 0 && (
            <div style={{
              padding: '24px 16px',
              textAlign: 'center',
              color: 'rgba(255,255,255,0.35)',
              fontSize: 12,
            }}>
              {tab === 'favorites'
                ? '★ ' + t('agents.library.tabFavorites') + ' — 0'
                : t('agents.library.emptyTitle')}
            </div>
          )}
          {agentsToShow.map((agent) => (
            <div
              key={agent.name}
              data-testid={`canvas-library-agent-${agent.name}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                borderRadius: 7,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid transparent',
                cursor: 'pointer',
                transition: 'background-color 120ms ease, border-color 120ms ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
                e.currentTarget.style.borderColor = 'transparent';
              }}
            >
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleFavorite(agent.name); }}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: favorites.has(agent.name) ? '#FFC76B' : 'rgba(255,255,255,0.25)',
                  fontSize: 14,
                  cursor: 'pointer',
                  flexShrink: 0,
                  fontFamily: 'inherit',
                }}
                title={favorites.has(agent.name) ? 'Retirer des favoris' : 'Ajouter aux favoris'}
              >
                {favorites.has(agent.name) ? '★' : '☆'}
              </button>
              <div
                onClick={() => handleRun(agent)}
                style={{ flex: 1, minWidth: 0 }}
              >
                <div style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#E2E2F0',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {agent.displayName}
                </div>
                <div style={{
                  fontSize: 11,
                  color: 'rgba(255,255,255,0.40)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {agent.description}
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleRun(agent); }}
                style={{
                  padding: '3px 10px',
                  borderRadius: 5,
                  border: 'none',
                  background: 'var(--color-accent)',
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                {t('agents.library.runBtn')}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Run prompt modal */}
      {runAgent && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1200,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setRunAgent(null); }}
        >
          <div style={{
            background: 'var(--color-panel-2)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 12,
            width: 460,
            padding: 24,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#E2E2F0' }}>
              {t('agents.library.runTitle')} : {runAgent.displayName}
            </div>
            <textarea
              value={runTask}
              onChange={(e) => setRunTask(e.target.value)}
              autoFocus
              style={{
                background: 'var(--color-bg)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 7,
                padding: '10px 12px',
                color: '#E2E2F0',
                fontSize: 13,
                fontFamily: 'inherit',
                outline: 'none',
                resize: 'vertical',
                minHeight: 80,
                lineHeight: 1.5,
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setRunAgent(null)}
                style={{
                  padding: '6px 16px',
                  borderRadius: 7,
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'transparent',
                  color: 'rgba(255,255,255,0.6)',
                  fontSize: 13,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={confirmRun}
                style={{
                  padding: '6px 20px',
                  borderRadius: 7,
                  border: 'none',
                  background: 'var(--color-accent)',
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {t('agents.library.runBtn')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
