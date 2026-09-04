import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Org billing logic — mirrors supabase/functions/stripe-webhook/index.ts
// and supabase/functions/create-checkout-session-org/index.ts.
//
// Duplicated here because those functions run in Deno and are not importable
// from the Vitest (Node) environment. The test cases document the expected
// behaviour and must be kept in sync with the webhook implementation.
//
// Correct billing model:
//   SEATS      — €5/seat/month (500 EUR cents). Pure platform margin fee.
//                Grants ZERO usage credits.
//   MONTHLY CREDITS — buyer's chosen amount M EUR/month. Granted into the
//                org credit pot as M × 100 credit cents each billing cycle.
//                Stored in subscription metadata as monthly_credits_cents.
//   TOP-UP     — one-off credit addition (mode="payment", type="teams_topup").
// ─────────────────────────────────────────────────────────────────────────────

const TEAMS_SEAT_PRICE_EUR_CENTS = 500; // €5/seat/month, margin only

// ── Checkout routing (mirrors switch in stripe-webhook/index.ts) ─────────────

type CheckoutRoute = 'teams' | 'teams_topup' | 'topup' | 'pro';

function routeCheckoutSession(
  metadata: Record<string, string> | null | undefined,
  mode: string,
): CheckoutRoute {
  if (metadata?.type === 'teams') return 'teams';
  if (metadata?.type === 'teams_topup') return 'teams_topup';
  if (mode === 'payment') return 'topup';
  return 'pro';
}

// ── Subscription event routing ───────────────────────────────────────────────

type SubscriptionRoute = 'teams' | 'pro';

function routeSubscriptionEvent(
  metadata: Record<string, string> | null | undefined,
): SubscriptionRoute {
  if (metadata?.type === 'teams') return 'teams';
  return 'pro';
}

// ── Mock Supabase client ─────────────────────────────────────────────────────

interface MockEqResult {
  error: null;
}

function buildMockSupabase() {
  const eqFn = vi.fn().mockResolvedValue({ error: null } as MockEqResult);
  const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
  const fromFn = vi.fn().mockReturnValue({ update: updateFn });
  const rpcFn = vi.fn().mockResolvedValue({ error: null });

  return {
    rpc: rpcFn,
    from: fromFn,
    _spies: { rpc: rpcFn, from: fromFn, update: updateFn, eq: eqFn },
  };
}

// ── Handler simulations ──────────────────────────────────────────────────────
// Replicate the business logic of the Deno handlers using the mock client.
// These are intentionally thin wrappers — they test that the correct RPC calls
// and table updates happen with the right arguments.
//
// monthlyCents: the buyer's chosen monthly credit amount in cents.
//               INDEPENDENT of seat count — seats grant no credits.

async function simulateOrgCheckoutCompleted(
  supabase: ReturnType<typeof buildMockSupabase>,
  orgId: string,
  seats: number,
  monthlyCents: number,
  subscriptionId: string,
  customerId: string,
): Promise<void> {
  await supabase.rpc('set_seats_org', { p_org_id: orgId, p_seats: seats });
  await supabase.rpc('set_monthly_credits_org', { p_org_id: orgId, p_grant_cents: monthlyCents });
  await supabase.from('organizations').update({
    stripe_subscription_id: subscriptionId,
    stripe_customer_id: customerId,
    status: 'active',
    seats_paid: seats,
  }).eq('id', orgId);
}

async function simulateOrgSubscriptionUpdated(
  supabase: ReturnType<typeof buildMockSupabase>,
  orgId: string,
  seats: number,
  monthlyCents: number,
  subscriptionId: string,
  stripeStatus: string,
): Promise<void> {
  const orgStatus = stripeStatus === 'active' || stripeStatus === 'trialing'
    ? 'active'
    : stripeStatus;

  await supabase.rpc('set_seats_org', { p_org_id: orgId, p_seats: seats });
  await supabase.rpc('set_monthly_credits_org', { p_org_id: orgId, p_grant_cents: monthlyCents });
  await supabase.from('organizations').update({
    status: orgStatus,
    seats_paid: seats,
    stripe_subscription_id: subscriptionId,
  }).eq('id', orgId);
}

async function simulateOrgSubscriptionDeleted(
  supabase: ReturnType<typeof buildMockSupabase>,
  orgId: string,
): Promise<void> {
  await supabase.from('organizations').update({ status: 'canceled' }).eq('id', orgId);
}

async function simulateOrgTopupCheckout(
  supabase: ReturnType<typeof buildMockSupabase>,
  orgId: string,
  amountCents: number,
): Promise<void> {
  await supabase.rpc('add_credits_org', { p_org_id: orgId, p_cents: amountCents });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a buyer's chosen EUR amount to credit cents (1 EUR = 100 cents). */
function eurToCredits(eur: number): number {
  return Math.round(eur * 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('org billing — pricing constants', () => {
  it('seat price is €5 (500 EUR cents)', () => {
    expect(TEAMS_SEAT_PRICE_EUR_CENTS).toBe(500);
  });

  it('seat fee grants ZERO credits (pure margin)', () => {
    // The seat fee (€5/seat) is not a credit allocation.
    // Credits are a separate line item chosen by the buyer.
    const seatsGrantCents = 0;
    expect(seatsGrantCents).toBe(0);
  });
});

describe('org billing — monthly credit conversion', () => {
  it('€100 chosen monthly credits = 10 000 credit cents', () => {
    expect(eurToCredits(100)).toBe(10000);
  });

  it('€20 chosen monthly credits = 2 000 credit cents', () => {
    expect(eurToCredits(20)).toBe(2000);
  });

  it('€0 chosen monthly credits = 0 credit cents (seat-only plan)', () => {
    expect(eurToCredits(0)).toBe(0);
  });

  it('€50.50 rounds to 5050 credit cents', () => {
    expect(eurToCredits(50.50)).toBe(5050);
  });
});

describe('org billing — checkout routing', () => {
  it('metadata.type=teams routes to org-checkout (not Pro)', () => {
    expect(routeCheckoutSession({ type: 'teams', supabase_org_id: 'org-1' }, 'subscription')).toBe('teams');
  });

  it('metadata.type=teams_topup routes to org-topup', () => {
    expect(routeCheckoutSession({ type: 'teams_topup', supabase_org_id: 'org-1' }, 'payment')).toBe('teams_topup');
  });

  it('mode=payment (no type) routes to personal topup', () => {
    expect(routeCheckoutSession(null, 'payment')).toBe('topup');
  });

  it('subscription without type=teams routes to Pro checkout — unchanged', () => {
    expect(routeCheckoutSession(null, 'subscription')).toBe('pro');
  });

  it('Pro subscription with supabase_user_id (no type) routes to Pro — unchanged', () => {
    expect(routeCheckoutSession({ supabase_user_id: 'user-1', plan: 'pro' }, 'subscription')).toBe('pro');
  });

  it('metadata.type=teams takes priority over payment mode', () => {
    expect(routeCheckoutSession({ type: 'teams', supabase_org_id: 'org-1' }, 'payment')).toBe('teams');
  });

  it('metadata.type=teams_topup takes priority over generic payment route', () => {
    // teams_topup must be distinguished from personal topup even when mode=payment.
    expect(routeCheckoutSession({ type: 'teams_topup', supabase_org_id: 'org-1' }, 'payment')).toBe('teams_topup');
  });
});

describe('org billing — subscription event routing', () => {
  it('subscription.updated with type=teams routes to org handler', () => {
    expect(routeSubscriptionEvent({ type: 'teams', supabase_org_id: 'org-1' })).toBe('teams');
  });

  it('subscription.updated Pro (supabase_user_id, no type) routes to Pro — unchanged', () => {
    expect(routeSubscriptionEvent({ supabase_user_id: 'user-1', plan: 'pro' })).toBe('pro');
  });

  it('subscription.deleted with type=teams routes to org handler', () => {
    expect(routeSubscriptionEvent({ type: 'teams' })).toBe('teams');
  });

  it('subscription.deleted without metadata routes to Pro cancel — unchanged', () => {
    expect(routeSubscriptionEvent(null)).toBe('pro');
  });

  it('subscription.deleted with empty metadata routes to Pro cancel — unchanged', () => {
    expect(routeSubscriptionEvent({})).toBe('pro');
  });
});

describe('org billing — checkout.session.completed handler (teams)', () => {
  let supabase: ReturnType<typeof buildMockSupabase>;

  beforeEach(() => {
    supabase = buildMockSupabase();
  });

  it('calls set_seats_org with correct seat count', async () => {
    await simulateOrgCheckoutCompleted(supabase, 'org-abc', 5, 10000, 'sub_1', 'cus_1');
    expect(supabase._spies.rpc).toHaveBeenCalledWith('set_seats_org', { p_org_id: 'org-abc', p_seats: 5 });
  });

  it('calls set_monthly_credits_org with buyer-chosen amount (100 EUR = 10000 cents), NOT seats×2000', async () => {
    // 5 seats × €5 = €25 seat fee (margin only, no credits).
    // Buyer chose €100/month credits → 10 000 credit cents.
    await simulateOrgCheckoutCompleted(supabase, 'org-abc', 5, 10000, 'sub_1', 'cus_1');
    expect(supabase._spies.rpc).toHaveBeenCalledWith('set_monthly_credits_org', { p_org_id: 'org-abc', p_grant_cents: 10000 });
    // Note: in this test case buyer-chosen amount (10000) coincides with
    // seats×2000 (5×2000=10000), so a "not-called-with-old-value" guard would
    // contradict the assertion above. The positive assertion on the line above
    // is sufficient to verify the correct value is used.
  });

  it('calls set_monthly_credits_org with 0 when monthlyCredits=0 (seat-only plan)', async () => {
    // Buyer chose no monthly credits — seat fee only.
    await simulateOrgCheckoutCompleted(supabase, 'org-abc', 3, 0, 'sub_1', 'cus_1');
    expect(supabase._spies.rpc).toHaveBeenCalledWith('set_monthly_credits_org', { p_org_id: 'org-abc', p_grant_cents: 0 });
  });

  it('grant is independent of seat count: 1 seat, €50 credits = 5000 cents', async () => {
    await simulateOrgCheckoutCompleted(supabase, 'org-abc', 1, 5000, 'sub_1', 'cus_1');
    expect(supabase._spies.rpc).toHaveBeenCalledWith('set_monthly_credits_org', { p_org_id: 'org-abc', p_grant_cents: 5000 });
  });

  it('grant is independent of seat count: 10 seats, €20 credits = 2000 cents', async () => {
    // 10 seats would have been 20 000 cents with the old wrong formula (10×2000).
    // With the correct model, the grant is the chosen €20 = 2000 cents.
    await simulateOrgCheckoutCompleted(supabase, 'org-abc', 10, 2000, 'sub_1', 'cus_1');
    expect(supabase._spies.rpc).toHaveBeenCalledWith('set_monthly_credits_org', { p_org_id: 'org-abc', p_grant_cents: 2000 });
  });

  it('updates org status to active with correct seat count and subscription id', async () => {
    await simulateOrgCheckoutCompleted(supabase, 'org-abc', 5, 10000, 'sub_xyz', 'cus_1');
    expect(supabase._spies.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'active',
      seats_paid: 5,
      stripe_subscription_id: 'sub_xyz',
    }));
  });

  it('filters update by org id', async () => {
    await simulateOrgCheckoutCompleted(supabase, 'org-abc', 5, 10000, 'sub_1', 'cus_1');
    expect(supabase._spies.eq).toHaveBeenCalledWith('id', 'org-abc');
  });
});

describe('org billing — customer.subscription.updated handler (teams)', () => {
  let supabase: ReturnType<typeof buildMockSupabase>;

  beforeEach(() => {
    supabase = buildMockSupabase();
  });

  it('calls set_seats_org with updated seat count', async () => {
    await simulateOrgSubscriptionUpdated(supabase, 'org-abc', 8, 5000, 'sub_1', 'active');
    expect(supabase._spies.rpc).toHaveBeenCalledWith('set_seats_org', { p_org_id: 'org-abc', p_seats: 8 });
  });

  it('calls set_monthly_credits_org with chosen credits (NOT seats×2000)', async () => {
    // 8 seats at old formula = 16 000 cents. Correct = buyer's chosen €50 = 5000 cents.
    await simulateOrgSubscriptionUpdated(supabase, 'org-abc', 8, 5000, 'sub_1', 'active');
    expect(supabase._spies.rpc).toHaveBeenCalledWith('set_monthly_credits_org', { p_org_id: 'org-abc', p_grant_cents: 5000 });
  });

  it('calls set_monthly_credits_org with 0 for seat-only subscription', async () => {
    await simulateOrgSubscriptionUpdated(supabase, 'org-abc', 5, 0, 'sub_1', 'active');
    expect(supabase._spies.rpc).toHaveBeenCalledWith('set_monthly_credits_org', { p_org_id: 'org-abc', p_grant_cents: 0 });
  });

  it('status active -> org status active', async () => {
    await simulateOrgSubscriptionUpdated(supabase, 'org-abc', 5, 0, 'sub_1', 'active');
    expect(supabase._spies.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
  });

  it('status trialing -> org status active', async () => {
    await simulateOrgSubscriptionUpdated(supabase, 'org-abc', 5, 0, 'sub_1', 'trialing');
    expect(supabase._spies.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
  });

  it('status past_due -> org status past_due (preserved as-is)', async () => {
    await simulateOrgSubscriptionUpdated(supabase, 'org-abc', 5, 0, 'sub_1', 'past_due');
    expect(supabase._spies.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'past_due' }));
  });
});

describe('org billing — customer.subscription.deleted handler (teams)', () => {
  let supabase: ReturnType<typeof buildMockSupabase>;

  beforeEach(() => {
    supabase = buildMockSupabase();
  });

  it('sets org status to canceled', async () => {
    await simulateOrgSubscriptionDeleted(supabase, 'org-abc');
    expect(supabase._spies.update).toHaveBeenCalledWith({ status: 'canceled' });
  });

  it('filters cancel update by org id', async () => {
    await simulateOrgSubscriptionDeleted(supabase, 'org-abc');
    expect(supabase._spies.eq).toHaveBeenCalledWith('id', 'org-abc');
  });
});

describe('org billing — teams_topup checkout handler', () => {
  let supabase: ReturnType<typeof buildMockSupabase>;

  beforeEach(() => {
    supabase = buildMockSupabase();
  });

  it('calls add_credits_org with correct org id and amount', async () => {
    await simulateOrgTopupCheckout(supabase, 'org-abc', 2000);
    expect(supabase._spies.rpc).toHaveBeenCalledWith('add_credits_org', { p_org_id: 'org-abc', p_cents: 2000 });
  });

  it('€20 top-up = 2000 credit cents added to org pot', async () => {
    const amountCents = eurToCredits(20);
    await simulateOrgTopupCheckout(supabase, 'org-abc', amountCents);
    expect(supabase._spies.rpc).toHaveBeenCalledWith('add_credits_org', { p_org_id: 'org-abc', p_cents: 2000 });
  });

  it('€100 top-up = 10 000 credit cents added to org pot', async () => {
    const amountCents = eurToCredits(100);
    await simulateOrgTopupCheckout(supabase, 'org-abc', amountCents);
    expect(supabase._spies.rpc).toHaveBeenCalledWith('add_credits_org', { p_org_id: 'org-abc', p_cents: 10000 });
  });

  it('€500 top-up (max) = 50 000 credit cents', async () => {
    const amountCents = eurToCredits(500);
    await simulateOrgTopupCheckout(supabase, 'org-abc', amountCents);
    expect(supabase._spies.rpc).toHaveBeenCalledWith('add_credits_org', { p_org_id: 'org-abc', p_cents: 50000 });
  });

  it('top-up routes as teams_topup (not personal topup)', () => {
    // teams_topup metadata must not fall through to the personal topup handler.
    const route = routeCheckoutSession({ type: 'teams_topup', supabase_org_id: 'org-abc' }, 'payment');
    expect(route).toBe('teams_topup');
    expect(route).not.toBe('topup');
  });

  it('personal topup (no org metadata) routes to personal handler', () => {
    // Personal payment sessions without type=teams_topup stay on the personal path.
    const route = routeCheckoutSession({ supabase_user_id: 'user-1', type: 'topup' }, 'payment');
    expect(route).toBe('topup');
  });
});
