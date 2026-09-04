/**
 * Skeleton.test.tsx
 *
 * Regression test: Spinner (src/components/ui/Skeleton.tsx) used to call
 * useI18n() directly, which throws "useI18n must be used inside
 * I18nProvider" outside an I18nProvider ancestor — a real crash captured by
 * the app's own journal (six `frontend.error` rows, source
 * `window.onerror`, stack pointing at Spinner). Boot-time and fallback UI
 * (AuthGate's pre-auth splash and Suspense fallback, Suspense fallbacks
 * elsewhere in the tree) must never assume a provider is mounted — that is
 * exactly the situation such UI can render in.
 *
 * Fixed by switching Spinner to useI18nOptional (returns null instead of
 * throwing outside I18nProvider) with a hardcoded "Loading…" fallback
 * label, matching the real `common.loading` copy.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Spinner } from '../components/ui/Skeleton';
import { I18nProvider } from '../i18n';
import { en } from '../i18n/locales/en';

describe('Spinner', () => {
  it('renders without throwing outside an I18nProvider ancestor, with a hardcoded fallback label', () => {
    expect(() => render(<Spinner />)).not.toThrow();
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Loading…');
  });

  it('uses the real translated label when a real I18nProvider ancestor exists', () => {
    localStorage.setItem('lazy.locale', 'en');
    render(
      <I18nProvider>
        <Spinner />
      </I18nProvider>,
    );
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', en['common.loading']);
  });
});
