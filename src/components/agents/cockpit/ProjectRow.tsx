/* ProjectRow — one project's row in the AGENTS pipeline grid (design §8).
   Collapsed: compact header + per-stage "● n" chips. Expanded: full 5-column
   grid of mission cards. Per the README's collapse rule (D1 exception over
   the .dc.html prototype, which only shows a chip): any mission needing a
   human decision stays rendered as a FULL card, inline, even while the row
   is collapsed.
*/

import { useMemo } from 'react';
import type { FleetMission, FleetProject } from '../../../lib/agents/fleetMissions';
import type { UrgentKind } from './cockpitHelpers';
import { PIPELINE_STAGES, PIPELINE_GRID_TEMPLATE, classifyUrgent, sortMissionsForColumn, urgentActionsFor } from './cockpitHelpers';
import { UrgentMissionCard } from './UrgentMissionCard';
import { CompactMissionCard } from './CompactMissionCard';
import { useI18n } from '../../../i18n';

const STAGE_LABEL_KEYS: Record<string, string> = {
  plan: 'cockpit.stage.plan',
  code: 'cockpit.stage.code',
  test: 'cockpit.stage.test',
  review: 'cockpit.stage.review',
  merged: 'cockpit.stage.merged',
};

interface ChipInfo {
  text: string;
  bg: string;
  color: string;
}

function chipForColumn(missions: FleetMission[], stage: string): ChipInfo | null {
  if (missions.length === 0) return null;
  const kinds = missions.map(classifyUrgent).filter((k): k is UrgentKind => k !== null);
  if (kinds.includes('permission') || kinds.includes('failed')) {
    return { text: String(missions.length), bg: 'var(--color-danger)', color: '#14141C' };
  }
  if (kinds.includes('review')) {
    return { text: String(missions.length), bg: 'var(--color-warning)', color: '#14141C' };
  }
  if (stage === 'merged') {
    return { text: `${missions.length} ✓`, bg: 'transparent', color: 'var(--color-success)' };
  }
  const anyRunning = missions.some((m) => m.status === 'running');
  return {
    text: `● ${missions.length}`,
    bg: 'var(--color-panel-2)',
    color: anyRunning ? 'var(--color-success)' : 'var(--color-text-muted)',
  };
}

interface ProjectRowProps {
  project: FleetProject;
  color: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  highlightIds: ReadonlySet<string>;
  justMergedId: string | null;
  rankByMissionId: ReadonlyMap<string, number>;
  forceApproveIds: ReadonlySet<string>;
  onOpenMission: (missionId: string) => void;
  onUrgentAction: (mission: FleetMission, actionKey: string) => void;
}

export function ProjectRow({
  project,
  color,
  collapsed,
  onToggleCollapse,
  highlightIds,
  justMergedId,
  rankByMissionId,
  forceApproveIds,
  onOpenMission,
  onUrgentAction,
}: ProjectRowProps) {
  const { t } = useI18n();

  // Perf audit 2026-08-15 (item 4): these three used to be plain `const`s
  // computed inline in the render body on every render (map/filter chains
  // over `project.missions`), not memoized — cheap to fix, and worth fixing
  // even though this component is currently DEAD CODE (see AgentGrid.tsx,
  // its only consumer: not imported/rendered anywhere in the live app,
  // only referenced from a comment in CanvasView.tsx and from its own
  // test) so a future re-wiring doesn't inherit the same trap. Hoisted
  // ABOVE the zero-missions early return below (Rules of Hooks: a hook call
  // can't follow a conditional return) — cheap no-op work on an empty array
  // in that branch, not a real cost.
  const byStage = useMemo(
    () => PIPELINE_STAGES.map((stage) => sortMissionsForColumn(project.missions.filter((m) => m.stage === stage))),
    [project.missions],
  );
  const urgentMissions = useMemo(() => project.missions.filter((m) => classifyUrgent(m) !== null), [project.missions]);
  const activeCount = useMemo(
    () => project.missions.filter((m) => m.status === 'running' || m.status === 'queued').length,
    [project.missions],
  );

  // F7 fix (post-e2e wave): a project with zero missions must still render
  // — as a compact "calm" row (muted dot + "zzz" + name), never nothing and
  // never the full 5-column grid header (which would show 5 empty columns).
  // Mirrors the Bandeau's per-project pill 'idle' state (cockpitHelpers.ts's
  // deriveProjectPills) as a grid row instead of a pill. Ignores the
  // collapsed/expanded toggle entirely — there is nothing to expand.
  if (project.missions.length === 0) {
    return (
      <div
        data-testid={`project-row-${project.projectId}`}
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: PIPELINE_GRID_TEMPLATE,
            padding: '0 28px',
            height: 46,
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, opacity: 0.35, flexShrink: 0 }} />
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--color-text-muted)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {project.name}
            </span>
          </div>
          <span
            style={{
              gridColumn: '2 / -1',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--color-text-disabled)',
              paddingLeft: 12,
            }}
          >
            {t('cockpit.row.idle')}
          </span>
        </div>
      </div>
    );
  }

  const rowHasOverdue = collapsed && urgentMissions.length > 0;

  function renderCard(mission: FleetMission) {
    const kind = classifyUrgent(mission);
    const glow = highlightIds.has(mission.id);
    if (kind) {
      return (
        <UrgentMissionCard
          key={mission.id}
          mission={mission}
          kind={kind}
          rank={rankByMissionId.get(mission.id) ?? 1}
          glow={glow}
          onOpen={() => onOpenMission(mission.id)}
          actions={urgentActionsFor({ mission, kind, t, forceApprove: forceApproveIds.has(mission.id) })}
          onAction={(actionKey) => onUrgentAction(mission, actionKey)}
        />
      );
    }
    return (
      <CompactMissionCard
        key={mission.id}
        mission={mission}
        glow={glow}
        justMerged={justMergedId === mission.id}
        onOpen={() => onOpenMission(mission.id)}
      />
    );
  }

  return (
    <div
      data-testid={`project-row-${project.projectId}`}
      style={{
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: rowHasOverdue ? 'rgba(248,113,113,0.06)' : 'transparent',
      }}
    >
      {/* Row header — always visible, toggles collapse */}
      <div
        onClick={(e) => {
          // F8 fix (post-e2e wave): collapsing/expanding a row can shrink or
          // grow the scrollable grid's total content height dramatically
          // (a full 5-column mission grid vs. a 58px compact row). A scroll
          // position set while the row was tall stays exactly where it was
          // after the toggle, which can point deep into content that no
          // longer aligns with it — the collapsed row's own name/chips
          // scroll out of view while an unrelated card's middle ends up
          // sitting right at the sticky pipeline header's row, reading as
          // an overlap. Scrolling the just-toggled row's own header back
          // into view (nearest edge, no unnecessary jump when already
          // visible) keeps it always adjacent to — never colliding with —
          // the sticky header, at any zoom level.
          const node = e.currentTarget;
          onToggleCollapse();
          requestAnimationFrame(() => {
            node.scrollIntoView({ block: 'nearest' });
          });
        }}
        style={{
          display: 'grid',
          gridTemplateColumns: PIPELINE_GRID_TEMPLATE,
          padding: collapsed ? '0 28px' : '14px 28px 6px',
          height: collapsed ? 58 : undefined,
          alignItems: 'center',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => { if (collapsed) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--color-text-disabled)' }}>{collapsed ? '▶' : '▼'}</span>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {project.name}
            </span>
          </div>
          {!collapsed && (
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)', paddingLeft: 17 }}>
              {t('cockpit.row.agentsCount', { count: activeCount })}
              {urgentMissions.length > 0 ? ` · ${t('cockpit.row.needsYouCount', { count: urgentMissions.length })}` : ''}
            </span>
          )}
        </div>
        {collapsed &&
          byStage.map((missions, i) => {
            const chip = chipForColumn(missions, PIPELINE_STAGES[i]);
            return (
              <div key={PIPELINE_STAGES[i]} style={{ paddingLeft: 12, borderLeft: '1px solid rgba(255,255,255,0.06)', height: '100%', display: 'flex', alignItems: 'center' }}>
                {chip && (
                  <span
                    style={{
                      fontSize: 12,
                      borderRadius: 6,
                      padding: '2px 9px',
                      fontFamily: 'var(--font-mono)',
                      fontWeight: 600,
                      background: chip.bg,
                      color: chip.color,
                    }}
                  >
                    {chip.text}
                  </span>
                )}
              </div>
            );
          })}
      </div>

      {/* Expanded: full 5-column grid of cards */}
      {!collapsed && (
        <div style={{ display: 'grid', gridTemplateColumns: PIPELINE_GRID_TEMPLATE, padding: '0 28px 14px', alignItems: 'stretch' }}>
          <div />
          {byStage.map((missions, i) => (
            <div
              key={PIPELINE_STAGES[i]}
              style={{ paddingLeft: 10, borderLeft: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              {missions.map(renderCard)}
            </div>
          ))}
        </div>
      )}

      {/* Collapse-rule exception (D1/README): urgent cards stay inline even
          when the row is collapsed, not just a chip. */}
      {collapsed && urgentMissions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 28px 14px 46px' }}>
          {urgentMissions.map((mission) => {
            const kind = classifyUrgent(mission);
            if (!kind) return null;
            return (
              <UrgentMissionCard
                key={mission.id}
                mission={mission}
                kind={kind}
                rank={rankByMissionId.get(mission.id) ?? 1}
                glow={highlightIds.has(mission.id)}
                onOpen={() => onOpenMission(mission.id)}
                actions={urgentActionsFor({ mission, kind, t, forceApprove: forceApproveIds.has(mission.id) })}
                onAction={(actionKey) => onUrgentAction(mission, actionKey)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// Header row label lookup is exported for AgentGrid's sticky pipeline header
// so the two never drift.
export { STAGE_LABEL_KEYS };
