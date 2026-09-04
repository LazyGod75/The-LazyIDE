import { describe, it, expect } from 'vitest';
import {
  isLowCredit,
  formatCredits,
  usdToCredits,
  LOW_CREDIT_THRESHOLD_CENTS,
} from '../lib/billing/credits';

describe('credits', () => {
  // ── LOW_CREDIT_THRESHOLD_CENTS ──────────────────────────────────────

  it('LOW_CREDIT_THRESHOLD_CENTS is 200', () => {
    expect(LOW_CREDIT_THRESHOLD_CENTS).toBe(200);
  });

  // ── isLowCredit ─────────────────────────────────────────────────────

  it('returns true when active and credits are below threshold', () => {
    expect(isLowCredit(199, 'active')).toBe(true);
  });

  it('returns true when trialing and credits are below threshold', () => {
    expect(isLowCredit(50, 'trialing')).toBe(true);
  });

  it('returns false when credits equal the threshold (not strictly below)', () => {
    expect(isLowCredit(200, 'active')).toBe(false);
  });

  it('returns false when credits are above the threshold', () => {
    expect(isLowCredit(500, 'active')).toBe(false);
  });

  it('returns false when credits are exactly 0 (hard-block takes over)', () => {
    expect(isLowCredit(0, 'active')).toBe(false);
  });

  it('returns false when status is canceled even with low credits', () => {
    expect(isLowCredit(10, 'canceled')).toBe(false);
  });

  it('returns false when status is past_due', () => {
    expect(isLowCredit(10, 'past_due')).toBe(false);
  });

  it('returns false when status is free / unknown', () => {
    expect(isLowCredit(10, 'free')).toBe(false);
    expect(isLowCredit(10, '')).toBe(false);
  });

  // ── formatCredits ───────────────────────────────────────────────────
  // Credits are abstract integers — no currency symbol, thousands-separated.

  it('formats 0 credits as "0"', () => {
    expect(formatCredits(0)).toBe('0');
  });

  it('formats 100 credits as "100"', () => {
    expect(formatCredits(100)).toBe('100');
  });

  it('formats 150 credits as "150"', () => {
    expect(formatCredits(150)).toBe('150');
  });

  it('formats 2000 credits with thousands separator', () => {
    expect(formatCredits(2000)).toBe('2 000');
  });

  it('formats 1 credit as "1"', () => {
    expect(formatCredits(1)).toBe('1');
  });

  it('formats 199 credits as "199"', () => {
    expect(formatCredits(199)).toBe('199');
  });

  // ── usdToCredits ────────────────────────────────────────────────────
  // "1 credit == 1 USD cent" (scorecardRefresh.ts) — the single conversion
  // every credits display (real managed/BYOK spend AND native-rail
  // API-equivalent) must share, per CostChip.tsx's pre-existing formula.

  it('converts $5.00 to 500 credits', () => {
    expect(usdToCredits(5)).toBe(500);
  });

  it('converts $13.69 to 1369 credits', () => {
    expect(usdToCredits(13.69)).toBe(1369);
  });

  it('converts $0 to 0 credits', () => {
    expect(usdToCredits(0)).toBe(0);
  });

  it('rounds to the nearest whole credit', () => {
    expect(usdToCredits(0.001)).toBe(0);
    expect(usdToCredits(0.006)).toBe(1);
  });
});
