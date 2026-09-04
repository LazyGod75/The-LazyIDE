/// LSP process manager for Lazy IDE.
///
/// Spawns a language server (e.g. typescript-language-server) as a child
/// process, communicates over stdio using JSON-RPC framing (Content-Length
/// headers), and forwards server→client notifications as Tauri events on
/// `lsp://message`.
///
/// All public Tauri commands degrade gracefully when no server binary is
/// found: they return a clear error string or false — they never crash.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use std::ffi::OsStr;

fn quiet_command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

use serde::Serialize;
use tauri::Emitter;

// ── JSON-RPC framing ──────────────────────────────────────────────

/// Encode a JSON-RPC message body with the standard `Content-Length` header.
///
/// Format: `Content-Length: <n>\r\n\r\n<body>`
pub fn encode_message(body: &str) -> Vec<u8> {
    let bytes = body.as_bytes();
    let header = format!("Content-Length: {}\r\n\r\n", bytes.len());
    let mut out = Vec::with_capacity(header.len() + bytes.len());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(bytes);
    out
}

/// Read one JSON-RPC message from a `BufRead` source.
///
/// Reads header lines until a blank line, extracts `Content-Length`, then
/// reads exactly that many bytes as the body.
///
/// Returns `Ok(body)` on success, `Err(msg)` on malformed input or I/O error.
pub fn read_message<R: BufRead>(reader: &mut R) -> Result<String, String> {
    let mut content_length: Option<usize> = None;

    // Read header lines (terminated by \r\n or \n).
    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("lsp read_message: header read error: {}", e))?;
        if n == 0 {
            return Err("lsp read_message: connection closed".to_string());
        }
        let trimmed = line.trim_end_matches(['\r', '\n']).trim();
        if trimmed.is_empty() {
            // Blank line = end of headers.
            break;
        }
        // Parse Content-Length header (case-insensitive prefix).
        let lower = trimmed.to_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            let val = rest.trim();
            content_length = val
                .parse::<usize>()
                .ok()
                .filter(|&n| n > 0);
        }
        // Other headers (Content-Type, etc.) are ignored.
    }

    let len = content_length
        .ok_or_else(|| "lsp read_message: missing Content-Length header".to_string())?;

    let mut body = vec![0u8; len];
    reader
        .read_exact(&mut body)
        .map_err(|e| format!("lsp read_message: body read error: {}", e))?;

    String::from_utf8(body)
        .map_err(|e| format!("lsp read_message: body is not valid UTF-8: {}", e))
}

// ── State ──────────────────────────────────────────────────────────

/// Marker returned when the server binary was not found.
pub const UNAVAILABLE_MARKER: &str = "unavailable";

/// One active LSP server session.
struct LspSession {
    child: Child,
    stdin: ChildStdin,
    /// Monotonically increasing request id.
    next_id: i64,
    /// Pending requests: id -> oneshot sender.
    pending: HashMap<i64, std::sync::mpsc::SyncSender<Result<serde_json::Value, String>>>,
    /// Set to true when the reader thread exits (server died).
    /// Subsequent lsp_request calls fail immediately instead of timing out (#23).
    dead: bool,
}

impl Drop for LspSession {
    /// Best-effort safety net: kills the child if it is still running when
    /// this session is dropped, even via a path that forgot to kill it
    /// first. `Child`'s own `Drop` does NOT kill the process — that is
    /// exactly how restarting an LSP server for the same repo+language used
    /// to orphan the previous process forever: `lsp_start` called
    /// `HashMap::insert` with the same key, silently dropping the old
    /// `LspSession` (and its un-killed `Child`) while its reader thread
    /// (spawn_reader_thread) stayed permanently blocked in a read on a pipe
    /// nothing writes to anymore.
    ///
    /// `Child::kill` returns a `Result` rather than panicking (and `.wait()`
    /// is deliberately NOT called here — Drop must not block), so this can
    /// never panic during unwind. Not the primary cleanup path (lsp_start's
    /// stop-then-start and lsp_stop both already kill+wait explicitly
    /// before a session is dropped) — this only fires if a future code path
    /// forgets to.
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// Application state for the LSP manager.
pub struct LspState(Arc<Mutex<HashMap<String, LspSession>>>);

impl LspState {
    pub fn new() -> Self {
        LspState(Arc::new(Mutex::new(HashMap::new())))
    }
}

/// Remove and best-effort kill any existing session for `server_id` — the
/// "stop" half of lsp_start's stop-then-start guard (mirrors
/// start_or_restart_brain_sidecar's approach in commands/brain/sidecar.rs:
/// stop any previous instance FIRST, before the new one spawns). A no-op
/// when no session exists yet for this id (the common case: first start).
///
/// Poison-safe: a poisoned lock is logged and skipped — degrading to
/// "couldn't verify/stop a previous session" — rather than panicking or
/// propagating, mirroring kill_tracked_agent_pids's degrade-gracefully
/// contract (commands/agent.rs).
fn stop_lsp_session(sessions: &Arc<Mutex<HashMap<String, LspSession>>>, server_id: &str) {
    let removed = match sessions.lock() {
        Ok(mut guard) => guard.remove(server_id),
        Err(e) => {
            log::warn!(
                "stop_lsp_session: lock poisoned — could not check for a previous session for '{}': {}",
                server_id, e
            );
            return;
        }
    };
    if let Some(mut session) = removed {
        log::info!("stop_lsp_session: replacing existing session '{}'", server_id);
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
}

/// Kill every LSP server session's child process — for the app-exit hook so
/// language servers don't survive the IDE closing. Poison-safe: degrades
/// with `log::warn` on a poisoned lock instead of panicking, same pattern
/// as `kill_tracked_agent_pids` (commands/agent.rs), which has a dedicated
/// poison-safety test (see this module's own
/// `stop_all_lsp_for_exit_handles_poisoned_lock_without_panicking`).
///
/// Kill+wait run OUTSIDE the lock: the map is drained into a local, owned
/// `HashMap` (via `std::mem::take`, which also leaves an empty map behind —
/// no separate `.clear()` needed) under a brief lock, the guard is dropped,
/// and only THEN is each session's child process killed and waited on —
/// mirrors `stop_lsp_session`'s own drain-then-kill pattern just above.
/// Holding the lock across the blocking kill/wait calls would block any
/// concurrent command that also needs this state's lock for as long as the
/// whole exit sweep takes.
///
/// Wired into lib.rs's `run_exit_cleanup` exit hook (state looked up via
/// `app_handle.state::<lsp::LspState>()`, same pattern as the teams-sidecar
/// stop call there).
pub(crate) fn stop_all_lsp_for_exit(state: &LspState) {
    let drained = match state.0.lock() {
        Ok(mut guard) => std::mem::take(&mut *guard),
        Err(e) => {
            log::warn!("stop_all_lsp_for_exit: lock poisoned — could not stop LSP sessions: {}", e);
            return;
        }
    };
    for (server_id, mut session) in drained {
        log::info!("stop_all_lsp_for_exit: killing session '{}'", server_id);
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
}

// ── Binary resolution ─────────────────────────────────────────────

/// Check whether a language server binary is available for `language`.
///
/// For TypeScript/JavaScript: tries `typescript-language-server` via npx or PATH.
/// Returns the command to use, or None if not found.
fn resolve_server_command(language: &str) -> Option<Vec<String>> {
    match language.to_lowercase().as_str() {
        "typescript" | "javascript" | "typescriptreact" | "javascriptreact" | "tsx" | "jsx" => {
            // Try direct binary on PATH first.
            if probe_binary("typescript-language-server", &["--version"]) {
                return Some(vec![
                    "typescript-language-server".to_string(),
                    "--stdio".to_string(),
                ]);
            }
            // Try via npx (installs on demand if not cached — acceptable for dev).
            if probe_binary("npx", &["--version"]) {
                return Some(vec![
                    "npx".to_string(),
                    "--yes".to_string(),
                    "typescript-language-server".to_string(),
                    "--stdio".to_string(),
                ]);
            }
            None
        }
        // Future: add more languages here (rust-analyzer, pylsp, …)
        _ => None,
    }
}

/// Returns true if `binary` exits 0 when passed `args`.
fn probe_binary(binary: &str, args: &[&str]) -> bool {
    quiet_command(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

// ── Reader thread ─────────────────────────────────────────────────

/// Payload emitted on `lsp://message`.
#[derive(Clone, Serialize)]
struct LspMessageEvent {
    method: Option<String>,
    params: serde_json::Value,
}

/// Spawn a thread that reads JSON-RPC messages from the server stdout and:
/// - For notifications (no `id`): emits `lsp://message` via the app handle.
/// - For responses (has `id`): resolves the matching pending sender.
fn spawn_reader_thread(
    server_id: String,
    stdout: std::process::ChildStdout,
    sessions: Arc<Mutex<HashMap<String, LspSession>>>,
    app: tauri::AppHandle,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let body = match read_message(&mut reader) {
                Ok(b) => b,
                Err(e) => {
                    log::warn!("lsp reader ({}): {}", server_id, e);
                    break;
                }
            };

            let value: serde_json::Value = match serde_json::from_str(&body) {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("lsp reader ({}): invalid JSON: {}", server_id, e);
                    continue;
                }
            };

            let has_id = value.get("id").is_some() && !value["id"].is_null();
            if has_id {
                // It is a response — resolve the pending sender.
                let id = match value["id"].as_i64() {
                    Some(n) => n,
                    None => {
                        log::warn!("lsp reader ({}): response id is not i64", server_id);
                        continue;
                    }
                };
                let mut guard = match sessions.lock() {
                    Ok(g) => g,
                    Err(_) => break,
                };
                if let Some(session) = guard.get_mut(&server_id) {
                    if let Some(tx) = session.pending.remove(&id) {
                        let result = if let Some(err) = value.get("error") {
                            Err(err.to_string())
                        } else {
                            Ok(value.get("result").cloned().unwrap_or(serde_json::Value::Null))
                        };
                        let _ = tx.send(result);
                    }
                }
            } else {
                // It is a notification — emit as Tauri event.
                let method = value
                    .get("method")
                    .and_then(|m| m.as_str())
                    .map(|s| s.to_string());
                let params = value
                    .get("params")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let event = LspMessageEvent { method, params };
                if let Err(e) = app.emit("lsp://message", event) {
                    log::warn!("lsp reader ({}): emit failed: {}", server_id, e);
                }
            }
        }
        // Reader thread is exiting (server died or pipe closed).
        // Drain all pending request senders with an error so callers don't hang
        // waiting for the 5-second recv_timeout (#23).
        log::info!("lsp reader ({}): thread exiting — draining {} pending requests", server_id, {
            sessions.lock().map(|g| g.get(&server_id).map(|s| s.pending.len()).unwrap_or(0)).unwrap_or(0)
        });
        if let Ok(mut guard) = sessions.lock() {
            if let Some(session) = guard.get_mut(&server_id) {
                session.dead = true;
                for (_id, tx) in session.pending.drain() {
                    let _ = tx.send(Err("LSP server died".to_string()));
                }
            }
        }
    });
}

// ── Tauri commands ────────────────────────────────────────────────

/// Start an LSP server for `language` in `repo_path`.
///
/// Returns the server id on success. If no binary is found for `language`,
/// returns `Ok("unavailable")` — the frontend must check for this marker.
#[tauri::command]
pub fn lsp_start(
    repo_path: String,
    language: String,
    state: tauri::State<LspState>,
    project_registry: tauri::State<crate::state::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::commands::util::ensure_repo_in_any_open_project(&repo_path, &project_registry)?;
    let cmd_args = match resolve_server_command(&language) {
        Some(args) => args,
        None => {
            log::warn!("lsp_start: no server found for language '{}'", language);
            return Ok(UNAVAILABLE_MARKER.to_string());
        }
    };

    // Generate a stable server id from repo + language — computed BEFORE
    // spawning (previously computed after) so a previous session for this
    // exact id can be stopped first (see stop_lsp_session below) instead of
    // being silently orphaned by HashMap::insert overwriting its map entry.
    let server_id = format!(
        "{}-{}",
        language.to_lowercase(),
        repo_path
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '-')
            .take(24)
            .collect::<String>()
    );

    let sessions = state.0.clone();

    // Stop-then-start: kill+wait any previous session for this exact
    // server_id before the new child spawns — mirrors
    // start_or_restart_brain_sidecar's approach (commands/brain/sidecar.rs).
    // See stop_lsp_session's doc comment for the orphaning bug this closes.
    stop_lsp_session(&sessions, &server_id);

    let binary = &cmd_args[0];
    let args = &cmd_args[1..];

    let mut child = quiet_command(binary)
        .args(args)
        .current_dir(&repo_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("lsp_start: failed to spawn '{}': {}", binary, e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "lsp_start: no stdin handle".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "lsp_start: no stdout handle".to_string())?;

    // Insert session before starting the reader thread.
    {
        let mut guard = sessions
            .lock()
            .map_err(|e| format!("lsp_start: lock failed: {}", e))?;
        guard.insert(
            server_id.clone(),
            LspSession {
                child,
                stdin,
                next_id: 1,
                pending: HashMap::new(),
                dead: false,
            },
        );
    }

    spawn_reader_thread(server_id.clone(), stdout, sessions, app);
    log::info!("lsp_start: started '{}' for language '{}'", server_id, language);
    Ok(server_id)
}

/// Send a JSON-RPC request and wait for the matching response (5 s timeout).
///
/// Returns the `result` field as a JSON string.
#[tauri::command]
pub fn lsp_request(
    server_id: String,
    method: String,
    params_json: String,
    state: tauri::State<LspState>,
) -> Result<String, String> {
    let params: serde_json::Value = serde_json::from_str(&params_json)
        .map_err(|e| format!("lsp_request: invalid params JSON: {}", e))?;

    let (id, tx, rx) = {
        let mut guard = state
            .0
            .lock()
            .map_err(|e| format!("lsp_request: lock failed: {}", e))?;
        let session = guard
            .get_mut(&server_id)
            .ok_or_else(|| format!("lsp_request: no session '{}'", server_id))?;

        // Fail immediately if the reader thread has already exited (#23).
        if session.dead {
            return Err(format!("lsp_request: server '{}' has died", server_id));
        }

        let id = session.next_id;
        session.next_id += 1;

        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<serde_json::Value, String>>(1);
        session.pending.insert(id, tx.clone());
        (id, tx, rx)
    };

    // Write the JSON-RPC request.
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
    .to_string();

    {
        let mut guard = state
            .0
            .lock()
            .map_err(|e| format!("lsp_request: lock failed (write): {}", e))?;
        if let Some(session) = guard.get_mut(&server_id) {
            let encoded = encode_message(&body);
            session
                .stdin
                .write_all(&encoded)
                .map_err(|e| format!("lsp_request: stdin write failed: {}", e))?;
            session
                .stdin
                .flush()
                .map_err(|e| format!("lsp_request: stdin flush failed: {}", e))?;
        } else {
            // Session disappeared — clean up the sender.
            drop(tx);
            return Err(format!("lsp_request: session '{}' gone before write", server_id));
        }
    }

    // Await the response (5 second timeout).
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(val)) => Ok(val.to_string()),
        Ok(Err(e)) => Err(format!("lsp_request: server returned error: {}", e)),
        Err(_) => {
            // Timeout — remove the pending entry to avoid a leak.
            if let Ok(mut guard) = state.0.lock() {
                if let Some(session) = guard.get_mut(&server_id) {
                    session.pending.remove(&id);
                }
            }
            Err(format!(
                "lsp_request: timeout waiting for response to method '{}'",
                method
            ))
        }
    }
}

/// Send a JSON-RPC notification (no id, no response expected).
#[tauri::command]
pub fn lsp_notify(
    server_id: String,
    method: String,
    params_json: String,
    state: tauri::State<LspState>,
) -> Result<(), String> {
    let params: serde_json::Value = serde_json::from_str(&params_json)
        .map_err(|e| format!("lsp_notify: invalid params JSON: {}", e))?;

    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    })
    .to_string();

    let mut guard = state
        .0
        .lock()
        .map_err(|e| format!("lsp_notify: lock failed: {}", e))?;
    let session = guard
        .get_mut(&server_id)
        .ok_or_else(|| format!("lsp_notify: no session '{}'", server_id))?;

    let encoded = encode_message(&body);
    session
        .stdin
        .write_all(&encoded)
        .map_err(|e| format!("lsp_notify: stdin write failed: {}", e))?;
    session
        .stdin
        .flush()
        .map_err(|e| format!("lsp_notify: stdin flush failed: {}", e))
}

/// Kill the LSP server and drop its session.
#[tauri::command]
pub fn lsp_stop(
    server_id: String,
    state: tauri::State<LspState>,
) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|e| format!("lsp_stop: lock failed: {}", e))?;

    if let Some(mut session) = guard.remove(&server_id) {
        let _ = session.child.kill();
        let _ = session.child.wait();
        log::info!("lsp_stop: killed session '{}'", server_id);
    }
    Ok(())
}

/// Returns true if a language server binary is available for `language`.
///
/// Used by the frontend to decide whether to show LSP-dependent UI.
#[tauri::command]
pub fn lsp_available(language: String) -> bool {
    resolve_server_command(&language).is_some()
}

// ── Unit tests ────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::{encode_message, read_message, stop_all_lsp_for_exit, stop_lsp_session, LspSession, LspState};
    use std::collections::HashMap;
    use std::io::Cursor;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    /// Spawn a trivial, near-instantly-exiting child process — a stand-in
    /// for a real language server binary so session-lifecycle logic
    /// (stop/replace/exit guards) can be tested without depending on
    /// typescript-language-server (or npx) being installed. Mirrors the
    /// identical pattern in commands/brain/sidecar.rs's
    /// start_or_restart_brain_sidecar tests.
    fn spawn_trivial_child() -> std::process::Child {
        let mut cmd = if cfg!(windows) {
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", "exit", "0"]);
            c
        } else {
            let mut c = std::process::Command::new("sh");
            c.args(["-c", "exit 0"]);
            c
        };
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn trivial child for test")
    }

    /// Build an `LspSession` around a trivial child — `stdin`/`stdout` are
    /// only ever read/written by lsp_request/lsp_notify/spawn_reader_thread,
    /// none of which these tests exercise, so a real (if content-free) pipe
    /// pair is enough to satisfy the field types.
    fn trivial_session() -> LspSession {
        let mut child = spawn_trivial_child();
        let stdin = child.stdin.take().expect("trivial child must have stdin");
        LspSession { child, stdin, next_id: 1, pending: HashMap::new(), dead: false }
    }

    /// Helper: encode then decode a round-trip.
    fn roundtrip(body: &str) -> String {
        let encoded = encode_message(body);
        let mut cursor = Cursor::new(encoded);
        read_message(&mut cursor).expect("roundtrip decode failed")
    }

    #[test]
    fn framing_encode_has_content_length_header() {
        let body = r#"{"jsonrpc":"2.0","method":"test"}"#;
        let encoded = encode_message(body);
        let text = std::str::from_utf8(&encoded).unwrap();
        assert!(
            text.starts_with("Content-Length: 33\r\n\r\n"),
            "encoded must start with Content-Length header, got: {:?}",
            &text[..text.len().min(60)]
        );
    }

    #[test]
    fn framing_roundtrip_simple() {
        let body = r#"{"jsonrpc":"2.0","method":"initialize","id":1}"#;
        assert_eq!(roundtrip(body), body);
    }

    #[test]
    fn framing_roundtrip_empty_params() {
        let body = r#"{"jsonrpc":"2.0","method":"shutdown","id":2,"params":null}"#;
        assert_eq!(roundtrip(body), body);
    }

    #[test]
    fn framing_roundtrip_unicode() {
        let body = r#"{"text":"héllo wörld — ✓"}"#;
        assert_eq!(roundtrip(body), body);
    }

    #[test]
    fn framing_decode_multiple_messages() {
        let body1 = r#"{"id":1,"result":{}}"#;
        let body2 = r#"{"method":"textDocument/publishDiagnostics","params":{"uri":"file:///a.ts"}}"#;
        let mut encoded = encode_message(body1);
        encoded.extend_from_slice(&encode_message(body2));
        let mut cursor = Cursor::new(encoded);
        let got1 = read_message(&mut cursor).expect("decode 1");
        let got2 = read_message(&mut cursor).expect("decode 2");
        assert_eq!(got1, body1);
        assert_eq!(got2, body2);
    }

    #[test]
    fn framing_decode_missing_header_returns_error() {
        // Provide a raw body without Content-Length header.
        let raw = b"just a body without headers\r\n\r\n";
        let mut cursor = Cursor::new(raw.to_vec());
        // First read_line returns the body line, second an empty line (end of headers),
        // but Content-Length was never set — expect an error.
        let result = read_message(&mut cursor);
        assert!(
            result.is_err(),
            "missing Content-Length must return an error"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("Content-Length") || err.contains("content-length") || err.contains("missing"),
            "error must mention Content-Length, got: {}",
            err
        );
    }

    #[test]
    fn framing_decode_eof_returns_error() {
        let mut cursor = Cursor::new(Vec::<u8>::new());
        let result = read_message(&mut cursor);
        assert!(result.is_err(), "EOF must return an error");
        assert!(
            result.unwrap_err().contains("closed"),
            "EOF error must mention 'closed'"
        );
    }

    #[test]
    fn framing_content_length_is_byte_count_not_char_count() {
        // Unicode body: byte length > char count.
        let body = "✓✓✓"; // 3 chars, 9 bytes (3 bytes each in UTF-8)
        let encoded = encode_message(body);
        let text = std::str::from_utf8(&encoded).unwrap();
        // Header must declare byte length (9), not char length (3).
        assert!(
            text.contains("Content-Length: 9\r\n"),
            "Content-Length must be byte count (9 for '✓✓✓'), got header: {:?}",
            &text[..text.len().min(40)]
        );
    }

    // ── Multi-root allowlist (lsp_start's project-root gate) ────────────
    //
    // lsp_start delegates to util::ensure_repo_in_any_open_project, which in
    // turn delegates to ensure_repo_in_project_roots (thoroughly unit-tested
    // in util.rs itself). This test proves the specific scenario the
    // multi-root registry exists for: an LSP server started against a repo
    // that is registered but NOT the active project (a "background" mission)
    // must still be accepted, while a repo that was never registered at all
    // must still be denied.

    #[test]
    fn lsp_start_guard_accepts_background_registered_repo_and_rejects_foreign_one() {
        let active_dir = TempDir::new().expect("TempDir (active)");
        let background_dir = TempDir::new().expect("TempDir (background)");
        let foreign_dir = TempDir::new().expect("TempDir (foreign, never registered)");

        let active_root = active_dir.path().canonicalize().unwrap().to_string_lossy().to_string();
        let background_root = background_dir.path().canonicalize().unwrap().to_string_lossy().to_string();
        let foreign_root = foreign_dir.path().canonicalize().unwrap().to_string_lossy().to_string();

        let mut registry = crate::state::RegistryInner::default();
        registry.register(crate::state::ProjectEntry {
            id: "active".to_string(),
            root: active_root,
            brain_id: None,
        });
        registry.register(crate::state::ProjectEntry {
            id: "background".to_string(),
            root: background_root.clone(),
            brain_id: None,
        });
        registry.set_active("active").expect("set_active");

        let roots = registry.all_roots();

        assert!(
            crate::commands::util::ensure_repo_in_project_roots(&background_root, &roots).is_ok(),
            "a repo registered but not active (background project) must be accepted"
        );
        assert!(
            crate::commands::util::ensure_repo_in_project_roots(&foreign_root, &roots).is_err(),
            "a repo that was never registered must still be rejected"
        );
        eprintln!("lsp_start_guard_accepts_background_registered_repo_and_rejects_foreign_one PASSED");
    }

    // ── Stop-then-start / exit-guard session lifecycle ──────────────────

    /// `stop_lsp_session` on an id with no existing session must be a safe
    /// no-op — this is the common case (a language's very first lsp_start
    /// call for a repo) and must never error or panic.
    #[test]
    fn stop_lsp_session_is_a_noop_when_no_session_exists() {
        let sessions: Arc<Mutex<HashMap<String, LspSession>>> = Arc::new(Mutex::new(HashMap::new()));
        stop_lsp_session(&sessions, "typescript-doesnotexist");
        assert!(sessions.lock().unwrap().is_empty());
        eprintln!("stop_lsp_session_is_a_noop_when_no_session_exists PASSED");
    }

    /// The core replace-guard behavior lsp_start relies on: when a session
    /// already exists for `server_id`, `stop_lsp_session` must remove it
    /// from the map (so the caller's subsequent HashMap::insert can never
    /// silently overwrite a live, un-killed session again).
    #[test]
    fn stop_lsp_session_removes_an_existing_session() {
        let sessions: Arc<Mutex<HashMap<String, LspSession>>> = Arc::new(Mutex::new(HashMap::new()));
        sessions.lock().unwrap().insert("typescript-abc123".to_string(), trivial_session());
        assert!(sessions.lock().unwrap().contains_key("typescript-abc123"));

        stop_lsp_session(&sessions, "typescript-abc123");

        assert!(
            !sessions.lock().unwrap().contains_key("typescript-abc123"),
            "the previous session must be removed from the map"
        );
        eprintln!("stop_lsp_session_removes_an_existing_session PASSED");
    }

    /// `stop_lsp_session` must only touch the session matching the given
    /// id — an unrelated server_id's session (e.g. a different language for
    /// the same repo) must survive untouched.
    #[test]
    fn stop_lsp_session_leaves_other_sessions_untouched() {
        let sessions: Arc<Mutex<HashMap<String, LspSession>>> = Arc::new(Mutex::new(HashMap::new()));
        sessions.lock().unwrap().insert("typescript-abc123".to_string(), trivial_session());
        sessions.lock().unwrap().insert("javascript-abc123".to_string(), trivial_session());

        stop_lsp_session(&sessions, "typescript-abc123");

        let guard = sessions.lock().unwrap();
        assert!(!guard.contains_key("typescript-abc123"), "the targeted session must be gone");
        assert!(guard.contains_key("javascript-abc123"), "the unrelated session must be untouched");
        eprintln!("stop_lsp_session_leaves_other_sessions_untouched PASSED");
    }

    /// `LspSession`'s `Drop` impl must not panic even when the wrapped
    /// child has already exited (kill() on a dead process is expected to
    /// return an Err, which Drop must swallow, not propagate/panic on) —
    /// the exact "no panic in drop" contract this impl exists to satisfy.
    #[test]
    fn lsp_session_drop_does_not_panic_when_child_already_exited() {
        let mut child = spawn_trivial_child();
        let stdin = child.stdin.take().expect("trivial child must have stdin");
        // Give the trivial `exit 0` child a moment to actually finish, so
        // Drop's kill() below is genuinely racing/targeting an already-dead
        // process rather than a still-running one (either way it must not
        // panic — this just makes the intended scenario likely, not load-
        // bearing for correctness).
        std::thread::sleep(std::time::Duration::from_millis(200));
        let session = LspSession { child, stdin, next_id: 1, pending: HashMap::new(), dead: false };

        let dropped_without_panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            drop(session);
        }));
        assert!(dropped_without_panic.is_ok(), "LspSession Drop must never panic");
        eprintln!("lsp_session_drop_does_not_panic_when_child_already_exited PASSED");
    }

    /// `stop_all_lsp_for_exit` must kill every tracked session and clear
    /// the map — the app-exit sweep this function exists for.
    #[test]
    fn stop_all_lsp_for_exit_kills_and_clears_all_sessions() {
        let state = LspState::new();
        state.0.lock().unwrap().insert("typescript-a".to_string(), trivial_session());
        state.0.lock().unwrap().insert("javascript-b".to_string(), trivial_session());
        assert_eq!(state.0.lock().unwrap().len(), 2);

        stop_all_lsp_for_exit(&state);

        assert!(
            state.0.lock().unwrap().is_empty(),
            "every session must be removed after stop_all_lsp_for_exit"
        );
        eprintln!("stop_all_lsp_for_exit_kills_and_clears_all_sessions PASSED");
    }

    /// Poison-safety: a poisoned lock must degrade to a no-op (logged) and
    /// must never panic — same contract as kill_tracked_agent_pids's own
    /// dedicated poison-safety test (commands/agent.rs).
    #[test]
    fn stop_all_lsp_for_exit_handles_poisoned_lock_without_panicking() {
        let state = LspState::new();
        state.0.lock().unwrap().insert("typescript-a".to_string(), trivial_session());

        let state_ref = &state;
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = state_ref.0.lock().unwrap();
            panic!("simulated panic while holding LspState's internal lock");
        }));
        assert!(panicked.is_err(), "test precondition: the panic must have happened");
        assert!(state.0.is_poisoned(), "test precondition: the mutex must now be poisoned");

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            stop_all_lsp_for_exit(&state);
        }));
        assert!(result.is_ok(), "stop_all_lsp_for_exit must not panic on a poisoned lock");
        eprintln!("stop_all_lsp_for_exit_handles_poisoned_lock_without_panicking PASSED");
    }
}
