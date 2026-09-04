/* MissionCalendar — weekly grid calendar view, anchored on the real current date.

   Missions are placed on the day derived from the best real timestamp we
   have for them (plan-compiler creation time, judge verdict time, or last
   loop run). Mission does not carry a generic "createdAt" field yet, so a
   mission with none of those signals falls back to today — the only date
   we can honestly claim for it (it exists right now; we just don't know
   when it actually started).
*/

import type { Mission, MissionStatus } from '../../lib/agents/types';
import { useI18n } from '../../i18n';
import { EmptyState } from '../ui';
import { calendarStatusColors } from './missionStatusColors';

interface MissionCalendarProps {
  missions: Mission[];
  onMissionClick: (id: string) => void;
}

interface Day {
  date: Date;
  dayLabel: string;
  dateNum: number;
  isToday: boolean;
}

const LEGEND_STATUSES: MissionStatus[] = ['queued', 'running', 'review', 'done'];

// ── Real-date helpers ───────────────────────────────────────────────

/**
 * Best real timestamp we have for when a mission started. There is no
 * generic `createdAt`/`startedAt` on Mission yet — we use the earliest
 * real signal available: the plan compiler's timestamp, the judge
 * verdict time, or the last loop iteration. Returns null when none of
 * those exist yet (e.g. a mission still queued, never compiled).
 */
function missionTimestampMs(mission: Mission): number | null {
  const candidates = [
    mission.compiledPlan?.createdAt,
    mission.judgeVerdict?.createdAt,
    mission.loopConfig?.lastRunAt,
  ];
  for (const iso of candidates) {
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date: Date): Date {
  const d = startOfDay(date);
  const dow = d.getDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diffToMonday);
  return d;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Real Mon–Sun week containing `today`, with localized weekday labels. */
function buildWeek(today: Date, locale: string): Day[] {
  const weekStart = startOfWeek(today);
  const weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    const raw = weekdayFmt.format(d).replace(/\.$/, '');
    return {
      date: d,
      dayLabel: raw.charAt(0).toUpperCase() + raw.slice(1),
      dateNum: d.getDate(),
      isToday: isSameDay(d, today),
    };
  });
}

export function MissionCalendar({ missions, onMissionClick }: MissionCalendarProps) {
  const { t, locale } = useI18n();
  const today = new Date();
  const days = buildWeek(today, locale);

  if (missions.length === 0) {
    return (
      <div
        data-testid="agents-calendar"
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <EmptyState icon="⬡" title={t('agents.board.emptyTitle')} subtitle={t('agents.board.emptySubtitle')} />
      </div>
    );
  }

  return (
    <div data-testid="agents-calendar" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 8,
        }}
      >
        {days.map((day) => {
          const dayMissions = missions.filter((m) => {
            const ms = missionTimestampMs(m);
            // Honest fallback: with no recorded start time, the only date we
            // actually know about this mission is "it exists right now".
            const missionDate = ms !== null ? new Date(ms) : today;
            return isSameDay(missionDate, day.date);
          });

          return (
            <div
              key={day.date.toISOString()}
              style={{
                background: day.isToday ? 'rgba(124,92,255,0.08)' : '#16161D',
                border: day.isToday
                  ? '1px solid rgba(124,92,255,0.30)'
                  : '1px solid rgba(255,255,255,0.06)',
                borderRadius: 10,
                padding: '10px 8px',
                minHeight: 120,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              {/* Day header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: day.isToday ? '#C4B5FD' : 'rgba(255,255,255,0.4)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  {day.dayLabel}
                </span>
                <span
                  style={{
                    width: 22,
                    height: 22,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '50%',
                    background: day.isToday ? '#7C5CFF' : 'transparent',
                    color: day.isToday ? '#fff' : 'rgba(255,255,255,0.55)',
                    fontSize: 12,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {day.dateNum}
                </span>
                {day.isToday && (
                  <span
                    style={{
                      fontSize: 9,
                      color: '#C4B5FD',
                      fontWeight: 600,
                      letterSpacing: '0.05em',
                    }}
                  >
                    {t('home.today')}
                  </span>
                )}
              </div>

              {/* Mission chips */}
              {dayMissions.map((m) => {
                const colors = calendarStatusColors[m.status];
                return (
                  <button
                    key={m.id}
                    onClick={() => onMissionClick(m.id)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      background: colors.bg,
                      color: colors.text,
                      border: 'none',
                      borderRadius: 5,
                      padding: '4px 7px',
                      fontSize: 11,
                      fontWeight: 500,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={m.title}
                  >
                    <span
                      style={{
                        fontSize: 9,
                        opacity: 0.7,
                        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                        marginRight: 4,
                      }}
                    >
                      {m.id}
                    </span>
                    {m.title}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, paddingTop: 4 }}>
        {LEGEND_STATUSES.map((status) => {
          const colors = calendarStatusColors[status];
          return (
            <div key={status} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: colors.bg,
                  border: `1px solid ${colors.text}40`,
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{t(`agents.status.${status}`)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
