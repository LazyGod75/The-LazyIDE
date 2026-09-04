/* supabase-mock.ts — replaces src/lib/supabase/client for the screenshot harness.
   Intercepts functions.invoke to return demo data; stubs auth to return no session
   (auth is mocked at the useAuth level instead). */

import type { OrgData } from '../../lib/teams/types';

const DEMO_ORG_ID = 'org-acme-demo-001';

const DEMO_DATA: OrgData = {
  orgId: DEMO_ORG_ID,
  name: 'Acme Corp',
  seats: 10,
  departments: [
    { id: 'engineering', slug: 'engineering', name: 'Engineering' },
    { id: 'design', slug: 'design', name: 'Design' },
  ],
  creditsRemainingCents: 500000,
  lastMonthlyGrantCents: 500000,
  ownerUserId: 'user-admin-001',
  brainRepoUrl: null,
  brainRepoHtmlUrl: null,
  brainSeededAt: null,
  brainSeedMode: null,
  members: [
    {
      user_id: 'user-admin-001',
      role: 'org-admin',
      dept_id: 'engineering',
      added_at: '2026-01-15T10:00:00Z',
      display_name: 'Alice Martin',
      email: 'alice@acme.com',
    },
    {
      user_id: 'user-lead-002',
      role: 'team-lead',
      dept_id: 'engineering',
      added_at: '2026-01-20T10:00:00Z',
      display_name: 'Bob Chen',
      email: 'bob@acme.com',
    },
    {
      user_id: 'user-member-003',
      role: 'member',
      dept_id: 'design',
      added_at: '2026-02-01T10:00:00Z',
      display_name: 'Clara Dupont',
      email: 'clara@acme.com',
    },
    {
      user_id: 'user-viewer-004',
      role: 'viewer',
      dept_id: null,
      added_at: '2026-03-05T10:00:00Z',
      display_name: 'David Kim',
      email: 'david@acme.com',
    },
  ],
  invitations: [
    {
      id: 'inv-001',
      email: 'grace@acme.com',
      role: 'member',
      dept_id: 'engineering',
      status: 'pending',
      expires_at: '2026-07-15T10:00:00Z',
      created_at: '2026-06-25T10:00:00Z',
    },
    {
      id: 'inv-002',
      email: 'henry@acme.com',
      role: 'team-lead',
      dept_id: 'design',
      status: 'pending',
      expires_at: '2026-07-10T10:00:00Z',
      created_at: '2026-06-20T10:00:00Z',
    },
  ],
  allocations: [
    {
      id: 'alloc-001',
      entity_type: 'member',
      entity_id: 'user-lead-002',
      limit_cents: 5000,
      period: '2026-06',
      created_at: '2026-06-01T00:00:00Z',
    },
    {
      id: 'alloc-002',
      entity_type: 'dept',
      entity_id: 'design',
      limit_cents: 15000,
      period: '2026-06',
      created_at: '2026-06-01T00:00:00Z',
    },
  ],
};

// Minimal Supabase client mock
export const supabase = {
  auth: {
    getSession: () => Promise.resolve({ data: { session: null }, error: null }),
    onAuthStateChange: (_event: unknown, _cb: unknown) => ({
      data: { subscription: { unsubscribe: () => {} } },
    }),
    signUp: () => Promise.resolve({ error: null }),
    signIn: () => Promise.resolve({ error: null }),
    signOut: () => Promise.resolve(),
    signInWithOAuth: () => Promise.resolve({ data: null, error: null }),
  },
  functions: {
    invoke: async (fn: string, _opts: unknown) => {
      // Simulate tiny network delay
      await new Promise((r) => setTimeout(r, 50));

      if (fn === 'org-list') {
        return {
          data: {
            success: true,
            data: {
              members: DEMO_DATA.members,
              invitations: DEMO_DATA.invitations,
              allocations: DEMO_DATA.allocations,
            },
          },
          error: null,
        };
      }

      if (fn === 'org-create') {
        return { data: { success: true, data: { orgId: DEMO_ORG_ID } }, error: null };
      }

      if (fn === 'org-invite') {
        return {
          data: {
            success: true,
            data: {
              invitationId: 'inv-new-001',
              token: 'mock-token-xyz',
              link: 'https://lazy.app/invite/mock-token-xyz',
            },
          },
          error: null,
        };
      }

      if (fn === 'org-set-allocation') {
        return { data: { success: true, data: { ok: true } }, error: null };
      }

      if (fn === 'org-remove-member') {
        return { data: { success: true, data: { removed: true } }, error: null };
      }

      if (fn === 'org-revoke-invite') {
        return { data: { success: true, data: { revoked: true } }, error: null };
      }

      if (fn === 'org-accept-invite') {
        return { data: { success: true, data: { orgId: DEMO_ORG_ID } }, error: null };
      }

      return { data: { success: false, error: `Unknown function: ${fn}` }, error: null };
    },
  },
};
