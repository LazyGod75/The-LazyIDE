/* budgetSupabaseHydrate — read-through from usage_events into budgetTracker.

   Local usageHistory is not the managed-rail source of truth. This module
   sums cost_charged_usd from the signed-in user's own RLS-scoped rows.
   No session / query error → null (never invent 0 spend that would look
   like a successful empty ledger). hydrateGlobalSpentCents uses max() so
   a concurrent live spend() is never clobbered.
*/

import { usdToCredits } from '../billing/credits.js';
import { supabase } from '../supabase/client.js';
import { hydrateGlobalSpentCents } from './budgetTracker.js';

export interface LedgerRow {
  cost_charged_usd: number | string | null;
}

export interface LedgerPageQuery {
  fetchPage: (offset: number, limit: number) => Promise<{
    rows: LedgerRow[] | null;
    error: boolean;
  }>;
}

const PAGE_SIZE = 1000;
const MAX_PAGES = 10;

/** Net charged USD across rows. Non-finite values are skipped, never invented.
    Negative rows (refunds) count — the ledger is a real sum. */
export function chargedUsdSum(rows: readonly LedgerRow[]): number {
  let usd = 0;
  for (const r of rows) {
    const n = Number(r.cost_charged_usd ?? 0);
    if (!Number.isFinite(n)) continue;
    usd += n;
  }
  return usd;
}

/** Page the ledger until a short page or the hard cap. error → null. */
export async function sumLedgerCredits(query: LedgerPageQuery): Promise<number | null> {
  let usd = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { rows, error } = await query.fetchPage(page * PAGE_SIZE, PAGE_SIZE);
    if (error || !rows) return null;
    usd += chargedUsdSum(rows);
    if (rows.length < PAGE_SIZE) break;
  }
  if (usd < 0) return 0;
  return usdToCredits(usd);
}

export interface SessionUserClient {
  auth: {
    getSession: () => Promise<{
      data: { session: { user: { id: string } } | null };
    }>;
  };
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        range: (from: number, to: number) => Promise<{
          data: LedgerRow[] | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
}

export async function fetchLedgerChargedCredits(
  client: SessionUserClient,
): Promise<number | null> {
  const { data } = await client.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) return null;
  return sumLedgerCredits({
    fetchPage: async (offset, limit) => {
      const { data: rows, error } = await client
        .from('usage_events')
        .select('cost_charged_usd')
        .eq('user_id', userId)
        .range(offset, offset + limit - 1);
      if (error) return { rows: null, error: true };
      return { rows: rows ?? [], error: false };
    },
  });
}

export async function hydrateBudgetFromSupabase(
  client: SessionUserClient = supabase as unknown as SessionUserClient,
): Promise<number | null> {
  try {
    const cents = await fetchLedgerChargedCredits(client);
    if (cents == null) return null;
    hydrateGlobalSpentCents(cents);
    return cents;
  } catch {
    return null;
  }
}

/** Cursor `/usage` analog: re-read the durable ledger while the cockpit stays
    open. No session / error stays a no-op (hydrateBudgetFromSupabase). */
export const LEDGER_RECONCILE_MS = 60_000;

export function startBudgetLedgerReconcile(
  client: SessionUserClient = supabase as unknown as SessionUserClient,
  intervalMs: number = LEDGER_RECONCILE_MS,
): () => void {
  void hydrateBudgetFromSupabase(client);
  const id = setInterval(() => {
    void hydrateBudgetFromSupabase(client);
  }, intervalMs);
  return () => clearInterval(id);
}
