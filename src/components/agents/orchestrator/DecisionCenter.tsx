/* DecisionCenter.tsx — Pending decisions across the fleet (Pillar E2).

   Phantom-badge fix (real user report, 2026-08-14): this used to render
   `orchestrators.filter(status === 'blocked')` — a collection unrelated to
   the Decisions rail badge, which counts `rankUrgentMissions(projects)`
   (permission-blocked / failed / review-ready MISSIONS, cockpitHelpers.ts).
   This codebase has no real 'blocked' ORCHESTRATOR status in practice (see
   cockpitHelpers.ts's classifyUrgent doc comment), so that filter was
   effectively always empty — the badge said "2", this panel said "No
   pending decisions.", and neither number was stale: they were reading two
   different domain models that happened to share a label. Now takes the
   SAME `RankedUrgentMission[]` the badge's count is `.length`-derived from
   (Cockpit.tsx) and renders it with UrgentMissionCard — the exact component
   ProjectRow.tsx's AGENTS zone already uses for this exact data, wired to
   the SAME real onOpenMission/onUrgentAction handlers — so an action taken
   here behaves identically to the same action taken from the canvas.

   Duplicate-heading fix (same report): this used to render its own
   "Decision Center" <h3> directly under CockpitRailPopover's own "DECISIONS"
   title — same redundant-nesting bug FleetMap.tsx already had fixed (see
   that file's header comment: "the popover chrome IS the heading"). No
   heading rendered here at all now.

   Empty-state fix (same report): CockpitLeftRail always mounts this
   directly below GraphRunPanel, which already renders its own honest empty
   state ("No live graph run. Execute a plan via LazyManager to see waves
   here.") when there is nothing live to show. Stacking a SECOND "No pending
   decisions." message under it was redundant, and its own text used to get
   clipped by CockpitRailPopover's fixed sizing (see that file's own doc
   comment) — this renders nothing at all when the list is empty instead of
   a second empty-state line. */

import type { FleetMission } from '../../../lib/agents/fleetMissions';
import type { RankedUrgentMission } from '../cockpit/cockpitHelpers';
import { urgentActionsFor } from '../cockpit/cockpitHelpers';
import { UrgentMissionCard } from '../cockpit/UrgentMissionCard';
import { useI18n } from '../../../i18n';

export interface DecisionCenterProps {
  urgentMissions: RankedUrgentMission[];
  /** Missions whose last merge attempt was blocked (agentsStore.tsx's
   *  ApproveBlockedError) — same set ProjectRow.tsx's `forceApproveIds`
   *  prop reads, so "Merger" offers the same force-merge upgrade here. */
  forceApproveIds: ReadonlySet<string>;
  onOpenMission: (missionId: string) => void;
  onUrgentAction: (mission: FleetMission, actionKey: string) => void;
}

export function DecisionCenter({ urgentMissions, forceApproveIds, onOpenMission, onUrgentAction }: DecisionCenterProps) {
  const { t } = useI18n();

  if (urgentMissions.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {urgentMissions.map(({ mission, kind, rank }) => (
        <UrgentMissionCard
          key={mission.id}
          mission={mission}
          kind={kind}
          rank={rank}
          onOpen={() => onOpenMission(mission.id)}
          actions={urgentActionsFor({ mission, kind, t, forceApprove: forceApproveIds.has(mission.id) })}
          onAction={(actionKey) => onUrgentAction(mission, actionKey)}
        />
      ))}
    </div>
  );
}
