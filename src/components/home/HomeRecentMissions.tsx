/* HomeRecentMissions — clickable feed of recent missions for the Home dashboard.
   Shows the 5 most recent real missions, or an honest empty state.
   Clicking a row navigates to the 'agents' space.
   Complements the "While you were away" section (no duplication).
*/

import { useAppContext } from '../../app/AppContext';
import { useI18n } from '../../i18n';
import type { Mission } from '../../lib/agents/types';

export interface HomeRecentMissionsProps {
  missions: Mission[];
}

const STATUS_COLOR: Record<string, string> = {
  running:   '#FFC76B',
  review:    '#7C5CFF',
  done:      '#66E27A',
  queued:    'rgba(255,255,255,0.30)',
  failed:    '#FF6B6B',
  cancelled: 'rgba(255,255,255,0.20)',
};

// Maps MissionStatus → existing i18n key
const STATUS_KEY: Record<string, string> = {
  running:   'status.running',
  review:    'status.review',
  done:      'status.done',
  queued:    'agents.status.queued',
  failed:    'agents.status.failed',
  cancelled: 'agents.status.cancelled',
};

interface MissionRowProps {
  mission: Mission;
  onClick: () => void;
}

function MissionRow({ mission, onClick }: MissionRowProps) {
  const { t } = useI18n();
  const statusColor = STATUS_COLOR[mission.status] ?? 'rgba(255,255,255,0.3)';
  const statusKey = STATUS_KEY[mission.status] ?? mission.status;

  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        background: 'transparent',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        color: 'inherit',
        transition: 'background 0.15s',
        fontFamily: 'inherit',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-panel-2)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: statusColor,
          flexShrink: 0,
        }}
      />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          fontWeight: 500,
          color: 'var(--color-text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {mission.title}
      </div>
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: statusColor,
          background: `${statusColor}18`,
          borderRadius: 4,
          padding: '2px 7px',
          flexShrink: 0,
        }}
      >
        {t(statusKey)}
      </span>
    </button>
  );
}

export function HomeRecentMissions({ missions }: HomeRecentMissionsProps) {
  const { t } = useI18n();
  const { setActiveSpace } = useAppContext();

  // Most recent real missions first — no demo/mock fallback.
  const displayMissions = missions.slice(-5).toReversed();

  return (
    <section>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <h2
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.3)',
            margin: 0,
          }}
        >
          {t('home.recentMissions.title')}
        </h2>
        <button
          onClick={() => setActiveSpace('agents')}
          style={{
            fontSize: 11,
            color: 'rgba(124,92,255,0.8)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            fontFamily: 'inherit',
          }}
        >
          {t('home.recentMissions.viewAll')}
        </button>
      </div>
      {displayMissions.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {displayMissions.map((mission) => (
            <MissionRow
              key={mission.id}
              mission={mission}
              onClick={() => setActiveSpace('agents')}
            />
          ))}
        </div>
      ) : (
        <div
          style={{
            padding: '16px 12px',
            border: '1px dashed rgba(255,255,255,0.1)',
            borderRadius: 8,
            fontSize: 12,
            color: 'rgba(255,255,255,0.25)',
            fontStyle: 'italic',
            textAlign: 'center',
          }}
        >
          {t('home.recentMissions.empty')}
        </div>
      )}
    </section>
  );
}
