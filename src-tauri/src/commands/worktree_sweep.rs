//! Periodic + boot-time sweep for orphaned agent worktrees (worktree-leak
//! follow-up, Fix 2).
//!
//! `archiveMission` (agentsStore.tsx) now tears down a mission's worktree
//! the moment it is archived (reusing `discardWorktree`/
//! `cleanup_worktree_and_branch` — see worktree_cleanup.rs), but that is a
//! best-effort, fire-and-forget JS-side call: a hard app crash between
//! "mission reached a terminal status" and "the cleanup call actually ran"
//! — or any mission archived by a build that predates that fix — leaves a
//! directory under `<repo>/.lazy/worktrees/` that nothing else will ever
//! revisit. `recoverStaleMissions` (src/lib/agents/missionQueue.ts) only
//! pauses the in-memory QUEUE entry on a crash-recovery boot; it never
//! touches the filesystem. This module is that missing recovery path.
//!
//! Modeled EXACTLY on `commands::journal::spawn_journal_retention` (same
//! shape): one pass a few minutes after boot, then every 24h, via
//! `tauri::async_runtime::spawn` + `tokio::task::spawn_blocking` so the
//! (blocking) filesystem/git work never occupies a tokio worker thread for
//! the duration of a sweep. Errors are logged, never fatal — a failed sweep
//! just means "nothing reclaimed this pass", same "don't fail the caller"
//! posture as the journal retention pass it mirrors.
//!
//! ── Safety model (this destroys directories on disk — three tiers) ──
//!
//!   1. LIVE — a worktree whose sanitized directory name resolves (via
//!      `missions_current`, the same materialized projection the fleet
//!      cockpit itself reads) to a mission that is 'review'/'running', OR
//!      to any mission that is simply not (yet) archived. NEVER touched,
//!      unconditionally — this re-implements the same hard floor
//!      `fleetHygiene.ts`'s own archive rules apply, defensively, since
//!      this module has no access to the TS rules directly.
//!   2. ARCHIVED — a worktree that resolves to a mission that IS archived
//!      AND terminal (done/failed/cancelled): the app has already decided
//!      this mission is definitively finished (the same signal
//!      `archiveMission`'s own cleanup acts on) — reclaimed unconditionally,
//!      including any uncommitted changes still sitting in it, exactly
//!      matching `archiveMission`'s/`discardMission`'s own existing
//!      behavior (neither of those gates on uncommitted changes either).
//!   3. ORPHAN — a worktree with NO matching row in `missions_current` at
//!      all (its mission record predates the journal, or the worktree was
//!      created outside the normal mission flow). Nothing here can confirm
//!      what this worktree was for, so it is reclaimed ONLY when it has
//!      zero uncommitted changes (`git status --porcelain`); a dirty orphan
//!      is left alone and logged instead of guessed at — "never delete a
//!      worktree with uncommitted changes unless its mission is
//!      definitively gone" (tier 2 above IS that definitively-gone case;
//!      tier 3, by definition, cannot prove it, so it earns the extra
//!      caution).
//!
//! Every destructive filesystem call still goes through
//! `worktree_cleanup::remove_worktree_with_retry` /
//! `cleanup_worktree_and_branch`, which independently enforce
//! `is_within_agent_worktrees_dir` as a hard boundary — this module never
//! bypasses that check, and never invents a second removal path.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde_json::Value as JsonValue;
use tauri::Manager;

use crate::commands::git::git_binary;
use crate::commands::journal::{journal_missions_current_inner, MissionCurrentOut};
use crate::commands::util::quiet_command;
use crate::commands::worktree_cleanup::{cleanup_worktree_and_branch, remove_worktree_with_retry};
use crate::state::ProjectRegistry;

/// Best-known fields off one `missions_current` row's JSON `data` snapshot —
/// deliberately narrow (mirrors fleetHygiene.ts's own `HygieneMission`
/// "only what a rule actually inspects" convention), so a row missing a
/// field (an old/placeholder row — see journal.rs's
/// `apply_mission_projection`) degrades to "not a match" / "not archived"
/// rather than a parse error.
struct MissionSnapshot {
    mission_id: String,
    status: String,
    archived: bool,
    /// Raw (unsanitized) branch name, e.g. `agent/M39-foo` — `Mission.worktree`
    /// on the TS side. `None` when the snapshot has no `worktree` field
    /// (a mission that never actually reached "running", so never created a
    /// worktree in the first place — never a match for anything on disk).
    worktree: Option<String>,
}

/// `data`'s own `status` wins when present (mirrors journal.rs's
/// `apply_mission_projection`: "its own status field... wins over the
/// type-based mapping"), falling back to the `missions_current.status`
/// column, which the same upsert keeps in lockstep whenever a snapshot
/// exists. A `data` blob that fails to parse (corrupt row, placeholder
/// `{"missionId": ...}` written before the first real snapshot) degrades to
/// "no worktree, not archived" — never a match, never eligible for tier 2.
fn parse_mission_snapshot(row: &MissionCurrentOut) -> MissionSnapshot {
    let json: JsonValue = serde_json::from_str(&row.data).unwrap_or(JsonValue::Null);
    MissionSnapshot {
        mission_id: row.mission_id.clone(),
        status: json
            .get("status")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| row.status.clone()),
        archived: json.get("archived").and_then(|v| v.as_bool()).unwrap_or(false),
        worktree: json.get("worktree").and_then(|v| v.as_str()).map(|s| s.to_string()),
    }
}

/// Mirrors `resolveDiscardWorktreePath`'s sanitization EXACTLY
/// (agentsStore.tsx: `branch.replace(/[^a-zA-Z0-9\-_]/g, '-')`) — ASCII
/// alphanumeric plus `-`/`_` survive unchanged, everything else (including
/// `/`, which every real branch name in this codebase contains, and any
/// non-ASCII character) becomes `-`. Must stay byte-for-byte in sync with
/// that regex or this module will never match a real worktree directory to
/// its owning mission.
fn sanitize_branch_for_dir(branch: &str) -> String {
    branch
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

/// What this sweep decided about one worktree directory — see this module's
/// doc comment for the three-tier safety model each variant corresponds to.
#[derive(Debug, Clone, PartialEq)]
enum WorktreeDisposition {
    /// Tier 1 — never touched.
    Live,
    /// Tier 2 — a definitively-archived, terminal mission owns this
    /// worktree; safe to reclaim unconditionally.
    ArchivedMission { mission_id: String, branch: String },
    /// Tier 3 — no mission record references this worktree at all.
    Orphan,
}

/// Pure classification — no I/O. `dir_name` is the worktree directory's own
/// basename (already the sanitized form on disk); `missions` should already
/// be ordered most-recently-updated-first (exactly what
/// `journal_missions_current_inner` returns) so the first match found here
/// is the freshest one, on the rare chance more than one mission sanitizes
/// to the same directory name.
fn classify_worktree(dir_name: &str, missions: &[MissionSnapshot]) -> WorktreeDisposition {
    let matches: Vec<&MissionSnapshot> = missions
        .iter()
        .filter(|m| m.worktree.as_deref().map(sanitize_branch_for_dir).as_deref() == Some(dir_name))
        .collect();

    if let Some(first) = matches.first() {
        let all_archived_terminal = matches
            .iter()
            .all(|m| m.archived && matches!(m.status.as_str(), "done" | "failed" | "cancelled"));

        return if all_archived_terminal {
            WorktreeDisposition::ArchivedMission {
                mission_id: first.mission_id.clone(),
                branch: first.worktree.clone().unwrap_or_default(),
            }
        } else {
            // Covers 'review'/'running' explicitly named by the spec, AND
            // every other case this module cannot prove is definitively
            // gone (queued, or terminal-but-not-yet-archived) — see this
            // module's doc comment, tier 1.
            WorktreeDisposition::Live
        };
    }

    // No direct `worktree`-field match. Role sub-agent worktrees
    // (orchestrator fan-out, runtime.ts's Step E — "implémenteur"/
    // "testeur"/"relecteur" and friends) are NEVER written to
    // `missions_current` at all: their childId/childBranch is derived as
    // `${parentMissionId}-${roleName}-wt` purely in-memory and the worktree
    // is created straight off `agent_create_worktree`, with no journal
    // projection of its own. Undetected, every one of them looks exactly
    // like tier 3 (Orphan) to the match above — which is what let a clean
    // sub-agent worktree belonging to a still-running parent mission get
    // swept mid-mission (real run, 2026-08-01: M3/M3-implémenteur-wt et al.
    // reclaimed by 'worktree_sweep: reclaiming clean orphan worktree ...
    // no matching mission record' while the parent mission was still
    // 'review'). Detect them structurally instead: `mission_id` (the
    // journal's own un-sanitized id column, e.g. "M3") is always a literal,
    // un-sanitized prefix of the child's directory name — mission ids are
    // plain ASCII (`M<n>`), and `agent_create_worktree_inner`'s own
    // directory sanitization (git.rs) is Unicode-`is_alphanumeric`-aware,
    // so it leaves the accented role names in these dir names untouched
    // (unlike `sanitize_branch_for_dir` above, which deliberately mirrors
    // the ASCII-only JS regex used for ordinary mission worktrees) — no
    // sanitization mismatch to reconcile for this prefix check. If ANY
    // mission with that id is still alive (not archived-terminal), treat
    // the child exactly like tier 1: never touched, unconditionally, same
    // as its parent. If every matching parent is archived-terminal (or no
    // parent is found at all), fall through to ordinary tier-3 handling
    // below — this function deliberately does NOT invent a branch name to
    // force-delete for a child it cannot fully identify; a clean directory
    // is reclaimed, a dirty one is left alone, same conservative floor as
    // any other untracked worktree.
    let has_live_parent = missions.iter().any(|m| {
        dir_name.starts_with(&format!("{}-", m.mission_id))
            && !(m.archived && matches!(m.status.as_str(), "done" | "failed" | "cancelled"))
    });
    if has_live_parent {
        return WorktreeDisposition::Live;
    }

    WorktreeDisposition::Orphan
}

/// `git status --porcelain` in `worktree_path` — `true` means "has
/// uncommitted changes" OR "could not be verified at all". Fails CLOSED: a
/// worktree this function cannot actually inspect is never treated as
/// safely empty.
fn has_uncommitted_changes(worktree_path: &Path) -> bool {
    match quiet_command(git_binary()).args(["status", "--porcelain"]).current_dir(worktree_path).output() {
        Ok(out) if out.status.success() => !out.stdout.is_empty(),
        _ => true,
    }
}

/// One sweep's outcome — logged by the caller, and asserted on directly in
/// tests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WorktreeSweepSummary {
    pub scanned: usize,
    pub reclaimed_archived: usize,
    pub reclaimed_orphans: usize,
    pub skipped_dirty_orphans: usize,
}

impl WorktreeSweepSummary {
    fn add(&mut self, other: WorktreeSweepSummary) {
        self.scanned += other.scanned;
        self.reclaimed_archived += other.reclaimed_archived;
        self.reclaimed_orphans += other.reclaimed_orphans;
        self.skipped_dirty_orphans += other.skipped_dirty_orphans;
    }
}

/// Sweeps ONE repo's `<repo_path>/.lazy/worktrees/` — enumerates every
/// subdirectory, classifies it against `missions`, and reclaims whatever
/// tier 2/3 (see module doc) allows. A missing `.lazy/worktrees` directory
/// (a project that never ran a mission) is a silent no-op, not an error.
fn sweep_orphan_worktrees_for_repo(repo_path: &str, missions: &[MissionSnapshot]) -> WorktreeSweepSummary {
    let mut summary = WorktreeSweepSummary::default();
    let worktrees_dir: PathBuf = Path::new(repo_path).join(".lazy").join("worktrees");

    let entries = match fs::read_dir(&worktrees_dir) {
        Ok(e) => e,
        Err(_) => return summary,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(dir_name) = entry.file_name().into_string() else { continue };
        summary.scanned += 1;

        match classify_worktree(&dir_name, missions) {
            WorktreeDisposition::Live => {}
            WorktreeDisposition::ArchivedMission { mission_id, branch } => {
                log::info!(
                    "worktree_sweep: reclaiming worktree '{}' — mission '{}' is archived",
                    path.display(),
                    mission_id
                );
                cleanup_worktree_and_branch(repo_path, &path.to_string_lossy(), &branch);
                summary.reclaimed_archived += 1;
            }
            WorktreeDisposition::Orphan => {
                if has_uncommitted_changes(&path) {
                    log::warn!(
                        "worktree_sweep: leaving orphan worktree '{}' alone — no matching mission record AND uncommitted changes present (or unverifiable)",
                        path.display()
                    );
                    summary.skipped_dirty_orphans += 1;
                    continue;
                }
                log::info!(
                    "worktree_sweep: reclaiming clean orphan worktree '{}' — no matching mission record",
                    path.display()
                );
                // No confidently-known branch to delete (see this module's
                // doc comment, tier 3) — reclaim the directory only, never
                // guess a branch name to force-delete.
                if let Err(e) = remove_worktree_with_retry(repo_path, &path.to_string_lossy()) {
                    log::warn!("worktree_sweep: failed to remove orphan '{}': {}", path.display(), e);
                } else {
                    summary.reclaimed_orphans += 1;
                }
            }
        }
    }

    summary
}

/// One full sweep pass across every entry in `repo_roots`, reading
/// `missions_current` once and reusing that single snapshot for every repo
/// (a mission belongs to exactly one project, but reading once instead of
/// once-per-repo is also simply cheaper).
pub(crate) fn run_orphan_sweep_once(conn: &Connection, repo_roots: &[String]) -> Result<WorktreeSweepSummary, String> {
    let rows = journal_missions_current_inner(conn, None)?;
    let missions: Vec<MissionSnapshot> = rows.iter().map(parse_mission_snapshot).collect();

    let mut total = WorktreeSweepSummary::default();
    for repo in repo_roots {
        total.add(sweep_orphan_worktrees_for_repo(repo, &missions));
    }
    Ok(total)
}

/// Spawn the periodic + boot-time orphan-worktree sweep — see this module's
/// doc comment. `app` is an OWNED `AppHandle` (not a borrowed
/// `tauri::State`) so `ProjectRegistry` can be re-derived fresh on every
/// tick from inside a `'static` background task — the same pattern
/// `agent_create_worktree` (git.rs) already uses for the identical reason (a
/// `tauri::State<'_, T>` borrow cannot move into a `'static` closure).
/// Re-deriving on every tick (rather than once at spawn time) matters here
/// specifically: which repos exist to sweep can change over a long-running
/// session as projects open/close.
pub(crate) fn spawn_worktree_orphan_sweep(app: tauri::AppHandle, journal_conn: Arc<Mutex<Connection>>) {
    const INITIAL_DELAY_SECS: u64 = 5 * 60;
    const INTERVAL_SECS: u64 = 24 * 60 * 60;

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_secs(INITIAL_DELAY_SECS)).await;

        loop {
            let conn_for_task = Arc::clone(&journal_conn);
            let app_for_task = app.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                let roots = app_for_task
                    .state::<ProjectRegistry>()
                    .0
                    .lock()
                    .map(|registry| registry.all_roots())
                    .unwrap_or_default();
                let guard = conn_for_task
                    .lock()
                    .map_err(|e| format!("worktree_sweep: journal lock failed: {}", e))?;
                run_orphan_sweep_once(&guard, &roots)
            })
            .await;

            match outcome {
                Ok(Ok(summary)) => log::info!(
                    "worktree_sweep: scanned {} worktree(s), reclaimed {} archived, {} clean orphan(s), left {} dirty orphan(s) alone",
                    summary.scanned,
                    summary.reclaimed_archived,
                    summary.reclaimed_orphans,
                    summary.skipped_dirty_orphans
                ),
                Ok(Err(e)) => log::warn!("worktree_sweep: run failed: {}", e),
                Err(e) => log::warn!("worktree_sweep: background task join error: {}", e),
            }

            tokio::time::sleep(tokio::time::Duration::from_secs(INTERVAL_SECS)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // ── Local git/worktree test helpers (independent copy — mirrors
    // worktree_cleanup.rs's own test module convention: "kept as an
    // independent local copy... so this module's tests exercise only its
    // own public surface"). ──────────────────────────────────────────────

    fn setup_git_repo(dir: &TempDir) -> String {
        let root = dir.path().to_str().unwrap().to_string();
        quiet_command("git").args(["init"]).current_dir(&root).output().expect("git init");
        quiet_command("git").args(["config", "user.email", "agent@lazy.dev"]).current_dir(&root).output().expect("git config email");
        quiet_command("git").args(["config", "user.name", "Lazy Agent"]).current_dir(&root).output().expect("git config name");
        fs::write(dir.path().join("README.md"), "# repo\n").expect("write README");
        quiet_command("git").args(["add", "README.md"]).current_dir(&root).output().expect("git add");
        quiet_command("git").args(["commit", "-m", "initial"]).current_dir(&root).output().expect("git commit");
        root
    }

    /// Creates a real worktree at `.lazy/worktrees/<sanitized_branch>`,
    /// exactly like `agent_create_worktree_inner` (git.rs) does. Returns the
    /// worktree's absolute path.
    fn create_worktree(repo_path: &str, branch: &str) -> String {
        let safe_branch = sanitize_branch_for_dir(branch);
        let wt_path = Path::new(repo_path).join(".lazy").join("worktrees").join(&safe_branch);
        let wt_rel = Path::new(".lazy").join("worktrees").join(&safe_branch);
        let out = quiet_command("git")
            .args(["worktree", "add", "-b", branch, &wt_rel.to_string_lossy()])
            .current_dir(repo_path)
            .output()
            .expect("git worktree add");
        assert!(out.status.success(), "git worktree add failed: {}", String::from_utf8_lossy(&out.stderr));
        wt_path.to_string_lossy().into_owned()
    }

    fn snapshot(mission_id: &str, status: &str, archived: bool, worktree: Option<&str>) -> MissionSnapshot {
        MissionSnapshot {
            mission_id: mission_id.to_string(),
            status: status.to_string(),
            archived,
            worktree: worktree.map(|w| w.to_string()),
        }
    }

    // ── sanitize_branch_for_dir ────────────────────────────────────────

    #[test]
    fn sanitize_branch_for_dir_mirrors_the_js_regex() {
        assert_eq!(sanitize_branch_for_dir("agent/M39-foo"), "agent-M39-foo");
        assert_eq!(sanitize_branch_for_dir("agent-safe_branch123"), "agent-safe_branch123");
        assert_eq!(sanitize_branch_for_dir("a/b/c"), "a-b-c");
        eprintln!("sanitize_branch_for_dir_mirrors_the_js_regex PASSED");
    }

    #[test]
    fn sanitize_branch_for_dir_replaces_non_ascii_too() {
        // JS's `[^a-zA-Z0-9\-_]` is ASCII-only — an accented char is NOT
        // alphanumeric under that regex and must become '-', same as here.
        assert_eq!(sanitize_branch_for_dir("café/x"), "caf--x");
        eprintln!("sanitize_branch_for_dir_replaces_non_ascii_too PASSED");
    }

    // ── classify_worktree ────────────────────────────────────────────────

    #[test]
    fn classify_worktree_is_orphan_when_no_mission_matches() {
        let missions = vec![snapshot("M1", "done", true, Some("agent/other-branch"))];
        assert_eq!(classify_worktree("agent-M39-foo", &missions), WorktreeDisposition::Orphan);
        eprintln!("classify_worktree_is_orphan_when_no_mission_matches PASSED");
    }

    #[test]
    fn classify_worktree_is_orphan_with_zero_missions() {
        assert_eq!(classify_worktree("agent-M39-foo", &[]), WorktreeDisposition::Orphan);
        eprintln!("classify_worktree_is_orphan_with_zero_missions PASSED");
    }

    #[test]
    fn classify_worktree_never_touches_a_running_mission() {
        let missions = vec![snapshot("M1", "running", false, Some("agent/M39-foo"))];
        assert_eq!(classify_worktree("agent-M39-foo", &missions), WorktreeDisposition::Live);
        eprintln!("classify_worktree_never_touches_a_running_mission PASSED");
    }

    #[test]
    fn classify_worktree_never_touches_a_review_mission() {
        let missions = vec![snapshot("M1", "review", false, Some("agent/M39-foo"))];
        assert_eq!(classify_worktree("agent-M39-foo", &missions), WorktreeDisposition::Live);
        eprintln!("classify_worktree_never_touches_a_review_mission PASSED");
    }

    #[test]
    fn classify_worktree_reclaims_an_archived_done_mission() {
        let missions = vec![snapshot("M1", "done", true, Some("agent/M39-foo"))];
        assert_eq!(
            classify_worktree("agent-M39-foo", &missions),
            WorktreeDisposition::ArchivedMission { mission_id: "M1".to_string(), branch: "agent/M39-foo".to_string() }
        );
        eprintln!("classify_worktree_reclaims_an_archived_done_mission PASSED");
    }

    #[test]
    fn classify_worktree_reclaims_an_archived_failed_mission() {
        let missions = vec![snapshot("M2", "failed", true, Some("agent/M40-bar"))];
        assert_eq!(
            classify_worktree("agent-M40-bar", &missions),
            WorktreeDisposition::ArchivedMission { mission_id: "M2".to_string(), branch: "agent/M40-bar".to_string() }
        );
        eprintln!("classify_worktree_reclaims_an_archived_failed_mission PASSED");
    }

    #[test]
    fn classify_worktree_reclaims_an_archived_cancelled_mission() {
        let missions = vec![snapshot("M3", "cancelled", true, Some("agent/M41-baz"))];
        assert_eq!(
            classify_worktree("agent-M41-baz", &missions),
            WorktreeDisposition::ArchivedMission { mission_id: "M3".to_string(), branch: "agent/M41-baz".to_string() }
        );
        eprintln!("classify_worktree_reclaims_an_archived_cancelled_mission PASSED");
    }

    #[test]
    fn classify_worktree_never_touches_a_terminal_mission_that_is_not_yet_archived() {
        let missions = vec![snapshot("M1", "failed", false, Some("agent/M39-foo"))];
        assert_eq!(classify_worktree("agent-M39-foo", &missions), WorktreeDisposition::Live);
        eprintln!("classify_worktree_never_touches_a_terminal_mission_that_is_not_yet_archived PASSED");
    }

    #[test]
    fn classify_worktree_never_touches_a_queued_mission() {
        let missions = vec![snapshot("M1", "queued", false, Some("agent/M39-foo"))];
        assert_eq!(classify_worktree("agent-M39-foo", &missions), WorktreeDisposition::Live);
        eprintln!("classify_worktree_never_touches_a_queued_mission PASSED");
    }

    // ── classify_worktree — role sub-agent worktrees (Problem B) ────────

    #[test]
    fn classify_worktree_protects_a_role_sub_agent_of_a_running_parent() {
        // The parent mission's OWN worktree field never matches the child's
        // directory name directly (runtime.ts Step E never writes the
        // child to missions_current) — only the prefix rule below can find
        // it. "M3-implémenteur-wt" is the exact directory name from the
        // 2026-08-01 real run this fix addresses.
        let missions = vec![snapshot("M3", "review", false, Some("agent/M3-fusionner-la-branche"))];
        assert_eq!(classify_worktree("M3-implémenteur-wt", &missions), WorktreeDisposition::Live);
        eprintln!("classify_worktree_protects_a_role_sub_agent_of_a_running_parent PASSED");
    }

    #[test]
    fn classify_worktree_protects_a_role_sub_agent_even_with_no_worktree_field_on_the_parent() {
        // A parent mission snapshot that hasn't reached 'running' yet (no
        // `worktree` field at all) must still protect an already-spawned
        // child — the prefix check only needs `mission_id` + liveness.
        let missions = vec![snapshot("M7", "queued", false, None)];
        assert_eq!(classify_worktree("M7-testeur-wt", &missions), WorktreeDisposition::Live);
        eprintln!("classify_worktree_protects_a_role_sub_agent_even_with_no_worktree_field_on_the_parent PASSED");
    }

    #[test]
    fn classify_worktree_does_not_protect_a_role_sub_agent_of_an_archived_terminal_parent() {
        let missions = vec![snapshot("M9", "done", true, Some("agent/M9-foo"))];
        // Falls through to ordinary orphan handling (tier 3), not Live —
        // this function refuses to guess the child's exact branch name to
        // force-delete it like a tier-2 ArchivedMission would.
        assert_eq!(classify_worktree("M9-relecteur-wt", &missions), WorktreeDisposition::Orphan);
        eprintln!("classify_worktree_does_not_protect_a_role_sub_agent_of_an_archived_terminal_parent PASSED");
    }

    #[test]
    fn classify_worktree_prefix_rule_never_false_matches_an_unrelated_mission_id() {
        // "M30-..." must not be mistaken for a child of "M3" — the prefix
        // check requires the literal separator right after the id.
        let missions = vec![snapshot("M3", "running", false, Some("agent/M3-foo"))];
        assert_eq!(classify_worktree("M30-implementer-wt", &missions), WorktreeDisposition::Orphan);
        eprintln!("classify_worktree_prefix_rule_never_false_matches_an_unrelated_mission_id PASSED");
    }

    // ── sweep_orphan_worktrees_for_repo (real git + fs) ─────────────────

    #[test]
    fn sweep_reclaims_a_clean_orphan_with_no_matching_mission() {
        let repo_dir = TempDir::new().expect("TempDir");
        let root = setup_git_repo(&repo_dir);
        let wt_path = create_worktree(&root, "agent/orphan-clean");

        let summary = sweep_orphan_worktrees_for_repo(&root, &[]);

        assert_eq!(summary.scanned, 1);
        assert_eq!(summary.reclaimed_orphans, 1);
        assert_eq!(summary.reclaimed_archived, 0);
        assert_eq!(summary.skipped_dirty_orphans, 0);
        assert!(!Path::new(&wt_path).exists(), "clean orphan worktree must be removed");
        eprintln!("sweep_reclaims_a_clean_orphan_with_no_matching_mission PASSED");
    }

    #[test]
    fn sweep_never_removes_a_clean_role_sub_agent_worktree_of_a_live_mission() {
        // Reproduces the 2026-08-01 real run (Problem B): a clean sub-agent
        // worktree ("M3-implémenteur-wt" et al.) belonging to a still-'review'
        // parent mission must survive the sweep, not be reclaimed as an
        // "orphan" just because it has no missions_current row of its own.
        let repo_dir = TempDir::new().expect("TempDir");
        let root = setup_git_repo(&repo_dir);
        let child_wt = create_worktree(&root, "M3-implémenteur-wt");
        let missions = vec![snapshot("M3", "review", false, Some("agent/M3-fusionner-la-branche"))];

        let summary = sweep_orphan_worktrees_for_repo(&root, &missions);

        assert_eq!(summary.reclaimed_orphans, 0);
        assert_eq!(summary.reclaimed_archived, 0);
        assert!(Path::new(&child_wt).exists(), "a live parent's sub-agent worktree must never be swept as an orphan");
        eprintln!("sweep_never_removes_a_clean_role_sub_agent_worktree_of_a_live_mission PASSED");
    }

    #[test]
    fn sweep_leaves_a_dirty_orphan_alone() {
        let repo_dir = TempDir::new().expect("TempDir");
        let root = setup_git_repo(&repo_dir);
        let wt_path = create_worktree(&root, "agent/orphan-dirty");
        fs::write(Path::new(&wt_path).join("uncommitted.txt"), "never committed\n").expect("write scratch file");

        let summary = sweep_orphan_worktrees_for_repo(&root, &[]);

        assert_eq!(summary.reclaimed_orphans, 0);
        assert_eq!(summary.skipped_dirty_orphans, 1);
        assert!(Path::new(&wt_path).exists(), "a dirty orphan must survive the sweep untouched");
        eprintln!("sweep_leaves_a_dirty_orphan_alone PASSED");
    }

    #[test]
    fn sweep_reclaims_a_worktree_and_its_branch_for_an_archived_failed_mission() {
        let repo_dir = TempDir::new().expect("TempDir");
        let root = setup_git_repo(&repo_dir);
        let branch = "agent/M40-archived-failed";
        let wt_path = create_worktree(&root, branch);
        let missions = vec![snapshot("M40", "failed", true, Some(branch))];

        let summary = sweep_orphan_worktrees_for_repo(&root, &missions);

        assert_eq!(summary.reclaimed_archived, 1);
        assert!(!Path::new(&wt_path).exists(), "archived mission's worktree must be removed");

        let branches = quiet_command("git").args(["branch", "--list", branch]).current_dir(&root).output().expect("git branch --list");
        assert!(String::from_utf8_lossy(&branches.stdout).trim().is_empty(), "branch '{}' must be deleted too", branch);
        eprintln!("sweep_reclaims_a_worktree_and_its_branch_for_an_archived_failed_mission PASSED");
    }

    #[test]
    fn sweep_reclaims_even_a_dirty_worktree_for_an_archived_mission() {
        // Tier 2 (definitively-archived) never gates on uncommitted changes
        // — matches archiveMission's/discardMission's own JS-side behavior
        // (see this module's doc comment).
        let repo_dir = TempDir::new().expect("TempDir");
        let root = setup_git_repo(&repo_dir);
        let branch = "agent/M41-archived-dirty";
        let wt_path = create_worktree(&root, branch);
        fs::write(Path::new(&wt_path).join("uncommitted.txt"), "leftover work\n").expect("write scratch file");
        let missions = vec![snapshot("M41", "done", true, Some(branch))];

        let summary = sweep_orphan_worktrees_for_repo(&root, &missions);

        assert_eq!(summary.reclaimed_archived, 1);
        assert!(!Path::new(&wt_path).exists(), "an archived mission's worktree is reclaimed even with uncommitted changes");
        eprintln!("sweep_reclaims_even_a_dirty_worktree_for_an_archived_mission PASSED");
    }

    #[test]
    fn sweep_never_removes_a_worktree_belonging_to_a_running_mission() {
        let repo_dir = TempDir::new().expect("TempDir");
        let root = setup_git_repo(&repo_dir);
        let branch = "agent/M42-running";
        let wt_path = create_worktree(&root, branch);
        let missions = vec![snapshot("M42", "running", false, Some(branch))];

        let summary = sweep_orphan_worktrees_for_repo(&root, &missions);

        assert_eq!(summary.reclaimed_archived, 0);
        assert_eq!(summary.reclaimed_orphans, 0);
        assert!(Path::new(&wt_path).exists(), "a running mission's worktree must never be touched");
        eprintln!("sweep_never_removes_a_worktree_belonging_to_a_running_mission PASSED");
    }

    #[test]
    fn sweep_never_removes_a_worktree_belonging_to_a_review_mission() {
        let repo_dir = TempDir::new().expect("TempDir");
        let root = setup_git_repo(&repo_dir);
        let branch = "agent/M43-review";
        let wt_path = create_worktree(&root, branch);
        let missions = vec![snapshot("M43", "review", false, Some(branch))];

        let summary = sweep_orphan_worktrees_for_repo(&root, &missions);

        assert!(Path::new(&wt_path).exists(), "a review mission's worktree must never be touched");
        assert_eq!(summary.reclaimed_archived + summary.reclaimed_orphans, 0);
        eprintln!("sweep_never_removes_a_worktree_belonging_to_a_review_mission PASSED");
    }

    #[test]
    fn sweep_never_removes_a_worktree_for_a_terminal_but_not_yet_archived_mission() {
        let repo_dir = TempDir::new().expect("TempDir");
        let root = setup_git_repo(&repo_dir);
        let branch = "agent/M44-failed-unarchived";
        let wt_path = create_worktree(&root, branch);
        let missions = vec![snapshot("M44", "failed", false, Some(branch))];

        let summary = sweep_orphan_worktrees_for_repo(&root, &missions);

        assert!(Path::new(&wt_path).exists(), "a failed-but-unarchived mission's worktree must survive");
        assert_eq!(summary.reclaimed_archived + summary.reclaimed_orphans, 0);
        eprintln!("sweep_never_removes_a_worktree_for_a_terminal_but_not_yet_archived_mission PASSED");
    }

    #[test]
    fn sweep_of_a_missing_worktrees_dir_is_a_silent_noop() {
        let repo_dir = TempDir::new().expect("TempDir");
        let root = setup_git_repo(&repo_dir);
        let summary = sweep_orphan_worktrees_for_repo(&root, &[]);
        assert_eq!(summary, WorktreeSweepSummary::default());
        eprintln!("sweep_of_a_missing_worktrees_dir_is_a_silent_noop PASSED");
    }

    // ── run_orphan_sweep_once (real sqlite + real git, end to end) ──────

    #[test]
    fn run_orphan_sweep_once_reads_missions_current_and_sweeps_every_repo_root() {
        let journal_conn = Connection::open_in_memory().expect("open in-memory journal db");
        crate::commands::journal::init_journal_schema(&journal_conn).expect("init schema");

        let repo_a_dir = TempDir::new().expect("TempDir a");
        let repo_a = setup_git_repo(&repo_a_dir);
        let archived_branch = "agent/M50-done-archived";
        let archived_wt = create_worktree(&repo_a, archived_branch);
        let orphan_wt = create_worktree(&repo_a, "agent/no-mission-record");

        let repo_b_dir = TempDir::new().expect("TempDir b");
        let repo_b = setup_git_repo(&repo_b_dir);
        let live_branch = "agent/M51-running";
        let live_wt = create_worktree(&repo_b, live_branch);

        let data_archived = serde_json::json!({ "status": "done", "archived": true, "worktree": archived_branch }).to_string();
        journal_conn
            .execute(
                "INSERT INTO missions_current (mission_id, project_id, status, data, updated_ms) VALUES ('M50', 'p-a', 'done', ?1, 1)",
                rusqlite::params![data_archived],
            )
            .expect("insert archived mission row");

        let data_live = serde_json::json!({ "status": "running", "archived": false, "worktree": live_branch }).to_string();
        journal_conn
            .execute(
                "INSERT INTO missions_current (mission_id, project_id, status, data, updated_ms) VALUES ('M51', 'p-b', 'running', ?1, 2)",
                rusqlite::params![data_live],
            )
            .expect("insert running mission row");

        let summary = run_orphan_sweep_once(&journal_conn, &[repo_a, repo_b]).expect("sweep must succeed");

        assert_eq!(summary.scanned, 3, "both repos' worktrees combined");
        assert_eq!(summary.reclaimed_archived, 1);
        assert_eq!(summary.reclaimed_orphans, 1);
        assert!(!Path::new(&archived_wt).exists(), "archived mission's worktree reclaimed");
        assert!(!Path::new(&orphan_wt).exists(), "clean orphan reclaimed");
        assert!(Path::new(&live_wt).exists(), "running mission's worktree untouched");
        eprintln!("run_orphan_sweep_once_reads_missions_current_and_sweeps_every_repo_root PASSED");
    }

    #[test]
    fn run_orphan_sweep_once_is_a_noop_for_an_empty_repo_root_list() {
        let journal_conn = Connection::open_in_memory().expect("open in-memory journal db");
        crate::commands::journal::init_journal_schema(&journal_conn).expect("init schema");
        let summary = run_orphan_sweep_once(&journal_conn, &[]).expect("sweep must succeed");
        assert_eq!(summary, WorktreeSweepSummary::default());
        eprintln!("run_orphan_sweep_once_is_a_noop_for_an_empty_repo_root_list PASSED");
    }
}
