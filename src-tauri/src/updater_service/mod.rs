//! Auto-update service — staged-disk-update-applied-at-next-boot model.
//!
//! # Why not `Update::download_and_install` / `Update::install`
//!
//! `tauri-plugin-updater` 2.10.1's Windows `install_inner` (`updater.rs:865`)
//! is `ShellExecuteW` immediately followed by an UNCONDITIONAL
//! `std::process::exit(0)`. That exit bypasses Tauri's event loop entirely —
//! `RunEvent::Exit` never fires, so `run_exit_cleanup` (lib.rs) never runs,
//! so `crash_guard::mark_clean_exit` never runs, so every update was counted
//! as a crash by `crash_guard`'s SafeMode detector. This module never calls
//! `Update::install`/`download_and_install`: the plugin is used ONLY for
//! `check()`/`download()` (to inherit minisign signature verification —
//! `Update::download` verifies before returning bytes, `updater.rs:712`).
//! Applying the update is entirely our own code, staged to disk this
//! session and executed at the START of the NEXT boot — before any
//! sidecar/agent/thread exists to lose work or need killing, and with a
//! `crash_guard::mark_clean_exit` call we control ourselves right before the
//! deliberate exit.
//!
//! # State
//!
//! Persisted at `<data_dir>/updates/state.json` (same `data_dir` root
//! `crash_guard` already resolves pre-`Builder` — see `lib.rs::run()`'s call
//! site). Atomic writes (`.json.tmp` + `fs::rename`), same idiom as
//! `crash_guard::save_history` / `state::projects_registry_save_inner`.
//!
//! # `take_boot_action` — the critical function
//!
//! Every branch is fail-open by construction: a corrupt/missing file, a
//! sha256 mismatch, a spawn failure, or repeated failed attempts all
//! degrade to "boot normally, no update this time" — NEVER a boot loop,
//! NEVER a panic. See its own doc comment for the exact branch order (it is
//! significant) and `mod tests` (`tests.rs`) for one test per branch.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

const UPDATES_DIR_NAME: &str = "updates";
const STATE_FILE_NAME: &str = "state.json";
const STATE_TMP_EXTENSION: &str = "json.tmp";

/// Windows NSIS installer naming convention this app's own release pipeline
/// already produces (`productName` = "Lazy" in `tauri.conf.json`) — matches
/// the exact example in the spec's `state.json` schema
/// (`"Lazy_0.1.12_x64-setup.exe"`).
const INSTALLER_FILE_PREFIX: &str = "Lazy";
const INSTALLER_FILE_SUFFIX: &str = "_x64-setup.exe";

/// `attempts >= this` at boot means the staged update has already failed to
/// apply this many times — give up rather than risk a silent boot loop.
const MAX_INSTALL_ATTEMPTS: u32 = 2;

const SHA256_READ_CHUNK_BYTES: usize = 64 * 1024;

/// dev/test only: when set, overrides the updater manifest endpoint via
/// `UpdaterBuilder::endpoints` instead of the real release endpoint baked
/// into `tauri.conf.json` — lets e2e verification point at a local manifest
/// server. Never read outside `build_updater`.
const DEV_ENDPOINT_ENV_VAR: &str = "LAZY_UPDATER_ENDPOINT";

const EVENT_DOWNLOAD_PROGRESS: &str = "updater://download-progress";
const EVENT_STAGED: &str = "updater://staged";

// ── Persisted state ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StagedUpdate {
    pub version: String,
    /// File name only (no directory) — the file always lives directly under
    /// `<data_dir>/updates/`.
    pub file: String,
    pub sha256: String,
    #[serde(default)]
    pub notes: Option<String>,
    /// Number of times `take_boot_action` has attempted to spawn this
    /// installer. Reaching `MAX_INSTALL_ATTEMPTS` discards the staged update
    /// rather than retrying forever.
    #[serde(default)]
    pub attempts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterState {
    #[serde(default = "default_auto_update")]
    pub auto_update: bool,
    #[serde(default)]
    pub ignored_version: Option<String>,
    #[serde(default)]
    pub last_check_at: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub staged: Option<StagedUpdate>,
    /// The version this device was running immediately before the current
    /// `staged` install was last attempted — set by `take_boot_action` in
    /// the same save as its `attempts` increment, read back (and cleared) by
    /// the NEXT boot's `take_boot_action` once it observes the update
    /// succeeded, to answer "updated from which version" for
    /// `BootAction::UpdateApplied` without needing to track it anywhere
    /// else. Not part of the spec's illustrative `state.json` shape but
    /// required to make that field meaningful; tolerantly defaulted so an
    /// older `state.json` without it still loads fine. `None` whenever no
    /// install attempt is in flight.
    #[serde(default)]
    pub installing_from: Option<String>,
}

fn default_auto_update() -> bool {
    true
}

impl Default for UpdaterState {
    fn default() -> Self {
        Self {
            auto_update: true,
            ignored_version: None,
            last_check_at: None,
            last_error: None,
            staged: None,
            installing_from: None,
        }
    }
}

fn updates_dir(dir: &Path) -> PathBuf {
    dir.join(UPDATES_DIR_NAME)
}

fn state_path(dir: &Path) -> PathBuf {
    updates_dir(dir).join(STATE_FILE_NAME)
}

/// Load `state.json`. Fail-open to `UpdaterState::default()` (autoUpdate:
/// true, nothing staged) on ANY error — missing file (first run), corrupt
/// JSON, whatever. A lost updater state is never worth blocking boot over,
/// same contract as `crash_guard::load_history`.
pub fn load_state(dir: &Path) -> UpdaterState {
    let Ok(raw) = fs::read_to_string(state_path(dir)) else {
        return UpdaterState::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Atomically persist `state` — write to a sibling `.json.tmp` then
/// `fs::rename` over the real path, so a crash mid-write can never leave a
/// half-written `state.json` for the next read. Same idiom as
/// `crash_guard::save_history` / `state::projects_registry_save_inner`.
pub fn save_state(dir: &Path, state: &UpdaterState) -> Result<(), String> {
    let dir_path = updates_dir(dir);
    fs::create_dir_all(&dir_path)
        .map_err(|e| format!("create_dir_all({}) failed: {}", dir_path.display(), e))?;

    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("failed to serialize updater state: {e}"))?;

    let path = state_path(dir);
    let tmp = path.with_extension(STATE_TMP_EXTENSION);
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("write({}) failed: {}", tmp.display(), e))?;
    fs::rename(&tmp, &path)
        .map_err(|e| format!("rename({} -> {}) failed: {}", tmp.display(), path.display(), e))?;
    Ok(())
}

// ── Boot action ───────────────────────────────────────────────────────

/// What `lib.rs::run()` should do this boot, decided by `take_boot_action`.
#[derive(Debug, Clone, PartialEq)]
pub enum BootAction {
    /// Nothing staged, or nothing actionable — boot normally.
    None,
    /// Spawn the installer at `exe_path`, then exit — `lib.rs` is
    /// responsible for `crash_guard::mark_clean_exit` before doing so (this
    /// module never touches crash_guard directly, to keep the two
    /// independently testable).
    Install { exe_path: PathBuf },
    /// The previously staged update is confirmed applied (the running
    /// binary's version is already >= what was staged) — nothing to spawn,
    /// just surfaced for logging/telemetry.
    UpdateApplied { from_version: String },
}

/// THE critical function of this module. Called once, pre-`Builder`, from
/// `lib.rs::run()`, with `current_version` = `env!("CARGO_PKG_VERSION")` of
/// the binary that is CURRENTLY running (i.e. the pre-update version, unless
/// this is the boot right after a successful install, in which case it's
/// already the new one).
///
/// Branch order is significant (matches the spec exactly):
/// 1. no `staged` → `None`.
/// 2. `staged.version <= current_version` → the update already succeeded
///    (this is the boot after a prior `Install` actually replaced the exe) —
///    clear staged state, report `UpdateApplied`.
/// 3. staged file missing, or its sha256 no longer matches → discard,
///    `None` (fail-open: a tampered/corrupt/partially-written installer is
///    never spawned).
/// 4. `attempts >= MAX_INSTALL_ATTEMPTS` → discard, `None` (fail-open: never
///    loop boot on a staged update that keeps failing to apply).
/// 5. otherwise → increment+persist `attempts`, return `Install`.
///
/// Every early-return path that mutates persisted state does so via
/// `discard_staged`/`save_state`, both of which are themselves fail-open (a
/// write failure is logged, never panics, never blocks this function from
/// returning `None`).
pub fn take_boot_action(dir: &Path, current_version: &str) -> BootAction {
    let state = load_state(dir);
    let Some(staged) = state.staged.clone() else {
        return BootAction::None;
    };

    let Ok(current) = Version::parse(current_version) else {
        log::error!(
            "updater_service: current_version '{current_version}' is not valid semver — skipping boot action (fail-open)"
        );
        return BootAction::None;
    };

    let staged_version = match Version::parse(&staged.version) {
        Ok(v) => v,
        Err(_) => {
            log::error!(
                "updater_service: staged version '{}' is not valid semver — discarding staged update",
                staged.version
            );
            discard_staged(dir, &staged);
            return BootAction::None;
        }
    };

    if staged_version <= current {
        let from_version = state.installing_from.clone().unwrap_or_else(|| "unknown".to_string());
        log::info!(
            "updater_service: staged update {} confirmed applied (now running {}) — clearing staged state",
            staged.version, current_version
        );
        discard_staged(dir, &staged);
        return BootAction::UpdateApplied { from_version };
    }

    let exe_path = updates_dir(dir).join(&staged.file);
    if !exe_path.is_file() {
        log::warn!(
            "updater_service: staged installer {} is missing — discarding staged update",
            exe_path.display()
        );
        discard_staged(dir, &staged);
        return BootAction::None;
    }

    let hash_matches = matches!(
        sha256_hex_of_file(&exe_path),
        Ok(hash) if hash.eq_ignore_ascii_case(&staged.sha256)
    );
    if !hash_matches {
        log::warn!(
            "updater_service: staged installer {} failed sha256 verification — discarding staged update",
            exe_path.display()
        );
        discard_staged(dir, &staged);
        return BootAction::None;
    }

    if staged.attempts >= MAX_INSTALL_ATTEMPTS {
        log::error!(
            "updater_service: staged update {} still not applied after {} attempt(s) — giving up (fail-open, never loop boot)",
            staged.version, staged.attempts
        );
        discard_staged(dir, &staged);
        return BootAction::None;
    }

    let mut next_state = state;
    let mut next_staged = staged;
    next_staged.attempts += 1;
    next_state.installing_from = Some(current_version.to_string());
    next_state.staged = Some(next_staged);
    if let Err(e) = save_state(dir, &next_state) {
        log::error!(
            "updater_service: failed to persist incremented boot-attempt count ({e}) — skipping install this boot (fail-open)"
        );
        return BootAction::None;
    }

    BootAction::Install { exe_path }
}

/// Best-effort: delete the staged installer file (if present) and clear
/// `staged`/`installing_from` from persisted state. Every failure is logged
/// and swallowed — this function must never be a reason `take_boot_action`
/// (or a `clear_staged`/`updater_clear_staged` caller) fails or panics.
fn discard_staged(dir: &Path, staged: &StagedUpdate) {
    let exe_path = updates_dir(dir).join(&staged.file);
    if exe_path.is_file() {
        if let Err(e) = fs::remove_file(&exe_path) {
            log::warn!("updater_service: failed to remove staged installer {}: {e}", exe_path.display());
        }
    }
    let mut state = load_state(dir);
    state.staged = None;
    state.installing_from = None;
    if let Err(e) = save_state(dir, &state) {
        log::error!("updater_service: failed to clear staged state: {e}");
    }
}

/// Write a freshly downloaded update's bytes to `<data_dir>/updates/`,
/// compute its sha256, replace any previously staged update (deleting its
/// file), and persist the new `staged` entry. Called from `updater_download`
/// right after `Update::download` returns — the caller is expected to
/// `drop` its own copy of `bytes` immediately after this returns (spec A.4:
/// never keep the downloaded bytes resident longer than necessary).
pub fn stage(dir: &Path, version: &str, notes: Option<String>, bytes: &[u8]) -> Result<StagedUpdate, String> {
    Version::parse(version).map_err(|e| format!("stage: '{version}' is not valid semver: {e}"))?;

    let dir_path = updates_dir(dir);
    fs::create_dir_all(&dir_path)
        .map_err(|e| format!("stage: create_dir_all({}) failed: {}", dir_path.display(), e))?;

    let mut state = load_state(dir);
    if let Some(previous) = state.staged.take() {
        let previous_path = dir_path.join(&previous.file);
        if previous_path.is_file() {
            if let Err(e) = fs::remove_file(&previous_path) {
                log::warn!(
                    "updater_service: failed to remove superseded staged installer {}: {e}",
                    previous_path.display()
                );
            }
        }
    }

    let file_name = installer_file_name(version);
    let file_path = dir_path.join(&file_name);
    fs::write(&file_path, bytes).map_err(|e| format!("stage: write({}) failed: {}", file_path.display(), e))?;

    let staged = StagedUpdate {
        version: version.to_string(),
        file: file_name,
        sha256: sha256_hex(bytes),
        notes,
        attempts: 0,
    };

    state.staged = Some(staged.clone());
    state.installing_from = None; // a fresh stage supersedes any prior in-flight attempt bookkeeping
    save_state(dir, &state)?;

    // Sweep any leftover `.exe` this stage's own removal above did not
    // account for (e.g. a previous `discard_staged`/`stage` whose
    // `fs::remove_file` failed at that moment) — best-effort, never a
    // reason `stage` itself fails.
    prune_orphans(dir);

    Ok(staged)
}

fn installer_file_name(version: &str) -> String {
    format!("{INSTALLER_FILE_PREFIX}_{version}{INSTALLER_FILE_SUFFIX}")
}

/// Clear whatever is currently staged (file + state), if anything. No-op
/// when nothing is staged. Used by both `updater_clear_staged` (user opts
/// out mid-flight) and available for `updater_set_auto(false)` callers who
/// want to also drop an in-flight stage — the spec's IPC contract only
/// requires the former, so only that command calls it, but the function
/// itself is generic.
pub fn clear_staged(dir: &Path) {
    let state = load_state(dir);
    if let Some(staged) = state.staged {
        discard_staged(dir, &staged);
    }
}

/// Delete every `.exe` under `<data_dir>/updates/` that is not the currently
/// staged file — cleans up leftovers from a superseded stage whose
/// `discard_staged`/`stage` cleanup step itself failed (e.g. the file was
/// locked at that exact moment), or from an older, pre-this-module layout.
/// Best-effort throughout; a missing/unreadable directory is a silent no-op,
/// never an error.
pub fn prune_orphans(dir: &Path) {
    let state = load_state(dir);
    let keep = state.staged.as_ref().map(|s| s.file.as_str());
    let dir_path = updates_dir(dir);
    let Ok(entries) = fs::read_dir(&dir_path) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("exe") {
            continue;
        }
        let is_kept =
            matches!((keep, path.file_name().and_then(|f| f.to_str())), (Some(k), Some(name)) if k == name);
        if !is_kept {
            if let Err(e) = fs::remove_file(&path) {
                log::warn!("updater_service: failed to prune orphan installer {}: {e}", path.display());
            }
        }
    }
}

// ── sha256 ────────────────────────────────────────────────────────────

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_encode(hasher.finalize().as_slice())
}

/// Streams the file through the hasher in fixed-size chunks rather than
/// `fs::read`-ing it whole — the installer can be ~100MB and this runs at
/// boot, before the window even exists; same "never hold the whole payload
/// resident" spirit as the download path itself.
fn sha256_hex_of_file(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; SHA256_READ_CHUNK_BYTES];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_encode(hasher.finalize().as_slice()))
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── Runtime (post-boot) state ────────────────────────────────────────

/// `.manage()`d once from `lib.rs::run()`. `downloading` guards
/// `updater_download` so at most one download runs at a time (spec A.4);
/// `boot_update_applied` is the `from_version` `lib.rs` observed from
/// `BootAction::UpdateApplied` at boot (if any this session) — surfaced by
/// `updater_state`, never cleared once set (a plain read-only snapshot for
/// the lifetime of the process, same contract as
/// `crash_guard::StartupCrashStateManaged`).
pub struct UpdaterRuntimeState {
    downloading: AtomicBool,
    boot_update_applied: Mutex<Option<String>>,
}

impl UpdaterRuntimeState {
    pub fn new(boot_update_applied: Option<String>) -> Self {
        Self { downloading: AtomicBool::new(false), boot_update_applied: Mutex::new(boot_update_applied) }
    }
}

fn resolve_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map_err(|e| format!("could not resolve app data dir: {e}"))
}

/// Builds the plugin's `Updater` for one `check`/`download` call. Applies
/// the `LAZY_UPDATER_ENDPOINT` dev/test override when set (see that
/// constant's own doc comment) via `UpdaterBuilder::endpoints` — verified
/// present on `tauri-plugin-updater` 2.10.1's `UpdaterBuilder`
/// (`updater.rs:197`) before use.
fn build_updater(app: &tauri::AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app.updater_builder();
    if let Ok(endpoint) = std::env::var(DEV_ENDPOINT_ENV_VAR) {
        let parsed = url::Url::parse(&endpoint)
            .map_err(|e| format!("{DEV_ENDPOINT_ENV_VAR} is not a valid URL: {e}"))?;
        builder = builder
            .endpoints(vec![parsed])
            .map_err(|e| format!("failed to apply {DEV_ENDPOINT_ENV_VAR} override: {e}"))?;
    }
    builder.build().map_err(|e| e.to_string())
}

/// Same intention as the frontend's now-retired `isBenignPlatformError`: a
/// `TargetNotFound`/`TargetsNotFound` from the plugin means "no build
/// published for this platform/arch", which is a normal, silent
/// "up-to-date" outcome for this install, never a user-visible error.
fn is_benign_platform_error(err: &tauri_plugin_updater::Error) -> bool {
    matches!(
        err,
        tauri_plugin_updater::Error::TargetNotFound(_) | tauri_plugin_updater::Error::TargetsNotFound(_)
    ) || err.to_string().to_lowercase().contains("platforms")
}

fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ── Tauri commands (IPC contract — spec A.4) ────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterCheckOut {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pub_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[tauri::command]
pub async fn updater_check(app: tauri::AppHandle) -> Result<UpdaterCheckOut, String> {
    let data_dir = resolve_data_dir(&app)?;
    let updater = build_updater(&app)?;

    let out = match updater.check().await {
        Ok(Some(update)) => UpdaterCheckOut {
            status: "available",
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            pub_date: update.date.map(|d| d.to_string()),
            message: None,
        },
        Ok(None) => UpdaterCheckOut { status: "up-to-date", version: None, notes: None, pub_date: None, message: None },
        Err(e) if is_benign_platform_error(&e) => {
            UpdaterCheckOut { status: "up-to-date", version: None, notes: None, pub_date: None, message: None }
        }
        Err(e) => {
            let message = e.to_string();
            let mut state = load_state(&data_dir);
            state.last_check_at = Some(now_iso8601());
            state.last_error = Some(message.clone());
            if let Err(save_err) = save_state(&data_dir, &state) {
                log::warn!("updater_service: failed to persist check error: {save_err}");
            }
            return Ok(UpdaterCheckOut {
                status: "error",
                version: None,
                notes: None,
                pub_date: None,
                message: Some(message),
            });
        }
    };

    let mut state = load_state(&data_dir);
    state.last_check_at = Some(now_iso8601());
    state.last_error = None;
    if let Err(e) = save_state(&data_dir, &state) {
        log::warn!("updater_service: failed to persist last_check_at: {e}");
    }

    Ok(out)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterDownloadOut {
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgressOut {
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedEventOut {
    version: String,
}

#[tauri::command]
pub async fn updater_download(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, UpdaterRuntimeState>,
) -> Result<UpdaterDownloadOut, String> {
    // Single-flight guard (spec A.4): `swap` returns the PREVIOUS value, so
    // a `true` result means another download was already in flight and this
    // call must bail out without ever touching disk/network.
    if runtime.downloading.swap(true, Ordering::SeqCst) {
        return Err("an update download is already in progress".to_string());
    }

    let result = updater_download_inner(&app).await;

    runtime.downloading.store(false, Ordering::SeqCst);
    result
}

async fn updater_download_inner(app: &tauri::AppHandle) -> Result<UpdaterDownloadOut, String> {
    let data_dir = resolve_data_dir(app)?;
    let updater = build_updater(app)?;

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return Err("no update is available to download".to_string()),
        Err(e) if is_benign_platform_error(&e) => {
            return Err("no update is available to download".to_string());
        }
        Err(e) => return Err(e.to_string()),
    };

    let version = update.version.clone();
    let notes = update.body.clone();

    let mut downloaded: u64 = 0;
    let progress_app = app.clone();
    let bytes = update
        .download(
            move |chunk_len, total| {
                downloaded += chunk_len as u64;
                let _ = progress_app.emit(EVENT_DOWNLOAD_PROGRESS, DownloadProgressOut { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    // Written to disk synchronously inside `stage` — drop our copy right
    // after so the ~100MB buffer never lingers in this task's stack/heap
    // longer than the single call that needed it (spec A.4/point 5).
    let staged = stage(&data_dir, &version, notes, &bytes)?;
    drop(bytes);

    let _ = app.emit(EVENT_STAGED, StagedEventOut { version: staged.version.clone() });

    Ok(UpdaterDownloadOut { version: staged.version })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedOut {
    pub version: String,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAppliedOut {
    pub from_version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterStateOut {
    pub current_version: String,
    pub auto_update: bool,
    pub staged: Option<StagedOut>,
    pub last_check_at: Option<String>,
    pub ignored_version: Option<String>,
    pub last_error: Option<String>,
    pub update_applied: Option<UpdateAppliedOut>,
}

#[tauri::command]
pub fn updater_state(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, UpdaterRuntimeState>,
) -> Result<UpdaterStateOut, String> {
    let data_dir = resolve_data_dir(&app)?;
    let state = load_state(&data_dir);

    let update_applied = match runtime.boot_update_applied.lock() {
        Ok(guard) => guard.clone().map(|from_version| UpdateAppliedOut { from_version }),
        Err(e) => {
            log::warn!("updater_service: boot_update_applied lock poisoned: {e}");
            None
        }
    };

    Ok(UpdaterStateOut {
        current_version: app.package_info().version.to_string(),
        auto_update: state.auto_update,
        staged: state.staged.map(|s| StagedOut { version: s.version, notes: s.notes }),
        last_check_at: state.last_check_at,
        ignored_version: state.ignored_version,
        last_error: state.last_error,
        update_applied,
    })
}

#[tauri::command]
pub fn updater_set_auto(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let data_dir = resolve_data_dir(&app)?;
    let mut state = load_state(&data_dir);
    state.auto_update = enabled;
    save_state(&data_dir, &state)
}

#[tauri::command]
pub fn updater_ignore_version(app: tauri::AppHandle, version: String) -> Result<(), String> {
    let data_dir = resolve_data_dir(&app)?;
    let mut state = load_state(&data_dir);
    state.ignored_version = Some(version);
    save_state(&data_dir, &state)
}

#[tauri::command]
pub fn updater_clear_staged(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = resolve_data_dir(&app)?;
    clear_staged(&data_dir);
    Ok(())
}

/// `request_restart` (not `AppHandle::restart`, which short-circuits straight
/// to a process respawn when called from the main thread — see its own doc
/// comment, `tauri-2.11.3/src/app.rs:582`) so this reliably goes through
/// `RunEvent::ExitRequested` + `RunEvent::Exit` regardless of which thread
/// the IPC dispatch happens to run this command on, i.e. it always reaches
/// `run_exit_cleanup` → `crash_guard::mark_clean_exit` (lib.rs) before the
/// process actually exits — exactly the "clean marker before the deliberate
/// exit" contract the rest of this module depends on.
#[tauri::command]
pub fn updater_restart_and_apply(app: tauri::AppHandle) {
    app.request_restart();
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests;
