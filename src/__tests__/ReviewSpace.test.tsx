/* ReviewSpace.test.tsx — browser empty state (no canned demo diffs).

   The web platform has no git backend. Review must show an honest empty
   state, never PENDING_CHANGES (Bug #342 / mock scores). */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { en } from '../i18n/locales/en';
import { ToastProvider } from '../components/ui';
import { ReviewSpace } from '../spaces/ReviewSpace';

vi.mock('../app/AppContext', () => {
  const value = { platform: { name: 'web' }, projectRoot: '' };
  return { useAppContext: () => value };
});

vi.mock('../lib/agents/runtime', () => ({
  isManagedAgentAvailable: () => false,
  isLiveAgentAvailable: () => false,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function renderReview() {
  render(
    <I18nProvider>
      <ToastProvider>
        <ReviewSpace />
      </ToastProvider>
    </I18nProvider>,
  );
}

describe('ReviewSpace — browser has no git, so no canned diffs', () => {
  it('shows the honest empty state and never Bug #342 mock data', async () => {
    renderReview();

    expect(await screen.findByText(en['review.browserNoGit'])).toBeInTheDocument();
    expect(screen.getByText(en['review.browserNoGitDesc'])).toBeInTheDocument();
    expect(screen.queryByText('Bug #342')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create PR/ })).not.toBeInTheDocument();
  });
});
