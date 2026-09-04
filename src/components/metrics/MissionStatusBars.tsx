/* MissionStatusBars — mini horizontal bars representing mission counts by status */

import { barStatusColors } from '../agents/missionStatusColors';

export interface MissionStatusBarsProps {
  done: number;
  running: number;
  review: number;
  queued?: number;
}

export function MissionStatusBars({
  done,
  running,
  review,
  queued = 0,
}: MissionStatusBarsProps) {
  const total = done + running + review + queued;

  if (total === 0) {
    return (
      <div
        style={{
          display: 'flex',
          gap: 3,
          height: 4,
          width: '100%',
          marginTop: 4,
        }}
      >
        <div
          style={{
            flex: 1,
            borderRadius: 2,
            background: 'rgba(255,255,255,0.10)',
          }}
        />
      </div>
    );
  }

  const segments: Array<{ key: string; count: number; color: string }> = [
    { key: 'running', count: running, color: barStatusColors['running'] as string },
    { key: 'review', count: review, color: barStatusColors['review'] as string },
    { key: 'done', count: done, color: barStatusColors['done'] as string },
    { key: 'queued', count: queued, color: barStatusColors['queued'] as string },
  ].filter((s) => s.count > 0);

  return (
    <div
      style={{
        display: 'flex',
        gap: 2,
        height: 4,
        width: '100%',
        marginTop: 4,
      }}
    >
      {segments.map(({ key, count, color }) => (
        <div
          key={key}
          style={{
            flex: count,
            borderRadius: 2,
            background: color,
            minWidth: 4,
          }}
        />
      ))}
    </div>
  );
}
