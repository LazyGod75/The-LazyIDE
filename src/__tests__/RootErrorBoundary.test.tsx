/**
 * RootErrorBoundary.test.tsx
 *
 * Regression test for the app-wide error boundary added to AppShell.tsx.
 * Previously only SpaceErrorBoundary existed, wrapping just the active
 * space's content — a throw during render of anything else in AppShell
 * (SpacesRail, Omnibar, CommandPalette, UpdaterService,
 * OnboardingModal) had no ancestor boundary at all, so React unmounted
 * the whole tree and the webview went fully white with no recovery path.
 * RootErrorBoundary now wraps the entire AppShell (see AppShell.tsx) and
 * renders a minimal, dependency-free fallback with a Reload action
 * instead.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RootErrorBoundary } from '../components/RootErrorBoundary';

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('kaboom: missing import crash');
  return <div data-testid="ok">rendered fine</div>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RootErrorBoundary', () => {
  it('renders children normally when nothing throws', () => {
    render(
      <RootErrorBoundary>
        <Bomb shouldThrow={false} />
      </RootErrorBoundary>,
    );
    expect(screen.getByTestId('ok')).toBeInTheDocument();
  });

  it('catches a render-time throw and shows a fallback instead of leaving a blank tree', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <RootErrorBoundary>
        <Bomb shouldThrow={true} />
      </RootErrorBoundary>,
    );

    expect(screen.queryByTestId('ok')).toBeNull();
    expect(screen.getByText('Lazy hit an unexpected error')).toBeInTheDocument();
    expect(screen.getByText('kaboom: missing import crash')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('logs the caught error instead of silently swallowing it', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <RootErrorBoundary>
        <Bomb shouldThrow={true} />
      </RootErrorBoundary>,
    );

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[RootErrorBoundary]',
      expect.any(Error),
      expect.anything(),
    );
  });

  it('clicking Reload reloads the webview', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // jsdom's window.location.reload is a non-configurable method (it
    // throws "Cannot redefine property" under vi.spyOn), so the standard
    // workaround is to replace the whole `window.location` object, whose
    // OWN property on `window` is configurable.
    const originalLocation = window.location;
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    });

    render(
      <RootErrorBoundary>
        <Bomb shouldThrow={true} />
      </RootErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    expect(reloadSpy).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });
});
