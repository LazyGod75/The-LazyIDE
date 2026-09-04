/* CockpitLeftRail — P1-3 full-bleed redesign: a slim column of ROUND icon
   buttons floating over the canvas' far-left edge (P1-2 already moved this
   off the old permanently-stacked panel block; this wave un-anchors it from
   the 460px right column entirely — see Cockpit.tsx's header comment — and
   floats it directly over <CanvasView>, vertically centered on the left
   edge so it never collides with CanvasView's own top-left CanvasToolbar
   Panel or its bottom-left MiniMap). Clicking an icon opens a
   "mini-parchemin" popover (CockpitRailPopover) anchored to that icon; every
   existing panel component is reused VERBATIM inside a popover — same
   props, same data, nothing re-derived here. Only one popover is ever open
   at a time (a single `openId` state, not one boolean per icon), and it
   closes on outside click / Escape (CockpitRailPopover).

   Content mapping (nothing dropped, from either the pre-P1-2 stacked block
   OR the top Bandeau/CapObjectives bar this same redesign also removes —
   see Cockpit.tsx's header comment):
     - 'report'     -> not a CockpitRailPopover mounted HERE: like the other
                       icons it captures its own screen rect on click, but
                       forwards that rect up through onReportClick so
                       AgentsSpace.tsx (which owns the ProjectReportPage
                       overlay/reportProjectId state) can open ITS OWN
                       CockpitRailPopover anchored to the same icon — see
                       AgentsSpace.tsx's onOpenReport wiring. W-CHROME:
                       replaces AgentsSpace.tsx's old standalone
                       "report-trigger-bar" header row (which hosted only
                       this one button below TopNav) — same destination, same
                       real handler, now a round icon ABOVE 'kpis' instead of
                       its own row.
     - 'kpis'       -> CockpitMeteoLine (the météo greeting + per-project
                       pills Bandeau.tsx used to show in the top bar) +
                       KpiGroup (the 5 real KPI tiles, ALSO formerly in the
                       top Bandeau bar). LiveFeed (recent mission/
                       orchestrator activity) was here too but W-CHROME
                       removed it from this popover per product feedback
                       ("just the KPIs, not the live activity") — LiveFeed
                       itself is NOT deleted (no other mount point today,
                       kept for potential reuse elsewhere).
     - 'fleetMap'   -> FleetMap (multi-project overview)
     - 'objectives' -> CapObjectives (the "CAP — tes objectifs" block,
                       formerly its own full-width band under Bandeau)
     - 'decisions'  -> DecisionCenter + a PlanApprovalPanel per orchestrator
                       currently 'planning' + an OrchestratorTree per
                       orchestrator — same three components, same order, the
                       old block rendered them in
     - 'budget'     -> BudgetBurn (real-time spend vs. limit)

   AutonomySelector is NOT here anymore: the design spec moves autonomy into
   the right manager overlay as a compact control (ManagerAutonomyBar, see
   ManagerOverlay.tsx) — friction F5, "compact autonomy control".

   Founder bug fix (2026-07-22): re-clicking an already-open icon used to
   reopen its popover instead of closing it (see CockpitRailPopover.tsx's own
   doc comment for the exact close-then-reopen race). `activeTriggerRef`
   below tracks whichever icon button was last clicked and is forwarded to
   every CockpitRailPopover instance as `triggerRef` — see useDismissable.ts.
   The 'report' icon's popover is owned by AgentsSpace.tsx instead (this
   file's header comment above), so `onReportClick` also forwards the
   button element (not just its rect) for the same fix there. */

import { memo, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { bumpRenderCount } from '../../../lib/perf/renderCounters';
import { FleetMap, type FleetProject as FleetMapProject } from '../orchestrator/FleetMap';
import { DecisionCenter } from '../orchestrator/DecisionCenter';
import { OrchestratorTree } from '../orchestrator/OrchestratorTree';
import { PlanApprovalPanel } from '../orchestrator/PlanApprovalPanel';
import { GraphRunPanel } from '../orchestrator/GraphRunPanel';
import { BudgetBurn } from '../orchestrator/BudgetBurn';
import { ProvisioningPanel } from '../orchestrator/ProvisioningPanel';
import { CustomRulesPanel } from '../orchestrator/CustomRulesPanel';
import { bindPlanFileDiff } from '../../../lib/agents/planScopeDiffIo';
import type { OrchestratorState, OrchestratorPlanStep } from '../../../lib/agents/types';
import type { GraphRun } from '../../../lib/agents/graph/types';
import type { RunDebugSnapshot } from '../../../lib/agents/graph/graphDebugView';
import type { FleetProject, FleetMission } from '../../../lib/agents/fleetMissions';
import type { Objective } from '../../../lib/objectives/objectivesStore';
import { CockpitRailPopover, type PopoverAnchorRect } from './CockpitRailPopover';
import { CockpitMeteoLine } from './CockpitMeteoLine';
import { KpiGroup } from './KpiGroup';
import { ScorecardPanel } from './ScorecardPanel';
import { CapObjectives } from './CapObjectives';
import { countActiveByModelFamily, type ProjectPill, type RankedUrgentMission } from './cockpitHelpers';

type RailIconId = 'kpis' | 'fleetMap' | 'objectives' | 'decisions' | 'budget' | 'provisioning' | 'rules';

export interface CockpitLeftRailProps {
  /** Full fleet snapshot — feeds KpiGroup + CapObjectives + CockpitMeteoLine
   *  (the exact same `fleet.projects` shape Cockpit.tsx already threads
   *  everywhere else; distinct from `fleetMapProjects` below, FleetMap's own
   *  narrower local shape). */
  projects: FleetProject[];
  pills: ProjectPill[];
  pendingDecisions: number;
  /** Phantom-badge fix (real user report, 2026-08-14) — the SAME
   *  `rankUrgentMissions(projects)` array `pendingDecisions` is `.length`-
   *  derived from (Cockpit.tsx). The 'decisions' popover renders this list
   *  verbatim via DecisionCenter/UrgentMissionCard instead of the old
   *  unrelated `orchestrators.filter(status === 'blocked')` collection, and
   *  this rail's own badge reads `urgentMissions.length` (not the separate
   *  `pendingDecisions` scalar) — see `badgesById.decisions` below — so the
   *  badge and the panel it opens are structurally the same source and
   *  cannot drift apart again. */
  urgentMissions: RankedUrgentMission[];
  /** Real handlers (Cockpit.tsx's handleOpenMission/handleUrgentAction) —
   *  same primitives ProjectRow.tsx's AGENTS-zone urgent cards already use,
   *  forwarded here so DecisionCenter's cards behave identically. */
  onOpenMission: (missionId: string) => void;
  onUrgentAction: (mission: FleetMission, actionKey: string) => void;
  /** Missions whose last merge attempt was blocked (agentsStore.tsx's
   *  ApproveBlockedError) — same `blockedApproveIds` state ProjectRow.tsx's
   *  `forceApproveIds` prop already reads, so a mission's "Merger" action
   *  offers the SAME force-merge upgrade here as it does on the canvas. */
  forceApproveIds: ReadonlySet<string>;
  /** "Rapport" rail icon (above 'kpis') — opens the ProjectReportPage
   *  popover for the active project. Not a CockpitRailPopover mounted here:
   *  unlike the other rail icons this one's popover is owned by
   *  AgentsSpace.tsx (which owns the reportProjectId state), so the click's
   *  captured anchor rect is forwarded up through this callback instead of
   *  driving a local `openId`. Optional purely so the screenshot/test
   *  harness can keep mounting without wiring it — Cockpit's real render
   *  always passes it (see CockpitLeftRailProps' other optional on*Click
   *  props for the same convention). Also receives the trigger button
   *  element itself (not just its rect) so AgentsSpace.tsx can pass it as
   *  CockpitRailPopover's `triggerRef` — see this file's header comment on
   *  the re-click-to-close race that requires it. */
  onReportClick?: (anchorRect: PopoverAnchorRect, triggerEl: HTMLButtonElement) => void;
  /** Severity-1 usability-trap fix (real user report, 2026-08-14): the
   *  Command/Construction toggle used to live ONLY inside the canvas top
   *  toolbar (CanvasToolbar.tsx's `canvas-toolbar-cockpit-mode`) — which
   *  Command mode itself unmounts, since Command mode replaces the canvas
   *  entirely (Cockpit.tsx's `cockpitMode === 'construction'` guard around
   *  `<CanvasView>`). This rail is the ONE piece of chrome Cockpit.tsx
   *  renders unconditionally in BOTH modes, so it's the correct — and now
   *  only guaranteed-reachable — home for this control. `cockpitMode` also
   *  drives the 'fleetMap' icon's own mode-aware behavior below (see
   *  `handleIconClick`'s inline comment). */
  cockpitMode: 'command' | 'construction';
  onToggleMode: () => void;
  onDecisionsKpiClick?: () => void;
  onAgentsKpiClick?: () => void;
  onMergedKpiClick?: () => void;
  onBrainKpiClick?: () => void;
  onRequestRecoveryPlan: (objective: Objective) => void;
  onHoverObjective: (objective: Objective | null) => void;
  /** Screenshot/test-only seam, forwarded verbatim — see CapObjectives.tsx's
   *  own doc comment. */
  objectivesOverride?: Objective[];
  fleetMapProjects: FleetMapProject[];
  onSelectProject: (projectId: string) => void;
  orchestrators: OrchestratorState[];
  onApprovePlan: (id: string) => void;
  onRejectPlan: (id: string) => void;
  onRevisePlan: (id: string) => void;
  /** Live SGR run (execute_plan path) — shown above plan trees. */
  activeGraphRun?: GraphRun | null;
  activeGraphSnapshot?: RunDebugSnapshot | null;
  onStepClick: (step: OrchestratorPlanStep) => void;
  budgetSpentCents: number;
  budgetLimitCents?: number;
}

// ── Local icon glyphs (inline SVG, no emoji — design-system convention,
//    see LazyManagerRail.tsx's CanvasChipIcon / nodeChrome.tsx's TypeGlyph). ─

function ReportIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 3h7l4 4v14H7V3Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M14 3v4h4" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M9.5 12h5M9.5 15.5h5M9.5 8.5h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function KpisIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 20V10M12 20V4M20 20v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FleetMapIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M9 4v13M15 6.5v13" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function ObjectivesIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 21V4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M6 4h11l-3 4 3 4H6Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function DecisionsIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BudgetIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M3 10h18" stroke="currentColor" strokeWidth="2" />
      <circle cx="16.5" cy="14.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ProvisioningIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RulesIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Severity-1 usability-trap fix (real user report, 2026-08-14): swap-arrows
 *  glyph for the Command/Construction mode toggle — see this file's own
 *  `RailIconButton id="mode"` usage below for why it lives on the rail (the
 *  ONE piece of chrome that renders in BOTH modes). */
function ModeToggleIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 8h13M17 8l-3-3M17 8l-3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 16H7M7 16l3-3M7 16l3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface RailIconDef {
  id: RailIconId;
  Icon: () => React.ReactElement;
  labelKey: string;
}

const RAIL_ICONS: RailIconDef[] = [
  { id: 'kpis', Icon: KpisIcon, labelKey: 'cockpit.rail.kpis' },
  { id: 'fleetMap', Icon: FleetMapIcon, labelKey: 'cockpit.rail.fleetMap' },
  { id: 'objectives', Icon: ObjectivesIcon, labelKey: 'cockpit.rail.objectives' },
  { id: 'decisions', Icon: DecisionsIcon, labelKey: 'cockpit.rail.decisions' },
  { id: 'budget', Icon: BudgetIcon, labelKey: 'cockpit.rail.budget' },
  { id: 'provisioning', Icon: ProvisioningIcon, labelKey: 'cockpit.rail.provisioning' },
  { id: 'rules', Icon: RulesIcon, labelKey: 'cockpit.rail.rules' },
];

// ── Shared layout export — consumed by CanvasFloatingButtons.tsx (canvas/) ─
// BUG FIX: CanvasFloatingButtons ('Agent Library' / 'MCP Servers' round
// buttons, floating over the SAME canvas as this rail) used to anchor to the
// exact same spot this rail does (`position:absolute; left:16; top:'50%';
// transform:'translateY(-50%)'`) — two independent flex columns anchored to
// the identical origin, with no shared parent to stack them under, so its
// icons visually overlapped this rail's icons (measured: both groups
// painting at x=16, y=409-459 in a 1440x844 viewport). This rail keeps its
// vertically-centered spot unchanged (it's the primary/larger rail);
// CanvasFloatingButtons now anchors BELOW it using this exported height
// instead of also centering — see that file's own comment. Exported (not
// re-hardcoded there as a separate guess) so the two can never drift back
// out of sync if RAIL_ICONS grows or shrinks.
export const COCKPIT_LEFT_RAIL_ITEM_COUNT = RAIL_ICONS.length + 3; // + logo mark + 'mode' toggle + 'report' icon (all three rendered above RAIL_ICONS below)
export const COCKPIT_LEFT_RAIL_HEIGHT =
  COCKPIT_LEFT_RAIL_ITEM_COUNT * 38 + (COCKPIT_LEFT_RAIL_ITEM_COUNT - 1) * 8; // 38px icon + 8px gap, matching this file's own inline styles below

// ── Rail-overlap fix (real user report, 2026-08-14): Cockpit.tsx's Command-
// mode grid used to start at the container's literal left edge (`inset: 0`)
// — this floating rail (`left: 16`, 40px-wide icons) then painted directly
// on top of the grid's own leftmost ~40-56px, cutting project names/labels
// off mid-word ("…ounce — 0 mission(s)"). `COCKPIT_LEFT_RAIL_RESERVED_LEFT_PX`
// is the real DOM-space equivalent of the gutter cameraInsets.ts's
// `usableCanvasRect` already reserves for THIS SAME rail on the canvas side
// (`railWidth + DEFAULT_HORIZONTAL_GUTTER_PX`, 24px) — any plain (non-canvas)
// full-bleed panel anchored to this root's left edge should use this as its
// own `left` instead of `0`, so it can never render underneath the rail. ──
export const COCKPIT_LEFT_RAIL_LEFT_OFFSET_PX = 16; // this file's own root `left` style below
export const COCKPIT_LEFT_RAIL_WIDTH_PX = 38; // RailIconButton's own width/height
const COCKPIT_LEFT_RAIL_GUTTER_PX = 24; // matches cameraInsets.ts's DEFAULT_HORIZONTAL_GUTTER_PX
export const COCKPIT_LEFT_RAIL_RESERVED_LEFT_PX =
  COCKPIT_LEFT_RAIL_LEFT_OFFSET_PX + COCKPIT_LEFT_RAIL_WIDTH_PX + COCKPIT_LEFT_RAIL_GUTTER_PX; // 80

function RailIconButton({
  id,
  Icon,
  label,
  active,
  badge,
  onClick,
  hasPopup = true,
}: {
  id: RailIconId | 'report' | 'mode';
  Icon: () => React.ReactElement;
  label: string;
  active: boolean;
  /** Real, honest count only (running agents for 'kpis', pending decisions
   *  for 'decisions') — never a fabricated/decorative number. Omitted (no
   *  badge rendered) whenever there's nothing to report. */
  badge?: number;
  onClick: (el: HTMLButtonElement) => void;
  /** 'report' and 'mode' are pure actions (open the ProjectReportPage
   *  overlay / flip the cockpit mode directly), not a CockpitRailPopover —
   *  false there so aria-haspopup/aria-expanded accurately describe a plain
   *  action button instead of a dialog trigger. */
  hasPopup?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={`cockpit-rail-icon-${id}`}
      aria-label={label}
      data-tooltip={label}
      aria-haspopup={hasPopup ? 'dialog' : undefined}
      aria-expanded={hasPopup ? active : undefined}
      onClick={(e) => onClick(e.currentTarget)}
      style={{
        width: 38,
        height: 38,
        borderRadius: '50%',
        flexShrink: 0,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: active ? '1px solid var(--color-accent)' : '1px solid var(--color-border)',
        background: active ? 'rgba(124,92,255,0.16)' : 'rgba(20,20,28,0.82)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        color: active ? 'var(--color-accent-pale)' : 'var(--color-text-muted)',
        cursor: 'pointer',
        boxShadow: active ? '0 0 0 3px rgba(124,92,255,0.18)' : 'none',
        transition: 'background 0.15s, border-color 0.15s, color 0.15s',
      }}
    >
      <Icon />
      {badge !== undefined && badge > 0 && (
        <span
          data-testid={`cockpit-rail-badge-${id}`}
          style={{
            position: 'absolute',
            top: -3,
            right: -3,
            minWidth: 15,
            height: 15,
            borderRadius: 8,
            background: 'var(--color-assistant-cyan)',
            color: '#04121E',
            fontSize: 8,
            fontFamily: 'var(--font-mono)',
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 3px',
          }}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}

// Perf audit 2026-08-15 (item 3): renamed so it can be wrapped in `memo()`
// below — see that wrapper's own comment for scope/limits.
function CockpitLeftRailImpl({
  projects,
  pills,
  pendingDecisions,
  urgentMissions,
  onOpenMission,
  onUrgentAction,
  forceApproveIds,
  onReportClick,
  cockpitMode,
  onToggleMode,
  onDecisionsKpiClick,
  onAgentsKpiClick,
  onMergedKpiClick,
  onBrainKpiClick,
  onRequestRecoveryPlan,
  onHoverObjective,
  objectivesOverride,
  fleetMapProjects,
  onSelectProject,
  orchestrators,
  onApprovePlan,
  onRejectPlan,
  onRevisePlan,
  onStepClick,
  budgetSpentCents,
  budgetLimitCents,
  activeGraphRun = null,
  activeGraphSnapshot = null,
}: CockpitLeftRailProps) {
  bumpRenderCount('CockpitLeftRail');
  const { t } = useI18n();
  const [openId, setOpenId] = useState<RailIconId | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  // Whichever rail icon button was last clicked — forwarded to whichever
  // CockpitRailPopover is currently mounted as `triggerRef` so its
  // outside-pointerdown handler ignores clicks on the button that opened
  // it (see this file's header comment + CockpitRailPopover.tsx's own).
  const activeTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Real, honest badge counts — same derivation KpiGroup's own "agents" tile
  // uses (countActiveByModelFamily), so the rail icon's badge never diverges
  // from the number the popover it opens actually shows.
  const runningCounts = countActiveByModelFamily(projects, ['running']);
  const runningCount = runningCounts.sonnet + runningCounts.haiku + runningCounts.opus + runningCounts.other;
  const badgesById: Partial<Record<RailIconId, number>> = {
    kpis: runningCount,
    // Phantom-badge fix — reads `urgentMissions.length` directly (the SAME
    // array rendered by DecisionCenter below), not the separate
    // `pendingDecisions` scalar, so this badge and that panel's item count
    // are the same read, not just numbers that happen to currently agree.
    decisions: urgentMissions.length,
  };

  function handleIconClick(id: RailIconId, el: HTMLButtonElement) {
    // Duplicate-Fleet-Map fix (real user report, 2026-08-14): Command mode's
    // own grid (Cockpit.tsx's `cockpit-command-fleet` quadrant) already
    // shows this EXACT project list, always-visible, with no click needed —
    // opening the popover on top of it just stacked an identical list a
    // second time (plus FleetMap.tsx's own former duplicate heading, now
    // removed — see that file's header comment). Rather than popping a
    // redundant floating copy, point at the real inline panel that's
    // already on screen: same honest scroll+flash pattern
    // handleMergedKpiClick (Cockpit.tsx) already uses for the FLUX ticker.
    // Every OTHER rail icon never special-cases mode — their popover
    // content (interactive Decisions incl. approve/reject, Objectives,
    // Budget, Provisioning, Rules, KPIs) has no always-visible Command-mode
    // twin, so their plain toggle-a-popover behavior is unchanged.
    if (id === 'fleetMap' && cockpitMode === 'command') {
      const quadrant = document.querySelector('[data-testid="cockpit-command-fleet"]');
      if (quadrant instanceof HTMLElement) {
        // Optional chaining — jsdom (this repo's test environment) has no
        // scrollIntoView implementation at all; every real browser does.
        quadrant.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
        quadrant.classList.add('focus-flash');
        setTimeout(() => quadrant.classList.remove('focus-flash'), 1400);
      }
      return;
    }
    activeTriggerRef.current = el;
    setOpenId((prev) => (prev === id ? null : id));
    setAnchorRect(el.getBoundingClientRect());
  }

  function close() {
    setOpenId(null);
  }

  return (
    <div
      data-testid="cockpit-left-rail"
      style={{
        position: 'absolute',
        left: 16,
        top: '50%',
        transform: 'translateY(-50%)',
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        // W-CHROME label-clipping fix: this used to be `maxHeight: 'calc(100%
        // - 32px)'` + `overflowY: 'auto'` as a defensive vertical-scroll
        // fallback. CSS forces a mismatched visible/non-visible overflow
        // pair onto the SAME computed value per axis (spec: if overflow-y
        // isn't 'visible' and overflow-x is, overflow-x is computed as
        // 'auto' too) — so that alone silently clipped this container
        // horizontally, cutting off every icon's `[data-tooltip]::after`
        // name bubble (design-system.css) on both left and right, since
        // each bubble is centered (`left:50%; translateX(-50%)`) and wider
        // than the 40px round button it floats above, right at the
        // screen's left edge. RAIL_ICONS is a small, static, fixed-length
        // list (never data-driven/unbounded), so the vertical-scroll
        // fallback was defending against a case that can't actually grow —
        // dropping it (both axes back to the 'visible' default) fixes the
        // real bug with no loss of real capability.
      }}
    >
      {/* Decorative brand mark (mockup's `.icons .logo`) — not a control,
          just the floating rail's visual anchor. */}
      <div
        aria-hidden="true"
        style={{
          width: 38,
          height: 38,
          borderRadius: '50%',
          flexShrink: 0,
          background: 'linear-gradient(135deg, var(--color-accent), #5B3ECC)',
          color: '#fff',
          fontWeight: 800,
          fontSize: 16,
          fontFamily: 'var(--font-ui)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 6px 18px -8px rgba(0,0,0,0.6)',
        }}
      >
        L
      </div>

      {/* Command/Construction mode toggle — severity-1 usability-trap fix
          (real user report, 2026-08-14): this is now the ONE guaranteed-
          reachable affordance for switching cockpit mode, because this
          entire rail (unlike the canvas top toolbar) renders unconditionally
          in BOTH modes (Cockpit.tsx's `<CockpitLeftRail>` call sits OUTSIDE
          the `cockpitMode === 'construction' | 'command'` branches). The
          canvas toolbar's own `canvas-toolbar-cockpit-mode` button (only
          reachable in Construction mode, where the canvas exists at all)
          stays as a convenience shortcut — both already read/write the SAME
          `lazy.cockpitMode` state via the pre-existing `cockpit:modeChange`
          bus event (Cockpit.tsx), so the two can never disagree. Direct
          action, not a popover (hasPopup false, same convention as
          'report' above) — clicking it flips the mode immediately. */}
      <RailIconButton
        id="mode"
        Icon={ModeToggleIcon}
        label={cockpitMode === 'command' ? t('cockpit.mode.construction') : t('cockpit.mode.command')}
        active={cockpitMode === 'command'}
        hasPopup={false}
        onClick={() => onToggleMode()}
      />

      {/* "Rapport" — round icon ABOVE 'kpis'. No LOCAL popover (hasPopup is
          false, same as before — this button never toggles `openId`), but
          it still captures its own screen rect on click, same as the other
          icons, and forwards it to AgentsSpace.tsx via onReportClick so that
          component can open its own CockpitRailPopover anchored here (see
          this file's header comment). */}
      <RailIconButton
        id="report"
        Icon={ReportIcon}
        label={t('report.trigger.label')}
        active={false}
        hasPopup={false}
        onClick={(el) => onReportClick?.(el.getBoundingClientRect(), el)}
      />

      {RAIL_ICONS.map(({ id, Icon, labelKey }) => {
        // 'fleetMap' in Command mode never opens a popover (handleIconClick
        // scrolls/flashes the already-visible grid quadrant instead — see
        // that function's own comment) — aria-haspopup/aria-expanded must
        // describe that honestly instead of always claiming a dialog.
        const opensPopover = !(id === 'fleetMap' && cockpitMode === 'command');
        return (
          <RailIconButton
            key={id}
            id={id}
            Icon={Icon}
            label={t(labelKey)}
            active={opensPopover && openId === id}
            badge={badgesById[id]}
            hasPopup={opensPopover}
            onClick={(el) => handleIconClick(id, el)}
          />
        );
      })}

      {openId === 'kpis' && anchorRect && (
        <CockpitRailPopover title={t('cockpit.rail.kpis')} anchorRect={anchorRect} onClose={close} testId="kpis" triggerRef={activeTriggerRef}>
          <CockpitMeteoLine pills={pills} pendingDecisions={pendingDecisions} />
          <KpiGroup
            projects={projects}
            pendingDecisions={pendingDecisions}
            onDecisionsClick={onDecisionsKpiClick}
            onAgentsClick={onAgentsKpiClick}
            onMergedClick={onMergedKpiClick}
            onBrainClick={onBrainKpiClick}
          />
          <ScorecardPanel />
        </CockpitRailPopover>
      )}

      {openId === 'fleetMap' && anchorRect && (
        <CockpitRailPopover title={t('cockpit.rail.fleetMap')} anchorRect={anchorRect} onClose={close} testId="fleetMap" triggerRef={activeTriggerRef}>
          <FleetMap projects={fleetMapProjects} onSelectProject={onSelectProject} />
        </CockpitRailPopover>
      )}

      {openId === 'objectives' && anchorRect && (
        <CockpitRailPopover title={t('cockpit.rail.objectives')} anchorRect={anchorRect} onClose={close} testId="objectives" triggerRef={activeTriggerRef}>
          <CapObjectives
            projects={projects}
            onRequestRecoveryPlan={onRequestRecoveryPlan}
            onHoverObjective={onHoverObjective}
            objectivesOverride={objectivesOverride}
          />
        </CockpitRailPopover>
      )}

      {openId === 'decisions' && anchorRect && (
        <CockpitRailPopover title={t('cockpit.rail.decisions')} anchorRect={anchorRect} onClose={close} testId="decisions" triggerRef={activeTriggerRef}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <GraphRunPanel run={activeGraphRun ?? null} snapshot={activeGraphSnapshot ?? null} />
            <DecisionCenter
              urgentMissions={urgentMissions}
              forceApproveIds={forceApproveIds}
              onOpenMission={onOpenMission}
              onUrgentAction={onUrgentAction}
            />
            {orchestrators
              .filter((o) => o.status === 'planning')
              .map((o) => (
                <PlanApprovalPanel
                  key={o.id}
                  orchestrator={o}
                  loadFileDiff={bindPlanFileDiff(
                    projects.find((p) => p.projectId === o.projectId)?.root,
                  )}
                  onApprove={() => onApprovePlan(o.id)}
                  onRevise={() => onRevisePlan(o.id)}
                  onReject={() => onRejectPlan(o.id)}
                />
              ))}
            {orchestrators.map((o) => (
              <OrchestratorTree key={o.id} orchestrator={o} onStepClick={onStepClick} />
            ))}
          </div>
        </CockpitRailPopover>
      )}

      {openId === 'budget' && anchorRect && (
        <CockpitRailPopover title={t('cockpit.rail.budget')} anchorRect={anchorRect} onClose={close} testId="budget" triggerRef={activeTriggerRef}>
          <BudgetBurn spentCents={budgetSpentCents} limitCents={budgetLimitCents} />
        </CockpitRailPopover>
      )}

      {openId === 'provisioning' && anchorRect && (
        <CockpitRailPopover title={t('cockpit.rail.provisioning')} anchorRect={anchorRect} onClose={close} testId="provisioning" triggerRef={activeTriggerRef}>
          <ProvisioningPanel />
        </CockpitRailPopover>
      )}

      {openId === 'rules' && anchorRect && (
        <CockpitRailPopover title={t('cockpit.rail.rules')} anchorRect={anchorRect} onClose={close} testId="rules" triggerRef={activeTriggerRef}>
          <CustomRulesPanel />
        </CockpitRailPopover>
      )}
    </div>
  );
}

/**
 * Perf audit 2026-08-15 (item 3): same measured render-churn fix as
 * CanvasView.tsx's own `memo` export — see that file's comment for the full
 * mechanism. This component's props include several that were previously
 * INLINE arrow functions in Cockpit.tsx's JSX (onSelectProject,
 * onApprovePlan, onRejectPlan, onRevisePlan, onStepClick) — those are now
 * stable `useCallback`s there too (Cockpit.tsx, "perf audit 2026-08-15"
 * comment), without which this `memo` wrap would have been a no-op (a new
 * function identity on every prop is a changed prop, memo or not). Like
 * CanvasView, this still re-renders on every fleet poll tick because
 * `projects`/`pills`/`urgentMissions`/etc. are all `useMemo`'d off
 * `fleet.projects`, which itself gets a fresh reference every ~2.5s
 * regardless of memo (see fleetMissions.ts, untouched by this change).
 */
export const CockpitLeftRail = memo(CockpitLeftRailImpl);
