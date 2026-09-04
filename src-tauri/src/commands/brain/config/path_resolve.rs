//! The canonical brain-path resolver used by recall, search, startup
//! context, and the sidecar (`resolve_unified_brain_path` /
//! `resolve_brain_path_core`), `BrainInfo` / `get_brain_info`, note
//! counting, and the seed-time stranded-brain fix.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::state::ProjectState;

use super::bin_resolve::env_brain_override;
use super::brain_config_file::{BrainConfig, persist_brain_config, ui_persisted_brain_path};
use crate::commands::brain::sidecar::dirs_fallback_brain;

/// Canonical brain-path resolver used by recall, search, startup context, and
/// the sidecar.
///
/// Priority (mirrors the lazybrain CLI convention):
///   1. `LAZYBRAIN_BRAIN_PATH` env var — if set **and** the path exists.
///   2. UI-persisted brain choice (Settings > Memory) — "global" or "custom"
///      mode set via `set_brain_config` / `import_brain_from_github`. Lets a
///      user pick/persist a brain without ever touching the env var above,
///      which still wins if both are present (documented user intent).
///   3. `<project_root>/.lazybrain/brain` — if a project root is provided.
///   4. `~/.lazybrain/brain` — home-directory default (new-user fallback).
///
/// The priority logic itself lives in `resolve_brain_path_core` (pure, takes
/// all three inputs as parameters) so it's unit-testable without real env
/// vars or a config file on disk — this function just gathers the
/// I/O-dependent inputs and delegates.
///
/// Returns the path as a `String`; callers that need to check existence should
/// do so explicitly and surface an actionable error rather than silently
/// returning empty results.
pub(crate) fn resolve_unified_brain_path(project_root: Option<&str>) -> String {
    let env_override = env_brain_override();
    let ui_config_path = ui_persisted_brain_path();
    resolve_brain_path_core(env_override.as_deref(), ui_config_path.as_deref(), project_root)
}

/// Classify which branch of `resolve_unified_brain_path` produced a brain
/// path: env override > UI-persisted config > project-local > home fallback.
///
/// Pure function (no I/O) so it is unit-testable by injecting synthetic
/// `env_override` / `ui_config_path` / `project_root` values instead of
/// depending on this process's actual `LAZYBRAIN_BRAIN_PATH` / persisted
/// config file / `ProjectState`, which vary by machine and would make a test
/// relying on the real environment flaky.
fn classify_brain_source(
    env_override: Option<&str>,
    ui_config_path: Option<&str>,
    project_root: Option<&str>,
) -> &'static str {
    if env_override.is_some() {
        return "env_override";
    }
    if ui_config_path.is_some() {
        return "ui_config";
    }
    match project_root {
        Some(root) if !root.is_empty() => "project",
        _ => "home_fallback",
    }
}

/// Count `.html` note files under `<brain_path>/notes/<partition>/*.html` —
/// mirrors the vendored LazyBrain CLI's own note-counting convention
/// (`notesDir()`/`notePath()` in src/store/paths.ts, and `buildDryRunSummary`
/// in src/commands/wipe.ts, which counts exactly this way for `wipe --dry-run`).
/// Reusing the engine's own on-disk layout means this stays correct without
/// having to guess or invent a new convention.
///
/// Pure filesystem walk — `readdir` only, never reads file contents — so it
/// stays fast even for a brain with several thousand notes, and critically
/// does NOT talk to the sidecar/HTTP. This preserves `get_brain_info`'s
/// documented "fast, Rust-only, does not depend on the sidecar being up"
/// contract (see MemoryPanel.tsx's `fetchBrainInfo` doc comment) — counting
/// notes must never make brain-path resolution depend on a warm sidecar.
///
/// Returns 0 for a brain path that does not exist yet, or whose `notes/`
/// subdirectory is absent or contains no `.html` files — exactly the
/// "resolved a brain but it has 0 notes" case this function exists to
/// detect, which is a DIFFERENT condition from "sidecar down" (a separate
/// signal already available via `health()` / `brain.health()`).
pub(crate) fn count_brain_notes(brain_path: &str) -> u64 {
    let notes_dir = Path::new(brain_path).join("notes");
    let partitions = match fs::read_dir(&notes_dir) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };

    let mut count: u64 = 0;
    for partition in partitions.flatten() {
        let part_path = partition.path();
        if !part_path.is_dir() {
            continue;
        }
        let files = match fs::read_dir(&part_path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for file in files.flatten() {
            let is_html = file
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("html"))
                .unwrap_or(false);
            if is_html {
                count += 1;
            }
        }
    }
    count
}

/// Pure core of `get_brain_info` — takes the already-unlocked project root
/// so it can be composed/tested without a live `tauri::State`. Mirrors the
/// git_status / git_status_inner split used elsewhere in this file.
pub(crate) fn get_brain_info_inner(project_root: Option<&str>) -> BrainInfo {
    let env_override = env_brain_override();
    let ui_config_path = ui_persisted_brain_path();
    let source = classify_brain_source(env_override.as_deref(), ui_config_path.as_deref(), project_root);
    let path = resolve_unified_brain_path(project_root);
    let note_count = count_brain_notes(&path);
    BrainInfo { path, source: source.to_string(), note_count, is_empty: note_count == 0 }
}

/// Return the brain path currently in effect for the active project, plus
/// which resolution branch produced it (env override / project-local / home
/// fallback). Reuses `env_brain_override` and `resolve_unified_brain_path`
/// as-is — no new resolution logic, just surfaces what those already
/// compute, so the UI can be transparent about it.
#[tauri::command]
pub(crate) fn get_brain_info(project_state: tauri::State<ProjectState>) -> Result<BrainInfo, String> {
    let root = project_state.0.lock()
        .map(|g| g.clone())
        .map_err(|e| format!("project state lock failed: {}", e))?;
    let root_opt = if root.is_empty() { None } else { Some(root.as_str()) };
    Ok(get_brain_info_inner(root_opt))
}

/// Brain path + resolution source, for UI transparency (Settings > Memory
/// brain-path display, BrainSpace's "Ce projet" scope badge). See
/// `resolve_unified_brain_path` / `classify_brain_source` for how these are
/// computed — this struct only carries the result across the IPC boundary.
///
/// `note_count`/`is_empty` (see `count_brain_notes`) are the BRAIN
/// DISCOVERABILITY signal: they let the UI distinguish "resolved a brain
/// but it has 0 notes" (actionable — point the user at Settings > Memory)
/// from "sidecar down" (a separate, unrelated failure mode surfaced by
/// `health()` / `brain.health()`) instead of both collapsing into the same
/// indistinguishable "no relevant neurons found".
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BrainInfo {
    pub path: String,
    pub source: String, // "env_override" | "ui_config" | "project" | "home_fallback"
    #[serde(rename = "noteCount")]
    pub note_count: u64,
    #[serde(rename = "isEmpty")]
    pub is_empty: bool,
}

/// Pure priority core shared by `resolve_unified_brain_path`: given the
/// already-resolved env override, UI-config path, and project root, decides
/// which one wins. No I/O — unit-testable with synthetic inputs instead of
/// real env vars / config files, same rationale as `classify_brain_source`.
fn resolve_brain_path_core(
    env_override: Option<&str>,
    ui_config_path: Option<&str>,
    project_root: Option<&str>,
) -> String {
    if let Some(v) = env_override {
        return v.to_string();
    }
    if let Some(p) = ui_config_path.filter(|p| !p.is_empty()) {
        return p.to_string();
    }
    if let Some(root) = project_root {
        if !root.is_empty() {
            return Path::new(root).join(".lazybrain").join("brain").to_string_lossy().into_owned();
        }
    }
    dirs_fallback_brain()
}

// ── Seed-time brain path unification (stranded-brain fix) ────────────────
//
// `resolve_brain_path_core` above (runtime resolution: recall, search,
// every `brain_fetch_*` command) and `resolve_brain_path` (sidecar.rs,
// app-boot resolution) share the SAME first two priority steps — env
// override, then UI-persisted config — but DIVERGE on the final fallback
// when NEITHER is set and no project is open: `resolve_brain_path_core`
// lands on `dirs_fallback_brain()` (`~/.lazybrain/brain`), while
// `resolve_brain_path` lands on `<app_local_data_dir>/lazybrain/brain`
// instead (its own priority step 4, ahead of the identical step-5
// `dirs_fallback_brain()` fallback it also carries).
//
// This is invisible during normal use — a project is almost always open by
// the time any brain command runs — but `brain_seed` (history_import.rs) is
// reachable from onboarding BEFORE the user has ever opened a project. A
// brand-new user who seeds their history there writes every imported note
// into `~/.lazybrain/brain` (via the OLD `brain_path_from_project` ->
// `resolve_unified_brain_path` -> `resolve_brain_path_core` chain), while
// the boot-time sidecar the user actually sees serving the app is already
// running against `<app_local_data_dir>/lazybrain/brain` — a DIFFERENT
// directory. The import genuinely succeeds, but the notes are stranded:
// invisible to the running app until the user opens a project (which
// resolves to a third, also-different, per-project path) or otherwise
// discovers the mismatch.
//
// `resolve_seed_brain_path` closes this gap: at seed time only, it
// resolves to the SAME app-data path the boot sidecar uses instead of the
// home-directory fallback, AND persists that choice into `brain-config.json`
// (the exact mechanism `set_brain_config` already uses) so every LATER
// resolution — boot or runtime, project open or not — agrees on it too.
// `resolve_brain_path_core`'s own priority order is UNCHANGED by this fix.

/// Decision output of `decide_seed_brain_target` — see that function's doc
/// comment for the full rationale. `persist` tells the caller
/// (`resolve_seed_brain_path`) whether this choice needs writing into
/// `brain-config.json` so later resolutions agree with it.
#[derive(Debug, Clone, PartialEq)]
struct SeedBrainTarget {
    path: String,
    persist: bool,
}

/// Pure decision core for `resolve_seed_brain_path`. No I/O — unit-testable
/// with synthetic inputs instead of real env vars / config files / a live
/// `AppHandle`, same rationale as `classify_brain_source` /
/// `resolve_brain_path_core`.
///
/// Mirrors `resolve_brain_path_core`'s env_override > ui_config_path >
/// project_root priority EXACTLY for the first three branches — never
/// reordered (see this section's module doc comment: `resolve_brain_path_core`
/// itself is unchanged by this fix). The only behavior difference is the
/// FINAL fallback branch: when none of the three is set, this substitutes
/// `app_data_brain` (the SAME path `resolve_brain_path` in sidecar.rs falls
/// back to at boot) for `resolve_brain_path_core`'s own
/// `dirs_fallback_brain()` — and marks the result as needing persistence, so
/// a later resolution with still-no-project-open reads the SAME path back
/// from `brain-config.json` instead of independently re-deriving
/// `dirs_fallback_brain()` again.
///
/// `persist` is `true` ONLY for that corrected branch, and only when
/// `app_data_brain` is actually available. Every other branch already
/// resolves to a path some OTHER durable source of truth (an env var, a
/// previously-persisted config, or the current project) already owns —
/// writing `brain-config.json` on top of one of those would be redundant at
/// best and a surprising silent override at worst. When `app_data_brain` is
/// unavailable too (e.g. `app.path().app_local_data_dir()` itself failed),
/// this keeps today's pre-fix behavior exactly: `dirs_fallback_brain()`,
/// `persist: false`.
fn decide_seed_brain_target(
    env_override: Option<String>,
    ui_config_path: Option<String>,
    project_root: Option<&str>,
    app_data_brain: Option<String>,
) -> SeedBrainTarget {
    if let Some(v) = env_override {
        return SeedBrainTarget { path: v, persist: false };
    }
    if let Some(p) = ui_config_path.filter(|p| !p.is_empty()) {
        return SeedBrainTarget { path: p, persist: false };
    }
    if let Some(root) = project_root {
        if !root.is_empty() {
            let path = Path::new(root).join(".lazybrain").join("brain").to_string_lossy().into_owned();
            return SeedBrainTarget { path, persist: false };
        }
    }
    match app_data_brain {
        Some(path) => SeedBrainTarget { path, persist: true },
        None => SeedBrainTarget { path: dirs_fallback_brain(), persist: false },
    }
}

/// Resolve the brain path a first-time `brain_seed` / `brain_seed_estimate`
/// call should target — see this section's module doc comment for the
/// stranded-brain divergence this closes. Gathers the same kind of inputs
/// `resolve_unified_brain_path` / `get_brain_info_inner` already gather
/// (`env_brain_override`, the UI-persisted config, the current project
/// root) plus the boot-time sidecar's own app-data fallback
/// (`app.path().app_local_data_dir()/lazybrain/brain`), then delegates the
/// actual decision to the pure `decide_seed_brain_target` above.
///
/// `persist`: whether to ACT on `SeedBrainTarget::persist` (write
/// `brain-config.json` + `create_dir_all` the brain directory) when the
/// decision calls for it. `brain_seed` (the real import) passes `true`;
/// `brain_seed_estimate` (a read-only dry-run cost estimate, called before
/// the user has committed to seeding at all) passes `false` so it resolves
/// to the exact same path WITHOUT the persistence side effect — an estimate
/// must never silently commit the user to a brain-config.json choice.
pub(crate) fn resolve_seed_brain_path(
    app: &tauri::AppHandle,
    project_state: &ProjectState,
    persist: bool,
) -> String {
    let env_override = env_brain_override();
    let ui_config_path = ui_persisted_brain_path();
    let project_root = project_state.0.lock().map(|g| g.clone()).unwrap_or_default();
    let project_root_opt = if project_root.is_empty() { None } else { Some(project_root.as_str()) };
    let app_data_brain = app.path().app_local_data_dir()
        .ok()
        .map(|d| d.join("lazybrain").join("brain").to_string_lossy().into_owned());

    let target = decide_seed_brain_target(env_override, ui_config_path, project_root_opt, app_data_brain);

    if target.persist && persist {
        log::info!(
            "resolve_seed_brain_path: no project open, no LAZYBRAIN_BRAIN_PATH, and no UI-persisted \
             brain configured — seeding into the app-data brain '{}' and persisting it as the active \
             brain-config.json choice so boot and runtime resolution agree from now on",
            target.path
        );
        if let Err(e) = fs::create_dir_all(&target.path) {
            log::warn!("resolve_seed_brain_path: create_dir_all('{}') failed: {}", target.path, e);
        }
        let config = BrainConfig { mode: "custom".to_string(), path: Some(target.path.clone()) };
        if let Err(e) = persist_brain_config(app, &config) {
            log::warn!("resolve_seed_brain_path: failed to persist brain-config.json: {}", e);
        }
    }

    target.path
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Priority mirrors `resolve_unified_brain_path`: an env override wins
    /// even when a UI config and a project root are also set.
    #[test]
    fn classify_brain_source_env_override_wins_over_project() {
        assert_eq!(
            super::classify_brain_source(Some("/some/global/brain"), Some("/some/ui/brain"), Some("/some/project")),
            "env_override"
        );
        eprintln!("classify_brain_source_env_override_wins_over_project PASSED");
    }

    /// No env override, but a UI-persisted config path → "ui_config", even
    /// when a project root is also set (UI config outranks project-local).
    #[test]
    fn classify_brain_source_ui_config_wins_over_project_and_home() {
        assert_eq!(
            super::classify_brain_source(None, Some("/some/ui/brain"), Some("/some/project")),
            "ui_config"
        );
        assert_eq!(
            super::classify_brain_source(None, Some("/some/ui/brain"), None),
            "ui_config"
        );
        eprintln!("classify_brain_source_ui_config_wins_over_project_and_home PASSED");
    }

    /// No env override, no UI config, but a non-empty project root → "project".
    #[test]
    fn classify_brain_source_project_when_no_override() {
        assert_eq!(
            super::classify_brain_source(None, None, Some("/some/project")),
            "project"
        );
        eprintln!("classify_brain_source_project_when_no_override PASSED");
    }

    /// No env override, no UI config, and no project root (None, or an
    /// empty string — matching ProjectState's unset default before
    /// set_project runs) → "home_fallback".
    #[test]
    fn classify_brain_source_home_fallback_when_nothing_set() {
        assert_eq!(super::classify_brain_source(None, None, None), "home_fallback");
        assert_eq!(super::classify_brain_source(None, None, Some("")), "home_fallback");
        eprintln!("classify_brain_source_home_fallback_when_nothing_set PASSED");
    }

    /// get_brain_info_inner must assemble BrainInfo.path from
    /// resolve_unified_brain_path and BrainInfo.source from
    /// classify_brain_source consistently — verified here with no env
    /// override input (project branch), which is deterministic because
    /// classify_brain_source only consults its parameters, not the
    /// process environment. (get_brain_info_inner still reads the real
    /// LAZYBRAIN_BRAIN_PATH internally for the `env_override` branch,
    /// which is exactly why that branch is not asserted here — see note
    /// above.)
    #[test]
    fn get_brain_info_inner_project_path_matches_resolver() {
        let tmp = TempDir::new().expect("TempDir::new");
        let root = tmp.path().to_str().unwrap().to_string();

        let info = super::get_brain_info_inner(Some(root.as_str()));

        let expected_path = super::resolve_unified_brain_path(Some(root.as_str()));
        assert_eq!(info.path, expected_path);
        // Only assert "project" when this machine has no active env override —
        // otherwise both info.source and expected_path would legitimately be
        // "env_override" / the override path, which is still self-consistent
        // but would make this assertion meaningless either way.
        if std::env::var("LAZYBRAIN_BRAIN_PATH").is_err() {
            assert_eq!(info.source, "project");
        }
        eprintln!("get_brain_info_inner_project_path_matches_resolver PASSED");
    }

    #[test]
    fn resolve_brain_path_core_env_override_wins_over_everything() {
        assert_eq!(
            resolve_brain_path_core(Some("/env/brain"), Some("/ui/brain"), Some("/proj")),
            "/env/brain"
        );
        eprintln!("resolve_brain_path_core_env_override_wins_over_everything PASSED");
    }

    #[test]
    fn resolve_brain_path_core_ui_config_wins_over_project() {
        assert_eq!(
            resolve_brain_path_core(None, Some("/ui/brain"), Some("/proj")),
            "/ui/brain"
        );
        eprintln!("resolve_brain_path_core_ui_config_wins_over_project PASSED");
    }

    #[test]
    fn resolve_brain_path_core_ui_config_wins_over_home_fallback() {
        assert_eq!(resolve_brain_path_core(None, Some("/ui/brain"), None), "/ui/brain");
        eprintln!("resolve_brain_path_core_ui_config_wins_over_home_fallback PASSED");
    }

    #[test]
    fn resolve_brain_path_core_project_wins_when_no_override_or_ui_config() {
        let expected = std::path::Path::new("/proj")
            .join(".lazybrain")
            .join("brain")
            .to_string_lossy()
            .into_owned();
        assert_eq!(resolve_brain_path_core(None, None, Some("/proj")), expected);
        eprintln!("resolve_brain_path_core_project_wins_when_no_override_or_ui_config PASSED");
    }

    #[test]
    fn resolve_brain_path_core_home_fallback_when_nothing_set() {
        assert_eq!(resolve_brain_path_core(None, None, None), super::dirs_fallback_brain());
        assert_eq!(resolve_brain_path_core(None, None, Some("")), super::dirs_fallback_brain());
        eprintln!("resolve_brain_path_core_home_fallback_when_nothing_set PASSED");
    }

    // ── decide_seed_brain_target (seed-time stranded-brain fix) ─────────
    //
    // Covers every branch: the first three must match resolve_brain_path_core
    // exactly (same priority, `persist: false`); only the final fallback
    // branch differs (app-data path instead of dirs_fallback_brain, and
    // `persist: true` when that app-data path is available).

    #[test]
    fn decide_seed_brain_target_env_override_wins_over_everything() {
        let target = decide_seed_brain_target(
            Some("/env/brain".to_string()),
            Some("/ui/brain".to_string()),
            Some("/proj"),
            Some("/app-data/lazybrain/brain".to_string()),
        );
        assert_eq!(target, SeedBrainTarget { path: "/env/brain".to_string(), persist: false });
        eprintln!("decide_seed_brain_target_env_override_wins_over_everything PASSED");
    }

    #[test]
    fn decide_seed_brain_target_ui_config_wins_over_project_and_app_data() {
        let target = decide_seed_brain_target(
            None,
            Some("/ui/brain".to_string()),
            Some("/proj"),
            Some("/app-data/lazybrain/brain".to_string()),
        );
        assert_eq!(target, SeedBrainTarget { path: "/ui/brain".to_string(), persist: false });
        eprintln!("decide_seed_brain_target_ui_config_wins_over_project_and_app_data PASSED");
    }

    #[test]
    fn decide_seed_brain_target_empty_ui_config_is_treated_as_absent() {
        // Mirrors resolve_brain_path_core's own `.filter(|p| !p.is_empty())`
        // handling of an empty (but Some) ui_config_path.
        let target = decide_seed_brain_target(
            None,
            Some(String::new()),
            Some("/proj"),
            Some("/app-data/lazybrain/brain".to_string()),
        );
        let expected_path = std::path::Path::new("/proj")
            .join(".lazybrain")
            .join("brain")
            .to_string_lossy()
            .into_owned();
        assert_eq!(target, SeedBrainTarget { path: expected_path, persist: false });
        eprintln!("decide_seed_brain_target_empty_ui_config_is_treated_as_absent PASSED");
    }

    #[test]
    fn decide_seed_brain_target_project_root_wins_over_app_data_when_no_override_or_ui_config() {
        let target = decide_seed_brain_target(
            None,
            None,
            Some("/proj"),
            Some("/app-data/lazybrain/brain".to_string()),
        );
        let expected_path = std::path::Path::new("/proj")
            .join(".lazybrain")
            .join("brain")
            .to_string_lossy()
            .into_owned();
        assert_eq!(target, SeedBrainTarget { path: expected_path, persist: false });
        eprintln!("decide_seed_brain_target_project_root_wins_over_app_data_when_no_override_or_ui_config PASSED");
    }

    #[test]
    fn decide_seed_brain_target_empty_project_root_is_treated_as_absent() {
        let target = decide_seed_brain_target(
            None,
            None,
            Some(""),
            Some("/app-data/lazybrain/brain".to_string()),
        );
        assert_eq!(target, SeedBrainTarget { path: "/app-data/lazybrain/brain".to_string(), persist: true });
        eprintln!("decide_seed_brain_target_empty_project_root_is_treated_as_absent PASSED");
    }

    #[test]
    fn decide_seed_brain_target_falls_back_to_app_data_brain_and_marks_persist_true() {
        // The actual bug fix: nothing configured, no project open — target
        // the SAME path the boot sidecar would use, and flag it for
        // persistence so later resolutions agree.
        let target = decide_seed_brain_target(
            None,
            None,
            None,
            Some("/app-data/lazybrain/brain".to_string()),
        );
        assert_eq!(
            target,
            SeedBrainTarget { path: "/app-data/lazybrain/brain".to_string(), persist: true }
        );
        eprintln!("decide_seed_brain_target_falls_back_to_app_data_brain_and_marks_persist_true PASSED");
    }

    #[test]
    fn decide_seed_brain_target_falls_back_to_dirs_fallback_when_app_data_brain_unavailable_too() {
        // Nothing configured AND app_local_data_dir itself failed — keep
        // today's pre-fix behavior exactly: dirs_fallback_brain, no persist.
        let target = decide_seed_brain_target(None, None, None, None);
        assert_eq!(
            target,
            SeedBrainTarget { path: super::dirs_fallback_brain(), persist: false }
        );
        eprintln!("decide_seed_brain_target_falls_back_to_dirs_fallback_when_app_data_brain_unavailable_too PASSED");
    }

    // ── count_brain_notes / BrainInfo.noteCount+isEmpty (BRAIN DISCOVERABILITY) ──

    #[test]
    fn count_brain_notes_zero_for_nonexistent_path() {
        assert_eq!(count_brain_notes("/definitely/does/not/exist/anywhere"), 0);
        eprintln!("count_brain_notes_zero_for_nonexistent_path PASSED");
    }

    /// Exactly the real-world diagnosis scenario: a brain directory that
    /// exists (e.g. it has `_cache/fts.sqlite`) but no `notes/` subdirectory
    /// at all — must count as 0, not error.
    #[test]
    fn count_brain_notes_zero_when_notes_dir_absent() {
        let tmp = TempDir::new().expect("TempDir::new");
        std::fs::create_dir_all(tmp.path().join("_cache")).expect("mkdir _cache");
        std::fs::write(tmp.path().join("_cache").join("fts.sqlite"), "x").expect("write fts.sqlite");

        assert_eq!(count_brain_notes(tmp.path().to_str().unwrap()), 0);
        eprintln!("count_brain_notes_zero_when_notes_dir_absent PASSED");
    }

    #[test]
    fn count_brain_notes_zero_when_notes_dir_empty() {
        let tmp = TempDir::new().expect("TempDir::new");
        std::fs::create_dir_all(tmp.path().join("notes")).expect("mkdir notes");

        assert_eq!(count_brain_notes(tmp.path().to_str().unwrap()), 0);
        eprintln!("count_brain_notes_zero_when_notes_dir_empty PASSED");
    }

    /// Mirrors the real on-disk layout: `notes/<yyyy-mm>/<slug>.html`,
    /// partitioned across multiple month directories.
    #[test]
    fn count_brain_notes_counts_html_files_across_partitions() {
        let tmp = TempDir::new().expect("TempDir::new");
        let notes = tmp.path().join("notes");
        std::fs::create_dir_all(notes.join("2026-05")).expect("mkdir partition");
        std::fs::create_dir_all(notes.join("2026-06")).expect("mkdir partition");

        std::fs::write(notes.join("2026-05").join("a.html"), "<html></html>").expect("write");
        std::fs::write(notes.join("2026-05").join("b.html"), "<html></html>").expect("write");
        std::fs::write(notes.join("2026-06").join("c.html"), "<html></html>").expect("write");

        assert_eq!(count_brain_notes(tmp.path().to_str().unwrap()), 3);
        eprintln!("count_brain_notes_counts_html_files_across_partitions PASSED");
    }

    /// Non-`.html` siblings (e.g. a stray `.json`/`.txt`) must not be
    /// counted as notes — matches the vendored engine's own
    /// `f.endsWith(".html")` filter in `buildDryRunSummary`.
    #[test]
    fn count_brain_notes_ignores_non_html_files() {
        let tmp = TempDir::new().expect("TempDir::new");
        let partition = tmp.path().join("notes").join("2026-05");
        std::fs::create_dir_all(&partition).expect("mkdir partition");

        std::fs::write(partition.join("real-note.html"), "<html></html>").expect("write");
        std::fs::write(partition.join("readme.txt"), "not a note").expect("write");
        std::fs::write(partition.join("meta.json"), "{}").expect("write");

        assert_eq!(count_brain_notes(tmp.path().to_str().unwrap()), 1);
        eprintln!("count_brain_notes_ignores_non_html_files PASSED");
    }

    #[test]
    fn get_brain_info_inner_reports_populated_brain_note_count() {
        let tmp = TempDir::new().expect("TempDir::new");
        let partition = tmp.path().join("notes").join("2026-05");
        std::fs::create_dir_all(&partition).expect("mkdir partition");
        std::fs::write(partition.join("note-1.html"), "<html></html>").expect("write");
        std::fs::write(partition.join("note-2.html"), "<html></html>").expect("write");

        // get_brain_info_inner resolves the brain path from project_root via
        // the project branch (<root>/.lazybrain/brain) when no env/UI
        // override is active on this machine — build that exact layout so
        // the full get_brain_info_inner path (not just count_brain_notes in
        // isolation) is exercised end to end.
        let root = TempDir::new().expect("TempDir::new");
        let brain_dir = root.path().join(".lazybrain").join("brain");
        let brain_partition = brain_dir.join("notes").join("2026-05");
        std::fs::create_dir_all(&brain_partition).expect("mkdir brain partition");
        std::fs::write(brain_partition.join("note-1.html"), "<html></html>").expect("write");
        std::fs::write(brain_partition.join("note-2.html"), "<html></html>").expect("write");
        std::fs::write(brain_partition.join("note-3.html"), "<html></html>").expect("write");

        let info = super::get_brain_info_inner(Some(root.path().to_str().unwrap()));
        if std::env::var("LAZYBRAIN_BRAIN_PATH").is_err() {
            assert_eq!(info.note_count, 3);
            assert!(!info.is_empty);
        }
        eprintln!("get_brain_info_inner_reports_populated_brain_note_count PASSED (note_count={})", info.note_count);
    }

    #[test]
    fn get_brain_info_inner_is_empty_true_when_note_count_zero() {
        let tmp = TempDir::new().expect("TempDir::new");
        let info = super::get_brain_info_inner(Some(tmp.path().to_str().unwrap()));
        if std::env::var("LAZYBRAIN_BRAIN_PATH").is_err() {
            assert_eq!(info.note_count, 0);
            assert!(info.is_empty, "a freshly created project dir with no brain yet must resolve isEmpty=true");
        }
        eprintln!("get_brain_info_inner_is_empty_true_when_note_count_zero PASSED");
    }
}
