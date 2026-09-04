/* CenterEditor — editor column for the redesigned Code space: multi-project
   tabs (project color dot, live dot), contextual banner (D9), code area
   (real EditorPane, or the real live-worktree tail view while a mission is
   actively writing the active file), minimap, split view, and the existing
   apply-edit / multi-edit modal + bus wiring — extracted verbatim in
   behavior from the pre-redesign CodeSpace.tsx's inline CenterEditor.
*/

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useAppContext } from '../../../app/AppContext';
import { useI18n } from '../../../i18n';
import { useEditorStore } from '../editorStore';
import { EditorTabs } from '../EditorTabs';
import { ApplyEditModal } from '../ApplyEditModal';
import { MultiFileEditModal } from '../MultiFileEditModal';
import { Minimap } from '../Minimap';
import { captureEdit } from '../../../lib/brain/capture';
import { useToast } from '../../ui';
import { on, emit } from '../../../lib/bus';
import type { EditApplyRequest, MultiEditApplyRequest } from '../../../lib/bus';
import type { CodeBanner } from '../../../lib/agents/codeBanner';
import type { FileActivityKind } from '../../../lib/agents/codeFileActivity';
import { basename, joinPath } from '../../../lib/paths';
import { isPrettierConfigured, runPrettierWrite } from '../../../lib/editor/formatDocument';
import { ContextualBanner } from './ContextualBanner';
import { LiveWorktreeView } from './LiveWorktreeView';
import { EditorEmptyState } from './EditorEmptyState';
import { getRecentFiles, removeRecentFile, type RecentFileEntry } from '../../../lib/editor/recentFiles';

const EditorPane = lazy(() =>
  import('../EditorPane').then((m) => ({ default: m.EditorPane }))
);

interface ApplyEditState {
  currentContent: string;
  proposedContent: string;
  path: string;
  filename: string;
}

interface MultiEditState {
  files: Array<{
    path: string;
    proposedContent: string;
    currentContent: string;
    language?: string;
  }>;
}

function isFileTooLargeError(err: unknown): boolean {
  return String(err).toLowerCase().includes('read ceiling');
}

interface CenterEditorProps {
  banner: CodeBanner;
  onDismissBanner: () => void;
  isLiveWorktreeFile: boolean;
  projectColorForPath: (path: string) => string | null;
  isLiveForPath: (path: string) => boolean;
  liveActivityForPath?: (path: string) => { kind: FileActivityKind; label: string } | null;
}

export function CenterEditor({ banner, onDismissBanner, isLiveWorktreeFile, projectColorForPath, isLiveForPath, liveActivityForPath }: CenterEditorProps) {
  const { t } = useI18n();
  const { tabs, activeTabPath, closeTab, updateContent, markSaved, setActiveTab, openFile, togglePin, reorderTabs, setSplitTab, splitTabPath } = useEditorStore();
  const { platform, projectRoot } = useAppContext();
  const { toast } = useToast();
  const [applyEdit, setApplyEdit] = useState<ApplyEditState | null>(null);
  const [multiEdit, setMultiEdit] = useState<MultiEditState | null>(null);
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const codeScrollRef = useRef<HTMLDivElement>(null);

  const activeTab = tabs.find(t => t.path === activeTabPath) ?? null;

  const handleSave = useCallback(async () => {
    if (!activeTab) return;
    try {
      await platform.fs.writeFile(activeTab.path, activeTab.content);
      markSaved(activeTab.path);
      const firstLine = activeTab.content.split('\n')[0] ?? '';
      captureEdit(activeTab.path, activeTab.filename, firstLine);
      toast(t('code.fileSaved', { name: activeTab.filename }), 'success', 2000);
    } catch {
      toast(t('code.saveFailed', { name: activeTab.filename }), 'error');
    }
  }, [activeTab, platform, markSaved, toast, t]);

  const handleTabClose = useCallback((path: string) => {
    const tab = tabs.find(t => t.path === path);
    if (tab?.isDirty) {
      const confirmed = window.confirm(t('code.confirmCloseUnsaved', { name: tab.filename }));
      if (!confirmed) return;
    }
    closeTab(path);
  }, [tabs, closeTab, t]);

  const handleCloseActiveTab = useCallback(() => {
    if (!activeTab) return;
    handleTabClose(activeTab.path);
  }, [activeTab, handleTabClose]);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault();
        handleCloseActiveTab();
      }
    }
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [handleSave, handleCloseActiveTab]);

  useEffect(() => {
    return on('editor:applyEdit', (req: EditApplyRequest) => {
      const targetPath = req.path ?? activeTabPath;
      if (!targetPath) return;
      const tab = tabs.find(t => t.path === targetPath);
      if (!tab) {
        platform.fs.readFile(targetPath).then(content => {
          const fname = basename(targetPath);
          openFile(targetPath, fname, content);
          setApplyEdit({ currentContent: content, proposedContent: req.proposedContent, path: targetPath, filename: fname });
        }).catch(() => {/* file unreadable, ignore */});
        return;
      }
      setApplyEdit({ currentContent: tab.content, proposedContent: req.proposedContent, path: tab.path, filename: tab.filename });
    });
  }, [activeTabPath, tabs, platform, openFile]);

  useEffect(() => {
    return on('editor:applyMultiEdit', (req: MultiEditApplyRequest) => {
      Promise.all(
        req.files.map(async (f) => {
          try {
            const tab = tabs.find(t => t.path === f.path);
            if (tab) return { ...f, currentContent: tab.content };
            const content = await platform.fs.readFile(f.path);
            return { ...f, currentContent: content };
          } catch {
            return { ...f, currentContent: '' };
          }
        })
      ).then(files => { setMultiEdit({ files }); });
    });
  }, [tabs, platform]);

  useEffect(() => {
    return on('editor:openFile', req => {
      platform.fs.readFile(req.path).then(content => {
        const fname = basename(req.path);
        openFile(req.path, fname, content);
        if (req.line) setFocusLine(req.line);
        emit('nav:navigateSpace', 'code');
      }).catch((err: unknown) => {
        if (isFileTooLargeError(err)) toast(t('code.fileTooLargeToOpen'), 'error');
      });
    });
  }, [platform, openFile, toast, t]);

  // ── B23: palette "Nouveau fichier" / "Renommer" / "Formater le
  // document" — dispatched via bus events (paletteItems.ts /
  // CommandPalette.tsx), handled here since this component already owns
  // tabs/platform wiring for the active file (same split as the
  // editor:applyEdit/applyMultiEdit effects above). Each is a real
  // fs/rename/spawn action against the real Platform — none ever fakes
  // success; every failure path surfaces an honest toast instead.

  const handleNewFile = useCallback(async () => {
    if (!projectRoot) {
      toast(t('code.noProjectOpen'), 'warning');
      return;
    }
    const name = window.prompt(t('fileExplorer.fileNamePrompt'));
    if (!name?.trim()) return;
    const path = joinPath(projectRoot, name.trim());
    try {
      await platform.fs.createFile(path);
    } catch (err) {
      toast(t('code.palette.newFileFailed', { error: err instanceof Error ? err.message : String(err) }), 'error');
      return;
    }
    const content = await platform.fs.readFile(path).catch(() => '');
    const filename = name.trim().split(/[\\/]/).pop() ?? name.trim();
    openFile(path, filename, content);
    emit('fs:changed', undefined);
  }, [projectRoot, platform, openFile, toast, t]);

  const handleRenameActiveFile = useCallback(async () => {
    if (!activeTab) {
      toast(t('code.palette.renameNoActiveFile'), 'warning');
      return;
    }
    const nextName = window.prompt(t('fileExplorer.fileNamePrompt'), activeTab.filename);
    if (!nextName?.trim() || nextName.trim() === activeTab.filename) return;
    const sep = activeTab.path.includes('\\') ? '\\' : '/';
    const parentPath = activeTab.path.includes(sep)
      ? activeTab.path.slice(0, activeTab.path.lastIndexOf(sep))
      : '';
    const newPath = parentPath ? `${parentPath}${sep}${nextName.trim()}` : nextName.trim();
    try {
      await platform.fs.rename(activeTab.path, newPath);
      // Persist the CURRENT buffer under the new name too — a dirty tab's
      // unsaved edits must not silently revert to the last-saved-under-
      // the-old-name bytes just because the file moved.
      await platform.fs.writeFile(newPath, activeTab.content);
    } catch (err) {
      toast(t('code.palette.renameFailed', { error: err instanceof Error ? err.message : String(err) }), 'error');
      return;
    }
    closeTab(activeTab.path);
    openFile(newPath, nextName.trim(), activeTab.content);
    markSaved(newPath);
    emit('fs:changed', undefined);
  }, [activeTab, platform, closeTab, openFile, markSaved, toast, t]);

  const handleFormatDocument = useCallback(async () => {
    if (!activeTab) {
      toast(t('code.palette.formatNoActiveFile'), 'warning');
      return;
    }
    if (platform.name !== 'tauri' || !projectRoot) {
      toast(t('code.palette.formatNotAvailableDemo'), 'warning');
      return;
    }
    const configured = await isPrettierConfigured(platform, projectRoot);
    if (!configured) {
      toast(t('code.palette.formatUnavailable'), 'warning');
      return;
    }
    try {
      await platform.fs.writeFile(activeTab.path, activeTab.content);
      markSaved(activeTab.path);
    } catch {
      toast(t('code.saveFailed', { name: activeTab.filename }), 'error');
      return;
    }
    const result = await runPrettierWrite(platform, projectRoot, activeTab.path);
    if (!result.ok) {
      toast(t('code.palette.formatFailed', { message: result.message }), 'error');
      return;
    }
    try {
      const formatted = await platform.fs.readFile(activeTab.path);
      updateContent(activeTab.path, formatted);
      markSaved(activeTab.path);
      toast(t('code.palette.formatSuccess', { name: activeTab.filename }), 'success', 2000);
    } catch {
      toast(t('code.palette.formatFailed', { message: '' }), 'error');
    }
  }, [activeTab, platform, projectRoot, markSaved, updateContent, toast, t]);

  // Empty-state "recent files" (EditorEmptyState.tsx) — opens a real file
  // through the same fs read + openFile path every other file-open uses. A
  // recent entry whose file has since been deleted/moved fails honestly
  // (toast) and is pruned from the MRU rather than left to keep reappearing
  // as a dead link.
  const handleOpenRecentFile = useCallback(async (file: RecentFileEntry) => {
    try {
      const content = await platform.fs.readFile(file.path);
      openFile(file.path, file.filename, content);
    } catch {
      removeRecentFile(projectRoot, file.path);
      toast(t('code.recentFileOpenFailed', { name: file.filename }), 'error');
    }
  }, [platform, openFile, projectRoot, toast, t]);

  useEffect(() => on('editor:newFile', () => { void handleNewFile(); }), [handleNewFile]);
  useEffect(() => on('editor:renameActiveFile', () => { void handleRenameActiveFile(); }), [handleRenameActiveFile]);
  useEffect(() => on('editor:formatDocument', () => { void handleFormatDocument(); }), [handleFormatDocument]);

  function handleAcceptEdit(proposed: string) {
    if (!applyEdit) return;
    updateContent(applyEdit.path, proposed);
    setApplyEdit(null);
  }

  function handleRejectEdit() { setApplyEdit(null); }

  async function handleAcceptMultiEdit(acceptedPaths: string[]) {
    if (!multiEdit) return;
    const accepted = multiEdit.files.filter(f => acceptedPaths.includes(f.path));
    setMultiEdit(null);
    for (const file of accepted) {
      updateContent(file.path, file.proposedContent);
      try {
        await platform.fs.writeFile(file.path, file.proposedContent);
        markSaved(file.path);
      } catch {
        const fname = basename(file.path);
        toast(t('code.multiEditSaveFailed', { name: fname }), 'error');
      }
    }
  }

  function handleRejectMultiEdit() { setMultiEdit(null); }
  function handleFocusLineDone() { setFocusLine(null); }
  function handleFollowCursor() {
    codeScrollRef.current?.scrollTo({ top: codeScrollRef.current.scrollHeight, behavior: 'smooth' });
  }

  return (
    <>
      <div ref={containerRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, background: 'var(--color-bg)' }} tabIndex={-1}>
        <EditorTabs
          tabs={tabs}
          activeTabPath={activeTabPath}
          onTabClick={setActiveTab}
          onTabClose={handleTabClose}
          onReorder={reorderTabs}
          onTogglePin={togglePin}
          onSplit={(path) => setSplitTab(splitTabPath === path ? null : path)}
          projectColorForPath={projectColorForPath}
          isLiveForPath={isLiveForPath}
          liveActivityForPath={liveActivityForPath}
        />

        <ContextualBanner banner={banner} onFollowCursor={handleFollowCursor} onDismiss={onDismissBanner} />

        {activeTab ? (
          isLiveWorktreeFile ? (
            <div ref={codeScrollRef} style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
              <LiveWorktreeView platform={platform} path={activeTab.path} />
            </div>
          ) : (
            <Suspense
              fallback={
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg)', color: 'rgba(255,255,255,0.25)', fontSize: 12 }}>
                  {t('code.loadingEditor')}
                </div>
              }
            >
              <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  {/* B21: `key={activeTab.path}` forces a full unmount/remount of
                      EditorPane (and its underlying CodeMirror view) on every tab
                      switch, instead of React reusing the same component instance
                      with new value/filename/path props. Without a key, one single
                      CodeMirror view — and everything @uiw/react-codemirror keeps
                      PER-INSTANCE inside it (the debounced "value changed
                      externally" flush in useCodeMirror.js, aiCompletion.ts's ghost-
                      text decoration field, the LSP view binding) — is reused
                      across every open file. A value-prop swap that lands while
                      that internal debounce/latch is mid-flight (e.g. right after
                      an agent's own edit lands via updateContent, or while the user
                      was still typing right before switching tabs) can apply late,
                      against whichever document happens to be active BY THEN —
                      the observed symptom (a stale/duplicated line surviving a tab
                      switch). Keying per path makes that carryover structurally
                      impossible: switching tabs always starts every bit of that
                      per-file state completely fresh. See this file's header/PR
                      notes for the investigation (QA3/B21) — a live, agent-driven
                      repro needs a real Tauri app + running mission, unavailable in
                      this environment; this fix removes the exact mechanism the
                      QA hypothesis named ("stale decoration... after a tab
                      switch") regardless of whether that specific repro path is
                      the one that was hit. */}
                  <EditorPane key={activeTab.path} value={activeTab.content} filename={activeTab.filename} path={activeTab.path} onChange={value => updateContent(activeTab.path, value)} focusLine={focusLine} />
                </div>
                <Minimap content={activeTab.content} onScroll={(line) => setFocusLine(line)} />
                {splitTabPath && splitTabPath !== activeTab.path && (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: '1px solid rgba(255,255,255,0.07)' }}>
                    <EditorPane
                      key={splitTabPath}
                      value={tabs.find(t => t.path === splitTabPath)?.content ?? ''}
                      filename={tabs.find(t => t.path === splitTabPath)?.filename ?? ''}
                      path={splitTabPath}
                      onChange={value => updateContent(splitTabPath, value)}
                    />
                  </div>
                )}
              </div>
            </Suspense>
          )
        ) : (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }} onTransitionEnd={handleFocusLineDone}>
            <EditorEmptyState
              recentFiles={getRecentFiles(projectRoot)}
              projectRoot={projectRoot}
              onOpenRecentFile={(file) => void handleOpenRecentFile(file)}
              onNewFile={() => void handleNewFile()}
            />
          </div>
        )}
      </div>

      {applyEdit && (
        <ApplyEditModal currentContent={applyEdit.currentContent} proposedContent={applyEdit.proposedContent} filename={applyEdit.filename} onAccept={handleAcceptEdit} onReject={handleRejectEdit} />
      )}

      {multiEdit && (
        <MultiFileEditModal files={multiEdit.files} onAccept={handleAcceptMultiEdit} onReject={handleRejectMultiEdit} />
      )}
    </>
  );
}
