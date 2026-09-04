/* WelcomeStep — step 1 of 4.
   Introduces Lazy in one clear sentence. No fluff.
*/

import React from 'react';
import { useI18n } from '../../../i18n';

interface WelcomeStepProps {
  onNext: () => void;
  /** Skip the rest of the wizard (same as the header Skip control). */
  onSkip?: () => void;
  userEmail?: string | null;
  isNewAccount?: boolean;
}

export function WelcomeStep({ onNext, onSkip, userEmail, isNewAccount = true }: WelcomeStepProps) {
  const { t } = useI18n();
  const greetingKey = isNewAccount ? 'onboarding.welcome.greetingNew' : 'onboarding.welcome.greetingReturning';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      {/* Logotype */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          background: 'var(--color-accent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 20,
          fontWeight: 700,
          color: '#fff',
          fontFamily: 'var(--font-mono)',
          flexShrink: 0,
        }}>
          L
        </div>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', letterSpacing: '-0.02em' }}>
            Lazy IDE
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 1 }}>
            {userEmail ? t(greetingKey, { email: userEmail }) : t('onboarding.welcome.subtitle')}
          </div>
        </div>
      </div>

      {/* One-line description */}
      <div style={{
        padding: '20px 24px',
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
      }}>
        <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--color-text)', margin: 0 }}>
          {t('onboarding.welcome.description')}
        </p>
      </div>

      {/* Feature list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {FEATURES.map(f => (
          <div key={f.labelKey} style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}>
            <div style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--color-accent)',
              marginTop: 7,
              flexShrink: 0,
            }} />
            <div>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>
                {t(f.labelKey)}
              </span>
              <span style={{ fontSize: 13, color: 'var(--color-text-muted)', marginLeft: 6 }}>
                {t(f.descKey)}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Sticky within the modal's scrollable body (see OnboardingModal.tsx's
          bodyStyle) so this button stays reachable without extra scrolling
          at short window heights. */}
      <div style={navFooterStyle}>
        {onSkip && (
          <button
            type="button"
            data-testid="onboarding-welcome-skip"
            onClick={onSkip}
            style={skipButtonStyle}
          >
            {t('onboarding.skip')}
          </button>
        )}
        <button
          type="button"
          onClick={onNext}
          autoFocus
          style={primaryButtonStyle}
        >
          {t('onboarding.welcome.getStarted')}
        </button>
      </div>
    </div>
  );
}

const FEATURES = [
  { labelKey: 'onboarding.welcome.feature.brain', descKey: 'onboarding.welcome.feature.brain.desc' },
  { labelKey: 'onboarding.welcome.feature.agents', descKey: 'onboarding.welcome.feature.agents.desc' },
  { labelKey: 'onboarding.welcome.feature.tokenSaver', descKey: 'onboarding.welcome.feature.tokenSaver.desc' },
];

const primaryButtonStyle: React.CSSProperties = {
  padding: '10px 20px',
  background: 'var(--color-accent)',
  border: 'none',
  borderRadius: 8,
  color: '#fff',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
  transition: 'background 0.12s',
};

const skipButtonStyle: React.CSSProperties = {
  padding: '10px 16px',
  background: 'transparent',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  color: 'var(--color-text-muted)',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const navFooterStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'center',
  gap: 10,
  position: 'sticky',
  bottom: 0,
  marginTop: 8,
  paddingTop: 12,
  paddingBottom: 4,
  background: 'var(--color-panel)',
};
