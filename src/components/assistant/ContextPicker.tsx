/* ContextPicker — popover for @-mention context selection.
   Shows open files, project files, and brain nodes.
   Inserts a reference into the composer text.
*/

import { useState, useEffect, useRef, useCallback } from 'react';
import { useEditorStore } from '../editor/editorStore';
import { getPlatform } from '../../lib/platform';
import type { BrainSearchResult, DirEntry } from '../../lib/platform/types';
import { useI18n } from '../../i18n';

// Port used by the LazyBrain sidecar daemon.
// Desktop (Tauri) binds 37990; web dev proxy uses 7700.
// TODO: replace with a shared constant once a platform/constants module is available.
function getBrainDaemonPort(): number {
  const platform = getPlatform();
  return platform.name === 'tauri' ? 37990 : 7700;
}

export interface ContextItem {
  kind: 'file' | 'brain' | 'git' | 'terminal' | 'web' | 'docs';
  label: string;
  ref: string;
  content?: string;
}

interface ContextPickerProps {
  query: string;
  onSelect: (item: ContextItem) => void;
  onClose: () => void;
  anchorRect: DOMRect | null;
}

type Tab = 'files' | 'brain' | 'git' | 'terminal' | 'web';

// Fetch project files from filesystem when no tabs are open
async function fetchProjectFiles(platform: ReturnType<typeof getPlatform>, projectRoot: string): Promise<DirEntry[]> {
  const results: DirEntry[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 3 || results.length > 30) return;
    try {
      const entries = await platform.fs.readDir(dir);
      for (const e of entries) {
        if (results.length >= 30) break;
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
        if (e.isDir) {
          await walk(e.path, depth + 1);
        } else {
          const ext = e.name.split('.').pop()?.toLowerCase() ?? '';
          if (['ts','tsx','js','jsx','py','rs','go','json','md','css','html'].includes(ext)) {
            results.push(e);
          }
        }
      }
    } catch { /* ignore */ }
  }
  await walk(projectRoot || '/project', 0);
  return results;
}

export function ContextPicker({ query, onSelect, onClose, anchorRect }: ContextPickerProps) {
  const { tabs } = useEditorStore();
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<Tab>('files');
  const [brainResults, setBrainResults] = useState<BrainSearchResult[]>([]);
  const [brainLoading, setBrainLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [projectFiles, setProjectFiles] = useState<DirEntry[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.toLowerCase().replace(/^@/, '').trim();

  // Load project files from filesystem when no tabs are open
  useEffect(() => {
    if (tabs.length > 0) return;
    const platform = getPlatform();
    fetchProjectFiles(platform, '').then(files => setProjectFiles(files)).catch(() => {});
  }, [tabs.length]);

  const fileItems: ContextItem[] = (tabs.length > 0 ? tabs : []).map(t => ({
    kind: 'file' as const,
    label: t.filename,
    ref: `@file:${t.path}`,
    content: t.content,
  }));

  // If no tabs are open, use project files from filesystem
  const projectFileItems: ContextItem[] = projectFiles.map(f => ({
    kind: 'file' as const,
    label: f.name,
    ref: `@file:${f.path}`,
  }));

  const allFileItems = tabs.length > 0 ? fileItems : projectFileItems;

  const brainItems: ContextItem[] = brainResults.map(r => ({
    kind: 'brain' as const,
    label: r.title,
    ref: `@brain:${r.id}`,
  }));

  const allItems = activeTab === 'files' ? allFileItems : brainItems;

  const handleTabChange = useCallback((tab: Tab) => {
    setActiveTab(tab);
    setSelectedIndex(0);
  }, []);

  useEffect(() => {
    if (activeTab !== 'brain') return;
    // Auto-search even with empty query to show recent/default results
    const searchQuery = q || 'recent';
    let cancelled = false;
    const platform = getPlatform();
    Promise.resolve().then(() => {
      if (cancelled) return;
      setBrainLoading(true);
      return platform.brain.search(searchQuery, 8);
    }).then(results => {
      if (!cancelled) {
        setBrainResults(results ?? []);
        setBrainLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setBrainLoading(false);
    });
    return () => { cancelled = true; };
  }, [activeTab, q]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, allItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (allItems[selectedIndex]) onSelect(allItems[selectedIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [allItems, selectedIndex, onSelect, onClose]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Position: fixed overlay, clamped to viewport, fixed height to prevent jumping
  const style: React.CSSProperties = anchorRect
    ? {
        position: 'fixed',
        top: Math.max(8, anchorRect.top - 220),
        left: Math.min(anchorRect.left, window.innerWidth - 340),
        width: 320,
        height: 220,
      }
    : {
        position: 'fixed',
        bottom: 120,
        right: 16,
        width: 320,
        height: 240,
      };

  return (
    <div
      style={{
        ...style,
        background: '#1C1C2A',
        border: '1px solid rgba(124,92,255,0.3)',
        borderRadius: 8,
        overflow: 'hidden',
        zIndex: 200,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        display: 'flex',
        flexDirection: 'column',
      }}
      onClick={e => { e.stopPropagation(); }}
    >
      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        {(['files', 'brain', 'git', 'terminal', 'web'] as Tab[]).map(tab => (
          <button
            key={tab}
            onClick={e => { e.stopPropagation(); handleTabChange(tab); }}
            style={{
              flex: 1,
              padding: '5px 0',
              fontSize: 10,
              fontWeight: 600,
              color: activeTab === tab ? 'var(--color-accent-light)' : 'rgba(255,255,255,0.3)',
              background: activeTab === tab ? 'rgba(124,92,255,0.08)' : 'transparent',
              border: 'none',
              borderBottom: activeTab === tab ? '2px solid #7C5CFF' : '2px solid transparent',
              cursor: 'pointer',
              fontFamily: 'inherit',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {tab === 'files' ? t('assistant.contextPicker.tabFiles')
              : tab === 'brain' ? t('assistant.contextPicker.tabBrain')
              : tab === 'git' ? t('assistant.contextPicker.tabGit')
              : tab === 'terminal' ? t('assistant.contextPicker.tabTerminal')
              : t('assistant.contextPicker.tabWeb')}
          </button>
        ))}
      </div>

      {/* Items */}
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '2px 0' }}>
        {activeTab === 'files' && allFileItems.length === 0 && (
          <div style={{ padding: '12px', fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>
            {tabs.length === 0 && projectFiles.length === 0 ? t('common.loading') : t('assistant.contextPicker.noMatchingFiles')}
          </div>
        )}
        {activeTab === 'brain' && brainLoading && (
          <div style={{ padding: '12px', fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>
            {t('assistant.searching')}
          </div>
        )}
        {activeTab === 'brain' && !brainLoading && brainResults.length === 0 && (
          <div style={{ padding: '12px', fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>
            {t('assistant.brainNotRunning', { port: String(getBrainDaemonPort()) })}
          </div>
        )}
        {activeTab === 'git' && (
          <>
            <ContextRow icon="📦" label={t('assistant.contextPicker.gitDiffLabel')} refv="@git:diff" onSelect={onSelect} item={{ kind: 'git', label: t('assistant.contextPicker.gitDiffShort'), ref: '@git:diff' }} />
            <ContextRow icon="📋" label={t('assistant.contextPicker.recentCommits')} refv="@git:log" onSelect={onSelect} item={{ kind: 'git', label: t('assistant.contextPicker.recentCommits'), ref: '@git:log' }} />
            <ContextRow icon="🌿" label={t('assistant.contextPicker.currentBranch')} refv="@git:branch" onSelect={onSelect} item={{ kind: 'git', label: t('assistant.contextPicker.currentBranch'), ref: '@git:branch' }} />
          </>
        )}
        {activeTab === 'terminal' && (
          <>
            <ContextRow icon="💻" label={t('assistant.contextPicker.terminalOutputLabel')} refv="@terminal:output" onSelect={onSelect} item={{ kind: 'terminal', label: t('assistant.contextPicker.terminalOutputShort'), ref: '@terminal:output' }} />
            <ContextRow icon="⚡" label={t('assistant.contextPicker.lastCommand')} refv="@terminal:last" onSelect={onSelect} item={{ kind: 'terminal', label: t('assistant.contextPicker.lastCommand'), ref: '@terminal:last' }} />
          </>
        )}
        {activeTab === 'web' && (
          <div style={{ padding: '12px', fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
            {t('assistant.contextPicker.webHint')}
          </div>
        )}
        {allItems.map((item, i) => (
          <div
            key={`${item.kind}:${item.ref}`}
            onClick={e => { e.stopPropagation(); onSelect(item); }}
            onMouseEnter={() => setSelectedIndex(i)}
            style={{
              padding: '5px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              cursor: 'pointer',
              background: i === selectedIndex ? 'rgba(124,92,255,0.12)' : 'transparent',
              fontSize: 11,
              color: i === selectedIndex ? '#D5D8E0' : 'rgba(255,255,255,0.5)',
            }}
          >
            <span style={{ fontSize: 10, opacity: 0.6 }}>
              {item.kind === 'file' ? '📄' : item.kind === 'brain' ? '🧠' : item.kind === 'git' ? '📦' : item.kind === 'terminal' ? '💻' : '🌐'}
            </span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.label}
            </span>
            {item.kind === 'file' && (
              <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)', flexShrink: 0 }}>
                {item.ref.replace('@file:', '')}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ContextRow({ icon, label, refv, onSelect, item }: {
  icon: string;
  label: string;
  refv: string;
  onSelect: (item: ContextItem) => void;
  item: ContextItem;
}) {
  return (
    <div
      onClick={e => { e.stopPropagation(); onSelect(item); }}
      style={{
        padding: '5px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        cursor: 'pointer',
        fontSize: 11,
        color: 'rgba(255,255,255,0.5)',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(124,92,255,0.12)'; (e.currentTarget as HTMLDivElement).style.color = '#D5D8E0'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; (e.currentTarget as HTMLDivElement).style.color = 'rgba(255,255,255,0.5)'; }}
    >
      <span style={{ fontSize: 10, opacity: 0.6 }}>{icon}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)', flexShrink: 0 }}>{refv}</span>
    </div>
  );
}
