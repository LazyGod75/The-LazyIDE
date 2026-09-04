/* telemetryPrefs.ts — user opt-out for version telemetry (reportAppVersion).

   Owner decision (2026-08-12 privacy audit): reportAppVersion() in
   useSubscription.ts is genuinely light (app version +, once per launch,
   the version just auto-updated from — no file paths, no content, no user
   id on the wire, see that function's doc comment) but there was no way to
   turn it off. This module is the persisted switch.

   Plain localStorage read/write, same convention as
   src/lib/models/accessSettings.ts (loadAccessSettings/saveAccessSettings)
   — not Rust-backed like updateStore.ts's autoUpdate, because this has no
   counterpart on the Rust side to stay in sync with; it only gates a
   client-side RPC call.

   Read synchronously at the top of every reportAppVersion() call so a
   toggle flip in Settings takes effect on the very next call (mount,
   focus, or auth-state change) — no caching, no subscription needed. */

const TELEMETRY_STORAGE_KEY = 'lazy.telemetry.appVersionEnabled';

/** Default: enabled. Only an explicit `"false"` written by
 *  saveVersionTelemetryEnabled() turns it off — anything else (unset,
 *  unavailable localStorage, corrupted value) is treated as enabled. */
export function loadVersionTelemetryEnabled(): boolean {
  try {
    return localStorage.getItem(TELEMETRY_STORAGE_KEY) !== 'false';
  } catch {
    // localStorage unavailable (e.g. private browsing, SSR-like test env)
    // — fail open to the default (enabled) rather than throwing.
    return true;
  }
}

export function saveVersionTelemetryEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(TELEMETRY_STORAGE_KEY, String(enabled));
  } catch {
    // localStorage unavailable — best-effort only, same as accessSettings.ts.
  }
}
