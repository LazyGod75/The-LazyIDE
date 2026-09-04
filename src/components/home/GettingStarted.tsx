/* GettingStarted — dismissible first-run checklist on Accueil (Home).
   Three REAL checks (live state, never a scripted tour):
     1. a project is open              — projectRoot is set
     2. the AI engine is ready         — getEngineReadiness().ready
     3. a mission or first message ran — agents store mission count (passed
        in as `hasMissions`) OR the lazy.firstAssistantSend flag (set by the
        composer send path, see Composer.tsx handleSend)
   Dismiss ("Masquer") and auto-hide-once-all-done are both persisted
   per-account in localStorage, so a graduated user is never nagged again.
   Tauri only — the isTauri() gate lives here so HomeSpace can render it
   unconditionally.
*/

import { useCallback, useEffect, useState } from 'react';
import { useAppContext } from '../../app/AppContext';
import { useAuth } from '../../lib/auth/useAuth';
import { useI18n } from '../../i18n';
import { isTauri } from '../../lib/platform';
import { getEngineReadiness } from '../../lib/models/entitlement';
import { emit } from '../../lib/bus';

const FIRST_SEND_KEY = 'lazy.firstAssistantSend';
const DISMISSED_PREFIX = 'lazy.gettingStarted.dismissed';

function dismissedKey(userId: string): string {
  return `${DISMISSED_PREFIX}:${userId}`;
}

function readDismissed(userId: string | null): boolean {
  if (!userId) return false;
  try {
    return localStorage.getItem(dismissedKey(userId)) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(userId: string | null): void {
  if (!userId) return;
  try {
    localStorage.setItem(dismissedKey(userId), '1');
  } catch {
    // localStorage unavailable — silently ignore.
  }
}

function readFirstAssistantSend(): boolean {
  try {
    return localStorage.getItem(FIRST_SEND_KEY) === '1';
  } catch {
    return false;
  }
}

interface GettingStartedProps {
  /** Real per-project mission count already loaded by HomeSpace (same data
      source the agents store persists to) — avoids a second load. */
  hasMissions: boolean;
}

interface StepRowProps {
  label: string;
  done: boolean;
  actionLabel: string;
  onAction: () => void;
}

function StepRow({ label, done, actionLabel, onAction }: StepRowProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
      <span
        aria-hidden="true"
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          fontWeight: 700,
          background: done ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.06)',
          border: `1px solid ${done ? 'rgba(34,197,94,0.4)' : 'rgba(255,255,255,0.14)'}`,
          color: '#66E27A',
        }}
      >
        {done ? '✓' : ''}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 13,
          color: done ? 'var(--color-text-muted)' : 'var(--color-text)',
          textDecoration: done ? 'line-through' : 'none',
        }}
      >
        {label}
      </span>
      {!done && (
        <button
          onClick={onAction}
          style={{
            padding: '5px 12px',
            background: 'var(--color-accent)',
            border: 'none',
            borderRadius: 6,
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function GettingStarted({ hasMissions }: GettingStartedProps) {
  const { t } = useI18n();
  const { projectRoot, openProject, setActiveSpace } = useAppContext();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [dismissed, setDismissed] = useState(() => readDismissed(userId));

  const step1Done = Boolean(projectRoot);
  const step2Done = getEngineReadiness().ready;
  const step3Done = hasMissions || readFirstAssistantSend();
  const allDone = step1Done && step2Done && step3Done;

  // Auto-hide forever once all three are real and done — persisted the same
  // way as an explicit dismiss, so a graduated user is never nagged again
  // even if a later signal (e.g. closing the project) would otherwise flip
  // a step back to "undone".
  useEffect(() => {
    if (allDone) writeDismissed(userId);
  }, [allDone, userId]);

  const handleDismiss = useCallback(() => {
    writeDismissed(userId);
    setDismissed(true);
  }, [userId]);

  const goConfigureEngine = useCallback(() => {
    emit('nav:navigateSpace', 'models');
  }, []);

  const goLaunchMission = useCallback(() => {
    setActiveSpace('agents');
  }, [setActiveSpace]);

  if (!isTauri() || dismissed || allDone) return null;

  return (
    <section
      style={{
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-accent-border)',
        borderRadius: 10,
        padding: '14px 16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)', margin: 0 }}>
          {t('home.gettingStarted.title')}
        </h2>
        <button
          onClick={handleDismiss}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-text-muted)',
            fontSize: 11,
            cursor: 'pointer',
            fontFamily: 'inherit',
            padding: '2px 6px',
          }}
        >
          {t('home.gettingStarted.dismiss')}
        </button>
      </div>
      <StepRow
        label={t('home.gettingStarted.step1')}
        done={step1Done}
        actionLabel={t('home.action.openFolder')}
        onAction={() => openProject()}
      />
      <StepRow
        label={t('home.gettingStarted.step2')}
        done={step2Done}
        actionLabel={t('engine.preflight.configure')}
        onAction={goConfigureEngine}
      />
      <StepRow
        label={t('home.gettingStarted.step3')}
        done={step3Done}
        actionLabel={t('home.action.newMission')}
        onAction={goLaunchMission}
      />
    </section>
  );
}
