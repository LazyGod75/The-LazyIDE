/* budgetThreshold — classify spend vs a cap.

   Extracted from budgetTracker.checkThresholds: the same 90%/100%
   branches were duplicated for mission, project, and global scopes.
*/

export type BudgetThresholdKind = 'budget.warning' | 'budget.exceeded';

export function classifyBudgetPct(pct: number): BudgetThresholdKind | null {
  if (!Number.isFinite(pct)) return null;
  if (pct >= 100) return 'budget.exceeded';
  if (pct >= 90) return 'budget.warning';
  return null;
}

export function emitIfOverThreshold(
  spentCents: number,
  limitCents: number | undefined,
  emit: (kind: BudgetThresholdKind, capUsd: number, spentUsd: number, pct: number) => void,
): void {
  if (limitCents === undefined) return;
  const pct = Math.round((spentCents / limitCents) * 100);
  const kind = classifyBudgetPct(pct);
  if (!kind) return;
  emit(kind, limitCents / 100, spentCents / 100, pct);
}
