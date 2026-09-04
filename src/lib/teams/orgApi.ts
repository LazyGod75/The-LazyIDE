/* teams/orgApi.ts — thin wrappers over Supabase Edge Functions.
   All functions call functions.invoke() with the user's JWT (session auth).
   Return values follow the ApiEnvelope<T> pattern.
*/

import { supabase } from '../supabase/client.js';
import type {
  OrgCreateResult,
  OrgInviteResult,
  OrgAcceptResult,
  OrgData,
  OrgRole,
  Department,
  ApiEnvelope,
  MemberUsageRow,
} from './types.js';

// ── Helpers ───────────────────────────────────────────────────────

function extractError(data: unknown, status: number): string {
  if (data && typeof data === 'object' && 'error' in data) {
    return String((data as { error: unknown }).error);
  }
  return `Request failed (${status})`;
}

async function invoke<T>(
  fn: string,
  body: Record<string, unknown>,
): Promise<ApiEnvelope<T>> {
  const { data, error } = await supabase.functions.invoke<ApiEnvelope<T>>(fn, {
    body,
  });

  if (error) {
    return { success: false, error: error.message ?? String(error) };
  }

  if (!data) {
    return { success: false, error: 'Empty response from server' };
  }

  if (!data.success) {
    return { success: false, error: extractError(data, 200) };
  }

  return data as { success: true; data: T };
}

// ── Public API ────────────────────────────────────────────────────

/** Create a new organization. The caller becomes the owner (org-admin). */
export async function createOrg(
  name: string,
  seats: number,
): Promise<ApiEnvelope<OrgCreateResult>> {
  return invoke<OrgCreateResult>('org-create', { name, seats });
}

/** Invite a member by email. Role must be one of the valid OrgRole values. */
export async function inviteMember(
  orgId: string,
  email: string,
  role: OrgRole,
  deptId?: string,
): Promise<ApiEnvelope<OrgInviteResult>> {
  return invoke<OrgInviteResult>('org-invite', {
    orgId,
    email,
    role,
    ...(deptId ? { deptId } : {}),
  });
}

/** Accept an invitation using the raw token from the invite link. */
export async function acceptInvite(
  token: string,
): Promise<ApiEnvelope<OrgAcceptResult>> {
  return invoke<OrgAcceptResult>('org-accept-invite', { token });
}

/** Revoke a pending invitation by its ID. */
export async function revokeInvite(
  invitationId: string,
): Promise<ApiEnvelope<{ revoked: boolean }>> {
  return invoke<{ revoked: boolean }>('org-revoke-invite', { invitationId });
}

/** Remove a member from the org. Owner is protected server-side and in the UI. */
export async function removeMember(
  orgId: string,
  userId: string,
): Promise<ApiEnvelope<{ removed: boolean }>> {
  return invoke<{ removed: boolean }>('org-remove-member', { orgId, userId });
}

/** Leave an org the caller is a member of. Rejected server-side for the org owner
 *  (delete the organization instead — see deleteOrg) and for the last org-admin. */
export async function leaveOrg(orgId: string): Promise<ApiEnvelope<{ left: boolean }>> {
  return invoke<{ left: boolean }>('org-leave', { orgId });
}

/** Permanently delete an organization. Owner-only; rejected server-side when a paid
 *  seats subscription is still active (cancel via the billing portal first — B26). */
export async function deleteOrg(orgId: string): Promise<ApiEnvelope<{ deleted: boolean }>> {
  return invoke<{ deleted: boolean }>('org-delete', { orgId });
}

/** Define or update a credit allocation for a member or department. limitCents = 0 removes the allocation. */
export async function setAllocation(
  orgId: string,
  entityType: 'member' | 'dept',
  entityId: string,
  limitCents: number,
  period: string,
): Promise<ApiEnvelope<{ ok: boolean }>> {
  return invoke<{ ok: boolean }>('org-set-allocation', {
    orgId,
    entityType,
    entityId,
    limitCents,
    period,
  });
}

/** Create a department in the org. Slug must be unique within the org. */
export async function createDepartment(
  orgId: string,
  slug: string,
  name: string,
): Promise<ApiEnvelope<{ deptId: string }>> {
  return invoke<{ deptId: string }>('org-create-dept', { orgId, slug, name });
}

/** Change a member's role. The org owner's role is immutable (rejected server-side). */
export async function setMemberRole(
  orgId: string,
  userId: string,
  role: OrgRole,
): Promise<ApiEnvelope<null>> {
  return invoke<null>('org-set-role', { orgId, userId, role });
}

/** Assign a member to a department, or pass null to unassign. */
export async function setMemberDept(
  orgId: string,
  userId: string,
  deptId: string | null,
): Promise<ApiEnvelope<null>> {
  return invoke<null>('org-set-dept', { orgId, userId, deptId });
}

/** List all org data the caller is authorised to see. */
export async function listOrg(orgId: string): Promise<ApiEnvelope<OrgData>> {
  const result = await invoke<{
    org: {
      id: string;
      name: string;
      seats: number;
      creditsRemainingCents?: number;
      lastMonthlyGrantCents?: number;
      ownerUserId?: string;
      brainRepoUrl?: string | null;
      brainRepoHtmlUrl?: string | null;
      brainSeededAt?: string | null;
      brainSeedMode?: string | null;
    };
    members: OrgData['members'];
    invitations: OrgData['invitations'];
    allocations: OrgData['allocations'];
    departments?: Department[];
  }>('org-list', { orgId });

  if (!result.success) return result;

  return {
    success: true,
    data: {
      orgId,
      name: result.data.org?.name ?? '',
      seats: result.data.org?.seats ?? 0,
      members: result.data.members,
      invitations: result.data.invitations,
      allocations: result.data.allocations,
      departments: result.data.departments ?? [],
      creditsRemainingCents: result.data.org?.creditsRemainingCents ?? 0,
      lastMonthlyGrantCents: result.data.org?.lastMonthlyGrantCents ?? 0,
      ownerUserId: result.data.org?.ownerUserId ?? '',
      brainRepoUrl: result.data.org?.brainRepoUrl ?? null,
      brainRepoHtmlUrl: result.data.org?.brainRepoHtmlUrl ?? null,
      brainSeededAt: result.data.org?.brainSeededAt ?? null,
      brainSeedMode: result.data.org?.brainSeedMode ?? null,
    },
  };
}

/**
 * Per-member usage summary since `sinceIso`, via `org-list`'s `usage-summary`
 * action (wraps the `org_usage_summary(p_org_id, p_since)` RPC — SECURITY
 * DEFINER, service_role only, called from the Edge Function).
 *
 * HONESTY NOTE (D5b): usage_events.org_id/dept_id are never populated, so
 * this is each member's TOTAL consumption across every project/org, not
 * consumption attributed specifically to this org. Callers must label it
 * accordingly (e.g. "consommation du membre") rather than implying org-scoped
 * spend.
 */
export async function getUsageSummary(
  orgId: string,
  sinceIso: string,
): Promise<ApiEnvelope<MemberUsageRow[]>> {
  const result = await invoke<{ summary: MemberUsageRow[] }>('org-list', {
    orgId,
    action: 'usage-summary',
    since: sinceIso,
  });

  if (!result.success) return result;
  return { success: true, data: result.data.summary ?? [] };
}

export interface SetBrainRepoResult {
  id: string;
  name: string;
  brain_repo_url: string;
  brain_repo_html_url: string;
  brain_seeded_at: string;
  brain_seed_mode: string;
}

/** Set the brain repo URL for an organization (org-admin only). */
export async function setBrainRepo(
  orgId: string,
  repoUrl: string,
  htmlUrl: string,
  seedMode: 'publish-existing' | 'empty' | 'clone-existing',
): Promise<ApiEnvelope<SetBrainRepoResult>> {
  return invoke<SetBrainRepoResult>('org-set-brain-repo', {
    orgId,
    repoUrl,
    htmlUrl,
    seedMode,
  });
}
