/* AgentsSpace — Mission Control + Bibliotheque space component */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AgentAnimations,
  SpaceSubHeader,
  MissionDetailDrawer,
  NewMissionModal,
  useAgentsStore,
  Cockpit,
} from '../components/agents';
import type { SpaceTab } from '../components/agents/SpaceSubHeader';
import { useAgentsUiContext } from '../components/agents/agentsUiContext';
import { AgentLibrary } from '../components/agents/library/AgentLibrary';
import { ProjectReportPage } from '../components/agents/report';
import { CockpitRailPopover, type PopoverAnchorRect } from '../components/agents/cockpit/CockpitRailPopover';
import type { LazyAgent } from '../lib/agents/agentDef';
import { AGENT_COLOR_MAP } from '../lib/agents/agentDef';
import { compileAgent } from '../lib/agents/compile';
import { listAgents } from '../lib/agents/agentsStorage';
import { invoke } from '@tauri-apps/api/core';
import { useToast } from '../components/ui';
import { useI18n } from '../i18n';
import { getEngineReadiness, engineReasonKey, isAnyEngineUsable, type EngineReadinessReason } from '../lib/models/entitlement';
import { emit, on } from '../lib/bus';
import type { MissionFocusRequest, MissionCrossProjectLoaded } from '../lib/bus';
import { useAppContext } from '../app/AppContext';
import { projectIdFromRoot } from '../lib/journal/projectId';
import type { Mission } from '../lib/agents/types';

// ── Helper: resolve project root ──────────────────────────────────

async function getProjectRoot(): Promise<string> {
  try {
    return await invoke<string>('get_project_root');
  } catch {
    return '.';
  }
}

// ── Engine readiness banner ─────────────────────────────────────────
//
// Shown at the top of Mission Control whenever the selected engine cannot
// run right now (CLI not detected, no BYOK key, Pro inactive, or Pro
// credits exhausted). Reuses getEngineReadiness() — the same synchronous
// readiness check every other launch surface (mission modal, composer,
// model picker) already calls — so the cockpit surfaces a clear,
// non-broken "no-credit / not-configured" state instead of a Kanban board
// that silently never fills up. Display only: no entitlement logic lives
// here.

function EngineNotReadyBanner({ reason }: { reason: EngineReadinessReason }) {
  const { t } = useI18n();
  const isProReason = reason === 'pro-inactive' || reason === 'pro-no-credits';

  return (
    <div
      data-testid="cockpit-engine-banner"
      role="status"
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '8px 20px',
        background: 'rgba(251,185,36,0.08)',
        borderBottom: '1px solid rgba(251,185,36,0.25)',
      }}
    >
      <span style={{ fontSize: 12, color: '#FBB924', fontWeight: 500 }}>
        {t(engineReasonKey(reason))}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {/* LazyPro is ALWAYS offered when nothing can run — a key/CLI gap is
            fixed in Models, but Pro is the zero-setup path (plan + credits or
            a top-up). Real-user feedback 2026-08-03. */}
        <button
          onClick={() => emit('nav:navigateSpace', 'account')}
          style={{
            flexShrink: 0,
            padding: '4px 12px',
            borderRadius: 6,
            border: '1px solid rgba(246,169,69,0.45)',
            background: 'rgba(246,169,69,0.12)',
            color: '#F6A945',
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {t(isProReason ? 'engine.preflight.goPro' : 'engine.preflight.proFallback')}
        </button>
        {!isProReason && (
          <button
            onClick={() => emit('nav:navigateSpace', 'models')}
            style={{
              flexShrink: 0,
              padding: '4px 12px',
              borderRadius: 6,
              border: '1px solid rgba(124,92,255,0.4)',
              background: 'rgba(124,92,255,0.12)',
              color: '#C4B5FD',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {t('engine.preflight.configure')}
          </button>
        )}
      </div>
    </div>
  );
}

// W-PARCHEMIN: fallback anchor for the report popover when 'report:open'
// fires with no clickable element to measure (a bus-triggered deep link, not
// a rail-icon click) — see AgentsSpaceInner's own comment above.
const REPORT_POPOVER_FALLBACK_ANCHOR: PopoverAnchorRect = { top: 96, bottom: 136, left: 16, right: 56 };

// ── Inner component (needs store + ui context) ────────────────────

function AgentsSpaceInner() {
  const { t } = useI18n();
  const { missions, selectedMissionId, setSelectedMissionId, addMission } = useAgentsStore();
  const runningCount = missions.filter(m => m.status === 'running').length;
  // Synchronous, safe-on-every-render per entitlement.ts's own contract —
  // drives the "no-credit / not-configured" cockpit banner below. The banner
  // ONLY shows when NO engine at all can run: a user holding several working
  // engines (Claude CLI + a BYOK key, etc.) must never be nagged about one
  // broken family — the launch pipeline already falls back to a working one.
  const engineReadiness = getEngineReadiness();
  const showEngineBanner = !engineReadiness.ready && !isAnyEngineUsable();
  const { newMissionPending, clearNewMissionPending } = useAgentsUiContext();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<SpaceTab>('mission-control');
  const [isModalOpen, setIsModalOpen] = useState(false);

  // ── Agent Canvas W8e: per-project « Rapport » page ──────────────────
  // Integration choice: SpaceTab (mission-control|bibliotheque) is owned by
  // SpaceSubHeader.tsx — not this wave's file — so a 3rd tab value isn't an
  // option without editing that component. Instead the Rapport page is a
  // SEPARATE overlay (same "never a tree swap" pattern MissionDetailDrawer
  // already uses below: Cockpit/AgentLibrary stay mounted underneath),
  // triggered either by CockpitLeftRail's 'report' icon (mission-control tab
  // only) or by the 'report:open' bus event so other surfaces can deep-link
  // into it later (see bus.ts's doc comment on that event: LazyManager's
  // `open_report` action, a canvas zone-header link, a Bandeau KPI click).
  //
  // W-PARCHEMIN: this used to be a `position:fixed inset:0` full-page div.
  // It now opens in a CockpitRailPopover "mini-parchemin" (same shell every
  // other CockpitLeftRail icon uses, just wider — see CockpitRailPopover.tsx)
  // anchored to whichever icon triggered it. The rail-icon path forwards its
  // own getBoundingClientRect() through onOpenReport below; the bus path has
  // no clickable element to measure, so it falls back to
  // REPORT_POPOVER_FALLBACK_ANCHOR (roughly where the rail's 'report' icon
  // sits) — usePopoverPosition clamps to the viewport regardless, so a
  // slightly-off fallback anchor never renders off-screen.
  const { projectRoot, openProjects } = useAppContext();
  const activeProjectId = useMemo(() => projectIdFromRoot(projectRoot), [projectRoot]);
  const [reportProjectId, setReportProjectId] = useState<string | null>(null);
  const [reportAnchorRect, setReportAnchorRect] = useState<PopoverAnchorRect | null>(null);
  // Founder bug fix (2026-07-22): the 'report' rail icon's own toggle button
  // element — forwarded to CockpitRailPopover as `triggerRef` so re-clicking
  // it doesn't first get treated as an outside click (which would close the
  // popover, then this component's own click handler would immediately
  // reopen it — see CockpitRailPopover.tsx/CockpitLeftRail.tsx's doc
  // comments). Left null for the bus-triggered deep-link path below, which
  // has no associated button.
  const reportTriggerRef = useRef<HTMLButtonElement | null>(null);

  function closeReport() {
    setReportProjectId(null);
    setReportAnchorRect(null);
  }

  // Rail-icon path: re-clicking the icon while it's already showing the
  // active project's report closes it instead of just re-setting the same
  // values (see this component's `reportTriggerRef` doc comment above).
  // Navigating to a DIFFERENT project's report from inside the popover
  // itself (onSelectProject below) still lets a subsequent click on the
  // rail icon jump back to the active project's own report, unchanged.
  function handleOpenReport(anchorRect: PopoverAnchorRect, triggerEl: HTMLButtonElement) {
    if (reportProjectId === activeProjectId) {
      closeReport();
      return;
    }
    reportTriggerRef.current = triggerEl;
    setReportProjectId(activeProjectId);
    setReportAnchorRect(anchorRect);
  }

  useEffect(
    () => on('report:open', (payload) => {
      reportTriggerRef.current = null;
      setReportProjectId(payload.projectId ?? activeProjectId);
      setReportAnchorRect(REPORT_POPOVER_FALLBACK_ANCHOR);
    }),
    [activeProjectId],
  );

  const reportProjectRoot = useMemo(() => {
    if (!reportProjectId) return projectRoot;
    return openProjects.find((p) => projectIdFromRoot(p.root) === reportProjectId)?.root ?? projectRoot;
  }, [reportProjectId, openProjects, projectRoot]);
  // Ref to handleRunAgent so the DnD event listener can call it without stale closure
  const handleRunAgentRef = useRef<((agent: LazyAgent, task: string) => Promise<void>) | null>(null);

  // Open modal when palette triggers "Nouvelle mission"
  useEffect(() => {
    if (newMissionPending) {
      setIsModalOpen(true); // eslint-disable-line react-hooks/set-state-in-effect
      clearNewMissionPending();
    }
  }, [newMissionPending, clearNewMissionPending]);

  // Dead-click fix (real user report, 2026-08-14 — the manager rail's
  // fleet-signal "Diff" button "does nothing"): `selectedMissionId` can be
  // set by a caller that only knows about a mission through the
  // CROSS-PROJECT fleet read-model (useFleetMissions' journal poll, no
  // project filter — e.g. Cockpit.tsx's handleUrgentAction, the producer
  // for both the manager rail's signal bubbles AND the canvas node action
  // row), while `missions` right below is agentsStore's own
  // SINGLE-active-project list. fleetMissions.ts's own module doc comment
  // documents the resulting gap verbatim: agentsStore's mission list "is
  // not re-loaded when the active project changes after AgentsSpace first
  // mounts".
  //
  // Fixing the CAUSE, not just the message (round 2): rather than only
  // waiting out that gap and eventually apologising, Cockpit.tsx's
  // handleUrgentAction now ALSO actively re-fetches the mission from the
  // SAME real source the fleet signal came from (loadMissionsFromJournal)
  // and broadcasts it via 'mission:crossProjectLoaded' the moment it
  // resolves (see bus.ts's own doc comment) — a full, real Mission, not a
  // degraded projection. `crossProjectMissions` below is a small additive
  // cache for exactly those broadcasts; it never touches agentsStore's own
  // `missions` (that list stays correctly scoped to the active project).
  // `selectedMission` checks both, so the drawer opens with the real diff
  // the instant the fetch lands — normally well under a second, not a
  // fixed multi-second wait.
  const [crossProjectMissions, setCrossProjectMissions] = useState<Record<string, Mission>>({});
  useEffect(
    () =>
      on('mission:crossProjectLoaded', ({ missionId, mission }: MissionCrossProjectLoaded) => {
        setCrossProjectMissions((prev) => ({ ...prev, [missionId]: mission }));
      }),
    [],
  );
  const selectedMission = selectedMissionId
    ? missions.find((m) => m.id === selectedMissionId) ?? crossProjectMissions[selectedMissionId] ?? null
    : null;

  // Last-resort path ONLY (see above): a mission the active fetch genuinely
  // could not find (deleted, project no longer on disk, journal read
  // failure) still needs an honest, visible outcome rather than silence —
  // NEVER DEGRADE IN SILENCE. The grace period covers the fetch's own
  // real round-trip time before concluding it is genuinely dead.
  const DEAD_SELECTION_GRACE_MS = 4000;
  useEffect(() => {
    if (!selectedMissionId || selectedMission) return;
    const timer = setTimeout(() => {
      toast(t('cockpit.toast.missionUnavailable', { id: selectedMissionId }), 'error');
      setSelectedMissionId(null);
    }, DEAD_SELECTION_GRACE_MS);
    return () => clearTimeout(timer);
  }, [selectedMissionId, selectedMission, toast, setSelectedMissionId, t]);

  // QA B14: AgentsSpaceInner is mounted for the entire lifetime of this
  // space, so this subscriber is already registered before the Cockpit
  // urgent card that emits mission:focusSection can even be clicked — that
  // ordering guarantee is what makes the bus event usable here at all
  // (MissionDetailDrawer itself only mounts AFTER the same click, via
  // setSelectedMissionId below, so a subscriber living there would miss the
  // very first emit). See Cockpit.tsx's handleUrgentAction for the producer.
  const [pendingFocus, setPendingFocus] = useState<MissionFocusRequest | null>(null);
  useEffect(() => on('mission:focusSection', setPendingFocus), []);
  const focusSection =
    pendingFocus && selectedMission && pendingFocus.missionId === selectedMission.id
      ? pendingFocus.section
      : null;

  /** Launch an agent as a mission:
   *  1. Compile agent to .claude/agents/<name>.md (creates the subagent file).
   *  2. Create a Mission with the agent's metadata.
   *  3. The runtime passes `--agent <name>` via the task prompt.
   *  4. Switch to Mission Control to see it run.
   */
  const handleRunAgent = useCallback(async (agent: LazyAgent, task: string) => {
    // Compile first (creates the agent file so Claude Code can pick it up)
    try {
      const projectRoot = await getProjectRoot();
      await compileAgent(agent, projectRoot, 'claude-code');
    } catch {
      // Non-fatal: the agent may already be compiled or we're in web mode
    }

    // Derive model label
    const modelLabels: Record<string, string> = {
      haiku: 'Haiku 4.5',
      sonnet: 'Sonnet 4.6',
      opus: 'Opus 4.8',
      inherit: 'Sonnet 4.6',
    };
    const modelLabel = modelLabels[agent.modelTier] ?? 'Sonnet 4.6';

    // Build agent task prompt. The agentName field routes the run
    // to the named sub-agent definition in .claude/agents/.
    const agentTask = task;

    // Color from the agent (used as worktree label prefix)
    const _colorHex = AGENT_COLOR_MAP[agent.color] ?? '#7C5CFF';
    void _colorHex;

    // Map legacy 'bypassPermissions' to the canonical 'full' value; pass
    // other modes through directly; undefined falls back to the safe default.
    const rawMode = agent.permissionMode;
    const permissionMode =
      rawMode === 'bypassPermissions' ? ('full' as const)
      : rawMode === 'default' || rawMode === undefined ? undefined
      : rawMode;

    addMission({
      title: `${agent.displayName || agent.name}: ${task.slice(0, 60)}${task.length > 60 ? '…' : ''}`,
      description: agent.description,
      repo: '.',
      worktree: `agent-lib/${agent.name}`,
      modelLabel,
      mode: 'agent',
      orchestrator: false,
      agentName: agent.name,
      agentTask,
      permissionMode,
    });

    toast(t('agents.missionLaunched', { name: agent.displayName || agent.name }), 'success');
    // Switch to Mission Control to watch it run
    setActiveTab('mission-control');
  }, [addMission, toast, t]);

  // Keep ref up to date (useLayoutEffect avoids updating during render)
  useLayoutEffect(() => {
    handleRunAgentRef.current = handleRunAgent;
  });

  // Listen for DnD drops from FileExplorer (lazy:agent-dropped CustomEvent)
  useEffect(() => {
    async function onAgentDropped(e: Event) {
      const evt = e as CustomEvent<{
        agentId: string;
        agentName: string;
        targetPath: string;
        isDir: boolean;
      }>;
      const { agentId, targetPath, isDir } = evt.detail;

      // Find the agent by id from storage
      let agent: LazyAgent | null = null;
      try {
        const stored = await listAgents();
        const found = stored.find((s) => s.agent.id === agentId);
        if (found) agent = found.agent;
      } catch {
        // web mode fallback — skip
        return;
      }

      if (!agent || !handleRunAgentRef.current) return;

      // Build context-aware task prompt
      const kind = isDir ? 'dossier' : 'fichier';
      const task = `Work on the ${kind} ${targetPath}: ${agent.description.split('.')[0] ?? 'complete the task'}.`;

      await handleRunAgentRef.current(agent, task);
    }

    window.addEventListener('lazy:agent-dropped', onAgentDropped);
    return () => window.removeEventListener('lazy:agent-dropped', onAgentDropped);
  }, []); // empty deps — stable via ref

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0,
      }}
    >
      <AgentAnimations />

      {/* The redesigned Cockpit (D2/D1) replaces the old SpaceSubHeader +
          9-view switcher as the default mission-control UI — TopNav is now
          the shared header (wave 1), so mission-control renders full-bleed
          with no sub-header of its own. The old view-switcher UI (and its
          9 underlying view components) stays reachable only through the
          Bibliothèque tab's own SpaceSubHeader below, which still needs a
          way back — the view-related props are inert there since that
          switcher only ever renders while `activeTab === 'mission-control'`
          (see SpaceSubHeader.tsx), a state this space no longer reaches. */}
      {activeTab === 'bibliotheque' && (
        <SpaceSubHeader
          activeView="kanban"
          onViewChange={() => {}}
          onNewMission={() => setIsModalOpen(true)}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          activeCount={runningCount}
        />
      )}

      {activeTab === 'mission-control' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
          {showEngineBanner && engineReadiness.reason && (
            <EngineNotReadyBanner reason={engineReadiness.reason} />
          )}
          {/* W-CHROME: the old "report-trigger-bar" strip that lived here
              (a full-width row below TopNav existing ONLY to host the
              « Rapport » button, top-right) is gone — that trigger is now
              CockpitLeftRail's 'report' round icon, above 'kpis'. Cockpit
              fills the freed vertical space directly (full-bleed root
              starts right at the nav bottom); onOpenReport is the exact
              same real handler the old button called, now also given the
              icon's own rect (W-PARCHEMIN) to anchor the report popover. */}
          <Cockpit
            onOpenLibrary={() => setActiveTab('bibliotheque')}
            onOpenReport={handleOpenReport}
          />
        </div>
      )}

      {activeTab === 'bibliotheque' && (
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0 }}>
          <AgentLibrary onRunAgent={handleRunAgent} />
        </div>
      )}

      <NewMissionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
      />

      {/* W8e — Rapport overlay, same "never a tree swap" convention as
          MissionDetailDrawer below: Cockpit/AgentLibrary stay mounted
          underneath. W-PARCHEMIN: now a CockpitRailPopover "mini-parchemin"
          (portaled to document.body, its own zIndex 2200) instead of a
          full-page div — wider than the other rail icons' popovers
          (ArtifactOutputModal.tsx's own `min(720px, 92vw)` / `80vh`
          convention) to fit the report's KPI strip + mission cards.
          data-testid stays "project-report-overlay" (dataTestId override) —
          e2e depends on it. Opening a mission from a report card
          (onOpenMission below) closes the report instead of stacking a
          drawer under/over it — MissionDetailDrawer's own overlay sits at
          zIndex 40, well below this popover's 2200, so leaving both mounted
          would render the mission drawer invisibly behind the report. */}
      {reportProjectId !== null && reportAnchorRect && (
        <CockpitRailPopover
          title={t('report.trigger.label')}
          anchorRect={reportAnchorRect}
          onClose={closeReport}
          testId="report"
          dataTestId="project-report-overlay"
          width="min(720px, 92vw)"
          maxHeight="80vh"
          triggerRef={reportTriggerRef}
        >
          <ProjectReportPage
            projectId={reportProjectId}
            projectRoot={reportProjectRoot}
            openProjects={openProjects}
            onSelectProject={setReportProjectId}
            onOpenMission={(missionId) => {
              closeReport();
              setSelectedMissionId(missionId);
            }}
            onClose={closeReport}
            layout="popover"
          />
        </CockpitRailPopover>
      )}

      {/* D13/D14 — MissionDetail as a drawer overlay ON TOP of the content
          above (never a tree swap), so Cockpit stays mounted underneath. */}
      {selectedMission && (
        <MissionDetailDrawer
          mission={selectedMission}
          onClose={() => setSelectedMissionId(null)}
          focusSection={focusSection}
          onFocusHandled={() => setPendingFocus(null)}
        />
      )}
    </div>
  );
}

// ── Exported component — wraps with store provider ────────────────

export function AgentsSpace() {
  return <AgentsSpaceInner />;
}
