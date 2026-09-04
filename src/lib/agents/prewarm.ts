/* prewarm.ts — fire-and-forget background pre-warming of the manager's
   critical-path dependencies at app launch. None of these block the first
   render (they run AFTER createRoot().render() in main.tsx's bootstrap),
   but they complete BEFORE the user can type and send their first manager
   message, so the first turn's critical path is shorter.

   What gets pre-warmed:
   1. buildManagerCorePrompt() — the ~120KB static system prompt string.
      Memoized after first call, so the first manager turn skips the build.
   2. resolveProjectRoot() — the IPC round-trip to get_project_root.
      Cached after first call, so the first manager turn skips the IPC.
   3. buildManagerDynamicContext's dependencies are NOT pre-warmed here —
      they depend on live agent/mission/canvas state that doesn't exist
      until the user opens a project and the stores hydrate. Pre-warming
      them would produce stale/empty context.

   All pre-warm calls are best-effort: a failure (no Tauri, no project
   open, IPC timeout) is swallowed silently — the manager turn's own
   boundedContext wrappers handle fallbacks at call time. */

import { prewarmManagerCorePrompt } from './managerCorePrompt';

// resolveProjectRoot is exported from agentsStore.tsx, but importing the
// full 833KB module at boot just for one function would pull the entire
// orchestrator/manager/fleet state machine into the initial bundle eval.
// Instead, lazy-import it so only the prewarm path pays that cost, and
// only after the first render is already on screen.
async function prewarmProjectRoot(): Promise<void> {
  try {
    const { resolveProjectRoot, prewarmManagerStartupContext } = await import('../../components/agents/agentsStore');
    await resolveProjectRoot().catch(() => {});
    await prewarmManagerStartupContext();
  } catch {
    // agentsStore module unavailable (e.g. web build without Tauri) — no-op
  }
  try {
    const { listAgents } = await import('./agentsStorage');
    await listAgents();
  } catch {
    // best-effort — first manager turn pays the IPC if this misses
  }
}

// Re-export for test setup convenience
export { invalidateProjectRootCache } from './projectRootCache';

/** Fire-and-forget pre-warm. Call once at app launch (main.tsx bootstrap),
 *  AFTER createRoot().render() so it never blocks first paint. */
export function prewarmManager(): void {
  // 1. Core prompt — synchronous, ~1-2ms, but builds a 120KB string.
  //    Doing it here means the first runManagerTurn call skips this.
  try {
    prewarmManagerCorePrompt();
  } catch {
    // best-effort — the memo guard inside buildManagerCorePrompt makes
    // this safe to call multiple times; a failure here just means the
    // first turn pays the build cost (the original behavior).
  }

  // 2. Project root — async IPC, fire-and-forget. The cache populated
  //    here is reused by the first manager turn's Promise.all.
  void prewarmProjectRoot();
}
