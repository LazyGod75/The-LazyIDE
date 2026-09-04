import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { getPlatform } from '../../lib/platform';
import { basename, stripVerbatimPrefix } from '../../lib/paths';
import { recordRecentFile } from '../../lib/editor/recentFiles';

// ── Per-project tab persistence (T0.9) ───────────────────────────────
//
// Tabs are scoped per project WITHOUT keeping N in-memory copies (that
// "Map<projectId, State>" shape is explicitly NOT what this store does —
// see the T0.9 task's AppShell deviation note): a single EditorState is
// reused across every project, saved to localStorage on the way out of a
// project and restored (files re-read from disk — content is never
// persisted) on the way in. This keeps memory bounded to whichever
// project is currently active.

const TABS_STORAGE_PREFIX = 'lazy.editor.tabs.';
const TABS_PERSIST_DEBOUNCE_MS = 300;

/**
 * Derives the localStorage key for a project root's persisted tabs.
 * Strips the Windows verbatim (`\\?\`) prefix via paths.ts's shared helper
 * (never hand-rolled — this exact bug class has been reintroduced three
 * times already, see paths.ts's module doc) plus a trailing separator, so a
 * `\\?\`-prefixed root and its plain equivalent persist/restore under the
 * exact same key. Exported for direct testing (editorStoreProjects.test.ts)
 * and reused by production code below — one single derivation, never two.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function tabsStorageKey(root: string): string {
  const normalized = stripVerbatimPrefix(root).replace(/[\\/]+$/, '');
  return `${TABS_STORAGE_PREFIX}${normalized}`;
}

/** Shape persisted per project — just enough to restore the tab strip.
 *  File content is never persisted; it is re-read from disk on restore. */
interface PersistedTabs {
  paths: Array<{ path: string; pinned?: boolean }>;
  activeTabPath: string | null;
}

function readPersistedTabs(root: string): PersistedTabs | null {
  try {
    const raw = localStorage.getItem(tabsStorageKey(root));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as PersistedTabs).paths)) {
      return null;
    }
    return parsed as PersistedTabs;
  } catch {
    return null;
  }
}

function writePersistedTabs(root: string, tabs: PersistedTabs): void {
  try {
    localStorage.setItem(tabsStorageKey(root), JSON.stringify(tabs));
  } catch {
    // best-effort — a quota/private-mode write failure must never break editing
  }
}

export interface OpenTab {
  path: string;
  filename: string;
  content: string;
  savedContent: string;
  isDirty: boolean;
  pinned?: boolean;
}

export interface FileDiagnostic {
  path: string;
  filename: string;
  line: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

interface EditorState {
  tabs: OpenTab[];
  activeTabPath: string | null;
  diagnostics: FileDiagnostic[];
  splitTabPath: string | null;
}

interface EditorStoreValue extends EditorState {
  openFile: (path: string, filename: string, content: string) => void;
  closeTab: (path: string) => void;
  updateContent: (path: string, content: string) => void;
  markSaved: (path: string) => void;
  setActiveTab: (path: string) => void;
  setDiagnostics: (path: string, filename: string, items: Omit<FileDiagnostic, 'path' | 'filename'>[]) => void;
  togglePin: (path: string) => void;
  reorderTabs: (fromIdx: number, toIdx: number) => void;
  setSplitTab: (path: string | null) => void;
  clearDiagnostics: (path: string) => void;
}

const EditorStoreContext = createContext<EditorStoreValue | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useEditorStore(): EditorStoreValue {
  const ctx = useContext(EditorStoreContext);
  if (!ctx) throw new Error('useEditorStore must be used inside EditorStoreProvider');
  return ctx;
}

interface EditorStoreProviderProps {
  children: React.ReactNode;
}

export function EditorStoreProvider({ children }: EditorStoreProviderProps) {
  const [state, setState] = useState<EditorState>({
    tabs: [],
    activeTabPath: null,
    diagnostics: [],
    splitTabPath: null,
  });

  const platform = getPlatform();

  // The project root the CURRENTLY held state belongs to — a ref (not
  // state) because it must be read from inside the project://changed
  // listener's closure (set up once on mount) without forcing that effect
  // to re-subscribe on every switch.
  const currentRootRef = useRef<string>('');

  // Mirrors `state` for the SAME reason: the project-switch listener is a
  // long-lived closure (registered once) and must always force-save the
  // LATEST tabs, not whatever was current when the listener was created.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  function openFile(path: string, filename: string, content: string) {
    // Recorded unconditionally (even when the tab is already open) — CenterEditor's
    // empty state (recentFiles.ts) reads this as an MRU, independent of the tab
    // strip itself, which loses this history entirely the moment the last tab
    // closes. No-ops when no project root is known yet (currentRootRef.current
    // is only populated under Tauri — see the project-switch effect below).
    recordRecentFile(currentRootRef.current, path, filename);
    setState(prev => {
      const existing = prev.tabs.find(t => t.path === path);
      if (existing) {
        return {
          ...prev,
          tabs: prev.tabs.map(t =>
            t.path === path ? { ...t, content, savedContent: content, isDirty: false } : t
          ),
          activeTabPath: path,
        };
      }
      const newTab: OpenTab = {
        path,
        filename,
        content,
        savedContent: content,
        isDirty: false,
      };
      return {
        ...prev,
        tabs: [...prev.tabs, newTab],
        activeTabPath: path,
      };
    });
  }

  function closeTab(path: string) {
    setState(prev => {
      const idx = prev.tabs.findIndex(t => t.path === path);
      if (idx === -1) return prev;
      const newTabs = prev.tabs.filter(t => t.path !== path);
      let newActive: string | null = null;
      if (prev.activeTabPath === path) {
        if (newTabs.length > 0) {
          const neighborIdx = Math.min(idx, newTabs.length - 1);
          newActive = newTabs[neighborIdx].path;
        }
      } else {
        newActive = prev.activeTabPath;
      }
      return { ...prev, tabs: newTabs, activeTabPath: newActive };
    });
  }

  function updateContent(path: string, content: string) {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t =>
        t.path === path
          ? { ...t, content, isDirty: content !== t.savedContent }
          : t
      ),
    }));
  }

  function markSaved(path: string) {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t =>
        t.path === path
          ? { ...t, savedContent: t.content, isDirty: false }
          : t
      ),
    }));
  }

  function setActiveTab(path: string) {
    setState(prev => ({ ...prev, activeTabPath: path }));
  }

  function togglePin(path: string) {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t => t.path === path ? { ...t, pinned: !t.pinned } : t),
    }));
  }

  function reorderTabs(fromIdx: number, toIdx: number) {
    setState(prev => {
      const tabs = [...prev.tabs];
      const [moved] = tabs.splice(fromIdx, 1);
      tabs.splice(toIdx, 0, moved);
      return { ...prev, tabs };
    });
  }

  function setSplitTab(path: string | null) {
    setState(prev => ({ ...prev, splitTabPath: path }));
  }

  function clearDiagnostics(path: string) {
    setState(prev => ({
      ...prev,
      diagnostics: prev.diagnostics.filter(d => d.path !== path),
    }));
  }

  function setDiagnostics(
    path: string,
    filename: string,
    items: Omit<FileDiagnostic, 'path' | 'filename'>[],
  ) {
    setState(prev => {
      const others = prev.diagnostics.filter(d => d.path !== path);
      const next: FileDiagnostic[] = items.map(d => ({ ...d, path, filename }));
      return { ...prev, diagnostics: [...others, ...next] };
    });
  }

  // Restores the persisted tabs for `root` (no-op if nothing was
  // persisted). Reads every file's CURRENT content from disk in parallel —
  // a since-deleted/renamed file is skipped (with a warning) rather than
  // failing the whole restore — then replaces the tab list in ONE setState
  // so tab order is deterministic regardless of which read resolves first.
  // Stable forever (empty deps: reads getPlatform() fresh on every call
  // rather than closing over the render-scoped `platform` above) so the
  // project-switch listener effect below never needs to re-subscribe
  // because of this function's identity changing.
  const restoreProjectTabs = useCallback(async (root: string): Promise<void> => {
    const persisted = readPersistedTabs(root);
    if (!persisted || persisted.paths.length === 0) return;

    const { fs } = getPlatform();
    const results = await Promise.allSettled(persisted.paths.map(({ path }) => fs.readFile(path)));

    const restoredTabs: OpenTab[] = [];
    persisted.paths.forEach(({ path, pinned }, i) => {
      const result = results[i];
      if (result.status !== 'fulfilled') {
        console.warn('[editorStore] skipping persisted tab, file unreadable:', path, result.reason);
        return;
      }
      restoredTabs.push({
        path,
        filename: basename(path),
        content: result.value,
        savedContent: result.value,
        isDirty: false,
        pinned,
      });
    });

    if (restoredTabs.length === 0) return;

    const activeTabPath =
      persisted.activeTabPath && restoredTabs.some((t) => t.path === persisted.activeTabPath)
        ? persisted.activeTabPath
        : restoredTabs[0].path;

    setState((prev) => ({ ...prev, tabs: restoredTabs, activeTabPath }));
  }, []);

  // Debounced per-project persistence: writes the CURRENT project's tabs
  // (paths + pinned + active — never content) ~300ms after the last
  // structural change, so rapid tab churn (opening several files in a row)
  // does not hammer localStorage. Keyed off a derived signature (not the
  // raw `state.tabs` array) so pure content edits (typing) do not reset the
  // debounce window — only open/close/reorder/pin/active-tab changes do.
  const tabsSignature = state.tabs.map((t) => `${t.path} ${t.pinned ? '1' : '0'}`).join('');
  useEffect(() => {
    if (platform.name !== 'tauri') return;
    const root = currentRootRef.current;
    if (!root) return;

    const snapshot: PersistedTabs = {
      paths: state.tabs.map((t) => ({ path: t.path, pinned: t.pinned })),
      activeTabPath: state.activeTabPath,
    };
    const timer = setTimeout(() => writePersistedTabs(root, snapshot), TABS_PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsSignature, state.activeTabPath, platform.name]);

  // On mount: resolve whichever project is ALREADY active (the project of
  // the session at the time this provider mounted — before any
  // project://changed event has had a chance to fire) and restore its
  // tabs, then listen for subsequent switches: force-save the outgoing
  // project's tabs (synchronously, NOT waiting for the debounce above —
  // otherwise the clear-on-switch below would cancel the pending debounced
  // write via the effect's own cleanup before it ever fires), clear, and
  // restore the incoming project's persisted tabs.
  useEffect(() => {
    if (platform.name !== 'tauri') return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    async function init() {
      const { getProjectRoot } = await import('../../lib/platform/tauri');
      let initialRoot = '';
      try {
        initialRoot = await getProjectRoot();
      } catch {
        // Command unavailable / IPC hiccup — treat exactly like "no active
        // project yet" (initialRoot already defaults to '').
      }
      if (cancelled) return;
      if (initialRoot) {
        currentRootRef.current = initialRoot;
        await restoreProjectTabs(initialRoot);
      }
      if (cancelled) return;

      const { listen } = await import('@tauri-apps/api/event');
      listen<string>('project://changed', (event) => {
        const previousRoot = currentRootRef.current;
        const nextRoot = event.payload;
        if (previousRoot === nextRoot) return;

        if (previousRoot) {
          writePersistedTabs(previousRoot, {
            paths: stateRef.current.tabs.map((t) => ({ path: t.path, pinned: t.pinned })),
            activeTabPath: stateRef.current.activeTabPath,
          });
        }

        currentRootRef.current = nextRoot;
        setState({ tabs: [], activeTabPath: null, diagnostics: [], splitTabPath: null });
        restoreProjectTabs(nextRoot).catch(() => {});
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      }).catch(() => {});
    }

    init();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [platform.name, restoreProjectTabs]);

  const value: EditorStoreValue = {
    tabs: state.tabs,
    activeTabPath: state.activeTabPath,
    diagnostics: state.diagnostics,
    splitTabPath: state.splitTabPath,
    openFile,
    closeTab,
    updateContent,
    markSaved,
    setActiveTab,
    setDiagnostics,
    togglePin,
    reorderTabs,
    setSplitTab,
    clearDiagnostics,
  };

  return (
    <EditorStoreContext.Provider value={value}>
      {children}
    </EditorStoreContext.Provider>
  );
}
