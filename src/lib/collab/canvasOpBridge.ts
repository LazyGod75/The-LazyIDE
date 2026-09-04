/* canvasOpBridge.ts — module-level bridge between local canvas edits
   and the Realtime canvas-op channel.

   useCanvasFlowGraph commits a drag's FINAL frame here; canvasStore
   addNote/updateNote emit notes. CanvasLiveSync registers the
   broadcaster that holds the live channel.

   `beginRemoteApply` / `endRemoteApply` wrap store writes that came FROM
   the channel so they never echo back out.
*/

type MoveBroadcaster = (nodeId: string, position: { x: number; y: number }) => void;
type NoteBroadcaster = (noteId: string, note: { text: string; projectId?: string }) => void;

let moveBroadcaster: MoveBroadcaster | null = null;
let noteBroadcaster: NoteBroadcaster | null = null;
let applyingRemote = 0;

export function setCanvasOpBroadcaster(fn: MoveBroadcaster | null): void {
  moveBroadcaster = fn;
}

export function setCanvasNoteBroadcaster(fn: NoteBroadcaster | null): void {
  noteBroadcaster = fn;
}

export function beginRemoteApply(): void {
  applyingRemote += 1;
}

export function endRemoteApply(): void {
  applyingRemote = Math.max(0, applyingRemote - 1);
}

export function isApplyingRemote(): boolean {
  return applyingRemote > 0;
}

/** Called by useCanvasFlowGraph on a committed local drag (final frame). */
export function emitLocalCanvasMove(nodeId: string, position: { x: number; y: number }): void {
  if (applyingRemote > 0) return;
  moveBroadcaster?.(nodeId, position);
}

/** Called by canvasStore on a local note add/update. */
export function emitLocalCanvasNote(noteId: string, note: { text: string; projectId?: string }): void {
  if (applyingRemote > 0) return;
  noteBroadcaster?.(noteId, note);
}
