//! Interactive mission execution: `agent_run` spawns the chosen CLI agent
//! (claude or codex) in a worktree and streams structured events to the
//! frontend; `agent_run_kill` tree-kills a running mission by id.

use std::process::Stdio;

use tauri::{Emitter, Manager};

use crate::permission_flag;
use crate::state::{ProjectRegistry, ProjectState};
use crate::commands::util::{
    ensure_repo_in_any_open_project, interrupt_then_force_kill, normalize_for_git, quiet_command, resolve_cli_program,
    spawn_stderr_tail, tree_kill_args, truncate_on_char_boundary, STDERR_TAIL_CAP_BYTES,
};
use crate::commands::brain::sidecar::{BrainState, brain_path_from_project, brain_port_and_token};

use super::brain_mcp::build_brain_mcp_config;
use super::extra_roots::{build_extra_roots_cli_args, build_extra_roots_settings_config, validate_extra_readable_roots};
use super::lifecycle::{
    format_mission_panic_payload, track_agent_pid, untrack_agent_pid, AgentPidState,
    MAX_CONCURRENT_MISSIONS, MISSION_GATE, MISSION_HARD_DEADLINE_SECS,
};
use super::protocol::{
    parse_result_is_error, parse_result_session_id, parse_result_usage, AgentDoneEvent,
    AgentRunRequest, AgentStepEvent,
};

/// Spawn the chosen CLI agent autonomously in `worktree_path`, stream structured
/// events, and emit:
///   `agent://step/{id}` — AgentStepEvent (one per assistant turn / tool use)
///   `agent://done/{id}` — AgentDoneEvent
///   `agent://error/{id}` — String error message
///
/// For claude: `claude -p "<task>" --model <model> --output-format stream-json
///              --verbose --permission-mode=acceptEdits`
///   (default is acceptEdits; use permission_mode="full" to opt-in to bypass)
///
/// Brain-everywhere (claude only): in addition to the ONE-TIME brain context
/// injected into the task prompt by runtime.ts before this command is invoked,
/// `agent_run` also wires a LIVE `brain_search` MCP tool scoped to this
/// project's brain (see build_brain_mcp_config) so the model can query memory
/// AGAIN at any point mid-mission, not just from the initial snapshot. This is
/// additive and fails open — when unavailable, the mission behaves exactly as
/// it did before this existed.
///
/// The `agent_run_pid` state allows killing the process via agent_run_kill.
#[tauri::command]
pub(crate) async fn agent_run(
    app: tauri::AppHandle,
    req: AgentRunRequest,
    agent_pids: tauri::State<'_, AgentPidState>,
    project_state: tauri::State<'_, ProjectState>,
    project_registry: tauri::State<'_, ProjectRegistry>,
) -> Result<(), String> {
    // Security: validate worktree_path is inside ANY currently open project
    // root (not just the active one) — a mission running in a background
    // (registered, not active) project must not be rejected.
    ensure_repo_in_any_open_project(&req.worktree_path, &project_registry)?;

    // Cross-project READ access: validate every caller-declared extra
    // readable root against the SAME registry, BEFORE the mission thread is
    // even spawned — a caller must not be able to widen a mission's reach
    // to arbitrary disk just by naming a path. Any entry that is not inside
    // a currently open project fails the WHOLE call with the real reason
    // (see extra_roots.rs's doc comment); an empty/absent request is an
    // empty Ok, i.e. today's unchanged worktree-only scope.
    let extra_readable_roots = {
        let open_roots = project_registry.0.lock()
            .map_err(|e| format!("agent_run: project registry lock failed: {}", e))?
            .all_roots();
        validate_extra_readable_roots(
            req.extra_readable_roots.as_deref().unwrap_or(&[]),
            &open_roots,
        )?
    };

    let step_event  = format!("agent://step/{}", req.id);
    let done_event  = format!("agent://done/{}", req.id);
    let error_event = format!("agent://error/{}", req.id);

    // Build the command depending on the tool.
    let tool = req.tool.clone();
    let model = req.model.clone();
    let task = req.task.clone();
    let worktree_path = normalize_for_git(&req.worktree_path);
    let system = req.system.clone();
    let req_permission_mode = req.permission_mode.clone();
    let req_allowed_tools = req.allowed_tools.clone();
    let req_denied_tools = req.denied_tools.clone();
    let req_session_id = req.session_id.clone();

    // Brain-everywhere: resolve the mission's project brain path up front —
    // project_state is only valid on this async task, not inside the spawned
    // blocking closure below — so the closure can wire a scoped brain_search
    // MCP tool for the "claude" tool branch. The brain sidecar's port is
    // resolved the same way: it may not be BRAIN_PORT if that default was
    // already taken (see BrainSidecar::start's fallback), so the wired MCP
    // tool always reaches the sidecar wherever it actually ended up listening.
    let brain_path = brain_path_from_project(&project_state);
    let (brain_port, brain_token) = brain_port_and_token(&app.state::<BrainState>());

    // Concurrency cap: reject-fast rather than queue. Acquired here (not
    // inside the mission thread below) so a caller at the limit gets this
    // Err back from the `invoke()` call itself — synchronous with the
    // command's own Result, no race against the frontend attaching its
    // agent://error/{id} listener after the fact. The permit is moved into
    // the mission thread and held for the mission's entire lifetime,
    // releasing the slot only when that thread exits (see MISSION_GATE's
    // doc comment). missionQueue.ts on the frontend is expected to surface
    // this distinct message rather than silently retry-loop.
    let mission_permit = match MISSION_GATE.try_acquire() {
        Some(p) => p,
        None => {
            return Err(format!(
                "agent_run: mission limit reached ({} concurrent missions active)",
                MAX_CONCURRENT_MISSIONS
            ));
        }
    };

    let id_clone = req.id.clone();
    let app_clone = app.clone();
    let pids_clone = agent_pids.0.clone();

    std::thread::spawn(move || {
        // Panic safety net: an unexpected panic anywhere in the mission
        // body below must still let Mission Control know the mission
        // ended — otherwise the frontend waits forever for a done/error
        // event that will never come (mirrors why install_panic_hook in
        // lib.rs exists for the sibling logging problem). These clones are
        // taken BEFORE the mission closure below moves its own copies:
        // that closure owns everything it captures (`move`), so if it
        // panics and unwinds, its captured `app_clone`/`done_event`/
        // `error_event` are dropped along with everything else — the
        // catch_unwind Err branch below needs independent handles to
        // still be able to emit.
        let panic_app = app_clone.clone();
        let panic_done_event = done_event.clone();
        let panic_error_event = error_event.clone();
        let panic_mission_id = id_clone.clone();
        let panic_pids = pids_clone.clone();

        let mission_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        // Held for the whole mission — releases the MISSION_GATE slot when
        // this thread (and therefore the mission) ends, on every exit path
        // (drop runs regardless of which `return`/break exits this closure,
        // including an unexpected panic: catch_unwind above still unwinds
        // this frame normally, it only stops the unwind at its own
        // boundary instead of letting it propagate past the thread, so
        // this Drop still runs).
        let _mission_permit = mission_permit;

        use std::io::BufReader;
        use std::io::BufRead;

        // Holds the prompt to write to stdin (avoids CVE-2024-24576: Rust 1.77+
        // refuses to spawn .cmd/.bat with newline-containing argv on Windows).
        // Both the "claude" and "codex" match arms below unconditionally set
        // this (the "other" arm returns early instead), so it is declared
        // without an initial value — the compiler proves it is always
        // assigned by the time it's read after the match.
        let stdin_prompt: Option<String>;

        // Brain-everywhere: path of the generated --mcp-config temp file (if
        // wired for this mission), removed after the child process exits —
        // see the cleanup right after child.wait() below.
        let mut brain_mcp_cleanup: Option<std::path::PathBuf> = None;

        // Cross-project READ access: path of the generated --settings temp
        // file (if wired for this mission), removed after the child process
        // exits alongside brain_mcp_cleanup below — see extra_roots.rs.
        let mut extra_roots_cleanup: Option<std::path::PathBuf> = None;

        let mut cmd = match tool.as_str() {
            "claude" => {
                // Build prompt: optional system prefix + task
                let prompt = if let Some(ref sys) = system {
                    if sys.is_empty() {
                        task.clone()
                    } else {
                        format!("[System]\n{}\n\n[User]\n{}", sys, task)
                    }
                } else {
                    task.clone()
                };

                // Deliver via stdin; bare -p tells claude to read prompt from stdin.
                stdin_prompt = Some(prompt);

                let mut c = quiet_command(resolve_cli_program("claude"));
                c.args([
                    "-p",
                    "--model", &model,
                    "--output-format", "stream-json",
                    "--verbose",
                ]);
                // Map permission_mode to the appropriate CLI flag.
                // Default: 'acceptEdits' — safe for isolated git worktrees; no silent bypass.
                // Use permission_flag() so the mapping is unit-testable.
                match permission_flag(req_permission_mode.as_deref()) {
                    "--dangerously-skip-permissions" => { c.arg("--dangerously-skip-permissions"); }
                    "--permission-mode=plan"         => { c.args(["--permission-mode", "plan"]); }
                    "--permission-mode=acceptEdits"  => { c.args(["--permission-mode", "acceptEdits"]); }
                    _                               => { /* no extra flag */ }
                }
                // Brain-everywhere: wire a scoped brain_search MCP tool for this
                // mission when the LazyBrain CLI + a brain for this project are
                // both available. Fails open — any missing piece (script, node,
                // brain) just skips MCP wiring entirely; the mission still runs
                // exactly as it did before this feature existed. See
                // build_brain_mcp_config / brain-search-server.mjs for the full
                // fallback chain (warm HTTP sidecar -> cold CLI subprocess ->
                // explanatory "unavailable" tool result).
                let brain_mcp = build_brain_mcp_config(&id_clone, &brain_path, brain_port, &brain_token);
                if let Some(ref cfg_path) = brain_mcp {
                    c.arg("--mcp-config").arg(cfg_path);
                    c.arg("--strict-mcp-config");
                }
                let brain_mcp_wired = brain_mcp.is_some();
                brain_mcp_cleanup = brain_mcp;

                // Pass allowed/denied tools when provided. mcp__brain__brain_search
                // is always appended when brain MCP wiring succeeded, so the model
                // can reach it. This does NOT narrow any other tool access already
                // granted by the permission mode: empirically verified that
                // --allowedTools is additive under acceptEdits (Bash/Write/Edit
                // remain available even when not named in the list), not an
                // exclusive filter.
                let mut allowed_tools = req_allowed_tools.unwrap_or_default();
                if brain_mcp_wired {
                    allowed_tools.push("mcp__brain__brain_search".to_string());
                }
                if !allowed_tools.is_empty() {
                    c.args(["--allowedTools", &allowed_tools.join(" ")]);
                }
                if let Some(ref tools) = req_denied_tools {
                    if !tools.is_empty() {
                        c.args(["--disallowedTools", &tools.join(" ")]);
                    }
                }
                // P4.1 — Resume from a previous claude session when session_id is provided
                if let Some(ref sid) = req_session_id {
                    if !sid.is_empty() {
                        c.args(["--resume", sid]);
                    }
                }

                // Cross-project READ access (validated against the project
                // registry before this thread was even spawned — see
                // extra_readable_roots above): --add-dir per extra root
                // grants READ without prompts; --settings pairs it with a
                // generated deny-Edit/Write rule under each root so the read
                // grant can never become a write grant, even under
                // --permission-mode acceptEdits. Claude-only (--add-dir has
                // no codex equivalent wired here). Fails CLOSED: if the
                // settings file can't be written, no --add-dir is added
                // either — a read grant is never wired without its paired
                // write-deny. See extra_roots.rs's doc comment for the exact
                // CLI semantics this relies on and its one known limitation
                // (deny rules bind Edit/Write and Claude-recognised Bash
                // commands, not an arbitrary subprocess the agent spawns).
                if !extra_readable_roots.is_empty() {
                    match build_extra_roots_settings_config(&id_clone, &extra_readable_roots) {
                        Some(cfg_path) => {
                            for arg in build_extra_roots_cli_args(&extra_readable_roots, &cfg_path) {
                                c.arg(arg);
                            }
                            extra_roots_cleanup = Some(cfg_path);
                        }
                        None => {
                            log::warn!(
                                "agent_run: mission {} requested {} extra readable root(s) but the settings file could not be written — skipping cross-project read access entirely (fail-closed)",
                                id_clone, extra_readable_roots.len()
                            );
                        }
                    }
                }

                c.current_dir(&worktree_path);
                c
            }
            "codex" => {
                // Deliver via stdin (avoids CVE-2024-24576: Rust 1.77+ refuses
                // to spawn .cmd/.bat with newline-containing argv on Windows,
                // and resolve_cli_program prefers .cmd on Windows). Mirrors
                // the "claude" branch above and codex_chat_stream_inner
                // (chat.rs) — `codex exec` reads the prompt from stdin when
                // no positional prompt argument is given.
                stdin_prompt = Some(task.clone());

                let mut c = quiet_command(resolve_cli_program("codex"));
                c.args(["exec", "--json", "--skip-git-repo-check"]);
                if !model.is_empty() {
                    c.args(["--model", &model]);
                }
                c.current_dir(&worktree_path);
                c
            }
            other => {
                let msg = format!("agent_run: unknown tool '{}'", other);
                let _ = app_clone.emit(&error_event, &msg);
                return;
            }
        };

        cmd.stdin(Stdio::piped())
           .stdout(Stdio::piped())
           .stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("agent_run: spawn '{}' failed: {}", tool, e);
                let _ = app_clone.emit(&error_event, &msg);
                return;
            }
        };

        // Store PID for kill support
        track_agent_pid(&pids_clone, &id_clone, child.id());

        // Feed the prompt via stdin (mirrors claude_chat_stream_inner).
        // Write in a dedicated thread to prevent deadlock when stdout fills
        // up before stdin is fully drained by the child process.
        if let Some(prompt_bytes) = stdin_prompt {
            if let Some(mut stdin) = child.stdin.take() {
                std::thread::spawn(move || {
                    use std::io::Write;
                    let _ = stdin.write_all(prompt_bytes.as_bytes());
                    let _ = stdin.flush();
                    // dropping stdin closes the pipe, signaling EOF to the CLI
                });
            }
        }

        // Drain stderr concurrently to prevent pipe buffer deadlock. Tail-
        // capped (see spawn_stderr_tail's doc comment) — a runaway child
        // (e.g. the Bun-based claude CLI hitting a JavaScriptCore
        // MemoryExhaustion assertion) no longer grows this thread's buffer
        // without bound.
        let stderr_handle = child.stderr.take().map(|se| spawn_stderr_tail(se, STDERR_TAIL_CAP_BYTES));

        let started = std::time::Instant::now();

        // Track assistant text for the final summary
        let mut last_text = String::new();
        let mut tool_count: u32 = 0;
        let mut input_tokens: u64 = 0;
        let mut output_tokens: u64 = 0;
        let mut cost_usd: f64 = 0.0;
        let mut cache_read_input_tokens: Option<u64> = None;
        let mut result_session_id: Option<String> = None;
        // is_error fix: claude/codex can report is_error:true in the "result"
        // line while the process still exits 0 (refusal, max-turns, etc.).
        // Tracked separately from exit_status so the success check below does
        // not rely on the OS exit code alone. Sticky (never reset to false)
        // in case a stream ever carries more than one "result" line.
        let mut result_is_error = false;

        // Dedicated reader thread streams stdout lines over an mpsc channel
        // so the mission loop below can poll with a bounded 1s timeout
        // instead of blocking indefinitely inside `reader.lines()`. That is
        // what lets the loop notice both the hard deadline and a child
        // killed out-of-band by agent_run_kill (which has no separate
        // in-process flag to check — the taskkill it runs on the tracked
        // PID is the only signal; child.try_wait() below is how that kill
        // becomes observable here) even when the child — or a grandchild
        // that inherited its stdout handle — never closes the pipe.
        //
        // This reader thread is intentionally never joined on the deadline/
        // kill exit paths below: it is now a dedicated OS thread rather than
        // a pooled tokio blocking-pool slot (the whole point of this
        // change), so an occasional abandoned reader thread here no longer
        // exhausts a shared, session-lifetime-capped resource the way it
        // used to.
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
                // line_tx drops here, closing the channel — the mission
                // loop's recv_timeout wakes with Disconnected, its normal-
                // completion signal (mirrors the old `for` loop's own EOF
                // exit, one nesting level up from here).
            });
        }

        // Processes one decoded stdout line. Body unchanged from before this
        // restructure (same event protocol/ordering to the frontend) except
        // the empty-line skip below reads `return` instead of `continue`,
        // now that this is a closure invoked once per line rather than a
        // loop body. NOTE: deliberately keeps the original (deeper) body
        // indentation from when it lived inside `if let Some(stdout) { for
        // .. {` — reindenting a ~150-line stream-json match by hand right
        // before a deadline-sensitive change was judged a worse risk than
        // the cosmetic inconsistency; a follow-up `cargo fmt` pass can fix
        // this safely.
        let mut process_line = |line: String| {
                let trimmed = line.trim();
                if trimmed.is_empty() { return; }

                // Parse stream-json line
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    let ev_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

                    match ev_type {
                        // Tool use start — emit a step.
                        // NOTE: tool_count is NOT incremented here because the same tool use
                        // also appears inside the "assistant" content block (canonical source).
                        // Incrementing in both places would double-count every tool call.
                        "tool_use" => {
                            let name = v.get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            let input_summary = v.get("input")
                                .map(|i| {
                                    // Show first 80 bytes of input JSON as summary
                                    // (char-boundary-safe — this is streamed CLI
                                    // output that can legitimately contain
                                    // accented/CJK text, e.g. a French file path).
                                    let s = i.to_string();
                                    if s.len() > 80 { format!("{}…", truncate_on_char_boundary(&s, 80)) } else { s }
                                })
                                .unwrap_or_default();
                            let step = AgentStepEvent {
                                kind: "tool".to_string(),
                                name: Some(name.clone()),
                                summary: Some(format!("{} {}", name, input_summary)),
                                text: None,
                            };
                            let _ = app_clone.emit(&step_event, step);
                        }

                        // Assistant message — emit text chunks
                        "assistant" => {
                            if let Some(msg) = v.get("message") {
                                if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
                                    for block in content {
                                        let btype = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                        match btype {
                                            "text" => {
                                                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                                    if !text.is_empty() {
                                                        last_text = text.to_string();
                                                        let step = AgentStepEvent {
                                                            kind: "text".to_string(),
                                                            name: None,
                                                            summary: Some(
                                                                if text.len() > 120 {
                                                                    // char-boundary-safe: assistant text is
                                                                    // free-form model output — routinely
                                                                    // accented/CJK, e.g. a French response.
                                                                    format!("{}…", truncate_on_char_boundary(text, 120))
                                                                } else {
                                                                    text.to_string()
                                                                }
                                                            ),
                                                            text: Some(text.to_string()),
                                                        };
                                                        let _ = app_clone.emit(&step_event, step);
                                                    }
                                                }
                                            }
                                            "tool_use" => {
                                                // Tool use appears inline in content blocks too
                                                tool_count += 1;
                                                let name = block.get("name")
                                                    .and_then(|n| n.as_str())
                                                    .unwrap_or("tool")
                                                    .to_string();
                                                let input_summary = block.get("input")
                                                    .map(|i| {
                                                        // char-boundary-safe — see the top-level
                                                        // "tool_use" branch above for why.
                                                        let s = i.to_string();
                                                        if s.len() > 80 { format!("{}…", truncate_on_char_boundary(&s, 80)) } else { s }
                                                    })
                                                    .unwrap_or_default();
                                                let step = AgentStepEvent {
                                                    kind: "tool".to_string(),
                                                    name: Some(name.clone()),
                                                    summary: Some(format!("{} {}", name, input_summary)),
                                                    text: None,
                                                };
                                                let _ = app_clone.emit(&step_event, step);
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                            }
                        }

                        // Result line (final)
                        "result" => {
                            let result_text = v.get("result")
                                .and_then(|r| r.as_str())
                                .unwrap_or("")
                                .to_string();
                            if !result_text.is_empty() {
                                last_text = result_text.clone();
                            }
                            // is_error fix: a refused/failed/max-turns run can still
                            // exit 0 — is_error is the authoritative success signal.
                            if parse_result_is_error(&v) {
                                result_is_error = true;
                            }
                            let (it, ot, cu, crit) = parse_result_usage(&v);
                            if it > 0 { input_tokens = it; }
                            if ot > 0 { output_tokens = ot; }
                            if cu > 0.0 { cost_usd = cu; }
                            if crit.is_some() { cache_read_input_tokens = crit; }
                            if let Some(sid) = parse_result_session_id(&v) {
                                result_session_id = Some(sid);
                            }
                            let step = AgentStepEvent {
                                kind: "result".to_string(),
                                name: None,
                                summary: Some(
                                    if last_text.len() > 120 {
                                        // char-boundary-safe — final result text is
                                        // free-form model output, same as above.
                                        format!("{}…", truncate_on_char_boundary(&last_text, 120))
                                    } else {
                                        last_text.clone()
                                    }
                                ),
                                text: Some(last_text.clone()),
                            };
                            let _ = app_clone.emit(&step_event, step);
                        }

                        // System / init messages
                        "system" => {
                            let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
                            if subtype == "init" {
                                let step = AgentStepEvent {
                                    kind: "system".to_string(),
                                    name: Some("init".to_string()),
                                    summary: Some("Agent initialized".to_string()),
                                    text: None,
                                };
                                let _ = app_clone.emit(&step_event, step);
                            }
                        }

                        _ => {
                            // Other event types (tool_result, etc.) — skip
                        }
                    }
                }
                // Non-JSON lines silently ignored (progress indicators, etc.)
        };

        let deadline = started + std::time::Duration::from_secs(MISSION_HARD_DEADLINE_SECS);
        let mut timed_out = false;

        loop {
            match line_rx.recv_timeout(std::time::Duration::from_secs(1)) {
                Ok(line) => process_line(line),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if let Ok(Some(_status)) = child.try_wait() {
                        // Child already exited (naturally, or killed via
                        // agent_run_kill — see the reader-thread comment
                        // above for why try_wait() is how that becomes
                        // visible here). Give the reader thread one short
                        // bounded window to hand off any line it already had
                        // buffered (e.g. the final "result" line landing
                        // right as the process exits) before moving on —
                        // never blocks past this window even if a grandchild
                        // still holds the pipe open.
                        while let Ok(line) = line_rx.recv_timeout(std::time::Duration::from_millis(200)) {
                            process_line(line);
                        }
                        break;
                    }
                    if std::time::Instant::now() >= deadline {
                        timed_out = true;
                        log::warn!(
                            "agent_run: mission {} exceeded the {}s hard deadline — tree-killing pid {}",
                            id_clone, MISSION_HARD_DEADLINE_SECS, child.id()
                        );
                        #[cfg(target_os = "windows")]
                        {
                            let _ = quiet_command("taskkill").args(tree_kill_args(child.id())).output();
                        }
                        #[cfg(not(target_os = "windows"))]
                        {
                            unsafe { libc::kill(child.id() as i32, libc::SIGKILL); }
                        }
                        // Bounded drain — a killed process's grandchildren
                        // may still hold the pipe open, so this never waits
                        // past a short fixed window either.
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

        // Wait for process (already exited on every loop-exit path above —
        // this reaps it and retrieves its real exit code without blocking).
        let exit_status = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);

        // Brain-everywhere: remove the generated --mcp-config temp file now
        // that claude has exited and can no longer read it (removing it any
        // earlier would race the CLI's own startup read of the file).
        if let Some(ref cfg_path) = brain_mcp_cleanup {
            let _ = std::fs::remove_file(cfg_path);
        }

        // Cross-project READ access: remove the generated --settings temp
        // file now that claude has exited and can no longer read it — same
        // race rationale as brain_mcp_cleanup above (removing it any
        // earlier risks the CLI reading a half-written or missing file at
        // its own startup).
        if let Some(ref cfg_path) = extra_roots_cleanup {
            let _ = std::fs::remove_file(cfg_path);
        }

        // Collect stderr output from the drain thread
        let stderr_text = stderr_handle.and_then(|h| h.join().ok()).unwrap_or_default();

        // Remove PID from map
        untrack_agent_pid(&pids_clone, &id_clone);

        let summary = if last_text.is_empty() {
            format!("Agent completed (tool calls: {})", tool_count)
        } else if last_text.len() > 200 {
            // char-boundary-safe — see the "result" branch above for why.
            format!("{}…", truncate_on_char_boundary(&last_text, 200))
        } else {
            last_text.clone()
        };

        // is_error fix: success requires BOTH a zero exit code AND no
        // is_error:true in the result line — do not decide success from the
        // OS exit code alone (see parse_result_is_error).
        if exit_status == 0 && !result_is_error {
            let done = AgentDoneEvent {
                result: summary,
                exit_code: 0,
                duration_ms: started.elapsed().as_millis() as u64,
                input_tokens,
                output_tokens,
                cost_usd,
                tool_count,
                cache_read_input_tokens,
                session_id: result_session_id,
            };
            let _ = app_clone.emit(&done_event, done);
        } else {
            // Always emit the done event with accumulated metrics so the frontend
            // can display duration/cost/tokens even for failed runs (#28).
            let done = AgentDoneEvent {
                result: summary.clone(),
                exit_code: exit_status,
                duration_ms: started.elapsed().as_millis() as u64,
                input_tokens,
                output_tokens,
                cost_usd,
                tool_count,
                cache_read_input_tokens,
                session_id: result_session_id,
            };
            let _ = app_clone.emit(&done_event, done);

            let msg = if timed_out {
                format!(
                    "agent_run: mission '{}' exceeded the {}h hard deadline and was terminated",
                    tool, MISSION_HARD_DEADLINE_SECS / 3600
                )
            } else if result_is_error {
                format!("agent_run: {} reported is_error in its result — {}", tool, summary)
            } else if !stderr_text.trim().is_empty() {
                format!("agent_run error: {}", stderr_text.trim())
            } else {
                format!("agent_run: '{}' exited with code {}", tool, exit_status)
            };
            let _ = app_clone.emit(&error_event, &msg);
        }
        }));

        if let Err(panic_payload) = mission_result {
            let message = format_mission_panic_payload(&*panic_payload);
            log::error!(
                "agent_run: mission '{}' thread panicked: {}",
                panic_mission_id, message
            );

            // The normal completion path above (inside the catch_unwind
            // closure) already calls untrack_agent_pid on every non-
            // panicking exit; a panic skips past that call via unwinding,
            // so this is the only place it runs for this outcome — the two
            // paths are mutually exclusive, never both.
            untrack_agent_pid(&panic_pids, &panic_mission_id);

            let done = AgentDoneEvent {
                result: format!("Mission thread panicked: {}", message),
                exit_code: -1,
                duration_ms: 0,
                input_tokens: 0,
                output_tokens: 0,
                cost_usd: 0.0,
                tool_count: 0,
                cache_read_input_tokens: None,
                session_id: None,
            };
            let _ = panic_app.emit(&panic_done_event, done);
            let _ = panic_app.emit(
                &panic_error_event,
                &format!("agent_run: mission '{}' thread panicked: {}", panic_mission_id, message),
            );
        }
    });

    Ok(())
}

/// Kill a running agent_run process by mission id.
/// First shot is a graceful interrupt (SIGINT / taskkill without /F) so the
/// CLI can flush; force tree-kill follows after AGENT_INTERRUPT_DRAIN_MS.
#[tauri::command]
pub(crate) fn agent_run_kill(id: String, agent_pids: tauri::State<AgentPidState>) -> Result<(), String> {
    let pid = {
        let map = agent_pids.0.lock()
            .map_err(|e| format!("agent_run_kill: lock failed: {}", e))?;
        map.get(&id).copied()
    };
    if let Some(pid) = pid {
        interrupt_then_force_kill(pid);
    }
    Ok(())
}

/// Mission ids whose native CLI child is still tracked in AgentPidState
/// (alive as far as the bookkeeping map knows). Boot-time replay recovery
/// uses this so a still-running `claude -p` is reattached instead of marked
/// failed (see replayRecovery.ts / agentsStore applyReplayRecovery).
#[tauri::command]
pub(crate) fn agent_run_live_ids(agent_pids: tauri::State<AgentPidState>) -> Result<Vec<String>, String> {
    let map = agent_pids.0.lock()
        .map_err(|e| format!("agent_run_live_ids: lock failed: {}", e))?;
    Ok(map.keys().cloned().collect())
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    // ── Multi-root allowlist (agent_run's worktree_path gate) ────────────
    //
    // agent_run now gates req.worktree_path via
    // util::ensure_repo_in_any_open_project, which reads every open root
    // from the ProjectRegistry rather than the single legacy ProjectState
    // root. This proves the scenario the multi-root registry exists for: a
    // mission whose worktree lives under a repo registered as a BACKGROUND
    // project (registered, not the active one) must be accepted, while a
    // worktree under a repo that was never registered at all must still be
    // denied.

    #[test]
    fn agent_run_worktree_gate_accepts_background_registered_repo_and_rejects_foreign_one() {
        let active_dir = TempDir::new().expect("TempDir (active)");
        let background_dir = TempDir::new().expect("TempDir (background)");
        let foreign_dir = TempDir::new().expect("TempDir (foreign, never registered)");

        let active_root = active_dir.path().canonicalize().unwrap().to_string_lossy().to_string();
        let background_root = background_dir.path().canonicalize().unwrap().to_string_lossy().to_string();
        // Mission worktree lives under the background repo's own
        // .lazy/worktrees dir — the exact shape agent_create_worktree_inner
        // (git.rs) produces.
        let background_worktree = background_dir.path().join(".lazy").join("worktrees").join("agent-m1");
        std::fs::create_dir_all(&background_worktree).expect("create_dir_all worktree");
        let background_worktree_str = background_worktree.canonicalize().unwrap().to_string_lossy().to_string();
        let foreign_root = foreign_dir.path().canonicalize().unwrap().to_string_lossy().to_string();

        let mut registry = crate::state::RegistryInner::default();
        registry.register(crate::state::ProjectEntry {
            id: "active".to_string(),
            root: active_root,
            brain_id: None,
        });
        registry.register(crate::state::ProjectEntry {
            id: "background".to_string(),
            root: background_root,
            brain_id: None,
        });
        registry.set_active("active").expect("set_active");

        let roots = registry.all_roots();

        assert!(
            crate::commands::util::ensure_repo_in_project_roots(&background_worktree_str, &roots).is_ok(),
            "a worktree under a registered-but-not-active (background) project must be accepted"
        );
        assert!(
            crate::commands::util::ensure_repo_in_project_roots(&foreign_root, &roots).is_err(),
            "a repo that was never registered must still be rejected"
        );
        eprintln!("agent_run_worktree_gate_accepts_background_registered_repo_and_rejects_foreign_one PASSED");
    }

    // ── Cross-project READ access (extra_readable_roots gate) ────────────
    //
    // End-to-end version of extra_roots.rs's own unit tests, but exercised
    // through a real ProjectRegistry (mirrors the worktree gate test above):
    // a mission whose worktree lives in project A must be able to declare
    // project B's root as an extra readable root ONLY when B is itself a
    // currently registered project — never an arbitrary foreign directory —
    // and the accepted root must produce the exact --add-dir/--settings
    // argv agent_run's "claude" branch appends to the Command.

    #[test]
    fn agent_run_extra_readable_roots_gate_accepts_a_second_registered_project_and_rejects_a_foreign_one() {
        use super::super::extra_roots::{build_extra_roots_cli_args, build_extra_roots_settings_config, validate_extra_readable_roots};

        let mission_root_dir = TempDir::new().expect("TempDir (mission's own project)");
        let other_project_dir = TempDir::new().expect("TempDir (second registered project)");
        let foreign_dir = TempDir::new().expect("TempDir (foreign, never registered)");

        let mission_root = mission_root_dir.path().canonicalize().unwrap().to_string_lossy().to_string();
        let other_root = other_project_dir.path().canonicalize().unwrap().to_string_lossy().to_string();
        let foreign_root = foreign_dir.path().canonicalize().unwrap().to_string_lossy().to_string();

        let mut registry = crate::state::RegistryInner::default();
        registry.register(crate::state::ProjectEntry { id: "mission-project".to_string(), root: mission_root, brain_id: None });
        registry.register(crate::state::ProjectEntry { id: "other-project".to_string(), root: other_root.clone(), brain_id: None });
        registry.set_active("mission-project").expect("set_active");
        let open_roots = registry.all_roots();

        // Accepted: the second registered project's root.
        let validated = validate_extra_readable_roots(&[other_root.clone()], &open_roots)
            .expect("a currently registered project root must be accepted as an extra readable root");
        // `validate_extra_readable_roots` returns the *cleaned* (separator-normalized,
        // verbatim-`\\?\`-stripped) form of each accepted root — see extra_roots.rs's
        // doc comment ("Returns the cleaned ... roots on success"). On Windows
        // `Path::canonicalize()` ALWAYS hands back a verbatim-prefixed path, so
        // `other_root` carries `\\?\` while `validated` deliberately does not — same
        // directory, different string. Compare against the exact normalization the
        // validator applies (mirrors ensure_repo_in_project_root's strip-before-key
        // idiom) so the assertion is canonical-form agnostic instead of comparing a
        // cleaned root to a raw verbatim one.
        let expected_root = crate::commands::util::strip_verbatim_prefix(
            &crate::commands::util::normalize_separators(&other_root),
        );
        assert_eq!(
            validated,
            vec![expected_root],
            "the validated root must be the requested root in its cleaned (verbatim-stripped) form"
        );

        let cfg_path = build_extra_roots_settings_config("m-extra-1", &validated)
            .expect("a non-empty validated list must produce a settings file");
        let raw = std::fs::read_to_string(&cfg_path).expect("read generated settings file");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("generated settings must be valid JSON");
        let deny = parsed["permissions"]["deny"].as_array().expect("permissions.deny must be an array");
        assert_eq!(deny.len(), 2, "one root -> exactly one Edit + one Write deny entry");
        assert!(deny.iter().any(|v| v.as_str().unwrap_or("").starts_with("Edit(//")), "must deny Edit under the extra root");
        assert!(deny.iter().any(|v| v.as_str().unwrap_or("").starts_with("Write(//")), "must deny Write under the extra root");

        let argv = build_extra_roots_cli_args(&validated, &cfg_path);
        assert_eq!(argv[0], "--add-dir", "the first flag for a granted extra root must be --add-dir");
        assert_eq!(argv[1], validated[0], "--add-dir's value must be the validated root itself");
        assert_eq!(argv[2], "--settings", "the deny-rules file must be wired via --settings");
        assert_eq!(argv[3], cfg_path.to_string_lossy(), "--settings's value must be the generated deny-rules file path");
        let _ = std::fs::remove_file(&cfg_path);

        // Rejected: a directory that is not any currently registered project root.
        let rejected = validate_extra_readable_roots(&[foreign_root], &open_roots);
        assert!(rejected.is_err(), "a foreign, unregistered directory must never be usable as an extra readable root");

        eprintln!("agent_run_extra_readable_roots_gate_accepts_a_second_registered_project_and_rejects_a_foreign_one PASSED");
    }
}
