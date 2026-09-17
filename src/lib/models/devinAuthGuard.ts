/* devinAuthGuard — client-side circuit breaker for the Devin CLI backend.

   Why it exists (2026-09, real user report): every `devin acp` spawn that
   hits a rejected/stale credential can make the CLI open an OAuth tab in
   the system browser. Any retrying caller — wakeup poller, routine tick,
   failover chain, model-catalog refresh — then produces one tab per spawn:
   a browser-tab storm. The Rust backend got the same breaker in chat.rs,
   but that only helps a rebuilt binary; THIS guard stops the JS side from
   invoking `devin_list_models` / `agent_cli_chat_stream` at all while a
   failure is recent — so it protects the currently-running app too.

   Two trigger paths:
     1. An auth-shaped error message (401/unauthorized/credential/login…)
        engages immediately — retrying cannot help without re-login.
     2. Any N failures inside a short window — covers opaque error codes
        the auth heuristic misses.

   The block lifts automatically when the cooldown elapses, when the app
   restarts (state is module-local), when `devin auth login` rewrites
   credentials.toml (mtime probe — same signal the Rust breaker uses), or
   explicitly via resetDevinAuthGuard.
*/

const AUTH_COOLDOWN_MS = 15 * 60 * 1000;
const GENERIC_WINDOW_MS = 2 * 60 * 1000;
const GENERIC_THRESHOLD = 3;
const GENERIC_COOLDOWN_MS = 10 * 60 * 1000;

const AUTH_BLOCKED_MSG =
  'Devin CLI rejected the stored credential — run `devin auth login` once, then retry. (Attempts are paused for a while to avoid opening more auth tabs.)';
const GENERIC_BLOCKED_MSG =
  'Devin CLI keeps failing — attempts paused for a few minutes. Check `devin auth status` / your network, then retry.';
const NOT_LOGGED_IN_MSG =
  'Devin CLI is not logged in — run `devin auth login` once, then retry. (Spawns paused so no auth tabs open.)';

let blockedUntil = 0;
let blockedMsg = AUTH_BLOCKED_MSG;
let genericFailures: number[] = [];
let blockedCredMtime: number | null = null;
let credBaselineStored = false;
let mtimeProbeRunning = false;
let credsPresenceProbed = false;

/** Reads the credentials.toml mtime via the backend. On first call stores
 *  the baseline; when a later read differs, `devin auth login` rewrote the
 *  file and the block lifts — the user never waits out the cooldown.
 *  `credBaselineStored` exists because null is ambiguous: it means both
 *  "no baseline yet" and "baseline = file missing". A file APPEARING after
 *  a missing baseline is a login — it must lift a NOT_LOGGED_IN block. */
async function probeCredMtime(): Promise<void> {
  if (mtimeProbeRunning) return;
  mtimeProbeRunning = true;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const mtime = await invoke<number | null>('devin_credentials_mtime_ms');
    if (!credBaselineStored) {
      blockedCredMtime = mtime;
      credBaselineStored = true;
    } else if (mtime !== blockedCredMtime) {
      resetDevinAuthGuard();
    }
  } catch {
    /* no tauri runtime (tests) or unreadable file — keep the block */
  } finally {
    mtimeProbeRunning = false;
  }
}

/** True when an error string looks like a genuine credential rejection —
 *  the only failure class where retrying the same key cannot help. Mirrors
 *  chat.rs's is_devin_auth_failure exactly: deliberately does NOT match
 *  bare "auth" (a timeout ON the `authenticate` RPC contains the method
 *  name — real incident: flaky network armed the 15-min breaker
 *  mid-mission) nor "forbidden"/"permission" (quota/concurrency errors). */
export function isDevinAuthError(message: string): boolean {
  const l = message.toLowerCase();
  return (
    l.includes('401') ||
    l.includes('403') ||
    l.includes('unauthorized') ||
    // "authentication" (the noun — the thing that failed), never bare
    // "auth"/"authenticate" (the RPC method name appears in timeouts).
    l.includes('authentication') ||
    // Devin's own "run devin auth login" guidance is auth-shaped; the
    // bare word "authenticate" (RPC method) never is.
    l.includes('auth login') ||
    l.includes('invalid api key') ||
    (l.includes('api key') && l.includes('reject')) ||
    l.includes('not authenticated') ||
    l.includes('not logged in') ||
    l.includes('invalid credential') ||
    l.includes('expired credential') ||
    l.includes('bad credentials') ||
    // Our own breaker message IS auth-shaped by design — when the Rust
    // side blocks, its error text must keep this guard engaged too.
    l.includes('rejected the stored credential')
  );
}

/** Some(message) while the breaker is engaged — callers must NOT invoke
 *  any command that spawns `devin acp`. */
export function devinAuthBlocked(): string | null {
  return Date.now() < blockedUntil ? blockedMsg : null;
}

/** One-shot pre-arm: asks the backend whether the stored credential can
 *  actually authenticate. Without it the breaker was purely REACTIVE:
 *  module-local, so every app relaunch spawned `devin acp` blind — each
 *  spawn with dead credentials popping an OAuth tab — until the first
 *  failure landed (the 2026-09-15/17 auth-tab storms).
 *
 *  Two probes, safest first:
 *    1. `devin_auth_probe` — spawns `devin acp` and runs the real
 *       initialize→authenticate handshake (methodId windsurf-api-key,
 *       which NEVER opens a browser). Catches the file-present-but-key-
 *       rejected case AND the session-token format `devin auth status`
 *       falsely reports as logged-out.
 *    2. `devin_auth_status` — credentials.toml content check (older
 *       backends without the probe command land here).
 *  Either answering "no usable credential" arms the block BEFORE the first
 *  spawn instead of after it. Both failing (non-Tauri, old exe, probe
 *  indeterminate) leaves the reactive path in charge. */
async function probeCredentialPresence(): Promise<void> {
  if (credsPresenceProbed) return;
  credsPresenceProbed = true;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // The live probe does a real ACP handshake (~1-2s) — a wedged CLI must
    // never stall the guard (every guarded caller waits on this).
    // Indeterminate after 10s → fall through to the file check.
    const probeTimeout = new Promise<null>((r) => setTimeout(() => r(null), 10_000));
    let authed: boolean | null;
    try {
      authed = await Promise.race([invoke<boolean>('devin_auth_probe'), probeTimeout]);
    } catch {
      authed = await invoke<boolean>('devin_auth_status').catch(() => null);
    }
    if (authed === false && Date.now() >= blockedUntil) {
      blockedUntil = Date.now() + AUTH_COOLDOWN_MS;
      blockedMsg = NOT_LOGGED_IN_MSG;
      // Await the baseline probe: fired-and-forgotten it races the next
      // guarded call, which then sees mtimeProbeRunning and returns the
      // stale block even after `devin auth login` rewrote the file.
      await probeCredMtime();
    }
  } catch {
    /* non-Tauri runtime (tests/web) or backend older than the command —
       nothing to pre-arm; the reactive path still applies. */
  }
}

/** Async variant: while blocked on an auth failure, first re-checks the
 *  credentials file so a fresh `devin auth login` unblocks immediately
 *  instead of waiting out the cooldown. Also pre-arms on first call when
 *  no credential exists on disk (see probeCredentialPresence). */
export async function devinAuthBlockedAsync(): Promise<string | null> {
  await probeCredentialPresence();
  if (Date.now() >= blockedUntil) return null;
  if (blockedMsg !== GENERIC_BLOCKED_MSG) await probeCredMtime();
  return Date.now() < blockedUntil ? blockedMsg : null;
}

/** Record a failure from a Devin CLI call. Auth-shaped errors engage the
 *  breaker immediately; anything else counts toward the generic streak. */
export function noteDevinFailure(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (isDevinAuthError(msg)) {
    blockedUntil = Date.now() + AUTH_COOLDOWN_MS;
    blockedMsg = AUTH_BLOCKED_MSG;
    blockedCredMtime = null;
    void probeCredMtime();
    return;
  }
  const cutoff = Date.now() - GENERIC_WINDOW_MS;
  genericFailures = [...genericFailures.filter((t) => t > cutoff), Date.now()];
  if (genericFailures.length >= GENERIC_THRESHOLD) {
    blockedUntil = Date.now() + GENERIC_COOLDOWN_MS;
    blockedMsg = GENERIC_BLOCKED_MSG;
    genericFailures = [];
  }
}

/** Clear the breaker — call after the user re-authenticates
 *  (`devin auth login`) or asks to retry. Re-arms the presence probe so a
 *  still-missing credential re-engages on the next guarded call instead of
 *  silently unblocking into another tab storm. */
export function resetDevinAuthGuard(): void {
  blockedUntil = 0;
  genericFailures = [];
  blockedCredMtime = null;
  credBaselineStored = false;
  credsPresenceProbed = false;
}
