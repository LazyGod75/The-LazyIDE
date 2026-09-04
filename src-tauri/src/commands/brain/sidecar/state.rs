//! `BrainState` (the managed Tauri state wrapping the sidecar handle), the
//! app-exit stop hook, `BrainConnection` (the honest port/token/failure-reason
//! shape exposed to the frontend), and the shared `reqwest` blocking client
//! builders every HTTP call in this module tree goes through.

use std::sync::{Arc, Mutex};

use serde::Serialize;

use super::BRAIN_PORT;
use crate::commands::brain::sidecar::process::BrainSidecar;

pub struct BrainState(pub Arc<Mutex<BrainSidecar>>);

impl Default for BrainState {
    fn default() -> Self {
        Self::new()
    }
}

impl BrainState {
    pub fn new() -> Self {
        BrainState(Arc::new(Mutex::new(BrainSidecar::new())))
    }
}

/// Best-effort stop of the sidecar held in managed `BrainState`, for the app
/// exit path (`WindowEvent::Destroyed` in `run()`, lib.rs).
///
/// `BrainSidecar`'s `Drop` impl also calls `stop()`, but `Drop` does **not**
/// run on this exit path — Tauri/winit tears down the process once the
/// `on_window_event` handler returns, before Rust gets a chance to run
/// destructors on managed state — so this must be invoked explicitly. QA
/// proved the gap: the LazyBrain sidecar (plus its own worker child
/// process) survived as an orphan after `lazy-ide.exe` had already exited.
///
/// `BrainState` is constructed exactly once per app run and mutated in
/// place across project switches (`restart_brain_sidecar` in
/// commands/brain/config.rs calls `stop()`/`start()` on the SAME instance —
/// see that function's doc comment) — so this always targets whichever
/// sidecar is CURRENTLY running, whether that is the first-launch sidecar
/// or the result of a later `set_project` restart. No separate handling is
/// needed for either case.
///
/// Never panics: a poisoned `BrainState` lock (some other thread panicked
/// while holding it) is logged and skipped rather than propagated — mirrors
/// `kill_tracked_agent_pids`'s handling of `AgentPidState` in
/// commands/agent.rs, so every piece of exit-time cleanup degrades the same
/// way instead of taking the whole shutdown path down with it.
pub(crate) fn stop_brain_sidecar_for_exit(state: &BrainState) {
    match state.0.lock() {
        Ok(mut sidecar) => sidecar.stop(),
        Err(e) => log::warn!("app exit: brain sidecar lock failed: {}", e),
    }
}

/// Return the port on which the LazyBrain daemon is listening.
#[tauri::command]
pub(crate) fn get_brain_port(state: tauri::State<BrainState>) -> u16 {
    state.0.lock().map(|s| s.port).unwrap_or(BRAIN_PORT)
}

/// Read `(port, token)` from the brain sidecar state in a single lock
/// acquisition. Falls back to `(BRAIN_PORT, String::new())` if the mutex is
/// poisoned — mirrors the existing `.unwrap_or(BRAIN_PORT)` resilience
/// pattern used throughout the `brain_fetch_*` commands below (a poisoned
/// lock already degrades those calls today; this keeps the same
/// fail-open behavior rather than introducing a new error path).
pub(crate) fn brain_port_and_token(state: &tauri::State<BrainState>) -> (u16, String) {
    state.0.lock()
        .map(|s| (s.port, s.token.clone()))
        .unwrap_or((BRAIN_PORT, String::new()))
}

/// Connection details for the small number of frontend code paths that talk
/// to the LazyBrain sidecar directly over HTTP instead of through a Rust
/// `brain_fetch_*` proxy command (currently: BrainSpace's graph/note-meta
/// direct-fetch fallback, used when the primary `invoke`-based path times
/// out). Exposes the same `port` as `get_brain_port` plus the Bearer token
/// required by the sidecar's `checkAuth` so those direct fetches are not
/// silently rejected with 401 now that auth is enabled.
///
/// Handing the token to the renderer over `invoke` is not a new trust
/// boundary: the WebView2 renderer already has far more powerful commands
/// available to it (`run_shell`, `write_file`, `git_push`, `agent_run`...),
/// so exposing a loopback-only bearer token used exclusively to talk to this
/// app's own sidecar does not widen the existing trust model.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BrainConnection {
    pub port: u16,
    pub token: String,
    /// Honest boot-time reason the sidecar cannot possibly be running (see
    /// `BrainSidecar::bin_missing`'s doc comment) — e.g.
    /// "sidecar absent (build incomplet)" when the LazyBrain binary was never
    /// found at boot (dev engine build absent AND no bundled resources).
    /// `None` in the normal case (binary found; sidecar may still be
    /// starting up, or genuinely down for some other reason) — this field is
    /// specifically for the "will NEVER start" case, not a general health
    /// check. Serializes as `binMissingReason` (struct-level camelCase).
    pub bin_missing_reason: Option<String>,
    /// Honest reason `ensure_brain_init` genuinely failed after exhausting
    /// every retry (see `BrainSidecar::init_failed_reason`'s doc comment) —
    /// `None` in the normal case (brain fine, or still starting up). Lets
    /// the frontend distinguish "init genuinely failed, a `serve` daemon
    /// may now be running against a broken brain" from every other down
    /// state, instead of silently spinning on a sidecar that will never
    /// answer correctly. Serializes as `initFailedReason`.
    pub init_failed_reason: Option<String>,
}

/// Human-readable reason surfaced via `BrainConnection.binMissingReason` —
/// single source of truth so the frontend's honest fallback string can never
/// drift from the boot log's own wording (see lib.rs's "LazyBrain bin not
/// found" branch, which sets `BrainSidecar::bin_missing`).
pub(crate) const SIDECAR_ABSENT_REASON: &str = "sidecar absent (build incomplet)";

/// Pure core of `get_brain_connection` — takes the already-extracted
/// `(port, token, bin_missing, init_failed_reason)` so it is unit-testable
/// without a live `tauri::State`/`BrainState` (mirrors this file's/config.rs's
/// established `_inner` split, e.g. `brain_fetch_health`/`brain_fetch_health_inner`).
pub(crate) fn brain_connection_from(
    port: u16,
    token: String,
    bin_missing: bool,
    init_failed_reason: Option<String>,
) -> BrainConnection {
    BrainConnection {
        port,
        token,
        bin_missing_reason: bin_missing.then(|| SIDECAR_ABSENT_REASON.to_string()),
        init_failed_reason,
    }
}

/// Return `{ port, token, binMissingReason, initFailedReason }` for
/// direct-from-webview HTTP calls to the brain sidecar. See `BrainConnection`
/// doc comment for why `port`/`token` are safe to expose via `invoke`;
/// `binMissingReason`/`initFailedReason` add honest signals for the two
/// "this will never work as-is" cases instead of a silent zero/connection-
/// refused that reads identically to "still starting up".
#[tauri::command]
pub(crate) fn get_brain_connection(state: tauri::State<BrainState>) -> BrainConnection {
    let (port, token, bin_missing, init_failed_reason) = state.0.lock()
        .map(|s| (s.port, s.token.clone(), s.bin_missing, s.init_failed_reason.clone()))
        .unwrap_or((BRAIN_PORT, String::new(), false, None));
    brain_connection_from(port, token, bin_missing, init_failed_reason)
}

/// Build a reusable `reqwest` blocking client with a caller-specified
/// connect+read timeout. `http_client()` below is the common-case 15 s
/// client; `recall_from_warm_sidecar` (commands/brain/search.rs) uses a
/// longer ceiling instead — see that call site's `RECALL_WARM_TIMEOUT_SECS`
/// doc comment for why.
pub(crate) fn http_client_with_timeout(secs: u64) -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(secs))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
}

/// Build a reusable `reqwest` blocking client with a 15-second connect+read
/// timeout.  All proxy HTTP calls (brain sidecar, teams sidecar) must go
/// through this client so they never block indefinitely.
pub(crate) fn http_client() -> reqwest::blocking::Client {
    http_client_with_timeout(15)
}

#[cfg(test)]
mod tests {
    // ── Honest boot surface: bin_missing / get_brain_connection (M12 fix) ──

    #[test]
    fn brain_connection_from_reports_no_reason_when_bin_is_present() {
        let conn = super::brain_connection_from(37990, "tok".to_string(), false, None);
        assert_eq!(conn.port, 37990);
        assert_eq!(conn.token, "tok");
        assert_eq!(conn.bin_missing_reason, None, "must not fabricate a reason when the bin was found");
        assert_eq!(conn.init_failed_reason, None, "must not fabricate an init-failed reason when none occurred");
        eprintln!("brain_connection_from_reports_no_reason_when_bin_is_present PASSED");
    }

    #[test]
    fn brain_connection_from_reports_the_absent_reason_when_bin_is_missing() {
        let conn = super::brain_connection_from(37990, "tok".to_string(), true, None);
        assert_eq!(
            conn.bin_missing_reason.as_deref(),
            Some(super::SIDECAR_ABSENT_REASON),
            "must surface the honest 'sidecar absent (build incomplet)' reason, not a silent zero"
        );
        eprintln!("brain_connection_from_reports_the_absent_reason_when_bin_is_missing PASSED");
    }

    #[test]
    fn brain_connection_from_surfaces_init_failed_reason_when_present() {
        let conn = super::brain_connection_from(
            37990,
            "tok".to_string(),
            false,
            Some("init exited with status 1 after 3/3 attempts".to_string()),
        );
        assert_eq!(
            conn.init_failed_reason.as_deref(),
            Some("init exited with status 1 after 3/3 attempts"),
            "an explicit init failure must be surfaced honestly, not silently dropped"
        );
        eprintln!("brain_connection_from_surfaces_init_failed_reason_when_present PASSED");
    }

    /// stop_brain_sidecar_for_exit must degrade gracefully on a poisoned
    /// lock (mirrors kill_tracked_agent_pids_handles_poisoned_lock_without_panicking
    /// in commands/agent.rs) — the exit hook runs during app teardown,
    /// where a panic would be especially unwelcome.
    #[test]
    fn stop_brain_sidecar_for_exit_handles_poisoned_lock_without_panicking() {
        use std::panic;
        use std::sync::Arc;
        use super::{BrainState, stop_brain_sidecar_for_exit};

        let state = BrainState::new();
        let inner = Arc::clone(&state.0);
        // Deliberately poison the mutex by panicking while holding the lock.
        let _ = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let _guard = inner.lock().expect("lock");
            panic!("intentional poison for test");
        }));

        // Must not panic — stop_brain_sidecar_for_exit logs a warning and returns.
        stop_brain_sidecar_for_exit(&state);
        eprintln!("stop_brain_sidecar_for_exit_handles_poisoned_lock_without_panicking PASSED");
    }
}
