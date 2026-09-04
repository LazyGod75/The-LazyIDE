/**
 * brain-context.ts — AsyncLocalStorage-based "which brain is this request
 * for" propagation.
 *
 * Problem: dozens of modules (util/config.ts, indexer/db.ts, graph/*.ts,
 * store/paths.ts) resolve the active brain's paths through getConfig(), a
 * process-wide memoized singleton — the "one sidecar, one brain" design
 * brain-registry.ts replaces. Rethreading an explicit brainId/context
 * parameter through every one of those call sites (and everything that
 * calls them, transitively — graph loaders, the FTS index, retrieval
 * levels) would touch 50+ files for one feature.
 *
 * AsyncLocalStorage lets a request-scoped context ride the async call chain
 * instead: brain-registry.ts enters a context once per request, and
 * getConfig() reads it back at the bottom without any intermediate function
 * needing to know the context exists. No active context (CLI commands,
 * tests, anything that never touches the registry) → getActiveBrainContext()
 * returns undefined → every consumer falls back to its pre-existing
 * single-brain behavior, unchanged.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface BrainContext {
  /** Registry-assigned stable id for this brain (see brain-registry.ts). */
  brainId: string;
  /** Absolute, resolved brain root — same shape as LazyBrainConfig.brainPath. */
  brainPath: string;
  /** Absolute, resolved cache dir for this brain — same shape as LazyBrainConfig.cachePath. */
  cachePath: string;
}

const storage = new AsyncLocalStorage<BrainContext>();

/**
 * Run `fn` with `context` active for its synchronous body and every
 * promise/callback chain it kicks off — AsyncLocalStorage propagates
 * through .then()/await automatically. Returns whatever `fn` returns (sync
 * value or Promise) unchanged. Prefer this for bounded, composable scoping
 * (tests, one-off writes).
 */
export function runWithBrainContext<T>(context: BrainContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Switch the CURRENT async execution to `context` for its remainder,
 * without requiring callers to wrap the rest of their logic in a callback.
 * Use this at the top of a request handler when wrapping the remaining
 * dispatch chain in a callback would mean re-indenting a large amount of
 * unrelated, unchanged code (see commands/serve.ts).
 */
export function enterBrainContext(context: BrainContext): void {
  storage.enterWith(context);
}

/** The active brain context, or undefined when nothing wraps the current execution. */
export function getActiveBrainContext(): BrainContext | undefined {
  return storage.getStore();
}
