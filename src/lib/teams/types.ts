/* teams/types.ts — shared types for the Teams feature. */

export type OrgRole = 'org-admin' | 'team-lead' | 'member' | 'viewer';

export const ORG_ROLES: OrgRole[] = ['org-admin', 'team-lead', 'member', 'viewer'];

export interface OrgMember {
  user_id: string;
  role: OrgRole;
  dept_id: string | null;
  dept_name?: string | null;
  added_at: string;
  /** Display name resolved from user profile (optional, may be undefined in member-only views). */
  display_name?: string;
  email?: string;
}

export interface OrgInvitation {
  id: string;
  email: string;
  role: OrgRole;
  dept_id: string | null;
  status: 'pending' | 'accepted' | 'revoked';
  expires_at: string;
  created_at: string;
}

export interface OrgAllocation {
  id: string;
  entity_type: string;
  entity_id: string;
  limit_cents: number;
  period: string;
  created_at: string;
}

export interface Department {
  id: string;
  slug: string;
  name: string;
}

export interface OrgData {
  orgId: string;
  name: string;
  seats: number;
  members: OrgMember[];
  invitations: OrgInvitation[];
  allocations: OrgAllocation[];
  departments: Department[];
  /** Org pot commun balance — real column (organizations.credits_remaining_cents). */
  creditsRemainingCents: number;
  /** Current monthly grant amount — used to render "sur {total}" captions. */
  lastMonthlyGrantCents: number;
  /** organizations.owner_user_id — the ONE user who can delete the org and
   *  who can never leave it (must delete instead). Every other org-admin/
   *  team-lead/member/viewer may leave (B26). */
  ownerUserId: string;
  brainRepoUrl: string | null;
  brainRepoHtmlUrl: string | null;
  brainSeededAt: string | null;
  brainSeedMode: string | null;
}

// ── Usage summary (D5b — org_usage_summary RPC) ───────────────────

/**
 * One row of `public.org_usage_summary(p_org_id, p_since)` — the member's
 * TOTAL consumption (usage_events.org_id/dept_id are never populated, so
 * this is not scoped to work done "for" this org specifically — label it
 * honestly in the UI, e.g. "consommation du membre").
 */
export interface MemberUsageRow {
  user_id: string;
  dept_id: string | null;
  events: number;
  cost_charged_usd: number;
  input_tokens: number;
  output_tokens: number;
  last_event_at: string | null;
}

// ── Team Brain search ─────────────────────────────────────────────

/**
 * A single search result from the team brain (GET /search or /dept/:slug/search).
 * Fields extracted from data-cerveau-* HTML attributes by the Teams sidecar.
 */
export interface TeamBrainSearchResult {
  id: string;
  title: string;
  excerpt: string;
  /** Author extracted from data-cerveau-author (email or display name). */
  author: string | null;
  /** Agent name from data-cerveau-agent (e.g. "code-reviewer"). */
  agent: string | null;
  /** Source team slug when available. */
  team: string | null;
  /** Source department slug when available. */
  dept: string | null;
  /** 'org' for federated results, or a dept slug for dept-scoped results. */
  scope: string;
}

/** Scope of a team brain search. */
export type TeamBrainScopeKind = 'org' | 'dept';

export interface TeamBrainScope {
  kind: TeamBrainScopeKind;
  /** Only meaningful when kind === 'dept'. */
  deptSlug?: string;
}

// ── API response shapes ───────────────────────────────────────────

export interface OrgCreateResult {
  orgId: string;
}

export interface OrgInviteResult {
  invitationId: string;
  token: string;
  link: string;
}

export interface OrgAcceptResult {
  orgId: string;
}

export type ApiEnvelope<T> =
  | { success: true; data: T }
  | { success: false; error: string };
