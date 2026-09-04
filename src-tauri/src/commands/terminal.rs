//! PTY-backed terminal commands (spawn/write/resize/kill).

use std::collections::HashMap;
use std::io::{Read as IoRead, Write as IoWrite};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::Emitter;
use uuid::Uuid;

pub(crate) struct PtyHandle {
    writer: Box<dyn IoWrite + Send>,
    master: Box<dyn MasterPty + Send>,
    /// Shared with the per-terminal exit watchdog spawned in
    /// `terminal_spawn` (see its doc comment) — `Arc<Mutex<_>>` rather than
    /// a plain `Box` so both `terminal_kill` and the watchdog can act on the
    /// same child. The watchdog only ever polls the non-blocking
    /// `try_wait()` while holding this lock (never the blocking `wait()`),
    /// so an explicit `terminal_kill` is never stuck waiting behind it.
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
}

type PtyMap = Arc<Mutex<HashMap<String, PtyHandle>>>;

#[derive(Default)]
pub struct PtyState(PtyMap);

impl PtyState {
    pub fn new() -> Self {
        PtyState(Arc::new(Mutex::new(HashMap::new())))
    }
}

/// Stable prefix `terminal_spawn`'s `Err(String)` carries when the
/// underlying OS refused to create the process for lack of memory —
/// Windows `os error 8` (ERROR_NOT_ENOUGH_MEMORY, surfaced by
/// portable_pty's CreateProcessW wrapper) or the POSIX ENOMEM equivalent.
/// 2026-07-21/22 memory-pressure incident: the founder's machine, woken
/// from sleep with ~1.4GB free RAM, hit exactly this failure while the app
/// auto-spawned a dev server — the raw OS error string surfaced as an
/// unowned dialog instead of a soft, recoverable notice. The TS layer
/// (devPreview.ts's spawn catch block) matches on this exact prefix to
/// distinguish this transient resource-pressure failure — worth a deferred
/// single retry — from every other spawn failure (bad shell config,
/// permission denied, missing binary, ...), which must keep failing
/// loudly/honestly exactly as before. Kept as a plain string prefix (not a
/// typed Rust error enum crossing the IPC boundary) because every
/// `#[tauri::command]` in this file already returns `Result<_, String>` —
/// see this file's own convention throughout.
pub(crate) const SPAWN_ERROR_INSUFFICIENT_MEMORY_PREFIX: &str = "INSUFFICIENT_MEMORY: ";

/// True when `message` (an already-formatted spawn-failure string) describes
/// an OS-level "not enough memory to create this process" failure — checked
/// via substring match on the OS's own error text (case-insensitive) rather
/// than a typed error code, since `portable_pty`'s cross-platform error type
/// does not expose a stable `raw_os_error()` accessor at this call site.
///
/// `os error 8` is checked ONLY on Windows (`cfg!(windows)`), where it
/// unambiguously means `ERROR_NOT_ENOUGH_MEMORY` — the real incident this
/// fix closes. On POSIX, raw errno 8 is `ENOEXEC` ("exec format error", a
/// completely unrelated failure), so that bare code is never trusted there;
/// the OS's own message text ("not enough memory" / "enomem") is the only
/// signal on that platform.
fn is_insufficient_memory_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    if cfg!(windows) && lower.contains("os error 8") {
        return true;
    }
    lower.contains("not enough memory") || lower.contains("enomem")
}

/// Spawn a native PTY with a default shell (PowerShell on Windows, sh elsewhere).
/// Returns a session id. Emits `terminal://output/{id}` events with output chunks.
///
/// # Arguments
/// * `cwd` - Optional working directory for the PTY. If provided, must be an existing directory.
///   If None, uses the current Tauri process directory.
#[tauri::command]
pub(crate) fn terminal_spawn(
    state: tauri::State<PtyState>,
    app: tauri::AppHandle,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<String, String> {
    let pty_system = native_pty_system();

    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("openpty failed: {}", e))?;

    // Choose default shell: powershell.exe on Windows, $SHELL elsewhere.
    // On Windows, LAZY_SHELL is validated against an explicit allowlist to prevent
    // an attacker from redirecting the terminal to an arbitrary executable (#45).
    let shell = if cfg!(target_os = "windows") {
        const WINDOWS_SHELL_ALLOWLIST: &[&str] = &["powershell.exe", "pwsh.exe", "cmd.exe"];
        let requested = std::env::var("LAZY_SHELL").unwrap_or_else(|_| "powershell.exe".to_string());
        let lower = requested.to_lowercase();
        // Strip any directory component for the allowlist check.
        let basename = std::path::Path::new(&lower)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(lower.as_str())
            .to_string();
        if WINDOWS_SHELL_ALLOWLIST.contains(&basename.as_str()) {
            requested
        } else {
            log::warn!("terminal_spawn: LAZY_SHELL '{}' not in allowlist; falling back to powershell.exe", requested);
            "powershell.exe".to_string()
        }
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    };

    let mut cmd = CommandBuilder::new(&shell);

    // Resolve and set the working directory for the PTY
    let spawn_cwd = resolve_spawn_cwd(cwd)?;
    cmd.cwd(spawn_cwd);

    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        let detail = format!("spawn_command failed for '{}': {}", shell, e);
        if is_insufficient_memory_error(&detail) {
            format!("{}{}", SPAWN_ERROR_INSUFFICIENT_MEMORY_PREFIX, detail)
        } else {
            detail
        }
    })?;

    let id = Uuid::new_v4().to_string();
    let event_name = format!("terminal://output/{}", id);

    // Clone master for reading (reader lives in the spawned thread)
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader failed: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {}", e))?;

    // Spawn background reader thread
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    // Emit to the frontend; ignore send errors (window may have closed)
                    let _ = app.emit(&event_name, chunk);
                }
                Err(_) => break,
            }
        }
    });

    let child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>> = Arc::new(Mutex::new(child));

    // Child-exit watchdog: on Windows, ConPTY does not signal EOF to the
    // reader thread above when the child exits on its own (Ctrl+D, `exit`,
    // a crashed shell) — only closing the PTY master does that (see
    // pty_echo_test's doc comment, and close_terminal_session_from_watchdog
    // below, which reuses terminal_kill's exact drop-the-handle mechanism).
    // Previously ONLY an explicit terminal_kill call closed it, so any path
    // that let a terminal go away without that call (e.g. the shell process
    // itself exiting while its tab/session was otherwise abandoned) leaked
    // the reader thread forever, parked in a blocking read nothing will
    // ever unblock, plus this session's map entry.
    //
    // Polls the non-blocking try_wait() (never the blocking wait()) so the
    // shared child lock is only ever held briefly — see PtyHandle::child's
    // doc comment for why that matters. Self-terminates within one poll
    // interval of either the child exiting on its own OR an explicit
    // terminal_kill call (which also drops the child handle, and
    // try_wait() surfaces that as "exited" here too) — net effect: a shell
    // exiting ends both the reader and this watchdog within ~1s.
    {
        let child_for_watchdog = child.clone();
        let map_for_watchdog = state.0.clone();
        let id_for_watchdog = id.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(300));
                let exited = match child_for_watchdog.lock() {
                    Ok(mut c) => !matches!(c.try_wait(), Ok(None)),
                    Err(e) => {
                        log::warn!(
                            "terminal watchdog ({}): child lock poisoned, cleaning up defensively: {}",
                            id_for_watchdog, e
                        );
                        true
                    }
                };
                if exited {
                    close_terminal_session_from_watchdog(&map_for_watchdog, &id_for_watchdog);
                    break;
                }
            }
        });
    }

    let handle = PtyHandle {
        writer,
        master: pair.master,
        child,
    };

    state
        .0
        .lock()
        .map_err(|e| format!("state lock failed: {}", e))?
        .insert(id.clone(), handle);

    Ok(id)
}

/// Write data to a PTY session.
#[tauri::command]
pub(crate) fn terminal_write(
    state: tauri::State<PtyState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut map = state
        .0
        .lock()
        .map_err(|e| format!("state lock failed: {}", e))?;

    let handle = map
        .get_mut(&id)
        .ok_or_else(|| format!("terminal session '{}' not found", id))?;

    handle
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write failed: {}", e))?;

    handle
        .writer
        .flush()
        .map_err(|e| format!("flush failed: {}", e))
}

/// Resize a PTY session.
#[tauri::command]
pub(crate) fn terminal_resize(
    state: tauri::State<PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state
        .0
        .lock()
        .map_err(|e| format!("state lock failed: {}", e))?;

    let handle = map
        .get(&id)
        .ok_or_else(|| format!("terminal session '{}' not found", id))?;

    handle
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {}", e))
}

/// Kill a PTY session and drop its resources.
#[tauri::command]
pub(crate) fn terminal_kill(
    state: tauri::State<PtyState>,
    id: String,
) -> Result<(), String> {
    let mut map = state
        .0
        .lock()
        .map_err(|e| format!("state lock failed: {}", e))?;

    let handle = map
        .remove(&id)
        .ok_or_else(|| format!("terminal session '{}' not found", id))?;

    // Best-effort kill; ignore errors (process may have already exited).
    // Briefly locks the shared child (see PtyHandle::child's doc comment) —
    // the exit watchdog spawned in terminal_spawn only ever holds this same
    // lock for a non-blocking try_wait() poll, never across a blocking
    // wait, so this can never be stuck waiting behind it.
    if let Ok(mut child) = handle.child.lock() {
        let _ = child.kill();
    }
    drop(handle);

    Ok(())
}

/// Best-effort kill of every currently-tracked PTY session — called from
/// the app-exit hook (`run_exit_cleanup`, lib.rs) so a leaked/forgotten
/// terminal session (e.g. a PTY orphaned by a frontend effect racing its own
/// cleanup — see TerminalView.tsx's spawn-effect doc comment for the exact
/// leak this closes one layer down) never survives the IDE closing, and so
/// the OS is never left tearing down a large number of still-open PTY child
/// processes/threads on its own after this process has already exited.
/// Poison-safe like `commands::mcp::kill_all_mcp_servers`: a poisoned lock
/// is logged and skipped, never propagated or panicked, since this runs
/// during app teardown where a panic would be especially unwelcome.
///
/// Entries are drained into a local `Vec` under a brief lock, then the guard
/// is dropped BEFORE that `Vec` (and therefore every `PtyHandle`'s child
/// kill) runs — same "never hold the map lock across the actual kill work"
/// rationale `kill_all_mcp_servers`/`kill_browser_instance` already
/// document for their own drain step.
pub(crate) fn kill_all_terminal_sessions(state: &PtyState) {
    let drained: Vec<(String, PtyHandle)> = match state.0.lock() {
        Ok(mut map) => map.drain().collect(),
        Err(e) => {
            log::warn!("kill_all_terminal_sessions: lock poisoned: {}", e);
            return;
        }
    };
    let count = drained.len();
    for (_id, handle) in &drained {
        if let Ok(mut child) = handle.child.lock() {
            let _ = child.kill();
        }
    }
    drop(drained);
    if count > 0 {
        log::info!("app exit: stopped {} terminal session(s)", count);
    }
}

/// Same effect as `terminal_kill` (remove the session, best-effort kill,
/// drop the handle — dropping `master` is what actually unblocks the
/// reader thread, see terminal_spawn's watchdog comment) but silent and
/// idempotent: the watchdog has no caller to report an error to, and
/// legitimately races an explicit `terminal_kill` on the same id —
/// whichever of the two removes the id from the map first "wins"; the
/// other finds nothing there and safely no-ops.
fn close_terminal_session_from_watchdog(map: &PtyMap, id: &str) {
    let handle = match map.lock() {
        Ok(mut guard) => guard.remove(id),
        Err(e) => {
            log::warn!("terminal watchdog: state lock poisoned for '{}': {}", id, e);
            return;
        }
    };
    if let Some(handle) = handle {
        if let Ok(mut child) = handle.child.lock() {
            let _ = child.kill();
        }
        drop(handle);
    }
}

/// Resolve and validate a cwd for PTY spawn.
/// If cwd is None, returns the current directory.
/// If cwd is Some, validates that the directory exists and returns it as an absolute path.
fn resolve_spawn_cwd(cwd: Option<String>) -> Result<std::path::PathBuf, String> {
    match cwd {
        None => {
            std::env::current_dir()
                .map_err(|e| format!("Failed to get current directory: {}", e))
        }
        Some(path) => {
            let p = std::path::PathBuf::from(path);
            if !p.exists() {
                return Err(format!("Working directory does not exist: {}", p.display()));
            }
            if !p.is_dir() {
                return Err(format!("Path is not a directory: {}", p.display()));
            }
            Ok(p)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Spawns `cmd /c echo lazy-pty-ok` via a native PTY and asserts that the
    /// output contains the expected sentinel string.
    ///
    /// On Windows the PTY master does not signal EOF when the child exits, so
    /// we read in small chunks and stop as soon as the sentinel appears or after
    /// a generous timeout.
    #[test]
    fn pty_echo_test() {
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty failed");

        let mut cmd = CommandBuilder::new("cmd");
        cmd.args(["/c", "echo lazy-pty-ok"]);

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .expect("spawn_command failed");

        // Drop slave — on Unix this triggers EOF; on Windows it's a no-op
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("clone_reader failed");

        // Collect output in a background thread with a deadline
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 512];
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut accumulated = String::new();
            loop {
                if Instant::now() >= deadline {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        accumulated.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if accumulated.contains("lazy-pty-ok") {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = tx.send(accumulated);
        });

        // Wait for child to exit (gives it a chance to flush)
        let _ = child.wait();

        // Give the reader thread up to 12 s to produce the sentinel
        let output = rx
            .recv_timeout(Duration::from_secs(12))
            .unwrap_or_default();

        assert!(
            output.contains("lazy-pty-ok"),
            "Expected 'lazy-pty-ok' in PTY output, got: {:?}",
            output
        );
    }

    /// Test that resolve_spawn_cwd accepts None and returns current directory
    #[test]
    fn resolve_spawn_cwd_none_returns_current_dir() {
        let result = resolve_spawn_cwd(None);
        assert!(result.is_ok(), "None should return current directory");
    }

    /// Test that resolve_spawn_cwd rejects a non-existent path
    #[test]
    fn resolve_spawn_cwd_rejects_missing_dir() {
        let result = resolve_spawn_cwd(Some("/nonexistent/path/12345".to_string()));
        assert!(result.is_err(), "Non-existent path should be rejected");
        assert!(
            result.unwrap_err().contains("does not exist"),
            "Error should mention non-existence"
        );
    }

    /// Test that resolve_spawn_cwd accepts an existing directory
    #[test]
    fn resolve_spawn_cwd_accepts_existing_dir() {
        let temp_dir = std::env::temp_dir();
        let result = resolve_spawn_cwd(Some(temp_dir.to_string_lossy().to_string()));
        assert!(result.is_ok(), "Existing directory should be accepted");
        assert_eq!(
            result.unwrap().to_string_lossy().to_string(),
            temp_dir.to_string_lossy().to_string()
        );
    }

    /// Test that resolve_spawn_cwd rejects a file path (not a directory)
    #[test]
    fn resolve_spawn_cwd_rejects_file_path() {
        let temp_file = std::env::temp_dir().join("test_file_12345.txt");
        let _ = std::fs::write(&temp_file, "test");
        let result = resolve_spawn_cwd(Some(temp_file.to_string_lossy().to_string()));
        let _ = std::fs::remove_file(&temp_file);
        assert!(result.is_err(), "File path should be rejected");
        assert!(
            result.unwrap_err().contains("not a directory"),
            "Error should mention it is not a directory"
        );
    }

    // ── 2026-07-22 memory-pressure incident: is_insufficient_memory_error ──

    /// Matches the real incident's own log text (Windows os error 8 —
    /// ERROR_NOT_ENOUGH_MEMORY, surfaced by portable_pty's CreateProcessW
    /// wrapper).
    #[test]
    fn is_insufficient_memory_error_matches_windows_os_error_8() {
        assert!(is_insufficient_memory_error(
            "spawn_command failed for 'powershell.exe': CreateProcessW failed: os error 8 (not enough memory)"
        ));
    }

    /// Matches a generic "not enough memory" phrasing even without the
    /// literal "os error 8" substring (belt-and-suspenders — different
    /// portable_pty backends may phrase this differently).
    #[test]
    fn is_insufficient_memory_error_matches_generic_not_enough_memory_text() {
        assert!(is_insufficient_memory_error("Not enough memory to start the process"));
    }

    /// Matches the POSIX ENOMEM equivalent.
    #[test]
    fn is_insufficient_memory_error_matches_enomem() {
        assert!(is_insufficient_memory_error("fork failed: ENOMEM (os error 12)"));
    }

    /// Never false-positives on an unrelated spawn failure — every OTHER
    /// spawn error must keep failing exactly as before this fix (no soft
    /// retry, no deferred-spawn journal event).
    #[test]
    fn is_insufficient_memory_error_does_not_match_unrelated_failures() {
        assert!(!is_insufficient_memory_error(
            "spawn_command failed for 'powershell.exe': The system cannot find the file specified. (os error 2)"
        ));
        assert!(!is_insufficient_memory_error(
            "spawn_command failed for 'powershell.exe': Access is denied. (os error 5)"
        ));
    }

    /// terminal_spawn's error-mapping closure prefixes ONLY an
    /// insufficient-memory failure with the stable marker the TS layer
    /// matches on — every other failure's message passes through unchanged.
    #[test]
    fn spawn_error_prefix_applies_only_to_memory_failures() {
        let memory_detail = "spawn_command failed for 'powershell.exe': CreateProcessW failed: os error 8 (not enough memory)".to_string();
        let other_detail = "spawn_command failed for 'powershell.exe': Access is denied. (os error 5)".to_string();

        let prefixed = if is_insufficient_memory_error(&memory_detail) {
            format!("{}{}", SPAWN_ERROR_INSUFFICIENT_MEMORY_PREFIX, memory_detail)
        } else {
            memory_detail.clone()
        };
        let unprefixed = if is_insufficient_memory_error(&other_detail) {
            format!("{}{}", SPAWN_ERROR_INSUFFICIENT_MEMORY_PREFIX, other_detail)
        } else {
            other_detail.clone()
        };

        assert!(prefixed.starts_with(SPAWN_ERROR_INSUFFICIENT_MEMORY_PREFIX));
        assert_eq!(unprefixed, other_detail);
    }

    // ── Exit-watchdog cleanup (close_terminal_session_from_watchdog) ────

    /// Builds a `PtyHandle` around a trivial, near-instantly-exiting child
    /// — enough to exercise session removal/kill logic without needing a
    /// real interactive shell.
    fn trivial_pty_handle() -> PtyHandle {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty failed");
        let mut cmd = if cfg!(windows) {
            let mut c = CommandBuilder::new("cmd");
            c.args(["/C", "exit", "0"]);
            c
        } else {
            let mut c = CommandBuilder::new("sh");
            c.args(["-c", "exit 0"]);
            c
        };
        cmd.cwd(std::env::temp_dir());
        let child = pair.slave.spawn_command(cmd).expect("spawn trivial child for test");
        let writer = pair.master.take_writer().expect("take_writer failed");
        PtyHandle { writer, master: pair.master, child: Arc::new(Mutex::new(child)) }
    }

    /// The idempotency this function exists for: calling it on an id that
    /// is not (or no longer) in the map — e.g. terminal_kill already won
    /// the race — must be a safe no-op, never a panic or error.
    #[test]
    fn close_terminal_session_from_watchdog_is_a_noop_for_unknown_id() {
        let map: PtyMap = Arc::new(Mutex::new(HashMap::new()));
        close_terminal_session_from_watchdog(&map, "does-not-exist");
        assert!(map.lock().unwrap().is_empty());
    }

    /// The common watchdog-wins case: a tracked session is removed from the
    /// map (dropping its `master`, which is what unblocks the reader
    /// thread — see terminal_spawn's watchdog comment).
    #[test]
    fn close_terminal_session_from_watchdog_removes_a_tracked_session() {
        let map: PtyMap = Arc::new(Mutex::new(HashMap::new()));
        map.lock().unwrap().insert("session-1".to_string(), trivial_pty_handle());
        assert!(map.lock().unwrap().contains_key("session-1"));

        close_terminal_session_from_watchdog(&map, "session-1");

        assert!(
            !map.lock().unwrap().contains_key("session-1"),
            "the session must be removed from the map"
        );
    }

    /// No double-close race: calling it twice in a row for the same id
    /// (simulating the watchdog and an explicit terminal_kill both firing)
    /// must not panic — the second call simply finds nothing.
    #[test]
    fn close_terminal_session_from_watchdog_is_idempotent_across_two_calls() {
        let map: PtyMap = Arc::new(Mutex::new(HashMap::new()));
        map.lock().unwrap().insert("session-1".to_string(), trivial_pty_handle());

        close_terminal_session_from_watchdog(&map, "session-1");
        close_terminal_session_from_watchdog(&map, "session-1"); // must not panic

        assert!(map.lock().unwrap().is_empty());
    }

    /// Only the targeted id is removed — an unrelated session in the same
    /// map must survive untouched.
    #[test]
    fn close_terminal_session_from_watchdog_leaves_other_sessions_untouched() {
        let map: PtyMap = Arc::new(Mutex::new(HashMap::new()));
        map.lock().unwrap().insert("session-1".to_string(), trivial_pty_handle());
        map.lock().unwrap().insert("session-2".to_string(), trivial_pty_handle());

        close_terminal_session_from_watchdog(&map, "session-1");

        let guard = map.lock().unwrap();
        assert!(!guard.contains_key("session-1"));
        assert!(guard.contains_key("session-2"), "unrelated session must be untouched");
    }
}
