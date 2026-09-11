//! Lightweight AI chat streaming: direct claude/codex CLI passthrough chat
//! and the direct Anthropic HTTP API streaming path used by inline AI edits.
//! Distinct from commands::agent, which runs full autonomous coding missions.

use std::process::Stdio;

use futures_util::StreamExt;
use serde::Deserialize;
use tauri::{Emitter, Manager};

use crate::state::ProjectState;
use crate::commands::agent::{track_agent_pid, untrack_agent_pid, AgentPidState};
use crate::commands::util::{quiet_command, resolve_cli_program, spawn_stderr_tail, tree_kill_args, STDERR_TAIL_CAP_BYTES};

/// Request payload for agent_cli_chat_stream (dispatches by tool name).
#[derive(Deserialize, Debug)]
pub struct AgentCliChatRequest {
    /// Which CLI tool to use: "claude" | "codex" | "devin" (ACP — see the
    /// Devin section at the bottom of this file)
    pub tool: String,
    /// Caller-assigned correlation id (used in event names: model://chunk/{id}, etc.)
    pub id: String,
    /// Model alias or id (tool-specific default if None/empty).
    pub model: Option<String>,
    /// Optional system prompt injected before the conversation.
    pub system: Option<String>,
    /// Conversation messages (role + content).
    pub messages: Vec<ChatMessageReq>,
    /// Chat mode: "ask" | "edit" | "plan" — controls --permission-mode on claude invocations.
    pub mode: Option<String>,
}

/// Check whether an agent CLI tool is available on PATH.
///
/// Supported tools: "claude", "codex". Any unknown tool returns false.
/// Runs `<tool> --version` (best-effort).
#[tauri::command]
pub(crate) fn agent_cli_available(tool: String) -> bool {
    // Devin ships as devin.exe under a per-user install dir that is not
    // always on the PATH a Tauri app inherits — resolve_devin_program()
    // covers those well-known locations (see its own doc comment).
    let program = match tool.as_str() {
        "claude" => resolve_cli_program("claude"),
        "codex"  => resolve_cli_program("codex"),
        "devin"  => resolve_devin_program(),
        _        => return false,
    };
    match quiet_command(program)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(s) => s.success(),
        Err(_) => false,
    }
}

/// Generic streaming chat command that dispatches to the correct CLI backend.
///
/// Emits Tauri events (same protocol as claude_chat_stream):
///   model://chunk/{id}  — payload: String (text delta)
///   model://done/{id}   — payload: {inputTokens: 0, outputTokens: 0}
///   model://error/{id}  — payload: String (error message)
#[tauri::command]
pub(crate) async fn agent_cli_chat_stream(
    app: tauri::AppHandle,
    req: AgentCliChatRequest,
    agent_pids: tauri::State<'_, AgentPidState>,
) -> Result<(), String> {
    match req.tool.as_str() {
        "claude" => {
            // Delegate to the existing Claude Code implementation.
            let claude_req = ClaudeCodeChatRequest {
                id:       req.id,
                model:    req.model,
                system:   req.system,
                messages: req.messages,
                mode:     req.mode,
            };
            claude_chat_stream_inner(app, claude_req, agent_pids).await
        }
        "codex" => {
            codex_chat_stream_inner(app, req, agent_pids).await
        }
        "devin" => {
            devin_chat_stream_inner(app, req, agent_pids).await
        }
        other => {
            let msg = format!("agent_cli_chat_stream: unknown tool '{}'", other);
            let _ = app.emit(&format!("model://error/{}", req.id), &msg);
            Err(msg)
        }
    }
}

// ── Cancellation ──────────────────────────────────────────────────────
//
// P0-2 fix: previously nothing ever tree-killed the `claude`/`codex` CLI
// child spawned by claude_chat_stream_inner/codex_chat_stream_inner when a
// caller gave up on the stream (LazyManager turn timeout, user clicking
// "Reessayer", etc). The front-end AbortController only rejected the LOCAL
// queue (see claudeCodeProvider.ts's streamClaudeCodeTurn) — the Rust child
// (cmd.exe wrapper + claude.exe + its own subprocess tree) kept running to
// completion, burning the user's Claude subscription quota as an invisible
// orphan. Proven in a real test: 4 timed-out turns left 12 live processes,
// ~440MB each, still running 12 minutes later.
//
// Fix: tree-kill the pid tracked under the same "chat-claude-{id}"/
// "chat-codex-{id}" key claude_chat_stream_inner/codex_chat_stream_inner
// already register with track_agent_pid — same AgentPidState map and same
// tree_kill_args mechanism agent_run_kill uses for missions, just keyed by
// chat stream id instead of mission id.

/// Idempotent, best-effort cancellation of a chat CLI child tracked under
/// `pid_key` in `AgentPidState`. Tree-kills the pid (parent cmd.exe/shell
/// wrapper + the claude/codex process + any of its own children) so nothing
/// survives past the abort. A missing `pid_key` — id never started, already
/// exited naturally, or a repeated cancel call on the same id — is a silent
/// no-op: this runs from an abort path with no user-facing recovery, so it
/// must never panic or surface a blocking error.
fn cancel_tracked_chat_pid(pid_key: &str, agent_pids: &AgentPidState) {
    let pid = match agent_pids.0.lock() {
        Ok(map) => map.get(pid_key).copied(),
        Err(e) => {
            log::warn!("cancel_tracked_chat_pid: lock failed for '{}': {}", pid_key, e);
            None
        }
    };
    let Some(pid) = pid else {
        return;
    };
    log::info!("cancel_tracked_chat_pid: tree-killing pid {} for '{}'", pid, pid_key);
    #[cfg(target_os = "windows")]
    {
        let _ = quiet_command("taskkill").args(tree_kill_args(pid)).output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsafe { libc::kill(pid as i32, libc::SIGKILL); }
    }
}

/// Cancel an in-flight `claude_chat_stream` call by its stream id. Call this
/// from the front-end's abort/timeout handler — see claudeCodeProvider.ts's
/// streamClaudeCodeTurn onAbort — right after the local queue is rejected,
/// as a best-effort side effect (never awaited for correctness, never
/// allowed to throw from an abort path).
#[tauri::command]
pub(crate) fn claude_chat_stream_cancel(id: String, agent_pids: tauri::State<'_, AgentPidState>) -> Result<(), String> {
    cancel_tracked_chat_pid(&format!("chat-claude-{}", id), &agent_pids);
    Ok(())
}

/// Codex equivalent of `claude_chat_stream_cancel` — same contract, targets
/// the "chat-codex-{id}" tracking key codex_chat_stream_inner registers.
#[tauri::command]
pub(crate) fn codex_chat_stream_cancel(id: String, agent_pids: tauri::State<'_, AgentPidState>) -> Result<(), String> {
    cancel_tracked_chat_pid(&format!("chat-codex-{}", id), &agent_pids);
    Ok(())
}

/// Spawn `codex exec --json --skip-git-repo-check "<prompt>"` and stream output.
///
/// Codex `--json` emits JSONL lines. We extract text from assistant messages:
///   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}],...}}
/// which mirrors the claude stream-json format.
async fn codex_chat_stream_inner(
    app: tauri::AppHandle,
    req: AgentCliChatRequest,
    agent_pids: tauri::State<'_, AgentPidState>,
) -> Result<(), String> {
    let chunk_event = format!("model://chunk/{}", req.id);
    let done_event  = format!("model://done/{}", req.id);
    let error_event = format!("model://error/{}", req.id);

    // Build a single prompt from system + messages (same approach as claude)
    let prompt = build_claude_prompt(req.system.as_deref(), &req.messages);

    let model_args: Vec<String> = if let Some(ref m) = req.model {
        if !m.is_empty() {
            vec!["--model".to_string(), m.clone()]
        } else {
            vec![]
        }
    } else {
        vec![]
    };
    let model_label = req.model.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| "default".to_string());

    // Read the current project root so codex runs in the right directory.
    let project_root: String = app.state::<ProjectState>()
        .0.lock()
        .map(|g| g.clone())
        .unwrap_or_default();

    let app_clone = app.clone();
    // Orphan-cleanup tracking key: shares AgentPidState (and therefore its
    // app-exit tree-kill sweep, see kill_tracked_agent_pids in agent.rs) with
    // agent_run/spawn_scheduler missions. Namespaced with a "chat-codex-"
    // prefix (distinct from agent_run's caller-assigned mission id and
    // spawn_scheduler's "sched-*" ids) purely so a chat correlation id can
    // never collide with a mission id in the same map.
    let pid_key = format!("chat-codex-{}", req.id);
    let pids_clone = agent_pids.0.clone();

    let prompt_byte_len = prompt.len();

    tokio::task::spawn_blocking(move || {
        let codex_program = resolve_cli_program("codex");
        let mut cmd = quiet_command(&codex_program);
        cmd.args(["exec", "--json", "--skip-git-repo-check"]);
        for arg in &model_args {
            cmd.arg(arg);
        }
        if !project_root.is_empty() {
            cmd.current_dir(&project_root);
        }
        let spawned_at = std::time::Instant::now();
        let mut child = match cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("codex spawn failed: {}", e);
                let _ = app_clone.emit(&error_event, &msg);
                return;
            }
        };
        log::info!(
            "codex_chat_stream_inner: spawned pid_key={} program={:?} model={} prompt_bytes={}",
            pid_key, codex_program, model_label, prompt_byte_len
        );

        // Register so this child is tree-killed on app exit if still running
        // (see kill_tracked_agent_pids) — previously ask/edit/plan chat
        // children were never tracked at all and could survive the app
        // closing as orphans.
        track_agent_pid(&pids_clone, &pid_key, child.id());

        // Feed the prompt via stdin (avoids CVE-2024-24576 on Windows — same fix as claude path).
        if let Some(mut stdin) = child.stdin.take() {
            let prompt_bytes = prompt.clone();
            std::thread::spawn(move || {
                use std::io::Write;
                let _ = stdin.write_all(prompt_bytes.as_bytes());
                let _ = stdin.flush();
            });
        }

        // Drain stderr concurrently to prevent pipe buffer deadlock.
        // Tail-capped — see spawn_stderr_tail's doc comment (util.rs).
        let stderr_handle = child.stderr.take().map(|se| spawn_stderr_tail(se, STDERR_TAIL_CAP_BYTES));

        use std::io::BufReader;
        use std::io::BufRead;

        // Same run-on-splice risk as claude_chat_stream_inner's stdout loop
        // (codex --json is also a multi-step agent loop that can emit
        // several assistant lines per turn) — see AssistantTextRelay's doc
        // comment.
        let mut text_relay = AssistantTextRelay::default();

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line_result in reader.lines() {
                match line_result {
                    Ok(line) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() { continue; }

                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                            // Codex --json format (legacy):
                            // {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
                            // Also handles stream_error lines — ignore those.
                            let ev_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                            if ev_type == "stream_error" || ev_type == "error" {
                                // Log but don't abort — codex retries automatically
                                continue;
                            }
                            for chunk in text_relay.chunks_for_line(&v) {
                                if !chunk.is_empty() {
                                    let _ = app_clone.emit(&chunk_event, &chunk);
                                }
                            }
                            // result line signals end
                            if ev_type == "result" {
                                let is_error = v.get("is_error")
                                    .and_then(|e| e.as_bool())
                                    .unwrap_or(false);
                                if is_error {
                                    let msg = v.get("result")
                                        .and_then(|r| r.as_str())
                                        .unwrap_or("codex error")
                                        .to_string();
                                    let _ = app_clone.emit(&error_event, &msg);
                                    return;
                                }
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        }

        let exit_status = match child.wait() {
            Ok(s) => s,
            Err(e) => {
                log::error!("codex_chat_stream_inner: child.wait() failed for pid_key={}: {}", pid_key, e);
                let msg = format!("codex: failed to wait for process exit: {}", e);
                let _ = app_clone.emit(&error_event, &msg);
                untrack_agent_pid(&pids_clone, &pid_key);
                return;
            }
        };

        // Collect stderr output from the drain thread
        let stderr_text = stderr_handle.and_then(|h| h.join().ok()).unwrap_or_default();

        untrack_agent_pid(&pids_clone, &pid_key);

        let elapsed_ms = spawned_at.elapsed().as_millis();
        let exit_code = exit_status.code().unwrap_or(-1);

        if exit_status.success() {
            log::info!(
                "codex_chat_stream_inner: pid_key={} completed in {}ms exit_code={}",
                pid_key, elapsed_ms, exit_code
            );
            let usage = serde_json::json!({ "inputTokens": 0, "outputTokens": 0 });
            let _ = app_clone.emit(&done_event, usage);
        } else {
            log::warn!(
                "codex_chat_stream_inner: pid_key={} exited non-zero after {}ms exit_code={}",
                pid_key, elapsed_ms, exit_code
            );
            let msg = if !stderr_text.trim().is_empty() {
                format!("codex error: {}", stderr_text.trim())
            } else {
                format!("codex exited with status {}", exit_status)
            };
            let _ = app_clone.emit(&error_event, &msg);
        }
    });

    Ok(())
}

/// Request payload for claude_chat_stream (subscription auth — no API key).
#[derive(Deserialize, Debug)]
pub struct ClaudeCodeChatRequest {
    /// Caller-assigned correlation id (used in event names: model://chunk/{id}, etc.)
    pub id: String,
    /// Model alias or id passed to `claude --model`.
    /// Defaults to "haiku" if empty/absent (Claude Haiku = fast + cost-efficient).
    pub model: Option<String>,
    /// Optional system prompt injected before the conversation.
    pub system: Option<String>,
    /// Conversation messages (role + content).
    pub messages: Vec<ChatMessageReq>,
    /// Chat mode: "ask" | "edit" | "plan" — controls --permission-mode.
    pub mode: Option<String>,
}

/// Check whether the `claude` CLI is available on PATH.
///
/// Runs `claude --version` with a 5-second timeout (best-effort).
/// Returns true if the process exits 0, false otherwise.
#[tauri::command]
pub(crate) fn claude_available() -> bool {
    agent_cli_available("claude".to_string())
}

/// Build a single-string prompt from system + messages for the Claude CLI.
///
/// The CLI `-p` flag takes a single prompt argument; we fold the conversation
/// into it as a human-readable exchange so the model has history context.
fn build_claude_prompt(system: Option<&str>, messages: &[ChatMessageReq]) -> String {
    let mut parts: Vec<String> = Vec::new();

    if let Some(sys) = system {
        if !sys.is_empty() {
            parts.push(format!("[System]\n{}", sys));
        }
    }

    for msg in messages {
        let role_label = if msg.role == "assistant" { "Assistant" } else { "User" };
        parts.push(format!("[{}]\n{}", role_label, msg.content));
    }

    parts.join("\n\n")
}

/// Streaming chat command via the Claude Code CLI (subscription — no API key).
///
/// Spawns: `claude -p <prompt> --model <model> --output-format stream-json --verbose`
///
/// The `stream-json` format emits one JSON object per line. Each text delta
/// appears as `{"type":"assistant","message":{"content":[{"type":"text","text":"..."}],...}}`.
/// We parse these incrementally and emit:
///   model://chunk/{id}   — payload: String (text delta or tool annotation line)
///   model://done/{id}    — payload: {inputTokens: 0, outputTokens: 0}
///   model://error/{id}   — payload: String (error message)
///   model://action/{id}  — payload: { tool: string, file: string|null }
#[tauri::command]
pub(crate) async fn claude_chat_stream(
    app: tauri::AppHandle,
    req: ClaudeCodeChatRequest,
    agent_pids: tauri::State<'_, AgentPidState>,
) -> Result<(), String> {
    claude_chat_stream_inner(app, req, agent_pids).await
}

/// Inner implementation shared with agent_cli_chat_stream dispatcher.
async fn claude_chat_stream_inner(
    app: tauri::AppHandle,
    req: ClaudeCodeChatRequest,
    agent_pids: tauri::State<'_, AgentPidState>,
) -> Result<(), String> {
    let chunk_event  = format!("model://chunk/{}", req.id);
    let done_event   = format!("model://done/{}", req.id);
    let error_event  = format!("model://error/{}", req.id);
    let action_event = format!("model://action/{}", req.id);

    let model = req.model
        .as_deref()
        .filter(|m| !m.is_empty())
        .unwrap_or("claude-haiku-4-5");

    let prompt = build_claude_prompt(req.system.as_deref(), &req.messages);

    // Resolve permission mode from the chat mode field.
    let perm = match req.mode.as_deref() {
        Some("edit") => "acceptEdits",
        Some("plan") => "plan",
        _ => "default",
    }.to_string();

    // For edit/plan, also pass --add-dir so claude can access the project tree.
    let add_dir = matches!(req.mode.as_deref(), Some("edit") | Some("plan"));

    // In ask/default mode, block write tools so the model cannot write (or claim to write) files.
    // Read-only tools (Read, Grep, Glob) remain available.
    let disallow_write = !matches!(req.mode.as_deref(), Some("edit") | Some("plan"));

    // Read the current project root — set by the user opening a folder in the IDE.
    let project_root: String = app.state::<ProjectState>()
        .0.lock()
        .map(|g| g.clone())
        .unwrap_or_default();

    // Spawn claude in a blocking thread (process I/O)
    let model_owned = model.to_string();
    let app_clone = app.clone();
    // Orphan-cleanup tracking key — see codex_chat_stream_inner's identical
    // comment above for why this shares AgentPidState with agent_run/
    // spawn_scheduler and why it carries its own "chat-claude-" namespace.
    let pid_key = format!("chat-claude-{}", req.id);
    let pids_clone = agent_pids.0.clone();
    let prompt_byte_len = prompt.len();

    tokio::task::spawn_blocking(move || {
        // Build the command with flags; use chained .arg() so runtime strings
        // (perm, project_root) can be included without array-type conflicts.
        let claude_program = resolve_cli_program("claude");
        let mut cmd = quiet_command(&claude_program);
        cmd.arg("-p")
           .arg("--model").arg(&model_owned)
           .arg("--output-format").arg("stream-json")
           .arg("--verbose")
           // The IDE assistant is an ephemeral Q&A call. Loading the user's MCP
           // servers and SessionStart hooks on every message costs 30-75s on heavy
           // setups, which makes the assistant feel broken (empty bubble). Skip MCP
           // and heavy user/project hooks; OAuth auth (stored separately) is kept.
           // ~6-8s vs ~75s. For instant (~1-2s) responses, configure an Anthropic
           // API key (BYOK) which bypasses the CLI entirely.
           .arg("--strict-mcp-config")
           .arg("--setting-sources").arg("local")
           .arg("--permission-mode").arg(&perm);
        if disallow_write {
            for tool in &["Write", "Edit", "MultiEdit", "NotebookEdit"] {
                cmd.arg("--disallowedTools").arg(tool);
            }
        }
        if !project_root.is_empty() {
            cmd.current_dir(&project_root);
            if add_dir {
                cmd.arg("--add-dir").arg(&project_root);
            }
        }
        let spawned_at = std::time::Instant::now();
        let mut child = match cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("claude spawn failed: {}", e);
                let _ = app_clone.emit(&error_event, &msg);
                return;
            }
        };
        log::info!(
            "claude_chat_stream_inner: spawned pid_key={} program={:?} model={} prompt_bytes={}",
            pid_key, claude_program, model_owned, prompt_byte_len
        );

        // Register so this child is tree-killed on app exit if still running
        // (see kill_tracked_agent_pids) — previously ask/edit/plan chat
        // children were never tracked at all and could survive the app
        // closing as orphans.
        track_agent_pid(&pids_clone, &pid_key, child.id());

        // Feed the prompt via stdin (avoids CVE-2024-24576 on Windows where Rust 1.77+
        // refuses to spawn .cmd/.bat with newline-containing argv). Write in a dedicated
        // thread to prevent deadlock when stdout fills up before stdin is drained.
        if let Some(mut stdin) = child.stdin.take() {
            let prompt_bytes = prompt.clone();
            std::thread::spawn(move || {
                use std::io::Write;
                let _ = stdin.write_all(prompt_bytes.as_bytes());
                let _ = stdin.flush();
                // dropping stdin closes the pipe, signaling EOF to the CLI
            });
        }

        // Drain stderr in a background thread to prevent OS pipe buffer deadlock.
        // Claude writes verbose output to stderr; if we only read stdout the 64KB
        // buffer fills up and claude blocks mid-stream, hanging the UI forever.
        // Tail-capped — see spawn_stderr_tail's doc comment (util.rs).
        let stderr_handle = child.stderr.take().map(|se| spawn_stderr_tail(se, STDERR_TAIL_CAP_BYTES));

        // Read stdout line-by-line and parse stream-json events
        use std::io::BufReader;
        use std::io::BufRead;

        // Joins successive complete assistant text messages within this turn
        // with a blank-line boundary instead of gluing them together — see
        // AssistantTextRelay's doc comment for why this exists and why it
        // joins rather than drops. Lives for the whole child process's
        // stdout loop (one turn), not per-line.
        let mut text_relay = AssistantTextRelay::default();

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line_result in reader.lines() {
                match line_result {
                    Ok(line) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() { continue; }

                        // Parse JSON line — extract text deltas and tool_use blocks.
                        // A malformed/truncated line simply fails to parse here and
                        // is silently skipped (see the trailing comment on this
                        // loop) — it never touches text_relay's state, so it cannot
                        // corrupt a boundary decision for the surrounding lines.
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                            // stream-json format: {"type":"assistant","message":{...}}
                            // The message content array may contain text and tool_use blocks.
                            let ev_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

                            // Forward extended-thinking content (if the CLI/model emits
                            // it for the configured model) via the same \x1b[reasoning]
                            // marker convention the managed/Pro path's ai-proxy already
                            // uses — see mark_reasoning_lines and streamEvents.ts's
                            // extractThinkingText, which requires zero changes to parse
                            // this. Emitted before the visible text below so reasoning
                            // reads before the answer, matching content-block order.
                            for thinking in extract_thinking_from_stream_json(&v) {
                                let marked = mark_reasoning_lines(&thinking);
                                let _ = app_clone.emit(&chunk_event, &marked);
                            }

                            for chunk in text_relay.chunks_for_line(&v) {
                                if !chunk.is_empty() {
                                    let _ = app_clone.emit(&chunk_event, &chunk);
                                }
                            }
                            // Surface tool_use blocks as a structured action event ONLY —
                            // NOT as visible "-> Tool `file`" text spliced into the chunk
                            // stream (that used to smear tool narration into the answer
                            // prose in edit-mode chat). claudeCodeProvider.ts's
                            // streamChatEvents turns each model://action into a typed
                            // 'tool' StreamEvent (running -> done) for the assistant
                            // chat's step UI; editor:openFile still fires from this SAME
                            // action_event, unconditionally, for both the plain-string
                            // streamChat consumers and the structured streamChatEvents
                            // consumer (see that provider's buildRunTurn).
                            for tool_use in extract_tool_uses_from_stream_json(&v) {
                                let _ = app_clone.emit(
                                    &action_event,
                                    serde_json::json!({ "tool": tool_use.name, "file": tool_use.file }),
                                );
                            }
                            // result line: check is_error before relying on exit status
                            // (CLI can return is_error:true with exit code 0)
                            if ev_type == "result" {
                                let is_error = v.get("is_error")
                                    .and_then(|e| e.as_bool())
                                    .unwrap_or(false);
                                if is_error {
                                    let msg = v.get("result")
                                        .and_then(|r| r.as_str())
                                        .unwrap_or("claude error")
                                        .to_string();
                                    let _ = app_clone.emit(&error_event, &msg);
                                    return;
                                }
                            }
                        }
                        // Non-JSON lines (progress bars, warnings) are silently ignored.
                    }
                    Err(_) => break,
                }
            }
        }

        // Wait for child to exit
        let exit_status = match child.wait() {
            Ok(s) => s,
            Err(e) => {
                log::error!("claude_chat_stream_inner: child.wait() failed for pid_key={}: {}", pid_key, e);
                let msg = format!("claude: failed to wait for process exit: {}", e);
                let _ = app_clone.emit(&error_event, &msg);
                untrack_agent_pid(&pids_clone, &pid_key);
                return;
            }
        };

        // Collect stderr output from the drain thread
        let stderr_text = stderr_handle.and_then(|h| h.join().ok()).unwrap_or_default();

        untrack_agent_pid(&pids_clone, &pid_key);

        let elapsed_ms = spawned_at.elapsed().as_millis();
        let exit_code = exit_status.code().unwrap_or(-1);

        if exit_status.success() {
            log::info!(
                "claude_chat_stream_inner: pid_key={} completed in {}ms exit_code={}",
                pid_key, elapsed_ms, exit_code
            );
            let usage = serde_json::json!({ "inputTokens": 0, "outputTokens": 0 });
            let _ = app_clone.emit(&done_event, usage);
        } else {
            log::warn!(
                "claude_chat_stream_inner: pid_key={} exited non-zero after {}ms exit_code={}",
                pid_key, elapsed_ms, exit_code
            );
            let msg = if !stderr_text.trim().is_empty() {
                format!("claude error: {}", stderr_text.trim())
            } else {
                format!("claude exited with status {}", exit_status)
            };
            let _ = app_clone.emit(&error_event, &msg);
        }
    });

    Ok(())
}

/// Extract all text strings from a stream-json line value.
///
/// Only extracts from `{"type":"assistant","message":{"content":[{"type":
/// "text","text":"..."}]}}` events — same top-level "type" guard as
/// extract_tool_uses_from_stream_json below, mirrored exactly. Every other
/// stream-json event ("system" init, "result", and "user" turns — which
/// cover both real tool_result echoes AND the CLI harness's own synthetic
/// re-prompt when the model produced tool calls but no visible text) can
/// carry a `message` object with its own "text"-typed content blocks; before
/// this guard that unrelated text was forwarded to the visible
/// model://chunk stream right alongside real assistant text. That was the
/// root cause of a confirmed leak into the LazyManager chat: a harness
/// re-prompt ("...produce a user-visible response.") rendered as if the
/// model had said it, immediately followed by the model's own reasoning
/// text pulled in the same way.
pub(crate) fn extract_text_from_stream_json(v: &serde_json::Value) -> Vec<String> {
    let mut result = Vec::new();
    if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return result;
    }

    if let Some(msg) = v.get("message") {
        if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
            for item in content {
                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                        result.push(text.to_string());
                    }
                }
            }
        }
    }

    result
}

/// Per-turn state that separates successive *complete* assistant text
/// messages with a blank-line boundary instead of gluing them together.
///
/// Why this exists: `claude -p --output-format stream-json` (run here WITHOUT
/// `--include-partial-messages`, per extract_thinking_from_stream_json's doc
/// comment) is itself a multi-step agent loop for a single logical turn. One
/// "turn" as seen by the caller of claude_chat_stream_inner can therefore
/// produce SEVERAL separate `"type":"assistant"` stream-json lines, each a
/// distinct, already-complete message — e.g. narration text before a
/// tool_use ("Let me check the file first."), then, after the tool_result
/// round-trip, a second assistant line with the final answer. Both are
/// legitimately meant for the user (this is explicitly not the harness
/// re-prompt case already filtered out by extract_text_from_stream_json's
/// "type" == "assistant" guard above — that one drops a synthetic *"user"*
/// line; this one is about two real, distinct *assistant* lines).
///
/// Before this fix, `claude_chat_stream_inner`'s read loop forwarded every
/// text block from every assistant line to the same model://chunk stream
/// with zero separator between them, because model://chunk is consumed as a
/// flat concatenation (see claudeCodeProvider.ts: chunks are queued and
/// yielded in order with no delimiter reinserted downstream). Two complete
/// sentences glued byte-for-byte with no space or boundary is exactly the
/// observed LazyManager corruption: "...au démarrage.js(projet actif...)" —
/// a run-on splice of two separate renderings of the same task description,
/// not a single garbled stream.
///
/// The fix joins rather than drops: a real Claude Code turn frequently has
/// meaningful text both before AND after a tool call (see the tool_use
/// interleaving noted on extract_tool_uses_from_stream_json), and both halves
/// are meant for the user, so silently keeping only the "final" assistant
/// message would lose real content. What was missing was only a boundary
/// between them, not a decision about which one to discard — so this joins
/// every non-empty assistant-text-bearing line in the turn with a "\n\n"
/// separator, in the order they arrive.
///
/// Scope: the boundary is inserted between distinct stream-json *lines*, not
/// between multiple "text" content blocks returned for the SAME line by
/// extract_text_from_stream_json. Content blocks within one message are
/// already contiguous prose from a single Anthropic API turn (a tool_use
/// block ends that turn — the model cannot resume text generation after one
/// within the same message — so a single line never legitimately contains
/// two independent text stretches split by a tool call); only across lines
/// does the "separate complete message" boundary apply.
#[derive(Default)]
struct AssistantTextRelay {
    /// Whether any non-empty assistant text has already been forwarded for
    /// this turn (i.e. since this relay was constructed for the current
    /// child process's stdout loop).
    emitted_any: bool,
}

impl AssistantTextRelay {
    /// Given one stream-json line's parsed JSON value, returns the chunk(s)
    /// that should be emitted to model://chunk, in order.
    ///
    /// - Non-assistant lines, or assistant lines with no non-empty text
    ///   blocks (pure tool_use / pure thinking messages), return an empty
    ///   Vec and leave `emitted_any` untouched — a `system`/`result`/
    ///   `user`(tool_result) line, or a tool-only assistant line, must never
    ///   itself count as having emitted visible text, or a later real text
    ///   line would get a spurious leading separator.
    /// - The FIRST line in the turn that carries non-empty text is relayed
    ///   unchanged — this is what keeps the common single-message case
    ///   byte-identical to the pre-fix output.
    /// - Every SUBSEQUENT line that carries non-empty text is preceded by a
    ///   single "\n\n" separator chunk, then its own text block(s) unchanged.
    fn chunks_for_line(&mut self, v: &serde_json::Value) -> Vec<String> {
        let texts: Vec<String> = extract_text_from_stream_json(v)
            .into_iter()
            .filter(|t| !t.is_empty())
            .collect();
        if texts.is_empty() {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(texts.len() + 1);
        if self.emitted_any {
            out.push("\n\n".to_string());
        }
        out.extend(texts);
        self.emitted_any = true;
        out
    }
}

/// Extract "thinking" block text from a stream-json line's `message.content`
/// array — the Claude Code CLI's extended-thinking content block, mirroring
/// the Anthropic Messages API shape: `{"type":"thinking","thinking":"...",
/// "signature":"..."}`. Sibling of extract_text_from_stream_json above,
/// which only looks at `type: "text"` items and silently ignored `type:
/// "thinking"` ones (GAP 1: thinking dropped on this path).
///
/// This path's stream-json runs WITHOUT `--include-partial-messages`, so
/// each line is one complete assistant message — a thinking block's text
/// already arrives whole in a single line here, unlike the token-by-token
/// Anthropic SSE path (see stream_anthropic's separate accumulation
/// buffer). No cross-line buffering is needed for this function.
///
/// Same top-level "type" == "assistant" guard as extract_text_from_stream_json
/// above (and extract_tool_uses_from_stream_json below) — a non-assistant
/// event's `message.content` must never be read as the model's own
/// reasoning, for the same leak reason documented on that sibling function.
///
/// Honest limitation: whether the real `claude` CLI actually emits a
/// "thinking" content block in stream-json for the configured model cannot
/// be verified without the real CLI/subscription — this function forwards
/// one if present; it cannot make the CLI produce one.
pub(crate) fn extract_thinking_from_stream_json(v: &serde_json::Value) -> Vec<String> {
    let mut result = Vec::new();
    if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return result;
    }
    if let Some(content) = v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        for item in content {
            if item.get("type").and_then(|t| t.as_str()) == Some("thinking") {
                if let Some(text) = item.get("thinking").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        result.push(text.to_string());
                    }
                }
            }
        }
    }
    result
}

/// Wire prefix for the out-of-band reasoning-channel marker — mirrors the
/// convention the managed/Pro path's ai-proxy already uses (see
/// managedProvider.ts's module doc comment and streamEvents.ts's
/// extractThinkingText / brainSearchLoop.ts's OUT_OF_BAND_MARKER on the
/// TypeScript side). Forwarding thinking text prefixed with this exact byte
/// sequence lets the existing TS-side extraction (thinking) and stripping
/// (visible text) logic handle it with zero new convention.
const REASONING_MARKER_PREFIX: &str = "\x1b[reasoning]";

/// Formats accumulated extended-thinking text as one or more marker-prefixed
/// lines, ready to interleave into the same `model://chunk` text stream as
/// ordinary visible text. Each line of `text` gets its own marker so the
/// TypeScript side's per-line extraction (extractThinkingText) and stripping
/// (stripInvisibleLines) both see a correctly marked line regardless of how
/// many newlines the thinking content contains — matches the managed path's
/// existing `\x1b[reasoning]<line>` convention byte-for-byte.
///
/// Takes the FULL accumulated thinking text for a block, not a raw
/// per-token delta: callers buffer deltas into a String and call this once,
/// when the reasoning stretch ends (see stream_anthropic and
/// claude_chat_stream_inner). A naive per-delta call would let the
/// TypeScript side's line-level `.trim()` (extractThinkingText) eat the
/// inter-word space at each delta boundary, corrupting the reconstructed
/// text — buffering the whole block first and splitting into lines exactly
/// once avoids that entirely.
fn mark_reasoning_lines(text: &str) -> String {
    text.lines()
        .map(|line| format!("{}{}", REASONING_MARKER_PREFIX, line))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

/// One tool_use block surfaced from a stream-json assistant message: the
/// tool name and, for file-oriented tools, the target file path.
#[derive(Debug, PartialEq)]
pub(crate) struct ToolUseInfo {
    pub name: String,
    pub file: Option<String>,
}

/// Extract all tool_use blocks from a stream-json line's `message.content`
/// array (assistant messages only — mirrors the original inline check).
/// Pure/testable: separated from the emit side-effects in
/// claude_chat_stream_inner (GAP 2) so "which tools got called, with which
/// file" can be verified without spawning the CLI. Callers decide how to
/// surface these (currently: model://action only, no visible-text
/// annotation — see the call site's doc comment).
pub(crate) fn extract_tool_uses_from_stream_json(v: &serde_json::Value) -> Vec<ToolUseInfo> {
    let mut result = Vec::new();
    if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return result;
    }
    if let Some(content) = v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                let name = block.get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_string();
                let file = block.get("input")
                    .and_then(|i| i.get("file_path"))
                    .and_then(|f| f.as_str())
                    .map(|s| s.to_string());
                result.push(ToolUseInfo { name, file });
            }
        }
    }
    result
}

/// A single chat message for model_chat_stream.
#[derive(Deserialize, Debug, Clone)]
pub struct ChatMessageReq {
    pub role: String,
    pub content: String,
}

/// Request payload for model_chat_stream.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelChatRequest {
    /// Caller-assigned correlation id (used in event names).
    pub id: String,
    /// Provider: "anthropic" | "openai" | "google"
    pub provider: String,
    /// Model id, e.g. "claude-haiku-4-5"
    pub model: String,
    /// Optional system prompt.
    pub system: Option<String>,
    /// Conversation messages.
    pub messages: Vec<ChatMessageReq>,
    /// BYOK key — takes priority over env var.
    pub api_key: Option<String>,
    /// Max tokens to generate (defaults to 1024).
    pub max_tokens: Option<u32>,
}

/// Anthropic SSE event types we care about.
enum AnthropicSseEvent {
    TextDelta(String),
    /// Extended-thinking delta — see mark_reasoning_lines' doc comment for
    /// why callers buffer these rather than forwarding each one immediately.
    ThinkingDelta(String),
    MessageStop,
    Usage { input_tokens: u32, output_tokens: u32 },
    Error(String),
}

/// Parse a single SSE data line from the Anthropic streaming API.
fn parse_anthropic_sse(data: &str) -> Option<AnthropicSseEvent> {
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    let event_type = v.get("type")?.as_str()?;
    match event_type {
        "content_block_delta" => {
            let delta = v.get("delta")?;
            match delta.get("type")?.as_str()? {
                "text_delta" => {
                    let text = delta.get("text")?.as_str()?.to_string();
                    Some(AnthropicSseEvent::TextDelta(text))
                }
                // Extended-thinking delta: the text field is "thinking", NOT
                // "text" (distinct from text_delta above) — verified against
                // the Messages API streaming reference; see this module's
                // parse_anthropic_sse tests for the exact wire shape.
                "thinking_delta" => {
                    let text = delta.get("thinking")?.as_str()?.to_string();
                    Some(AnthropicSseEvent::ThinkingDelta(text))
                }
                // signature_delta, input_json_delta, citations_delta, etc. —
                // not needed for chat display; only text/thinking forwarded.
                // Requesting extended thinking itself (a top-level
                // "thinking": {...} field on the request body) is a
                // separate, out-of-scope decision — see this file's module
                // doc / the final report; this function only forwards
                // thinking_delta events if the caller's request already
                // asked for them.
                _ => None,
            }
        }
        "message_delta" => {
            // Check usage in message_delta
            if let Some(usage) = v.get("usage") {
                let output = usage.get("output_tokens")
                    .and_then(|t| t.as_u64())
                    .unwrap_or(0) as u32;
                // input_tokens are in message_start, not message_delta — emit 0 here
                return Some(AnthropicSseEvent::Usage { input_tokens: 0, output_tokens: output });
            }
            None
        }
        "message_start" => {
            // Extract input_tokens from message_start
            if let Some(msg) = v.get("message") {
                if let Some(usage) = msg.get("usage") {
                    let input = usage.get("input_tokens")
                        .and_then(|t| t.as_u64())
                        .unwrap_or(0) as u32;
                    return Some(AnthropicSseEvent::Usage { input_tokens: input, output_tokens: 0 });
                }
            }
            None
        }
        "message_stop" => Some(AnthropicSseEvent::MessageStop),
        "error" => {
            let msg = v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error")
                .to_string();
            Some(AnthropicSseEvent::Error(msg))
        }
        _ => None,
    }
}

/// Resolve the Anthropic API key: prefer explicit req.api_key, then env var.
fn resolve_anthropic_key(req_key: Option<&str>) -> Result<String, String> {
    if let Some(k) = req_key {
        let k = k.trim();
        if !k.is_empty() {
            return Ok(k.to_string());
        }
    }
    std::env::var("ANTHROPIC_API_KEY")
        .map_err(|_| "no_api_key".to_string())
        .and_then(|k| {
            let k = k.trim().to_string();
            if k.is_empty() { Err("no_api_key".to_string()) } else { Ok(k) }
        })
}

/// Streaming model chat command.
///
/// Emits Tauri events:
///   model://chunk/{id}  — payload: String (text delta)
///   model://done/{id}   — payload: {inputTokens: u32, outputTokens: u32}
///   model://error/{id}  — payload: String (error message)
#[tauri::command]
pub(crate) async fn model_chat_stream(
    app: tauri::AppHandle,
    req: ModelChatRequest,
) -> Result<(), String> {
    match req.provider.as_str() {
        "anthropic" => stream_anthropic(app, req).await,
        other => {
            let msg = format!("provider '{}' not implemented", other);
            let _ = app.emit(&format!("model://error/{}", req.id), &msg);
            Err(msg)
        }
    }
}

async fn stream_anthropic(app: tauri::AppHandle, req: ModelChatRequest) -> Result<(), String> {
    let api_key = resolve_anthropic_key(req.api_key.as_deref())?;

    let chunk_event = format!("model://chunk/{}", req.id);
    let done_event  = format!("model://done/{}", req.id);
    let error_event = format!("model://error/{}", req.id);

    // Build request body
    let messages: Vec<serde_json::Value> = req.messages.iter().map(|m| {
        serde_json::json!({ "role": m.role, "content": m.content })
    }).collect();

    let mut body = serde_json::json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(1024),
        "messages": messages,
        "stream": true,
    });

    if let Some(system) = &req.system {
        if !system.is_empty() {
            body["system"] = serde_json::Value::String(system.clone());
        }
    }

    // Async reqwest client (non-blocking)
    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let msg = format!("API error {}: {}", status, text);
        let _ = app.emit(&error_event, &msg);
        return Err(msg);
    }

    // Read SSE stream byte-by-byte
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut current_event_name = String::new();
    let mut total_input: u32 = 0;
    let mut total_output: u32 = 0;
    // Accumulates extended-thinking text for the CURRENT reasoning stretch.
    // Anthropic streams thinking as many small token-level deltas (unlike
    // the Claude Code CLI path's whole-block stream-json lines), so this
    // buffers deltas and flushes as marker-prefixed line(s) — via
    // mark_reasoning_lines — only once the stretch ends: the next text
    // delta, message_stop, or the stream simply ending. See
    // mark_reasoning_lines' doc comment for why a naive per-delta marker
    // would corrupt word spacing across delta boundaries.
    let mut thinking_buf = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream read error: {}", e))?;
        let text = String::from_utf8_lossy(&chunk);
        buf.push_str(&text);

        // SSE lines are separated by \n; events by \n\n
        loop {
            if let Some(nl) = buf.find('\n') {
                let line = buf[..nl].trim_end_matches('\r').to_string();
                buf = buf[nl + 1..].to_string();

                if line.starts_with("event:") {
                    current_event_name = line[6..].trim().to_string();
                } else if line.starts_with("data:") {
                    let data = line[5..].trim();
                    if data == "[DONE]" {
                        // OpenAI-style done, not used by Anthropic but handle gracefully
                        break;
                    }
                    if let Some(evt) = parse_anthropic_sse(data) {
                        match evt {
                            AnthropicSseEvent::TextDelta(text) => {
                                // A reasoning stretch (if any) ends here — flush it as
                                // marker-prefixed line(s) BEFORE the visible text delta
                                // that follows it, matching content-block order.
                                if !thinking_buf.is_empty() {
                                    let marked = mark_reasoning_lines(&thinking_buf);
                                    let _ = app.emit(&chunk_event, &marked);
                                    thinking_buf.clear();
                                }
                                let _ = app.emit(&chunk_event, &text);
                            }
                            AnthropicSseEvent::ThinkingDelta(text) => {
                                thinking_buf.push_str(&text);
                            }
                            AnthropicSseEvent::Usage { input_tokens, output_tokens } => {
                                if input_tokens > 0 { total_input = input_tokens; }
                                if output_tokens > 0 { total_output += output_tokens; }
                            }
                            AnthropicSseEvent::MessageStop => {
                                if !thinking_buf.is_empty() {
                                    let marked = mark_reasoning_lines(&thinking_buf);
                                    let _ = app.emit(&chunk_event, &marked);
                                    thinking_buf.clear();
                                }
                                let usage = serde_json::json!({
                                    "inputTokens": total_input,
                                    "outputTokens": total_output,
                                });
                                let _ = app.emit(&done_event, usage);
                                return Ok(());
                            }
                            AnthropicSseEvent::Error(msg) => {
                                let _ = app.emit(&error_event, &msg);
                                return Err(msg);
                            }
                        }
                    }
                } else if line.is_empty() {
                    // blank line = end of event, reset event name
                    current_event_name.clear();
                }
            } else {
                break;
            }
        }

        let _ = current_event_name; // suppress unused warning inside loop
    }

    // Stream ended without message_stop — flush any still-open reasoning
    // stretch, then emit done anyway.
    if !thinking_buf.is_empty() {
        let marked = mark_reasoning_lines(&thinking_buf);
        let _ = app.emit(&chunk_event, &marked);
    }
    let usage = serde_json::json!({
        "inputTokens": total_input,
        "outputTokens": total_output,
    });
    let _ = app.emit(&done_event, usage);
    Ok(())
}

// ── Devin CLI (ACP) backend ─────────────────────────────────────────────
//
// Unlike claude/codex, the Devin CLI does not stream a single prompt on
// stdout: `devin -p` buffers the whole reply and only prints at exit, which
// would give the UI zero progress for turns that routinely take 30-120s.
// The supported streaming surface is `devin acp` — the Agent Client
// Protocol, a newline-delimited JSON-RPC server over stdio (the same
// protocol Zed/JetBrains use to embed the agent). Verified end-to-end
// against devin 3000.x:
//
//   -> initialize            {protocolVersion:1, clientCapabilities, ...}
//   -> authenticate          {methodId:"devin-browser", apiKey}   (see below)
//   -> session/new           {cwd, mcpServers:[]}                 -> sessionId
//   -> session/set_mode      {sessionId, modeId}  ("ask"/"accept-edits"/"plan")
//   -> session/prompt        {sessionId, prompt:[{type:"text",...}]}
//   <- session/update notifications: agent_message_chunk (text),
//      agent_thought_chunk (reasoning), tool_call, config_option_update, ...
//   <- session/prompt result: {stopReason, usage:{inputTokens,outputTokens}}
//
// One ACP process per turn (same per-turn lifecycle as codex — deliberately
// NOT a persistent server, which would keep an idle agent resident between
// turns and complicate crash/cancel recovery; spawn cost is ~300-400ms).
// ACP intentionally ignores the CLI's interactive login state — auth comes
// from an explicit `authenticate` call carrying the api key read LOCALLY
// from the Devin CLI's own credentials store. The key never enters a log,
// an event, or a frontend payload.
//
// Cancellation reuses the same contract as the other chat backends: the
// child pid is tracked under "chat-devin-{id}" and devin_chat_stream_cancel
// tree-kills it; killing the process also ends the JSON-RPC loop (stdout
// EOF), so no explicit session/cancel is required on the abort path.

/// Hard cap on bytes read for an fs/read_text_file agent->client request.
/// Large enough for any real source file; protects the stdio channel from
/// an accidental multi-GB dump (e.g. the agent probing a binary artifact).
const ACP_READ_FILE_CAP_BYTES: usize = 1_000_000;

/// Resolves the devin CLI executable. PATH first (devin's installer adds it
/// for most setups), then the two well-known per-user install locations —
/// the standalone CLI (%LOCALAPPDATA%\devin\cli\bin) and the copy bundled
/// inside the Devin IDE — because a Tauri app launched from Explorer often
/// inherits a stale PATH from before the install.
fn resolve_devin_program() -> std::ffi::OsString {
    let on_path = resolve_cli_program("devin");
    if std::path::Path::new(&on_path).exists() {
        return on_path;
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        for rel in [
            r"devin\cli\bin\devin.exe",
            r"Programs\Devin\resources\app\extensions\windsurf\devin\bin\devin.exe",
        ] {
            let candidate = format!("{local}\\{rel}");
            if std::path::Path::new(&candidate).exists() {
                return candidate.into();
            }
        }
    }
    // Fall back to the bare name — CreateProcess may still resolve it via
    // its own search order (e.g. a shim in the user's PATH that our cached
    // env snapshot missed).
    "devin".into()
}

/// Reads the api key the Devin CLI itself stores at
/// %APPDATA%\devin\credentials.toml (`windsurf_api_key = "..."`). We never
/// log or forward this value — it is only placed into the `authenticate`
/// JSON-RPC call written to the child's own stdin. Returns None when the
/// file or key is absent (user not logged in) so the caller can surface a
/// precise "run `devin auth login`" error instead of an opaque ACP failure.
fn read_devin_api_key() -> Option<String> {
    let appdata = std::env::var("APPDATA").ok()?;
    let content = std::fs::read_to_string(format!("{appdata}\\devin\\credentials.toml")).ok()?;
    for line in content.lines() {
        let l = line.trim();
        let Some(rest) = l.strip_prefix("windsurf_api_key") else { continue };
        let value = rest.trim_start().strip_prefix('=')?.trim().trim_matches('"');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// True when the Devin CLI is installed AND has a stored credential the ACP
/// backend can authenticate with. Surfaced in Settings so the Devin option
/// can distinguish "not installed" from "installed but not logged in".
#[tauri::command]
pub(crate) fn devin_auth_status() -> bool {
    read_devin_api_key().is_some()
}

/// A single option from the model config_option_update — one entry in the
/// account's real catalog (values like "swe-2-medium", "claude-opus-5-max").
#[derive(serde::Serialize)]
pub struct DevinModelOption {
    pub id: String,
    pub label: String,
}

/// Live model catalog for the Devin backend. Spawns a short-lived
/// `devin acp`, runs initialize -> authenticate -> session/new, captures the
/// `config_option_update` notification's "model" select options (the real,
/// account-specific catalog — ~80 entries covering every model family the
/// plan can run), then kills the process. Falls back to an empty list on
/// any failure — the frontend keeps a static fallback list so the picker
/// still offers SWE-2 while detection is offline.
#[tauri::command]
pub(crate) async fn devin_list_models(app: tauri::AppHandle) -> Result<Vec<DevinModelOption>, String> {
    let project_root: String = app.state::<ProjectState>()
        .0.lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let result = std::panic::catch_unwind(move || devin_list_models_blocking(&project_root));
        result.unwrap_or_else(|_| Ok(Vec::new()))
    })
    .await
    .map_err(|e| format!("devin_list_models task failed: {e}"))?
}

fn devin_list_models_blocking(project_root: &str) -> Result<Vec<DevinModelOption>, String> {
    let Some(api_key) = read_devin_api_key() else {
        return Err("Devin CLI not authenticated — run `devin auth login` first.".to_string());
    };
    let mut cmd = quiet_command(resolve_devin_program());
    cmd.arg("acp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if !project_root.is_empty() {
        cmd.current_dir(project_root);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Err(format!("failed to spawn `devin acp`: {e}")),
    };
    let pid = child.id();
    // Watchdog: this command has no frontend abort path, so a hung child
    // must be reaped internally — 30s is far beyond the observed ~400ms.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(30));
        let _ = quiet_command("taskkill").args(tree_kill_args(pid)).output();
    });

    let models = {
        let mut conn = AcpConn::new(&mut child);
        conn.project_root = project_root.to_string();
        (|| -> Result<Vec<DevinModelOption>, String> {
            conn.call("initialize", serde_json::json!({
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": { "name": "lazy-ide", "version": "0" },
            }), &mut |_| {})?;
            conn.call("authenticate", serde_json::json!({
                "methodId": "devin-browser",
                "apiKey": api_key,
            }), &mut |_| {})?;
            let mut found: Vec<DevinModelOption> = Vec::new();
            conn.call("session/new", serde_json::json!({
                "cwd": if project_root.is_empty() { "." } else { project_root },
                "mcpServers": [],
            }), &mut |update| {
                if update.get("sessionUpdate").and_then(|v| v.as_str()) == Some("config_option_update") {
                    if let Some(options) = update.get("configOptions").and_then(|v| v.as_array()) {
                        for opt in options {
                            if opt.get("id").and_then(|v| v.as_str()) != Some("model") { continue }
                            if let Some(entries) = opt.get("options").and_then(|v| v.as_array()) {
                                for e in entries {
                                    if let (Some(id), Some(name)) = (
                                        e.get("value").and_then(|v| v.as_str()),
                                        e.get("name").and_then(|v| v.as_str()),
                                    ) {
                                        found.push(DevinModelOption { id: id.to_string(), label: name.to_string() });
                                    }
                                }
                            }
                        }
                    }
                }
            })?;
            Ok(found)
        })()
        // conn dropped here — its stdin closes, letting `devin acp` exit on EOF
    };
    let _ = child.kill();
    let _ = child.wait();
    models
}

/// Minimal ACP JSON-RPC plumbing over the child's stdio. Requests are
/// sequential (initialize -> authenticate -> session/new -> ... -> prompt),
/// matching how the ACP session lifecycle is specified — no pipelining is
/// needed for a per-turn client and it keeps error attribution exact.
struct AcpConn {
    stdin: std::process::ChildStdin,
    reader: std::io::BufReader<std::process::ChildStdout>,
    next_id: u64,
    /// Project root the session was opened on — the read_text_file jail.
    project_root: String,
}

impl AcpConn {
    fn new(child: &mut std::process::Child) -> Self {
        Self {
            stdin: child.stdin.take().expect("acp stdin piped"),
            reader: std::io::BufReader::new(child.stdout.take().expect("acp stdout piped")),
            next_id: 1,
            project_root: String::new(),
        }
    }

    fn send(&mut self, msg: &serde_json::Value) -> Result<(), String> {
        use std::io::Write;
        let line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("acp write failed: {e}"))
    }

    /// Send a request and block until ITS response arrives. Notifications
    /// (session/update) are folded through `on_update`; agent->client
    /// requests (fs/read_text_file, session/request_permission) are answered
    /// inline so the agent never stalls waiting on us mid-turn.
    fn call(
        &mut self,
        method: &str,
        params: serde_json::Value,
        on_update: &mut dyn FnMut(&serde_json::Value),
    ) -> Result<serde_json::Value, String> {
        use std::io::BufRead;
        let id = self.next_id;
        self.next_id += 1;
        self.send(&serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params,
        }))?;
        let mut line = String::new();
        loop {
            line.clear();
            let n = self.reader.read_line(&mut line).map_err(|e| format!("acp read failed: {e}"))?;
            if n == 0 {
                return Err("devin acp closed its output stream".to_string());
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
            // Our response: id matches and carries result|error.
            if msg.get("id").and_then(|v| v.as_u64()) == Some(id)
                && (msg.get("result").is_some() || msg.get("error").is_some())
            {
                if let Some(err) = msg.get("error") {
                    let text = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown acp error");
                    return Err(format!("{method} failed: {text}"));
                }
                return Ok(msg.get("result").cloned().unwrap_or(serde_json::Value::Null));
            }
            // An agent->client REQUEST carries both method and id.
            if let (Some(m), Some(rid)) = (msg.get("method").and_then(|v| v.as_str()), msg.get("id").cloned()) {
                self.answer_client_request(m, &rid, msg.get("params").cloned().unwrap_or(serde_json::Value::Null));
                continue;
            }
            // session/update notification.
            if msg.get("method").and_then(|v| v.as_str()) == Some("session/update") {
                if let Some(update) = msg.pointer("/params/update") {
                    on_update(update);
                }
            }
        }
    }

    /// Answers a JSON-RPC request the AGENT sent us. Only the two request
    /// kinds a read/edit agent legitimately needs are implemented; every
    /// other method (terminal/*, fs/write_text_file — which we did not
    /// advertise) gets Method not found.
    fn answer_client_request(&mut self, method: &str, id: &serde_json::Value, params: serde_json::Value) {
        let response = match method {
            "fs/read_text_file" => self.acp_read_text_file(&params),
            "session/request_permission" => acp_auto_permission(&params),
            _ => Err(-32601),
        };
        let msg = match response {
            Ok(result) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(code) => serde_json::json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": code, "message": "lazy-ide: not supported" },
            }),
        };
        let _ = self.send(&msg);
    }

    /// fs/read_text_file — the agent asks the client (us) for file content.
    /// Jailed to the session's project root: the agent's own sandbox already
    /// constrains what it wants to read, and serving arbitrary paths (e.g.
    /// ~/.ssh) would route that content into the model's context via our
    /// process. Case/separator-tolerant prefix check, matching the TS-side
    /// normalizeForPathCompare convention.
    fn acp_read_text_file(&self, params: &serde_json::Value) -> Result<serde_json::Value, i64> {
        let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let norm = |p: &str| p.trim().trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase();
        let (root, target) = (norm(&self.project_root), norm(path));
        if self.project_root.is_empty() || !(target == root || target.starts_with(&(root + "\\"))) {
            return Err(-32602);
        }
        let bytes = std::fs::read(path).map_err(|_| -32602)?;
        let capped = if bytes.len() > ACP_READ_FILE_CAP_BYTES { &bytes[..ACP_READ_FILE_CAP_BYTES] } else { &bytes[..] };
        Ok(serde_json::json!({ "content": String::from_utf8_lossy(capped) }))
    }
}

impl Drop for AcpConn {
    /// Closing stdin lets `devin acp` see EOF and exit cleanly — the polite
    /// counterpart to the explicit child.kill() callers still issue.
    fn drop(&mut self) {
        use std::io::Write;
        let _ = self.stdin.flush();
    }
}

/// Auto-answer for session/request_permission. The user already granted
/// LazyIDE the launch; per-tool-call prompting inside a CLI-driven chat turn
/// would deadlock the stream (there is no UI for it), so we pick the
/// narrowest allow option the agent offered — 'allow_once' first, then
/// 'allow_always', then the first listed option — or report 'cancelled'
/// when the options list is empty (the spec's legal escape).
fn acp_auto_permission(params: &serde_json::Value) -> Result<serde_json::Value, i64> {
    let options = params.get("options").and_then(|v| v.as_array());
    let pick = options.and_then(|opts| {
        opts.iter()
            .find(|o| o.get("kind").and_then(|k| k.as_str()) == Some("allow_once"))
            .or_else(|| opts.iter().find(|o| o.get("kind").and_then(|k| k.as_str()) == Some("allow_always")))
            .or_else(|| opts.first())
            .and_then(|o| o.get("optionId").and_then(|v| v.as_str()))
    });
    match pick {
        Some(option_id) => Ok(serde_json::json!({
            "outcome": { "outcome": "selected", "optionId": option_id },
        })),
        None => Ok(serde_json::json!({ "outcome": { "outcome": "cancelled" } })),
    }
}

/// Maps LazyIDE's chat mode to Devin's ACP session modes (seen live in
/// session/new's modes.availableModes: accept-edits/smart/ask/plan/bypass).
/// "edit" maps to accept-edits (write code, apply edits) — NOT bypass,
/// which auto-approves everything and is deliberately never chosen here.
fn acp_mode_id(mode: Option<&str>) -> Option<&'static str> {
    match mode {
        Some("ask") => Some("ask"),
        Some("edit") => Some("accept-edits"),
        Some("plan") => Some("plan"),
        _ => None,
    }
}

/// Spawn `devin acp` and drive one prompt turn over JSON-RPC, emitting the
/// same model:// events as the other chat backends.
async fn devin_chat_stream_inner(
    app: tauri::AppHandle,
    req: AgentCliChatRequest,
    agent_pids: tauri::State<'_, AgentPidState>,
) -> Result<(), String> {
    let chunk_event = format!("model://chunk/{}", req.id);
    let done_event  = format!("model://done/{}", req.id);
    let error_event = format!("model://error/{}", req.id);
    let action_event = format!("model://action/{}", req.id);
    let pid_key = format!("chat-devin-{}", req.id);

    let Some(api_key) = read_devin_api_key() else {
        let msg = "Devin CLI is not authenticated — run `devin auth login` once, then retry.".to_string();
        let _ = app.emit(&error_event, &msg);
        return Err(msg);
    };

    let prompt = build_claude_prompt(req.system.as_deref(), &req.messages);
    let project_root: String = app.state::<ProjectState>()
        .0.lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    let model = req.model.clone().unwrap_or_default();
    let mode = req.mode.clone();
    let app2 = app.clone();
    // Same tracking contract as codex_chat_stream_inner — the clone shares
    // AgentPidState's map with kill_tracked_agent_pids' app-exit sweep.
    let pids_clone = agent_pids.0.clone();

    tokio::task::spawn_blocking(move || {
        let mut args: Vec<String> = vec!["acp".to_string()];
        if !model.is_empty() {
            args.push("--model".to_string());
            args.push(model.clone());
        }
        let mut cmd = quiet_command(resolve_devin_program());
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !project_root.is_empty() {
            cmd.current_dir(&project_root);
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return Err(format!("failed to spawn `devin acp`: {e}")),
        };
        track_agent_pid(&pids_clone, &pid_key, child.id());
        // Drain stderr concurrently (pipe-buffer deadlock guard), tail-capped.
        let stderr_handle = child.stderr.take().map(|se| spawn_stderr_tail(se, STDERR_TAIL_CAP_BYTES));

        let result = devin_acp_turn(&mut child, api_key, &project_root, mode.as_deref(), &prompt, &app2, &chunk_event, &action_event);
        // AcpConn (dropped with devin_acp_turn's scope) owned stdin — its
        // close already let the child see EOF. kill() is the belt-and-braces
        // for a turn that ended on error before stdin closed.
        let _ = child.kill();
        let _ = child.wait();
        untrack_agent_pid(&pids_clone, &pid_key);
        let stderr_text = stderr_handle.and_then(|h| h.join().ok()).unwrap_or_default();

        match result {
            Ok(usage) => {
                let _ = app2.emit(&done_event, &usage);
                Ok(())
            }
            Err(e) => {
                let msg = if stderr_text.is_empty() { e } else { format!("{e}\n\n{stderr_text}") };
                let _ = app2.emit(&error_event, &msg);
                Err(msg)
            }
        }
    })
    .await
    .map_err(|e| format!("devin acp task failed: {e}"))?
}

/// One full ACP turn on an already-spawned `devin acp` child: handshake,
/// session, mode, prompt. Returns the session/prompt result's usage object
/// for the done event. All text arrives via on_update -> the emit closures.
fn devin_acp_turn(
    child: &mut std::process::Child,
    api_key: String,
    project_root: &str,
    mode: Option<&str>,
    prompt: &str,
    app: &tauri::AppHandle,
    chunk_event: &str,
    action_event: &str,
) -> Result<serde_json::Value, String> {
    let mut conn = AcpConn::new(child);
    conn.project_root = project_root.to_string();

    let emit_update = |update: &serde_json::Value| {
        match update.get("sessionUpdate").and_then(|v| v.as_str()) {
            Some("agent_message_chunk") => {
                if let Some(text) = update.pointer("/content/text").and_then(|v| v.as_str()) {
                    let _ = app.emit(chunk_event, text);
                }
            }
            Some("agent_thought_chunk") => {
                if let Some(text) = update.pointer("/content/text").and_then(|v| v.as_str()) {
                    let _ = app.emit(chunk_event, &mark_reasoning_lines(text));
                }
            }
            Some("tool_call") => {
                let tool = update.get("title").and_then(|v| v.as_str())
                    .or_else(|| update.get("kind").and_then(|v| v.as_str()))
                    .unwrap_or("tool");
                let file = update.get("locations")
                    .and_then(|v| v.as_array())
                    .and_then(|locs| locs.first())
                    .and_then(|loc| loc.get("path").and_then(|v| v.as_str()));
                let _ = app.emit(action_event, &serde_json::json!({ "tool": tool, "file": file }));
            }
            _ => {}
        }
    };

    conn.call("initialize", serde_json::json!({
        "protocolVersion": 1,
        // readTextFile advertised so the agent can pull project files
        // through us in ask mode instead of needing its own fs tools.
        "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": false } },
        "clientInfo": { "name": "lazy-ide", "version": env!("CARGO_PKG_VERSION") },
    }), &mut |_| {})?;

    conn.call("authenticate", serde_json::json!({
        "methodId": "devin-browser",
        "apiKey": api_key,
    }), &mut |_| {})?;

    // session/new requires a valid cwd — "." (the child's inherited cwd)
    // when no project is open yet.
    let session = conn.call("session/new", serde_json::json!({
        "cwd": if project_root.is_empty() { "." } else { project_root },
        "mcpServers": [],
    }), &mut |_| {})?;
    let session_id = session.get("sessionId").and_then(|v| v.as_str())
        .ok_or_else(|| "session/new returned no sessionId".to_string())?
        .to_string();

    if let Some(mode_id) = acp_mode_id(mode) {
        // Best-effort: an older CLI without set_mode support must not kill
        // the turn — the mode default (accept-edits) still streams fine.
        let _ = conn.call("session/set_mode", serde_json::json!({
            "sessionId": session_id, "modeId": mode_id,
        }), &mut |_| {});
    }

    let result = conn.call("session/prompt", serde_json::json!({
        "sessionId": session_id,
        "prompt": [{ "type": "text", "text": prompt }],
    }), &mut |update| emit_update(update))?;

    // Each turn is its own session; deleting it keeps the user's
    // `devin list` / session DB free of one-shot chat junk. Best-effort —
    // older CLIs without session/delete must not fail a completed turn.
    let _ = conn.call("session/delete", serde_json::json!({ "sessionId": session_id }), &mut |_| {});

    let usage = result.get("usage").cloned().unwrap_or_else(|| serde_json::json!({}));
    Ok(serde_json::json!({
        "inputTokens": usage.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0),
        "outputTokens": usage.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0),
    }))
}

/// Cancel an in-flight devin ACP turn — same contract as
/// claude_chat_stream_cancel/codex_chat_stream_cancel, targeting the
/// "chat-devin-{id}" tracking key devin_chat_stream_inner registers.
#[tauri::command]
pub(crate) fn devin_chat_stream_cancel(id: String, agent_pids: tauri::State<'_, AgentPidState>) -> Result<(), String> {
    cancel_tracked_chat_pid(&format!("chat-devin-{}", id), &agent_pids);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── extract_text_from_stream_json — baseline regression guard ────────
    // (Pre-existing function; not modified by this change, but this file had
    // zero tests before — a minimal baseline here is cheap insurance.)

    #[test]
    fn extract_text_from_stream_json_reads_assistant_text_blocks() {
        let v = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": "hello" }] },
        });
        assert_eq!(extract_text_from_stream_json(&v), vec!["hello".to_string()]);
    }

    #[test]
    fn extract_text_from_stream_json_ignores_thinking_blocks() {
        let v = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{ "type": "thinking", "thinking": "hmm" }] },
        });
        assert!(extract_text_from_stream_json(&v).is_empty());
    }

    #[test]
    fn extract_text_from_stream_json_ignores_non_assistant_messages() {
        // Regression guard for the confirmed LazyManager chat leak: a "user"
        // line — the CLI harness's own synthetic re-prompt when the model
        // produced tool calls but no visible text ("...produce a
        // user-visible response.") — must never be read as assistant text,
        // even though it carries the same message.content[].type == "text"
        // shape a real assistant event does.
        let v = serde_json::json!({
            "type": "user",
            "message": {
                "content": [
                    { "type": "text", "text": "...response had no visible output. Please continue and produce a user-visible response." },
                ],
            },
        });
        assert!(extract_text_from_stream_json(&v).is_empty());
    }

    #[test]
    fn extract_text_from_stream_json_ignores_result_events() {
        let v = serde_json::json!({
            "type": "result",
            "message": { "content": [{ "type": "text", "text": "final result echo" }] },
        });
        assert!(extract_text_from_stream_json(&v).is_empty());
    }

    // ── AssistantTextRelay — run-on splice fix (this change) ──────────────
    //
    // Regression coverage for the confirmed LazyManager corruption: several
    // "type":"assistant" stream-json lines in one turn (a multi-step CLI
    // agent loop, not token-level streaming — see AssistantTextRelay's doc
    // comment) were relayed with zero boundary between them, so two complete
    // sentences got glued mid-word into one run-on string.

    /// Test-only helper that mirrors the real stdout read loop's per-line
    /// handling exactly: skip blank lines, skip lines that fail to parse as
    /// JSON (silently, like the real loop), otherwise feed the parsed value
    /// through AssistantTextRelay and collect every non-empty chunk it
    /// yields, in order. Lets these tests assert the exact sequence of
    /// model://chunk payloads without spawning a CLI process.
    fn relay_chunks_for_lines(raw_lines: &[&str]) -> Vec<String> {
        let mut relay = AssistantTextRelay::default();
        let mut out = Vec::new();
        for raw in raw_lines {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                continue;
            };
            for chunk in relay.chunks_for_line(&v) {
                if !chunk.is_empty() {
                    out.push(chunk);
                }
            }
        }
        out
    }

    #[test]
    fn single_assistant_message_is_relayed_byte_identical_no_separator_added() {
        // The common case: one complete assistant text message for the
        // whole turn. Must NOT gain a leading/trailing separator — this is
        // the "byte-identical to today's output" requirement.
        let lines = [
            r#"{"type":"system","subtype":"init"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Bonjour, voici la reponse."}]}}"#,
            r#"{"type":"result","is_error":false,"result":"ok"}"#,
        ];
        assert_eq!(
            relay_chunks_for_lines(&lines).concat(),
            "Bonjour, voici la reponse.",
        );
    }

    #[test]
    fn two_assistant_messages_in_one_turn_are_joined_with_a_blank_line() {
        // Narration before a tool call, then the final answer after the
        // tool_result round-trip — both are separate complete "assistant"
        // stream-json lines and both are meant for the user.
        let lines = [
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Let me check the file first."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/a.ts"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"1","content":"file contents"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Done, the file looks correct."}]}}"#,
        ];
        assert_eq!(
            relay_chunks_for_lines(&lines).concat(),
            "Let me check the file first.\n\nDone, the file looks correct.",
        );
    }

    #[test]
    fn assistant_text_interleaved_with_tool_use_and_tool_result_lines_stays_boundaried() {
        // Three text-bearing assistant lines, each separated from the
        // others by non-text lines (tool_use-only assistant lines, a
        // tool_result "user" line, a "system" line). Every boundary between
        // the three real text messages must still get exactly one "\n\n" —
        // the intervening non-text lines must not add extra separators or
        // suppress the ones that are needed.
        let lines = [
            r#"{"type":"system","subtype":"init"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Step one."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"1","content":"a.ts\nb.ts"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Step two."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"pwd"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"2","content":"/repo"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Step three."}]}}"#,
        ];
        assert_eq!(
            relay_chunks_for_lines(&lines).concat(),
            "Step one.\n\nStep two.\n\nStep three.",
        );
    }

    #[test]
    fn a_malformed_json_line_is_skipped_and_does_not_corrupt_surrounding_text() {
        // A truncated/corrupted line (e.g. a partially-flushed pipe write)
        // must be silently skipped — no panic, and it must not consume a
        // "message boundary" slot (no spurious separator on either side).
        let lines = [
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Before."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Truncated mid-obj"#, // malformed: unterminated
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"After."}]}}"#,
        ];
        assert_eq!(
            relay_chunks_for_lines(&lines).concat(),
            "Before.\n\nAfter.",
        );
    }

    #[test]
    fn non_assistant_lines_never_count_as_an_emitted_message_boundary() {
        // A "system"/"result"/tool_result "user" line carries no visible
        // assistant text and must not itself flip emitted_any — otherwise a
        // FIRST real assistant text line arriving after only non-text lines
        // would incorrectly gain a leading separator.
        let lines = [
            r#"{"type":"system","subtype":"init"}"#,
            r#"{"type":"user","message":{"content":[{"type":"text","text":"...produce a user-visible response."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Only real answer."}]}}"#,
        ];
        assert_eq!(
            relay_chunks_for_lines(&lines).concat(),
            "Only real answer.",
        );
    }

    #[test]
    fn reproduces_the_observed_lazymanager_splice_shape() {
        // Reconstructs the reported corruption's shape: a first assistant
        // line whose text is itself a complete, period-terminated sentence,
        // immediately followed (no tool call in between, straight back-to-
        // back assistant lines — the CLI's own multi-step loop can emit
        // these consecutively) by a second assistant line restating/
        // continuing the task description. Before this fix these were
        // concatenated with zero separator, producing exactly the observed
        // "...au demarrage.js(projet actif...)" run-on splice. After the
        // fix they must land as two clearly separated paragraphs.
        let lines = [
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Je lance un agent haiku pour ajouter la fonction sum(a, b) dans index.js avec l'affichage de sum(2,3) au demarrage."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"index.js (projet actif uc-smoke-2026-08-12) et afficher `sum(2,3)` au lancement."}]}}"#,
        ];
        let relayed = relay_chunks_for_lines(&lines).concat();
        assert_eq!(
            relayed,
            "Je lance un agent haiku pour ajouter la fonction sum(a, b) dans index.js avec l'affichage de sum(2,3) au demarrage.\n\nindex.js (projet actif uc-smoke-2026-08-12) et afficher `sum(2,3)` au lancement.",
        );
        // The corrupted, no-separator splice must NOT appear.
        assert!(!relayed.contains("demarrage.js(projet"));
    }

    // ── extract_thinking_from_stream_json — GAP 1 (Claude Code CLI path) ──

    #[test]
    fn extract_thinking_from_stream_json_reads_thinking_block_text() {
        let v = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [
                    { "type": "thinking", "thinking": "Let me check the docs first.", "signature": "sig" },
                ],
            },
        });
        assert_eq!(
            extract_thinking_from_stream_json(&v),
            vec!["Let me check the docs first.".to_string()],
        );
    }

    #[test]
    fn extract_thinking_from_stream_json_ignores_text_only_message() {
        let v = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": "The answer is 42." }] },
        });
        assert!(extract_thinking_from_stream_json(&v).is_empty());
    }

    #[test]
    fn extract_thinking_from_stream_json_picks_thinking_out_of_a_mixed_message() {
        // Real Claude messages interleave a thinking block before the text/
        // tool_use blocks in the same content array.
        let v = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [
                    { "type": "thinking", "thinking": "I should read the file." },
                    { "type": "tool_use", "name": "Read", "input": { "file_path": "/a.ts" } },
                    { "type": "text", "text": "Done reading." },
                ],
            },
        });
        assert_eq!(
            extract_thinking_from_stream_json(&v),
            vec!["I should read the file.".to_string()],
        );
    }

    #[test]
    fn extract_thinking_from_stream_json_handles_missing_message_field() {
        let v = serde_json::json!({ "type": "result", "is_error": false });
        assert!(extract_thinking_from_stream_json(&v).is_empty());
    }

    #[test]
    fn extract_thinking_from_stream_json_skips_empty_thinking_text() {
        let v = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{ "type": "thinking", "thinking": "" }] },
        });
        assert!(extract_thinking_from_stream_json(&v).is_empty());
    }

    #[test]
    fn extract_thinking_from_stream_json_ignores_non_assistant_messages() {
        // Same guard, same reason as extract_text_from_stream_json's
        // equivalent test above — a non-assistant event's message.content
        // must never be surfaced as the model's own reasoning.
        let v = serde_json::json!({
            "type": "user",
            "message": { "content": [{ "type": "thinking", "thinking": "not really the model's thinking" }] },
        });
        assert!(extract_thinking_from_stream_json(&v).is_empty());
    }

    // ── mark_reasoning_lines — \x1b[reasoning] marker formatting ──────────
    // Must match streamEvents.ts's REASONING_MARKER (/\x1b?\[reasoning\]/)
    // and brainSearchLoop.ts's OUT_OF_BAND_MARKER byte-for-byte.

    #[test]
    fn mark_reasoning_lines_prefixes_a_single_line_and_terminates_it() {
        assert_eq!(
            mark_reasoning_lines("I should check the docs first."),
            "\x1b[reasoning]I should check the docs first.\n",
        );
    }

    #[test]
    fn mark_reasoning_lines_uses_the_exact_marker_byte_sequence() {
        let marked = mark_reasoning_lines("x");
        // Byte-for-byte: ESC, '[', 'r','e','a','s','o','n','i','n','g', ']'
        assert!(marked.starts_with("\u{1b}[reasoning]"));
        assert_eq!(marked.as_bytes()[0], 0x1b);
    }

    #[test]
    fn mark_reasoning_lines_prefixes_every_line_of_a_multiline_block() {
        let marked = mark_reasoning_lines("First thought.\nSecond thought.");
        assert_eq!(
            marked,
            "\x1b[reasoning]First thought.\n\x1b[reasoning]Second thought.\n",
        );
    }

    #[test]
    fn mark_reasoning_lines_preserves_internal_word_spacing() {
        // Regression guard for the exact bug this design avoids: buffering
        // the FULL accumulated text (not per-delta marking) means splitting
        // into lines happens exactly once, so no inter-word space is lost
        // to the TypeScript side's per-line .trim() (extractThinkingLine).
        let accumulated = "I should".to_string() + " check the" + " docs first.";
        assert_eq!(
            mark_reasoning_lines(&accumulated),
            "\x1b[reasoning]I should check the docs first.\n",
        );
    }

    #[test]
    fn mark_reasoning_lines_does_not_add_a_trailing_empty_marked_line() {
        // str::lines() (unlike a naive split('\n')) does not yield a
        // trailing empty segment for text already ending in '\n'.
        let marked = mark_reasoning_lines("one line\n");
        assert_eq!(marked, "\x1b[reasoning]one line\n");
    }

    // ── extract_tool_uses_from_stream_json — GAP 2 (tool_use narration) ───

    #[test]
    fn extract_tool_uses_from_stream_json_reads_name_and_file() {
        let v = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [
                    { "type": "tool_use", "name": "Edit", "input": { "file_path": "/src/foo.ts" } },
                ],
            },
        });
        let uses = extract_tool_uses_from_stream_json(&v);
        assert_eq!(uses, vec![ToolUseInfo { name: "Edit".to_string(), file: Some("/src/foo.ts".to_string()) }]);
    }

    #[test]
    fn extract_tool_uses_from_stream_json_handles_a_tool_with_no_file_path() {
        // e.g. Bash/Grep — input has no file_path field at all.
        let v = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [
                    { "type": "tool_use", "name": "Grep", "input": { "pattern": "TODO" } },
                ],
            },
        });
        let uses = extract_tool_uses_from_stream_json(&v);
        assert_eq!(uses, vec![ToolUseInfo { name: "Grep".to_string(), file: None }]);
    }

    #[test]
    fn extract_tool_uses_from_stream_json_returns_all_blocks_for_parallel_tool_use() {
        let v = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [
                    { "type": "tool_use", "name": "Read", "input": { "file_path": "/a.ts" } },
                    { "type": "tool_use", "name": "Read", "input": { "file_path": "/b.ts" } },
                ],
            },
        });
        let uses = extract_tool_uses_from_stream_json(&v);
        assert_eq!(uses.len(), 2);
        assert_eq!(uses[0].file, Some("/a.ts".to_string()));
        assert_eq!(uses[1].file, Some("/b.ts".to_string()));
    }

    #[test]
    fn extract_tool_uses_from_stream_json_ignores_text_only_message() {
        let v = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": "no tools here" }] },
        });
        assert!(extract_tool_uses_from_stream_json(&v).is_empty());
    }

    #[test]
    fn extract_tool_uses_from_stream_json_ignores_non_assistant_messages() {
        // e.g. the "result" line, or a "user" line echoing a tool_result —
        // must not be misread as a NEW tool_use.
        let v = serde_json::json!({
            "type": "result",
            "message": {
                "content": [
                    { "type": "tool_use", "name": "Write", "input": { "file_path": "/x.ts" } },
                ],
            },
        });
        assert!(extract_tool_uses_from_stream_json(&v).is_empty());
    }

    // ── parse_anthropic_sse — GAP 1 (BYOK Anthropic SSE path) ─────────────

    #[test]
    fn parse_anthropic_sse_reads_thinking_delta_from_the_thinking_field() {
        // Byte-exact wire shape: content_block_delta / delta.type ==
        // "thinking_delta" / text lives in delta.thinking, NOT delta.text.
        let data = r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think..."}}"#;
        match parse_anthropic_sse(data) {
            Some(AnthropicSseEvent::ThinkingDelta(text)) => assert_eq!(text, "Let me think..."),
            other => panic!("expected ThinkingDelta, got a different variant/None: {}", other.is_some()),
        }
    }

    #[test]
    fn parse_anthropic_sse_still_reads_text_delta_from_the_text_field() {
        // Regression guard: thinking_delta support must not disturb the
        // pre-existing text_delta path (a DIFFERENT field name: "text").
        let data = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#;
        match parse_anthropic_sse(data) {
            Some(AnthropicSseEvent::TextDelta(text)) => assert_eq!(text, "Hello"),
            other => panic!("expected TextDelta, got a different variant/None: {}", other.is_some()),
        }
    }

    #[test]
    fn parse_anthropic_sse_ignores_thinking_delta_missing_the_thinking_field() {
        // Malformed/unexpected shape must not panic or misfire as text.
        let data = r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta"}}"#;
        assert!(parse_anthropic_sse(data).is_none());
    }

    #[test]
    fn parse_anthropic_sse_ignores_signature_delta() {
        // signature_delta terminates a thinking block; it carries no
        // display text and must not be forwarded as thinking or text.
        let data = r#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}"#;
        assert!(parse_anthropic_sse(data).is_none());
    }

    #[test]
    fn parse_anthropic_sse_ignores_input_json_delta() {
        let data = r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"a\":"}}"#;
        assert!(parse_anthropic_sse(data).is_none());
    }
}
