/* MissionBoard — Kanban view with 6 columns, project grouping (T2.2), proof gallery (T2.2) */

import { useState, useCallback } from 'react';
import type { Mission, MissionStatus } from '../../lib/agents/types';
import { MissionCard } from './MissionCard';
import { EmptyState } from '../ui';
import { EmptyStateProposals } from './EmptyStateProposals';
import { useI18n } from '../../i18n';
import { CpuIcon } from '../icons';

interface MissionBoardProps {
  missions: Mission[];
  onMissionClick: (id: string) => void;
  onNewMission?: () => void;
  onMissionDelete?: (id: string) => void;
  onMissionStatusChange?: (id: string, status: MissionStatus) => void;
  onLaunchProposal?: (prompt: string) => void;
}

interface Column {
  status: MissionStatus;
  accentColor: string;
  isRunning?: boolean;
  width: number;
}

const COLUMN_DEFS: Column[] = [
  { status: 'queued', accentColor: 'rgba(255,255,255,0.25)', width: 220 },
  { status: 'running', accentColor: '#7C5CFF', isRunning: true, width: 240 },
  { status: 'review', accentColor: '#FBB924', width: 220 },
  { status: 'done', accentColor: '#22C55E', width: 220 },
  { status: 'failed', accentColor: '#F87171', width: 200 },
  { status: 'cancelled', accentColor: 'rgba(255,255,255,0.2)', width: 200 },
];

export function MissionBoard({ missions, onMissionClick, onNewMission, onMissionDelete, onMissionStatusChange, onLaunchProposal }: MissionBoardProps) {
  const { t } = useI18n();
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<MissionStatus | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, status: MissionStatus) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverCol(status);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, status: MissionStatus) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragId;
    if (id && onMissionStatusChange) {
      onMissionStatusChange(id, status);
    }
    setDragId(null);
    setDragOverCol(null);
  }, [dragId, onMissionStatusChange]);

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDragOverCol(null);
  }, []);

  // Board-wide empty state: no missions at all
  if (missions.length === 0) {
    return (
      <div
        data-testid="agents-board"
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {onLaunchProposal ? (
          <EmptyStateProposals onLaunch={onLaunchProposal} />
        ) : (
          <EmptyState
            icon={CpuIcon}
            title={t('agents.board.emptyTitle')}
            subtitle={t('agents.board.emptySubtitle')}
            action={onNewMission ? { label: t('agents.board.newMission'), onClick: onNewMission } : undefined}
          />
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="agents-board"
      style={{
        display: 'flex',
        flexDirection: 'row',
        gap: 14,
        padding: '16px 20px',
        overflowX: 'auto',
        overflowY: 'hidden',
        minHeight: 0,
        height: '100%',
        alignItems: 'stretch',
      }}
    >
      {COLUMN_DEFS.map((col) => {
        const colMissions = missions.filter((m) => m.status === col.status);
        const isDropTarget = dragOverCol === col.status;
        return (
          <div
            key={col.status}
            onDragOver={(e) => handleDragOver(e, col.status)}
            onDrop={(e) => handleDrop(e, col.status)}
            style={{
              flexShrink: 0,
              width: col.width,
              display: 'flex',
              flexDirection: 'column',
              gap: 0,
              minHeight: 0,
              borderRadius: 8,
              outline: isDropTarget ? `2px dashed ${col.accentColor}` : 'none',
              outlineOffset: -2,
              transition: 'outline 0.15s',
            }}
          >
            {/* Column header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 10,
                padding: '0 2px',
                flexShrink: 0,
              }}
            >
              {col.isRunning && <span className="agent-live-dot" />}
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'rgba(255,255,255,0.55)',
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                }}
              >
                {t(`agents.status.${col.status}`)}
              </span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 18,
                  height: 18,
                  borderRadius: 9,
                  background: col.isRunning ? 'rgba(124,92,255,0.25)' : 'rgba(255,255,255,0.08)',
                  color: col.isRunning ? '#C4B5FD' : 'rgba(255,255,255,0.45)',
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '0 4px',
                }}
              >
                {colMissions.length}
              </span>
            </div>

            {/* Cards */}
            <div
              data-testid={`mission-column-cards-${col.status}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                overflowY: 'auto',
                paddingBottom: 8,
                flex: 1,
                minHeight: 0,
              }}
            >
              {colMissions.map((mission) => (
                <div
                  key={mission.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, mission.id)}
                  onDragEnd={handleDragEnd}
                  style={{ opacity: dragId === mission.id ? 0.4 : 1 }}
                >
                  <MissionCard
                    mission={mission}
                    onClick={() => onMissionClick(mission.id)}
                    onDelete={onMissionDelete ? () => onMissionDelete(mission.id) : undefined}
                  />
                </div>
              ))}
              {colMissions.length === 0 && (
                <div
                  style={{
                    padding: '20px 12px',
                    textAlign: 'center',
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.2)',
                    border: '1px dashed rgba(255,255,255,0.08)',
                    borderRadius: 8,
                  }}
                >
                  {t('agents.board.columnEmpty')}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
