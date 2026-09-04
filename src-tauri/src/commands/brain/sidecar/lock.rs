//! Cross-process sidecar single-instance guard + stale-pid reclaim.
//!
//! Fix #2 (P42 follow-up): fix #1 (lib.rs's `RunEvent::Exit` handling) closes
//! the orphan-on-restart gap GOING FORWARD, but cannot retroactively clean up
//! a sidecar left behind by an app instance that crashed, was killed by the
//! OS/Task Manager, or otherwise never reached ANY exit-cleanup path in a
//! PREVIOUS run. Without this, that orphaned `node lazybrain.js serve`
//! process keeps running (and keeps its SQLite brain file open) forever,
//! and the NEXT app launch spawns a completely independent second sidecar
//! against the SAME on-disk brain — two writers, a real corruption risk —
//! with no user action able to notice or fix it (violates the "never
//! saturates the machine, no manual unblocking" guarantee just as badly as
//! the orphan itself).
//!
//! A small on-disk record per distinct brain path, centrally located under
//! `app_local_data_dir` (NOT inside the brain path itself — a "custom"/
//! "global" brain choice, see `resolve_brain_path`, may point anywhere on
//! disk, whereas app_local_data_dir is always guaranteed writable by this
//! app), closes this: every spawn attempt reclaims (tree-kills) whatever
//! live pid a PREVIOUS attempt recorded for this exact brain path before
//! spawning its own, then records its own pid+port for the NEXT attempt to
//! find in turn.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use sha1_smol::Sha1;

use crate::commands::util::{quiet_command, tree_kill_args};

/// Cached `app_local_data_dir`, exposed once at boot (lib.rs's `.setup()`,
/// alongside the existing `expose_app_config_dir`) so call sites with no
/// `AppHandle` in scope — `start_or_restart_brain_sidecar`, invoked both
/// from lib.rs's boot thread AND from `restart_brain_sidecar`
/// (commands/brain/config.rs) on every project switch/retry — can still
/// resolve the central directory the guard below lives under. Mirrors
/// `expose_app_config_dir`/`app_config_dir_from_env` (config.rs) exactly:
/// same env-var-as-a-cache trick, just a second independent directory, kept
/// here (not config.rs) since this mechanism is entirely sidecar-internal.
pub(crate) fn expose_app_local_data_dir(dir: &Path) {
    std::env::set_var("LAZY_APP_LOCAL_DATA_DIR", dir.to_string_lossy().into_owned());
}

fn app_local_data_dir_from_env() -> Option<PathBuf> {
    std::env::var("LAZY_APP_LOCAL_DATA_DIR").ok().map(PathBuf::from)
}

/// Subdirectory (of `app_local_data_dir`) holding one state/lock file pair
/// per distinct brain path this app has ever spawned a sidecar against.
const SIDECAR_STATE_SUBDIR: &str = "lazybrain-sidecars";

/// On-disk record of the most recently spawned sidecar for a given brain
/// path — written only after that sidecar became healthy (see
/// `record_sidecar_state`), read back by the NEXT spawn attempt (this
/// process restarting, or a later app launch) to decide whether a live
/// orphan needs reclaiming first (`reclaim_stale_sidecar`).
#[derive(Debug, Serialize, Deserialize)]
struct SidecarStateRecord {
    pid: u32,
    port: u16,
}

/// Stable hex digest identifying `brain_path` for the state/lock filenames
/// below — reuses `sha1_smol` (already a dependency via `util::project_id_for_root`'s
/// identical technique) rather than adding a new hashing crate.
fn sidecar_profile_hash(brain_path: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(brain_path.as_bytes());
    hasher.digest().to_string()
}

fn sidecar_state_dir() -> Option<PathBuf> {
    app_local_data_dir_from_env().map(|d| d.join(SIDECAR_STATE_SUBDIR))
}

fn sidecar_state_path(brain_path: &str) -> Option<PathBuf> {
    sidecar_state_dir().map(|d| d.join(format!("{}.json", sidecar_profile_hash(brain_path))))
}

fn sidecar_lock_path(brain_path: &str) -> Option<PathBuf> {
    sidecar_state_dir().map(|d| d.join(format!("{}.lock", sidecar_profile_hash(brain_path))))
}

/// Best-effort liveness probe. Windows: parses `tasklist`'s CSV output for
/// an exact pid match (avoids a heavier `OpenProcess`/`GetExitCodeProcess`
/// WinAPI dance for what is only ever a best-effort check — a spawn failure
/// here just means the reclaim step degrades to "assume not alive", never a
/// hard error). Non-Windows: a signal-0 `kill()` (checks existence without
/// actually signaling), mirroring `BrainSidecar::stop`'s existing
/// `#[cfg(not(target_os = "windows"))]` fallback.
#[cfg(target_os = "windows")]
fn pid_is_alive(pid: u32) -> bool {
    match quiet_command("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/NH", "/FO", "CSV"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    {
        Ok(out) => String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()),
        Err(_) => false,
    }
}

#[cfg(not(target_os = "windows"))]
fn pid_is_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// Tree-kill `pid` — the exact `taskkill /PID <pid> /T /F` (or `SIGKILL` on
/// non-Windows) `BrainSidecar::stop` already uses, extracted so both the
/// in-process stop path and this cross-process reclaim path share one
/// implementation instead of two hand-kept-in-sync copies.
fn tree_kill_pid(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = quiet_command("taskkill").args(tree_kill_args(pid)).output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsafe { libc::kill(pid as i32, libc::SIGKILL); }
    }
}

fn read_recorded_pid(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// Best-effort: if a previous spawn attempt for `brain_path` recorded a pid
/// in its on-disk state file AND that pid is still alive, tree-kill it
/// before this attempt spawns a fresh one.
///
/// The recorded pid is reclaimed UNCONDITIONALLY whenever it is alive,
/// regardless of why — an orphan left by a previous app instance that
/// crashed/was killed before ever reaching an exit-cleanup path (fix #1
/// above closes this for THIS instance going forward, but cannot
/// retroactively fix an already-dead one), or a second, genuinely
/// concurrently-running app instance racing this same brain path. Two
/// sidecars writing the same on-disk brain (SQLite) at once is a strictly
/// worse outcome than unconditionally reclaiming — mirrors
/// `BrainSidecar::spawn_at`'s existing "stop whatever was there first"
/// policy for the in-process restart case, just extended across process
/// boundaries via this on-disk record.
///
/// No-op (never blocks a spawn) when `app_local_data_dir` has not been
/// exposed yet (e.g. a unit test with no env var set) — degrades to
/// exactly today's behavior (no cross-process guard at all), never a hard
/// failure over a missing directory.
pub(crate) fn reclaim_stale_sidecar(brain_path: &str) {
    let Some(state_path) = sidecar_state_path(brain_path) else { return };
    let Some(record) = std::fs::read_to_string(&state_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<SidecarStateRecord>(&raw).ok())
    else {
        return;
    };
    if pid_is_alive(record.pid) {
        log::warn!(
            "brain sidecar: reclaiming a live sidecar (pid={}, port={}) recorded for '{}' — tree-killing before spawning a fresh one",
            record.pid, record.port, brain_path
        );
        tree_kill_pid(record.pid);
    }
    let _ = std::fs::remove_file(&state_path);
}

/// Best-effort: record the freshly-spawned (and now-healthy) sidecar's
/// pid+port so a FUTURE spawn attempt (this same process's next restart, or
/// a later app launch) can find and reclaim it if it ever survives as an
/// orphan. Overwrites unconditionally — the newest spawn for this
/// `brain_path` is always the one worth tracking.
pub(crate) fn record_sidecar_state(brain_path: &str, pid: u32, port: u16) {
    let Some(path) = sidecar_state_path(brain_path) else { return };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::debug!("brain sidecar: could not create state dir {}: {}", parent.display(), e);
            return;
        }
    }
    match serde_json::to_string(&SidecarStateRecord { pid, port }) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                log::debug!("brain sidecar: could not write state file {}: {}", path.display(), e);
            }
        }
        Err(e) => log::debug!("brain sidecar: could not serialize sidecar state record: {}", e),
    }
}

/// RAII advisory lock guarding concurrent spawn ATTEMPTS for the SAME
/// `brain_path` — closes the narrow TOCTOU window `reclaim_stale_sidecar` /
/// `record_sidecar_state` alone cannot: two attempts (e.g. the app launched
/// twice within the same second) racing to read "no live pid recorded yet"
/// and both proceeding to spawn a second writer against the same on-disk
/// brain before either has finished its (~5-10s) health-check wait and
/// recorded its own pid.
///
/// Backed by `create_new` (an atomic, exclusive file create — the `O_EXCL`
/// equivalent) rather than a third-party crate (fs4/etc.) — keeps this
/// dependency-free per this fix's own "keep deps minimal" instruction. Held
/// for the WHOLE spawn attempt (acquired once at the top of
/// `start_or_restart_brain_sidecar`, released automatically on every return
/// path via `Drop` — mirrors `BoundedGatePermit`'s drop-releases pattern in
/// commands/util.rs) rather than just the initial check, so it actually
/// covers the full "reclaim + spawn + health-check + record" critical
/// section, not merely the instant of the check.
pub(crate) struct SidecarSpawnLock(Option<PathBuf>);

impl Drop for SidecarSpawnLock {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Atomically create `path` (fails if it already exists) and write this
/// process's own pid into it — used both for the first attempt and the
/// stale-lock-reclaim retry in `acquire_sidecar_spawn_lock`.
fn try_create_lock_file(path: &Path) -> bool {
    match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut f) => {
            let _ = f.write_all(std::process::id().to_string().as_bytes());
            true
        }
        Err(_) => false,
    }
}

/// Acquire the spawn lock for `brain_path`. `Err(())` means a genuinely live
/// holder is mid-spawn right now — the caller must skip this attempt
/// entirely (never block/retry-loop: the OTHER attempt's own health-check
/// wait will finish on its own, and this instance's brain UI simply
/// degrades to "not yet healthy", same as any other transient sidecar-down
/// state, no user action required).
///
/// A STALE lock (its recorded owner pid no longer alive — the previous
/// holder crashed mid-spawn, before ever removing its own lock file) is
/// reclaimed exactly once rather than permanently wedging every future
/// spawn shut — matching this codebase's "never require manual unblocking"
/// standard (the same standard fix #1's `RunEvent::Exit` handling and this
/// whole fix exist to uphold).
pub(crate) fn acquire_sidecar_spawn_lock(brain_path: &str) -> Result<SidecarSpawnLock, ()> {
    let Some(lock_path) = sidecar_lock_path(brain_path) else {
        // No app_local_data_dir resolved (e.g. a unit test with no env var
        // exposed) — degrade to "no locking" rather than ever blocking a
        // spawn over a missing directory.
        return Ok(SidecarSpawnLock(None));
    };
    if let Some(parent) = lock_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    if try_create_lock_file(&lock_path) {
        return Ok(SidecarSpawnLock(Some(lock_path)));
    }

    // Lock already exists — reclaim it if its recorded owner is no longer
    // alive; otherwise a genuine concurrent spawn attempt holds it right now.
    if let Some(owner_pid) = read_recorded_pid(&lock_path) {
        if !pid_is_alive(owner_pid) {
            log::warn!(
                "brain sidecar spawn lock: reclaiming a stale lock (owner pid {} is gone) for '{}'",
                owner_pid, brain_path
            );
            let _ = std::fs::remove_file(&lock_path);
            if try_create_lock_file(&lock_path) {
                return Ok(SidecarSpawnLock(Some(lock_path)));
            }
        }
    }
    Err(())
}

#[cfg(test)]
mod tests {
    // ── Cross-process sidecar single-instance guard (fix #2) ───────────
    //
    // NOTE ON ENV VAR SAFETY: only the tests below ever touch
    // `LAZY_APP_LOCAL_DATA_DIR` in this whole crate (mirrors the same
    // "only tests that need it touch it" caution already documented for
    // `USERPROFILE`/`HOME` in maintenance.rs's tests), so this cannot race
    // any OTHER test in the binary. It CAN, however, race against EACH
    // OTHER: `cargo test` runs every test in this binary on multiple
    // threads BY DEFAULT (not just `#[test]`-per-file — the whole binary),
    // and this is one process-global env var, so two of the tests below
    // running concurrently would otherwise stomp each other's value/restore
    // (confirmed: reproduced as a real flaky failure under plain `cargo
    // test` before this mutex was added — `--test-threads=1` alone had
    // masked it). `ENV_VAR_LOCK` below serializes just these tests against
    // each other; every other test in the binary keeps running fully in
    // parallel.
    static ENV_VAR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// RAII guard restoring `LAZY_APP_LOCAL_DATA_DIR` to its original value
    /// (or removing it) on drop, including during a panic — same shape as
    /// maintenance.rs's own `EnvVarGuard`, duplicated locally rather than
    /// shared across modules since it is a small, fully self-contained test
    /// helper. Holds `ENV_VAR_LOCK` for its entire lifetime (see that
    /// static's doc comment) so construction, the env var's lifetime, and
    /// its restore-on-drop are one atomic critical section from every other
    /// test using this same guard.
    struct EnvVarGuard {
        original: Option<String>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl EnvVarGuard {
        fn set_local_data_dir(dir: &std::path::Path) -> Self {
            let lock = ENV_VAR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let original = std::env::var("LAZY_APP_LOCAL_DATA_DIR").ok();
            super::expose_app_local_data_dir(dir);
            Self { original, _lock: lock }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(v) => std::env::set_var("LAZY_APP_LOCAL_DATA_DIR", v),
                None => std::env::remove_var("LAZY_APP_LOCAL_DATA_DIR"),
            }
        }
    }

    #[test]
    fn sidecar_profile_hash_is_stable_and_distinct_per_brain_path() {
        let a1 = super::sidecar_profile_hash(r"C:\Users\dev\brain-a");
        let a2 = super::sidecar_profile_hash(r"C:\Users\dev\brain-a");
        let b = super::sidecar_profile_hash(r"C:\Users\dev\brain-b");

        assert_eq!(a1, a2, "the same brain path must always hash the same");
        assert_ne!(a1, b, "distinct brain paths must not collide");
        assert!(a1.chars().all(|c| c.is_ascii_hexdigit()), "must be a hex digest, got: {}", a1);
        eprintln!("sidecar_profile_hash_is_stable_and_distinct_per_brain_path PASSED");
    }

    #[test]
    fn pid_is_alive_reports_true_for_the_current_process() {
        assert!(super::pid_is_alive(std::process::id()), "this test's own process must report alive");
        eprintln!("pid_is_alive_reports_true_for_the_current_process PASSED");
    }

    #[test]
    fn pid_is_alive_reports_false_for_an_implausible_pid() {
        assert!(!super::pid_is_alive(u32::MAX), "an implausible pid must report not-alive");
        eprintln!("pid_is_alive_reports_false_for_an_implausible_pid PASSED");
    }

    #[test]
    fn acquire_sidecar_spawn_lock_creates_and_releases_the_lock_file_on_drop() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let _env = EnvVarGuard::set_local_data_dir(tmp.path());

        let brain_path = "brain-a";
        let lock_path = super::sidecar_lock_path(brain_path).expect("lock path must resolve once env is set");

        {
            let guard = super::acquire_sidecar_spawn_lock(brain_path).expect("must acquire a fresh lock");
            assert!(lock_path.exists(), "lock file must exist while the guard is held");
            drop(guard);
        }
        assert!(!lock_path.exists(), "lock file must be removed once the guard drops");
        eprintln!("acquire_sidecar_spawn_lock_creates_and_releases_the_lock_file_on_drop PASSED");
    }

    #[test]
    fn acquire_sidecar_spawn_lock_refuses_when_a_live_owner_holds_it() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let _env = EnvVarGuard::set_local_data_dir(tmp.path());

        let brain_path = "brain-b";
        let lock_path = super::sidecar_lock_path(brain_path).expect("lock path must resolve");
        std::fs::create_dir_all(lock_path.parent().unwrap()).unwrap();
        // Simulate another process's live lock by recording THIS test
        // process's own pid — guaranteed alive for the duration of the test.
        std::fs::write(&lock_path, std::process::id().to_string()).expect("seed a live-owner lock file");

        let result = super::acquire_sidecar_spawn_lock(brain_path);
        assert!(result.is_err(), "a lock held by a genuinely live pid must not be acquired");
        assert!(lock_path.exists(), "a refused acquisition must leave the live owner's lock file untouched");
        eprintln!("acquire_sidecar_spawn_lock_refuses_when_a_live_owner_holds_it PASSED");
    }

    #[test]
    fn acquire_sidecar_spawn_lock_reclaims_a_stale_lock_left_by_a_dead_pid() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let _env = EnvVarGuard::set_local_data_dir(tmp.path());

        let brain_path = "brain-c";
        let lock_path = super::sidecar_lock_path(brain_path).expect("lock path must resolve");
        std::fs::create_dir_all(lock_path.parent().unwrap()).unwrap();
        // An implausible pid — the previous holder crashed without cleaning
        // up its own lock file.
        std::fs::write(&lock_path, u32::MAX.to_string()).expect("seed a stale lock file");

        let guard = super::acquire_sidecar_spawn_lock(brain_path);
        assert!(guard.is_ok(), "a lock whose recorded owner is dead must be reclaimed, not permanently refused");
        eprintln!("acquire_sidecar_spawn_lock_reclaims_a_stale_lock_left_by_a_dead_pid PASSED");
    }

    #[test]
    fn record_and_reclaim_sidecar_state_roundtrips_through_the_state_file() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let _env = EnvVarGuard::set_local_data_dir(tmp.path());

        let brain_path = "brain-d";
        // An implausible (dead) pid — this test's own point is the file
        // round-trip, not the kill mechanics (already proven directly by
        // `reclaim_stale_sidecar_tree_kills_a_genuinely_live_recorded_process`
        // below, using a disposable child process — NEVER this test
        // process's own pid, which `reclaim_stale_sidecar` would otherwise
        // genuinely tree-kill since it treats any recorded ALIVE pid as
        // fair game unconditionally).
        super::record_sidecar_state(brain_path, u32::MAX, 12345);
        let state_path = super::sidecar_state_path(brain_path).expect("state path must resolve");
        assert!(state_path.exists(), "record_sidecar_state must write the state file");

        // reclaim_stale_sidecar reads it back, finds the pid dead, skips the
        // kill, and still removes the now-consumed state file.
        super::reclaim_stale_sidecar(brain_path);
        assert!(!state_path.exists(), "reclaim_stale_sidecar must remove the state file it consumed");
        eprintln!("record_and_reclaim_sidecar_state_roundtrips_through_the_state_file PASSED");
    }

    /// THE regression test for the orphan-reclaim path itself: a genuinely
    /// live, long-running child process recorded in the state file must be
    /// tree-killed by `reclaim_stale_sidecar`, not merely have its record
    /// removed.
    #[test]
    fn reclaim_stale_sidecar_tree_kills_a_genuinely_live_recorded_process() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let _env = EnvVarGuard::set_local_data_dir(tmp.path());

        let mut long_runner = if cfg!(windows) {
            // `ping` (unlike `timeout`) does not error out on redirected
            // stdin ("ERROR: Input redirection is not supported") — needed
            // since stdin is null'd below — and runs directly (no
            // intermediate `cmd.exe` layer), so its pid is exactly the one
            // this test tracks and kills.
            std::process::Command::new("ping")
                .args(["-n", "61", "127.0.0.1"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("spawn a long-running child for this test")
        } else {
            std::process::Command::new("sh")
                .args(["-c", "sleep 60"])
                .spawn()
                .expect("spawn a long-running child for this test")
        };
        let pid = long_runner.id();
        assert!(super::pid_is_alive(pid), "test precondition: the long-runner must be alive before reclaim");

        let brain_path = "brain-e";
        super::record_sidecar_state(brain_path, pid, 12346);

        super::reclaim_stale_sidecar(brain_path);

        // Tree-kill via taskkill/SIGKILL is asynchronous relative to this
        // call — reap with a bounded wait instead of asserting instantly.
        let mut still_alive = super::pid_is_alive(pid);
        for _ in 0..20 {
            if !still_alive {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
            still_alive = super::pid_is_alive(pid);
        }
        assert!(!still_alive, "reclaim_stale_sidecar must have tree-killed the recorded live process");

        let _ = long_runner.kill();
        let _ = long_runner.wait();
        eprintln!("reclaim_stale_sidecar_tree_kills_a_genuinely_live_recorded_process PASSED (pid={})", pid);
    }
}
