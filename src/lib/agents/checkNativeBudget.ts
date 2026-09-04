/* checkNativeBudget — native/BYOK post-hoc spend check after planAndAct.

   Extracted from runMission so the nested arrow (complexity 12) can sit on
   the ESLint ratchet. classifyBudget stays in runtime.ts; this module takes
   the already-classified status to avoid a runtime ↔ here value cycle.
   Callbacks own journal/timeline/kill side effects — this file does not
   import emitBuffered or killAgentRun.
*/

import { usdToCredits } from '../billing/credits.js';

export interface NativeBudgetCheckCtx {
  isNativeRail: boolean;
  budgetCapUsd: number | undefined;
  budgetExceeded: boolean;
  budgetWarned: boolean;
  onNativeEquivalent: (spentCredits: number, pct: number) => void;
  onExceeded: (spentUsd: number) => void;
  onWarning: (pct: number, spentUsd: number) => void;
}

function applyExceeded(costUsd: number, ctx: NativeBudgetCheckCtx): void {
  if (ctx.budgetExceeded) return;
  if (ctx.isNativeRail) {
    ctx.onNativeEquivalent(usdToCredits(costUsd), 100);
    return;
  }
  ctx.onExceeded(costUsd);
}

function applyWarning(costUsd: number, ctx: NativeBudgetCheckCtx): void {
  if (ctx.budgetWarned) return;
  const pct = ctx.budgetCapUsd ? Math.round((costUsd / ctx.budgetCapUsd) * 100) : 0;
  if (ctx.isNativeRail) {
    ctx.onNativeEquivalent(usdToCredits(costUsd), pct);
    return;
  }
  ctx.onWarning(pct, costUsd);
}

export function checkNativeBudget(
  status: 'ok' | 'warning' | 'exceeded',
  costUsd: number,
  ctx: NativeBudgetCheckCtx,
): void {
  if (status === 'exceeded') {
    applyExceeded(costUsd, ctx);
    return;
  }
  if (status === 'warning') applyWarning(costUsd, ctx);
}
