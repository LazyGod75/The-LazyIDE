/* CommandPalette.tsx — functional Cmd-K overlay for Lazy IDE.
   Opens via Cmd/Ctrl+K or Omnibar pill click.
   Sources: files (scanned from the open project), commands (space nav),
   brain nodes from platform.brain.search(), agent launcher.
   Never falls back to canned demo nodes or MOCK_FILES.
*/

import React, { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SpaceId } from '../../app/AppContext';
import { useAppContext } from '../../app/AppContext';
import { useI18n } from '../../i18n';
import { useEditorStore } from '../editor/editorStore';
import { useAgentsUiContext } from '../agents/agentsUiContext';
import { getPlatform } from '../../lib/platform';
import type { DirEntry } from '../../lib/platform/types';
import { emit } from '../../lib/bus';
import { useSubscriptionContext } from '../../lib/billing';
import { useToast } from '../ui';
import {
  buildCommandItems,
  buildFileItems,
  buildSections,
  type PaletteItem,
  type SectionId,
  type Section,
  type FileEntry,
} from './paletteItems';
import { buildBillingCommandItems, runBillingCommand } from './paletteBilling';
import { fuzzyFilter } from './fuzzy';
import { PaletteRow } from './PaletteRow';
import { usePaletteState } from './usePaletteState';
import type { ProjectLike } from '../../lib/agents/projectForPath';

// ── File discovery ────────────────────────────────────────────────

const FILE_CAP = 500;

async function collectFiles(
  readDir: (path: string) => Promise<DirEntry[]>,
  root: string,
  collected: FileEntry[] = [],
  depth = 0,
): Promise<FileEntry[]> {
  if (collected.length >= FILE_CAP || depth > 6) return collected;

  let entries: DirEntry[];
  try {
    entries = await readDir(root);
  } catch {
    return collected;
  }

  for (const entry of entries) {
    if (collected.length >= FILE_CAP) break;
    // Skip hidden directories and common noise folders
    const name = entry.name;
    if (name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build' || name === 'target') {
      continue;
    }
    if (entry.isDir) {
      await collectFiles(readDir, entry.path, collected, depth + 1);
    } else {
      collected.push({ path: entry.path, filename: entry.name, content: '' });
    }
  }

  return collected;
}

// ── Props ─────────────────────────────────────────────────────────

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

// ── Brain node items from search results ──────────────────────────

interface RealBrainNode {
  id: string;
  title: string;
  snippet: string;
  cluster?: string;
  fuzzyScore?: number;
  fuzzyIndices?: number[];
}

function buildBrainItems(
  _q: string,
  realNodes: RealBrainNode[],
): PaletteItem[] {
  return realNodes.slice(0, 4).map((n) => ({
    id: `brain-node-${n.id}`,
    kind: 'brain' as const,
    label: n.title || n.id,
    hint: `${n.cluster ?? 'brain'} · brain`,
    icon: '◈',
    action: { type: 'brainNode' as const, nodeId: n.id, nodeName: n.title || n.id },
  }));
}

function buildAllItems(
  query: string,
  realBrainNodes: RealBrainNode[],
  fileEntries: FileEntry[],
  t: (key: string, params?: Record<string, string | number>) => string,
  commandSource: PaletteItem[],
  openProjects: readonly ProjectLike[],
): PaletteItem[] {
  const q = query.trim();

  // Files: scanned project entries only — never the canned MOCK_FILES list.
  const fileItems = fuzzyFilter(
    buildFileItems(fileEntries, openProjects),
    q,
    (item) => item.label,
  ).slice(0, 6);

  // Commands section (static nav/action commands + QA fix B7's real
  // billing commands, appended by the caller — see commandSource below).
  const commandItems = fuzzyFilter(commandSource, q, (item) => item.label).slice(0, 8);

  // Brain section: always show "ask brain" + top matching nodes.
  // QA fix (2026-08-15): `hint: 'Brain'` used to be a hardcoded, non-localized
  // literal that just duplicated the kind badge's own text (KIND_LABELS.brain,
  // t('palette.kind.brain')) rendered right below the label — same
  // trailing-word artifact as buildCommandItems' dropped hints. Removed
  // rather than translated: the badge already says it.
  const brainQuery: PaletteItem = {
    id: 'brain-query',
    kind: 'brain',
    label: q ? t('palette.askBrain', { query: q }) : t('palette.askBrainEmpty'),
    icon: '◈',
    action: { type: 'brainQuery', query: q },
  };

  const brainNodes = buildBrainItems(q, realBrainNodes);

  // Agent section (same hardcoded-hint fix as brainQuery above).
  const agentItem: PaletteItem = {
    id: 'agent-launch',
    kind: 'agent',
    label: q ? t('palette.launchAgent', { query: q }) : t('palette.launchAgentEmpty'),
    icon: '◈',
    action: { type: 'agentLaunch', query: q },
  };

  return [
    ...fileItems,
    ...commandItems,
    brainQuery,
    ...brainNodes,
    agentItem,
  ];
}

function groupBySection(
  items: PaletteItem[],
  sections: Section[],
): Array<{ section: SectionId; label: string; items: PaletteItem[] }> {
  const groups = sections.map((s) => ({
    section: s.id,
    label: s.label,
    items: [] as PaletteItem[],
  }));

  for (const item of items) {
    const sectionId: SectionId =
      item.kind === 'file'    ? 'files' :
      item.kind === 'command' ? 'commands' :
      item.kind === 'brain'   ? 'brain' :
      'agents';

    const group = groups.find((g) => g.section === sectionId);
    if (group) group.items.push(item);
  }

  return groups.filter((g) => g.items.length > 0);
}

// ── Component ─────────────────────────────────────────────────────

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const { t } = useI18n();
  const { setActiveSpace, openProject, projectRoot, openProjects } = useAppContext();
  const { openFile } = useEditorStore();
  const { requestNewMission } = useAgentsUiContext();
  const { isPro, isProPlus } = useSubscriptionContext();
  const { toast } = useToast();

  const { query, setQuery, highlightedIndex, setHighlightedIndex, reset } = usePaletteState();

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const platform = getPlatform();
  const isTauri = platform.name === 'tauri';

  // Real brain search results (only used under Tauri)
  const [realBrainNodes, setRealBrainNodes] = useState<RealBrainNode[]>([]);

  // Real file entries from projectRoot (Tauri only, loaded once per open)
  const [realFileEntries, setRealFileEntries] = useState<FileEntry[]>([]);

  // QA fix (B7): static nav/action commands + the billing entries relevant
  // to the user's real subscription state (mirrors AccountPopover's own
  // free/Pro branching).
  const commandSource = useMemo(
    () => [...buildCommandItems(t), ...buildBillingCommandItems(isPro, isProPlus, t)],
    [isPro, isProPlus, t],
  );

  const sections = useMemo(() => buildSections(t), [t]);

  // Build flat item list (memoised on query + real brain nodes + real file entries)
  const allItems = useMemo(
    () => buildAllItems(query, realBrainNodes, realFileEntries, t, commandSource, openProjects),
    [query, realBrainNodes, realFileEntries, t, commandSource, openProjects],
  );
  const groups = useMemo(() => groupBySection(allItems, sections), [allItems, sections]);

  // Focus input when palette opens; also refresh real file list under Tauri
  useEffect(() => {
    if (!isOpen) return;

    reset();
    setRealBrainNodes([]); // eslint-disable-line react-hooks/set-state-in-effect
    setTimeout(() => inputRef.current?.focus(), 30);

    if (isTauri && projectRoot) {
      collectFiles(platform.fs.readDir.bind(platform.fs), projectRoot)
        .then((entries) => {
          setRealFileEntries(entries);
        })
        .catch(() => {
          setRealFileEntries([]);
        });
    } else {
      setRealFileEntries([]);
    }
  }, [isOpen, reset, isTauri, projectRoot]); // eslint-disable-line react-hooks/exhaustive-deps

  // Async brain search (debounced by 200ms) — same path on web and Tauri.
  useEffect(() => {
    if (!isOpen) return;

    const q = query.trim();
    if (!q) {
      setRealBrainNodes([]); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }

    // B3.1: `cancelled` guards against the classic "slowest response wins"
    // race — the cleanup below only clears the pending timer, it can't stop
    // a request already in flight, so a slow response for an earlier query
    // could otherwise resolve after (and overwrite) a faster later one.
    // Same pattern as ContextPicker.tsx's brain-search effect.
    let cancelled = false;
    const timer = setTimeout(() => {
      platform.brain.search(q, 4).then((results) => {
        if (cancelled) return;
        setRealBrainNodes(
          results.map((r) => ({
            id: r.id,
            title: r.title,
            snippet: r.snippet,
            cluster: r.cluster,
          })),
        );
      }).catch(() => {
        if (!cancelled) setRealBrainNodes([]);
      });
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll highlighted row into view
  useEffect(() => {
    if (!isOpen) return;
    const el = document.getElementById(`palette-option-${allItems[highlightedIndex]?.id}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, allItems, isOpen]);

  // Run the action for a palette item
  const runItem = useCallback(
    async (item: PaletteItem) => {
      const { action } = item;

      switch (action.type) {
        case 'openFile': {
          const content = await platform.fs.readFile(action.path).catch(() => '');
          openFile(action.path, action.filename, content);
          setActiveSpace('code');
          // Also emit bus event so other listeners can react
          emit('editor:openFile', { path: action.path });
          break;
        }
        case 'switchSpace':
          // QA fix (B5): `tab` deep-links into a Settings sub-tab (e.g.
          // "Aller à : Réglages" lands on Compte instead of General).
          setActiveSpace(action.space as SpaceId, action.tab);
          if (action.space === 'agents' && item.id === 'cmd-new-mission') {
            requestNewMission();
          }
          break;
        case 'brainQuery':
        case 'brainNode':
          setActiveSpace('brain');
          break;
        case 'agentLaunch':
          setActiveSpace('agents');
          break;
        case 'openFolder':
          // Close palette first so the dialog appears on top
          onClose();
          await openProject();
          return; // already closed above
        case 'billing': {
          // QA fix (B7): real Stripe checkout/portal actions, same plumbing
          // AccountChip's popover uses — errors surface via the same toast
          // pattern instead of failing silently.
          onClose();
          const { error } = await runBillingCommand(action.billingAction, t);
          if (error) toast(error, 'error');
          return; // already closed above
        }
        case 'newFile':
          // Real fs/rename/spawn actions — CenterEditor.tsx is the sole
          // owner of tabs/platform wiring for the active file (same split
          // as editor:applyEdit), so this only dispatches the bus event and
          // switches to the Code space to make the result visible.
          setActiveSpace('code');
          emit('editor:newFile', undefined);
          break;
        case 'renameActiveFile':
          setActiveSpace('code');
          emit('editor:renameActiveFile', undefined);
          break;
        case 'formatDocument':
          setActiveSpace('code');
          emit('editor:formatDocument', undefined);
          break;
        case 'placeholder':
          break;
      }

      onClose();
    },
    [openFile, setActiveSpace, onClose, platform, openProject, requestNewMission, toast],
  );

  // Keyboard handler on the overlay
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedIndex((prev) => Math.min(prev + 1, allItems.length - 1));
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }

      if (e.key === 'Enter' && allItems[highlightedIndex]) {
        e.preventDefault();
        runItem(allItems[highlightedIndex]);
      }
    },
    [allItems, highlightedIndex, setHighlightedIndex, onClose, runItem],
  );

  if (!isOpen) return null;

  return createPortal(
    <div
      role="presentation"
      style={STYLES.backdrop}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.searchLabel')}
        onKeyDown={handleKeyDown}
        style={STYLES.modal}
      >
        {/* Search input */}
        <div style={STYLES.inputRow}>
          <span style={STYLES.searchIcon}>K</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlightedIndex(0);
            }}
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.searchLabel')}
            aria-autocomplete="list"
            aria-controls="palette-listbox"
            aria-activedescendant={
              allItems[highlightedIndex]
                ? `palette-option-${allItems[highlightedIndex].id}`
                : undefined
            }
            style={STYLES.input}
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <button
              aria-label={t('palette.clearSearch')}
              onMouseDown={(e) => {
                e.preventDefault();
                setQuery('');
                inputRef.current?.focus();
              }}
              style={STYLES.clearBtn}
            >
              x
            </button>
          )}
        </div>

        {/* Divider */}
        <div style={STYLES.divider} />

        {/* Results list */}
        <div
          ref={listRef}
          id="palette-listbox"
          role="listbox"
          aria-label={t('palette.resultsLabel')}
          style={STYLES.list}
        >
          {allItems.length === 0 ? (
            <div style={STYLES.empty}>{t('palette.noResults', { query })}</div>
          ) : (
            groups.map((group) => (
              <div key={group.section}>
                <div style={STYLES.sectionLabel}>{group.label}</div>
                {group.items.map((item) => {
                  const flatIdx = allItems.indexOf(item);
                  return (
                    <PaletteRow
                      key={item.id}
                      item={item}
                      isHighlighted={flatIdx === highlightedIndex}
                      onMouseEnter={() => setHighlightedIndex(flatIdx)}
                      onMouseDown={() => runItem(item)}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div style={STYLES.footer}>
          <span style={STYLES.footerHint}><kbd style={STYLES.kbd}>Up/Down</kbd> {t('palette.navigate')}</span>
          <span style={STYLES.footerHint}><kbd style={STYLES.kbd}>Enter</kbd> {t('palette.confirm')}</span>
          <span style={STYLES.footerHint}><kbd style={STYLES.kbd}>Esc</kbd> {t('palette.close')}</span>
          {isTauri ? (
            <span style={{ ...STYLES.footerHint, marginLeft: 'auto', color: '#66E27A', fontSize: 10 }}>
              {realFileEntries.length > 0 ? t('palette.files', { count: realFileEntries.length }) : ''}{t('palette.brainLive')}
            </span>
          ) : (
            <span style={{ ...STYLES.footerHint, marginLeft: 'auto', color: 'rgba(255,200,100,0.6)', fontSize: 10 }}>
              {t('palette.demo')}
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Styles ────────────────────────────────────────────────────────

const STYLES = {
  backdrop: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(5, 5, 10, 0.72)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingTop: '14vh',
    zIndex: 9999,
  },
  modal: {
    width: 620,
    maxWidth: 'calc(100vw - 32px)',
    background: '#16161D',
    border: '1px solid rgba(124, 92, 255, 0.25)',
    borderRadius: 12,
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(124, 92, 255, 0.1)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column' as const,
    maxHeight: '72vh',
  },
  inputRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '0 14px',
  },
  searchIcon: {
    fontSize: 11,
    fontWeight: 600,
    color: '#7C5CFF',
    whiteSpace: 'nowrap' as const,
    letterSpacing: '0.05em',
    flexShrink: 0,
    background: 'rgba(124, 92, 255, 0.12)',
    border: '1px solid rgba(124, 92, 255, 0.25)',
    borderRadius: 5,
    padding: '2px 6px',
  },
  input: {
    flex: 1,
    height: 48,
    background: 'transparent',
    border: 'none',
    outline: 'none',
    fontSize: 15,
    color: '#E6E8EF',
    fontFamily: 'inherit',
    caretColor: '#7C5CFF',
  },
  clearBtn: {
    background: 'none',
    border: 'none',
    color: 'rgba(255,255,255,0.35)',
    cursor: 'pointer',
    fontSize: 18,
    lineHeight: 1,
    padding: '0 4px',
    flexShrink: 0,
  },
  divider: {
    height: 1,
    background: 'rgba(255,255,255,0.07)',
    flexShrink: 0,
  },
  list: {
    overflowY: 'auto' as const,
    flex: 1,
    paddingTop: 4,
    paddingBottom: 4,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    color: 'rgba(255,255,255,0.28)',
    padding: '8px 14px 4px',
  },
  empty: {
    padding: '24px 14px',
    fontSize: 13,
    color: 'rgba(255,255,255,0.28)',
    textAlign: 'center' as const,
  },
  footer: {
    display: 'flex',
    gap: 16,
    alignItems: 'center',
    padding: '8px 14px',
    borderTop: '1px solid rgba(255,255,255,0.06)',
    flexShrink: 0,
  },
  footerHint: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 11,
    color: 'rgba(255,255,255,0.3)',
  },
  kbd: {
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 4,
    padding: '1px 5px',
    fontSize: 10,
    fontFamily: 'monospace',
    color: 'rgba(255,255,255,0.5)',
  },
} as const;
