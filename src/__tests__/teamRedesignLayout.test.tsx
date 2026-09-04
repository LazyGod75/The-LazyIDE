/**
 * teamRedesignLayout.test.tsx — W-UX3 finding D regression ("La page Team
 * est bug"): LeadBudgetPanel/MemberView used `flex: 1; minHeight: 0` (a
 * fixed-height dashboard layout) inside the Team space's SCROLLING column,
 * so the flex algorithm squeezed them to the leftover viewport space and
 * their unclipped content painted OVER the sections below (David's own
 * capture: invitations inside the budget card, « Gérer les sièges »
 * colliding with the Brain section title).
 *
 * jsdom has no layout engine, so the honest regression pin here is the
 * STYLE CONTRACT that caused the overlap: a scroll-column section must be
 * natural-height and non-shrinking (`flexShrink: 0`, never `flex: 1` /
 * `minHeight: 0` on the section root). The visual half of the proof is the
 * real-exe capture (see the W-UX3 report).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en', setLocale: vi.fn(), LOCALES: [] }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({ t: (key: string) => key, locale: 'en', setLocale: vi.fn(), LOCALES: [] }),
}));

const toastSpy = vi.fn();
vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../lib/billing', () => ({
  formatCredits: (cents: number) => String(cents),
  startTeamsTopup: vi.fn(),
  openOrgBillingPortal: vi.fn(),
}));

vi.mock('../lib/teams/orgApi', () => ({
  setAllocation: vi.fn(),
}));

import { LeadBudgetPanel } from '../components/team/redesign/LeadBudgetPanel';

describe('LeadBudgetPanel — scroll-column layout contract (W-UX3 finding D)', () => {
  it('the panel root is natural-height and non-shrinking (never flex:1/minHeight:0 in the scrolling Team column)', () => {
    render(
      <LeadBudgetPanel
        orgId="org-1"
        creditsRemainingCents={1000}
        lastMonthlyGrantCents={2000}
        allocations={[]}
        departments={[]}
        members={[]}
        deptUsedCents={new Map()}
        onRefetch={vi.fn()}
      />,
    );
    const root = screen.getByTestId('lead-budget-panel');
    expect(root.style.flexShrink).toBe('0');
    // The exact declarations that squeezed the panel to ~0 height inside
    // the scroll container — must never come back. (`style.flex` is a
    // shorthand that reflects the flexShrink longhand in jsdom, so the
    // growth half is asserted via flexGrow specifically.)
    expect(root.style.flexGrow).toBe('');
    expect(root.style.minHeight).toBe('');
  });
});
