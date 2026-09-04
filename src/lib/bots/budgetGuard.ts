/* budgetGuard — per-bot budget tracking and enforcement.

   Tracks the cumulative cost of a bot's runs and enforces a budget cap.
   A 90% warning is informational — it MUST NOT throw or block a launch.
   Only a true cap crossing (checkBotBudgetExceeded) is a hard stop.
*/

interface BotBudget {
  botId: string;
  totalCostUsd: number;
  runCount: number;
  /** The budget cap in USD, or 0 for unlimited. */
  capUsd: number;
}

const budgets = new Map<string, BotBudget>();

function emptyBudget(botId: string): BotBudget {
  return { botId, totalCostUsd: 0, runCount: 0, capUsd: 0 };
}

/** Set the budget cap for a bot. 0 = unlimited. */
export function setBotBudgetCap(botId: string, capUsd: number): void {
  const existing = budgets.get(botId) ?? emptyBudget(botId);
  budgets.set(botId, { ...existing, capUsd });
}

/** Record a cost for a bot run. Returns the updated total. Never throws. */
export function recordBotCost(botId: string, costUsd: number): number {
  const existing = budgets.get(botId) ?? emptyBudget(botId);
  const updated: BotBudget = {
    ...existing,
    totalCostUsd: existing.totalCostUsd + costUsd,
    runCount: existing.runCount + 1,
  };
  budgets.set(botId, updated);
  return updated.totalCostUsd;
}

/** Get the current budget state for a bot. */
export function getBotBudget(botId: string): {
  totalCostUsd: number;
  runCount: number;
  capUsd: number;
  remainingUsd: number | null;
  percentUsed: number;
} {
  const budget = budgets.get(botId);
  if (!budget) return { totalCostUsd: 0, runCount: 0, capUsd: 0, remainingUsd: null, percentUsed: 0 };
  const remainingUsd = budget.capUsd > 0 ? Math.max(0, budget.capUsd - budget.totalCostUsd) : null;
  const percentUsed = budget.capUsd > 0 ? Math.min(100, (budget.totalCostUsd / budget.capUsd) * 100) : 0;
  return {
    totalCostUsd: budget.totalCostUsd,
    runCount: budget.runCount,
    capUsd: budget.capUsd,
    remainingUsd,
    percentUsed,
  };
}

/** Hard stop only — null unless spend is at or over the cap. */
export function checkBotBudgetExceeded(botId: string): string | null {
  const budget = budgets.get(botId);
  if (!budget || budget.capUsd <= 0) return null;
  if (budget.totalCostUsd < budget.capUsd) return null;
  return `Budget exceeded for this bot: $${budget.totalCostUsd.toFixed(4)} spent of $${budget.capUsd.toFixed(2)} cap. Raise the cap in the bot settings to continue.`;
}

/** Informational 90% band — never a launch blocker. */
export function checkBotBudgetWarning(botId: string): string | null {
  const budget = budgets.get(botId);
  if (!budget || budget.capUsd <= 0) return null;
  if (budget.totalCostUsd >= budget.capUsd) return null;
  if (budget.totalCostUsd < budget.capUsd * 0.9) return null;
  return `Budget warning: 90% of the cap has been reached ($${budget.totalCostUsd.toFixed(4)} of $${budget.capUsd.toFixed(2)}).`;
}

/** Display helper: exceeded first, else the 90% warning, else null.
 *  Callers that launch a run MUST use checkBotBudgetExceeded instead —
 *  a warning here must not be treated as an error. */
export function checkBotBudget(botId: string): string | null {
  return checkBotBudgetExceeded(botId) ?? checkBotBudgetWarning(botId);
}

/** Clear all budget data — tests and hot-reload only. */
export function resetBudgetGuard(): void {
  budgets.clear();
}
