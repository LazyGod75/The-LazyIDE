/**
 * GeneralTabSections.test.tsx
 *
 * Regression test for the Settings > General tab reorganization
 * (SettingsSpace.tsx's GeneralTab / <SettingsSection>): the tab used to be
 * a flat list of 9 unrelated settings in identical cards with no grouping
 * at all (automatic memory injection, token-savings indicator, dual-judge
 * verification, agent notifications, language, re-run onboarding, report
 * app version, automatic updates, automatically install updates). Fixed by
 * grouping them into five labelled sections (Brain, Agents, Preferences,
 * Privacy, Updates) — this test asserts the five section labels render AND
 * that every one of the original 9 settings is still present and
 * reachable (organisation, not removal — nothing was dropped in the
 * regrouping).
 *
 * Mocking follows the same pattern as UpdateSection.test.tsx (i18n
 * passthrough, updateStore, agentsStore) since GeneralTab renders
 * UpdateSection and TelemetrySection as part of its own Updates/Privacy
 * sections.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../i18n', () => {
  const context = {
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})` : key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [{ code: 'en', label: 'English', flag: '' }],
  };
  return {
    useI18n: () => context,
    // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
    useI18nOptional: () => context,
  };
});

vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'david@example.com' }, loading: false, signOut: vi.fn() }),
}));

vi.mock('../lib/billing', () => ({
  useSubscriptionContext: () => ({
    subscription: null, loading: false, isPro: false, isProPlus: false, hasManagedCredits: false, refresh: vi.fn(),
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

const { mockUseUpdateStore } = vi.hoisted(() => ({ mockUseUpdateStore: vi.fn() }));
vi.mock('../lib/updateStore', () => ({
  useUpdateStore: mockUseUpdateStore,
}));

vi.mock('../components/agents/agentsStore', () => ({
  useAgentsStoreOptional: vi.fn(() => null),
}));

import { SettingsSpace } from '../spaces/SettingsSpace';

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockUseUpdateStore.mockReturnValue({
    phase: 'idle',
    lastCheckAt: null,
    lastError: null,
    ignoredVersion: null,
    errorStreak: 0,
    autoUpdate: true,
    check: vi.fn(),
    download: vi.fn(),
    restartAndApply: vi.fn(),
    setAuto: vi.fn(),
    ignoreVersion: vi.fn(),
  });
});

function renderGeneralTab() {
  return render(<SettingsSpace initialTab="general" />);
}

describe('GeneralTab — grouped into labelled sections', () => {
  it('renders all five section labels', () => {
    renderGeneralTab();

    expect(screen.getByText('settings.section.brain')).toBeInTheDocument();
    expect(screen.getByText('settings.section.agents')).toBeInTheDocument();
    expect(screen.getByText('settings.section.preferences')).toBeInTheDocument();
    expect(screen.getByText('settings.section.privacy')).toBeInTheDocument();
    expect(screen.getByText('settings.section.updates')).toBeInTheDocument();
  });

  it('keeps every one of the original 9 settings present (organisation, not removal)', () => {
    renderGeneralTab();

    // Brain
    expect(screen.getByText('settings.general.autoMemory')).toBeInTheDocument();
    expect(screen.getByText('settings.general.tokenSaverBadge')).toBeInTheDocument();
    // Agents
    expect(screen.getByText('settings.general.dualJudge')).toBeInTheDocument();
    expect(screen.getByText('settings.general.agentNotifications')).toBeInTheDocument();
    // Preferences
    expect(screen.getByText('settings.language')).toBeInTheDocument();
    expect(screen.getByText('settings.rerunOnboarding')).toBeInTheDocument();
    expect(screen.getByText('settings.rerunOnboarding.action')).toBeInTheDocument();
    // Privacy
    expect(screen.getByText('settings.general.versionTelemetry')).toBeInTheDocument();
    // Updates (UpdateSection's own two cards)
    expect(screen.getByText('settings.update.title')).toBeInTheDocument();
    expect(screen.getByText('settings.update.autoUpdateLabel')).toBeInTheDocument();
  });
});
