/* replayRecovery — boot-time recovery for journal-sourced missions.

   Extracted from agentsStore so PID-alive reattach is unit-testable
   without mounting the React store. A running mission whose native CLI
   child is still alive must stay running; one whose process is gone flips
   to failed (or salvageable review).
*/

import type { Mission } from './types.js';

export function isInterruptedMission(m: Mission): boolean {
  if (m.status === 'running') return true;
  if (m.status === 'review') {
    const lastEntry = m.actionTimeline?.[m.actionTimeline.length - 1];
    return Boolean(m.liveAction) || Boolean(lastEntry?.isLive);
  }
  return false;
}

export function hasSalvageableDeliverable(m: Mission): boolean {
  if (m.emptyDeliverable) return false;
  const filesChanged = m.diffFiles?.length ?? 0;
  const linesChanged = (m.diffAdded ?? 0) + (m.diffRemoved ?? 0);
  return filesChanged > 0 || linesChanged > 0;
}

export interface ReplayRecoveryOpts {
  /** Mission ids whose native CLI PID is still alive (agent_run_live_ids). */
  liveMissionIds?: ReadonlySet<string>;
}

export function applyReplayRecovery(
  missions: Mission[],
  t: (key: string) => string,
  opts?: ReplayRecoveryOpts,
): { missions: Mission[]; interruptedIds: string[]; reattachedIds: string[] } {
  const interruptedIds: string[] = [];
  const reattachedIds: string[] = [];
  const live = opts?.liveMissionIds ?? new Set<string>();

  const recovered = missions.map((m): Mission => {
    if (!isInterruptedMission(m)) return m;

    if (m.status === 'running' && live.has(m.id)) {
      reattachedIds.push(m.id);
      return m;
    }

    if (m.status === 'review' && hasSalvageableDeliverable(m)) {
      const reason = t('agents.recoveredOnRestartReviewPreserved');
      return {
        ...m,
        liveAction: undefined,
        statusReason: reason,
        actionTimeline: [
          ...(m.actionTimeline ?? []).map((e) => ({ ...e, isLive: false })),
          { time: new Date().toLocaleTimeString(), text: reason, isLive: false },
        ],
      };
    }

    interruptedIds.push(m.id);
    const reason = t('agents.recoveredOnRestart');
    return {
      ...m,
      status: 'failed',
      statusReason: reason,
      liveAction: undefined,
      actionTimeline: [
        ...(m.actionTimeline ?? []).map((e) => ({ ...e, isLive: false })),
        { time: new Date().toLocaleTimeString(), text: reason, isLive: false },
      ],
    };
  });
  return { missions: recovered, interruptedIds, reattachedIds };
}
