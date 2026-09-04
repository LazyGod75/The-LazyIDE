/* useCanvasInspectSelection.ts — 'O'/'L'/'D'/'H' per-node inspect shortcuts
   (W5b deliverable #2, parity checklist "Per-node click-to-inspect
   input/output"; 'H' added W9 — see lib/bus.ts's `MissionFocusSection` doc
   comment, which explicitly flagged this exact wiring gap: "the canvas 'H'
   shortcut ... belongs to other waves' files"). Split out of CanvasView.tsx
   (W2b's own "assembles small, independently-testable hooks" pattern,
   applied to this new W5b concern) rather than grown inline — CanvasView.tsx
   was already at its file-size ceiling before this wave.

   Derives "the single selected mission/loop node" (both carry a real
   `mission`, see MissionNodeData/LoopNodeData) from the live `nodes` array
   and exposes four handlers. O/L/D call the EXACT SAME
   `canvasActions.onOpenMission` / `onUrgentAction(mission, 'logs'|'diff')`
   primitives CanvasContextMenu.tsx's own Ouvrir/Logs/Diff menu items
   already use — never a second "open a mission" code path. H (History) has
   no `onUrgentAction` action-key equivalent (canvasActions is Canvas-Diff/
   Logs-only) — it emits the SAME `mission:focusSection` bus event +
   `setSelectedMissionId` call Cockpit.tsx's own Diff/Logs urgent-card
   handlers use (QA B14 wiring), which MissionDetail.tsx's `focusSection`
   effect already consumes for `section: 'history'` (RunHistoryDrawer.tsx,
   W8b) — this hook is simply the SECOND producer of that event, not a new
   consumer.
*/

import { useCallback, useMemo } from 'react';
import { useAgentsStore } from '../../agentsStore';
import { emit } from '../../../../lib/bus';
import type { LoopNodeData, MissionNodeData } from '../canvasTypes';
import type { CanvasReactFlowNode } from '../reconciler';
import type { CanvasActionsValue } from '../chrome/CanvasActionsContext';

export interface UseCanvasInspectSelectionResult {
  /** The single selected mission/loop node, or `null` when zero or more
   *  than one is selected — every handler below is then a safe no-op. */
  selectedMissionNode: CanvasReactFlowNode | null;
  onOpenSelectedMission: () => void;
  onLogsSelectedMission: () => void;
  onDiffSelectedMission: () => void;
  onHistorySelectedMission: () => void;
}

export function useCanvasInspectSelection(
  nodes: readonly CanvasReactFlowNode[],
  canvasActions: CanvasActionsValue,
): UseCanvasInspectSelectionResult {
  const { setSelectedMissionId } = useAgentsStore();

  const selectedMissionNode = useMemo(() => {
    const selected = nodes.filter((n) => n.selected && (n.type === 'mission' || n.type === 'loop'));
    return selected.length === 1 ? selected[0]! : null;
  }, [nodes]);

  const onOpenSelectedMission = useCallback(() => {
    if (!selectedMissionNode) return;
    const { mission } = selectedMissionNode.data as MissionNodeData | LoopNodeData;
    canvasActions.onOpenMission(mission.id);
  }, [selectedMissionNode, canvasActions]);

  const onLogsSelectedMission = useCallback(() => {
    if (!selectedMissionNode) return;
    const { mission } = selectedMissionNode.data as MissionNodeData | LoopNodeData;
    canvasActions.onUrgentAction(mission, 'logs');
  }, [selectedMissionNode, canvasActions]);

  const onDiffSelectedMission = useCallback(() => {
    if (!selectedMissionNode) return;
    const { mission } = selectedMissionNode.data as MissionNodeData | LoopNodeData;
    canvasActions.onUrgentAction(mission, 'diff');
  }, [selectedMissionNode, canvasActions]);

  const onHistorySelectedMission = useCallback(() => {
    if (!selectedMissionNode) return;
    const { mission } = selectedMissionNode.data as MissionNodeData | LoopNodeData;
    emit('mission:focusSection', { missionId: mission.id, section: 'history' });
    setSelectedMissionId(mission.id);
  }, [selectedMissionNode, setSelectedMissionId]);

  return { selectedMissionNode, onOpenSelectedMission, onLogsSelectedMission, onDiffSelectedMission, onHistorySelectedMission };
}
