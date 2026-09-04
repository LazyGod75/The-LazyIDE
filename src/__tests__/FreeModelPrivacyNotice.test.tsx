import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FreeModelPrivacyNotice } from '../components/settings/FreeModelPrivacyNotice';

// Passthrough i18n mock — matches the convention used by other component
// tests in this suite (e.g. BrainContextBanner.test.tsx): t() just returns
// the key, so assertions target the key rather than a translated string
// that could drift across locale files.
vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({
    t: (key: string) => key,
  }),
}));

describe('FreeModelPrivacyNotice', () => {
  it('renders the warning when a free model is active', () => {
    render(<FreeModelPrivacyNotice isFree={true} />);
    const notice = screen.getByTestId('free-model-privacy-notice');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent('settings.pro.freeModelNotice');
    expect(notice.getAttribute('role')).toBe('alert');
  });

  it('renders nothing when the model is not free', () => {
    render(<FreeModelPrivacyNotice isFree={false} />);
    expect(screen.queryByTestId('free-model-privacy-notice')).not.toBeInTheDocument();
  });
});
