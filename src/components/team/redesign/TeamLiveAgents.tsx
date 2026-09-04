/* TeamLiveAgents — live "agents at work" strip for Team space.
   Honest: real fleet missions only (no fabricated teammate CRDT cursors).
   Click jumps to the mission on the canvas, same as LazyManager's focus chip. */

import { emit } from '../../../lib/bus';
import { makeRef } from '../../agents/canvas/canvasTypes';
import { collectLiveTeamAgents, liveAgentCursorLine, type LiveTeamAgent } from '../../../lib/teams/liveTeamAgents';
import type { FleetProject } from '../../../lib/agents/fleetMissions';
import { useI18n } from '../../../i18n';

interface TeamLiveAgentsProps {
  projects: FleetProject[];
}

function statusColor(status: LiveTeamAgent['status']): string {
  if (status === 'review') return 'var(--color-warning)';
  if (status === 'queued') return 'var(--color-text-muted)';
  return 'var(--color-accent)';
}

function openOnCanvas(missionId: string): void {
  emit('nav:navigateSpace', 'agents');
  emit('canvas:focus', { ref: makeRef('mission', missionId) });
}

export function TeamLiveAgents({ projects }: TeamLiveAgentsProps) {
  const { t } = useI18n();
  const live = collectLiveTeamAgents(projects);

  return (
    <div data-testid="team-live-agents" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        style={{
          fontSize: 11.5,
          fontWeight: 700,
          letterSpacing: '1.8px',
          textTransform: 'uppercase',
          color: 'var(--color-text-muted)',
        }}
      >
        {t('team.redesign.lead.fleet.liveTitle')}
      </div>
      {live.length === 0 ? (
        <div data-testid="team-live-agents-empty" style={{ fontSize: 13.5, color: 'var(--color-text-ghost)' }}>
          {t('team.redesign.lead.fleet.liveEmpty')}
        </div>
      ) : (
        live.map((agent) => (
          <button
            key={agent.missionId}
            type="button"
            data-testid="team-live-agent-row"
            data-status={agent.status}
            onClick={() => openOnCanvas(agent.missionId)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              background: 'var(--color-panel)',
              border: '1px solid var(--color-border)',
              borderRadius: 12,
              padding: '12px 16px',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: 'inherit',
              color: 'inherit',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: statusColor(agent.status),
                flexShrink: 0,
                animation: agent.status === 'running' || agent.status === 'review' ? 'blinkDot 1.2s ease-in-out infinite' : undefined,
              }}
            />
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {agent.agentName}
                <span data-testid="team-live-agent-status" style={{ fontWeight: 500, color: statusColor(agent.status) }}>
                  {' · '}{t(`agents.status.${agent.status}`)}
                </span>
                <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}> · {agent.title}</span>
              </span>
              <span
                data-testid="team-live-agent-cursor"
                style={{ fontSize: 11.5, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {liveAgentCursorLine(agent, t)}
              </span>
            </span>
          </button>
        ))
      )}
    </div>
  );
}
