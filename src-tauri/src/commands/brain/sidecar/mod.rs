//! LazyBrain sidecar process lifecycle (spawn/health/port/token) and the
//! low-level read-only fetch proxies (graph/note/search/backlinks/neighbors)
//! that talk to the running sidecar over HTTP.
//!
//! Split into focused sub-modules (the combined file was ~3050 lines):
//!   - `lock`:    cross-process single-instance guard (state/lock files under
//!                `app_local_data_dir`, stale-pid reclaim) that stops two
//!                sidecars ever writing the same on-disk brain at once.
//!   - `resolve`: `LazyBrainBin` (node_exe/script + the argv it builds),
//!                token generation, and every path-resolution helper (which
//!                binary to run, which brain path to run it against).
//!   - `init`:    `ensure_brain_init` and its whole support cast — legacy
//!                vs. canonical config detection, the one-time config
//!                migration, and the failure-marker cooldown cache.
//!   - `process`: the `BrainSidecar` child-process handle itself
//!                (spawn/stop/Drop) and `start_or_restart_brain_sidecar`,
//!                the free function that actually starts/restarts it
//!                without holding `BrainState`'s mutex across the slow wait.
//!   - `warmup`:  the readiness poll (`wait_ready_at`) and the background
//!                recall pre-warm fired once a sidecar is declared healthy.
//!   - `state`:   `BrainState` (the managed Tauri state), the app-exit stop
//!                hook, `BrainConnection`, and the shared `reqwest` client
//!                builders every HTTP call in this module tree uses.
//!   - `routing`: multi-tenant `?brainId=` query-suffix resolution
//!                (`POST /brains/open` + `active_brain_query_suffix`).
//!   - `fetch`:   the read-only `brain_fetch_*` Tauri commands that proxy
//!                graph/note/search/backlinks/neighbors over HTTP.
//!
//! All items re-exported here so existing `crate::commands::brain::sidecar::X`
//! call sites keep working unchanged.

use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) mod lock;
pub(crate) mod resolve;
pub(crate) mod init;
pub(crate) mod process;
pub(crate) mod warmup;
pub(crate) mod state;
pub(crate) mod routing;
pub(crate) mod fetch;

pub(crate) use lock::*;
pub(crate) use resolve::*;
pub(crate) use init::*;
pub(crate) use process::*;
pub(crate) use state::*;
pub(crate) use routing::*;
pub(crate) use fetch::*;

pub(crate) const BRAIN_PORT: u16 = 37990;

/// Set once the app begins shutting down (`WindowEvent::Destroyed` in
/// lib.rs, via `mark_shutting_down`) so a brain-sidecar spawn attempt still
/// in flight bails out instead of starting a brand new child process while
/// — or immediately after — the app is tearing down.
///
/// Why this matters: since the initial sidecar startup now runs on a
/// background thread (lib.rs's `.setup()`, so the window is interactive
/// immediately — see that call site) and `start_or_restart_brain_sidecar`
/// no longer holds `BrainState`'s mutex across its slow wait (fix #4), a
/// user who closes the window in the first few seconds after launch (while
/// the sidecar is still coming up) can race `stop_brain_sidecar_for_exit`
/// against THIS thread's own port-fallback retry: the exit hook kills the
/// in-progress child, `wait_ready_at` then (correctly) reports it unhealthy,
/// and — without this flag — the retry branch would spawn a NEW child
/// process right as the app exits, defeating the exact orphan-prevention
/// `stop_brain_sidecar_for_exit` exists for. Checked at the top of
/// `start_or_restart_brain_sidecar` and again before its retry, so both the
/// very first spawn attempt and the fallback-port retry are covered.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// Mark the app as shutting down — see `SHUTTING_DOWN`'s doc comment. Called
/// once, from the `WindowEvent::Destroyed` handler in lib.rs, BEFORE
/// `stop_brain_sidecar_for_exit` runs.
pub(crate) fn mark_shutting_down() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
}
