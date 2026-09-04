/* useCanvasDnd.ts — palette drag/drop + drag-alignment-guide glue for the
   Agent Canvas (W2b refactor of CanvasView.tsx — deliverable #0). Pure
   extraction of CanvasView.tsx's W2a drag/drop handlers: palette-item drop
   onto the canvas pane (resolves the drop point, hit-tests it against the
   live project zones, creates a Draft), and the alignment-guide state a
   node drag shows/clears (canvasPlacement.ts's `computeAlignmentGuides`,
   rendered by `<AlignmentGuides/>`).
*/

import { useCallback, useState, type DragEvent as ReactDragEvent } from 'react';
import { PALETTE_DRAG_MIME, MACRO_DRAG_MIME, type PaletteDraftPayload } from '../CanvasPalette';
import { generateCanvasId } from '../canvasIds';
import { makeRef } from '../canvasTypes';
import { instantiateMacro, siblingRectsInZone } from '../canvasMacros';
import { computeAlignmentGuides, findChainNearPoint, type AlignmentGuides, type FlowPoint } from '../canvasPlacement';
import type { Size } from '../placementCollision';
import { useCanvasStore } from '../canvasStore';
import { DEFAULT_NODE_SIZE, type CanvasReactFlowNode } from '../reconciler';

export interface UseCanvasDndParams {
  nodes: CanvasReactFlowNode[];
  resolveFlowPoint: (clientX: number, clientY: number) => FlowPoint | null;
  placeInZoneOrTransverse: (flowPosition: FlowPoint, footprint?: Size) => { projectId?: string; relativePosition: FlowPoint };
}

export interface UseCanvasDndResult {
  dragGuides: AlignmentGuides | null;
  handleCanvasDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  handleCanvasDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
  handleNodeDrag: (event: unknown, node: CanvasReactFlowNode) => void;
  handleNodeDragStop: () => void;
  /** Group macros — instantiates a saved macro at `flowPosition` (an
   *  ABSOLUTE canvas point — the palette's click-to-add path has no drag
   *  event to read a drop point from, so it hands in a sensible anchor,
   *  e.g. the active zone's center). No-op for an unknown macroId. */
  handleInstantiateMacro: (macroId: string, flowPosition: FlowPoint) => void;
}

export function useCanvasDnd({ nodes, resolveFlowPoint, placeInZoneOrTransverse }: UseCanvasDndParams): UseCanvasDndResult {
  const addDraft = useCanvasStore((s) => s.addDraft);
  const setPositions = useCanvasStore((s) => s.setPositions);
  const macros = useCanvasStore((s) => s.macros);
  const instantiateMacroResult = useCanvasStore((s) => s.instantiateMacroResult);
  const chains = useCanvasStore((s) => s.chains);
  const addChain = useCanvasStore((s) => s.addChain);
  const removeChain = useCanvasStore((s) => s.removeChain);

  const [dragGuides, setDragGuides] = useState<AlignmentGuides | null>(null);

  const handleCanvasDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes(PALETTE_DRAG_MIME) || event.dataTransfer.types.includes(MACRO_DRAG_MIME)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleInstantiateMacro = useCallback(
    (macroId: string, flowPosition: FlowPoint) => {
      const macro = macros.find((m) => m.id === macroId);
      if (!macro) return; // unknown id — no-op, never a fabricated instantiate
      // No footprint passed here — this is only used to resolve the ZONE
      // (or Transverse) + a relative anchor point; instantiateMacro below
      // does its OWN per-item collision-safe placement pass.
      const { projectId, relativePosition } = placeInZoneOrTransverse(flowPosition);
      const occupied = siblingRectsInZone(nodes, projectId);
      const result = instantiateMacro(macro, relativePosition, projectId, occupied);
      instantiateMacroResult(result);
    },
    [macros, placeInZoneOrTransverse, nodes, instantiateMacroResult],
  );

  const handleCanvasDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const macroRaw = event.dataTransfer.getData(MACRO_DRAG_MIME);
      if (macroRaw) {
        event.preventDefault();
        const flowPosition = resolveFlowPoint(event.clientX, event.clientY);
        if (flowPosition) handleInstantiateMacro(macroRaw, flowPosition);
        return;
      }
      const raw = event.dataTransfer.getData(PALETTE_DRAG_MIME);
      if (!raw) return; // not a palette drag (e.g. an OS file drop) — ignore
      event.preventDefault();
      let payload: PaletteDraftPayload;
      try {
        payload = JSON.parse(raw) as PaletteDraftPayload;
      } catch {
        return;
      }
      const flowPosition = resolveFlowPoint(event.clientX, event.clientY);
      if (!flowPosition) return;
      // fix/canvas-ux R4a — a palette-dropped draft always renders as a
      // full card (DEFAULT_NODE_SIZE.draft), so the collision-safe scan
      // uses that real footprint, never the raw drop point verbatim.
      const { projectId, relativePosition } = placeInZoneOrTransverse(flowPosition, DEFAULT_NODE_SIZE.draft);
      const draftId = generateCanvasId('draft');
      const draftRef = makeRef('draft', draftId);
      addDraft({ id: draftId, ...payload, projectId, createdBy: 'user' });

      // Smart Edge Splitting: If dropped onto an existing chain edge, split it
      const hitChain = findChainNearPoint(flowPosition, chains, nodes, 50);
      if (hitChain) {
        removeChain(hitChain.id);
        addChain({
          id: generateCanvasId('chain'),
          sourceRef: hitChain.sourceRef,
          targetRef: draftRef,
          condition: hitChain.condition,
          createdBy: 'user',
        });
        addChain({
          id: generateCanvasId('chain'),
          sourceRef: draftRef,
          targetRef: hitChain.targetRef,
          condition: 'success',
          createdBy: 'user',
        });
      }

      // Dropped inside a real zone: honor the exact drop point. Dropped
      // outside every zone (-> Transverse) deliberately gets NO explicit
      // position — the Transverse group node may not exist yet, so its
      // absolute origin can't be predicted here; the reconciler's own
      // incremental grid placement positions it correctly on the very next
      // reconcile.
      if (projectId) setPositions({ [draftRef]: relativePosition });
    },
    [resolveFlowPoint, placeInZoneOrTransverse, addDraft, setPositions, handleInstantiateMacro, chains, nodes, removeChain, addChain],
  );

  const handleNodeDrag = useCallback(
    (_event: unknown, node: CanvasReactFlowNode) => {
      setDragGuides(computeAlignmentGuides({ id: node.id, parentId: node.parentId, position: node.position }, nodes));
    },
    [nodes],
  );

  const handleNodeDragStop = useCallback(() => {
    setDragGuides(null);
  }, []);

  return { dragGuides, handleCanvasDragOver, handleCanvasDrop, handleNodeDrag, handleNodeDragStop, handleInstantiateMacro };
}
