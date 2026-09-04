/* missionCaps — bounds Mission Control's frontend memory growth.

   Nothing here mutates: every function returns a NEW array, following the
   project's immutable-update convention. Kept as small pure functions (no
   React, no platform) so each cap is trivially unit-testable and reusable at
   every append/merge site in agentsStore.tsx — a long-running mission
   streams one actionTimeline entry per tool call/step from the agent
   runtime, LazyManager accumulates chat turns forever, and missions
   themselves are never evicted, so all three are unbounded without this.
*/

import type { ActionEvent, ManagerMessage, Mission } from './types.js';

/** Keep-last cap for a single mission's action timeline. */
export const MAX_ACTION_TIMELINE_ENTRIES = 500;

/** Keep-last cap for LazyManager's chat history. */
export const MAX_MANAGER_MESSAGES = 300;

/** Keep-last cap for non-active missions retained in memory/on disk. */
export const MAX_INACTIVE_MISSIONS = 150;

/** Keep-last N entries — a no-op (shallow copy) when already within budget. */
export function capActionTimeline(
  entries: readonly ActionEvent[],
  max: number = MAX_ACTION_TIMELINE_ENTRIES,
): ActionEvent[] {
  return entries.length <= max ? [...entries] : entries.slice(-max);
}

/** Keep-last N entries — a no-op (shallow copy) when already within budget. */
export function capManagerMessages(
  messages: readonly ManagerMessage[],
  max: number = MAX_MANAGER_MESSAGES,
): ManagerMessage[] {
  return messages.length <= max ? [...messages] : messages.slice(-max);
}

/**
 * Statuses that keep a mission exempt from the inactive-mission cap —
 * anything still awaiting the agent, the user's review, or resumption.
 *
 * 'paused' is deliberately NOT a separate case here: per types.ts's
 * `Mission.paused` doc comment, pause is a boolean flag layered on TOP of
 * status 'running' — never its own MissionStatus — so a paused mission's
 * status is already 'running' and already covered below.
 */
function isActiveIshStatus(status: Mission['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'review';
}

/**
 * Prunes the mission list so it never grows without bound: every active-ish
 * mission (queued/running/review — see isActiveIshStatus) is always kept, in
 * full, regardless of count; among the rest (done/failed/cancelled), only
 * the most recently-added `maxInactive` are kept. Original relative order is
 * preserved — mission lookups elsewhere assume creation order (see
 * agentsStore.tsx's resolveMissionQueryTarget: "last matching entry wins").
 */
export function pruneMissions(
  missions: readonly Mission[],
  maxInactive: number = MAX_INACTIVE_MISSIONS,
): Mission[] {
  const inactive = missions.filter((m) => !isActiveIshStatus(m.status));
  if (inactive.length <= maxInactive) return [...missions];

  const keptInactiveIds = new Set(inactive.slice(-maxInactive).map((m) => m.id));
  return missions.filter((m) => isActiveIshStatus(m.status) || keptInactiveIds.has(m.id));
}
