/* CodeSidebar — 320px left column assembling PROJETS / WORKTREES / BRAIN /
   RÈGLE DU MANAGER (design-code.md §4.2-§4.5). The design drops the old
   single-project explorer/search/outline/git-graph/etc. icon strip
   entirely — every one of those legacy panels stays reachable (not
   deleted) via a compact "⋯" overflow menu in the header instead, per the
   redesign's own instruction to keep existing functionality discreetly
   available rather than remove it.
*/

import { useMemo, useState } from 'react';
import type { Platform } from '../../../lib/platform/types';
import type { ProjectEntry } from '../../../app/AppContext';
import type { FleetProject, FleetMission } from '../../../lib/agents/fleetMissions';
import { CodeSidebarProjects } from './CodeSidebarProjects';
import { CodeLiveFiles } from './CodeLiveFiles';
import { CodeSidebarWorktrees } from './CodeSidebarWorktrees';
import { CodeSidebarBrain, CodeSidebarManagerNote } from './CodeSidebarBrain';
import { useI18n } from '../../../i18n';

export type LegacyPanel = 'search' | 'outline' | 'gitGraph' | 'sourceControl' | 'extensions' | 'debug' | 'docker' | 'db' | 'timeline';

// `available: false` entries render a disabled row with a "coming soon"
// badge in the overflow menu itself instead of letting the user click
// through to find out — see design-code.md's "product blocks/promises
// without explaining" fix (2026-08-15). Keep this in sync with
// renderLegacyPanel's ComingSoon-wrapped cases in CodeSpace.tsx.
const LEGACY_PANEL_ITEMS: Array<{ id: LegacyPanel; labelKey: string; available: boolean }> = [
  { id: 'sourceControl', labelKey: 'codespace.overflow.sourceControl', available: true },
  { id: 'search', labelKey: 'codespace.overflow.search', available: true },
  { id: 'outline', labelKey: 'codespace.overflow.outline', available: true },
  { id: 'gitGraph', labelKey: 'codespace.overflow.gitGraph', available: true },
  { id: 'extensions', labelKey: 'codespace.overflow.extensions', available: false },
  { id: 'debug', labelKey: 'codespace.overflow.debug', available: false },
  { id: 'docker', labelKey: 'codespace.overflow.docker', available: false },
  { id: 'db', labelKey: 'codespace.overflow.db', available: false },
  { id: 'timeline', labelKey: 'codespace.overflow.timeline', available: true },
];

interface CodeSidebarProps {
  openProjects: ProjectEntry[];
  /** The active project's registry id (AppContext.activeProjectId) — F6 fix
   *  (post-e2e wave): drives which project's PROJETS section renders first
   *  and expanded by default. */
  activeProjectId: string | null;
  fleetProjects: FleetProject[];
  platform: Platform;
  activeTabPath: string | null;
  activeFileProject: ProjectEntry | null;
  activeFileMissions: readonly FleetMission[];
  onFileOpen: (path: string, filename: string) => void;
  onOpenProject: () => void;
  onOpenDiff: (worktreeBranch: string, subtitle: string, mission: FleetMission | null) => void;
  onOpenNeuron: (noteId: string) => void;
  legacyPanel: LegacyPanel | null;
  onSelectLegacyPanel: (panel: LegacyPanel) => void;
  onCloseLegacyPanel: () => void;
  renderLegacyPanel: (panel: LegacyPanel) => React.ReactNode;
  /** Non-sidebar legacy overlay modals (settings/profiles/import/compare
   *  branches/rebase/snippets/web preview/zen mode) — kept reachable from
   *  the same overflow menu, rendered below a divider. */
  overlayItems: Array<{ id: string; labelKey: string }>;
  onOpenOverlay: (id: string) => void;
}

export function CodeSidebar({
  openProjects,
  activeProjectId,
  fleetProjects,
  platform,
  activeTabPath,
  activeFileProject,
  activeFileMissions,
  onFileOpen,
  onOpenProject,
  onOpenDiff,
  onOpenNeuron,
  legacyPanel,
  onSelectLegacyPanel,
  onCloseLegacyPanel,
  renderLegacyPanel,
  overlayItems,
  onOpenOverlay,
}: CodeSidebarProps) {
  const { t } = useI18n();
  const [showOverflow, setShowOverflow] = useState(false);

  const activeFileFleet = useMemo(
    () => (activeFileProject ? fleetProjects.find((p) => p.root === activeFileProject.root) : undefined),
    [activeFileProject, fleetProjects],
  );

  return (
    <div style={{ width: 320, flexShrink: 0, background: 'var(--color-panel-3)', borderRight: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 10px 0', flexShrink: 0, position: 'relative' }}>
        {legacyPanel && (
          <button
            onClick={onCloseLegacyPanel}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-accent-pale)', fontSize: 11.5, fontFamily: 'inherit', padding: '4px 6px' }}
          >
            ← {t('codespace.overflow.backToFiles')}
          </button>
        )}
        <div style={{ marginLeft: 'auto', position: 'relative' }}>
          <button
            title={t('codespace.overflow.more')}
            onClick={() => setShowOverflow((v) => !v)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: 16, padding: '4px 8px', lineHeight: 1 }}
          >
            ⋯
          </button>
          {showOverflow && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setShowOverflow(false)} />
              <div
                style={{
                  position: 'absolute', top: '100%', right: 0, zIndex: 50, minWidth: 180,
                  background: 'var(--color-panel-2)', border: '1px solid var(--color-border)', borderRadius: 8,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.4)', padding: '4px 0',
                }}
              >
                {LEGACY_PANEL_ITEMS.map((item) => (
                  <button
                    key={item.id}
                    disabled={!item.available}
                    title={item.available ? undefined : t('codespace.overflow.comingSoon')}
                    onClick={() => {
                      if (!item.available) return;
                      onSelectLegacyPanel(item.id);
                      setShowOverflow(false);
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                      width: '100%', textAlign: 'left', background: 'none', border: 'none',
                      cursor: item.available ? 'pointer' : 'not-allowed',
                      fontSize: 12, padding: '7px 14px',
                      color: item.available ? 'var(--color-text-secondary)' : 'var(--color-text-muted)',
                      opacity: item.available ? 1 : 0.55,
                      fontFamily: 'inherit',
                    }}
                    onMouseEnter={item.available ? (e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)'; } : undefined}
                    onMouseLeave={item.available ? (e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; } : undefined}
                  >
                    <span>{t(item.labelKey)}</span>
                    {!item.available && (
                      <span style={{ fontSize: 9.5, letterSpacing: '0.03em', flexShrink: 0 }}>
                        {t('codespace.overflow.comingSoon')}
                      </span>
                    )}
                  </button>
                ))}
                {overlayItems.length > 0 && <div style={{ borderTop: '1px solid var(--color-border-2)', margin: '4px 0' }} />}
                {overlayItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => { onOpenOverlay(item.id); setShowOverflow(false); }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, padding: '7px 14px', color: 'var(--color-text-secondary)', fontFamily: 'inherit' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                  >
                    {t(item.labelKey)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {legacyPanel ? (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {renderLegacyPanel(legacyPanel)}
        </div>
      ) : (
        <>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <CodeLiveFiles fleetProjects={fleetProjects} onFileOpen={onFileOpen} />
            <CodeSidebarProjects
              openProjects={openProjects}
              activeProjectId={activeProjectId}
              fleetProjects={fleetProjects}
              platform={platform}
              activeTabPath={activeTabPath}
              onFileOpen={onFileOpen}
              onOpenProject={onOpenProject}
            />
            {activeFileProject && (
              <CodeSidebarWorktrees
                projectRoot={activeFileProject.root}
                platform={platform}
                missions={activeFileMissions}
                onOpenDiff={onOpenDiff}
              />
            )}
            <CodeSidebarBrain
              platform={platform}
              activeFilePath={activeTabPath}
              activeFileRoot={activeFileProject?.root ?? null}
              onOpenNeuron={onOpenNeuron}
            />
          </div>
          <CodeSidebarManagerNote
            platform={platform}
            projectId={activeFileFleet?.projectId ?? null}
            missions={activeFileFleet?.missions ?? []}
          />
        </>
      )}
    </div>
  );
}
