import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from '../components/auth/AuthGate';
import { I18nProvider } from '../i18n';
import { en } from '../i18n/locales/en';
import { GUEST_MODE_KEY } from '../lib/auth/guestMode';

vi.mock('../lib/platform', () => ({
  isTauri: () => true,
}));

vi.mock('../lib/envCloud', () => ({
  isCloudConfigured: () => true,
}));

vi.mock('../lib/auth/useAuth', () => ({
  useAuth: () => ({
    session: null,
    user: null,
    loading: false,
  }),
}));

vi.mock('../lib/platform/openExternal', () => ({
  openExternal: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'en');
});

afterEach(() => {
  localStorage.clear();
});

function renderGate() {
  return render(
    <I18nProvider>
      <AuthGate>
        <div data-testid="app-shell">shell</div>
      </AuthGate>
    </I18nProvider>,
  );
}

describe('AuthGate — desktop skip', () => {
  it('shows a skip control on the signed-out desktop gate', async () => {
    renderGate();
    expect(await screen.findByTestId('auth-skip')).toBeInTheDocument();
    expect(screen.getByTestId('auth-skip')).toHaveTextContent(en['auth.skip']);
    expect(screen.queryByTestId('app-shell')).toBeNull();
  });

  it('lets the user skip sign-in and remember guest mode across remounts', async () => {
    const { unmount } = renderGate();
    fireEvent.click(await screen.findByTestId('auth-skip'));

    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    });
    expect(localStorage.getItem(GUEST_MODE_KEY)).toBe('1');

    unmount();
    renderGate();
    expect(await screen.findByTestId('app-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('auth-skip')).toBeNull();
  });
});
