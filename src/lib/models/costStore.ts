/* costStore — simple in-memory token/cost accumulator for the session.
   Consumers call addUsage() after each model call; useCostStore() subscribes.
*/

import { usdToCredits } from '../billing/credits.js';
import { recordUsageSpendCents } from '../agents/budgetTracker.js';
import { recordUsage as historyRecordUsage, recordBrainSavings as historyRecordBrainSavings } from './usageHistory.js';
import { estimateUsageUsd } from './estimateUsageUsd.js';

export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** Anthropic prompt-cache breakdown for this record — present only when
   *  the caller (managedProvider.ts's RealUsage, forwarded from ai-proxy's
   *  settled `\x1b[usage]` marker) actually reported real cache usage for
   *  this turn. Absent for BYOK/CLI providers, chars/4-estimated turns, and
   *  any older ai-proxy deployment that doesn't emit the fields yet. Purely
   *  observational — never fed into totalCostUsd below, which already
   *  reflects the real charge (or estimateUsageUsd for BYOK/CLI). */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Estimated USD this record saved (or, on a cache-priming call, spent
   *  extra) vs. no caching — see ai-proxy's CostBreakdown.cacheSavingsUsd. */
  cacheSavingsUsd?: number;
  /** REAL settled USD cost for this call, when the backend reported it.
   *  Managed (managedProvider.ts, forwarding ai-proxy's settled `\x1b[usage]`
   *  marker) supplies it; the marker's costUsd is the authoritative price the
   *  user was actually charged — 0 for free models (ox alpha). BYOK/CLI
   *  providers and chars/4-estimated turns omit it, so addUsage falls back to
   *  catalog rates (Haiku 0.80/4.00 only when the id is unknown). */
  costUsd?: number;
}

export interface CostState {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalBrainTokensSaved: number;
  totalCostUsd: number;
  /** Cumulative cache read/write tokens and net estimated USD saved (can go
   *  negative on a cache-priming-heavy session — see UsageRecord above)
   *  across every addUsage() call this session that reported real cache
   *  usage. Zero for a session with no managed-backend cache activity —
   *  never assumed, only ever incremented from a real reported figure. */
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCacheSavingsUsd: number;
}

type Listener = (state: CostState) => void;

let _state: CostState = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalBrainTokensSaved: 0,
  totalCostUsd: 0,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  totalCacheSavingsUsd: 0,
};

const _listeners = new Set<Listener>();

function notify(): void {
  const snapshot = { ..._state };
  _listeners.forEach(fn => fn(snapshot));
}

export function addUsage(record: UsageRecord): void {
  // Real settled cost wins when the backend reported it (managed provider,
  // forwarding ai-proxy's `\x1b[usage]` marker). Free models settle at 0 —
  // the catalog/fallback estimate would otherwise invent a charge.
  // BYOK/CLI and chars/4-estimated turns omit costUsd and keep the estimate.
  const cost =
    record.costUsd !== undefined
      ? Math.max(0, record.costUsd)
      : estimateUsageUsd(record.model, record.inputTokens, record.outputTokens);

  _state = {
    ..._state,
    totalInputTokens:  _state.totalInputTokens  + record.inputTokens,
    totalOutputTokens: _state.totalOutputTokens + record.outputTokens,
    totalCostUsd:      _state.totalCostUsd      + cost,
    totalCacheReadTokens:     _state.totalCacheReadTokens     + (record.cacheReadTokens ?? 0),
    totalCacheCreationTokens: _state.totalCacheCreationTokens + (record.cacheCreationTokens ?? 0),
    totalCacheSavingsUsd:     _state.totalCacheSavingsUsd     + (record.cacheSavingsUsd ?? 0),
  };

  try {
    historyRecordUsage({ inputTokens: record.inputTokens, outputTokens: record.outputTokens, costUsd: cost, model: record.model });
  } catch { /* best-effort forwarding — must never throw into callers */ }

  notify();
  recordUsageSpendCents(usdToCredits(cost));
}

export function addBrainSavings(tokensSaved: number): void {
  if (!Number.isFinite(tokensSaved) || tokensSaved <= 0) return;
  const rounded = Math.round(tokensSaved);
  _state = {
    ..._state,
    totalBrainTokensSaved: _state.totalBrainTokensSaved + rounded,
  };
  try {
    historyRecordBrainSavings(rounded);
  } catch { /* best-effort forwarding */ }
  notify();
}

export function getCostState(): CostState {
  return { ..._state };
}

export function subscribeCost(fn: Listener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function resetCost(): void {
  _state = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalBrainTokensSaved: 0,
    totalCostUsd: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheSavingsUsd: 0,
  };
  _bySource = { codeur: 0, mission: 0, manager: 0, tool: 0 };
  notify();
}

// ── Recall-savings choke point ──────────────────────────────────────
//
// Every real brain recall (Codeur chat, mission launch/prompt-header,
// LazyManager chat, tool-loop brain search) funnels its MEASURED saving
// through recordRecallSaving so CockpitKpiBar's aggregate reflects every
// recall, not just one surface. Root cause of the "always 0" complaint:
// normalizeRecall (src/lib/brain/context.ts) computes a real tokensSaved
// estimate on every call, but only assistantStore.tsx (Codeur chat) ever
// forwarded it to addBrainSavings — mission launches (runtime.ts,
// managedAgent.ts), the tool-loop's BRAIN_SEARCH directive
// (brainSearchLoop.ts) and the brain_query/brain_synthesize tools
// (toolRuntime.ts) computed a real saving and then let it evaporate. A
// user whose brain usage is mission-driven (the common cockpit workflow)
// therefore saw 0 no matter how much the brain actually saved.
export type RecallSavingSource = 'codeur' | 'mission' | 'manager' | 'tool';

let _bySource: Record<RecallSavingSource, number> = {
  codeur: 0,
  mission: 0,
  manager: 0,
  tool: 0,
};

/**
 * Records ONE recall's measured token saving. Call this once per recall
 * result an in-flight turn/mission actually ADOPTED as injected prompt
 * context — never for a discarded candidate (e.g. assistantStore's
 * scope-fallback recall that lost out to the primary one).
 *
 * `source` only feeds `getRecallSavingsBySource` (diagnostics/tests) — the
 * persisted aggregate (usageHistory, via addBrainSavings) stays a single
 * honest total. Non-positive/non-finite values are silently dropped, same
 * as addBrainSavings — never floored to a fake non-zero number.
 *
 * TODO(brain-savings wiring — src/lib/agents/managerEngine.ts is owned by
 * another builder, not edited here): in runManagerTurn(), right after
 * `const recall = normalizeRecall(await getPlatform().brain.recall(lastUserMsg.content));`
 * (~line 881-884), add `recordRecallSaving(recall, 'manager')`.
 */
export function recordRecallSaving(
  recall: { tokensSaved: number } | null | undefined,
  source: RecallSavingSource,
): void {
  if (!recall || !Number.isFinite(recall.tokensSaved) || recall.tokensSaved <= 0) return;
  const rounded = Math.round(recall.tokensSaved);
  _bySource = { ..._bySource, [source]: _bySource[source] + rounded };
  addBrainSavings(rounded);
}

/** Session-scoped per-surface breakdown — diagnostics/tests only, never persisted. */
export function getRecallSavingsBySource(): Readonly<Record<RecallSavingSource, number>> {
  return { ..._bySource };
}
