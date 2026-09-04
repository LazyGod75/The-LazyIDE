/**
 * roleView.test.ts — pure-logic tests for role → viewpoint routing and
 * role → permissions mapping (Team redesign, wave2/team).
 */

import { describe, it, expect } from 'vitest';
import { deriveTeamView, getRolePermissions, usagePct, usageState } from '../lib/teams/roleView';

// ─────────────────────────────────────────────────────────────────
// deriveTeamView
// ─────────────────────────────────────────────────────────────────

describe('deriveTeamView', () => {
  it('returns solo when the user has no org membership at all', () => {
    expect(deriveTeamView(null, 0)).toBe('solo');
  });

  it('returns lead for org-admin', () => {
    expect(deriveTeamView('org-admin', 1)).toBe('lead');
  });

  it('returns lead for team-lead', () => {
    expect(deriveTeamView('team-lead', 1)).toBe('lead');
  });

  it('returns member for member', () => {
    expect(deriveTeamView('member', 1)).toBe('member');
  });

  it('returns member for viewer', () => {
    expect(deriveTeamView('viewer', 1)).toBe('member');
  });

  it('returns multi when the user belongs to more than one org, regardless of role', () => {
    expect(deriveTeamView('org-admin', 2)).toBe('multi');
    expect(deriveTeamView('member', 3)).toBe('multi');
  });

  it('never throws on the (role=null, orgCount=1) combination — callers must not reach it in steady state (see TeamSpace.tsx gating on membership-loading), but the pure function stays total', () => {
    expect(() => deriveTeamView(null, 1)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────
// getRolePermissions
// ─────────────────────────────────────────────────────────────────

describe('getRolePermissions', () => {
  it('org-admin can do everything, including modifying team rules (matches set_member_role RPC: org-admin only)', () => {
    const perms = getRolePermissions('org-admin');
    expect(perms.find((p) => p.key === 'modifyTeamRules')?.allowed).toBe(true);
    expect(perms.find((p) => p.key === 'authorizeOutOfScope')?.allowed).toBe(true);
  });

  it('team-lead CANNOT modify team rules or authorize out-of-scope writes (backend RPCs reject non-org-admin)', () => {
    const perms = getRolePermissions('team-lead');
    expect(perms.find((p) => p.key === 'modifyTeamRules')?.allowed).toBe(false);
    expect(perms.find((p) => p.key === 'authorizeOutOfScope')?.allowed).toBe(false);
    expect(perms.find((p) => p.key === 'mergeReviews')?.allowed).toBe(true);
    expect(perms.find((p) => p.key === 'launchMissions')?.allowed).toBe(true);
  });

  it('member has merge/launch but not org-rules permissions', () => {
    const perms = getRolePermissions('member');
    expect(perms.find((p) => p.key === 'mergeReviews')?.allowed).toBe(true);
    expect(perms.find((p) => p.key === 'modifyTeamRules')?.allowed).toBe(false);
  });

  it('viewer has no write permissions at all', () => {
    const perms = getRolePermissions('viewer');
    expect(perms.every((p) => !p.allowed)).toBe(true);
  });

  it('always returns exactly the 4 permission keys in a fixed order', () => {
    const perms = getRolePermissions('member');
    expect(perms.map((p) => p.key)).toEqual([
      'mergeReviews',
      'launchMissions',
      'authorizeOutOfScope',
      'modifyTeamRules',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────
// usagePct / usageState
// ─────────────────────────────────────────────────────────────────

describe('usagePct / usageState', () => {
  it('computes rounded percentage', () => {
    expect(usagePct(288, 300)).toBe(96);
    expect(usagePct(412, 1000)).toBe(41);
  });

  it('clamps at 100 even if used exceeds limit', () => {
    expect(usagePct(500, 300)).toBe(100);
  });

  it('returns 0 when there is no limit (limit <= 0)', () => {
    expect(usagePct(50, 0)).toBe(0);
  });

  it('classifies >=90% as hot, >=70% as warm, else ok', () => {
    expect(usageState(288, 300)).toBe('hot'); // 96%
    expect(usageState(117, 400)).toBe('ok'); // ~29%
    expect(usageState(296, 400)).toBe('warm'); // 74%
  });

  it('a member with no limit is always ok (no cap to breach)', () => {
    expect(usageState(999, 0)).toBe('ok');
  });
});
