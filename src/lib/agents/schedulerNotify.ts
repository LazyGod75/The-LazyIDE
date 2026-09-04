/* schedulerNotify — bus + journal fan-out for scheduler queue signals.

   The manager must learn WHY a mission waited (scope_conflict / stale)
   without importing managerEngine. Journal events already exist; this
   module also emits typed bus events the manager wakeup can subscribe to.
*/

import { emit } from '../bus.js';

export interface SchedulerQueuedNotice {
  missionId: string;
  projectId: string;
  reason: 'pool_full' | 'scope_conflict';
  pool: string;
  depth: number;
  conflictsWith?: string[];
}

export interface SchedulerStaleNotice {
  missionId: string;
  projectId?: string;
  waitedMs: number;
}

export function notifySchedulerQueued(notice: SchedulerQueuedNotice): void {
  emit('scheduler:queued', notice);
}

export function notifySchedulerStale(notice: SchedulerStaleNotice): void {
  emit('scheduler:stale', notice);
}
