//! MCP (Model Context Protocol) Tauri commands — manages stdio MCP server
//! processes and SSE-based MCP server communication.
//!
//! `mcp_spawn_server` — spawns a stdio MCP server as a child process,
//!   keeping it in a global state map for subsequent calls.
//! `mcp_call_server` — sends a JSON-RPC message to the server's stdin,
//!   reads the response from stdout (synchronous round-trip with timeout).
//! `mcp_send_server_stdin` — sends a message without waiting for response
//!   (for notifications like "notifications/initialized").
//! `mcp_stop_server` — kills the server process and removes it from state.
//! `mcp_sse_call` — makes an HTTP POST to an SSE-based MCP server and
//!   returns the response.
//!
//! The MCP protocol is JSON-RPC 2.0 over stdio (one message per line) or
//! HTTP+SSE. This module handles the transport; the TypeScript mcpClient.ts
//! handles the protocol-level handshake and tool discovery.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::commands::web::{guard_url, shared_http_client};

/// State for a running stdio MCP server.
struct McpServerState {
    child: Child,
}

/// Tree-kills the child on drop — a safety net for every removal path (not
/// just `mcp_stop_server`'s own explicit kill), and the actual mechanism
/// `kill_all_mcp_servers` relies on (see that function's doc comment).
/// Tree-kill (`taskkill /T /F`, not a plain `Child::kill()`), because an MCP
/// server frequently spawns its OWN child processes (e.g. an `npx`-launched
/// server spawning the real interpreter) that a single-process kill would
/// leak — mirrors `commands::util::tree_kill_args`'s own rationale, the
/// same helper `kill_tracked_agent_pids` / `TeamsSidecar::stop` use.
impl Drop for McpServerState {
    fn drop(&mut self) {
        let pid = self.child.id();
        #[cfg(target_os = "windows")]
        {
            let _ = crate::commands::util::quiet_command("taskkill")
                .args(crate::commands::util::tree_kill_args(pid))
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

type ServerMap = HashMap<String, McpServerState>;

/// Global state holding all running MCP server processes.
static MCP_SERVERS: std::sync::OnceLock<Arc<Mutex<ServerMap>>> = std::sync::OnceLock::new();

fn servers() -> &'static Arc<Mutex<ServerMap>> {
    MCP_SERVERS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// Best-effort tree-kill of every currently-running stdio MCP server child
/// process — called from the app-exit hook (`run_exit_cleanup`, lib.rs) so a
/// mission's MCP tool servers don't survive the IDE closing. Draining the
/// map is enough: `McpServerState`'s own `Drop` impl (above) does the
/// actual tree-kill for every entry removed this way. Poison-safe like
/// `commands::agent::kill_tracked_agent_pids`: a poisoned lock is logged and
/// skipped, never propagated or panicked, since this runs during app
/// teardown where a panic would be especially unwelcome.
///
/// Entries are drained into a local `Vec` under a brief lock, then the
/// guard is dropped BEFORE that `Vec` (and therefore every `McpServerState`
/// it holds) is dropped. Each `Drop` runs `taskkill /T /F` via a blocking
/// `.output()` call plus `kill()`/`wait()` — holding the lock across that
/// (as a plain `map.clear()` under the lock previously did) would block any
/// concurrent command that also needs `servers()`'s lock for as long as the
/// slowest server takes to tree-kill.
pub(crate) fn kill_all_mcp_servers() {
    let drained: Vec<(String, McpServerState)> = match servers().lock() {
        Ok(mut map) => map.drain().collect(),
        Err(e) => {
            log::warn!("kill_all_mcp_servers: lock poisoned: {}", e);
            return;
        }
    };
    let count = drained.len();
    // Dropping `drained` here (outside the lock) is what actually runs each
    // McpServerState's tree-kill — see this function's own doc comment.
    drop(drained);
    if count > 0 {
        log::info!("app exit: stopped {} MCP server(s)", count);
    }
}

/// Spawns a stdio MCP server process.
///
/// The `command`/`args`/`env` triple comes from the user's own MCP server
/// configuration (mcpRegistry.ts — Settings > MCP); executing it is the
/// feature, not a bug — same trust model as every other MCP host
/// (Cursor, Claude Desktop). The guards below therefore only strip what a
/// config CANNOT legitimately need: env vars that inject code INTO the
/// spawned process (NODE_OPTIONS, LD_PRELOAD & friends), empty ids, and
/// pathological sizes — defense in depth against a corrupted config or a
/// stray webview caller, never a capability boundary.
#[tauri::command]
pub fn mcp_spawn_server(
    id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("mcp_spawn_server: empty server id".to_string());
    }
    if command.trim().is_empty() {
        return Err("mcp_spawn_server: empty command".to_string());
    }
    // Hard caps — a server needs dozens of args at most, never thousands;
    // anything past this is malformed input, not a real config.
    const MAX_ARGS: usize = 64;
    const MAX_ENV: usize = 64;
    const MAX_FIELD_LEN: usize = 4096;
    if args.len() > MAX_ARGS || env.len() > MAX_ENV {
        return Err("mcp_spawn_server: too many args/env entries".to_string());
    }
    if args.iter().any(|a| a.len() > MAX_FIELD_LEN)
        || env.iter().any(|(k, v)| k.len() > 256 || v.len() > MAX_FIELD_LEN)
    {
        return Err("mcp_spawn_server: arg/env value too long".to_string());
    }
    // Interpreter-level env injection — each of these executes attacker-
    // controlled code inside the spawned process (or its dynamic loader)
    // regardless of what `command` is. No MCP server config ever needs them.
    const BLOCKED_ENV: &[&str] = &[
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "LD_AUDIT",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
        "DYLD_PRINT_LIBRARIES",
        "NODE_OPTIONS",
        "PYTHONSTARTUP",
        "PYTHONINSPECT",
        "PERL5OPT",
        "PERL5LIB",
        "RUBYOPT",
        "RUBYLIB",
        "BASH_ENV",
        "ENV",
        "SHELLOPTS",
        "PS4",
        "PROMPT_COMMAND",
        "JAVA_TOOL_OPTIONS",
        "_JAVA_OPTIONS",
        "JDK_JAVA_OPTIONS",
        "DOTNET_STARTUP_HOOKS",
        "RUSTC_WRAPPER",
    ];
    let mut cmd = Command::new(&command);
    cmd.args(&args);
    for (k, v) in &env {
        if BLOCKED_ENV.iter().any(|b| b.eq_ignore_ascii_case(k)) {
            return Err(format!(
                "mcp_spawn_server: env var '{}' is not allowed (interpreter/loader injection vector)",
                k
            ));
        }
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = cmd.spawn().map_err(|e| {
        format!("Failed to spawn MCP server '{}': {}", command, e)
    })?;

    let mut map = servers().lock().map_err(|e| format!("Lock error: {}", e))?;
    map.insert(id, McpServerState { child });
    Ok(())
}

/// Sends a JSON-RPC message to a stdio MCP server's stdin and reads the
/// response from stdout. This is a synchronous round-trip: writes the
/// message, then reads one line from stdout (the JSON-RPC response).
#[tauri::command]
pub fn mcp_call_server(
    id: String,
    message: String,
    timeout_ms: u64,
) -> Result<String, String> {
    let mut map = servers().lock().map_err(|e| format!("Lock error: {}", e))?;

    let state = map
        .get_mut(&id)
        .ok_or_else(|| format!("MCP server '{}' not found", id))?;

    let stdin = state
        .child
        .stdin
        .as_mut()
        .ok_or_else(|| "MCP server stdin not available".to_string())?;

    // Write the message followed by a newline (JSON-RPC over stdio is line-delimited)
    stdin
        .write_all(message.as_bytes())
        .map_err(|e| format!("Failed to write to MCP server stdin: {}", e))?;
    stdin
        .write_all(b"\n")
        .map_err(|e| format!("Failed to write newline: {}", e))?;
    stdin
        .flush()
        .map_err(|e| format!("Failed to flush stdin: {}", e))?;

    // Read the response from stdout (line-delimited JSON-RPC)
    let stdout = state
        .child
        .stdout
        .as_mut()
        .ok_or_else(|| "MCP server stdout not available".to_string())?;

    let mut reader = BufReader::new(stdout);

    // Read lines until we get a response (skip notifications/comments)
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if std::time::Instant::now() > deadline {
            return Err(format!(
                "MCP server '{}' timed out after {}ms waiting for response",
                id, timeout_ms
            ));
        }

        let mut line = String::new();
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read from MCP server stdout: {}", e))?;

        if bytes_read == 0 {
            return Err(format!("MCP server '{}' closed stdout", id));
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Skip JSON-RPC notifications (no "id" field) — we want a response
        // with an "id" matching our request
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if parsed.get("id").is_some() {
                return Ok(trimmed.to_string());
            }
            // It's a notification or server-initiated message — skip it
            continue;
        }
        // Not valid JSON — skip
    }
}

/// Sends a message to a stdio MCP server's stdin without waiting for a
/// response (for notifications like "notifications/initialized").
#[tauri::command]
pub fn mcp_send_server_stdin(id: String, message: String) -> Result<(), String> {
    let mut map = servers().lock().map_err(|e| format!("Lock error: {}", e))?;

    let state = map
        .get_mut(&id)
        .ok_or_else(|| format!("MCP server '{}' not found", id))?;

    let stdin = state
        .child
        .stdin
        .as_mut()
        .ok_or_else(|| "MCP server stdin not available".to_string())?;

    stdin
        .write_all(message.as_bytes())
        .map_err(|e| format!("Failed to write: {}", e))?;
    stdin
        .write_all(b"\n")
        .map_err(|e| format!("Failed to write newline: {}", e))?;
    stdin
        .flush()
        .map_err(|e| format!("Failed to flush: {}", e))?;

    Ok(())
}

/// Stops a running stdio MCP server process.
#[tauri::command]
pub fn mcp_stop_server(id: String) -> Result<(), String> {
    let mut map = servers().lock().map_err(|e| format!("Lock error: {}", e))?;
    // `McpServerState::drop` (tree-kill) runs the instant the removed value
    // is dropped at the end of this statement — see that impl's own doc
    // comment for why a tree-kill, not a plain Child::kill(), is needed.
    map.remove(&id);
    Ok(())
}

// ── SSE transport ──────────────────────────────────────────────────

/// Makes an HTTP POST to an SSE-based MCP server endpoint.
/// Sends a JSON-RPC request and returns the response.
#[tauri::command]
pub fn mcp_sse_call(
    url: String,
    method: String,
    params: serde_json::Value,
    headers: HashMap<String, String>,
    timeout_ms: u64,
) -> Result<String, String> {
    // SSRF guard: block requests to loopback/private/link-local/metadata
    // addresses before ever opening a connection — same guard web_fetch/
    // web_search apply, previously missing here even though this endpoint
    // is configured by the user (an MCP server URL) and reachable by the
    // agentic model. Redirect hops are re-checked by the shared client's
    // own custom redirect policy (see shared_http_client).
    guard_url(&url)?;

    // Build the JSON-RPC request
    let rpc_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(1),
        "method": method,
        "params": params,
    });

    // Reuse the shared client (web.rs) instead of building a fresh one per
    // call — same SSRF-guarded redirect policy and connection pool as
    // web_fetch/web_search. The per-request timeout below overrides the
    // client's own default.
    let client = shared_http_client();

    let mut req = client.post(&url).timeout(Duration::from_millis(timeout_ms));
    // Header allowlist-by-exclusion: the MCP server's configured headers
    // (Authorization, api keys, Accept...) pass through, but transport-
    // framing and hop-by-hop headers are refused — a config-controlled
    // `Host`/`Content-Length`/`Transfer-Encoding`/`Connection` override
    // would enable request smuggling against whatever server the URL
    // points at, and `Proxy-*`/`Sec-*`/`Forwarded` variants are spoofing
    // vectors no MCP server needs from its client.
    const BLOCKED_HEADERS: &[&str] = &[
        "host",
        "content-length",
        "transfer-encoding",
        "connection",
        "keep-alive",
        "upgrade",
        "te",
        "trailer",
        "proxy-authorization",
        "proxy-authenticate",
        "forwarded",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-real-ip",
        "expect",
        "content-encoding",
        "content-type", // set explicitly below — never overridden
    ];
    for (k, v) in &headers {
        if BLOCKED_HEADERS.iter().any(|b| b.eq_ignore_ascii_case(k)) {
            return Err(format!(
                "mcp_sse_call: header '{}' is not allowed (transport/framing control is the client's job)",
                k
            ));
        }
        // Reject values with CR/LF — header injection into the raw request.
        if v.contains('\r') || v.contains('\n') {
            return Err(format!(
                "mcp_sse_call: header '{}' contains a newline (header injection)",
                k
            ));
        }
        req = req.header(k, v);
    }
    req = req.header("Content-Type", "application/json");

    let response = req
        .body(rpc_body.to_string())
        .send()
        .map_err(|e| format!("SSE MCP call failed: {}", e))?;

    let body = response
        .text()
        .map_err(|e| format!("Failed to read SSE response: {}", e))?;

    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A poisoned-lock `MCP_SERVERS` map must degrade gracefully (log +
    /// return) rather than panic — this runs from the app-exit hook, where a
    /// panic would be especially unwelcome. Mirrors
    /// `teams_sidecar::stop_teams_sidecar_for_exit_handles_poisoned_lock_without_panicking`'s
    /// own recipe: panic while holding the lock to poison it, then confirm
    /// the function under test still returns cleanly.
    ///
    /// `servers()` is a process-wide `OnceLock` singleton (unlike
    /// `AgentPidState::new()`, which every other poison test in this crate
    /// constructs fresh per test) — `clear_poison()` (stable since Rust
    /// 1.77, this crate's own MSRV) restores it afterward so a poison
    /// introduced here can never leak into any other test sharing this same
    /// static within the same test binary run.
    #[test]
    fn kill_all_mcp_servers_handles_poisoned_lock_without_panicking() {
        use std::panic;

        let inner = Arc::clone(servers());
        let _ = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let _guard = inner.lock().expect("lock");
            panic!("intentional poison for test");
        }));

        // Must not panic — kill_all_mcp_servers logs a warning and returns.
        kill_all_mcp_servers();
        inner.clear_poison();
        eprintln!("kill_all_mcp_servers_handles_poisoned_lock_without_panicking PASSED");
    }
}
