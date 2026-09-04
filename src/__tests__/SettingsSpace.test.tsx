/**
 * SettingsSpace.test.tsx
 *
 * Regression test for a P3 + product-gap finding: the Teams CTA
 * (components/team/TeamsCtaSection) was commented out of the Account tab,
 * leaving non-team users with no Settings entry point to start a team (the
 * dedicated "Team" nav tab only exists once teamsActive() is already true —
 * see AppShell.tsx's showTeamTab). Re-enabled, gated on teamsActive() being
 * false so a user already on an active/trialing org isn't shown a
 * "create a team" CTA for one they already have.
 *
 * Heavy/unrelated AccountTab dependencies (auth, billing, toast, the Teams
 * CTA's own internals) are mocked out — this file only asserts SettingsSpace's
 * OWN gating decision, not TeamsCtaSection's internals (covered by
 * team-ui.test.tsx) or useSubscriptionContext/useAuth's own behavior.
 *
 * BUG-3: AccountTab reads useSubscriptionContext() (the shared, app-root
 * subscription state) instead of running its own independent
 * useSubscription(user) fetch — two sources of truth was the root cause of
 * the header credits badge staying stale relative to the Compte page. The
 * billing mock below exports useSubscriptionContext to match; a lingering
 * useSubscription export would silently no-op if AccountTab regressed back
 * to calling it, so the "no second fetch" describe block below asserts the
 * real export is never called.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// ── i18n mock — returns the key, so assertions are locale-agnostic ─────

vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  }),
}));

// ── auth mock — always a signed-in user (AccountTab's !user branch,
// AuthScreen, is a separate concern not under test here) ────────────────

const mockUser = { id: 'user-1', email: 'david@example.com' };

vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: mockUser, loading: false, signOut: vi.fn() }),
}));

// ── billing mock — Free plan, no subscription (isPro branch is a separate
// concern, already covered elsewhere; irrelevant to the CTA's gating).
// useSubscription is mocked to a spy that must NEVER be called by AccountTab
// (BUG-3 regression guard — see the top-of-file note and the describe block
// below) — only useSubscriptionContext should be read. ─────────────────

// vi.hoisted: vi.mock factories are hoisted above module-level consts, so a
// plain `const mockUseSubscription = vi.fn()` referenced inside the factory
// below would throw "Cannot access before initialization".
const { mockUseSubscription } = vi.hoisted(() => ({ mockUseSubscription: vi.fn() }));

vi.mock('../lib/billing', () => ({
  useSubscription: mockUseSubscription,
  useSubscriptionContext: () => ({
    subscription: null,
    loading: false,
    isPro: false,
    isProPlus: false,
    hasManagedCredits: false,
    refresh: vi.fn(),
  }),
  startProCheckout: vi.fn(async () => ({ error: null })),
  startTopup: vi.fn(async () => ({ error: null })),
  openBillingPortal: vi.fn(async () => ({ error: null })),
  isLowCredit: vi.fn(() => false),
  isOutOfCredits: vi.fn(() => false),
  formatCredits: vi.fn((cents: number) => `${cents}`),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// ── ActiveTeamContext mock — the CTA's gating input, mutated per test ───

const activeTeamState = { hasActiveTeam: false, refresh: vi.fn() };

vi.mock('../lib/teams/ActiveTeamContext', () => ({
  useActiveTeamContext: () => activeTeamState,
}));

// Real '../lib/features' (teamsActive) runs unmocked: it just ORs
// activeTeamState.hasActiveTeam with a dev-only override that stays false
// here since VITE_TEAMS_ENABLED isn't set in the test env — so exercising
// the real function is both simpler and more faithful than re-mocking it.

// ── TeamsCtaSection mock — its own internals (org creation, checkout) are
// covered by team-ui.test.tsx; this file only cares whether SettingsSpace
// decides to render it at all. ──────────────────────────────────────────

vi.mock('../components/team/TeamsCtaSection', () => ({
  TeamsCtaSection: ({ onCreated }: { onCreated: () => void }) => (
    <button data-testid="teams-cta-stub" onClick={onCreated}>
      teams-cta-stub
    </button>
  ),
}));

import { SettingsSpace } from '../spaces/SettingsSpace';

describe('SettingsSpace — Account tab reads the shared subscription context (BUG-3)', () => {
  beforeEach(() => {
    activeTeamState.hasActiveTeam = false;
    mockUseSubscription.mockClear();
  });

  it('never calls useSubscription(user) directly — only useSubscriptionContext, avoiding a second independent fetch', () => {
    render(<SettingsSpace initialTab="account" />);

    expect(mockUseSubscription).not.toHaveBeenCalled();
  });
});

describe('SettingsSpace — Account tab Teams CTA (live)', () => {
  beforeEach(() => {
    activeTeamState.hasActiveTeam = false;
  });

  it('renders the Teams CTA for a user with no active org (the Settings entry point to start a team)', () => {
    render(<SettingsSpace initialTab="account" />);

    expect(screen.getByTestId('teams-cta-stub')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-agents')).toBeInTheDocument();
  });

  it('hides the Teams CTA once the user has an active org (they already have a team)', () => {
    activeTeamState.hasActiveTeam = true;
    render(<SettingsSpace initialTab="account" />);

    expect(screen.queryByTestId('teams-cta-stub')).toBeNull();
  });
});
