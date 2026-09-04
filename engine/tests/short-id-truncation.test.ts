/**
 * D1 — shortId must truncate at the last hyphen boundary within 32 chars,
 * never ending mid-word.
 */

import { describe, expect, it } from 'vitest';
import { shortIdForTest } from '../src/commands/inject-context.js';

describe('D1 — shortId word-boundary truncation', () => {
  it('strips leading date prefix and returns clean slug', () => {
    const result = shortIdForTest('2026-06-09-push-branch-non-destructive-remove-tracking');
    expect(result).toBe('push-branch-non-destructive');
  });

  it('does not end mid-word (no trailing hyphen-fragment)', () => {
    const result = shortIdForTest('2026-06-09-push-branch-non-destructive-remo');
    // "remo" is a partial word — must be dropped
    expect(result).toBe('push-branch-non-destructive');
  });

  it('handles id without date prefix — truncates at word boundary if > 32 chars', () => {
    // "alpha-beta-gamma-delta-epsilon-zeta-eta" = 38 chars — needs truncation.
    // Sliced at 32: "alpha-beta-gamma-delta-epsilon-ze" — last hyphen at pos 29.
    // Expected: "alpha-beta-gamma-delta-epsilon"
    const result = shortIdForTest('alpha-beta-gamma-delta-epsilon-zeta-eta');
    expect(result).toBe('alpha-beta-gamma-delta-epsilon');
    // Must be a valid slug segment (no partial words at the end)
    expect(result).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('returns the full slug when it fits within 32 chars', () => {
    const result = shortIdForTest('2026-06-09-short-id');
    expect(result).toBe('short-id');
  });

  it('hard-cuts when the first segment alone exceeds 32 chars (degenerate)', () => {
    const longFirstSegment = 'a'.repeat(40);
    const result = shortIdForTest(`2026-06-09-${longFirstSegment}`);
    // Hard-cut at 32 chars is allowed (degenerate case)
    expect(result.length).toBeLessThanOrEqual(32);
  });

  it('original bug case: "push-branch-non-destructive-remo" becomes "push-branch-non-destructive"', () => {
    // The full id from the audit finding
    const id = '2026-06-09-push-branch-non-destructive-remove-tracking';
    const result = shortIdForTest(id);
    expect(result).not.toContain('remo');
    expect(result).toBe('push-branch-non-destructive');
  });
});
