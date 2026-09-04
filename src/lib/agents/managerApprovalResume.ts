/* managerApprovalResume.ts — LazyManager approval-queue-drain resume.

   THE GAP (founder repro, 2x deterministic, SUPERVISED mode): a manager
   turn ends with a sensitive action awaiting approval, and the manager's
   own message promises "je confirme dès que j'ai le vrai résultat, puis je
   propose la suite au tour suivant" — but nothing in agentsStore.tsx ever
   asks it that follow-up question. approvePendingAction/rejectPendingAction
   (agentsStore.tsx) execute the human's decision, flip the origin
   message's ActionBadge, optionally append a hidden "Résultat réel" message
   for the model's own context — and then just return. The conversation
   hangs there until the human types a brand-new message to unblock it.
   This is the exact SAME class of defect managerWakeup.ts's own header
   already documents for the journal-event side ("no automated call site
   exists anywhere in the codebase, so the manager's own promises are
   structurally dead: nobody ever asks it the next question") — this module
   is the approval-side counterpart: once a conversation's pending-approval
   queue drains (every action in it approved or rejected), it should get
   exactly one automated follow-up turn to react to the real results.

   ARCHITECTURE (mirrors managerWakeup.ts's own split)
   - This module stays pure and free of React/store/i18n, exactly like
     managerWakeup.ts's classifyWakeupEvent/isEchoOfManagerTurn/
     checkHourlyCap: it takes a plain snapshot of the three facts that
     matter and returns a boolean, nothing else. In particular it
     deliberately does NOT build the turn's message text — agentsStore.tsx
     already holds a live `t()` from useI18n (same reasoning as
     managerWakeup.ts's own header: formatWakeupMessage/
     formatWakeupDisplayMessage live there, not in the pure module, so a
     locale switch or a wording tweak never requires touching this file).
     agentsStore.tsx's formatApprovalResumeMessage(t) is the direct sibling
     of formatWakeupMessage for this feature.
   - Unlike managerWakeup.ts (which polls a journal-event stream on a
     timer, debounces a batch, and caps a rate), this decision has no
     timing dimension at all: it fires exactly once, synchronously with the
     event that drains the queue (an approval or a rejection), targeting
     the SAME conversation the approval belongs to — never routed through
     pickWakeupTargetConversationId's "most-recently-active idle
     conversation" heuristic (agentsStore.tsx), since the manager promised
     THIS conversation an answer, not whichever tab happens to be free.
   - Re-entrancy (the actual risk here — several approvals, e.g. from
     "Approve all", can drain the queue at nearly the same instant) is NOT
     this module's job to prevent: `resumeAlreadyInFlight` is an INPUT,
     owned and set by agentsStore.tsx's own dedicated per-conversation
     ref-based lock (acquired before the resume turn's first await,
     released in a `finally`), read here purely as one more fact this
     decision depends on. Keeping the lock's state OUTSIDE this module is
     what makes shouldResumeAfterApprovalQueueDrain trivially unit
     testable — every test just supplies the three facts it cares about, no
     fake timers, no mock store.
*/

export interface ApprovalResumeCheckInput {
  /**
   * How many actions are still queued in `pendingApprovals` for this
   * conversation, AFTER the action that triggered this check was resolved
   * (approved or rejected). 0 means the queue just drained — this is the
   * post-resolution count, never the raw pre-resolution queue length.
   */
  remainingPendingApprovals: number;
  /**
   * True when a manager turn (of ANY origin — user chat, a proactive
   * wakeup, or a previous approval-resume) is currently in flight on this
   * SAME conversation. Resuming into an already-running turn would race
   * it — the whole point of "one follow-up turn" is to hand the manager
   * the real results once, not to interrupt whatever it is already doing.
   */
  conversationBusy: boolean;
  /**
   * True when an approval-resume turn is ALREADY in flight for this exact
   * conversation — the dedicated per-conversation lock agentsStore.tsx
   * holds for the whole duration of the resume turn. The primary guard
   * against firing twice for the same drain when several approvals
   * resolve within milliseconds of each other (e.g. "Approve all").
   */
  resumeAlreadyInFlight: boolean;
}

/**
 * Decides whether resolving one pending action should trigger the
 * automated follow-up turn on its conversation — true exactly when the
 * queue has just drained (0 remaining), nothing else is already running on
 * that conversation, and no other approval/rejection has already claimed
 * this exact drain. Agnostic to WHAT resolved the last action (an approval
 * or a rejection) — only the resulting queue/turn state matters, so a
 * rejected batch resumes the manager exactly like an approved one does.
 * See this module's header for why re-entrancy is an INPUT here rather
 * than internal state.
 */
export function shouldResumeAfterApprovalQueueDrain(input: ApprovalResumeCheckInput): boolean {
  return input.remainingPendingApprovals === 0 && !input.conversationBusy && !input.resumeAlreadyInFlight;
}
