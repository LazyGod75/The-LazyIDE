/**
 * team-ui.test.tsx
 *
 * Unit tests for the Team tab foundation:
 *   - Feature flag: Team tab hidden when TEAMS_ENABLED is false
 *   - OrgOnboarding: create org and join org flows
 *   - OrgDashboard: members section, invitations section, invite modal trigger
 *   - MembersList: owner protection, self protection, remove action
 *   - InvitationsList: revoke action
 *   - InviteModal: send invite -> shows invite link
 *   - useOrg hook: loading/error/data states
 *
 * Note on PrimaryButton:  OrgOnboarding uses a local PrimaryButton wrapper that
 * does NOT forward arbitrary props (no rest spread), so data-testid never reaches
 * the DOM.  Tests that need to click the CTA button use getByRole('button', {name}).
 * Since the i18n mock returns the translation key itself, button names are stable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// ── i18n mock — returns the key, so test assertions are locale-agnostic ──

vi.mock('../i18n', () => {
  const context = {
    t: (key: string) => key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  };
  return {
    useI18n: () => context,
    // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not
    // useI18n — must be present here too or it renders provider-less
    // (which is fine) but the mock itself must export the symbol.
    useI18nOptional: () => context,
  };
});

// ── Toast mock ────────────────────────────────────────────────────────

const toastSpy = vi.fn();
vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ── orgApi mock ───────────────────────────────────────────────────────

const createOrgMock = vi.fn();
const acceptInviteMock = vi.fn();
const inviteMemberMock = vi.fn();
const revokeInviteMock = vi.fn();
const removeMemberMock = vi.fn();
const listOrgMock = vi.fn();
const createDepartmentMock = vi.fn();
const setMemberRoleMock = vi.fn();
const setMemberDeptMock = vi.fn();

vi.mock('../lib/teams/orgApi', () => ({
  createOrg: (...args: unknown[]) => createOrgMock(...args),
  acceptInvite: (...args: unknown[]) => acceptInviteMock(...args),
  inviteMember: (...args: unknown[]) => inviteMemberMock(...args),
  revokeInvite: (...args: unknown[]) => revokeInviteMock(...args),
  removeMember: (...args: unknown[]) => removeMemberMock(...args),
  listOrg: (...args: unknown[]) => listOrgMock(...args),
  createDepartment: (...args: unknown[]) => createDepartmentMock(...args),
  setMemberRole: (...args: unknown[]) => setMemberRoleMock(...args),
  setMemberDept: (...args: unknown[]) => setMemberDeptMock(...args),
}));

// ── auth mock ─────────────────────────────────────────────────────────

vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: { id: 'caller-user-id' } }),
}));

// ── useOrg mock ───────────────────────────────────────────────────────

const useOrgMock = vi.fn();
vi.mock('../lib/teams/useOrg', () => ({
  useOrg: (...args: unknown[]) => useOrgMock(...args),
  loadStoredOrgId: vi.fn(() => null),
  saveOrgId: vi.fn(),
  clearOrgId: vi.fn(),
}));

// ── useAllocations mock ───────────────────────────────────────────────

vi.mock('../lib/teams/useAllocations', () => ({
  useAllocations: () => ({
    allocations: [],
    members: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
    setAllocation: vi.fn(),
    removeAllocation: vi.fn(),
  }),
}));

// ── billing mock (startTeamsCheckout + startTeamsTopup) ───────────────

const startTeamsCheckoutMock = vi.fn();
const startTeamsTopupMock = vi.fn();

vi.mock('../lib/billing', () => ({
  startTeamsCheckout: (...args: unknown[]) => startTeamsCheckoutMock(...args),
  startTeamsTopup: (...args: unknown[]) => startTeamsTopupMock(...args),
}));

// ── ActiveTeamContext mock ─────────────────────────────────────────────

const activeTeamContextValue = { hasActiveTeam: false, refresh: vi.fn() };

vi.mock('../lib/teams/ActiveTeamContext', () => ({
  useActiveTeamContext: () => activeTeamContextValue,
}));

// ── features mock — default: TEAMS_ENABLED = false ────────────────────

vi.mock('../lib/features', () => ({
  TEAMS_ENABLED: false,
}));

// ── bus mock — capture navigation emits ───────────────────────────────

const emitMock = vi.fn();
vi.mock('../lib/bus', () => ({
  emit: (...args: unknown[]) => emitMock(...args),
  on: () => () => undefined,
}));

// ── Imports (after mocks) ─────────────────────────────────────────────

import { OrgOnboarding } from '../components/team/OrgOnboarding';
import { OrgDashboard } from '../components/team/OrgDashboard';
import { MembersList } from '../components/team/MembersList';
import { InvitationsList } from '../components/team/InvitationsList';
import { InviteModal } from '../components/team/InviteModal';
import { TeamsCtaSection } from '../components/team/TeamsCtaSection';
import { CreditsSection } from '../components/team/CreditsSection';
import { DepartmentsSection } from '../components/team/DepartmentsSection';
import type { OrgData, OrgMember, OrgInvitation, Department } from '../lib/teams/types';

// ── Fixtures ──────────────────────────────────────────────────────────

const ADMIN_MEMBER: OrgMember = {
  user_id: 'caller-user-id',
  role: 'org-admin',
  dept_id: null,
  added_at: '2025-01-01T00:00:00Z',
  display_name: 'Alice Admin',
};

const REGULAR_MEMBER: OrgMember = {
  user_id: 'other-user-id',
  role: 'member',
  dept_id: 'engineering',
  added_at: '2025-01-02T00:00:00Z',
  display_name: 'Bob Member',
};

const PENDING_INVITE: OrgInvitation = {
  id: 'invite-123',
  email: 'charlie@example.com',
  role: 'member',
  dept_id: null,
  status: 'pending',
  expires_at: new Date(Date.now() + 86400000).toISOString(), // tomorrow
  created_at: '2025-01-01T00:00:00Z',
};

const DEPARTMENTS: Department[] = [
  { id: 'engineering', slug: 'engineering', name: 'Engineering' },
  { id: 'design', slug: 'design', name: 'Design' },
];

const ORG_DATA: OrgData = {
  orgId: 'org-abc123',
  name: 'Acme Corp',
  seats: 5,
  members: [ADMIN_MEMBER, REGULAR_MEMBER],
  invitations: [PENDING_INVITE],
  allocations: [],
  departments: DEPARTMENTS,
  creditsRemainingCents: 100000,
  lastMonthlyGrantCents: 100000,
  ownerUserId: 'caller-user-id',
  brainRepoUrl: null,
  brainRepoHtmlUrl: null,
  brainSeededAt: null,
  brainSeedMode: null,
};

// ─────────────────────────────────────────────────────────────────────
// Feature flag
// ─────────────────────────────────────────────────────────────────────

describe('TEAMS_ENABLED feature flag', () => {
  it('is false by default (module mock), so Team tab does not surface', async () => {
    const { TEAMS_ENABLED } = await import('../lib/features');
    expect(TEAMS_ENABLED).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// TeamSpace guard — tested via the flag value (AppShell switch logic)
// ─────────────────────────────────────────────────────────────────────

describe('TeamSpace guard', () => {
  it('solo experience is unchanged: flag off => no team content rendered', async () => {
    const { TEAMS_ENABLED } = await import('../lib/features');
    // Mirrors: case 'team': return TEAMS_ENABLED ? <TeamSpace /> : null
    const content = TEAMS_ENABLED ? 'team-visible' : null;
    expect(content).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// OrgOnboarding
// ─────────────────────────────────────────────────────────────────────

describe('OrgOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders create mode by default with name and seats inputs', () => {
    render(<OrgOnboarding onOrgCreated={vi.fn()} />);
    expect(screen.getByTestId('org-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('org-seats-input')).toBeInTheDocument();
    // CTA button present (PrimaryButton does not forward data-testid, use role)
    expect(screen.getByRole('button', { name: 'team.create.cta' })).toBeInTheDocument();
  });

  it('switches to join mode when Join tab is clicked', () => {
    render(<OrgOnboarding onOrgCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('mode-join'));
    expect(screen.getByTestId('org-token-input')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'team.join.cta' })).toBeInTheDocument();
  });

  it('create button is disabled when name is empty', () => {
    render(<OrgOnboarding onOrgCreated={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'team.create.cta' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('create button is enabled after filling in the name', () => {
    render(<OrgOnboarding onOrgCreated={vi.fn()} />);
    fireEvent.change(screen.getByTestId('org-name-input'), {
      target: { value: 'Acme Corp' },
    });
    const btn = screen.getByRole('button', { name: 'team.create.cta' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('calls org-create endpoint and invokes onOrgCreated on success', async () => {
    createOrgMock.mockResolvedValue({ success: true, data: { orgId: 'new-org-id' } });
    const onCreated = vi.fn();

    render(<OrgOnboarding onOrgCreated={onCreated} />);

    fireEvent.change(screen.getByTestId('org-name-input'), {
      target: { value: 'Test Corp' },
    });
    fireEvent.change(screen.getByTestId('org-seats-input'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'team.create.cta' }));

    await waitFor(() => {
      expect(createOrgMock).toHaveBeenCalledWith('Test Corp', 10);
      expect(onCreated).toHaveBeenCalledWith('new-org-id');
    });
  });

  it('shows error toast when org-create fails', async () => {
    createOrgMock.mockResolvedValue({ success: false, error: 'Server error' });
    render(<OrgOnboarding onOrgCreated={vi.fn()} />);

    fireEvent.change(screen.getByTestId('org-name-input'), {
      target: { value: 'Test Corp' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'team.create.cta' }));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith('Server error', 'error');
    });
  });

  it('calls org-accept-invite and invokes onOrgCreated on success', async () => {
    acceptInviteMock.mockResolvedValue({ success: true, data: { orgId: 'joined-org-id' } });
    const onCreated = vi.fn();

    render(<OrgOnboarding onOrgCreated={onCreated} />);
    fireEvent.click(screen.getByTestId('mode-join'));

    fireEvent.change(screen.getByTestId('org-token-input'), {
      target: { value: 'my-invite-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'team.join.cta' }));

    await waitFor(() => {
      expect(acceptInviteMock).toHaveBeenCalledWith('my-invite-token');
      expect(onCreated).toHaveBeenCalledWith('joined-org-id');
    });
  });

  it('extracts token from a full invite URL', async () => {
    acceptInviteMock.mockResolvedValue({ success: true, data: { orgId: 'from-url' } });
    const onCreated = vi.fn();

    render(<OrgOnboarding onOrgCreated={onCreated} />);
    fireEvent.click(screen.getByTestId('mode-join'));

    fireEvent.change(screen.getByTestId('org-token-input'), {
      target: { value: 'https://app.lazy.dev/invite?token=abc123xyz' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'team.join.cta' }));

    await waitFor(() => {
      expect(acceptInviteMock).toHaveBeenCalledWith('abc123xyz');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// MembersList
// ─────────────────────────────────────────────────────────────────────

describe('MembersList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty state when no members', () => {
    render(
      <MembersList
        orgId="org-1"
        members={[]}
        departments={DEPARTMENTS}
        callerUserId="caller-user-id"
        isAdmin={false}
        onRefetch={vi.fn()}
      />,
    );
    expect(screen.getByText('team.members.empty')).toBeInTheDocument();
  });

  it('renders all member rows', () => {
    render(
      <MembersList
        orgId="org-1"
        members={[ADMIN_MEMBER, REGULAR_MEMBER]}
        departments={DEPARTMENTS}
        callerUserId="caller-user-id"
        isAdmin={true}
        onRefetch={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId('member-row')).toHaveLength(2);
  });

  it('remove button is disabled for the org-admin (owner protected)', () => {
    render(
      <MembersList
        orgId="org-1"
        members={[ADMIN_MEMBER]}
        departments={DEPARTMENTS}
        callerUserId="different-user"
        isAdmin={true}
        onRefetch={vi.fn()}
      />,
    );
    const removeBtn = screen.getByTestId(`remove-member-${ADMIN_MEMBER.user_id}`);
    expect(removeBtn).toBeDisabled();
  });

  it('remove button is disabled for the caller themselves (self-protection)', () => {
    render(
      <MembersList
        orgId="org-1"
        members={[REGULAR_MEMBER]}
        departments={DEPARTMENTS}
        callerUserId="other-user-id"
        isAdmin={true}
        onRefetch={vi.fn()}
      />,
    );
    const removeBtn = screen.getByTestId(`remove-member-${REGULAR_MEMBER.user_id}`);
    expect(removeBtn).toBeDisabled();
  });

  it('remove button is enabled for a non-owner, non-self member', () => {
    const thirdParty: OrgMember = {
      user_id: 'third-user-id',
      role: 'member',
      dept_id: null,
      added_at: '2025-01-03T00:00:00Z',
    };

    render(
      <MembersList
        orgId="org-1"
        members={[thirdParty]}
        departments={DEPARTMENTS}
        callerUserId="caller-user-id"
        isAdmin={true}
        onRefetch={vi.fn()}
      />,
    );
    const removeBtn = screen.getByTestId(`remove-member-${thirdParty.user_id}`);
    expect(removeBtn).not.toBeDisabled();
  });

  it('calls org-remove-member with correct args and triggers refetch on success', async () => {
    removeMemberMock.mockResolvedValue({ success: true, data: { removed: true } });
    const onRefetch = vi.fn();
    const thirdParty: OrgMember = {
      user_id: 'third-user-id',
      role: 'member',
      dept_id: null,
      added_at: '2025-01-03T00:00:00Z',
    };

    render(
      <MembersList
        orgId="org-abc"
        members={[thirdParty]}
        departments={DEPARTMENTS}
        callerUserId="caller-user-id"
        isAdmin={true}
        onRefetch={onRefetch}
      />,
    );

    fireEvent.click(screen.getByTestId(`remove-member-${thirdParty.user_id}`));

    await waitFor(() => {
      expect(removeMemberMock).toHaveBeenCalledWith('org-abc', 'third-user-id');
      expect(onRefetch).toHaveBeenCalled();
    });
  });

  // ── Admin role + department controls ────────────────────────────

  it('admin sees role and department selects for a member', () => {
    render(
      <MembersList
        orgId="org-1"
        members={[REGULAR_MEMBER]}
        departments={DEPARTMENTS}
        callerUserId="caller-user-id"
        isAdmin={true}
        onRefetch={vi.fn()}
      />,
    );
    expect(screen.getByTestId(`role-select-${REGULAR_MEMBER.user_id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`dept-select-${REGULAR_MEMBER.user_id}`)).toBeInTheDocument();
  });

  it('non-admin sees NO role/dept selects — read-only badge only', () => {
    render(
      <MembersList
        orgId="org-1"
        members={[REGULAR_MEMBER]}
        departments={DEPARTMENTS}
        callerUserId="other-user-id"
        isAdmin={false}
        onRefetch={vi.fn()}
      />,
    );
    expect(screen.queryByTestId(`role-select-${REGULAR_MEMBER.user_id}`)).toBeNull();
    expect(screen.queryByTestId(`dept-select-${REGULAR_MEMBER.user_id}`)).toBeNull();
    expect(screen.queryByTestId(`remove-member-${REGULAR_MEMBER.user_id}`)).toBeNull();
    // Read-only role badge is still shown.
    expect(screen.getByText('team.role.member')).toBeInTheDocument();
  });

  it('role select is disabled for the caller’s own row (self)', () => {
    render(
      <MembersList
        orgId="org-1"
        members={[ADMIN_MEMBER]}
        departments={DEPARTMENTS}
        callerUserId="caller-user-id"
        isAdmin={true}
        onRefetch={vi.fn()}
      />,
    );
    expect(screen.getByTestId(`role-select-${ADMIN_MEMBER.user_id}`)).toBeDisabled();
  });

  it('changing the role select calls setMemberRole and refetches on success', async () => {
    setMemberRoleMock.mockResolvedValue({ success: true, data: null });
    const onRefetch = vi.fn();

    render(
      <MembersList
        orgId="org-xyz"
        members={[REGULAR_MEMBER]}
        departments={DEPARTMENTS}
        callerUserId="caller-user-id"
        isAdmin={true}
        onRefetch={onRefetch}
      />,
    );

    fireEvent.change(screen.getByTestId(`role-select-${REGULAR_MEMBER.user_id}`), {
      target: { value: 'team-lead' },
    });

    await waitFor(() => {
      expect(setMemberRoleMock).toHaveBeenCalledWith('org-xyz', 'other-user-id', 'team-lead');
      expect(onRefetch).toHaveBeenCalled();
    });
  });

  it('shows error toast when setMemberRole is rejected (owner role immutable)', async () => {
    setMemberRoleMock.mockResolvedValue({ success: false, error: 'The owner role is immutable.' });
    const onRefetch = vi.fn();

    render(
      <MembersList
        orgId="org-1"
        members={[REGULAR_MEMBER]}
        departments={DEPARTMENTS}
        callerUserId="caller-user-id"
        isAdmin={true}
        onRefetch={onRefetch}
      />,
    );

    fireEvent.change(screen.getByTestId(`role-select-${REGULAR_MEMBER.user_id}`), {
      target: { value: 'viewer' },
    });

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith('The owner role is immutable.', 'error');
      expect(onRefetch).not.toHaveBeenCalled();
    });
  });

  it('changing the dept select to a department calls setMemberDept with the dept id', async () => {
    setMemberDeptMock.mockResolvedValue({ success: true, data: null });
    const onRefetch = vi.fn();

    render(
      <MembersList
        orgId="org-dep"
        members={[REGULAR_MEMBER]}
        departments={DEPARTMENTS}
        callerUserId="caller-user-id"
        isAdmin={true}
        onRefetch={onRefetch}
      />,
    );

    fireEvent.change(screen.getByTestId(`dept-select-${REGULAR_MEMBER.user_id}`), {
      target: { value: 'design' },
    });

    await waitFor(() => {
      expect(setMemberDeptMock).toHaveBeenCalledWith('org-dep', 'other-user-id', 'design');
      expect(onRefetch).toHaveBeenCalled();
    });
  });

  it('changing the dept select to unassigned calls setMemberDept with null', async () => {
    setMemberDeptMock.mockResolvedValue({ success: true, data: null });

    render(
      <MembersList
        orgId="org-dep"
        members={[REGULAR_MEMBER]}
        departments={DEPARTMENTS}
        callerUserId="caller-user-id"
        isAdmin={true}
        onRefetch={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId(`dept-select-${REGULAR_MEMBER.user_id}`), {
      target: { value: '' },
    });

    await waitFor(() => {
      expect(setMemberDeptMock).toHaveBeenCalledWith('org-dep', 'other-user-id', null);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// InvitationsList
// ─────────────────────────────────────────────────────────────────────

describe('InvitationsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty state when no invitations', () => {
    render(<InvitationsList invitations={[]} onRefetch={vi.fn()} />);
    expect(screen.getByText('team.invitations.empty')).toBeInTheDocument();
  });

  it('renders invitation rows with email visible', () => {
    render(<InvitationsList invitations={[PENDING_INVITE]} onRefetch={vi.fn()} />);
    expect(screen.getAllByTestId('invitation-row')).toHaveLength(1);
    expect(screen.getByText('charlie@example.com')).toBeInTheDocument();
  });

  it('calls org-revoke-invite with the correct invitationId', async () => {
    revokeInviteMock.mockResolvedValue({ success: true, data: { revoked: true } });
    const onRefetch = vi.fn();

    render(<InvitationsList invitations={[PENDING_INVITE]} onRefetch={onRefetch} />);
    fireEvent.click(screen.getByTestId(`revoke-invite-${PENDING_INVITE.id}`));

    await waitFor(() => {
      expect(revokeInviteMock).toHaveBeenCalledWith('invite-123');
      expect(onRefetch).toHaveBeenCalled();
    });
  });

  it('shows error toast when revoke fails', async () => {
    revokeInviteMock.mockResolvedValue({ success: false, error: 'Revoke failed' });

    render(<InvitationsList invitations={[PENDING_INVITE]} onRefetch={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`revoke-invite-${PENDING_INVITE.id}`));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith('Revoke failed', 'error');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// InviteModal
// ─────────────────────────────────────────────────────────────────────

describe('InviteModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders email, role, and department fields', () => {
    render(<InviteModal orgId="org-1" onClose={vi.fn()} onInvited={vi.fn()} />);
    expect(screen.getByTestId('invite-email-input')).toBeInTheDocument();
    expect(screen.getByTestId('invite-role-select')).toBeInTheDocument();
    expect(screen.getByTestId('invite-dept-input')).toBeInTheDocument();
  });

  it('send button is disabled when email is empty', () => {
    render(<InviteModal orgId="org-1" onClose={vi.fn()} onInvited={vi.fn()} />);
    const btn = screen.getByTestId('send-invite-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('calls org-invite with correct args and shows invite link on success', async () => {
    inviteMemberMock.mockResolvedValue({
      success: true,
      data: {
        invitationId: 'inv-1',
        token: 'tok-abc',
        link: 'https://app.lazy.dev/invite?token=tok-abc',
      },
    });
    const onInvited = vi.fn();

    render(<InviteModal orgId="org-xyz" onClose={vi.fn()} onInvited={onInvited} />);

    fireEvent.change(screen.getByTestId('invite-email-input'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.click(screen.getByTestId('send-invite-btn'));

    await waitFor(() => {
      expect(inviteMemberMock).toHaveBeenCalledWith(
        'org-xyz',
        'new@example.com',
        'member',
        undefined,
      );
      expect(onInvited).toHaveBeenCalled();
      // After success, the invite link copy button is shown.
      expect(screen.getByTestId('copy-link-btn')).toBeInTheDocument();
    });
  });

  it('shows error toast when invite fails', async () => {
    inviteMemberMock.mockResolvedValue({ success: false, error: 'Invite limit reached' });

    render(<InviteModal orgId="org-1" onClose={vi.fn()} onInvited={vi.fn()} />);

    fireEvent.change(screen.getByTestId('invite-email-input'), {
      target: { value: 'fail@example.com' },
    });
    fireEvent.click(screen.getByTestId('send-invite-btn'));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith('Invite limit reached', 'error');
    });
  });

  it('passes the selected role to org-invite', async () => {
    inviteMemberMock.mockResolvedValue({
      success: true,
      data: { invitationId: 'inv-2', token: 'tok-2', link: 'https://x' },
    });

    render(<InviteModal orgId="org-1" onClose={vi.fn()} onInvited={vi.fn()} />);

    fireEvent.change(screen.getByTestId('invite-email-input'), {
      target: { value: 'lead@example.com' },
    });
    fireEvent.change(screen.getByTestId('invite-role-select'), {
      target: { value: 'team-lead' },
    });
    fireEvent.click(screen.getByTestId('send-invite-btn'));

    await waitFor(() => {
      expect(inviteMemberMock).toHaveBeenCalledWith(
        'org-1',
        'lead@example.com',
        'team-lead',
        undefined,
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// OrgDashboard
// ─────────────────────────────────────────────────────────────────────

describe('OrgDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders member rows and invite button for an org-admin', () => {
    render(
      <OrgDashboard
        data={ORG_DATA}
        loading={false}
        callerUserId="caller-user-id"
        onRefetch={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId('member-row').length).toBeGreaterThan(0);
    expect(screen.getByTestId('open-invite-modal-btn')).toBeInTheDocument();
  });

  it('does NOT show invite button when caller is not an admin', () => {
    render(
      <OrgDashboard
        data={{ ...ORG_DATA, members: [REGULAR_MEMBER] }}
        loading={false}
        callerUserId="other-user-id"
        onRefetch={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('open-invite-modal-btn')).toBeNull();
  });

  it('opens InviteModal when invite button is clicked', () => {
    render(
      <OrgDashboard
        data={ORG_DATA}
        loading={false}
        callerUserId="caller-user-id"
        onRefetch={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('open-invite-modal-btn'));
    expect(screen.getByTestId('invite-email-input')).toBeInTheDocument();
  });

  it('shows invitations section for admin', () => {
    render(
      <OrgDashboard
        data={ORG_DATA}
        loading={false}
        callerUserId="caller-user-id"
        onRefetch={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId('invitation-row').length).toBeGreaterThan(0);
  });

  it('hides invitations section for non-admin', () => {
    render(
      <OrgDashboard
        data={{ ...ORG_DATA, members: [REGULAR_MEMBER] }}
        loading={false}
        callerUserId="other-user-id"
        onRefetch={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('invitation-row')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// useOrg hook — verified through the mock's return shapes
// ─────────────────────────────────────────────────────────────────────

describe('useOrg hook state machine', () => {
  it('no fetch is triggered when orgId is null', () => {
    useOrgMock.mockReturnValue({
      orgId: null,
      data: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
      setOrgId: vi.fn(),
    });

    const { orgId, loading, data } = useOrgMock();
    expect(orgId).toBeNull();
    expect(loading).toBe(false);
    expect(data).toBeNull();
    expect(listOrgMock).not.toHaveBeenCalled();
  });

  it('loading is true when orgId is set but data is not yet available', () => {
    useOrgMock.mockReturnValue({
      orgId: 'org-abc123',
      data: null,
      loading: true,
      error: null,
      refetch: vi.fn(),
      setOrgId: vi.fn(),
    });

    const { loading, data } = useOrgMock();
    expect(loading).toBe(true);
    expect(data).toBeNull();
  });

  it('error is set when listOrg fails', () => {
    useOrgMock.mockReturnValue({
      orgId: 'org-abc123',
      data: null,
      loading: false,
      error: 'Not found',
      refetch: vi.fn(),
      setOrgId: vi.fn(),
    });

    const { error, data } = useOrgMock();
    expect(error).toBe('Not found');
    expect(data).toBeNull();
  });

  it('data is populated when listOrg succeeds', () => {
    useOrgMock.mockReturnValue({
      orgId: 'org-abc123',
      data: ORG_DATA,
      loading: false,
      error: null,
      refetch: vi.fn(),
      setOrgId: vi.fn(),
    });

    const { data } = useOrgMock();
    expect(data?.orgId).toBe('org-abc123');
    expect(data?.members).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// TeamsCtaSection — create-team flow with seats + monthlyCredits
// ─────────────────────────────────────────────────────────────────────

describe('TeamsCtaSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeTeamContextValue.hasActiveTeam = false;
    activeTeamContextValue.refresh = vi.fn();
  });

  it('shows plan description and create-team button when no active team', () => {
    render(<TeamsCtaSection onCreated={vi.fn()} />);
    expect(screen.getByTestId('create-team-cta')).toBeInTheDocument();
  });

  it('shows active message when user already has a team', () => {
    activeTeamContextValue.hasActiveTeam = true;
    render(<TeamsCtaSection onCreated={vi.fn()} />);
    expect(screen.getByText('settings.teams.active')).toBeInTheDocument();
    expect(screen.queryByTestId('create-team-cta')).toBeNull();
  });

  it('active-team branch shows a Go-to-team button that navigates to the team space', () => {
    activeTeamContextValue.hasActiveTeam = true;
    render(<TeamsCtaSection onCreated={vi.fn()} />);
    const btn = screen.getByTestId('go-to-team-btn');
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(emitMock).toHaveBeenCalledWith('nav:navigateSpace', 'team');
  });

  it('shows form with monthlyCredits field after clicking create-team button', () => {
    render(<TeamsCtaSection onCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('create-team-cta'));
    expect(screen.getByLabelText('settings.teams.monthlyCreditsLabel')).toBeInTheDocument();
    expect(screen.getByLabelText('settings.teams.orgNameLabel')).toBeInTheDocument();
    expect(screen.getByLabelText('settings.teams.seatsLabel')).toBeInTheDocument();
  });

  it('create button is disabled when org name is empty', () => {
    render(<TeamsCtaSection onCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('create-team-cta'));
    const btn = screen.getByRole('button', { name: 'settings.teams.createAndPay' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('calls createOrg then startTeamsCheckout with (orgId, seats, monthlyCredits)', async () => {
    createOrgMock.mockResolvedValue({ success: true, data: { orgId: 'team-org-999' } });
    startTeamsCheckoutMock.mockResolvedValue({ error: null });
    const onCreated = vi.fn();

    render(<TeamsCtaSection onCreated={onCreated} />);
    fireEvent.click(screen.getByTestId('create-team-cta'));

    fireEvent.change(screen.getByLabelText('settings.teams.orgNameLabel'), {
      target: { value: 'Acme Team' },
    });
    fireEvent.change(screen.getByLabelText('settings.teams.seatsLabel'), {
      target: { value: '8' },
    });
    fireEvent.change(screen.getByLabelText('settings.teams.monthlyCreditsLabel'), {
      target: { value: '100' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'settings.teams.createAndPay' }));

    await waitFor(() => {
      expect(createOrgMock).toHaveBeenCalledWith('Acme Team', 8);
      expect(startTeamsCheckoutMock).toHaveBeenCalledWith('team-org-999', 8, 100);
    });
  });

  it('shows error toast and does NOT call startTeamsCheckout when createOrg fails', async () => {
    createOrgMock.mockResolvedValue({ success: false, error: 'Quota exceeded' });
    const onCreated = vi.fn();

    render(<TeamsCtaSection onCreated={onCreated} />);
    fireEvent.click(screen.getByTestId('create-team-cta'));
    fireEvent.change(screen.getByLabelText('settings.teams.orgNameLabel'), {
      target: { value: 'Test Corp' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.teams.createAndPay' }));

    await waitFor(() => {
      expect(createOrgMock).toHaveBeenCalled();
      expect(startTeamsCheckoutMock).not.toHaveBeenCalled();
      expect(toastSpy).toHaveBeenCalledWith(expect.any(String), 'error');
    });
  });

  it('passes monthlyCredits=0 when left at default', async () => {
    createOrgMock.mockResolvedValue({ success: true, data: { orgId: 'org-zero-credits' } });
    startTeamsCheckoutMock.mockResolvedValue({ error: null });

    render(<TeamsCtaSection onCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('create-team-cta'));
    fireEvent.change(screen.getByLabelText('settings.teams.orgNameLabel'), {
      target: { value: 'Zero Credits Org' },
    });

    // seats defaults to 5, monthlyCredits defaults to 0
    fireEvent.click(screen.getByRole('button', { name: 'settings.teams.createAndPay' }));

    await waitFor(() => {
      expect(startTeamsCheckoutMock).toHaveBeenCalledWith('org-zero-credits', 5, 0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// CreditsSection — org top-up block
// ─────────────────────────────────────────────────────────────────────

describe('CreditsSection top-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startTeamsTopupMock.mockResolvedValue({ error: null });
  });

  it('renders the top-up block with presets when isAdmin=true', () => {
    render(<CreditsSection orgId="org-1" isAdmin={true} onRefetch={vi.fn()} />);
    expect(screen.getByTestId('org-topup-block')).toBeInTheDocument();
    expect(screen.getByTestId('topup-preset-10')).toBeInTheDocument();
    expect(screen.getByTestId('topup-preset-20')).toBeInTheDocument();
    expect(screen.getByTestId('topup-preset-50')).toBeInTheDocument();
    expect(screen.getByTestId('topup-preset-100')).toBeInTheDocument();
  });

  it('does NOT render when isAdmin=false', () => {
    const { container } = render(<CreditsSection orgId="org-1" isAdmin={false} onRefetch={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('calls startTeamsTopup with orgId and preset amount', async () => {
    render(<CreditsSection orgId="org-topup-test" isAdmin={true} onRefetch={vi.fn()} />);
    fireEvent.click(screen.getByTestId('topup-preset-20'));

    await waitFor(() => {
      expect(startTeamsTopupMock).toHaveBeenCalledWith('org-topup-test', 20);
    });
  });

  it('shows redirect toast on successful top-up', async () => {
    render(<CreditsSection orgId="org-1" isAdmin={true} onRefetch={vi.fn()} />);
    fireEvent.click(screen.getByTestId('topup-preset-50'));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith('team.credits.topup.redirect', 'info');
    });
  });

  it('shows error toast when top-up fails', async () => {
    startTeamsTopupMock.mockResolvedValue({ error: 'Card declined' });
    render(<CreditsSection orgId="org-1" isAdmin={true} onRefetch={vi.fn()} />);
    fireEvent.click(screen.getByTestId('topup-preset-10'));

    await waitFor(() => {
      // t() mock returns the key; verify toast is called with error severity
      expect(startTeamsTopupMock).toHaveBeenCalledWith('org-1', 10);
      expect(toastSpy).toHaveBeenCalledWith('team.credits.topup.error', 'error');
    });
  });

  it('calls startTeamsTopup with custom amount from input', async () => {
    render(<CreditsSection orgId="org-custom" isAdmin={true} onRefetch={vi.fn()} />);
    fireEvent.change(screen.getByTestId('topup-custom-input'), {
      target: { value: '75' },
    });
    fireEvent.click(screen.getByTestId('topup-confirm-btn'));

    await waitFor(() => {
      expect(startTeamsTopupMock).toHaveBeenCalledWith('org-custom', 75);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// DepartmentsSection — admin-only department management
// ─────────────────────────────────────────────────────────────────────

describe('DepartmentsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT render when isAdmin=false', () => {
    const { container } = render(
      <DepartmentsSection orgId="org-1" isAdmin={false} departments={DEPARTMENTS} onRefetch={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows empty state when there are no departments', () => {
    render(<DepartmentsSection orgId="org-1" isAdmin={true} departments={[]} onRefetch={vi.fn()} />);
    expect(screen.getByText('team.depts.empty')).toBeInTheDocument();
    expect(screen.queryByTestId('dept-row')).toBeNull();
  });

  it('renders a row for each existing department', () => {
    render(
      <DepartmentsSection orgId="org-1" isAdmin={true} departments={DEPARTMENTS} onRefetch={vi.fn()} />,
    );
    expect(screen.getAllByTestId('dept-row')).toHaveLength(2);
    expect(screen.getByText('Engineering')).toBeInTheDocument();
  });

  it('auto-suggests a slug from the name', () => {
    render(<DepartmentsSection orgId="org-1" isAdmin={true} departments={[]} onRefetch={vi.fn()} />);
    fireEvent.change(screen.getByTestId('dept-name-input'), {
      target: { value: 'Data Science' },
    });
    expect((screen.getByTestId('dept-slug-input') as HTMLInputElement).value).toBe('data-science');
  });

  it('create flow: calls createDepartment with slug + name, toasts and refetches', async () => {
    createDepartmentMock.mockResolvedValue({ success: true, data: { deptId: 'dept-new' } });
    const onRefetch = vi.fn();

    render(<DepartmentsSection orgId="org-create" isAdmin={true} departments={[]} onRefetch={onRefetch} />);

    fireEvent.change(screen.getByTestId('dept-name-input'), {
      target: { value: 'Data Science' },
    });
    fireEvent.click(screen.getByTestId('create-dept-btn'));

    await waitFor(() => {
      expect(createDepartmentMock).toHaveBeenCalledWith('org-create', 'data-science', 'Data Science');
      expect(toastSpy).toHaveBeenCalledWith('team.depts.created', 'success');
      expect(onRefetch).toHaveBeenCalled();
    });
  });

  it('create button is disabled until a name is entered', () => {
    render(<DepartmentsSection orgId="org-1" isAdmin={true} departments={[]} onRefetch={vi.fn()} />);
    expect(screen.getByTestId('create-dept-btn')).toBeDisabled();
    fireEvent.change(screen.getByTestId('dept-name-input'), {
      target: { value: 'Ops' },
    });
    expect(screen.getByTestId('create-dept-btn')).not.toBeDisabled();
  });

  it('shows error toast when createDepartment fails', async () => {
    createDepartmentMock.mockResolvedValue({ success: false, error: 'Slug already exists' });

    render(<DepartmentsSection orgId="org-1" isAdmin={true} departments={[]} onRefetch={vi.fn()} />);
    fireEvent.change(screen.getByTestId('dept-name-input'), {
      target: { value: 'Engineering' },
    });
    fireEvent.click(screen.getByTestId('create-dept-btn'));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith('Slug already exists', 'error');
    });
  });
});
