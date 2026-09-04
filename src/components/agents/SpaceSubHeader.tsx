/* SpaceSubHeader — header bar for the Agents space (view selector + actions) */

import { useI18n } from '../../i18n';

export type ViewId = 'kanban' | 'liste' | 'calendrier' | 'timeline' | 'inbox' | 'feed' | 'briefing' | 'roster' | 'agent-timeline';
export type SpaceTab = 'mission-control' | 'bibliotheque';

interface SpaceSubHeaderProps {
  activeView: ViewId;
  onViewChange: (v: ViewId) => void;
  onNewMission: () => void;
  activeTab?: SpaceTab;
  onTabChange?: (tab: SpaceTab) => void;
  activeCount: number;
}

const VIEW_IDS: ViewId[] = ['kanban', 'liste', 'calendrier', 'timeline', 'inbox', 'feed', 'briefing', 'roster', 'agent-timeline'];

export function SpaceSubHeader({
  activeView,
  onViewChange,
  onNewMission,
  activeTab = 'mission-control',
  onTabChange,
  activeCount,
}: SpaceSubHeaderProps) {
  const { t } = useI18n();

  return (
    <div
      style={{
        flexShrink: 0,
        background: '#0E0E12',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      {/* Top row: title + main tab switch + actions */}
      <div
        style={{
          height: 48,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 20px',
          gap: 12,
        }}
      >
        {/* Left: title */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 130 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: '#E2E2F0',
              letterSpacing: '0.01em',
              lineHeight: 1,
            }}
          >
            {activeTab === 'bibliotheque' ? t('agents.subheader.library') : t('agents.subheader.missionControl')}
          </span>
          <span
            style={{
              fontSize: 10,
              color: 'rgba(255,255,255,0.38)',
              letterSpacing: '0.02em',
              lineHeight: 1,
            }}
          >
            {activeTab === 'bibliotheque' ? t('agents.subheader.librarySub') : t('agents.subheader.missionControlSub')}
          </span>
        </div>

        {/* Center: main tab switch */}
        <div
          style={{
            display: 'flex',
            background: '#16161D',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.08)',
            padding: 2,
            gap: 2,
          }}
        >
          {([
            { id: 'mission-control' as SpaceTab, labelKey: 'agents.subheader.missionControl' },
            { id: 'bibliotheque' as SpaceTab, labelKey: 'agents.subheader.library' },
          ]).map(({ id, labelKey }) => (
            <button
              key={id}
              data-testid={`tab-${id}`}
              onClick={() => onTabChange?.(id)}
              style={{
                padding: '4px 14px',
                borderRadius: 6,
                border: 'none',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 500,
                fontFamily: 'inherit',
                lineHeight: 1.4,
                transition: 'background 0.15s, color 0.15s',
                background: activeTab === id ? '#7C5CFF' : 'transparent',
                color: activeTab === id ? '#fff' : 'rgba(255,255,255,0.5)',
                whiteSpace: 'nowrap',
              }}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>

        {/* Right: live chip + action button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 160, justifyContent: 'flex-end' }}>
          {activeTab === 'mission-control' && (
            <>
              {activeCount > 0 && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 10px',
                    borderRadius: 20,
                    background: 'rgba(34,197,94,0.10)',
                    border: '1px solid rgba(34,197,94,0.22)',
                  }}
                >
                  <span className="agent-live-dot" style={{ background: '#22C55E' }} />
                  <span style={{ fontSize: 11, color: '#4ADE80', fontWeight: 500, whiteSpace: 'nowrap' }}>
                    {t('agents.subheader.liveChip', { count: activeCount })}
                  </span>
                </div>
              )}
              <button
                onClick={onNewMission}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 14px',
                  borderRadius: 7,
                  border: 'none',
                  cursor: 'pointer',
                  background: '#7C5CFF',
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('agents.subheader.newMission')}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Second row: mission control view tabs (only in mission-control tab) */}
      {activeTab === 'mission-control' && (
        <div
          style={{
            display: 'flex',
            padding: '0 20px',
            gap: 2,
            height: 34,
            alignItems: 'flex-end',
          }}
        >
          {VIEW_IDS.map((id) => (
            <button
              key={id}
              onClick={() => onViewChange(id)}
              style={{
                padding: '5px 12px',
                background: 'none',
                border: 'none',
                borderBottom: activeView === id ? '2px solid #7C5CFF' : '2px solid transparent',
                color: activeView === id ? '#C4B5FD' : 'rgba(255,255,255,0.4)',
                fontSize: 12,
                fontWeight: activeView === id ? 600 : 400,
                fontFamily: 'inherit',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'color 0.15s',
              }}
            >
              {t(`agents.subheader.view.${id}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
