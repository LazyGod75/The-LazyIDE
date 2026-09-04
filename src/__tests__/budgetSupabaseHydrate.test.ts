import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  chargedUsdSum,
  fetchLedgerChargedCredits,
  hydrateBudgetFromSupabase,
  startBudgetLedgerReconcile,
  sumLedgerCredits,
  type LedgerRow,
  type SessionUserClient,
} from '../lib/agents/budgetSupabaseHydrate';
import {
  getGlobalBudget,
  hydrateGlobalSpentCents,
  spend,
  _resetBudgetTrackerForTests,
} from '../lib/agents/budgetTracker';

beforeEach(() => {
  _resetBudgetTrackerForTests();
});

describe('chargedUsdSum', () => {
  it('sums finite charged USD including refunds, skipping junk', () => {
    const rows: LedgerRow[] = [
      { cost_charged_usd: 1.5 },
      { cost_charged_usd: '0.25' },
      { cost_charged_usd: null },
      { cost_charged_usd: 'nope' },
      { cost_charged_usd: -0.1 },
    ];
    expect(chargedUsdSum(rows)).toBeCloseTo(1.65, 5);
  });
});

describe('sumLedgerCredits', () => {
  it('returns null on a query error — never invents an empty ledger', async () => {
    const cents = await sumLedgerCredits({
      fetchPage: async () => ({ rows: null, error: true }),
    });
    expect(cents).toBeNull();
  });

  it('pages until a short page and converts via usdToCredits', async () => {
    const cents = await sumLedgerCredits({
      fetchPage: async (offset) => {
        if (offset === 0) {
          return { rows: [{ cost_charged_usd: 1.0 }], error: false };
        }
        return { rows: [], error: false };
      },
    });
    expect(cents).toBe(100);
  });
});

function mockClient(opts: {
  userId?: string;
  pages: Array<{ data: LedgerRow[] | null; error: { message: string } | null }>;
}): SessionUserClient {
  const pages = [...opts.pages];
  return {
    auth: {
      getSession: async () => ({
        data: { session: opts.userId ? { user: { id: opts.userId } } : null },
      }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          range: async () => pages.shift() ?? { data: [], error: null },
        }),
      }),
    }),
  };
}

describe('fetchLedgerChargedCredits', () => {
  it('skips when there is no signed-in session', async () => {
    expect(await fetchLedgerChargedCredits(mockClient({ pages: [] }))).toBeNull();
  });

  it('sums the signed-in user ledger', async () => {
    const cents = await fetchLedgerChargedCredits(mockClient({
      userId: 'u1',
      pages: [{ data: [{ cost_charged_usd: 4.2 }], error: null }],
    }));
    expect(cents).toBe(420);
  });
});

describe('hydrateBudgetFromSupabase', () => {
  it('lifts the live tracker and never drops a higher live spend', async () => {
    spend('m1', 'p1', 900);
    const cents = await hydrateBudgetFromSupabase(mockClient({
      userId: 'u1',
      pages: [{ data: [{ cost_charged_usd: 1.0 }], error: null }],
    }));
    expect(cents).toBe(100);
    expect(getGlobalBudget().spentCents).toBe(900);
  });

  it('hydrates from the ledger when live spend is lower', async () => {
    hydrateGlobalSpentCents(10);
    const cents = await hydrateBudgetFromSupabase(mockClient({
      userId: 'u1',
      pages: [{ data: [{ cost_charged_usd: 2.5 }], error: null }],
    }));
    expect(cents).toBe(250);
    expect(getGlobalBudget().spentCents).toBe(250);
  });

  it('leaves the tracker untouched when the query fails', async () => {
    spend('m1', 'p1', 50);
    const cents = await hydrateBudgetFromSupabase(mockClient({
      userId: 'u1',
      pages: [{ data: null, error: { message: 'rls' } }],
    }));
    expect(cents).toBeNull();
    expect(getGlobalBudget().spentCents).toBe(50);
  });

  it('swallows a thrown client and does not invent spend', async () => {
    const boom: SessionUserClient = {
      auth: { getSession: async () => { throw new Error('offline'); } },
      from: () => ({ select: () => ({ eq: () => ({ range: async () => ({ data: null, error: null }) }) }) }),
    };
    expect(await hydrateBudgetFromSupabase(boom)).toBeNull();
    expect(getGlobalBudget().spentCents).toBe(0);
  });
});

describe('startBudgetLedgerReconcile', () => {
  it('re-reads the ledger on an interval and stops when unsubscribed', async () => {
    vi.useFakeTimers();
    let fetches = 0;
    const client: SessionUserClient = {
      auth: {
        getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            range: async () => {
              fetches += 1;
              return { data: [{ cost_charged_usd: 1 }], error: null };
            },
          }),
        }),
      }),
    };
    const stop = startBudgetLedgerReconcile(client, 1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toBeGreaterThanOrEqual(1);
    const afterFirst = fetches;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetches).toBeGreaterThan(afterFirst);
    stop();
    const frozen = fetches;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetches).toBe(frozen);
    vi.useRealTimers();
  });
});
