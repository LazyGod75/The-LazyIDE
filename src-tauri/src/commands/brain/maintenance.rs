//! Periodic + on-demand brain consolidation ("dream" maintenance).
//!
//! # History
//! Both call sites here used to run `lazybrain dream --maintain`.
//! `--maintain` is NOT a real flag — dream's actual options are `--dry-run`
//! / `--enrich` / `--max-notes` / `--pretty` / `--synthesize` / `--topic` /
//! `--force` / `--agent` / `--include-cwd-project` (see
//! `engine/src/cli/register-pipeline.ts`). commander.js rejects unknown
//! options and exits non-zero, so this background job has never once
//! completed successfully since it was added: synthesize (wiki), profile
//! updates, and hygiene (prune/compress/interlink) never ran.
//!
//! # The fix
//! Both sites now call [`run_full_maintenance_sequence`], which spawns five
//! REAL CLI subcommands in order, non-fatal per step (mirrors
//! `brain_rebuild_graph`'s existing log-and-continue pattern in
//! `capture.rs`): `dream`, `prune`, `reindex --missing`, `compress`, `interlink`,
//! `profile-update`.
//!
//! # `dream` (not `dream --synthesize`)
//! The obvious-looking choice, `dream --synthesize`, is a trap: reading
//! `engine/src/commands/dream.ts` shows `--synthesize` is a SHORTCUT
//! (`runSynthesizeOnlyShortcut`) that runs ONLY Phase 5 (wiki synthesis) and
//! returns immediately — it explicitly SKIPS Phase 0 (conversation
//! ingestion, including the R5 Claude Code JSONL discovery this module
//! forwards `HOME`/`USERPROFILE` for below) and Phase 0.5 (noise
//! soft-expiry). Plain `dream` (no flags) runs the full pipeline —
//! ingestion, noise cleanup, stub-expansion (no-op without the CLI, see
//! below), TLDR generation (same), contradiction detection, duplicate
//! detection, AND Phase 5 synthesize at the end (`runSynthesizePhase`,
//! called unconditionally) — so plain `dream` is a strict superset of what
//! `--synthesize` alone would give us, and is what actually fulfils "Phase 0
//! ingestion + noise cleanup + Phase 5 synthesis" in one call.
//!
//! # Non-LLM guarantee
//! `LAZYBRAIN_CLAUDE_BIN=_lazybrain_no_llm_` makes
//! `isClaudeCliAvailable()` (engine/src/util/claude-cli.ts) return false, so
//! `dream`'s stub-expansion (Phase 1) and TLDR-generation (Phase 2) phases
//! both no-op (they gate on that flag). The other four steps never call an
//! LLM at all: `prune`/`compress`/`interlink`/`profile-update` were audited
//! (grep for `callClaudeCli`/`isClaudeCliAvailable`/`ANTHROPIC_API_KEY`) and
//! carry no such import. `interlink` and dream's duplicate-detection phase
//! use `embed()` (engine/src/indexer/embeddings.ts), which runs a LOCAL
//! `@huggingface/transformers` (transformers.js/onnxruntime) model, not a
//! paid API — no Anthropic/OpenAI call, no API key required. The model
//! weights are a one-time download from Hugging Face cached under
//! `~/.lazybrain/models`; if never used before on this machine, the first
//! maintenance run may pause to fetch them (network, not cost).
//!
//! # Why `prune --apply` uses a SAFE policy set (not the CLI default)
//! `prune`'s own CLI default is dry-run (`--apply` is opt-in). This module
//! now applies a **guarded** deletion pass: `--apply` with policies that
//! cannot eat ordinary IDE captures. Investigating
//! `engine/src/commands/prune.ts`'s `empty-tldr` policy (one of the policies
//! included when `--policy` is left unset) revealed a real data-loss trap:
//! `hasEmptyTldr()` matches any note with NO `data-section="tldr"` at all —
//! and TLDR generation is entirely LLM-gated (dream Phase 2, disabled by the
//! sentinel above), while notes captured by the IDE itself (`event_to_html`
//! in `capture.rs`) never carry a TLDR section to begin with. Running
//! `prune --apply` unattended with the **default** policy set would therefore
//! delete the large majority of a user's captured neurons. The applied set
//! is `claude-mem-observer,placeholder-noise,session-dream,backup-dirs` —
//! observer residue, prompt-injection placeholders, ephemeral dream sessions,
//! and `notes_backup_*` dirs. `empty-tldr` stays dry-run-only forever here.

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::Timelike;

use crate::commands::brain::config::resolve_lazybrain_bin_static;
use crate::commands::brain::history_import::is_seed_in_progress;
use crate::commands::brain::ops::{record_ops_idle, record_ops_running, record_ops_timed_out};
use crate::commands::brain::sidecar::{LazyBrainBin, brain_path_from_project};
use crate::commands::system_pressure::{self, PressureLevel, PressureTracker};
use crate::commands::util::{
    apply_below_normal_priority, force_kill_pid, quiet_command, tree_kill_args,
    truncate_on_char_boundary,
};
use crate::state::ProjectState;

// ── Maintenance PID tracking (P0.3 — orphan prevention) ───────────
//
// `run_maintenance_step` used to call `cmd.output()` — a blocking spawn+wait
// with no PID tracking. When the IDE exited mid-maintenance (e.g. user closed
// the window during a `dream` run), the child `node lazybrain.js dream` process
// was orphaned: still consuming CPU + up to 7 GB of memory for embeddings,
// with no parent to reap it. QA proved exactly this — a `lazybrain.js dream`
// orphan at 1010s CPU / 7.2 GB after the IDE had already exited.
//
// `MaintenancePidState` mirrors `AgentPidState` (commands/agent.rs): a simple
// HashMap keyed by step name, tree-killed on app exit via
// `kill_tracked_maintenance_pids` (called from lib.rs's `on_window_event`,
// alongside `kill_tracked_agent_pids` and `stop_brain_sidecar_for_exit`).

/// State holding PIDs of active maintenance child processes (step_name -> pid).
/// At most one step runs at a time (guarded by `CONSOLIDATION_IN_PROGRESS`),
/// so this map holds at most one entry — but a Vec/HashMap keeps the pattern
/// extensible and identical to `AgentPidState`.
pub struct MaintenancePidState(pub Arc<Mutex<HashMap<String, u32>>>);

impl Default for MaintenancePidState {
    fn default() -> Self {
        Self::new()
    }
}

impl MaintenancePidState {
    pub fn new() -> Self {
        MaintenancePidState(Arc::new(Mutex::new(HashMap::new())))
    }
}

/// Tree-kill every PID currently tracked in `MaintenancePidState`.
/// Called from the app-exit hook so maintenance children don't survive as
/// orphans. Best-effort — a process may have already exited.
pub(crate) fn kill_tracked_maintenance_pids(state: &MaintenancePidState) {
    let pids: Vec<u32> = match state.0.lock() {
        Ok(map) => map.values().copied().collect(),
        Err(e) => {
            log::warn!("kill_tracked_maintenance_pids: lock failed: {}", e);
            return;
        }
    };
    for pid in pids {
        log::info!("kill_tracked_maintenance_pids: tree-killing pid={}", pid);
        #[cfg(target_os = "windows")]
        {
            let _ = quiet_command("taskkill")
                .args(tree_kill_args(pid))
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::process::Command::new("kill")
                .arg("-9")
                .arg(pid.to_string())
                .output();
        }
    }
}

/// Ceiling for `lazybrain dream` (embeddings + ingestion). Unbounded
/// `wait_with_output()` left 100% CPU / multi-GB orphans after IDE exit.
const DREAM_STEP_TIMEOUT_SECS: u64 = 600;
/// Ceiling for prune / compress / interlink / profile-update.
const MAINTENANCE_STEP_TIMEOUT_SECS: u64 = 180;

fn maintenance_step_timeout_secs(name: &str) -> u64 {
    // `index-rebuild` joins the dream-class ceiling: when the
    // indexer_text_version marker is stale (rules bump — e.g. the
    // distilled-field FTS injection), it performs ONE full re-index of every
    // note file (DOM parse per note), which needs more than 180s on a large
    // brain. On the common incremental path it's seconds — the ceiling only
    // matters on rollout nights.
    if name == "dream" || name == "index-rebuild" {
        DREAM_STEP_TIMEOUT_SECS
    } else {
        MAINTENANCE_STEP_TIMEOUT_SECS
    }
}

/// Poll a spawned child until it exits or `secs` elapse, then collect pipes
/// the way `wait_with_output()` would. Tree-kills on timeout so node + ONNX
/// grandchildren cannot outlive the parent.
fn wait_maintenance_child_with_timeout(
    mut child: std::process::Child,
    secs: u64,
    label: &str,
    brain_path: &str,
) -> Result<std::process::Output, String> {
    let pid = child.id();
    record_ops_running(brain_path, label, pid, secs);
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|e| format!("wait_with_output: {}", e));
            }
            Ok(None) => {}
            Err(e) => return Err(format!("try_wait: {}", e)),
        }
        if Instant::now() >= deadline {
            log::warn!("brain maintenance[{}]: timed out after {}s — killing pid={}", label, secs, pid);
            force_kill_pid(pid);
            let _ = child.kill();
            let _ = child.wait();
            record_ops_timed_out(brain_path, label, pid, secs);
            return Err(format!("{} timed out after {}s", label, secs));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// How often the background consolidation loop fires (seconds of uptime).
/// 30 minutes — long enough to stay out of the way, short enough to stay fresh.
pub(crate) const CONSOLIDATE_INTERVAL_SECS: u64 = 30 * 60;

// ── Dream gating (P0 follow-up) ──────────────────────────────────────
//
// `spawn_brain_consolidator`'s periodic loop used to fire on a plain
// CONSOLIDATE_INTERVAL_SECS uptime timer with no awareness of what else the
// machine was doing, or whether the user was mid-task — the exact opposite
// of the founder-level guarantee that this app never saturates a normal
// user's machine on its own. Three gates below close that, applied ONLY to
// the AUTOMATIC periodic pass (never to `brain_consolidate_now`, the
// explicit "Consolidate now" button — an explicit user request bypasses
// automatic scheduling throttles, same precedent `brain_retry_sidecar`
// already established for `INIT_FAILURE_RETRY_AFTER_SECS`'s cooldown).

/// Local hour (0-23) the night window OPENS — 22:00.
const NIGHT_WINDOW_START_HOUR: u32 = 22;
/// Local hour (0-23) the night window CLOSES — 08:00. The window wraps
/// midnight: `hour >= START || hour < END`, see `is_in_night_window`.
const NIGHT_WINDOW_END_HOUR: u32 = 8;

/// How many CONSECUTIVE minutes of Normal system pressure (see
/// `commands::system_pressure`) must have elapsed before the heavy sequence
/// is allowed to run OUTSIDE the night window.
const IDLE_NORMAL_PRESSURE_MINS: u64 = 30;

/// Pure core of the night-window check — given the local hour, is it inside
/// 22:00-08:00? Extracted so this wraps-past-midnight comparison is
/// unit-tested directly rather than only indirectly through a real
/// `chrono::Local::now()` call (which cannot be pinned to a specific hour in
/// a test).
fn is_in_night_window(local_hour: u32) -> bool {
    local_hour >= NIGHT_WINDOW_START_HOUR || local_hour < NIGHT_WINDOW_END_HOUR
}

/// Whether the automatic background pass is currently allowed to run a
/// heavy maintenance sequence, given the ALREADY-DEBOUNCED system pressure
/// level and how long (in minutes) it has been continuously Normal. Pure —
/// unit-tested directly; `spawn_brain_consolidator`'s loop is the only
/// caller, feeding it real `chrono`/`system_pressure` readings.
fn dream_schedule_allows_run(pressure_level: PressureLevel, idle_normal_mins: u64, local_hour: u32) -> bool {
    if pressure_level != PressureLevel::Normal {
        return false;
    }
    is_in_night_window(local_hour) || idle_normal_mins >= IDLE_NORMAL_PRESSURE_MINS
}

/// Tracks whether the user currently has an active mission/task running
/// (Mission Control, agent runs, ...) — a second, independent gate on top of
/// system pressure: even a perfectly idle-looking machine (low CPU/RAM
/// pressure between an agent's tool calls) should not have the heavy
/// consolidation sequence competing with the user's own in-flight work for
/// disk I/O / the brain's SQLite lock.
///
/// Defaults to `false` (see `MissionsActiveState::new`) — until the frontend
/// mission/scheduler owner wires `set_missions_active(true/false)` into its
/// own mission start/stop lifecycle, this gate never fires and behavior is
/// IDENTICAL to before this fix (matches the fix's own "make the Rust side
/// default to inactive" requirement).
///
/// JS CALL SITE NEEDED (not wired by this change): call
/// `invoke('set_missions_active', { active: true })` when a mission/agent
/// run starts, and `invoke('set_missions_active', { active: false })` when
/// the LAST active one finishes (Mission Control / the scheduler owns
/// knowing "is anything still running").
pub struct MissionsActiveState(pub Arc<AtomicBool>);

impl Default for MissionsActiveState {
    fn default() -> Self {
        Self::new()
    }
}

impl MissionsActiveState {
    pub fn new() -> Self {
        MissionsActiveState(Arc::new(AtomicBool::new(false)))
    }
}

/// Toggle whether the user currently has an active mission — see
/// `MissionsActiveState`'s doc comment for the JS call site this expects.
#[tauri::command]
pub(crate) fn set_missions_active(active: bool, state: tauri::State<MissionsActiveState>) {
    state.0.store(active, Ordering::SeqCst);
}

/// Guards against concurrent consolidation runs (fire-and-forget scheduler
/// AND the manual "Consolidate now" button share this one guard).
static CONSOLIDATION_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Unix-epoch seconds before which the periodic background loop
/// (`spawn_brain_consolidator`) must not START a new pass, even though its
/// normal `CONSOLIDATE_INTERVAL_SECS` timer has already elapsed. `0` (the
/// initial value) means "no deferral requested" — the loop's very first
/// `now >= deadline` check always passes then, so behavior is IDENTICAL to a
/// plain fixed-interval sleep unless something actually calls
/// `postpone_next_consolidation` below.
///
/// Why this exists: `brain_seed` (history_import.rs) now runs a light,
/// bounded post-seed pipeline (index -> synthesize -> serve) synchronously
/// right after a history import, deliberately WITHOUT calling the heavy
/// sequence below (see this module's doc comment for why `interlink`/
/// `compress`/`prune` are expensive). But `spawn_brain_consolidator`'s own
/// 30-minute timer keeps ticking independently from app startup — a user who
/// spends part of their first session in onboarding, then starts exploring a
/// freshly seeded brain, can otherwise have the background loop's FIRST
/// scheduled pass land minutes later, grabbing the brain for tens of minutes
/// (~1.1GB) right as they start using it. `postpone_next_consolidation`
/// pushes that first pass out by another full interval every time a fresh
/// seed completes, so heavy maintenance never lands right on top of one —
/// deferred, never skipped.
static DEFER_CONSOLIDATION_UNTIL_SECS: AtomicU64 = AtomicU64::new(0);

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Push the earliest allowed next background consolidation pass to
/// `CONSOLIDATE_INTERVAL_SECS` from right now. See
/// `DEFER_CONSOLIDATION_UNTIL_SECS`'s doc comment for the race this closes.
/// Called by `brain_seed` (history_import.rs) after every post-seed
/// pipeline run, successful or not — any fresh seed activity is reason
/// enough to give the brain breathing room before the next heavy pass.
///
/// Does NOT touch `CONSOLIDATION_IN_PROGRESS` — a pass already running (rare,
/// but possible if a seed happens to overlap one) is left to finish; this
/// only affects when the NEXT one is allowed to START.
pub(crate) fn postpone_next_consolidation() {
    let new_deadline = now_secs().saturating_add(CONSOLIDATE_INTERVAL_SECS);
    DEFER_CONSOLIDATION_UNTIL_SECS.store(new_deadline, Ordering::SeqCst);
    log::info!(
        "brain maintenance: next background consolidation deferred by a fresh seed (+{}s)",
        CONSOLIDATE_INTERVAL_SECS
    );
}

/// Resolve the user home directory (USERPROFILE on Windows, HOME elsewhere).
fn resolve_user_home() -> Option<String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|s| !s.is_empty())
}

/// R5: forward HOME/USERPROFILE so a bundled node child can discover
/// `~/.claude/projects` for Claude Code conversation ingestion (dream's
/// Phase 0 conversation-source scan). A harmless no-op for steps that don't
/// read it (prune/compress/interlink/profile-update).
fn apply_r5_claude_code_env(cmd: &mut Command) {
    if let Some(home) = resolve_user_home() {
        let claude_projects = std::path::Path::new(&home).join(".claude").join("projects");
        if claude_projects.exists() {
            #[cfg(windows)]
            cmd.env("USERPROFILE", &home);
            #[cfg(not(windows))]
            cmd.env("HOME", &home);
        }
    }
}

/// Outcome of one maintenance step — used for logging and for the summary
/// string `brain_consolidate_now` returns to the Settings UI.
#[derive(Debug)]
struct StepOutcome {
    /// CLI subcommand name, e.g. "dream".
    name: &'static str,
    ok: bool,
    /// Trimmed stdout on success, trimmed stderr (or the spawn error) on failure.
    detail: String,
}

/// Run one `lazybrain <args...>` maintenance step against `brain_path`.
///
/// Non-LLM (sentinel env, see module doc) and never panics or propagates an
/// `Err`: a spawn failure or non-zero exit becomes an `ok: false`
/// `StepOutcome` so callers can log-and-continue — mirrors
/// `brain_rebuild_graph`'s existing per-step pattern (capture.rs) where one
/// bad step must never abort the rest of the sequence.
fn run_maintenance_step(
    lb: &LazyBrainBin,
    brain_path: &str,
    name: &'static str,
    args: &[&str],
    pid_state: Option<&MaintenancePidState>,
) -> StepOutcome {
    let mut cmd = lb.command(args);
    cmd.env("LAZYBRAIN_BRAIN_PATH", brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1")
        .env("LAZYBRAIN_CLAUDE_BIN", "_lazybrain_no_llm_")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_r5_claude_code_env(&mut cmd);
    apply_below_normal_priority(&mut cmd);

    // Spawn + track PID + wait, so the exit hook can tree-kill if the IDE
    // closes mid-step (prevents orphaned dream/embeddings processes).
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let detail = format!("spawn failed: {}", e);
            log::warn!("brain maintenance[{}]: {} (continuing)", name, detail);
            return StepOutcome { name, ok: false, detail };
        }
    };

    let pid = child.id();
    if let Some(state) = pid_state {
        if let Ok(mut map) = state.0.lock() {
            map.insert(name.to_string(), pid);
        }
    }

    let timeout_secs = maintenance_step_timeout_secs(name);
    let result = wait_maintenance_child_with_timeout(child, timeout_secs, name, brain_path)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::TimedOut, e));

    // Untrack regardless of outcome.
    if let Some(state) = pid_state {
        if let Ok(mut map) = state.0.lock() {
            map.remove(name);
        }
    }

    match result {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            log::info!("brain maintenance[{}]: ok", name);
            record_ops_idle(brain_path);
            StepOutcome { name, ok: true, detail: truncate_on_char_boundary(&stdout, 400).to_string() }
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let detail = if stderr.is_empty() { format!("exited {}", out.status) } else { stderr };
            log::warn!("brain maintenance[{}]: {} (continuing)", name, detail);
            record_ops_idle(brain_path);
            StepOutcome { name, ok: false, detail: truncate_on_char_boundary(&detail, 400).to_string() }
        }
        Err(e) => {
            let detail = format!("wait failed: {}", e);
            log::warn!("brain maintenance[{}]: {} (continuing)", name, detail);
            StepOutcome { name, ok: false, detail }
        }
    }
}

/// Policies `--apply` is allowed to delete unattended. MUST NOT include
/// `empty-tldr` (see module doc).
const SAFE_PRUNE_POLICY: &str = "claude-mem-observer,placeholder-noise,session-dream,backup-dirs";
const PRUNE_APPLY_ARGS: &[&str] = &["prune", "--apply", "--policy", SAFE_PRUNE_POLICY];

/// The 6-step sequence, in order: (step name, CLI args).
///
/// `reindex --missing` (engine/src/commands/reindex-missing.ts) reconciles
/// disk vs. SQLite index: several write paths persist note HTML without
/// indexing it (warn-only failures in dream/graph/conv-enrich), and nothing
/// else ever repaired the drift — the resulting disk/index mismatch flips
/// `indexIsTrustworthy()` to false, silently downgrading EVERY structural
/// query to a full O(corpus) scan. The command is idempotent + resumable
/// (re-derives its candidate set from live disk+index state each run), so
/// the 180s step timeout is safe: a large backlog simply converges over
/// successive nightly passes. Runs after `dream` (the heaviest writer) and
/// `prune` (whose deletions it must see), before `compress`/`interlink`
/// (which depend on a trustworthy index). `--delete-ghosts` is deliberately
/// NOT passed: a transient FS-unreadable window would make every indexed
/// row look like a ghost — index-row deletion stays operator-only.
/// The 7-step sequence, in order: (step name, CLI args).
const MAINTENANCE_STEPS: [(&str, &[&str]); 7] = [
    ("dream", &["dream"]),
    ("prune", PRUNE_APPLY_ARGS),
    ("reindex", &["reindex", "--missing", "--no-dry-run"]),
    // Fingerprint-level incremental reconcile (mtime/SHA skip, orphan
    // delete, embed batch) — and the carrier of the indexer_text_version
    // gate: when the FTS text composition rules change, this step forces one
    // full re-index under the new rules so the rollout happens unattended
    // instead of waiting for a manual `index-rebuild --full`. Complements
    // `reindex --missing` (index-vs-disk) with fingerprint-vs-disk coverage.
    // (`index-rebuild` without --full delegates to runIncrementalUpdate —
    // engine/src/commands/index-rebuild.ts.)
    ("index-rebuild", &["index-rebuild"]),
    ("compress", &["compress"]),
    ("interlink", &["interlink"]),
    ("profile-update", &["profile-update"]),
];

/// Attribution fix ("make the supervisor honest"): before every step EXCEPT
/// the first, re-check system pressure and stop the sequence if it is no
/// longer Normal.
///
/// Gate #1 in `spawn_brain_consolidator`'s loop (below) already confirmed
/// Normal pressure before this sequence started — but that check happens
/// ONCE, before `dream` (the first, heaviest step: it holds the embeddings
/// workload documented at the top of this module — a real orphan was
/// measured at 7.2 GB) runs. Without a mid-sequence check, `dream` can push
/// the machine into Elevated/High pressure and the sequence would blindly
/// launch four MORE heavy children (`prune`, `compress`, `interlink`,
/// `profile-update`) on top of an already-strained machine, while the NEXT
/// scheduled periodic pass separately (and correctly) skips itself citing
/// the same pressure reading — so the mitigation only ever throttles work
/// that has not started yet, never the step actually causing the load.
/// Checking between steps closes that gap: the sequence itself backs off the
/// moment ITS OWN prior step is the one that tipped the pressure over, and
/// the warning names that step explicitly instead of leaving the cause
/// implicit.
///
/// `pressure_state` is `None` in tests that don't care about this gate (see
/// `run_full_maintenance_sequence`'s tests) — behavior is then IDENTICAL to
/// before this fix (all 5 steps always attempted).
fn should_stop_before_step(
    step_index: usize,
    previous_step_name: &str,
    pressure_state: Option<&Arc<Mutex<PressureTracker>>>,
) -> bool {
    if step_index == 0 {
        return false;
    }
    let Some(state) = pressure_state else {
        return false;
    };
    let pressure = system_pressure::pressure_snapshot(state);
    if pressure.level == PressureLevel::Normal {
        return false;
    }
    log::warn!(
        "brain maintenance: stopping before step {} — system pressure is {:?} \
         (ram={}MB avail, cpu={:.0}%) right after '{}' ran; this is very likely \
         '{}' itself driving the load, not a foreign process — deferring the \
         remaining steps to the next pass instead of piling more heavy work on",
        step_index + 1,
        pressure.level,
        pressure.available_ram_mb,
        pressure.cpu_pct,
        previous_step_name,
        previous_step_name,
    );
    true
}

/// Run the full non-LLM maintenance sequence against `brain_path`, in order.
/// Each step is independent — see the module doc comment for why each
/// command/flag choice was made (esp. plain `dream` vs `--synthesize`, and
/// `prune`'s dry-run-only default). Stops early (see
/// `should_stop_before_step`) if pressure rises mid-sequence and a
/// `pressure_state` was supplied — the returned `Vec` may then have fewer
/// than 5 entries; callers must not assume a fixed length.
fn run_full_maintenance_sequence(
    lb: &LazyBrainBin,
    brain_path: &str,
    pid_state: Option<&MaintenancePidState>,
    pressure_state: Option<&Arc<Mutex<PressureTracker>>>,
) -> Vec<StepOutcome> {
    let mut outcomes = Vec::with_capacity(MAINTENANCE_STEPS.len());
    for (i, (name, args)) in MAINTENANCE_STEPS.iter().enumerate() {
        if i > 0 && should_stop_before_step(i, MAINTENANCE_STEPS[i - 1].0, pressure_state) {
            break;
        }
        outcomes.push(run_maintenance_step(lb, brain_path, name, args, pid_state));
    }
    outcomes
}

/// Resolve the LazyBrain binary and run the full maintenance sequence
/// against `brain_path`. Returns `Err` only when the binary itself cannot be
/// found (a real environment problem — nothing to run at all); once
/// running, every individual step is non-fatal (see `run_maintenance_step`),
/// so this returns `Ok` past that point even when some/all steps failed.
///
/// Shared by `brain_consolidate_now` (foreground; owns the
/// `CONSOLIDATION_IN_PROGRESS` guard) and `spawn_brain_consolidator`'s
/// periodic loop (background; owns its own copy of the same guard) so both
/// call sites run byte-for-byte the same sequence and can never drift.
fn resolve_and_run_maintenance(
    brain_path: &str,
    pid_state: Option<&MaintenancePidState>,
    pressure_state: Option<&Arc<Mutex<PressureTracker>>>,
) -> Result<Vec<StepOutcome>, String> {
    let lb = resolve_lazybrain_bin_static()?;
    Ok(run_full_maintenance_sequence(&lb, brain_path, pid_state, pressure_state))
}

/// Fold a `Vec<StepOutcome>` into one human-readable line, logging it too.
/// Used as both the log message and the string `brain_consolidate_now`
/// returns to the UI (a plain sentence is enough for a toast).
fn summarize_outcomes(outcomes: &[StepOutcome]) -> String {
    let ok_count = outcomes.iter().filter(|o| o.ok).count();
    let detail = outcomes
        .iter()
        .map(|o| {
            if o.ok {
                format!("{}=ok", o.name)
            } else {
                // Surface WHY a step failed (truncated) so the toast/log is
                // actionable, not just a pass/fail count.
                format!("{}=failed ({})", o.name, truncate_on_char_boundary(&o.detail, 80))
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    log::info!("brain maintenance: {}/{} steps ok ({})", ok_count, outcomes.len(), detail);
    format!("Consolidation complete: {}/{} steps ok ({})", ok_count, outcomes.len(), detail)
}

/// Run the brain maintenance sequence once, on demand (Settings > Memory
/// "Consolidate now" button).
///
/// Guarded by `CONSOLIDATION_IN_PROGRESS`: if the periodic background pass
/// (or another concurrent click) is already running, this returns
/// immediately with an informational message rather than running a second
/// pass in parallel.
#[tauri::command]
pub(crate) fn brain_consolidate_now(
    project_state: tauri::State<ProjectState>,
    pid_state: tauri::State<MaintenancePidState>,
    pressure_state: tauri::State<system_pressure::SystemPressureState>,
) -> Result<String, String> {
    // Never race a history-import seed — see `is_seed_in_progress`'s doc
    // comment (history_import.rs). The periodic background loop below has
    // the identical check; this manual "Consolidate now" button gets it too
    // so BOTH triggers for the heavy sequence stay off an in-progress seed,
    // not just the timer-driven one.
    if is_seed_in_progress() {
        return Ok("a history-import seed is in progress — consolidation skipped".to_string());
    }

    if CONSOLIDATION_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok("consolidation already running — skipped".to_string());
    }

    let brain_path = brain_path_from_project(&project_state);
    let result = resolve_and_run_maintenance(&brain_path, Some(&pid_state), Some(&pressure_state.0))
        .map(|outcomes| summarize_outcomes(&outcomes));

    CONSOLIDATION_IN_PROGRESS.store(false, Ordering::SeqCst);
    result
}

/// Spawn the periodic brain consolidation background task.
///
/// Runs the full maintenance sequence (see module doc) every
/// `CONSOLIDATE_INTERVAL_SECS` seconds of uptime. Only one run at a time
/// (guarded by `CONSOLIDATION_IN_PROGRESS`, shared with `brain_consolidate_now`).
/// Fire-and-forget — errors are logged, never fatal. Off the UI thread via
/// `spawn_blocking` (the sequence shells out to five separate node
/// processes, one after another, which blocks its worker thread for the
/// duration).
///
/// `enabled`: when false the loop exits immediately (feature flag, default ON).
///
/// `pressure_state`/`missions_active` back the two new dream gates (see this
/// module's "Dream gating" section) — passed as raw shared primitives
/// (`Arc<Mutex<...>>` / `Arc<AtomicBool>`), matching `pid_state`'s own
/// established convention for handing shared state into a plain background-
/// thread function with no `tauri::State` extraction available.
pub(crate) fn spawn_brain_consolidator(
    brain_path: String,
    enabled: bool,
    pid_state: Arc<Mutex<HashMap<String, u32>>>,
    pressure_state: Arc<Mutex<PressureTracker>>,
    missions_active: Arc<AtomicBool>,
) {
    if !enabled {
        return;
    }

    tauri::async_runtime::spawn(async move {
        // Initial delay: wait one full interval before the first run so startup
        // is not burdened. The user can trigger immediately via brain_consolidate_now.
        tokio::time::sleep(tokio::time::Duration::from_secs(CONSOLIDATE_INTERVAL_SECS)).await;

        loop {
            // Honor any deferral requested while we were asleep — e.g. a
            // fresh history-import seed (`brain_seed`, history_import.rs)
            // that completed during this window and called
            // `postpone_next_consolidation`. Keep sleeping in
            // CONSOLIDATE_INTERVAL_SECS-sized chunks until the deadline has
            // actually passed instead of running on the original fixed
            // schedule regardless. A no-op loop (never enters the body) when
            // no deferral was ever requested — DEFER_CONSOLIDATION_UNTIL_SECS
            // starts at 0, always in the past — so default behavior/timing
            // is unchanged. See DEFER_CONSOLIDATION_UNTIL_SECS's doc comment.
            while now_secs() < DEFER_CONSOLIDATION_UNTIL_SECS.load(Ordering::SeqCst) {
                tokio::time::sleep(tokio::time::Duration::from_secs(CONSOLIDATE_INTERVAL_SECS)).await;
            }

            // Belt-and-braces: even though `postpone_next_consolidation`
            // (called at both the start and end of `brain_seed`,
            // history_import.rs) already pushed the deadline checked above
            // out, a long seed (a ~2000-note import has been observed taking
            // 40+ minutes) can outlive a single deferral window. Check right
            // before starting a run; if a seed is still active, skip this
            // cycle and defer again instead of racing it — see
            // `is_seed_in_progress`'s doc comment (history_import.rs).
            if is_seed_in_progress() {
                log::info!("brain_consolidator: a history-import seed is in progress — deferring this pass");
                postpone_next_consolidation();
                tokio::time::sleep(tokio::time::Duration::from_secs(CONSOLIDATE_INTERVAL_SECS)).await;
                continue;
            }

            // ── Dream gate #1: system pressure must be Normal ──
            // Reads the already-debounced snapshot (see
            // `commands::system_pressure`'s module doc) — never samples
            // sysinfo directly, so this agrees with every other pressure
            // reader in the app.
            let pressure = system_pressure::pressure_snapshot(&pressure_state);
            if pressure.level != PressureLevel::Normal {
                log::info!(
                    "brain_consolidator: skipped this pass — system pressure is {:?} (ram={}MB avail, cpu={:.0}%)",
                    pressure.level, pressure.available_ram_mb, pressure.cpu_pct
                );
                tokio::time::sleep(tokio::time::Duration::from_secs(CONSOLIDATE_INTERVAL_SECS)).await;
                continue;
            }

            // ── Dream gate #2: no active user mission ──
            if missions_active.load(Ordering::SeqCst) {
                log::info!("brain_consolidator: skipped this pass — a user mission is active");
                tokio::time::sleep(tokio::time::Duration::from_secs(CONSOLIDATE_INTERVAL_SECS)).await;
                continue;
            }

            // ── Dream gate #3: night window (22:00-08:00) OR 30+ min of ──
            // ── Normal-pressure idle ──
            let local_hour = chrono::Local::now().hour();
            let idle_mins = system_pressure::minutes_since_last_non_normal(&pressure_state);
            if !dream_schedule_allows_run(pressure.level, idle_mins, local_hour) {
                log::info!(
                    "brain_consolidator: skipped this pass — outside the 22:00-08:00 night window and only {} min of Normal-pressure idle (need {}+)",
                    idle_mins, IDLE_NORMAL_PRESSURE_MINS
                );
                tokio::time::sleep(tokio::time::Duration::from_secs(CONSOLIDATE_INTERVAL_SECS)).await;
                continue;
            }

            if CONSOLIDATION_IN_PROGRESS
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                let brain_clone = brain_path.clone();
                let pid_clone = Arc::clone(&pid_state);
                let pressure_clone = Arc::clone(&pressure_state);
                tokio::task::spawn_blocking(move || {
                    let pid_ref = MaintenancePidState(pid_clone);
                    match resolve_and_run_maintenance(&brain_clone, Some(&pid_ref), Some(&pressure_clone)) {
                        Ok(outcomes) => {
                            summarize_outcomes(&outcomes);
                        }
                        Err(e) => log::warn!("brain_consolidator: {}", e),
                    }
                    CONSOLIDATION_IN_PROGRESS.store(false, Ordering::SeqCst);
                });
            } else {
                log::info!("brain_consolidator: skipped (another run in progress)");
            }

            tokio::time::sleep(tokio::time::Duration::from_secs(CONSOLIDATE_INTERVAL_SECS)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::brain::config::resolve_bin_path_static;
    use crate::commands::system_pressure::tracker_with_level_for_test;
    use crate::commands::util::quiet_command;
    use std::io::Write as IoWrite;
    use tempfile::TempDir;

    /// A deliberately-unknown subcommand/flag must degrade to a non-fatal
    /// `StepOutcome` — never panic, never propagate a hard error. This is a
    /// direct regression test for the exact bug class this module fixes:
    /// the OLD code called `dream --maintain`, a flag commander.js has
    /// always rejected (see engine/src/cli/register-pipeline.ts's real
    /// `dream` options), and that failure was silently fatal to the entire
    /// consolidation pass. Reproduces the historic call verbatim.
    #[test]
    fn run_maintenance_step_rejects_unknown_maintain_flag_without_panicking() {
        let bin_path = match resolve_bin_path_static() {
            Ok(p) => p,
            Err(_) => {
                eprintln!("SKIP run_maintenance_step_rejects_unknown_maintain_flag_without_panicking — lazybrain.js not found");
                return;
            }
        };
        let lb = LazyBrainBin { node_exe: "node".to_string(), script: bin_path };

        let tmp = TempDir::new().expect("TempDir::new");
        let brain_path = tmp.path().to_str().unwrap().to_string();
        init_brain(&lb, &brain_path);

        // Isolate from this machine's real ~/.claude/projects — commander.js
        // rejects the unknown `--maintain` option before any phase logic
        // runs, so this should be moot, but the guard is cheap insurance
        // against ever depending on real personal data (see
        // fake_home_without_claude_projects's doc comment).
        let _home_guard = fake_home_without_claude_projects(&tmp);

        let outcome = run_maintenance_step(&lb, &brain_path, "dream", &["dream", "--maintain"], None);

        assert!(!outcome.ok, "the historic `--maintain` flag must be reported as a failed step, got ok=true");
        assert!(
            !outcome.detail.is_empty(),
            "a failed step must carry a non-empty detail message (the commander.js rejection text)"
        );
        eprintln!(
            "run_maintenance_step_rejects_unknown_maintain_flag_without_panicking PASSED: detail={:?}",
            outcome.detail
        );
    }

    /// End-to-end proof that the real fix works: init a brain, store one
    /// neuron, then run the full 6-step sequence and assert every step
    /// completed (none aborted the sequence) and that `profile-update`
    /// actually created `_user-profile.html` — the concrete artifact this
    /// whole feature exists to produce.
    #[test]
    fn run_full_maintenance_sequence_completes_and_creates_profile() {
        let bin_path = match resolve_bin_path_static() {
            Ok(p) => p,
            Err(_) => {
                eprintln!("SKIP run_full_maintenance_sequence_completes_and_creates_profile — lazybrain.js not found");
                return;
            }
        };
        let lb = LazyBrainBin { node_exe: "node".to_string(), script: bin_path };

        let tmp = TempDir::new().expect("TempDir::new");
        let brain_path = tmp.path().to_str().unwrap().to_string();
        init_brain(&lb, &brain_path);
        let note_path = store_test_neuron(&lb, &brain_path, "maintenance-seq-sentinel");

        // ISOLATION: without this, the spawned `dream` step inherits this
        // process's real USERPROFILE — since the claude-code source reads it
        // natively (see apply_r5_claude_code_env's doc comment) — and Phase 0
        // would scan THIS MACHINE's real ~/.claude/projects conversation
        // history into this throwaway temp brain. Harmless to the real data
        // (read-only scan) but makes the test slow and non-deterministic,
        // and violates "test on throwaway brains" in spirit. Pointing
        // USERPROFILE/HOME at a fresh directory with no `.claude/projects`
        // subfolder makes the claude-code source find nothing, deterministically.
        let _home_guard = fake_home_without_claude_projects(&tmp);

        let outcomes = run_full_maintenance_sequence(&lb, &brain_path, None, None);

        assert_eq!(outcomes.len(), 7, "sequence must run exactly 7 steps");
        let names: Vec<&str> = outcomes.iter().map(|o| o.name).collect();
        assert_eq!(
            names,
            vec![
                "dream",
                "prune",
                "reindex",
                "index-rebuild",
                "compress",
                "interlink",
                "profile-update"
            ],
            "steps must run in this exact order"
        );
        for o in &outcomes {
            assert!(o.ok, "step '{}' must succeed on a freshly-initialized brain with 1 note, got: {}", o.name, o.detail);
        }

        let profile_path = tmp.path().join("_user-profile.html");
        assert!(
            profile_path.exists(),
            "profile-update step must create _user-profile.html in {}, not found",
            tmp.path().display()
        );
        assert!(
            note_path.exists(),
            "safe prune --apply must not delete an ordinary IDE capture (no empty-tldr): {}",
            note_path.display()
        );

        eprintln!(
            "run_full_maintenance_sequence_completes_and_creates_profile PASSED: {:?}",
            outcomes
        );
    }

    // ── Mid-sequence pressure-abort ("make the supervisor honest") ──────

    /// `should_stop_before_step` must never stop the FIRST step (index 0) —
    /// gate #1 in `spawn_brain_consolidator`'s loop already confirmed Normal
    /// pressure before the sequence started, so `dream` always gets to run.
    #[test]
    fn should_stop_before_step_never_stops_the_first_step() {
        let high = tracker_with_level_for_test(PressureLevel::High);
        assert!(
            !should_stop_before_step(0, "n/a", Some(&high)),
            "step 0 must always run regardless of pressure"
        );
        eprintln!("should_stop_before_step_never_stops_the_first_step PASSED");
    }

    /// With no `pressure_state` supplied (the two existing tests above),
    /// behavior must be byte-for-byte identical to before this fix: every
    /// step always runs.
    #[test]
    fn should_stop_before_step_never_stops_when_no_pressure_state_supplied() {
        assert!(!should_stop_before_step(1, "dream", None));
        assert!(!should_stop_before_step(4, "interlink", None));
        eprintln!("should_stop_before_step_never_stops_when_no_pressure_state_supplied PASSED");
    }

    /// Core fix: once pressure is non-Normal AFTER an earlier step ran, a
    /// later step must be stopped — this is the exact scenario the module
    /// doc describes (`dream` itself drives pressure up; the sequence must
    /// not blindly launch four more heavy children on top of it).
    #[test]
    fn should_stop_before_step_stops_when_pressure_is_elevated_mid_sequence() {
        let elevated = tracker_with_level_for_test(PressureLevel::Elevated);
        assert!(should_stop_before_step(1, "dream", Some(&elevated)));

        let high = tracker_with_level_for_test(PressureLevel::High);
        assert!(should_stop_before_step(2, "prune", Some(&high)));
        eprintln!("should_stop_before_step_stops_when_pressure_is_elevated_mid_sequence PASSED");
    }

    /// Normal pressure mid-sequence must never stop a later step.
    #[test]
    fn should_stop_before_step_allows_continuation_when_pressure_stays_normal() {
        let normal = tracker_with_level_for_test(PressureLevel::Normal);
        assert!(!should_stop_before_step(1, "dream", Some(&normal)));
        eprintln!("should_stop_before_step_allows_continuation_when_pressure_stays_normal PASSED");
    }

    /// End-to-end proof on the real 6-step sequence: with pressure already
    /// non-Normal, `run_full_maintenance_sequence` must run ONLY the first
    /// step (`dream`) and stop — never reaching `prune`/`compress`/
    /// `interlink`/`profile-update`. Uses a real brain + real binary (like
    /// `run_full_maintenance_sequence_completes_and_creates_profile` above)
    /// so this proves the actual wiring, not just the pure gate function.
    #[test]
    fn run_full_maintenance_sequence_stops_early_under_non_normal_pressure() {
        let bin_path = match resolve_bin_path_static() {
            Ok(p) => p,
            Err(_) => {
                eprintln!(
                    "SKIP run_full_maintenance_sequence_stops_early_under_non_normal_pressure — lazybrain.js not found"
                );
                return;
            }
        };
        let lb = LazyBrainBin { node_exe: "node".to_string(), script: bin_path };

        let tmp = TempDir::new().expect("TempDir::new");
        let brain_path = tmp.path().to_str().unwrap().to_string();
        init_brain(&lb, &brain_path);
        store_test_neuron(&lb, &brain_path, "pressure-abort-sentinel");
        let _home_guard = fake_home_without_claude_projects(&tmp);

        let high = tracker_with_level_for_test(PressureLevel::High);
        let outcomes = run_full_maintenance_sequence(&lb, &brain_path, None, Some(&high));

        assert_eq!(
            outcomes.len(),
            1,
            "only the first step ('dream') must run when pressure is already High \
             before the second step's gate check; got {:?}",
            outcomes
        );
        assert_eq!(outcomes[0].name, "dream");
        eprintln!(
            "run_full_maintenance_sequence_stops_early_under_non_normal_pressure PASSED: {:?}",
            outcomes
        );
    }

    /// `CONSOLIDATION_IN_PROGRESS` must gate concurrent runs: while the flag
    /// is held, `brain_consolidate_now`-style compare_exchange must fail so
    /// a second caller gets the "already running" short-circuit instead of
    /// racing the first pass.
    #[test]
    fn consolidation_guard_blocks_concurrent_acquisition() {
        let first = CONSOLIDATION_IN_PROGRESS.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst);
        assert!(first.is_ok(), "first acquisition must succeed");

        let second = CONSOLIDATION_IN_PROGRESS.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst);
        assert!(second.is_err(), "second concurrent acquisition must fail while the first still holds the guard");

        // Release for any other test in this binary that shares the same static.
        CONSOLIDATION_IN_PROGRESS.store(false, Ordering::SeqCst);
        eprintln!("consolidation_guard_blocks_concurrent_acquisition PASSED");
    }

    /// `is_seed_in_progress` (history_import.rs, `pub(crate)`) must be
    /// reachable from this module — the consolidator loop above and
    /// `brain_consolidate_now` both call it right before starting a heavy
    /// pass. Nothing in this test binary run has acquired
    /// history_import.rs's private `SeedInProgressGuard` (it is only
    /// constructed inside `brain_seed` itself, which this test never calls),
    /// so the flag must read false — the guard's own true/false toggle
    /// behavior is proven directly in history_import.rs's
    /// `seed_in_progress_guard_toggles_the_flag_and_releases_on_drop` test.
    #[test]
    fn is_seed_in_progress_is_reachable_from_maintenance_and_defaults_false() {
        assert!(!is_seed_in_progress());
        eprintln!("is_seed_in_progress_is_reachable_from_maintenance_and_defaults_false PASSED");
    }

    /// `postpone_next_consolidation` must push
    /// `DEFER_CONSOLIDATION_UNTIL_SECS` to (approximately) `now +
    /// CONSOLIDATE_INTERVAL_SECS`, and each call must move it further out —
    /// the exact property `brain_seed` (history_import.rs) depends on to
    /// keep the background loop's heavy pass off a freshly seeded brain.
    #[test]
    fn postpone_next_consolidation_pushes_the_deadline_forward() {
        let before = now_secs();
        postpone_next_consolidation();
        let first_deadline = DEFER_CONSOLIDATION_UNTIL_SECS.load(Ordering::SeqCst);

        assert!(
            first_deadline >= before + CONSOLIDATE_INTERVAL_SECS,
            "deadline must be at least now + CONSOLIDATE_INTERVAL_SECS, got {} (before={})",
            first_deadline, before
        );

        // A second call (e.g. a second source's seed finishing later) must
        // push the deadline further out, never backward.
        postpone_next_consolidation();
        let second_deadline = DEFER_CONSOLIDATION_UNTIL_SECS.load(Ordering::SeqCst);
        assert!(
            second_deadline >= first_deadline,
            "a second postpone call must never move the deadline backward (first={}, second={})",
            first_deadline, second_deadline
        );

        // Reset for any other test in this binary that shares the same static.
        DEFER_CONSOLIDATION_UNTIL_SECS.store(0, Ordering::SeqCst);
        eprintln!(
            "postpone_next_consolidation_pushes_the_deadline_forward PASSED (first={}, second={})",
            first_deadline, second_deadline
        );
    }

    #[test]
    fn prune_apply_args_are_guarded_against_empty_tldr() {
        let prune = MAINTENANCE_STEPS
            .iter()
            .find(|(name, _)| *name == "prune")
            .expect("prune step");
        let joined = prune.1.join(" ");
        assert!(joined.contains("--apply"), "unattended prune must actually apply: {joined}");
        assert!(joined.contains("--policy"), "unattended prune must pin policies: {joined}");
        assert!(
            joined.contains("claude-mem-observer"),
            "safe set includes observer residue: {joined}"
        );
        assert!(
            !joined.contains("empty-tldr"),
            "empty-tldr would delete IDE captures with no TLDR: {joined}"
        );
        assert_eq!(maintenance_step_timeout_secs("dream"), DREAM_STEP_TIMEOUT_SECS);
        assert_eq!(maintenance_step_timeout_secs("prune"), MAINTENANCE_STEP_TIMEOUT_SECS);
        eprintln!("prune_apply_args_are_guarded_against_empty_tldr PASSED ({joined})");
    }

    #[test]
    fn wait_maintenance_child_with_timeout_kills_a_slow_process() {
        let mut cmd = if cfg!(windows) {
            let mut c = std::process::Command::new("powershell");
            c.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 20"]);
            c
        } else {
            let mut c = std::process::Command::new("sleep");
            c.arg("20");
            c
        };
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let child = cmd.spawn().expect("spawn slow process");
        let start = Instant::now();
        let result = wait_maintenance_child_with_timeout(child, 1, "test-timeout", "");
        let elapsed = start.elapsed();
        assert!(result.is_err(), "slow child must time out, got {result:?}");
        assert!(
            elapsed < Duration::from_secs(18),
            "must not wait out the full 20s sleep — took {:?}",
            elapsed
        );
        eprintln!("wait_maintenance_child_with_timeout_kills_a_slow_process PASSED (elapsed={:?})", elapsed);
    }

    // ── Dream gating (night window / pressure / missions) ───────────

    #[test]
    fn is_in_night_window_accepts_hours_at_and_after_22() {
        assert!(is_in_night_window(22));
        assert!(is_in_night_window(23));
        eprintln!("is_in_night_window_accepts_hours_at_and_after_22 PASSED");
    }

    #[test]
    fn is_in_night_window_accepts_hours_before_8() {
        assert!(is_in_night_window(0));
        assert!(is_in_night_window(7));
        eprintln!("is_in_night_window_accepts_hours_before_8 PASSED");
    }

    #[test]
    fn is_in_night_window_rejects_daytime_hours() {
        assert!(!is_in_night_window(8), "8 itself is the window's closing hour, not inside it");
        assert!(!is_in_night_window(14));
        assert!(!is_in_night_window(21), "21 is still before the 22:00 opening hour");
        eprintln!("is_in_night_window_rejects_daytime_hours PASSED");
    }

    #[test]
    fn dream_schedule_allows_run_blocks_when_pressure_is_not_normal_even_at_night() {
        assert!(
            !dream_schedule_allows_run(PressureLevel::High, 999, 23),
            "non-Normal pressure must block the run regardless of time-of-day or idle minutes"
        );
        eprintln!("dream_schedule_allows_run_blocks_when_pressure_is_not_normal_even_at_night PASSED");
    }

    #[test]
    fn dream_schedule_allows_run_during_the_night_window_regardless_of_idle_minutes() {
        assert!(
            dream_schedule_allows_run(PressureLevel::Normal, 0, 23),
            "inside the night window, 0 idle minutes must still be allowed"
        );
        eprintln!("dream_schedule_allows_run_during_the_night_window_regardless_of_idle_minutes PASSED");
    }

    #[test]
    fn dream_schedule_allows_run_outside_night_window_once_idle_long_enough() {
        assert!(
            dream_schedule_allows_run(PressureLevel::Normal, IDLE_NORMAL_PRESSURE_MINS, 14),
            "daytime is allowed once idle minutes reach the threshold"
        );
        eprintln!("dream_schedule_allows_run_outside_night_window_once_idle_long_enough PASSED");
    }

    #[test]
    fn dream_schedule_allows_run_blocks_daytime_when_not_yet_idle_long_enough() {
        assert!(
            !dream_schedule_allows_run(PressureLevel::Normal, IDLE_NORMAL_PRESSURE_MINS - 1, 14),
            "daytime with Normal pressure but not-yet-30-minutes idle must still be blocked"
        );
        eprintln!("dream_schedule_allows_run_blocks_daytime_when_not_yet_idle_long_enough PASSED");
    }

    // ── MissionsActiveState / set_missions_active ───────────────────

    #[test]
    fn missions_active_state_defaults_to_false() {
        let state = MissionsActiveState::new();
        assert!(!state.0.load(Ordering::SeqCst), "must default to inactive so behavior without the JS call site is unchanged");
        eprintln!("missions_active_state_defaults_to_false PASSED");
    }

    #[test]
    fn missions_active_state_toggles_via_the_shared_flag() {
        let state = MissionsActiveState::new();
        state.0.store(true, Ordering::SeqCst);
        assert!(state.0.load(Ordering::SeqCst));
        state.0.store(false, Ordering::SeqCst);
        assert!(!state.0.load(Ordering::SeqCst));
        eprintln!("missions_active_state_toggles_via_the_shared_flag PASSED");
    }

    // ── shared test helpers ──────────────────────────────────────────

    /// RAII guard that sets a process env var and restores its ORIGINAL
    /// value (or removes it, if it was unset) on drop — including on panic,
    /// since `Drop::drop` still runs during unwinding. Needed because
    /// `resolve_user_home()` reads `std::env::var` directly (no
    /// dependency-injection seam), so the only way to make a spawned child
    /// see a fake USERPROFILE/HOME is to actually change this TEST PROCESS's
    /// own env var for the duration of the call (child processes inherit it).
    struct EnvVarGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &std::path::Path) -> Self {
            let original = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, original }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }

    /// Point USERPROFILE (and HOME, for parity on non-Windows) at a fresh
    /// subdirectory of `tmp` that deliberately has NO `.claude/projects`
    /// folder, so `apply_r5_claude_code_env`'s existence check — and the
    /// claude-code conversation source dream's Phase 0 reads natively — both
    /// find nothing. Isolates tests from this developer machine's real
    /// (per-repo-memory: very large) `~/.claude/projects` history so a
    /// maintenance-sequence test stays fast and deterministic instead of
    /// scanning real personal data into a throwaway brain.
    fn fake_home_without_claude_projects(tmp: &TempDir) -> (EnvVarGuard, EnvVarGuard) {
        let fake_home = tmp.path().join("fake-home-no-claude-dir");
        std::fs::create_dir_all(&fake_home).expect("create fake home dir");
        (
            EnvVarGuard::set("USERPROFILE", &fake_home),
            EnvVarGuard::set("HOME", &fake_home),
        )
    }

    fn init_brain(lb: &LazyBrainBin, brain_path: &str) {
        let status = quiet_command("node")
            .args([&lb.script, "init", "--brain", brain_path])
            .env("LAZYBRAIN_BRAIN_PATH", brain_path)
            .env("LAZYBRAIN_LOG_LEVEL", "warn")
            .env("LAZYBRAIN_TELEMETRY", "0")
            .env("LAZYBRAIN_EMBEDDINGS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("lazybrain init failed to spawn");
        assert!(status.success(), "lazybrain init failed: {}", status);
    }

    /// Stores a test neuron and returns the resolved on-disk path (parsed
    /// from `store`'s own JSON stdout, e.g. `{"id":...,"path":"...",...}`) —
    /// needed by tests that must backdate the file's mtime afterward.
    fn store_test_neuron(lb: &LazyBrainBin, brain_path: &str, title: &str) -> std::path::PathBuf {
        let html = format!(
            r#"<article id="{title}"
         data-cerveau-version="0.1.0"
         data-cerveau-created="2026-01-01T00:00:00Z"
         data-cerveau-updated="2026-01-01T00:00:00Z"
         data-cerveau-type="episodic"
         data-cerveau-source="lazy-ide:test"
         data-cerveau-tier="working"
         data-cerveau-importance="0.6"
         data-cerveau-tags="test maintenance">
  <h2>{title}</h2>
  <p data-cerveau-fact data-cerveau-confidence="1.0" data-cerveau-extracted-by="human">
    Automated maintenance-sequence test neuron with enough real prose to survive dream's noise filter.
  </p>
</article>
"#,
            title = title
        );

        let mut child = quiet_command("node")
            .args([&lb.script, "store"])
            .env("LAZYBRAIN_BRAIN_PATH", brain_path)
            .env("LAZYBRAIN_LOG_LEVEL", "warn")
            .env("LAZYBRAIN_TELEMETRY", "0")
            .env("LAZYBRAIN_EMBEDDINGS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("lazybrain store failed to spawn");
        child.stdin.take().unwrap().write_all(html.as_bytes()).expect("stdin write");
        let out = child.wait_with_output().expect("wait_with_output");
        assert!(out.status.success(), "lazybrain store failed: {}", out.status);

        let stdout = String::from_utf8_lossy(&out.stdout);
        let json: serde_json::Value = serde_json::from_str(stdout.trim())
            .expect("store stdout is not valid JSON");
        let path = json["path"].as_str().expect("store output missing path field");
        std::path::PathBuf::from(path)
    }

    /// Regression test for a real bug found while proving this feature
    /// works: `indexNote()` (engine/src/indexer/note-index.ts) only
    /// recognized `<article>`/`<section>` as valid note roots, but
    /// `compress`'s own consolidated-batch output is rooted at
    /// `<memory-batch>` (engine/src/commands/compress.ts) — so
    /// `runCompress`'s own `indexNote(readNote(path))` call, made right
    /// after writing a real batch, threw "No root element in note
    /// ...batch-*.html" every time compress had a genuine (non-noop)
    /// candidate to archive. The default `compress` (no `--older-than-days`
    /// override, matching `run_full_maintenance_sequence`'s own wiring)
    /// only reaches that code path once a note is > 7 days old — a fresh
    /// note always short-circuits to `{"status":"noop",...}` beforehand,
    /// which is why `run_full_maintenance_sequence_completes_and_creates_profile`
    /// above (fresh notes) could not have caught this. Fixed by adding
    /// `memory-batch` to indexNote's selector, matching the convention
    /// already used by schema/scrubber.ts. This test backdates a note's
    /// mtime past the 7-day cutoff so the REAL archive path actually runs.
    #[test]
    fn compress_step_succeeds_once_a_note_is_old_enough_to_be_a_real_candidate() {
        let bin_path = match resolve_bin_path_static() {
            Ok(p) => p,
            Err(_) => {
                eprintln!("SKIP compress_step_succeeds_once_a_note_is_old_enough_to_be_a_real_candidate — lazybrain.js not found");
                return;
            }
        };
        let lb = LazyBrainBin { node_exe: "node".to_string(), script: bin_path };

        let tmp = TempDir::new().expect("TempDir::new");
        let brain_path = tmp.path().to_str().unwrap().to_string();
        init_brain(&lb, &brain_path);
        let note_path = store_test_neuron(&lb, &brain_path, "compress-candidate-sentinel");

        // Backdate past compress's default 7-day threshold. runCompress
        // filters on filesystem mtime (`n.mtimeMs < cutoff`), not the HTML's
        // data-cerveau-created attribute, so this is the correct lever.
        // NOTE: must open with write access — a plain (read-only) File::open
        // handle lacks FILE_WRITE_ATTRIBUTES on Windows, so set_modified()
        // fails with "Access denied" (OS error 5) on a read-only handle.
        let eight_days_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 86_400);
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&note_path)
            .expect("open stored note (write mode) to backdate mtime");
        file.set_modified(eight_days_ago).expect("set_modified (backdate mtime)");
        drop(file);

        let outcome = run_maintenance_step(&lb, &brain_path, "compress", &["compress"], None);

        assert!(
            outcome.ok,
            "compress must succeed once it has a real (non-noop) candidate to archive — \
             a regression of the indexNote/memory-batch root-element bug fails here with \
             'No root element in note ...batch-*.html'; got: {}",
            outcome.detail
        );
        assert!(
            !outcome.detail.contains("noop"),
            "this test's entire point is to exercise the REAL archive path (not the noop/\
             no-candidates short-circuit) — got: {}",
            outcome.detail
        );

        eprintln!(
            "compress_step_succeeds_once_a_note_is_old_enough_to_be_a_real_candidate PASSED: {}",
            outcome.detail
        );
    }
}
