/* UpdaterService — background update scheduling + one-time "staged" toast
   (Tauri only). Renders nothing.

   Drives src/lib/updateStore.ts (single shared store — a network check
   triggered here, from Settings, or from anywhere else always goes through
   the SAME check(), never two concurrent requests — see that module's own
   dedup guard). The scheduling MATH (jitter, error backoff, the
   focus-recheck threshold) lives in updateStore.ts as pure functions
   (nextCheckDelayMs/shouldRecheckOnFocus) so it stays independently
   unit-testable; this component only owns the actual setTimeout calls.

   Schedule (auto-update spec, section B.3):
   - first check 20s after mount (never competes with the boot sequence),
   - periodic re-check every ~4h, jittered +/-25%,
   - re-check on window focus when the last check is older than 2h,
   - error backoff: 15min, doubled on every consecutive failure, capped
     at 4h (all via updateStore's errorStreak + nextCheckDelayMs),
   - autoUpdate + an available, non-ignored version -> download() in the
     background,
   - the first time phase flips to 'staged' for a given version -> a
     single, non-sticky toast (10s) with a "Restart now" action. Tracked
     per-version via updateStore's hasShownStagedToast/markStagedToastShown
     (localStorage), so it never repeats for the same build even across
     relaunches of the app before the update is actually applied.

   Mounted once, inside ToastProvider (AppShell), so the toast action has
   context. Renamed from UpdaterStartupCheck.tsx — same mount point
   (AppShell.tsx), now a full scheduler instead of a single fire-and-forget
   check + local-only toast.
*/

import { useEffect } from 'react';
import { useI18n } from '../../i18n';
import { useToast } from '../ui/Toast';
import { isTauri } from '../../lib/platform';
import {
  useUpdateStore,
  getUpdateState,
  check,
  download,
  nextCheckDelayMs,
  shouldRecheckOnFocus,
  hasShownStagedToast,
  markStagedToastShown,
} from '../../lib/updateStore';

const INITIAL_CHECK_DELAY_MS = 20_000;
const TOAST_DURATION_MS = 10_000;

// Module-level guard: React StrictMode double-invokes effects in dev.
let started = false;

/** Test-only reset — mirrors updateStore's own _resetUpdateStoreForTests
    convention: without this, a second test in the same file would see
    `started === true` left over from the first and silently schedule
    nothing. */
export function _resetUpdaterServiceForTests(): void {
  started = false;
}

/** check() then, if policy allows, download() the result in the background.
    Reads state via getUpdateState() (not a React value) so it stays correct
    across an arbitrary number of scheduled ticks without any component
    re-render in between. */
async function runCheckAndMaybeDownload(): Promise<void> {
  await check();
  const state = getUpdateState();
  if (state.autoUpdate && state.phase === 'available' && state.version !== state.ignoredVersion) {
    void download();
  }
}

export function UpdaterService() {
  const { t } = useI18n();
  const { toast } = useToast();
  const store = useUpdateStore();

  useEffect(() => {
    if (started || !isTauri()) return;
    started = true;

    let cancelled = false;
    const pending = new Set<ReturnType<typeof setTimeout>>();

    function schedule(fn: () => void, delayMs: number): void {
      const id = setTimeout(() => {
        pending.delete(id);
        if (!cancelled) fn();
      }, delayMs);
      pending.add(id);
    }

    async function tick(): Promise<void> {
      await runCheckAndMaybeDownload();
      if (cancelled) return;
      const { errorStreak } = getUpdateState();
      schedule(() => void tick(), nextCheckDelayMs({ errorStreak }, Date.now()));
    }

    schedule(() => void tick(), INITIAL_CHECK_DELAY_MS);

    function handleFocus(): void {
      if (shouldRecheckOnFocus(getUpdateState().lastCheckAt, Date.now())) {
        void runCheckAndMaybeDownload();
      }
    }
    window.addEventListener('focus', handleFocus);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleFocus);
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  // Separate effect: fires whenever phase/version change, regardless of
  // which check triggered the transition (the schedule above, a manual
  // Settings check, or Settings' own download()) — the whole point of a
  // shared store is that every surface observes the same terminal state.
  useEffect(() => {
    if (!isTauri()) return;
    if (store.phase !== 'staged' || !store.version) return;
    if (hasShownStagedToast(store.version)) return;

    markStagedToastShown(store.version);
    const title = t('settings.update.stagedTitle', { version: store.version });
    const body = t('settings.update.stagedBody');
    toast(`${title} — ${body}`, 'success', TOAST_DURATION_MS, {
      label: t('settings.update.restartNow'),
      onClick: () => { void store.restartAndApply(); },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.phase, store.version]);

  return null;
}
