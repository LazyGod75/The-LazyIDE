//! Scoped brain search/recall used to build mission startup context, and the
//! warm-sidecar-first / cold-CLI-fallback strategy shared by both.

use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Global mutex serializing cold CLI fallback spawns (`run_recall_for_brain`).
/// Each cold spawn loads the ONNX embedder from scratch (~24s, hundreds of MB
/// of RAM). Without serialization, the "all" scope fan-out or concurrent
/// assistant turns can spawn N cold processes simultaneously, freezing the
/// machine. This mutex ensures at most ONE cold subprocess runs at a time.
static COLD_FALLBACK_LOCK: Mutex<()> = Mutex::new(());

/// Instant of the last cold-fallback spawn attempt (`run_recall_for_brain`),
/// or `None` before the first one. Backs the cooldown circuit breaker — see
/// `COLD_FALLBACK_COOLDOWN_SECS`.
static LAST_COLD_SPAWN: Mutex<Option<Instant>> = Mutex::new(None);

/// Cooldown circuit breaker for the cold CLI recall fallback
/// (`run_recall_for_brain`). `COLD_FALLBACK_LOCK` above only serializes
/// CONCURRENT spawns (max 1 at a time) — it does nothing to stop SEQUENTIAL
/// repeats each separately paying the full ~24-30s cold-load cost when the
/// warm sidecar keeps being unreachable/slow across several turns in a row
/// (e.g. it is stuck restarting or the embedder is thrashing on a
/// low-RAM machine). While a cold spawn happened less than
/// `COLD_FALLBACK_COOLDOWN_SECS` ago, further calls skip spawning entirely
/// and return a degraded (empty) result immediately instead. Callers already
/// treat empty recall as "nothing to inject" — see `brain_fetch_recall_scoped`'s
/// `Ok(None)` branches, which render as an empty `text`/`sourceProjects: []`
/// response, and the frontend's existing handling of a recall with no hits —
/// so a skipped cold fallback degrades gracefully instead of piling up
/// redundant heavy Node+ONNX processes.
///
/// Sized well above `RECALL_WARM_TIMEOUT_SECS` (30s, itself sized to clear
/// the documented ~24s worst-case embedder load) so a single legitimately
/// slow cold spawn cannot itself immediately retrigger the breaker; short
/// enough that a genuinely recovered sidecar is not penalized for long.
const COLD_FALLBACK_COOLDOWN_SECS: u64 = 120;

/// True when a cold spawn attempt was recorded within the cooldown window.
/// Read-only — see `record_cold_spawn` for the write side.
fn cold_fallback_on_cooldown() -> bool {
    let last = LAST_COLD_SPAWN.lock().ok().and_then(|g| *g);
    match last {
        Some(t) => t.elapsed() < Duration::from_secs(COLD_FALLBACK_COOLDOWN_SECS),
        None => false,
    }
}

/// Record "a cold spawn is starting now". Called right before the actual
/// subprocess spawn (while still holding `COLD_FALLBACK_LOCK`) so the
/// cooldown window starts at the attempt, not at completion — a hung/slow
/// cold process must not let a second queued caller immediately spawn
/// another one the instant the lock is released.
fn record_cold_spawn() {
    if let Ok(mut guard) = LAST_COLD_SPAWN.lock() {
        *guard = Some(Instant::now());
    }
}

use serde::Deserialize;

use crate::state::ProjectState;
use crate::commands::brain::sidecar::{
    BRAIN_PORT, BrainSidecar, BrainState, LazyBrainBin, brain_path_from_project, http_client,
    http_client_with_timeout,
};
use crate::commands::brain::config::{get_brain_projects, resolve_lazybrain_bin_static, resolve_unified_brain_path};

/// Scope for brain_fetch_search_scoped / brain_fetch_recall_scoped.
///
/// Mirrors the TypeScript `BrainScope` type from src/lib/platform/types.ts:
///   'current' | 'all' | { project: string }
#[derive(Deserialize, Debug)]
#[serde(untagged)]
enum BrainScope {
    Named(String),            // "current" | "all"
    Project { project: String }, // { project: "/path/to/root" }
}

/// Derive the brain path from a project root (same convention as elsewhere in this file).
/// Used only for explicit multi-project fan-out (scope = "all" / "project").
/// Does NOT apply env-var override — each fan-out entry is an explicit project root.
fn brain_path_for_root(root: &str) -> std::path::PathBuf {
    std::path::Path::new(root).join(".lazybrain").join("brain")
}

/// Spawn `cmd`, poll with `try_wait()` until it exits or `secs` seconds have
/// elapsed.  Kills the child and returns `Err` on timeout.
///
/// Replaces unbounded `.output()` calls so the Tauri thread is never stuck
/// indefinitely when the lazybrain process hangs (e.g. during embedding search).
///
/// `pub(crate)`: also reused by config.rs's `run_lazybrain_text` (the
/// `brain_query_css` / `brain_neighbours` cold-CLI spawn), which used to call
/// a plain, unbounded `Command::output()` — the ONLY brain CLI spawn in the
/// codebase with no ceiling at all. Measured cold on a real 5881-note/300MB
/// brain it stays fast (~1-4s, no embedder involved), but "never hang" is a
/// contract every other spawn in this file already honors (see this
/// function's own doc comment) — a future slow brain/disk should degrade to
/// an honest timeout error here too, not a genuinely unbounded wait.
pub(crate) fn output_with_timeout(
    cmd: &mut Command,
    secs: u64,
) -> Result<std::process::Output, String> {
    let mut child = cmd.spawn().map_err(|e| format!("spawn: {}", e))?;
    let deadline = Instant::now() + Duration::from_secs(secs);

    loop {
        let exited = child
            .try_wait()
            .map_err(|e| format!("try_wait: {}", e))?
            .is_some();

        if exited {
            // Process has exited; collect buffered stdout/stderr.
            // try_wait() caches the exit status so wait_with_output() does not
            // call waitpid() again — it just reads the pipes and returns.
            return child
                .wait_with_output()
                .map_err(|e| format!("wait_with_output: {}", e));
        }

        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("brain command timed out after {}s", secs));
        }

        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Run `lazybrain search --strip --top <limit> <query>` and return the stripped
/// text output.  The brain path is passed via the `LAZYBRAIN_BRAIN_PATH` env var
/// only (`--json` and a post-subcommand `--brain` flag are NOT supported by the
/// bundled sidecar).
///
/// Returns `Ok(Some(text))` on success, `Ok(None)` when output is empty,
/// `Err(msg)` on timeout (> 30 s) or non-zero exit.
fn run_search_for_brain(
    lb: &LazyBrainBin,
    brain_path: &str,
    query: &str,
    limit: u32,
) -> Result<Option<String>, String> {
    let limit_str = limit.to_string();
    let mut cmd = lb.command(&["search", "--strip", "--top", &limit_str, query]);
    cmd.env("LAZYBRAIN_BRAIN_PATH", brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let output = output_with_timeout(&mut cmd, 30)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("brain search exited {}: {}", output.status, stderr));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if text.is_empty() { None } else { Some(text) })
}

/// Build the argv for `lazybrain inject-context --mode turn` — the cold CLI
/// fallback `run_recall_for_brain` spawns when the warm sidecar is
/// unreachable (see `recall_from_warm_sidecar_patient`'s retry contract).
/// Pure and unit-tested in isolation (mirrors sidecar.rs's
/// `serve_command_args` pattern) since inspecting the `std::process::Command`
/// `LazyBrainBin::command` builds is awkward — this is the single source of
/// truth `run_recall_for_brain` feeds into it.
///
/// `--max-tokens 1500` and `--nudge tool` are ALWAYS passed:
///   - 1500 matches the warm sidecar `/_api/recall?maxTokens=1500` (see
///     `recall_from_warm_sidecar`) and `BRAIN_RECALL_MAX_TOKENS` on the
///     TypeScript side. Measured 2026-08-28: with turn-mode topK scaled to
///     the budget, 500 tokens packed 20 file-neurons vs 40 at 1500 on a
///     40-note L2 corpus — so a colder CLI at 500 is not equivalent to the
///     sidecar. Wider than `inject-context`'s own 150-token
///     `DEFAULT_TURN_MAX_TOKENS`, which is tuned for the Claude Code hook
///     path instead (see that constant's doc comment, session-inject.ts).
///   - `--nudge tool` tells the model to use the `brain_search` tool / emit
///     `BRAIN_SEARCH: <query>` instead of the engine's default "invoke the
///     lazybrain-recall skill" instruction — this IDE's native/managed
///     providers have neither a Skill tool nor a `lazybrain` CLI available to
///     the model (see `NudgeStyle`, engine/src/commands/inject-context/
///     markers.ts). The default ('skill') stays intact for the Claude Code
///     plugin path, which never passes `--nudge` at all.
///
/// `--cwd`/`--session-id` are appended only when the caller has them — an
/// unknown cwd/session degrades to no active-file boost / no
/// differential-injection dedup for that one call rather than passing a
/// bogus empty flag value.
fn recall_command_args<'a>(
    query: &'a str,
    cwd: Option<&'a str>,
    session_id: Option<&'a str>,
) -> Vec<&'a str> {
    let mut args = vec![
        "inject-context",
        "--mode",
        "turn",
        "--query",
        query,
        "--max-tokens",
        "1500",
        "--nudge",
        "tool",
    ];
    if let Some(c) = cwd {
        args.push("--cwd");
        args.push(c);
    }
    if let Some(s) = session_id {
        args.push("--session-id");
        args.push(s);
    }
    args
}

/// Run `lazybrain inject-context --mode turn --query <query> [--cwd ...]
/// [--session-id ...] --max-tokens 1500 --nudge tool` for recall injection —
/// the cold CLI fallback used only when the warm sidecar
/// (`recall_from_warm_sidecar`) is unreachable.
///
/// Until this fix, this function ran raw `search --strip --top 6` instead,
/// because of a stale belief (recorded in this function's prior doc comment)
/// that `inject-context --mode turn` "returns empty in the bundled sidecar
/// even with a populated brain". Reproducing on a real populated brain with
/// the CURRENT engine — both `engine/dist/bin/lazybrain.js` and the bundled
/// `src-tauri/resources/lazybrain/lazybrain.js` — shows turn mode returns
/// real, non-empty, scored content today. That belief predates the engine
/// internalization commit (`a6a4fb4`, "internalize the LazyBrain engine ...
/// + improve recall"), which widened the retrieval router's short-natural-
/// language-query routing: `router.ts`'s `pickLevel` used to send 3-5 token
/// queries (e.g. "how does auth work" — exactly the shape of a real per-turn
/// question) to keyword-only L2, which can miss a paraphrased match with no
/// literal keyword overlap; such queries now reach hybrid L2+L3 semantic
/// search. The stale-comment workaround here was never revisited after that
/// fix landed, so it kept bypassing a since-fixed, richer recall path.
/// Switching back restores turn mode's PageRank-seeded reranking, per-level
/// score floors, active-file boost, intent-routed selective stripping, the
/// trivial-prompt/MEMORY_TRIGGERS short-circuit, the ~500-token budget, and
/// (when `session_id` is supplied) session dedup — none of which raw
/// `search --strip` had.
///
/// Returns `Ok(Some(text))`, `Ok(None)` if empty, or `Err(msg)` on failure.
fn run_recall_for_brain(
    lb: &LazyBrainBin,
    brain_path: &str,
    query: &str,
    cwd: Option<&str>,
    session_id: Option<&str>,
) -> Result<Option<String>, String> {
    // Cooldown breaker, cheap pre-check outside the lock: skip queuing
    // entirely for the common case where the breaker is already tripped
    // (repeated calls while the warm sidecar stays unreachable). See
    // COLD_FALLBACK_COOLDOWN_SECS's doc comment for why sequential cold
    // spawns — not just concurrent ones — need bounding.
    if cold_fallback_on_cooldown() {
        log::warn!(
            "run_recall_for_brain: cold fallback on cooldown (< {}s since last cold spawn) — \
             skipping spawn, returning degraded empty recall",
            COLD_FALLBACK_COOLDOWN_SECS
        );
        return Ok(None);
    }

    let args = recall_command_args(query, cwd, session_id);
    let mut cmd = lb.command(&args);
    cmd.env("LAZYBRAIN_BRAIN_PATH", brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        // Kept ON (unlike most other one-shot spawns in this file): this
        // cold CLI subprocess is still answering a REAL per-turn recall —
        // the same query that `recall_from_warm_sidecar` would have
        // answered, just via a fresh subprocess because the warm sidecar
        // was unreachable — so it must still count toward Settings >
        // Memory's "Queries (24h)" diagnostic. See process.rs's spawn_at
        // for the fuller rationale.
        .env("LAZYBRAIN_TELEMETRY", "1")
        .env("LAZYBRAIN_EMBEDDINGS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    // Serialize cold fallback spawns: each one loads the ONNX model from
    // scratch (~24s, hundreds of MB RAM). Without this, concurrent calls
    // (e.g. "all" scope fan-out, or multiple assistant turns) spawn N
    // heavy processes simultaneously, freezing the machine.
    let _guard = COLD_FALLBACK_LOCK.lock().map_err(|e| format!("cold fallback lock poisoned: {}", e))?;

    // Re-check now that we hold the lock: a caller that queued behind an
    // in-flight cold spawn must not immediately start its OWN cold spawn the
    // instant the lock is released — that spawn (recorded below) may have
    // tripped the breaker while this call was waiting.
    if cold_fallback_on_cooldown() {
        drop(_guard);
        log::warn!(
            "run_recall_for_brain: cold fallback on cooldown after acquiring lock (< {}s since last cold spawn) — \
             skipping spawn, returning degraded empty recall",
            COLD_FALLBACK_COOLDOWN_SECS
        );
        return Ok(None);
    }
    record_cold_spawn();

    let output = output_with_timeout(&mut cmd, 30)?;

    drop(_guard); // release before returning so the next queued call can proceed

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("brain recall exited {}: {}", output.status, stderr));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if text.is_empty() { None } else { Some(text) })
}

/// Recall text plus the LazyBrain retrieval level that answered the query —
/// the `level` field of a `/_api/recall` response (engine's
/// `runTurnInjectDetailed`, commands/inject-context.ts — raw engine codes
/// "L1".."L4", "L2_L3_HYBRID" — src/retrieval/levels/{l1,l2,l3,hybrid,l4}.ts
/// in the vendored CLI: L1 structural/exact match, L2 FTS/keyword, L3
/// embedding/semantic, L2_L3_HYBRID fused keyword+semantic, L4
/// semantic+cross-encoder rerank). The sibling `/_api/search` route (used by
/// `brain_fetch_search_scoped`, the manual search panel — NOT per-turn
/// recall) reports the same level codes per hit instead of once per
/// response; both ultimately come from the same `route()`/`pickLevel`
/// dispatch, which picks one retrieval strategy per query, not per hit.
///
/// `level` is `None` only when the sidecar response carried no `level`
/// field at all (e.g. zero results, or the feature-map fast path answered
/// instead of `route()` — see `TurnInjectResult.levelUsed`'s doc comment,
/// inject-context.ts) — never guessed. Classifying this raw code into the
/// 3-value semantic/hybrid/keyword the UI shows is done on the TS side (see
/// `classifyRecallLevel` in src/lib/brain/context.ts) — this struct only
/// preserves what the engine actually reported.
#[derive(Debug)]
pub(crate) struct RecallText {
    pub text: String,
    pub level: Option<String>,
}

/// Timeout for the warm-sidecar recall HTTP call — longer than the default
/// `http_client()` 15 s.
///
/// WARMUP-vs-TIMEOUT: the engine now warms its embedder (ONNX bi-encoder)
/// fire-and-forget right after `serve` starts listening (see
/// `commands/serve.ts`'s `embedderWarmupStart` block) — up to ~24 s cold per
/// that file's own comment, paid once per sidecar process. `pickLevel`
/// (retrieval/router.ts) routes any 3-15 token natural-language query
/// (exactly the shape of a per-turn assistant question) to
/// `L2_L3_HYBRID`, which awaits the SAME embedder promise inside the
/// request handler — so a recall issued in that first-warmup window blocks
/// on however much of the ~24 s remains.
///
/// At the previous 15 s, a query issued early in that window could outrun
/// the client-side timeout, making this call return `Err` and fall back to
/// `run_recall_for_brain`'s COLD CLI subprocess — a brand-new `node`
/// process that reloads the ONNX model AGAIN from scratch (redundant with
/// the warm sidecar's own in-flight load) and can itself trip its 30 s
/// ceiling under load, surfacing as a failed/empty recall instead of just
/// waiting a few more seconds for the warm (and already-loading) embedder.
/// 30 s gives that warm load enough headroom over the documented ~24 s
/// worst case to finish and answer directly, while still bounding the
/// request (readiness itself is unaffected — see `BrainSidecar::wait_ready`,
/// whose `q=ping` probe is a 1-token query that `pickLevel` always routes to
/// keyword-only L2, never touching the embedder).
const RECALL_WARM_TIMEOUT_SECS: u64 = 30;

/// Fetch turn-mode recall context from the WARM bundled sidecar's
/// `/_api/recall` route on `port` — the brain sidecar's actual bound port
/// (see `BrainSidecar::start`, which may have fallen back away from
/// `BRAIN_PORT` if that default was already taken).
///
/// `/_api/recall` (server/routes/recall.ts) runs the SAME
/// `runTurnInjectDetailed` pipeline as `lazybrain inject-context --mode turn`
/// — scoring, per-level score floors, active-file boost, intent-routed
/// selective stripping, the ~500-token budget, and (when `session_id` is
/// supplied) session dedup — inside the already-running sidecar process, so
/// it answers in ~10 ms once warm versus the ~30 s cold start of a fresh
/// `lazybrain inject-context` subprocess (which reloads the ML model and can
/// trip the 30 s timeout). This is the fast path for the per-turn assistant
/// recall ("current" scope). See `RECALL_WARM_TIMEOUT_SECS` for why this
/// call uses a longer-than-default HTTP timeout, and `recall_command_args`'s
/// doc comment for why `nudge=tool` is always sent.
///
/// The engine has already formatted/budgeted/gated `text` — this function
/// only extracts it plus the retrieval `level` (see `RecallText`) instead of
/// discarding it, so the caller can thread recall honesty (semantic vs
/// hybrid vs keyword-only) through to the UI.
///
/// Returns `Ok(Some(RecallText))` with the formatted text, `Ok(None)` when
/// there is nothing to inject, or `Err(msg)` when the sidecar is unreachable
/// / returns malformed JSON (the caller may then fall back to the cold
/// subprocess).
fn recall_from_warm_sidecar(
    query: &str,
    cwd: Option<&str>,
    session_id: Option<&str>,
    port: u16,
    token: &str,
) -> Result<Option<RecallText>, String> {
    let mut url = format!(
        "http://127.0.0.1:{}/_api/recall?q={}&maxTokens=1500&nudge=tool",
        port,
        urlencoding::encode(query)
    );
    if let Some(c) = cwd {
        url.push_str(&format!("&cwd={}", urlencoding::encode(c)));
    }
    if let Some(s) = session_id {
        url.push_str(&format!("&sessionId={}", urlencoding::encode(s)));
    }

    let resp = http_client_with_timeout(RECALL_WARM_TIMEOUT_SECS)
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("warm sidecar unreachable: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("warm sidecar returned {}", resp.status()));
    }

    let json: serde_json::Value = resp
        .json()
        .map_err(|e| format!("warm sidecar bad JSON: {}", e))?;

    Ok(parse_recall_api_response(&json))
}

/// How long `recall_from_warm_sidecar_patient` keeps retrying a
/// CONNECTION-level failure (see `is_connection_level_error`) before giving
/// up and letting the caller fall back to the cold CLI subprocess
/// (`run_recall_for_brain`).
///
/// COLD-START RACE FIX: before this existed, ANY warm-sidecar failure —
/// including a connection refused because the auto-index pipeline
/// (index_project.rs) had just killed the old sidecar and the replacement
/// was still spawning — fell straight through to the cold CLI subprocess,
/// which pays its OWN full ONNX model load from scratch (up to the ~24s
/// documented cold case) in a brand new, wholly redundant process, even
/// though the sidecar that was ALREADY loading that exact model was mere
/// seconds from being ready. That redundant cold load — not the warm path's
/// own well-headroomed `RECALL_WARM_TIMEOUT_SECS` ceiling — is what could
/// push a first post-restart recall toward (or past) the frontend's 32s
/// ceiling (see `BRAIN_RECALL_TIMEOUT_MS`, src/lib/models/brainSearchLoop.ts).
/// Retrying the warm path first is strictly cheaper: empirically, a refused
/// connection fails in low-single-digit milliseconds (not seconds), and the
/// restart window it signals is normally ~1-2s end to end — so a short
/// retry loop almost always finds the SAME warm, already-loading sidecar
/// instead of paying for a second independent model load.
///
/// Bounded well under `RECALL_WARM_TIMEOUT_SECS` (30s) — this is a fast
/// recheck loop for a short-lived process handoff, not a substitute for that
/// ceiling; a sidecar that is still unreachable after this budget is
/// treated exactly as before (handed to the cold CLI fallback, which has
/// its own independent bound), so a genuinely broken brain still surfaces a
/// real error instead of hanging forever.
const SIDECAR_RESTART_RETRY_BUDGET_SECS: u64 = 15;

/// Poll interval for `recall_from_warm_sidecar_patient`'s retry loop.
const SIDECAR_RESTART_RETRY_INTERVAL_MS: u64 = 300;

/// True for a `recall_from_warm_sidecar` error that means the TCP connection
/// itself never succeeded (consistent with the sidecar process being
/// between stop/spawn — see `SIDECAR_RESTART_RETRY_BUDGET_SECS`), as
/// opposed to a reachable-but-slow-or-erroring response.
/// `recall_from_warm_sidecar` only ever produces the `"warm sidecar
/// unreachable: {}"` shape from its `.send()` `.map_err` — every other error
/// string (`"warm sidecar returned ..."`, `"warm sidecar bad JSON: ..."`)
/// means the connection succeeded, so retrying would not help and would
/// only delay the (already fair, `RECALL_WARM_TIMEOUT_SECS`-bounded) verdict.
fn is_connection_level_error(e: &str) -> bool {
    e.starts_with("warm sidecar unreachable")
}

/// Patient wrapper around `recall_from_warm_sidecar`: on a connection-level
/// failure, re-reads `(port, token)` from `brain_state` — a restart changes
/// both — and retries for up to `retry_budget` instead of immediately
/// handing the caller off to the cold CLI fallback. See
/// `SIDECAR_RESTART_RETRY_BUDGET_SECS` for the full cold-start race this
/// closes.
///
/// A reachable-but-slow-or-erroring response is returned immediately,
/// unretried — `recall_from_warm_sidecar`'s own `RECALL_WARM_TIMEOUT_SECS`
/// already gave that attempt a full, fair chance, and retrying THAT case
/// would just double the wait for no benefit.
///
/// Takes the raw `Arc<Mutex<BrainSidecar>>` (not `tauri::State<BrainState>`)
/// and an explicit `retry_budget` — both purely for testability, mirroring
/// the pure-core convention used throughout config.rs/index_project.rs: a
/// real `tauri::State` cannot be constructed in a unit test, and a
/// hardcoded budget would force any test of the retry behaviour itself to
/// either wait the full production budget or not exist.
fn recall_from_warm_sidecar_patient(
    query: &str,
    cwd: Option<&str>,
    session_id: Option<&str>,
    brain_state: &Arc<Mutex<BrainSidecar>>,
    retry_budget: Duration,
) -> Result<Option<RecallText>, String> {
    let deadline = Instant::now() + retry_budget;
    loop {
        let (port, token) = brain_state
            .lock()
            .map(|s| (s.port, s.token.clone()))
            .unwrap_or((BRAIN_PORT, String::new()));

        match recall_from_warm_sidecar(query, cwd, session_id, port, &token) {
            Ok(v) => return Ok(v),
            Err(e) if is_connection_level_error(&e) && Instant::now() < deadline => {
                log::debug!(
                    "brain_fetch_recall_scoped: warm sidecar unreachable on port {} ({}) — retrying, likely mid-restart",
                    port, e
                );
                std::thread::sleep(Duration::from_millis(SIDECAR_RESTART_RETRY_INTERVAL_MS));
            }
            Err(e) => return Err(e),
        }
    }
}

/// Pure parse of a `/_api/recall` JSON response body (`{query, text, level,
/// tokens}` — see `handleRecall`, engine/src/server/routes/recall.ts) into
/// recall text + the retrieval level (see `RecallText`). Extracted from
/// `recall_from_warm_sidecar` so this is unit-testable against synthetic
/// JSON, without spinning up a real HTTP server (this crate has no
/// HTTP-mocking dev-dependency).
///
/// Unlike the flat-list `/_api/search` shape this replaces (`{results:
/// [{snippet, level}, ...]}`, formatted into bullets here in Rust), the
/// engine has ALREADY formatted, budgeted, and gated `text` — turn mode's
/// own pipeline (scoring, intent-routed selective stripping, per-level score
/// floors, the recall-nudge header) — so this function only extracts it
/// plus the level; it does not re-derive or reformat anything.
///
/// Returns `None` when `text` is missing, not a string, or blank —
/// collapsing to "nothing to inject", matching this file's pre-existing
/// contract for an unusable response.
fn parse_recall_api_response(json: &serde_json::Value) -> Option<RecallText> {
    let text = json.get("text").and_then(|t| t.as_str())?.trim();
    if text.is_empty() {
        return None;
    }

    let level = json.get("level").and_then(|l| l.as_str()).map(str::to_string);

    Some(RecallText { text: text.to_string(), level })
}

/// Fetch startup context via `lazybrain inject-context --mode highlights`.
///
/// The brain path is resolved via `resolve_unified_brain_path` (LAZYBRAIN_BRAIN_PATH
/// env var takes priority) and passed as the `LAZYBRAIN_BRAIN_PATH` env var to the
/// child process.  A 30-second timeout prevents hanging on first run.
///
/// `--nudge tool` (see `recall_command_args`'s doc comment) — this IDE's
/// native/managed providers have no Skill tool and no `lazybrain` CLI, only
/// the `brain_search` tool / `BRAIN_SEARCH:` directive, so the injected
/// `[BRAIN]`/`[RECALL]` lines must not tell the model to invoke a
/// lazybrain-recall Skill that does not exist in this integration.
///
/// Returns the trimmed stdout, or an empty string on any error (startup context
/// is optional — never block the UI for it).
#[tauri::command]
pub(crate) fn brain_fetch_startup_context(cwd: String) -> Result<String, String> {
    let lb = match resolve_lazybrain_bin_static() {
        Ok(b) => b,
        Err(_) => return Ok(String::new()),
    };

    // Resolve brain path: prefer LAZYBRAIN_BRAIN_PATH env var, then cwd-local.
    let brain_path = resolve_unified_brain_path(Some(&cwd));

    let mut cmd = lb.command(&[
        "inject-context",
        "--mode", "highlights",
        "--cwd", &cwd,
        "--max-tokens", "400",
        "--nudge", "tool",
    ]);
    cmd.env("LAZYBRAIN_BRAIN_PATH", &brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        // Kept ON: this is THE call behind Settings > General's "Automatic
        // memory injection — Injects Brain context at the start of each new
        // conversation" (see fetchManagerStartupContext, agentsStore.tsx,
        // gated on isFirstTurn) — a real per-conversation event, not an
        // admin/maintenance operation. It logs an 'inject' telemetry event
        // (runMarkerInject, inject-context/sections.ts) that Settings >
        // Memory's diagnostics card should reflect. See process.rs's
        // spawn_at for the fuller rationale on why this differs from most
        // other one-shot spawns in this codebase.
        .env("LAZYBRAIN_TELEMETRY", "1")
        .env("LAZYBRAIN_EMBEDDINGS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    match output_with_timeout(&mut cmd, 30) {
        Ok(o) if o.status.success() => {
            Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
        }
        _ => Ok(String::new()),
    }
}

/// Multi-project scoped search.
///
/// Scope:
///   "current" — uses the running LazyBrain HTTP sidecar (/_api/search) which
///               returns structured JSON.  This is the fast path for the UI.
///   "all"     — fans out `lazybrain search --strip` across every configured
///               project brain via the CLI; merges results as synthetic hits.
///   { project } — runs only that project's brain via the CLI.
///
/// Returns a JSON object: { hits: [...], total_ms: u64 }
/// Each hit carries an optional `sourceProject` field.
/// An optional `error` field is included when a brain is missing or the CLI fails.
#[tauri::command]
pub(crate) fn brain_fetch_search_scoped(
    query: String,
    scope: serde_json::Value,
    limit: Option<u32>,
    project_state: tauri::State<ProjectState>,
    brain_state: tauri::State<BrainState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let top = limit.unwrap_or(10);

    // Parse scope
    let parsed_scope: BrainScope = serde_json::from_value(scope)
        .map_err(|e| format!("brain_fetch_search_scoped: invalid scope: {}", e))?;

    let t_start = std::time::Instant::now();

    match parsed_scope {
        BrainScope::Named(ref s) if s == "current" => {
            // "current" scope: proxy the running HTTP sidecar — it already has
            // the brain loaded and returns structured JSON (id/score/snippet/path).
            let brain_path = brain_path_from_project(&project_state);
            if !std::path::Path::new(&brain_path).exists() {
                return Ok(serde_json::json!({
                    "hits": [],
                    "total_ms": 0,
                    "error": format!("Brain introuvable à {} — lance `lazybrain init`", brain_path),
                }));
            }
            let root = project_state.0.lock().map(|g| g.clone()).unwrap_or_default();
            let brain_port = brain_state.0.lock().map(|s| s.port).unwrap_or(BRAIN_PORT);
            let encoded_q = urlencoding::encode(&query);
            let url = format!(
                "http://127.0.0.1:{}/_api/search?q={}&top={}",
                brain_port, encoded_q, top
            );
            let hits = match http_client().get(&url).send() {
                Ok(resp) => match resp.json::<serde_json::Value>() {
                    Ok(json) => {
                        // HTTP API returns { results: [...] }; map to { hits: [...] }
                        json.get("results")
                            .and_then(|r| r.as_array())
                            .map(|arr| {
                                arr.iter().map(|r| {
                                    let mut h = r.clone();
                                    if let Some(map) = h.as_object_mut() {
                                        map.insert(
                                            "sourceProject".to_string(),
                                            serde_json::Value::String(root.clone()),
                                        );
                                    }
                                    h
                                })
                                .collect::<Vec<_>>()
                            })
                            .unwrap_or_default()
                    }
                    Err(_) => Vec::new(),
                },
                Err(e) => {
                    log::warn!("brain_fetch_search_scoped HTTP sidecar: {}", e);
                    Vec::new()
                }
            };
            Ok(serde_json::json!({
                "hits": hits,
                "total_ms": t_start.elapsed().as_millis() as u64,
            }))
        }

        BrainScope::Project { ref project } => {
            // Single named project brain via CLI
            let lb = match resolve_lazybrain_bin_static() {
                Ok(b) => b,
                Err(e) => return Ok(serde_json::json!({
                    "hits": [], "total_ms": 0,
                    "error": format!("LazyBrain not found: {}", e),
                })),
            };
            let brain_path = brain_path_for_root(project);
            if !brain_path.exists() {
                log::warn!("brain_fetch_search_scoped: brain not found at {}", brain_path.display());
                return Ok(serde_json::json!({
                    "hits": [], "total_ms": 0,
                    "error": format!("Brain introuvable à {} — lance `lazybrain init`", brain_path.display()),
                }));
            }
            let brain_path_str = brain_path.to_string_lossy().into_owned();
            let hits = match run_search_for_brain(&lb, &brain_path_str, &query, top) {
                Ok(Some(text)) => vec![serde_json::json!({
                    "id": format!("search-{}", project),
                    "title": project.as_str(),
                    "snippet": text.chars().take(600).collect::<String>(),
                    "score": 1.0,
                    "sourceProject": project,
                })],
                Ok(None) => Vec::new(),
                Err(e) => {
                    log::warn!("brain_fetch_search_scoped project {}: {}", project, e);
                    Vec::new()
                }
            };
            Ok(serde_json::json!({
                "hits": hits,
                "total_ms": t_start.elapsed().as_millis() as u64,
            }))
        }

        BrainScope::Named(_) => {
            // "all" scope: fan out across all configured project brains via CLI
            let lb = match resolve_lazybrain_bin_static() {
                Ok(b) => b,
                Err(e) => return Ok(serde_json::json!({
                    "hits": [], "total_ms": 0,
                    "error": format!("LazyBrain not found: {}", e),
                })),
            };
            let project_roots = get_brain_projects(app).unwrap_or_default();

            let mut all_hits: Vec<serde_json::Value> = Vec::new();

            for root in &project_roots {
                let brain_path = brain_path_for_root(root);
                if !brain_path.exists() {
                    log::warn!("brain_fetch_search_scoped: brain not found at {}, skipping", brain_path.display());
                    continue;
                }
                let brain_path_str = brain_path.to_string_lossy().into_owned();
                match run_search_for_brain(&lb, &brain_path_str, &query, top) {
                    Ok(Some(text)) => {
                        all_hits.push(serde_json::json!({
                            "id": format!("search-{}", root),
                            "title": root.as_str(),
                            "snippet": text.chars().take(600).collect::<String>(),
                            "score": 1.0,
                            "sourceProject": root,
                        }));
                    }
                    Ok(None) => {}
                    Err(e) => {
                        log::warn!("brain_fetch_search_scoped all-scope {}: {}", root, e);
                    }
                }
            }

            // Trim to limit
            all_hits.truncate(top as usize);

            Ok(serde_json::json!({
                "hits": all_hits,
                "total_ms": t_start.elapsed().as_millis() as u64,
            }))
        }
    }
}

/// Multi-project scoped recall via `lazybrain inject-context --mode turn`
/// (turn-mode scoring — see `run_recall_for_brain`/`recall_from_warm_sidecar`'s
/// doc comments).
///
/// Scope:
///   "current" — searches the current project brain (resolved via
///               `resolve_unified_brain_path`; `LAZYBRAIN_BRAIN_PATH` takes priority).
///   "all"     — fans out across all configured project brains; sections are
///               prefixed with a [Project: ...] header.
///   { project } — searches only that project's brain.
///
/// `session_id`: Q3 differential-injection dedup — when supplied, the engine
/// skips notes already shown earlier in this session (see `sessionId` on
/// `InjectContextCliOptions`, engine/src/commands/inject-context.ts). This is
/// plumbed end to end (CLI `--session-id` flag, `/_api/recall?sessionId=`
/// query param) and ready to use, but the frontend
/// (`src/lib/platform/*.ts`'s `recallScoped`, called from
/// `src/lib/models/brainSearchLoop.ts`'s `recallForDirective`) does not yet
/// generate/pass a stable per-conversation id — until it does, this is
/// always `None` here and every call behaves exactly as before `session_id`
/// existed (no dedup, not a regression). Threading a real id through is
/// frontend work, out of scope for this Rust/engine change.
///
/// Core "current"-scope recall logic, extracted from `brain_fetch_recall_scoped`
/// so it is directly unit-testable against a REAL spawned sidecar (see this
/// file's tests module) without needing a live `tauri::App`/`tauri::State`.
///
/// GRAPH/RECALL DIVERGENCE FIX (brain unreachable from manager chat while
/// BrainSpace shows it live, same app instance, same active project): this
/// used to gate on `Path::new(brain_path).exists()` — `brain_path` being the
/// LOCALLY recomputed `resolve_unified_brain_path`/`brain_path_from_project`
/// result — BEFORE ever attempting the warm sidecar. That local path can
/// legitimately diverge from whatever brain the sidecar is ACTUALLY serving
/// (its own boot-time default, or a multi-tenant brainId — see
/// `sidecar::routing::active_brain_query_suffix`), which is exactly the live
/// source of truth `brain_fetch_graph`/BrainSpace already trusts
/// UNCONDITIONALLY, with no local-path gate at all (see that command's doc
/// comment in sidecar/fetch.rs). A project whose brain lives somewhere other
/// than `<project_root>/.lazybrain/brain` — an env override, a UI-persisted
/// global/custom brain, or a different multi-tenant brainId — used to fail
/// this pre-check and surface an actionable-SOUNDING but WRONG "Brain
/// introuvable — lance `lazybrain init`" error, even while the exact same
/// live sidecar was already answering BrainSpace's graph for that very
/// project (a genuinely indexed, thousands-of-neuron brain). The manager
/// would then paraphrase that error as "no brain accessible for this
/// project" and recommend indexing a project that was already indexed — a
/// wrong remedy sending the user down a dead end.
///
/// Fix: try the warm sidecar FIRST — the same live source of truth
/// `brain_fetch_graph` trusts — so recall succeeds whenever the sidecar is
/// demonstrably up and answering, exactly like the graph. Only fall back to
/// the local existence check (and its explanatory error) once the sidecar
/// itself is unreachable at the CONNECTION level and a cold CLI subprocess
/// pinned to `brain_path` is the only remaining option — that fallback
/// genuinely needs a real brain on disk at `brain_path` to do anything, so
/// the check is still meaningful there, just no longer gates the live path.
fn recall_current_scope(
    query: &str,
    brain_path: &str,
    root: &str,
    session_id: Option<&str>,
    brain_state: &Arc<Mutex<BrainSidecar>>,
    lb: &LazyBrainBin,
) -> serde_json::Value {
    // Fast path: query the WARM sidecar over HTTP (~10 ms, model already
    // loaded) via /_api/recall — turn-mode scoring, not raw top-K. The
    // cold `lazybrain inject-context` subprocess reloads the ML model
    // and can take ~30 s, which is what trips the per-turn recall timeout.
    // Fall back to the cold subprocess only when the sidecar is STILL
    // unreachable after `recall_from_warm_sidecar_patient`'s short
    // retry budget — see that function's doc comment for why a bare,
    // unretried connection failure used to send every mid-restart
    // query straight into a redundant cold model load.
    match recall_from_warm_sidecar_patient(
        query,
        Some(root),
        session_id,
        brain_state,
        Duration::from_secs(SIDECAR_RESTART_RETRY_BUDGET_SECS),
    ) {
        Ok(Some(recalled)) => serde_json::json!({
            "text": recalled.text,
            "sourceProjects": [root],
            "level": recalled.level,
        }),
        Ok(None) => serde_json::json!({
            "text": "", "sourceProjects": [],
        }),
        // BIG-BRAIN DOUBLE-WAIT FIX: only a genuine connection-level
        // failure (sidecar unreachable for this call's ENTIRE
        // recall_from_warm_sidecar_patient retry budget — process
        // crashed, wrong port, still between stop/spawn) justifies the
        // cold CLI fallback below. A reachable-but-slow-or-erroring
        // response (e.g. `recall_from_warm_sidecar`'s own
        // RECALL_WARM_TIMEOUT_SECS elapsed on a REAL, large brain —
        // measured empirically at 40s-180s+ for a 5881-note/300MB
        // brain, well past this 30s ceiling, with the embedder itself
        // warm in ~2.4s so embedder load is NOT the cause) means the
        // sidecar is alive and already spent up to
        // RECALL_WARM_TIMEOUT_SECS running the SAME turn-mode
        // pipeline this cold subprocess would run again from scratch.
        // Falling back in that case used to roughly DOUBLE the wait
        // (up to ~60s total) for the identical verdict — the "rare
        // compound worst case" the frontend's BRAIN_RECALL_TIMEOUT_MS
        // doc comment describes is, for a realistically large brain,
        // not rare at all. Surface the real error immediately instead;
        // only retry via the cold path when the warm sidecar was
        // never actually reachable to begin with.
        Err(http_err) if is_connection_level_error(&http_err) => {
            log::warn!(
                "brain_fetch_recall_scoped: warm sidecar still unreachable after retry budget ({}); falling back to cold subprocess",
                http_err
            );
            // The warm path — the live source of truth BrainSpace's graph
            // trusts unconditionally — was never reachable, so a cold CLI
            // subprocess pinned to `brain_path` is the only fallback left,
            // and unlike the warm path it genuinely needs a real brain on
            // disk at that exact path to do anything. This is the ONLY
            // place `brain_path`'s existence is still checked.
            if !std::path::Path::new(brain_path).exists() {
                return serde_json::json!({
                    "text": "", "sourceProjects": [],
                    "error": format!(
                        "Brain introuvable à {} — lance `lazybrain init`",
                        brain_path
                    ),
                });
            }
            // The cold `lazybrain inject-context --mode turn` subprocess
            // DOES report a real level (unlike the old raw-search
            // fallback) — but it only reaches stdout as formatted text,
            // not structured JSON, so there is nothing to parse a
            // `level` out of here either; omitted rather than guessed,
            // matching RecallText's contract.
            match run_recall_for_brain(lb, brain_path, query, Some(root), session_id) {
                Ok(Some(text)) => serde_json::json!({
                    "text": text,
                    "sourceProjects": [root],
                }),
                Ok(None) => serde_json::json!({
                    "text": "", "sourceProjects": [],
                }),
                Err(e) => serde_json::json!({
                    "text": "", "sourceProjects": [],
                    "error": e,
                }),
            }
        }
        Err(http_err) => {
            log::warn!(
                "brain_fetch_recall_scoped: warm sidecar reachable but failed/timed out ({}) — \
                 NOT retrying via cold subprocess (same pipeline, would just double the wait \
                 on a genuinely slow/large brain); surfacing the error directly",
                http_err
            );
            serde_json::json!({
                "text": "", "sourceProjects": [],
                "error": http_err,
            })
        }
    }
}

/// Returns: { text: String, sourceProjects: [String], error?: String }
///   - `text`           stripped context ready for LLM injection.
///   - `sourceProjects` projects that contributed results.
///   - `error`          present when the brain is missing or the CLI fails;
///                      the TS layer throws this so the UI can surface it.
#[tauri::command]
pub(crate) fn brain_fetch_recall_scoped(
    query: String,
    scope: serde_json::Value,
    session_id: Option<String>,
    project_state: tauri::State<ProjectState>,
    brain_state: tauri::State<BrainState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let lb = match resolve_lazybrain_bin_static() {
        Ok(b) => b,
        Err(e) => return Ok(serde_json::json!({
            "text": "", "sourceProjects": [],
            "error": format!("LazyBrain introuvable: {}", e),
        })),
    };

    let parsed_scope: BrainScope = serde_json::from_value(scope)
        .map_err(|e| format!("brain_fetch_recall_scoped: invalid scope: {}", e))?;

    match parsed_scope {
        BrainScope::Named(ref s) if s == "current" => {
            let brain_path = brain_path_from_project(&project_state);
            let root = project_state.0.lock().map(|g| g.clone()).unwrap_or_default();
            Ok(recall_current_scope(&query, &brain_path, &root, session_id.as_deref(), &brain_state.0, &lb))
        }

        BrainScope::Project { ref project } => {
            let brain_path = brain_path_for_root(project);
            if !brain_path.exists() {
                log::warn!("brain_fetch_recall_scoped: brain not found at {}", brain_path.display());
                return Ok(serde_json::json!({
                    "text": "", "sourceProjects": [],
                    "error": format!(
                        "Brain introuvable à {} — lance `lazybrain init`",
                        brain_path.display()
                    ),
                }));
            }
            let brain_path_str = brain_path.to_string_lossy().into_owned();
            match run_recall_for_brain(&lb, &brain_path_str, &query, Some(project.as_str()), session_id.as_deref()) {
                Ok(Some(text)) => Ok(serde_json::json!({
                    "text": text,
                    "sourceProjects": [project],
                })),
                Ok(None) => Ok(serde_json::json!({
                    "text": "", "sourceProjects": [],
                })),
                Err(e) => Ok(serde_json::json!({
                    "text": "", "sourceProjects": [],
                    "error": e,
                })),
            }
        }

        BrainScope::Named(_) => {
            // "all" scope: fan out across all configured project brains
            let project_roots = get_brain_projects(app).unwrap_or_default();

            // Early exit: when the multi-project registry is empty, the
            // fan-out below would iterate zero times and return an empty
            // result — but the user may have a perfectly good "current"
            // project brain. Previously this silently returned nothing,
            // causing the assistant's scope-fallback to waste a second
            // recall. Short-circuit here so the caller sees "no results
            // from 'all'" immediately instead of spawning zero cold CLIs
            // and still paying the round-trip cost.
            if project_roots.is_empty() {
                return Ok(serde_json::json!({
                    "text": "", "sourceProjects": [],
                }));
            }

            let mut sections: Vec<String> = Vec::new();
            let mut contributing_projects: Vec<String> = Vec::new();

            for root in &project_roots {
                let brain_path = brain_path_for_root(root);
                if !brain_path.exists() {
                    log::warn!("brain_fetch_recall_scoped: brain not found at {}, skipping", brain_path.display());
                    continue;
                }
                let brain_path_str = brain_path.to_string_lossy().into_owned();
                match run_recall_for_brain(&lb, &brain_path_str, &query, Some(root.as_str()), session_id.as_deref()) {
                    Ok(Some(text)) => {
                        sections.push(format!("[Project: {}]\n{}", root, text));
                        contributing_projects.push(root.clone());
                    }
                    Ok(None) => {}
                    Err(e) => {
                        log::warn!("brain_fetch_recall_scoped all-scope {}: {}", root, e);
                    }
                }
            }

            let merged_text = sections.join("\n\n---\n\n");
            Ok(serde_json::json!({
                "text": merged_text,
                "sourceProjects": contributing_projects,
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        RECALL_WARM_TIMEOUT_SECS, is_connection_level_error, parse_recall_api_response,
        recall_command_args, recall_current_scope, recall_from_warm_sidecar_patient,
    };

    // ── WARMUP-vs-TIMEOUT (recall HTTP client) ───────────────────────

    /// The engine's own doc comment (commands/serve.ts) states embedder
    /// warmup takes "up to ~24s cold" — the warm-sidecar recall timeout
    /// must clear that with real headroom, and must be strictly longer than
    /// the 15s default `http_client()` uses for everything else (graph/
    /// note-meta/backlinks/neighbors), which this call site intentionally
    /// does NOT share. Locks the exact value so a future edit cannot
    /// silently shrink it back below the documented cold-load worst case.
    #[test]
    fn recall_warm_timeout_clears_documented_embedder_cold_load_with_headroom() {
        const DOCUMENTED_COLD_EMBEDDER_LOAD_SECS: u64 = 24;
        const DEFAULT_HTTP_CLIENT_TIMEOUT_SECS: u64 = 15;

        assert!(
            RECALL_WARM_TIMEOUT_SECS > DOCUMENTED_COLD_EMBEDDER_LOAD_SECS,
            "recall timeout ({}s) must clear the engine's documented ~{}s cold embedder load",
            RECALL_WARM_TIMEOUT_SECS, DOCUMENTED_COLD_EMBEDDER_LOAD_SECS
        );
        assert!(
            RECALL_WARM_TIMEOUT_SECS > DEFAULT_HTTP_CLIENT_TIMEOUT_SECS,
            "recall timeout must be raised above the {}s default http_client() timeout",
            DEFAULT_HTTP_CLIENT_TIMEOUT_SECS
        );
        eprintln!(
            "recall_warm_timeout_clears_documented_embedder_cold_load_with_headroom PASSED (RECALL_WARM_TIMEOUT_SECS={})",
            RECALL_WARM_TIMEOUT_SECS
        );
    }

    // ── recall_command_args (turn-mode argv builder) ────────────────────

    #[test]
    fn recall_command_args_always_includes_mode_turn_budget_and_tool_nudge() {
        let args = recall_command_args("how does auth work", None, None);
        assert_eq!(
            args,
            vec![
                "inject-context", "--mode", "turn", "--query", "how does auth work",
                "--max-tokens", "1500", "--nudge", "tool",
            ],
            "must always request turn mode, a 1500-token budget, and the tool nudge, with no cwd/session-id when absent"
        );
        eprintln!("recall_command_args_always_includes_mode_turn_budget_and_tool_nudge PASSED");
    }

    #[test]
    fn recall_command_args_appends_cwd_and_session_id_when_present() {
        let args = recall_command_args("how does auth work", Some("/my/project"), Some("sess-1"));
        assert_eq!(
            args,
            vec![
                "inject-context", "--mode", "turn", "--query", "how does auth work",
                "--max-tokens", "1500", "--nudge", "tool",
                "--cwd", "/my/project",
                "--session-id", "sess-1",
            ]
        );
        eprintln!("recall_command_args_appends_cwd_and_session_id_when_present PASSED");
    }

    #[test]
    fn recall_command_args_omits_cwd_flag_when_cwd_is_none_but_keeps_session_id() {
        let args = recall_command_args("q", None, Some("sess-1"));
        assert!(!args.contains(&"--cwd"));
        assert!(args.contains(&"--session-id"));
        eprintln!("recall_command_args_omits_cwd_flag_when_cwd_is_none_but_keeps_session_id PASSED");
    }

    // ── parse_recall_api_response (RECALL LEVEL HONESTY, /_api/recall) ──

    #[test]
    fn parse_recall_api_response_extracts_text_and_level() {
        let json = serde_json::json!({
            "query": "how does auth work",
            "text": "[FILE]\nsrc/auth.ts ...",
            "level": "L3",
            "tokens": 42,
        });
        let recalled = parse_recall_api_response(&json).expect("must parse a non-empty response");
        assert_eq!(recalled.level.as_deref(), Some("L3"));
        assert!(recalled.text.contains("src/auth.ts"));
        eprintln!("parse_recall_api_response_extracts_text_and_level PASSED");
    }

    #[test]
    fn parse_recall_api_response_preserves_hybrid_level_code() {
        let json = serde_json::json!({ "text": "hybrid hit", "level": "L2_L3_HYBRID" });
        let recalled = parse_recall_api_response(&json).expect("must parse");
        assert_eq!(recalled.level.as_deref(), Some("L2_L3_HYBRID"));
        eprintln!("parse_recall_api_response_preserves_hybrid_level_code PASSED");
    }

    #[test]
    fn parse_recall_api_response_preserves_keyword_level_code() {
        let json = serde_json::json!({ "text": "keyword hit", "level": "L2" });
        let recalled = parse_recall_api_response(&json).expect("must parse");
        assert_eq!(recalled.level.as_deref(), Some("L2"));
        eprintln!("parse_recall_api_response_preserves_keyword_level_code PASSED");
    }

    /// No `level` field in the response at all (e.g. the feature-map fast
    /// path answered instead of route() — see TurnInjectResult.levelUsed's
    /// doc comment) — must be `None`, never guessed or defaulted.
    #[test]
    fn parse_recall_api_response_level_is_none_when_absent() {
        let json = serde_json::json!({ "text": "no level here" });
        let recalled = parse_recall_api_response(&json).expect("must parse");
        assert_eq!(recalled.level, None);
        eprintln!("parse_recall_api_response_level_is_none_when_absent PASSED");
    }

    #[test]
    fn parse_recall_api_response_none_when_text_field_missing() {
        let json = serde_json::json!({ "query": "x", "level": "L2" });
        assert!(parse_recall_api_response(&json).is_none());
        eprintln!("parse_recall_api_response_none_when_text_field_missing PASSED");
    }

    #[test]
    fn parse_recall_api_response_none_when_text_is_empty_string() {
        let json = serde_json::json!({ "text": "" });
        assert!(parse_recall_api_response(&json).is_none());
        eprintln!("parse_recall_api_response_none_when_text_is_empty_string PASSED");
    }

    /// Whitespace-only text collapses to "nothing to inject", same as a
    /// genuinely empty string — matches runTurnInjectDetailed's own contract
    /// (empty sections join to `''`, never a whitespace-only string).
    #[test]
    fn parse_recall_api_response_none_when_text_is_whitespace_only() {
        let json = serde_json::json!({ "text": "   \n  ", "level": "L3" });
        assert!(parse_recall_api_response(&json).is_none());
        eprintln!("parse_recall_api_response_none_when_text_is_whitespace_only PASSED");
    }

    #[test]
    fn parse_recall_api_response_trims_text() {
        let json = serde_json::json!({ "text": "  padded text  ", "level": "L2" });
        let recalled = parse_recall_api_response(&json).expect("must parse");
        assert_eq!(recalled.text, "padded text");
        eprintln!("parse_recall_api_response_trims_text PASSED");
    }

    // ── is_connection_level_error (COLD-START RACE FIX: retry classifier) ──

    #[test]
    fn is_connection_level_error_true_for_unreachable_shape() {
        assert!(is_connection_level_error(
            "warm sidecar unreachable: error sending request for url (http://127.0.0.1:48620/_api/search?q=x): connection refused"
        ));
        eprintln!("is_connection_level_error_true_for_unreachable_shape PASSED");
    }

    #[test]
    fn is_connection_level_error_false_for_reachable_but_erroring_response() {
        assert!(!is_connection_level_error("warm sidecar returned 500 Internal Server Error"));
        eprintln!("is_connection_level_error_false_for_reachable_but_erroring_response PASSED");
    }

    #[test]
    fn is_connection_level_error_false_for_bad_json() {
        assert!(!is_connection_level_error("warm sidecar bad JSON: expected value at line 1 column 1"));
        eprintln!("is_connection_level_error_false_for_bad_json PASSED");
    }

    // ── recall_from_warm_sidecar_patient (COLD-START RACE FIX) ──────────
    //
    // Both tests below drive the REAL retry loop (real Instant/thread::sleep,
    // no mocked clock) against real TCP sockets — only the retry_budget
    // parameter is shortened from the production SIDECAR_RESTART_RETRY_BUDGET_SECS
    // (15s) so the test suite stays fast; see recall_from_warm_sidecar_patient's
    // doc comment for why the budget is a parameter rather than a hardcoded
    // constant.

    /// The core claim: a connection that is refused because the sidecar
    /// process is between stop/spawn (exactly the window
    /// `index_project::reload_sidecar_after_auto_index` creates) must be
    /// retried until the replacement sidecar answers, NOT handed to the
    /// caller as an immediate error. Proven with a REAL sidecar spawned on a
    /// background thread shortly after the retry loop starts against a port
    /// nothing is listening on yet — mirrors
    /// `start_or_restart_brain_sidecar_releases_lock_before_the_slow_wait`'s
    /// real-process-on-a-background-thread style (sidecar.rs).
    #[test]
    fn recall_from_warm_sidecar_patient_retries_through_connection_refused_until_sidecar_comes_up() {
        use crate::commands::brain::config::resolve_lazybrain_bin_static;
        use crate::commands::brain::sidecar::{BrainState, start_or_restart_brain_sidecar};
        use std::net::TcpListener;
        use std::time::{Duration, Instant};
        use tempfile::TempDir;

        let lb = match resolve_lazybrain_bin_static() {
            Ok(b) => b,
            Err(_) => {
                eprintln!(
                    "SKIP recall_from_warm_sidecar_patient_retries_through_connection_refused_until_sidecar_comes_up — lazybrain.js not found"
                );
                return;
            }
        };

        let brain = TempDir::new().expect("TempDir::new (brain)");
        let brain_path = brain.path().to_str().unwrap().to_string();
        crate::commands::brain::sidecar::BrainSidecar::ensure_brain_init(&lb, &brain_path);

        // A genuinely free port, nothing listening yet — every attempt
        // against it must fail with a connection-level error until the
        // background thread's spawn below brings a real server up (on
        // whichever port it actually binds — start_or_restart_brain_sidecar
        // updates brain_state.port itself, and the retry loop re-reads that
        // on every iteration, so this test does not need port X and the
        // sidecar's real port to match).
        let free_port = TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .expect("OS must hand back an ephemeral port")
            .port();

        let state = BrainState::new();
        state.0.lock().expect("lock").port = free_port;

        let restart_thread = {
            let arc = state.0.clone();
            let lb_clone = lb.clone();
            let brain_path_clone = brain_path.clone();
            std::thread::spawn(move || {
                start_or_restart_brain_sidecar(&arc, &lb_clone, &brain_path_clone, free_port)
            })
        };

        let start = Instant::now();
        let result = recall_from_warm_sidecar_patient(
            "does this brain know anything about authentication",
            None,
            None,
            &state.0,
            Duration::from_secs(15),
        );
        let elapsed = start.elapsed();

        let became_healthy = restart_thread.join().expect("restart thread must not panic");

        assert!(
            result.is_ok(),
            "expected the patient retry to eventually reach the real sidecar instead of erroring, got {:?}",
            result
        );
        assert!(
            elapsed < Duration::from_secs(14),
            "expected the retry loop to succeed well before its 15s budget once the sidecar came up, took {:?}",
            elapsed
        );

        eprintln!(
            "recall_from_warm_sidecar_patient_retries_through_connection_refused_until_sidecar_comes_up PASSED \
             (elapsed={:?}, sidecar_became_healthy={}, result={:?})",
            elapsed, became_healthy, result
        );

        state.0.lock().expect("lock").stop();
    }

    /// The bound half of the same claim: if nothing EVER comes up (a
    /// genuinely broken brain/sidecar), `recall_from_warm_sidecar_patient`
    /// must still return an `Err` within its budget rather than hanging
    /// forever — the "don't hang forever" contract. Uses a short budget so
    /// this test stays fast; pure networking, no lazybrain.js dependency.
    #[test]
    fn recall_from_warm_sidecar_patient_gives_up_after_its_budget_when_nothing_ever_listens() {
        use crate::commands::brain::sidecar::BrainState;
        use std::net::TcpListener;
        use std::time::{Duration, Instant};

        let free_port = TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .expect("OS must hand back an ephemeral port")
            .port();

        let state = BrainState::new();
        state.0.lock().expect("lock").port = free_port;

        let budget = Duration::from_millis(700);
        let start = Instant::now();
        let result = recall_from_warm_sidecar_patient("nothing is listening here", None, None, &state.0, budget);
        let elapsed = start.elapsed();

        assert!(result.is_err(), "expected an eventual Err when the sidecar never comes up, got {:?}", result);
        assert!(
            is_connection_level_error(&result.as_ref().unwrap_err()),
            "the final error should still be the connection-level shape, got {:?}",
            result
        );
        assert!(
            elapsed >= budget,
            "must actually spend the retry budget before giving up, elapsed={:?} budget={:?}",
            elapsed, budget
        );
        // Generous absolute ceiling rather than a tight multiple of `budget`:
        // each failed attempt pays real (variable, OS/runtime-dependent)
        // connection + HTTP-client-construction overhead on top of the
        // configured sleep interval, so the exact overshoot past `budget`
        // is not tightly predictable. The property that actually matters —
        // "bounded, not the old 30-60s hang" — is what this asserts.
        assert!(
            elapsed < Duration::from_secs(10),
            "must not hang far past its budget when nothing ever listens, elapsed={:?} budget={:?}",
            elapsed, budget
        );

        eprintln!(
            "recall_from_warm_sidecar_patient_gives_up_after_its_budget_when_nothing_ever_listens PASSED (elapsed={:?})",
            elapsed
        );
    }

    // ── recall_current_scope (GRAPH/RECALL DIVERGENCE FIX) ──────────────
    //
    // The manager's brain_query grounding (recallForDirective ->
    // platform.brain.recallScoped('current') -> brain_fetch_recall_scoped ->
    // recall_current_scope) must never disagree with BrainSpace's
    // brain_fetch_graph about whether a brain is reachable: brain_fetch_graph
    // (sidecar/fetch.rs) has NO local filesystem existence check at all — it
    // unconditionally proxies to whatever the live sidecar answers. These
    // tests prove recall_current_scope now behaves the same way: the local
    // `brain_path`'s existence is consulted only as a LAST resort, once the
    // warm sidecar is proven unreachable, never as a precondition for even
    // trying it.

    /// The exact bug this fix closes: a live, reachable sidecar (the same
    /// one BrainSpace's graph reaches, unconditionally) must answer even when
    /// the LOCALLY recomputed `brain_path` — `resolve_unified_brain_path`'s
    /// result for "the current project" — does not exist on disk. Before the
    /// fix this returned an immediate "Brain introuvable ... lance
    /// `lazybrain init`" error without ever attempting the sidecar.
    #[test]
    fn recall_current_scope_reaches_a_live_sidecar_even_when_the_locally_resolved_brain_path_does_not_exist() {
        use crate::commands::brain::config::resolve_lazybrain_bin_static;
        use crate::commands::brain::sidecar::{BrainSidecar, BrainState, start_or_restart_brain_sidecar};
        use std::net::TcpListener;
        use tempfile::TempDir;

        let lb = match resolve_lazybrain_bin_static() {
            Ok(b) => b,
            Err(_) => {
                eprintln!(
                    "SKIP recall_current_scope_reaches_a_live_sidecar_even_when_the_locally_resolved_brain_path_does_not_exist \
                     — lazybrain.js not found"
                );
                return;
            }
        };

        // The sidecar is booted against a REAL brain (temp dir A) — stands
        // in for "whatever brain the live sidecar is actually serving" (its
        // own boot-time default, or a multi-tenant brainId — see
        // active_brain_query_suffix), exactly what brain_fetch_graph trusts
        // unconditionally.
        let real_brain = TempDir::new().expect("TempDir::new (real brain)");
        let real_brain_path = real_brain.path().to_str().unwrap().to_string();
        BrainSidecar::ensure_brain_init(&lb, &real_brain_path);

        let free_port = TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .expect("OS must hand back an ephemeral port")
            .port();

        let state = BrainState::new();
        state.0.lock().expect("lock").port = free_port;

        let became_healthy = start_or_restart_brain_sidecar(&state.0, &lb, &real_brain_path, free_port);
        assert!(became_healthy, "test sidecar must come up healthy against the real brain");

        // `brain_path` here is a DIFFERENT, never-created directory — stands
        // in for the locally-resolved path diverging from what the sidecar
        // actually serves (e.g. no project-local .lazybrain/brain folder was
        // ever materialized because the effective brain lives elsewhere).
        let nonexistent = real_brain.path().join("never-created").join("brain");
        let nonexistent_path = nonexistent.to_str().unwrap().to_string();
        assert!(
            !nonexistent.exists(),
            "the divergent local path must genuinely not exist for this test to prove anything"
        );

        let result = recall_current_scope(
            "does this brain know anything",
            &nonexistent_path,
            "C:\\some\\project\\root",
            None,
            &state.0,
            &lb,
        );

        assert!(
            result.get("error").is_none(),
            "recall_current_scope must not fail with a 'brain missing' error when the warm sidecar is \
             reachable and answering, even though the locally-resolved brain_path does not exist on disk \
             — this is exactly the divergence that made the manager say 'no brain accessible' while \
             BrainSpace showed the same brain live. Got: {:?}",
            result
        );

        eprintln!(
            "recall_current_scope_reaches_a_live_sidecar_even_when_the_locally_resolved_brain_path_does_not_exist \
             PASSED (result={:?})",
            result
        );

        state.0.lock().expect("lock").stop();
    }

    /// The other half of the same claim: when the sidecar is GENUINELY
    /// unreachable (not merely a locally-divergent path), the local
    /// existence check still gates the cold-CLI fallback and the honest
    /// "Brain introuvable" error still surfaces — the fix narrows WHEN the
    /// check applies, it does not remove the check's real purpose.
    #[test]
    fn recall_current_scope_still_reports_brain_introuvable_when_sidecar_unreachable_and_local_path_missing() {
        use crate::commands::brain::config::resolve_lazybrain_bin_static;
        use crate::commands::brain::sidecar::BrainState;
        use std::net::TcpListener;
        use tempfile::TempDir;

        let lb = match resolve_lazybrain_bin_static() {
            Ok(b) => b,
            Err(_) => {
                eprintln!(
                    "SKIP recall_current_scope_still_reports_brain_introuvable_when_sidecar_unreachable_and_local_path_missing \
                     — lazybrain.js not found"
                );
                return;
            }
        };

        // Nothing listens on this port — the warm-sidecar attempt exhausts
        // its retry budget and falls through to the cold-CLI path, which
        // genuinely needs a real brain on disk.
        let free_port = TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .expect("OS must hand back an ephemeral port")
            .port();
        let state = BrainState::new();
        state.0.lock().expect("lock").port = free_port;

        let tmp = TempDir::new().expect("TempDir::new");
        let missing = tmp.path().join("never-created-brain");
        let missing_path = missing.to_str().unwrap().to_string();
        assert!(!missing.exists());

        let result = recall_current_scope("anything", &missing_path, "C:\\some\\project\\root", None, &state.0, &lb);

        let error = result.get("error").and_then(|e| e.as_str()).unwrap_or("");
        assert!(
            error.contains("Brain introuvable"),
            "when the sidecar is genuinely unreachable AND the local brain_path does not exist, the honest \
             'Brain introuvable — lance lazybrain init' error must still surface (the one case where the \
             local existence check is meaningful — the cold CLI fallback needs a real brain on disk). Got: {:?}",
            result
        );

        eprintln!(
            "recall_current_scope_still_reports_brain_introuvable_when_sidecar_unreachable_and_local_path_missing \
             PASSED (result={:?})",
            result
        );
    }
}
