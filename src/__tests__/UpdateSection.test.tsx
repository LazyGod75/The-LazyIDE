/**
 * UpdateSection.test.tsx
 *
 * AUTOUPDATE-SPEC.md B.5 — SettingsSpace's UpdateSection (General tab),
 * rewritten against the shared src/lib/updateStore.ts store: every real
 * phase (up-to-date/available/downloading/staged/error), the autoUpdate
 * toggle, and the agents-running confirmation gate in front of
 * restartAndApply() (no window.confirm — see RestartConfirmPanel in
 * SettingsSpace.tsx).
 *
 * i18n is mocked as a passthrough that also renders interpolated params
 * (`key(k=v,...)`) so assertions can pin exact key+params without depending
 * on any one locale's copy — same technique already used by
 * newMissionPreflight.test.tsx / BrainWiki.test.tsx for this codebase's t().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

vi.mock('../i18n', () => {
  const context = {
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})` : key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
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

// Narrower than the real useAgentsStoreOptional()'s AgentsStoreValue |
// null — SettingsSpace's useRunningAgentCount only ever reads
// store.missions[].status, so the mock only needs to honestly shape that.
const { mockUseAgentsStoreOptional } = vi.hoisted(() => ({
  mockUseAgentsStoreOptional: vi.fn<() => { missions: Mission[] } | null>(() => null),
}));
vi.mock('../components/agents/agentsStore', () => ({
  useAgentsStoreOptional: mockUseAgentsStoreOptional,
}));

import { SettingsSpace } from '../spaces/SettingsSpace';
import type { Mission } from '../lib/agents/types';

afterEach(cleanup);

const mockCheck = vi.fn();
const mockDownload = vi.fn();
const mockRestartAndApply = vi.fn();
const mockSetAuto = vi.fn();

interface StoreOverrides {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'staged' | 'error';
  version?: string;
  notes?: string;
  progress?: { downloaded: number; total: number | null };
  autoUpdate?: boolean;
  lastCheckAt?: string | null;
  lastError?: string | null;
}

function setStore(overrides: StoreOverrides): void {
  mockUseUpdateStore.mockReturnValue({
    autoUpdate: true,
    lastCheckAt: null,
    lastError: null,
    ignoredVersion: null,
    errorStreak: 0,
    ...overrides,
    check: mockCheck,
    download: mockDownload,
    restartAndApply: mockRestartAndApply,
    setAuto: mockSetAuto,
    ignoreVersion: vi.fn(),
  });
}

function renderGeneralTab() {
  return render(<SettingsSpace initialTab="general" />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseAgentsStoreOptional.mockReturnValue(null);
  setStore({ phase: 'idle' });
});

describe('UpdateSection — up-to-date', () => {
  it('shows the up-to-date label and a manual check button', () => {
    renderGeneralTab();
    expect(screen.getByText('settings.update.upToDate')).toBeInTheDocument();

    fireEvent.click(screen.getByText('settings.update.checkButton'));
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });

  it('shows "last checked" instead of "up to date" once a check has happened', () => {
    setStore({ phase: 'idle', lastCheckAt: '2026-07-25T09:00:00.000Z' });
    renderGeneralTab();

    expect(screen.queryByText('settings.update.upToDate')).toBeNull();
    expect(screen.getByText(/settings\.update\.lastChecked\(time=/)).toBeInTheDocument();
  });
});

describe('UpdateSection — available', () => {
  it('shows the Download button and real notes when autoUpdate is off', () => {
    setStore({ phase: 'available', version: '0.1.12', notes: 'Bug fixes', autoUpdate: false });
    renderGeneralTab();

    expect(screen.getByText('settings.update.available(version=0.1.12)')).toBeInTheDocument();
    expect(screen.getByText('settings.update.whatsNew')).toBeInTheDocument();
    expect(screen.getByText('Bug fixes')).toBeInTheDocument();

    fireEvent.click(screen.getByText('settings.update.downloadButton'));
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('hides the Download button when autoUpdate is on (background download takes over)', () => {
    setStore({ phase: 'available', version: '0.1.12', notes: 'Bug fixes', autoUpdate: true });
    renderGeneralTab();

    expect(screen.queryByText('settings.update.downloadButton')).toBeNull();
  });
});

describe('UpdateSection — downloading', () => {
  it('shows the download percentage when total is known', () => {
    setStore({ phase: 'downloading', progress: { downloaded: 50, total: 100 } });
    renderGeneralTab();

    expect(screen.getByText('settings.update.downloadingPct(pct=50)')).toBeInTheDocument();
  });

  it('falls back to the indeterminate label when total is unknown', () => {
    setStore({ phase: 'downloading', progress: { downloaded: 50, total: null } });
    renderGeneralTab();

    expect(screen.getByText('settings.update.downloading')).toBeInTheDocument();
  });
});

describe('UpdateSection — staged + restart gate', () => {
  it('shows the staged title/body and real notes', () => {
    setStore({ phase: 'staged', version: '0.1.12', notes: 'Bug fixes' });
    renderGeneralTab();

    expect(screen.getByText('settings.update.stagedTitle(version=0.1.12)')).toBeInTheDocument();
    expect(screen.getByText('settings.update.stagedBody')).toBeInTheDocument();
    expect(screen.getByText('Bug fixes')).toBeInTheDocument();
  });

  it('restarts immediately when no agents are running', () => {
    setStore({ phase: 'staged', version: '0.1.12' });
    mockUseAgentsStoreOptional.mockReturnValue({ missions: [] });
    renderGeneralTab();

    fireEvent.click(screen.getByText('settings.update.restartNow'));

    expect(mockRestartAndApply).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('shows an explicit confirmation naming the running-agent count instead of calling restartAndApply directly', () => {
    setStore({ phase: 'staged', version: '0.1.12' });
    mockUseAgentsStoreOptional.mockReturnValue({
      missions: [
        { id: 'm1', title: 'a', status: 'running', model: 'sonnet' },
        { id: 'm2', title: 'b', status: 'running', model: 'sonnet' },
        { id: 'm3', title: 'c', status: 'done', model: 'sonnet' },
      ],
    });
    renderGeneralTab();

    fireEvent.click(screen.getByText('settings.update.restartNow'));

    expect(mockRestartAndApply).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('settings.update.agentsRunningWarning(count=2)');
  });

  it('Cancel in the confirmation dismisses it without restarting', () => {
    setStore({ phase: 'staged', version: '0.1.12' });
    mockUseAgentsStoreOptional.mockReturnValue({ missions: [{ id: 'm1', title: 'a', status: 'running', model: 'sonnet' }] });
    renderGeneralTab();

    fireEvent.click(screen.getByText('settings.update.restartNow'));
    fireEvent.click(screen.getByText('common.cancel'));

    expect(mockRestartAndApply).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('confirming in the dialog calls restartAndApply and dismisses it', () => {
    setStore({ phase: 'staged', version: '0.1.12' });
    mockUseAgentsStoreOptional.mockReturnValue({ missions: [{ id: 'm1', title: 'a', status: 'running', model: 'sonnet' }] });
    renderGeneralTab();

    fireEvent.click(screen.getByText('settings.update.restartNow'));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.update.restartNow' }));

    expect(mockRestartAndApply).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('UpdateSection — error', () => {
  it('shows the error message and a Retry button that re-checks', () => {
    setStore({ phase: 'error', lastError: 'network unreachable' });
    renderGeneralTab();

    expect(screen.getByText('settings.update.error(message=network unreachable)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('settings.update.retry'));
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });
});

describe('UpdateSection — autoUpdate toggle', () => {
  it('reflects the current autoUpdate value and flips it on click', () => {
    setStore({ phase: 'idle', autoUpdate: true });
    renderGeneralTab();

    const toggle = screen.getByRole('switch', { name: 'settings.update.autoUpdateLabel' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle);
    expect(mockSetAuto).toHaveBeenCalledWith(false);
  });
});
