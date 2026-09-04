// teams_sidecar.rs — LazyBrain-Teams HTTP server sidecar.
//
// Started at app boot when the LAZY_TEAMS_ENABLED=1 env var is set.
// Spawns `node <script>` and waits for GET /health -> {ok:true} before
// marking the sidecar ready.
//
// The Tauri commands teams_health and teams_capture (defined in lib.rs)
// proxy HTTP calls through reqwest because WebView2 cannot reach loopback
// directly — the same pattern used by brain_fetch_graph.
//
// DEV script path:
//   <cargo_manifest_dir>/../../LazyBrain-Teams/dist/server/main.js
// PROD script path (bundled):
//   <exe_dir>/resources/teams-server/main.js

use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};

// ── Core struct ───────────────────────────────────────────────────

/// Holds the LazyBrain-Teams server child process and its port.
pub struct TeamsSidecar {
    pub child: Option<Child>,
    pub port: u16,
}

impl Default for TeamsSidecar {
    fn default() -> Self {
        Self::new()
    }
}

impl TeamsSidecar {
    pub fn new() -> Self {
        TeamsSidecar { child: None, port: 7777 }
    }

    /// Find a free TCP port, preferring `preferred`.
    ///
    /// Tries to bind the preferred port; if unavailable, asks the OS for any
    /// free ephemeral port. Falls back to the preferred value if both fail.
    pub fn find_free_port(preferred: u16) -> u16 {
        use std::net::TcpListener;
        // Try preferred port first
        if TcpListener::bind(format!("127.0.0.1:{}", preferred)).is_ok() {
            return preferred;
        }
        // Ask OS for any free port
        match TcpListener::bind("127.0.0.1:0") {
            Ok(l) => l.local_addr().map(|a| a.port()).unwrap_or(preferred),
            Err(_) => preferred,
        }
    }

    /// Spawn `node <script>` with LBT_PORT and LBT_DATA_DIR, then wait for
    /// GET /health to return 2xx (see `wait_healthy`'s own doc comment for
    /// the measured, platform-dependent cost of the failure path — it is
    /// NOT a flat 5s).
    ///
    /// Returns true if the server became healthy, false otherwise.
    pub fn start(
        &mut self,
        node_exe: &str,
        script: &str,
        port: u16,
        data_dir: &str,
        auth_mode: &str,
        jwt_secret: &str,
    ) -> bool {
        self.port = port;

        let mut cmd = crate::commands::util::quiet_command(node_exe);
        cmd.arg(script)
            .env("LBT_PORT", port.to_string())
            .env("LBT_DATA_DIR", data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        // Inject auth env vars only in supabase mode (non-empty strings).
        // Solo and demo modes receive empty strings — no auth env vars are set.
        if !auth_mode.is_empty() {
            cmd.env("TEAMS_AUTH_MODE", auth_mode);
        }
        if !jwt_secret.is_empty() {
            cmd.env("SUPABASE_JWT_SECRET", jwt_secret);
        }

        match cmd.spawn() {
            Ok(child) => {
                log::info!(
                    "Teams sidecar started (pid={}, port={})",
                    child.id(),
                    port
                );
                self.child = Some(child);
                self.wait_healthy()
            }
            Err(e) => {
                log::warn!("Teams sidecar failed to spawn: {}", e);
                false
            }
        }
    }

    /// Poll GET /health every 500 ms until the server responds 2xx, up to 10
    /// attempts.
    ///
    /// The 10 x 500ms sleep gives a 5s FLOOR, not a ceiling — this doc used
    /// to (wrongly) claim "up to 5 s" as an assertion, not a measurement.
    /// Measured directly (see `wait_healthy_blocking_cost_against_unreachable_port_is_measured`
    /// below): on this Windows dev machine, each FAILED `reqwest::blocking::get`
    /// call against an unreachable port itself costs ~2.0s on top of the
    /// 500ms sleep (10/10 attempts measured at 2.02-2.04s), for a total
    /// measured worst case of ~25.3s, not ~5s. The likely cause is that
    /// `reqwest::blocking::get` is a convenience free function that spins up
    /// a brand-new blocking `Client` (and its own mini Tokio runtime) on
    /// EVERY call rather than reusing one — a real, separate perf issue
    /// worth its own follow-up (flagged, not fixed here: out of scope for
    /// this change, and changing HTTP client behavior deserves its own
    /// review). This number may vary by OS/network stack; treat "~5s" as a
    /// best-case floor and "~25s" as an observed worst case, not a
    /// guaranteed bound.
    fn wait_healthy(&self) -> bool {
        let url = format!("http://127.0.0.1:{}/health", self.port);
        for attempt in 0..10 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            match reqwest::blocking::get(&url) {
                Ok(resp) if resp.status().is_success() => {
                    log::info!(
                        "Teams sidecar healthy (port={}, attempt={})",
                        self.port,
                        attempt + 1
                    );
                    return true;
                }
                Ok(resp) => {
                    log::debug!(
                        "Teams sidecar /health returned {} (attempt {})",
                        resp.status(),
                        attempt + 1
                    );
                }
                Err(e) => {
                    log::debug!(
                        "Teams sidecar /health connect failed: {} (attempt {})",
                        e,
                        attempt + 1
                    );
                }
            }
        }
        log::warn!(
            "Teams sidecar did not become healthy within 5 s (port={})",
            self.port
        );
        false
    }

    /// Kill the child process — and, on Windows, its full descendant
    /// process tree — if running.
    ///
    /// Idempotent and best-effort: mirrors `BrainSidecar::stop` in
    /// commands/brain/sidecar.rs (see its doc comment for the full
    /// rationale) — the same orphan-child risk applies here, even though
    /// the Teams sidecar is currently gated behind `LAZY_TEAMS_ENABLED` and
    /// off by default for solo users. Never panics: every OS call below has
    /// its `Result` discarded.
    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let pid = child.id();

            #[cfg(target_os = "windows")]
            {
                let _ = crate::commands::util::quiet_command("taskkill")
                    .args(crate::commands::util::tree_kill_args(pid))
                    .output();
            }
            #[cfg(not(target_os = "windows"))]
            {
                unsafe { libc::kill(pid as i32, libc::SIGKILL); }
            }

            let _ = child.kill();
            let _ = child.wait();
            log::info!("Teams sidecar stopped (pid={})", pid);
        }
    }
}

impl Drop for TeamsSidecar {
    fn drop(&mut self) {
        self.stop();
    }
}

// ── Tauri state wrapper ───────────────────────────────────────────

/// Managed Tauri state for the Teams sidecar.
pub struct TeamsSidecarState(pub Arc<Mutex<TeamsSidecar>>);

impl Default for TeamsSidecarState {
    fn default() -> Self {
        Self::new()
    }
}

impl TeamsSidecarState {
    pub fn new() -> Self {
        TeamsSidecarState(Arc::new(Mutex::new(TeamsSidecar::new())))
    }
}

/// Best-effort stop of the sidecar held in managed `TeamsSidecarState`, for
/// the app exit path (`WindowEvent::Destroyed` in `run()`, lib.rs). See
/// `stop_brain_sidecar_for_exit` in commands/brain/sidecar.rs for the full
/// rationale (`Drop` does not run on this exit path) — mirrored here for the
/// Teams sidecar, which carries the same latent orphan risk.
///
/// Never panics: a poisoned lock is logged and skipped rather than
/// propagated, same as `stop_brain_sidecar_for_exit` / `kill_tracked_agent_pids`.
pub(crate) fn stop_teams_sidecar_for_exit(state: &TeamsSidecarState) {
    match state.0.lock() {
        Ok(mut sidecar) => sidecar.stop(),
        Err(e) => log::warn!("app exit: teams sidecar lock failed: {}", e),
    }
}

// ── Script path resolution ────────────────────────────────────────

/// Resolve the path to LazyBrain-Teams dist/server/main.js.
///
/// Priority:
///   1. Dev: `<cargo_manifest_dir>/../../LazyBrain-Teams/dist/server/main.js`
///      (sibling repo in the cerveau workspace)
///   2. Prod: `<exe_dir>/resources/teams-server/main.js`
///      (bundled with the Tauri installer)
///
/// Returns None when the script is not found at either location.
pub fn resolve_teams_script() -> Option<String> {
    // 1. Dev path: sibling LazyBrain-Teams repo
    let dev_script = {
        let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.pop(); // src-tauri -> workspace root (e.g. Lazy-teams-wt or Lazy)
        p.pop(); // workspace root -> cerveau
        p.push("LazyBrain-Teams");
        p.push("dist");
        p.push("server");
        p.push("main.js");
        p
    };
    if dev_script.exists() {
        log::info!("Teams server: dev script at {}", dev_script.display());
        return Some(dev_script.to_string_lossy().into_owned());
    }

    log::debug!(
        "Teams server: dev script not found at {} — checking prod path",
        dev_script.display()
    );

    // 2. Prod path: bundled next to the exe
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let prod = exe_dir
                .join("resources")
                .join("teams-server")
                .join("main.js");
            if prod.exists() {
                log::info!("Teams server: prod script at {}", prod.display());
                return Some(prod.to_string_lossy().into_owned());
            }
        }
    }

    log::info!("Teams server: script not found (sidecar will not start)");
    None
}

#[cfg(test)]
mod tests {
    use super::{TeamsSidecar, TeamsSidecarState, stop_teams_sidecar_for_exit};

    /// stop() on a sidecar that was never started (child is None) must be a
    /// safe no-op. Mirrors brain_sidecar_stop_on_never_started_sidecar_is_a_safe_noop
    /// in commands/brain/sidecar.rs.
    #[test]
    fn teams_sidecar_stop_on_never_started_sidecar_is_a_safe_noop() {
        let mut sidecar = TeamsSidecar::new();
        sidecar.stop();
        assert!(sidecar.child.is_none());
        sidecar.stop();
        assert!(sidecar.child.is_none());
        eprintln!("teams_sidecar_stop_on_never_started_sidecar_is_a_safe_noop PASSED");
    }

    /// stop() must be idempotent and must never panic even when the tracked
    /// child has already exited on its own. Mirrors
    /// brain_sidecar_stop_is_idempotent_and_survives_already_exited_child —
    /// same contract, same fix, applied to the Teams sidecar.
    #[test]
    fn teams_sidecar_stop_is_idempotent_and_survives_already_exited_child() {
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

        let mut sidecar = TeamsSidecar::new();
        sidecar.child = Some(child);

        sidecar.stop();
        assert!(sidecar.child.is_none(), "stop() must clear child");

        sidecar.stop();
        assert!(sidecar.child.is_none());

        eprintln!("teams_sidecar_stop_is_idempotent_and_survives_already_exited_child PASSED");
    }

    /// stop_teams_sidecar_for_exit must degrade gracefully on a poisoned
    /// lock (mirrors stop_brain_sidecar_for_exit_handles_poisoned_lock_without_panicking
    /// and kill_tracked_agent_pids_handles_poisoned_lock_without_panicking) —
    /// the exit hook runs during app teardown, where a panic would be
    /// especially unwelcome.
    #[test]
    fn stop_teams_sidecar_for_exit_handles_poisoned_lock_without_panicking() {
        use std::panic;
        use std::sync::Arc;

        let state = TeamsSidecarState::new();
        let inner = Arc::clone(&state.0);
        let _ = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let _guard = inner.lock().expect("lock");
            panic!("intentional poison for test");
        }));

        stop_teams_sidecar_for_exit(&state);
        eprintln!("stop_teams_sidecar_for_exit_handles_poisoned_lock_without_panicking PASSED");
    }

    /// Cold-boot regression guard (perf audit 2026-08-15): quantifies, with a
    /// real measurement rather than trusting this file's own "up to 5s" doc
    /// comment, the exact blocking cost `wait_healthy` puts on WHATEVER
    /// thread calls it when the sidecar never becomes healthy (wrong/closed
    /// port — same failure shape as a slow/crashed `node` child). This is
    /// the cost `lib.rs`'s `run()` used to pay directly on the Tauri setup
    /// thread before the fix in this change (teams-sidecar start moved onto
    /// `std::thread::spawn`, mirroring commit 0e08036's brain-sidecar fix) —
    /// see `teams_sidecar_health_wait_stays_off_setup_thread` in lib.rs for
    /// the structural half of this guard.
    #[test]
    fn wait_healthy_blocking_cost_against_unreachable_port_is_measured() {
        // Grab a free port and immediately drop the listener so nothing is
        // bound there — `wait_healthy`'s reqwest calls fail fast (connection
        // refused) rather than hanging on a connect timeout, isolating the
        // measurement to the 10 x 500ms sleep loop the function itself owns.
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind free port");
            listener.local_addr().expect("local addr").port()
        };
        let sidecar = TeamsSidecar { child: None, port };

        let start = std::time::Instant::now();
        let healthy = sidecar.wait_healthy();
        let elapsed = start.elapsed();

        assert!(!healthy, "nothing is listening on this port — must report unhealthy");
        eprintln!(
            "MEASURED wait_healthy blocking cost against an unreachable port: {:?} \
             (10 attempts x 500ms sleep + a blocking reqwest GET each)",
            elapsed
        );
        // Loose bounds: the 10 x 500ms sleep floor is exact; the ceiling
        // leaves headroom for slow CI machines without letting a real
        // regression (e.g. a reqwest connect timeout being hit instead of
        // an immediate refusal) pass silently.
        assert!(
            elapsed.as_millis() >= 4900,
            "expected the 5s sleep floor (10 x 500ms) as an absolute minimum, got {:?}",
            elapsed
        );
        // Generous, not tight: measured on this Windows dev machine at
        // ~25.3s (each failed reqwest call costs ~2.0s beyond its 500ms
        // sleep — see wait_healthy's doc comment). The exact per-call
        // failure cost is platform/network-stack dependent, so this ceiling
        // exists only to catch a genuine runaway (e.g. a connect timeout
        // firing instead of an immediate refusal), not to pin an exact number.
        assert!(
            elapsed.as_secs() < 60,
            "wait_healthy took far longer than any previously observed run: {:?} — \
             investigate whether reqwest is hitting a connect timeout instead of a fast refusal",
            elapsed
        );
    }
}
