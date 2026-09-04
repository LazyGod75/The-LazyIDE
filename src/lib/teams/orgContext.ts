/**
 * orgContext.ts — org-context.json builder + Tauri sync commands.
 *
 * buildOrgContext: pure function, testable without Supabase or Tauri.
 * fetchOrgContextData: queries Supabase (RLS-filtered by user JWT).
 * syncOrgContext / resyncOrgContext: write the JSON via Tauri command.
 *
 * Phase 0: "teams" in the contract map to departments (no teams table yet).
 * All departments in the org are visible to every member (org-readable).
 */

import { supabase } from '../supabase/client.js';
import { isTauri } from '../platform/index.js';

// ── Contract types ────────────────────────────────────────────

export type TeamVisibility = 'private' | 'org-readable';
export type TeamRole = 'lead' | 'member' | 'viewer';

export interface OrgContextTeam {
  slug: string;
  name: string;
  visibility: TeamVisibility;
  role: TeamRole | null;
  deptId?: string;
}

export interface OrgContextDept {
  id: string;
  slug: string;
}

export interface OrgContextJson {
  userId: string;
  orgId: string;
  orgSlug: string;
  isOrgAdmin: boolean;
  teams: OrgContextTeam[];
  depts: OrgContextDept[];
  brainRepoUrl?: string | null;
}

// ── Internal DB row types ─────────────────────────────────────

interface OrgRow {
  id: string;
  name: string;
  brain_repo_url?: string | null;
}

interface OrgMemberRow {
  org_id: string;
  role: string;
  dept_id: string | null;
}

interface DeptRow {
  id: string;
  slug: string;
  name: string;
  org_id: string;
}

// ── Helpers ───────────────────────────────────────────────────

/** Convert an org name to a URL-safe slug. */
function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'org'
  );
}

/**
 * Map org-level role + dept membership to a team-level role.
 *
 * Rules (Phase 0):
 *   - org-admin           → 'lead' in EVERY team
 *   - team-lead in dept   → 'lead'
 *   - member in dept      → 'member'
 *   - viewer in dept      → 'viewer'
 *   - not in this dept    → null
 */
function mapTeamRole(
  orgRole: string,
  isUserDept: boolean,
  isOrgAdmin: boolean,
): TeamRole | null {
  if (isOrgAdmin) return 'lead';
  if (!isUserDept) return null;
  switch (orgRole) {
    case 'team-lead': return 'lead';
    case 'member':    return 'member';
    case 'viewer':    return 'viewer';
    default:          return 'member';
  }
}

// ── Pure builder ──────────────────────────────────────────────

/**
 * Build the org-context.json payload from raw Supabase rows.
 *
 * Pure function — no network calls, no Tauri invokes.
 * Suitable for unit tests with injected fixtures.
 */
export function buildOrgContext(
  userId: string,
  member: OrgMemberRow,
  org: OrgRow,
  depts: DeptRow[],
): OrgContextJson {
  const isOrgAdmin = member.role === 'org-admin';
  const orgSlug = slugify(org.name);

  const deptEntries: OrgContextDept[] = depts.map((d) => ({
    id: d.id,
    slug: d.slug,
  }));

  const teams: OrgContextTeam[] = depts.map((d) => ({
    slug: d.slug,
    name: d.name,
    visibility: 'org-readable' as TeamVisibility,
    role: mapTeamRole(member.role, member.dept_id === d.id, isOrgAdmin),
    deptId: d.id,
  }));

  return {
    userId,
    orgId: member.org_id,
    orgSlug,
    isOrgAdmin,
    teams,
    depts: deptEntries,
    brainRepoUrl: org.brain_repo_url ?? null,
  };
}

// ── Supabase fetch ────────────────────────────────────────────

/**
 * Fetch org membership + departments for `userId` and build the
 * org-context.json payload.
 *
 * Uses the active Supabase session (RLS enforced server-side).
 * Returns null when the user has no org membership.
 */
export async function fetchOrgContextData(
  userId: string,
): Promise<OrgContextJson | null> {
  // 1. Org membership
  const { data: memberRows, error: memberErr } = await supabase
    .from('org_members')
    .select('org_id, role, dept_id')
    .eq('user_id', userId)
    .limit(1);

  if (memberErr || !memberRows || memberRows.length === 0) {
    return null;
  }

  const member = memberRows[0] as OrgMemberRow;

  // 2. Org details (name → slug)
  const { data: orgRows, error: orgErr } = await supabase
    .from('organizations')
    .select('id, name, brain_repo_url')
    .eq('id', member.org_id)
    .limit(1);

  if (orgErr || !orgRows || orgRows.length === 0) {
    return null;
  }

  const org = orgRows[0] as OrgRow;

  // 3. All departments visible to the user (RLS: member of org)
  const { data: deptRows, error: deptErr } = await supabase
    .from('departments')
    .select('id, slug, name, org_id')
    .eq('org_id', member.org_id);

  if (deptErr) {
    return null;
  }

  return buildOrgContext(userId, member, org, (deptRows ?? []) as DeptRow[]);
}

// ── Tauri command wrappers ────────────────────────────────────

/**
 * Write org-context.json to the Teams sidecar DATA_DIR (step 1).
 *
 * No-op outside Tauri (web / test environment).
 * In solo mode the TS call-site must NOT call this function.
 */
export async function syncOrgContext(context: OrgContextJson): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('teams_write_org_context', { payload: context });
}

/**
 * Re-write org-context.json after an org membership change (step 4).
 *
 * Call after: session refresh with new claims, role change, team change.
 * No-op outside Tauri.
 */
export async function resyncOrgContext(context: OrgContextJson): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('teams_resync', { payload: context });
}
