/* Cockpit — top-level fleet cockpit screen (manager-first layout,
   cockpit2), replacing AgentsSpace's old mission-control tab body.

   P1-3 full-bleed redesign: the page IS the Agent Canvas (multi-project
   React Flow fleet view, canvas/CanvasView.tsx) — full-bleed, edge to edge,
   no top météo/KPI bandeau, no 2-column split. Everything else floats OVER
   it as absolutely-positioned overlays anchored to this component's own
   `position:relative` root:
     - Far-left: a vertical rail of round icon buttons (CockpitLeftRail),
       vertically centered on the left edge. Each icon opens a
       "mini-parchemin" popover with that section's data — KPIs (KpiGroup's
       5 tiles + the météo greeting/project pills CockpitMeteoLine now
       carries, both formerly the top Bandeau bar), Fleet Map, Objectives/Cap
       (CapObjectives, formerly its own full-width band), Decisions, Budget.
       Nothing was dropped — see CockpitLeftRail.tsx's header comment for the
       full mapping.
     - Right: LazyManagerRail inside a floating glass overlay (ManagerOverlay)
       pinned to the right edge, ALWAYS visible, collapsible to a thin
       persistent tab that re-expands it (never fully hidden) — also now
       carries a compact autonomy control (ManagerAutonomyBar, fixes friction
       F5). Replaces the old fixed 460px right column.
     - Bottom: FluxFooter as a thin floating ticker overlay instead of a
       flex-stacked footer.
   "Poste d'analyse" (the old SWOT/dette/risques/audit desk) was already
   removed entirely in a prior wave and stays gone.

   W-CHROME: AgentsSpace.tsx's old "report-trigger-bar" row (a full-width
   strip below TopNav that existed ONLY to host the « Rapport » button,
   top-right) is gone — that button is now the 'report' round icon in
   CockpitLeftRail, directly above 'kpis' (see CockpitLeftRail.tsx's header
   comment). Same real onOpenReport handler, forwarded through this
   component unchanged. The kpis popover also no longer renders LiveFeed
   (live activity) per product feedback — KpiGroup's tiles only, LiveFeed
   itself untouched/unmounted rather than deleted.

   Cross-project action honesty note: store primitives (approveMission,
   interveneMission, retryMission, addMission, setSelectedMissionId) all
   operate on agentsStore's SINGLE active-project mission list (a
   pre-existing architectural constraint — see code-cockpit-map.md §4). For
   a mission belonging to a currently-inactive open project, an action here
   first calls the REAL switchProject() and asks the user to retry — it
   never fakes a cross-project mutation. See handleUrgentAction/
   handleOpenMission below. The manager rail's question relay and proactive
   signals (managerSignals.ts) reuse this exact same honesty pattern.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { emit, on } from '../../../lib/bus';
import { useToast } from '../../ui';
import { useAppContext } from '../../../app/AppContext';
import { useAgentsStore, resolveMissionRepoPath } from '../agentsStore';
import { projectIdFromRoot } from '../../../lib/journal/projectId';
import { loadMissionsFromJournal } from '../../../lib/journal/missionsProjection';
import { ApproveBlockedError, MergeConflictError } from '../approveGate';
import { useFleetMissions, type FleetMission, type FleetProject, type UseFleetMissionsResult } from '../../../lib/agents/fleetMissions';
import type { Objective } from '../../../lib/objectives/objectivesStore';
import type { ManagerMessage, OrchestratorPlanStep } from '../../../lib/agents/types';
import { rankUrgentMissions, deriveProjectPills, nextModelTierLabel } from './cockpitHelpers';
import { logPlanActionFailure } from './planActionErrors';
import { getGlobalBudget, subscribeBudget, hydrateGlobalSpentCents } from '../../../lib/agents/budgetTracker';
import { startBudgetLedgerReconcile } from '../../../lib/agents/budgetSupabaseHydrate';
import { getWindowMetrics, subscribeUsageHistory } from '../../../lib/models/usageHistory';
import { usdToCredits } from '../../../lib/billing/credits';
import { deriveManagerSignals } from './managerSignals';
import { recordMissionAnswer } from '../../../lib/agents/missionQuestion';
import { CanvasView } from '../canvas/CanvasView';
import type { ScheduleNodeData } from '../canvas/canvasTypes';
import type { MissionLoopMeta } from '../canvas/reconciler';
import { CockpitLeftRail, COCKPIT_LEFT_RAIL_RESERVED_LEFT_PX } from './CockpitLeftRail';
import type { PopoverAnchorRect } from './CockpitRailPopover';
import { ManagerOverlay, OVERLAY_RIGHT_OFFSET, resolveInitialOverlayWidth } from './ManagerOverlay';
import { FluxFooter } from './FluxFooter';

const JUST_MERGED_DISPLAY_MS = 4_500;

interface CockpitProps {
  onOpenLibrary: () => void;
  /**
   * "Rapport" rail icon handler (CockpitLeftRail, above 'kpis') — opens the
   * ProjectReportPage popover for the active project, anchored to the icon
   * that was clicked. W-CHROME: replaces AgentsSpace.tsx's old standalone
   * "report-trigger-bar" header row (which hosted only this one button,
   * below TopNav); AgentsSpace.tsx owns the reportProjectId + popover-anchor
   * state, this is just the real trigger (plus the anchor rect it needs)
   * forwarded down to the rail, same pattern onOpenLibrary already uses.
   * Also receives the trigger button element itself (founder bug fix,
   * 2026-07-22 — see CockpitLeftRail.tsx/CockpitRailPopover.tsx's own doc
   * comments) so the report popover can ignore pointerdowns on its own
   * rail icon and avoid the close-then-reopen race on re-click.
   */
  onOpenReport: (anchorRect: PopoverAnchorRect, triggerEl: HTMLButtonElement) => void;
  /**
   * Screenshot/test-only injection seam — see
   * src/__screenshots__/cockpit-harness.tsx. Production code never passes
   * any of these; Cockpit always reads the real fleet read-model,
   * objectives store, and manager chat. Exists so the harness can mount the
   * REAL component tree (styles, i18n, store wiring) with fixture data
   * instead of the live Tauri-only sources, which always return empty
   * outside a Tauri runtime (repo convention: real data or an honest empty
   * state, never mock data baked into app code — see fleetMissions.ts's
   * doc comment). The fixture VALUES live only in the harness file.
   */
  fleetOverride?: UseFleetMissionsResult;
  objectivesOverride?: Objective[];
  managerMessagesOverride?: ManagerMessage[];
  /**
   * Screenshot/test-only: pretends this project root is the active one, so
   * `isActiveProject`-gated handlers (see switchToProjectIfNeeded below)
   * actually run their real effect instead of always swallowing the click
   * as "switch project first" — lets the harness prove out real card-click
   * / urgent-action wiring for one fixture project without a live Tauri
   * backend and its `openProjects`/`activeProjectId`.
   */
  activeProjectRootOverride?: string;
  /**
   * Screenshot/test-only, forwarded verbatim to CanvasView — see that
   * component's own doc comment on these two props for why they exist
   * (CanvasView.tsx's `scheduledOverride`/`missionLoopMetaOverride`).
   */
  scheduledOverride?: ScheduleNodeData[];
  missionLoopMetaOverride?: ReadonlyMap<string, MissionLoopMeta>;
}

export function Cockpit({
  onOpenLibrary,
  onOpenReport,
  fleetOverride,
  objectivesOverride,
  managerMessagesOverride,
  activeProjectRootOverride,
  scheduledOverride,
  missionLoopMetaOverride,
}: CockpitProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { openProjects, activeProjectId, switchProject } = useAppContext();
  const { missions: activeMissions, setSelectedMissionId, approveMission, interveneMission, addMission, retryMission, orchestrators, activeGraphRun, activeGraphSnapshot, autonomyLevel, setAutonomyLevel, executePlan, revisePlan, rejectPlan } = useAgentsStore();

  const liveFleet = useFleetMissions(!fleetOverride);
  const fleet = fleetOverride ?? liveFleet;
  const [highlightProjectId, setHighlightProjectId] = useState<string | null>(null);
  const [justMergedId, setJustMergedId] = useState<string | null>(null);
  const [managerDraft, setManagerDraft] = useState<string | null>(null);
  /** Missions whose first "Merger" click was blocked by the approve gate
   *  (ApproveBlockedError) — a second "Merger" click on the same mission
   *  force-merges, mirroring AttentionInbox.tsx's separate force-approve
   *  button (this card has no room for a 3rd action slot, so the same
   *  button toggles to "force" instead). */
  const [blockedApproveIds, setBlockedApproveIds] = useState<Set<string>>(new Set());
  /** Missions whose last "Merger" click ended in a real git conflict
   *  (MergeConflictError — see agentsStore.tsx's approveMission and git.rs's
   *  abort-on-conflict doc comments). Drives the signal card's honest
   *  conflict state (managerSignals.ts's deriveManagerSignals) instead of
   *  re-offering the same "Merger" button that just conflicted. Cleared the
   *  moment a later merge attempt on that mission actually succeeds. */
  const [conflictedMissionIds, setConflictedMissionIds] = useState<Set<string>>(new Set());
  /** QA B16 — "agents" KPI tile click: briefly glows every currently-running
   *  mission card (same glow mechanism CapObjectives' hover already drives
   *  via highlightProjectId below), auto-clears like justMergedId does. */
  const [runningPulseActive, setRunningPulseActive] = useState(false);
  const [budget, setBudget] = useState(getGlobalBudget);
  useEffect(() => {
    const syncFromHistory = () => {
      hydrateGlobalSpentCents(usdToCredits(getWindowMetrics('all').costUsd));
      setBudget(getGlobalBudget());
    };
    syncFromHistory();
    const stopLedger = startBudgetLedgerReconcile();
    const unsubHistory = subscribeUsageHistory(syncFromHistory);
    const unsubBudget = subscribeBudget(() => setBudget(getGlobalBudget()));
    return () => {
      stopLedger();
      unsubHistory();
      unsubBudget();
    };
  }, []);
  /** Cockpit view mode: 'command' shows Fleet Map + Decision Center +
   *  Orchestrator Tree + Live Feed in a full-width grid; 'construction'
   *  shows the React Flow canvas (default). Toggled via the floating
   *  mode-switch button or keyboard shortcut 'C' (Pillar E1). */
  const [cockpitMode, setCockpitMode] = useState<'command' | 'construction'>(() => {
    try { return (localStorage.getItem('lazy.cockpitMode') as 'command' | 'construction') || 'construction'; }
    catch { return 'construction'; }
  });
  // Live mirror of cockpitMode for toggleCockpitMode — the toggle must emit
  // `cockpit:modeChange` OUTSIDE the setState updater: React (StrictMode) can
  // invoke an updater twice, and calling the bus `emit` inside one synchronously
  // triggers the subscription below (`setCockpitMode(mode)`) mid-render — a
  // state update during render that silently corrupts the toggle (real repro:
  // toggling command -> construction no-ops, the mode never leaves 'command').
  // Reading the current mode from this ref keeps the emit side-effect out of
  // the updater entirely.
  const cockpitModeRef = useRef<'command' | 'construction'>(cockpitMode);
  useEffect(() => { cockpitModeRef.current = cockpitMode; }, [cockpitMode]);
  useEffect(() => {
    try { localStorage.setItem('lazy.cockpitMode', cockpitMode); } catch { /* ignore */ }
  }, [cockpitMode]);
  const toggleCockpitMode = useCallback(() => {
    const next = cockpitModeRef.current === 'command' ? 'construction' : 'command';
    setCockpitMode(next);
    // 2026-08-09 — the canvas toolbar owns the visible toggle now, but the
    // 'C' keyboard shortcut (below) still routes through here: broadcast
    // the new mode so the toolbar's own local state stays in sync.
    emit('cockpit:modeChange', { mode: next });
  }, []);
  // 2026-08-09 — toolbar button sync: CanvasToolbar's `canvas-toolbar-
  // cockpit-mode` emits `cockpit:modeChange` when clicked; apply it here so
  // the cockpit view reacts even though this component no longer owns the
  // only toggle affordance.
  useEffect(() => {
    const off = on('cockpit:modeChange', ({ mode }: { mode: 'command' | 'construction' }) => {
      setCockpitMode(mode);
    });
    return off;
  }, []);
  // Severity-1 usability-trap fix (real user report, 2026-08-14): TopNav.tsx
  // emits this when the user re-clicks the ALREADY-active Cockpit pill — a
  // natural "take me home" gesture. Always resets to 'construction' (the
  // SAME default this file's own useState initializer falls back to, and
  // the product's primary full-bleed canvas experience — see this file's
  // header comment), never toggles or remembers a second value. Mode
  // persistence across restarts (localStorage above) is kept exactly as-is:
  // this is an explicit, deliberate user gesture, not an automatic reset.
  useEffect(() => {
    return on('cockpit:resetMode', () => {
      setCockpitMode('construction');
      emit('cockpit:modeChange', { mode: 'construction' });
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key === 'c') {
        toggleCockpitMode();
      } else if (e.key === 'e') {
        // Manual manager-overlay widen/narrow shortcut — mirrors this same
        // bare-letter, "not typing in a field" convention as 'c' above; see
        // ManagerOverlay.tsx's header comment for the full width state
        // machine this toggles between (normal <-> expanded).
        emit('manager:toggleOverlayWidth', undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleCockpitMode]);

  // P2a: Track live manager overlay width so FluxFooter reserves exact space
  // instead of static worst-case MANAGER_OVERLAY_MAX_RESERVED_WIDTH.
  //
  // fix/canvas-collapse-reservation round 2 (David's round-9 report: a
  // fresh launch with a persisted custom drag width reserved that stale
  // custom width for the canvas even though the overlay itself opened
  // COLLAPSED — this `useState` used to default to the hardcoded worst-case
  // `MANAGER_OVERLAY_MAX_RESERVED_WIDTH` and simply wait for
  // `<ManagerOverlay>` to mount and correct it via the bus event below; a
  // safe-but-wrong placeholder for FluxFooter's own "never let my ticker
  // get covered" need, but wrong for the canvas's `reservedRightPx` below,
  // whose whole point is to be as SMALL/accurate as possible so the canvas
  // isn't needlessly cramped). `resolveInitialOverlayWidth()` reads the
  // SAME persisted localStorage `<ManagerOverlay>` itself reads on its own
  // mount, resolved through the SAME `resolveEffectiveOverlayWidth`
  // function that component's own live `currentWidth` now uses — so this
  // very first render already agrees with whatever `<ManagerOverlay>` is
  // about to render, instead of guessing a large placeholder and waiting
  // for a correction that, on this exact repro, never actually needed to
  // happen at all (the FIRST real value already was the answer). Falls
  // back to the SAME old worst-case constant when `window`/localStorage
  // are genuinely unavailable (SSR-style guard, matches every other
  // localStorage read in this file/ManagerOverlay.tsx).
  const [managerOverlayWidth, setManagerOverlayWidth] = useState(
    () => resolveInitialOverlayWidth() + OVERLAY_RIGHT_OFFSET,
  );
  useEffect(() => {
    const off = on('manager:overlayWidthChange', ({ width }) => {
      setManagerOverlayWidth(width + OVERLAY_RIGHT_OFFSET);
    });
    return () => { off(); };
  }, []);

  const pills = useMemo(() => deriveProjectPills(fleet.projects), [fleet.projects]);
  // `rankByMissionId` (a mission-id -> rank map) used to be threaded down
  // into AgentGrid/ProjectRow for the urgent-rank chip. The canvas
  // reconciler now derives the identical rank straight from
  // `rankUrgentMissions(projects)` itself (same pure function, same
  // `fleet.projects` input) when building each MissionNodeData, so keeping
  // a second, always-redundant copy here would be dead weight — dropped
  // (see CanvasView.tsx's CanvasViewProps doc comment).
  const ranked = useMemo(() => rankUrgentMissions(fleet.projects), [fleet.projects]);
  // Phantom-badge fix (real user report, 2026-08-14): the Decisions rail
  // badge/météo greeting/KPI "DECISIONS" tile and the Decisions popover's
  // OWN list used to derive from two UNRELATED collections — this scalar
  // used to call `countPendingDecisions(fleet.projects)` separately (a
  // second, independent `rankUrgentMissions` call), while the popover's
  // `DecisionCenter` content read `orchestrators.filter(status==='blocked')`
  // — a different domain model this codebase barely ever populates (see
  // cockpitHelpers.ts's classifyUrgent doc comment: there is no real
  // 'blocked' mission status here). The badge said "2", the panel said
  // "No pending decisions." — not because either number was stale, but
  // because they were never the same number to begin with. Deriving this
  // scalar from `ranked.length` (the SAME array now threaded into
  // CockpitLeftRail as `urgentMissions` and rendered verbatim by
  // DecisionCenter) makes the badge and the panel agree BY CONSTRUCTION —
  // one selector (`rankUrgentMissions`), two views, impossible to drift.
  const pendingDecisions = ranked.length;
  /** Live manager-rail signal feed (question relay + proactive
   *  review/failed/question one-liners) — see managerSignals.ts's module
   *  doc comment for why this needs no separate debounce/dismiss state: it
   *  is recomputed fresh from the fleet snapshot every render and keyed by
   *  (kind, missionId), so a resolved mission simply stops appearing. */
  const signals = useMemo(
    () => deriveManagerSignals(fleet.projects, conflictedMissionIds),
    [fleet.projects, conflictedMissionIds],
  );
  /** CockpitLeftRail's "Fleet Map" popover — same shape FleetMap.tsx has
   *  always expected, unchanged by the P1-2 rail redesign. */
  const fleetMapProjects = useMemo(
    () => fleet.projects.map((p) => ({ id: p.projectId, name: p.name, missions: p.missions })),
    [fleet.projects],
  );
  const highlightIds = useMemo(() => {
    const fromHover = highlightProjectId
      ? (fleet.projects.find((p) => p.projectId === highlightProjectId)?.missions.map((m) => m.id) ?? [])
      : [];
    const fromRunningPulse = runningPulseActive
      ? fleet.projects.flatMap((p) => p.missions.filter((m) => m.status === 'running').map((m) => m.id))
      : [];
    return new Set([...fromHover, ...fromRunningPulse]);
  }, [highlightProjectId, runningPulseActive, fleet.projects]);

  const activeRoot = useMemo(
    () => activeProjectRootOverride ?? (openProjects.find((p) => p.id === activeProjectId)?.root ?? null),
    [activeProjectRootOverride, openProjects, activeProjectId],
  );

  const isActiveProject = useCallback(
    (project: FleetProject) => activeRoot !== null && project.root === activeRoot,
    [activeRoot],
  );

  const findFleetProject = useCallback(
    (missionId: string): FleetProject | undefined => fleet.projects.find((p) => p.missions.some((m) => m.id === missionId)),
    [fleet.projects],
  );

  /** Real project switch + a clear hint, when acting on a mission that
   *  belongs to a project other than the one currently active. Returns
   *  true if it handled the click (caller should stop). */
  const switchToProjectIfNeeded = useCallback(
    (project: FleetProject): boolean => {
      if (isActiveProject(project)) return false;
      const entry = openProjects.find((p) => p.root === project.root);
      if (entry) {
        void switchProject(entry.id);
        toast(t('cockpit.toast.projectSwitched', { name: project.name }), 'info');
      } else {
        // Bug fix (audit wave): a mission whose project isn't even in
        // openProjects used to fall through here with NO toast at all —
        // the action silently did nothing and the user had no way to know
        // why. No existing i18n key covers "project not open" (i18n locale
        // files are outside this fix's file ownership) — a plain,
        // tone-matched French string instead of inventing a fabricated key.
        toast(`Projet « ${project.name} » non ouvert — ouvre-le d'abord pour agir sur cette mission.`, 'error');
      }
      return true;
    },
    [isActiveProject, openProjects, switchProject, toast, t],
  );

  /**
   * Agent Canvas W3 (spec §7 "Cross-project honesty"): chainEngine.ts fired
   * a chain whose target draft lives in a currently-inactive project — no
   * silent switch happened there. This toast is the ONLY user-visible
   * surface for that: an info toast naming the source mission, with a
   * "Lancer" action that performs the REAL switchProject() (same primitive
   * `switchToProjectIfNeeded` above uses). chainEngine itself is already
   * subscribed to the resulting `project://changed` event and auto-fires
   * the deferred launch the moment the active project actually matches —
   * so this button's only job is to trigger that real switch; it does not
   * (and must not) launch anything itself.
   */
  useEffect(() => {
    return on('chain:pendingCrossProject', ({ projectId, sourceTitle }) => {
      const entry = openProjects.find((p) => projectIdFromRoot(p.root) === projectId);
      toast(
        t('canvas.manager.chainReady', { title: sourceTitle }),
        'info',
        8000,
        entry ? { label: 'Lancer', onClick: () => { void switchProject(entry.id); } } : undefined,
      );
    });
  }, [openProjects, switchProject, toast, t]);

  const handleOpenMission = useCallback(
    (missionId: string) => {
      const project = findFleetProject(missionId);
      if (!project) return;
      if (switchToProjectIfNeeded(project)) return;
      setSelectedMissionId(missionId);
    },
    [findFleetProject, switchToProjectIfNeeded, setSelectedMissionId],
  );

  const handleUrgentAction = useCallback(
    (mission: FleetMission, actionKey: string) => {
      const project = findFleetProject(mission.id);
      if (!project) return;
      if (switchToProjectIfNeeded(project)) return;

      switch (actionKey) {
        case 'deny-replan':
          interveneMission(mission.id, t('cockpit.order.denyReplan'));
          break;
        case 'allow-once':
          interveneMission(mission.id, t('cockpit.order.allowOnce'));
          break;
        case 'merge': {
          const force = blockedApproveIds.has(mission.id);
          void (async () => {
            try {
              // Bug fix (audit wave): this mission's OWN project root, never
              // whatever project happens to be ACTIVE right now — same
              // resolveMissionRepoPath pattern the manager tool's
              // approve_mission case and the auto-merge engine already use
              // (agentsStore.tsx). switchToProjectIfNeeded above already
              // guarantees the mission's project IS the active one by the
              // time this runs, but resolving through the mission itself
              // stays correct even if that assumption ever changes.
              const repoPath = await resolveMissionRepoPath(mission.id);
              await approveMission(mission.id, repoPath, force ? { force: true } : undefined);
              setJustMergedId(mission.id);
              setTimeout(() => setJustMergedId(null), JUST_MERGED_DISPLAY_MS);
              setBlockedApproveIds((prev) => {
                if (!prev.has(mission.id)) return prev;
                const next = new Set(prev);
                next.delete(mission.id);
                return next;
              });
              // A later merge attempt succeeded (or resolved as an honest
              // already-merged no-op — approveMission never throws for
              // that case either) — this mission is no longer conflicted.
              setConflictedMissionIds((prev) => {
                if (!prev.has(mission.id)) return prev;
                const next = new Set(prev);
                next.delete(mission.id);
                return next;
              });
            } catch (err) {
              if (err instanceof MergeConflictError) {
                // Honesty fix (severe QA bug): git.rs already aborted the
                // conflicting merge server-side, so the user's working tree
                // is clean again — but the mission itself must never look
                // like nothing happened. Flip the signal card to an
                // explicit, persistent conflict state (Diff only, no fake
                // retry) instead of just a transient toast.
                setConflictedMissionIds((prev) => new Set(prev).add(mission.id));
                toast(t('cockpit.toast.mergeConflict'), 'error');
              } else if (err instanceof ApproveBlockedError) {
                setBlockedApproveIds((prev) => new Set(prev).add(mission.id));
                toast(`${err.reason} — ${t('cockpit.toast.mergeAgainToForce')}`, 'error');
              } else {
                toast(`${t('common.error')}: ${String(err)}`, 'error');
              }
            }
          })();
          break;
        }
        // B14: "Diff" and "Logs" used to both just call setSelectedMissionId
        // with no further signal, so opening the drawer via either button
        // landed on the exact same view. Each now also requests which
        // section to scroll+highlight — AgentsSpace.tsx's always-mounted
        // mission:focusSection subscriber (registered before this card can
        // even be clicked) forwards it into MissionDetail.
        //
        // Dead-click root cause (real user report, 2026-08-14): `mission`
        // here comes from `fleet.projects` (useFleetMissions' cross-project
        // journal poll, NO project filter — see that module's own doc
        // comment), while MissionDetailDrawer only ever renders for an id
        // present in agentsStore's SINGLE active-project mission list — the
        // exact list AgentsSpace.tsx's `selectedMission` looks up
        // `selectedMissionId` against. fleetMissions.ts's module doc
        // comment documents the resulting gap verbatim: agentsStore's own
        // mission list "is not re-loaded when the active project changes
        // after AgentsSpace first mounts", so it can lag behind the
        // journal-sourced fleet view even once `isActiveProject` above says
        // the right project IS active.
        //
        // A grace-period-then-toast fix here would still leave the user
        // clicking a review affordance that reliably fails to show them the
        // diff. Instead: fire the SAME real primitive agentsStore's own boot
        // hydration uses (loadMissionsFromJournal) for this mission's own
        // project the moment we know it might be missing, and broadcast the
        // real Mission the instant it resolves (mission:crossProjectLoaded
        // — see bus.ts's own doc comment on that event). AgentsSpace.tsx
        // renders from either its own `missions` OR this cross-project
        // cache, so the drawer opens with the REAL diff/transcript data as
        // soon as the load lands — typically well under a second, not the
        // ~2.5s poll interval — with zero risk of a stale/partial view
        // (a full journal-sourced Mission, not a FleetMission projection).
        // A load that finds nothing (mission genuinely gone, project not on
        // disk, etc.) never emits — AgentsSpace.tsx's own grace-period toast
        // is the last-resort path for that genuine failure, not the normal
        // outcome.
        case 'diff':
        case 'logs': {
          const section = actionKey === 'diff' ? 'diff' : 'logs';
          emit('mission:focusSection', { missionId: mission.id, section });
          setSelectedMissionId(mission.id);
          if (!activeMissions.some((m) => m.id === mission.id)) {
            void loadMissionsFromJournal(project.projectId)
              .then((loaded) => {
                const found = loaded?.find((m) => m.id === mission.id);
                if (found) emit('mission:crossProjectLoaded', { missionId: mission.id, mission: found });
              })
              .catch(() => {
                // Best-effort — AgentsSpace.tsx's grace-period toast is the
                // honest fallback when this genuinely cannot be loaded.
              });
          }
          break;
        }
        case 'retry':
          // Real retry primitive — same one MissionDetail's own "Relancer"
          // button and AttentionInbox.tsx's 'blocked' kind use. Wired here so
          // the manager rail's "failed" signal bubble's "Réessayer" button
          // (managerSignals.ts) is a real action, not decoration.
          retryMission(mission.id);
          toast(t('cockpit.toast.retried', { name: mission.title }), 'success');
          break;
        case 'promote': {
          const full = activeMissions.find((m) => m.id === mission.id);
          void addMission({
            title: `${mission.title} · ${t('cockpit.action.promotedSuffix')}`,
            agentTask: full?.agentTask ?? mission.title,
            repo: '.',
            worktree: '',
            modelLabel: nextModelTierLabel(mission.model),
            orchestrator: false,
          });
          toast(t('cockpit.toast.promoted', { name: mission.title }), 'success');
          break;
        }
        default:
          break;
      }
    },
    [findFleetProject, switchToProjectIfNeeded, interveneMission, approveMission, setSelectedMissionId, activeMissions, addMission, retryMission, toast, t, blockedApproveIds],
  );

  /** Question-relay answer flow for the manager rail's 'question' signal
   *  bubbles (managerSignals.ts) — traces the EXACT same real path as
   *  AttentionInbox.tsx's handleAnswer: deliver the answer to the running
   *  mission (interveneMission), then persist it as a decision neuron +
   *  mission.answered journal event (recordMissionAnswer) so an identical
   *  future question auto-answers. Cross-project honest via the same
   *  switchToProjectIfNeeded gate every other handler above uses. */
  const handleSignalAnswer = useCallback(
    (mission: FleetMission, projectId: string, question: string, answer: string) => {
      const project = findFleetProject(mission.id);
      if (!project) return;
      if (switchToProjectIfNeeded(project)) return;
      interveneMission(mission.id, answer);
      void recordMissionAnswer({ missionId: mission.id, question, answer, projectId, actor: 'user' });
    },
    [findFleetProject, switchToProjectIfNeeded, interveneMission],
  );

  const handleRequestRecoveryPlan = useCallback(
    (objective: Objective) => {
      setManagerDraft(t('cockpit.manager.recoveryOrder', { title: objective.title }));
    },
    [t],
  );

  const handleHoverObjective = useCallback((objective: Objective | null) => {
    setHighlightProjectId(objective?.projectId ?? null);
  }, []);

  // ── QA B16: KPI tile click targets (the credits tile is B1's separate
  //    scope — see AccountChip.tsx). Every handler below drives a REAL
  //    existing primitive, never a fabricated destination. ──────────────

  /** "Décisions" — opens the single most urgent mission across the fleet
   *  (same ranking the urgent cards themselves use), or does nothing when
   *  there genuinely are none (honest no-op, matches the météo phrase
   *  already showing "0" in that case). */
  const handleDecisionsKpiClick = useCallback(() => {
    if (ranked.length === 0) return;
    handleOpenMission(ranked[0]!.mission.id);
  }, [ranked, handleOpenMission]);

  /** "Agents" — briefly glows every running mission card (the grid has no
   *  separate filter view to switch to; a highlight is the real, honest
   *  equivalent using the glow mechanism CapObjectives' hover already
   *  drives via highlightIds above). */
  const handleAgentsKpiClick = useCallback(() => {
    setRunningPulseActive(true);
    setTimeout(() => setRunningPulseActive(false), JUST_MERGED_DISPLAY_MS);
  }, []);

  /** "Mergées" — scrolls to and flashes the real FLUX activity ticker
   *  (FluxFooter, id="flux-footer"). GlobalFeed.tsx's standalone history
   *  page is orphaned/unrouted (see FluxFooter.tsx's doc comment) — never
   *  navigating to a page that isn't actually reachable. Honest no-op when
   *  the ticker itself is empty (FluxFooter renders null with no activity). */
  const handleMergedKpiClick = useCallback(() => {
    const el = document.getElementById('flux-footer');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    el.classList.add('focus-flash');
    setTimeout(() => el.classList.remove('focus-flash'), 1400);
  }, []);

  /** "Brain" — real space navigation, same bus event every other
   *  nav:navigateSpace producer in the app uses. */
  const handleBrainKpiClick = useCallback(() => {
    emit('nav:navigateSpace', 'brain');
  }, []);

  // Perf audit 2026-08-15 (item 3): these five were inline arrow functions
  // written directly in the CockpitLeftRail/ManagerOverlay JSX below — a new
  // function identity every single Cockpit render, which would silently
  // defeat wrapping those two components in React.memo (a memoized
  // component still re-renders whenever ANY prop's reference changes, and
  // an inline `() => ...}` literal is a new reference every render by
  // definition). Extracted to stable useCallback identities so the memo
  // wrap below actually has a chance to bail out when the rest of this
  // component's re-render was for an unrelated reason (see
  // Cockpit.rerenderChurn.test.tsx for the measured effect).
  const handleSelectProject = useCallback((id: string) => setHighlightProjectId(id), []);
  const handleApprovePlan = useCallback((id: string) => { executePlan(id).catch(() => {}); }, [executePlan]);
  const handleRejectPlan = useCallback(
    (id: string) => { rejectPlan(id).catch((error: unknown) => logPlanActionFailure('rejectPlan', id, error)); },
    [rejectPlan],
  );
  const handleRevisePlan = useCallback(
    (id: string) => { revisePlan(id).catch((error: unknown) => logPlanActionFailure('revisePlan', id, error)); },
    [revisePlan],
  );
  const handleStepClick = useCallback((s: OrchestratorPlanStep) => toast(`Step ${s.id}`, 'info'), [toast]);
  const handleDraftConsumed = useCallback(() => setManagerDraft(null), []);

  return (
    <div data-testid="cockpit-fullbleed-root" style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
      {/* P1-3 full-bleed redesign: the canvas fills the ENTIRE page edge to
          edge — no top Bandeau bar, no 2-column split (see this file's
          header comment). Everything else below floats OVER it as
          absolutely-positioned overlays anchored to THIS relative root. */}
      {cockpitMode === 'construction' && (
        <CanvasView
          projects={fleet.projects}
          highlightIds={highlightIds}
          justMergedId={justMergedId}
          forceApproveIds={blockedApproveIds}
          onOpenMission={handleOpenMission}
          onUrgentAction={handleUrgentAction}
          onOpenLibrary={onOpenLibrary}
          scheduledOverride={scheduledOverride}
          missionLoopMetaOverride={missionLoopMetaOverride}
          // fix/canvas-overlay-occlusion — same live width FluxFooter's
          // ticker already reserves below (P2-19/P2a, this file's own
          // comment on that div) — the canvas itself now reserves the
          // IDENTICAL space, so nothing it renders (toolbar controls,
          // mission-card action rows, zone content) can ever paint under
          // the docked ManagerOverlay, at any width state (normal/expanded/
          // collapsed/drag-resized) or window size — this value already
          // tracks all of those live via 'manager:overlayWidthChange'.
          reservedRightPx={managerOverlayWidth}
        />
      )}
      {cockpitMode === 'command' && (
        // Rail-overlap fix (real user report, 2026-08-14): this grid used to
        // span `inset: 0`, starting at the container's literal left edge —
        // the floating CockpitLeftRail (`left: 16`, 40px icons, zIndex 40)
        // then painted directly on top of this grid's own leftmost content,
        // cutting project names/status text off mid-word ("…ounce — 0
        // mission(s)", "…tive plans."). `left` now reserves
        // COCKPIT_LEFT_RAIL_RESERVED_LEFT_PX instead of 0 — the real
        // DOM-space equivalent of the gutter cameraInsets.ts already
        // reserves for this SAME rail on the canvas side.
        <div data-testid="cockpit-command-grid" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: COCKPIT_LEFT_RAIL_RESERVED_LEFT_PX, display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 8, padding: 8, overflow: 'hidden', zIndex: 1 }}>
          <div data-testid="cockpit-command-fleet" style={{ overflow: 'auto', background: 'rgba(10,10,16,0.5)', borderRadius: 8, padding: 12 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 14, opacity: 0.7 }}>Fleet Map</h3>
            {fleet.projects.length === 0 ? <p style={{ opacity: 0.5 }}>No projects registered.</p> : fleet.projects.map((p) => (
              <div key={p.projectId} style={{ padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <strong>{p.name || p.projectId}</strong> — {p.missions.length} mission(s)
              </div>
            ))}
          </div>
          <div data-testid="cockpit-command-decisions" style={{ overflow: 'auto', background: 'rgba(10,10,16,0.5)', borderRadius: 8, padding: 12 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 14, opacity: 0.7 }}>Decision Center</h3>
            {ranked.length === 0 ? <p style={{ opacity: 0.5 }}>No pending decisions.</p> : ranked.slice(0, 5).map(({ mission }) => (
              <div key={mission.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <strong>{mission.title}</strong> — {mission.status}
              </div>
            ))}
          </div>
          <div data-testid="cockpit-command-orchestrator" style={{ overflow: 'auto', background: 'rgba(10,10,16,0.5)', borderRadius: 8, padding: 12 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 14, opacity: 0.7 }}>Orchestrator Tree</h3>
            {orchestrators.length === 0 ? <p style={{ opacity: 0.5 }}>No active plans.</p> : orchestrators.map((o) => (
              <div key={o.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <strong>{o.name}</strong> — {o.status} ({o.steps.length} steps)
              </div>
            ))}
          </div>
          <div data-testid="cockpit-command-livefeed" style={{ overflow: 'auto', background: 'rgba(10,10,16,0.5)', borderRadius: 8, padding: 12 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 14, opacity: 0.7 }}>Live Feed</h3>
            <FluxFooter />
          </div>
        </div>
      )}
      {/* Cockpit mode toggle — 2026-08-09 real-user request: the floating
          mid-screen pill is REMOVED. 2026-08-09's follow-up (canvas top
          toolbar's `canvas-toolbar-cockpit-mode`) turned out to be a
          severity-1 usability trap: that toolbar only renders in
          Construction mode (it's part of <CanvasView>, above), so it was
          the ONLY toggle affordance and Command mode had no way back at
          all — fixed 2026-08-14 by moving the real, guaranteed-reachable
          toggle into CockpitLeftRail below (renders unconditionally in
          BOTH modes; see that file's own `RailIconButton id="mode"`
          comment). The canvas toolbar button stays mounted as a
          Construction-mode convenience shortcut, reading/writing the same
          persisted `lazy.cockpitMode` via the same `cockpit:modeChange` bus
          event. Keyboard shortcut C still works (registered in the effect
          above), and TopNav.tsx's Cockpit pill resets to Construction on a
          re-click (`cockpit:resetMode`, effect above). */}

      {/* Far-left floating round-icon rail (KPIs incl. the météo greeting +
          KpiGroup's 5 tiles formerly in Bandeau, Fleet Map, Objectives/Cap
          formerly the full-width CapObjectives band, Decisions, Budget).
          See CockpitLeftRail.tsx's header comment for the full content
          mapping — nothing from the old Bandeau/CapObjectives/stacked-panel
          block was dropped, it all moved into a popover here. */}
      <CockpitLeftRail
        projects={fleet.projects}
        pills={pills}
        pendingDecisions={pendingDecisions}
        // Same `ranked` array `pendingDecisions` is `.length`-derived from —
        // see this file's own doc comment above. The Decisions popover
        // renders these verbatim (UrgentMissionCard, same component/props
        // the AGENTS zone already uses), wired to the SAME real handlers
        // ProjectRow.tsx uses, so an action taken from the popover behaves
        // identically to the same action taken from the canvas.
        urgentMissions={ranked}
        onOpenMission={handleOpenMission}
        onUrgentAction={handleUrgentAction}
        forceApproveIds={blockedApproveIds}
        onReportClick={onOpenReport}
        cockpitMode={cockpitMode}
        onToggleMode={toggleCockpitMode}
        onDecisionsKpiClick={handleDecisionsKpiClick}
        onAgentsKpiClick={handleAgentsKpiClick}
        onMergedKpiClick={handleMergedKpiClick}
        onBrainKpiClick={handleBrainKpiClick}
        onRequestRecoveryPlan={handleRequestRecoveryPlan}
        onHoverObjective={handleHoverObjective}
        objectivesOverride={objectivesOverride}
        fleetMapProjects={fleetMapProjects}
        onSelectProject={handleSelectProject}
        orchestrators={orchestrators}
        // Best-effort: executePlan's own body already routes every failure
        // branch (deferred-action replay, materialization, execute_plan
        // itself) through revertToPendingWithError, which both toasts AND
        // reverts the card to 'pending' with a visible errorMessage — this
        // outer catch only guards the narrow pre-materialization window
        // (resolveOrchestratorRoot/getOrchestrator) against becoming an
        // unhandled promise rejection, see agentsStore.tsx::executePlan.
        onApprovePlan={handleApprovePlan}
        onRejectPlan={handleRejectPlan}
        onRevisePlan={handleRevisePlan}
        onStepClick={handleStepClick}
        budgetSpentCents={budget.spentCents}
        budgetLimitCents={budget.limitCents}
        activeGraphRun={activeGraphRun}
        activeGraphSnapshot={activeGraphSnapshot}
      />

      {/* Right-edge floating LazyManager overlay — ALWAYS visible (design
          spec: never fully hidden), collapsible to a thin persistent tab
          that re-expands it. Replaces the old fixed 460px right column; see
          ManagerOverlay.tsx's header comment for the collapse mechanism and
          the compact autonomy control it now carries (fixes friction F5). */}
      <ManagerOverlay
        projects={fleet.projects}
        draftPrefill={managerDraft}
        onDraftConsumed={handleDraftConsumed}
        messagesOverride={managerMessagesOverride}
        signals={signals}
        onAnswerSignal={handleSignalAnswer}
        onSignalAction={handleUrgentAction}
        autonomyLevel={autonomyLevel}
        onAutonomyChange={setAutonomyLevel}
      />

      {/* Bottom FLUX ticker — kept as a thin floating overlay (design spec
          §1's "fold into left or keep as thin overlay") rather than a
          flex-stacked footer, now that CanvasView owns the whole page. A
          semi-opaque glass backing keeps it legible over canvas content;
          FluxFooter itself renders null when there's no real activity.

          P2-19 fix: `right` used to be 0, spanning the FULL page width —
          including the space ManagerOverlay floats over on the right edge.
          That overlay paints on top (zIndex 40 > this bar's 30), so the
          ticker's own rightmost entries rendered directly UNDERNEATH its
          opaque glass panel and were simply invisible/cut off there. Now
          stops short of ManagerOverlay's own footprint (its live width +
          right offset — tracked via manager:overlayWidthChange bus event),
          so the two overlays never share the same screen region regardless
          of the manager panel's collapsed/expanded state. P2a: now DYNAMIC
          — reserves only the actual current width, not the worst-case max. */}
      <div
        style={{
          position: 'absolute',
          left: 64,
          right: managerOverlayWidth,
          bottom: 12,
          zIndex: 30,
          background: 'rgba(20,20,28,0.88)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderRadius: 999,
          border: '1px solid var(--color-border)',
          overflow: 'hidden',
          marginRight: 16,
        }}
      >
        <FluxFooter />
      </div>
    </div>
  );
}
