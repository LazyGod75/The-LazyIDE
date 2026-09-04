/* AuthScreen — polished sign-in / sign-up card for Lazy IDE.
   Design language: dark violet theme, Linear/Cursor-quality.

   Sign-up uses Supabase email confirmation: after a successful sign-up the
   account has no session yet, so we show an explicit "check your email" panel
   with a rate-limit-aware resend action. The confirmation link returns to the
   desktop via the lazy://auth-callback deep link (see useAuth + oauthDesktop).
*/

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useI18n } from '../../i18n';
import { useAuth } from '../../lib/auth/useAuth';
import { openExternal } from '../../lib/platform/openExternal';

// ── Legal links ────────────────────────────────────────────────────

const TERMS_URL = 'https://www.gameon-industries.fr/terms';
const PRIVACY_URL = 'https://www.gameon-industries.fr/privacy';

// ── Validation ──────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
/** Local cooldown applied after a successful resend, before the next is allowed. */
const RESEND_COOLDOWN_SEC = 60;

function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

// ── Types ──────────────────────────────────────────────────────────

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface AuthScreenProps {
  /** Called when the user explicitly skips / closes without signing in. */
  onSkip: () => void;
  /**
   * When false, the "continue without an account" skip link is hidden.
   * Defaults to true to preserve the web / Settings management behavior.
   * The desktop launch gate passes false to make sign-in mandatory.
   */
  allowSkip?: boolean;
  /**
   * Force the Create / Sign in segmented control. The manager session CTA
   * labels itself "Sign in" — landing on Create account was a measured miss
   * (QA 2026-08-28). Absent: returning users (`lazy.returningUser`) open
   * Sign in, everyone else Create account.
   */
  initialMode?: AuthMode;
}

type AuthMode = 'signin' | 'signup';

// ── Error mapping — turn raw Supabase messages into friendly i18n copy ──

function isEmailNotConfirmed(raw: string): boolean {
  const m = raw.toLowerCase();
  return m.includes('not confirmed') || m.includes('email_not_confirmed');
}

function isInvalidCredentials(raw: string): boolean {
  const m = raw.toLowerCase();
  return m.includes('invalid login') || m.includes('invalid credentials');
}

function mapAuthError(raw: string, t: Translate): string {
  if (isEmailNotConfirmed(raw)) return t('auth.errorEmailNotConfirmed');
  if (isInvalidCredentials(raw)) return t('auth.errorInvalidCredentials');
  return raw;
}

function markReturningUser(): void {
  try {
    localStorage.setItem('lazy.returningUser', '1');
  } catch {
    // localStorage unavailable — ignore
  }
}

// ── Icons ──────────────────────────────────────────────────────────

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

function LazyMark() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="rgba(124,92,255,0.15)" />
      <rect x="1" y="1" width="30" height="30" rx="7" stroke="rgba(124,92,255,0.4)" strokeWidth="1" fill="none" />
      <path d="M10 8 L10 22 L22 22" stroke="#A78BFF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="22" cy="22" r="2" fill="#7C5CFF" />
    </svg>
  );
}

function Spinner() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 14,
        height: 14,
        border: '2px solid rgba(255,255,255,0.3)',
        borderTopColor: '#fff',
        borderRadius: '50%',
        animation: 'spin 0.7s linear infinite',
        flexShrink: 0,
      }}
      aria-hidden="true"
    />
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      {off && <path d="M4 4 L20 20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  );
}

// ── Legal footer ───────────────────────────────────────────────────

function LegalLink({ url, label }: { url: string; label: string }) {
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      // openExternal now throws on genuine failure (see openExternal.ts) instead
      // of silently no-op'ing — catch here so a rare failure doesn't surface as
      // an unhandled promise rejection for this fire-and-forget footer link.
      openExternal(url).catch((error: unknown) => {
        console.error('LegalLink: failed to open external URL', error);
      });
    },
    [url],
  );

  return (
    <a href={url} onClick={handleClick} target="_blank" rel="noopener noreferrer" style={styles.legalLink}>
      {label}
    </a>
  );
}

function LegalFooter() {
  const { t } = useI18n();
  const template = t('auth.legalPrefix');
  const terms = <LegalLink key="terms" url={TERMS_URL} label={t('auth.terms')} />;
  const privacy = <LegalLink key="privacy" url={PRIVACY_URL} label={t('auth.privacy')} />;

  const parts = template.split(/(\{terms\}|\{privacy\})/g);
  const nodes = parts.map((part, i) => {
    if (part === '{terms}') return terms;
    if (part === '{privacy}') return privacy;
    return <React.Fragment key={`t-${i}`}>{part}</React.Fragment>;
  });

  return <p style={styles.legal}>{nodes}</p>;
}

// ── Mode tabs — clean Créer / Se connecter segmented control ─────────

function ModeTabs({ mode, onSelect, t }: { mode: AuthMode; onSelect: (m: AuthMode) => void; t: Translate }) {
  const tab = (value: AuthMode, label: string) => {
    const active = mode === value;
    return (
      <button
        type="button"
        role="tab"
        data-testid={`auth-mode-${value}`}
        aria-selected={active}
        onClick={() => onSelect(value)}
        style={{ ...styles.tab, ...(active ? styles.tabActive : null) }}
      >
        {label}
      </button>
    );
  };

  return (
    <div role="tablist" style={styles.tabs}>
      {tab('signup', t('auth.createAccount'))}
      {tab('signin', t('auth.signIn'))}
    </div>
  );
}

// ── Inline field error ──────────────────────────────────────────────

function FieldError({ children }: { children: React.ReactNode }) {
  return <span style={styles.fieldError}>{children}</span>;
}

// ── Password field with show/hide toggle ────────────────────────────

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  autoComplete: string;
  disabled: boolean;
  show: boolean;
  onToggleShow: () => void;
  onChange: (v: string) => void;
  showLabel: string;
  hideLabel: string;
  error?: string | null;
  hint?: string | null;
}

function PasswordField(props: PasswordFieldProps) {
  return (
    <div style={styles.field}>
      <label htmlFor={props.id} style={styles.label}>
        {props.label}
      </label>
      <div style={styles.passwordWrap}>
        <input
          id={props.id}
          data-testid={props.id}
          type={props.show ? 'text' : 'password'}
          autoComplete={props.autoComplete}
          required
          value={props.value}
          onChange={e => props.onChange(e.target.value)}
          disabled={props.disabled}
          placeholder="••••••••"
          style={{ ...styles.input, paddingRight: 40, opacity: props.disabled ? 0.6 : 1 }}
        />
        <button
          type="button"
          onClick={props.onToggleShow}
          disabled={props.disabled}
          aria-label={props.show ? props.hideLabel : props.showLabel}
          style={styles.eyeBtn}
        >
          <EyeIcon off={props.show} />
        </button>
      </div>
      {props.error
        ? <FieldError>{props.error}</FieldError>
        : props.hint
          ? <span style={styles.hint}>{props.hint}</span>
          : null}
    </div>
  );
}

// ── Check-email panel — primary post-signup state ───────────────────

interface CheckEmailPanelProps {
  email: string;
  resending: boolean;
  cooldown: number;
  resendMsg: string | null;
  error: string | null;
  onResend: () => void;
  onBack: () => void;
  t: Translate;
}

function CheckEmailPanel(props: CheckEmailPanelProps) {
  const { t } = props;
  const disabled = props.resending || props.cooldown > 0;
  return (
    <div style={styles.confirmPanel} role="status" aria-live="polite">
      <div style={styles.confirmIcon} aria-hidden="true">✉️</div>
      <h3 style={styles.confirmTitle}>{t('auth.checkEmailTitle')}</h3>
      <p style={styles.confirmBody}>{t('auth.checkEmailBody', { email: props.email })}</p>

      {props.error && (
        <div role="alert" style={styles.errorBox}>
          <span>{props.error}</span>
        </div>
      )}
      {props.resendMsg && <p style={styles.resentText}>{props.resendMsg}</p>}

      <button
        type="button"
        onClick={props.onResend}
        disabled={disabled}
        style={{ ...styles.googleBtn, opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
      >
        {props.resending ? <Spinner /> : null}
        <span>{props.cooldown > 0 ? t('auth.resendCooldown', { sec: props.cooldown }) : t('auth.resendEmail')}</span>
      </button>

      <button type="button" onClick={props.onBack} style={styles.backBtn}>
        {t('auth.backToForm')}
      </button>
    </div>
  );
}

// ── AuthScreen ─────────────────────────────────────────────────────

export function AuthScreen({ onSkip, allowSkip = true, initialMode }: AuthScreenProps) {
  const { t } = useI18n();
  const { signIn, signUp, signInWithGoogle, resendConfirmation } = useAuth();

  const [mode, setMode] = useState<AuthMode>(() => {
    if (initialMode === 'signin' || initialMode === 'signup') return initialMode;
    try {
      return localStorage.getItem('lazy.returningUser') === '1' ? 'signin' : 'signup';
    } catch {
      return 'signup';
    }
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showResend, setShowResend] = useState(false);
  const [confirmSent, setConfirmSent] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [resendMsg, setResendMsg] = useState<string | null>(null);

  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  // Cooldown countdown — one self-rescheduling timeout per remaining second.
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  // ── Live validation ──
  const emailValid = isValidEmail(email);
  const pwLongEnough = password.length >= MIN_PASSWORD;
  const pwMatches = password === confirm;
  const formValid =
    mode === 'signup'
      ? emailValid && pwLongEnough && pwMatches && confirm.length > 0
      : emailValid && password.length > 0;

  const emailError = email.length > 0 && !emailValid ? t('auth.invalidEmail') : null;
  const pwError = mode === 'signup' && password.length > 0 && !pwLongEnough ? t('auth.passwordTooShort') : null;
  const confirmError = mode === 'signup' && confirm.length > 0 && !pwMatches ? t('auth.passwordsMismatch') : null;

  const selectMode = useCallback((m: AuthMode) => {
    setMode(m);
    setError(null);
    setShowResend(false);
    setConfirm('');
  }, []);

  const handleResend = useCallback(async () => {
    if (resending || cooldown > 0) return;
    setResending(true);
    setResendMsg(null);
    setError(null);
    try {
      const { error: rErr, retryAfterSec } = await resendConfirmation(email);
      if (rErr && retryAfterSec) {
        setCooldown(retryAfterSec);
        setResendMsg(t('auth.resendRateLimited'));
      } else if (rErr) {
        setError(mapAuthError(rErr, t));
      } else {
        setResendMsg(t('auth.resent'));
        setCooldown(RESEND_COOLDOWN_SEC);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('auth.unexpectedError'));
    } finally {
      setResending(false);
    }
  }, [resending, cooldown, email, resendConfirmation, t]);

  const handleEmailSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (submitting || !formValid) return;
      setError(null);
      setShowResend(false);
      setSubmitting(true);
      try {
        if (mode === 'signup') {
          const { error: authError, needsConfirmation } = await signUp(email, password);
          if (authError) setError(mapAuthError(authError, t));
          else if (needsConfirmation) setConfirmSent(true);
          // else: a session was created → AuthGate swaps to the app automatically.
        } else {
          const { error: authError } = await signIn(email, password);
          if (authError) {
            setError(mapAuthError(authError, t));
            if (isEmailNotConfirmed(authError)) setShowResend(true);
          } else {
            markReturningUser();
          }
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : t('auth.unexpectedError'));
      } finally {
        setSubmitting(false);
      }
    },
    [mode, email, password, submitting, formValid, signIn, signUp, t],
  );

  const handleGoogle = useCallback(async () => {
    if (googleLoading) return;
    setError(null);
    setGoogleLoading(true);
    const { error: authError } = await signInWithGoogle();
    setGoogleLoading(false);
    if (authError) setError(authError);
    else markReturningUser();
  }, [googleLoading, signInWithGoogle]);

  const isFormDisabled = submitting || googleLoading;

  return (
    <div style={styles.card}>
      {/* ── Header ── */}
      <div style={styles.header}>
        <LazyMark />
        <div>
          <h2 style={styles.title}>{mode === 'signin' ? t('auth.title') : t('auth.signUpTitle')}</h2>
          <p style={styles.subtitle}>{t('auth.subtitle')}</p>
        </div>
      </div>

      {confirmSent ? (
        <CheckEmailPanel
          email={email}
          resending={resending}
          cooldown={cooldown}
          resendMsg={resendMsg}
          error={error}
          onResend={handleResend}
          onBack={() => { setConfirmSent(false); setError(null); }}
          t={t}
        />
      ) : (
        <>
          {/* ── Mode tabs ── */}
          <ModeTabs mode={mode} onSelect={selectMode} t={t} />

          {/* ── Google button ── */}
          <button
            type="button"
            onClick={handleGoogle}
            disabled={isFormDisabled}
            style={{ ...styles.googleBtn, opacity: isFormDisabled ? 0.6 : 1, cursor: isFormDisabled ? 'not-allowed' : 'pointer' }}
            aria-label={t('auth.continueWithGoogle')}
          >
            {googleLoading ? <Spinner /> : <GoogleLogo />}
            <span>{t('auth.continueWithGoogle')}</span>
          </button>

          {/* ── Divider ── */}
          <div style={styles.divider} aria-hidden="true">
            <div style={styles.dividerLine} />
            <span style={styles.dividerText}>{t('auth.or')}</span>
            <div style={styles.dividerLine} />
          </div>

          {/* ── Email / Password form ── */}
          <form
            onSubmit={handleEmailSubmit}
            noValidate
            aria-label={mode === 'signin' ? t('auth.signIn') : t('auth.createAccount')}
            style={styles.form}
          >
            <div style={styles.field}>
              <label htmlFor="auth-email" style={styles.label}>{t('auth.email')}</label>
              <input
                ref={emailRef}
                id="auth-email"
                data-testid="auth-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                disabled={isFormDisabled}
                placeholder="you@example.com"
                style={{ ...styles.input, opacity: isFormDisabled ? 0.6 : 1 }}
              />
              {emailError && <FieldError>{emailError}</FieldError>}
            </div>

            <PasswordField
              id="auth-password"
              label={t('auth.password')}
              value={password}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              disabled={isFormDisabled}
              show={showPassword}
              onToggleShow={() => setShowPassword(s => !s)}
              onChange={setPassword}
              showLabel={t('auth.showPassword')}
              hideLabel={t('auth.hidePassword')}
              error={pwError}
              hint={mode === 'signup' ? t('auth.passwordHint') : null}
            />

            {mode === 'signup' && (
              <PasswordField
                id="auth-confirm"
                label={t('auth.confirmPassword')}
                value={confirm}
                autoComplete="new-password"
                disabled={isFormDisabled}
                show={showPassword}
                onToggleShow={() => setShowPassword(s => !s)}
                onChange={setConfirm}
                showLabel={t('auth.showPassword')}
                hideLabel={t('auth.hidePassword')}
                error={confirmError}
              />
            )}

            {error && (
              <div role="alert" style={styles.errorBox}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }}>
                  <circle cx="8" cy="8" r="7" stroke="#F97066" strokeWidth="1.5" fill="none" />
                  <path d="M8 5v3.5" stroke="#F97066" strokeWidth="1.5" strokeLinecap="round" />
                  <circle cx="8" cy="11" r="0.75" fill="#F97066" />
                </svg>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span>{error}</span>
                  {showResend && (
                    <button
                      type="button"
                      onClick={handleResend}
                      disabled={resending || cooldown > 0}
                      style={styles.inlineResendBtn}
                    >
                      {cooldown > 0 ? t('auth.resendCooldown', { sec: cooldown }) : t('auth.resendConfirmation')}
                    </button>
                  )}
                  {resendMsg && <span style={styles.resentText}>{resendMsg}</span>}
                </div>
              </div>
            )}

            <button
              type="submit"
              data-testid="auth-submit"
              disabled={isFormDisabled || !formValid}
              data-primary="true"
              style={{
                ...styles.submitBtn,
                opacity: isFormDisabled || !formValid ? 0.5 : 1,
                cursor: isFormDisabled || !formValid ? 'not-allowed' : 'pointer',
              }}
            >
              {submitting ? (
                <span style={styles.submitBtnInner}>
                  <Spinner />
                  {mode === 'signin' ? t('auth.signingIn') : t('auth.creatingAccount')}
                </span>
              ) : (
                mode === 'signin' ? t('auth.signIn') : t('auth.createAccount')
              )}
            </button>
          </form>
        </>
      )}

      {/* ── Legal footer — shown in all states ── */}
      <LegalFooter />

      {/* ── Skip link — hidden when sign-in is mandatory (allowSkip === false) ── */}
      {allowSkip && (
        <div style={styles.skipContainer}>
          <button type="button" data-testid="auth-skip" onClick={onSkip} style={styles.skipBtn}>
            {t('auth.skip')}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Styles — pure inline objects (matches design-system tokens) ────

const styles = {
  card: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 18,
    width: '100%',
    maxWidth: 380,
  },

  header: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 14,
  },

  title: {
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--color-text)',
    letterSpacing: '-0.3px',
    marginBottom: 4,
    fontFamily: 'var(--font-ui)',
  },

  subtitle: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
    lineHeight: 1.5,
    fontFamily: 'var(--font-ui)',
  },

  tabs: {
    display: 'flex',
    gap: 4,
    padding: 4,
    background: 'var(--color-panel-2)',
    border: '1px solid var(--color-border)',
    borderRadius: 10,
  },

  tab: {
    flex: 1,
    padding: '8px 12px',
    background: 'transparent',
    border: 'none',
    borderRadius: 7,
    color: 'var(--color-text-muted)',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'var(--font-ui)',
    cursor: 'pointer',
    transition: 'background 0.15s, color 0.15s',
  },

  tabActive: {
    background: 'var(--color-accent)',
    color: '#fff',
  },

  googleBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    width: '100%',
    padding: '11px 16px',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: 9,
    color: 'var(--color-text)',
    fontSize: 13,
    fontWeight: 500,
    fontFamily: 'var(--font-ui)',
    transition: 'background 0.15s, border-color 0.15s',
    letterSpacing: '0.01em',
  },

  divider: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },

  dividerLine: {
    flex: 1,
    height: 1,
    background: 'var(--color-border)',
  },

  dividerText: {
    fontSize: 11,
    color: 'var(--color-text-ghost)',
    fontFamily: 'var(--font-ui)',
    userSelect: 'none' as const,
  },

  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 14,
  },

  field: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },

  label: {
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--color-text-dim)',
    fontFamily: 'var(--font-ui)',
    letterSpacing: '0.01em',
  },

  input: {
    width: '100%',
    padding: '10px 13px',
    background: 'var(--color-panel-2)',
    border: '1px solid var(--color-border)',
    borderRadius: 8,
    fontSize: 13,
    color: 'var(--color-text)',
    fontFamily: 'var(--font-ui)',
    outline: 'none',
    transition: 'border-color 0.15s',
  },

  passwordWrap: {
    position: 'relative' as const,
    display: 'flex',
    alignItems: 'center',
  },

  eyeBtn: {
    position: 'absolute' as const,
    right: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    background: 'none',
    border: 'none',
    color: 'var(--color-text-ghost)',
    cursor: 'pointer',
    padding: 0,
  },

  fieldError: {
    fontSize: 11,
    color: '#F97066',
    fontFamily: 'var(--font-ui)',
    lineHeight: 1.4,
  },

  hint: {
    fontSize: 11,
    color: 'var(--color-text-ghost)',
    fontFamily: 'var(--font-ui)',
    lineHeight: 1.4,
  },

  errorBox: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 7,
    padding: '9px 12px',
    background: 'rgba(249,112,102,0.08)',
    border: '1px solid rgba(249,112,102,0.25)',
    borderRadius: 7,
    fontSize: 12,
    color: '#F97066',
    lineHeight: 1.5,
    fontFamily: 'var(--font-ui)',
  },

  inlineResendBtn: {
    alignSelf: 'flex-start' as const,
    background: 'none',
    border: 'none',
    padding: 0,
    fontSize: 12,
    color: '#F97066',
    fontFamily: 'var(--font-ui)',
    fontWeight: 600,
    cursor: 'pointer',
    textDecoration: 'underline',
    textUnderlineOffset: 2,
  },

  submitBtn: {
    width: '100%',
    padding: '11px 16px',
    background: 'var(--color-accent)',
    border: 'none',
    borderRadius: 9,
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'var(--font-ui)',
    letterSpacing: '0.01em',
    transition: 'background 0.15s, box-shadow 0.15s',
  },

  submitBtnInner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },

  confirmPanel: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 12,
    textAlign: 'center' as const,
    padding: '8px 4px',
  },

  confirmIcon: {
    fontSize: 32,
    lineHeight: 1,
  },

  confirmTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--color-text)',
    fontFamily: 'var(--font-ui)',
    margin: 0,
  },

  confirmBody: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
    lineHeight: 1.5,
    fontFamily: 'var(--font-ui)',
    margin: 0,
  },

  resentText: {
    fontSize: 12,
    color: 'var(--color-success, #66E27A)',
    fontFamily: 'var(--font-ui)',
    margin: 0,
  },

  backBtn: {
    background: 'none',
    border: 'none',
    padding: '4px 8px',
    fontSize: 12,
    color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-ui)',
    cursor: 'pointer',
    textDecoration: 'underline',
    textUnderlineOffset: 2,
  },

  legal: {
    textAlign: 'center' as const,
    fontSize: 11,
    lineHeight: 1.5,
    color: 'var(--color-text-ghost)',
    fontFamily: 'var(--font-ui)',
    margin: 0,
  },

  legalLink: {
    color: 'var(--color-text-muted)',
    textDecoration: 'underline',
    textUnderlineOffset: 2,
    cursor: 'pointer',
  },

  skipContainer: {
    display: 'flex',
    justifyContent: 'center',
    paddingTop: 2,
  },

  skipBtn: {
    background: 'none',
    border: 'none',
    padding: '4px 8px',
    fontSize: 11,
    color: 'var(--color-text-ghost)',
    fontFamily: 'var(--font-ui)',
    cursor: 'pointer',
    letterSpacing: '0.02em',
    transition: 'color 0.15s',
  },
} as const;
