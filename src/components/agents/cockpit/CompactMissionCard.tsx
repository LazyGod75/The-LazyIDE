/* CompactMissionCard — the "compact" mission card variant (design §8.4) for
   running/queued/done missions that don't need a human decision. */

import type { FleetMission } from '../../../lib/agents/fleetMissions';
import { missionWhoWhatLine } from '../../../lib/agents/missionWhoLine';
import { useI18n } from '../../../i18n';

interface CompactMissionCardProps {
  mission: FleetMission;
  glow?: boolean;
  justMerged?: boolean;
  onOpen: () => void;
}

export function CompactMissionCard({ mission, glow, justMerged, onOpen }: CompactMissionCardProps) {
  const { t } = useI18n();
  const isDone = mission.status === 'done';
  const isQueued = mission.status === 'queued';
  const isRunning = mission.status === 'running';

  const dotColor = isDone || isRunning ? 'var(--color-success)' : isQueued ? '#5A5F6C' : 'rgba(255,255,255,0.35)';
  const nameColor = isDone ? 'var(--color-success-text)' : 'var(--color-text)';
  const liveColor = isDone ? 'var(--color-success)' : isQueued ? 'var(--color-text-disabled)' : 'var(--color-success-text)';

  const shadow = justMerged
    ? '0 0 0 2px rgba(74,222,128,0.55), 0 0 22px rgba(74,222,128,0.3)'
    : glow
      ? '0 0 0 2px rgba(124,92,255,0.55), 0 0 22px rgba(124,92,255,0.3)'
      : 'none';

  const meta = isQueued
    ? t('cockpit.card.queued')
    : mission.progress !== undefined
      ? `${Math.round(mission.progress)}%`
      : mission.model;

  return (
    <div
      data-testid={`compact-card-${mission.id}`}
      onClick={onOpen}
      style={{
        background: 'var(--color-panel-2)',
        border: `1px solid ${glow ? 'rgba(124,92,255,0.7)' : 'rgba(255,255,255,0.07)'}`,
        borderRadius: 8,
        padding: '9px 13px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        cursor: 'pointer',
        opacity: isQueued ? 0.6 : 1,
        boxShadow: shadow,
        transition: 'box-shadow 0.25s, border-color 0.15s',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: dotColor,
          flexShrink: 0,
          animation: isRunning ? 'blinkDot 2s infinite' : 'none',
        }}
      />
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: nameColor,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flexShrink: 0,
          maxWidth: '45%',
        }}
      >
        {mission.title}
      </span>
      <span
        data-testid="compact-mission-cursor"
        style={{
          flex: 1,
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: liveColor,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
        }}
      >
        {missionWhoWhatLine(mission, t)}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--color-text-disabled)',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {meta}
      </span>
    </div>
  );
}
