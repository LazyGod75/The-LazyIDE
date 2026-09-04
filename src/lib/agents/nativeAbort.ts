/* nativeAbort — native CLI stop from stopSignal OR AbortSignal.

   The managed rail aborts an in-flight HTTP turn via AbortSignal.
   The native rail has no HTTP call: it tree-kills the tracked PID
   (agent_run_kill). Until this helper, RunOptions.signal was ignored
   on the native path and only stopSignal (polled every 200ms) could
   kill the process.
*/

export function isNativeStopRequested(
  stopSignal: () => boolean,
  abortSignal?: AbortSignal,
): boolean {
  return Boolean(abortSignal?.aborted) || stopSignal();
}

export function armAbortListener(
  abort: AbortSignal | undefined,
  onAbort: () => void,
): () => void {
  if (!abort) return () => undefined;
  if (abort.aborted) {
    onAbort();
    return () => undefined;
  }
  abort.addEventListener('abort', onAbort, { once: true });
  return () => abort.removeEventListener('abort', onAbort);
}
