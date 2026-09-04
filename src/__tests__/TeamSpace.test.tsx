/**
 * TeamSpace.test.tsx
 *
 * Regression tests for the "Team page flash" bug: opening the Team page as
 * an established member briefly showed the Solo ("no team") empty state
 * before the real Lead/Member content appeared. Root cause — `view` is
 * derived from `realRole` (needs `useOrg`'s `data`) and `orgCount` (needs
 * `useOrgMemberships`' `memberships`); both default to their "empty" value
 * (null / 0) while unresolved, which is indistinguishable from a genuinely
 * Solo user. The old loading gate only checked `!orgId`, so a cached orgId
 * from a previous session (the common case for a member) skipped past it
 * even though `data` hadn't loaded yet — see src/spaces/TeamSpace.tsx.
 *
 * All hooks are mocked (same convention as AppShell.test.tsx's space
 * stubs) so this file asserts TeamSpace's own three-state branching logic
 * — loading / loaded-with-team / loaded-without-team — not any individual
 * hook's or viewpoint's internals (those have their own coverage).
 *
 * Wrapped in the real I18nProvider (not mocked) because LoadingScreen ->
 * Spinner and ErrorScreen both read useI18n() — cheap and self-contained,
 * same convention as AppShell.test.tsx.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { TeamSpace } from '../spaces/TeamSpace';
import { I18nProvider } from '../i18n';
import type { OrgData } from '../lib/teams/types';
import type { OrgMembership } from '../lib/teams/useOrgMemberships';
import type { UseOrgState } from '../lib/teams/useOrg';
import type { UseOrgMembershipsState } from '../lib/teams/useOrgMemberships';

// ── Hook mocks ──────────────────────────────────────────────────────────

const mockUseAuth = vi.fn();
const mockUseOrg = vi.fn();
const mockUseOrgMemberships = vi.fn();

vi.mock('../lib/auth', () => ({ useAuth: () => mockUseAuth() }));
vi.mock('../lib/teams/useOrg', () => ({ useOrg: () => mockUseOrg() }));
vi.mock('../lib/teams/useOrgMemberships', () => ({ useOrgMemberships: () => mockUseOrgMemberships() }));
vi.mock('../lib/teams/useOrgUsageSummary', () => ({
  useOrgUsageSummary: () => ({ byUserId: new Map(), rows: [], loading: false, error: null, refetch: vi.fn() }),
}));

// Child viewpoints stubbed to trivial markers — this file only cares which
// ONE of them (or the loading screen) TeamSpace picks, not their internals.
vi.mock('../components/team/redesign/SoloView', () => ({
  SoloView: () => <div data-testid="solo-view-stub" />,
}));
vi.mock('../components/team/redesign/LeadView', () => ({
  LeadView: () => <div data-testid="lead-view-stub" />,
}));
vi.mock('../components/team/redesign/MemberView', () => ({
  MemberView: () => <div data-testid="member-view-stub" />,
}));
vi.mock('../components/team/redesign/MultiTeamView', () => ({
  MultiTeamView: () => <div data-testid="multi-view-stub" />,
}));

// ── Fixtures ──────────────────────────────────────────────────────────

const CALLER_ID = 'user-1';
const ORG_ID = 'org-1';

const MEMBER_ORG_DATA: OrgData = {
  orgId: ORG_ID,
  name: 'Acme',
  seats: 5,
  members: [{ user_id: CALLER_ID, role: 'member', dept_id: null, added_at: '2026-01-01T00:00:00Z' }],
  invitations: [],
  allocations: [],
  departments: [],
  creditsRemainingCents: 0,
  lastMonthlyGrantCents: 0,
  ownerUserId: 'owner-1',
  brainRepoUrl: null,
  brainRepoHtmlUrl: null,
  brainSeededAt: null,
  brainSeedMode: null,
};

const MEMBER_MEMBERSHIP: OrgMembership = {
  orgId: ORG_ID,
  orgName: 'Acme',
  role: 'member',
  status: 'active',
  seats: 5,
  memberCount: 1,
  brainRepoUrl: null,
};

function orgState(overrides: Partial<UseOrgState>): UseOrgState {
  return {
    orgId: null,
    data: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
    setOrgId: vi.fn(),
    clearActiveOrg: vi.fn(),
    ...overrides,
  };
}

function membershipsState(overrides: Partial<UseOrgMembershipsState>): UseOrgMembershipsState {
  return {
    memberships: [],
    loading: false,
    refresh: vi.fn(),
    ...overrides,
  };
}

function renderTeamSpace(): ReactElement {
  return (
    <I18nProvider>
      <TeamSpace />
    </I18nProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseAuth.mockReturnValue({ user: { id: CALLER_ID } });
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('TeamSpace — loading vs empty-state gating (no flash of "no team")', () => {
  it('renders the loading state (not the empty state) while membership is unresolved', () => {
    // Established member reopening the tab: orgId is already cached from a
    // previous session, but neither useOrgMemberships nor useOrg has
    // resolved yet — this is exactly the race that used to flash Solo.
    mockUseOrgMemberships.mockReturnValue(membershipsState({ loading: true }));
    mockUseOrg.mockReturnValue(orgState({ orgId: ORG_ID, data: null, loading: true }));

    render(renderTeamSpace());

    expect(screen.getByRole('status')).toBeInTheDocument(); // Spinner
    expect(screen.queryByTestId('solo-view-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('member-view-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lead-view-stub')).not.toBeInTheDocument();
  });

  it('renders team content once membership resolves to an existing team', () => {
    mockUseOrgMemberships.mockReturnValue(membershipsState({ memberships: [MEMBER_MEMBERSHIP], loading: false }));
    mockUseOrg.mockReturnValue(orgState({ orgId: ORG_ID, data: MEMBER_ORG_DATA, loading: false }));

    render(renderTeamSpace());

    expect(screen.getByTestId('member-view-stub')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('solo-view-stub')).not.toBeInTheDocument();
  });

  it('renders the empty state only once membership resolves to no team', () => {
    mockUseOrgMemberships.mockReturnValue(membershipsState({ memberships: [], loading: false }));
    mockUseOrg.mockReturnValue(orgState({ orgId: null, data: null, loading: false }));

    render(renderTeamSpace());

    expect(screen.getByTestId('solo-view-stub')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('member-view-stub')).not.toBeInTheDocument();
  });

  it('does not wait on a leftover orgId when nobody is signed in', () => {
    mockUseAuth.mockReturnValue({ user: null });
    mockUseOrgMemberships.mockReturnValue(membershipsState({ loading: false }));
    mockUseOrg.mockReturnValue(orgState({ orgId: ORG_ID, data: null, loading: true }));

    render(renderTeamSpace());

    expect(screen.getByTestId('solo-view-stub')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders team content immediately when membership was already resolved (cache hit) — no loading flash', () => {
    // Mirrors what useOrg/useOrgMemberships report on a second mount within
    // the same session thanks to their module-level cache: loading=false
    // and data/memberships already populated on the very FIRST render.
    mockUseOrgMemberships.mockReturnValue(membershipsState({ memberships: [MEMBER_MEMBERSHIP], loading: false }));
    mockUseOrg.mockReturnValue(orgState({ orgId: ORG_ID, data: MEMBER_ORG_DATA, loading: false }));

    render(renderTeamSpace());

    // Synchronously present on first render — never a loading placeholder.
    expect(screen.getByTestId('member-view-stub')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
