/**
 * Pure credit-balance utilities.
 * No side effects, no imports — safe to unit-test without mocks.
 */

/** Alert threshold: warn when remaining credits fall below 200 credits. */
export const LOW_CREDIT_THRESHOLD_CENTS = 200;

/**
 * Returns true when the user is on an active/trialing Pro subscription
 * and their remaining credits are below the alert threshold but still > 0.
 *
 * We intentionally return false when credits reach exactly 0 so that the
 * warning does not compete with a "no credits left" hard-block message.
 */
export function isLowCredit(
  creditsRemainingCents: number,
  status: string,
): boolean {
  const isSubscribed = status === 'active' || status === 'trialing';
  return (
    isSubscribed &&
    creditsRemainingCents > 0 &&
    creditsRemainingCents < LOW_CREDIT_THRESHOLD_CENTS
  );
}

/**
 * Returns true when the user is on an active/trialing Pro subscription
 * but has exactly 0 credits remaining. This is the hard-block state —
 * the user must top up or wait for the next billing cycle.
 */
export function isOutOfCredits(
  creditsRemainingCents: number,
  status: string,
): boolean {
  const isSubscribed = status === 'active' || status === 'trialing';
  return isSubscribed && creditsRemainingCents <= 0;
}

/**
 * Formats a credit amount as a locale-aware integer string with thousands
 * separator. Credits are abstract and currency-neutral — no currency symbol.
 * e.g. 2000 → "2 000", 150 → "150".
 */
export function formatCredits(credits: number): string {
  return Math.round(credits).toLocaleString('fr-FR');
}

/**
 * THE single $-to-credits conversion formula for this app — "1 credit == 1
 * USD cent" (scorecardRefresh.ts's own doc comment; the same convention the
 * real Pro balance is stored in, `credits_remaining_cents`). Every surface
 * that turns a dollar figure (real managed/BYOK spend, OR a native-rail
 * API-list-price EQUIVALENT — see runtime.ts's classifyMissionModel) into a
 * credits number must import THIS function rather than re-deriving
 * `Math.round(usd * 100)` locally — CostChip.tsx used to keep its own copy;
 * that duplication is exactly what this centralizes (2026-08-19 dollar-kill
 * incident follow-up: the display-honesty half of the fix).
 *
 * Converting to credits does NOT by itself say whether the figure is real
 * spend or a notional equivalent — callers still carry that distinction
 * separately (classifyMissionModel's rail) and must word their label
 * accordingly (see CostChip.tsx's two branches for the precedent).
 */
export function usdToCredits(usd: number): number {
  return Math.round(usd * 100);
}

/**
 * Formats a subscription's renewal date for the no-credits messaging
 * (W-MODELSEL fix). Returns undefined when periodEnd is missing/invalid so
 * callers fall back to an honest date-less message instead of ever
 * rendering "Invalid Date" or inventing a date.
 */
export function formatRenewalDate(
  periodEnd: string | null | undefined,
  locale: string,
): string | undefined {
  if (!periodEnd) return undefined;
  const date = new Date(periodEnd);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
}
