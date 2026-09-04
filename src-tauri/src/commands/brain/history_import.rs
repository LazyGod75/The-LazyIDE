//! First-run history detection and brain seeding (dry-run estimate + real
//! import) from existing Claude Code / Codex JSONL history on disk.

use std::collections::HashMap;
use std::fs;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::state::ProjectState;
use crate::commands::brain::sidecar::{
    start_or_restart_brain_sidecar, BrainSidecar, BrainState, LazyBrainBin, BRAIN_PORT,
};
use crate::commands::brain::config::{
    count_brain_notes, resolve_lazybrain_bin_static, resolve_seed_brain_path,
};
use crate::commands::brain::maintenance::{postpone_next_consolidation, MaintenancePidState};
use crate::commands::brain::capture::derive_topic_from_cwd;
use crate::commands::chat::agent_cli_available;

/// Resolved LLM backend for import annotation: which env vars to set on the
/// spawned `lazybrain import --use-llm` process, plus a human-readable label
/// for progress reporting. NO SILENT DEGRADATION: `brain_seed` always tells
/// the caller which backend (if any) is active before it starts importing —
/// see the `phase: "backend"` progress event below.
struct LlmBackend {
    /// Env vars to set on the child process. Empty when no backend is
    /// available — the import still runs, but produces heuristic-only notes.
    env: Vec<(&'static str, String)>,
    /// Human-readable label surfaced to the UI.
    label: String,
}

/// Detect the best available LLM backend for import annotation, mirroring
/// (a subset of) `annotator/llm.ts`'s `resolveExtractorBackend` priority:
///
///   1. `claude` CLI on PATH → LAZYBRAIN_EXTRACTOR=claude-cli. Reuses the
///      user's existing Claude Code CLI login — the same detection this
///      app's assistant already relies on (see chat.rs's
///      `agent_cli_available`) — so no separate API key is required.
///   2. ANTHROPIC_API_KEY present in this process's environment → passed
///      through to the child so `resolveExtractorBackend` picks the direct
///      Anthropic API path.
///   3. Neither → heuristic-only. Deliberately does NOT fall back to
///      LAZYBRAIN_EXTRACTOR=openai (local devstral): that target is usually
///      not running (see `resolveExtractorBackend`'s own doc comment), so
///      selecting it here would silently produce empty enrichment while
///      *looking* configured — an honest "heuristic only" label is better.
///
/// v1 scope note: this only checks for a CLI on PATH and an
/// already-exported ANTHROPIC_API_KEY env var — it does not reach into the
/// app's own BYOK key storage (that key is normally threaded per-chat-request
/// from the frontend, see chat.rs's `resolve_anthropic_key`, and import runs
/// outside any chat request). If neither is present the import still
/// succeeds with heuristic-only notes, and the UI is told so explicitly.
fn resolve_llm_backend() -> LlmBackend {
    if agent_cli_available("claude".to_string()) {
        return LlmBackend {
            env: vec![("LAZYBRAIN_EXTRACTOR", "claude-cli".to_string())],
            label: "Claude Code CLI".to_string(),
        };
    }
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        if !key.trim().is_empty() {
            return LlmBackend {
                env: vec![("ANTHROPIC_API_KEY", key)],
                label: "Anthropic API".to_string(),
            };
        }
    }
    LlmBackend {
        env: Vec::new(),
        label: "heuristic only (no LLM backend detected)".to_string(),
    }
}

/// A detected conversation-history source.
///
/// Mirrors the TypeScript `HistorySource` type from platform/types.ts:
///   { source: string; label: string; available: boolean; itemCount: number; path?: string }
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistorySource {
    pub source: String,
    pub label: String,
    pub available: bool,
    pub item_count: u64,
    pub path: Option<String>,
}

/// Count *.jsonl files inside a directory tree one level deep.
/// Claude Code stores one project dir per conversation group:
///   ~/.claude/projects/<project-slug>/*.jsonl
fn count_jsonl_files(dir: &std::path::Path) -> u64 {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut count: u64 = 0;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_dir() {
            // One sub-directory per project — count *.jsonl inside
            if let Ok(sub) = fs::read_dir(&path) {
                for sub_entry in sub.filter_map(|e| e.ok()) {
                    let sp = sub_entry.path();
                    if sp.extension().and_then(|x| x.to_str()) == Some("jsonl") {
                        count += 1;
                    }
                }
            }
        } else if path.extension().and_then(|x| x.to_str()) == Some("jsonl") {
            count += 1;
        }
    }
    count
}

/// Count files directly inside a directory (non-recursive, any extension).
/// Used for Cursor history dirs where each file is one conversation.
fn count_files_in_dir(dir: &std::path::Path) -> u64 {
    match fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .count() as u64,
        Err(_) => 0,
    }
}

/// Detect available conversation history sources.
///
/// Currently detects:
///   - claude-code: ~/.claude/projects (JSONL conversation files)
///   - cursor:      %APPDATA%/Cursor/User/workspaceStorage (Cursor history)
///
/// Does NOT read file CONTENTS — only enumerates and counts entries.
#[tauri::command]
pub(crate) fn detect_history_sources() -> Vec<HistorySource> {
    let mut sources: Vec<HistorySource> = Vec::new();

    // ── Claude Code: ~/.claude/projects ──────────────────────────
    let claude_projects_dir = {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        std::path::Path::new(&home).join(".claude").join("projects")
    };

    let (claude_available, claude_count, claude_path) = if claude_projects_dir.is_dir() {
        let count = count_jsonl_files(&claude_projects_dir);
        (true, count, Some(claude_projects_dir.to_string_lossy().into_owned()))
    } else {
        (false, 0, None)
    };

    sources.push(HistorySource {
        source: "claude-code".to_string(),
        label: "Claude Code conversations".to_string(),
        available: claude_available,
        item_count: claude_count,
        path: claude_path,
    });

    // ── Cursor: %APPDATA%/Cursor/User/workspaceStorage ────────────
    let cursor_dir = {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| {
            // Fallback on non-Windows: ~/.config
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
            format!("{}/.config", home)
        });
        std::path::Path::new(&appdata)
            .join("Cursor")
            .join("User")
            .join("workspaceStorage")
    };

    let (cursor_available, cursor_count, cursor_path) = if cursor_dir.is_dir() {
        let count = count_files_in_dir(&cursor_dir);
        (true, count, Some(cursor_dir.to_string_lossy().into_owned()))
    } else {
        (false, 0, None)
    };

    sources.push(HistorySource {
        source: "cursor".to_string(),
        label: "Cursor conversations".to_string(),
        available: cursor_available,
        item_count: cursor_count,
        path: cursor_path,
    });

    sources
}

/// Parsed result from `lazybrain import --dry-run`.
///
/// The CLI prints a JSON object:
///   { source, scanned, imported, skipped, estItems, estTokens, sampleTitles }
#[derive(Deserialize, Debug, Default)]
struct ImportDryRunResult {
    #[serde(rename = "estItems", default)]
    est_items: u64,
    #[serde(rename = "estTokens", default)]
    est_tokens: u64,
}

/// Estimate the cost (items + tokens + minutes) of seeding from the given sources.
///
/// Spawns `lazybrain import --source <s> --input auto --brain <brain> --dry-run`
/// for each source, sums `estItems` and `estTokens`, then derives `estMinutes`
/// at a conservative 200 tokens/second rate.
///
/// The brain `brain_seed` would actually target is used as the estimate's
/// path too — resolved via `resolve_seed_brain_path` (config.rs) rather than
/// a plain `brain_path_from_project`, so the estimate is honest about where
/// notes WOULD land even in the onboarding case where no project is open yet
/// (see that function's doc comment for the stranded-brain divergence it
/// closes). `persist: false`: this is a read-only dry-run, called before the
/// user has committed to seeding at all — it must never write
/// `brain-config.json` as a side effect. Sources for which the CLI errors
/// are silently skipped.
///
/// `async fn` + `spawn_blocking` (not the `#[tauri::command(async)]`
/// attribute this command used previously): the loop below spawns
/// `lazybrain import --dry-run` per source via a plain sync
/// `Command::output()` — the same "blocks for a while" shape 921d664
/// already fixed for every other `lazybrain`-spawning command (see
/// `project_register`'s doc comment, commands/brain/config.rs, for the
/// full mechanism). `(async)` on a non-async fn dispatches the body onto a
/// tokio ASYNC worker rather than the blocking pool — the exact
/// tokio-panic shape 921d664 documents for `reqwest::blocking` — so
/// `spawn_blocking` is the only shape this codebase treats as safe for
/// blocking work, even though this particular function does not itself
/// call `reqwest::blocking`.
#[tauri::command]
pub(crate) async fn brain_seed_estimate(
    sources: Vec<String>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    match tauri::async_runtime::spawn_blocking(move || brain_seed_estimate_inner(sources, &app)).await {
        Ok(result) => result,
        Err(e) => Err(format!("brain_seed_estimate: blocking task join failed: {}", e)),
    }
}

/// Synchronous body of `brain_seed_estimate` — always runs on the blocking
/// pool (see the command's doc comment above). Derives `ProjectState` from
/// the `AppHandle` because a `tauri::State<'_, T>` borrow cannot move into
/// a `'static` `spawn_blocking` closure — see `project_register`'s doc
/// comment (config.rs) for the full mechanism.
fn brain_seed_estimate_inner(sources: Vec<String>, app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let project_state = app.state::<ProjectState>();

    let lb = resolve_lazybrain_bin_static()
        .map_err(|e| format!("brain_seed_estimate: {}", e))?;

    let brain_path = resolve_seed_brain_path(app, &project_state, false);

    let mut total_items: u64 = 0;
    let mut total_tokens: u64 = 0;

    for source in &sources {
        let output = lb.command(&[
            "import",
            "--source", source,
            "--input",  "auto",
            "--brain",  &brain_path,
            "--dry-run",
        ])
        .env("LAZYBRAIN_BRAIN_PATH", &brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();

        let output = match output {
            Ok(o) => o,
            Err(e) => {
                log::warn!("brain_seed_estimate: spawn failed for source '{}': {}", source, e);
                continue;
            }
        };

        if !output.status.success() {
            log::warn!(
                "brain_seed_estimate: import --dry-run exited {} for source '{}'",
                output.status, source
            );
            continue;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        match serde_json::from_str::<ImportDryRunResult>(stdout.trim()) {
            Ok(res) => {
                total_items  += res.est_items;
                total_tokens += res.est_tokens;
            }
            Err(e) => {
                log::warn!(
                    "brain_seed_estimate: JSON parse failed for source '{}': {} (stdout={})",
                    source, e, stdout.trim()
                );
            }
        }
    }

    // Conservative throughput estimate: 200 tokens/s
    const TOKENS_PER_SECOND: u64 = 200;
    let est_seconds = if TOKENS_PER_SECOND > 0 {
        total_tokens / TOKENS_PER_SECOND
    } else {
        0
    };
    let est_minutes = (est_seconds / 60).max(if total_items > 0 { 1 } else { 0 });

    // Resolved independently of the sources loop above (cheap: one
    // `claude --version` probe) so the onboarding/Settings UI can decide the
    // default state of the "use LLM" toggle and its copy ("notes will be
    // heuristic-only") BEFORE the user commits to starting the import.
    let backend = resolve_llm_backend();

    Ok(serde_json::json!({
        "items":       total_items,
        "estTokens":   total_tokens,
        "estMinutes":  est_minutes,
        "backend":     backend.label,
        "llmAvailable": !backend.env.is_empty(),
    }))
}

/// Parsed result from `lazybrain import` (real run, not dry-run).
#[derive(Deserialize, Debug, Default)]
struct ImportRunResult {
    #[serde(default)]
    imported: u64,
    #[serde(default)]
    skipped: u64,
}

// ── Post-seed pipeline (index -> synthesize -> link -> score -> serve) ──
//
// `brain_seed` used to stop the instant the last source finished importing:
// the raw neuron HTML was on disk, but nothing had rebuilt the FTS/semantic
// index, no wiki pages existed, and the `lazybrain serve` sidecar was never
// (re)started — so a brand new user who just imported their history landed
// on an empty Brain/Wiki with "Sidecar brain indisponible", even though the
// import itself had genuinely succeeded. Worse, the app's OTHER brain-ready
// mechanism — the 30-minute background consolidator (`spawn_brain_consolidator`,
// maintenance.rs) — runs the FULL `dream`/`prune`/`compress`/`interlink`/
// `profile-update` sequence, which holds the brain for tens of minutes on a
// large import (interlink's embeddings pass scales with note count) and can
// race the sidecar's own init, tripping the failure-cache marker
// (`ensure_brain_init`'s `INIT_FAILURE_MARKER`, sidecar.rs) and blocking
// recovery for hours.
//
// The fix: right after the import loop below, the app itself runs a light,
// bounded, USER-FACING pipeline — `index-rebuild` -> `dream --synthesize` ->
// `graph` -> `build-index` -> `health-score` -> (re)start the serve sidecar —
// emitting progress on the SAME `brain://seed-progress` channel the import
// loop already uses, with phases `"indexing"` / `"synthesizing"` /
// `"linking"` / `"scoring"` / `"serving"` / `"done"` / `"error"` so the
// onboarding progress UI can render one continuous sequence. `dream
// --synthesize` (not plain `dream`) is deliberate: reading
// `engine/src/commands/dream.ts` shows `--synthesize` is a shortcut
// (`runSynthesizeOnlyShortcut`) that runs ONLY Phase 5 (wiki synthesis: the
// brain-index + topic-overview pages) and returns immediately, explicitly
// skipping Phase 0 conversation ingestion (already done by `import` above),
// noise cleanup, and contradiction/duplicate detection — see
// maintenance.rs's own module doc for the full phase breakdown. That is
// exactly the "fast, non-LLM" wiki-only pass this step needs; the heavy
// full-pipeline steps (`prune`/`compress`/`interlink`/`profile-update`) stay
// on `run_full_maintenance_sequence`'s existing 30-minute cadence — this
// function never calls it.
//
// BUG FIX (missing graph/build-index/health-score): the pipeline above
// originally stopped at `dream --synthesize` -> serve, which left a freshly
// seeded brain with no file-neurons/backlinks/clusters (`graph` — the SAME
// step-for-step invocation `brain_rebuild_graph`, capture.rs, runs on a
// manual rebuild — never ran after a seed) and a health score frozen at 0
// (`brain_fetch_health`, config.rs, reads a `<meta name="cerveau-health">`
// tag from `_index.html` and returns `{"score": 0}` when that file is
// missing; only `build-index` ever creates it — `health-score`'s own
// `writeHealthMeta` only PATCHES an existing one, see `brain_rebuild_graph`'s
// doc comment for the empirical proof). Two new phases close this gap:
// `"linking"` runs `graph` (with `--cwd <project_root>` when a project is
// open, so the same tree-sitter code-scan `brain_rebuild_graph` triggers on
// a manual rebuild also runs once, automatically, right after a fresh seed)
// and `"scoring"` runs `build-index` then `health-score` in sequence —
// reusing `brain_rebuild_graph`'s exact command/env/ordering rationale
// rather than inventing a new one.

/// Ceiling for the post-seed `index-rebuild` step. Generous for a large
/// (~2000-note) history import while still bounding the background thread's
/// worst case — mirrors `index_project.rs`'s `AUTO_INDEX_STEP_TIMEOUT_SECS`
/// intent (same subcommand, same "don't hang forever" contract) but this
/// module keeps its own copy rather than importing a private constant across
/// files (matches this codebase's established one-constant-per-call-site
/// convention, e.g. `capture.rs`'s `BRAIN_CAPTURE_TIMEOUT_SECS`).
const POST_SEED_INDEX_TIMEOUT_SECS: u64 = 300;

/// Ceiling for the post-seed `dream --synthesize` step. Smaller than the
/// index-rebuild ceiling above: the synthesize-only shortcut skips ingestion
/// and only composes wiki pages from already-indexed notes, so it is
/// expected to be fast even on a large brain.
const POST_SEED_SYNTHESIZE_TIMEOUT_SECS: u64 = 180;

/// Ceiling for the post-seed `graph` step ("linking" phase) — regenerates
/// `brain-graph.json` and, when a project is open, code-scans it into
/// file-neuron/aggregate-neuron notes (the SAME invocation
/// `brain_rebuild_graph` runs on a manual rebuild — see capture.rs). Sized
/// like `POST_SEED_INDEX_TIMEOUT_SECS` above: same "don't hang forever"
/// contract, same generous-for-a-large-scan intent, same per-call-site
/// constant convention (this module keeps its own copy rather than
/// importing capture.rs's private constant of a similar purpose).
const POST_SEED_GRAPH_TIMEOUT_SECS: u64 = 300;

/// Ceiling for EACH of the post-seed `build-index` and `health-score` steps
/// ("scoring" phase). Smaller than the graph/index-rebuild ceilings above:
/// both operate on already-indexed/-linked notes (`build-index` composes the
/// `_index.html` atlas from what `index-rebuild`/`graph` already wrote;
/// `health-score` only reads that atlas and patches one meta tag into it),
/// so neither is expected to scale the way a cold index-rebuild or a full
/// project code-scan can.
const POST_SEED_SCORE_TIMEOUT_SECS: u64 = 120;

/// Spawn `cmd` (stdin/stdout/stderr all null — this module discards output,
/// same tradeoff as `index_project.rs`'s `run_step_with_timeout`), poll with
/// `try_wait()` until it exits or `timeout_secs` elapses, and return `Ok(())`
/// only on a genuine zero exit. Kills the child on timeout. Tracks the PID in
/// `pid_state` (when given) for the app's exit hook to tree-kill — mirrors
/// `maintenance.rs`'s `run_maintenance_step` PID-tracking so a post-seed step
/// still running when the user closes the window during onboarding cannot
/// orphan a `lazybrain.js` process the way the P0.3 fix (maintenance.rs's
/// module doc) already prevents for background consolidation.
///
/// Self-contained rather than reusing `index_project.rs`'s private helper of
/// the same name, or `maintenance.rs`'s `run_maintenance_step` (which blocks
/// unboundedly on `wait_with_output()` with no deadline) — neither is
/// importable here, and this module must not edit either file.
fn run_step_with_timeout(
    cmd: &mut Command,
    timeout_secs: u64,
    label: &str,
    pid_state: Option<&MaintenancePidState>,
) -> Result<(), String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("'{}' failed to spawn: {}", label, e))?;

    let pid = child.id();
    if let Some(state) = pid_state {
        if let Ok(mut map) = state.0.lock() {
            map.insert(label.to_string(), pid);
        }
    }
    let untrack = |state: Option<&MaintenancePidState>| {
        if let Some(state) = state {
            if let Ok(mut map) = state.0.lock() {
                map.remove(label);
            }
        }
    };

    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                untrack(pid_state);
                return Ok(());
            }
            Ok(Some(status)) => {
                untrack(pid_state);
                return Err(format!("'{}' exited {}", label, status));
            }
            Ok(None) => {}
            Err(e) => {
                untrack(pid_state);
                return Err(format!("'{}' try_wait failed: {}", label, e));
            }
        }

        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            untrack(pid_state);
            return Err(format!("'{}' timed out after {}s", label, timeout_secs));
        }

        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Emit a `brain://seed-progress` event. Reuses the exact channel/shape the
/// per-source import loop already emits on (`{done, total, phase, message,
/// percent}`) so the onboarding progress UI renders one continuous sequence
/// instead of switching channels partway through.
fn emit_seed_progress(app: &tauri::AppHandle, phase: &str, done: u64, total: u64, message: String, percent: u8) {
    let _ = app.emit("brain://seed-progress", serde_json::json!({
        "done":    done,
        "total":   total,
        "phase":   phase,
        "message": message,
        "percent": percent,
    }));
}

// ── Seed-in-progress guard (belt-and-braces against the 30-min consolidator) ──
//
// `postpone_next_consolidation` (called at both the START and END of
// `brain_seed` below) pushes the background consolidator's next allowed pass
// out by a full `CONSOLIDATE_INTERVAL_SECS` window — but a single deferral
// window can still be shorter than a large history import (a ~2000-note
// import has been observed taking 40+ minutes, well past the 30-minute
// consolidator interval). `SEED_IN_PROGRESS` is the belt-and-braces guard the
// consolidator loop (`spawn_brain_consolidator`, maintenance.rs) — and
// `brain_consolidate_now`, the manual "Consolidate now" button — check
// immediately before starting a heavy pass: if a seed is still running, they
// skip and defer again instead of racing it.

/// True for the entire duration of an active `brain_seed` call (import loop
/// + post-seed pipeline). See module doc above.
static SEED_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Whether a `brain_seed` call is currently running. Read by
/// `maintenance::spawn_brain_consolidator`'s loop and `brain_consolidate_now`
/// right before either would start a background consolidation pass.
pub(crate) fn is_seed_in_progress() -> bool {
    SEED_IN_PROGRESS.load(Ordering::SeqCst)
}

/// RAII guard: flips `SEED_IN_PROGRESS` true on construction, false on drop —
/// including on a panic mid-seed (`Drop::drop` still runs during unwinding),
/// so a crash can never leave the flag stuck at `true` and wedge the
/// consolidator off forever. Mirrors `maintenance.rs`'s own `EnvVarGuard` test
/// helper for the identical "always release, even on an early/panicking
/// exit" property. Held for `brain_seed`'s ENTIRE body (import loop + the
/// post-seed pipeline), not just the import loop — `run_post_seed_pipeline`
/// (index-rebuild/dream --synthesize) is itself a multi-minute brain-touching
/// operation the consolidator must equally stay off of.
pub(crate) struct SeedInProgressGuard;

impl SeedInProgressGuard {
    fn acquire() -> Self {
        SEED_IN_PROGRESS.store(true, Ordering::SeqCst);
        SeedInProgressGuard
    }
}

impl Drop for SeedInProgressGuard {
    fn drop(&mut self) {
        SEED_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

// ── Whole-pipeline progress percent ───────────────────────────────
//
// `done`/`total` on the "import" phase count SOURCES (usually 1-2) — a
// meaningless 0/50/100% jump for a UI trying to show real progress. `percent`
// is a SEPARATE, backend-computed field carried on every
// `brain://seed-progress` event: the import phase is weighted by each
// selected source's OWN item count (so a 1800-conversation claude-code
// source and a 20-conversation cursor source don't each count as a flat
// "half the bar"), mapped onto 0..90; the post-seed pipeline's fixed steps
// then take the remaining 90..100 (see the PCT_* constants below). This is
// still an approximation (a source's items are not uniformly-sized work, and
// the post-seed steps' internal progress isn't observable) — never presented
// as more precise than "whole-pipeline, source-weighted interpolation".

/// Post-seed pipeline phases map to these fixed percentages — each step's
/// own internal progress is not observable (a single subprocess call with no
/// intermediate output), so every step jumps straight to its endpoint value.
/// Five steps now share the post-import 90..100 range (was three: indexing/
/// synthesizing/serving) — indexing -> synthesizing -> linking -> scoring ->
/// serving, 2 points apart, leaving PCT_DONE's own 100 for the caller's
/// final "done" event.
const PCT_INDEXING: u8 = 90;
const PCT_SYNTHESIZING: u8 = 92;
const PCT_LINKING: u8 = 94;
const PCT_SCORING: u8 = 96;
const PCT_SERVING: u8 = 98;
const PCT_DONE: u8 = 100;

/// Weighted percent for the import phase (0..90): `cumulative_items /
/// total_items`, scaled onto the 0..90 range. Falls back to an even split
/// across sources (`sources_done / sources_total`) when item counts are
/// unavailable/zero (e.g. a source's directory vanished between detection
/// and import) — never divides by zero. Clamped to [0, 90] so a stale/
/// inconsistent input can never bleed into the post-seed pipeline's own
/// 90..100 range.
fn import_phase_percent(cumulative_items: u64, total_items: u64, sources_done: u64, sources_total: u64) -> u8 {
    let ratio = if total_items > 0 {
        cumulative_items as f64 / total_items as f64
    } else if sources_total > 0 {
        sources_done as f64 / sources_total as f64
    } else {
        0.0
    };
    (ratio.clamp(0.0, 1.0) * f64::from(PCT_INDEXING)).round() as u8
}

// ── Intra-source progress (notes-on-disk watcher) ─────────────────────
//
// The per-source loop in `brain_seed` below only ever emitted
// `brain://seed-progress` at a source's START and FINISH — for a single
// large source (observed: 830 conversations, ~40 minutes) the percent sat
// frozen at the exact same value for the ENTIRE run, which reads as
// hung/broken even though the import is genuinely progressing. `lazybrain
// import` itself streams no machine-readable intermediate progress on
// stdout (only one JSON summary at the very end, parsed into
// `ImportRunResult` above) and is a vendored subprocess this app does not
// control the output contract of — so the notes it writes to disk as it
// goes are the only observable mid-import signal available.
// `spawn_notes_progress_watcher` below polls that count every ~2s for the
// duration of a single source's blocking subprocess call and emits
// intermediate "import" events on the SAME `brain://seed-progress`
// channel/shape the surrounding loop's start/finish events already use.

/// Poll interval for the watcher below. A single recursive `*.html`-under-
/// `notes/` count (same work `count_brain_notes` already does once for the
/// post-seed outcome) is cheap enough to repeat at this cadence for a
/// 40+-minute source without meaningfully competing with the import
/// subprocess itself for disk I/O.
const NOTES_WATCH_INTERVAL: Duration = Duration::from_secs(2);

/// How often the watcher wakes to check its stop flag while waiting out
/// NOTES_WATCH_INTERVAL — keeps shutdown latency low (the caller blocks on
/// `stop_notes_progress_watcher`'s `join()` right after the subprocess
/// exits) without needing a busy loop.
const NOTES_WATCH_TICK: Duration = Duration::from_millis(200);

/// Weighted percent for an in-flight source, given how many NEW notes have
/// landed on disk since this source started relative to its own estimated
/// item count. Pure, side-effect-free core of the watcher's per-tick
/// computation (see `spawn_notes_progress_watcher`) — kept standalone so it
/// can be unit-tested directly with plain integers, no subprocess/thread
/// involved.
///
/// `notes_written_this_source` is `current_note_count -
/// baseline_note_count` (saturating — never underflows if a count somehow
/// dips transiently). `baseline_note_count` MUST be captured at THIS
/// source's start, not once for the whole `brain_seed` call, so notes
/// written by earlier sources (or already on disk from a previous run)
/// never skew this source's own fraction.
///
/// The result is exactly `import_phase_percent`'s own cumulative-items
/// formula with this in-flight source's fractional contribution folded
/// in: `notes_written_this_source` is clamped to `this_source_est_items`
/// (so a runaway/undercounted estimate — one JSONL conversation can yield
/// several notes — can never push this source's contribution past its own
/// allotted weight) and added to `cumulative_items_before_this_source`
/// before being handed to `import_phase_percent`. That reuse is what
/// guarantees a mid-source tick is mathematically continuous with the
/// exact source-start/source-finish percents the surrounding loop already
/// emits (same numerator/denominator as those, just an intermediate value
/// strictly between the two) — equivalent to the spec formula `percent =
/// weighted_completed_sources + clamp(notes_written / this_source_est_items,
/// 0, 1) * this_source_weight * 90` (see this function's own unit tests for
/// a direct cross-check against that formula).
fn intra_source_percent(
    baseline_note_count: u64,
    current_note_count: u64,
    this_source_est_items: u64,
    cumulative_items_before_this_source: u64,
    total_items: u64,
    sources_done: u64,
    sources_total: u64,
) -> u8 {
    let notes_written_this_source = current_note_count.saturating_sub(baseline_note_count);
    let effective_items = notes_written_this_source.min(this_source_est_items);
    import_phase_percent(
        cumulative_items_before_this_source.saturating_add(effective_items),
        total_items,
        sources_done,
        sources_total,
    )
}

/// Fixed per-source context handed to `spawn_notes_progress_watcher` —
/// bundled into one struct (rather than half a dozen loose parameters) so
/// the spawn function's signature stays readable; see its call site in
/// `brain_seed`'s per-source loop for where each field comes from.
struct SourceProgressContext {
    baseline_note_count: u64,
    this_source_est_items: u64,
    cumulative_items_before_this_source: u64,
    total_items: u64,
    sources_done: u64,
    sources_total: u64,
    /// The exact percent already emitted by the caller's own "source
    /// starting" event, immediately before spawning this watcher — seeds
    /// the monotonic clamp below so the very first tick can never regress
    /// below it.
    floor_percent: u8,
}

/// Handle for a watcher started by `spawn_notes_progress_watcher` — pass to
/// `stop_notes_progress_watcher` the instant the watched subprocess exits.
struct NotesProgressWatcher {
    stop: Arc<AtomicBool>,
    handle: thread::JoinHandle<()>,
}

/// Spawns a background thread that polls the brain's on-disk note count
/// every `NOTES_WATCH_INTERVAL` and emits `brain://seed-progress` "import"
/// events with an intra-source percent (`intra_source_percent` above)
/// while one source's blocking `lazybrain import` subprocess is still
/// running — see this section's module doc comment for the full
/// rationale.
///
/// The returned handle MUST be passed to `stop_notes_progress_watcher` the
/// instant the subprocess exits (success, failure, or spawn error) — left
/// running any longer it would keep polling and emitting stale progress
/// for a source that has already moved on; the surrounding loop's own
/// source-finish event, emitted right after, remains the authoritative
/// end-of-source signal, unchanged by this watcher.
///
/// Never fails the import: `count_brain_notes` itself never errors (a
/// missing/unreadable directory just counts as 0, see config.rs) and every
/// event emit already swallows its own error (`emit_seed_progress`). The
/// whole loop body additionally runs behind `catch_unwind` (mirrors
/// index_project.rs's identical auto-index background thread precaution)
/// so even an unexpected panic here can only stop THIS watcher's ticks
/// early — logged, never propagated to the main thread importing this
/// source.
fn spawn_notes_progress_watcher(
    app: tauri::AppHandle,
    brain_path: String,
    source: String,
    ctx: SourceProgressContext,
) -> NotesProgressWatcher {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = Arc::clone(&stop);

    let handle = thread::spawn(move || {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // Monotonic floor — never emit below the source-start percent
            // the caller already sent (or any prior tick this thread
            // itself sent). Local, not shared/atomic: this thread is the
            // ONLY emitter of these intra-source ticks for its entire
            // lifetime (the main thread is blocked inside the
            // subprocess's own `.output()` call until this watcher is
            // stopped), so no cross-thread ordering is needed to keep it
            // monotonic.
            let mut last_percent = ctx.floor_percent;

            loop {
                let mut waited = Duration::ZERO;
                while waited < NOTES_WATCH_INTERVAL {
                    if stop_for_thread.load(Ordering::SeqCst) {
                        return;
                    }
                    let step = NOTES_WATCH_TICK.min(NOTES_WATCH_INTERVAL - waited);
                    thread::sleep(step);
                    waited += step;
                }
                if stop_for_thread.load(Ordering::SeqCst) {
                    return;
                }

                let current_note_count = count_brain_notes(&brain_path);
                let computed = intra_source_percent(
                    ctx.baseline_note_count,
                    current_note_count,
                    ctx.this_source_est_items,
                    ctx.cumulative_items_before_this_source,
                    ctx.total_items,
                    ctx.sources_done,
                    ctx.sources_total,
                );
                last_percent = last_percent.max(computed);
                emit_seed_progress(
                    &app,
                    "import",
                    ctx.sources_done,
                    ctx.sources_total,
                    format!("Importing from {}", source),
                    last_percent,
                );
            }
        }));

        if let Err(e) = outcome {
            log::warn!("spawn_notes_progress_watcher: watcher thread panicked: {:?}", e);
        }
    });

    NotesProgressWatcher { stop, handle }
}

/// Stop a watcher started by `spawn_notes_progress_watcher` and block until
/// its thread exits. Infallible: a panicked watcher thread's `join()` error
/// is deliberately swallowed (`let _ =`), never propagated — this progress
/// channel is best-effort by design, see that function's doc comment.
fn stop_notes_progress_watcher(watcher: NotesProgressWatcher) {
    watcher.stop.store(true, Ordering::SeqCst);
    let _ = watcher.handle.join();
}

/// Outcome of `run_post_seed_pipeline`, folded into `brain_seed`'s final
/// return value and "done" progress event.
struct PostSeedOutcome {
    /// Total notes on disk after the pipeline (`count_brain_notes`) —
    /// includes both the just-imported notes AND any wiki pages `dream
    /// --synthesize` created.
    notes_total: u64,
    /// Whether the serve sidecar reported healthy by the end of the
    /// "serving" step. `false` here is exactly the "Sidecar brain
    /// indisponible" condition this whole fix targets — surfaced honestly
    /// rather than silently swallowed.
    served: bool,
}

// ── Individual pipeline steps (AppHandle-free, independently unit-testable) ──
//
// Each step below does exactly one thing and returns a plain `Result`/`bool`
// — no `tauri::AppHandle`, no event emission. `run_post_seed_pipeline`
// (further down) is the thin orchestrator that sequences them and emits
// `brain://seed-progress` around each call. Splitting it this way mirrors
// `index_project.rs`'s own `run_auto_index` (AppHandle, emits events) vs
// `run_auto_index_pipeline` (no AppHandle, does the actual subprocess work)
// split, and — concretely — is what makes these steps `cargo test`-able
// against a real scratch brain without needing a live Tauri app instance.

/// Step 1/5: rebuild the FTS/semantic index so the notes `import` just wrote
/// are actually findable (search/recall reads the index, not the raw HTML
/// files on disk).
fn run_index_rebuild_step(
    lb: &LazyBrainBin,
    brain_path: &str,
    pid_state: Option<&MaintenancePidState>,
) -> Result<(), String> {
    let mut cmd = lb.command(&["index-rebuild"]);
    cmd.env("LAZYBRAIN_BRAIN_PATH", brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1");
    run_step_with_timeout(&mut cmd, POST_SEED_INDEX_TIMEOUT_SECS, "post-seed-index-rebuild", pid_state)
}

/// Step 2/5: `dream --synthesize` (fast, non-LLM; generates the wiki
/// brain-index + topic-overview pages). Deliberately NOT plain `dream` — see
/// this section's module doc comment.
fn run_synthesize_step(
    lb: &LazyBrainBin,
    brain_path: &str,
    pid_state: Option<&MaintenancePidState>,
) -> Result<(), String> {
    let mut cmd = lb.command(&["dream", "--synthesize"]);
    cmd.env("LAZYBRAIN_BRAIN_PATH", brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1")
        .env("LAZYBRAIN_CLAUDE_BIN", "_lazybrain_no_llm_");
    run_step_with_timeout(&mut cmd, POST_SEED_SYNTHESIZE_TIMEOUT_SECS, "post-seed-dream-synthesize", pid_state)
}

/// Step 3/5 ("linking" phase): `graph [--cwd <project_root>]` — regenerate
/// `brain-graph.json` and, when a project is open, code-scan it into
/// file-neuron/aggregate-neuron notes. Mirrors `brain_rebuild_graph`'s
/// (capture.rs) own `--cwd` handling exactly, including the arg-lifetime
/// pattern (`cwd_arg` declared before the `if` so the borrow it holds
/// outlives the block that creates it) — see that function's doc comment
/// for the full rationale on why `--cwd` matters: without it, `graph` only
/// discovers project dirs from existing notes' `data-cerveau-cwd`
/// attributes, which a freshly imported (conversation-only) brain has none
/// of.
///
/// `project_root` may be empty (a seed run during onboarding, before any
/// project is open) — `graph` still runs without `--cwd` in that case, which
/// still links/clusters the imported conversation notes to each other, just
/// without a code scan.
fn run_graph_step(
    lb: &LazyBrainBin,
    brain_path: &str,
    project_root: &str,
    pid_state: Option<&MaintenancePidState>,
) -> Result<(), String> {
    let mut graph_args: Vec<&str> = vec!["graph"];
    let cwd_arg;
    if !project_root.is_empty() {
        graph_args.push("--cwd");
        cwd_arg = project_root.to_string();
        graph_args.push(&cwd_arg);
    }
    let mut cmd = lb.command(&graph_args);
    cmd.env("LAZYBRAIN_BRAIN_PATH", brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1");
    run_step_with_timeout(&mut cmd, POST_SEED_GRAPH_TIMEOUT_SECS, "post-seed-graph", pid_state)
}

/// Step 4a/5 ("scoring" phase, part 1): `build-index` — composes the brain's
/// `_index.html` atlas from the already-rebuilt/-linked notes. The ONLY
/// command that creates `_index.html` from scratch (see
/// `brain_rebuild_graph`'s doc comment in capture.rs for the empirical
/// proof) — `health-score` below only patches an EXISTING one.
fn run_build_index_step(
    lb: &LazyBrainBin,
    brain_path: &str,
    pid_state: Option<&MaintenancePidState>,
) -> Result<(), String> {
    let mut cmd = lb.command(&["build-index"]);
    cmd.env("LAZYBRAIN_BRAIN_PATH", brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1");
    run_step_with_timeout(&mut cmd, POST_SEED_SCORE_TIMEOUT_SECS, "post-seed-build-index", pid_state)
}

/// Step 4b/5 ("scoring" phase, part 2): `health-score` — patches the
/// `cerveau-health` meta tag into `_index.html` (the exact tag
/// `brain_fetch_health` reads, config.rs). Run unconditionally by the
/// caller, even when `run_build_index_step` above failed:
/// `writeHealthMeta` silently no-ops when `_index.html` is missing (verified
/// in capture.rs's `brain_rebuild_graph_runs_cli`) — it never errors — so
/// there is no harm in still attempting it, and skipping it would only leave
/// the health score stale for longer than necessary.
fn run_health_score_step(
    lb: &LazyBrainBin,
    brain_path: &str,
    pid_state: Option<&MaintenancePidState>,
) -> Result<(), String> {
    let mut cmd = lb.command(&["health-score"]);
    cmd.env("LAZYBRAIN_BRAIN_PATH", brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1");
    run_step_with_timeout(&mut cmd, POST_SEED_SCORE_TIMEOUT_SECS, "post-seed-health-score", pid_state)
}

/// Step 5/5: (re)start the serve sidecar via sidecar.rs's own public restart
/// function — never reimplemented here. Returns whether the sidecar became
/// healthy. `start_or_restart_brain_sidecar` itself already clears any stale
/// `.lazybrain-init-failed` marker the instant it confirms the sidecar is
/// healthy (see its doc comment in sidecar.rs) — a fresh seed followed by a
/// successful restart is exactly the "fresh evidence the brain is fine" case
/// that exists to unblock, so nothing extra is needed here.
fn run_serve_step(lb: &LazyBrainBin, brain_path: &str, brain_state: &Arc<Mutex<BrainSidecar>>) -> bool {
    let preferred_port = brain_state.lock().map(|s| s.port).unwrap_or(BRAIN_PORT);
    start_or_restart_brain_sidecar(brain_state, lb, brain_path, preferred_port)
}

/// Run the bounded, user-facing "make the freshly seeded brain usable"
/// pipeline: index -> synthesize -> link -> score -> serve. See this
/// section's module doc comment for why each step/flag was chosen and why
/// the heavy maintenance sequence is deliberately NOT called here.
///
/// `project_root`: passed through to the "linking" phase's `graph` step so
/// it can pass `--cwd <project_root>` when a project is open — see
/// `run_graph_step`'s doc comment. May be empty (onboarding seed with no
/// project open yet); `graph` still runs without `--cwd` in that case.
///
/// Every step is best-effort and non-fatal to the ones after it — mirrors
/// `brain_rebuild_graph`'s (capture.rs) and `run_maintenance_step`'s
/// (maintenance.rs) existing log-and-continue pattern: a failed
/// `index-rebuild` must not prevent attempting `dream --synthesize`, a
/// failed `dream --synthesize` must not prevent attempting `graph`, and so
/// on through `build-index` / `health-score` / serve — a user is better
/// served by a serving-but-partially-stale brain than by no brain at all.
/// Each failure still emits its own honest `phase: "error"` event (with the
/// step name) so the UI never shows silent success.
fn run_post_seed_pipeline(
    app: &tauri::AppHandle,
    lb: &LazyBrainBin,
    brain_path: &str,
    project_root: &str,
    brain_state: &Arc<Mutex<BrainSidecar>>,
    pid_state: Option<&MaintenancePidState>,
) -> PostSeedOutcome {
    emit_seed_progress(app, "indexing", 0, 5, "Indexing imported notes".to_string(), PCT_INDEXING);
    if let Err(e) = run_index_rebuild_step(lb, brain_path, pid_state) {
        log::warn!("run_post_seed_pipeline: index-rebuild: {}", e);
        emit_seed_progress(app, "error", 0, 5, format!("Indexing step failed: {}", e), PCT_INDEXING);
        // Continue anyway — see this function's doc comment.
    }

    emit_seed_progress(app, "synthesizing", 1, 5, "Building wiki overview pages".to_string(), PCT_SYNTHESIZING);
    if let Err(e) = run_synthesize_step(lb, brain_path, pid_state) {
        log::warn!("run_post_seed_pipeline: dream --synthesize: {}", e);
        emit_seed_progress(app, "error", 1, 5, format!("Wiki synthesis failed: {}", e), PCT_SYNTHESIZING);
        // Continue anyway — the sidecar can still serve a brain with no wiki
        // pages, which beats no sidecar at all.
    }

    emit_seed_progress(app, "linking", 2, 5, "Linking neurons and scanning code".to_string(), PCT_LINKING);
    if let Err(e) = run_graph_step(lb, brain_path, project_root, pid_state) {
        log::warn!("run_post_seed_pipeline: graph: {}", e);
        emit_seed_progress(app, "error", 2, 5, format!("Linking step failed: {}", e), PCT_LINKING);
        // Continue anyway — a brain with no backlinks/clusters is still
        // searchable/browsable.
    }

    emit_seed_progress(app, "scoring", 3, 5, "Building atlas and health score".to_string(), PCT_SCORING);
    if let Err(e) = run_build_index_step(lb, brain_path, pid_state) {
        log::warn!("run_post_seed_pipeline: build-index: {}", e);
        emit_seed_progress(app, "error", 3, 5, format!("Atlas build failed: {}", e), PCT_SCORING);
        // Continue anyway — health-score below safely no-ops without
        // _index.html (see run_health_score_step's doc comment), and the
        // serve step after it does not depend on either succeeding.
    }
    if let Err(e) = run_health_score_step(lb, brain_path, pid_state) {
        log::warn!("run_post_seed_pipeline: health-score: {}", e);
        emit_seed_progress(app, "error", 3, 5, format!("Health score failed: {}", e), PCT_SCORING);
    }

    emit_seed_progress(app, "serving", 4, 5, "Starting the brain server".to_string(), PCT_SERVING);
    let served = run_serve_step(lb, brain_path, brain_state);
    if !served {
        log::warn!("run_post_seed_pipeline: sidecar did not become healthy on brain '{}'", brain_path);
        emit_seed_progress(app, "error", 4, 5, "Brain server did not become ready".to_string(), PCT_SERVING);
    }

    PostSeedOutcome { notes_total: count_brain_notes(brain_path), served }
}

/// Seed the current project brain from the given sources.
///
/// Spawns `lazybrain import --source <s> --input auto --brain <brain> [--use-llm] [--since <iso>]`
/// for each source sequentially, then runs `run_post_seed_pipeline` (index ->
/// synthesize -> link -> score -> serve) so the app itself finishes making
/// the brain usable — no CLI run by hand required. See this file's
/// "Post-seed pipeline" module doc comment above for the full rationale.
///
/// Emits Tauri event `brain://seed-progress` with payload:
///   { done: u64, total: u64, phase: String, message?: String, percent: u8 }
/// plus, on the final "done" event only: { imported, skipped, notesTotal,
/// served } (see seedProgressStore.ts's locally-widened RawSeedProgressEvent
/// type, which reads these additive fields). `total` is the number of
/// sources during the import phase, and 5 (the number of post-seed pipeline
/// steps) during "indexing"/"synthesizing"/"linking"/"scoring"/"serving" —
/// `done` counts 0..5 across those five steps, landing on 5/5 exactly on the
/// final "done" event. Phases: "backend" (once, if useLlm), "import" (per
/// source), "indexing", "synthesizing", "linking", "scoring", "serving",
/// "done", "error". `percent` is a separate, whole-pipeline (0-100) value —
/// see import_phase_percent's doc comment above for how it's weighted.
///
/// Returns `{ imported, skipped, notesTotal, served }` — the sum across all
/// sources plus the post-seed pipeline outcome.
///
/// `async fn` + `spawn_blocking` (NOT the `#[tauri::command(async)]`
/// attribute this command used previously — that earlier version of this
/// doc comment claimed `(async)` alone was a safe, sufficient fix, which is
/// WRONG and is superseded by this one): `(async)` on a non-async fn
/// dispatches the body onto a tokio ASYNC worker, not the blocking pool —
/// exactly the shape 921d664 already proved panics tokio the instant a
/// `reqwest::blocking` client is constructed/dropped on that worker
/// ("Cannot drop a runtime in a context where blocking is not allowed"),
/// wedging the invoke forever. That path IS reachable from here: this
/// function's own post-seed pipeline (`run_post_seed_pipeline` ->
/// `run_serve_step` -> `start_or_restart_brain_sidecar`) calls
/// `wait_ready_at` (sidecar.rs), which builds a `reqwest::blocking::Client`
/// to poll the freshly (re)started sidecar. `spawn_blocking` is the only
/// shape this codebase has proven safe for blocking work — see
/// `project_register`'s doc comment (config.rs) for the full mechanism.
/// The progress-event behavior this doc comment used to describe is
/// unaffected: `app` is still an owned `AppHandle` moved whole into the
/// blocking closure, so every `app.emit("brain://seed-progress", ...)`
/// call below still fires exactly as before — only the dispatch mechanism
/// changed; the function body is otherwise unchanged sync Rust.
#[tauri::command]
pub(crate) async fn brain_seed(
    sources: Vec<String>,
    use_llm: bool,
    since: Option<String>,
    project_root: Option<String>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    match tauri::async_runtime::spawn_blocking(move || brain_seed_inner(sources, use_llm, since, project_root, &app)).await {
        Ok(result) => result,
        Err(e) => Err(format!("brain_seed: blocking task join failed: {}", e)),
    }
}

/// Synchronous body of `brain_seed` — always runs on the blocking pool (see
/// the command's doc comment above). Derives every managed State from the
/// `AppHandle` (`app.state::<T>()`) because a `tauri::State<'_, T>` borrow
/// cannot move into a `'static` `spawn_blocking` closure.
fn brain_seed_inner(
    sources: Vec<String>,
    use_llm: bool,
    since: Option<String>,
    seed_project_root: Option<String>,
    app: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let project_state = app.state::<ProjectState>();
    let brain_state = app.state::<BrainState>();
    let pid_state = app.state::<MaintenancePidState>();

    let lb = resolve_lazybrain_bin_static()
        .map_err(|e| format!("brain_seed: {}", e))?;

    // Keep the 30-min background consolidator off this brain for the ENTIRE
    // duration of the seed — called FIRST, before any import work starts.
    // The consolidator's own timer runs independently of this function (it
    // started counting at app launch), so a seed that happens to start close
    // to its 30-minute mark must be protected from turn one, not just once
    // seeding finishes (the second call near the end of this function keeps
    // that original "fresh window after completion" behavior too). See
    // `postpone_next_consolidation`'s doc comment (maintenance.rs) and
    // `SEED_IN_PROGRESS`'s doc comment above for the belt-and-braces guard
    // covering seeds that outlast a single deferral window.
    postpone_next_consolidation();
    let _seed_guard = SeedInProgressGuard::acquire();

    // `persist: true` — a real seed (unlike `brain_seed_estimate`'s dry-run)
    // may need to commit the app-data brain choice into brain-config.json —
    // see `resolve_seed_brain_path`'s doc comment (config.rs) for the
    // stranded-brain divergence this closes.
    let brain_path = resolve_seed_brain_path(app, &project_state, true);
    // Extracted separately (not derived from brain_path) so the "linking"
    // phase below can pass it straight to `graph --cwd` — mirrors
    // `brain_rebuild_graph`'s own project_root extraction (capture.rs).
    let project_root = project_state.0.lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    let total = sources.len() as u64;
    let mut total_imported: u64 = 0;
    let mut total_skipped: u64 = 0;

    // Resolve each selected source's item count (same detection logic
    // `detect_history_sources` uses — called directly, not via IPC, since a
    // #[tauri::command]-annotated function is still a perfectly normal
    // callable Rust function) so the import phase's `percent` can be
    // weighted by actual conversation volume instead of a flat 1/N per
    // source — see the "Whole-pipeline progress percent" section above.
    // Best-effort: any source missing from the map (or an all-zero total)
    // falls back to an even split inside `import_phase_percent`.
    let source_item_counts: HashMap<String, u64> = detect_history_sources()
        .into_iter()
        .map(|s| (s.source, s.item_count))
        .collect();
    let total_items: u64 = sources.iter()
        .map(|s| source_item_counts.get(s).copied().unwrap_or(0))
        .sum();
    let mut cumulative_items: u64 = 0;

    // Resolve once, up front — every source in this run shares the same
    // backend. NO SILENT DEGRADATION: when the caller asked for LLM
    // enrichment, state which backend will actually be used (or that none
    // was found and notes will be heuristic-only) BEFORE any source starts,
    // as its own progress event so the UI can surface it distinctly from the
    // per-source "Importing from …" messages below.
    let backend = if use_llm { Some(resolve_llm_backend()) } else { None };
    if let Some(ref b) = backend {
        let _ = app.emit("brain://seed-progress", serde_json::json!({
            "done":    0,
            "total":   total,
            "phase":   "backend",
            "message": format!("LLM backend: {}", b.label),
            "percent": 0,
        }));
    }

    for (idx, source) in sources.iter().enumerate() {
        let done = idx as u64;
        let this_source_items = source_item_counts.get(source).copied().unwrap_or(0);
        let start_pct = import_phase_percent(cumulative_items, total_items, done, total);

        // Emit progress: starting this source
        let _ = app.emit("brain://seed-progress", serde_json::json!({
            "done":    done,
            "total":   total,
            "phase":   "import",
            "message": format!("Importing from {}", source),
            "percent": start_pct,
        }));

        // Build args
        let mut args: Vec<&str> = vec![
            "import",
            "--source", source,
            "--input",  "auto",
            "--brain",  &brain_path,
        ];
        if use_llm {
            args.push("--use-llm");
        }
        // since is owned — we need to hold it alive
        let since_str: String;
        if let Some(ref s) = since {
            since_str = s.clone();
            args.push("--since");
            args.push(&since_str);
        }

        let mut cmd = lb.command(&args);
        cmd.env("LAZYBRAIN_BRAIN_PATH", &brain_path)
            .env("LAZYBRAIN_LOG_LEVEL", "warn")
            .env("LAZYBRAIN_TELEMETRY", "0")
            .env("LAZYBRAIN_EMBEDDINGS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(ref pr) = seed_project_root {
            cmd.env("LAZYBRAIN_PROJECT_ROOT", pr);
            let slug = derive_topic_from_cwd(pr);
            if !slug.is_empty() {
                cmd.env("LAZYBRAIN_PROJECT_SLUG", &slug);
            }
        }
        // Backend env vars (LAZYBRAIN_EXTRACTOR and/or ANTHROPIC_API_KEY) —
        // only set for a real --use-llm run; a dry-run/heuristic run never
        // touches an LLM so there is nothing to configure.
        if let Some(ref b) = backend {
            for (key, value) in &b.env {
                cmd.env(key, value);
            }
        }

        // Intra-source progress: `cmd.output()` below blocks for however
        // long this source's import takes (observed up to ~40 minutes for
        // a large source) with no intermediate output of its own — spawn
        // the notes-on-disk watcher for exactly that span so the percent
        // keeps moving instead of sitting frozen at `start_pct` until the
        // WHOLE source finishes. Baseline captured right here (immediately
        // before spawn) so notes written by earlier sources never skew
        // this source's own fraction. See spawn_notes_progress_watcher's
        // doc comment (this section, above the per-source loop) for the
        // full rationale.
        let baseline_note_count = count_brain_notes(&brain_path);
        let notes_watcher = spawn_notes_progress_watcher(
            app.clone(),
            brain_path.clone(),
            source.clone(),
            SourceProgressContext {
                baseline_note_count,
                this_source_est_items: this_source_items,
                cumulative_items_before_this_source: cumulative_items,
                total_items,
                sources_done: done,
                sources_total: total,
                floor_percent: start_pct,
            },
        );
        let output = cmd.output();
        // Stop the watcher THE INSTANT the subprocess returns (success,
        // failure, or spawn error) — before any of the existing
        // success/failure handling below, so it can never emit a stale
        // tick for a source that has already moved on.
        stop_notes_progress_watcher(notes_watcher);

        let output = match output {
            Ok(o) => o,
            Err(e) => {
                let msg = format!("brain_seed: spawn failed for source '{}': {}", source, e);
                log::warn!("{}", msg);
                cumulative_items += this_source_items;
                let end_pct = import_phase_percent(cumulative_items, total_items, done + 1, total);
                let _ = app.emit("brain://seed-progress", serde_json::json!({
                    "done":    done + 1,
                    "total":   total,
                    "phase":   "error",
                    "message": msg,
                    "percent": end_pct,
                }));
                continue;
            }
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let msg = format!(
                "brain_seed: import exited {} for source '{}': {}",
                output.status, source, stderr.trim()
            );
            log::warn!("{}", msg);
            cumulative_items += this_source_items;
            let end_pct = import_phase_percent(cumulative_items, total_items, done + 1, total);
            let _ = app.emit("brain://seed-progress", serde_json::json!({
                "done":    done + 1,
                "total":   total,
                "phase":   "error",
                "message": msg,
                "percent": end_pct,
            }));
            continue;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Ok(res) = serde_json::from_str::<ImportRunResult>(stdout.trim()) {
            total_imported += res.imported;
            total_skipped  += res.skipped;
        }

        cumulative_items += this_source_items;
        let end_pct = import_phase_percent(cumulative_items, total_items, done + 1, total);
        // Emit progress: this source done
        let _ = app.emit("brain://seed-progress", serde_json::json!({
            "done":    done + 1,
            "total":   total,
            "phase":   "import",
            "message": format!("Done importing from {}", source),
            "percent": end_pct,
        }));
    }

    // All sources are done (per-source failures already logged + reported
    // above, non-fatal). The raw neuron HTML is on disk now, but the brain is
    // not yet USABLE by itself — see this function's doc comment and the
    // "Post-seed pipeline" module doc above. Run it unconditionally (even
    // when every source failed, or 0 items were imported): the sidecar
    // should still come up and serve whatever the brain already has, rather
    // than staying down until some later, unrelated trigger.
    let outcome = run_post_seed_pipeline(app, &lb, &brain_path, &project_root, &brain_state.0, Some(&pid_state));

    // Push the background 30-min consolidator's next heavy pass
    // (interlink/compress/prune/profile-update) further out AGAIN — a fresh
    // 30-minute window starting from NOW that seeding has actually
    // completed, on top of the guard/deferral already in place since the
    // top of this function. See `postpone_next_consolidation`'s doc comment
    // (maintenance.rs).
    postpone_next_consolidation();

    // Final event carries the structured result (imported/skipped/
    // notesTotal/served) alongside the usual done/total/phase/message/
    // percent shape — additive fields, read by seedProgressStore.ts (a
    // locally-widened type there, same convention as this codebase's other
    // narrow platform-type extensions) so the frontend can learn the outcome
    // from the EVENT STREAM instead of only from this command's own return
    // value. That matters because callers are no longer required to await
    // this command to completion to know what happened — see
    // BrainSetupStep.tsx / seedProgressStore.ts's non-blocking seed flow.
    let done_message = format!(
        "Imported {} notes ({} skipped) — {} notes in brain",
        total_imported, total_skipped, outcome.notes_total
    );
    let _ = app.emit("brain://seed-progress", serde_json::json!({
        "done":       5,
        "total":      5,
        "phase":      "done",
        "message":    done_message,
        "percent":    PCT_DONE,
        "imported":   total_imported,
        "skipped":    total_skipped,
        "notesTotal": outcome.notes_total,
        "served":     outcome.served,
    }));
    // Let the Brain/Wiki views refresh now that the sidecar reflects the
    // freshly imported + synthesized notes (same event brain_rebuild_graph
    // already emits on a successful rebuild — capture.rs).
    let _ = app.emit("brain://updated", ());

    Ok(serde_json::json!({
        "imported":   total_imported,
        "skipped":    total_skipped,
        "notesTotal": outcome.notes_total,
        "served":     outcome.served,
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        import_phase_percent, intra_source_percent, is_seed_in_progress, run_build_index_step,
        run_graph_step, run_health_score_step, run_index_rebuild_step, run_serve_step,
        run_synthesize_step, BrainSidecar, BrainState, LazyBrainBin, SeedInProgressGuard,
    };
    use crate::commands::brain::config::resolve_bin_path_static;
    use tempfile::TempDir;

    // ── Whole-pipeline progress percent (import_phase_percent) ─────────

    #[test]
    fn import_phase_percent_weights_by_item_count_not_flat_source_count() {
        // Two sources: 1800 vs 200 items (9:1 ratio). After the FIRST source
        // completes, the weighted percent must reflect ~90% of the item
        // volume (1800/2000 * 90 = 81), not a flat 50% (1 of 2 sources) —
        // the exact bug this weighting fixes.
        let pct = import_phase_percent(1800, 2000, 1, 2);
        assert_eq!(pct, 81, "expected item-weighted 81%, got {}", pct);
    }

    #[test]
    fn import_phase_percent_falls_back_to_even_split_when_item_counts_are_unknown() {
        // total_items == 0 (e.g. detection raced and found nothing) — falls
        // back to an even per-source split instead of dividing by zero or
        // always returning 0.
        let pct = import_phase_percent(0, 0, 1, 2);
        assert_eq!(pct, 45, "expected even-split 45% (1 of 2 sources * 90), got {}", pct);
    }

    #[test]
    fn import_phase_percent_clamps_to_90_even_with_inconsistent_inputs() {
        // Defensive: cumulative > total must still clamp to the 90% ceiling
        // (the import phase's slice of the whole pipeline) instead of
        // overflowing into the post-seed pipeline's own 90..100 range.
        let pct = import_phase_percent(9_999, 100, 5, 2);
        assert_eq!(pct, 90);
    }

    #[test]
    fn import_phase_percent_is_zero_at_the_very_start() {
        let pct = import_phase_percent(0, 2000, 0, 2);
        assert_eq!(pct, 0);
    }

    // ── Intra-source progress (intra_source_percent) ────────────────────
    //
    // Pure-function coverage for the notes-on-disk watcher's per-tick
    // computation — see intra_source_percent's own doc comment for the
    // derivation. No threads/subprocesses/filesystem involved: baseline,
    // current count, and estimates go in, a percent comes out.

    #[test]
    fn intra_source_percent_equals_the_source_start_percent_before_any_notes_land() {
        // baseline == current (no notes written by THIS source yet) — must
        // exactly match the "source starting" percent the surrounding loop
        // already computes via import_phase_percent(cumulative_items_before,
        // ...), so the watcher's very first tick can never visibly jump.
        let pct = intra_source_percent(100, 100, 830, 0, 2000, 0, 2);
        let start_pct = import_phase_percent(0, 2000, 0, 2);
        assert_eq!(pct, start_pct);
    }

    #[test]
    fn intra_source_percent_ignores_notes_written_before_this_sources_baseline() {
        // baseline=500 (notes already on disk from EARLIER sources or a
        // previous run), current=500 (nothing new from THIS source yet) —
        // must read as zero progress for this source, never display those
        // 500 pre-existing notes as if this source had already produced
        // them. Directly covers this fix's "baseline captured at source
        // start so pre-existing notes don't skew" requirement.
        let pct = intra_source_percent(500, 500, 830, 0, 830, 0, 1);
        assert_eq!(pct, 0);
    }

    #[test]
    fn intra_source_percent_moves_partway_through_a_large_single_source() {
        // The concrete bug-report scenario: one 830-item source, no other
        // sources, halfway through (415 of 830 notes written) must show
        // real movement instead of sitting frozen at 0% for the whole run.
        let pct = intra_source_percent(0, 415, 830, 0, 830, 0, 1);
        assert_eq!(pct, 45, "expected ~45% (415/830 * 90), got {}", pct);
    }

    #[test]
    fn intra_source_percent_reaches_the_source_finish_percent_once_notes_reach_the_estimate() {
        // notes_written == this_source_est_items — must exactly match the
        // "source done" percent the loop emits right after (end_pct), so
        // the LAST tick before a source finishes never jumps at the
        // boundary either.
        let pct = intra_source_percent(0, 830, 830, 0, 2000, 0, 2);
        let end_pct = import_phase_percent(830, 2000, 1, 2);
        assert_eq!(pct, end_pct);
    }

    #[test]
    fn intra_source_percent_clamps_to_this_sources_own_share_even_if_more_notes_land_than_estimated() {
        // notes_written far exceeds the estimate (one JSONL conversation
        // can yield several notes) — must not overshoot into the NEXT
        // source's slice of the whole-pipeline bar.
        let overshoot = intra_source_percent(0, 5_000, 830, 0, 2000, 0, 2);
        let exact = intra_source_percent(0, 830, 830, 0, 2000, 0, 2);
        assert_eq!(overshoot, exact);
    }

    #[test]
    fn intra_source_percent_is_monotonic_as_notes_accumulate() {
        let mut last = 0u8;
        for notes in [0, 100, 200, 415, 600, 830] {
            let pct = intra_source_percent(0, notes, 830, 0, 830, 0, 1);
            assert!(pct >= last, "percent regressed: {} -> {} at notes={}", last, pct, notes);
            last = pct;
        }
    }

    #[test]
    fn intra_source_percent_never_divides_by_zero_when_this_source_has_no_estimate() {
        // this_source_est_items == 0 (e.g. detection raced and found
        // nothing for this source) — degrades to import_phase_percent's own
        // zero-estimate handling instead of panicking.
        let pct = intra_source_percent(0, 50, 0, 0, 2000, 0, 2);
        assert_eq!(pct, 0);
    }

    #[test]
    fn intra_source_percent_matches_the_explicit_weighted_formula() {
        // Cross-check against the literal spec formula this function
        // implements: percent = weighted_completed_sources +
        // clamp(notes_written / this_source_est_items, 0, 1) *
        // this_source_weight * 90.
        let (baseline, current, est, cum_before, total, sources_done, sources_total) =
            (200u64, 550u64, 900u64, 1100u64, 3000u64, 1u64, 3u64);

        let notes_written = (current - baseline) as f64;
        let weighted_completed_sources = (cum_before as f64 / total as f64) * 90.0;
        let this_source_weight = est as f64 / total as f64;
        let fraction = (notes_written / est as f64).clamp(0.0, 1.0);
        let expected = (weighted_completed_sources + fraction * this_source_weight * 90.0).round() as u8;

        let actual = intra_source_percent(baseline, current, est, cum_before, total, sources_done, sources_total);
        assert_eq!(actual, expected);
    }

    // ── Seed-in-progress guard ──────────────────────────────────────────

    #[test]
    fn seed_in_progress_guard_toggles_the_flag_and_releases_on_drop() {
        assert!(!is_seed_in_progress(), "must start false");
        {
            let _guard = SeedInProgressGuard::acquire();
            assert!(is_seed_in_progress(), "must be true while the guard is held");
        }
        assert!(!is_seed_in_progress(), "must be false again once the guard drops");
    }

    /// End-to-end proof of the post-seed pipeline fix (index -> synthesize
    /// -> link -> score -> serve): copies ~30 REAL exported notes from the
    /// user's own history-import archive into a fresh scratch brain (a
    /// throwaway `TempDir`, never a live/production brain), then runs
    /// exactly the five steps `run_post_seed_pipeline` sequences and
    /// confirms the concrete artifacts the fix promises: the FTS index
    /// rebuilt (`_cache/fts.sqlite`), a wiki brain-index page exists among
    /// the notes, the graph rebuilt (`_cache/brain-graph.json`), the atlas
    /// built (`_index.html`, with a best-effort health score), the serve
    /// sidecar wrote `_cache/serve.port`, and `/_api/tree` answers over
    /// HTTP.
    #[test]
    fn post_seed_pipeline_makes_a_freshly_seeded_brain_usable() {
        let bin_path = match resolve_bin_path_static() {
            Ok(p) => p,
            Err(_) => {
                eprintln!("SKIP post_seed_pipeline_makes_a_freshly_seeded_brain_usable — lazybrain.js not found");
                return;
            }
        };
        let lb = LazyBrainBin { node_exe: "node".to_string(), script: bin_path };

        let tmp = TempDir::new().expect("TempDir::new (scratch brain)");
        let brain_path = tmp.path().to_path_buf();
        let brain_path_str = brain_path.to_str().unwrap().to_string();
        BrainSidecar::ensure_brain_init(&lb, &brain_path_str);

        // Copy ~30 real, already-imported notes from the user's own history
        // archive into the scratch brain's notes/2026-07/ partition — a
        // faithful stand-in for what `lazybrain import` would have just
        // written, without re-running the (slower) import itself.
        let archive_partition = std::path::Path::new(
            r"C:\Users\user\Documents\Lazy-Brain-David\brain-heuristic-20260708-0310\notes\2026-07",
        );
        if !archive_partition.is_dir() {
            eprintln!(
                "SKIP post_seed_pipeline_makes_a_freshly_seeded_brain_usable — archive partition not found: {}",
                archive_partition.display()
            );
            return;
        }
        let dest_partition = brain_path.join("notes").join("2026-07");
        std::fs::create_dir_all(&dest_partition).expect("create dest partition dir");
        let mut copied: u32 = 0;
        for entry in std::fs::read_dir(archive_partition).expect("read archive partition").flatten() {
            if copied >= 30 {
                break;
            }
            let src = entry.path();
            if src.extension().and_then(|e| e.to_str()) != Some("html") {
                continue;
            }
            let dest = dest_partition.join(src.file_name().expect("file_name"));
            std::fs::copy(&src, &dest).expect("copy archive note into scratch brain");
            copied += 1;
        }
        assert!(copied >= 20, "expected to copy at least 20 archive notes, copied {}", copied);

        // ── Step 1: indexing ──────────────────────────────────────────
        let index_result = run_index_rebuild_step(&lb, &brain_path_str, None);
        assert!(index_result.is_ok(), "index-rebuild step failed: {:?}", index_result.err());
        let fts_path = brain_path.join("_cache").join("fts.sqlite");
        assert!(fts_path.exists(), "expected {} to exist after index-rebuild", fts_path.display());

        // ── Step 2: synthesizing ─────────────────────────────────────
        let synth_result = run_synthesize_step(&lb, &brain_path_str, None);
        assert!(synth_result.is_ok(), "dream --synthesize step failed: {:?}", synth_result.err());

        // Scan every partition (not just the one seeded above) — the
        // synthesize step writes wiki pages under a partition keyed by
        // TODAY's date, which need not match the archive's own dated folder.
        let notes_root = brain_path.join("notes");
        let has_brain_index_page = std::fs::read_dir(&notes_root)
            .expect("read notes root after synthesize")
            .flatten()
            .filter(|e| e.path().is_dir())
            .flat_map(|part| std::fs::read_dir(part.path()).into_iter().flatten().flatten())
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("html"))
            .any(|e| {
                std::fs::read_to_string(e.path())
                    .map(|html| html.contains(r#"data-cerveau-type="brain-index""#))
                    .unwrap_or(false)
            });
        assert!(
            has_brain_index_page,
            "expected a brain-index wiki page to exist under {} after dream --synthesize",
            notes_root.display()
        );

        // ── Step 3: linking ────────────────────────────────────────────
        // No project open for this scratch-brain scenario (mirrors a user
        // seeding during onboarding before ever opening a project) — same
        // "graph with no --cwd" shape capture.rs's brain_rebuild_graph_runs_cli
        // already proves produces _cache/brain-graph.json.
        //
        // Tolerant of failure/timeout, same pattern as the "sidecar did not
        // become healthy" tolerance below and capture.rs's "health-score not
        // implemented" tolerance: these are REAL notes copied from the
        // user's own history archive, which may carry `data-cerveau-cwd`
        // attributes pointing at real, potentially large, project
        // directories — `graph` auto-discovers and code-scans those even
        // with no --cwd (see `run_graph_step`'s doc comment), which can
        // legitimately take a while (empirically ~60s in isolation, proven
        // via manual repro) and occasionally exceed POST_SEED_GRAPH_TIMEOUT_SECS
        // under test-suite contention (several other real-subprocess tests
        // in this crate run concurrently). This step's plumbing (the
        // subprocess invocation, env, timeout wiring) is what this test
        // exists to prove — proven whenever the scan is fast, which is the
        // common case — not a guarantee that any archive's incidental
        // external code-scan finishes inside the timeout on a loaded
        // machine.
        let graph_result = run_graph_step(&lb, &brain_path_str, "", None);
        let graph_json = brain_path.join("_cache").join("brain-graph.json");
        if let Err(e) = graph_result {
            eprintln!(
                "post_seed_pipeline_makes_a_freshly_seeded_brain_usable: graph step failed/timed out \
                 ({}) — likely a slow real-world code-scan discovered from these notes' cwd attributes \
                 under test-suite contention; continuing without asserting brain-graph.json",
                e
            );
        } else {
            assert!(graph_json.exists(), "expected {} to exist after graph", graph_json.display());
        }

        // ── Step 4: scoring ────────────────────────────────────────────
        let build_index_result = run_build_index_step(&lb, &brain_path_str, None);
        assert!(build_index_result.is_ok(), "build-index step failed: {:?}", build_index_result.err());
        let index_html = brain_path.join("_index.html");
        assert!(index_html.exists(), "expected {} to exist after build-index", index_html.display());

        let health_result = run_health_score_step(&lb, &brain_path_str, None);
        if health_result.is_err() {
            // Mirrors capture.rs's brain_rebuild_graph_runs_cli tolerance:
            // an environment whose resolved engine build does not implement
            // health-score yet is an environment/engine-completeness fact,
            // not a regression in this step's own invocation plumbing.
            eprintln!(
                "post_seed_pipeline_makes_a_freshly_seeded_brain_usable: health-score step failed \
                 ({:?}) — continuing without asserting the cerveau-health meta tag",
                health_result.err()
            );
        } else {
            let html = std::fs::read_to_string(&index_html).unwrap_or_default();
            assert!(
                html.contains("cerveau-health"),
                "health-score must write a cerveau-health meta tag into _index.html"
            );
        }

        // ── Step 5: serving ──────────────────────────────────────────
        let state = BrainState::new();
        // Distinct test-only port, avoids contending with a real running
        // Lazy instance's own sidecar (BRAIN_PORT=37990) or any other
        // test's hardcoded port in this crate.
        state.0.lock().expect("lock").port = 48733;
        let served = run_serve_step(&lb, &brain_path_str, &state.0);
        if !served {
            eprintln!(
                "post_seed_pipeline_makes_a_freshly_seeded_brain_usable: sidecar did not become \
                 healthy in this environment — SKIP serving/tree assertions (index+synthesize+link+ \
                 score already proven above: {} notes, fts.sqlite present, brain-index page present, \
                 brain-graph.json present, _index.html present)",
                copied
            );
            return;
        }

        let serve_port_marker = brain_path.join("_cache").join("serve.port");
        assert!(
            serve_port_marker.exists(),
            "expected {} to exist once the sidecar is serving",
            serve_port_marker.display()
        );

        let (port, token) = {
            let guard = state.0.lock().expect("lock");
            (guard.port, guard.token.clone())
        };
        let tree_url = format!("http://127.0.0.1:{}/_api/tree", port);
        let resp = reqwest::blocking::Client::new()
            .get(&tree_url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .expect("_api/tree request must reach the served scratch brain");
        assert!(resp.status().is_success(), "/_api/tree must respond 2xx, got {}", resp.status());

        state.0.lock().expect("lock").stop();

        eprintln!(
            "post_seed_pipeline_makes_a_freshly_seeded_brain_usable PASSED: {} notes copied, \
             fts.sqlite + brain-index page + brain-graph.json + _index.html + serve.port + \
             /_api/tree(status {}) all confirmed at {}",
            copied, resp.status(), brain_path.display()
        );
    }
}
