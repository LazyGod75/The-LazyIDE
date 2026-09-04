// ── Structural recall (`query` CSS selector) + graph hop (`neighbours`) ──
//
// These two surface the engine's deterministic L1 CSS-selector query
// (engine/src/commands/query.ts) and its 1-hop graph spread-activation
// (engine/src/commands/neighbours.ts) to the LLM as real tools — the
// structural recall power the original LazyBrain had but that no model in the
// app could reach (only free-text `brain_fetch_search` was ever exposed).
//
// Both pin the resolved brain path via `LAZYBRAIN_BRAIN_PATH` — the SAME
// mechanism brain_stats/brain_wipe use (see the module note above) — so they
// can never wander into an unrelated personal brain, and both return the
// engine's own `--pretty` human-readable text VERBATIM: that render carries
// the note #ids the model needs to cite a hit and to feed a follow-up
// `neighbours` call, which a `--strip` (text-only) render would drop. stderr
// is captured (not nulled like brain_stats) so an engine-side failure — an
// invalid selector, a brain that was never init'd — becomes an honest `Err`
// carrying the reason, never a silent empty string the model would misread
// as "no matches".

use std::process::Stdio;

use tauri::Manager;

use crate::state::ProjectState;
use crate::commands::brain::sidecar::brain_path_from_project;

use super::bin_resolve::resolve_lazybrain_bin_static;

/// Clamp a caller-supplied result cap into a sane range for one structural
/// query. Pure/unit-tested (`clamp_query_limit_bounds`). Bounds the value so a
/// confused caller can neither ask for 0 — which the engine's `opts.limit ?? 50`
/// treats as a real 0-row cap (empty output), NOT "use the default" — nor
/// dump the entire brain in a single call.
fn clamp_query_limit(limit: u32) -> u32 {
    limit.clamp(1, 200)
}

/// Argv for `lazybrain query '<selector>' --pretty --limit <n>`. Pure so it is
/// unit-testable in isolation (`query_css_command_args_shape`). The selector is
/// forwarded as a SINGLE argv element — `std::process::Command` performs no
/// shell parsing, so an attribute selector like
/// `article[data-cerveau-type="decision"]` (quotes, brackets and all) reaches
/// Commander intact with zero escaping. `--pretty` (not `--strip`) is
/// deliberate: it emits `<noteId>` + stripped text per hit, and the model needs
/// those ids to cite a result and to follow it with `brain_neighbours`.
fn query_css_command_args(selector: &str, limit: u32) -> Vec<String> {
    vec![
        "query".to_string(),
        selector.to_string(),
        "--pretty".to_string(),
        "--limit".to_string(),
        clamp_query_limit(limit).to_string(),
    ]
}

/// Argv for `lazybrain neighbours <id> --pretty`. Pure/unit-tested
/// (`neighbours_command_args_shape`). The engine strips a leading `#` from the
/// id itself (see `runNeighbours`), so the id is forwarded as given. `--pretty`
/// renders `<kind> (<via>) → <to>` edges the model can read and then query.
fn neighbours_command_args(id: &str) -> Vec<String> {
    vec!["neighbours".to_string(), id.to_string(), "--pretty".to_string()]
}

/// Timeout for `run_lazybrain_text`'s cold CLI spawn (`brain_query_css` /
/// `brain_neighbours`). These are L1 structural queries (CSS selector match /
/// 1-hop graph follow) — no embedder involved — measured cold at ~1-4s even
/// on a real 5881-note/300MB brain, so this is generous headroom, not a
/// budget expected to be routinely spent.
const QUERY_CSS_NEIGHBOURS_TIMEOUT_SECS: u64 = 30;

/// Spawn a bundled `lazybrain` subcommand with the brain path pinned and hand
/// its trimmed stdout back as text. Shared by `brain_query_css` /
/// `brain_neighbours` — both give the engine's own `--pretty` output straight
/// to the model. `label` names the caller for error messages; `args[0]` is the
/// subcommand. Non-zero exit → `Err` with the captured stderr reason.
///
/// Bounded via `output_with_timeout` (search.rs) — this used to be a plain
/// unbounded `Command::output()`, the only brain CLI spawn in the codebase
/// with no ceiling at all (every other spawn in search.rs already enforces
/// one; see that module's "NEVER DEGRADE IN SILENCE" / never-hang contract).
fn run_lazybrain_text(brain_path: &str, args: &[String], label: &str) -> Result<String, String> {
    let lb = resolve_lazybrain_bin_static()?;
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut cmd = lb.command(&arg_refs);
    cmd.env("LAZYBRAIN_BRAIN_PATH", brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = crate::commands::brain::search::output_with_timeout(&mut cmd, QUERY_CSS_NEIGHBOURS_TIMEOUT_SECS)
        .map_err(|e| format!("{}: {}", label, e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "{}: `{}` exited with status {} — {}",
            label,
            args.first().map(String::as_str).unwrap_or("?"),
            output.status,
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Run a deterministic CSS-selector query (engine L1, <5ms) over the CURRENT
/// project's brain and return the engine's pretty text (note #ids + stripped
/// text per hit). The structural counterpart to the semantic
/// `brain_fetch_search`: it answers precise, deterministic questions vector
/// search cannot — "every decision still active"
/// (`article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])`),
/// "every warning" (`aside[role="doc-warning"]`), "notes touching src/auth"
/// (`data[value*="src/auth"]`), "contradictions"
/// (`[data-cerveau-saliency-kind="contradiction"]`).
///
/// Thin wrapper around `brain_query_css_inner` (mirrors the brain_stats split)
/// so the spawn core is testable against an explicit path. A valid-but-zero-
/// match selector is `Ok("0 matches")` (the engine's pretty empty render), NOT
/// an error — only a syntactically invalid selector or a missing brain errors.
/// `async fn` + `spawn_blocking`: spawns `lazybrain query` (see
/// `run_lazybrain_text`) via a plain sync `Command::output()` — same
/// main-thread-stall shape as `brain_stats` above; see
/// `project_register`'s doc comment for the full mechanism.
#[tauri::command]
pub(crate) async fn brain_query_css(
    selector: String,
    limit: Option<u32>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let project_state = app.state::<ProjectState>();
        let brain_path = brain_path_from_project(&project_state);
        brain_query_css_inner(&brain_path, &selector, limit.unwrap_or(50))
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("brain_query_css: blocking task join failed: {}", e)),
    }
}

/// Pure-ish core of `brain_query_css` — validates the selector, builds the
/// argv, spawns with the brain path pinned. Takes the resolved brain path so
/// the empty-selector guard is unit-testable without spawning node.
pub(crate) fn brain_query_css_inner(
    brain_path: &str,
    selector: &str,
    limit: u32,
) -> Result<String, String> {
    let trimmed = selector.trim();
    if trimmed.is_empty() {
        return Err("brain_query_css: selector must not be empty".to_string());
    }
    let args = query_css_command_args(trimmed, limit);
    run_lazybrain_text(brain_path, &args, "brain_query_css")
}

/// Return the 1-hop graph neighbours of a note id (supersession chains,
/// triples, shared entities/clusters — see engine/src/commands/neighbours.ts)
/// as the engine's pretty text. The model uses this to FOLLOW a structural
/// hit's graph ("what replaced this?", "what else touches auth?"). An unknown
/// id is `Ok` with the engine's noop line, not an error. Thin wrapper around
/// `brain_neighbours_inner`.
/// `async fn` + `spawn_blocking`: spawns `lazybrain neighbours` (see
/// `run_lazybrain_text`) via a plain sync `Command::output()` — same
/// main-thread-stall shape as `brain_stats` above; see
/// `project_register`'s doc comment for the full mechanism.
#[tauri::command]
pub(crate) async fn brain_neighbours(
    id: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let project_state = app.state::<ProjectState>();
        let brain_path = brain_path_from_project(&project_state);
        brain_neighbours_inner(&brain_path, &id)
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("brain_neighbours: blocking task join failed: {}", e)),
    }
}

/// Pure-ish core of `brain_neighbours` — validates the id, builds the argv,
/// spawns with the brain path pinned. Takes the resolved brain path so the
/// empty-id guard is unit-testable without spawning node.
pub(crate) fn brain_neighbours_inner(brain_path: &str, id: &str) -> Result<String, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("brain_neighbours: id must not be empty".to_string());
    }
    let args = neighbours_command_args(trimmed);
    run_lazybrain_text(brain_path, &args, "brain_neighbours")
}

#[cfg(test)]
mod tests {
    // ── brain_query_css / brain_neighbours argv builders + guards (pure) ──

    /// The CSS query argv carries the selector VERBATIM as one element (no
    /// shell escaping — Command passes argv directly), plus `--pretty` (so the
    /// model gets note #ids to cite and to follow) and a clamped `--limit`.
    #[test]
    fn query_css_command_args_shape() {
        let args = super::query_css_command_args(r#"article[data-cerveau-type="decision"]"#, 50);
        assert_eq!(
            args,
            vec![
                "query",
                r#"article[data-cerveau-type="decision"]"#,
                "--pretty",
                "--limit",
                "50",
            ]
        );
        eprintln!("query_css_command_args_shape PASSED");
    }

    /// Limit is clamped into [1, 200]: 0 (which the engine's `?? 50` would
    /// treat as a real 0-row cap, not "default") and absurd values are bounded
    /// so the tool can neither misfire empty nor dump the whole brain. The
    /// clamped value is what actually lands in the argv.
    #[test]
    fn clamp_query_limit_bounds() {
        assert_eq!(super::clamp_query_limit(0), 1);
        assert_eq!(super::clamp_query_limit(50), 50);
        assert_eq!(super::clamp_query_limit(10_000), 200);
        let args = super::query_css_command_args(r#"aside[role="doc-warning"]"#, 0);
        assert_eq!(args.last().map(String::as_str), Some("1"));
        eprintln!("clamp_query_limit_bounds PASSED");
    }

    /// neighbours argv is `neighbours <id> --pretty` — id forwarded as-is (the
    /// engine strips a leading '#' itself), pretty so edges render as
    /// `<kind> (<via>) -> <to>` for the model to read and follow.
    #[test]
    fn neighbours_command_args_shape() {
        let args = super::neighbours_command_args("decision-oauth-pkce-2026-06-01");
        assert_eq!(
            args,
            vec!["neighbours", "decision-oauth-pkce-2026-06-01", "--pretty"]
        );
        eprintln!("neighbours_command_args_shape PASSED");
    }

    /// Empty/whitespace input is rejected BEFORE any spawn (the guard runs
    /// before `resolve_lazybrain_bin_static`), so these assert an `Err` without
    /// needing node or a real brain on disk.
    #[test]
    fn structural_inners_reject_empty_input() {
        assert!(super::brain_query_css_inner("/no/such/brain", "   ", 50).is_err());
        assert!(super::brain_neighbours_inner("/no/such/brain", "  ").is_err());
        eprintln!("structural_inners_reject_empty_input PASSED");
    }
}
