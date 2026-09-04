/* managedAgentTurnError.ts — in-loop stream-error classification extracted
   from planAndActManaged.

   Measured 2026-08-28: planAndActManaged cyclomatic complexity was 71 after
   the prepare/final/execute split (ESLint ceiling 12). This module owns the
   money-incident AbortError path, BUG-1 no_credits, the 2026-08-05 DeepSeek
   402 definitive-provider path, and V4 transient retry. Behavior is copied,
   not redesigned. Does not import managedAgent.ts (cycle). */

import { ManagedUnavailableError } from '../models/managedProvider.js';
import { classifyDefinitiveProviderError } from '../models/byokProviders.js';
import type { ActionEvent } from './types.js';
import { agentErrorEvent } from './agentError.js';
import type { TFunc } from './runtime.js';

export type ClassifiedTurnError =
  | { kind: 'abort' }
  | { kind: 'no_credits' }
  | { kind: 'provider'; providerId: string; shortReason: string }
  | { kind: 'transient' };

export function classifyManagedTurnError(err: unknown): ClassifiedTurnError {
  if (err instanceof Error && err.name === 'AbortError') return { kind: 'abort' };
  if (err instanceof ManagedUnavailableError && err.code === 'no_credits') return { kind: 'no_credits' };
  const definitive = classifyDefinitiveProviderError(err);
  if (definitive) {
    return { kind: 'provider', providerId: definitive.providerId, shortReason: definitive.shortReason };
  }
  return { kind: 'transient' };
}

export function applyManagedTurnError(
  err: unknown,
  opts: {
    consecutiveFailures: number;
    maxConsecutiveFailures: number;
    nowTime: () => string;
    onAction: (event: ActionEvent) => void;
    stopForNoCredits: () => void;
    stopForDefinitiveProviderError: (providerId: string, shortReason: string) => void;
    escalateAndStop: () => void;
    t?: TFunc;
  },
): 'stop' | { retry: number } {
  const classified = classifyManagedTurnError(err);
  if (classified.kind === 'abort') {
    opts.onAction({ time: opts.nowTime(), text: 'Agent stopped by user', isLive: false });
    return 'stop';
  }
  if (classified.kind === 'no_credits') {
    opts.stopForNoCredits();
    return 'stop';
  }
  if (classified.kind === 'provider') {
    opts.stopForDefinitiveProviderError(classified.providerId, classified.shortReason);
    return 'stop';
  }
  const consecutiveFailures = opts.consecutiveFailures + 1;
  opts.onAction(agentErrorEvent(opts.nowTime(), String(err), opts.t));
  if (consecutiveFailures >= opts.maxConsecutiveFailures) {
    opts.escalateAndStop();
    return 'stop';
  }
  return { retry: consecutiveFailures };
}
