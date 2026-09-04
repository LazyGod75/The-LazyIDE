/* ProjectReportPage.tsx — Agent Canvas W8e: per-project « Rapport » page —
   at a glance, what the agents produced for a given project: completed
   missions, KPIs, and each mission's real proof-of-work artifacts.

   Data source: useProjectReport(projectId) (lib/journal/useMissionHistory.ts,
   W8b's foundation) — a pure journal-derived read-model, never fabricated.

   WIRING GAPS left for the orchestrator (outside this wave's writable set):
     - LazyManager's `open_report` action (managerEngine.ts is not this
       wave's file) — AgentsSpace.tsx's bus listener below already handles
       the 'report:open' event, so wiring the manager action is just an
       emit() call at the manager's action-dispatch site.
     - A canvas zone-header / project-node "Voir le rapport" link (would
       live in chrome/nodeChrome.tsx or CanvasContextMenu.tsx — W8a's
       writable files this wave, not touched here) — can emit
       `report:open({ projectId })` once added.
     - CockpitKpiBar.tsx ("Bandeau KPI") is not this wave's file either;
       a KPI click there could also emit `report:open` with no changes
       needed on this side.
*/

import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { useProjectReport } from '../../../lib/journal/useMissionHistory';
import { useZoneDigest } from '../../../lib/journal/useZoneDigest';
import { useBrainSavings } from '../../../lib/journal/useBrainSavings';
import { formatZoneDigestAge } from '../../../lib/journal/zoneDigest';
import { projectColor } from '../canvas/canvasTypes';
import { basename } from '../../../lib/paths';
import { ReportKpiStrip } from './ReportKpiStrip';
import { BrainSavingsCard } from './BrainSavingsCard';
import { ReportPeriodSelector } from './ReportPeriodSelector';
import { ProjectSwitcherRow } from './ProjectSwitcherRow';
import { MissionReportCard } from './MissionReportCard';
import { filterMissionsByPeriod, type ReportPeriod } from './reportPeriod';
import type { ProjectEntry } from '../../../app/AppContext';

interface ProjectReportPageProps {
  projectId: string;
  projectRoot: string;
  openProjects: readonly ProjectEntry[];
  onSelectProject: (projectId: string) => void;
  onOpenMission: (missionId: string) => void;
  onClose: () => void;
  /**
   * 'page' (default): the pre-existing full-viewport look (opaque
   * `--color-bg` background, `height: 100%`) plus this page's own in-page
   * close button — unchanged for any caller still rendering it as a
   * full-page overlay.
   * 'popover': rendered inside CockpitRailPopover's "mini-parchemin" shell
   * (AgentsSpace.tsx's report popover) — drops the full-bleed
   * height/background (the popover shell already scrolls and backgrounds
   * its own body) and hides the in-page close button, since the popover
   * already closes on outside-click/Escape (CockpitRailPopover.tsx).
   */
  layout?: 'page' | 'popover';
}

export function ProjectReportPage({
  projectId,
  projectRoot,
  openProjects,
  onSelectProject,
  onOpenMission,
  onClose,
  layout = 'page',
}: ProjectReportPageProps) {
  const { t } = useI18n();
  const { report, loading } = useProjectReport(projectId);
  // Defect #8 fix (replay/report coherence): the empty state used to be a
  // pure shell ("Aucune mission terminée pour le moment", nothing else) even
  // when the project has real recent activity that simply never reached a
  // SUCCESS terminal event (still running, failed, cancelled, ...) — the
  // SAME digest source ProjectGroupNode.tsx's living empty zone reads from
  // (lib/journal/useZoneDigest.ts), so both surfaces agree on what "real
  // activity" means for this project.
  const { digest } = useZoneDigest(projectId);
  const { summary: brainSavings } = useBrainSavings(projectId);
  const [period, setPeriod] = useState<ReportPeriod>('all');

  const filtered = useMemo(
    () => (report ? filterMissionsByPeriod(report.completedMissions, period) : []),
    [report, period],
  );

  const color = projectColor(projectId);
  const projectLabel = basename(projectRoot);

  return (
    <div
      data-testid="project-report-page"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: '20px 24px',
        overflowY: 'auto',
        ...(layout === 'page' ? { height: '100%', background: 'var(--color-bg)' } : {}),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--color-text)' }}>
            {t('report.header.title', { project: projectLabel })}
          </h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ReportPeriodSelector value={period} onChange={setPeriod} />
          {layout === 'page' && (
            <button
              data-testid="project-report-close"
              onClick={onClose}
              style={{
                background: 'none',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                color: 'var(--color-text-muted)',
                fontSize: 12,
                padding: '5px 12px',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {t('report.header.close')}
            </button>
          )}
        </div>
      </div>

      <ProjectSwitcherRow projects={openProjects} activeProjectId={projectId} onSelect={onSelectProject} />

      {loading || !report ? (
        <div style={{ fontSize: 12, color: 'var(--color-text-disabled)' }}>{t('common.loading')}</div>
      ) : report.completedMissions.length === 0 ? (
        <div
          data-testid="project-report-empty"
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '48px 20px', textAlign: 'center' }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text)' }}>{t('report.empty.title')}</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', maxWidth: 420 }}>{t('report.empty.hint')}</div>
          {digest?.lastActivity && (
            <div data-testid="project-report-empty-last-activity" style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('report.empty.lastActivity', {
                when: formatZoneDigestAge(digest.lastActivity.atMs, t),
                type: digest.lastActivity.type,
              })}
            </div>
          )}
        </div>
      ) : (
        <>
          <ReportKpiStrip
            missionCount={report.completedMissions.length}
            mergedTodayCount={report.mergedTodayCount}
            totals={report.totals}
            brainNeuronsToday={digest?.brainNeuronsToday}
          />
          <BrainSavingsCard summary={brainSavings} />
          {filtered.length === 0 ? (
            <div data-testid="project-report-period-empty" style={{ fontSize: 12, color: 'var(--color-text-disabled)' }}>
              {t('report.period.empty')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {filtered.map((m) => (
                <MissionReportCard key={m.missionId} mission={m} onOpenMission={onOpenMission} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
