/**
 * LazyManagerHeader — "+ Nouvelle" busy-dot safety timeout.
 *
 * Real user report: the "+ Nouvelle" pill read grey/stuck for 30s+ with no
 * turn actually running. Investigation: multi-conversation LazyManager
 * (wave 1, 2026-08-01) already made the button's own `disabled` HTML
 * attribute depend ONLY on `openConversationCapReached` — never on busy
 * state (see lazyManagerNewConversationBusy.test.tsx, which proves the
 * button is never HTML-disabled by a busy turn). `disabled` (busy) only
 * drives the small amber dot decoration. This file covers the remaining
 * gap: a `disabled` prop that fails to clear upstream (a stale hydration
 * race, a future regression) would leave that dot lying forever with no
 * self-healing — this proves the safety-timeout backstop added for it,
 * and proves the cap-based disable (a legitimately long-lived, correct
 * `true`) is completely unaffected by it.
 *
 * Props-level render, same convention as lazyManagerHeaderDockedWidth.test
 * .tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React, { createRef } from 'react';
import { I18nProvider } from '../i18n';
import { LazyManagerStoreProvider } from '../components/lazyManager/lazyManagerStore';
import { LazyManagerHeader, BUSY_DOT_SAFETY_TIMEOUT_MS } from '../components/lazyManager/LazyManagerHeader';

function renderHeader(overrides: Partial<React.ComponentProps<typeof LazyManagerHeader>> = {}) {
  const modelSelectRef = createRef<HTMLSelectElement>();
  return render(
    <I18nProvider>
      <LazyManagerStoreProvider>
        <LazyManagerHeader
          mode="orchestrator"
          onModeChange={vi.fn()}
          onShowHistory={vi.fn()}
          onNewSession={vi.fn()}
          disabled={false}
          modelSelectRef={modelSelectRef}
          autonomyLevel="supervised"
          onAutonomyChange={vi.fn()}
          phase="idle"
          openConversationCapReached={false}
          {...overrides}
        />
      </LazyManagerStoreProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LazyManagerHeader — "+ Nouvelle" is never HTML-disabled by busy, whatever the elapsed time', () => {
  it('stays clickable immediately and long past the safety-timeout window while disabled=true', () => {
    renderHeader({ disabled: true });
    expect(screen.getByTestId('lazy-manager-new-conv')).not.toBeDisabled();

    act(() => { vi.advanceTimersByTime(BUSY_DOT_SAFETY_TIMEOUT_MS + 60_000); });

    expect(screen.getByTestId('lazy-manager-new-conv')).not.toBeDisabled();
  });
});

describe('LazyManagerHeader — busy-dot safety timeout', () => {
  it('shows the dot immediately when disabled=true', () => {
    renderHeader({ disabled: true });
    expect(screen.getByTestId('lazy-manager-new-conv-busy-dot')).toBeInTheDocument();
  });

  it('keeps showing the dot right up to (but not past) the safety timeout', () => {
    renderHeader({ disabled: true });
    act(() => { vi.advanceTimersByTime(BUSY_DOT_SAFETY_TIMEOUT_MS - 1000); });
    expect(screen.getByTestId('lazy-manager-new-conv-busy-dot')).toBeInTheDocument();
  });

  it('hides the dot once disabled has been continuously true past the safety timeout (self-heals a wedged upstream flag)', () => {
    renderHeader({ disabled: true });
    act(() => { vi.advanceTimersByTime(BUSY_DOT_SAFETY_TIMEOUT_MS + 1); });
    expect(screen.queryByTestId('lazy-manager-new-conv-busy-dot')).not.toBeInTheDocument();
  });

  it('never shows the dot at all when disabled=false', () => {
    renderHeader({ disabled: false });
    act(() => { vi.advanceTimersByTime(BUSY_DOT_SAFETY_TIMEOUT_MS + 60_000); });
    expect(screen.queryByTestId('lazy-manager-new-conv-busy-dot')).not.toBeInTheDocument();
  });

  it('a fresh mount always gets a full grace window — never inherits staleness from a previous render', () => {
    const first = renderHeader({ disabled: true });
    act(() => { vi.advanceTimersByTime(BUSY_DOT_SAFETY_TIMEOUT_MS + 1); });
    expect(screen.queryByTestId('lazy-manager-new-conv-busy-dot')).not.toBeInTheDocument();
    first.unmount();

    // A brand-new mount (simulating a fresh boot/reload) with disabled=true
    // from the very first render must show the dot again immediately, not
    // inherit the previous instance's elapsed time.
    renderHeader({ disabled: true });
    expect(screen.getByTestId('lazy-manager-new-conv-busy-dot')).toBeInTheDocument();
  });
});

describe('LazyManagerHeader — the open-conversation cap is NEVER bypassed by the busy-dot safety timeout', () => {
  it('stays HTML-disabled, with its explanatory tooltip, arbitrarily long past the busy-dot safety-timeout window', () => {
    renderHeader({ openConversationCapReached: true, disabled: false });
    const pill = screen.getByTestId('lazy-manager-new-conv');
    expect(pill).toBeDisabled();

    act(() => { vi.advanceTimersByTime(BUSY_DOT_SAFETY_TIMEOUT_MS + 10 * 60_000); });

    // The cap is a real, correct, count-based state (not a "stuck" flag) —
    // it must NEVER be silently bypassed by a timeout meant only to guard
    // against a wedged BUSY signal. Still disabled, same explanatory title.
    expect(pill).toBeDisabled();
    // Locale-agnostic on purpose (default test locale here is English, not
    // French — see lazyManagerHeaderDockedWidth.test.tsx's identical cap
    // tooltip assertion for the same reason): both locales' strings mention
    // "conversations" ("Maximum number of open conversations reached..." /
    // "Nombre maximum de conversations ouvertes atteint...").
    expect(pill).toHaveAttribute('title', expect.stringContaining('conversations'));
  });
});
