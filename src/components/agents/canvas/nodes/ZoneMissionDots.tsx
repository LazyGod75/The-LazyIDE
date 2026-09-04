/* ZoneMissionDots.tsx — feat/always-visible-agents: persistent per-mission
   status dots for a project zone (spec: "every agent must have a
   persistent visual presence at EVERY zoom level, including on collapsed
   zones" — David's own 17%-zoom screenshot showed a zone reduced to
   aggregate counts only, ZERO individual missions visible).

   Extracted from ProjectGroupNode.tsx (already at this repo's 800-line file
   cap) rather than inlined there. Pure/memoized, no per-dot React state —
   each dot is a plain styled <span>, liveness-derived color/pulse class
   only (the SAME `canvas-dot-running-pulse` class MissionNode.tsx's own
   chip tier already uses), so this stays cheap with 30+ missions in one
   zone: re-render only happens when the zone's `missions` array actually
   changes (reconcilerZones.ts's `stableData` referential-stability guard).

   Capped at {@link MAX_VISIBLE_DOTS} + a "+N" overflow chip (never a
   silent drop — same "honest disclosure" convention as
   ProjectGroupNode.tsx's own ZoneChipFoldBadge).
*/

import { memo } from 'react';
import { useI18n } from '../../../../i18n';
import type { ZoneMissionDot } from '../canvasTypes';
import { deriveMissionLiveness, statusAccentColor } from '../chrome/nodeChrome';

/** Visual cap (task brief: "capped visually, e.g. wrap rows, max ~40 dots
 *  then a +N overflow chip") — a zone with more concurrent missions than
 *  this is not a realistic fleet size; the overflow chip discloses the
 *  rest honestly rather than rendering an unbounded, unreadable grid. */
const MAX_VISIBLE_DOTS = 40;

interface ZoneMissionDotsProps {
  missions: readonly ZoneMissionDot[];
  /** Focuses the canvas camera on this mission/loop node (CanvasView.tsx's
   *  `fitView` idiom) — never opens MissionDetail (that stays
   *  `onOpenMission`'s job, unrelated to this strip). */
  onFocusNode: (ref: string) => void;
}

/** One status dot — a plain colored circle, pulsing while `running` (reuses
 *  the existing running-ring CSS rather than a new animation). Hover title
 *  is "title — status" (MissionNode.tsx's own `buildNodeTooltip` word order,
 *  same `agents.status.<status>` i18n key it already uses — no new i18n
 *  key needed for either half of this tooltip). */
function MissionDot({ mission, onFocusNode }: { mission: ZoneMissionDot; onFocusNode: (ref: string) => void }) {
  const { t } = useI18n();
  const liveness = deriveMissionLiveness({ status: mission.status, paused: mission.paused });
  return (
    <span
      data-testid={`zone-mission-dot-${mission.missionId}`}
      className={`nodrag${liveness === 'running' ? ' canvas-dot-running-pulse' : ''}`}
      title={`${mission.title} — ${t(`agents.status.${mission.status}`)}`}
      onClick={(e) => {
        e.stopPropagation();
        onFocusNode(mission.ref);
      }}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: statusAccentColor(liveness),
        cursor: 'pointer',
        flexShrink: 0,
        // ZoneAggregateSummary's own floating chip sets `pointerEvents:
        // 'none'` on its whole container (so it never blocks a drag/click
        // meant for the zone underneath) — each dot opts back IN so it
        // stays clickable there too.
        pointerEvents: 'auto',
      }}
    />
  );
}

export const ZoneMissionDots = memo(function ZoneMissionDots({ missions, onFocusNode }: ZoneMissionDotsProps) {
  if (missions.length === 0) return null;
  const visible = missions.slice(0, MAX_VISIBLE_DOTS);
  const overflow = missions.length - visible.length;

  return (
    <div
      data-testid="zone-mission-dots"
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, padding: '2px 0', minWidth: 0 }}
    >
      {visible.map((mission) => (
        <MissionDot key={mission.missionId} mission={mission} onFocusNode={onFocusNode} />
      ))}
      {overflow > 0 && (
        <span
          data-testid="zone-mission-dots-overflow"
          style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)', flexShrink: 0 }}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
});
