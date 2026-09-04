/* actionGate.ts — Per-mode action gating (Pillar C2).
   Decides whether an action runs automatically, asks for approval, or is denied.
   Phase 2: now uses actionClassifier for definitive classification and logs
   every gate decision via gateAuditLog.
*/

import type { AutonomyConfig } from './types.js';
import { getEffectiveAutonomy } from './autonomyMode.js';
import { getGlobalBudget } from './budgetTracker.js';
import { classifyAction } from './actionClassifier.js';
import { appendGateAuditEntry, type GateAuditEntry } from './gateAuditLog.js';

export interface GateResult {
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
}

export interface GateContext {
  projectId?: string;
  costEstimateCents?: number;
  customRules?: unknown[];
  turnId?: string;
  /** Full action payload (every field but `type`) — required for
   *  classifiers that vary tier by field, e.g. clear_canvas's
   *  mode: 'archive' | 'delete' (see classifyAction's doc comment). */
  payload?: Record<string, unknown>;
}

export async function evaluateActionGate(
  actionType: string,
  config?: AutonomyConfig,
  context?: GateContext,
): Promise<GateResult> {
  const autonomy = getEffectiveAutonomy(config);
  const tier = classifyAction(actionType, context?.payload);

  let result: GateResult;

  if (autonomy.deniedActions?.includes(actionType)) {
    result = { decision: 'deny', reason: `Action '${actionType}' is on the denied list.` };
  } else if (autonomy.allowedActions?.length && !autonomy.allowedActions.includes(actionType)) {
    result = { decision: 'deny', reason: `Action '${actionType}' is not on the allowed list.` };
  } else if (context?.costEstimateCents && autonomy.budgetLimit !== undefined) {
    const { spentCents } = getGlobalBudget();
    if (spentCents + context.costEstimateCents > autonomy.budgetLimit) {
      result = { decision: 'deny', reason: 'Action would exceed autonomy budget limit.' };
    } else {
      result = computeGateDecision(actionType, tier, autonomy.mode);
    }
  } else {
    result = computeGateDecision(actionType, tier, autonomy.mode);
  }

  // Audit log — best-effort, never blocks
  const entry: GateAuditEntry = {
    timestamp: new Date().toISOString(),
    actionType,
    decision: result.decision,
    reason: result.reason,
    turnId: context?.turnId,
    autonomyMode: autonomy.mode,
  };
  appendGateAuditEntry(entry).catch(() => { /* best-effort */ });

  return result;
}

function computeGateDecision(actionType: string, tier: 'safe' | 'sensitive' | 'destructive' | 'unknown', mode: string): GateResult {
  if (mode === 'manual') {
    return { decision: 'ask', reason: 'Manual mode requires user validation for every action.' };
  }

  if (tier === 'safe') {
    return { decision: 'allow', reason: 'Safe action allowed in current autonomy mode.' };
  }

  if (mode === 'yolo') {
    if (tier === 'destructive') {
      return { decision: 'ask', reason: 'Destructive action requires confirmation even in YOLO mode.' };
    }
    return { decision: 'allow', reason: 'YOLO mode allows actions within budget.' };
  }

  if (tier === 'destructive' || tier === 'sensitive') {
    return { decision: 'ask', reason: `${tier === 'destructive' ? 'Destructive' : 'Sensitive'} action requires validation in supervised/custom mode.` };
  }

  // Unknown action type — default to ask for safety
  if (tier === 'unknown') {
    return { decision: 'ask', reason: `Unknown action type '${actionType}' requires validation.` };
  }

  return { decision: 'allow', reason: 'Action allowed by policy.' };
}

/** Synchronous version for cases where async is not available (e.g. inside
 *  a tight loop). Does NOT write to the audit log — use the async version
 *  for the universal gate path. */
export function evaluateActionGateSync(
  actionType: string,
  config?: AutonomyConfig,
  context?: GateContext,
): GateResult {
  const autonomy = getEffectiveAutonomy(config);
  const tier = classifyAction(actionType, context?.payload);

  if (autonomy.deniedActions?.includes(actionType)) {
    return { decision: 'deny', reason: `Action '${actionType}' is on the denied list.` };
  }

  if (autonomy.allowedActions?.length && !autonomy.allowedActions.includes(actionType)) {
    return { decision: 'deny', reason: `Action '${actionType}' is not on the allowed list.` };
  }

  if (context?.costEstimateCents && autonomy.budgetLimit !== undefined) {
    const { spentCents } = getGlobalBudget();
    if (spentCents + context.costEstimateCents > autonomy.budgetLimit) {
      return { decision: 'deny', reason: 'Action would exceed autonomy budget limit.' };
    }
  }

  return computeGateDecision(actionType, tier, autonomy.mode);
}
