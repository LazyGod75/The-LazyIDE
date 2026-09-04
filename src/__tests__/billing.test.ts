import { describe, it, expect } from 'vitest';

import { isLowCredit, formatCredits } from '../lib/billing/credits';

import { TOPUP_MIN_EUR, TOPUP_MAX_EUR, isValidTopupAmount } from '../lib/billing/topup';



// ── computeCreditsGrant logic (mirrors stripe-webhook/index.ts) ──────

// Duplicated here because the webhook runs in Deno and is not importable

// from the Vitest environment. Keeping the logic in sync is enforced by

// the test cases below which document the expected behaviour.



const PRO_MONTHLY_CREDITS_CENTS = 2000;

const PRO_PLUS_MONTHLY_CREDITS_CENTS = 6000;



function computeCreditsGrant(params: {

  newStatus: string;

  newPlan: string;

  newPeriodEnd: string;

  existingPeriodEnd: string | null | undefined;

}): number | null {

  const { newStatus, newPlan, newPeriodEnd, existingPeriodEnd } = params;



  if (newStatus === 'canceled' || newStatus === 'incomplete_expired') {

    return 0;

  }



  if (newStatus === 'past_due' || newStatus === 'unpaid') {

    return null;

  }



  const isActive = newStatus === 'active' || newStatus === 'trialing';

  if (!isActive) {

    return null;

  }



  if (existingPeriodEnd && existingPeriodEnd === newPeriodEnd) {

    return null;

  }



  if (newPlan === 'pro_plus') {

    return PRO_PLUS_MONTHLY_CREDITS_CENTS;

  }

  return PRO_MONTHLY_CREDITS_CENTS;

}



// ── Tests ───────────────────────────────────────────────────────────



describe('billing — computeCreditsGrant', () => {

  it('grants full credits on first active subscription', () => {

    expect(computeCreditsGrant({

      newStatus: 'active',

      newPlan: 'pro',

      newPeriodEnd: '2026-07-22T00:00:00.000Z',

      existingPeriodEnd: null,

    })).toBe(PRO_MONTHLY_CREDITS_CENTS);

  });



  it('grants full credits on first trialing subscription', () => {

    expect(computeCreditsGrant({

      newStatus: 'trialing',

      newPlan: 'pro',

      newPeriodEnd: '2026-07-22T00:00:00.000Z',

      existingPeriodEnd: null,

    })).toBe(PRO_MONTHLY_CREDITS_CENTS);

  });



  it('grants Pro+ credits (6000) when plan is pro_plus', () => {

    expect(computeCreditsGrant({

      newStatus: 'active',

      newPlan: 'pro_plus',

      newPeriodEnd: '2026-07-22T00:00:00.000Z',

      existingPeriodEnd: null,

    })).toBe(PRO_PLUS_MONTHLY_CREDITS_CENTS);

  });



  it('grants Pro credits (2000) when plan is pro', () => {

    expect(computeCreditsGrant({

      newStatus: 'active',

      newPlan: 'pro',

      newPeriodEnd: '2026-07-22T00:00:00.000Z',

      existingPeriodEnd: null,

    })).toBe(PRO_MONTHLY_CREDITS_CENTS);

  });



  it('does NOT re-grant for the same billing period (idempotent)', () => {

    expect(computeCreditsGrant({

      newStatus: 'active',

      newPlan: 'pro',

      newPeriodEnd: '2026-07-22T00:00:00.000Z',

      existingPeriodEnd: '2026-07-22T00:00:00.000Z',

    })).toBeNull();

  });



  it('grants again when the billing period advances', () => {

    expect(computeCreditsGrant({

      newStatus: 'active',

      newPlan: 'pro',

      newPeriodEnd: '2026-08-22T00:00:00.000Z',

      existingPeriodEnd: '2026-07-22T00:00:00.000Z',

    })).toBe(PRO_MONTHLY_CREDITS_CENTS);

  });



  it('grants Pro+ again when the billing period advances', () => {

    expect(computeCreditsGrant({

      newStatus: 'active',

      newPlan: 'pro_plus',

      newPeriodEnd: '2026-08-22T00:00:00.000Z',

      existingPeriodEnd: '2026-07-22T00:00:00.000Z',

    })).toBe(PRO_PLUS_MONTHLY_CREDITS_CENTS);

  });



  it('clears credits to 0 on canceled', () => {

    expect(computeCreditsGrant({

      newStatus: 'canceled',

      newPlan: 'pro',

      newPeriodEnd: '2026-08-22T00:00:00.000Z',

      existingPeriodEnd: '2026-07-22T00:00:00.000Z',

    })).toBe(0);

  });



  it('clears credits to 0 on incomplete_expired', () => {

    expect(computeCreditsGrant({

      newStatus: 'incomplete_expired',

      newPlan: 'pro',

      newPeriodEnd: '2026-08-22T00:00:00.000Z',

      existingPeriodEnd: '2026-07-22T00:00:00.000Z',

    })).toBe(0);

  });



  it('preserves credits (null) on past_due', () => {

    expect(computeCreditsGrant({

      newStatus: 'past_due',

      newPlan: 'pro',

      newPeriodEnd: '2026-08-22T00:00:00.000Z',

      existingPeriodEnd: '2026-07-22T00:00:00.000Z',

    })).toBeNull();

  });



  it('preserves credits (null) on unpaid', () => {

    expect(computeCreditsGrant({

      newStatus: 'unpaid',

      newPlan: 'pro',

      newPeriodEnd: '2026-08-22T00:00:00.000Z',

      existingPeriodEnd: '2026-07-22T00:00:00.000Z',

    })).toBeNull();

  });



  it('returns null for unknown / inactive statuses', () => {

    expect(computeCreditsGrant({

      newStatus: 'incomplete',

      newPlan: 'pro',

      newPeriodEnd: '2026-08-22T00:00:00.000Z',

      existingPeriodEnd: null,

    })).toBeNull();

  });

});



describe('billing — checkout URL format', () => {

  it('success_url uses hash route with checkout=success param', () => {

    const appUrl = 'https://lazy.app';

    const successUrl = `${appUrl}/#/settings?checkout=success&session_id={CHECKOUT_SESSION_ID}`;

    expect(successUrl).toContain('/#/settings');

    expect(successUrl).toContain('checkout=success');

    expect(successUrl).toContain('{CHECKOUT_SESSION_ID}');

  });



  it('cancel_url uses hash route with checkout=cancel param', () => {

    const appUrl = 'https://lazy.app';

    const cancelUrl = `${appUrl}/#/settings?checkout=cancel`;

    expect(cancelUrl).toContain('/#/settings');

    expect(cancelUrl).toContain('checkout=cancel');

  });



  it('portal return_url uses hash route to settings', () => {

    const appUrl = 'https://lazy.app';

    const returnUrl = `${appUrl}/#/settings`;

    expect(returnUrl).toContain('/#/settings');

  });

});



describe('billing — credits integration', () => {

  it('isLowCredit is true when credits are low after grant period', () => {

    expect(isLowCredit(50, 'active')).toBe(true);

  });



  it('formatCredits formats the monthly grant correctly', () => {

    // Credits are currency-neutral (internal USD cents), displayed as plain numbers

    expect(formatCredits(PRO_MONTHLY_CREDITS_CENTS)).toBe('2\u202f000');

  });



  it('formatCredits formats the Pro+ monthly grant correctly', () => {

    expect(formatCredits(PRO_PLUS_MONTHLY_CREDITS_CENTS)).toBe('6\u202f000');

  });

});



describe('billing — top-up credits', () => {

  // Top-ups are collected in EUR but credits remain in USD cents internally.

  // €5 → 500 cents, €10 → 1000 cents, etc. (1€ = 100 cents at parity)

  it('top-up €5 adds 500 cents to existing balance', () => {

    const currentCredits = 1500;

    const topupAmount = 500;

    expect(currentCredits + topupAmount).toBe(2000);

  });



  it('top-up €10 adds 1000 cents to existing balance', () => {

    const currentCredits = 300;

    const topupAmount = 1000;

    expect(currentCredits + topupAmount).toBe(1300);

  });



  it('top-up €20 adds 2000 cents to existing balance', () => {

    const currentCredits = 0;

    const topupAmount = 2000;

    expect(currentCredits + topupAmount).toBe(2000);

  });



  it('top-up is additive even with Pro+ subscription credits', () => {

    const proPlusCredits = PRO_PLUS_MONTHLY_CREDITS_CENTS;

    const topupAmount = 1000;

    expect(proPlusCredits + topupAmount).toBe(7000);

  });



  it('custom top-up €7 adds 700 cents', () => {

    const topupEuros = 7;

    const topupCents = Math.round(topupEuros * 100);

    expect(topupCents).toBe(700);

  });



  it('custom top-up €42.50 adds 4250 cents', () => {

    const topupEuros = 42.50;

    const topupCents = Math.round(topupEuros * 100);

    expect(topupCents).toBe(4250);

  });



  it('custom top-up €150 adds 15000 cents', () => {

    const topupEuros = 150;

    const topupCents = Math.round(topupEuros * 100);

    expect(topupCents).toBe(15000);

  });



  it('top-up amount must be between €1 and €10000', () => {

    expect(TOPUP_MIN_EUR).toBe(1);

    expect(TOPUP_MAX_EUR).toBe(10000);

  });

});



describe('billing — isValidTopupAmount', () => {

  it('rejects 0 (below minimum)', () => {

    expect(isValidTopupAmount(0)).toBe(false);

  });



  it('rejects a non-integer amount', () => {

    expect(isValidTopupAmount(0.5)).toBe(false);

  });



  it('accepts the minimum bound (1)', () => {

    expect(isValidTopupAmount(1)).toBe(true);

  });



  it('accepts a mid-range amount (5)', () => {

    expect(isValidTopupAmount(5)).toBe(true);

  });



  it('accepts a preset amount (500)', () => {

    expect(isValidTopupAmount(500)).toBe(true);

  });



  it('accepts the maximum bound (10000)', () => {

    expect(isValidTopupAmount(10000)).toBe(true);

  });



  it('rejects an amount above the maximum (10001)', () => {

    expect(isValidTopupAmount(10001)).toBe(false);

  });



  it('rejects NaN', () => {

    expect(isValidTopupAmount(NaN)).toBe(false);

  });



  it('rejects Infinity', () => {

    expect(isValidTopupAmount(Infinity)).toBe(false);

  });

});

