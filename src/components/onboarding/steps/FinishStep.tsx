/* FinishStep — step 4 of 4.
   Marks onboarding complete (lazy.onboarded = '1'), shows a brief summary
   of next steps, and lets the user open the IDE.
*/

import type { CSSProperties } from 'react';
import { useI18n } from '../../../i18n';

interface FinishStepProps {
  onFinish: () => void;
}

export function FinishStep({ onFinish }: FinishStepProps) {
  const { t } = useI18n();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--color-text)', marginBottom: 6 }}>
          {t('onboarding.finish.title')}
        </div>
        <div style={{ fontSize: 13, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
          {t('onboarding.finish.description')}
        </div>
      </div>

      {/* Next steps */}
      <div style={{
        padding: '16px 18px',
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}>
        <div style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--color-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 2,
        }}>
          {t('onboarding.finish.whatNext')}
        </div>
        {NEXT_STEPS.map(step => (
          <div key={step.titleKey} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: 'rgba(124,92,255,0.12)',
              border: '1px solid var(--color-accent-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              fontSize: 13,
            }}>
              {step.icon}
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)', marginBottom: 2 }}>
                {t(step.titleKey)}
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.4 }}>
                {t(step.descKey)}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Re-run note */}
      <div style={{
        fontSize: 11,
        color: 'var(--color-text-ghost)',
        lineHeight: 1.5,
        borderTop: '1px solid var(--color-border)',
        paddingTop: 14,
      }}>
        {t('onboarding.finish.rerunNote')}{' '}
        <strong style={{ color: 'var(--color-text-muted)' }}>{t('onboarding.finish.rerunPath')}</strong>.
      </div>

      {/* Sticky within the modal's scrollable body (see OnboardingModal.tsx's
          bodyStyle) so this button stays reachable without extra scrolling
          at short window heights. */}
      <div style={navFooterStyle}>
        <button
          onClick={onFinish}
          autoFocus
          style={{
            padding: '11px 24px',
            background: 'var(--color-accent)',
            border: 'none',
            borderRadius: 8,
            color: '#fff',
            fontSize: 14,
            fontWeight: 700,
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'background 0.12s',
          }}
        >
          {t('onboarding.finish.openLazy')}
        </button>
      </div>
    </div>
  );
}

const navFooterStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  position: 'sticky',
  bottom: 0,
  marginTop: 8,
  paddingTop: 12,
  paddingBottom: 4,
  background: 'var(--color-panel)',
};

const NEXT_STEPS = [
  {
    icon: 'B',
    titleKey: 'onboarding.finish.next.brain.title',
    descKey: 'onboarding.finish.next.brain.desc',
  },
  {
    icon: 'A',
    titleKey: 'onboarding.finish.next.agents.title',
    descKey: 'onboarding.finish.next.agents.desc',
  },
  {
    icon: 'S',
    titleKey: 'onboarding.finish.next.settings.title',
    descKey: 'onboarding.finish.next.settings.desc',
  },
];
