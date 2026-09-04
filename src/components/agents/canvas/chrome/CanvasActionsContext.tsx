/* CanvasActionsContext.tsx — delivers real action handlers down to every
   canvas node (W1b). Node components never call agentsStore/Cockpit
   primitives directly (they don't own that wiring — Cockpit.tsx is W1c's
   file); they call these context methods, and W1c's <CanvasView/> wraps
   the React Flow tree in a <CanvasActionsProvider value={...}> built from
   Cockpit's EXISTING handlers (handleOpenMission, handleUrgentAction, …
   see Cockpit.tsx) — same real primitives the old AgentGrid/ProjectRow
   cards called, zero new mutation path.

   Default value is a set of safe no-ops (not `null`) so a node rendered in
   isolation (a fixture render test, a future storybook-less preview) never
   crashes on a missing provider — it just silently does nothing, which is
   the correct behavior for "not wired up yet" rather than a hard error in
   the middle of someone else's unrelated test.
*/

import { createContext, useContext, type ReactNode } from 'react';
import type { FleetMission } from '../../../../lib/agents/fleetMissions';

export interface CanvasActionsValue {
  /** Opens a mission's MissionDetail drawer (honest cross-project switch
   *  first if the mission belongs to a non-active project — see
   *  Cockpit.tsx's handleOpenMission doc comment). */
  onOpenMission: (missionId: string) => void;
  /** Same actionKey vocabulary as the cockpit grid's urgent cards:
   *  'deny-replan' | 'allow-once' | 'merge' | 'diff' | 'logs' | 'retry' |
   *  'promote' — see Cockpit.tsx's handleUrgentAction switch. */
  onUrgentAction: (mission: FleetMission, actionKey: string) => void;
  /** Draft's "Lancer" button — calls the real addMission (honest
   *  cross-project switch first when needed), then the reconciler remaps
   *  `draft:<id>` to `mission:<id>` (spec §6). */
  onLaunchDraft: (draftId: string) => void;
  /** Draft's edit affordance — opens the draft's quick-edit UI (W2a). */
  onEditDraft: (draftId: string) => void;
  /** LoopNode's enabled toggle — real pause_loop/resume primitive. */
  onToggleLoop: (missionId: string, enabled: boolean) => void;
  /** LoopNode's « Passer la prochaine » inline button (W5a deliverable #3)
   *  — advances `loopConfig.nextRunAt` by one cadence via the SAME real
   *  persistence path (loopEngine.ts's `updateLoop`) `onToggleLoop` already
   *  uses, never a canvas-only simulated skip. No-op when the loop has no
   *  live `nextRunAt` (disabled loop) — see agentsStore.tsx's
   *  `skipLoopNextRun`. */
  onSkipLoopNextRun: (missionId: string) => void;
  /** Clicking a LoopNode iteration mini-chip — opens that iteration's own
   *  MissionDetail (the chip's id IS a real mission id, spec §4.2). */
  onOpenIteration: (missionId: string) => void;
  onRemoveNote: (id: string) => void;
  onUpdateNote: (id: string, text: string) => void;
  /**
   * NOT in W1b's original handler list handed down by the orchestrator —
   * added because deliverable #5 (ProjectGroupNode) requires a working
   * collapse chevron and canvasTypes.ts's ProjectNodeData is pure data
   * (no callback field, by design — node data never carries functions).
   * canvasStore (W1a) owns the `collapsed` flag's persistence; W1c must
   * wire this to the real canvasStore setCollapsed action when it builds
   * the provider value. Flagged explicitly in the W1b handoff report.
   */
  onToggleCollapseProject: (projectId: string, collapsed: boolean) => void;
  /**
   * W8c (additive, OPTIONAL — deliberately, unlike every other field above)
   * — pin/approve/reject-gate/router actions. Node/menu components
   * (MissionNode.tsx, CanvasContextMenu.tsx) currently implement these
   * DIRECTLY via `useAgentsStoreOptional()` + `useCanvasStore()` reads (the
   * same escape hatch CanvasContextMenu.tsx's header already documents for
   * stopMission/deleteLoop) rather than through this context, because wiring
   * a real handler here requires CanvasView.tsx (out of this wave's writable
   * set) to build the provider's `value`. Optional so the EXISTING provider
   * value object CanvasView.tsx/useCanvasEditing.ts already builds (which
   * this wave cannot touch) keeps satisfying this interface unchanged — a
   * required field here would otherwise break that file's compile the
   * moment this interface grew. These fields exist so a future manager-rail
   * / command-bar surface can reuse the SAME real primitives without
   * duplicating them — see this wave's report for the CanvasView.tsx wiring
   * still needed from whoever owns that file next. Safe no-op defaults
   * below, same as every other field in this interface.
   */
  onPinChainOutput?: (chainId: string) => void;
  onUnpinChainOutput?: (chainId: string) => void;
  onRefireChainDownstream?: (chainId: string) => void;
  onApproveMission?: (missionId: string) => void;
  onRejectMissionWithFeedback?: (missionId: string, feedback: string) => void;
  /**
   * feat/always-visible-agents — clicking a zone's mission-roster dot
   * (ZoneMissionDots.tsx) `fitView`s onto that mission/loop node, the SAME
   * "look here" idiom CanvasView.tsx already uses for a search match/urgent
   * focus (`fitView({ nodes: [{ id }], duration: 250 })`) — never opens the
   * MissionDetail drawer itself (that stays `onOpenMission`'s job). Optional
   * (same convention as the W8c-era fields above): CanvasView.tsx is the one
   * file that can build this from a live `reactFlowInstanceRef`.
   */
  onFocusNode?: (ref: string) => void;
}

function noop(): void {
  // Safe no-op default — see module doc comment.
}

export const DEFAULT_CANVAS_ACTIONS: CanvasActionsValue = {
  onOpenMission: noop,
  onUrgentAction: noop,
  onLaunchDraft: noop,
  onEditDraft: noop,
  onToggleLoop: noop,
  onSkipLoopNextRun: noop,
  onOpenIteration: noop,
  onRemoveNote: noop,
  onUpdateNote: noop,
  onToggleCollapseProject: noop,
  onPinChainOutput: noop,
  onUnpinChainOutput: noop,
  onRefireChainDownstream: noop,
  onApproveMission: noop,
  onRejectMissionWithFeedback: noop,
  onFocusNode: noop,
};

const CanvasActionsContext = createContext<CanvasActionsValue>(DEFAULT_CANVAS_ACTIONS);

export function CanvasActionsProvider({
  value,
  children,
}: {
  value: CanvasActionsValue;
  children: ReactNode;
}) {
  return <CanvasActionsContext.Provider value={value}>{children}</CanvasActionsContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCanvasActions(): CanvasActionsValue {
  return useContext(CanvasActionsContext);
}
