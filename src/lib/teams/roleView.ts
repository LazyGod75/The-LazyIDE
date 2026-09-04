/* roleView.ts — pure role → viewpoint and role → permissions derivation
   for the Team redesign (4 viewpoints: Solo / Lead / Member / Multi-team).

   No I/O, no React — fully unit-testable (see src/__tests__/roleView.test.ts).
   Mirrors Team.dc.html's renderVals() logic but computed from REAL state
   instead of a demo tab switch (per design-team.md §0 and §10 item 2).
*/

import type { OrgRole } from './types.js';

export type TeamView = 'solo' | 'lead' | 'member' | 'multi';

/**
 * Derives which of the 4 viewpoints should render.
 *
 * - No org membership at all (role === null) -> 'solo'.
 * - Member of MORE THAN ONE active org -> 'multi' (fail-closed per D5d: the
 *   backend must actually return >1 org for this user, never a UI-only
 *   toggle — orgCount is the caller's real count, not a guess).
 * - 'org-admin' or 'team-lead' in the (single) active org -> 'lead'.
 * - 'member' or 'viewer' -> 'member'.
 */
export function deriveTeamView(role: OrgRole | null, orgCount: number): TeamView {
  if (orgCount > 1) return 'multi';
  if (role === null) return 'solo';
  if (role === 'org-admin' || role === 'team-lead') return 'lead';
  return 'member';
}

// ── Role -> permissions (D-drawer "SES PERMISSIONS") ────────────────
//
// Grounded in what the backend actually enforces (not a free invention):
//   - create_department / set_member_role / set_member_dept (teams_management_rpcs.sql)
//     all require `caller role = 'org-admin'` STRICTLY — team-lead is
//     explicitly rejected. This is the real source for "modifier les
//     règles de la team" being org-admin-only.
//   - org-list's allocations are visible to org-admin AND team-lead (elevated
//     read), but only org-admin can mutate them (org-set-allocation calls
//     the same admin-gated pattern) — team-lead does not get "autoriser une
//     écriture hors périmètre" (out-of-scope write authorization is treated
//     as an org-rules-level decision, same tier as role/dept management).
//   - member/viewer have no elevated read or write path anywhere in the
//     Edge Functions surveyed — least privilege.
export interface RolePermission {
  key: string;
  allowed: boolean;
}

const PERMISSION_KEYS = [
  'mergeReviews',
  'launchMissions',
  'authorizeOutOfScope',
  'modifyTeamRules',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

const ROLE_PERMISSIONS: Record<OrgRole, Record<PermissionKey, boolean>> = {
  'org-admin': {
    mergeReviews: true,
    launchMissions: true,
    authorizeOutOfScope: true,
    modifyTeamRules: true,
  },
  'team-lead': {
    mergeReviews: true,
    launchMissions: true,
    authorizeOutOfScope: false,
    modifyTeamRules: false,
  },
  member: {
    mergeReviews: true,
    launchMissions: true,
    authorizeOutOfScope: false,
    modifyTeamRules: false,
  },
  viewer: {
    mergeReviews: false,
    launchMissions: false,
    authorizeOutOfScope: false,
    modifyTeamRules: false,
  },
};

/** Returns the 4-item permission checklist for a role, in a fixed display order. */
export function getRolePermissions(role: OrgRole): RolePermission[] {
  const table = ROLE_PERMISSIONS[role];
  return PERMISSION_KEYS.map((key) => ({ key, allowed: table[key] }));
}

// ── Budget usage state (Lead member rows + Member's own budget bar) ──

export type UsageState = 'hot' | 'warm' | 'ok';

/** pct = round(used/limit*100), clamped to [0,100]. limit<=0 => 'ok' (no cap to breach). */
export function usagePct(usedCents: number, limitCents: number): number {
  if (limitCents <= 0) return 0;
  return Math.min(100, Math.round((usedCents / limitCents) * 100));
}

export function usageState(usedCents: number, limitCents: number): UsageState {
  if (limitCents <= 0) return 'ok';
  const pct = usagePct(usedCents, limitCents);
  if (pct >= 90) return 'hot';
  if (pct >= 70) return 'warm';
  return 'ok';
}
