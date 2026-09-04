/* StageGantt.tsx — per-run stage timeline (Agent Canvas W8b, history drawer).

   Pure presentational: given already-derived StageSpan[] rows (see
   ../../../../lib/journal/missionHistory.ts's deriveStageSpans — this
   component never re-derives anything from raw events), renders one
   horizontal Gantt row per run — the primary mission plus up to 3 loop-
   iteration comparisons. The caller (RunHistoryDrawer) decides which rows to
   pass and how to label them; this component only lays out time.

   Reuses STAGE_COLORS from the fleet grid's StageRail (chrome/) VERBATIM —
   read-only import, never redefines the 5-hue mapping — so a mission's Gantt
   bar and its canvas node's metro-line dot always agree on color.

   A span with `endMs: null` is still open (no closing event observed yet) —
   rendered as a bar reaching `nowMs` with a pulsing marker at its live edge,
   via native SVG SMIL <animate> (no CSS dependency on chrome/canvas.css,
   which this wave does not own).
*/

import { memo, useState } from 'react';
import { useI18n } from '../../../../i18n';
import { STAGE_COLORS } from '../chrome/StageRail';
import type { StageSpan } from '../../../../lib/journal/missionHistory';

export interface StageGanttRow {
  id: string;
  label: string;
  spans: readonly StageSpan[];
}

interface StageGanttProps {
  rows: readonly StageGanttRow[];
  /** Injectable for deterministic fixture tests — defaults to Date.now(). */
  nowMs?: number;
  width?: number;
}

const ROW_HEIGHT = 30;
const BAR_HEIGHT = 14;
const LABEL_WIDTH = 92;
const RIGHT_PAD = 12;
const TOP_PAD = 8;
const MERGE_DOT_R = 5;
const LABEL_MAX_CHARS = 13;

/** "40s" / "6min" / "1h20" — only ever formats a REAL derived duration
 *  (endMs ?? nowMs) - startMs, never a placeholder. */
// eslint-disable-next-line react-refresh/only-export-components
export function formatStageDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `${totalMin}min`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins > 0 ? `${hours}h${mins}` : `${hours}h`;
}

/** Earliest span start / latest span end (or `nowMs` for an open span) across
 *  every row — the shared time axis every row's bars are positioned against. */
function computeDomain(rows: readonly StageGanttRow[], nowMs: number): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    for (const span of r.spans) {
      min = Math.min(min, span.startMs);
      max = Math.max(max, span.endMs ?? nowMs);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [0, 1];
  return [min, max];
}

// memo: pure presentational; the drawer memoizes `rows`, so unrelated parent
// re-renders (live mission polling) skip re-rendering the whole SVG.
export const StageGantt = memo(function StageGantt({ rows, nowMs, width = 560 }: StageGanttProps) {
  const { t } = useI18n();
  // Mount-time fallback via a lazy useState initializer (the one render
  // phase where an impure call is allowed) — open spans measure against
  // this instant; their live edge is animated by SMIL, not by re-rendering.
  const [mountNowMs] = useState(() => Date.now());
  const resolvedNowMs = nowMs ?? mountNowMs;
  const hasAnySpan = rows.some((r) => r.spans.length > 0);

  if (rows.length === 0 || !hasAnySpan) {
    return (
      <div style={{ fontSize: 12, color: 'var(--color-text-disabled)', padding: '8px 0' }}>
        {t('canvas.history.ganttEmpty')}
      </div>
    );
  }

  const [domainStart, domainEnd] = computeDomain(rows, resolvedNowMs);
  const chartWidth = Math.max(width - LABEL_WIDTH - RIGHT_PAD, 40);
  const svgHeight = rows.length * ROW_HEIGHT + TOP_PAD;
  const x = (ms: number) => LABEL_WIDTH + ((ms - domainStart) / (domainEnd - domainStart)) * chartWidth;

  return (
    <svg
      data-testid="stage-gantt"
      viewBox={`0 0 ${width} ${svgHeight}`}
      width="100%"
      height={svgHeight}
      role="img"
      aria-label={t('canvas.history.ganttAriaLabel')}
    >
      {rows.map((r, rowIndex) => {
        const rowY = TOP_PAD + rowIndex * ROW_HEIGHT;
        const barY = rowY + (ROW_HEIGHT - BAR_HEIGHT) / 2;
        return (
          <g key={r.id} data-testid={`gantt-row-${r.id}`}>
            <text x={0} y={rowY + ROW_HEIGHT / 2 + 4} fontSize={10.5} fill="var(--color-text-muted)" fontFamily="var(--font-mono)">
              {r.label.length > LABEL_MAX_CHARS ? `${r.label.slice(0, LABEL_MAX_CHARS - 1)}…` : r.label}
            </text>
            {r.spans.map((span, i) => {
              const isMerged = span.endMs !== null && span.endMs === span.startMs;
              const isLive = span.endMs === null;
              const endMs = span.endMs ?? resolvedNowMs;
              const color = STAGE_COLORS[span.stage];
              const x0 = x(span.startMs);
              const durationLabel = formatStageDuration(endMs - span.startMs);
              const testId = `gantt-span-${r.id}-${span.stage}`;

              if (isMerged) {
                return (
                  <circle key={i} data-testid={testId} cx={x0} cy={barY + BAR_HEIGHT / 2} r={MERGE_DOT_R} fill={color}>
                    <title>{`${span.stage} · ${t('canvas.history.ganttMergedAt')}`}</title>
                  </circle>
                );
              }

              const barWidth = Math.max(x(endMs) - x0, 2);
              return (
                <g key={i} data-testid={testId}>
                  <rect x={x0} y={barY} width={barWidth} height={BAR_HEIGHT} rx={3} fill={color} opacity={isLive ? 0.75 : 0.9}>
                    <title>{`${span.stage} · ${durationLabel}`}</title>
                  </rect>
                  {barWidth > 26 && (
                    <text x={x0 + 5} y={barY + BAR_HEIGHT / 2 + 3.5} fontSize={9} fill="var(--color-bg)" fontFamily="var(--font-mono)">
                      {durationLabel}
                    </text>
                  )}
                  {isLive && (
                    <circle data-testid={`gantt-live-pulse-${r.id}`} cx={x0 + barWidth} cy={barY + BAR_HEIGHT / 2} r={4} fill={color}>
                      <animate attributeName="opacity" values="1;0.25;1" dur="1.2s" repeatCount="indefinite" />
                      <animate attributeName="r" values="3;6;3" dur="1.2s" repeatCount="indefinite" />
                    </circle>
                  )}
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
});
