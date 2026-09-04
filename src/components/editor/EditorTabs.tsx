import { useState } from 'react';
import type { OpenTab } from './editorStore';
import { useI18n } from '../../i18n';
import { fileActivityDotChrome, type FileActivityKind } from '../../lib/agents/codeFileActivity';

interface EditorTabsProps {
  tabs: OpenTab[];
  activeTabPath: string | null;
  onTabClick: (path: string) => void;
  onTabClose: (path: string) => void;
  onReorder?: (fromIdx: number, toIdx: number) => void;
  onTogglePin?: (path: string) => void;
  onSplit?: (path: string) => void;
  /** Code space redesign (D9): per-tab project accent dot. Returns null for
   *  a tab with no known owning project — no dot is rendered then. */
  projectColorForPath?: (path: string) => string | null;
  /** True while a mission is actively writing this tab's file. Kept for
   *  callers that only have the boolean; `liveActivityForPath` wins when both
   *  are passed (it also names the agent). */
  isLiveForPath?: (path: string) => boolean;
  /** Honest per-tab cursor: kind + who/what line from real fleet activity. */
  liveActivityForPath?: (path: string) => { kind: FileActivityKind; label: string } | null;
}

export function EditorTabs({ tabs, activeTabPath, onTabClick, onTabClose, onReorder, onTogglePin, onSplit, projectColorForPath, isLiveForPath, liveActivityForPath }: EditorTabsProps) {
  const { t } = useI18n();
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);

  if (tabs.length === 0) return null;

  const sortedTabs = [...tabs].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return 0;
  });

  return (
    <>
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        background: 'var(--color-bg)',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        height: 36,
        flexShrink: 0,
        overflowX: 'auto',
        overflowY: 'hidden',
      }}
    >
      {sortedTabs.map((tab, idx) => {
        const isActive = tab.path === activeTabPath;
        const isDragOver = dragOverIdx === idx;
        const projectColor = projectColorForPath?.(tab.path) ?? null;
        const activity = liveActivityForPath?.(tab.path) ?? null;
        const liveKind = activity?.kind ?? (isLiveForPath?.(tab.path) ? 'run' : null);
        const liveChrome = liveKind ? fileActivityDotChrome(liveKind) : null;
        return (
          <div
            key={tab.path}
            draggable={!!onReorder}
            onDragStart={e => { setDragIdx(idx); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={e => { if (onReorder) { e.preventDefault(); setDragOverIdx(idx); } }}
            onDrop={e => {
              e.preventDefault();
              if (onReorder && dragIdx !== null && dragIdx !== idx) onReorder(dragIdx, idx);
              setDragIdx(null); setDragOverIdx(null);
            }}
            onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
            onClick={() => onTabClick(tab.path)}
            onContextMenu={e => {
              if (onTogglePin) { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, path: tab.path }); }
            }}
            onMouseEnter={() => setHoveredPath(tab.path)}
            onMouseLeave={() => setHoveredPath(null)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '0 14px',
              background: isActive ? '#1A1A25' : 'transparent',
              borderRight: '1px solid rgba(255,255,255,0.07)',
              borderTop: isActive ? `2px solid ${projectColor ?? '#7C5CFF'}` : '2px solid transparent',
              borderLeft: isDragOver ? '2px solid #7C5CFF' : '2px solid transparent',
              cursor: 'pointer',
              flexShrink: 0,
              opacity: dragIdx === idx ? 0.4 : 1,
              minWidth: 80,
              maxWidth: 160,
            }}
          >
            {projectColor && (
              <span style={{ width: 8, height: 8, borderRadius: 2, background: projectColor, flexShrink: 0 }} />
            )}
            {tab.pinned && (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <circle cx="5" cy="3" r="2" stroke="#7C5CFF" strokeWidth="1.1" />
                <line x1="5" y1="5" x2="5" y2="9" stroke="#7C5CFF" strokeWidth="1.1" strokeLinecap="round" />
              </svg>
            )}
            <span
              style={{
                fontSize: 12,
                color: isActive ? '#D5D8E0' : 'rgba(255,255,255,0.35)',
                fontWeight: isActive ? 500 : undefined,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {tab.filename}
            </span>
            {liveChrome && (
              <span
                data-testid="code-tab-activity-dot"
                data-kind={liveKind}
                title={activity?.label}
                aria-label={activity?.label}
                style={{ width: 7, height: 7, borderRadius: '50%', background: liveChrome.color, animation: liveChrome.animation, display: 'inline-block', flexShrink: 0 }}
              />
            )}
            {!liveChrome && tab.isDirty && hoveredPath !== tab.path && (
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#7C5CFF', display: 'inline-block', flexShrink: 0 }} />
            )}
            <button
              aria-label={t('editorTabs.closeTab')}
              onClick={e => { e.stopPropagation(); onTabClose(tab.path); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 16,
                height: 16,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                opacity: hoveredPath === tab.path ? 1 : 0,
                transition: 'opacity 0.1s',
                flexShrink: 0,
              }}
            >
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                <line x1="1" y1="1" x2="7" y2="7" stroke="rgba(255,255,255,0.5)" strokeWidth="1.3" strokeLinecap="round" />
                <line x1="7" y1="1" x2="1" y2="7" stroke="rgba(255,255,255,0.5)" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
    {contextMenu && (
      <>
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }} onClick={() => setContextMenu(null)} onContextMenu={e => { e.preventDefault(); setContextMenu(null); }} />
        <div style={{ position: 'fixed', top: contextMenu.y, left: contextMenu.x, background: '#1C1C2A', border: '1px solid rgba(124,92,255,0.3)', borderRadius: 6, padding: '4px 0', zIndex: 1000, minWidth: 160, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
          {onTogglePin && (
            <CtxItem label={tabs.find(tb => tb.path === contextMenu.path)?.pinned ? t('editorTabs.unpinTab') : t('editorTabs.pinTab')} onClick={() => { onTogglePin(contextMenu.path); setContextMenu(null); }} />
          )}
          {onSplit && (
            <CtxItem label={t('editorTabs.splitEditor')} onClick={() => { onSplit(contextMenu.path); setContextMenu(null); }} />
          )}
          <CtxItem label={t('editorTabs.closeTabMenuItem')} onClick={() => { onTabClose(contextMenu.path); setContextMenu(null); }} />
          <CtxItem label={t('editorTabs.closeOthers')} onClick={() => { tabs.filter(tb => tb.path !== contextMenu.path).forEach(tb => onTabClose(tb.path)); setContextMenu(null); }} />
        </div>
      </>
    )}
    </>
  );
}

function CtxItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        color: '#D5D8E0',
        cursor: 'pointer',
        fontSize: 12,
        fontFamily: 'inherit',
        padding: '6px 14px',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(124,92,255,0.1)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      {label}
    </button>
  );
}
