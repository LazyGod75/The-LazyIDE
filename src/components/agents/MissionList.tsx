/* MissionList — table view of all missions */

import type { Mission, MissionStatus } from '../../lib/agents/types';
import { useI18n } from '../../i18n';

interface MissionListProps {
  missions: Mission[];
  onMissionClick: (id: string) => void;
}

const STATUS_BG: Record<MissionStatus, string> = {
  queued: 'rgba(255,255,255,0.07)',
  running: 'rgba(124,92,255,0.15)',
  review: 'rgba(251,185,36,0.12)',
  done: 'rgba(34,197,94,0.10)',
  failed: 'rgba(239,68,68,0.10)',
  cancelled: 'rgba(255,255,255,0.04)',
};

const STATUS_COLOR: Record<MissionStatus, string> = {
  queued: 'rgba(255,255,255,0.45)',
  running: '#C4B5FD',
  review: '#FBB924',
  done: '#4ADE80',
  failed: '#F87171',
  cancelled: 'rgba(255,255,255,0.3)',
};

function StatusPill({ status }: { status: MissionStatus }) {
  const { t } = useI18n();
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 5,
        background: STATUS_BG[status],
        color: STATUS_COLOR[status],
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {status === 'running' && <span className="agent-live-dot" style={{ width: 6, height: 6 }} />}
      {t(`agents.status.${status}`)}
    </span>
  );
}

function MiniProgress({ value }: { value: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div className="agent-progress-track" style={{ width: 60 }}>
        <div className="agent-progress-bar" style={{ width: `${value}%` }} />
      </div>
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', width: 28 }}>{value}%</span>
    </div>
  );
}

export function MissionList({ missions, onMissionClick }: MissionListProps) {
  const { t } = useI18n();
  const HEADERS = [
    t('agents.list.colMission'),
    t('agents.list.colStatus'),
    t('agents.list.colModel'),
    t('agents.list.colWorktree'),
    t('agents.list.colCost'),
    t('agents.list.colProgress'),
    t('agents.list.colDependsOn'),
  ];

  return (
    <div style={{ padding: '16px 20px', overflowX: 'auto' }}>
      <table
        style={{
          width: '100%',
          borderCollapse: 'separate',
          borderSpacing: 0,
          minWidth: 780,
        }}
      >
        <thead>
          <tr>
            {HEADERS.map((h) => (
              <th
                key={h}
                style={{
                  textAlign: 'left',
                  padding: '6px 12px 10px',
                  fontSize: 10,
                  fontWeight: 700,
                  color: 'rgba(255,255,255,0.35)',
                  letterSpacing: '0.07em',
                  textTransform: 'uppercase',
                  borderBottom: '1px solid rgba(255,255,255,0.07)',
                  whiteSpace: 'nowrap',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {missions.map((m, i) => (
            <tr
              key={m.id}
              onClick={() => onMissionClick(m.id)}
              style={{
                cursor: 'pointer',
                background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(124,92,255,0.05)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLTableRowElement).style.background =
                  i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)';
              }}
            >
              {/* Mission */}
              <td style={cellStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontSize: 10,
                      color: 'rgba(255,255,255,0.3)',
                      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                      minWidth: 24,
                    }}
                  >
                    {m.id}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 500, color: '#E2E2F0' }}>{m.title}</span>
                  {m.loopConfig && (
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 600,
                        color: '#a78bfa',
                        background: 'rgba(124,92,255,0.15)',
                        padding: '1px 5px',
                        borderRadius: 3,
                        fontFamily: "'JetBrains Mono', monospace",
                        whiteSpace: 'nowrap',
                      }}
                    >
                      loop {m.loopConfig.cadence} #{m.loopConfig.iterationCount}
                    </span>
                  )}
                  {m.loopParentId && m.loopIteration && (
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 600,
                        color: '#a78bfa',
                        background: 'rgba(124,92,255,0.15)',
                        padding: '1px 5px',
                        borderRadius: 3,
                        fontFamily: "'JetBrains Mono', monospace",
                        whiteSpace: 'nowrap',
                      }}
                    >
                      iter #{m.loopIteration}
                    </span>
                  )}
                </div>
              </td>
              {/* Statut */}
              <td style={cellStyle}>
                <StatusPill status={m.status} />
              </td>
              {/* Modèle */}
              <td style={cellStyle}>
                <span
                  style={{
                    fontSize: 11,
                    color: m.model ? '#C4B5FD' : 'rgba(255,255,255,0.2)',
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  }}
                >
                  {m.model || '—'}
                </span>
              </td>
              {/* Worktree */}
              <td style={cellStyle}>
                <span
                  style={{
                    fontSize: 11,
                    color: m.worktree ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.18)',
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  }}
                >
                  {m.worktree || '—'}
                </span>
              </td>
              {/* Coût */}
              <td style={cellStyle}>
                <span style={{ fontSize: 12, color: m.cost ? '#E2E2F0' : 'rgba(255,255,255,0.2)' }}>
                  {m.cost || '—'}
                </span>
              </td>
              {/* Progression */}
              <td style={cellStyle}>
                {m.progress !== undefined ? (
                  <MiniProgress value={m.progress} />
                ) : (
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>—</span>
                )}
              </td>
              {/* Dépend de */}
              <td style={cellStyle}>
                {m.dependsOn && m.dependsOn.length > 0 ? (
                  <div style={{ display: 'flex', gap: 4 }}>
                    {m.dependsOn.map((dep) => (
                      <span
                        key={dep}
                        style={{
                          fontSize: 10,
                          color: '#FBB924',
                          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                          background: 'rgba(251,185,36,0.10)',
                          padding: '1px 5px',
                          borderRadius: 3,
                        }}
                      >
                        {dep}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const cellStyle: React.CSSProperties = {
  padding: '9px 12px',
  borderBottom: '1px solid rgba(255,255,255,0.05)',
  verticalAlign: 'middle',
};
