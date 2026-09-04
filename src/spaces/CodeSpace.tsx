/* CodeSpace — the redesigned "Code multi-projet" screen (design-code.md).
   Multi-project sidebar (PROJETS/WORKTREES/BRAIN/manager note), restyled
   multi-project tabs + contextual agent banner + live-worktree view,
   cyan-branded Assistant Code rail, and a real diff drawer — all driven by
   real cross-project fleet mission data (useFleetMissions) and real
   filesystem/git/brain reads. Header/nav is owned by TopNav (wave 1) —
   this component owns only the body below it.
*/

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppContext } from '../app/AppContext';
import type { ProjectEntry } from '../app/AppContext';
import { useI18n } from '../i18n';
import { useEditorStore } from '../components/editor/editorStore';
import { useResizable, ResizeHandle } from '../components/editor/ResizeHandle';
import { useToast } from '../components/ui';
import { useFleetMissions } from '../lib/agents/fleetMissions';
import type { FleetMission } from '../lib/agents/fleetMissions';
import { colorForProject } from '../lib/projectColors';
import { findOwningProject } from '../lib/agents/projectForPath';
import { findFileActivity, basenameOf, fileActivityWhoLine } from '../lib/agents/codeFileActivity';
import { deriveCodeBanner } from '../lib/agents/codeBanner';
import { relativeToRoot } from '../components/editor/codespace/fileTree';
import { resolveDiscardWorktreePath } from '../components/agents/agentsStore';
import { joinPath, isPathWithinRoot } from '../lib/paths';
import { emit, on, type CursorPosition } from '../lib/bus';

import { CodeSidebar, type LegacyPanel } from '../components/editor/codespace/CodeSidebar';
import { CenterEditor } from '../components/editor/codespace/CenterEditor';
import { TerminalStrip } from '../components/editor/codespace/TerminalStrip';
import { CodeStatusBar } from '../components/editor/codespace/CodeStatusBar';
import { DiffDrawer, type DiffDrawerTarget } from '../components/editor/codespace/DiffDrawer';
import { ImagePreview } from '../components/platform/ImagePreview';

import { GlobalSearchPanel } from '../components/editor/GlobalSearchPanel';
import { OutlineView } from '../components/editor/OutlineView';
import { GitGraph } from '../components/git/GitGraph';
import { SourceControlPanel } from '../components/git/SourceControlPanel';
import { ExtensionPanel } from '../components/platform/ExtensionPanel';
import { DebuggerPanel } from '../components/platform/DebuggerPanel';
import { DockerPanel } from '../components/platform/DockerPanel';
import { DbExplorer } from '../components/platform/DbExplorer';
import { Timeline } from '../components/platform/Timeline';
import { SettingsPanel } from '../components/platform/SettingsPanel';
import { ProfilesManager } from '../components/platform/ProfilesManager';
import { ImportVsCode } from '../components/platform/ImportVsCode';
import { WebPreview } from '../components/platform/WebPreview';
import { CompareBranches } from '../components/git/CompareBranches';
import { InteractiveRebase } from '../components/git/InteractiveRebase';
import { SnippetsManager } from '../components/editor/SnippetsManager';
import { ZenMode } from '../components/editor/ZenMode';

import { useManagerHostSource } from '../components/lazyManager/managerHostRegistry';
import type { AssistantIdentity, AssistantQuickAction } from '../components/assistant/assistantIdentity';

const OVERLAY_ITEMS = [
  { id: 'settings', labelKey: 'codespace.overflow.editorSettings' },
  { id: 'profiles', labelKey: 'codespace.overflow.profiles' },
  { id: 'importVsCode', labelKey: 'codespace.overflow.importVsCode' },
  { id: 'compareBranches', labelKey: 'codespace.overflow.compareBranches' },
  { id: 'interactiveRebase', labelKey: 'codespace.overflow.interactiveRebase' },
  { id: 'snippets', labelKey: 'codespace.overflow.snippets' },
  { id: 'webPreview', labelKey: 'codespace.overflow.webPreview' },
  { id: 'zenMode', labelKey: 'codespace.overflow.zenMode' },
];

type OverlayModal = null | 'settings' | 'profiles' | 'importVsCode' | 'compareBranches' | 'interactiveRebase' | 'snippets' | 'webPreview' | 'zenMode';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

/** True when `filename`'s extension is an image format ImagePreview.tsx can
 *  render — used at file-open time to route it to the image overlay instead
 *  of a text editor tab. Exported for unit testing. */
export function isImagePath(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'TS', tsx: 'TSX', js: 'JS', jsx: 'JSX', json: 'JSON', md: 'Markdown', css: 'CSS',
    html: 'HTML', py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', c: 'C', cpp: 'C++',
    sh: 'Shell', yml: 'YAML', yaml: 'YAML', toml: 'TOML', sql: 'SQL',
  };
  return map[ext] ?? 'Plain Text';
}

/** Absolute worktree root for a running mission on `project`, or null when
 *  the mission has no worktree (shouldn't happen for a real running
 *  mission, but never assumed). */
function worktreeRootFor(project: ProjectEntry, mission: FleetMission): string | null {
  if (!mission.worktree) return null;
  return resolveDiscardWorktreePath(project.root, mission.worktree);
}

function CodeSpaceBody() {
  const { t } = useI18n();
  const { platform, projectRoot, openProjects, openProject, activeProjectId } = useAppContext();
  const { tabs, activeTabPath, openFile } = useEditorStore();
  const { toast } = useToast();
  const { projects: fleetProjects } = useFleetMissions(true);

  const sidebarAssistant = useResizable({ initial: 400, min: 300, max: 560, direction: 'horizontal', invert: true });
  const terminal = useResizable({ initial: 260, min: 38, max: 600, direction: 'vertical' });

  const [legacyPanel, setLegacyPanel] = useState<LegacyPanel | null>(null);
  const [overlay, setOverlay] = useState<OverlayModal>(null);
  const [diffTarget, setDiffTarget] = useState<DiffDrawerTarget | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState<Record<string, boolean>>({});
  const [imagePreviewPath, setImagePreviewPath] = useState<string | null>(null);
  // Cursor position for the status bar's "Ln X, Col Y" indicator —
  // EditorPane.tsx emits 'editor:cursor' on every selection change
  // (cursorPositionFromState, 1-based). CodeStatusBar previously had no
  // consumer for this event at all (its own DEFECT #4 comment referenced a
  // StatusBar.tsx that no longer exists), so the position never showed up.
  const [cursorPosition, setCursorPosition] = useState<CursorPosition | null>(null);

  // Memoized (rather than a plain `.find() ?? null`) so `activeTab` — and
  // `activeFilename` derived from it below — are values the React Compiler
  // can prove are frozen between renders. Without this, the compiler can't
  // guarantee `activeFilename` stays stable as a dependency of the
  // `rawBanner` useMemo and skips optimizing the whole component
  // (react-hooks/preserve-manual-memoization).
  const activeTab = useMemo(() => tabs.find((tb) => tb.path === activeTabPath) ?? null, [tabs, activeTabPath]);
  const activeFileProject = activeTabPath ? findOwningProject(activeTabPath, openProjects) : null;
  const activeFileFleet = activeFileProject ? fleetProjects.find((p) => p.root === activeFileProject.root) : undefined;
  const activeFileMissions = activeFileFleet?.missions ?? [];

  const activeRelPath = activeTabPath && activeFileProject ? relativeToRoot(activeFileProject.root, activeTabPath) : null;
  const activeFilename = activeTab?.filename ?? null;

  // Subscribe once for the component's lifetime — CenterEditor.tsx remounts
  // EditorPane on every tab switch (key={activeTab.path}), so the emitter
  // changes identity but the bus event name does not.
  useEffect(() => on('editor:cursor', setCursorPosition), []);

  // A freshly (re)mounted EditorPane only emits 'editor:cursor' on the
  // FIRST doc change or selection move (see its updateListener) — never on
  // mount itself. Without this reset, switching tabs would keep showing the
  // previous file's stale line/col until the user moves the cursor in the
  // new one.
  useEffect(() => {
    setCursorPosition(null);
  }, [activeTabPath]);

  // Is the active tab literally a running mission's worktree copy (rather
  // than the project's own working copy)? Drives the read-only live view.
  const liveWorktreeMission = useMemo(() => {
    if (!activeTabPath || !activeFileProject) return null;
    for (const mission of activeFileMissions) {
      if (mission.status !== 'running') continue;
      const root = worktreeRootFor(activeFileProject, mission);
      // isPathWithinRoot (verbatim-prefix + drive-letter-case tolerant —
      // see paths.ts) rather than a bare startsWith: `root` and
      // `activeTabPath` can come from independently-resolved sources (see
      // missionScopeGuard.ts's 2026-08-02 false-positive incident for the
      // same mismatch class).
      if (root && isPathWithinRoot(root, activeTabPath)) {
        return mission;
      }
    }
    return null;
  }, [activeTabPath, activeFileProject, activeFileMissions]);

  const rawBanner = useMemo(() => {
    if (!activeRelPath || !activeFilename) return { kind: 'none' as const };
    return deriveCodeBanner(activeRelPath, activeFilename, activeFileMissions);
  }, [activeRelPath, activeFilename, activeFileMissions]);
  const banner = activeTabPath && bannerDismissed[activeTabPath] ? { kind: 'none' as const } : rawBanner;

  const projectColorForPath = useCallback((path: string) => {
    const owner = findOwningProject(path, openProjects);
    return owner ? colorForProject(owner.id) : null;
  }, [openProjects]);

  const fileActivityForPath = useCallback((path: string) => {
    const owner = findOwningProject(path, openProjects);
    if (!owner) return null;
    const fleet = fleetProjects.find((p) => p.root === owner.root);
    if (!fleet) return null;
    const relPath = relativeToRoot(owner.root, path);
    const filename = basenameOf(path);
    return findFileActivity(relPath, filename, fleet.missions);
  }, [openProjects, fleetProjects]);

  const isLiveForPath = useCallback((path: string) => {
    return fileActivityForPath(path)?.kind === 'run';
  }, [fileActivityForPath]);

  const liveActivityForPath = useCallback((path: string) => {
    const activity = fileActivityForPath(path);
    if (!activity) return null;
    return { kind: activity.kind, label: fileActivityWhoLine(activity, t) };
  }, [fileActivityForPath, t]);

  // ── Sidebar file open: a file with a real "agent writing" activity opens
  // its LIVE worktree copy (the file the agent is actually writing to);
  // everything else opens the project's own working copy, as always. ──
  const handleSidebarFileOpen = useCallback(async (path: string, filename: string) => {
    // Images render in the ImagePreview overlay instead of a text editor tab
    // — never routed through the UTF-8 text-read paths below, which would
    // corrupt binary content (ImagePreview does its own binary-safe read).
    if (isImagePath(filename)) {
      setImagePreviewPath(path);
      return;
    }
    const project = findOwningProject(path, openProjects);
    const fleet = project ? fleetProjects.find((p) => p.root === project.root) : undefined;
    if (project && fleet) {
      const relPath = relativeToRoot(project.root, path);
      const activity = findFileActivity(relPath, filename, fleet.missions);
      if (activity?.kind === 'run' && activity.mission.worktree) {
        const worktreeRoot = resolveDiscardWorktreePath(project.root, activity.mission.worktree);
        const worktreePath = joinPath(worktreeRoot, relPath);
        try {
          const content = await platform.fs.readFile(worktreePath);
          openFile(worktreePath, filename, content);
          return;
        } catch {
          // Worktree copy not readable (race with agent creating it, or it
          // simply hasn't diverged from main yet) — fall through to the
          // honest default: open the project's own working copy.
        }
      }
    }
    try {
      const content = await platform.fs.readFile(path);
      openFile(path, filename, content);
    } catch (err: unknown) {
      toast(String(err instanceof Error ? err.message : err), 'error');
    }
  }, [openProjects, fleetProjects, platform, openFile, toast]);

  const handleOpenDiff = useCallback((worktreeBranch: string, _subtitle: string, mission: FleetMission | null) => {
    if (!activeFileProject) return;
    const worktreePath = mission?.worktree
      ? resolveDiscardWorktreePath(activeFileProject.root, mission.worktree)
      : activeFileProject.root;
    setDiffTarget({ worktreePath, branch: worktreeBranch, missionId: mission?.id ?? null });
  }, [activeFileProject]);

  const handleOpenNeuron = useCallback((noteId: string) => {
    emit('nav:focusBrainNode', noteId);
  }, []);

  const handleDismissBanner = useCallback(() => {
    if (!activeTabPath) return;
    setBannerDismissed((prev) => ({ ...prev, [activeTabPath]: true }));
  }, [activeTabPath]);

  function renderLegacyPanel(panel: LegacyPanel) {
    switch (panel) {
      case 'sourceControl':
        return <SourceControlPanel platform={platform} projectRoot={projectRoot} />;
      case 'search':
        return <GlobalSearchPanel onFileOpen={(path, filename, content) => openFile(path, filename, content)} />;
      case 'outline':
        return <OutlineView lspHandle={null} onJump={(line) => emit('editor:openFile', { path: activeTabPath ?? '', line })} />;
      case 'gitGraph':
        return <GitGraph platform={platform} projectRoot={projectRoot} />;
      case 'extensions':
        return <ExtensionPanel onClose={() => setLegacyPanel(null)} />;
      case 'debug':
        return <DebuggerPanel onClose={() => setLegacyPanel(null)} />;
      case 'docker':
        return <DockerPanel />;
      case 'db':
        return <DbExplorer />;
      case 'timeline':
        return <Timeline />;
      default:
        return null;
    }
  }

  const assistantIdentity: AssistantIdentity = {
    title: t('codespace.assistant.title'),
    tagline: t('codespace.assistant.tagline'),
    avatarLetter: 'A',
    avatarGradient: 'linear-gradient(135deg,#38BDF8,#7C5CFF)',
    accentColor: '#7DD3FC',
    statusLine: activeTabPath && activeFileProject
      ? { projectColor: colorForProject(activeFileProject.id), filePath: activeRelPath ?? activeTabPath, diffStat: liveWorktreeMission ? `+${liveWorktreeMission.diffAdded ?? 0} −${liveWorktreeMission.diffRemoved ?? 0}` : undefined }
      : null,
  };

  const assistantQuickActions: AssistantQuickAction[] = [
    {
      id: 'explain-file',
      label: t('codespace.assistant.explainFile'),
      kind: 'send',
      buildText: () => activeFilename
        ? t('codespace.assistant.explainPrompt', { file: activeRelPath ?? activeFilename })
        : t('codespace.assistant.explainPromptNoFile'),
    },
    {
      id: 'send-agent',
      label: t('codespace.assistant.sendAgent'),
      kind: 'launch',
      buildText: (composerText) => composerText.trim() || t('codespace.assistant.sendAgentDefaultTask', { file: activeFilename ?? '' }),
    },
  ];

  // Registers this host's live coder-mode props + DOM container with the
  // single <ManagerHost> (mounted once at the AppShell root) instead of
  // instantiating <LazyManager> here directly — see
  // managerHostRegistry.tsx's header comment. Called unconditionally, above
  // the "no project open" early return below (hooks can't be conditional):
  // while that welcome screen is showing, the container ref callback below
  // never attaches to a DOM node, so <ManagerHost> has nothing to portal
  // into — matching this component's pre-fix behavior (the welcome screen
  // never rendered LazyManager either, it replaces the whole layout).
  const managerContainerRef = useManagerHostSource('code', {
    identity: assistantIdentity,
    quickActions: assistantQuickActions,
  });

  // Show a welcome screen when no project is open (tauri only — web always has mock data)
  if (!projectRoot && platform.name === 'tauri' && openProjects.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, maxWidth: 400, textAlign: 'center', padding: 40 }}>
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" style={{ opacity: 0.15 }}>
            <path d="M6 14h10l4 4h22v26H6z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          </svg>
          <div style={{ fontSize: 18, color: 'rgba(255,255,255,0.5)', fontWeight: 500 }}>{t('code.welcomeTitle')}</div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)', lineHeight: 1.6 }}>{t('code.welcomeSubtitle')}</div>
          <button
            onClick={() => openProject()}
            style={{ padding: '10px 24px', fontSize: 13, background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.4)', borderRadius: 8, color: '#A78BFF', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}
          >
            {t('code.openFolder')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0, minWidth: 0 }}>
        <CodeSidebar
          openProjects={openProjects}
          activeProjectId={activeProjectId}
          fleetProjects={fleetProjects}
          platform={platform}
          activeTabPath={activeTabPath}
          activeFileProject={activeFileProject}
          activeFileMissions={activeFileMissions}
          onFileOpen={(path, filename) => void handleSidebarFileOpen(path, filename)}
          onOpenProject={() => void openProject()}
          onOpenDiff={handleOpenDiff}
          onOpenNeuron={handleOpenNeuron}
          legacyPanel={legacyPanel}
          onSelectLegacyPanel={setLegacyPanel}
          onCloseLegacyPanel={() => setLegacyPanel(null)}
          renderLegacyPanel={renderLegacyPanel}
          overlayItems={OVERLAY_ITEMS}
          onOpenOverlay={(id) => setOverlay(id as OverlayModal)}
        />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          <CenterEditor
            banner={banner}
            onDismissBanner={handleDismissBanner}
            isLiveWorktreeFile={liveWorktreeMission !== null}
            projectColorForPath={projectColorForPath}
            isLiveForPath={isLiveForPath}
            liveActivityForPath={liveActivityForPath}
          />
          <ResizeHandle onPointerDown={terminal.onPointerDown} direction="vertical" />
          <TerminalStrip height={terminal.size} />
          <CodeStatusBar
            projectName={activeFileProject ? basenameOf(activeFileProject.root) : null}
            projectColor={activeFileProject ? colorForProject(activeFileProject.id) : null}
            branchOrWorktree={liveWorktreeMission?.worktree ?? null}
            language={activeFilename ? detectLanguage(activeFilename) : null}
            totalLines={activeTab ? activeTab.content.split('\n').length : null}
            diffStat={liveWorktreeMission ? `+${liveWorktreeMission.diffAdded ?? 0} −${liveWorktreeMission.diffRemoved ?? 0}` : null}
            cursorPosition={activeTab ? cursorPosition : null}
          />
        </div>

        <ResizeHandle onPointerDown={sidebarAssistant.onPointerDown} direction="horizontal" />
        <aside
          style={{
            width: sidebarAssistant.size,
            minWidth: 0,
            borderLeft: '1px solid var(--color-border-2)',
            background: 'var(--color-panel-3)',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
            overflow: 'hidden',
          }}
        >
          {/* Portal target for the single <ManagerHost>-owned LazyManager
              instance — see managerHostRegistry.tsx. flex:1/minHeight:0 so
              it fills this aside exactly as LazyManager's own root div used
              to when instantiated directly here. */}
          <div
            ref={managerContainerRef}
            data-testid="code-assistant-body"
            style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
          />
        </aside>
      </div>

      {overlay === 'settings' && <SettingsPanel onClose={() => setOverlay(null)} />}
      {overlay === 'profiles' && <ProfilesManager onClose={() => setOverlay(null)} />}
      {overlay === 'importVsCode' && <ImportVsCode onClose={() => setOverlay(null)} />}
      {overlay === 'compareBranches' && <CompareBranches platform={platform} projectRoot={projectRoot} onClose={() => setOverlay(null)} />}
      {overlay === 'interactiveRebase' && <InteractiveRebase platform={platform} projectRoot={projectRoot} onClose={() => setOverlay(null)} />}
      {overlay === 'snippets' && <SnippetsManager onClose={() => setOverlay(null)} />}
      {overlay === 'webPreview' && <WebPreview url="http://localhost:3000" onClose={() => setOverlay(null)} />}
      {overlay === 'zenMode' && (
        <ZenMode onExit={() => setOverlay(null)}>
          <CenterEditor
            banner={banner}
            onDismissBanner={handleDismissBanner}
            isLiveWorktreeFile={liveWorktreeMission !== null}
            projectColorForPath={projectColorForPath}
            isLiveForPath={isLiveForPath}
            liveActivityForPath={liveActivityForPath}
          />
        </ZenMode>
      )}

      {diffTarget && <DiffDrawer target={diffTarget} onClose={() => setDiffTarget(null)} />}
      {imagePreviewPath && <ImagePreview path={imagePreviewPath} onClose={() => setImagePreviewPath(null)} />}
    </div>
  );
}

// Note: EditorStoreProvider is mounted once at App root level.
export function CodeSpace() {
  return <CodeSpaceBody />;
}
