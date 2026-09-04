/* journalEventTypeList.ts — runtime, type-checked enumeration of every
   `JournalEventType` (eventTypes.ts). Kept as its own small file (rather
   than appended to eventTypes.ts, already a large single-source-of-truth
   contracts file) because it serves a different purpose: eventTypes.ts
   defines the *shapes*, this file exists purely so a runtime consumer
   (activityFeedFormat.test.ts's exhaustive `feed.eventType.*` coverage
   check) can iterate every valid type literal as a real string, not just a
   compile-time type.

   Why this can't rot: `activityFeedFormat.test.ts` used to carry its own
   hand-maintained `previouslyUncoveredTypes` array (15 strings, fr/en
   only). Six real event types — agent.message_read, loop.stopped,
   scheduler.stalled, scheduler.throttled, tools.context, frontend.error —
   shipped in eventTypes.ts's `JournalEventInput` union and were never added
   to that array, so nothing ever caught their missing locale entries until
   an audit read the app's own journal db directly.

   The mechanism: `JOURNAL_EVENT_TYPE_MAP` is typed as
   `Record<JournalEventType, true>`, so TypeScript's object-literal checking
   enforces BOTH directions — omit a real union member and the literal is
   missing a required property (compile error); add a key that isn't in the
   union and it's an excess property (compile error). `JOURNAL_EVENT_TYPES`
   is just `Object.keys()` of that map, so any future addition/removal from
   `JournalEventInput` forces this file to be updated before `tsc` passes —
   no test run required to notice, and no second list to remember to touch.
*/

import type { JournalEventType } from './eventTypes.js';

const JOURNAL_EVENT_TYPE_MAP: Record<JournalEventType, true> = {
  'project.registered': true,
  'project.opened': true,
  'project.closed': true,
  'mission.created': true,
  'mission.updated': true,
  'mission.quoted': true,
  'mission.queued': true,
  'mission.started': true,
  'mission.step': true,
  'mission.blocked': true,
  'mission.question': true,
  'mission.answered': true,
  'mission.paused': true,
  'mission.resumed': true,
  'mission.intervened': true,
  'mission.takeover_started': true,
  'mission.takeover_returned': true,
  'mission.review_requested': true,
  'mission.proof_attached': true,
  'mission.approved': true,
  'mission.approve_blocked': true,
  'mission.rejected': true,
  'mission.completed': true,
  'mission.failed': true,
  'mission.quota_exhausted': true,
  'mission.cancelled': true,
  'mission.reverted': true,
  'mission.archived': true,
  'mission.queue.reconciled': true,
  'agent.spawned': true,
  'agent.message': true,
  'agent.handoff': true,
  'agent.delegated': true,
  'agent.web_search': true,
  'agent.message_read': true,
  'tool.called': true,
  'tools.context': true,
  'spend.tokens': true,
  'budget.warning': true,
  'budget.exceeded': true,
  'duration.warning': true,
  'duration.exceeded': true,
  'gate.passed': true,
  'gate.failed': true,
  'brain.recalled': true,
  'brain.captured': true,
  'brain.capture_failed': true,
  'brain.promoted': true,
  'brain.decision_created': true,
  'brain.decision_hit': true,
  'loop.tick': true,
  'loop.iteration': true,
  'loop.stopped': true,
  'scheduler.queued': true,
  'scheduler.throttled': true,
  'scheduler.stalled': true,
  'teams.synced': true,
  'teams.push': true,
  'teams.pull': true,
  'teams.conflict_resolved': true,
  'chain.fired': true,
  'chain.pending_cross_project': true,
  'chain.resumed': true,
  'chain.pinned': true,
  'contest.completed': true,
  'approval.mode_changed': true,
  'merge.conflicted': true,
  'merge.noop_already_merged': true,
  'fleet.hygiene': true,
  'manager.wakeup': true,
  'manager.approval_resume': true,
  'lazybot.completed': true,
  'lazybot.routine_failed': true,
  'spawn.deferred': true,
  'app.recovered': true,
  'frontend.error': true,
  'brain.ops_orphan': true,
};

/** Every `JournalEventType` literal, as real runtime strings — see this
 *  file's header for the exhaustiveness guarantee. Consumed by
 *  activityFeedFormat.test.ts to assert every emittable type resolves a
 *  real `feed.eventType.*` label in all 6 locales. */
export const JOURNAL_EVENT_TYPES: readonly JournalEventType[] = Object.keys(
  JOURNAL_EVENT_TYPE_MAP,
) as JournalEventType[];
