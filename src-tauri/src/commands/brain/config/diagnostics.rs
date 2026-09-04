// ── Diagnostics (`stats`) + destructive reset (`wipe`) ──────────────
//
// Both surface a bundled engine command the app never exposed before. Each
// pins the resolved brain path via the `LAZYBRAIN_BRAIN_PATH` env var — the
// SAME mechanism every other sidecar/CLI spawn in this crate uses (see
// `spawn_at` / `ensure_brain_init` / `brain_fetch_graph_merged`). Pinning it
// is not incidental: it short-circuits the engine's own brain-path discovery
// (engine/src/util/config.ts `discoverBrainPath`) BEFORE its
// `~/Documents/Lazy-Brain*` fallback scan, so neither command can silently
// operate on an unrelated personal brain when no path is pinned.

use std::process::Stdio;

use tauri::{Emitter, Manager};

use crate::state::{ProjectRegistry, ProjectState};
use crate::commands::brain::sidecar::{BrainState, brain_path_from_project};

use super::bin_resolve::resolve_lazybrain_bin_static;
use super::brain_config_apply::restart_brain_sidecar;

/// Argv for `lazybrain stats`. Pure so it is unit-testable in isolation
/// (`stats_command_args_is_bare_stats`) — the engine's `stats` subcommand
/// prints its telemetry summary as JSON to stdout BY DEFAULT (there is no
/// `--json` flag — confirmed against engine/src/cli/register-core.ts, which
/// declares only `--window-hours` and `--pretty`), so passing an unknown
/// `--json` here would make Commander exit non-zero. `--window-hours`
/// defaults to 24 in the engine; left implicit.
fn stats_command_args() -> Vec<String> {
    vec!["stats".to_string()]
}

/// Argv for `lazybrain wipe --yes`. Pure/unit-tested
/// (`wipe_command_args_requires_yes`). `--yes` is MANDATORY: the engine
/// (engine/src/commands/wipe.ts) prints a dry-run summary and refuses to
/// delete anything without it (confirmed against register-serve.ts's
/// `-y, --yes` option).
fn wipe_command_args() -> Vec<String> {
    vec!["wipe".to_string(), "--yes".to_string()]
}

/// Parse a LazyBrain CLI's stdout (a single JSON document, possibly
/// pretty-printed and newline-terminated) into a `serde_json::Value`. Pure —
/// unit-tested (`parse_json_stdout_*`) without spawning node. Both `stats`
/// and `wipe --yes` write exactly one JSON object to stdout (logs go to
/// stderr, which callers null/pipe separately), so a `trim` + parse is
/// sufficient and honest: malformed output is an `Err`, never a silent
/// default.
fn parse_json_stdout(stdout: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(stdout.trim())
        .map_err(|e| format!("failed to parse CLI JSON output: {}", e))
}

/// Return the live telemetry stats for the current project's brain: totals by
/// type, L1-L4 routing distribution, p50 latencies, avg injected tokens (see
/// engine/src/commands/stats.ts `runStats`). Thin wrapper around
/// `brain_stats_inner` (mirrors the `brain_fetch_health` split) so the
/// spawn+parse core is testable against an explicit path.
///
/// Fail-soft by contract: any missing-engine / spawn / non-zero-exit / parse
/// failure returns `Err`, and the caller (MemoryPanel's diagnostics card)
/// degrades to a dash rather than crashing the panel. On a FRESH brain with
/// no query telemetry yet, `queries_total` is 0 and the routing-distribution
/// / latency / avg-inject fields are all zero/empty — that is a truthful "no
/// queries recorded", returned as `Ok`, not an error.
/// `async fn` + `spawn_blocking`: this thin wrapper spawns `lazybrain
/// stats` (see `brain_stats_inner`) via a plain sync `Command::output()` —
/// the same main-thread-stall shape 921d664 already fixed for every other
/// `lazybrain`-spawning command (see `project_register`'s doc comment,
/// below in this file, for the full mechanism and why `spawn_blocking`,
/// not the `(async)` attribute).
#[tauri::command]
pub(crate) async fn brain_stats(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let project_state = app.state::<ProjectState>();
        let brain_path = brain_path_from_project(&project_state);
        brain_stats_inner(&brain_path)
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("brain_stats: blocking task join failed: {}", e)),
    }
}

/// Pure-ish core of `brain_stats` — spawns `lazybrain stats` with the brain
/// path pinned (see module note above) and parses the JSON it prints. Takes
/// the already-resolved brain path so it can be exercised directly.
pub(crate) fn brain_stats_inner(brain_path: &str) -> Result<serde_json::Value, String> {
    let lb = resolve_lazybrain_bin_static()?;
    let args = stats_command_args();
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = lb.command(&arg_refs)
        .env("LAZYBRAIN_BRAIN_PATH", brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("brain_stats: spawn failed: {}", e))?;
    if !output.status.success() {
        return Err(format!("brain_stats: `stats` exited with status {}", output.status));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_json_stdout(&stdout)
}

/// Argv for `lazybrain health-detail --category <category>`. Pure/unit-tested
/// (mirrors `stats_command_args`) — `category` is validated on the engine
/// side (health-detail.ts's CLI action rejects anything other than
/// `orphans`/`brokenLinks`/`duplicates`), so this just forwards it verbatim.
fn health_detail_command_args(category: &str) -> Vec<String> {
    vec![
        "health-detail".to_string(),
        "--category".to_string(),
        category.to_string(),
    ]
}

/// TASK 2 (Settings > Memory remediation UI): read-only, on-demand breakdown
/// for one health metric — "here is EXACTLY what is wrong, here is the
/// list", never a mutation. Backs MemoryPanel's "View details" action for
/// orphans / broken links / duplicates. Same `async fn` + `spawn_blocking`
/// shape as `brain_stats` above (this spawns a blocking `Command::output()`
/// and must not stall the Tauri IPC main thread).
#[tauri::command]
pub(crate) async fn brain_health_detail(
    category: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let project_state = app.state::<ProjectState>();
        let brain_path = brain_path_from_project(&project_state);
        brain_health_detail_inner(&brain_path, &category)
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("brain_health_detail: blocking task join failed: {}", e)),
    }
}

/// Pure-ish core of `brain_health_detail` — spawns `lazybrain health-detail`
/// with the brain path pinned (see module note above) and parses the JSON it
/// prints. Read-only: the underlying engine command (health-detail.ts) only
/// calls `listAll()`/`loadBacklinks()`, never writes to the brain.
pub(crate) fn brain_health_detail_inner(
    brain_path: &str,
    category: &str,
) -> Result<serde_json::Value, String> {
    let lb = resolve_lazybrain_bin_static()?;
    let args = health_detail_command_args(category);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = lb.command(&arg_refs)
        .env("LAZYBRAIN_BRAIN_PATH", brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("brain_health_detail: spawn failed: {}", e))?;
    if !output.status.success() {
        return Err(format!("brain_health_detail: `health-detail` exited with status {}", output.status));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_json_stdout(&stdout)
}

/// Delete ALL notes, artifacts and cache of the CURRENT PROJECT brain (the
/// exact path `get_brain_info` / MemoryPanel's BrainPathSection shows), then
/// restart the sidecar on the now-empty brain and emit `brain://updated` so
/// the whole Memory panel refetches and reflects 0 notes.
///
/// This is destructive and irreversible — the safety model:
///  - The brain path is resolved on the RUST side via
///    `brain_path_from_project` (identical resolution to
///    `get_brain_info().path`) and pinned via `LAZYBRAIN_BRAIN_PATH`. The
///    frontend never passes a path, so a confused/compromised renderer cannot
///    aim this at an arbitrary directory, and pinning short-circuits the
///    engine's `~/Documents/Lazy-Brain*` discovery scan (see module note).
///  - The sidecar is STOPPED before the wipe so no `serve` child is holding
///    the SQLite FTS DB / cache open (Windows would otherwise refuse to
///    delete those files), then RESTARTED afterwards — always, even if the
///    wipe itself failed — so the brain never ends up wedged with no sidecar.
///  - The engine adds an independent second guard: it refuses to wipe while a
///    `daemon` is running (engine/src/commands/wipe.ts).
///
/// The UI gates this behind an explicit two-step, type-to-confirm dialog that
/// shows the exact path (MemoryPanel's DangerZoneSection). Returns
/// `{ path, report }` (report = the engine's WipeReport counts) on success.
/// `async fn` + `spawn_blocking`: this command stops the sidecar, spawns
/// `lazybrain wipe --yes` (blocking `Command::output()`), then restarts
/// the sidecar — several seconds of blocking work that, as a plain sync
/// command, ran on Tauri's MAIN thread and stalled the whole IPC surface
/// (same shape 921d664 fixed for `brain_capture`/`project_register`; see
/// `project_register`'s doc comment for the full mechanism and why
/// `spawn_blocking`, not the `(async)` attribute).
#[tauri::command]
pub(crate) async fn brain_wipe(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    match tauri::async_runtime::spawn_blocking(move || brain_wipe_inner(&app)).await {
        Ok(result) => result,
        Err(e) => Err(format!("brain_wipe: blocking task join failed: {}", e)),
    }
}

/// Synchronous body of `brain_wipe` — always runs on the blocking pool (see
/// the command's doc comment above). Derives every managed State from the
/// `AppHandle` (`app.state::<T>()`) because a `tauri::State<'_, T>` borrow
/// cannot move into a `'static` `spawn_blocking` closure.
fn brain_wipe_inner(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let project_state = app.state::<ProjectState>();
    let brain_state = app.state::<BrainState>();
    let registry = app.state::<ProjectRegistry>();

    let brain_path = brain_path_from_project(&project_state);

    // Resolve the engine up front: if it is missing there is nothing to wipe,
    // and we must NOT tear the running sidecar down for a wipe we cannot do.
    let lb = resolve_lazybrain_bin_static()?;

    // Stop the sidecar so `serve` is not holding the FTS DB / cache open
    // during deletion. Scoped lock — dropped before `restart_brain_sidecar`
    // (which re-acquires it) to avoid any double-lock.
    {
        let mut sidecar = brain_state.0.lock()
            .map_err(|e| format!("brain_wipe: brain state lock failed: {}", e))?;
        sidecar.stop();
    }

    let args = wipe_command_args();
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let spawn_result = lb.command(&arg_refs)
        .env("LAZYBRAIN_BRAIN_PATH", &brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();

    let output = match spawn_result {
        Ok(o) => o,
        Err(e) => {
            // Bring the sidecar back even though the wipe never ran.
            let _ = restart_brain_sidecar(&brain_state, &registry, &brain_path);
            return Err(format!("brain_wipe: spawn failed: {}", e));
        }
    };

    // Whatever the outcome, restart the sidecar and tell the UI to refetch.
    let _ = restart_brain_sidecar(&brain_state, &registry, &brain_path);
    let _ = app.emit("brain://updated", ());

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "brain_wipe: `wipe --yes` exited with status {} — {}",
            output.status,
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let report = parse_json_stdout(&stdout).unwrap_or_else(|_| serde_json::json!({}));
    Ok(serde_json::json!({ "path": brain_path, "report": report }))
}

#[cfg(test)]
mod tests {
    // ── brain_stats / brain_wipe argv builders + JSON parse (pure) ──────

    /// `stats` must be spawned with NO extra flags — the engine's `stats`
    /// subcommand prints JSON by default and declares no `--json`, so passing
    /// one would make Commander exit non-zero. Guards against a future
    /// "add --json" regression.
    #[test]
    fn stats_command_args_is_bare_stats() {
        assert_eq!(super::stats_command_args(), vec!["stats"]);
        eprintln!("stats_command_args_is_bare_stats PASSED");
    }

    /// `wipe` MUST carry `--yes` — without it the engine only dry-runs and
    /// refuses to delete. This is the flag that makes brain_wipe actually
    /// reset the brain.
    #[test]
    fn wipe_command_args_requires_yes() {
        let args = super::wipe_command_args();
        assert_eq!(args, vec!["wipe", "--yes"]);
        assert!(args.iter().any(|a| a == "--yes"), "wipe argv must contain --yes");
        eprintln!("wipe_command_args_requires_yes PASSED");
    }

    /// `health-detail` must forward `--category` verbatim, unquoted, as its
    /// own argv entry — the engine's `--requiredOption` parser splits on
    /// whitespace, so `category` and its flag must stay as two separate
    /// Vec entries (never `"--category orphans"` collapsed into one).
    #[test]
    fn health_detail_command_args_forwards_category() {
        assert_eq!(
            super::health_detail_command_args("orphans"),
            vec!["health-detail", "--category", "orphans"],
        );
        assert_eq!(
            super::health_detail_command_args("brokenLinks"),
            vec!["health-detail", "--category", "brokenLinks"],
        );
        assert_eq!(
            super::health_detail_command_args("duplicates"),
            vec!["health-detail", "--category", "duplicates"],
        );
        eprintln!("health_detail_command_args_forwards_category PASSED");
    }

    /// A well-formed (pretty-printed, newline-terminated) JSON object from the
    /// CLI parses into a Value; the `by_type`/routing shape `stats` emits
    /// survives round-trip.
    #[test]
    fn parse_json_stdout_parses_pretty_object() {
        let raw = "{\n  \"queries_total\": 0,\n  \"routing_distribution_pct\": { \"L1\": \"0.0\" }\n}\n";
        let v = super::parse_json_stdout(raw).expect("valid JSON must parse");
        assert_eq!(v.get("queries_total").and_then(|q| q.as_u64()), Some(0));
        assert!(v.get("routing_distribution_pct").is_some());
        eprintln!("parse_json_stdout_parses_pretty_object PASSED");
    }

    /// Non-JSON stdout (e.g. an engine error line that leaked to stdout) is an
    /// honest `Err`, never a silent empty default — the caller decides how to
    /// degrade (dash for stats; `{}` fallback for the wipe report).
    #[test]
    fn parse_json_stdout_rejects_non_json() {
        assert!(super::parse_json_stdout("lazybrain: something broke").is_err());
        assert!(super::parse_json_stdout("").is_err());
        eprintln!("parse_json_stdout_rejects_non_json PASSED");
    }
}
