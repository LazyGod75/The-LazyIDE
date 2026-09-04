/* SafeModeBanner — persistent, dismissible banner shown when the app booted
   into safe mode after repeated crashes (see src/lib/startupRecovery.ts and
   StartupRecoveryCheck.tsx, which decides WHEN to render this and owns the
   fetch). No existing global status-bar host in AppShell to attach to, so
   this renders as a fixed top overlay bar — same "minimal, dependency-free,
   self-contained" posture as RootErrorBoundary's own fallback, and the same
   dark-panel/colored-accent visual language as Toast.tsx / IndexingBanner.tsx.

   Persistent (no auto-dismiss timer, unlike Toast) because safe mode stays
   in effect for the whole session — dismissing only hides the notice, it
   does not exit safe mode; "Restart now" is the actual way out.
*/

import { useI18n } from '../i18n';

interface SafeModeBannerProps {
  onRestart: () => void;
  onDismiss: () => void;
  /** Real, measured count of consecutive unexpected closures the backend's
   *  `get_startup_recovery_state` command reported (StartupRecoveryState.
   *  consecutive) — never a guess. See this file's own module doc comment /
   *  the `startup.safeMode.message` copy for why the wording only reports
   *  this MEASURED fact and never asserts an unverified cause (disk/memory)
   *  the app never actually checked (real user report, 2026-08-01 QA: the
   *  banner told the user to free disk/memory while 46 GB were free). */
  consecutiveCrashes: number;
}

export function SafeModeBanner({ onRestart, onDismiss, consecutiveCrashes }: SafeModeBannerProps) {
  const { t } = useI18n();

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9998,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 16px',
        background: '#16161D',
        borderBottom: '1px solid rgba(251,185,36,0.32)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        fontFamily: 'var(--font-ui)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: 'rgba(251,185,36,0.14)',
          border: '1px solid rgba(251,185,36,0.32)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--color-warning-text)',
          flexShrink: 0,
        }}
      >
        !
      </span>

      <span style={{ fontSize: 12, color: '#E6E8EF', lineHeight: 1.4, flex: 1 }}>
        {t('startup.safeMode.message', { count: consecutiveCrashes })}
      </span>

      <button
        onClick={onRestart}
        style={{
          background: 'rgba(251,185,36,0.14)',
          border: '1px solid rgba(251,185,36,0.32)',
          color: 'var(--color-warning-text)',
          cursor: 'pointer',
          fontSize: 11,
          fontWeight: 600,
          lineHeight: 1,
          padding: '6px 12px',
          borderRadius: 6,
          flexShrink: 0,
          fontFamily: 'inherit',
          whiteSpace: 'nowrap',
        }}
      >
        {t('startup.safeMode.restartButton')}
      </button>

      <button
        aria-label={t('common.close')}
        onClick={onDismiss}
        style={{
          background: 'none',
          border: 'none',
          color: 'rgba(255,255,255,0.35)',
          cursor: 'pointer',
          fontSize: 14,
          lineHeight: 1,
          padding: '0 2px',
          flexShrink: 0,
          fontFamily: 'monospace',
        }}
      >
        x
      </button>
    </div>
  );
}
