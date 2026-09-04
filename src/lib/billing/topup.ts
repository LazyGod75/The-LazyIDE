/**
 * Shared top-up constants and validation. Single source of truth for
 * AccountPopover's inline top-up form and the command palette's billing
 * entries — replaces the two hardcoded `TOPUP_CREDITS = 500` copies that
 * used to live in AccountPopover.tsx and paletteBilling.ts.
 *
 * Bounds mirror the create-checkout-session edge function's server-side
 * validation (1–10000 EUR). Kept in sync here manually since that function
 * runs in Deno and can't import this module.
 */

export const TOPUP_MIN_EUR = 1;
export const TOPUP_MAX_EUR = 10000;
export const TOPUP_PRESETS_EUR = [10, 50, 100, 500] as const;

/**
 * True when `amount` is a valid top-up amount in EUR: a finite integer
 * within [TOPUP_MIN_EUR, TOPUP_MAX_EUR]. Integer-only — no cents-level
 * precision needed for a top-up amount picker.
 */
export function isValidTopupAmount(amount: number): boolean {
  return (
    Number.isFinite(amount) &&
    Number.isInteger(amount) &&
    amount >= TOPUP_MIN_EUR &&
    amount <= TOPUP_MAX_EUR
  );
}
