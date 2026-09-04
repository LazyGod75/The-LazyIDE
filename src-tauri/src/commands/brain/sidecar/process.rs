//! The `BrainSidecar` child-process handle itself (spawn/stop/Drop) and
//! `start_or_restart_brain_sidecar`, the free function that actually starts
//! or restarts it without holding `BrainState`'s mutex across the slow
//! (~5-10s) health-check wait.

use std::process::{Child, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use crate::teams_sidecar;
use crate::commands::util::{quiet_command, tree_kill_args};
use super::{BRAIN_PORT, SHUTTING_DOWN};
use crate::commands::brain::sidecar::init::clear_init_failure_marker;
use crate::commands::brain::sidecar::lock::{acquire_sidecar_spawn_lock, reclaim_stale_sidecar, record_sidecar_state};
use crate::commands::brain::sidecar::resolve::{LazyBrainBin, generate_sidecar_token, serve_command_args};
use crate::commands::brain::sidecar::warmup::{spawn_brain_recall_warmup, wait_ready_at};

/// Holds the LazyBrain daemon child process.
pub struct BrainSidecar {
    child: Option<Child>,
    pub(crate) port: u16,
    /// Bearer token required by the sidecar's `checkAuth` (see `spawn_at` and
    /// every `brain_fetch_*` command below). Generated once per
    /// `BrainSidecar` — since `BrainState`/`BrainSidecar` are constructed
    /// exactly once at app startup (`BrainState::new()` in `run()`) and then
    /// reused in place across project switches (`restart_brain_sidecar` only
    /// calls `stop()`/`start()` on the existing instance), this is
    /// effectively one token for the whole app process lifetime, matching
    /// the "one token per app launch" requirement. Never logged.
    ///
    /// `pub(crate)` (not private) for the same reason `port` already is:
    /// crate-internal callers that hold the `BrainState`/`BrainSidecar`
    /// directly (bypassing the `tauri::State`-based `brain_port_and_token`
    /// helper — e.g. a background auto-index thread with no `tauri::State`
    /// in scope, or its unit tests) need it to authenticate their own
    /// `/_api/*` calls against the sidecar they just (re)started.
    pub(crate) token: String,
    /// True when `resolve_brain_bin` found no LazyBrain binary at all (dev
    /// engine build absent AND no bundled `resources/lazybrain` — a build
    /// that ran without `npm run bundle:sidecar` first) — set once, at boot,
    /// by the setup hook's "LazyBrain bin not found" branch (lib.rs). Before
    /// this flag existed, that case degraded to a SILENT zero everywhere
    /// downstream (empty KPI, "0 notes", connection-refused fetches
    /// indistinguishable from "still starting up") — no honest signal that
    /// the sidecar will NEVER start, as opposed to "starting up, check back
    /// in a second". Read by `get_brain_connection` so the frontend can
    /// render an honest "sidecar absent (build incomplet)" state instead.
    pub(crate) bin_missing: bool,
    /// Honest reason `ensure_brain_init` genuinely failed after exhausting
    /// every retry (`INIT_TRANSIENT_RETRY_ATTEMPTS` non-zero exits) — `None`
    /// whenever the brain is fine (canonical, legacy-accepted, or a
    /// successful fresh init). Set by the two call sites that have this
    /// `BrainState` in scope right after calling `ensure_brain_init` (the
    /// boot-time thread in lib.rs, and `restart_brain_sidecar` in
    /// commands/brain/config.rs) — both simply overwrite this field with
    /// whatever that call just returned, so a later successful retry
    /// (`brain_retry_sidecar`, an explicit project switch) naturally clears
    /// a stale reason with no separate "clear" call needed. Read by
    /// `get_brain_connection` (mirrors `bin_missing_reason`'s established
    /// convention exactly) so the frontend can show an honest "brain init
    /// failed" state instead of silently booting a `serve` daemon against a
    /// brain it just declared broken.
    pub(crate) init_failed_reason: Option<String>,
}

impl Default for BrainSidecar {
    fn default() -> Self {
        Self::new()
    }
}

impl BrainSidecar {
    pub fn new() -> Self {
        BrainSidecar {
            child: None,
            port: BRAIN_PORT,
            token: generate_sidecar_token(),
            bin_missing: false,
            init_failed_reason: None,
        }
    }

    /// Spawn the `serve` child process bound to `port`, without waiting for
    /// readiness. Stores `port` in `self.port` before spawning so `get_brain_port`
    /// is accurate even while the sidecar is still warming up (or if spawn fails).
    ///
    /// Port selection and the (blocking) health-check wait both live in the
    /// free function `start_or_restart_brain_sidecar` below, not in a
    /// `&mut self` method here — see that function's doc comment for why:
    /// in short, a `&mut self` method holds whatever `MutexGuard` the caller
    /// obtained `self` through for the method's ENTIRE duration, which is
    /// fine for this fast/non-blocking spawn step but was the exact problem
    /// with the old all-in-one `start()` (removed) for the slow wait.
    fn spawn_at(&mut self, lb: &LazyBrainBin, brain_path: &str, port: u16) -> bool {
        self.port = port;
        let args = serve_command_args(port, &self.token);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let child = lb.command(&arg_refs)
            .env("LAZYBRAIN_BRAIN_PATH", brain_path)
            .env("LAZYBRAIN_LOG_LEVEL", "warn")
            // TELEMETRY MUST STAY ON HERE: this `serve` child IS the warm
            // HTTP sidecar that answers every live /_api/search and
            // /_api/recall call (see search.rs's recall_from_warm_sidecar
            // and brain_fetch_search_scoped) — i.e. the ONE process real
            // per-turn recall and mission brain.recall() actually run
            // through. Every other spawn site in this codebase sets this to
            // "0" because it launches a one-shot admin/CLI subprocess
            // (init, capture, index, maintenance) where a query/inject
            // telemetry event would never fire anyway. This is not one of
            // those — disabling it here silently zeroes out Settings >
            // Memory's "Queries (24h)" diagnostic (`brain_stats`/
            // engine/src/commands/stats.ts reads _cache/telemetry.jsonl)
            // regardless of how much real recall traffic the sidecar
            // serves. The one synthetic query this process issues itself
            // (the warmup probe, see warmup.rs's spawn_brain_recall_warmup)
            // is separately excluded via the `X-Lazy-Warmup` header/
            // `skipTelemetry` opt (server/routes/recall.ts), so turning
            // this on does not pollute the counter with cache-priming noise.
            .env("LAZYBRAIN_TELEMETRY", "1")
            .env("LAZYBRAIN_EMBEDDINGS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();

        match child {
            Ok(c) => {
                log::info!("LazyBrain daemon started (pid={}, port={})", c.id(), port);
                self.child = Some(c);
                true
            }
            Err(e) => {
                log::warn!("LazyBrain daemon failed to start on port {}: {}", port, e);
                false
            }
        }
    }

    /// Kill the child process — and, on Windows, its full descendant
    /// process tree — if running.
    ///
    /// Idempotent: calling this when the sidecar is already stopped (or was
    /// never started, `self.child` is `None`) is a safe no-op. Never
    /// panics, even when the tracked pid has already exited on its own
    /// (crashed, killed externally, etc.) — every OS call below has its
    /// `Result` discarded, matching `kill_tracked_agent_pids`' best-effort
    /// contract in commands/agent.rs.
    ///
    /// Windows: tree-kills via `taskkill /PID <pid> /T /F` (see
    /// `tree_kill_args`) BEFORE falling back to `child.kill()`.
    /// `Child::kill()` alone (`TerminateProcess` on just this one handle)
    /// does not reach worker/child processes the sidecar itself spawns
    /// (e.g. an embeddings worker) — QA proved exactly that process tree
    /// survives as an orphan, still answering HTTP on its port+token, after
    /// the IDE's own process had already exited. Mirrors the same `/T /F`
    /// pattern `kill_tracked_agent_pids` / `agent_run_kill` already use for
    /// tracked agent CLI pids.
    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let pid = child.id();

            #[cfg(target_os = "windows")]
            {
                let _ = quiet_command("taskkill")
                    .args(tree_kill_args(pid))
                    .output();
            }
            #[cfg(not(target_os = "windows"))]
            {
                unsafe { libc::kill(pid as i32, libc::SIGKILL); }
            }

            let _ = child.kill();
            let _ = child.wait();
            log::info!("LazyBrain daemon stopped (pid={})", pid);
        }
    }
}

impl Drop for BrainSidecar {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Start (first launch) or restart (project switch) the sidecar held in
/// `brain_state`, preferring `preferred_port`, WITHOUT holding the shared
/// mutex across the slow (~5-10 s) health-check wait.
///
/// Why this exists: `BrainState`'s mutex guards every `brain_fetch_*` /
/// `get_brain_port` / `get_brain_connection` command (see their doc
/// comments) — `BrainSidecar::start` takes `&mut self` for its ENTIRE body,
/// meaning whatever `MutexGuard` the caller obtained `self` through stays
/// locked for however long `wait_ready` takes (up to ~5 s, ~10 s with the
/// port-fallback retry). That was tolerable for the very first sidecar
/// start (before any project is open, before the user could plausibly have
/// triggered a brain command) but NOT for `restart_brain_sidecar`
/// (commands/brain/config.rs), called on every project switch — QA/AUDIT
/// identified this as freezing every brain feature app-wide for the whole
/// restart, since any other command blocked on the same mutex the whole
/// time. Both call sites (initial startup in lib.rs's `.setup()` — itself
/// now off the main thread, see that call site — and `restart_brain_sidecar`)
/// use this function so neither one re-introduces the freeze.
///
/// Sequence:
///  1. Lock briefly: stop any existing child (safe no-op if none — see
///     `stop`'s own doc comment), spawn the new one (`spawn_at` — fast,
///     non-blocking, just `Command::spawn`), snapshot `(port, token)`, then
///     UNLOCK (the guard is dropped at the end of this block).
///  2. Outside the lock: poll readiness (`wait_ready_at`) — virtually all
///     the wall-clock time is spent here, and every other brain command can
///     now run concurrently instead of blocking on this mutex.
///  3. On failure, retry once on a different port — same fallback
///     `BrainSidecar::start` already provides, reproduced here as two more
///     brief lock/unlock steps instead of one long lock hold.
///
/// Returns `true` iff the sidecar became healthy (same contract as `start`).
///
/// Also enforces the cross-process single-instance guard (fix #2, see this
/// file's "Cross-process sidecar single-instance guard" section above): a
/// spawn lock for `brain_path` is held for the ENTIRE function (released
/// automatically on every return via `SidecarSpawnLock`'s `Drop`), and any
/// live sidecar a previous attempt (this process's own earlier run, or a
/// past/concurrent OS process) recorded for this brain path is reclaimed
/// (tree-killed) before a fresh one is spawned.
pub(crate) fn start_or_restart_brain_sidecar(
    brain_state: &Arc<Mutex<BrainSidecar>>,
    lb: &LazyBrainBin,
    brain_path: &str,
    preferred_port: u16,
) -> bool {
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        log::debug!("start_or_restart_brain_sidecar: app is shutting down — skipping spawn");
        return false;
    }

    let _spawn_lock = match acquire_sidecar_spawn_lock(brain_path) {
        Ok(guard) => guard,
        Err(()) => {
            log::warn!(
                "start_or_restart_brain_sidecar: another process is already starting a sidecar for '{}' — skipping this attempt",
                brain_path
            );
            return false;
        }
    };
    reclaim_stale_sidecar(brain_path);

    let (port, token, spawned, child_pid) = {
        let mut sidecar = match brain_state.lock() {
            Ok(g) => g,
            Err(e) => {
                log::warn!("start_or_restart_brain_sidecar: BrainState lock failed: {}", e);
                return false;
            }
        };
        // Stop any previously-running child FIRST — a no-op on first launch
        // (child is None), but essential on a project-switch restart: without
        // this, spawn_at below would overwrite self.child with the new
        // process while the OLD one (the previous project's sidecar) is
        // still running, silently orphaning it — the exact class of bug
        // stop_brain_sidecar_for_exit's doc comment documents QA finding.
        sidecar.stop();
        let chosen_port = teams_sidecar::TeamsSidecar::find_free_port(preferred_port);
        let ok = sidecar.spawn_at(lb, brain_path, chosen_port);
        let pid = sidecar.child.as_ref().map(|c| c.id());
        (sidecar.port, sidecar.token.clone(), ok, pid)
    };

    // Outside the lock: the slow part. Skip straight to the retry branch if
    // spawn_at itself already failed (mirrors start()'s `&&` short-circuit —
    // no point polling a process that never started).
    if spawned && wait_ready_at(port, &token) {
        // A healthy sidecar is fresh, direct proof the brain is fine —
        // clear any stale `.lazybrain-init-failed` marker immediately rather
        // than letting it sit until INIT_FAILURE_RETRY_AFTER_SECS expires.
        // See `clear_init_failure_marker`'s doc comment.
        clear_init_failure_marker(brain_path);
        if let Some(pid) = child_pid {
            record_sidecar_state(brain_path, pid, port);
        }
        spawn_brain_recall_warmup(port, token);
        return true;
    }

    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        log::debug!("start_or_restart_brain_sidecar: app is shutting down — skipping retry");
        return false;
    }

    let (retry_port, retry_token, retry_spawned, retry_pid) = {
        let mut sidecar = match brain_state.lock() {
            Ok(g) => g,
            Err(e) => {
                log::warn!("start_or_restart_brain_sidecar: BrainState lock failed on retry: {}", e);
                return false;
            }
        };
        sidecar.stop();
        let fallback_port = teams_sidecar::TeamsSidecar::find_free_port(port);
        if fallback_port == port {
            // No genuinely different port available — give up, matching
            // start()'s behavior.
            return false;
        }
        log::warn!(
            "LazyBrain sidecar not healthy on port {} — retrying on free port {}",
            port, fallback_port
        );
        let ok = sidecar.spawn_at(lb, brain_path, fallback_port);
        let pid = sidecar.child.as_ref().map(|c| c.id());
        (sidecar.port, sidecar.token.clone(), ok, pid)
    };

    if retry_spawned && wait_ready_at(retry_port, &retry_token) {
        clear_init_failure_marker(brain_path);
        if let Some(pid) = retry_pid {
            record_sidecar_state(brain_path, pid, retry_port);
        }
        spawn_brain_recall_warmup(retry_port, retry_token);
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use crate::commands::brain::sidecar::resolve::LazyBrainBin;
    use crate::commands::brain::sidecar::state::BrainState;

    /// Companion to `start_or_restart_brain_sidecar_falls_back_to_free_port_when_preferred_is_taken`
    /// below: when the preferred port is genuinely free, the shared helper
    /// it delegates to (`TeamsSidecar::find_free_port`) must return it
    /// unchanged — the contract "keep behavior identical when 37990 is
    /// free" depends on this. Uses a dynamically-obtained free port instead
    /// of a hardcoded number so the assertion never depends on what else
    /// happens to be running on the machine executing `cargo test`.
    #[test]
    fn find_free_port_keeps_preferred_port_when_free() {
        use super::teams_sidecar::TeamsSidecar;
        use std::net::TcpListener;

        let free_port = TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .expect("OS must hand back an ephemeral port")
            .port();

        assert_eq!(
            TeamsSidecar::find_free_port(free_port),
            free_port,
            "find_free_port must return the preferred port unchanged when it is free"
        );

        eprintln!(
            "find_free_port_keeps_preferred_port_when_free PASSED (port={})",
            free_port
        );
    }

    #[test]
    fn brain_sidecar_new_defaults_bin_missing_to_false() {
        let sidecar = super::BrainSidecar::new();
        assert!(!sidecar.bin_missing, "a freshly constructed BrainSidecar must not claim the bin is missing");
        eprintln!("brain_sidecar_new_defaults_bin_missing_to_false PASSED");
    }

    /// A fresh BrainSidecar must carry a real (non-empty) token — the
    /// property spawn_at, wait_ready, and every brain_fetch_* HTTP call
    /// depend on to authenticate to the sidecar's checkAuth.
    #[test]
    fn brain_sidecar_new_has_nonempty_token() {
        use super::BrainSidecar;
        let sidecar = BrainSidecar::new();
        // token is a private field, but this test lives in the same module
        // (Rust privacy is per-module, not per-struct) — same access pattern
        // already used for `.port` throughout this file.
        assert!(!sidecar.token.is_empty(), "BrainSidecar::new() must generate a non-empty token");
        eprintln!("brain_sidecar_new_has_nonempty_token PASSED");
    }

    /// stop() on a sidecar that was never started (child is None) must be a
    /// safe no-op — the baseline idempotency case (e.g. app exit before any
    /// project was ever opened, or the sidecar bin was never resolved).
    #[test]
    fn brain_sidecar_stop_on_never_started_sidecar_is_a_safe_noop() {
        use super::BrainSidecar;

        let mut sidecar = BrainSidecar::new();
        sidecar.stop();
        assert!(sidecar.child.is_none());
        // Calling it again must also stay a no-op — proves idempotency, not
        // just "worked once".
        sidecar.stop();
        assert!(sidecar.child.is_none());

        eprintln!("brain_sidecar_stop_on_never_started_sidecar_is_a_safe_noop PASSED");
    }

    /// stop() must be idempotent and must never panic even when the tracked
    /// child has already exited on its own by the time stop() runs (the
    /// "bogus/already-gone pid" case QA's crash scenario resembles). Uses a
    /// genuine short-lived OS process (BrainSidecar::child is a real
    /// std::process::Child — its pid cannot be fabricated) so both the
    /// `taskkill /PID <pid> /T /F` call and the `child.kill()`/`wait()`
    /// fallback run against a pid that is provably already gone.
    #[test]
    fn brain_sidecar_stop_is_idempotent_and_survives_already_exited_child() {
        use super::BrainSidecar;
        use std::process::Command;

        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "exit", "0"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "exit 0"]);
            c
        };
        let mut child = cmd.spawn().expect("spawn trivial child for test");
        let _ = child.wait(); // reap it now — pid is stale/gone by the time stop() runs

        let mut sidecar = BrainSidecar::new();
        sidecar.child = Some(child);

        // First stop(): must not panic against an already-exited pid.
        sidecar.stop();
        assert!(sidecar.child.is_none(), "stop() must clear child");

        // Second stop(): already stopped — must stay a safe no-op.
        sidecar.stop();
        assert!(sidecar.child.is_none());

        eprintln!("brain_sidecar_stop_is_idempotent_and_survives_already_exited_child PASSED");
    }

    /// `restart_brain_sidecar` (commands/brain/config.rs) never constructs a
    /// new `BrainSidecar` — it calls `stop()` then `start()` on the SAME
    /// instance held inside the app's one managed `BrainState`. That means
    /// `self.child` (and therefore the pid `stop_brain_sidecar_for_exit`
    /// targets at app exit) always reflects whichever sidecar is CURRENTLY
    /// running — the first-launch one, or the result of a later
    /// `set_project` restart — never a stale pre-restart pid. Proven here
    /// with two real short-lived processes so the pid genuinely changes,
    /// without going through `start()`'s slow network health-check loop.
    #[test]
    fn brain_sidecar_child_reflects_the_latest_restart_not_a_stale_one() {
        use super::BrainSidecar;
        use std::process::Command;

        fn spawn_trivial() -> std::process::Child {
            if cfg!(windows) {
                let mut c = Command::new("cmd");
                c.args(["/C", "exit", "0"]);
                c.spawn().expect("spawn trivial child for test")
            } else {
                let mut c = Command::new("sh");
                c.args(["-c", "exit 0"]);
                c.spawn().expect("spawn trivial child for test")
            }
        }

        let mut sidecar = BrainSidecar::new();

        // "First launch": a real child is running under this BrainSidecar.
        let first = spawn_trivial();
        let first_pid = first.id();
        sidecar.child = Some(first);

        // "set_project restart": restart_brain_sidecar's exact sequence —
        // stop() the old one, then a new spawn takes its place — on this
        // same instance, never a new BrainSidecar/BrainState.
        sidecar.stop();
        assert!(sidecar.child.is_none(), "stop() must clear the pre-restart child");

        let second = spawn_trivial();
        let second_pid = second.id();
        assert_ne!(first_pid, second_pid, "test precondition: OS must hand back a different pid");
        sidecar.child = Some(second);

        // The instance now holds the POST-restart pid — exactly what
        // stop_brain_sidecar_for_exit (and therefore the app-exit handler)
        // will target, never the pre-restart one.
        assert_eq!(sidecar.child.as_ref().map(|c| c.id()), Some(second_pid));

        // Final cleanup also proves stop() works correctly on the *current*
        // (post-restart) child.
        sidecar.stop();
        assert!(sidecar.child.is_none());

        eprintln!(
            "brain_sidecar_child_reflects_the_latest_restart_not_a_stale_one PASSED \
             (first_pid={}, second_pid={})",
            first_pid, second_pid
        );
    }

    // ── start_or_restart_brain_sidecar (fix #4: don't hold BrainState's ──
    // ── lock across the slow wait_ready poll) ───────────────────────────
    //
    // NOTE: `SHUTTING_DOWN` / `mark_shutting_down()` are deliberately NOT
    // exercised by a dedicated test here. `cargo test` runs every test in
    // this binary in one process (across threads), sharing all `static`
    // state — a test that calls the real `mark_shutting_down()` would flip
    // that flag to `true` PERMANENTLY for the rest of the test run, silently
    // failing every other test below that spawns a sidecar (order-dependent
    // flakiness, not a real bug). The tests below implicitly prove the flag
    // defaults to `false` and does not interfere with normal operation
    // (they all spawn/restart successfully); the shutdown-gating branches
    // themselves are small, direct `AtomicBool::load` checks reviewed by
    // inspection rather than a runtime test.

    /// Companion to `brain_sidecar_falls_back_to_free_port_when_preferred_is_taken`
    /// above, proving `start_or_restart_brain_sidecar` (the function
    /// `restart_brain_sidecar` in commands/brain/config.rs and lib.rs's
    /// `.setup()` now actually call) has the SAME port-fallback resilience
    /// as `BrainSidecar::start`: when the preferred port is already taken,
    /// it must pick a different, genuinely bindable one, using a fake
    /// binary so this stays fast and independent of node/lazybrain.js.
    #[test]
    fn start_or_restart_brain_sidecar_falls_back_to_free_port_when_preferred_is_taken() {
        use super::start_or_restart_brain_sidecar;
        use std::net::TcpListener;

        let _hold = TcpListener::bind("127.0.0.1:37991").ok();
        if _hold.is_none() {
            eprintln!(
                "start_or_restart_brain_sidecar_falls_back_to_free_port_when_preferred_is_taken: \
                 37991 already occupied by another process — using that as the taken port"
            );
        }

        let lb = LazyBrainBin {
            node_exe: "definitely-not-a-real-lazybrain-binary".to_string(),
            script: "nonexistent.js".to_string(),
        };

        let state = BrainState::new();
        // A distinct brain_path per test (not shared with the other
        // `start_or_restart_brain_sidecar` tests below) — the cross-process
        // spawn lock (fix #2) keys on this exact string, so two tests
        // sharing one literal here could genuinely contend for the same
        // on-disk lock file if `LAZY_APP_LOCAL_DATA_DIR` happens to be set
        // by another concurrently-running test at that instant (this file's
        // own lock-file tests set it via `EnvVarGuard`) — this is not a
        // hypothetical: it reproduced as a real flaky failure before this
        // fix, tracked down to exactly this collision.
        let started = start_or_restart_brain_sidecar(&state.0, &lb, "unused-brain-path-falls-back-test", 37991);
        assert!(!started, "a nonexistent node binary must never actually become healthy");

        let resolved_port = state.0.lock().expect("lock").port;
        assert_ne!(resolved_port, 37991, "must not stay on 37991 when that port is already taken");

        TcpListener::bind(("127.0.0.1", resolved_port)).unwrap_or_else(|e| {
            panic!("fallback port {} must actually be bindable: {}", resolved_port, e)
        });

        eprintln!(
            "start_or_restart_brain_sidecar_falls_back_to_free_port_when_preferred_is_taken PASSED \
             (resolved_port={})",
            resolved_port
        );
    }

    /// A restart must stop the PREVIOUS child before spawning the new one —
    /// otherwise the old process (e.g. the prior project's sidecar) would be
    /// silently orphaned when `spawn_at` overwrites `self.child`. Proven
    /// with a real short-lived process standing in for "the sidecar from
    /// before the project switch".
    #[test]
    fn start_or_restart_brain_sidecar_stops_the_previous_child_first() {
        use super::start_or_restart_brain_sidecar;
        use std::process::Command;

        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "exit", "0"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "exit 0"]);
            c
        };
        let previous_child = cmd.spawn().expect("spawn trivial previous child for test");
        let previous_pid = previous_child.id();

        let state = BrainState::new();
        state.0.lock().expect("lock").child = Some(previous_child);

        let lb = LazyBrainBin {
            node_exe: "definitely-not-a-real-lazybrain-binary".to_string(),
            script: "nonexistent.js".to_string(),
        };
        // Distinct brain_path — see the sibling test above for why sharing
        // one literal across `start_or_restart_brain_sidecar` tests is a
        // real (proven) flakiness hazard now that fix #2's cross-process
        // lock keys on this string.
        let _ = start_or_restart_brain_sidecar(&state.0, &lb, "unused-brain-path-stops-previous-child-test", 47992);

        // The previous child slot must no longer hold the pre-restart pid —
        // either replaced by a (failed) new spawn attempt or cleared, but
        // never left pointing at the stale previous_pid.
        let current_pid = state.0.lock().expect("lock").child.as_ref().map(|c| c.id());
        assert_ne!(
            current_pid,
            Some(previous_pid),
            "restart must not leave the pre-restart child pid in place unmanaged"
        );

        eprintln!("start_or_restart_brain_sidecar_stops_the_previous_child_first PASSED");
    }

    /// The core claim fix #4 makes: unlike `BrainSidecar::start` (which
    /// holds `&mut self` — i.e. the caller's `MutexGuard` — for its ENTIRE
    /// duration, including the up-to-5s `wait_ready` poll),
    /// `start_or_restart_brain_sidecar` must release the `BrainState` mutex
    /// BEFORE the slow poll begins, so any other brain_fetch_*/get_brain_port
    /// command issued while the sidecar is still coming up does not block
    /// for the same duration.
    ///
    /// Proven with a REAL child process (a `node` script that idles for a
    /// few seconds without ever answering HTTP) spawned on a background
    /// thread, while this test's own thread repeatedly attempts `try_lock()`
    /// on the SAME state. If the mutex were still held for the whole wait
    /// (the pre-fix bug), every `try_lock()` attempt would fail for the
    /// entire ~5s window instead of succeeding almost immediately.
    #[test]
    fn start_or_restart_brain_sidecar_releases_lock_before_the_slow_wait() {
        use super::start_or_restart_brain_sidecar;
        use std::process::Command;
        use tempfile::TempDir;

        // Skip if node is not on PATH — mirrors this file's existing
        // convention (see brain_capture_writes_neuron in capture.rs) for
        // environment-dependent tests.
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("SKIP start_or_restart_brain_sidecar_releases_lock_before_the_slow_wait — node not on PATH");
            return;
        }

        // A trivial script that idles for a few seconds without ever
        // starting an HTTP server (and ignores argv entirely) — wait_ready_at
        // will therefore poll its full course and report unhealthy, giving
        // this test a real multi-second window to observe concurrent lock
        // access in. It also never actually binds the target port, so the
        // retry branch's own find_free_port check will find the SAME port
        // still free and bail out early (see start_or_restart_brain_sidecar's
        // `if fallback_port == port` early return) — keeping this test to a
        // single ~5s wait instead of two.
        let tmp = TempDir::new().expect("TempDir::new");
        let idle_script = tmp.path().join("idle.js");
        std::fs::write(&idle_script, "setTimeout(() => {}, 4000);\n").expect("write idle script");

        let lb = LazyBrainBin {
            node_exe: "node".to_string(),
            script: idle_script.to_string_lossy().into_owned(),
        };

        let state = BrainState::new();
        let arc = state.0.clone();
        let lb_clone = lb.clone();
        // Distinct brain_path — see start_or_restart_brain_sidecar_falls_back_to_free_port_when_preferred_is_taken's
        // comment for why sharing one literal across these tests is a real
        // (proven) flakiness hazard now that fix #2's cross-process lock
        // keys on this string.
        let handle = std::thread::spawn(move || {
            start_or_restart_brain_sidecar(&arc, &lb_clone, "unused-brain-path-releases-lock-test", 47993)
        });

        // Poll try_lock for up to 2s — far more robust than a single fixed
        // sleep against timing variance on a loaded CI/dev machine.
        let mut lock_acquired_promptly = false;
        for _ in 0..40 {
            if state.0.try_lock().is_ok() {
                lock_acquired_promptly = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(
            lock_acquired_promptly,
            "BrainState mutex must be free during the slow readiness wait (tried for 2s) — \
             if this fails, the lock is still held for the whole duration, exactly the \
             app-wide freeze this fix removes"
        );

        // Let the background call finish (the idle script never answers
        // HTTP, so this resolves to unhealthy) and clean up its process.
        let started = handle.join().expect("start_or_restart_brain_sidecar thread panicked");
        assert!(!started, "the idle script never answers HTTP — must resolve to unhealthy, not a false positive");
        state.0.lock().expect("lock").stop();

        eprintln!("start_or_restart_brain_sidecar_releases_lock_before_the_slow_wait PASSED");
    }
}
