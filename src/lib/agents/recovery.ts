/* recovery.ts — Recovery policies for failed stages.
   Replaces the "agent error → failed, end of story" behavior with
   configurable retry, backoff, and blocked-state handling.

   Inspired by Millrace's recovery concept: environmental failures requeue,
   real blocked states stay visible until an operator handles them.
*/

import type { StageContract, CompiledPlan } from './stageContract.js';
import { blockStage, startStage } from './stageContract.js';
import { detectQuotaExhaustion, formatQuotaExhaustionReason } from './quotaExhaustion.js';

// ── Recovery policy types ─────────────────────────────────────────

/** i18n translate function shape — see byokProviders.ts's Translate doc
 *  comment for the shared convention. Optional everywhere: omitting `t`
 *  falls back to the ORIGINAL hardcoded copy (French for noCreditsPolicy,
 *  the pre-existing English for every other policy in this file). */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

export type RecoveryAction = 'retry' | 'block' | 'skip' | 'operator_needed';

export interface RecoveryDecision {
  action: RecoveryAction;
  delayMs: number;
  reason: string;
  /**
   * Real incident fix (2026-08-19, session-limit overnight loss) — set ONLY
   * by quotaExhaustionPolicy below, when the CLI's own quota-exhaustion
   * message carried a parseable reset time (quotaExhaustion.ts's
   * QuotaExhaustionInfo.resetAtMs). The natural retry boundary for this
   * condition: runtime.ts uses it to back off the mission's scheduler pool
   * (see scheduler.ts's reportQuotaExhausted) so sibling missions waiting on
   * the same pool are not launched into the same wall either, instead of
   * only stopping THIS one mission's own retry. Absent for every other
   * policy/outcome — never a fabricated value.
   */
  resetAtMs?: number;
}

export interface RecoveryPolicy {
  match: (stage: StageContract, error: string) => boolean;
  decide: (stage: StageContract, error: string, t?: Translate) => RecoveryDecision;
}

// ── Built-in policies ─────────────────────────────────────────────

const isEnvironmentalError = (error: string): boolean => {
  const lower = error.toLowerCase();
  return (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('econnrefused') ||
    lower.includes('enoent') ||
    lower.includes('spawn') ||
    lower.includes('permission denied') ||
    lower.includes('resource temporarily unavailable')
  );
};

const isTaskFailure = (error: string): boolean => {
  const lower = error.toLowerCase();
  return (
    lower.includes('exit code') ||
    (lower.includes('test') && lower.includes('fail')) ||
    lower.includes('assert') ||
    lower.includes('compile error') ||
    lower.includes('type error')
  );
};

/**
 * Real incident (2026-08-19) — a 9-step doc plan lost an entire overnight
 * run: seven missions (M68-M74) each hit the Claude CLI's own subscription/
 * session quota wall ("You've hit your session limit · resets 12:30am
 * (Europe/Paris)"), which the app classified as an ordinary agent failure
 * and retried anyway — M72 alone relaunched four times in twelve minutes,
 * each retry guaranteed to hit the exact same wall, before finally reporting
 * only "Mission failed after retry — see agent logs" even though the app had
 * already captured both the real cause and the reset time. Matched FIRST
 * (before noCreditsPolicy/environmentalPolicy/taskFailurePolicy/
 * defaultPolicy) so this condition is never retried even once — unlike
 * no_credits (a wallet the user can top up any time), a quota wall clears
 * itself only at a KNOWN clock time; retrying before it is guaranteed to
 * fail and only burns scheduler slots, wall-clock, and the mission's own
 * retry budget. See quotaExhaustion.ts's own doc comment for the exact,
 * narrow matching rule (never triggers on a task that merely MENTIONS a
 * session/rate limit).
 */
const quotaExhaustionPolicy: RecoveryPolicy = {
  match: (_stage, error) => detectQuotaExhaustion(error) !== null,
  decide: (_stage, error) => {
    const info = detectQuotaExhaustion(error);
    // match() above already proved this is non-null for this call — info is
    // re-derived rather than threaded through RecoveryPolicy's (stage,
    // error) => boolean `match` shape, which carries no return value.
    const reason = info ? formatQuotaExhaustionReason(info) : error;
    return { action: 'block', delayMs: 0, reason, resetAtMs: info?.resetAtMs };
  },
};

/** BUG-1 — recognizes managedAgent.ts's stopForNoCredits message (and the
 *  raw ManagedUnavailableError code, in case a caller ever passes it
 *  unwrapped). Matched FIRST so a no_credits failure always blocks instead
 *  of being retried by environmentalPolicy/taskFailurePolicy/defaultPolicy —
 *  those would otherwise retry the exact same wallet wall that managedAgent.ts
 *  already gave up on after one attempt, doubling the retry layer. */
const isNoCreditsError = (error: string): boolean => {
  const lower = error.toLowerCase();
  return lower.includes('crédits pro épuisés') || lower.includes('no_credits');
};

const noCreditsPolicy: RecoveryPolicy = {
  match: (_stage, error) => isNoCreditsError(error),
  decide: (_stage, _error, t) => ({
    action: 'block',
    delayMs: 0,
    reason: t
      ? t('agents.managedAgent.noCreditsMessage')
      : 'Crédits Pro épuisés — recharge ou bascule sur ton abonnement CLI dans Réglages > Modèles.',
  }),
};

const environmentalPolicy: RecoveryPolicy = {
  match: (_stage, error) => isEnvironmentalError(error),
  decide: (stage, _error) => {
    if (stage.attemptCount < stage.maxAttempts) {
      const backoff = Math.min(1000 * Math.pow(2, stage.attemptCount - 1), 8000);
      return {
        action: 'retry',
        delayMs: backoff,
        reason: `Environmental error — retrying with ${backoff}ms backoff (attempt ${stage.attemptCount + 1}/${stage.maxAttempts})`,
      };
    }
    return {
      action: 'block',
      delayMs: 0,
      reason: 'Environmental error persists after max retries — operator intervention needed',
    };
  },
};

const taskFailurePolicy: RecoveryPolicy = {
  match: (stage, error) => isTaskFailure(error) && stage.kind !== 'fix',
  decide: (stage, _error) => {
    if (stage.onFail) {
      return {
        action: 'retry',
        delayMs: 0,
        reason: `Task failure — routing to fix stage: ${stage.onFail}`,
      };
    }
    if (stage.attemptCount < stage.maxAttempts) {
      return {
        action: 'retry',
        delayMs: 500,
        reason: `Task failure — retrying (attempt ${stage.attemptCount + 1}/${stage.maxAttempts})`,
      };
    }
    return {
      action: 'block',
      delayMs: 0,
      reason: 'Task failed after max attempts — needs operator review',
    };
  },
};

const fixStagePolicy: RecoveryPolicy = {
  match: (stage) => stage.kind === 'fix',
  decide: (stage, _error) => {
    if (stage.attemptCount < stage.maxAttempts) {
      return {
        action: 'retry',
        delayMs: 300,
        reason: `Fix stage retrying (attempt ${stage.attemptCount + 1}/${stage.maxAttempts})`,
      };
    }
    return {
      action: 'operator_needed',
      delayMs: 0,
      reason: 'Fix stage exhausted retries — operator must review and provide guidance',
    };
  },
};

const defaultPolicy: RecoveryPolicy = {
  match: () => true,
  decide: (stage, _error) => {
    if (stage.attemptCount < stage.maxAttempts) {
      return {
        action: 'retry',
        delayMs: 500,
        reason: `Retrying stage (attempt ${stage.attemptCount + 1}/${stage.maxAttempts})`,
      };
    }
    return {
      action: 'block',
      delayMs: 0,
      reason: 'Stage failed after max attempts — blocked for operator review',
    };
  },
};

const POLICIES: RecoveryPolicy[] = [quotaExhaustionPolicy, noCreditsPolicy, environmentalPolicy, taskFailurePolicy, fixStagePolicy, defaultPolicy];

// ── Public API ────────────────────────────────────────────────────

export function evaluateRecovery(stage: StageContract, error: string, t?: Translate): RecoveryDecision {
  for (const policy of POLICIES) {
    if (policy.match(stage, error)) {
      return policy.decide(stage, error, t);
    }
  }
  return defaultPolicy.decide(stage, error, t);
}

export function applyRecovery(
  plan: CompiledPlan,
  stageId: string,
  error: string,
  t?: Translate,
): { plan: CompiledPlan; decision: RecoveryDecision } {
  const stage = plan.graph.stages.find((s) => s.id === stageId);
  if (!stage) {
    return {
      plan,
      decision: { action: 'block', delayMs: 0, reason: 'Stage not found' },
    };
  }

  const decision = evaluateRecovery(stage, error, t);

  switch (decision.action) {
    case 'retry':
      return { plan: startStage(plan, stageId), decision };
    case 'block':
    case 'operator_needed':
      return { plan: blockStage(plan, stageId, error), decision };
    case 'skip':
      return {
        plan: {
          ...plan,
          graph: {
            ...plan.graph,
            stages: plan.graph.stages.map((s) =>
              s.id === stageId ? { ...s, state: 'skipped' as const } : s,
            ),
          },
        },
        decision,
      };
    default:
      return { plan: blockStage(plan, stageId, error), decision };
  }
}

export function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
