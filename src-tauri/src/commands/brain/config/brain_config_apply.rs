//! Validating + applying a `set_brain_config` request, and the shared
//! sidecar-restart/retry helpers every path that changes the DEFAULT brain
//! the sidecar boots on goes through.

use std::fs;
use std::path::Path;

use tauri::Manager;

use crate::state::{ProjectRegistry, ProjectState};
use crate::commands::brain::sidecar::{BrainSidecar, BrainState};

use super::bin_resolve::resolve_lazybrain_bin_static;
use super::brain_config_file::{BrainConfig, persist_brain_config};
use super::path_resolve::{BrainInfo, get_brain_info_inner, resolve_unified_brain_path};

/// Validate + normalize a `set_brain_config` request into a `BrainConfig`
/// ready to persist — split out from the `#[tauri::command]` so it's
/// unit-testable without a live AppHandle/State.
///
///   - "project": `path` is ignored; always succeeds (clears any previously
///     stored override).
///   - "global" / "custom": `path` is required and must be non-empty; the
///     directory must already exist, or be creatable (`create_dir_all`) —
///     pointing either mode at a brand new empty folder is valid and simply
///     starts a fresh brain there once the sidecar restarts and
///     `ensure_brain_init` runs (see `restart_brain_sidecar`).
///   - anything else is rejected with an actionable error.
fn validate_brain_config_request(mode: &str, path: Option<&str>) -> Result<BrainConfig, String> {
    match mode {
        "project" => Ok(BrainConfig { mode: "project".to_string(), path: None }),
        "global" | "custom" => {
            let p = path
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or_else(|| format!("brain config mode '{}' requires a non-empty path", mode))?;
            let dir = Path::new(p);
            if dir.exists() {
                if !dir.is_dir() {
                    return Err(format!("brain path exists but is not a directory: {}", p));
                }
            } else {
                fs::create_dir_all(dir)
                    .map_err(|e| format!("brain path '{}' does not exist and could not be created: {}", p, e))?;
            }
            Ok(BrainConfig { mode: mode.to_string(), path: Some(p.to_string()) })
        }
        other => Err(format!(
            "invalid brain config mode: '{}' (expected 'project', 'global', or 'custom')",
            other
        )),
    }
}

/// Restart the `BrainSidecar` on `brain_path`: `ensure_brain_init` first
/// (creates the brain if this path has never been used before), then
/// stop + start, preferring the port the sidecar was already bound to
/// (falls back to another free port if that one is no longer available).
/// Shared by `set_brain_config`, `import_brain_from_github`,
/// `brain_retry_sidecar`, and `brain_wipe` (diagnostics.rs) — every path
/// that changes which DEFAULT brain the sidecar boots on (or explicitly
/// retries the current one, or needs a clean process after a destructive
/// wipe) restarts the process the same way. `set_project`/`project_register`
/// (T0.7) no longer call this — a project switch is a registry mutex flip
/// now, not a process restart (spec section 5.2) — so this remains only for
/// the handful of paths that genuinely still need the OLD single-tenant
/// behavior. Fails open: a sidecar that doesn't become healthy is logged and
/// reported back as `Ok(false)`, never a hard `Err` — only a poisoned
/// `BrainState` lock is a hard error.
///
/// Clears every cached `brain_id` in `registry` FIRST: the multi-tenant
/// engine's brain registry (`engine/src/server/brain-registry.ts`) lives
/// only in the sidecar PROCESS's memory, so restarting that process forgets
/// every brain this app previously registered with it — a stale cached
/// `brain_id` would otherwise route the next `brain_fetch_*` call at a now-
/// unrecognized id (404). See `RegistryInner::clear_all_brain_ids`;
/// `active_brain_query_suffix` (sidecar.rs) re-resolves lazily on next use.
///
/// Delegates the actual stop/spawn/wait sequence to
/// `start_or_restart_brain_sidecar`, which does NOT hold `BrainState`'s
/// mutex across the slow (~5-10s) health-check wait — see that function's
/// doc comment. Holding it for the full duration here previously froze
/// every `brain_fetch_*`/`get_brain_port` command app-wide for the whole
/// restart (AUDIT fix #4) every time the user switched projects; this
/// function's own lock use is now just the brief read of the preferred port
/// below.
///
/// Returns whether the sidecar became healthy — `start_or_restart_brain_sidecar`
/// already computes this exact bool internally (via its blocking readiness
/// wait), so propagating it out lets `brain_retry_sidecar` report a real
/// "reconnected or still down" answer to the UI without a second probe.
/// Existing call sites that don't care (`apply_brain_config`) keep calling
/// this with a bare `...?;` — a discarded `bool` in statement position,
/// exactly as harmless as the discarded `()` it used to return.
///
/// `pub(super)`: called from `diagnostics` (`brain_wipe_inner`), a sibling
/// submodule of `config`, in addition to the callers within this file.
pub(super) fn restart_brain_sidecar(
    brain_state: &tauri::State<BrainState>,
    registry: &tauri::State<ProjectRegistry>,
    brain_path: &str,
) -> Result<bool, String> {
    if let Ok(mut guard) = registry.0.lock() {
        guard.clear_all_brain_ids();
    }

    let lb = resolve_lazybrain_bin_static().ok();
    let Some(ref lb) = lb else { return Ok(false) };

    // Store the outcome on BrainState so get_brain_connection can surface a
    // genuine init failure to the UI (see BrainSidecar::init_failed_reason's
    // doc comment) — overwritten with None below the moment init succeeds
    // again, so a healthy retry (brain_retry_sidecar) or project switch
    // naturally clears a stale reason.
    let init_failure = BrainSidecar::ensure_brain_init(lb, brain_path);
    if let Ok(mut sidecar) = brain_state.0.lock() {
        sidecar.init_failed_reason = init_failure;
    }

    let preferred_port = brain_state.0.lock()
        .map(|s| s.port)
        .map_err(|e| format!("brain state lock failed: {}", e))?;

    let healthy = crate::commands::brain::sidecar::start_or_restart_brain_sidecar(
        &brain_state.0, lb, brain_path, preferred_port,
    );
    if !healthy {
        log::warn!(
            "restart_brain_sidecar: brain sidecar did not become healthy at '{}' — brain UI will degrade to mock mode",
            brain_path
        );
    }
    Ok(healthy)
}

/// Manually retry starting the brain sidecar — the target of BrainSpace's
/// "Réessayer" button and its bounded auto-retry loop when the sidecar is
/// reported unavailable (`settings.memory.health.sidecarUnavailable`; see
/// BrainSpace.tsx's `sidecarUnavailable` state).
///
/// Force-clears any cached `.lazybrain-init-failed` marker before retrying
/// (`clear_init_failure_marker`) — the marker's cooldown
/// (`INIT_FAILURE_RETRY_AFTER_SECS`, sidecar.rs) exists to avoid re-running a
/// DETERMINISTICALLY failing init on every app launch, not to veto a
/// deliberate retry the user (or the UI, on their behalf) just asked for.
///
/// Resolves the brain path exactly like `set_brain_config`/`set_project`
/// (`resolve_unified_brain_path` over the current project root) so a retry
/// always targets whichever brain is actually active, then delegates to
/// `restart_brain_sidecar` for the real stop/ensure_brain_init/start
/// sequence. Returns `true` iff the sidecar came up healthy.
///
/// `async fn` + `spawn_blocking`: `restart_brain_sidecar` blocks on
/// `BrainSidecar::ensure_brain_init` (subprocess + retry backoff) and
/// `start_or_restart_brain_sidecar`'s readiness wait (up to ~5s, ~10s with
/// its own port-fallback retry, itself built on `reqwest::blocking` probes)
/// — same class of main-thread-starving work, and the same
/// blocking-client-dropped-in-async-context panic hazard, as
/// `project_register`; see that command's doc comment for the full
/// mechanism (and why `spawn_blocking`, not the `(async)` attribute).
#[tauri::command]
pub(crate) async fn brain_retry_sidecar(app: tauri::AppHandle) -> Result<bool, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let project_state = app.state::<ProjectState>();
        let brain_state = app.state::<BrainState>();
        let registry = app.state::<ProjectRegistry>();

        let root = project_state.0.lock()
            .map(|g| g.clone())
            .map_err(|e| format!("brain_retry_sidecar: project state lock failed: {}", e))?;
        let root_opt = if root.is_empty() { None } else { Some(root.as_str()) };
        let brain_path = resolve_unified_brain_path(root_opt);

        crate::commands::brain::sidecar::clear_init_failure_marker(&brain_path);

        restart_brain_sidecar(&brain_state, &registry, &brain_path)
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("brain_retry_sidecar: blocking task join failed: {}", e)),
    }
}

/// Core of `set_brain_config`: validate, persist, restart the sidecar on
/// the newly-resolved brain, and return the fresh `BrainInfo`. Shared with
/// `import_brain_from_github`, which reuses this after cloning + validating
/// a GitHub brain.
///
/// `pub(super)`: called from `brain_import_github`, a sibling submodule of
/// `config`, in addition to `set_brain_config` below.
pub(super) fn apply_brain_config(
    mode: &str,
    path: Option<&str>,
    app: &tauri::AppHandle,
    project_state: &tauri::State<ProjectState>,
    brain_state: &tauri::State<BrainState>,
    registry: &tauri::State<ProjectRegistry>,
) -> Result<BrainInfo, String> {
    let config = validate_brain_config_request(mode, path)?;
    persist_brain_config(app, &config)?;

    let root = project_state.0.lock()
        .map(|g| g.clone())
        .map_err(|e| format!("project state lock failed: {}", e))?;
    let root_opt = if root.is_empty() { None } else { Some(root.as_str()) };
    let new_brain_path = resolve_unified_brain_path(root_opt);
    restart_brain_sidecar(brain_state, registry, &new_brain_path)?;

    Ok(get_brain_info_inner(root_opt))
}

/// Persist the user's brain choice (Settings > Memory "choose your brain"
/// UI) and switch the running sidecar to it — no env var required.
///
/// `mode`:
///   - `"project"` — clear the stored override; falls back to
///     `<project>/.lazybrain/brain` (or `~/.lazybrain/brain` with no open
///     project), exactly as before this feature existed.
///   - `"global"` — `path` is a directory the user picked to house a
///     machine-wide brain; the brain itself lives at
///     `<path>/.lazybrain/brain`, created via `ensure_brain_init` if this is
///     the first time this directory has been chosen.
///   - `"custom"` — `path` IS the brain (or its root — see
///     `custom_brain_leaf`), e.g. one already cloned from GitHub via
///     `import_brain_from_github`, or any existing brain directory.
///
/// See `validate_brain_config_request` for the full validation contract and
/// `apply_brain_config` for the persist + sidecar-restart pipeline.
///
/// `async fn` + `spawn_blocking`: `apply_brain_config` calls
/// `restart_brain_sidecar` — see `brain_retry_sidecar`'s doc comment for the
/// blocking cost (and `reqwest::blocking` panic hazard) this keeps on the
/// blocking pool.
#[tauri::command]
pub(crate) async fn set_brain_config(
    mode: String,
    path: Option<String>,
    app: tauri::AppHandle,
) -> Result<BrainInfo, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let project_state = app.state::<ProjectState>();
        let brain_state = app.state::<BrainState>();
        let registry = app.state::<ProjectRegistry>();
        apply_brain_config(&mode, path.as_deref(), &app, &project_state, &brain_state, &registry)
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("set_brain_config: blocking task join failed: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn validate_brain_config_request_project_mode_always_clears_override() {
        let cfg = validate_brain_config_request("project", Some("/some/leftover/path"))
            .expect("project mode must always succeed");
        assert_eq!(cfg, BrainConfig { mode: "project".to_string(), path: None });
        eprintln!("validate_brain_config_request_project_mode_always_clears_override PASSED");
    }

    #[test]
    fn validate_brain_config_request_global_mode_creates_missing_directory() {
        let tmp = TempDir::new().expect("TempDir::new");
        let new_dir = tmp.path().join("brand-new-subdir");
        assert!(!new_dir.exists());

        let cfg = validate_brain_config_request("global", Some(new_dir.to_str().unwrap()))
            .expect("a creatable path must be accepted");
        assert!(new_dir.is_dir(), "validate_brain_config_request must create the directory");
        assert_eq!(cfg.mode, "global");
        assert_eq!(cfg.path.as_deref(), new_dir.to_str());
        eprintln!("validate_brain_config_request_global_mode_creates_missing_directory PASSED");
    }

    #[test]
    fn validate_brain_config_request_rejects_file_as_path() {
        let tmp = TempDir::new().expect("TempDir::new");
        let file_path = tmp.path().join("not-a-dir.txt");
        std::fs::write(&file_path, "x").expect("write file");

        let err = validate_brain_config_request("custom", Some(file_path.to_str().unwrap()))
            .expect_err("a file path must be rejected");
        assert!(err.contains("not a directory"), "{}", err);
        eprintln!("validate_brain_config_request_rejects_file_as_path PASSED");
    }

    #[test]
    fn validate_brain_config_request_rejects_missing_path_for_global_and_custom() {
        assert!(validate_brain_config_request("global", None).is_err());
        assert!(validate_brain_config_request("custom", Some("   ")).is_err());
        eprintln!("validate_brain_config_request_rejects_missing_path_for_global_and_custom PASSED");
    }

    #[test]
    fn validate_brain_config_request_rejects_invalid_mode() {
        let err = validate_brain_config_request("bogus", Some("/x")).expect_err("unknown mode must be rejected");
        assert!(err.contains("invalid brain config mode"), "{}", err);
        eprintln!("validate_brain_config_request_rejects_invalid_mode PASSED");
    }
}
