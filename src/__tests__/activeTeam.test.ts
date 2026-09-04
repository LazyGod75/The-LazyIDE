/**
 * activeTeam.test.ts — unit tests for the active-team gate logic.
 *
 * ONLY tests pure functions (no React hooks, no Supabase calls).
 * This guarantees determinism and prevents the object-dep loop issue.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveHasActiveTeam,
  computeShowTeamTab,
  type OrgStatusRow,
} from '../lib/teams/useActiveTeam';

// ── deriveHasActiveTeam ───────────────────────────────────────────────

describe('deriveHasActiveTeam', () => {
  it('returns true for an active org', () => {
    const rows: OrgStatusRow[] = [{ status: 'active' }];
    expect(deriveHasActiveTeam(rows)).toBe(true);
  });

  it('returns true for a trialing org', () => {
    const rows: OrgStatusRow[] = [{ status: 'trialing' }];
    expect(deriveHasActiveTeam(rows)).toBe(true);
  });

  it('returns true when at least one org is active among several', () => {
    const rows: OrgStatusRow[] = [
      { status: 'canceled' },
      { status: 'active' },
    ];
    expect(deriveHasActiveTeam(rows)).toBe(true);
  });

  it('returns true when at least one org is trialing among several', () => {
    const rows: OrgStatusRow[] = [
      { status: 'past_due' },
      { status: 'trialing' },
    ];
    expect(deriveHasActiveTeam(rows)).toBe(true);
  });

  it('returns false for an empty array (no org membership — free user)', () => {
    expect(deriveHasActiveTeam([])).toBe(false);
  });

  it('returns false for null (fail-closed: called on Supabase error)', () => {
    expect(deriveHasActiveTeam(null)).toBe(false);
  });

  it('returns false for a canceled org (Pro solo, no team)', () => {
    const rows: OrgStatusRow[] = [{ status: 'canceled' }];
    expect(deriveHasActiveTeam(rows)).toBe(false);
  });

  it('returns false for a past_due org', () => {
    const rows: OrgStatusRow[] = [{ status: 'past_due' }];
    expect(deriveHasActiveTeam(rows)).toBe(false);
  });

  it('returns false for an unpaid org', () => {
    const rows: OrgStatusRow[] = [{ status: 'unpaid' }];
    expect(deriveHasActiveTeam(rows)).toBe(false);
  });

  it('returns false for an incomplete_expired org', () => {
    const rows: OrgStatusRow[] = [{ status: 'incomplete_expired' }];
    expect(deriveHasActiveTeam(rows)).toBe(false);
  });
});

// ── computeShowTeamTab ────────────────────────────────────────────────

describe('computeShowTeamTab', () => {
  it('shows tab when kill-switch is on AND user has active team', () => {
    expect(computeShowTeamTab(true, true)).toBe(true);
  });

  it('hides tab when kill-switch is off, even if user has active team', () => {
    expect(computeShowTeamTab(false, true)).toBe(false);
  });

  it('hides tab when user has no active team, even if kill-switch is on', () => {
    expect(computeShowTeamTab(true, false)).toBe(false);
  });

  it('hides tab in the default state (both false)', () => {
    expect(computeShowTeamTab(false, false)).toBe(false);
  });
});

// ── Fail-closed guarantee ─────────────────────────────────────────────
// These tests document the fail-closed contract explicitly.

describe('fail-closed guarantee', () => {
  it('null rows (error path) → no team access', () => {
    expect(deriveHasActiveTeam(null)).toBe(false);
  });

  it('empty rows (no membership) → no team access', () => {
    expect(deriveHasActiveTeam([])).toBe(false);
  });

  it('kill-switch disabled → no team tab regardless of membership', () => {
    expect(computeShowTeamTab(false, true)).toBe(false);
  });
});
