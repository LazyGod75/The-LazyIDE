/* budgetGuard — per-bot budget tracking and enforcement.

   Tracks the cumulative cost of a bot's runs and enforces a budget cap.
   A 90% warning is informational — it MUST NOT throw or block a launch.
   Only a true cap crossing (checkBotBudgetExceeded) is a hard stop.

   Spend is persisted to `.lazy/bot-budget.json` so cumulative totals survive
   an app restart. Persistence is best-effort and never throws.
*/

import { getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';
import { getCachedProjectRoot } from '../agents/projectRootCache.js';

const BOT_BUDGET_FILE = '.lazy/bot-budget.json';
const BUDGET_VERSION = '1.0.0';

interface BotBudget {
  botId: string;
  totalCostUsd: number;
  runCount: number;
  /** The budget cap in USD, or 0 for unlimited. */
  capUsd: number;
  /** ISO timestamp of the last spend update written to disk. */
  updatedAt?: string;
}

interface BudgetFile {
  version: string;
  spend: Record<string, { totalUsd: number; updatedAt: string }>;
}

const budgets = new Map<string, BotBudget>();
let budgetRoot: string | null = null;
let hydratePromise: Promise<void> | null = null;
let opTail: Promise<unknown> = Promise.resolve();

function emptyBudget(botId: string): BotBudget {
  return { botId, totalCostUsd: 0, runCount: 0, capUsd: 0 };
}

function rootPath(): string {
  return budgetRoot ?? getCachedProjectRoot() ?? '';
}

function filePath(): string {
  return joinPath(rootPath(), BOT_BUDGET_FILE);
}

function emptyFile(): BudgetFile {
  return { version: BUDGET_VERSION, spend: {} };
}

function normalizeFile(raw: unknown): BudgetFile {
  const out = emptyFile();
  if (typeof raw !== 'object' || raw === null) return out;
  const rec = raw as Record<string, unknown>;
  if (rec.version && typeof rec.version === 'string') out.version = rec.version;
  if (rec.spend && typeof rec.spend === 'object') {
    for (const [botId, value] of Object.entries(rec.spend as Record<string, unknown>)) {
      const entry = value as Record<string, unknown>;
      if (typeof entry?.totalUsd === 'number') {
        out.spend[botId] = {
          totalUsd: entry.totalUsd,
          updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
        };
      }
    }
  }
  return out;
}

async function hydrateOnce(): Promise<void> {
  const root = rootPath();
  if (!root) return;
  try {
    const content = await getPlatform().fs.readFile(filePath());
    const file = normalizeFile(JSON.parse(content));
    for (const [botId, entry] of Object.entries(file.spend)) {
      const existing = budgets.get(botId) ?? emptyBudget(botId);
      budgets.set(botId, {
        ...existing,
        totalCostUsd: existing.totalCostUsd + entry.totalUsd,
        updatedAt: entry.updatedAt,
      });
    }
  } catch {
    // Missing or corrupt file is treated as a fresh budget.
  }
}

function ensureHydrated(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = hydrateOnce();
  return hydratePromise;
}

function enqueueBudgetOp<T>(op: () => Promise<T>): Promise<T> {
  const run = opTail.then(op, op);
  opTail = run.then(() => undefined, () => undefined);
  return run;
}

async function persistBudgets(): Promise<void> {
  const root = rootPath();
  if (!root) return;
  const file: BudgetFile = { version: BUDGET_VERSION, spend: {} };
  for (const [botId, budget] of budgets) {
    if (budget.totalCostUsd > 0) {
      file.spend[botId] = {
        totalUsd: budget.totalCostUsd,
        updatedAt: budget.updatedAt ?? new Date().toISOString(),
      };
    }
  }
  try {
    const platform = getPlatform();
    await platform.fs.createDir?.(joinPath(root, '.lazy'));
    await platform.fs.writeFile(filePath(), JSON.stringify(file, null, 2));
  } catch (err) {
    console.warn('[budgetGuard] persist failed:', err);
  }
}

/** Set the project root that hosts `.lazy/bot-budget.json`. Override for tests. */
export function setBudgetRoot(root: string): void {
  budgetRoot = root;
  hydratePromise = null;
}

/** Force a one-time hydration from disk — tests only. */
export async function hydrateBudgetStore(): Promise<void> {
  await ensureHydrated();
}

/** Wait for queued budget operations to finish — tests only. */
export function flushBudgetStore(): Promise<unknown> {
  return opTail;
}

/** Set the budget cap for a bot. 0 = unlimited. */
export function setBotBudgetCap(botId: string, capUsd: number): void {
  const existing = budgets.get(botId) ?? emptyBudget(botId);
  budgets.set(botId, { ...existing, capUsd });
}

/** Record a cost for a bot run. Returns the updated total. Never throws. */
export function recordBotCost(botId: string, costUsd: number): number {
  const existing = budgets.get(botId) ?? emptyBudget(botId);
  const updatedAt = new Date().toISOString();
  const updated: BotBudget = {
    ...existing,
    totalCostUsd: existing.totalCostUsd + costUsd,
    runCount: existing.runCount + 1,
    updatedAt,
  };
  budgets.set(botId, updated);
  enqueueBudgetOp(async () => {
    await ensureHydrated();
    await persistBudgets();
  }).catch(() => undefined);
  return updated.totalCostUsd;
}

/** Get the current total spend for a bot. */
export function getBotSpend(botId: string): number {
  void ensureHydrated();
  return budgets.get(botId)?.totalCostUsd ?? 0;
}

/** Get the current budget state for a bot. */
export function getBotBudget(botId: string): {
  totalCostUsd: number;
  runCount: number;
  capUsd: number;
  remainingUsd: number | null;
  percentUsed: number;
} {
  void ensureHydrated();
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
  void ensureHydrated();
  const budget = budgets.get(botId);
  if (!budget || budget.capUsd <= 0) return null;
  if (budget.totalCostUsd < budget.capUsd) return null;
  return `Budget exceeded for this bot: $${budget.totalCostUsd.toFixed(4)} spent of $${budget.capUsd.toFixed(2)} cap. Raise the cap in the bot settings to continue.`;
}

/** Informational 90% band — never a launch blocker. */
export function checkBotBudgetWarning(botId: string): string | null {
  void ensureHydrated();
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

/** Reset all budget state for tests, including hydration and the op queue. */
export function resetBudgetForTests(): void {
  budgets.clear();
  hydratePromise = null;
  opTail = Promise.resolve();
}
