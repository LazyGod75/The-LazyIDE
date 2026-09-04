/* runMissionOpts — default RunOptions + i18n labels for runMission.

   Extracted so runMission's own cyclomatic complexity no longer counts
   five parameter defaults and the worktree/cancel ternaries. Type-only
   import from runtime.ts (erased) — no runtime cycle.
*/

import type { RunOptions, TFunc } from './runtime.js';

export type NormalizedRunOptions = RunOptions & {
  stopSignal: () => boolean;
  pauseSignal: () => boolean;
  drainIntervenes: () => string[];
  getBudgetCapUsd: () => number | undefined;
  getMaxDurationMs: () => number | undefined;
};

export function withRunDefaults(opts: RunOptions): NormalizedRunOptions {
  return {
    ...opts,
    stopSignal: opts.stopSignal ?? (() => false),
    pauseSignal: opts.pauseSignal ?? (() => false),
    drainIntervenes: opts.drainIntervenes ?? (() => []),
    getBudgetCapUsd: opts.getBudgetCapUsd ?? (() => undefined),
    getMaxDurationMs: opts.getMaxDurationMs ?? (() => undefined),
  };
}

export function runtimeLabel(
  t: TFunc | undefined,
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
): string {
  return t ? t(key, params) : fallback;
}
