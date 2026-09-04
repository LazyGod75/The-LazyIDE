/**
 * QA 2026-08-28: the manager session CTA says "Sign in" but AuthScreen
 * defaulted to Create account (no lazy.returningUser). initialMode='signin'
 * must select the Sign in tab on first paint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { AuthScreen } from '../components/auth/AuthScreen';

vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  }),
}));

vi.mock('../lib/auth/useAuth', () => ({
  useAuth: () => ({
    signIn: vi.fn(),
    signUp: vi.fn(),
    signInWithGoogle: vi.fn(),
    resendConfirmation: vi.fn(),
  }),
}));

vi.mock('../lib/platform/openExternal', () => ({
  openExternal: vi.fn(),
}));

describe('AuthScreen — initialMode', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('opens Sign in when initialMode is signin, even without a returning-user flag', () => {
    render(<AuthScreen onSkip={() => {}} initialMode="signin" />);
    expect(screen.getByTestId('auth-mode-signin')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('auth-mode-signup')).toHaveAttribute('aria-selected', 'false');
  });

  it('opens Create account when initialMode is signup for a returning user', () => {
    localStorage.setItem('lazy.returningUser', '1');
    render(<AuthScreen onSkip={() => {}} initialMode="signup" />);
    expect(screen.getByTestId('auth-mode-signup')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('auth-mode-signin')).toHaveAttribute('aria-selected', 'false');
  });
});
