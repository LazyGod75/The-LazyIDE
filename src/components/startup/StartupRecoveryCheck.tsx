/* StartupRecoveryCheck — boot-time crash-recovery UX. Mirrors
   UpdaterService.tsx's own mount-once-per-session pattern exactly
   (module-level `started` guard against StrictMode's double-invoke).

   Reads the shared, cached src/lib/startupRecovery.ts fetch (also read by
   agentsStore.tsx's boot pass, so both agree on the same snapshot) and:
     - 'recovered'  -> one non-blocking toast, no persistent UI.
     - 'safe_mode'  -> a persistent, dismissible SafeModeBanner with a
                       "Restart now" action wired to the existing
                       restartAndApplyUpdate() (src/lib/updater.ts), which
                       goes through RunEvent::Exit -> run_exit_cleanup() for
                       a clean restart.
     - 'clean'      -> no-op (the overwhelmingly common case).

   Mounted inside ToastProvider (AppShell), same as UpdaterService, so
   the toast has context.
*/

import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { useToast } from '../ui/Toast';
import { getStartupRecoveryState } from '../../lib/startupRecovery';
import { restartAndApplyUpdate } from '../../lib/updater';
import { SafeModeBanner } from '../SafeModeBanner';

// Module-level guard: React StrictMode double-invokes effects in dev.
let started = false;

export function StartupRecoveryCheck() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [safeMode, setSafeMode] = useState(false);
  // Real, measured crash count (StartupRecoveryState.consecutive) — the
  // banner's own honesty fix reports THIS, never an unverified disk/memory
  // diagnosis (see SafeModeBanner.tsx's consecutiveCrashes doc comment).
  const [consecutiveCrashes, setConsecutiveCrashes] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (started) return;
    started = true;

    void getStartupRecoveryState().then((result) => {
      if (result.state === 'recovered') {
        toast(t('startup.recoveredToast'), 'info', 6000);
      } else if (result.state === 'safe_mode') {
        setConsecutiveCrashes(result.consecutive);
        setSafeMode(true);
      }
    });
  }, [t, toast]);

  if (!safeMode || dismissed) return null;

  return (
    <SafeModeBanner
      onRestart={() => { void restartAndApplyUpdate(); }}
      onDismiss={() => setDismissed(true)}
      consecutiveCrashes={consecutiveCrashes}
    />
  );
}
