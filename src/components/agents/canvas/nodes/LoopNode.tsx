/* LoopNode.tsx — recurring mission card (spec §4.2): loop glyph + cadence
   label, live next-run countdown, iteration count, enabled toggle, and up
   to 3 recent-iteration mini-chips.

   Same pure-card / RF-wrapper split as MissionNode: `LoopNodeCard` takes
   an explicit `nowMs` prop (no internal timer) so the countdown math is
   directly assertable in a test without fake timers; `LoopNode` (the
   React Flow-registered component) owns the single `setInterval(1000)`
   that ticks `nowMs`, cleaned up on unmount.

   W-CARDS (founder, 2026-07-21) — the old three-level semantic zoom (dot
   glyph / title+cadence-only compact / full) is retired: this card renders
   its ONE full layout (countdown, enabled toggle, iteration count + chips)
   at every zoom, scaled naturally by React Flow's own viewport transform,
   same convention as MissionNode.tsx. `zoomLevel` stays accepted on
   `LoopNodeCardProps` for call-site compatibility but no longer read.
*/

import { memo, useEffect, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { LoopIterationChip, LoopNodeData } from '../canvasTypes';
import type { LoopCadence } from '../../../../lib/agents/types';
import { useI18n } from '../../../../i18n';
import { humanizeLiveActionParts } from '../../../../lib/agents/liveActionSummary';
import { useCanvasActions } from '../chrome/CanvasActionsContext';
import { useCanvasStore } from '../canvasStore';
import type { CanvasZoomLevel } from '../chrome/useZoomLevel';
import {
  AgentPersonaChip,
  FULL_CARD_MAX_HEIGHT,
  FULL_CARD_WIDTH,
  LiveActionLine,
  NodeCard,
  TypeGlyph,
  buildNodeTooltip,
  deriveMissionLiveness,
  formatCountdown,
  statusAccentColor,
  typeAccentColor,
} from '../chrome/nodeChrome';
import { HoverActionStrip, OpenIcon, PauseIcon, PlayIcon, SkipIcon, type HoverAction } from '../chrome/HoverActionStrip';
import { useConnectionDragHighlight } from '../chrome/connectionDragStore';
import { makeRef } from '../canvasTypes';

// See MissionNode.tsx's MissionFlowNode doc comment for why the
// `& Record<string, unknown>` intersection is needed here.
export type LoopFlowNode = Node<LoopNodeData & Record<string, unknown>, 'loop'>;

const CADENCE_LABELS: Partial<Record<string, string>> = {
  '1m': '1 min',
  '5m': '5 min',
  '15m': '15 min',
  '1h': '1 h',
  '6h': '6 h',
  '1d': '1 j',
};

/** Human cadence label — falls back to the raw cadence string for a
 *  custom/unrecognized value (LoopCadence is `(string & {})`-extensible,
 *  see lib/agents/types.ts). */
export function cadenceLabel(cadence: LoopCadence): string {
  return CADENCE_LABELS[cadence] ?? cadence;
}

const MAX_VISIBLE_ITERATIONS = 3;

interface LoopNodeCardProps {
  data: LoopNodeData;
  nowMs: number;
  /** W-CARDS — accepted for call-site compatibility (every existing test/
   *  caller) but no longer read: the card always renders its one full
   *  layout regardless of zoom (see this file's own header). */
  zoomLevel?: CanvasZoomLevel;
  selected?: boolean;
}

export function LoopNodeCard({ data, nowMs, selected }: LoopNodeCardProps) {
  const { t } = useI18n();
  const actions = useCanvasActions();
  // W8a deliverable #2 — expand-in-place state (canvasStore prefs, same
  // provider-free direct-read pattern as MissionNodeCard's fold state).
  const expanded = useCanvasStore((s) => s.prefs.expandedLoops?.[data.mission.id] === true);
  const toggleExpandLoop = useCanvasStore((s) => s.toggleExpandLoop);
  const { mission, loopConfig, recentIterations } = data;
  const liveness = deriveMissionLiveness(mission);
  const connectionHighlight = useConnectionDragHighlight(makeRef('loop', mission.id));
  const nextRunMs = loopConfig.nextRunAt ? Date.parse(loopConfig.nextRunAt) : NaN;
  const countdownLabel = Number.isNaN(nextRunMs) ? null : formatCountdown(nextRunMs - nowMs, t);
  const visible = recentIterations.slice(0, MAX_VISIBLE_ITERATIONS);
  const overflow = recentIterations.length - visible.length;

  // W8a deliverable #1 — hover quick-actions.
  const hoverActions: HoverAction[] = [
    { key: 'open', label: t('canvas.contextMenu.open'), icon: <OpenIcon />, onSelect: () => actions.onOpenMission(mission.id) },
    loopConfig.enabled
      ? { key: 'pause', label: t('canvas.contextMenu.pause'), icon: <PauseIcon />, onSelect: () => actions.onToggleLoop(mission.id, false) }
      : { key: 'resume', label: t('canvas.hover.resume'), icon: <PlayIcon />, onSelect: () => actions.onToggleLoop(mission.id, true) },
    { key: 'skip', label: t('canvas.node.skipNextRun'), icon: <SkipIcon />, onSelect: () => actions.onSkipLoopNextRun(mission.id) },
  ];

  return (
    <NodeCard
      liveness={liveness}
      typeAccent={typeAccentColor('loop')}
      error={liveness === 'failed'}
      connectionHighlight={connectionHighlight}
      selected={selected}
      testId={`loop-node-${mission.id}`}
      tooltip={buildNodeTooltip(mission.title, t(`agents.status.${mission.status}`), cadenceLabel(loopConfig.cadence))}
      hoverActions={<HoverActionStrip actions={hoverActions} groupLabel={t('canvas.hover.actions')} />}
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
        {recentIterations.length > 0 && (
          <button
            type="button"
            data-testid={`loop-node-expand-${mission.id}`}
            className="nodrag"
            title={t(expanded ? 'canvas.loop.collapseIterations' : 'canvas.loop.expandIterations')}
            aria-label={t(expanded ? 'canvas.loop.collapseIterations' : 'canvas.loop.expandIterations')}
            aria-expanded={expanded}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              toggleExpandLoop(mission.id);
            }}
            style={{
              width: 16,
              height: 16,
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <svg
              className="canvas-fold-chevron"
              data-open={String(expanded)}
              width={10}
              height={10}
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path d="M3.5 6 8 10.5 12.5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <TypeGlyph kind="loop" color={typeAccentColor('loop')} title="Loop" />
        {mission.agentName && (
          <AgentPersonaChip agentName={mission.agentName} testId={`loop-node-agent-chip-${mission.id}`} />
        )}
        <span
          data-testid="loop-node-title"
          style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {mission.title}
        </span>
        {/* P2 node visual language (cockpit-redesign mockup) — a distinct
            rounded "cadence pill" (loop type-accent tinted) instead of the
            generic grey MetaChip other node kinds use for meta info: the
            loop's recurrence engine is its own visual identity, never
            confusable with a schedule/cron's amber "cron expression" line
            below (ScheduleNode.tsx) or a mission's plain model chip. */}
        <span
          data-testid="loop-node-cadence"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            fontWeight: 600,
            color: typeAccentColor('loop'),
            background: `color-mix(in srgb, ${typeAccentColor('loop')} 14%, transparent)`,
            border: `1px solid color-mix(in srgb, ${typeAccentColor('loop')} 32%, transparent)`,
            borderRadius: 999,
            padding: '1px 8px',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          ⟳ {cadenceLabel(loopConfig.cadence)}
        </span>
      </div>

      {/* P2 node visual language — a running loop iteration always shows a
          monospace verb+target action line with a pulsing live dot, same
          honest-degradation rule as MissionNode's own live-action line:
          a recognized `<Tool>: {json}` liveAction on the loop's own mission
          row renders as verb+detail; otherwise the REAL iteration count
          (loopConfig.iterationCount, never fabricated) stands in as the
          verb alone. */}
      {liveness === 'running' &&
        (() => {
          const liveParts = humanizeLiveActionParts(mission.liveAction);
          const verb = liveParts?.verb ?? t('canvas.node.iterationCount', { count: loopConfig.iterationCount });
          return (
            <LiveActionLine
              testId="loop-node-live-verb"
              verb={verb}
              detail={liveParts?.detail || undefined}
              accentColor={statusAccentColor(liveness)}
            />
          );
        })()}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span data-testid="loop-node-countdown" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-secondary)' }}>
          {countdownLabel ? t('canvas.node.nextRun', { value: countdownLabel }) : t('canvas.node.noNextRun')}
        </span>
        {loopConfig.enabled && countdownLabel && (
          <button
            type="button"
            data-testid="loop-node-skip-next-run"
            className="nodrag"
            title={t('canvas.node.skipNextRun')}
            aria-label={t('canvas.node.skipNextRun')}
            onClick={(e) => {
              e.stopPropagation();
              actions.onSkipLoopNextRun(mission.id);
            }}
            style={{
              flexShrink: 0,
              width: 18,
              height: 18,
              borderRadius: 5,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3.5v9l7-4.5-7-4.5Z" fill="currentColor" />
              <rect x="11.5" y="3.5" width="1.8" height="9" fill="currentColor" />
            </svg>
          </button>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={loopConfig.enabled}
          data-testid="loop-node-toggle"
          className="nodrag"
          onClick={(e) => {
            e.stopPropagation();
            actions.onToggleLoop(mission.id, !loopConfig.enabled);
          }}
          style={{
            flexShrink: 0,
            width: 28,
            height: 16,
            borderRadius: 8,
            border: 'none',
            cursor: 'pointer',
            background: loopConfig.enabled ? 'var(--color-success)' : 'var(--color-panel-3)',
            position: 'relative',
            padding: 0,
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: loopConfig.enabled ? 14 : 2,
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: '#14141C',
              transition: 'left 0.15s ease',
            }}
          />
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span data-testid="loop-node-iteration-count" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-muted)' }}>
          {t('canvas.node.iterationCount', { count: loopConfig.iterationCount })}
        </span>
      </div>

      {visible.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {visible.map((iteration: LoopIterationChip) => (
            <button
              key={iteration.id}
              type="button"
              data-testid={`loop-node-iteration-${iteration.id}`}
              className="nodrag"
              title={`#${iteration.iteration}`}
              onClick={(e) => {
                e.stopPropagation();
                actions.onOpenIteration(iteration.id);
              }}
              style={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                background: statusAccentColor(deriveMissionLiveness({ status: iteration.status, paused: false })),
              }}
            />
          ))}
          {overflow > 0 && (
            <span data-testid="loop-node-iteration-overflow" style={{ fontSize: 10, color: 'var(--color-text-disabled)', fontFamily: 'var(--font-mono)' }}>
              +{overflow}
            </span>
          )}
        </div>
      )}
    </NodeCard>
  );
}

const LOOP_ACCENT = typeAccentColor('loop');
const TARGET_HANDLE_STYLE = { width: 6, height: 16, borderRadius: 2, background: LOOP_ACCENT, border: '2px solid var(--color-panel)' };
const SOURCE_HANDLE_STYLE = { width: 12, height: 12, borderRadius: '50%', background: LOOP_ACCENT, border: '2px solid var(--color-panel)' };

export const LoopNode = memo(function LoopNode({ data, selected }: NodeProps<LoopFlowNode>) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(intervalId);
  }, []);

  return (
    <>
      {/* Chain INTO a loop is rejected at connect-time (spec §7 "loops
          self-schedule") — the target handle still renders so React Flow
          can show the drag-reject affordance instead of having nowhere to
          drop; the actual validation lives in chainEngine.ts (W3). */}
      <Handle type="target" position={Position.Left} style={TARGET_HANDLE_STYLE} />
      <LoopNodeCard data={data} nowMs={nowMs} selected={selected} />
      <Handle type="source" position={Position.Right} style={SOURCE_HANDLE_STYLE} />
    </>
  );
});
