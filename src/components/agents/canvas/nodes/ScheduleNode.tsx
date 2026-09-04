/* ScheduleNode.tsx — agent-template cron trigger (Rust scheduler, spec
   §4.2). Visually DISTINCT from LoopNode on purpose (spec: "two recurrence
   engines, never merged visually") — different glyph (clock vs
   loop-arrows), different accent color (warning amber vs assistant cyan),
   no iteration chips/toggle-switch styling reuse from LoopNode even though
   the layout is structurally similar.

   Same pure-card / RF-wrapper split as LoopNode: `ScheduleNodeCard` takes
   an explicit `nowMs` prop, `ScheduleNode` owns the ticking interval.

   W-CARDS (founder, 2026-07-21) — the old three-level semantic zoom (dot
   glyph / agent-name+cron-only compact / full) is retired: this card
   renders its ONE full layout (countdown/disabled badge included) at every
   zoom, scaled naturally by React Flow's own viewport transform, same
   convention as MissionNode.tsx.
*/

import { memo, useEffect, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { ScheduleNodeData } from '../canvasTypes';
import { useI18n } from '../../../../i18n';
import type { CanvasZoomLevel } from '../chrome/useZoomLevel';
import { FULL_CARD_MAX_HEIGHT, FULL_CARD_WIDTH, MetaChip, NodeCard, TypeGlyph, buildNodeTooltip, formatCountdown, typeAccentColor } from '../chrome/nodeChrome';
import { useConnectionDragHighlight } from '../chrome/connectionDragStore';
import { makeRef } from '../canvasTypes';

const SCHEDULE_ACCENT = typeAccentColor('schedule');

// See MissionNode.tsx's MissionFlowNode doc comment for why the
// `& Record<string, unknown>` intersection is needed here.
export type ScheduleFlowNode = Node<ScheduleNodeData & Record<string, unknown>, 'schedule'>;

interface ScheduleNodeCardProps {
  data: ScheduleNodeData;
  nowMs: number;
  /** W-CARDS — accepted for call-site compatibility (every existing test/
   *  caller) but no longer read: the card always renders its one full
   *  layout regardless of zoom (see this file's own header). */
  zoomLevel?: CanvasZoomLevel;
  selected?: boolean;
}

export function ScheduleNodeCard({ data, nowMs, selected }: ScheduleNodeCardProps) {
  const { t } = useI18n();
  const countdownLabel = data.nextRunMs === undefined ? null : formatCountdown(data.nextRunMs - nowMs, t);
  const connectionHighlight = useConnectionDragHighlight(makeRef('schedule', data.scheduleId));

  return (
    <NodeCard
      typeAccent={SCHEDULE_ACCENT}
      connectionHighlight={connectionHighlight}
      selected={selected}
      faded={!data.enabled}
      testId={`schedule-node-${data.scheduleId}`}
      tooltip={buildNodeTooltip(data.agentName, t(data.enabled ? 'canvas.node.scheduleEnabled' : 'canvas.node.scheduleDisabled'), data.cronLabel)}
      style={{
        padding: '12px 12px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        width: FULL_CARD_WIDTH,
        maxHeight: FULL_CARD_MAX_HEIGHT,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <TypeGlyph kind="schedule" color={SCHEDULE_ACCENT} title="Schedule" />
        <span
          data-testid="schedule-node-agent"
          style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {data.agentName}
        </span>
        {!data.enabled && (
          <MetaChip testId="schedule-node-disabled-badge">{t('canvas.node.scheduleDisabled')}</MetaChip>
        )}
      </div>

      <span data-testid="schedule-node-cron-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-secondary)' }}>
        {data.cronLabel}
      </span>

      {countdownLabel && (
        <span data-testid="schedule-node-countdown" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-muted)' }}>
          {t('canvas.node.nextRun', { value: countdownLabel })}
        </span>
      )}
    </NodeCard>
  );
}

const TARGET_HANDLE_STYLE = { width: 6, height: 16, borderRadius: 2, background: SCHEDULE_ACCENT, border: '2px solid var(--color-panel)' };
const SOURCE_HANDLE_STYLE = { width: 12, height: 12, borderRadius: '50%', background: SCHEDULE_ACCENT, border: '2px solid var(--color-panel)' };

export const ScheduleNode = memo(function ScheduleNode({ data, selected }: NodeProps<ScheduleFlowNode>) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(intervalId);
  }, []);

  return (
    <>
      <Handle type="target" position={Position.Left} style={TARGET_HANDLE_STYLE} />
      <ScheduleNodeCard data={data} nowMs={nowMs} selected={selected} />
      <Handle type="source" position={Position.Right} style={SOURCE_HANDLE_STYLE} />
    </>
  );
});
