//! Background auto-indexing for a freshly-opened project.
//!
//! `set_project` (commands/brain/config.rs) already runs `ensure_brain_init`
//! on every project open, but `init` only creates the brain's directory
//! skeleton — it never populates it. Without this module, a brand new brain
//! stays empty forever unless the user manually runs `lazybrain graph` /
//! uses the capture UI, which defeats the point of the engine's `graph
//! --cwd` fresh-folder tree-sitter scan.
//!
//! `spawn_auto_index_if_needed` is the single entry point: called from
//! `set_project` right after the sidecar restarts, it decides (via
//! `should_auto_index`) whether the resolved brain — of ANY source
//! (project/global/custom/env_override/home_fallback; see
//! `classify_brain_source`, config.rs) — needs indexing, and if so runs the
//! pipeline (`graph --cwd` -> `index-rebuild` -> `build-index` ->
//! `health-score`) on a background OS thread so project open is never
//! blocked.
//!
//! WIDENED SCOPE (per-project marker): auto-index used to fire ONLY for an
//! EMPTY project-mode brain — a global/custom/env-override/home-fallback
//! brain (any brain a user pointed Lazy at via Settings > Memory, an env
//! var, or the new-user home-directory default) was NEVER code-scanned, and
//! a NON-empty brain (e.g. one just seeded from onboarding conversation
//! history — see `resolve_seed_brain_path`, config.rs, and the post-seed
//! pipeline, history_import.rs) was never scanned for a newly opened project
//! either, even though it had never had THAT project's code linked into it.
//! `should_auto_index` now fires whenever the brain is EMPTY *or* this
//! specific `project_root` has no entry yet in
//! `<brain>/_cache/auto-indexed-projects.json` (see
//! `mark_project_auto_indexed` / `is_project_auto_indexed` below) — a
//! per-(brain, project) marker written only after a successful pipeline run,
//! so a brain shared across several projects (e.g. a "global" brain) gets
//! each project's code linked in exactly once, and a failed/partial run is
//! correctly retried on the next open instead of being silently skipped
//! forever.
//!
//! Progress is reported to the frontend via the `brain://indexing` Tauri
//! event (`{status: "started"|"done"|"failed", notes?: number}`), consumed
//! by `IndexingBanner` (src/components/brain/IndexingBanner.tsx).
//!
//! BUG FIX (warm sidecar staleness): `graph --cwd`/`index-rebuild` above run
//! as SEPARATE, short-lived CLI subprocesses against the brain's on-disk
//! files, while the `lazybrain serve` sidecar `set_project` already started
//! (BEFORE this pipeline ever runs) is a long-lived process that resolves
//! some state exactly once per process lifetime — most notably the ONNX
//! semantic embedder, which LATCHES permanently unavailable on its first
//! failed resolution (see `embedderUnavailable` in
//! engine/src/indexer/embeddings.ts) with no retry. If that first attempt
//! (fired automatically right after `serve` starts listening) fails for any
//! reason, semantic recall (L3, and any hybrid level folding it in) silently
//! and PERMANENTLY degrades to keyword-only search for that process's
//! entire remaining lifetime — a query with no literal keyword overlap with
//! the freshly auto-indexed notes then genuinely returns zero hits, even
//! though the notes are present and fully indexed on disk. See
//! `reload_sidecar_after_auto_index`'s doc comment for the full mechanism
//! and the empirical proof this fix is based on. Once `run_auto_index_pipeline`
//! reports new notes, `run_auto_index` restarts the warm sidecar (via the
//! same lock-free `start_or_restart_brain_sidecar` project switches use) so
//! it re-resolves everything — embedder included — from scratch.
//!
//! COLD-START RACE FIX (first post-restart query hard-timing-out): even
//! with the restart above, the FIRST real query after it could still race
//! the new process's own embedder cold-load and hard-fail at the frontend's
//! 32s ceiling (`BRAIN_RECALL_TIMEOUT_MS`, src/lib/models/brainSearchLoop.ts)
//! instead of getting a real answer — for two compounding reasons, found by
//! empirical timing (see the cold-start investigation this fix is based on:
//! an idle dev machine with a warm model-file disk cache still showed a
//! measurable, avoidable ~0.6-1.1s cost on the first hybrid query after a
//! restart, versus ~10-15ms once the embedder was pre-warmed — and the
//! engine's own serve.ts comment documents a worst case up to ~24s cold).
//! First, `brain://indexing: "done"` used to fire the INSTANT the CLI
//! pipeline exited — before the restart above had even begun — so a
//! question asked right as that (premature) "done" banner appeared could
//! race the entire restart+cold-load window with no patience at all.
//! Second, the brief connection-refused gap between the old sidecar being
//! killed and the new one accepting connections (empirically ~1-1.5s) had
//! no retry on the recall path (see `recall_from_warm_sidecar_patient`,
//! commands/brain/search.rs) — a query landing in that gap fell straight
//! through to the cold CLI subprocess fallback, which pays an entirely
//! REDUNDANT full model load in a brand-new process instead of just waiting
//! the ~1-2s for the sidecar that was already loading the same model.
//!
//! Fixed on two sides: `run_auto_index` now emits `"done"` only AFTER the
//! restart (and, on success, an explicit embedder warmup —
//! `warm_up_sidecar_embedder` below) has finished, so "done" is an honest
//! "safe to ask now" signal; and `recall_from_warm_sidecar_patient`
//! (search.rs) retries a connection-level failure for a short, bounded
//! window instead of immediately paying for a redundant cold load. Neither
//! change touches the engine — both reuse the existing `/_api/search` HTTP
//! endpoint, which already resolves the SAME memoized `getEmbedder()`
//! promise a real query would (see engine/src/indexer/embeddings.ts's
//! `pipePromise`).

use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde::Deserialize;
use tauri::{Emitter, Manager};

use crate::commands::brain::config::{BrainInfo, count_brain_notes, resolve_lazybrain_bin_static};
use crate::commands::brain::ops::{record_ops_idle, record_ops_running, record_ops_timed_out};
use crate::commands::brain::sidecar::{
    BrainSidecar, LazyBrainBin, http_client_with_timeout, start_or_restart_brain_sidecar,
};
use crate::commands::util::{apply_below_normal_priority, force_kill_pid, stable_path_key};

/// Guards against overlapping auto-index runs — e.g. the user switches
/// project twice in quick succession before the first run finishes, or
/// re-opens the same fresh project before its first index completes.
static AUTO_INDEX_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Ceiling for EACH subprocess step (`graph --cwd`, `index-rebuild`) in the
/// auto-index pipeline. Generous relative to the observed baseline (a 4-file
/// project completes `graph --cwd` in under a second) so a large real-world
/// repository still has headroom; still bounds the background thread's
/// worst-case lifetime so a pathological project (huge monorepo, a stalled
/// network drive) cannot hang it forever.
const AUTO_INDEX_STEP_TIMEOUT_SECS: u64 = 180;

/// Whether a freshly-opened project should be auto-indexed: true when the
/// resolved brain is currently EMPTY (see `count_brain_notes` /
/// `BrainInfo.is_empty`) OR when this specific project has never had a
/// SUCCESSFUL auto-index pass recorded for it in this brain (see
/// `is_project_auto_indexed` / `mark_project_auto_indexed` below). Applies
/// to EVERY brain source — project, global, custom, env_override, and
/// home_fallback alike (see `classify_brain_source`, config.rs) — see this
/// module's doc comment ("WIDENED SCOPE") for why the earlier
/// project-mode-only restriction was removed: a non-project brain being
/// empty, or missing a specific project's code links, is exactly as
/// undiscoverable as a project-mode brain in the same state.
///
/// Pure — takes the already-computed `is_empty` / `project_already_indexed`
/// rather than re-resolving them, so it is unit-testable without touching
/// disk or env vars. Mirrors the pure-core convention used throughout
/// config.rs (`classify_brain_source`, `resolve_brain_path_core`).
pub(crate) fn should_auto_index(is_empty: bool, project_already_indexed: bool) -> bool {
    is_empty || !project_already_indexed
}

/// Filename of the "already auto-indexed" marker, inside the brain's
/// `_cache/` directory — the same directory LazyBrain's own CLI already uses
/// for derived/non-portable state (`_cache/fts.sqlite`,
/// `_cache/brain-graph.json`, `_cache/serve.port`).
const AUTO_INDEXED_PROJECTS_FILENAME: &str = "auto-indexed-projects.json";

/// Map of canonicalized project root -> ISO-8601 timestamp of the last
/// successful auto-index pass for that project into a given brain. Written
/// by `mark_project_auto_indexed`, read by `is_project_auto_indexed` — see
/// `should_auto_index`'s doc comment for why a NON-empty brain still needs
/// this per-project marker (a brain seeded from onboarding conversation
/// history has notes, but has never had THIS project's code scanned into
/// it).
type AutoIndexedProjects = HashMap<String, String>;

fn auto_indexed_projects_path(brain_path: &str) -> std::path::PathBuf {
    Path::new(brain_path).join("_cache").join(AUTO_INDEXED_PROJECTS_FILENAME)
}

/// Read the "already auto-indexed" marker file for `brain_path`. Fails open
/// on any error (missing file, unreadable, invalid JSON, wrong shape) — a
/// corrupt or absent marker must never block or crash auto-indexing; it
/// simply means "nothing recorded yet", same fail-open contract as
/// config.rs's `read_brain_config_at`.
fn read_auto_indexed_projects(brain_path: &str) -> AutoIndexedProjects {
    let path = auto_indexed_projects_path(brain_path);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return AutoIndexedProjects::new(),
    };
    match serde_json::from_str::<AutoIndexedProjects>(&text) {
        Ok(map) => map,
        Err(e) => {
            log::warn!(
                "auto-index: {} is invalid JSON: {} — treating as empty",
                path.display(), e
            );
            AutoIndexedProjects::new()
        }
    }
}

/// True when `project_root` has an entry in `brain_path`'s "already
/// auto-indexed" marker — see `should_auto_index`'s doc comment.
/// Comparison uses [`stable_path_key`] so `C:\`, `C:/`, and `\\?\C:\` are
/// the same project on Windows.
fn is_project_auto_indexed(brain_path: &str, project_root: &str) -> bool {
    let key = stable_path_key(project_root);
    read_auto_indexed_projects(brain_path)
        .keys()
        .any(|existing| stable_path_key(existing) == key)
}

/// Record that `project_root` was successfully auto-indexed into
/// `brain_path`, with the current UTC time (ISO-8601, matches the format
/// `event_to_html` already uses in capture.rs) as the value. Creates
/// `<brain_path>/_cache/` if it does not exist yet. Called ONLY after
/// `run_auto_index_pipeline` reports success — see `run_auto_index`'s call
/// site — so a failed/partial pipeline is correctly retried on the next
/// project open instead of being permanently marked done.
fn mark_project_auto_indexed(brain_path: &str, project_root: &str) -> Result<(), String> {
    let path = auto_indexed_projects_path(brain_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all({}) failed: {}", parent.display(), e))?;
    }
    let mut map = read_auto_indexed_projects(brain_path);
    let key = stable_path_key(project_root);
    map.retain(|existing, _| stable_path_key(existing) != key);
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    map.insert(key, now);
    let json = serde_json::to_string_pretty(&map)
        .map_err(|e| format!("serialize {} failed: {}", AUTO_INDEXED_PROJECTS_FILENAME, e))?;
    std::fs::write(&path, json).map_err(|e| format!("write {} failed: {}", path.display(), e))
}

/// Payload for the `brain://indexing` Tauri event. `notes` is only present
/// on `"done"` — never guessed or estimated for `"started"`/`"failed"`.
#[derive(Serialize, Clone)]
struct IndexingEvent {
    status: &'static str, // "started" | "done" | "failed"
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<u64>,
}

fn emit_indexing_event(app: &tauri::AppHandle, status: &'static str, notes: Option<u64>) {
    if let Err(e) = app.emit("brain://indexing", IndexingEvent { status, notes }) {
        log::warn!("auto-index: emit brain://indexing ({}) failed: {}", status, e);
    }
}

fn try_acquire_auto_index_slot() -> bool {
    AUTO_INDEX_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

fn release_auto_index_slot() {
    AUTO_INDEX_IN_PROGRESS.store(false, Ordering::SeqCst);
}

/// Kick off background auto-indexing for `project_root` when `info` (the
/// `BrainInfo` `set_project` just resolved for this same project) says the
/// brain qualifies (see `should_auto_index` — empty, or this project not yet
/// recorded in `<brain>/_cache/auto-indexed-projects.json`). Never blocks
/// the caller: returns immediately, doing all work — including resolving
/// the lazybrain binary — on a plain OS thread.
///
/// `brain_state` is the app's shared `BrainState.0` handle (see
/// `BrainState` in sidecar.rs) — threaded through so that once the pipeline
/// finishes, `run_auto_index` can restart the SAME warm sidecar `set_project`
/// already started against this brain, so it reflects the notes this pass
/// just wrote. See the module doc comment and
/// `reload_sidecar_after_auto_index` for why a running sidecar needs this
/// nudge.
///
/// Idempotent: a run already in flight (tracked by `AUTO_INDEX_IN_PROGRESS`)
/// makes this a no-op instead of starting a second, overlapping indexing
/// pass. Tolerant of failure by construction: every error path inside the
/// spawned thread is logged and turned into a `brain://indexing` `"failed"`
/// event, never a panic that escapes the thread or affects the caller.
pub(crate) fn spawn_auto_index_if_needed(
    app: tauri::AppHandle,
    info: &BrainInfo,
    project_root: &str,
    brain_state: Arc<Mutex<BrainSidecar>>,
) {
    let already_indexed = is_project_auto_indexed(&info.path, project_root);
    if !should_auto_index(info.is_empty, already_indexed) {
        return;
    }

    if !try_acquire_auto_index_slot() {
        log::info!(
            "auto-index: skipped for '{}' — another run is already in progress",
            project_root
        );
        return;
    }

    let project_root = project_root.to_string();
    let brain_path = info.path.clone();

    std::thread::spawn(move || {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_auto_index(&app, &project_root, &brain_path, &brain_state);
        }));

        release_auto_index_slot();

        if let Err(e) = outcome {
            log::warn!("auto-index: background thread panicked: {:?}", e);
            emit_indexing_event(&app, "failed", None);
        }
    });
}

#[derive(Deserialize)]
struct ActiveBrainConfigFile {
    #[serde(rename = "localDir")]
    local_dir: String,
}

fn is_team_brain_active(app: &tauri::AppHandle, brain_path: &str) -> bool {
    let config_path = match app.path().app_local_data_dir() {
        Ok(d) => d.join("lazy").join("teams").join("active.json"),
        Err(_) => return false,
    };
    let text = match std::fs::read_to_string(&config_path) {
        Ok(t) => t,
        Err(_) => return false,
    };
    let config: ActiveBrainConfigFile = match serde_json::from_str(&text) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let normalized_brain = stable_path_key(brain_path);
    let normalized_local = stable_path_key(&config.local_dir);
    normalized_brain == normalized_local
}

/// Emits `started`, runs the pipeline, restarts + warms the sidecar on a
/// successful pipeline that produced new notes (see
/// `reload_sidecar_after_auto_index`), and only THEN emits `done`/`failed`.
/// Split from `run_auto_index_pipeline` (the part that actually spawns
/// subprocesses) so that function stays unit-testable without a live
/// `AppHandle` — mirrors the pure-core/thin-command split used throughout
/// config.rs (e.g. `get_brain_info_inner` vs `get_brain_info`).
///
/// COLD-START RACE FIX: `"done"` used to fire immediately after the
/// pipeline exited, BEFORE the restart below had even started — see this
/// module's doc comment for the race that let a question asked right at
/// that (premature) signal hard-fail. `"done"` now means "the brain is
/// actually ready to answer", not just "the CLI pipeline exited".
fn run_auto_index(app: &tauri::AppHandle, project_root: &str, brain_path: &str, brain_state: &Arc<Mutex<BrainSidecar>>) {
    log::info!(
        "auto-index: starting for project '{}' (brain '{}')",
        project_root, brain_path
    );
    emit_indexing_event(app, "started", None);

    let lb = match resolve_lazybrain_bin_static() {
        Ok(b) => b,
        Err(e) => {
            log::warn!("auto-index: lazybrain.js not found — skipping: {}", e);
            emit_indexing_event(app, "failed", None);
            return;
        }
    };

    match run_auto_index_pipeline(&lb, project_root, brain_path) {
        Ok(notes) => {
            log::info!("auto-index: complete for '{}' — {} notes", brain_path, notes);

            // Record the per-project marker now that the pipeline succeeded
            // (see `should_auto_index`'s doc comment) — a write failure is
            // logged but must not turn an otherwise-successful pipeline into
            // a "failed" event; worst case, the next project open just
            // re-runs auto-index for this project instead of skipping it.
            if let Err(e) = mark_project_auto_indexed(brain_path, project_root) {
                log::warn!(
                    "auto-index: failed to record auto-indexed-projects.json marker for '{}': {}",
                    project_root, e
                );
            }

            // Only worth restarting/warming when there is something new for
            // the sidecar to reflect — an empty-project scan (notes == 0)
            // leaves the brain exactly as empty as the sidecar already sees
            // it, so there is nothing further to wait for.
            if notes > 0 {
                reload_sidecar_after_auto_index(&lb, brain_path, brain_state);
            }

            if is_team_brain_active(app, brain_path) {
                let _ = app.emit("team-brain-needs-push", ());
            }

            // Reported AFTER the restart+warmup above, not before and not
            // in parallel — see this function's doc comment.
            emit_indexing_event(app, "done", Some(notes));
        }
        Err(e) => {
            log::warn!("{}", e);
            emit_indexing_event(app, "failed", None);
        }
    }
}

/// After a successful auto-index pass writes new notes, restart the brain
/// sidecar so its NEXT query reflects them.
///
/// Root cause: `lazybrain serve` is a long-lived Node process; `graph
/// --cwd`/`index-rebuild` (this module's `run_auto_index_pipeline`) run as
/// SEPARATE, short-lived CLI subprocesses against the same on-disk brain.
/// Raw read access to the SQLite FTS index itself is not the problem — WAL
/// mode lets a long-lived reader see a separate process's committed writes
/// on its very next query (verified empirically: a warm sidecar queried
/// immediately after a separate `graph --cwd` + `index-rebuild` pass, with a
/// working embedder, correctly returns the new notes with no restart).
///
/// The reproducible failure is one layer ABOVE the database: the ONNX
/// semantic embedder is resolved — and, on failure, LATCHED unavailable —
/// exactly once per process (`embedderUnavailable` / `getEmbedder()` in
/// engine/src/indexer/embeddings.ts; the resolution attempt fires
/// automatically right after `serve` starts listening, see the warmup block
/// in engine/src/commands/serve.ts). If that first attempt fails for ANY
/// reason — plausibly including transient contention with this very
/// auto-index pass's own filesystem/model-loading activity — semantic
/// search (L3, and any hybrid level folding it in) silently and
/// PERMANENTLY falls back to keyword-only search for the rest of that
/// process's life; nothing ever retries it. A query with no literal keyword
/// overlap with the new notes then genuinely returns zero hits from
/// `/_api/search`, even though the notes are present and fully indexed on
/// disk — this is the "0 neurons" symptom, and matches "engine search is
/// proven correct via a FRESH-sidecar CLI test": a brand new process
/// re-resolves the embedder from scratch and is not stuck with the stale
/// latch. Restarting sidesteps the exact mechanism entirely rather than
/// depending on diagnosing it precisely on every affected machine — a fresh
/// process re-resolves everything (embedder included) from scratch, so this
/// fix is correct regardless of whether the embedder latch, or some other
/// per-process cache the engine might add later, is the culprit on any
/// given run.
///
/// Delegates to `start_or_restart_brain_sidecar` (sidecar.rs) — the same
/// lock-free-during-the-slow-wait restart `restart_brain_sidecar`
/// (config.rs) uses for project switches — so this never holds
/// `BrainState`'s mutex for the ~5-10s readiness wait; every other brain
/// command stays responsive while the sidecar comes back up.
///
/// Re-entrancy / restart-storm guard: only called from `run_auto_index`,
/// itself only reachable through `spawn_auto_index_if_needed` while
/// `AUTO_INDEX_IN_PROGRESS` is held (released by the caller only AFTER the
/// whole background-thread closure — including this call — returns). This
/// function does not call `spawn_auto_index_if_needed` (directly or
/// indirectly), and neither does the sidecar's own boot sequence, so
/// restarting here cannot itself trigger another auto-index pass or a
/// second restart of its own accord — at most one restart per successful
/// auto-index run.
///
/// Best-effort: a restart that does not become healthy is logged, never
/// propagated as an error — the notes are already safely on disk either
/// way; only the WARM sidecar's view of them would stay stale until the
/// next natural restart (e.g. the user switches projects).
///
/// COLD-START RACE FIX: once the restart itself reports healthy, this also
/// fires a blocking `warm_up_sidecar_embedder` probe against the NEW
/// sidecar before returning — so by the time `run_auto_index` reports
/// `"done"` to the frontend, the process serving that brain has already
/// resolved its embedder, not just started listening. See this module's
/// doc comment for the race this closes.
fn reload_sidecar_after_auto_index(
    lb: &LazyBrainBin,
    brain_path: &str,
    brain_state: &Arc<Mutex<BrainSidecar>>,
) {
    let preferred_port = match brain_state.lock() {
        Ok(s) => s.port,
        Err(e) => {
            log::warn!("auto-index: BrainState lock failed before post-index reload: {}", e);
            return;
        }
    };

    log::info!(
        "auto-index: restarting brain sidecar at '{}' so it reflects freshly indexed notes",
        brain_path
    );
    if !start_or_restart_brain_sidecar(brain_state, lb, brain_path, preferred_port) {
        log::warn!("auto-index: post-index sidecar reload did not become healthy");
        return;
    }

    let (port, token) = match brain_state.lock() {
        Ok(s) => (s.port, s.token.clone()),
        Err(e) => {
            log::warn!("auto-index: BrainState lock failed before embedder warmup: {}", e);
            return;
        }
    };
    warm_up_sidecar_embedder(port, &token);
}

/// Multi-token, natural-language-shaped throwaway query used ONLY to force
/// the retrieval router's `L2_L3_HYBRID` path (see `pickLevel` in
/// engine/src/retrieval/router.ts: 3-15 tokens with no quoted phrase always
/// routes there — the readiness probe's own `q=ping` deliberately does NOT,
/// see `wait_ready_at`'s doc comment in sidecar.rs), so
/// `warm_up_sidecar_embedder` actually resolves the embedder promise a real
/// user question would need, instead of merely confirming the HTTP server
/// answers. Its own response is discarded — only the side effect (the
/// sidecar process's `getEmbedder()` promise resolving — see
/// engine/src/indexer/embeddings.ts) matters.
const EMBEDDER_WARMUP_QUERY: &str = "warm up the semantic search embedder";

/// Timeout for `warm_up_sidecar_embedder`'s blocking probe. Mirrors
/// `RECALL_WARM_TIMEOUT_SECS` (commands/brain/search.rs), sized with
/// headroom over the engine's documented ~24s worst-case cold ONNX load.
/// Safe to block this long here: this runs on the background auto-index
/// thread (see `spawn_auto_index_if_needed`), never on a Tauri command
/// handler, so nothing user-facing waits on it directly — it only delays
/// this project-open's `brain://indexing: "done"` event, which is the whole
/// point (see `run_auto_index`'s doc comment).
const EMBEDDER_WARMUP_TIMEOUT_SECS: u64 = 30;

/// Fire a throwaway multi-token search against the just-restarted sidecar so
/// its embedder (ONNX model load — see the `embedderWarmupStart` block in
/// engine/src/commands/serve.ts) is resolved BEFORE `run_auto_index` reports
/// `"done"` to the frontend, instead of leaving that cold-load cost for the
/// user's own first recall to pay. See this module's doc comment for the
/// full race being fixed.
///
/// Best-effort: any failure (sidecar not actually reachable despite
/// `start_or_restart_brain_sidecar` reporting healthy, request error,
/// timeout) is logged and swallowed — never turns a successful auto-index +
/// restart into a reported failure. `serve.ts` ALSO fires its own
/// fire-and-forget warmup on every boot regardless of this call (this just
/// makes something actually WAIT on that same result before telling the
/// user it is safe to ask); if this probe itself fails, the user's first
/// real recall simply falls back to today's behavior for that one query
/// (`recall_from_warm_sidecar_patient` in search.rs still applies its own
/// short connection-retry on top).
fn warm_up_sidecar_embedder(port: u16, token: &str) {
    let encoded_q = urlencoding::encode(EMBEDDER_WARMUP_QUERY);
    let url = format!("http://127.0.0.1:{}/_api/search?q={}&top=1", port, encoded_q);
    let start = Instant::now();
    match http_client_with_timeout(EMBEDDER_WARMUP_TIMEOUT_SECS)
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
    {
        Ok(resp) => {
            log::info!(
                "auto-index: embedder warmup probe done in {:?} (status {})",
                start.elapsed(),
                resp.status()
            );
        }
        Err(e) => {
            log::warn!(
                "auto-index: embedder warmup probe failed after {:?}: {} — first user recall may pay the cold-load cost instead",
                start.elapsed(),
                e
            );
        }
    }
}

/// The actual pipeline: `graph --cwd <project_root> --format both`
/// (tree-sitter code-scan of a project with no pre-existing notes), then
/// `index-rebuild` (so FTS + semantic search reflect the new notes), then
/// `build-index` + `health-score` (non-fatal — composes the `_index.html`
/// atlas and patches its `cerveau-health` meta tag, mirroring
/// `brain_rebuild_graph`'s (capture.rs) own build-index/health-score
/// sequence and "neither failing here should fail the rebuild" rationale —
/// see that function's doc comment for the empirical proof that
/// `build-index` is the ONLY command that creates `_index.html` from
/// scratch). This is what makes the "start empty" onboarding path (an
/// empty brain seeded with no project open, then a project opened for the
/// first time — see `should_auto_index`) also produce a wiki atlas and a
/// health score, not just searchable notes.
///
/// Returns the resulting note count on success — `graph` and
/// `index-rebuild` are the only steps that can fail this function; a failed
/// `build-index`/`health-score` is logged and swallowed so a project still
/// gets a usable, searchable brain even if the atlas/health score didn't
/// refresh this time.
///
/// Brain path is passed BOTH via `--brain` (the `graph` command supports it
/// — see `brain_fetch_graph_merged` in config.rs for the same established
/// pattern) and via `LAZYBRAIN_BRAIN_PATH` (the only mechanism the other
/// three subcommands use elsewhere in this codebase, e.g.
/// `brain_rebuild_graph` in capture.rs) — belt and suspenders, matching
/// existing call sites exactly rather than inventing a new convention.
fn run_auto_index_pipeline(lb: &LazyBrainBin, project_root: &str, brain_path: &str) -> Result<u64, String> {
    let graph_args: Vec<&str> = vec![
        "graph",
        "--cwd", project_root,
        "--format", "both",
        "--brain", brain_path,
    ];
    let mut graph_cmd = lb.command(&graph_args);
    graph_cmd
        .env("LAZYBRAIN_BRAIN_PATH", brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    if !run_step_with_timeout(&mut graph_cmd, AUTO_INDEX_STEP_TIMEOUT_SECS, "graph --cwd", brain_path) {
        return Err(format!(
            "auto-index: 'graph --cwd {}' failed or timed out (brain '{}')",
            project_root, brain_path
        ));
    }

    let mut rebuild_cmd = lb.command(&["index-rebuild"]);
    rebuild_cmd
        .env("LAZYBRAIN_BRAIN_PATH", brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    if !run_step_with_timeout(&mut rebuild_cmd, AUTO_INDEX_STEP_TIMEOUT_SECS, "index-rebuild", brain_path) {
        return Err(format!(
            "auto-index: 'index-rebuild' failed or timed out (brain '{}')",
            brain_path
        ));
    }

    // Non-fatal from here on — see this function's doc comment. Mirrors
    // brain_rebuild_graph's (capture.rs) build-index -> health-score
    // sequence exactly: build-index first (the only command that creates
    // `_index.html` from scratch), health-score second (only patches an
    // EXISTING `_index.html` — silently no-ops otherwise). Reuses this
    // file's own AUTO_INDEX_STEP_TIMEOUT_SECS — no new constant needed.
    let mut build_index_cmd = lb.command(&["build-index"]);
    build_index_cmd
        .env("LAZYBRAIN_BRAIN_PATH", brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let _ = run_step_with_timeout(&mut build_index_cmd, AUTO_INDEX_STEP_TIMEOUT_SECS, "build-index", brain_path);

    let mut health_score_cmd = lb.command(&["health-score"]);
    health_score_cmd
        .env("LAZYBRAIN_BRAIN_PATH", brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let _ = run_step_with_timeout(&mut health_score_cmd, AUTO_INDEX_STEP_TIMEOUT_SECS, "health-score", brain_path);

    Ok(count_brain_notes(brain_path))
}

/// Spawn `cmd`, poll with `try_wait()` until it exits or `timeout_secs`
/// elapses. Kills the child and returns `false` on timeout or any spawn/exit
/// failure; returns `true` only on a genuine zero exit status.
///
/// Self-contained rather than reusing
/// `commands::brain::search::output_with_timeout` — that helper is private
/// to the `search` module and also captures stdout/stderr, which this call
/// site discards (graph/index-rebuild write to the brain on disk, not
/// stdout). Same poll/kill strategy, adapted to a pass/fail result.
fn run_step_with_timeout(cmd: &mut Command, timeout_secs: u64, label: &str, brain_path: &str) -> bool {
    apply_below_normal_priority(cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("auto-index: '{}' failed to spawn: {}", label, e);
            return false;
        }
    };

    let pid = child.id();
    record_ops_running(brain_path, label, pid, timeout_secs);
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                log::info!("auto-index: '{}' done", label);
                record_ops_idle(brain_path);
                return true;
            }
            Ok(Some(status)) => {
                log::warn!("auto-index: '{}' exited {}", label, status);
                record_ops_idle(brain_path);
                return false;
            }
            Ok(None) => {}
            Err(e) => {
                log::warn!("auto-index: '{}' try_wait failed: {}", label, e);
                return false;
            }
        }

        if Instant::now() >= deadline {
            log::warn!("auto-index: '{}' timed out after {}s — killing", label, timeout_secs);
            force_kill_pid(pid);
            let _ = child.kill();
            let _ = child.wait();
            record_ops_timed_out(brain_path, label, pid, timeout_secs);
            return false;
        }

        std::thread::sleep(Duration::from_millis(200));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;
    use tempfile::TempDir;

    // ── should_auto_index (pure gating logic) ───────────────────────
    //
    // Widened semantics (see this module's "WIDENED SCOPE" doc comment):
    // no more per-source gating — `should_auto_index` now only looks at
    // whether the brain is empty and whether THIS project has a marker
    // recorded yet, for ANY brain source.

    #[test]
    fn should_auto_index_true_when_brain_is_empty_regardless_of_project_marker() {
        assert!(should_auto_index(true, false));
        assert!(
            should_auto_index(true, true),
            "an empty brain must always be (re)indexed, even if some earlier pass already marked this project"
        );
        eprintln!("should_auto_index_true_when_brain_is_empty_regardless_of_project_marker PASSED");
    }

    #[test]
    fn should_auto_index_true_when_non_empty_but_this_project_not_yet_marked() {
        // e.g. a brain seeded from onboarding conversation history: has
        // notes (not empty) but has never had ITS code scanned for this
        // specific project.
        assert!(should_auto_index(false, false));
        eprintln!("should_auto_index_true_when_non_empty_but_this_project_not_yet_marked PASSED");
    }

    #[test]
    fn should_auto_index_false_when_non_empty_and_already_marked() {
        assert!(
            !should_auto_index(false, true),
            "must never re-index a brain/project pair that already succeeded"
        );
        eprintln!("should_auto_index_false_when_non_empty_and_already_marked PASSED");
    }

    // ── auto-indexed-projects.json marker helpers ────────────────────

    #[test]
    fn auto_indexed_projects_marker_treats_missing_file_as_not_indexed() {
        let brain = TempDir::new().expect("TempDir::new (brain)");
        let brain_path = brain.path().to_str().unwrap().to_string();

        assert!(!is_project_auto_indexed(&brain_path, "/some/project"));
        eprintln!("auto_indexed_projects_marker_treats_missing_file_as_not_indexed PASSED");
    }

    #[test]
    fn auto_indexed_projects_marker_treats_corrupt_json_as_not_indexed_without_panicking() {
        let brain = TempDir::new().expect("TempDir::new (brain)");
        let cache_dir = brain.path().join("_cache");
        std::fs::create_dir_all(&cache_dir).expect("create _cache");
        std::fs::write(cache_dir.join(AUTO_INDEXED_PROJECTS_FILENAME), "{ not valid json")
            .expect("write corrupt marker");

        let brain_path = brain.path().to_str().unwrap().to_string();
        assert!(!is_project_auto_indexed(&brain_path, "/anything"));
        eprintln!("auto_indexed_projects_marker_treats_corrupt_json_as_not_indexed_without_panicking PASSED");
    }

    #[test]
    fn auto_indexed_projects_marker_roundtrips_through_mark_and_is_indexed() {
        let brain = TempDir::new().expect("TempDir::new (brain)");
        let brain_path = brain.path().to_str().unwrap().to_string();

        assert!(!is_project_auto_indexed(&brain_path, "/some/project"), "must start un-indexed");

        mark_project_auto_indexed(&brain_path, "/some/project").expect("mark_project_auto_indexed");

        assert!(is_project_auto_indexed(&brain_path, "/some/project"), "must be indexed after marking");
        assert!(
            !is_project_auto_indexed(&brain_path, "/other/project"),
            "a DIFFERENT, never-marked project must not be affected"
        );
        eprintln!("auto_indexed_projects_marker_roundtrips_through_mark_and_is_indexed PASSED");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn auto_indexed_projects_marker_treats_windows_path_aliases_as_the_same_project() {
        let brain = TempDir::new().expect("TempDir::new (brain)");
        let brain_path = brain.path().to_str().unwrap().to_string();

        mark_project_auto_indexed(&brain_path, r"C:\Users\user\demo-shop")
            .expect("mark with backslash path");

        assert!(
            is_project_auto_indexed(&brain_path, "C:/Users/user/demo-shop"),
            "forward-slash open must hit the backslash marker"
        );
        assert!(
            is_project_auto_indexed(&brain_path, r"\\?\C:\Users\user\demo-shop"),
            "verbatim canonicalize() open must hit the same marker"
        );
        assert!(
            is_project_auto_indexed(&brain_path, r"c:\users\user\demo-shop"),
            "drive-letter case must not re-index"
        );

        mark_project_auto_indexed(&brain_path, r"\\?\C:\Users\user\demo-shop")
            .expect("re-mark with verbatim alias");
        let map = read_auto_indexed_projects(&brain_path);
        assert_eq!(
            map.len(),
            1,
            "re-marking an alias must replace, not accumulate keys: {:?}",
            map.keys().collect::<Vec<_>>()
        );
        eprintln!("auto_indexed_projects_marker_treats_windows_path_aliases_as_the_same_project PASSED");
    }

    #[test]
    fn auto_indexed_projects_marker_creates_cache_dir_if_missing() {
        let brain = TempDir::new().expect("TempDir::new (brain)");
        let brain_path = brain.path().to_str().unwrap().to_string();
        assert!(!brain.path().join("_cache").exists());

        mark_project_auto_indexed(&brain_path, "/some/project").expect("mark_project_auto_indexed");

        let marker = brain.path().join("_cache").join(AUTO_INDEXED_PROJECTS_FILENAME);
        assert!(marker.exists(), "expected marker file at {}", marker.display());
        eprintln!("auto_indexed_projects_marker_creates_cache_dir_if_missing PASSED");
    }

    #[test]
    fn auto_indexed_projects_marker_preserves_other_entries_when_adding_a_new_one() {
        let brain = TempDir::new().expect("TempDir::new (brain)");
        let brain_path = brain.path().to_str().unwrap().to_string();

        mark_project_auto_indexed(&brain_path, "/project/a").expect("mark a");
        mark_project_auto_indexed(&brain_path, "/project/b").expect("mark b");

        assert!(is_project_auto_indexed(&brain_path, "/project/a"), "marking b must not drop a");
        assert!(is_project_auto_indexed(&brain_path, "/project/b"));
        eprintln!("auto_indexed_projects_marker_preserves_other_entries_when_adding_a_new_one PASSED");
    }

    #[test]
    fn auto_indexed_projects_marker_timestamp_is_iso8601() {
        let brain = TempDir::new().expect("TempDir::new (brain)");
        let brain_path = brain.path().to_str().unwrap().to_string();

        mark_project_auto_indexed(&brain_path, "/some/project").expect("mark_project_auto_indexed");

        let map = read_auto_indexed_projects(&brain_path);
        let key = crate::commands::util::stable_path_key("/some/project");
        let ts = map.get(&key).expect("entry must exist after marking");
        assert!(
            chrono::DateTime::parse_from_rfc3339(ts).is_ok(),
            "timestamp '{}' must be ISO-8601 (RFC3339)", ts
        );
        eprintln!("auto_indexed_projects_marker_timestamp_is_iso8601 PASSED (ts={})", ts);
    }

    // ── in-flight guard ──────────────────────────────────────────────

    #[test]
    fn auto_index_slot_is_exclusive_until_released() {
        // Start from a known state — AUTO_INDEX_IN_PROGRESS is a
        // process-wide static, and this is the only test in the suite that
        // touches it, but resetting first keeps this test order-independent.
        release_auto_index_slot();

        assert!(try_acquire_auto_index_slot(), "first acquire must succeed");
        assert!(!try_acquire_auto_index_slot(), "second acquire while held must fail");
        release_auto_index_slot();
        assert!(try_acquire_auto_index_slot(), "must be acquirable again after release");
        release_auto_index_slot();

        eprintln!("auto_index_slot_is_exclusive_until_released PASSED");
    }

    // ── run_step_with_timeout ────────────────────────────────────────

    #[test]
    fn run_step_with_timeout_returns_false_for_unspawnable_binary() {
        let mut cmd = StdCommand::new("definitely-not-a-real-binary-xyz");
        assert!(!run_step_with_timeout(&mut cmd, 5, "test-unspawnable", ""));
        eprintln!("run_step_with_timeout_returns_false_for_unspawnable_binary PASSED");
    }

    #[test]
    fn run_step_with_timeout_returns_true_for_fast_successful_process() {
        let mut cmd = if cfg!(windows) {
            let mut c = StdCommand::new("cmd");
            c.args(["/C", "exit", "0"]);
            c
        } else {
            let mut c = StdCommand::new("sh");
            c.args(["-c", "exit 0"]);
            c
        };
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());

        assert!(run_step_with_timeout(&mut cmd, 5, "test-fast-success", ""));
        eprintln!("run_step_with_timeout_returns_true_for_fast_successful_process PASSED");
    }

    #[test]
    fn run_step_with_timeout_returns_false_for_nonzero_exit() {
        let mut cmd = if cfg!(windows) {
            let mut c = StdCommand::new("cmd");
            c.args(["/C", "exit", "1"]);
            c
        } else {
            let mut c = StdCommand::new("sh");
            c.args(["-c", "exit 1"]);
            c
        };
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());

        assert!(!run_step_with_timeout(&mut cmd, 5, "test-nonzero-exit", ""));
        eprintln!("run_step_with_timeout_returns_false_for_nonzero_exit PASSED");
    }

    /// Proves the timeout guard actually KILLS a slow process near the
    /// deadline instead of waiting for it to finish naturally — the "sane
    /// timeout/guard" task 1 requires. Uses PowerShell's Start-Sleep rather
    /// than cmd's `timeout` command: `timeout.exe` refuses to run at all
    /// under redirected stdin ("Input redirection is not supported"), which
    /// would make this test pass for the wrong reason (fast exit, not our
    /// kill logic).
    #[test]
    fn run_step_with_timeout_kills_process_that_exceeds_deadline() {
        let mut cmd = if cfg!(windows) {
            let mut c = StdCommand::new("powershell");
            c.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 20"]);
            c
        } else {
            let mut c = StdCommand::new("sleep");
            c.arg("20");
            c
        };
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());

        let start = Instant::now();
        let ok = run_step_with_timeout(&mut cmd, 1, "test-slow-process", "");
        let elapsed = start.elapsed();

        assert!(!ok, "a process that outlives the deadline must report failure");
        assert!(
            elapsed < Duration::from_secs(10),
            "must kill the process near the 1s deadline, not wait for it to finish naturally (elapsed={:?})",
            elapsed
        );
        eprintln!(
            "run_step_with_timeout_kills_process_that_exceeds_deadline PASSED (elapsed={:?})",
            elapsed
        );
    }

    // ── run_auto_index_pipeline (real subprocess — mirrors capture.rs's
    //    brain_rebuild_graph_runs_cli convention: skip if lazybrain.js is
    //    not available in this environment rather than failing CI) ────

    /// End-to-end proof of the exact `graph --cwd` + `index-rebuild`
    /// invocation this module runs in production: a fresh project directory
    /// with real source files, scanned into a fresh (freshly-initialized,
    /// empty) brain with no pre-existing notes — mirrors the CONTEXT's own
    /// proof case ("a 4-file project -> 3 code neurons in 925ms").
    #[test]
    fn run_auto_index_pipeline_creates_notes_from_fresh_project() {
        use crate::commands::brain::sidecar::BrainSidecar;

        let lb = match resolve_lazybrain_bin_static() {
            Ok(b) => b,
            Err(_) => {
                eprintln!(
                    "SKIP run_auto_index_pipeline_creates_notes_from_fresh_project — lazybrain.js not found"
                );
                return;
            }
        };

        let project = TempDir::new().expect("TempDir::new (project)");
        std::fs::write(
            project.path().join("math.js"),
            "export function add(a, b) {\n  return a + b;\n}\n\nexport function subtract(a, b) {\n  return a - b;\n}\n",
        ).expect("write math.js");
        std::fs::write(
            project.path().join("greet.py"),
            "def greet(name):\n    return f\"Hello, {name}!\"\n",
        ).expect("write greet.py");

        // Fresh (empty) brain, initialized via ensure_brain_init — exactly
        // the state `set_project` leaves behind before deciding whether to
        // auto-index.
        let brain = TempDir::new().expect("TempDir::new (brain)");
        let brain_path = brain.path().to_str().unwrap().to_string();
        BrainSidecar::ensure_brain_init(&lb, &brain_path);

        let project_path = project.path().to_str().unwrap().to_string();

        let result = run_auto_index_pipeline(&lb, &project_path, &brain_path);
        let notes = result.unwrap_or_else(|e| panic!("run_auto_index_pipeline failed: {}", e));

        assert!(
            notes >= 1,
            "expected at least 1 note created from a 2-file project, got {}",
            notes
        );
        assert_eq!(
            count_brain_notes(&brain_path),
            notes,
            "run_auto_index_pipeline's returned count must match count_brain_notes on disk"
        );

        // build-index + health-score are non-fatal (see this function's doc
        // comment) but still expected to succeed in a normal environment —
        // confirm the atlas they produce, tolerating only the same
        // "engine build doesn't implement health-score yet" case
        // capture.rs's brain_rebuild_graph_runs_cli already tolerates.
        let index_html = brain.path().join("_index.html");
        assert!(
            index_html.exists(),
            "expected build-index to create {} after run_auto_index_pipeline",
            index_html.display()
        );

        eprintln!(
            "run_auto_index_pipeline_creates_notes_from_fresh_project PASSED: {} notes created at {}, \
             _index.html present",
            notes, brain_path
        );
    }

    // ── BUG B: reload_sidecar_after_auto_index (warm-sidecar staleness) ──

    /// End-to-end proof of the Bug B fix: start a REAL sidecar against a
    /// REAL (empty) brain — exactly what `set_project`'s `restart_brain_sidecar`
    /// does BEFORE auto-index ever runs — confirm it answers empty, run the
    /// auto-index pipeline as a SEPARATE process against the SAME brain
    /// while the sidecar keeps running (mirrors production timing exactly),
    /// then call `reload_sidecar_after_auto_index` and confirm the SAME
    /// `/_api/search` endpoint the assistant's recall uses now returns the
    /// freshly indexed notes — without this test (or the fix) needing to
    /// know or reproduce the exact per-process staleness mechanism (see
    /// `reload_sidecar_after_auto_index`'s doc comment for the embedder-latch
    /// candidate found by inspection).
    #[test]
    fn reload_sidecar_after_auto_index_makes_warm_sidecar_see_fresh_notes() {
        use crate::commands::brain::sidecar::{BrainSidecar, BrainState};

        let lb = match resolve_lazybrain_bin_static() {
            Ok(b) => b,
            Err(_) => {
                eprintln!(
                    "SKIP reload_sidecar_after_auto_index_makes_warm_sidecar_see_fresh_notes — lazybrain.js not found"
                );
                return;
            }
        };

        // Fresh empty brain + a tiny real project for graph --cwd to scan.
        let brain = TempDir::new().expect("TempDir::new (brain)");
        let brain_path = brain.path().to_str().unwrap().to_string();
        BrainSidecar::ensure_brain_init(&lb, &brain_path);

        let project = TempDir::new().expect("TempDir::new (project)");
        std::fs::write(
            project.path().join("greeter.py"),
            "def greet_visitor(name):\n    return f\"hello {name}\"\n",
        )
        .expect("write greeter.py");
        let project_path = project.path().to_str().unwrap().to_string();

        // Start a REAL warm sidecar against the still-EMPTY brain — mirrors
        // set_project's restart_brain_sidecar, which always runs BEFORE
        // auto-index gets a chance to write anything. Explicit non-default
        // preferred port so this never contends with a real running Lazy
        // instance's own BRAIN_PORT (37990) or any other test's hardcoded port.
        let state = BrainState::new();
        let healthy = start_or_restart_brain_sidecar(&state.0, &lb, &brain_path, 48610);
        if !healthy {
            eprintln!(
                "SKIP reload_sidecar_after_auto_index_makes_warm_sidecar_see_fresh_notes — \
                 sidecar did not become healthy in this environment"
            );
            state.0.lock().expect("lock").stop();
            return;
        }

        let (port, token) = {
            let guard = state.0.lock().expect("lock");
            (guard.port, guard.token.clone())
        };
        let client = reqwest::blocking::Client::new();
        let query_url = format!("http://127.0.0.1:{}/_api/search?q=greet&top=5", port);

        // Baseline: brain is empty, warm sidecar must answer with zero results.
        let before: serde_json::Value = client
            .get(&query_url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .expect("baseline query must reach the warm sidecar")
            .json()
            .expect("baseline response must be valid JSON");
        let before_count = before.get("results").and_then(|r| r.as_array()).map(|a| a.len()).unwrap_or(0);
        assert_eq!(before_count, 0, "brain is empty — warm sidecar must report zero results before auto-index: {:?}", before);

        // Auto-index pipeline, run exactly as production does: a SEPARATE
        // CLI subprocess pair, while the sidecar started above keeps running.
        let notes = run_auto_index_pipeline(&lb, &project_path, &brain_path)
            .unwrap_or_else(|e| panic!("run_auto_index_pipeline failed: {}", e));
        assert!(notes >= 1, "expected at least 1 note from the fixture project, got {}", notes);

        // The fix: reload the warm sidecar so it reflects the fresh notes.
        reload_sidecar_after_auto_index(&lb, &brain_path, &state.0);

        let (port_after, token_after) = {
            let guard = state.0.lock().expect("lock");
            (guard.port, guard.token.clone())
        };
        let query_url_after = format!("http://127.0.0.1:{}/_api/search?q=greet&top=5", port_after);
        let after: serde_json::Value = client
            .get(&query_url_after)
            .header("Authorization", format!("Bearer {}", token_after))
            .send()
            .expect("post-reload query must reach the restarted sidecar")
            .json()
            .expect("post-reload response must be valid JSON");
        let after_count = after.get("results").and_then(|r| r.as_array()).map(|a| a.len()).unwrap_or(0);
        assert!(
            after_count > 0,
            "expected the reloaded sidecar to now return the freshly auto-indexed notes, got 0 results: {:?}",
            after
        );

        // Cleanup: stop whichever child is currently tracked (the post-reload one).
        state.0.lock().expect("lock").stop();

        eprintln!(
            "reload_sidecar_after_auto_index_makes_warm_sidecar_see_fresh_notes PASSED \
             (before={}, after={}, notes={})",
            before_count, after_count, notes
        );
    }

    // ── COLD-START RACE FIX: warmup query contract + embedder pre-warm ──

    /// `warm_up_sidecar_embedder`'s throwaway query must actually route to
    /// `L2_L3_HYBRID` in the engine's `pickLevel` (engine/src/retrieval/router.ts:
    /// 3-15 whitespace tokens, no quoted phrase) — otherwise the probe would
    /// silently do nothing useful (e.g. a 1-2 token query stays pure L2 and
    /// never touches the embedder at all, same as the readiness ping). Pure,
    /// no I/O — locks the contract so a future edit to the constant can't
    /// accidentally stop it from warming anything.
    #[test]
    fn embedder_warmup_query_routes_to_hybrid_level() {
        let tokens: Vec<&str> = EMBEDDER_WARMUP_QUERY.split_whitespace().collect();
        assert!(
            tokens.len() >= 3 && tokens.len() <= 15,
            "warmup query must have 3-15 tokens to hit L2_L3_HYBRID per pickLevel, got {} in '{}'",
            tokens.len(), EMBEDDER_WARMUP_QUERY
        );
        assert!(
            !EMBEDDER_WARMUP_QUERY.contains('"') && !EMBEDDER_WARMUP_QUERY.contains('\''),
            "warmup query must not contain a quoted phrase (pickLevel's hasPhrase check would change routing)"
        );
        eprintln!(
            "embedder_warmup_query_routes_to_hybrid_level PASSED (tokens={}, query='{}')",
            tokens.len(), EMBEDDER_WARMUP_QUERY
        );
    }

    /// End-to-end proof of the cold-start race fix: after
    /// `reload_sidecar_after_auto_index` returns, an IMMEDIATE real
    /// multi-word query against the restarted sidecar must be fast (the
    /// embedder was already resolved by the warmup probe) AND answer with a
    /// real semantic/hybrid level — not silently degraded to keyword-only
    /// L2, which would also be "fast" but for the wrong reason. 10s is a
    /// generous bound (empirically this completes in ~10-20ms on a
    /// disk-cache-warm machine; the point is proving it clears nowhere near
    /// the 24-32s cold-load ceiling this fix removes from the hot path, not
    /// pinning an exact number that could flake under CI/test-suite
    /// contention).
    #[test]
    fn reload_sidecar_after_auto_index_warms_the_embedder_before_returning() {
        use crate::commands::brain::sidecar::{BrainSidecar, BrainState};

        let lb = match resolve_lazybrain_bin_static() {
            Ok(b) => b,
            Err(_) => {
                eprintln!(
                    "SKIP reload_sidecar_after_auto_index_warms_the_embedder_before_returning — lazybrain.js not found"
                );
                return;
            }
        };

        let brain = TempDir::new().expect("TempDir::new (brain)");
        let brain_path = brain.path().to_str().unwrap().to_string();
        BrainSidecar::ensure_brain_init(&lb, &brain_path);

        let project = TempDir::new().expect("TempDir::new (project)");
        std::fs::write(
            project.path().join("auth.js"),
            "export function verifyLogin(username, password) {\n  return checkCredentials(username, password);\n}\n\nexport function createSessionToken(userId) {\n  return `sess_${userId}_${Date.now()}`;\n}\n",
        ).expect("write auth.js");
        std::fs::write(
            project.path().join("payment.js"),
            "export function chargeCard(token, amount) {\n  return billingGateway.charge(token, amount);\n}\n",
        ).expect("write payment.js");
        let project_path = project.path().to_str().unwrap().to_string();

        // Distinct port from reload_sidecar_after_auto_index_makes_warm_sidecar_see_fresh_notes's
        // 48610 so the two tests never contend even if cargo test runs them concurrently.
        let state = BrainState::new();
        let healthy = start_or_restart_brain_sidecar(&state.0, &lb, &brain_path, 48611);
        if !healthy {
            eprintln!(
                "SKIP reload_sidecar_after_auto_index_warms_the_embedder_before_returning — \
                 sidecar did not become healthy in this environment"
            );
            state.0.lock().expect("lock").stop();
            return;
        }

        let notes = run_auto_index_pipeline(&lb, &project_path, &brain_path)
            .unwrap_or_else(|e| panic!("run_auto_index_pipeline failed: {}", e));
        assert!(notes >= 1, "expected at least 1 note from the fixture project, got {}", notes);

        // The fix under test: restart + warm.
        reload_sidecar_after_auto_index(&lb, &brain_path, &state.0);

        let (port, token) = {
            let guard = state.0.lock().expect("lock");
            (guard.port, guard.token.clone())
        };

        // The user's first real question, fired IMMEDIATELY — no extra
        // delay — exactly like the app's frontend does the instant it sees
        // brain://indexing: "done" (which, after this fix, only fires once
        // this whole warm-up has already completed).
        let client = reqwest::blocking::Client::new();
        let query_url = format!(
            "http://127.0.0.1:{}/_api/search?q={}&top=5",
            port,
            urlencoding::encode("how does user authentication work in this project")
        );
        let start = Instant::now();
        let resp: serde_json::Value = client
            .get(&query_url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .expect("first post-warmup query must reach the restarted sidecar")
            .json()
            .expect("response must be valid JSON");
        let elapsed = start.elapsed();

        let results = resp.get("results").and_then(|r| r.as_array()).cloned().unwrap_or_default();
        assert!(!results.is_empty(), "expected the warmed sidecar to find the auth.js note, got: {:?}", resp);
        let level = results[0].get("level").and_then(|l| l.as_str()).unwrap_or("");
        assert!(
            level == "L2_L3_HYBRID" || level == "L3" || level == "L4",
            "expected a real semantic/hybrid level (proving the embedder was actually used, not silently \
             degraded to keyword-only L2), got level='{}' response={:?}",
            level, resp
        );
        assert!(
            elapsed < Duration::from_secs(10),
            "expected the first post-warmup query to be fast (embedder pre-resolved by warm_up_sidecar_embedder), \
             took {:?} — nowhere near the 10s bound this is meant to clear",
            elapsed
        );

        state.0.lock().expect("lock").stop();

        eprintln!(
            "reload_sidecar_after_auto_index_warms_the_embedder_before_returning PASSED \
             (elapsed={:?}, level={}, hits={}, notes={})",
            elapsed, level, results.len(), notes
        );
    }
}
