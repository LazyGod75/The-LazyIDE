/* MissionTimeline — Gantt view with SVG dependency arrows.

   Rows, bar positions, day headers and dependency arrows are all derived
   from real mission data — there is no hardcoded mission list or fixed
   "Mon 16 .. Sun 22" week anymore. Bar timing comes from the best real
   signal available per mission (see missionTimestampMs / missionEndMs);
   missions with no real timing signal yet get a label-only row instead of
   a fabricated bar.
*/

import { useEffect, useState } from 'react';
import type { Mission, MissionStatus } from '../../lib/agents/types';
import { useI18n } from '../../i18n';
import { EmptyState } from '../ui';

interface MissionTimelineProps {
  missions: Mission[];
  onMissionClick: (id: string) => void;
}

// ── Layout constants (pure presentation, not data) ─────────────────

const LABEL_W = 170;
const ROW_H = 44;
const HEADER_H = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_BAR_WIDTH_PCT = 1.5;

// Chart effective width for arrow/control-point math (chart fills remaining space)
const CHART_W = 800;

const GANTT_BAR_COLORS: Record<MissionStatus, string> = {
  running: '#7C5CFF',
  review: '#FBB924',
  done: 'rgba(34,197,94,0.6)',
  queued: 'rgba(255,255,255,0.15)',
  failed: 'rgba(248,113,113,0.5)',
  cancelled: 'rgba(255,255,255,0.08)',
};

// ── Real-time helpers ────────────────────────────────────────────────

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

/** Real end time: start + real run duration, or "now" while still running. */
function missionEndMs(mission: Mission, startMs: number, nowMs: number): number {
  if (mission.agentMetrics && mission.agentMetrics.durationMs > 0) {
    return startMs + mission.agentMetrics.durationMs;
  }
  if (mission.status === 'running') {
    return Math.max(nowMs, startMs);
  }
  return startMs;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

interface Domain {
  start: number;
  end: number;
}

/** Day-aligned span covering every mission's real start..end, plus "now". */
function computeDomain(missions: Mission[], nowMs: number): Domain {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const m of missions) {
    const s = missionTimestampMs(m);
    if (s === null) continue;
    starts.push(s);
    ends.push(missionEndMs(m, s, nowMs));
  }
  if (starts.length === 0) {
    // No mission has any real timing signal yet — anchor on today alone.
    const dayStart = startOfDay(nowMs);
    return { start: dayStart, end: dayStart + DAY_MS };
  }
  const domainStart = startOfDay(Math.min(...starts));
  let domainEnd = startOfDay(Math.max(...ends, nowMs)) + DAY_MS;
  if (domainEnd <= domainStart) domainEnd = domainStart + DAY_MS;
  return { start: domainStart, end: domainEnd };
}

function buildDayHeaders(domain: Domain, locale: string): Array<{ label: string; pct: number }> {
  const span = domain.end - domain.start;
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric' });
  const headers: Array<{ label: string; pct: number }> = [];
  for (let cur = domain.start; cur < domain.end; cur += DAY_MS) {
    const raw = fmt.format(new Date(cur));
    headers.push({
      label: raw.charAt(0).toUpperCase() + raw.slice(1),
      pct: ((cur - domain.start) / span) * 100,
    });
  }
  return headers;
}

// ── Row + arrow construction (real missions only) ───────────────────

interface GanttRow {
  mission: Mission;
  barStartPct?: number;
  barWidthPct?: number;
}

/** One row per real mission, sorted by real start time. Missions with no
    real timing signal yet get a label-only row (no bar) at the end. */
function buildRows(missions: Mission[], domain: Domain, nowMs: number): GanttRow[] {
  const span = Math.max(domain.end - domain.start, 1);
  const timed: GanttRow[] = [];
  const untimed: GanttRow[] = [];

  for (const mission of missions) {
    const startMs = missionTimestampMs(mission);
    if (startMs === null) {
      untimed.push({ mission });
      continue;
    }
    const endMs = Math.max(missionEndMs(mission, startMs, nowMs), startMs);
    const startPct = clamp(((startMs - domain.start) / span) * 100, 0, 100);
    const rawWidthPct = ((endMs - startMs) / span) * 100;
    // Floor the rendered width so very short/instant runs stay visible —
    // a presentational minimum only, not a claim about real duration.
    const widthPct = Math.min(Math.max(rawWidthPct, MIN_BAR_WIDTH_PCT), 100 - startPct);
    timed.push({ mission, barStartPct: startPct, barWidthPct: widthPct });
  }

  timed.sort((a, b) => (missionTimestampMs(a.mission) ?? 0) - (missionTimestampMs(b.mission) ?? 0));
  return [...timed, ...untimed];
}

interface Arrow {
  x1: number; y1: number;
  x2: number; y2: number;
}

function rowCenterY(index: number): number {
  return HEADER_H + index * ROW_H + ROW_H / 2;
}

/** Dependency arrows from the real `Mission.dependsOn` field — renders
    nothing until something actually populates that field for live
    missions (no hardcoded M3→M4-style fixtures). */
function buildArrows(rows: GanttRow[]): Arrow[] {
  const indexById = new Map<string, number>();
  rows.forEach((r, i) => indexById.set(r.mission.id, i));

  const arrows: Arrow[] = [];
  rows.forEach((row, toIdx) => {
    if (row.barStartPct === undefined) return;
    for (const depId of row.mission.dependsOn ?? []) {
      const fromIdx = indexById.get(depId);
      if (fromIdx === undefined) continue;
      const fromRow = rows[fromIdx];
      if (fromRow.barStartPct === undefined || fromRow.barWidthPct === undefined) continue;

      const x1 = ((fromRow.barStartPct + fromRow.barWidthPct) / 100) * CHART_W;
      const x2 = (row.barStartPct / 100) * CHART_W;
      arrows.push({ x1, y1: rowCenterY(fromIdx), x2, y2: rowCenterY(toIdx) });
    }
  });
  return arrows;
}

function totalSvgHeight(rowCount: number): number {
  return HEADER_H + rowCount * ROW_H;
}

// ── Main component ─────────────────────────────────────────────────

type GroupMode = 'time' | 'project' | 'agent';

export function MissionTimeline({ missions, onMissionClick }: MissionTimelineProps) {
  const { t, locale } = useI18n();

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [groupMode, setGroupMode] = useState<GroupMode>('time');

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (missions.length === 0) {
    return (
      <div
        data-testid="agents-timeline"
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <EmptyState icon="⬡" title={t('agents.board.emptyTitle')} subtitle={t('agents.board.emptySubtitle')} />
      </div>
    );
  }

  const domain = computeDomain(missions, nowMs);
  const allRows = buildRows(missions, domain, nowMs);

  // Group rows by project or agent when those modes are active
  const groupKey = (m: Mission): string => {
    if (groupMode === 'project') return m.worktree || m.model || 'default';
    if (groupMode === 'agent') return m.agentName || m.model || 'default';
    return '';
  };

  const groups: Array<{ label: string; rows: GanttRow[] }> = [];
  if (groupMode === 'time') {
    groups.push({ label: '', rows: allRows });
  } else {
    const map = new Map<string, GanttRow[]>();
    for (const row of allRows) {
      const key = groupKey(row.mission);
      const arr = map.get(key);
      if (arr) arr.push(row);
      else map.set(key, [row]);
    }
    for (const [label, rows] of map) {
      groups.push({ label, rows });
    }
    groups.sort((a, b) => a.label.localeCompare(b.label));
  }

  // Flatten groups into a single row list for arrow/height math, but
  // inject group header rows as separators.
  const flatRows: Array<{ type: 'header'; label: string } | { type: 'row'; row: GanttRow; globalIdx: number }> = [];
  let globalIdx = 0;
  for (const g of groups) {
    if (groupMode !== 'time') {
      flatRows.push({ type: 'header', label: g.label });
    }
    for (const row of g.rows) {
      flatRows.push({ type: 'row', row, globalIdx });
      globalIdx++;
    }
  }

  const arrows = buildArrows(allRows);
  const dayHeaders = buildDayHeaders(domain, locale);
  const totalSlots = flatRows.length;
  const svgH = totalSvgHeight(totalSlots);
  const nowPct = ((nowMs - domain.start) / (domain.end - domain.start)) * 100;
  const showNowLine = nowPct >= 0 && nowPct <= 100;

  return (
    <div
      data-testid="agents-timeline"
      style={{ padding: '16px 20px', overflowX: 'auto', minWidth: 0 }}
    >
      {/* Group mode toggle */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {(['time', 'project', 'agent'] as const).map((mode) => (
          <button
            key={mode}
            data-testid={`timeline-group-${mode}`}
            onClick={() => setGroupMode(mode)}
            style={{
              padding: '4px 10px',
              borderRadius: 5,
              border: `1px solid ${groupMode === mode ? 'rgba(124,92,255,0.4)' : 'rgba(255,255,255,0.06)'}`,
              background: groupMode === mode ? 'rgba(124,92,255,0.12)' : 'transparent',
              color: groupMode === mode ? '#C4B5FD' : 'rgba(255,255,255,0.35)',
              fontSize: 11,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {t(`timeline.group.${mode}`)}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', minWidth: 700 }}>
        {/* Labels column */}
        <div style={{ width: LABEL_W, flexShrink: 0 }}>
          <div style={{ height: HEADER_H }} />
          {flatRows.map((entry, idx) => {
            if (entry.type === 'header') {
              return (
                <div
                  key={`hdr-${idx}`}
                  style={{
                    height: ROW_H,
                    display: 'flex',
                    alignItems: 'center',
                    paddingRight: 10,
                    borderTop: '1px solid rgba(124,92,255,0.15)',
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: '#7C5CFF',
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {entry.label}
                  </span>
                </div>
              );
            }
            const { row } = entry;
            return (
              <div
                key={row.mission.id}
                style={{
                  height: ROW_H,
                  display: 'flex',
                  alignItems: 'center',
                  paddingRight: 10,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    color: 'rgba(255,255,255,0.65)',
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    cursor: 'pointer',
                  }}
                  onClick={() => onMissionClick(row.mission.id)}
                  title={row.mission.title}
                >
                  {row.mission.id} · {row.mission.title}
                </span>
              </div>
            );
          })}
        </div>

        {/* Chart area */}
        <div style={{ flex: 1, position: 'relative' }}>
          {/* Day headers */}
          <div
            style={{
              height: HEADER_H,
              position: 'relative',
              borderBottom: '1px solid rgba(255,255,255,0.07)',
              marginBottom: 0,
            }}
          >
            {dayHeaders.map(({ label, pct }) => (
              <span
                key={`${label}-${pct}`}
                style={{
                  position: 'absolute',
                  left: `${pct}%`,
                  top: 6,
                  fontSize: 10,
                  color: 'rgba(255,255,255,0.3)',
                  transform: 'translateX(-50%)',
                  whiteSpace: 'nowrap',
                  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                }}
              >
                {label}
              </span>
            ))}
          </div>

          {/* Row backgrounds + bars */}
          <div style={{ position: 'relative' }}>
            {flatRows.map((entry, idx) => {
              if (entry.type === 'header') {
                return (
                  <div
                    key={`hdr-chart-${idx}`}
                    style={{
                      height: ROW_H,
                      position: 'relative',
                      borderTop: '1px solid rgba(124,92,255,0.15)',
                      display: 'flex',
                      alignItems: 'center',
                    }}
                  >
                    {dayHeaders.map(({ pct, label }) => (
                      <div
                        key={`${label}-${pct}`}
                        style={{
                          position: 'absolute',
                          left: `${pct}%`,
                          top: 0,
                          bottom: 0,
                          width: 1,
                          background: 'rgba(255,255,255,0.04)',
                        }}
                      />
                    ))}
                  </div>
                );
              }
              const { row, globalIdx } = entry;
              return (
                <div
                  key={row.mission.id}
                  style={{
                    height: ROW_H,
                    position: 'relative',
                    background: globalIdx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  {/* Grid lines */}
                  {dayHeaders.map(({ pct, label }) => (
                    <div
                      key={`${label}-${pct}`}
                      style={{
                        position: 'absolute',
                        left: `${pct}%`,
                        top: 0,
                        bottom: 0,
                        width: 1,
                        background: 'rgba(255,255,255,0.04)',
                      }}
                    />
                  ))}

                  {/* Mission bar */}
                  {row.barStartPct !== undefined && row.barWidthPct !== undefined && (
                    <div
                      data-testid={`gantt-bar-${row.mission.id}`}
                      onClick={() => onMissionClick(row.mission.id)}
                      style={{
                        position: 'absolute',
                        left: `${row.barStartPct}%`,
                        width: `${row.barWidthPct}%`,
                        height: 18,
                        background: GANTT_BAR_COLORS[row.mission.status],
                        borderRadius: 4,
                        cursor: 'pointer',
                      }}
                      title={`${row.mission.id} · ${row.mission.title}`}
                    />
                  )}
                </div>
              );
            })}

            {/* "Now" line — drawn only when "now" actually falls within the visible range */}
            {showNowLine && (
              <div
                style={{
                  position: 'absolute',
                  left: `${nowPct}%`,
                  top: 0,
                  bottom: 0,
                  width: 1,
                  background: 'rgba(248,113,113,0.55)',
                  pointerEvents: 'none',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 4,
                    left: 4,
                    fontSize: 9,
                    color: '#F87171',
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                  }}
                >
                  maintenant
                </span>
              </div>
            )}

            {/* SVG overlay for dependency arrows */}
            <svg
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: svgH - HEADER_H,
                pointerEvents: 'none',
                overflow: 'visible',
              }}
              viewBox={`0 0 ${CHART_W} ${svgH - HEADER_H}`}
              preserveAspectRatio="none"
            >
              <defs>
                <marker
                  id="arrow-violet"
                  markerWidth="6"
                  markerHeight="6"
                  refX="3"
                  refY="3"
                  orient="auto"
                >
                  <path d="M0,0 L6,3 L0,6 Z" fill="#7C5CFF" />
                </marker>
              </defs>
              {arrows.map((a, i) => {
                const cx1 = a.x1 + Math.abs(a.x2 - a.x1) * 0.4;
                const cx2 = a.x2 - Math.abs(a.x2 - a.x1) * 0.4;
                const y1adj = a.y1 - HEADER_H;
                const y2adj = a.y2 - HEADER_H;
                return (
                  <path
                    key={i}
                    d={`M ${a.x1} ${y1adj} C ${cx1} ${y1adj}, ${cx2} ${y2adj}, ${a.x2} ${y2adj}`}
                    stroke="#7C5CFF"
                    strokeWidth="1.5"
                    strokeDasharray="4 3"
                    fill="none"
                    opacity="0.7"
                    markerEnd="url(#arrow-violet)"
                  />
                );
              })}
            </svg>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, marginTop: 16, flexWrap: 'wrap' }}>
        {([
          { color: '#7C5CFF', statusKey: 'running' as const },
          { color: '#FBB924', statusKey: 'review' as const },
          { color: 'rgba(34,197,94,0.6)', statusKey: 'done' as const },
          { color: 'rgba(255,255,255,0.15)', statusKey: 'queued' as const },
        ] as const).map(({ color, statusKey }) => (
          <div key={statusKey} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 14, height: 6, borderRadius: 3, background: color }} />
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{t(`agents.status.${statusKey}`)}</span>
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div
            style={{
              width: 14,
              height: 1,
              background: '#7C5CFF',
              borderTop: '1px dashed #7C5CFF',
            }}
          />
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{t('timeline.legend.dependency')}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div style={{ width: 2, height: 12, background: 'rgba(248,113,113,0.55)' }} />
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{t('timeline.legend.now')}</span>
        </div>
      </div>
    </div>
  );
}
