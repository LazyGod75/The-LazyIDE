/**
 * TopNav.test.tsx
 *
 * AUTOUPDATE-SPEC.md B.4 — a discrete accent dot on the Settings pill's gear
 * icon when an update is available or staged, ported from SpacesRail.tsx's
 * mission-count badge (SpacesRail itself is no longer mounted, not touched
 * here — see that file's lines 160-181). Also locks in the explicit
 * aria-label the spec requires on the pill while the dot is showing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const { mockUseUpdateStore } = vi.hoisted(() => ({ mockUseUpdateStore: vi.fn() }));
vi.mock('../lib/updateStore', () => ({
  useUpdateStore: mockUseUpdateStore,
}));

vi.mock('../lib/billing', () => ({
  useSubscriptionContext: () => ({ subscription: null, loading: false, isPro: false, refresh: vi.fn() }),
}));

import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { PaletteProvider } from '../components/palette/PaletteContext';
import { AgentsUiProvider } from '../components/agents/agentsUiContext';
import { TopNav } from '../components/TopNav';
import type { SpaceId } from '../app/AppContext';

afterEach(cleanup);

// I18nProvider resolves the locale from navigator.language when no saved
// preference exists (see src/i18n/index.tsx's detectLocaleSync) — jsdom's
// default is "en-US", not "fr". Force fr (the app's DEFAULT_LOCALE and this
// spec's reference language) before every test — setup.ts's own afterEach
// clears localStorage, so this can't be a one-time module-level call.
beforeEach(() => {
  localStorage.setItem('lazy.locale', 'fr');
});

function renderTopNav(activeSpace: SpaceId = 'agents') {
  return render(
    <I18nProvider>
      <ToastProvider>
        <PaletteProvider>
          <AgentsUiProvider>
            <TopNav activeSpace={activeSpace} onSpaceChange={vi.fn()} />
          </AgentsUiProvider>
        </PaletteProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

function settingsPill(): HTMLElement {
  return screen.getByTitle('Réglages');
}

/** Every real nav pill's testid (nav-pill-<SpaceId>), matching TopNav.tsx's
 *  own NAV_PILL_ITEMS + the settings gear — used to assert "exactly one
 *  current" across the whole segmented group, not just the space pills. */
const ALL_NAV_PILL_TESTIDS = ['nav-pill-agents', 'nav-pill-code', 'nav-pill-brain', 'nav-pill-team', 'nav-pill-settings'];

describe('TopNav — update-available dot on the Settings pill', () => {
  it('shows no dot, but still a real (non-emoji) aria-label, when idle', () => {
    mockUseUpdateStore.mockReturnValue({ phase: 'idle' });
    renderTopNav();

    expect(screen.queryByTestId('settings-update-dot')).toBeNull();
    // Accessibility fix (real user report): the gear's only visible content
    // is "⚙" — an aria-label naming it "Réglages" must be present even with
    // no update pending, not just when the update-badge variant kicks in.
    expect(settingsPill().getAttribute('aria-label')).toBe('Réglages');
  });

  it('shows no dot while merely checking or downloading', () => {
    mockUseUpdateStore.mockReturnValue({ phase: 'checking' });
    renderTopNav();
    expect(screen.queryByTestId('settings-update-dot')).toBeNull();
  });

  it('shows the dot and an explicit aria-label when a version is available', () => {
    mockUseUpdateStore.mockReturnValue({ phase: 'available' });
    renderTopNav();

    expect(screen.getByTestId('settings-update-dot')).toBeInTheDocument();
    expect(settingsPill().getAttribute('aria-label')).toBe('Réglages — mise à jour disponible');
  });

  it('shows the dot when an update is staged', () => {
    mockUseUpdateStore.mockReturnValue({ phase: 'staged' });
    renderTopNav();

    expect(screen.getByTestId('settings-update-dot')).toBeInTheDocument();
  });

  it('shows no dot on an error phase', () => {
    mockUseUpdateStore.mockReturnValue({ phase: 'error' });
    renderTopNav();

    expect(screen.queryByTestId('settings-update-dot')).toBeNull();
  });
});

// ── Accessibility fixes (real user report, 2026-08-14) ──────────────────
//
// nav[aria-label="Spaces"] used to expose NO current/selected state to
// assistive tech at all (no aria-current, no aria-pressed) and the gear's
// only accessible name was the literal "⚙" glyph. Locks in: a real
// data-testid on every pill (matching the app's existing convention, so
// e2e/tests never need to click by visible text again), a non-emoji
// accessible name on the settings gear, and exactly one pill marked
// aria-current for every possible SpaceId — including the SETTINGS_GROUP
// members ('settings'/'account'/'models'), where the settings gear itself
// must be the one marked current, and the previously-reported "Team stays
// highlighted while Settings is open" double-current bug cannot occur.
describe('TopNav — nav pill accessibility (data-testid, accessible name, current state)', () => {
  it('exposes a data-testid on every pill, following the nav-pill-<id> convention', () => {
    mockUseUpdateStore.mockReturnValue({ phase: 'idle' });
    renderTopNav();

    for (const testId of ALL_NAV_PILL_TESTIDS) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
  });

  it('the settings gear never has "⚙" as its accessible name', () => {
    mockUseUpdateStore.mockReturnValue({ phase: 'idle' });
    renderTopNav();

    const gear = screen.getByTestId('nav-pill-settings');
    expect(gear.getAttribute('aria-label')).not.toBeNull();
    expect(gear.getAttribute('aria-label')).not.toBe('⚙');
  });

  it.each<SpaceId>(['agents', 'code', 'brain', 'team', 'settings', 'account', 'models'])(
    'exactly one pill is aria-current for activeSpace=%s, and it matches the displayed space',
    (activeSpace) => {
      mockUseUpdateStore.mockReturnValue({ phase: 'idle' });
      renderTopNav(activeSpace);

      const currentPills = ALL_NAV_PILL_TESTIDS.filter(
        (testId) => screen.getByTestId(testId).getAttribute('aria-current') === 'page',
      );
      expect(currentPills).toHaveLength(1);

      const expectedTestId = ['settings', 'account', 'models'].includes(activeSpace)
        ? 'nav-pill-settings'
        : `nav-pill-${activeSpace}`;
      expect(currentPills[0]).toBe(expectedTestId);
    },
  );

  it('regression: Settings open never leaves Team (or any other pill) marked current too', () => {
    mockUseUpdateStore.mockReturnValue({ phase: 'idle' });
    renderTopNav('settings');

    expect(screen.getByTestId('nav-pill-team').getAttribute('aria-current')).toBeNull();
    expect(screen.getByTestId('nav-pill-settings').getAttribute('aria-current')).toBe('page');
  });
});

// ── Regression guard (investigated 2026-08-15) ───────────────────────────
//
// A field report claimed the Team pill had vanished entirely from the DOM
// after a rebuild 14 commits past 83e67ef, with a real "Acme" test org
// present. Investigation found none of those 14 commits touch TopNav.tsx,
// AppShell.tsx, AppContext.tsx, or ActiveTeamContext.tsx — the only files
// that could gate this pill — and a from-source production build still
// contains {id:"team",labelKey:"nav.team"} unconditionally inside
// NAV_PILL_ITEMS. The report was environmental (stale build artifact/
// webview cache), not a code regression.
//
// This test locks in the invariant that made that diagnosis possible:
// TopNav takes no team/org data as a prop or context dependency at all
// (renderTopNav below mounts no ActiveTeamProvider), so the Team pill can
// never depend on an async org/membership fetch succeeding. If a future
// change wires the pill to such a fetch, this test starts failing the
// moment that data is unavailable — the fix then is an explicit
// disabled/error state on the pill (per this investigation's brief), never
// letting it silently disappear again.
describe('TopNav — Team pill has no data dependency (regression guard)', () => {
  it('renders nav-pill-team for every SpaceId, with no team/org context provided at all', () => {
    mockUseUpdateStore.mockReturnValue({ phase: 'idle' });
    const allSpaceIds: SpaceId[] = [
      'home', 'code', 'agents', 'brain', 'review', 'terminals', 'models', 'settings', 'account', 'team',
    ];

    for (const space of allSpaceIds) {
      cleanup();
      renderTopNav(space);
      expect(screen.getByTestId('nav-pill-team')).toBeInTheDocument();
    }
  });
});
