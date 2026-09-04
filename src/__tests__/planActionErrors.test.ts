/**
 * planActionErrors.test.ts — err-2 fix (silent-failure audit).
 *
 * Cockpit.tsx's onRejectPlan/onRevisePlan handlers used to be
 * `rejectPlan(id).catch(() => {})` / `revisePlan(id).catch(() => {})` — a
 * failure left no trace anywhere. logPlanActionFailure is the extracted,
 * independently-testable replacement: asserts a simulated failure produces
 * a console.error trace with the plan id in it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { logPlanActionFailure } from '../components/agents/cockpit/planActionErrors';

describe('logPlanActionFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a console.error trace containing the action and plan id on a simulated failure', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('deleteOrchestrator: IO failure');

    logPlanActionFailure('rejectPlan', 'plan-123', error);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const [message, context] = consoleErrorSpy.mock.calls[0];
    expect(String(message)).toContain('rejectPlan');
    expect(context).toMatchObject({ planId: 'plan-123', error });
  });

  it('distinguishes revisePlan failures from rejectPlan failures in the trace', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logPlanActionFailure('revisePlan', 'plan-456', new Error('boom'));

    const [message] = consoleErrorSpy.mock.calls[0];
    expect(String(message)).toContain('revisePlan');
    expect(String(message)).not.toContain('rejectPlan');
  });
});
