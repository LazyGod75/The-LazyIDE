/**
 * team-credits.test.tsx
 *
 * Tests for the credit allocation UI (phase 0):
 *   - AllocationList: display existing allocations, empty state, edit/remove callbacks
 *   - AllocationForm: credits amount (D4: no euro conversion), submit disabled when invalid
 *   - CreditsSection: admin-only gate, full mutation flow, error state, loading state
 *   - useAllocations: loading/error/data state machine via orgApi mock
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// ── i18n mock ─────────────────────────────────────────────────────

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

// ── Toast mock ────────────────────────────────────────────────────

const toastSpy = vi.fn();
vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ── orgApi mock ───────────────────────────────────────────────────

const listOrgMock = vi.fn();
const setAllocationMock = vi.fn();

vi.mock('../lib/teams/orgApi', () => ({
  listOrg: (...args: unknown[]) => listOrgMock(...args),
  setAllocation: (...args: unknown[]) => setAllocationMock(...args),
  createOrg: vi.fn(),
  acceptInvite: vi.fn(),
  inviteMember: vi.fn(),
  revokeInvite: vi.fn(),
  removeMember: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────

import { AllocationList } from '../components/team/AllocationList';
import { AllocationForm } from '../components/team/AllocationForm';
import { CreditsSection } from '../components/team/CreditsSection';
import type { OrgAllocation, OrgMember, OrgData } from '../lib/teams/types';

// ── Fixtures ──────────────────────────────────────────────────────

const MEMBER_ALICE: OrgMember = {
  user_id: 'user-alice',
  role: 'org-admin',
  dept_id: null,
  added_at: '2025-01-01T00:00:00Z',
  display_name: 'Alice Admin',
  email: 'alice@example.com',
};

const MEMBER_BOB: OrgMember = {
  user_id: 'user-bob',
  role: 'member',
  dept_id: 'engineering',
  added_at: '2025-01-02T00:00:00Z',
  display_name: 'Bob Member',
};

const ALLOC_MEMBER: OrgAllocation = {
  id: 'alloc-1',
  entity_type: 'member',
  entity_id: 'user-bob',
  limit_cents: 5000,
  period: 'month',
  created_at: '2025-01-01T00:00:00Z',
};

const ALLOC_DEPT: OrgAllocation = {
  id: 'alloc-2',
  entity_type: 'dept',
  entity_id: 'engineering',
  limit_cents: 20000,
  period: 'month',
  created_at: '2025-01-01T00:00:00Z',
};

const ORG_DATA: OrgData = {
  orgId: 'org-test',
  name: 'Test Org',
  seats: 5,
  members: [MEMBER_ALICE, MEMBER_BOB],
  invitations: [],
  allocations: [ALLOC_MEMBER, ALLOC_DEPT],
  departments: [],
  creditsRemainingCents: 100000,
  lastMonthlyGrantCents: 100000,
  ownerUserId: 'user-alice',
  brainRepoUrl: null,
  brainRepoHtmlUrl: null,
  brainSeededAt: null,
  brainSeedMode: null,
};

// ─────────────────────────────────────────────────────────────────
// AllocationList
// ─────────────────────────────────────────────────────────────────

describe('AllocationList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty state when no allocations', () => {
    render(
      <AllocationList
        allocations={[]}
        members={[]}
        loading={false}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByTestId('allocations-empty')).toBeInTheDocument();
  });

  it('renders a row for each allocation', () => {
    render(
      <AllocationList
        allocations={[ALLOC_MEMBER, ALLOC_DEPT]}
        members={[MEMBER_ALICE, MEMBER_BOB]}
        loading={false}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByTestId('allocation-row-alloc-1')).toBeInTheDocument();
    expect(screen.getByTestId('allocation-row-alloc-2')).toBeInTheDocument();
  });

  it('resolves member display name from members list', () => {
    render(
      <AllocationList
        allocations={[ALLOC_MEMBER]}
        members={[MEMBER_ALICE, MEMBER_BOB]}
        loading={false}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText('Bob Member')).toBeInTheDocument();
  });

  it('calls onEdit with the correct allocation when Edit is clicked', () => {
    const onEdit = vi.fn();
    render(
      <AllocationList
        allocations={[ALLOC_MEMBER]}
        members={[MEMBER_BOB]}
        loading={false}
        onEdit={onEdit}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('edit-allocation-alloc-1'));
    expect(onEdit).toHaveBeenCalledWith(ALLOC_MEMBER);
  });

  it('calls onRemove with the correct allocation when Remove is clicked', () => {
    const onRemove = vi.fn();
    render(
      <AllocationList
        allocations={[ALLOC_MEMBER]}
        members={[MEMBER_BOB]}
        loading={false}
        onEdit={vi.fn()}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByTestId('remove-allocation-alloc-1'));
    expect(onRemove).toHaveBeenCalledWith(ALLOC_MEMBER);
  });
});

// ─────────────────────────────────────────────────────────────────
// AllocationForm
// ─────────────────────────────────────────────────────────────────

describe('AllocationForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submit button is disabled when no entity is selected', () => {
    render(
      <AllocationForm
        members={[MEMBER_BOB]}
        onSubmit={vi.fn()}
      />,
    );
    const btn = screen.getByTestId('alloc-submit-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('submit button is disabled when amount is empty', () => {
    render(
      <AllocationForm
        members={[MEMBER_BOB]}
        onSubmit={vi.fn()}
      />,
    );
    // Select a member but leave amount empty
    fireEvent.change(screen.getByTestId('alloc-entity-select'), {
      target: { value: 'user-bob' },
    });
    const btn = screen.getByTestId('alloc-submit-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('submits the credits amount directly (D4: credits, not euros — no *100 conversion)', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ success: true });
    render(
      <AllocationForm
        members={[MEMBER_BOB]}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByTestId('alloc-entity-select'), {
      target: { value: 'user-bob' },
    });
    fireEvent.change(screen.getByTestId('alloc-amount-input'), {
      target: { value: '50' },
    });
    fireEvent.click(screen.getByTestId('alloc-submit-btn'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('member', 'user-bob', 50, 'month');
    });
  });

  it('rounds a fractional credits amount to the nearest whole credit', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ success: true });
    render(
      <AllocationForm
        members={[MEMBER_BOB]}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByTestId('alloc-entity-select'), {
      target: { value: 'user-bob' },
    });
    fireEvent.change(screen.getByTestId('alloc-amount-input'), {
      target: { value: '12.6' },
    });
    fireEvent.click(screen.getByTestId('alloc-submit-btn'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('member', 'user-bob', 13, 'month');
    });
  });

  it('switches to dept type and uses text input for entity ID', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ success: true });
    render(
      <AllocationForm
        members={[MEMBER_BOB]}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByTestId('entity-type-dept'));
    expect(screen.getByTestId('alloc-entity-input')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('alloc-entity-input'), {
      target: { value: 'engineering' },
    });
    fireEvent.change(screen.getByTestId('alloc-amount-input'), {
      target: { value: '200' },
    });
    fireEvent.click(screen.getByTestId('alloc-submit-btn'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('dept', 'engineering', 200, 'month');
    });
  });

  it('pre-populates fields when initial allocation is provided', () => {
    render(
      <AllocationForm
        members={[MEMBER_BOB]}
        initial={ALLOC_MEMBER}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const amountInput = screen.getByTestId('alloc-amount-input') as HTMLInputElement;
    expect(amountInput.value).toBe('5000');
  });

  it('shows inline error when onSubmit returns failure', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ success: false, error: 'Quota exceeded' });
    render(
      <AllocationForm
        members={[MEMBER_BOB]}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByTestId('alloc-entity-select'), {
      target: { value: 'user-bob' },
    });
    fireEvent.change(screen.getByTestId('alloc-amount-input'), {
      target: { value: '50' },
    });
    fireEvent.click(screen.getByTestId('alloc-submit-btn'));

    await waitFor(() => {
      expect(screen.getByText('Quota exceeded')).toBeInTheDocument();
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// CreditsSection
// ─────────────────────────────────────────────────────────────────

describe('CreditsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when isAdmin is false', () => {
    listOrgMock.mockResolvedValue({ success: true, data: ORG_DATA });
    const { container } = render(
      <CreditsSection orgId="org-test" isAdmin={false} onRefetch={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the section when isAdmin is true', async () => {
    listOrgMock.mockResolvedValue({ success: true, data: ORG_DATA });
    render(<CreditsSection orgId="org-test" isAdmin={true} onRefetch={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('credits-section')).toBeInTheDocument();
    });
  });

  it('shows existing allocations when loaded', async () => {
    listOrgMock.mockResolvedValue({ success: true, data: ORG_DATA });
    render(<CreditsSection orgId="org-test" isAdmin={true} onRefetch={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('allocation-row-alloc-1')).toBeInTheDocument();
      expect(screen.getByTestId('allocation-row-alloc-2')).toBeInTheDocument();
    });
  });

  it('shows empty state when org has no allocations', async () => {
    listOrgMock.mockResolvedValue({
      success: true,
      data: { ...ORG_DATA, allocations: [] },
    });
    render(<CreditsSection orgId="org-test" isAdmin={true} onRefetch={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('allocations-empty')).toBeInTheDocument();
    });
  });

  it('calls org-set-allocation with the credits amount directly (D4: no euro conversion)', async () => {
    listOrgMock.mockResolvedValue({
      success: true,
      data: { ...ORG_DATA, allocations: [] },
    });
    setAllocationMock.mockResolvedValue({ success: true, data: { ok: true } });

    render(<CreditsSection orgId="org-test" isAdmin={true} onRefetch={vi.fn()} />);

    // Open form
    await waitFor(() => screen.getByTestId('open-alloc-form-btn'));
    fireEvent.click(screen.getByTestId('open-alloc-form-btn'));

    // Fill form: select member, enter 75 credits, keep month period (default)
    await waitFor(() => screen.getByTestId('alloc-entity-select'));
    fireEvent.change(screen.getByTestId('alloc-entity-select'), {
      target: { value: 'user-bob' },
    });
    fireEvent.change(screen.getByTestId('alloc-amount-input'), {
      target: { value: '75' },
    });
    fireEvent.click(screen.getByTestId('alloc-submit-btn'));

    await waitFor(() => {
      expect(setAllocationMock).toHaveBeenCalledWith(
        'org-test',
        'member',
        'user-bob',
        75,
        'month',
      );
    });
  });

  it('calls org-set-allocation with limitCents = 0 when removing an allocation', async () => {
    listOrgMock.mockResolvedValue({ success: true, data: ORG_DATA });
    setAllocationMock.mockResolvedValue({ success: true, data: { ok: true } });
    const onRefetch = vi.fn();

    render(<CreditsSection orgId="org-test" isAdmin={true} onRefetch={onRefetch} />);

    await waitFor(() => screen.getByTestId('remove-allocation-alloc-1'));
    fireEvent.click(screen.getByTestId('remove-allocation-alloc-1'));

    await waitFor(() => {
      expect(setAllocationMock).toHaveBeenCalledWith(
        'org-test',
        'member',
        'user-bob',
        0,
        'month',
      );
    });
  });

  it('shows a success toast after setting a budget', async () => {
    listOrgMock.mockResolvedValue({
      success: true,
      data: { ...ORG_DATA, allocations: [] },
    });
    setAllocationMock.mockResolvedValue({ success: true, data: { ok: true } });

    render(<CreditsSection orgId="org-test" isAdmin={true} onRefetch={vi.fn()} />);

    await waitFor(() => screen.getByTestId('open-alloc-form-btn'));
    fireEvent.click(screen.getByTestId('open-alloc-form-btn'));

    await waitFor(() => screen.getByTestId('alloc-entity-select'));
    fireEvent.change(screen.getByTestId('alloc-entity-select'), {
      target: { value: 'user-bob' },
    });
    fireEvent.change(screen.getByTestId('alloc-amount-input'), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByTestId('alloc-submit-btn'));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith('team.credits.setSuccess', 'success');
    });
  });

  it('shows an error toast when setting a budget fails', async () => {
    listOrgMock.mockResolvedValue({
      success: true,
      data: { ...ORG_DATA, allocations: [] },
    });
    setAllocationMock.mockResolvedValue({ success: false, error: 'Insufficient credits' });

    render(<CreditsSection orgId="org-test" isAdmin={true} onRefetch={vi.fn()} />);

    await waitFor(() => screen.getByTestId('open-alloc-form-btn'));
    fireEvent.click(screen.getByTestId('open-alloc-form-btn'));

    await waitFor(() => screen.getByTestId('alloc-entity-select'));
    fireEvent.change(screen.getByTestId('alloc-entity-select'), {
      target: { value: 'user-bob' },
    });
    fireEvent.change(screen.getByTestId('alloc-amount-input'), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByTestId('alloc-submit-btn'));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith('Insufficient credits', 'error');
    });
  });

  it('shows error state when listOrg fails', async () => {
    listOrgMock.mockResolvedValue({ success: false, error: 'Not authorized' });

    render(<CreditsSection orgId="org-test" isAdmin={true} onRefetch={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Not authorized')).toBeInTheDocument();
    });
  });

  it('opens the form when Edit is clicked on an existing allocation', async () => {
    listOrgMock.mockResolvedValue({ success: true, data: ORG_DATA });

    render(<CreditsSection orgId="org-test" isAdmin={true} onRefetch={vi.fn()} />);

    await waitFor(() => screen.getByTestId('edit-allocation-alloc-1'));
    fireEvent.click(screen.getByTestId('edit-allocation-alloc-1'));

    // Form should be visible with pre-populated amount (5000 credits for ALLOC_MEMBER)
    await waitFor(() => {
      const amountInput = screen.getByTestId('alloc-amount-input') as HTMLInputElement;
      expect(amountInput.value).toBe('5000');
    });
  });

  it('calls onRefetch from parent after a successful mutation', async () => {
    listOrgMock.mockResolvedValue({ success: true, data: ORG_DATA });
    setAllocationMock.mockResolvedValue({ success: true, data: { ok: true } });
    const onRefetch = vi.fn();

    render(<CreditsSection orgId="org-test" isAdmin={true} onRefetch={onRefetch} />);

    await waitFor(() => screen.getByTestId('remove-allocation-alloc-1'));
    fireEvent.click(screen.getByTestId('remove-allocation-alloc-1'));

    await waitFor(() => {
      expect(onRefetch).toHaveBeenCalled();
    });
  });
});
