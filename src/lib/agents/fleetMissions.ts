/* fleetMissions.ts — cross-project mission read-model (D3).

   Polls `journal_missions_current` (Tauri invoke, NO project filter — same
   call/precedent as SpacesRail's useRunningMissionCounts) every ~2.5s and
   groups the resulting rows by project, deriving a coarse pipeline stage
   per mission (see fleetStage.ts) for the Cockpit/Code redesign's
   per-project grid.

   For the currently ACTIVE project, live agentsStore missions (streaming,
   no polling lag) are merged over the journal snapshot when an
   AgentsStoreProvider ancestor exists (i.e. AgentsSpace has been visited
   this session) — see useAgentsStoreOptional's doc comment on that
   optional-outside-the-provider contract. This is a
   best-effort merge: agentsStore's own mission list does not carry a
   project id and is not re-loaded when the active project changes after
   AgentsSpace first mounts (a pre-existing gap, not fixed here — see
   code-shell-map.md §10), so the merge can show stale missions for a
   moment right after switching projects. The journal snapshot for that
   project is still polled underneath and takes back over once agentsStore
   itself catches up.

   Web (non-Tauri): always returns an empty project list — no mock data
   (repo convention: real data or an honest empty state).
*/

import { useEffect, useMemo, useState } from 'react';
import { useAppContext } from '../../app/AppContext.js';
import { useAgentsStoreMissionsOptional } from '../../components/agents/agentsStore.js';
import { projectIdFromRoot } from '../journal/projectId.js';
import { basename } from '../paths.js';
import type { ApprovalMode, DiffFile, JudgeVerdict, LoopConfig, Mission } from './types.js';
import { deriveFleetStage, isUrgentMission, type FleetStage } from './fleetStage.js';
import { extractPendingQuestionText } from './missionQuestion.js';
import { ensureApprovalModesLoaded, fleetApprovalModes, subscribeApprovalModes } from './approvalMode.js';
import { subscribeJournalMissions, type JournalMissionCurrentRow } from './journalMissionsFeed.js';

export interface FleetMission {
  id: string;
  title: string;
  status: Mission['status'];
  stage: FleetStage;
  liveAction?: string;
  model: string;
  progress?: number;
  worktree?: string;
  diffAdded?: number;
  diffRemoved?: number;
  /** Epoch ms this row was last updated in the journal, or `Date.now()` for
   *  a live (agentsStore-sourced) mission with no journal timestamp yet. */
  updatedMs: number;
  urgent: boolean;
  /**
   * Per-file write progress (Code space's D9 "who's working on this file"
   * signal — see fileActivity.ts). Not always populated: only managed-mode
   * missions currently set diffFiles[].inProgress reliably (see
   * code-codespace-map.md §3's open question) — an absent/empty array is a
   * real "no per-file signal", never a fabricated default.
   */
  diffFiles?: DiffFile[];
  /**
   * Human-readable reason the mission is in its current status (mirrors
   * Mission.statusReason) — surfaced by the Code space's failed-file banner.
   */
  statusReason?: string;
  /**
   * A pending ask_user question extracted from the mission's real
   * actionTimeline (missionQuestion.ts's extractPendingQuestionText) — the
   * Code space's honest stand-in for the design's "blocked" banner (there is
   * no MissionStatus === 'blocked' anywhere in the real data model; a
   * running mission genuinely waiting on the human is exactly this signal,
   * the same one AttentionInbox.tsx's 'question' kind is built on). Absent
   * when the mission has no open question.
   */
  pendingQuestion?: string;
  /** Mirrors Mission.contract?.scopePaths — drives the Code space's
   *  read-only "outside mission scope" file banner. Absent when the mission
   *  carries no contract (pre-T1.2 / demo missions) or no scope was set. */
  contractScopePaths?: string[];
  /** Mirrors Mission.paused (agentsStore's pauseMission/resumeMission flag,
   *  managed-mode only) — drives the Code space's live-write banner "⏸
   *  Pauser l'agent" / "▶ Reprendre l'agent" resume state (B18). A paused
   *  mission keeps status === 'running' (see agentsStore.tsx), so this is
   *  the only real signal distinguishing "actively writing" from "paused
   *  mid-write" for the same mission. */
  paused?: boolean;
  /**
   * QA B15 — mirrors Mission.judgeVerdict so the cockpit's urgent card can
   * reuse the shared approveGate.ts isJudgeRejected(mission) predicate
   * (same definition MissionDetailControls/MissionManagerAdvice use) to
   * decide whether a 'review' mission is actually a rejected verdict
   * awaiting a human call, not just "still evaluating". Absent for a
   * mission with no verdict yet.
   */
  judgeVerdict?: JudgeVerdict;
  /**
   * Agent Canvas (W1c, spec §4.2/§6) additive fields — mirror the matching
   * `Mission` fields verbatim, never re-derived. Populated by
   * `toFleetMission` below. Absent on every mission that predates the
   * canvas (loop engineering / orchestrator sub-missions / cost tracking
   * are all optional on `Mission` already), so no existing caller of
   * `FleetMission` is affected.
   */
  /** Loop configuration when this mission is a recurring loop's parent. */
  loopConfig?: LoopConfig;
  /** When this mission is a loop iteration, its parent loop mission id. */
  loopParentId?: string;
  /** Iteration number when this mission is a loop child (1-based). */
  loopIteration?: number;
  /** Parent mission id when this mission is an orchestrator sub-mission. */
  parentMissionId?: string;
  /** Mirrors Mission.cost (a formatted cost string, not a number). */
  cost?: string;
  /**
   * Brain visibility (brain-integration wave, spec: "les agents et le
   * lazymanager doivent interagir avec le lazybrain de manière optimale") —
   * mirror Mission.brainAdapted/brainCitations/tokensSaved verbatim, never
   * re-derived, so the Cockpit/Code grid can show a mission was actually
   * grounded by the brain-recall pre-run enrichment (runtime.ts's
   * 'brain-recall' launch phase + brainCitations.ts's captureBrainContext)
   * regardless of which launch path (user, chain-fired, manager
   * create_draft/launch_draft/launch_mission) produced it. Absent when the
   * mission predates these fields, or the recall found nothing / was
   * skipped (soft-fail by design) — never a fabricated `false`/`0`.
   */
  brainAdapted?: boolean;
  /** Count of Mission.brainCitations (its length) — a plain number is enough
   *  for a read-model badge; the citation ids/labels themselves stay on the
   *  full Mission object for MissionDetail. Absent (not 0) when the mission
   *  carries no citations at all. */
  brainCitationsCount?: number;
  /** Mirrors Mission.tokensSaved — an already-formatted label (e.g. "~1.2k
   *  tokens économisés"), not a raw number; see brainCitations.ts's
   *  formatTokenCount. */
  tokensSaved?: string;
  /** Mirrors Mission.archived (R13 — mission lifecycle) — the Agent Canvas
   *  reconciler filters an archived mission out of the live node set. */
  archived?: boolean;
  /**
   * Canvas attention-hierarchy wave 1 — mirrors Mission.originConversationId
   * verbatim (see that field's own doc comment in lib/agents/types.ts): the
   * ManagerConversationState id whose turn created this mission. Was already
   * stamped onto every manager-launched Mission (multi-conversation wave 1)
   * but never carried through `toFleetMission` below, so the Agent Canvas —
   * the ONE place a mission actually renders as a node — had no way to
   * attribute a mission to the conversation that launched it, despite the
   * per-conversation accent color (conversationColor.ts) already existing
   * for exactly this purpose. Absent for a mission launched outside the
   * manager (canvas "new mission" flows, loop iterations, chain-fired
   * launches, etc) — never fabricated.
   */
  originConversationId?: string;
  /** Named persona or specialized agent (e.g. "code-architect", "fastapi-reviewer"). */
  agentName?: string;
  /** Permission / autonomy mode (plan, acceptEdits, full). */
  permissionMode?: 'plan' | 'acceptEdits' | 'full';
  /** Structured plan steps for in-progress step visibility. */
  planSteps?: Mission['planSteps'];
  /** Mirrors Mission.botId — when set, this is a LazyBot run rendered as
   *  a bot node in the LazyBots zone, not as an agent mission node. */
  botId?: string;
  /**
   * Live collab (additive): true when this row was mirrored from a
   * teammate's fleet broadcast, not from the local journal. Absent on
   * every local mission. Remote cards are spectate-only.
   */
  remote?: boolean;
  /** Teammate who owns a remote mission — absent on local missions. */
  originUserId?: string;
  originUserName?: string;

  // ── P2 — shared session fields (additive, absent on pre-P2 missions) ──

  /** Session members for multi-owner lanes. Absent = solo (one owner). */
  sessionMembers?: Array<{ userId: string; name: string; role: 'owner' | 'collaborator' | 'spectator' }>;
  /** Who is paying for this mission's turns. Absent = the owner (BYOK). */
  sponsorUserId?: string;
  sponsorName?: string;
  /** Approximate cost in cents for this mission so far. Absent = unknown. */
  costCents?: number;
  /** Git worktree branch name (for 3-way sync awareness). */
  worktreeBranch?: string;
  /** Worktree HEAD commit short hash (for "2 versions" chip). */
  worktreeHead?: string;
}

export interface FleetProject {
  projectId: string;
  root: string;
  name: string;
  missions: FleetMission[];
  /**
   * W-MODES (approval modes) — this project's EFFECTIVE merge-approval mode
   * (approvalMode.ts's `getApprovalMode`: its own override when set, else
   * the global default). Additive read-model field so the UI wave can badge
   * a project's zone (e.g. the canvas digest / a project-row chip) without
   * re-reading the store directly. Optional/additive: only `useFleetMissions`
   * populates it (from approvalMode.ts's `getApprovalMode`) — a hand-built
   * FleetProject fixture elsewhere (tests, the canvas harness) is unaffected
   * and simply omits it, never a fabricated 'manual' on data that never
   * asked approvalMode.ts at all.
   */
  approvalMode?: ApprovalMode;
}

export interface UseFleetMissionsResult {
  projects: FleetProject[];
  loading: boolean;
  error: string | null;
}

function isMissionLike(value: unknown): value is Mission {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

function toFleetMission(mission: Mission, updatedMs: number): FleetMission {
  return {
    id: mission.id,
    title: mission.title,
    status: mission.status,
    stage: deriveFleetStage(mission),
    liveAction: mission.liveAction,
    model: mission.model,
    progress: mission.progress,
    worktree: mission.worktree,
    diffAdded: mission.diffAdded,
    diffRemoved: mission.diffRemoved,
    updatedMs,
    urgent: isUrgentMission(mission),
    diffFiles: mission.diffFiles,
    statusReason: mission.statusReason,
    pendingQuestion:
      mission.status === 'running' ? extractPendingQuestionText(mission) ?? undefined : undefined,
    contractScopePaths: mission.contract?.scopePaths,
    paused: mission.paused,
    judgeVerdict: mission.judgeVerdict,
    loopConfig: mission.loopConfig,
    loopParentId: mission.loopParentId,
    loopIteration: mission.loopIteration,
    parentMissionId: mission.parentMissionId,
    cost: mission.cost,
    brainAdapted: mission.brainAdapted,
    brainCitationsCount: mission.brainCitations && mission.brainCitations.length > 0 ? mission.brainCitations.length : undefined,
    tokensSaved: mission.tokensSaved,
    archived: mission.archived,
    originConversationId: mission.originConversationId,
    agentName: mission.agentName,
    permissionMode: mission.permissionMode,
    planSteps: mission.planSteps,
    botId: mission.botId,
  };
}

/**
 * Merge the active project's live (streaming) agentsStore missions OVER its
 * journal snapshot (D3: "prefer live agentsStore missions ... merged over
 * journal rows") — never a full replace. Exported and pure for direct unit
 * testing (see src/__tests__/fleetMissions.test.ts).
 *
 * Fixes two real regressions found in the live app (post-e2e fix wave):
 *
 *  - F11 (mission vanishes from the grid): the active project's branch used
 *    to REPLACE journalMissions outright with `liveStore.missions.map(...)`
 *    instead of merging. A mission that transitions out of agentsStore's own
 *    live tracking (e.g. running -> review, where the store stops actively
 *    streaming it) but is still present in the journal — the actual source
 *    of truth — vanished from the grid entirely, along with its urgent
 *    review card and its contribution to the agents KPI. This walks the
 *    journal list first (so every journal-known mission always keeps a slot)
 *    and only overlays a live mission's fresher fields on top by id.
 *
 *  - F4 (misattribution): agentsStore's own mission list carries no project
 *    id (see module doc comment above) — so a live mission that actually
 *    belongs to ANOTHER project (per `missionOwner`, built from the
 *    journal's own per-row project_id, the real source of truth for
 *    ownership) must never be duplicated into the active project's group.
 *    Only a mission with NO journal row anywhere (`missionOwner` has no
 *    entry for it — e.g. a [DEMO] dev-seed mission) is treated as
 *    legitimately local to the active project, since it exists nowhere else
 *    to attribute it to.
 *
 * Dedupe/merge is always keyed by mission id, NEVER by title — two distinct
 * missions can legitimately share the exact same title (see the M8/M9 case
 * this fixes: both titled "QA pricing — tests unitaires").
 */
export function mergeLiveMissions(
  journalMissions: readonly FleetMission[],
  liveMissions: readonly Mission[],
  activeProjectId: string,
  missionOwner: ReadonlyMap<string, string>,
): FleetMission[] {
  const eligibleLive = liveMissions.filter((m) => {
    const owner = missionOwner.get(m.id);
    return owner === undefined || owner === activeProjectId;
  });
  const liveById = new Map(eligibleLive.map((m) => [m.id, toFleetMission(m, Date.now())] as const));

  // Journal rows first — every mission the journal knows about always keeps
  // a slot, refreshed with the live version when one exists for it.
  const merged = journalMissions.map((jm) => liveById.get(jm.id) ?? jm);

  // Then any live mission with no journal row at all for this project
  // (dev-seed [DEMO] missions, or a brand-new mission the journal hasn't
  // flushed yet) — appended, never dropped.
  const journalIds = new Set(journalMissions.map((jm) => jm.id));
  const newLive = eligibleLive
    .filter((m) => !journalIds.has(m.id))
    .map((m) => liveById.get(m.id) as FleetMission);

  return [...merged, ...newLive];
}

/**
 * Cross-project fleet missions, grouped by every currently OPEN project
 * (`AppContext.openProjects`), most-recently-registered order.
 *
 * @param enabled - only polls while true (e.g. gate this on the Cockpit
 *   actually being the visible space, so background tabs don't poll).
 */
export function useFleetMissions(enabled = true): UseFleetMissionsResult {
  const { platform, openProjects, activeProjectId } = useAppContext();
  const liveMissions = useAgentsStoreMissionsOptional();
  const isTauri = platform.name === 'tauri';

  const [rows, setRows] = useState<readonly JournalMissionCurrentRow[]>([]);
  const [loading, setLoading] = useState(isTauri && enabled);
  const [error, setError] = useState<string | null>(null);

  // W-MODES: approvalMode.ts is a module-singleton store (same shape as
  // objectivesStore.ts), not itself reactive React state — this local
  // version counter forces the `projects` useMemo below to recompute
  // whenever the config loads or changes (a mode flip from anywhere: the
  // manager's set_approval_mode action, or a future UI selector).
  const [approvalModeVersion, setApprovalModeVersion] = useState(0);
  useEffect(() => {
    void ensureApprovalModesLoaded().then(() => setApprovalModeVersion((v) => v + 1));
    return subscribeApprovalModes(() => setApprovalModeVersion((v) => v + 1));
  }, []);

  useEffect(() => {
    if (!enabled || !isTauri) {
      setLoading(false);
      return;
    }
    // Shared cross-consumer poller (journalMissionsFeed.ts) — see that
    // module's header for why this used to be its own independent
    // 2.5s setInterval directly invoking journal_missions_current.
    return subscribeJournalMissions((nextRows, err) => {
      setRows(nextRows);
      setError(err);
      setLoading(false);
    });
  }, [enabled, isTauri]);

  const projects = useMemo<FleetProject[]>(() => {
    if (!isTauri) return [];

    const byProject = new Map<string, FleetMission[]>();
    // Real ownership of a mission id, per the journal's own project_id — the
    // source of truth mergeLiveMissions uses to stop a live mission from
    // being duplicated into the wrong project's group (F4).
    const missionOwner = new Map<string, string>();
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        continue; // one corrupt row must never break the whole read-model
      }
      // Malformed row (e.g. journal.rs's own INSERT-OR-IGNORE placeholder
      // `{missionId: X}` with no `id` — apply_mission_projection's
      // `placeholder_data`, written when a status-only event arrives before
      // any snapshot-carrying one) — silently skipped, never a target, same
      // as the JSON-parse-failure branch above.
      if (!isMissionLike(parsed)) continue;
      // B3 fix (2026-08-04) — a tombstoned row (deleteMission/
      // archiveMission's own real `archived: true` flag, or
      // tombstoneJournalMission's journal-only equivalent, agentsStore.tsx)
      // must never be surfaced on the canvas or counted toward "waiting for
      // you" signals (managerSignals.ts's own `!mission.archived` filter
      // already assumes upstream rows never carry one through in the first
      // place for exactly this reason).
      if (parsed.archived === true) continue;
      const list = byProject.get(row.project_id) ?? [];
      list.push(toFleetMission(parsed, row.updated_ms));
      byProject.set(row.project_id, list);
      missionOwner.set(parsed.id, row.project_id);
    }

    const modes = fleetApprovalModes(openProjects.map((p) => projectIdFromRoot(p.root)));

    return openProjects.map((project) => {
      const projectId = projectIdFromRoot(project.root);
      const journalMissions = byProject.get(projectId) ?? [];

      // Merge the live, streaming agentsStore list OVER the journal snapshot
      // for the active project when it's actually available (see module doc
      // comment for the known "stale right after switching projects"
      // caveat) — never a full replace, see mergeLiveMissions's doc comment
      // for the F4/F11 regressions this fixes.
      const missions =
        project.id === activeProjectId && liveMissions
          ? mergeLiveMissions(journalMissions, liveMissions, projectId, missionOwner)
          : journalMissions;

      return {
        projectId,
        root: project.root,
        name: basename(project.root),
        missions,
        approvalMode: modes[projectId] ?? 'manual',
      };
    });
    // approvalModeVersion is a version-counter dependency only (see its own
    // doc comment above) — its VALUE is never read in this body, only
    // fleetApprovalModes()'s live global-store read is, so eslint's
    // exhaustive-deps rule can't see why it belongs here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTauri, rows, openProjects, activeProjectId, liveMissions, approvalModeVersion]);

  return { projects, loading, error };
}
