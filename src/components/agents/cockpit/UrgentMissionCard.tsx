/* UrgentMissionCard — the "full" mission card variant (design §8.3) for a
   mission that needs a human decision right now: permission (a running
   mission blocked on a real ask_user question), failed, or review-ready.

   Every action button below is wired to a REAL agentsStore primitive — see
   Cockpit.tsx's handlers for exactly which store method each one calls.
   No fabricated success states: an action either performs the real mutation
   or, for a mission that belongs to a currently-inactive project, switches
   the active project first (see Cockpit.tsx's handleUrgentAction doc
   comment for why a single click can't do both atomically today).
*/

import type { FleetMission } from '../../../lib/agents/fleetMissions';
import type { UrgentAction, UrgentKind } from './cockpitHelpers';
import { formatElapsed } from './cockpitHelpers';
import { missionWhoWhatLine } from '../../../lib/agents/missionWhoLine';
import { useI18n } from '../../../i18n';

const KIND_STYLE: Record<UrgentKind, { border: string; headBg: string; dot: string; text: string; badgeBg: string; pulse: boolean }> = {
  permission: {
    border: 'rgba(248,113,113,0.55)',
    headBg: 'rgba(248,113,113,0.08)',
    dot: 'var(--color-danger)',
    text: 'var(--color-danger-text)',
    badgeBg: 'var(--color-danger)',
    pulse: true,
  },
  failed: {
    border: 'rgba(248,113,113,0.55)',
    headBg: 'rgba(248,113,113,0.08)',
    dot: 'var(--color-danger)',
    text: 'var(--color-danger-text)',
    badgeBg: 'var(--color-danger)',
    pulse: false,
  },
  review: {
    border: 'rgba(251,185,36,0.5)',
    headBg: 'rgba(251,185,36,0.07)',
    dot: 'var(--color-warning)',
    text: '#FCD34D',
    badgeBg: 'var(--color-warning)',
    pulse: false,
  },
};

interface UrgentMissionCardProps {
  mission: FleetMission;
  kind: UrgentKind;
  rank: number;
  glow?: boolean;
  onOpen: () => void;
  actions: UrgentAction[];
  onAction: (key: string) => void;
}

function badgeText(kind: UrgentKind, rank: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (kind === 'permission') return t('cockpit.badge.permission', { rank });
  if (kind === 'failed') return t('cockpit.badge.failed', { rank });
  return t('cockpit.badge.review', { rank });
}

export function UrgentMissionCard({ mission, kind, rank, glow, onOpen, actions, onAction }: UrgentMissionCardProps) {
  const { t } = useI18n();
  const style = KIND_STYLE[kind];
  const glowShadow = glow
    ? '0 0 0 2px rgba(124,92,255,0.55), 0 0 22px rgba(124,92,255,0.3)'
    : 'none';

  return (
    <div
      data-testid={`urgent-card-${mission.id}`}
      style={{
        background: 'var(--color-panel-2)',
        border: `1px solid ${style.border}`,
        borderRadius: 10,
        overflow: 'hidden',
        boxShadow: glowShadow !== 'none' ? glowShadow : '2px 2px 0 rgba(0,0,0,0.35)',
        animation: style.pulse ? 'pulseRed 2s infinite' : 'none',
        transition: 'box-shadow 0.25s',
      }}
    >
      <div
        onClick={onOpen}
        style={{
          padding: '8px 13px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          background: style.headBg,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: style.dot, flexShrink: 0 }} />
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            color: 'var(--color-text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {mission.title}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 10.5,
            fontWeight: 700,
            padding: '1px 6px',
            borderRadius: 4,
            background: style.badgeBg,
            color: '#14141C',
            whiteSpace: 'nowrap',
          }}
        >
          {badgeText(kind, rank, t)}
        </span>
      </div>
      <div
        data-testid="urgent-mission-cursor"
        onClick={onOpen}
        style={{
          padding: '8px 13px',
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          lineHeight: 1.6,
          color: style.text,
          cursor: 'pointer',
        }}
      >
        {missionWhoWhatLine(mission, t) || t('cockpit.card.noLiveText')}
        {kind !== 'permission' && (
          <span style={{ display: 'block', color: 'var(--color-text-disabled)', fontSize: 10.5 }}>
            {formatElapsed(mission.updatedMs, t)}
          </span>
        )}
      </div>
      {actions.length > 0 && (
        <div style={{ display: 'flex', gap: 6, padding: '8px 13px 11px' }}>
          {actions.map((action, index) => (
            <button
              key={action.key}
              data-testid={`urgent-action-${mission.id}-${action.key}`}
              onClick={(e) => {
                e.stopPropagation();
                onAction(action.key);
              }}
              style={{
                flex: 1,
                textAlign: 'center',
                padding: '6px 8px',
                borderRadius: 7,
                fontSize: 11.5,
                fontWeight: 700,
                fontFamily: 'inherit',
                cursor: 'pointer',
                border: index === 0 ? 'none' : '1px solid rgba(255,255,255,0.22)',
                background: index === 0 ? (action.key === 'merge' ? 'var(--color-merge)' : '#F0EFF4') : 'transparent',
                color: index === 0 ? '#14141C' : 'var(--color-text)',
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
