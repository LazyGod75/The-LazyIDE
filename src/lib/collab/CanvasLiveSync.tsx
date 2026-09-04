/* CanvasLiveSync — live co-editing bridge mounted once inside CanvasView.

   Wires the durable team canvas sync (git) to the live Realtime channel:
     - Registers move + note broadcasters so local edits reach teammates.
     - Applies incoming remote 'move' / 'note' ops to the local store.
     - Applies git-pulled merged canvas files the same way.

   Renders nothing. Degrades silently for solo/no-org users.
*/

import { useEffect } from 'react';
import { useCollab } from './CollabContext.js';
import { setCanvasOpBroadcaster, setCanvasNoteBroadcaster, beginRemoteApply, endRemoteApply } from './canvasOpBridge.js';
import { canvasStoreVanilla } from '../../components/agents/canvas/canvasStore.js';
import { on } from '../bus.js';
import { CANVAS_REMOTE_SYNC_EVENT } from '../teams/canvasShare.js';
import type { NoteData } from '../../components/agents/canvas/canvasTypes.js';

function applyPositions(layout: unknown): void {
  if (!layout || typeof layout !== 'object') return;
  const positions = (layout as { positions?: Record<string, { x?: number; y?: number }> }).positions;
  if (!positions) return;
  const patch: Record<string, { x: number; y: number }> = {};
  for (const [ref, pos] of Object.entries(positions)) {
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      patch[ref] = { x: pos.x, y: pos.y };
    }
  }
  if (Object.keys(patch).length === 0) return;
  beginRemoteApply();
  try {
    canvasStoreVanilla.getState().setPositions(patch);
  } finally {
    endRemoteApply();
  }
}

function applyNote(op: { noteId?: string; nodeId?: string; note?: { text: string; projectId?: string } }): void {
  const id = op.noteId ?? (op.nodeId?.startsWith('note:') ? op.nodeId.slice(5) : op.nodeId);
  if (!id || !op.note) return;
  const store = canvasStoreVanilla.getState();
  const existing = store.notes.find((n) => n.id === id);
  beginRemoteApply();
  try {
    if (existing) {
      store.updateNote(id, { text: op.note.text, projectId: op.note.projectId ?? existing.projectId });
    } else {
      const note: NoteData = { id, text: op.note.text, projectId: op.note.projectId };
      store.addNote(note);
    }
  } finally {
    endRemoteApply();
  }
}

export function CanvasLiveSync() {
  const { active, projectId, remoteCanvasOps, broadcastCanvasOp } = useCollab();

  useEffect(() => {
    if (!active) return;
    const key = projectId ?? '';
    setCanvasOpBroadcaster((nodeId, position) => {
      broadcastCanvasOp({ projectId: key, kind: 'move', nodeId, position });
    });
    setCanvasNoteBroadcaster((noteId, note) => {
      broadcastCanvasOp({ projectId: key, kind: 'note', noteId, nodeId: `note:${noteId}`, note });
    });
    return () => {
      setCanvasOpBroadcaster(null);
      setCanvasNoteBroadcaster(null);
    };
  }, [active, projectId, broadcastCanvasOp]);

  useEffect(() => {
    if (remoteCanvasOps.size === 0) return;
    const patch: Record<string, { x: number; y: number }> = {};
    for (const op of remoteCanvasOps.values()) {
      if (op.kind === 'move' && op.nodeId && op.position) {
        patch[op.nodeId] = op.position;
      } else if (op.kind === 'note') {
        applyNote(op);
      }
    }
    if (Object.keys(patch).length === 0) return;
    beginRemoteApply();
    try {
      canvasStoreVanilla.getState().setPositions(patch);
    } finally {
      endRemoteApply();
    }
  }, [remoteCanvasOps]);

  useEffect(() =>
    on(CANVAS_REMOTE_SYNC_EVENT as 'canvas:remote-sync', (payload) => {
      applyPositions(payload.layout);
    }),
  []);

  return null;
}
