import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WelcomeStep } from '../components/onboarding/steps/WelcomeStep';
import { I18nProvider } from '../i18n';
import { en } from '../i18n/locales/en';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'en');
});

describe('WelcomeStep — skip onboarding', () => {
  it('exposes a Skip button that completes onboarding without walking the wizard', () => {
    const onSkip = vi.fn();
    render(
      <I18nProvider>
        <WelcomeStep onNext={() => {}} onSkip={onSkip} />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('onboarding-welcome-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('onboarding-welcome-skip')).toHaveTextContent(en['onboarding.skip']);
  });
});
