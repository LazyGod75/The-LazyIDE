/* nativePause — stop-then-resume policy for the one-shot CLI rail.

   `claude -p` has no mid-call pause hook. Pause is therefore: SIGINT the
   tracked PID (agent_run_kill), keep the worktree, capture session_id from
   the done event, mark Mission.paused. Resume is a new agent_run with
   `--resume <session_id>` against the same worktree — not a fake flag.
*/

import type { Mission } from './types.js';

export function shouldTreatNativeExitAsPause(opts: {
  pauseRequested: boolean;
  stopRequested: boolean;
}): boolean {
  return opts.pauseRequested && !opts.stopRequested;
}

export function nativeResumePlan(mission: Pick<Mission, 'paused' | 'worktree' | 'agentMetrics' | 'status'>): {
  sessionId?: string;
  worktree: string;
} | null {
  if (mission.status !== 'running' || !mission.paused) return null;
  const worktree = mission.worktree?.trim();
  if (!worktree) return null;
  const sessionId = mission.agentMetrics?.sessionId?.trim() || undefined;
  return { worktree, sessionId };
}

export function canNativePause(mission: Pick<Mission, 'status' | 'paused'>): boolean {
  return mission.status === 'running' && !mission.paused;
}
