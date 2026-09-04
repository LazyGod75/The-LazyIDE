//! The scheduler's background firing loop: ticks every 10s, checks which
//! `ScheduledAgent`s are due, and spawns each due agent as a headless
//! claude mission (mirrors `run.rs`'s `agent_run` mission-thread pattern).
//!
//! NOT wired for cross-project read access (extra_roots.rs): unlike
//! `agent_run`, a `ScheduledAgent` has no per-invocation `AgentRunRequest`-
//! shaped caller payload and no worktree — it is a persisted cron config
//! (name/cron/system_prompt/model_tier/permission_mode/project_root) that
//! always runs `current_dir`'d straight into its OWN `project_root`, with no
//! notion of "this run's declared extra roots" to validate or thread
//! through. Extending this would mean adding a new persisted field to
//! `ScheduledAgent` (scheduler.rs) and its storage schema plus scheduler UI
//! — a materially different, larger change than reusing `extra_roots.rs`
//! here, and out of this feature's scope.

use std::collections::HashMap;
use std::collections::HashSet;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use tauri::Emitter;

use crate::permission_flag;
use crate::commands::chat::extract_text_from_stream_json;
use crate::commands::util::{
    normalize_for_git, quiet_command, resolve_cli_program, spawn_stderr_tail, tree_kill_args,
    BoundedGatePermit, STDERR_TAIL_CAP_BYTES,
};

use super::lifecycle::{
    format_mission_panic_payload, track_agent_pid, untrack_agent_pid, MISSION_GATE,
    MISSION_HARD_DEADLINE_SECS,
};
use super::scheduler::ScheduledAgent;

/// RAII guard for one `spawn_scheduler`-fired mission run. On drop (every
/// exit path of the mission thread — spawn failure or normal completion,
/// via `_run_guard`'s field-drop order the same way `_mission_permit` works
/// in `agent_run`) this removes `agent_id` from `running_agents` — clearing
/// spawn_scheduler's anti-overlap flag — and releases the held
/// `MISSION_GATE` permit. Bundled into one guard so both effects free at
/// the exact same moment the mission genuinely ends, never separately.
struct ScheduledRunGuard {
    running_agents: Arc<Mutex<HashSet<String>>>,
    agent_id: String,
    _mission_permit: BoundedGatePermit<'static>,
}

impl Drop for ScheduledRunGuard {
    fn drop(&mut self) {
        match self.running_agents.lock() {
            Ok(mut running) => { running.remove(&self.agent_id); }
            Err(e) => log::warn!(
                "ScheduledRunGuard: running_agents lock poisoned — could not clear '{}': {}",
                self.agent_id, e
            ),
        }
    }
}

/// Spawn the background scheduler loop. Checks every minute whether any
/// scheduled agent is due; if so, runs it headless via `agent_run` pattern
/// (compile agent, spawn claude CLI, emit mission events).
pub(crate) fn spawn_scheduler(
    app: tauri::AppHandle,
    scheduler_state: Arc<Mutex<Vec<ScheduledAgent>>>,
    agent_pids: Arc<Mutex<HashMap<String, u32>>>,
) {
    // Anti-overlap: agent ids with a run currently in flight. Each fire
    // gets a fresh mission_id (`sched-{name}-{timestamp}`), so agent_pids
    // (keyed by mission_id) cannot answer "is agent X's PREVIOUS run still
    // alive" — this separate agent_id-keyed set is what does. Without it, an
    // agent whose run overruns its own cron interval stacks a new
    // concurrent run every time that interval next matches.
    let running_agents: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    tauri::async_runtime::spawn(async move {
        use chrono::Timelike;

        let mut last_checked_minute: u32 = u32::MAX;

        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;

            let now = chrono::Utc::now();
            let current_minute = now.minute();

            // Fire at most once per minute
            if current_minute == last_checked_minute {
                continue;
            }
            last_checked_minute = current_minute;

            // Snapshot agents under lock
            let agents: Vec<ScheduledAgent> = {
                let guard = match scheduler_state.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                guard.clone()
            };

            for agent in agents {
                if !super::scheduler::cron_matches(&agent.cron, &now) {
                    continue;
                }

                // Anti-overlap guard — see running_agents' doc comment above.
                {
                    let running = running_agents.lock().unwrap_or_else(|e| e.into_inner());
                    if running.contains(&agent.id) {
                        log::info!(
                            "Scheduler: skipping agent '{}' (id={}) — previous run still active",
                            agent.name, agent.id
                        );
                        continue;
                    }
                }

                // Concurrency cap shared with agent_run — see MISSION_GATE's
                // doc comment. No caller is awaiting a promise here (this is
                // a background cron tick), so at capacity we just skip this
                // fire with a log line rather than queue or block the
                // scheduler loop itself; it is retried next time this
                // agent's cron matches.
                let mission_permit = match MISSION_GATE.try_acquire() {
                    Some(p) => p,
                    None => {
                        log::warn!(
                            "Scheduler: skipping agent '{}' (id={}) — mission limit reached ({} concurrent missions active)",
                            agent.name, agent.id, super::lifecycle::MAX_CONCURRENT_MISSIONS
                        );
                        continue;
                    }
                };
                {
                    let mut running = running_agents.lock().unwrap_or_else(|e| e.into_inner());
                    running.insert(agent.id.clone());
                }
                let run_guard = ScheduledRunGuard {
                    running_agents: running_agents.clone(),
                    agent_id: agent.id.clone(),
                    _mission_permit: mission_permit,
                };

                log::info!("Scheduler: firing agent '{}' (cron: {})", agent.name, agent.cron);

                let mission_id = format!("sched-{}-{}", agent.name, now.timestamp());
                let step_event  = format!("agent://step/{}", mission_id);
                let done_event  = format!("agent://done/{}", mission_id);
                let error_event = format!("agent://error/{}", mission_id);

                // Emit a "scheduled run started" event so Mission Control can show it
                let _ = app.emit(&step_event, serde_json::json!({
                    "kind": "system",
                    "name": "scheduler",
                    "summary": format!("Routine planifiee — agent {}", agent.name),
                }));
                let _ = app.emit("agent://scheduled-run", serde_json::json!({
                    "missionId": mission_id,
                    "agentName": agent.name,
                    "agentId": agent.id,
                    "scheduledAt": now.to_rfc3339(),
                }));

                // Build task prompt
                let task = format!(
                    "[Routine planifiee]\n\nAgent: {}\n\n{}\n\nDo the task. Be autonomous.",
                    agent.name, agent.system_prompt
                );

                let app_clone = app.clone();
                let pids_clone = agent_pids.clone();
                let model = match agent.model_tier.as_str() {
                    "haiku" => "haiku".to_string(),
                    "opus"  => "opus".to_string(),
                    _       => "sonnet".to_string(),
                };
                let sched_permission_mode = agent.permission_mode.clone();
                let sched_project_root = agent.project_root.clone();

                // Spawn the actual claude run on a dedicated OS thread —
                // missions are long-lived (up to MISSION_HARD_DEADLINE_SECS),
                // so a pooled tokio blocking-pool slot would stay pinned for
                // the mission's whole lifetime; see MISSION_GATE's doc
                // comment for why that pool is the wrong tool here.
                let name_clone = agent.name.clone();
                let id_clone = mission_id.clone();
                std::thread::spawn(move || {
                    // Panic safety net — see agent_run's identical wrapper
                    // for the full rationale. Clones taken BEFORE the
                    // mission closure below moves its own copies, so the
                    // catch_unwind Err branch still has handles to emit
                    // with after an unexpected panic.
                    let panic_app = app_clone.clone();
                    let panic_done_event = done_event.clone();
                    let panic_error_event = error_event.clone();
                    let panic_mission_id = id_clone.clone();
                    let panic_pids = pids_clone.clone();
                    let panic_name = name_clone.clone();

                    let mission_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                    // Held for the whole mission — releases the anti-overlap
                    // flag and the MISSION_GATE slot when this thread (and
                    // therefore the mission) ends, on every exit path
                    // (including an unexpected panic — catch_unwind above
                    // still unwinds this frame normally, it only stops the
                    // unwind at its own boundary, so this Drop still runs).
                    let _run_guard = run_guard;

                    use std::io::BufReader;
                    use std::io::BufRead;

                    let perm_flag = permission_flag(sched_permission_mode.as_deref());

                    // Audit log: any bypass must be explicit and traceable.
                    if perm_flag == "--dangerously-skip-permissions" {
                        eprintln!(
                            "[lazy][AUDIT] scheduler: agent '{}' (id={}) running with \
                             --dangerously-skip-permissions (permission_mode={:?}). \
                             This was explicitly configured in the agent JSON (permissionMode field).",
                            name_clone, id_clone, sched_permission_mode
                        );
                    }

                    // Deliver the task via stdin rather than argv (avoids
                    // CVE-2024-24576: Rust 1.77+ refuses to spawn .cmd/.bat
                    // with newline-containing argv on Windows, and
                    // resolve_cli_program prefers .cmd on Windows). `task` is
                    // built from agent.name/agent.system_prompt, both
                    // free-form strings read from the agent JSON config, so
                    // it can legitimately contain newlines. Mirrors
                    // agent_run's "claude" branch above.
                    let mut cmd = quiet_command(resolve_cli_program("claude"));
                    cmd.args([
                        "-p",
                        "--model", &model,
                        "--output-format", "stream-json",
                        "--verbose",
                    ]);
                    // Route through permission_flag — safe default is acceptEdits.
                    match perm_flag {
                        "--dangerously-skip-permissions" => { cmd.arg("--dangerously-skip-permissions"); }
                        "--permission-mode=plan"         => { cmd.args(["--permission-mode", "plan"]); }
                        "--permission-mode=acceptEdits"  => { cmd.args(["--permission-mode", "acceptEdits"]); }
                        _                               => { /* no extra flag */ }
                    }
                    cmd.stdin(Stdio::piped())
                       .stdout(Stdio::piped())
                       .stderr(Stdio::piped());

                    // Run in the project root so the agent can read/write project files (#27).
                    if !sched_project_root.is_empty() {
                        cmd.current_dir(normalize_for_git(&sched_project_root));
                    }

                    let mut child = match cmd.spawn() {
                        Ok(c) => c,
                        Err(e) => {
                            let msg = format!("scheduler spawn '{}' failed: {}", name_clone, e);
                            let _ = app_clone.emit(&error_event, &msg);
                            return;
                        }
                    };

                    track_agent_pid(&pids_clone, &id_clone, child.id());

                    // Feed the prompt via stdin (mirrors agent_run's identical
                    // stdin-writer thread). Write in a dedicated thread to
                    // prevent deadlock when stdout fills up before stdin is
                    // fully drained by the child process.
                    if let Some(mut stdin) = child.stdin.take() {
                        let prompt_bytes = task.clone();
                        std::thread::spawn(move || {
                            use std::io::Write;
                            let _ = stdin.write_all(prompt_bytes.as_bytes());
                            let _ = stdin.flush();
                            // dropping stdin closes the pipe, signaling EOF to the CLI
                        });
                    }

                    // Drain stderr concurrently to prevent pipe buffer deadlock.
                    // Tail-capped — see spawn_stderr_tail's doc comment.
                    let stderr_handle = child.stderr.take().map(|se| spawn_stderr_tail(se, STDERR_TAIL_CAP_BYTES));

                    let mut last_text = String::new();

                    // Dedicated reader thread + bounded mission loop — same
                    // pattern as agent_run (see its comment for the full
                    // rationale): lets the loop below notice the hard
                    // deadline and an out-of-band kill (try_wait()) without
                    // ever blocking this thread indefinitely inside
                    // `reader.lines()`, even if a grandchild process
                    // inherits the child's stdout handle and keeps it open.
                    let (line_tx, line_rx) = std::sync::mpsc::channel::<String>();
                    if let Some(stdout) = child.stdout.take() {
                        std::thread::spawn(move || {
                            let reader = BufReader::new(stdout);
                            for line_result in reader.lines() {
                                match line_result {
                                    Ok(line) => { if line_tx.send(line).is_err() { break; } }
                                    Err(_) => break,
                                }
                            }
                        });
                    }

                    // Processes one decoded stdout line — unchanged from
                    // before this restructure.
                    let mut process_line = |line: String| {
                        let trimmed = line.trim();
                        if trimmed.is_empty() { return; }
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                            let extracted = extract_text_from_stream_json(&v);
                            for text in extracted {
                                if !text.is_empty() { last_text = text; }
                            }
                        }
                    };

                    let mission_started = std::time::Instant::now();
                    let deadline = mission_started + std::time::Duration::from_secs(MISSION_HARD_DEADLINE_SECS);
                    let mut sched_timed_out = false;

                    loop {
                        match line_rx.recv_timeout(std::time::Duration::from_secs(1)) {
                            Ok(line) => process_line(line),
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                                if let Ok(Some(_status)) = child.try_wait() {
                                    // Give the reader thread a brief bounded
                                    // window to hand off any already-buffered
                                    // last line (e.g. the routine's final
                                    // text) — see agent_run's identical check
                                    // for the full rationale.
                                    while let Ok(line) = line_rx.recv_timeout(std::time::Duration::from_millis(200)) {
                                        process_line(line);
                                    }
                                    break;
                                }
                                if std::time::Instant::now() >= deadline {
                                    sched_timed_out = true;
                                    log::warn!(
                                        "Scheduler: agent '{}' (id={}) exceeded the {}s hard deadline — tree-killing pid {}",
                                        name_clone, id_clone, MISSION_HARD_DEADLINE_SECS, child.id()
                                    );
                                    #[cfg(target_os = "windows")]
                                    {
                                        let _ = quiet_command("taskkill").args(tree_kill_args(child.id())).output();
                                    }
                                    #[cfg(not(target_os = "windows"))]
                                    {
                                        unsafe { libc::kill(child.id() as i32, libc::SIGKILL); }
                                    }
                                    let drain_deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                                    while std::time::Instant::now() < drain_deadline {
                                        match line_rx.recv_timeout(std::time::Duration::from_millis(200)) {
                                            Ok(line) => process_line(line),
                                            Err(_) => break,
                                        }
                                    }
                                    break;
                                }
                                // Neither exited nor deadline reached yet — keep polling.
                            }
                        }
                    }

                    // Wait for process (already exited on every loop-exit
                    // path above — this reaps it and retrieves the real
                    // exit code without blocking).
                    let exit_code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);

                    // Collect stderr from the drain thread (errors surface in exit_code != 0)
                    let _stderr_text = stderr_handle.and_then(|h| h.join().ok()).unwrap_or_default();

                    untrack_agent_pid(&pids_clone, &id_clone);

                    let done = serde_json::json!({
                        "result": if sched_timed_out {
                            format!(
                                "Routine interrompue (delai de {}h depasse, agent {})",
                                MISSION_HARD_DEADLINE_SECS / 3600, name_clone
                            )
                        } else if last_text.is_empty() {
                            format!("Routine terminee (agent {})", name_clone)
                        } else {
                            last_text
                        },
                        "exit_code": exit_code,
                        "routine": true,
                    });
                    let _ = app_clone.emit(&done_event, done);
                    }));

                    if let Err(panic_payload) = mission_result {
                        let message = format_mission_panic_payload(&*panic_payload);
                        log::error!(
                            "Scheduler: agent '{}' (id={}) mission thread panicked: {}",
                            panic_name, panic_mission_id, message
                        );

                        // The normal completion path above (inside the
                        // catch_unwind closure) already calls
                        // untrack_agent_pid on every non-panicking exit; a
                        // panic skips past that call via unwinding, so this
                        // is the only place it runs for this outcome — the
                        // two paths are mutually exclusive, never both.
                        untrack_agent_pid(&panic_pids, &panic_mission_id);

                        let done = serde_json::json!({
                            "result": format!(
                                "Routine interrompue (panic du thread : {})",
                                message
                            ),
                            "exit_code": -1,
                            "routine": true,
                        });
                        let _ = panic_app.emit(&panic_done_event, done);
                        let _ = panic_app.emit(
                            &panic_error_event,
                            &format!(
                                "Scheduler: agent '{}' (id={}) mission thread panicked: {}",
                                panic_name, panic_mission_id, message
                            ),
                        );
                    }
                });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── ScheduledRunGuard (spawn_scheduler's anti-overlap + mission-cap guard) ──

    /// The core anti-overlap decision spawn_scheduler relies on: dropping a
    /// `ScheduledRunGuard` must clear its agent id from `running_agents`
    /// (so the NEXT cron tick for that agent is no longer skipped) and
    /// release its `MISSION_GATE` permit (so the concurrency cap slot is
    /// free for another mission) — both in the same drop, unconditionally.
    #[test]
    fn scheduled_run_guard_drop_clears_the_running_flag_and_releases_the_mission_permit() {
        let running_agents: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        running_agents.lock().unwrap().insert("agent-1".to_string());

        let permit = MISSION_GATE.try_acquire().expect("MISSION_GATE must have room in a fresh test process");
        let guard = ScheduledRunGuard {
            running_agents: running_agents.clone(),
            agent_id: "agent-1".to_string(),
            _mission_permit: permit,
        };
        assert!(running_agents.lock().unwrap().contains("agent-1"), "the flag must be set while the guard is alive");

        drop(guard);

        assert!(
            !running_agents.lock().unwrap().contains("agent-1"),
            "dropping the guard must clear the anti-overlap flag"
        );
        // The mission slot must also be free again — try_acquire must succeed.
        let _permit2 = MISSION_GATE.try_acquire()
            .expect("MISSION_GATE slot must be released again after the guard drops");
        eprintln!("scheduled_run_guard_drop_clears_the_running_flag_and_releases_the_mission_permit PASSED");
    }

    /// Poison-safety: ScheduledRunGuard::drop must degrade (log and skip)
    /// rather than panic when running_agents' lock is poisoned — same
    /// contract as kill_tracked_agent_pids_handles_poisoned_lock_without_panicking
    /// above. A panic unwinding through this Drop impl (e.g. because the
    /// mission thread itself panicked) must never cascade into a second
    /// panic-during-unwind abort.
    #[test]
    fn scheduled_run_guard_drop_is_poison_safe() {
        let running_agents: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        running_agents.lock().unwrap().insert("agent-2".to_string());

        let running_ref = &running_agents;
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = running_ref.lock().unwrap();
            panic!("simulated panic while holding running_agents' lock");
        }));
        assert!(panicked.is_err(), "test precondition: the panic must have happened");
        assert!(running_agents.is_poisoned(), "test precondition: the mutex must now be poisoned");

        let permit = MISSION_GATE.try_acquire().expect("MISSION_GATE must have room in a fresh test process");
        let guard = ScheduledRunGuard {
            running_agents: running_agents.clone(),
            agent_id: "agent-2".to_string(),
            _mission_permit: permit,
        };

        let dropped_without_panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            drop(guard);
        }));
        assert!(dropped_without_panic.is_ok(), "ScheduledRunGuard::drop must not panic on a poisoned lock");
        eprintln!("scheduled_run_guard_drop_is_poison_safe PASSED");
    }
}
