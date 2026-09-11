/* useCanvasEditing.ts — editing/creation handlers for the Agent Canvas
   (W2b refactor of CanvasView.tsx — deliverable #0 "REFACTOR FIRST").
   Extracted verbatim-behavior from CanvasView.tsx's W2a section: clipboard/
   duplicate/delete, quick-create, context menus, draft/note creation, and
   cross-project-honest launch/toggle-loop. Chain CREATION itself (both the
   click-to-connect flow and W2b's new drag-handle onConnect) lives in the
   sibling `useCanvasChainConnect.ts` — this hook just re-exposes its
   result so CanvasView.tsx's call site stays a single `editing.*` surface.

   Follows CanvasContextMenu.tsx's own established convention (this file's
   sibling, not touched by this wave): reads `useAppContext`/
   `useAgentsStore`/`useCanvasStore`/`useToast`/`useI18n` DIRECTLY rather
   than having CanvasView.tsx thread every primitive through as a prop —
   only genuinely CanvasView-local state (the live RF `nodes`/`edges`,
   `resolveFlowPoint`, zone geometry, the two mission-open callbacks that
   are CanvasView's own props) crosses the hook boundary explicitly.
*/

import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useI18n } from '../../../../i18n';
import { useAppContext } from '../../../../app/AppContext';
import { useToast } from '../../../ui';
import { useAgentsStoreActions, useAgentsStoreMissionsOptional, resolveMissionRepoPath } from '../../agentsStore';
import { ApproveBlockedError } from '../../approveGate';
import { pinChainWithAudit, refireChainDownstream } from '../../../../lib/agents/canvasChainOps';
import type { FleetMission, FleetProject } from '../../../../lib/agents/fleetMissions';
import type { Mission } from '../../../../lib/agents/types';
import { projectIdFromRoot } from '../../../../lib/journal/projectId';
import {
  makeRef,
  parseRef,
  type DraftSpec,
  type JoinSpec,
  type LoopNodeData,
  type MissionNodeData,
  type NoteData,
  type ProjectNodeData,
  type RouterBranch,
  type RouterSpec,
} from '../canvasTypes';
import { useCanvasStore } from '../canvasStore';
import { generateCanvasId } from '../canvasIds';
import { hasClipboardContent, readClipboard, writeClipboard, type ClipboardEntry } from '../canvasClipboard';
import { duplicatePosition, pastePositions, type FlowPoint } from '../canvasPlacement';
import type { Size } from '../placementCollision';
import { launchDraft } from '../draftLaunch';
import type { QuickCreateValue } from '../CanvasQuickCreateModal';
import type { ContextMenuState } from '../CanvasContextMenu';
import type { CanvasActionsValue } from '../chrome/CanvasActionsContext';
import { DEFAULT_NODE_SIZE, type CanvasReactFlowEdge, type CanvasReactFlowNode } from '../reconciler';
import { useCanvasChainConnect, type UseCanvasChainConnectResult } from './useCanvasChainConnect';

/** Stable fallback for useAgentsStoreMissionsOptional() (null outside an
 *  AgentsStoreProvider — useCanvasEditing only ever runs under CanvasView,
 *  inside the provider, but the hook's type says otherwise). A module
 *  constant, not an inline `?? []`, so useCallback deps keyed on
 *  `activeMissions` keep a stable reference. */
const EMPTY_MISSIONS: readonly Mission[] = [];

/** Honest fallback when a draft carries no explicit model — no primitive
 *  exists here to derive "the" default model (NewMissionModal's full
 *  provider-aware selection UI is out of scope); mirrors the plain model
 *  label already used throughout this repo's own fixtures/tests. Also
 *  draftLaunch.ts's own fallback (kept in sync by convention — see its
 *  header) for the same reason chainEngine.ts/fleetMissions.ts keep small
 *  narrow duplicates rather than a shared constant module for one literal. */
const DEFAULT_DRAFT_MODEL_LABEL = 'sonnet';

type QuickCreateState =
  | { mode: 'create'; flowPosition: FlowPoint; projectId?: string }
  | { mode: 'edit'; draftId: string; initial: QuickCreateValue }
  | null;

export interface UseCanvasEditingParams {
  projects: FleetProject[];
  nodes: CanvasReactFlowNode[];
  edges: CanvasReactFlowEdge[];
  setNodes: Dispatch<SetStateAction<CanvasReactFlowNode[]>>;
  resolveFlowPoint: (clientX: number, clientY: number) => FlowPoint | null;
  placeInZoneOrTransverse: (flowPosition: FlowPoint, footprint?: Size) => { projectId?: string; relativePosition: FlowPoint };
  onOpenMission: (missionId: string) => void;
  onUrgentAction: (mission: FleetMission, actionKey: string) => void;
}

/** Everything CanvasView.tsx's JSX + keyboard hook need from the editing
 *  surface — one object so the split stays a pure extraction (no behavior
 *  change), not a redesign of the call sites. Chain-connect fields
 *  (`chainSource`/`handleNodeClick`/`handleConnect`/`isValidConnection`)
 *  come straight from {@link UseCanvasChainConnectResult} — see
 *  useCanvasChainConnect.ts. */
export interface UseCanvasEditingResult extends UseCanvasChainConnectResult {
  canvasActions: CanvasActionsValue;

  quickCreate: QuickCreateState;
  setQuickCreate: Dispatch<SetStateAction<QuickCreateState>>;
  handleOpenQuickCreateAt: (flowPosition: FlowPoint, projectId?: string) => void;
  handleQuickCreateSubmit: (value: QuickCreateValue) => void;

  contextMenu: ContextMenuState | null;
  setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
  handleNodeContextMenu: (event: { preventDefault: () => void; clientX: number; clientY: number }, node: CanvasReactFlowNode) => void;
  handleEdgeContextMenu: (event: { preventDefault: () => void; clientX: number; clientY: number }, edge: CanvasReactFlowEdge) => void;
  handlePaneContextMenu: (event: { preventDefault: () => void; clientX: number; clientY: number }) => void;
  handleNodeDoubleClick: (event: { clientX: number; clientY: number }, node: CanvasReactFlowNode) => void;

  handlePaletteAddDraft: (payload: { title: string; task: string; agentName?: string; model?: string }, projectId?: string) => void;
  /** W9 (additive) — CanvasPalette's optional « + Router » click-to-add
   *  entry (CanvasPalette.tsx's `onAddRouter` prop, flagged unwired by
   *  W8c). Same default 2-branch (success/default) shape as
   *  CanvasContextMenu.tsx's own `addRouterAt`, minus explicit positioning
   *  — matches `handlePaletteAddDraft`'s own convention of never setting a
   *  position for a palette-added node (the reconciler auto-places it). */
  handlePaletteAddRouter: (projectId?: string) => void;
  /** W-JOIN — CanvasPalette's optional « + Jonction » click-to-add entry. */
  handlePaletteAddJoin: (projectId?: string) => void;
  /** R7 (additive) — CanvasPalette's optional « Terminal »/« Aperçu
   *  localhost » click-to-add entries. */
  handlePaletteAddTerminal: (projectId?: string) => void;
  handlePaletteAddPreview: (projectId?: string) => void;
  handleAddNoteAt: (flowPosition: FlowPoint) => void;

  handleCopySelection: () => void;
  handlePasteAt: (flowPosition: FlowPoint) => void;
  handleDuplicateSelection: () => void;
  handleDeleteSelection: () => void;
  handleSelectAllInZone: (projectId: string) => void;

  hasClipboard: () => boolean;
}

export function useCanvasEditing({
  projects,
  nodes,
  edges,
  setNodes,
  resolveFlowPoint,
  placeInZoneOrTransverse,
  onOpenMission,
  onUrgentAction,
}: UseCanvasEditingParams): UseCanvasEditingResult {
  const { t } = useI18n();
  const { toast } = useToast();
  const { openProjects, activeRoot, switchProject } = useAppContextActiveRoot();
  const activeFleetProjectId = useMemo(() => (activeRoot ? projectIdFromRoot(activeRoot) : null), [activeRoot]);
  const activeMissions = useAgentsStoreMissionsOptional() ?? EMPTY_MISSIONS;
  const {
    addMission,
    toggleLoop,
    skipLoopNextRun,
    stopMission,
    approveMission,
    retryMission,
  } = useAgentsStoreActions();

  const drafts = useCanvasStore((s) => s.drafts);
  const addDraft = useCanvasStore((s) => s.addDraft);
  const updateDraft = useCanvasStore((s) => s.updateDraft);
  const removeDraft = useCanvasStore((s) => s.removeDraft);
  const addNote = useCanvasStore((s) => s.addNote);
  const removeNote = useCanvasStore((s) => s.removeNote);
  const updateNote = useCanvasStore((s) => s.updateNote);
  const chains = useCanvasStore((s) => s.chains);
  const removeChain = useCanvasStore((s) => s.removeChain);
  const unpinChainOutput = useCanvasStore((s) => s.unpinChainOutput);
  const addRouter = useCanvasStore((s) => s.addRouter);
  const addJoin = useCanvasStore((s) => s.addJoin);
  const addSurface = useCanvasStore((s) => s.addSurface);
  const setPositions = useCanvasStore((s) => s.setPositions);
  const toggleCollapsed = useCanvasStore((s) => s.toggleCollapsed);

  // ── Cross-project honesty (spec §3) — same real switchProject() + toast
  //    pattern Cockpit.tsx's own handlers use. ──────────────────────────
  const isProjectActive = useCallback((project: FleetProject) => activeRoot !== null && project.root === activeRoot, [activeRoot]);

  const switchToProjectIfNeeded = useCallback(
    (project: FleetProject): boolean => {
      if (isProjectActive(project)) return false;
      const entry = openProjects.find((p) => p.root === project.root);
      if (entry) {
        void switchProject(entry.id);
        toast(t('cockpit.toast.projectSwitched', { name: project.name }), 'info');
      }
      return true;
    },
    [isProjectActive, openProjects, switchProject, toast, t],
  );

  const findFleetProject = useCallback((missionId: string) => projects.find((p) => p.missions.some((m) => m.id === missionId)), [projects]);
  const findFleetProjectById = useCallback((projectId?: string) => (projectId ? projects.find((p) => p.projectId === projectId) : undefined), [projects]);

  const handleToggleLoop = useCallback(
    (missionId: string, enabled: boolean) => {
      const project = findFleetProject(missionId);
      if (project && switchToProjectIfNeeded(project)) return;
      void toggleLoop(missionId, enabled);
    },
    [findFleetProject, switchToProjectIfNeeded, toggleLoop],
  );

  /** « Passer la prochaine » (W5a) — same cross-project honesty gate as
   *  handleToggleLoop above (the real persistence path both go through,
   *  agentsStore.tsx's `skipLoopNextRun`, only ever touches the ACTIVE
   *  project's .lazy/loops.json). */
  const handleSkipLoopNextRun = useCallback(
    (missionId: string) => {
      const project = findFleetProject(missionId);
      if (project && switchToProjectIfNeeded(project)) return;
      void skipLoopNextRun(missionId);
    },
    [findFleetProject, switchToProjectIfNeeded, skipLoopNextRun],
  );

  const handleLaunchDraft = useCallback(
    (draftId: string) => {
      const draft = drafts.find((d) => d.id === draftId);
      if (!draft) return;
      if (draft.projectId) {
        const project = findFleetProjectById(draft.projectId);
        if (!project) {
          toast(t('canvas.draft.projectClosed'), 'error');
          return;
        }
        if (switchToProjectIfNeeded(project)) return;
      }
      // Delegates the actual launch mechanics (addMission + atomic
      // remapDraftToMission) to the shared draftLaunch.ts primitive (W4
      // dedup) — the pre-check above already guarantees same-project (or no
      // project) by the time this runs, so launchDraft's own cross-project
      // guard is defense-in-depth here, never the live path. See
      // draftLaunch.ts's header for why this fixes a real staleness gap
      // (plain removeDraft() used to leave a chain pointing at this draft
      // dangling instead of rewritten onto the new mission ref).
      void launchDraft(draftId, { addMission, activeProjectId: activeFleetProjectId }).then((result) => {
        if (!result.ok) toast(t(result.reasonKey), 'error');
      });
    },
    [drafts, findFleetProjectById, switchToProjectIfNeeded, addMission, activeFleetProjectId, toast, t],
  );

  const [quickCreate, setQuickCreate] = useState<QuickCreateState>(null);

  const handleEditDraft = useCallback(
    (draftId: string) => {
      const draft = drafts.find((d) => d.id === draftId);
      if (!draft) return;
      setQuickCreate({
        mode: 'edit',
        draftId,
        initial: { title: draft.title, task: draft.task, model: draft.model ?? DEFAULT_DRAFT_MODEL_LABEL },
      });
    },
    [drafts],
  );

  const handleToggleCollapseProject = useCallback((projectId: string) => toggleCollapsed(projectId), [toggleCollapsed]);
  const handleUpdateNote = useCallback((id: string, text: string) => updateNote(id, { text }), [updateNote]);

  // ── W9 — CanvasActionsContext's 5 optional W8c handlers, wired to the
  // SAME real primitives MissionNode.tsx (approve/reject, pin) and
  // CanvasContextMenu.tsx (pin/unpin/refire) already call directly — see
  // CanvasActionsContext.tsx's own doc comment on why these were left
  // optional/unwired pending whoever owns this file next. ───────────────

  /** Mirrors CanvasContextMenu.tsx's `pinChainEdge` exactly: the source
   *  mission must resolve to a real, terminal-success `Mission` in the
   *  ACTIVE project's list before pinning — never a fabricated snapshot. */
  const handlePinChainOutput = useCallback(
    (chainId: string) => {
      const chain = chains.find((c) => c.id === chainId);
      const sourceParsed = chain ? parseRef(chain.sourceRef) : null;
      const sourceMission = sourceParsed ? activeMissions.find((m) => m.id === sourceParsed.id) : undefined;
      if (!sourceMission || sourceMission.status !== 'done') {
        toast(t('canvas.pin.toastNotDone'), 'error');
        return;
      }
      void pinChainWithAudit(chainId, sourceMission);
      toast(t('canvas.pin.toastPinned', { title: sourceMission.title }), 'success');
    },
    [chains, activeMissions, toast, t],
  );

  const handleUnpinChainOutput = useCallback((chainId: string) => unpinChainOutput(chainId), [unpinChainOutput]);

  /** Mirrors CanvasContextMenu.tsx's `refireChainEdge` exactly (same 4
   *  RefireOutcome branches, same toast keys). */
  const handleRefireChainDownstream = useCallback(
    (chainId: string) => {
      void refireChainDownstream(chainId).then((outcome) => {
        if (outcome === 'refired') toast(t('canvas.pin.toastRefired'), 'success');
        else if (outcome === 'skipped-not-pinned') toast(t('canvas.pin.toastNotPinned'), 'error');
        else if (outcome === 'skipped-target-not-draft') toast(t('canvas.pin.toastTargetNotDraft'), 'error');
        else toast(t('canvas.pin.toastRefireFailed'), 'error');
      });
    },
    [toast, t],
  );

  /** Mirrors MissionNode.tsx's `handleGateApprove` exactly (same
   *  resolveMissionRepoPath + ApproveBlockedError handling): this mission's
   *  OWN project root, never whatever project happens to be ACTIVE right
   *  now — same resolveMissionRepoPath pattern the manager tool's
   *  approve_mission case and the auto-merge engine already use
   *  (agentsStore.tsx). */
  const handleApproveMission = useCallback(
    (missionId: string) => {
      void (async () => {
        try {
          const repoPath = await resolveMissionRepoPath(missionId);
          await approveMission(missionId, repoPath);
          toast(t('canvas.gate.approveSuccess'), 'success');
        } catch (err) {
          toast(err instanceof ApproveBlockedError ? err.reason : `${t('canvas.gate.approveError')}: ${String(err)}`, 'error');
        }
      })();
    },
    [approveMission, toast, t],
  );

  /** Mirrors MissionNode.tsx's `handleGateRejectSubmit` exactly (same
   *  retryMission-with-feedback primitive, trimmed-empty guard). */
  const handleRejectMissionWithFeedback = useCallback(
    (missionId: string, feedback: string) => {
      const trimmed = feedback.trim();
      if (!trimmed) return;
      retryMission(missionId, { feedback: trimmed });
      toast(t('canvas.gate.rejectToast'), 'success');
    },
    [retryMission, toast, t],
  );

  const canvasActions = useMemo<CanvasActionsValue>(
    () => ({
      onOpenMission,
      onUrgentAction,
      onLaunchDraft: handleLaunchDraft,
      onEditDraft: handleEditDraft,
      onToggleLoop: handleToggleLoop,
      onSkipLoopNextRun: handleSkipLoopNextRun,
      onOpenIteration: onOpenMission,
      onRemoveNote: removeNote,
      onUpdateNote: handleUpdateNote,
      onToggleCollapseProject: handleToggleCollapseProject,
      onPinChainOutput: handlePinChainOutput,
      onUnpinChainOutput: handleUnpinChainOutput,
      onRefireChainDownstream: handleRefireChainDownstream,
      onApproveMission: handleApproveMission,
      onRejectMissionWithFeedback: handleRejectMissionWithFeedback,
    }),
    [
      onOpenMission,
      onUrgentAction,
      handleLaunchDraft,
      handleEditDraft,
      handleToggleLoop,
      handleSkipLoopNextRun,
      removeNote,
      handleUpdateNote,
      handleToggleCollapseProject,
      handlePinChainOutput,
      handleUnpinChainOutput,
      handleRefireChainDownstream,
      handleApproveMission,
      handleRejectMissionWithFeedback,
    ],
  );

  // ── Draft/note creation ──────────────────────────────────────────────

  const handlePaletteAddDraft = useCallback(
    (payload: { title: string; task: string; agentName?: string; model?: string }, projectId?: string) => {
      addDraft({ id: generateCanvasId('draft'), ...payload, projectId, createdBy: 'user' });
    },
    [addDraft],
  );

  /** W9 — CanvasPalette's optional « + Router » click-to-add entry, wired
   *  to the real `addRouter` store primitive. Same default 2-branch
   *  (success/default) shape as CanvasContextMenu.tsx's `addRouterAt`, but
   *  deliberately unpositioned like `handlePaletteAddDraft` above — the
   *  reconciler's incremental placement assigns the next free grid slot. */
  const handlePaletteAddRouter = useCallback(
    (projectId?: string) => {
      const branches: RouterBranch[] = [
        { id: generateCanvasId('branch'), label: t('canvas.router.branchLabel', { n: '1' }), condition: { kind: 'outcome', value: 'success' } },
        { id: generateCanvasId('branch'), label: t('canvas.router.branchLabel', { n: '2' }), condition: { kind: 'default' } },
      ];
      const router: RouterSpec = { id: generateCanvasId('router'), projectId, branches };
      addRouter(router);
    },
    [addRouter, t],
  );

  /** W-JOIN — CanvasPalette's optional « + Jonction » click-to-add entry,
   *  wired to the real `addJoin` store primitive. Same unpositioned
   *  convention as `handlePaletteAddRouter` above; no pre-filled sources
   *  (see CanvasContextMenu.tsx's `addJoinAt` doc comment on why a join
   *  starts empty). */
  const handlePaletteAddJoin = useCallback(
    (projectId?: string) => {
      const join: JoinSpec = { id: generateCanvasId('join'), projectId, mode: 'all_success', sourceRefs: [] };
      addJoin(join);
    },
    [addJoin],
  );

  /**
   * R7 (living surfaces) — CanvasPalette's optional « Terminal » click-to-add
   * entry. Spec: "cwd = active project root" — `activeRoot` (this hook's own
   * `useAppContextActiveRoot` adapter below) is exactly that, resolved
   * synchronously (no `resolveProjectRoot()` round-trip needed here, unlike
   * CanvasContextMenu.tsx's pane-level entry, which has no active-project
   * concept of its own to read from).
   */
  const handlePaletteAddTerminal = useCallback(
    (projectId?: string) => {
      addSurface({ id: generateCanvasId('terminal'), kind: 'terminal', projectId, cwd: activeRoot ?? undefined });
    },
    [addSurface, activeRoot],
  );

  /** R7 — CanvasPalette's optional « Aperçu localhost » click-to-add entry —
   *  no URL yet (the node's own URL bar fills it in, restricted to
   *  localhost, never a guessed port here). */
  const handlePaletteAddPreview = useCallback(
    (projectId?: string) => {
      addSurface({ id: generateCanvasId('preview'), kind: 'preview', projectId });
    },
    [addSurface],
  );

  const handleAddNoteAt = useCallback(
    (flowPosition: FlowPoint) => {
      const { projectId, relativePosition } = placeInZoneOrTransverse(flowPosition, DEFAULT_NODE_SIZE.note);
      const noteId = generateCanvasId('note');
      addNote({ id: noteId, text: '', projectId });
      if (projectId) setPositions({ [makeRef('note', noteId)]: relativePosition });
    },
    [placeInZoneOrTransverse, addNote, setPositions],
  );

  // ── Clipboard / duplicate / delete (spec §5 "Editing") ───────────────

  const handleCopySelection = useCallback(() => {
    const entries: ClipboardEntry[] = [];
    for (const node of nodes) {
      if (!node.selected) continue;
      if (node.type === 'draft') {
        const { id: _id, ...spec } = node.data as DraftSpec;
        entries.push({ kind: 'draft', spec });
      } else if (node.type === 'note') {
        const { id: _id, ...spec } = node.data as NoteData;
        entries.push({ kind: 'note', spec });
      }
    }
    if (entries.length > 0) writeClipboard(entries);
  }, [nodes]);

  const handlePasteAt = useCallback(
    (flowPosition: FlowPoint) => {
      const entries = readClipboard();
      if (entries.length === 0) return;
      const { projectId } = placeInZoneOrTransverse(flowPosition);
      // fix/canvas-ux R4a — the staggered anchor (pastePositions) still
      // decides each entry's PREFERRED spot (so a multi-item paste reads as
      // a diagonal cascade, same as before), but each entry is now resolved
      // through the collision-safe `placeInZoneOrTransverse` (its own real
      // footprint, not a guess) instead of being persisted at that raw
      // staggered point verbatim — never lands on top of an existing
      // sibling already in the zone.
      const anchors = pastePositions(flowPosition, entries.length);
      const patch: Record<string, FlowPoint> = {};
      entries.forEach((entry, index) => {
        const footprint = entry.kind === 'draft' ? DEFAULT_NODE_SIZE.draft : DEFAULT_NODE_SIZE.note;
        const placement = placeInZoneOrTransverse(anchors[index]!, footprint);
        if (entry.kind === 'draft') {
          const id = generateCanvasId('draft');
          addDraft({ id, ...entry.spec, projectId });
          if (projectId) patch[makeRef('draft', id)] = placement.relativePosition;
        } else {
          const id = generateCanvasId('note');
          addNote({ id, ...entry.spec, projectId });
          if (projectId) patch[makeRef('note', id)] = placement.relativePosition;
        }
      });
      if (Object.keys(patch).length > 0) setPositions(patch);
    },
    [placeInZoneOrTransverse, addDraft, addNote, setPositions],
  );

  const handleDuplicateSelection = useCallback(() => {
    for (const node of nodes) {
      if (!node.selected) continue;
      if (node.type === 'draft') {
        const data = node.data as DraftSpec;
        const id = generateCanvasId('draft');
        addDraft({ ...data, id });
        setPositions({ [makeRef('draft', id)]: duplicatePosition(node.position) });
      } else if (node.type === 'note') {
        const data = node.data as NoteData;
        const id = generateCanvasId('note');
        addNote({ ...data, id });
        setPositions({ [makeRef('note', id)]: duplicatePosition(node.position) });
      } else if (node.type === 'mission' || node.type === 'loop') {
        const data = node.data as MissionNodeData | LoopNodeData;
        const full = activeMissions.find((m) => m.id === data.mission.id);
        const id = generateCanvasId('draft');
        addDraft({
          id,
          title: t('canvas.draft.cloneTitle', { title: data.mission.title }),
          task: full?.agentTask ?? data.mission.title,
          agentName: full?.agentName,
          model: data.mission.model,
          projectId: data.projectId,
          createdBy: 'user',
        });
        setPositions({ [makeRef('draft', id)]: duplicatePosition(node.position) });
      }
    }
  }, [nodes, addDraft, addNote, setPositions, activeMissions, t]);

  const handleDeleteSelection = useCallback(() => {
    for (const node of nodes) {
      if (!node.selected) continue;
      if (node.type === 'draft') removeDraft((node.data as DraftSpec).id);
      else if (node.type === 'note') removeNote((node.data as NoteData).id);
      else if (node.type === 'mission' || node.type === 'loop') {
        const data = node.data as MissionNodeData | LoopNodeData;
        // Never a silent mission delete: confirm, then STOP via the real
        // primitive — history/journal rows are never touched.
        const confirmed = window.confirm(t('canvas.mission.confirmStop', { title: data.mission.title }));
        if (confirmed) stopMission(data.mission.id);
      }
    }
    for (const edge of edges) {
      if (edge.selected && edge.type === 'chain') removeChain(edge.id);
    }
  }, [nodes, edges, removeDraft, removeNote, stopMission, removeChain, t]);

  const handleSelectAllInZone = useCallback(
    (projectId: string) => {
      const zoneRef = makeRef('project', projectId);
      setNodes((nds) => nds.map((n) => (n.parentId === zoneRef ? { ...n, selected: true } : n)));
    },
    [setNodes],
  );

  // ── Quick-create ──────────────────────────────────────────────────────

  const handleOpenQuickCreateAt = useCallback((flowPosition: FlowPoint, projectId?: string) => {
    setQuickCreate({ mode: 'create', flowPosition, projectId });
  }, []);

  const handleQuickCreateSubmit = useCallback(
    (value: QuickCreateValue) => {
      if (!quickCreate) return;
      if (quickCreate.mode === 'create') {
        // fix/canvas-ux R4a — feeds the CTA path ("Lancer un agent" zone
        // digest button -> CanvasView.tsx's canvas:launchAgentForProject
        // handler -> handleOpenQuickCreateAt -> this submit) through the
        // same collision-safe placement every other creation path uses.
        const { projectId, relativePosition } = placeInZoneOrTransverse(quickCreate.flowPosition, DEFAULT_NODE_SIZE.draft);
        const id = generateCanvasId('draft');
        addDraft({ id, title: value.title, task: value.task, model: value.model, projectId, createdBy: 'user' });
        if (projectId) setPositions({ [makeRef('draft', id)]: relativePosition });
      } else {
        updateDraft(quickCreate.draftId, { title: value.title, task: value.task, model: value.model });
      }
      setQuickCreate(null);
    },
    [quickCreate, placeInZoneOrTransverse, addDraft, setPositions, updateDraft],
  );

  // ── Context menus / double-click ─────────────────────────────────────

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const handleNodeDoubleClick = useCallback(
    (event: { clientX: number; clientY: number }, node: CanvasReactFlowNode) => {
      if (node.type !== 'project') return;
      const data = node.data as ProjectNodeData;
      if (data.collapsed) return;
      const flowPosition = resolveFlowPoint(event.clientX, event.clientY);
      if (!flowPosition) return;
      setQuickCreate({ mode: 'create', flowPosition, projectId: data.projectId });
    },
    [resolveFlowPoint],
  );

  const handleNodeContextMenu = useCallback(
    (event: { preventDefault: () => void; clientX: number; clientY: number }, node: CanvasReactFlowNode) => {
      event.preventDefault();
      const flowPosition = resolveFlowPoint(event.clientX, event.clientY) ?? node.position;
      setContextMenu({ screenX: event.clientX, screenY: event.clientY, flowPosition, target: { kind: 'node', node } });
    },
    [resolveFlowPoint],
  );

  const handleEdgeContextMenu = useCallback(
    (event: { preventDefault: () => void; clientX: number; clientY: number }, edge: CanvasReactFlowEdge) => {
      event.preventDefault();
      const flowPosition = resolveFlowPoint(event.clientX, event.clientY) ?? { x: 0, y: 0 };
      setContextMenu({ screenX: event.clientX, screenY: event.clientY, flowPosition, target: { kind: 'edge', edge } });
    },
    [resolveFlowPoint],
  );

  const handlePaneContextMenu = useCallback(
    (event: { preventDefault: () => void; clientX: number; clientY: number }) => {
      event.preventDefault();
      const flowPosition = resolveFlowPoint(event.clientX, event.clientY) ?? { x: 0, y: 0 };
      setContextMenu({ screenX: event.clientX, screenY: event.clientY, flowPosition, target: { kind: 'pane' } });
    },
    [resolveFlowPoint],
  );

  // ── Chain creation (spec §5 "Connection UX", §7) — delegated to
  //    useCanvasChainConnect.ts (split out for cohesion; see that file's
  //    header for why both the click-to-connect flow and W2b's new
  //    drag-handle onConnect live there together). ──────────────────────
  const chainConnect = useCanvasChainConnect({ nodes });

  return {
    canvasActions,
    quickCreate,
    setQuickCreate,
    handleOpenQuickCreateAt,
    handleQuickCreateSubmit,
    contextMenu,
    setContextMenu,
    handleNodeContextMenu,
    handleEdgeContextMenu,
    handlePaneContextMenu,
    handleNodeDoubleClick,
    ...chainConnect,
    handlePaletteAddDraft,
    handlePaletteAddRouter,
    handlePaletteAddJoin,
    handlePaletteAddTerminal,
    handlePaletteAddPreview,
    handleAddNoteAt,
    handleCopySelection,
    handlePasteAt,
    handleDuplicateSelection,
    handleDeleteSelection,
    handleSelectAllInZone,
    hasClipboard: hasClipboardContent,
  };
}

// Tiny local adapter: useAppContext() exposes `activeProjectId` (an id),
// but every cross-project-honesty helper here historically compared
// against the active project's ROOT path (matching CanvasView.tsx's
// original `activeRoot` derivation from `openProjects`/`activeProjectId`).
// Kept as a one-line internal hook rather than duplicating the `.find()`
// at every call site.
function useAppContextActiveRoot() {
  const { openProjects, activeProjectId, switchProject } = useAppContext();
  const activeRoot = useMemo(() => openProjects.find((p) => p.id === activeProjectId)?.root ?? null, [openProjects, activeProjectId]);
  return { openProjects, activeRoot, switchProject };
}
