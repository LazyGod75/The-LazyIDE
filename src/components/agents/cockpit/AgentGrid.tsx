/* AgentGrid — sticky pipeline header (PLAN/CODE/TEST/REVUE/MERGÉ) + zoom
   controls + the scrollable, zoomable stack of project rows (design §7-8).
*/

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FleetMission, FleetProject } from '../../../lib/agents/fleetMissions';
import { PIPELINE_STAGES, PIPELINE_GRID_TEMPLATE } from './cockpitHelpers';
import { STAGE_LABEL_KEYS, ProjectRow } from './ProjectRow';
import { colorForProject } from '../../../lib/projectColors';
import { useI18n } from '../../../i18n';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.4;
const ZOOM_STEP = 0.1;
const WHEEL_ZOOM_STEP = 0.08;

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));
}

/** Module-level (not React state): keeps the AGENTS zone's zoom level alive
 *  across AgentGrid remounts within the same app session. AgentsSpace.tsx
 *  only renders <Cockpit/> while `activeTab === 'mission-control'` — opening
 *  the Bibliothèque tab and coming back fully unmounts/remounts Cockpit (and
 *  therefore AgentGrid), which used to silently reset zoom to 100% every
 *  time. Resets only on a real page reload/app restart, matching the design
 *  spec's "persists while navigating within the session" requirement
 *  (design-cockpit.md §15). */
let sessionZoom = 1;

interface AgentGridProps {
  projects: FleetProject[];
  collapsedMap: Record<string, boolean>;
  onToggleCollapse: (projectId: string) => void;
  highlightIds: ReadonlySet<string>;
  justMergedId: string | null;
  rankByMissionId: ReadonlyMap<string, number>;
  forceApproveIds: ReadonlySet<string>;
  onOpenMission: (missionId: string) => void;
  onUrgentAction: (mission: FleetMission, actionKey: string) => void;
  onOpenLibrary: () => void;
}

export function AgentGrid({
  projects,
  collapsedMap,
  onToggleCollapse,
  highlightIds,
  justMergedId,
  rankByMissionId,
  forceApproveIds,
  onOpenMission,
  onUrgentAction,
  onOpenLibrary,
}: AgentGridProps) {
  const { t } = useI18n();
  const [zoom, setZoomState] = useState(sessionZoom);
  const zoneRef = useRef<HTMLDivElement>(null);

  const setZoom = useCallback((updater: number | ((z: number) => number)) => {
    setZoomState((z) => {
      const next = typeof updater === 'function' ? (updater as (z: number) => number)(z) : updater;
      sessionZoom = next;
      return next;
    });
  }, []);

  const handleWheel = useCallback((e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom((z) => clampZoom(z + (e.deltaY < 0 ? WHEEL_ZOOM_STEP : -WHEEL_ZOOM_STEP)));
  }, [setZoom]);

  useEffect(() => {
    const el = zoneRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const zoomWidth = zoom >= 1 ? '100%' : `${(100 / zoom).toFixed(2)}%`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 320 }}>
      {/* Sticky pipeline header */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: PIPELINE_GRID_TEMPLATE,
          padding: '0 28px',
          paddingRight: 150,
          height: 46,
          alignItems: 'center',
          background: '#111119',
          borderBottom: '1px solid var(--color-border)',
          position: 'sticky',
          top: 0,
          zIndex: 5,
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }} title={t('cockpit.grid.zoomHint')}>
          <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--color-text-disabled)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {t('cockpit.grid.title')}
          </span>
          <div
            style={{
              background: 'var(--color-panel-2)',
              border: '1px solid rgba(255,255,255,0.14)',
              borderRadius: 8,
              padding: 2,
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              flexShrink: 0,
            }}
          >
            <button
              data-testid="grid-zoom-out"
              onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
              style={zoomButtonStyle}
              aria-label={t('cockpit.grid.zoomOut')}
            >
              −
            </button>
            <button
              data-testid="grid-zoom-reset"
              onClick={() => setZoom(1)}
              style={{ ...zoomButtonStyle, width: 40, fontFamily: 'var(--font-mono)', fontSize: 12 }}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              data-testid="grid-zoom-in"
              onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
              style={zoomButtonStyle}
              aria-label={t('cockpit.grid.zoomIn')}
            >
              +
            </button>
          </div>
        </div>
        {/* Deliberately OUT of the grid's auto-flow (position:absolute, not
            a grid child) — the header container above is already
            position:sticky, which is a valid CSS containing block for an
            absolutely-positioned descendant. A grid-column:'1 / -1' child
            here previously made the CSS Grid auto-placement algorithm push
            every auto-placed sibling after it (the 5 PLAN/CODE/TEST/REVUE/
            MERGÉ stage labels below) onto an IMPLICIT SECOND ROW, since an
            explicitly-positioned item spanning the full row width is
            treated as occupying all of row 1 — the labels rendered ~34px
            below the header's own 46px box (measured via
            getBoundingClientRect in a live-app check), overlapping the
            first project row underneath with the wrong background. Taking
            this button fully out of grid flow keeps the header's 6-column
            template exactly matching design-cockpit.md §7 (col 1 = zoom
            group only, cols 2-6 = stage labels), fixing that misalignment
            at every zoom level. */}
        <button
          onClick={onOpenLibrary}
          data-testid="open-library-chip"
          style={{
            position: 'absolute',
            right: 28,
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: 11,
            fontWeight: 600,
            padding: '4px 10px',
            borderRadius: 20,
            border: '1px solid rgba(255,255,255,0.14)',
            background: 'transparent',
            color: 'var(--color-text-muted)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
          }}
        >
          {t('cockpit.grid.library')}
        </button>
        {PIPELINE_STAGES.map((stage, i) => (
          <span
            key={stage}
            style={{
              paddingLeft: 12,
              borderLeft: '1px solid rgba(255,255,255,0.09)',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: 1.5,
              color: i === PIPELINE_STAGES.length - 1 ? 'var(--color-success)' : 'var(--color-text-disabled)',
            }}
          >
            {t(STAGE_LABEL_KEYS[stage])}
          </span>
        ))}
      </div>

      {/* Zoomable, scrollable rows */}
      <div ref={zoneRef} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {projects.length === 0 ? (
          <div style={{ padding: '40px 28px', color: 'var(--color-text-disabled)', fontSize: 13 }}>
            {t('cockpit.grid.empty')}
          </div>
        ) : (
          <div
            data-testid="agent-grid-zoom-content"
            style={{ display: 'flex', flexDirection: 'column', transform: `scale(${zoom})`, transformOrigin: 'top left', width: zoomWidth }}
          >
            {projects.map((project) => (
              <ProjectRow
                key={project.projectId}
                project={project}
                color={colorForProject(project.projectId)}
                collapsed={collapsedMap[project.projectId] ?? false}
                onToggleCollapse={() => onToggleCollapse(project.projectId)}
                highlightIds={highlightIds}
                justMergedId={justMergedId}
                rankByMissionId={rankByMissionId}
                forceApproveIds={forceApproveIds}
                onOpenMission={onOpenMission}
                onUrgentAction={onUrgentAction}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const zoomButtonStyle: React.CSSProperties = {
  width: 26,
  height: 22,
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: 'var(--color-text-secondary)',
  fontSize: 17,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'inherit',
};
