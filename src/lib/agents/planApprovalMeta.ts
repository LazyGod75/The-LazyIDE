/* planApprovalMeta — Plan-mode review math for PlanApprovalPanel.

   Only real OrchestratorPlanStep fields. Missing budgetCapUsd is omitted,
   never invented. usdToCredits is the single $-to-credits conversion.
*/

import type { OrchestratorPlanStep } from './types.js';
import { formatCredits, usdToCredits } from '../billing/credits.js';

/** One step's meta line: model/effort/budget/dependsOn, each shown only when
    present (never a fabricated placeholder) — pure, independently testable. */
export function stepMetaLine(step: OrchestratorPlanStep, stepById: ReadonlyMap<string, number>): string {
  const parts: string[] = [];
  if (step.agentName) parts.push(`@${step.agentName}`);
  if (step.modelId) parts.push(step.modelId);
  else if (step.model) parts.push(step.model);
  if (step.effort) parts.push(`effort:${step.effort}`);
  if (step.budgetCapUsd != null) parts.push(`${formatCredits(usdToCredits(step.budgetCapUsd))} credits max`);
  if (step.dependsOn.length > 0) {
    const depNums = step.dependsOn.map((depId) => {
      const n = stepById.get(depId);
      return n !== undefined ? `#${n + 1}` : depId;
    });
    parts.push(`after ${depNums.join(', ')}`);
  }
  return parts.join(' · ');
}

/** Files this step declared it will touch — plan review analog.
    Absent/empty → null (never a fabricated path list). */
export function stepScopeLine(step: OrchestratorPlanStep): string | null {
  const paths = step.scopePaths?.filter((p) => p.trim().length > 0) ?? [];
  if (paths.length === 0) return null;
  const shown = paths.slice(0, 4);
  const extra = paths.length - shown.length;
  return extra > 0 ? `touches ${shown.join(', ')} +${extra}` : `touches ${shown.join(', ')}`;
}

export interface PlanCostRollup {
  totalSteps: number;
  cappedSteps: number;
  /** Sum of present per-step caps in credits; null when no step has a cap. */
  creditsMax: number | null;
}

export function planCostRollup(steps: readonly OrchestratorPlanStep[]): PlanCostRollup {
  let cappedSteps = 0;
  let credits = 0;
  for (const s of steps) {
    if (s.budgetCapUsd == null) continue;
    cappedSteps += 1;
    credits += usdToCredits(s.budgetCapUsd);
  }
  return {
    totalSteps: steps.length,
    cappedSteps,
    creditsMax: cappedSteps > 0 ? credits : null,
  };
}

/** Locale-free confirm line used by tests; the panel may wrap this in i18n. */
export function planConfirmSummary(rollup: PlanCostRollup): string {
  const steps = rollup.totalSteps === 1 ? '1 step' : `${rollup.totalSteps} steps`;
  if (rollup.creditsMax == null) return `${steps} · no per-step credit caps`;
  const caps = rollup.cappedSteps === 1 ? '1 step' : `${rollup.cappedSteps} steps`;
  return `${steps} · ${formatCredits(rollup.creditsMax)} credits max on ${caps}`;
}
