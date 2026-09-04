/* TeamFleetCockpit — org-wide fleet KPIs (spec §13, teamAggregates.ts).
   Rolls up computeTeamAggregates() into a compact panel for LeadView: live
   mission counts across every member's projects, cost/tokens, brain
   promotion/decision counts, and the derived team health score.

   KPI tiles still null when computeTeamAggregates() returns null (not
   entitled / not running under Tauri). The live-agents strip always
   renders — it is derived from useFleetMissions (honest empty on web).
*/

import { useEffect, useState } from 'react';
import type { OrgMember } from '../../../lib/teams/types';
import { computeTeamAggregates, computeTeamHealthScore, type TeamCockpitData } from '../../../lib/teams/teamAggregates';
import { formatCost, formatTokens } from '../../metrics';
import { displayNameFor } from './shared';
import { useI18n } from '../../../i18n';
import { useFleetMissions } from '../../../lib/agents/fleetMissions';
import { TeamLiveAgents } from './TeamLiveAgents';

interface TeamFleetCockpitProps {
  members: OrgMember[];
}

function Tile({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <div style={{ background: 'var(--color-panel-2)', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 20, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{label}</div>
    </div>
  );
}

export function TeamFleetCockpit({ members }: TeamFleetCockpitProps) {
  const { t } = useI18n();
  const [data, setData] = useState<TeamCockpitData | null>(null);
  const { projects } = useFleetMissions();

  useEffect(() => {
    let cancelled = false;
    const orgContext = {
      members: members.map((m) => ({
        id: m.user_id,
        name: displayNameFor(m),
        role: m.role,
        deptId: m.dept_id ?? undefined,
      })),
    };
    void computeTeamAggregates(orgContext).then((result) => {
      if (!cancelled) setData(result);
    });
    return () => {
      cancelled = true;
    };
  }, [members]);

  const healthScore = data ? computeTeamHealthScore(data) : null;
  const activeMissions = data
    ? data.team.totalRunning + data.team.totalQueued + data.team.totalReview
    : 0;

  return (
    <div data-testid="team-fleet-cockpit" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {data && (
        <>
      <div
        style={{
          fontSize: 11.5,
          fontWeight: 700,
          letterSpacing: '1.8px',
          textTransform: 'uppercase',
          color: 'var(--color-text-muted)',
        }}
      >
        {t('team.redesign.lead.fleet.title')}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
        <Tile value={String(activeMissions)} label={t('team.redesign.lead.fleet.active')} color="var(--color-accent-pale)" />
        <Tile value={String(data.team.totalDone)} label={t('team.redesign.lead.fleet.done')} color="var(--color-success)" />
        <Tile value={String(data.team.totalFailed)} label={t('team.redesign.lead.fleet.failed')} color="var(--color-danger, #F87171)" />
        <Tile value={formatCost(data.team.totalCostUsd)} label={t('team.redesign.lead.fleet.cost')} color="var(--color-warning-text)" />
        <Tile value={formatTokens(data.team.totalTokens)} label={t('team.redesign.lead.fleet.tokens')} color="var(--color-text)" />
        <Tile value={String(data.team.neuronsPromoted)} label={t('team.redesign.lead.fleet.neuronsPromoted')} color="var(--color-text)" />
        <Tile value={String(data.team.decisionsAutoAnswered)} label={t('team.redesign.lead.fleet.decisions')} color="var(--color-text)" />
        <Tile value={`${healthScore}`} label={t('team.redesign.lead.fleet.health')} color="var(--color-success)" />
      </div>
        </>
      )}
      <TeamLiveAgents projects={projects} />
    </div>
  );
}
