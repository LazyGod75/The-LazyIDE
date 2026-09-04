/**
 * Tests for managerApprovalResume.ts — the LazyManager approval-queue-drain
 * resume, the approval-side counterpart to managerWakeup.ts's proactive
 * event wakeup (see that module's own test file for the sibling shape).
 *
 * shouldResumeAfterApprovalQueueDrain is a plain predicate over three facts
 * (remaining queue length, conversation busy, resume-already-in-flight) —
 * no timers, no store, no i18n — so every case here is a direct input/
 * output fixture.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldResumeAfterApprovalQueueDrain,
  type ApprovalResumeCheckInput,
} from '../lib/agents/managerApprovalResume';

function input(overrides: Partial<ApprovalResumeCheckInput> = {}): ApprovalResumeCheckInput {
  return {
    remainingPendingApprovals: 0,
    conversationBusy: false,
    resumeAlreadyInFlight: false,
    ...overrides,
  };
}

describe('shouldResumeAfterApprovalQueueDrain', () => {
  it('fires when the queue drains — nothing pending, conversation idle, no lock held', () => {
    expect(shouldResumeAfterApprovalQueueDrain(input())).toBe(true);
  });

  it('does not fire when actions remain pending', () => {
    expect(shouldResumeAfterApprovalQueueDrain(input({ remainingPendingApprovals: 1 }))).toBe(false);
    expect(shouldResumeAfterApprovalQueueDrain(input({ remainingPendingApprovals: 3 }))).toBe(false);
  });

  it('does not fire twice for the same drain — a caller-owned lock blocks the second check', () => {
    // The approval that observes the drain first acquires the lock and fires...
    expect(shouldResumeAfterApprovalQueueDrain(input())).toBe(true);
    // ...a second approval resolving at nearly the same instant (e.g.
    // "Approve all" draining the last two items together) sees the lock
    // already held and must not fire again.
    expect(shouldResumeAfterApprovalQueueDrain(input({ resumeAlreadyInFlight: true }))).toBe(false);
  });

  it('does not fire when a manager turn is already in flight on this conversation', () => {
    expect(shouldResumeAfterApprovalQueueDrain(input({ conversationBusy: true }))).toBe(false);
  });

  it('fires after a rejection exactly like it fires after an approval — only the resulting queue state matters, never which action resolved it', () => {
    // Both an approval and a rejection reach this function through the
    // identical shape: whichever one drains the queue, the same true
    // decision follows.
    const afterApprovalDrainsQueue = input();
    const afterRejectionDrainsQueue = input();
    expect(shouldResumeAfterApprovalQueueDrain(afterApprovalDrainsQueue)).toBe(true);
    expect(shouldResumeAfterApprovalQueueDrain(afterRejectionDrainsQueue)).toBe(true);
  });

  it('refuses when both guards are active at once, not just one', () => {
    expect(
      shouldResumeAfterApprovalQueueDrain(input({ conversationBusy: true, resumeAlreadyInFlight: true })),
    ).toBe(false);
  });
});
