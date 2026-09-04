/* OnboardingModal — full-screen overlay wizard shown on first run.
   Steps: Welcome (1) -> Model check (2) -> Brain setup (3) -> Finish (4).
   Features:
   - Focus trap (Tab cycles within modal)
   - Esc closes at any step except during an active seed operation
   - Step indicator bar
   - Rendered via createPortal to guarantee z-index above all content

   Step set: the full wizard (incl. Model + Brain) vs the condensed
   Welcome->Finish one is controlled by `isFirstRunOnDevice`, NOT by
   `isNewAccount`. The only production caller (AppShell) mounts this modal
   exclusively when useOnboarding().showOnboarding is true, which already
   means "first run on this device" — so `isFirstRunOnDevice` defaults to
   true here and the condensed path is only reached when a caller (e.g. a
   test, or a future call site) explicitly opts out. `isNewAccount` remains
   separate: it only affects the Welcome step's greeting copy.
*/

import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
} from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n';
import { WelcomeStep } from './steps/WelcomeStep';
import { ModelCheckStep } from './steps/ModelCheckStep';
import { BrainSetupStep } from './steps/BrainSetupStep';
import { FinishStep } from './steps/FinishStep';

// ── Types ──────────────────────────────────────────────────────────

interface OnboardingModalProps {
  onComplete: () => void;
  /** Email of the signed-in account — used to greet the user. */
  userEmail?: string | null;
  /** New signups get a "Welcome" greeting; returning accounts get "Welcome
      back". Greeting copy only — does NOT affect which steps render. */
  isNewAccount?: boolean;
  /** First time onboarding is shown on THIS device (no local onboarded flag
      yet — see useOnboarding's showOnboarding). Picks the full wizard (Model
      + Brain steps) vs a condensed Welcome->Finish one. Defaults to true
      because the real call site only ever mounts this modal on first run. */
  isFirstRunOnDevice?: boolean;
}

type StepId = 'welcome' | 'model' | 'brain' | 'finish';

const FULL_STEPS: StepId[] = ['welcome', 'model', 'brain', 'finish'];
const CONDENSED_STEPS: StepId[] = ['welcome', 'finish'];

const STEP_LABEL_KEYS: Record<StepId, string> = {
  welcome: 'onboarding.welcome',
  model:   'onboarding.model',
  brain:   'onboarding.brain',
  finish:  'onboarding.finish',
};

// ── OnboardingModal ────────────────────────────────────────────────

export function OnboardingModal({
  onComplete,
  userEmail,
  isNewAccount = true,
  isFirstRunOnDevice = true,
}: OnboardingModalProps) {
  const { t } = useI18n();
  const [stepIdx, setStepIdx] = useState(0);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const steps = isFirstRunOnDevice ? FULL_STEPS : CONDENSED_STEPS;
  const currentStep = steps[stepIdx];

  const goNext = useCallback(() => {
    setStepIdx(prev => Math.min(prev + 1, steps.length - 1));
  }, [steps.length]);

  const goBack = useCallback(() => {
    setStepIdx(prev => Math.max(prev - 1, 0));
  }, []);

  // Esc dismisses the wizard from any step (consistent with the always-present
  // "Passer" control). Skipping is non-destructive — onboarding is re-runnable
  // from Settings.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onComplete();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onComplete]);

  // Focus trap: keep Tab within the modal panel.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    function getFocusable(): HTMLElement[] {
      return Array.from(
        panel!.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    panel.addEventListener('keydown', handleKeyDown);

    // Move focus into modal on open/step change.
    const first = getFocusable()[0];
    if (first) first.focus();

    return () => panel.removeEventListener('keydown', handleKeyDown);
  }, [stepIdx]);

  const modal = (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={t(STEP_LABEL_KEYS[currentStep])}
      style={overlayStyle}
    >
      <div
        ref={panelRef}
        style={panelStyle}
      >
        {/* Header: skip control (own row, never overlaps the stepper track)
            + step indicator. Fixed — does not scroll away. */}
        <div style={headerStyle}>
          {currentStep !== 'finish' ? (
            <div style={skipRowStyle}>
              <button
                onClick={onComplete}
                style={skipButtonStyle}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.6)'; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.3)'; (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
              >
                {t('onboarding.skip')}
              </button>
            </div>
          ) : (
            // Keeps the stepper's vertical position stable across steps even
            // once Skip disappears on the last step, instead of the stepper
            // jumping up to fill the gap.
            <div style={skipRowStyle} aria-hidden="true" />
          )}

          {/* Step indicator */}
          <StepIndicator steps={steps} current={stepIdx} labels={STEP_LABEL_KEYS} translate={t} />
        </div>

        {/* Body: the only scrolling region. Each step still owns its own
            trailing nav row (Back/Continue/etc.) — see the `position:
            sticky; bottom: 0` on those rows — so the buttons stay pinned
            once scrolled into view instead of requiring the user to keep
            scrolling to reach them at short window heights. */}
        <div style={bodyStyle}>
          {currentStep === 'welcome' && (
            <WelcomeStep onNext={goNext} onSkip={onComplete} userEmail={userEmail} isNewAccount={isNewAccount} />
          )}
          {currentStep === 'model' && (
            <ModelCheckStep onNext={goNext} onBack={goBack} />
          )}
          {currentStep === 'brain' && (
            <BrainSetupStep onNext={goNext} onBack={goBack} />
          )}
          {currentStep === 'finish' && (
            <FinishStep onFinish={onComplete} />
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

// ── StepIndicator ─────────────────────────────────────────────────

interface StepIndicatorProps {
  steps: StepId[];
  current: number;
  labels: Record<StepId, string>;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

function StepIndicator({ steps, current, labels, translate }: StepIndicatorProps) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 0,
      marginBottom: 28,
    }}>
      {steps.map((step, idx) => {
        const isDone = idx < current;
        const isActive = idx === current;
        const isLast = idx === steps.length - 1;

        return (
          <React.Fragment key={step}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {/* Circle */}
              <div style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: isDone
                  ? 'var(--color-accent)'
                  : isActive
                    ? 'rgba(124,92,255,0.2)'
                    : 'rgba(255,255,255,0.06)',
                border: `1.5px solid ${isDone || isActive ? 'var(--color-accent)' : 'rgba(255,255,255,0.12)'}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 700,
                color: isDone ? '#fff' : isActive ? 'var(--color-accent-light)' : 'var(--color-text-ghost)',
                flexShrink: 0,
                transition: 'background 0.2s, border-color 0.2s',
              }}>
                {isDone ? '✓' : idx + 1}
              </div>
              {/* Label */}
              <span style={{
                fontSize: 12,
                fontWeight: isActive ? 600 : 400,
                color: isActive
                  ? 'var(--color-text)'
                  : isDone
                    ? 'var(--color-text-muted)'
                    : 'var(--color-text-ghost)',
                transition: 'color 0.2s',
              }}>
                {translate(labels[step])}
              </span>
            </div>
            {/* Connector line */}
            {!isLast && (
              <div style={{
                flex: 1,
                height: 1,
                background: idx < current
                  ? 'var(--color-accent)'
                  : 'rgba(255,255,255,0.08)',
                margin: '0 10px',
                minWidth: 20,
                transition: 'background 0.2s',
              }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 9000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(8, 8, 14, 0.85)',
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
};

// The panel is a fixed-height-budget flex column: header (skip + stepper)
// and body (scrollable step content) are separate flex items so the body's
// `overflowY: auto` + `minHeight: 0` reliably kicks in at any window height
// instead of relying on the whole panel to grow past the viewport and hope
// a single outer `overflowY: auto` catches it (see bug: at short window
// heights the Back/Continue row used to render past the bottom edge).
const panelStyle: React.CSSProperties = {
  position: 'relative',
  width: 520,
  maxWidth: 'calc(100vw - 32px)',
  maxHeight: 'calc(100vh - 48px)',
  overflow: 'hidden',
  background: 'var(--color-panel)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 14,
  boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
};

const headerStyle: React.CSSProperties = {
  flexShrink: 0,
  padding: '16px 32px 0',
};

const skipRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  minHeight: 26,
  marginBottom: 8,
};

const skipButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'rgba(255,255,255,0.3)',
  fontSize: 12,
  cursor: 'pointer',
  fontFamily: 'inherit',
  padding: '4px 10px',
  borderRadius: 4,
  transition: 'color 0.15s, background 0.15s',
};

// Body owns the scroll: `flex: 1` + `minHeight: 0` is what lets it shrink
// below its content's natural height inside the bounded panel above, which
// is what makes `overflowY: auto` actually engage instead of the panel
// silently growing taller than the window.
const bodyStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '8px 32px 28px',
};
