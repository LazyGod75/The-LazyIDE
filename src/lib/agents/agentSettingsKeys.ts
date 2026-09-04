/* agentSettingsKeys.ts — localStorage keys for agent-runner settings that
   must be readable from non-JSX modules (e.g. scheduler.ts), not just the
   Settings UI.

   AgentsPanel.tsx (src/components/settings/AgentsPanel.tsx) remains the
   registry of record for every `lazy.agents.*` localStorage key and
   re-exports LS_AGENTS_MAX_PARALLEL from here for backward compatibility —
   see its own header comment for the full key list. This module exists
   because scheduler.ts is reachable from tsconfig.cli.json's program (via
   runtime.ts's dynamic `import('./scheduler.js')`), which has no --jsx
   support and therefore cannot resolve a .tsx module, even for a plain
   string constant. */

/** localStorage key: number, max parallel agents (1-20). */
export const LS_AGENTS_MAX_PARALLEL = 'lazy.agents.maxParallel';
