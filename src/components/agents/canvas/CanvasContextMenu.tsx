/* CanvasContextMenu.tsx — right-click menus for every canvas surface (spec
   §5 "Context menus": node/edge/pane). Self-sufficient on purpose: rather
   than growing chrome/CanvasActionsContext.tsx's interface (a hard boundary
   this wave — see the wave's report), this component reads the SAME real
   primitives every other canvas surface already reads — `useCanvasActions()`
   for the handful of callbacks Cockpit.tsx wires (open/urgent-action/
   launch-draft/edit-draft/toggle-loop/remove-note/toggle-collapse),
   `useAgentsStore()` directly for the primitives CanvasActionsContext never
   needed (stopMission/deleteLoop — never modifies agentsStore.tsx, only
   calls its exported hook), and `useCanvasStore` directly for every
   canvas-owned mutation (addDraft/removeDraft/addNote/removeChain/
   setChainCondition/setChainDisabled/setPosition — canvasStore.ts already
   exposes every action this menu needs).

   Connect-mode ("Chaîner depuis…", spec §5 "Connection UX") is the one
   thing this component cannot own outright: arming it here, but resolving
   the NEXT click on a valid target has to happen at the `<ReactFlow>`
   level (CanvasView.tsx's onNodeClick), so this menu only calls
   `onArmChainFrom(sourceRef)` — a callback CanvasView.tsx supplies — and
   CanvasView.tsx owns the armed/hint-chip/Escape-cancels state.
*/

import { useEffect, useRef, type CSSProperties } from 'react';
import { useAgentsStoreActions, useAgentsStoreMissionsOptional, resolveProjectRoot } from '../agentsStore';
import { useCanvasActions } from './chrome/CanvasActionsContext';
import { usePopoverPosition } from './chrome/popoverPosition';
import { useCanvasStore } from './canvasStore';
import { classifyUrgent, urgentActionsFor } from '../cockpit/cockpitHelpers';
import { useI18n } from '../../../i18n';
import { useToast } from '../../ui';
import { generateCanvasId } from './canvasIds';
import { pendingOnlyRefs } from './canvasMacros';
import { computeFrameSelectionBBox } from './canvasFrameSelection';
import { duplicatePosition, toZoneRelative, type FlowPoint } from './canvasPlacement';
import {
  makeRef,
  parseRef,
  type ContestSpec,
  type DraftSpec,
  type FrameSpec,
  type LoopNodeData,
  type MissionNodeData,
  type JoinNodeData,
  type JoinSpec,
  type NodeRef,
  type NoteData,
  type ProjectNodeData,
  type RouterBranch,
  type RouterNodeData,
  type RouterSpec,
  type SurfaceSpec,
} from './canvasTypes';
import type { ChainEdgeData } from './edges/ChainEdge';
import { DEFAULT_FRAME_SIZE, TRANSVERSE_PROJECT_ID, type CanvasReactFlowEdge, type CanvasReactFlowNode } from './reconciler';
import { requestDryRun } from './dryrun/dryRunSignal';
import { pinChainWithAudit, refireChainDownstream } from '../../../lib/agents/canvasChainOps';
import { launchDraft } from './draftLaunch';
import { emit } from '../../../lib/bus';
import { projectIdFromRoot } from '../../../lib/journal/projectId';
import { fetchGitHubIssues, intakeToDrafts } from '../../../lib/agents/intakeAdapter';

export type ContextMenuTarget =
  | { kind: 'node'; node: CanvasReactFlowNode }
  | { kind: 'edge'; edge: CanvasReactFlowEdge }
  | { kind: 'pane' };

export interface ContextMenuState {
  screenX: number;
  screenY: number;
  /** Flow-space point at the click location — used by every "… ici" action
   *  (Note ici, Nouveau draft ici, Coller, Tout sélectionner ici). */
  flowPosition: FlowPoint;
  target: ContextMenuTarget;
}

interface CanvasContextMenuProps {
  state: ContextMenuState;
  onClose: () => void;
  onArmChainFrom: (sourceRef: NodeRef) => void;
  onOpenQuickCreateAt: (flowPosition: FlowPoint, projectId?: string) => void;
  onPasteAt: (flowPosition: FlowPoint, projectId?: string) => void;
  onSelectAllInZone: (projectId: string) => void;
  /** Group macros — opens the naming prompt for the CURRENT multi-selection
   *  (drafts/routers/notes only, see canvasMacros.ts's `pendingOnlyRefs`).
   *  Only offered when at least 2 such nodes are selected (spec: "multi-
   *  select nodes ... -> context menu"). */
  onSaveMacro: (refs: readonly NodeRef[]) => void;
  onRecenter: () => void;
  /** « Tout ranger » pane menu entry (spec §5 "Auto-layout") — the same
   *  elkjs whole-canvas layout the toolbar's « Ranger » button / Ctrl+L
   *  call (CanvasView.tsx wires this to `layout.runLayoutAll()`). Owed to
   *  W2b — this entry used to be a permanently-disabled placeholder. */
  onTidyUp: () => void;
  hasClipboard: boolean;
  projectZones: readonly { projectId: string; position: FlowPoint; size: { width: number; height: number } }[];
  /** R13 — the full reconciled node list, needed by the zone menu's
   *  "Archiver les terminées" bulk action to find which mission nodes
   *  currently render inside a given project zone (agentsStore's own flat
   *  `missions` list carries no projectId — the reconciler is what resolves
   *  that grouping, so this menu reads the ALREADY-reconciled result rather
   *  than re-deriving the same grouping a second way). Optional (defaults to
   *  `[]`) so a caller/test that doesn't care about the bulk-archive entry
   *  isn't forced to thread it through — an empty list just means the zone
   *  menu never offers "Archiver les terminées", never a crash. */
  nodes?: readonly CanvasReactFlowNode[];
}

interface MenuItem {
  key: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}
type MenuEntry = MenuItem | { separator: true };

const MENU_STYLE: CSSProperties = {
  position: 'fixed',
  zIndex: 2000,
  minWidth: 190,
  padding: 4,
  borderRadius: 9,
  background: 'var(--color-panel-2)',
  border: '1px solid rgba(255,255,255,0.14)',
  boxShadow: '3px 3px 0 rgba(0,0,0,0.4)',
  fontFamily: 'var(--font-ui)',
};

export function CanvasContextMenu({
  state,
  onClose,
  onArmChainFrom,
  onOpenQuickCreateAt,
  onPasteAt,
  onSelectAllInZone,
  onSaveMacro,
  onRecenter,
  onTidyUp,
  hasClipboard,
  projectZones,
  nodes = [],
}: CanvasContextMenuProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const menuRef = useRef<HTMLDivElement>(null);
  // fix/canvas-ux R6a BLOQUANT #2 — this menu previously had ZERO clamping
  // (neither axis), unlike GateFeedbackPopover/EdgeDropNodePicker's own
  // (partial, left-only) clamp: a right-click near the bottom or right edge
  // of the viewport could render entries partially or fully off-screen.
  // `gap: 0` preserves the exact original "open right at the click point"
  // anchoring for the common case (room on every side).
  const { left: menuLeft, top: menuTop } = usePopoverPosition(
    menuRef,
    { anchorTop: state.screenY, anchorBottom: state.screenY, preferredLeft: state.screenX },
    [state.screenX, state.screenY],
    { gap: 0 },
  );
  const actions = useCanvasActions();
  const missions = useAgentsStoreMissionsOptional() ?? [];
  const { stopMission, deleteLoop, setSelectedMissionId, archiveMission, archiveTerminalMissions, addMission } = useAgentsStoreActions();
  const addDraft = useCanvasStore((s) => s.addDraft);
  // W-CONTEST — same direct-canvasStore-mutation convention as every other
  // creation helper in this file (addRouter/addJoin/addFrame above).
  const addContest = useCanvasStore((s) => s.addContest);
  const removeDraft = useCanvasStore((s) => s.removeDraft);
  const setPosition = useCanvasStore((s) => s.setPosition);
  const addNote = useCanvasStore((s) => s.addNote);
  const removeChain = useCanvasStore((s) => s.removeChain);
  const setChainCondition = useCanvasStore((s) => s.setChainCondition);
  const setChainDisabled = useCanvasStore((s) => s.setChainDisabled);
  // W8c (pin output + router node) — same direct-canvasStore-mutation
  // convention as every other action above (pinning itself goes through
  // chainEngine's pinChainWithAudit choke point, never a raw store write).
  const unpinChainOutput = useCanvasStore((s) => s.unpinChainOutput);
  const chains = useCanvasStore((s) => s.chains);
  const addRouter = useCanvasStore((s) => s.addRouter);
  const removeRouter = useCanvasStore((s) => s.removeRouter);
  // W-JOIN — same direct-canvasStore-mutation convention as addRouter/removeRouter above.
  const addJoin = useCanvasStore((s) => s.addJoin);
  const removeJoin = useCanvasStore((s) => s.removeJoin);
  // R7 (living surfaces) — same direct-canvasStore-mutation convention as
  // every other creation helper in this file.
  const addSurface = useCanvasStore((s) => s.addSurface);
  const updateSurface = useCanvasStore((s) => s.updateSurface);
  const removeSurface = useCanvasStore((s) => s.removeSurface);
  // W-CLOSE row 2 (canvas groups / frames) — same direct-canvasStore-mutation
  // convention as every other creation helper in this file.
  const addFrame = useCanvasStore((s) => s.addFrame);
  const removeFrame = useCanvasStore((s) => s.removeFrame);
  // W-DISMISS — same direct-canvasStore-mutation convention as every other
  // action above; see canvasStore.ts's own doc comment on `dismissMission`.
  const dismissMission = useCanvasStore((s) => s.dismissMission);

  useEffect(() => {
    function handlePointerDown(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('mousedown', handlePointerDown);
    // R1b defect #12 fix — real-gesture triage proved Escape did NOT close
    // this menu. Root cause: right-clicking a NODE to open this menu also
    // gives that node native DOM focus, and React Flow's own
    // `NodeWrapper.onKeyDown` (registered directly on the focused node
    // element, i.e. LOWER in the bubble chain than `window`) treats Escape
    // as "deselect this node" whenever `disableKeyboardA11y` is false —
    // CanvasView.tsx now sets `disableKeyboardA11y` (spec's own
    // navigationScheme) so that handler is a no-op, but registering THIS
    // listener in the CAPTURE phase is the belt-and-braces half of the fix:
    // capture always runs top-down before ANY bubble-phase handler
    // (including a future regression that flips `disableKeyboardA11y` back,
    // or any other node-level/library keydown handler that calls
    // `stopPropagation`), so this menu is guaranteed to close on Escape
    // regardless of what else is listening further down the tree.
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onClose]);

  function withClose(fn: () => void): () => void {
    return () => {
      fn();
      onClose();
    };
  }

  function projectZoneOf(projectId: string) {
    return projectZones.find((z) => z.projectId === projectId);
  }

  function addNoteAt(point: FlowPoint, projectId?: string): void {
    const note: NoteData = { id: generateCanvasId('note'), text: '', projectId };
    addNote(note);
    const zone = projectId ? projectZoneOf(projectId) : undefined;
    setPosition(makeRef('note', note.id), zone ? toZoneRelative(point, zone) : point);
  }

  function duplicateAsDraft(
    missionId: string,
    title: string,
    model: string,
    projectId: string,
    position: FlowPoint,
    opts?: { isolated?: boolean },
  ): void {
    // Honest degradation: the FULL Mission (with real agentTask) is only
    // available for the ACTIVE project's missions (agentsStore's `missions`
    // list). A mission from a non-active project only has FleetMission's
    // fields — title is the best honest stand-in for task, never a
    // fabricated guess.
    const full = missions.find((m) => m.id === missionId);
    const isolated = opts?.isolated === true;
    const draft: DraftSpec = {
      id: generateCanvasId('draft'),
      // W-CLOSE row 6 — a distinct title prefix for the isolated variant so
      // the drafts list never looks identical to an ordinary clone-as-draft;
      // the user can tell, before even launching it, that THIS one won't
      // fire outgoing chains once it completes.
      title: isolated ? t('canvas.draft.isolatedCloneTitle', { title }) : t('canvas.draft.cloneTitle', { title }),
      task: full?.agentTask ?? title,
      agentName: full?.agentName,
      model,
      projectId,
      createdBy: 'user',
      isolated: isolated ? true : undefined,
    };
    addDraft(draft);
    setPosition(makeRef('draft', draft.id), duplicatePosition(position));
  }

  /** W-CONTEST — the 3 offered contest sizes (cheapest clean option per the
   *  task: flat entries rather than a submenu — this menu's `MenuItem` type
   *  has no nested/children concept, see this file's own `MenuEntry` type). */
  const CONTEST_SIZES = [2, 3, 4] as const;

  /**
   * « Lancer en concours » (W-CONTEST, best-of-N — Cursor "run N agents,
   * auto-pick best" parity): clones the draft template `n` times as
   * ISOLATED contestants (never fire an outgoing chain on their own — the
   * SAME `isolated` flag W-CLOSE row 6 already established for "Relancer en
   * isolation"), wraps them in a purely-visual frame, launches each through
   * `launchDraft` — the SAME real primitive draftLaunch.ts's own header says
   * both the ▶ button and the manager executor use ("no parallel path"), so
   * the scheduler's pool caps govern concurrency exactly like any other
   * launch — and registers the resulting mission ids as a running
   * {@link ContestSpec} for contestEngine.ts to judge once every contestant
   * terminates. A draft whose launch is refused (inactive project / engine
   * not ready) is honestly skipped (toasted, same `reasonKey` convention
   * every other `launchDraft` caller uses) rather than silently dropped; if
   * EVERY launch is refused, no contest is registered at all — never a
   * fabricated 1-contestant "contest".
   */
  function launchContest(node: CanvasReactFlowNode, n: (typeof CONTEST_SIZES)[number]): void {
    const draftData = node.data as DraftSpec;
    const projectId = draftData.projectId;
    const zone = projectId ? projectZoneOf(projectId) : undefined;

    const contestants: DraftSpec[] = Array.from({ length: n }, (_, i) => ({
      ...draftData,
      id: generateCanvasId('draft'),
      title: t('canvas.draft.contestCandidateTitle', { title: draftData.title, k: String(i + 1), n: String(n) }),
      isolated: true,
    }));

    const frame: FrameSpec = {
      id: generateCanvasId('frame'),
      projectId,
      title: t('canvas.frame.contestTitle', { title: draftData.title }),
      width: DEFAULT_FRAME_SIZE.width,
      height: DEFAULT_FRAME_SIZE.height,
    };
    addFrame(frame);
    setPosition(makeRef('frame', frame.id), zone ? toZoneRelative(node.position, zone) : node.position);

    let cursor = node.position;
    for (const draft of contestants) {
      addDraft(draft);
      cursor = duplicatePosition(cursor);
      setPosition(makeRef('draft', draft.id), zone ? toZoneRelative(cursor, zone) : cursor);
    }

    void resolveProjectRoot()
      .then((root) => projectIdFromRoot(root))
      .then(async (activeProjectId) => {
        const missionIds: string[] = [];
        for (const draft of contestants) {
          const result = await launchDraft(draft.id, { addMission, activeProjectId });
          if (result.ok) {
            missionIds.push(result.missionId);
          } else {
            toast(t(result.reasonKey), 'error');
          }
        }
        if (missionIds.length === 0) return; // every launch refused — no contest to track
        const contest: ContestSpec = {
          id: generateCanvasId('contest'),
          draftTemplateId: draftData.id,
          missionIds,
          status: 'running',
          createdAtMs: Date.now(),
        };
        addContest(contest);
      })
      .catch(() => {
        /* best-effort — mirrors every other resolveProjectRoot().then() chain in this file */
      });
  }

  /** W9 — « Historique » mission/loop entry: same `mission:focusSection`
   *  bus event + `setSelectedMissionId` call the 'H' keyboard shortcut
   *  (useCanvasInspectSelection.ts, this wave) and Cockpit.tsx's own
   *  Diff/Logs urgent-card handlers (QA B14) already use — a single real
   *  producer choke point, never a second "open the History section" path. */
  function openHistory(missionId: string): void {
    emit('mission:focusSection', { missionId, section: 'history' });
    setSelectedMissionId(missionId);
  }

  /** W8c deliverable #3 — default 2-branch router (success/default), placed
   *  at the click position. `label` deliberately mirrors RouterNode.tsx's
   *  own `addBranch` default naming so a freshly-created router always looks
   *  the same regardless of which entry point created it. */
  function addRouterAt(point: FlowPoint, projectId?: string): void {
    const branches: RouterBranch[] = [
      { id: generateCanvasId('branch'), label: t('canvas.router.branchLabel', { n: '1' }), condition: { kind: 'outcome', value: 'success' } },
      { id: generateCanvasId('branch'), label: t('canvas.router.branchLabel', { n: '2' }), condition: { kind: 'default' } },
    ];
    const router: RouterSpec = { id: generateCanvasId('router'), projectId, branches };
    addRouter(router);
    const zone = projectId ? projectZoneOf(projectId) : undefined;
    setPosition(makeRef('router', router.id), zone ? toZoneRelative(point, zone) : point);
  }

  /** W-JOIN — a fresh join starts with NO sources (unlike a router's
   *  pre-filled branches): a join's `sourceRefs` are only meaningful once
   *  drag-wired to a real upstream mission/loop node (canvasStore's
   *  `addChain` choke point populates them — see its own doc comment), so
   *  there is nothing sensible to pre-fill here. */
  function addJoinAt(point: FlowPoint, projectId?: string): void {
    const join: JoinSpec = { id: generateCanvasId('join'), projectId, mode: 'all_success', sourceRefs: [] };
    addJoin(join);
    const zone = projectId ? projectZoneOf(projectId) : undefined;
    setPosition(makeRef('join', join.id), zone ? toZoneRelative(point, zone) : point);
  }

  /** W-CLOSE row 2 (canvas groups / frames) — pane/zone "Nouveau cadre ici":
   *  a default-sized EMPTY frame at the click point, same zone-relative
   *  placement convention as `addNoteAt`/`addRouterAt` above. */
  function addFrameAt(point: FlowPoint, projectId?: string): void {
    const frame: FrameSpec = { id: generateCanvasId('frame'), projectId, title: t('canvas.frame.defaultTitle'), width: DEFAULT_FRAME_SIZE.width, height: DEFAULT_FRAME_SIZE.height };
    addFrame(frame);
    const zone = projectId ? projectZoneOf(projectId) : undefined;
    setPosition(makeRef('frame', frame.id), zone ? toZoneRelative(point, zone) : point);
  }

  /** Extra margin the frame's bounding box gets beyond the selection's own
   *  bbox, and the reserved height for the frame's title bar above it. */
  const FRAME_SELECTION_PADDING = 28;
  const FRAME_SELECTION_TITLE_HEIGHT = 26;

  /** Resolves a node's `parentId` (a project zone ref, or undefined) down to
   *  the plain projectId `FrameSpec.projectId` expects — Transverse's
   *  synthetic id (reconciler.ts's TRANSVERSE_PROJECT_ID) is never a REAL
   *  projectId to persist, same "absent means Transverse" convention
   *  DraftSpec/NoteData/RouterSpec already use. */
  function resolveFrameProjectId(parentId: string | undefined): string | undefined {
    const anchorProjectId = parentId ? parseRef(parentId)?.id : undefined;
    return anchorProjectId === TRANSVERSE_PROJECT_ID ? undefined : anchorProjectId;
  }

  /**
   * W-CLOSE row 2 — "Encadrer la sélection": sizes+positions a fresh frame
   * around the CURRENT selection's own bounding box (any node kind, not just
   * pending-only — a frame is purely visual, unlike a macro capture). The
   * actual bbox math (mixed-zone filtering, padding, title-bar reservation)
   * lives in canvasFrameSelection.ts's `computeFrameSelectionBBox` — pure,
   * independently unit-tested — this is just the store-mutation tail.
   */
  function frameSelection(): void {
    const selected = nodes.filter((n) => n.selected && n.type !== 'project' && n.type !== 'frame');
    const bbox = computeFrameSelectionBBox(selected, resolveFrameProjectId, FRAME_SELECTION_PADDING, FRAME_SELECTION_TITLE_HEIGHT);
    if (!bbox) return;
    const frame: FrameSpec = {
      id: generateCanvasId('frame'),
      projectId: bbox.projectId,
      title: t('canvas.frame.defaultTitle'),
      width: bbox.width,
      height: bbox.height,
    };
    addFrame(frame);
    setPosition(makeRef('frame', frame.id), { x: bbox.x, y: bbox.y });
  }

  /**
   * R7 (living surfaces) — creates a terminal or preview surface at `point`,
   * placed via the same `setPosition`/`toZoneRelative` convention every other
   * "…ici" creation entry in this file already uses. Returns the new
   * surface's id so callers that need to patch it after an ASYNC lookup
   * (`resolveProjectRoot`, for the pane-level "cwd = active project root"
   * case — a zone-level entry already has its root synchronously via
   * `ProjectNodeData.root`) can do so.
   */
  function addSurfaceAt(kind: SurfaceSpec['kind'], point: FlowPoint, projectId?: string, extra?: Partial<Omit<SurfaceSpec, 'id' | 'kind' | 'projectId'>>): string {
    const id = generateCanvasId(kind);
    addSurface({ id, kind, projectId, ...extra });
    const zone = projectId ? projectZoneOf(projectId) : undefined;
    setPosition(makeRef(kind, id), zone ? toZoneRelative(point, zone) : point);
    return id;
  }

  /** Pane-level « Ouvrir un terminal » — spec: "cwd = active project root".
   *  No project root is known synchronously at the pane (no specific zone),
   *  so the surface is created immediately (never blocking the menu close)
   *  and its `cwd` is patched once `resolveProjectRoot()` resolves. */
  function addTerminalAtPane(point: FlowPoint): void {
    const id = addSurfaceAt('terminal', point);
    void resolveProjectRoot().then((root) => updateSurface(id, { cwd: root }));
  }

  function paneEntries(): MenuEntry[] {
    const handleIntakeGitHub = (): void => {
      const repo = window.prompt(t('canvas.contextMenu.githubRepoPrompt'));
      if (!repo) return;
      void resolveProjectRoot().then(async (root) => {
        try {
          const projectId = projectIdFromRoot(root);
          const issues = await fetchGitHubIssues(repo);
          if (issues.length === 0) {
            toast(t('canvas.contextMenu.githubNoIssuesFound'), 'info');
            return;
          }
          const drafts = intakeToDrafts(issues, {
            projectId,
            defaultModel: '',
            defaultAgentName: 'claude',
          });
          for (const draft of drafts) {
            addDraft({ ...draft, createdBy: 'user' });
          }
          toast(t('canvas.contextMenu.githubImportedCount', { count: drafts.length }), 'success');
        } catch {
          toast(t('canvas.contextMenu.githubImportError'), 'error');
        }
      });
    };

    return [
      { key: 'new-draft-here', label: t('canvas.contextMenu.newDraftHere'), onSelect: withClose(() => onOpenQuickCreateAt(state.flowPosition)) },
      { key: 'new-router-here', label: t('canvas.contextMenu.newRouterHere'), onSelect: withClose(() => addRouterAt(state.flowPosition)) },
      { key: 'new-join-here', label: t('canvas.contextMenu.newJoinHere'), onSelect: withClose(() => addJoinAt(state.flowPosition)) },
      { key: 'note-here', label: t('canvas.contextMenu.noteHere'), onSelect: withClose(() => addNoteAt(state.flowPosition)) },
      // W-CLOSE row 2 — pane-level empty-frame creation (Transverse-scoped).
      { key: 'new-frame-here', label: t('canvas.contextMenu.newFrameHere'), onSelect: withClose(() => addFrameAt(state.flowPosition)) },
      // R7 (living surfaces) — pane-level terminal/preview creation.
      { key: 'new-terminal-here', label: t('canvas.contextMenu.newTerminalHere'), onSelect: withClose(() => addTerminalAtPane(state.flowPosition)) },
      { key: 'new-preview-here', label: t('canvas.contextMenu.newPreviewHere'), onSelect: withClose(() => addSurfaceAt('preview', state.flowPosition)) },
      { key: 'paste', label: t('canvas.contextMenu.paste'), disabled: !hasClipboard, onSelect: withClose(() => onPasteAt(state.flowPosition)) },
      { key: 'tidy-up', label: t('canvas.contextMenu.tidyUp'), onSelect: withClose(onTidyUp) },
      // W8a deliverable #3 — dry-run preview (the listener lives inside the
      // <ReactFlow> tree, see dryrun/dryRunSignal.ts for why it's signaled).
      { key: 'dry-run', label: t('canvas.dryrun.simulate'), onSelect: withClose(requestDryRun) },
      // P7.4 — Intake adapter: import issues from GitHub/Linear as drafts.
      { key: 'intake-github', label: t('canvas.contextMenu.importFromGithub'), onSelect: withClose(() => handleIntakeGitHub()) },
      { key: 'recenter', label: t('canvas.contextMenu.recenter'), onSelect: withClose(onRecenter) },
    ];
  }

  /** W8c deliverable #1 (pin output) — captures the source's real output onto
   *  this ONE chain (pinning is per-chain, not per-node — see
   *  canvasTypes.ts's `Chain.pinnedContext` doc comment). Honest degradation:
   *  the source must resolve to a real `Mission` (not just a `FleetMission`)
   *  in the ACTIVE project's `missions` list AND have reached `'done'` —
   *  same "must be an active-project mission" convention `duplicateAsDraft`
   *  already established below. */
  function pinChainEdge(chainId: string): void {
    // Reads the chain's REAL persisted `sourceRef` from canvasStore (not the
    // edge's rendered `source`, which reconciler.ts may have remapped for
    // display — folded-orchestrator re-anchoring, router-branch resolution —
    // see reconciler.ts's `remapHiddenEndpoint`/`resolveRouterBranchEndpoint`).
    const chain = chains.find((c) => c.id === chainId);
    const sourceParsed = chain ? parseRef(chain.sourceRef) : null;
    const sourceMission = sourceParsed ? missions.find((m) => m.id === sourceParsed.id) : undefined;
    if (!sourceMission || sourceMission.status !== 'done') {
      toast(t('canvas.pin.toastNotDone'), 'error');
      return;
    }
    // Shared pin tail (store write + chain.pinned journal audit — see
    // chainEngine.ts's pinChainWithAudit, the same choke point the manager
    // executor's pin_chain case goes through).
    void pinChainWithAudit(chainId, sourceMission);
    toast(t('canvas.pin.toastPinned', { title: sourceMission.title }), 'success');
  }

  function refireChainEdge(chainId: string): void {
    void refireChainDownstream(chainId).then((outcome) => {
      if (outcome === 'refired') {
        toast(t('canvas.pin.toastRefired'), 'success');
      } else if (outcome === 'skipped-not-pinned') {
        toast(t('canvas.pin.toastNotPinned'), 'error');
      } else if (outcome === 'skipped-target-not-draft') {
        toast(t('canvas.pin.toastTargetNotDraft'), 'error');
      } else {
        toast(t('canvas.pin.toastRefireFailed'), 'error');
      }
    });
  }

  function edgeEntries(edge: CanvasReactFlowEdge): MenuEntry[] {
    if (edge.type !== 'chain') return [];
    const edgeData = edge.data as ChainEdgeData | undefined;
    const condition = edgeData?.condition ?? 'success';
    const disabled = edgeData?.disabled ?? false;
    const pinned = edgeData?.pinned ?? false;
    const conditionItem = (key: 'success' | 'fail' | 'always', label: string): MenuItem => ({
      key: `condition-${key}`,
      label: condition === key ? `${label} ✓` : label,
      onSelect: withClose(() => setChainCondition(edge.id, key)),
    });
    return [
      conditionItem('success', t('canvas.contextMenu.conditionSuccess')),
      conditionItem('fail', t('canvas.contextMenu.conditionFail')),
      conditionItem('always', t('canvas.contextMenu.conditionAlways')),
      { separator: true },
      {
        key: 'toggle-disabled',
        label: disabled ? t('canvas.contextMenu.enable') : t('canvas.contextMenu.disable'),
        onSelect: withClose(() => setChainDisabled(edge.id, !disabled)),
      },
      { separator: true },
      pinned
        ? { key: 'unpin-output', label: t('canvas.contextMenu.unpinOutput'), onSelect: withClose(() => unpinChainOutput(edge.id)) }
        : { key: 'pin-output', label: t('canvas.contextMenu.pinOutput'), onSelect: withClose(() => pinChainEdge(edge.id)) },
      {
        key: 'refire-downstream',
        label: t('canvas.contextMenu.refireDownstream'),
        disabled: !pinned,
        onSelect: withClose(() => refireChainEdge(edge.id)),
      },
      { key: 'delete-chain', label: t('canvas.contextMenu.delete'), danger: true, onSelect: withClose(() => removeChain(edge.id)) },
    ];
  }

  function missionEntries(node: CanvasReactFlowNode): MenuEntry[] {
    const missionData = node.data as MissionNodeData;
    const { mission, projectId } = missionData;
    const entries: MenuEntry[] = [
      { key: 'open', label: t('canvas.contextMenu.open'), onSelect: withClose(() => actions.onOpenMission(mission.id)) },
      { key: 'diff', label: t('canvas.contextMenu.diff'), onSelect: withClose(() => actions.onUrgentAction(mission, 'diff')) },
      { key: 'logs', label: t('canvas.contextMenu.logs'), onSelect: withClose(() => actions.onUrgentAction(mission, 'logs')) },
      { key: 'history', label: t('canvas.contextMenu.history'), onSelect: withClose(() => openHistory(mission.id)) },
      // R7 (living surfaces) — spec: "Ouvrir un terminal dans le worktree"
      // (cwd = mission.worktree), tethered to this mission via `ownerRef` so
      // reconciler.ts draws the dotted "what talks to what" surface-edge.
      // `mission.worktree` is real (FleetMission carries it) — absent for a
      // mission whose worktree isn't known yet, the terminal then opens with
      // no cwd rather than guessing one.
      {
        key: 'open-terminal-worktree',
        label: t('canvas.contextMenu.openTerminalWorktree'),
        onSelect: withClose(() => addSurfaceAt('terminal', duplicatePosition(node.position), projectId, { cwd: mission.worktree, ownerRef: node.id })),
      },
    ];
    if (mission.status === 'failed') {
      entries.push({ key: 'retry', label: t('canvas.node.retry'), onSelect: withClose(() => actions.onUrgentAction(mission, 'retry')) });
    }
    if (mission.status === 'running' || mission.status === 'queued') {
      entries.push({ key: 'stop', label: t('canvas.contextMenu.stop'), danger: true, onSelect: withClose(() => stopMission(mission.id)) });
    }
    // R13 — mission lifecycle: a TERMINAL mission (done/failed/cancelled)
    // gets "Archiver" instead of a destructive delete (drafts keep their own
    // "delete" entry, draftEntries below — a still-unlaunched draft has no
    // journal history to protect). Additive/reversible-in-the-data: only
    // hides the node from THIS live canvas (reconciler.ts), never touches
    // Replay/Rapport/history.
    if (mission.status === 'done' || mission.status === 'failed' || mission.status === 'cancelled') {
      entries.push({
        key: 'archive',
        label: t('canvas.contextMenu.archive'),
        onSelect: withClose(() => archiveMission(mission.id)),
      });
      // W-DISMISS — a TERMINAL mission is already archivable above; this is
      // the narrower "just get this node off my screen right now" action
      // (no journal-visibility difference from archive, both are cosmetic
      // canvas-only hides — see canvasStore.ts's `dismissMission` doc
      // comment). Offered alongside archive, not instead of it: archive also
      // drives the zone's "Archiver les terminées" bulk count/aggregates,
      // dismiss does not.
      entries.push({
        key: 'dismiss-mission',
        label: t('canvas.contextMenu.dismissMission'),
        onSelect: withClose(() => dismissMission(mission.id)),
      });
    } else {
      // W-DISMISS — a non-terminal (queued/running/review) mission's agent
      // keeps running after this: the label says so explicitly so it never
      // reads as "stop this agent" (that's the separate "stop" entry above).
      entries.push({
        key: 'dismiss-mission',
        label: t('canvas.contextMenu.dismissRunningMission'),
        onSelect: withClose(() => dismissMission(mission.id)),
      });
    }
    entries.push(
      {
        key: 'duplicate-draft',
        label: t('canvas.contextMenu.duplicateAsDraft'),
        onSelect: withClose(() => duplicateAsDraft(mission.id, mission.title, mission.model, projectId, node.position)),
      },
      // W-CLOSE row 6 (Langflow/Dify "single-node re-run in isolation" parity
      // gap, re-examined honest v1) — clone-as-draft (same primitive as
      // "duplicate-draft" above) PLUS an isolation flag that survives the
      // eventual launch (draftLaunch.ts forwards DraftSpec.isolated onto the
      // new Mission) so its completion never fires an outgoing chain
      // (chainEngine.ts's onMissionTerminal/attemptFire). Offered on every
      // one-shot mission, not just failed/done ones — "run THIS node again,
      // side-effect-free" is a valid action at any point.
      {
        key: 'relaunch-isolated',
        label: t('canvas.contextMenu.relaunchIsolated'),
        onSelect: withClose(() => duplicateAsDraft(mission.id, mission.title, mission.model, projectId, node.position, { isolated: true })),
      },
      { key: 'chain-from', label: t('canvas.contextMenu.chainFrom'), onSelect: withClose(() => onArmChainFrom(node.id)) },
    );

    // W8c deliverable #1 — once a mission reaches terminal-success, its node
    // offers "Épingler la sortie", pinning EVERY currently-unpinned outgoing
    // chain in one action (the per-edge menu above still offers a precise
    // single-chain pin/unpin/refire).
    const fullMission = missions.find((m) => m.id === mission.id);
    if (mission.status === 'done' && fullMission) {
      const outgoing = chains.filter((c) => c.sourceRef === node.id);
      const hasUnpinned = outgoing.some((c) => c.pinnedContext == null);
      if (hasUnpinned) {
        entries.push({
          key: 'pin-output-node',
          label: t('canvas.contextMenu.pinOutput'),
          onSelect: withClose(() => {
            for (const chain of outgoing) {
              // Same audited choke point as the per-edge pin (one
              // chain.pinned journal row per chain pinned).
              if (chain.pinnedContext == null) void pinChainWithAudit(chain.id, fullMission);
            }
            toast(t('canvas.pin.toastPinned', { title: fullMission.title }), 'success');
          }),
        });
      }
    }

    const urgentKind = classifyUrgent(mission);
    if (urgentKind) {
      const urgent = urgentActionsFor({ mission, kind: urgentKind, t, forceApprove: false }).filter((a) => !entries.some((e) => 'key' in e && e.key === a.key));
      if (urgent.length > 0) {
        entries.push({ separator: true });
        for (const action of urgent) {
          entries.push({ key: action.key, label: action.label, onSelect: withClose(() => actions.onUrgentAction(mission, action.key)) });
        }
      }
    }
    return entries;
  }

  function loopEntries(node: CanvasReactFlowNode): MenuEntry[] {
    const loopData = node.data as LoopNodeData;
    const { mission, projectId, loopConfig } = loopData;
    return [
      { key: 'open', label: t('canvas.contextMenu.open'), onSelect: withClose(() => actions.onOpenMission(mission.id)) },
      // W5b: a loop node IS a mission (with loopConfig) — it needs the
      // same Diff/Logs reach missionEntries() already gives every
      // one-shot mission (parity checklist "per-node click-to-inspect
      // input/output ... every node").
      { key: 'diff', label: t('canvas.contextMenu.diff'), onSelect: withClose(() => actions.onUrgentAction(mission, 'diff')) },
      { key: 'logs', label: t('canvas.contextMenu.logs'), onSelect: withClose(() => actions.onUrgentAction(mission, 'logs')) },
      { key: 'history', label: t('canvas.contextMenu.history'), onSelect: withClose(() => openHistory(mission.id)) },
      {
        key: 'toggle-loop',
        label: loopConfig.enabled ? t('canvas.contextMenu.pause') : t('canvas.contextMenu.enable'),
        onSelect: withClose(() => actions.onToggleLoop(mission.id, !loopConfig.enabled)),
      },
      {
        key: 'delete-loop',
        label: t('canvas.contextMenu.deleteLoop'),
        danger: true,
        onSelect: withClose(() => {
          if (window.confirm(t('canvas.contextMenu.confirmDeleteLoop', { title: mission.title }))) void deleteLoop(mission.id);
        }),
      },
      // W-DISMISS — distinct from "delete-loop" above: delete-loop STOPS the
      // recurring schedule (a real, destructive lifecycle action, gated
      // behind a confirm); this only hides the node from THIS canvas — the
      // loop keeps firing on schedule exactly like a plain running mission
      // keeps running after missionEntries()'s own dismiss (see
      // canvasStore.ts's `dismissMission` doc comment). Same terminal/
      // non-terminal wording split as missionEntries() — a loop mission can
      // reach a terminal status too (its own last iteration failed/was
      // cancelled), not just 'running'.
      mission.status === 'done' || mission.status === 'failed' || mission.status === 'cancelled'
        ? { key: 'dismiss-mission', label: t('canvas.contextMenu.dismissMission'), onSelect: withClose(() => dismissMission(mission.id)) }
        : { key: 'dismiss-mission', label: t('canvas.contextMenu.dismissRunningMission'), onSelect: withClose(() => dismissMission(mission.id)) },
      {
        key: 'duplicate-draft',
        label: t('canvas.contextMenu.duplicateAsDraft'),
        onSelect: withClose(() => duplicateAsDraft(mission.id, mission.title, mission.model, projectId, node.position)),
      },
    ];
  }

  function draftEntries(node: CanvasReactFlowNode): MenuEntry[] {
    const draftData = node.data as DraftSpec;
    return [
      { key: 'launch', label: t('canvas.node.launch'), onSelect: withClose(() => actions.onLaunchDraft(draftData.id)) },
      // W-CONTEST — « Lancer en concours »: 3 flat entries (2/3/4 candidates)
      // rather than a submenu, this menu's own `MenuEntry` type has no
      // nested/children concept (cheapest clean option, see launchContest's
      // own doc comment).
      ...CONTEST_SIZES.map((n) => ({
        key: `launch-contest-${n}`,
        label: t('canvas.contextMenu.launchContest', { n: String(n) }),
        onSelect: withClose(() => launchContest(node, n)),
      })),
      { key: 'edit', label: t('canvas.contextMenu.edit'), onSelect: withClose(() => actions.onEditDraft(draftData.id)) },
      {
        key: 'duplicate',
        label: t('canvas.contextMenu.duplicate'),
        onSelect: withClose(() => {
          const copy: DraftSpec = { ...draftData, id: generateCanvasId('draft') };
          addDraft(copy);
          setPosition(makeRef('draft', copy.id), duplicatePosition(node.position));
        }),
      },
      { key: 'delete', label: t('canvas.contextMenu.delete'), danger: true, onSelect: withClose(() => removeDraft(draftData.id)) },
    ];
  }

  function noteEntries(node: CanvasReactFlowNode): MenuEntry[] {
    const noteData = node.data as NoteData;
    return [{ key: 'delete', label: t('canvas.contextMenu.delete'), danger: true, onSelect: withClose(() => actions.onRemoveNote(noteData.id)) }];
  }

  /** W8c deliverable #3 — RouterNode.tsx already owns inline label-edit/
   *  add-branch/delete UI on the card itself; this menu offers the same
   *  delete as a keyboard/right-click-accessible alternative. */
  function routerEntries(node: CanvasReactFlowNode): MenuEntry[] {
    const routerData = node.data as RouterNodeData;
    return [
      { key: 'chain-from', label: t('canvas.contextMenu.chainFrom'), onSelect: withClose(() => onArmChainFrom(node.id)) },
      { key: 'delete-router', label: t('canvas.contextMenu.deleteRouter'), danger: true, onSelect: withClose(() => removeRouter(routerData.routerId)) },
    ];
  }

  /** W-JOIN — a join is a valid chain SOURCE too (its one outgoing edge
   *  fires once every fan-in source is satisfied), so it gets the same
   *  `chain-from` entry as a router; delete is its own twin of
   *  `routerEntries`' delete above. */
  function joinEntries(node: CanvasReactFlowNode): MenuEntry[] {
    const joinData = node.data as JoinNodeData;
    return [
      { key: 'chain-from', label: t('canvas.contextMenu.chainFrom'), onSelect: withClose(() => onArmChainFrom(node.id)) },
      { key: 'delete-join', label: t('canvas.contextMenu.deleteJoin'), danger: true, onSelect: withClose(() => removeJoin(joinData.joinId)) },
    ];
  }

  function projectEntries(node: CanvasReactFlowNode): MenuEntry[] {
    const projectData = node.data as ProjectNodeData;
    const entries: MenuEntry[] = [
      {
        key: 'toggle-collapse',
        label: projectData.collapsed ? t('canvas.contextMenu.expand') : t('canvas.contextMenu.collapse'),
        onSelect: withClose(() => actions.onToggleCollapseProject(projectData.projectId, !projectData.collapsed)),
      },
      { key: 'select-all', label: t('canvas.contextMenu.selectAllHere'), onSelect: withClose(() => onSelectAllInZone(projectData.projectId)) },
      { key: 'note-here', label: t('canvas.contextMenu.noteHere'), onSelect: withClose(() => addNoteAt(state.flowPosition, projectData.projectId)) },
      { key: 'new-router-here', label: t('canvas.contextMenu.newRouterHere'), onSelect: withClose(() => addRouterAt(state.flowPosition, projectData.projectId)) },
      { key: 'new-join-here', label: t('canvas.contextMenu.newJoinHere'), onSelect: withClose(() => addJoinAt(state.flowPosition, projectData.projectId)) },
      // W-CLOSE row 2 — zone-level empty-frame creation.
      { key: 'new-frame-here', label: t('canvas.contextMenu.newFrameHere'), onSelect: withClose(() => addFrameAt(state.flowPosition, projectData.projectId)) },
      // R7 (living surfaces) — zone-level entries know their project's real
      // root SYNCHRONOUSLY (`ProjectNodeData.root`), unlike the pane-level
      // entry above (which has to resolve the active project async).
      {
        key: 'new-terminal-here',
        label: t('canvas.contextMenu.newTerminalHere'),
        onSelect: withClose(() => addSurfaceAt('terminal', state.flowPosition, projectData.projectId, { cwd: projectData.root })),
      },
      {
        key: 'new-preview-here',
        label: t('canvas.contextMenu.newPreviewHere'),
        onSelect: withClose(() => addSurfaceAt('preview', state.flowPosition, projectData.projectId)),
      },
    ];

    // R13 — « Archiver les terminées »: bulk-archives every terminal
    // (done/failed/cancelled) mission node CURRENTLY RENDERED in this zone.
    // Reads the already-reconciled `nodes` prop rather than re-deriving the
    // mission->project grouping a second way (agentsStore's flat `missions`
    // list carries no projectId — see this file's `nodes` prop doc comment).
    const terminalMissionIdsInZone = nodes
      .filter((n): n is CanvasReactFlowNode => n.type === 'mission')
      .filter((n) => (n.data as MissionNodeData).projectId === projectData.projectId)
      .map((n) => (n.data as MissionNodeData).mission)
      .filter((m) => m.status === 'done' || m.status === 'failed' || m.status === 'cancelled')
      .map((m) => m.id);
    if (terminalMissionIdsInZone.length > 0) {
      entries.push({ separator: true });
      entries.push({
        key: 'archive-terminated',
        label: t('canvas.contextMenu.archiveTerminated', { count: terminalMissionIdsInZone.length }),
        onSelect: withClose(() => archiveTerminalMissions(terminalMissionIdsInZone)),
      });
    }
    return entries;
  }

  /** R7 (living surfaces) — a terminal/preview node's only menu entry is
   *  closing it (TerminalNode.tsx/PreviewNode.tsx also expose the same × in
   *  their own header, this is the keyboard/right-click-accessible twin,
   *  same convention as `routerEntries`' delete above). */
  function surfaceEntries(node: CanvasReactFlowNode): MenuEntry[] {
    const surfaceData = node.data as SurfaceSpec;
    return [{ key: 'close-surface', label: t('canvas.contextMenu.closeSurface'), danger: true, onSelect: withClose(() => removeSurface(surfaceData.id)) }];
  }

  /** W-CLOSE row 2 — a frame's only menu entry is deleting it (FrameNode.tsx
   *  also exposes the same × in its own title bar — keyboard/right-click-
   *  accessible twin, same convention as `surfaceEntries`/`routerEntries`
   *  above). Never a "delete contents" action — a frame owns no children
   *  (canvasTypes.ts's FrameSpec header: "no parenting, no reflow"). */
  function frameEntries(node: CanvasReactFlowNode): MenuEntry[] {
    const frameData = node.data as FrameSpec;
    return [{ key: 'delete-frame', label: t('canvas.contextMenu.deleteFrame'), danger: true, onSelect: withClose(() => removeFrame(frameData.id)) }];
  }

  function sendToManagerEntry(node: CanvasReactFlowNode): MenuItem {
    const ref = node.id as string;
    let label: string = node.type ?? ref;
    if (node.type === 'mission' || node.type === 'loop') {
      const missionData = node.data as MissionNodeData;
      label = missionData.mission.title;
    } else if (node.type === 'draft') {
      const draftData = node.data as DraftSpec;
      label = draftData.title;
    } else if (node.type === 'project') {
      const projectData = node.data as ProjectNodeData;
      label = projectData.projectId;
    }
    return {
      key: 'send-to-manager',
      label: t('canvas.contextMenu.sendToManager'),
      onSelect: withClose(() => {
        emit('manager:sendToManager', { ref, label });
        // E: ref is already a fully-qualified canvas ref (e.g. "mission:abc-123"),
        // so prefix with @ only — no double "mission:" prefix.
        emit('manager:prefill', { text: `@${ref} `, expand: true });
      }),
    };
  }

  function nodeEntries(node: CanvasReactFlowNode): MenuEntry[] {
    let entries: MenuEntry[];
    switch (node.type) {
      case 'mission':
        entries = missionEntries(node);
        break;
      case 'loop':
        entries = loopEntries(node);
        break;
      case 'draft':
        entries = draftEntries(node);
        break;
      case 'note':
        entries = noteEntries(node);
        break;
      case 'router':
        entries = routerEntries(node);
        break;
      case 'join':
        entries = joinEntries(node);
        break;
      case 'project':
        entries = projectEntries(node);
        break;
      case 'terminal':
      case 'preview':
        entries = surfaceEntries(node);
        break;
      case 'frame':
        entries = frameEntries(node);
        break;
      default:
        entries = [];
    }
    // Append "Send to Manager" to every node type except project zones
    // (sending a zone to the manager makes no sense — the user wants to
    // send a specific mission/draft/note/router/etc.)
    if (node.type !== 'project') {
      entries = [...entries, { separator: true }, sendToManagerEntry(node)];
    }
    return entries;
  }

  // Group macros — the SAME multi-selection is offered regardless of which
  // surface (pane/node) was actually right-clicked, since selecting several
  // nodes then right-clicking any of them (or empty space near them) is the
  // natural gesture — only the edge menu (chain-specific actions) skips it.
  const selectedPendingRefs = pendingOnlyRefs(nodes.filter((n) => n.selected).map((n) => n.id));
  // W-CLOSE row 2 — "Encadrer la sélection" is offered for ANY selected node
  // kind (unlike the macro's pending-only rule above): a frame is purely
  // visual, so wrapping a mission/loop/schedule node is just as valid as
  // wrapping a draft. Same "regardless of which surface was right-clicked"
  // rationale as macroPrefix.
  const selectedFrameableNodes = nodes.filter((n) => n.selected && n.type !== 'project' && n.type !== 'frame');

  function buildEntries(): MenuEntry[] {
    const macroPrefix: MenuEntry[] =
      selectedPendingRefs.length >= 2
        ? [
            {
              key: 'save-macro',
              label: t('canvas.contextMenu.saveMacro', { count: String(selectedPendingRefs.length) }),
              onSelect: withClose(() => onSaveMacro(selectedPendingRefs)),
            },
            { separator: true },
          ]
        : [];
    const framePrefix: MenuEntry[] =
      selectedFrameableNodes.length >= 1
        ? [
            {
              key: 'frame-selection',
              label: t('canvas.contextMenu.frameSelection'),
              onSelect: withClose(frameSelection),
            },
            { separator: true },
          ]
        : [];
    if (state.target.kind === 'pane') return [...macroPrefix, ...framePrefix, ...paneEntries()];
    if (state.target.kind === 'edge') return edgeEntries(state.target.edge);
    return [...macroPrefix, ...framePrefix, ...nodeEntries(state.target.node)];
  }

  const entries = buildEntries();

  return (
    <div ref={menuRef} data-testid="canvas-context-menu" role="menu" style={{ ...MENU_STYLE, left: menuLeft, top: menuTop }}>
      {entries.map((entry, index) =>
        'separator' in entry ? (
          <div key={`sep-${index}`} data-testid="canvas-context-menu-separator" style={{ height: 1, margin: '4px 2px', background: 'var(--color-border-3)' }} />
        ) : (
          <button
            key={entry.key}
            type="button"
            data-testid={`canvas-context-menu-item-${entry.key}`}
            role="menuitem"
            disabled={entry.disabled}
            onClick={entry.onSelect}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              fontSize: 12,
              fontWeight: 600,
              padding: '6px 10px',
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: entry.disabled ? 'var(--color-text-disabled)' : entry.danger ? 'var(--color-danger)' : 'var(--color-text)',
              cursor: entry.disabled ? 'default' : 'pointer',
              fontFamily: 'inherit',
              opacity: entry.disabled ? 0.5 : 1,
            }}
          >
            {entry.label}
          </button>
        ),
      )}
    </div>
  );
}
