/* AuthGate — sign-in gate for the desktop (Tauri) build.

   Behavior:
   - Web build: pass-through (demo + Playwright).
   - Desktop without Lazy Cloud config: pass-through (OSS / BYOK / CLI).
   - Desktop with Cloud: show AuthScreen. The user may create an account
     or skip (guest mode, persisted in localStorage) and use CLI/BYOK/local.
*/

import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { clearGuestMode, isGuestMode, setGuestMode } from '../../lib/auth/guestMode';
import { useAuth } from '../../lib/auth/useAuth';
import { isCloudConfigured } from '../../lib/envCloud';
import { supabaseAnonKey, supabaseUrl } from '../../lib/env';
import { isTauri } from '../../lib/platform';
import { Spinner } from '../ui';

const AuthScreen = lazy(() => import('./AuthScreen').then((m) => ({ default: m.AuthScreen })));

interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const { session, loading } = useAuth();
  const [guest, setGuest] = useState(isGuestMode);

  useEffect(() => {
    if (session) clearGuestMode();
  }, [session]);

  const handleSkip = useCallback(() => {
    setGuestMode(true);
    setGuest(true);
  }, []);

  if (!isTauri()) {
    return <>{children}</>;
  }

  if (!isCloudConfigured(supabaseUrl, supabaseAnonKey)) {
    return <>{children}</>;
  }

  if (loading) {
    return (
      <div style={styles.splash}>
        <Spinner size={28} />
      </div>
    );
  }

  if (session || guest) {
    return <>{children}</>;
  }

  return (
    <div style={styles.gate}>
      <div style={styles.gateInner}>
        <Suspense fallback={<Spinner size={28} />}>
          <AuthScreen onSkip={handleSkip} allowSkip />
        </Suspense>
      </div>
    </div>
  );
}

const styles = {
  splash: {
    position: 'fixed' as const,
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--color-bg)',
  },

  gate: {
    position: 'fixed' as const,
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    background: 'var(--color-bg)',
    overflowY: 'auto' as const,
  },

  gateInner: {
    display: 'flex',
    width: '100%',
    maxWidth: 380,
  },
} as const;
