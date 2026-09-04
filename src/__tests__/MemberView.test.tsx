/**
 * MemberView.test.tsx
 *
 * Regression coverage for the usage-summary role gate (org-list's
 * "usage-summary" action): org-admin/team-lead get every member's row,
 * member/viewer only get their OWN row. MemberView only ever renders for
 * member/viewer (roleView.deriveTeamView), and only ever reads its own row
 * via `usageRows.find(r => r.user_id === callerUserId)` — this file pins
 * that the "YOUR BUDGET" card renders correctly from a `usageRows` array
 * containing ONLY the caller's own row (the shape the backend now sends
 * for this role), not just from a full-org array as before the gate.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { OrgData, MemberUsageRow } from '../lib/teams/types';

vi.mock('../i18n', () => ({
  useI18n: () => ({ t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key) }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({ t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key) }),
}));

vi.mock('../lib/agents/fleetMissions', () => ({
  useFleetMissions: () => ({ projects: [], loading: false, error: null }),
}));

vi.mock('../lib/bus', () => ({
  emit: vi.fn(),
}));

vi.mock('../components/team/TeamBrainSearch', () => ({
  TeamBrainSearch: () => <div data-testid="team-brain-search-stub" />,
}));

vi.mock('../components/team/redesign/GitHubPanel', () => ({
  GitHubPanel: () => <div data-testid="github-panel-stub" />,
}));

vi.mock('../components/team/redesign/LeaveOrgControl', () => ({
  LeaveOrgControl: () => <div data-testid="leave-org-control-stub" />,
}));

vi.mock('../lib/billing', () => ({
  formatCredits: (cents: number) => `${cents}cr`,
}));

import { MemberView } from '../components/team/redesign/MemberView';

const CALLER_ID = 'user-member';

const ORG_DATA: OrgData = {
  orgId: 'org-1',
  name: 'Acme',
  seats: 5,
  members: [
    { user_id: CALLER_ID, role: 'member', dept_id: null, added_at: '2026-01-01T00:00:00Z' },
    { user_id: 'user-other', role: 'member', dept_id: null, added_at: '2026-01-01T00:00:00Z' },
  ],
  invitations: [],
  allocations: [
    { id: 'alloc-1', entity_type: 'member', entity_id: CALLER_ID, limit_cents: 10000, period: 'month', created_at: '2026-01-01T00:00:00Z' },
  ],
  departments: [],
  creditsRemainingCents: 0,
  lastMonthlyGrantCents: 0,
  ownerUserId: 'owner-1',
  brainRepoUrl: null,
  brainRepoHtmlUrl: null,
  brainSeededAt: null,
  brainSeedMode: null,
};

function ownRow(overrides: Partial<MemberUsageRow> = {}): MemberUsageRow {
  return {
    user_id: CALLER_ID,
    dept_id: null,
    events: 12,
    cost_charged_usd: 42.5,
    input_tokens: 1000,
    output_tokens: 500,
    last_event_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

describe('MemberView — usage-summary role gate (member/viewer only see their own row)', () => {
  it('renders the caller\'s own budget from a usageRows array containing ONLY that row (post-gate backend shape)', () => {
    render(
      <MemberView
        data={ORG_DATA}
        callerUserId={CALLER_ID}
        usageRows={[ownRow()]}
        onLeftOrg={vi.fn()}
      />,
    );

    // 42.5 USD -> 4250 cents, formatted via the mocked formatCredits.
    expect(screen.getByText('4250cr')).toBeInTheDocument();
  });

  it('renders identically when usageRows also contains other members\' rows (pre-gate/admin shape) — same own-row lookup', () => {
    render(
      <MemberView
        data={ORG_DATA}
        callerUserId={CALLER_ID}
        usageRows={[ownRow(), ownRow({ user_id: 'user-other', cost_charged_usd: 999 })]}
        onLeftOrg={vi.fn()}
      />,
    );

    expect(screen.getByText('4250cr')).toBeInTheDocument();
    expect(screen.queryByText('99900cr')).not.toBeInTheDocument();
  });

  it('falls back to 0 (not a broken/empty layout) when usageRows has no row for the caller', () => {
    render(
      <MemberView
        data={ORG_DATA}
        callerUserId={CALLER_ID}
        usageRows={[]}
        onLeftOrg={vi.fn()}
      />,
    );

    expect(screen.getByText('0cr')).toBeInTheDocument();
  });
});
