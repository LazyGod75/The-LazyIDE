/* useCanvasChainConnect.ts — chain-creation (spec §5 "Connection UX", §7)
   split out of useCanvasEditing.ts for cohesion: this hook owns EXACTLY
   one concern — turning a candidate `sourceRef -> targetRef` pair into a
   real `Chain` via `validateChain` (chainValidation.ts, read-only import),
   toasting the reason on rejection. Two entry points share the same
   underlying `attemptCreateChain`/`targetInfoFor` so the validation/toast
   behavior is IDENTICAL regardless of how the user drew the edge:
     - the pre-existing click-to-connect flow ("Chaîner depuis…", armed by
       CanvasContextMenu.tsx via `setChainSource`, resolved by the next
       plain node click);
     - W2b's new drag-handle `onConnect`/`isValidConnection` (React Flow's
       own connection props, wired straight to `<ReactFlow>` by
       CanvasView.tsx).
*/

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { Connection, IsValidConnection } from '@xyflow/react';
import { useI18n } from '../../../../i18n';
import { useToast } from '../../../ui';
import { useCanvasStore } from '../canvasStore';
import { generateCanvasId } from '../canvasIds';
import { validateChain, type ChainTargetInfo } from '../chainValidation';
import type { CanvasNodeKind, MissionNodeData, NodeRef } from '../canvasTypes';
import type { CanvasReactFlowEdge, CanvasReactFlowNode } from '../reconciler';

export interface UseCanvasChainConnectParams {
  nodes: CanvasReactFlowNode[];
}

export interface UseCanvasChainConnectResult {
  chainSource: NodeRef | null;
  setChainSource: Dispatch<SetStateAction<NodeRef | null>>;
  handleNodeClick: (event: unknown, node: CanvasReactFlowNode) => void;
  handleConnect: (connection: Connection) => void;
  isValidConnection: IsValidConnection<CanvasReactFlowEdge>;
}

export function useCanvasChainConnect({ nodes }: UseCanvasChainConnectParams): UseCanvasChainConnectResult {
  const { t } = useI18n();
  const { toast } = useToast();
  const chains = useCanvasStore((s) => s.chains);
  const addChain = useCanvasStore((s) => s.addChain);

  const targetInfoFor = useCallback((node: CanvasReactFlowNode): ChainTargetInfo => {
    if (node.type === 'mission') return { kind: 'mission', missionStatus: (node.data as MissionNodeData).mission.status };
    return { kind: (node.type ?? 'draft') as CanvasNodeKind };
  }, []);

  /** Armed "Chaîner depuis…" source ref — the NEXT plain node click resolves
   *  it into a Chain, or Escape/clicking the source again cancels (spec §5
   *  "Connection UX"). */
  const [chainSource, setChainSource] = useState<NodeRef | null>(null);

  /** Validates + creates a chain, toasting the reason on rejection.
   *  Returns whether it was created — callers that only care about the
   *  side effect (click-to-connect) ignore the return value. */
  const attemptCreateChain = useCallback(
    (sourceRef: NodeRef, targetRef: NodeRef, targetNode: CanvasReactFlowNode): boolean => {
      const result = validateChain(chains, sourceRef, targetRef, targetInfoFor(targetNode));
      if (!result.ok) {
        toast(t(result.reasonKey), 'error');
        return false;
      }
      addChain({ id: generateCanvasId('chain'), sourceRef, targetRef, condition: 'success', createdBy: 'user' });
      return true;
    },
    [chains, targetInfoFor, addChain, toast, t],
  );

  const handleNodeClick = useCallback(
    (_event: unknown, node: CanvasReactFlowNode) => {
      if (!chainSource) return;
      if (node.id === chainSource) {
        setChainSource(null);
        return;
      }
      attemptCreateChain(chainSource, node.id, node);
      setChainSource(null);
    },
    [chainSource, attemptCreateChain],
  );

  const findNodeById = useCallback((id: string) => nodes.find((n) => n.id === id), [nodes]);

  const handleConnect = useCallback(
    (connection: Connection) => {
      const { source, target } = connection;
      if (!source || !target) return;
      const targetNode = findNodeById(target);
      if (!targetNode) return;
      attemptCreateChain(source, target, targetNode);
    },
    [findNodeById, attemptCreateChain],
  );

  /** Live drag-hover feedback (spec §5 "hovering mid-drag highlights valid
   *  targets ... running/done targets rejected") — pure lookup + validate,
   *  no toast (React Flow calls this on every hover frame during a drag).
   *  Typed as `IsValidConnection<CanvasReactFlowEdge>` (RF's own prop
   *  type — the callback receives either an in-progress `Connection` or an
   *  existing `Edge` being reconnected; both shapes carry `source`/
   *  `target`, which is all this needs). */
  const isValidConnection = useCallback<IsValidConnection<CanvasReactFlowEdge>>(
    (edge) => {
      const { source, target } = edge;
      if (!source || !target) return false;
      const targetNode = findNodeById(target);
      if (!targetNode) return false;
      return validateChain(chains, source, target, targetInfoFor(targetNode)).ok;
    },
    [findNodeById, chains, targetInfoFor],
  );

  return { chainSource, setChainSource, handleNodeClick, handleConnect, isValidConnection };
}
