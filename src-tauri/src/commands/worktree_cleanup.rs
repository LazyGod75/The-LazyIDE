//! Robust, idempotent, Windows-safe removal of an agent mission's git
//! worktree directory + its branch. Shared by agent_merge_worktree_inner's
//! post-merge cleanup (git.rs, Step 3 — reached only after a successful
//! merge) and agent_discard_worktree_inner (the Reject/Stop path, also
//! git.rs) — a single place that knows how to tear down a worktree
//! correctly, instead of two independent, drifting copies.
//!
//! ROOT CAUSE (real-app QA, confirmed empirically — see
//! `remove_worktree_with_retry_survives_uncoordinated_kill_race` below, which
//! reproduces it directly): `git worktree remove --force <path>` fails with a
//! real Windows
//! `Permission denied` while ANY process still has the worktree directory as
//! its current working directory (or an open handle inside it) — e.g. the
//! claude/codex CLI child agent_run spawns there, or a lingering grandchild
//! it started via a shell tool call (agent_run only tree-kills on an
//! EXPLICIT stop/app-exit, never on normal mission completion, so a
//! backgrounded dev-server/watcher the agent started can outlive the
//! mission). Critically, a FAILED `worktree remove` attempt of this kind can
//! itself corrupt git's own bookkeeping — confirmed empirically that git
//! drops the worktree's entry from `.git/worktrees/` on that failed attempt
//! WITHOUT deleting the directory, so a naive identical retry immediately
//! afterward fails differently ("fatal: '...' is not a working tree") even
//! once the lock has cleared — stranding the directory as neither a
//! registered worktree nor removed. This is why `remove_worktree_with_retry`
//! below retries the FULL sequence (git path AND a direct filesystem
//! fallback) on every attempt, not just once after falling out of a
//! git-only retry loop.
//!
//! For the discard/stop path specifically, this Windows-lock race is made
//! worse by an ordering gap: agentsStore.tsx's `stopMission` used to fire
//! its cleanup call independently of (and typically BEFORE) the actual
//! process kill, which happens on a SEPARATE ~200ms poll tick inside
//! runtime.ts's `planAndActLive`/`pollStop`. The fix pairs a Rust-side retry
//! budget generous enough to outlast that gap (see MAX_REMOVE_ATTEMPTS'
//! own doc comment for the measured timing it is sized against) with a
//! JS-side reordering: `agentsStore.tsx` now issues the kill
//! (`runtime.ts`'s `killAgentRun`) before attempting cleanup at all.
//!
//! Defense in depth (not proven to be this defect's primary cause, but
//! cheap and consistent with an existing fix in this codebase): before using
//! a worktree path as a literal `git.exe` argument, this module strips any
//! Windows verbatim (`\\?\`) prefix — the same class of "git chokes on a
//! literal `\\?\`-prefixed argument" `agent_create_worktree_inner` (git.rs)
//! already documents for `worktree add`.
//!
//! 2026-08-05 (os error 267 incident): every `Command::current_dir(repo_path)`
//! call in this module used the caller-supplied `repo_path` RAW — unlike the
//! `git worktree remove` argument above, which was already normalized. A
//! `repo_path` that is verbatim AND carries a stray '/' (mixed separators —
//! see `normalize_for_git`'s doc comment, util.rs, for the exact mechanism
//! and the sibling fix in git.rs's agent worktree lifecycle commands) fails
//! to spawn git at all with `ERROR_DIRECTORY_NAME_INVALID`. Since this
//! module's `cleanup_worktree_and_branch` is exactly what
//! `agent_merge_worktree_inner`'s Step 3 (git.rs) and
//! `agent_discard_worktree_inner` delegate to, a `repo_path` that survived
//! normalization all the way through the merge/discard itself could still
//! hit this on the cleanup call right after — every `current_dir(repo_path)`
//! below now routes through `normalize_for_git` too.
//!
//! This module additionally makes cleanup:
//!   - idempotent: removing an already-removed worktree, or deleting an
//!     already-deleted branch, is a success, not an error (repeated /
//!     overlapping cleanup calls are expected — see agentsStore.tsx's
//!     stopMission, which fires a direct cleanup call that can race
//!     runMission's own independent one).
//!   - bounded: every destructive filesystem call is gated by
//!     `util::is_within_agent_worktrees_dir`, so a path-computation bug can
//!     never make cleanup touch anything outside `<repo>/.lazy/worktrees/`.

use std::path::Path;
use std::time::Duration;

use crate::commands::git::git_binary;
use crate::commands::util::{is_within_agent_worktrees_dir, normalize_for_git, normalize_separators, quiet_command, strip_verbatim_prefix};

/// Retry budget for a locked worktree. Sized empirically: a fully
/// uncoordinated kill-vs-cleanup race (cleanup starting immediately, the
/// killing taskkill landing independently ~200ms later — the exact
/// pre-fix agentsStore.tsx shape) measured up to ~490ms before the OS fully
/// released the directory in local testing; 5 attempts * 250ms = 1000ms of
/// sleep alone (plus each attempt's own git/filesystem call time) leaves
/// comfortable headroom above that. The JS-side reordering fix (kill issued
/// before cleanup) shrinks the real-world window further — this budget is
/// the backstop for whenever it doesn't (managed missions with no PID to
/// kill, a future caller that forgets the ordering, antivirus scan locks,
/// etc.).
const MAX_REMOVE_ATTEMPTS: u32 = 8;
const RETRY_DELAY: Duration = Duration::from_millis(300);

/// Best-effort, idempotent, Windows-safe teardown of one agent worktree +
/// its branch. Never propagates a "cleanup failed" error to a caller whose
/// own primary goal (merge / discard) already succeeded — failures are
/// logged (`log::warn!`/`log::error!`) instead, per this codebase's
/// don't-swallow-don't-fail-the-caller convention (see
/// `agent_merge_worktree`'s doc comment in git.rs).
pub(crate) fn cleanup_worktree_and_branch(repo_path: &str, worktree_path: &str, branch: &str) {
    if let Err(e) = remove_worktree_with_retry(repo_path, worktree_path) {
        log::error!(
            "cleanup_worktree_and_branch: worktree removal did not complete for '{}': {}",
            worktree_path, e
        );
    }
    delete_branch_force(repo_path, branch);
}

/// Removes the worktree directory at `worktree_path`, retrying through a
/// short Windows file-lock window before giving up. Returns `Ok(())` once
/// the worktree is confirmed gone (including the idempotent "was already
/// gone" case) or `Err` only for a genuine, unresolved failure (a
/// safety-boundary violation, or the filesystem still refusing removal after
/// every attempt).
///
/// Each attempt tries BOTH the git-native removal AND (if the directory is
/// still present afterward) a direct filesystem removal, before sleeping and
/// retrying the whole pair — never a one-shot fallback after exhausting only
/// the git-based retries. This matters because a FAILED `git worktree
/// remove` can itself drop the worktree's registration without deleting the
/// directory (confirmed empirically — see this module's header comment), so
/// treating "git says it's not a working tree" as a single terminal signal
/// (try the fallback exactly once, then stop) does not survive a lock that
/// is still held at that exact moment; retrying the fallback too, on every
/// remaining attempt, does.
pub(crate) fn remove_worktree_with_retry(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    let normalized = normalize_separators(worktree_path);

    // Hard safety boundary — never soft-fail this one. See this function's
    // module doc comment / is_within_agent_worktrees_dir's own doc comment.
    if !is_within_agent_worktrees_dir(repo_path, &normalized) {
        return Err(format!(
            "refusing to remove '{}': not inside <repo>/.lazy/worktrees/",
            normalized
        ));
    }

    let target = Path::new(&normalized);
    if !target.exists() {
        log::debug!("remove_worktree_with_retry: '{}' already absent — no-op", normalized);
        prune_stale_registrations(repo_path);
        return Ok(());
    }

    // Windows verbatim-path fix: strip `\\?\` before using the path as a
    // literal git.exe argument — see this module's header comment
    // ("defense in depth").
    let arg = strip_verbatim_prefix(&normalized);

    let mut last_err = String::new();
    for attempt in 1..=MAX_REMOVE_ATTEMPTS {
        if !target.exists() {
            // Gone — whether this call's own previous attempt, or an
            // overlapping/concurrent cleanup call, got there first.
            prune_stale_registrations(repo_path);
            return Ok(());
        }

        let rm_out = quiet_command(git_binary())
            .args(["worktree", "remove", "--force", &arg])
            .current_dir(normalize_for_git(repo_path))
            .output();

        match rm_out {
            Ok(out) if out.status.success() => {
                prune_stale_registrations(repo_path);
                return Ok(());
            }
            Ok(out) => {
                last_err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            }
            Err(e) => {
                last_err = format!("failed to spawn git: {}", e);
            }
        }

        // Whatever git reported — a Windows file-lock ("Permission denied")
        // or a registration git already dropped ("is not a working tree") —
        // also try a direct filesystem removal on THIS SAME attempt. A lock
        // that has just cleared, or a registration git no longer tracks,
        // both resolve the same way: the directory itself is simply gone.
        if target.exists() {
            match std::fs::remove_dir_all(target) {
                Ok(()) => {
                    prune_stale_registrations(repo_path);
                    return Ok(());
                }
                Err(e) => {
                    last_err = format!("{} (fs fallback: {})", last_err, e);
                }
            }
        }

        if attempt < MAX_REMOVE_ATTEMPTS {
            log::warn!(
                "remove_worktree_with_retry: attempt {}/{} failed for '{}': {} — retrying in {:?}",
                attempt, MAX_REMOVE_ATTEMPTS, arg, last_err, RETRY_DELAY
            );
            std::thread::sleep(RETRY_DELAY);
        }
    }

    prune_stale_registrations(repo_path);
    if target.exists() {
        let msg = format!(
            "worktree removal failed after {} attempts for '{}': {}",
            MAX_REMOVE_ATTEMPTS, normalized, last_err
        );
        log::error!("remove_worktree_with_retry: {}", msg);
        Err(msg)
    } else {
        Ok(())
    }
}

/// Best-effort `git worktree prune` — forgets registrations for worktree
/// directories that no longer exist on disk (e.g. after the manual fallback
/// above deleted one directly). Never fails the caller: a missing git binary
/// or an already-clean registration list is not an error here.
fn prune_stale_registrations(repo_path: &str) {
    let _ = quiet_command(git_binary())
        .args(["worktree", "prune"])
        .current_dir(normalize_for_git(repo_path))
        .output();
}

/// Force-deletes `branch`, logging (not swallowing) any real failure.
/// "Branch not found" is treated as an idempotent no-op — it may have never
/// been committed (a discard before the first commit), or a previous /
/// overlapping cleanup call already deleted it.
fn delete_branch_force(repo_path: &str, branch: &str) {
    let br_out = quiet_command(git_binary())
        .args(["branch", "-D", branch])
        .current_dir(normalize_for_git(repo_path))
        .output();

    match br_out {
        Ok(out) if out.status.success() => {
            log::debug!("delete_branch_force: deleted branch '{}'", branch);
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if !stderr.contains("not found") {
                log::warn!("delete_branch_force: 'git branch -D {}' warning: {}", branch, stderr);
            }
        }
        Err(e) => {
            log::warn!("delete_branch_force: failed to spawn git for branch '{}': {}", branch, e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Mirrors git.rs's own setup_git_repo — kept as an independent local
    /// copy (rather than importing across the git.rs/worktree_cleanup.rs
    /// boundary) so this module's tests exercise only its own public
    /// surface, same convention as util.rs's make_temp_test_dir.
    fn setup_git_repo(dir: &TempDir) -> String {
        let root = dir.path().to_str().unwrap().to_string();
        quiet_command("git").args(["init"]).current_dir(&root).output().expect("git init");
        quiet_command("git").args(["config", "user.email", "agent@lazy.dev"]).current_dir(&root).output().expect("git config email");
        quiet_command("git").args(["config", "user.name", "Lazy Agent"]).current_dir(&root).output().expect("git config name");
        std::fs::write(dir.path().join("README.md"), "# repo\n").expect("write README");
        quiet_command("git").args(["add", "README.md"]).current_dir(&root).output().expect("git add");
        quiet_command("git").args(["commit", "-m", "initial"]).current_dir(&root).output().expect("git commit");
        root
    }

    /// Creates a worktree the same way agent_create_worktree_inner (git.rs)
    /// does: a RELATIVE `.lazy/worktrees/<safe_branch>` destination with
    /// `current_dir` set to `repo_path`, so the returned absolute path is
    /// joined from `repo_path` exactly like the real function — passing a
    /// canonicalized (verbatim) `repo_path` here reproduces the real-app
    /// shape end to end.
    fn create_worktree(repo_path: &str, branch: &str) -> String {
        let safe_branch: String = branch
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
            .collect();
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

    /// THE regression test: reproduces the exact real-app QA bug by
    /// canonicalizing repo_path (verbatim `\\?\`-prefixed on Windows,
    /// exactly like get_project_root's real output) before creating +
    /// cleaning up a worktree — the plain (non-canonicalized) TempDir path
    /// git.rs's pre-existing tests use never exercised this, which is
    /// exactly why the bug shipped.
    #[test]
    fn cleanup_removes_worktree_and_branch_with_verbatim_repo_path() {
        let repo_dir = TempDir::new().expect("TempDir");
        let plain_root = setup_git_repo(&repo_dir);
        let verbatim_root = Path::new(&plain_root)
            .canonicalize()
            .expect("canonicalize")
            .to_string_lossy()
            .to_string();
        #[cfg(target_os = "windows")]
        assert!(
            verbatim_root.starts_with(r"\\?\"),
            "sanity: canonicalize() must yield a verbatim path, got {}",
            verbatim_root
        );

        let branch = "agent/verbatim-cleanup-test".to_string();
        let wt_path = create_worktree(&verbatim_root, &branch);
        assert!(Path::new(&wt_path).is_dir(), "worktree must exist after creation");

        cleanup_worktree_and_branch(&verbatim_root, &wt_path, &branch);

        assert!(
            !Path::new(&wt_path).exists(),
            "worktree dir must be removed even with a verbatim repo_path: {}",
            wt_path
        );

        let branches = quiet_command("git")
            .args(["branch", "--list", &branch])
            .current_dir(&plain_root)
            .output()
            .expect("git branch --list");
        assert!(
            String::from_utf8_lossy(&branches.stdout).trim().is_empty(),
            "branch '{}' must be deleted",
            branch
        );

        eprintln!("cleanup_removes_worktree_and_branch_with_verbatim_repo_path PASSED");
    }

    /// THE Windows file-lock regression test — reproduces the actual root
    /// cause found while investigating this defect: a real child process
    /// with its current working directory inside the worktree (mirrors
    /// agent_run's `current_dir(&worktree_path)` for the claude/codex CLI,
    /// or a lingering shell-tool grandchild it started) is killed by an
    /// INDEPENDENT background thread ~200ms after removal starts — the
    /// exact pre-fix agentsStore.tsx shape, where stopMission's cleanup
    /// fired immediately, uncoordinated with the actual process kill that
    /// happens on runtime.ts's separate ~200ms `pollStop` tick. Confirmed
    /// empirically (see this module's header comment) that a bare, single
    /// `git worktree remove --force` attempt fails with a real Windows
    /// `Permission denied` in this exact window, and that the failed attempt
    /// itself drops git's worktree registration without deleting the
    /// directory — this test proves remove_worktree_with_retry survives
    /// that whole sequence and still ends up with the worktree gone.
    ///
    /// Windows-only: relies on `cmd`/`ping`/`taskkill` as a portable way to
    /// hold + release a real OS-level directory lock.
    #[cfg(target_os = "windows")]
    #[test]
    fn remove_worktree_with_retry_survives_uncoordinated_kill_race() {
        let repo_dir = TempDir::new().expect("TempDir");
        let root = setup_git_repo(&repo_dir);
        let branch = "agent/lock-race-test".to_string();
        let wt_path = create_worktree(&root, &branch);

        let child = std::process::Command::new("cmd")
            .args(["/c", "ping", "-n", "20", "127.0.0.1", ">", "nul"])
            .current_dir(&wt_path)
            .spawn()
            .expect("spawn lock-holder");
        let child_pid = child.id();
        std::thread::sleep(Duration::from_millis(300));

        // Kills the lock-holder from a SEPARATE thread ~200ms from now,
        // deliberately uncoordinated with the main thread's removal call
        // below — mirrors runtime.ts's pollStop() 200ms poll interval racing
        // ahead of agentsStore.tsx's (pre-fix) immediate cleanup call.
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            let _ = quiet_command("taskkill")
                .args(["/PID", &child_pid.to_string(), "/T", "/F"])
                .output();
        });

        let result = remove_worktree_with_retry(&root, &wt_path);
        assert!(
            result.is_ok(),
            "expected remove_worktree_with_retry to survive an uncoordinated kill race, got: {:?}",
            result
        );
        assert!(!Path::new(&wt_path).exists(), "worktree must be gone after surviving the race");

        eprintln!("remove_worktree_with_retry_survives_uncoordinated_kill_race PASSED");
    }

    /// Idempotence: cleaning up twice must not panic or error out — mirrors
    /// stopMission's own overlapping-cleanup-call scenario (see this
    /// module's header comment).
    #[test]
    fn cleanup_is_idempotent_when_called_twice() {
        let repo_dir = TempDir::new().expect("TempDir");
        let root = setup_git_repo(&repo_dir);
        let branch = "agent/idempotent-test".to_string();
        let wt_path = create_worktree(&root, &branch);

        cleanup_worktree_and_branch(&root, &wt_path, &branch);
        assert!(!Path::new(&wt_path).exists());

        // Second call: must not panic, and must leave things exactly as-is.
        cleanup_worktree_and_branch(&root, &wt_path, &branch);
        assert!(!Path::new(&wt_path).exists());

        // remove_worktree_with_retry directly, called a second time, must
        // also report Ok (idempotent no-op), not an error.
        let second = remove_worktree_with_retry(&root, &wt_path);
        assert!(second.is_ok(), "second removal of an already-removed worktree must be Ok, got: {:?}", second);

        eprintln!("cleanup_is_idempotent_when_called_twice PASSED");
    }

    /// Safety boundary: a worktree_path outside `.lazy/worktrees/` must be
    /// refused, and the directory must be left untouched on disk.
    #[test]
    fn remove_worktree_with_retry_refuses_a_path_outside_lazy_worktrees() {
        let repo_dir = TempDir::new().expect("TempDir");
        let root = setup_git_repo(&repo_dir);

        let outside_dir = repo_dir.path().join("not-a-worktree");
        std::fs::create_dir_all(&outside_dir).expect("create outside dir");
        std::fs::write(outside_dir.join("keep.txt"), "must survive\n").expect("write");

        let result = remove_worktree_with_retry(&root, &outside_dir.to_string_lossy());
        assert!(result.is_err(), "expected removal outside .lazy/worktrees to be refused");
        assert!(
            outside_dir.join("keep.txt").exists(),
            "the outside directory must be left completely untouched"
        );

        eprintln!("remove_worktree_with_retry_refuses_a_path_outside_lazy_worktrees PASSED");
    }

    /// delete_branch_force on a branch that was never created (e.g. a
    /// worktree that failed before its first commit) must be a quiet no-op,
    /// not a panic — exercised indirectly through cleanup_worktree_and_branch
    /// since delete_branch_force itself is private.
    #[test]
    fn cleanup_worktree_and_branch_tolerates_a_nonexistent_branch() {
        let repo_dir = TempDir::new().expect("TempDir");
        let root = setup_git_repo(&repo_dir);

        // No worktree, no branch — purely exercising the "nothing to do" path.
        let never_created = Path::new(&root).join(".lazy").join("worktrees").join("agent-never-created");
        cleanup_worktree_and_branch(&root, &never_created.to_string_lossy(), "agent/never-created");

        eprintln!("cleanup_worktree_and_branch_tolerates_a_nonexistent_branch PASSED");
    }
}
