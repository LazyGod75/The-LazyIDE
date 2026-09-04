//! `agent_run`'s request/event payload types and the stream-json "result"
//! line parsers shared by `run.rs`.

use serde::{Deserialize, Serialize};

/// Request payload for agent_run.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRequest {
    /// Caller-assigned mission id (used in event names).
    pub id: String,
    /// Absolute path of the git worktree where the agent operates.
    pub worktree_path: String,
    /// Which CLI backend: "claude" | "codex"
    pub tool: String,
    /// Model alias (e.g. "haiku").
    pub model: String,
    /// The task description given to the agent.
    pub task: String,
    /// Optional system prompt.
    pub system: Option<String>,
    /// Permission mode: 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions'.
    /// Defaults to 'acceptEdits' — safe, no silent bypass.
    /// Belt-and-braces: `rename_all = "camelCase"` above makes `permissionMode`
    /// the primary expected key, but this alias also accepts the snake_case
    /// name so a caller that regresses to it (this exact mismatch class has
    /// already recurred once — see AUDIT.md's P0 worktreePath issue) still
    /// gets a value here instead of silently deserializing to None.
    #[serde(alias = "permission_mode")]
    pub permission_mode: Option<String>,
    /// Optional agent name (carried for TS-side prompt embedding; not passed to CLI).
    pub agent_name: Option<String>,
    /// Optional list of tools the agent is allowed to use (maps to --allowedTools).
    /// Belt-and-braces alias — see permission_mode's doc comment above.
    #[serde(alias = "allowed_tools")]
    pub allowed_tools: Option<Vec<String>>,
    /// Optional list of tools the agent is denied from using (maps to --disallowedTools).
    /// Belt-and-braces alias — see permission_mode's doc comment above.
    #[serde(alias = "denied_tools")]
    pub denied_tools: Option<Vec<String>>,
    /// P4.1 — Optional claude CLI session ID for resume.
    /// When present and tool=="claude", passes `--resume <session_id>` to the CLI.
    /// Ignored for codex (no native resume support).
    #[serde(alias = "session_id")]
    pub session_id: Option<String>,
    /// Cross-project READ access (claude only): extra project roots this
    /// mission's agent may READ from, beyond its own worktree — each one
    /// becomes a `--add-dir` flag, paired with a generated `--settings`
    /// file denying `Edit`/`Write` under every one of them (see
    /// `extra_roots.rs`). This is the mission's OWN DECLARED value (set by
    /// the caller — e.g. a LazyManager plan step targeting another
    /// project's source — never silently "every open project"); `agent_run`
    /// (run.rs) validates every entry against `ProjectRegistry::all_roots`
    /// BEFORE using any of them, rejecting the whole request if one is not
    /// a currently registered project root. Absent/empty = today's
    /// unchanged worktree-only read/write scope.
    #[serde(alias = "extra_readable_roots")]
    pub extra_readable_roots: Option<Vec<String>>,
}

/// Step event payload emitted on `agent://step/{id}`.
#[derive(Serialize, Clone)]
pub struct AgentStepEvent {
    pub kind: String,     // "tool" | "text" | "result" | "system"
    pub name: Option<String>,   // tool name for kind=="tool"
    pub summary: Option<String>, // short human-readable description
    pub text: Option<String>,    // assistant text for kind=="text"
}

/// Done event payload emitted on `agent://done/{id}`.
#[derive(Serialize, Clone)]
pub struct AgentDoneEvent {
    pub result: String,    // final summary / last assistant text
    pub exit_code: i32,
    pub duration_ms: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub tool_count: u32,
    /// Prompt-cache READ tokens (M12 dogfood fix, undercount honesty): the
    /// claude CLI's `usage` object also reports `cache_read_input_tokens` —
    /// tokens served from Anthropic's prompt cache rather than freshly
    /// processed. These are real tokens the model read (billed at a reduced
    /// cache-read rate, but not free) and were previously silently dropped:
    /// `input_tokens` alone under-reported a mission's real input volume
    /// whenever caching kicked in (observed: "22 input tokens for 22 tool
    /// calls" — a ReAct loop repeatedly resending the same system prompt/
    /// tool definitions across turns is exactly the caching-heavy shape).
    /// `None` when no "result" line ever carried the field at all (older CLI
    /// version/deployment) — kept distinct from `Some(0)` (the field WAS
    /// present and genuinely reported zero cache reads for this run) so the
    /// frontend can label the metric honestly either way instead of
    /// conflating "unsupported" with "zero". Serializes as `null` when
    /// `None` (serde's default Option behavior) — runtime.ts reads it as
    /// `number | undefined`.
    pub cache_read_input_tokens: Option<u64>,
    /// P4.2 — claude CLI session ID extracted from the result event.
    /// Present when the CLI reports it (claude --output-format stream-json
    /// includes `session_id` in the result line). `None` for codex or older
    /// claude versions that don't report it.
    pub session_id: Option<String>,
}

/// Extract (input_tokens, output_tokens, cost_usd, cache_read_input_tokens)
/// from a stream-json "result" line.
///
/// The claude CLI `result` event may carry:
///   `usage: { input_tokens, output_tokens, cache_read_input_tokens,
///              cache_creation_input_tokens }`
///   `total_cost_usd` or `cost_usd`
/// All fields are optional. input_tokens/output_tokens/cost_usd default to 0
/// when absent (unchanged, existing contract); cache_read_input_tokens
/// returns `None` (not 0) when the field itself is absent, so callers can
/// distinguish "this CLI doesn't report cache reads" from "it reported
/// zero" — see AgentDoneEvent.cache_read_input_tokens's doc comment.
pub fn parse_result_usage(v: &serde_json::Value) -> (u64, u64, f64, Option<u64>) {
    let input_tokens = v
        .get("usage")
        .and_then(|u| u.get("input_tokens"))
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    let output_tokens = v
        .get("usage")
        .and_then(|u| u.get("output_tokens"))
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    let cost_usd = v
        .get("total_cost_usd")
        .or_else(|| v.get("cost_usd"))
        .and_then(|c| c.as_f64())
        .unwrap_or(0.0);
    let cache_read_input_tokens = v
        .get("usage")
        .and_then(|u| u.get("cache_read_input_tokens"))
        .and_then(|n| n.as_u64());
    (input_tokens, output_tokens, cost_usd, cache_read_input_tokens)
}

/// P4.2 — Extract `session_id` from a stream-json "result" line.
///
/// The claude CLI includes a `session_id` field in its result event when
/// `--output-format stream-json` is used. Returns `None` when absent (codex,
/// older claude versions, or non-result lines).
pub fn parse_result_session_id(v: &serde_json::Value) -> Option<String> {
    v.get("session_id")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
}

/// Extract `is_error` from a stream-json "result" line.
///
/// The claude/codex CLIs can report `is_error: true` (refusal, max-turns
/// reached, internal error, etc.) while the OS process itself still exits
/// with code 0 — exit code alone is not a reliable success signal. This
/// mirrors the same check already used on the interactive chat path (see
/// claude_chat_stream_inner / the codex chat-stream loop); `agent_run`
/// previously skipped it, silently reporting failed runs as successful.
pub fn parse_result_is_error(v: &serde_json::Value) -> bool {
    v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    /// Verify parse_result_usage extracts token counts and cost from a result event.
    #[test]
    fn parse_result_usage_extracts_metrics() {
        use super::parse_result_usage;

        // Full payload: usage + total_cost_usd
        let v = serde_json::json!({
            "type": "result",
            "result": "Task done.",
            "usage": {
                "input_tokens": 1234,
                "output_tokens": 567
            },
            "total_cost_usd": 0.0089
        });
        let (it, ot, cu, crit) = parse_result_usage(&v);
        assert_eq!(it, 1234, "input_tokens");
        assert_eq!(ot, 567, "output_tokens");
        assert!((cu - 0.0089).abs() < 1e-9, "cost_usd: {}", cu);
        assert_eq!(crit, None, "cache_read_input_tokens absent from usage -> None, never a fabricated 0");

        // Fallback field: cost_usd instead of total_cost_usd
        let v2 = serde_json::json!({
            "type": "result",
            "usage": { "input_tokens": 100, "output_tokens": 50 },
            "cost_usd": 0.0012
        });
        let (it2, ot2, cu2, crit2) = parse_result_usage(&v2);
        assert_eq!(it2, 100);
        assert_eq!(ot2, 50);
        assert!((cu2 - 0.0012).abs() < 1e-9, "cost_usd fallback: {}", cu2);
        assert_eq!(crit2, None);

        // Missing fields → all zeros (None for cache_read_input_tokens)
        let v3 = serde_json::json!({ "type": "result", "result": "done" });
        let (it3, ot3, cu3, crit3) = parse_result_usage(&v3);
        assert_eq!(it3, 0);
        assert_eq!(ot3, 0);
        assert_eq!(cu3, 0.0);
        assert_eq!(crit3, None);

        eprintln!("parse_result_usage_extracts_metrics PASSED");
    }

    /// M12 dogfood fix (undercount honesty): the claude CLI's usage object
    /// can carry `cache_read_input_tokens` — real tokens the model read from
    /// Anthropic's prompt cache, previously silently dropped (the observed
    /// "22 input tokens for 22 tool calls" undercount — a ReAct loop resends
    /// the same system prompt/tools every turn, exactly the caching-heavy
    /// shape). Must be extracted alongside input_tokens/output_tokens, never
    /// folded into input_tokens itself (the two are reported separately so
    /// the UI can label them honestly).
    #[test]
    fn parse_result_usage_extracts_cache_read_input_tokens() {
        use super::parse_result_usage;

        let v = serde_json::json!({
            "type": "result",
            "usage": {
                "input_tokens": 22,
                "output_tokens": 140,
                "cache_read_input_tokens": 11400,
                "cache_creation_input_tokens": 300
            },
            "total_cost_usd": 0.05
        });
        let (it, ot, _cu, crit) = parse_result_usage(&v);
        assert_eq!(it, 22, "input_tokens must stay the raw (fresh, non-cached) count");
        assert_eq!(ot, 140);
        assert_eq!(crit, Some(11400), "cache_read_input_tokens must be extracted, not dropped");

        // A CLI reporting a genuine zero must be kept distinct from "field absent".
        let v_zero = serde_json::json!({
            "type": "result",
            "usage": { "input_tokens": 5, "output_tokens": 3, "cache_read_input_tokens": 0 }
        });
        let (_, _, _, crit_zero) = parse_result_usage(&v_zero);
        assert_eq!(crit_zero, Some(0), "an explicit zero must be Some(0), never conflated with None/absent");

        eprintln!("parse_result_usage_extracts_cache_read_input_tokens PASSED");
    }

    /// Verify parse_result_is_error treats is_error:true as failure regardless
    /// of OS exit code (the silent-success bug: agent_run previously only
    /// looked at the process exit status).
    #[test]
    fn parse_result_is_error_detects_error_flag() {
        use super::parse_result_is_error;

        let error_result = serde_json::json!({
            "type": "result",
            "subtype": "error_max_turns",
            "is_error": true,
            "result": "Max turns reached without completing the task."
        });
        assert!(parse_result_is_error(&error_result), "is_error:true must be detected");

        let success_result = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "Task done."
        });
        assert!(!parse_result_is_error(&success_result), "is_error:false must not be flagged");

        // Missing field defaults to false (not present on every CLI version).
        let no_field = serde_json::json!({ "type": "result", "result": "done" });
        assert!(!parse_result_is_error(&no_field), "missing is_error must default to false");

        eprintln!("parse_result_is_error_detects_error_flag PASSED");
    }

    /// Primary contract: a camelCase payload (what runtime.ts/evaluator.ts
    /// send after Fix 1) must populate all three permission fields.
    #[test]
    fn agent_run_request_deserializes_camel_case_permission_fields() {
        let raw = serde_json::json!({
            "id": "m-1",
            "worktreePath": "C:\\repo\\worktree",
            "tool": "claude",
            "model": "haiku",
            "task": "do the thing",
            "permissionMode": "plan",
            "allowedTools": ["Read", "Bash"],
            "deniedTools": ["Write"]
        });
        let req: super::AgentRunRequest =
            serde_json::from_value(raw).expect("camelCase payload must deserialize");
        assert_eq!(
            req.permission_mode.as_deref(),
            Some("plan"),
            "camelCase permissionMode must populate permission_mode"
        );
        assert_eq!(
            req.allowed_tools,
            Some(vec!["Read".to_string(), "Bash".to_string()]),
            "camelCase allowedTools must populate allowed_tools"
        );
        assert_eq!(
            req.denied_tools,
            Some(vec!["Write".to_string()]),
            "camelCase deniedTools must populate denied_tools"
        );
        eprintln!("agent_run_request_deserializes_camel_case_permission_fields PASSED");
    }

    /// Belt-and-braces backstop: the #[serde(alias = ...)] on permission_mode/
    /// allowed_tools/denied_tools must also accept the snake_case names.
    #[test]
    fn agent_run_request_deserializes_snake_case_permission_fields_via_alias() {
        let raw = serde_json::json!({
            "id": "m-2",
            "worktreePath": "C:\\repo\\worktree",
            "tool": "claude",
            "model": "haiku",
            "task": "do the thing",
            "permission_mode": "acceptEdits",
            "allowed_tools": ["Edit"],
            "denied_tools": ["Bash"]
        });
        let req: super::AgentRunRequest =
            serde_json::from_value(raw).expect("snake_case alias payload must deserialize");
        assert_eq!(
            req.permission_mode.as_deref(),
            Some("acceptEdits"),
            "snake_case permission_mode alias must populate permission_mode"
        );
        assert_eq!(
            req.allowed_tools,
            Some(vec!["Edit".to_string()]),
            "snake_case allowed_tools alias must populate allowed_tools"
        );
        assert_eq!(
            req.denied_tools,
            Some(vec!["Bash".to_string()]),
            "snake_case denied_tools alias must populate denied_tools"
        );
        eprintln!("agent_run_request_deserializes_snake_case_permission_fields_via_alias PASSED");
    }

    /// Missing/absent permission fields still deserialize cleanly to None —
    /// aliases must not make the fields required.
    #[test]
    fn agent_run_request_permission_fields_default_to_none_when_absent() {
        let raw = serde_json::json!({
            "id": "m-3",
            "worktreePath": "C:\\repo\\worktree",
            "tool": "claude",
            "model": "haiku",
            "task": "do the thing"
        });
        let req: super::AgentRunRequest =
            serde_json::from_value(raw).expect("minimal payload must deserialize");
        assert_eq!(req.permission_mode, None);
        assert_eq!(req.allowed_tools, None);
        assert_eq!(req.denied_tools, None);
        assert_eq!(req.extra_readable_roots, None, "absent extraReadableRoots must deserialize to None, never an empty Vec");
        eprintln!("agent_run_request_permission_fields_default_to_none_when_absent PASSED");
    }

    /// extraReadableRoots (camelCase, the wire shape runtime.ts sends) must
    /// populate extra_readable_roots — the field this whole feature reads.
    #[test]
    fn agent_run_request_deserializes_extra_readable_roots_camel_case() {
        let raw = serde_json::json!({
            "id": "m-4",
            "worktreePath": "C:\\repo\\worktree",
            "tool": "claude",
            "model": "haiku",
            "task": "do the thing",
            "extraReadableRoots": ["C:\\other-project"]
        });
        let req: super::AgentRunRequest =
            serde_json::from_value(raw).expect("camelCase extraReadableRoots payload must deserialize");
        assert_eq!(
            req.extra_readable_roots,
            Some(vec!["C:\\other-project".to_string()]),
            "camelCase extraReadableRoots must populate extra_readable_roots"
        );
        eprintln!("agent_run_request_deserializes_extra_readable_roots_camel_case PASSED");
    }
}
