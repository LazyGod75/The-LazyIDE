/* dryRunSignal.ts — W8a deliverable #3: a tiny self-contained trigger so
   CanvasContextMenu's pane entry (rendered OUTSIDE the <ReactFlow> tree,
   no useReactFlow access) can start the dry-run preview that lives inside
   CanvasToolbar. Deliberately NOT lib/bus.ts: this is a canvas/dryrun/
   internal wire, not an app-wide event (the dry-run brief mandates a
   self-contained canvas/dryrun/ implementation). */

type DryRunListener = () => void;

const listeners = new Set<DryRunListener>();

/** Fired by CanvasContextMenu's « Simuler » pane entry. */
export function requestDryRun(): void {
  for (const listener of [...listeners]) listener();
}

/** Subscribed by useDryRunPreview (CanvasToolbar). Returns a disposer. */
export function onDryRunRequest(listener: DryRunListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
