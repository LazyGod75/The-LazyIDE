//! Mission thread lifecycle: the concurrency gate, PID bookkeeping, and the
//! panic-safety-net formatter shared by both `agent_run` (run.rs) and
//! `spawn_scheduler` (scheduler_run.rs).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::commands::util::BoundedGate;

// ── Mission thread lifecycle ──────────────────────────────────────

/// Hard wall-clock cap on a single mission's lifetime, enforced by the
/// mission loop in both `agent_run` and `spawn_scheduler` (each has its own
/// copy of the recv_timeout/try_wait/deadline loop — see either for the
/// pattern). Missions run on dedicated OS threads (not the shared tokio blocking
/// pool — see this change's rationale), so nothing else bounds how long one
/// can stay alive; without this, a wedged CLI child (or one waiting on a
/// grandchild that never exits) would pin its thread — and the mission
/// slot below — forever. No per-mission or config override exists yet
/// (AgentRunRequest carries no timeout field, and no caller-configurable
/// timeout was found elsewhere in this codebase as of this change), so
/// every mission gets this same default.
pub(crate) const MISSION_HARD_DEADLINE_SECS: u64 = 6 * 60 * 60;

/// Caps the number of concurrent long-running mission processes app-wide —
/// `agent_run` (interactive missions) and `spawn_scheduler` (cron-fired
/// runs) share this single gate. See `BoundedGate`'s doc comment
/// (commands/util.rs) for the general mechanism.
///
/// Missions are dedicated OS threads for their whole lifetime (up to
/// `MISSION_HARD_DEADLINE_SECS`) rather than pooled tokio blocking tasks, so
/// nothing else bounds how many can pile up concurrently — unbounded growth
/// here is exactly the OS-thread-exhaustion failure mode (442-556 threads
/// observed in long sessions) this change addresses. Capacity is checked
/// via `try_acquire` (never blocks) so a caller at the limit gets an
/// immediate, clear rejection instead of being silently queued behind
/// `acquire()`'s wait.
pub(crate) const MAX_CONCURRENT_MISSIONS: u32 = 12;
pub(crate) static MISSION_GATE: BoundedGate = BoundedGate::new(MAX_CONCURRENT_MISSIONS);

/// Formats a caught mission-thread panic payload (the `Err` side of
/// `std::panic::catch_unwind`, i.e. `Box<dyn Any + Send + 'static>`) into a
/// human-readable string. Used by both `agent_run` and `spawn_scheduler`'s
/// panic-safety-net branch (each wraps its mission closure in
/// `catch_unwind` so an unexpected panic still emits the mission-failure
/// events the frontend needs — otherwise Mission Control waits forever for
/// a done/error event that will never come). Mirrors `install_panic_hook`'s
/// own payload downcast (lib.rs): a `&str` payload covers a string-literal
/// `panic!("...")`, `String` covers a formatted `panic!("{}", ...)` or an
/// `.expect()`/`.unwrap()` message; any other payload type (rare — a custom
/// `panic_any` value) falls back to a fixed placeholder rather than failing
/// to produce a message at all.
pub(crate) fn format_mission_panic_payload(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "<non-string panic payload>".to_string())
}

/// Tree-kill every PID currently tracked in `AgentPidState`.
///
/// Used by the app-exit hook (`on_window_event` / `WindowEvent::Destroyed`
/// in `run()`) so claude/codex CLI missions spawned by `agent_run` or the
/// local scheduler don't survive the IDE closing. Both insertion sites
/// (`agent_run` and `spawn_scheduler`) already remove their entry from the
/// map once `child.wait()` returns — on success, non-zero exit, or after
/// `agent_run_kill` — so by the time this runs at exit, only PIDs for
/// missions that are still genuinely in flight remain, avoiding the PID-reuse
/// hazard of killing a stale/reused PID from a run that finished long ago.
///
/// Best-effort, same as `agent_run_kill`: a process may have already exited,
/// in which case `taskkill`/`kill` simply no-ops.
pub(crate) fn kill_tracked_agent_pids(agent_pids: &AgentPidState) {
    let pids: Vec<u32> = match agent_pids.0.lock() {
        Ok(map) => map.values().copied().collect(),
        Err(e) => {
            log::warn!("kill_tracked_agent_pids: lock failed: {}", e);
            return;
        }
    };
    for pid in pids {
        log::info!("app exit: tree-killing tracked agent pid {}", pid);
        // `/T` tree-kills — same rationale as agent_run_kill and
        // run_shell_inner's timeout path: claude/codex frequently spawn
        // nested child processes (shell tool calls, npm/node subprocesses).
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
    }
}

/// Best-effort insert into an `AgentPidState`-shaped PID map. Used by
/// `agent_run` and `spawn_scheduler` right after a mission's child process
/// spawns. A poisoned lock (some other thread panicked while holding it) is
/// logged and skipped rather than propagated — mirrors
/// `kill_tracked_agent_pids`'s degrade-gracefully contract above, instead of
/// the bare `.lock().unwrap()` this replaces, which would cascade-panic this
/// mission's background thread on an already-poisoned lock.
pub(crate) fn track_agent_pid(pids: &Arc<Mutex<HashMap<String, u32>>>, id: &str, pid: u32) {
    match pids.lock() {
        Ok(mut map) => {
            map.insert(id.to_string(), pid);
        }
        Err(e) => log::warn!("AgentPidState lock poisoned — pid {} not tracked for '{}': {}", pid, id, e),
    }
}

/// Best-effort removal from an `AgentPidState`-shaped PID map. Used by
/// `agent_run` and `spawn_scheduler` once the mission's child process exits.
/// Same degrade-gracefully contract as `track_agent_pid` — see its doc
/// comment.
pub(crate) fn untrack_agent_pid(pids: &Arc<Mutex<HashMap<String, u32>>>, id: &str) {
    match pids.lock() {
        Ok(mut map) => {
            map.remove(id);
        }
        Err(e) => log::warn!("AgentPidState lock poisoned — could not untrack '{}': {}", id, e),
    }
}

/// State holding PID of active agent_run processes (mission_id -> pid).
pub struct AgentPidState(pub Arc<Mutex<HashMap<String, u32>>>);

impl Default for AgentPidState {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentPidState {
    pub fn new() -> Self {
        AgentPidState(Arc::new(Mutex::new(HashMap::new())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirrors the insert-on-spawn / remove-on-completion pattern used by
    /// agent_run (and spawn_scheduler): the map must reflect "still running"
    /// only for genuinely in-flight missions, so a later exit-hook sweep
    /// never targets a PID from a run that already finished (and whose PID
    /// the OS may have since reused for an unrelated process).
    #[test]
    fn agent_pid_state_bookkeeping_insert_and_remove() {
        let state = super::AgentPidState::new();
        let id = "mission-test".to_string();

        {
            let mut map = state.0.lock().expect("lock");
            map.insert(id.clone(), 4242);
        }
        assert_eq!(
            state.0.lock().expect("lock").get(&id),
            Some(&4242),
            "PID must be present while the mission is tracked as running"
        );

        // Simulate the completion-path cleanup (child.wait() returned) that
        // both agent_run and spawn_scheduler already perform.
        {
            let mut map = state.0.lock().expect("lock");
            map.remove(&id);
        }
        assert_eq!(
            state.0.lock().expect("lock").get(&id),
            None,
            "PID must be removed once the run finishes"
        );
        eprintln!("agent_pid_state_bookkeeping_insert_and_remove PASSED");
    }

    /// kill_tracked_agent_pids must be best-effort (like agent_run_kill) and
    /// never panic when a tracked PID no longer corresponds to a real
    /// process — the common case, since a mission that's still in the map
    /// when the app exits is usually exiting/already-gone by the time the
    /// taskkill/kill call actually runs.
    #[test]
    fn kill_tracked_agent_pids_is_best_effort_and_does_not_panic() {
        let state = super::AgentPidState::new();
        {
            let mut map = state.0.lock().expect("lock");
            // Fake, essentially-guaranteed-nonexistent PIDs.
            map.insert("mission-a".to_string(), 999_999_001);
            map.insert("mission-b".to_string(), 999_999_002);
        }
        super::kill_tracked_agent_pids(&state);
        eprintln!("kill_tracked_agent_pids_is_best_effort_and_does_not_panic PASSED");
    }

    /// A poisoned-lock AgentPidState must degrade gracefully (log + return)
    /// rather than panic — the exit hook runs during app teardown, where a
    /// panic would be especially unwelcome.
    #[test]
    fn kill_tracked_agent_pids_handles_poisoned_lock_without_panicking() {
        use std::panic;
        use std::sync::Arc;

        let state = super::AgentPidState::new();
        let inner = Arc::clone(&state.0);
        // Deliberately poison the mutex by panicking while holding the lock.
        let _ = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let _guard = inner.lock().expect("lock");
            panic!("intentional poison for test");
        }));

        // Must not panic — kill_tracked_agent_pids logs a warning and returns.
        super::kill_tracked_agent_pids(&state);
        eprintln!("kill_tracked_agent_pids_handles_poisoned_lock_without_panicking PASSED");
    }

    // ── track_agent_pid / untrack_agent_pid ─────────────────────────
    //
    // These back the 4 former `pids_clone.lock().unwrap()` call sites in
    // agent_run and spawn_scheduler (mission-pid insert/remove around a
    // spawned child process). A poisoned AgentPidState lock must degrade
    // gracefully here exactly like kill_tracked_agent_pids /
    // stop_brain_sidecar_for_exit already do — a bare .unwrap() would have
    // cascade-panicked the mission's background thread.

    #[test]
    fn track_agent_pid_inserts_and_untrack_agent_pid_removes() {
        use super::{track_agent_pid, untrack_agent_pid};
        use std::collections::HashMap;
        use std::sync::{Arc, Mutex};

        let pids: Arc<Mutex<HashMap<String, u32>>> = Arc::new(Mutex::new(HashMap::new()));

        track_agent_pid(&pids, "mission-x", 4242);
        assert_eq!(
            pids.lock().expect("lock").get("mission-x"),
            Some(&4242),
            "pid must be tracked after track_agent_pid"
        );

        untrack_agent_pid(&pids, "mission-x");
        assert_eq!(
            pids.lock().expect("lock").get("mission-x"),
            None,
            "pid must be gone after untrack_agent_pid"
        );

        eprintln!("track_agent_pid_inserts_and_untrack_agent_pid_removes PASSED");
    }

    #[test]
    fn track_agent_pid_handles_poisoned_lock_without_panicking() {
        use super::track_agent_pid;
        use std::collections::HashMap;
        use std::panic;
        use std::sync::{Arc, Mutex};

        let pids: Arc<Mutex<HashMap<String, u32>>> = Arc::new(Mutex::new(HashMap::new()));
        let inner = Arc::clone(&pids);
        let _ = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let _guard = inner.lock().expect("lock");
            panic!("intentional poison for test");
        }));

        // Must not panic — track_agent_pid logs a warning and returns.
        track_agent_pid(&pids, "mission-y", 999);
        eprintln!("track_agent_pid_handles_poisoned_lock_without_panicking PASSED");
    }

    #[test]
    fn untrack_agent_pid_handles_poisoned_lock_without_panicking() {
        use super::untrack_agent_pid;
        use std::collections::HashMap;
        use std::panic;
        use std::sync::{Arc, Mutex};

        let pids: Arc<Mutex<HashMap<String, u32>>> = Arc::new(Mutex::new(HashMap::new()));
        let inner = Arc::clone(&pids);
        let _ = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let _guard = inner.lock().expect("lock");
            panic!("intentional poison for test");
        }));

        // Must not panic — untrack_agent_pid logs a warning and returns.
        untrack_agent_pid(&pids, "mission-y");
        eprintln!("untrack_agent_pid_handles_poisoned_lock_without_panicking PASSED");
    }

    // ── format_mission_panic_payload (agent_run/spawn_scheduler panic net) ──
    //
    // Both mission closures wrap their body in catch_unwind and feed the Err
    // payload through this function to build the log::error line and the
    // done/error event messages. Spawning a real mission thread/process to
    // exercise the full wrapper is not worth the flakiness here — this
    // function is the one piece of that wrapper with real logic (the rest
    // is direct calls to catch_unwind/emit/untrack_agent_pid, already
    // covered by their own tests elsewhere in this module), so testing it
    // directly plus one real catch_unwind round-trip is enough coverage.

    /// The exact downcast chain a `catch_unwind` Err payload goes through:
    /// a plain `panic!("literal")` payload is `&'static str`, a formatted
    /// `panic!("{}", x)` / `.expect(msg)` payload is `String`, and anything
    /// else (a custom `panic_any` payload) must still produce SOME message
    /// rather than being silently lost — mirrors install_panic_hook's own
    /// payload downcast in lib.rs.
    #[test]
    fn format_mission_panic_payload_covers_str_string_and_other_payloads() {
        let str_payload: Box<dyn std::any::Any + Send> = Box::new("boom");
        assert_eq!(format_mission_panic_payload(&*str_payload), "boom");

        let string_payload: Box<dyn std::any::Any + Send> = Box::new(String::from("kaboom"));
        assert_eq!(format_mission_panic_payload(&*string_payload), "kaboom");

        let other_payload: Box<dyn std::any::Any + Send> = Box::new(42i32);
        assert_eq!(
            format_mission_panic_payload(&*other_payload),
            "<non-string panic payload>"
        );

        eprintln!("format_mission_panic_payload_covers_str_string_and_other_payloads PASSED");
    }

    /// End-to-end proof that a real `catch_unwind`'d panic feeds correctly
    /// into `format_mission_panic_payload` — the exact call shape
    /// `agent_run`/`spawn_scheduler`'s panic-safety-net branch uses, just
    /// without spawning a real mission thread/process.
    #[test]
    fn format_mission_panic_payload_reads_a_real_caught_panic() {
        let result: std::thread::Result<()> = std::panic::catch_unwind(|| {
            panic!("simulated mission panic");
        });
        let payload = result.expect_err("test precondition: the panic must have happened");
        assert_eq!(
            format_mission_panic_payload(&*payload),
            "simulated mission panic"
        );
        eprintln!("format_mission_panic_payload_reads_a_real_caught_panic PASSED");
    }
}
