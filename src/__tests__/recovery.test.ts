/**
 * Tests for recovery.ts's evaluateRecovery — specifically the BUG-1
 * noCreditsPolicy: a no_credits failure must BLOCK immediately, never
 * retry, regardless of how many attempts remain (attemptCount < maxAttempts).
 * This is the second layer of BUG-1's fix: managedAgent.ts's own retry loop
 * already stops after one attempt (see managedAgent.test.ts's "BUG-1
 * no_credits is terminal" describe block) — this guards the OTHER retry
 * layer (runtime.ts's evaluateRecovery call after agentFailed is set) from
 * retrying the exact same wallet wall a second time.
 */

import { describe, it, expect } from 'vitest';
import { evaluateRecovery } from '../lib/agents/recovery';
import type { StageContract } from '../lib/agents/stageContract';

function makeStage(overrides: Partial<StageContract> = {}): StageContract {
  return {
    id: 'stage-1',
    kind: 'implement',
    label: 'Implement',
    description: 'test stage',
    model: 'anthropic/claude-sonnet-5',
    permissionMode: 'acceptEdits',
    systemPrompt: '',
    taskPrompt: '',
    state: 'in_progress',
    attemptCount: 0,
    maxAttempts: 3,
    dependsOn: [],
    onPass: null,
    onFail: null,
    ...overrides,
  };
}

describe('evaluateRecovery — BUG-1 no_credits policy', () => {
  it('blocks a no_credits error even with attempts remaining (attemptCount < maxAttempts)', () => {
    const stage = makeStage({ attemptCount: 0, maxAttempts: 3 });
    const decision = evaluateRecovery(
      stage,
      'Erreur agent: Crédits Pro épuisés — recharge ou bascule sur ton abonnement CLI dans Réglages > Modèles.',
    );

    expect(decision.action).toBe('block');
    expect(decision.delayMs).toBe(0);
  });

  it('matches the raw ManagedUnavailableError code as a fallback (case-insensitive)', () => {
    const stage = makeStage({ attemptCount: 0, maxAttempts: 3 });
    const decision = evaluateRecovery(stage, 'ManagedUnavailableError: NO_CREDITS');

    expect(decision.action).toBe('block');
  });

  it('is checked BEFORE environmentalPolicy/taskFailurePolicy/defaultPolicy — never retries', () => {
    // Would otherwise match isTaskFailure ("exit code") if noCreditsPolicy
    // were not matched first.
    const stage = makeStage({ attemptCount: 0, maxAttempts: 3 });
    const decision = evaluateRecovery(
      stage,
      'Erreur agent: Crédits Pro épuisés — exit code 1',
    );

    expect(decision.action).toBe('block');
  });

  it('does not affect an unrelated environmental error — still retries as before', () => {
    const stage = makeStage({ attemptCount: 0, maxAttempts: 3 });
    const decision = evaluateRecovery(stage, 'ECONNREFUSED: connect failed');

    expect(decision.action).toBe('retry');
  });

  it('does not affect an unrelated task failure — still retries as before', () => {
    const stage = makeStage({ attemptCount: 0, maxAttempts: 3, kind: 'implement' });
    const decision = evaluateRecovery(stage, 'test suite exit code 1: 3 tests failed');

    expect(decision.action).toBe('retry');
  });
});

/**
 * Real incident (2026-08-19) — the CLI's own subscription/session quota
 * wall ("You've hit your session limit · resets 12:30am (Europe/Paris)")
 * must never be retried: unlike no_credits (a wallet the user can top up
 * any time), the wall clears only at a known clock time, so a retry before
 * then is guaranteed to fail again — exactly what happened to M68-M74
 * overnight (M72 alone relaunched four times in twelve minutes).
 */
describe('evaluateRecovery — quotaExhaustionPolicy', () => {
  it('blocks a quota-exhaustion error even with attempts remaining, and carries the parsed resetAtMs', () => {
    const stage = makeStage({ attemptCount: 0, maxAttempts: 3 });
    const decision = evaluateRecovery(
      stage,
      "Erreur agent: You've hit your session limit · resets 12:30am (Europe/Paris)",
    );

    expect(decision.action).toBe('block');
    expect(decision.delayMs).toBe(0);
    expect(decision.reason).toContain('quota');
    expect(decision.reason).toContain('12:30am (Europe/Paris)');
    expect(typeof decision.resetAtMs).toBe('number');
  });

  it('blocks a quota-exhaustion variant with no reset time — still no retry, resetAtMs absent', () => {
    const stage = makeStage({ attemptCount: 0, maxAttempts: 3 });
    const decision = evaluateRecovery(stage, "Erreur agent: You've hit your session limit.");

    expect(decision.action).toBe('block');
    expect(decision.resetAtMs).toBeUndefined();
    expect(decision.reason).toContain('quota');
  });

  it('is checked BEFORE environmentalPolicy/taskFailurePolicy/defaultPolicy — never retries even with attempts remaining', () => {
    const stage = makeStage({ attemptCount: 0, maxAttempts: 3 });
    // Would otherwise match isTaskFailure ("exit code") if quotaExhaustionPolicy
    // were not matched first.
    const decision = evaluateRecovery(
      stage,
      "Erreur agent: You've hit your session limit · resets 12:30am (Europe/Paris) — exit code 1",
    );

    expect(decision.action).toBe('block');
  });

  it('does NOT misclassify an ordinary task/agent failure — still retries as before', () => {
    const stage = makeStage({ attemptCount: 0, maxAttempts: 3 });
    const decision = evaluateRecovery(stage, 'Erreur agent: test suite exit code 1: 3 tests failed');

    expect(decision.action).toBe('retry');
  });

  it('does NOT false-positive when the task text merely mentions "session limit"', () => {
    const stage = makeStage({ attemptCount: 0, maxAttempts: 3 });
    const decision = evaluateRecovery(
      stage,
      'Erreur agent: exit code 1 — task was "implement session limit handling for the API"',
    );

    // Falls through to taskFailurePolicy ("exit code"), never blocked as a
    // quota wall.
    expect(decision.action).toBe('retry');
  });
});
