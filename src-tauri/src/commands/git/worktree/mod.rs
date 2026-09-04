//! Agent worktree lifecycle: create / diff / merge / discard / revert.
//! Worktrees are just git repos, so this plumbing lives alongside the rest
//! of the git module -- see `super::` (this directory's `mod.rs`) for the
//! module map. Split out of the former flat `git.rs`.

use std::fs;

// `Manager` brings `AppHandle::state::<T>()` into scope for the async
// worktree-lifecycle commands below (create/merge/discard/revert), whose
// bodies run in `tauri::async_runtime::spawn_blocking` closures and must
// re-derive `ProjectRegistry` from an owned `AppHandle` — a borrowed
// `tauri::State<'_, T>` argument cannot move into a `'static` closure
// (same pattern as brain_capture in commands/brain/capture.rs).
use tauri::Manager;

use crate::state::ProjectRegistry;
use crate::commands::util::{ensure_repo_in_any_open_project, normalize_for_git, quiet_command};

use super::status::git_binary;

/// Create a git worktree for an agent mission.
///
/// Runs: `git -C <repo_path> worktree add -b <branch> <worktree_path> [<base_branch>]`
/// The worktree is placed under `<repo_path>/.lazy/worktrees/<branch>`.
///
/// `base_branch`: when `Some`, `branch` is created starting FROM that branch
/// instead of the repo's current HEAD (see Mission.baseBranch's doc comment,
/// src/lib/agents/types.ts, for the full plan/mission wiring). Existence is
/// verified BEFORE anything is created — a `base_branch` that does not exist
/// in `repo_path` fails the whole call with an explicit reason naming it;
/// this function NEVER silently falls back to HEAD/main on a missing base
/// branch (real incident: two missions asked to continue work living on
/// another branch each got a worktree silently rooted at an unrelated HEAD,
/// delivering nothing).
///
/// `merge_branches`: fan-in dependency merge (see Mission.mergeBranches's
/// doc comment, src/lib/agents/types.ts) — after `branch` is created from
/// `base_branch`, each branch here is real-`git merge`d into the new
/// worktree, in order. Every merge branch is verified to exist BEFORE
/// anything is created, same as `base_branch` above — never a silent drop.
/// A merge conflict discards the worktree and fails the whole call with an
/// explicit reason naming the conflicting branch, instead of leaving the
/// mission to start on a half-merged tree.
///
/// Returns the absolute worktree path on success.
/// Returns a clear Err if <repo_path> is not a git repo, <base_branch> or
/// any <merge_branches> entry (when given) does not exist, a merge
/// conflicts, or git fails.
///
/// `async fn` + `spawn_blocking`: this body runs git subprocesses — as a
/// plain sync command it executed on Tauri's MAIN thread, the exact class
/// 921d664/94f0bb0 moved off that thread everywhere else (a slow/hung git
/// here wedges every other invoke and asset request). State is re-derived
/// from the owned `AppHandle` inside the closure — see the `use
/// tauri::Manager` note at the top of this file.
#[tauri::command]
pub(crate) async fn agent_create_worktree(repo_path: String, branch: String, base_branch: Option<String>, merge_branches: Option<Vec<String>>, app: tauri::AppHandle) -> Result<String, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<ProjectRegistry>();
        ensure_repo_in_any_open_project(&repo_path, &registry)?;
        agent_create_worktree_inner(&repo_path, &branch, base_branch.as_deref(), merge_branches.as_deref())
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("agent_create_worktree: blocking task join failed: {}", e)),
    }
}

fn agent_create_worktree_inner(
    repo_path: &str,
    branch: &str,
    base_branch: Option<&str>,
    merge_branches: Option<&[String]>,
) -> Result<String, String> {
    let repo_dir = std::path::Path::new(repo_path);
    // 2026-08-05 (os error 267 incident — see normalize_for_git's doc
    // comment in util.rs): every git subprocess below takes a path derived
    // from caller-supplied `repo_path` as `current_dir`. Normalized ONCE
    // here so a verbatim (`\\?\`-prefixed) path carrying a stray '/' —
    // which disables Win32's '/'-to-'\' translation and makes
    // `Command::current_dir` fail to even SPAWN the child with
    // `ERROR_DIRECTORY_NAME_INVALID` — can never reach any of them. Does
    // NOT change what this function returns (`wt_path_str` below is still
    // built from the original, unmodified `repo_path`) — only what gets
    // handed to `current_dir`.
    let git_cwd = normalize_for_git(repo_path);

    // Check it is a git repo
    let check = quiet_command(git_binary())
        .args(["rev-parse", "--git-dir"])
        .current_dir(&git_cwd)
        .output()
        .map_err(|e| format!("agent_create_worktree: git check failed: {}", e))?;
    if !check.status.success() {
        return Err(format!(
            "agent_create_worktree: '{}' is not a git repository",
            repo_path
        ));
    }

    // Honest base-branch validation: a caller-declared start point that does
    // not actually exist fails HERE, loudly, naming the branch — never a
    // silent fallback to HEAD (see this function's own doc comment above).
    if let Some(base) = base_branch {
        let verify = quiet_command(git_binary())
            .args(["rev-parse", "--verify", "--quiet", &format!("{}^{{commit}}", base)])
            .current_dir(&git_cwd)
            .output()
            .map_err(|e| format!("agent_create_worktree: base branch check failed: {}", e))?;
        if !verify.status.success() {
            return Err(format!(
                "agent_create_worktree: base branch '{}' does not exist in '{}' — refusing to silently fall back to HEAD",
                base, repo_path
            ));
        }
    }

    // Honest merge-branch validation (fan-in dependency join — see this
    // function's own doc comment above): every extra branch a multi-
    // dependency step is about to merge in must exist BEFORE anything is
    // created, same "fail loud, never silently drop" contract as
    // base_branch above.
    if let Some(branches) = merge_branches {
        for b in branches {
            let verify = quiet_command(git_binary())
                .args(["rev-parse", "--verify", "--quiet", &format!("{}^{{commit}}", b)])
                .current_dir(&git_cwd)
                .output()
                .map_err(|e| format!("agent_create_worktree: merge branch check failed: {}", e))?;
            if !verify.status.success() {
                return Err(format!(
                    "agent_create_worktree: merge branch '{}' does not exist in '{}' — refusing to silently drop it from the fan-in merge",
                    b, repo_path
                ));
            }
        }
    }

    // Enable long paths on Windows (avoids "Filename too long" errors with node_modules)
    let _ = quiet_command(git_binary())
        .args(["config", "core.longpaths", "true"])
        .current_dir(&git_cwd)
        .output();

    // Sanitize branch for use as a directory name
    let safe_branch: String = branch
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();

    // Worktree path: <repo>/.lazy/worktrees/<branch>
    let wt_path = repo_dir
        .join(".lazy")
        .join("worktrees")
        .join(&safe_branch);

    // Create parent dir
    if let Some(parent) = wt_path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "agent_create_worktree: create_dir_all failed for '{}': {}",
                parent.display(),
                e
            )
        })?;
    }

    let wt_path_str = wt_path.to_string_lossy().into_owned();

    // Destination passed to the `git worktree add`/`remove` CLI arguments,
    // expressed RELATIVE to `repo_path` (current_dir below) rather than as
    // the absolute `wt_path_str`. On Windows, `repo_path` is typically a
    // `std::fs::canonicalize()`'d path carrying the verbatim/extended-length
    // `\\?\` prefix (see get_project_root/set_project). `current_dir`
    // tolerates a CLEAN verbatim prefix fine, but Git for Windows fails to
    // create a worktree when given a `\\?\`-prefixed path as a literal
    // destination argument ("fatal: could not create leading directories of
    // '//?/...': Invalid argument") — it creates the branch ref but never
    // materializes the working directory, silently breaking mission
    // isolation. Passing a path relative to `current_dir` sidesteps the
    // issue entirely; the function still returns the absolute `wt_path_str`
    // (verbatim prefix included) since downstream consumers only ever use it
    // as `current_dir` for further git invocations, which works correctly —
    // AS LONG AS it is passed through `normalize_for_git` first: a verbatim
    // path is only "current_dir-safe" when clean of stray '/' separators;
    // see `normalize_for_git`'s doc comment (util.rs, 2026-08-05, os error
    // 267) for the case this does NOT cover on its own.
    let wt_rel_str = std::path::Path::new(".lazy")
        .join("worktrees")
        .join(&safe_branch)
        .to_string_lossy()
        .into_owned();

    // Run: git worktree add -b <branch> <wt_rel_str> [<base_branch>]  (relative to repo_path)
    // Appending base_branch as the explicit start point is what makes the
    // new branch descend from it instead of the repo's current HEAD.
    //
    // 2026-08-04 (UC3 dogfood — M11 `worktree_creation_failed: git worktree
    // add error: Preparing worktree...`): two PARALLEL steps of the same
    // plan (M9 + M11, both "Assembler" nodes) ran `git worktree add` in the
    // SAME repo at the same time; git's index.lock/worktree-lock made one of
    // them fail spuriously. Retry transient lock-shaped failures with a
    // short backoff (the competing add finishes in milliseconds), and treat
    // an already-materialized worktree for this branch as success
    // (idempotent re-run), mirroring the "never fail a healthy launch over
    // a transient git lock" contract worktree_cleanup.rs already applies on
    // the removal side.
    let mut add_args: Vec<&str> = vec!["worktree", "add", "-b", branch, &wt_rel_str];
    if let Some(base) = base_branch {
        add_args.push(base);
    }

    let mut last_stderr = String::new();
    let mut add_ok = false;
    for attempt in 0..5i32 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(250 * attempt as u64));
        }
        let output = quiet_command(git_binary())
            .args(&add_args)
            .current_dir(&git_cwd)
            .output()
            .map_err(|e| format!("agent_create_worktree: git worktree add failed: {}", e))?;
        if output.status.success() {
            add_ok = true;
            break;
        }
        last_stderr = String::from_utf8_lossy(&output.stderr).into_owned();

        // Idempotence: the worktree directory already exists AND is a real
        // worktree (has its .git file) — a previous attempt (or a retried
        // mission) already created it. Treat as success.
        if wt_path.join(".git").exists() {
            merge_extra_branches(&wt_path_str, repo_path, &wt_rel_str, merge_branches)?;
            return Ok(wt_path_str);
        }

        let lockish = last_stderr.contains("index.lock")
            || last_stderr.contains("Unable to create")
            || last_stderr.contains("another git process")
            || last_stderr.contains("lock file");
        if !lockish {
            // A non-transient failure — no point retrying.
            break;
        }
    }

    if add_ok {
        merge_extra_branches(&wt_path_str, repo_path, &wt_rel_str, merge_branches)?;
        return Ok(wt_path_str);
    }

    if !output_failure_is_recoverable(&last_stderr) {
        return Err(format!(
            "agent_create_worktree: git worktree add error: {}",
            last_stderr.trim()
        ));
    }

    // If the failure is due to long filenames, retry with --no-checkout
    // and then do a checkout that skips the problematic node_modules
    if last_stderr.contains("Filename too long") || last_stderr.contains("Could not reset index") {
        // Remove the partially-created worktree if it exists
        let _ = quiet_command(git_binary())
            .args(["worktree", "remove", "--force", &wt_rel_str])
            .current_dir(&git_cwd)
            .output();
        // Retry with --no-checkout, same start point as the first attempt.
        let mut retry_args: Vec<&str> = vec!["worktree", "add", "--no-checkout", "-b", branch, &wt_rel_str];
        if let Some(base) = base_branch {
            retry_args.push(base);
        }
        let output2 = quiet_command(git_binary())
            .args(&retry_args)
            .current_dir(&git_cwd)
            .output()
            .map_err(|e| format!("agent_create_worktree: git worktree add (no-checkout) failed: {}", e))?;
        if output2.status.success() {
            merge_extra_branches(&wt_path_str, repo_path, &wt_rel_str, merge_branches)?;
            return Ok(wt_path_str);
        }
        let stderr2 = String::from_utf8_lossy(&output2.stderr);
        return Err(format!(
            "agent_create_worktree: git worktree add error: {}",
            stderr2.trim()
        ));
    }
    Err(format!(
        "agent_create_worktree: git worktree add error: {}",
        last_stderr.trim()
    ))
}

/// 2026-08-04 (UC3 dogfood) — distinguishes a TRANSIENT git failure worth
/// retrying (a competing `git worktree add`/`git merge` holding the repo
/// lock, the UC3 M11 failure) from a permanent one (invalid branch name,
/// bad base, filesystem error). Kept as a tiny helper so the retry policy
/// above reads as a policy, not a wall of string checks.
fn output_failure_is_recoverable(stderr: &str) -> bool {
    stderr.contains("index.lock")
        || stderr.contains("Unable to create")
        || stderr.contains("another git process")
        || stderr.contains("lock file")
        || stderr.contains("Filename too long")
        || stderr.contains("Could not reset index")
}

/// Fan-in dependency merge — real-`git merge`s every branch in
/// `merge_branches`, in order, INTO the freshly-created worktree at
/// `wt_path_str` (see agent_create_worktree_inner's doc comment above for
/// the full contract). A conflict aborts that merge, removes the whole
/// worktree (a half-merged fan-in must never look like a ready mission
/// start point), and fails with an explicit reason naming the branch —
/// never a silent partial merge.
fn merge_extra_branches(
    wt_path_str: &str,
    repo_path: &str,
    wt_rel_str: &str,
    merge_branches: Option<&[String]>,
) -> Result<(), String> {
    let Some(branches) = merge_branches else {
        return Ok(());
    };
    // 2026-08-05 (os error 267 incident — normalize_for_git's doc comment,
    // util.rs): both paths below are caller-derived and reach
    // `current_dir` directly; normalized once so a stray '/' mixed into a
    // verbatim path never fails to spawn git.
    let wt_cwd = normalize_for_git(wt_path_str);
    let repo_cwd = normalize_for_git(repo_path);
    for b in branches {
        let output = quiet_command(git_binary())
            .args(["merge", "--no-edit", b])
            .current_dir(&wt_cwd)
            .output()
            .map_err(|e| format!("agent_create_worktree: git merge '{}' failed: {}", b, e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let _ = quiet_command(git_binary())
                .args(["merge", "--abort"])
                .current_dir(&wt_cwd)
                .output();
            let _ = quiet_command(git_binary())
                .args(["worktree", "remove", "--force", wt_rel_str])
                .current_dir(&repo_cwd)
                .output();
            return Err(format!(
                "agent_create_worktree: merging dependency branch '{}' produced a conflict — refusing to start the mission on a broken merge: {}",
                b,
                stderr.trim()
            ));
        }
    }
    Ok(())
}

/// Get unified diff of all changes in a worktree vs HEAD.
///
/// Runs `git -C <worktree_path> diff HEAD` to show tracked changes,
/// then appends headers for untracked files (content shown inline).
///
/// Returns the unified diff string (may be empty if no changes).
#[tauri::command]
pub(crate) fn agent_worktree_diff(worktree_path: String, project_registry: tauri::State<ProjectRegistry>) -> Result<String, String> {
    ensure_repo_in_any_open_project(&worktree_path, &project_registry)?;
    agent_worktree_diff_inner(&worktree_path)
}

fn agent_worktree_diff_inner(worktree_path: &str) -> Result<String, String> {
    // 2026-08-05 (os error 267 incident — normalize_for_git's doc comment,
    // util.rs): only for `current_dir` below — the fs::read_to_string join
    // further down deliberately keeps using the original `worktree_path`
    // (a verbatim prefix is fine, even preferable, for direct file APIs).
    let cwd = normalize_for_git(worktree_path);

    // Staged+unstaged diff vs HEAD
    let output = quiet_command(git_binary())
        .args(["diff", "HEAD"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("agent_worktree_diff: git diff failed: {}", e))?;

    let mut diff = String::from_utf8_lossy(&output.stdout).into_owned();

    // Also include untracked new files (stage them temporarily to diff)
    let ls_output = quiet_command(git_binary())
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("agent_worktree_diff: git ls-files failed: {}", e))?;

    let untracked = String::from_utf8_lossy(&ls_output.stdout);
    for fname in untracked.lines() {
        // App-infrastructure junk is not part of the mission's work: the
        // agent worktree has no .gitignore (the root project's own
        // `.lazy/`+`.lazybrain/` ignore file is untracked, so worktree
        // checkouts never carry it), which made the brain's cache files
        // (`.lazybrain/brain/.cache-migrated`, `_cache/fts.sqlite`) show up
        // in every evaluator diff (run-10 forensics: reviewers commented on
        // the cache file in an otherwise 1-line README mission). Mirrors
        // agent_merge_worktree_inner's Step 1a exclusion below.
        if is_agent_infra_path(fname) {
            continue;
        }
        let fpath = std::path::Path::new(&worktree_path).join(fname);
        if let Ok(content) = fs::read_to_string(&fpath) {
            diff.push_str(&format!(
                "\n--- /dev/null\n+++ b/{}\n@@ -0,0 +1,{} @@\n",
                fname,
                content.lines().count()
            ));
            for line in content.lines() {
                diff.push('+');
                diff.push_str(line);
                diff.push('\n');
            }
        }
    }

    Ok(diff)
}

/// True when `rel_path` (forward-slash relative path, as git prints it) is
/// app infrastructure that must never ride along with a mission's own work:
/// `.lazy/` (worktrees, artifacts, missions.json) and `.lazybrain/` (brain
/// caches — including a LIVE-OPEN `_cache/fts.sqlite` the running app holds
/// a handle on). Component-boundary aware: `.lazyfoo` is NOT matched.
fn is_agent_infra_path(rel_path: &str) -> bool {
    rel_path == ".lazy"
        || rel_path.starts_with(".lazy/")
        || rel_path == ".lazybrain"
        || rel_path.starts_with(".lazybrain/")
}

/// Merge the agent's worktree branch into the current branch, then clean up.
///
/// Steps:
/// 1. Stage + commit all changes in the worktree on its branch — EXCLUDING
///    `.lazy/` and `.lazybrain/` (see `is_agent_infra_path`): the worktree
///    has no .gitignore (the root's own ignore file is untracked and thus
///    absent from checkouts), so a bare `git add -A` used to commit brain
///    caches onto the mission branch. Run-11 forensics: merging those
///    paths back into the ROOT then has git overwrite `.lazybrain/brain/
///    _cache/fts.sqlite` — a SQLite file the live app can hold OPEN — and
///    pollutes the user's history with cache junk. Mission commits must
///    carry the mission's work only.
/// 2. `git -C <repo_path> merge --no-ff <branch>` into the current branch.
///    A refused merge (real local changes to a file the merge touches, or
///    autocrlf phantom-dirt on Windows — an LF-on-disk file under
///    core.autocrlf=true that git counts as "local changes" even though
///    the content matches HEAD) surfaces as a clear Err; the caller
///    (agentsStore.approveMission) propagates it to the UI instead of
///    pretending success. NOTE: git's rollback of a refused merge may
///    rewrite the touched files with fresh line endings (run-11: README.md
///    LF→CRLF, content unchanged) — that is git's own behavior, not ours.
/// 3. Remove the worktree directory AND delete its branch — ONLY reached
///    after step 2 succeeds, so a failed merge (conflict, etc.) always
///    leaves the worktree + branch intact for the user to retry or inspect.
///    See worktree_cleanup::cleanup_worktree_and_branch for the Windows
///    verbatim-path fix (git worktree remove used to silently no-op on a
///    real desktop run — repo_path there is canonicalize()'d, i.e.
///    `\\?\`-prefixed, which git-for-windows rejects as a literal `remove`
///    argument) and the retry/idempotence behavior shared with the
///    discard/stop path below.
///
/// The worktree_path is derived from `repo_path` + the branch name:
/// <repo_path>/.lazy/worktrees/<branch> — `repo_path` here MUST always be
/// the true repo root a worktree was created under (`agent_create_worktree`'s
/// own `repoPath` argument), never a linked worktree's own directory, or
/// this lookup resolves to a path that was never created and Step 1 fails.
///
/// `merge_into_dir`: the directory whose CURRENT branch actually receives
/// the `git merge` in Step 2 — defaults to `repo_path` when `None` (today's
/// original behavior: merge into the main repo root's checked-out branch).
/// Orchestrator sub-agent fan-out (runtime.ts Step E) needs these to
/// DIFFER: a role sub-agent's worktree is always created under the true
/// repo root (so `repo_path` stays correct for Step 1's lookup), but its
/// work must land on the PARENT MISSION's own branch, which is checked out
/// in the parent's own worktree directory, not in `repo_path` — passing
/// that worktree path as `merge_into_dir` targets the merge there instead.
/// (Previously the call site substituted the parent worktree path in for
/// `repo_path` itself, which fixed the merge target but broke Step 1's
/// lookup — `git add`/`commit` ran against a nested, nonexistent
/// `<parent-worktree>/.lazy/worktrees/<child>` path, failed, and the caller
/// silently swallowed the error: the exact "sub-agent work never reaches
/// the parent mission's branch" defect this parameter fixes.)
///
/// Returns the merge commit's sha (T1.7 — revert support): captured via
/// `git rev-parse HEAD` in `merge_into_dir` (or `repo_path`) right after the
/// merge commit lands, before worktree cleanup runs. `git_revert_merge`
/// below needs it to `git revert -m 1` this exact commit later ("Revert
/// mission", spec §8).
///
/// `async fn` + `spawn_blocking`: same rationale as agent_create_worktree
/// above — git subprocesses must not run on Tauri's main thread.
#[tauri::command]
pub(crate) async fn agent_merge_worktree(
    repo_path: String,
    branch: String,
    merge_into_dir: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<ProjectRegistry>();
        ensure_repo_in_any_open_project(&repo_path, &registry)?;
        agent_merge_worktree_inner(&repo_path, &branch, merge_into_dir.as_deref())
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("agent_merge_worktree: blocking task join failed: {}", e)),
    }
}

/// Inner implementation of agent_merge_worktree — usable in tests without a
/// tauri::State (the project-root guard lives in the outer command). See
/// `agent_merge_worktree`'s doc comment above for `merge_into_dir`.
fn agent_merge_worktree_inner(repo_path: &str, branch: &str, merge_into_dir: Option<&str>) -> Result<String, String> {
    let merge_target = merge_into_dir.unwrap_or(repo_path);
    let safe_branch: String = branch
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();

    let wt_path = std::path::Path::new(repo_path)
        .join(".lazy")
        .join("worktrees")
        .join(&safe_branch);
    let wt_path_str = wt_path.to_string_lossy().into_owned();

    // 2026-08-05 (os error 267 incident — see normalize_for_git's doc
    // comment in util.rs): `wt_path_str` and `merge_target` are both
    // caller-derived paths — `merge_target` directly from `merge_into_dir`,
    // which (unlike `repoPath`) reaches this command from runtime.ts's
    // mergeWorktree WITHOUT going through paths.ts's normalizeRepoPathForGit
    // (see this function's own doc comment above for the orchestrator
    // fan-out shape that sets it). Normalized ONCE here so a verbatim path
    // carrying a stray '/' can never fail every `current_dir` below with
    // "ERROR_DIRECTORY_NAME_INVALID" — this was the exact prod "some merges
    // fail, others pass" shape: a top-level merge (`merge_into_dir` = None,
    // so `merge_cwd` reduces to the already-normalized `repoPath`) was
    // clean; a fan-in merge (`merge_into_dir` set to an un-normalized
    // parent worktree path) was not. `wt_path_str`/`merge_target` themselves
    // are untouched everywhere else in this function (incl. the cleanup
    // call at the end) — only what reaches `current_dir` changes.
    let wt_cwd = normalize_for_git(&wt_path_str);
    let merge_cwd = normalize_for_git(merge_target);

    // Step 1a: stage all of the worktree's own work. The worktree carries the
    // repo's TRACKED `.gitignore` (present in every checkout), which already
    // ignores `.lazy/` and `.lazybrain/` app infrastructure — so a plain
    // `git add -A -- .` stages the mission's real changes and naturally skips
    // the infra. The former explicit `:(exclude).lazy`/`:(exclude).lazybrain`
    // pathspecs were added back when worktrees had NO `.gitignore`; now that it
    // IS tracked, naming those already-ignored paths in the pathspec makes git
    // abort the ENTIRE add with "The following paths are ignored by one of your
    // .gitignore files: .lazy" (exit 1) — staging nothing and failing every
    // merge whenever a worktree happens to carry a nested `.lazy/` (e.g. agent
    // definitions the app wrote into it). Rely on `.gitignore` for exclusion;
    // `is_agent_infra_path` still guards the untracked-file path above.
    let add_out = quiet_command(git_binary())
        .args(["add", "-A", "--", "."])
        .current_dir(&wt_cwd)
        .output()
        .map_err(|e| format!("agent_merge_worktree: git add failed: {}", e))?;
    if !add_out.status.success() {
        let stderr = String::from_utf8_lossy(&add_out.stderr);
        return Err(format!(
            "agent_merge_worktree: git add error: {}",
            stderr.trim()
        ));
    }

    // Step 1b: check if there is anything to commit. STAGED changes only
    // (`git diff --cached --quiet`, exit 1 = staged diff present) — the old
    // `git status --porcelain` check also counted the untracked `.lazy/`/
    // `.lazybrain/` junk Step 1a now deliberately leaves unstaged, which
    // would send an empty commit to `git commit` ("nothing added to commit
    // but untracked files present", exit 1) and fail the whole merge.
    let staged_out = quiet_command(git_binary())
        .args(["diff", "--cached", "--quiet"])
        .current_dir(&wt_cwd)
        .output()
        .map_err(|e| format!("agent_merge_worktree: git diff --cached failed: {}", e))?;
    let has_changes = match staged_out.status.code() {
        Some(0) => false,
        Some(1) => true,
        _ => {
            let stderr = String::from_utf8_lossy(&staged_out.stderr);
            return Err(format!(
                "agent_merge_worktree: git diff --cached error: {}",
                stderr.trim()
            ));
        }
    };

    if has_changes {
        // Step 1c: commit
        let commit_out = quiet_command(git_binary())
            .args(["commit", "-m", &format!("feat(agent): mission on {}", branch)])
            .current_dir(&wt_cwd)
            .output()
            .map_err(|e| format!("agent_merge_worktree: git commit failed: {}", e))?;
        if !commit_out.status.success() {
            let stderr = String::from_utf8_lossy(&commit_out.stderr);
            return Err(format!(
                "agent_merge_worktree: git commit error: {}",
                stderr.trim()
            ));
        }
    }

    // Step 2: merge into main repo's current branch. `-m` supplies the
    // message; `--no-edit` is belt-and-braces so no configuration (or a
    // future `-m` removal) can ever make git spawn an editor inside this
    // windowless app and wait forever.
    let merge_out = quiet_command(git_binary())
        .args([
            "merge",
            "--no-ff",
            "--no-edit",
            branch,
            "-m",
            &format!("merge(agent): {}", branch),
        ])
        .current_dir(&merge_cwd)
        .output()
        .map_err(|e| format!("agent_merge_worktree: git merge failed: {}", e))?;
    if !merge_out.status.success() {
        // QA bug (severe): a conflicting `git merge` used to just return Err
        // here, leaving merge_target — the USER'S OWN working tree (or, for
        // orchestrator fan-out, the parent mission's own worktree), not the
        // sub-agent's isolated worktree — stuck mid-merge forever: MERGE_HEAD
        // present, conflict markers in files, some paths staged. The app
        // surfaced nothing persistent (a transient toast at best), so the
        // user had no idea their real project was left broken. git's own
        // conflict narration ("Auto-merging <file>", "CONFLICT (content):
        // ...", "Automatic merge failed...") is printed to STDOUT, not
        // stderr — the old code only ever read `.stderr`, so this error
        // message used to be empty/unhelpful on exactly the conflict case
        // that most needed it. Both streams are captured below.
        let stdout = String::from_utf8_lossy(&merge_out.stdout);
        let stderr = String::from_utf8_lossy(&merge_out.stderr);
        let combined = format!("{}\n{}", stdout.trim(), stderr.trim());
        let combined = combined.trim();

        // `git rev-parse --verify MERGE_HEAD` is the authoritative,
        // locale-independent signal that a merge is actually in progress
        // (works whether merge_target is a plain checkout or itself a linked
        // worktree) — more robust than grepping the message text.
        let has_merge_head = quiet_command(git_binary())
            .args(["rev-parse", "-q", "--verify", "MERGE_HEAD"])
            .current_dir(&merge_cwd)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if has_merge_head {
            // Always abort — the merge itself already failed, so an abort
            // hiccup must not mask the real error, but this is what
            // guarantees the user's tree comes back clean instead of
            // sitting mid-conflict indefinitely. Best-effort: ignore its
            // own exit code/output.
            let _ = quiet_command(git_binary())
                .args(["merge", "--abort"])
                .current_dir(&merge_cwd)
                .output();
            return Err(format!("MERGE_CONFLICT: {}", combined));
        }

        return Err(format!(
            "agent_merge_worktree: git merge error: {}",
            combined
        ));
    }

    // Capture the merge commit sha (T1.7 — revert support) BEFORE cleanup.
    // Read from merge_target, not repo_path — that's where the merge commit
    // above actually landed (they only coincide when merge_into_dir is
    // None). Cleanup below only removes the worktree dir + deletes `branch`
    // — it never touches merge_target's HEAD — but reading it as soon as
    // the merge commit exists keeps this in the same "right after step 2"
    // spot as the rest of this function's own narration.
    let merge_sha = git_rev_parse_head(&merge_cwd)?;

    // Step 3: remove the worktree + delete its branch. Reached ONLY after
    // merge_out.status.success() above — a failed merge returns Err before
    // this line, so cleanup never runs on a failed merge (only-on-success:
    // the worktree/branch survive intact for retry or inspection). Shared
    // with agent_discard_worktree_inner's cleanup below via
    // cleanup_worktree_and_branch — see its doc comment (worktree_cleanup.rs)
    // for the Windows verbatim-path fix and retry/idempotence behavior.
    // Failures there are logged, not propagated: the merge itself already
    // succeeded, so a cleanup hiccup must not be reported as a mission
    // failure (but must not be silently pretended-away either).
    crate::commands::worktree_cleanup::cleanup_worktree_and_branch(repo_path, &wt_path_str, branch);

    Ok(merge_sha)
}

/// Resolve HEAD's commit sha in `repo_path` via `git rev-parse HEAD`.
/// Shared by `agent_merge_worktree_inner` (captures the merge commit) and
/// `git_revert_merge_inner` below (captures the revert commit).
fn git_rev_parse_head(repo_path: &str) -> Result<String, String> {
    // 2026-08-05 (os error 267 incident — normalize_for_git's doc comment,
    // util.rs): belt-and-braces even though agent_merge_worktree_inner
    // already normalizes before calling this — git_revert_merge_inner below
    // calls this too, with its own `repo_path` that may not be.
    let output = quiet_command(git_binary())
        .args(["rev-parse", "HEAD"])
        .current_dir(normalize_for_git(repo_path))
        .output()
        .map_err(|e| format!("git rev-parse HEAD failed: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git rev-parse HEAD error: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Discard an agent worktree without merging.
///
/// Removes the worktree directory AND deletes its branch — see
/// worktree_cleanup::cleanup_worktree_and_branch (shared with
/// agent_merge_worktree_inner's post-merge cleanup above) for the Windows
/// verbatim-path fix and idempotent-retry behavior.
///
/// `async fn` + `spawn_blocking`: same rationale as agent_create_worktree
/// above — git subprocesses must not run on Tauri's main thread.
#[tauri::command]
pub(crate) async fn agent_discard_worktree(
    repo_path: String,
    worktree_path: String,
    branch: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    match tauri::async_runtime::spawn_blocking(move || {
        agent_discard_worktree_guarded(&repo_path, &worktree_path, &branch, &app)
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("agent_discard_worktree: blocking task join failed: {}", e)),
    }
}

/// Guard + body of `agent_discard_worktree`, on the blocking pool. Split
/// out (rather than inlined in the closure like its create/merge siblings)
/// because the original command carried an in-body doc block about
/// worktree_path validation that reads better on a named function.
fn agent_discard_worktree_guarded(
    repo_path: &str,
    worktree_path: &str,
    branch: &str,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let registry = app.state::<ProjectRegistry>();
    ensure_repo_in_any_open_project(repo_path, &registry)?;
    // worktree_path is intentionally NOT validated via ensure_repo_in_any_open_project
    // here: that check canonicalize()s its input, which requires the target
    // to exist on disk — but discarding an ALREADY-removed worktree
    // (idempotent re-call, e.g. agentsStore.tsx's stopMission firing a direct
    // cleanup call that can race runMission's own independent cleanup path)
    // is an expected, legitimate no-op, not an error. The containment
    // boundary is instead enforced lexically inside cleanup_worktree_and_branch
    // (is_within_agent_worktrees_dir), which works whether or not the target
    // currently exists.
    agent_discard_worktree_inner(repo_path, worktree_path, branch)
}

fn agent_discard_worktree_inner(repo_path: &str, worktree_path: &str, branch: &str) -> Result<(), String> {
    crate::commands::worktree_cleanup::cleanup_worktree_and_branch(repo_path, worktree_path, branch);
    Ok(())
}

/// Revert a merge commit produced by `agent_merge_worktree` ("Revert
/// mission" — merged case, spec §8: "if merged: `git revert` of the merge
/// commit").
///
/// Reverting a MERGE commit needs `-m 1` (mainline parent 1 — the branch
/// that was merged INTO, i.e. `repo_path`'s own history before the agent's
/// branch landed): a plain `git revert <sha>` always fails on a merge
/// commit with "mainline was not specified", since git cannot infer on its
/// own which parent is "the line of history to preserve".
///
/// Dirty-tree protection is delegated to git itself: `git revert` refuses
/// with "your local changes would be overwritten by revert" when (and only
/// when) uncommitted changes overlap the paths the revert touches, and that
/// refusal is surfaced verbatim as this command's Err. The previous blanket
/// pre-check (`git status --porcelain` non-empty → refuse) made revert
/// unusable in ANY real project: the app itself drops an untracked
/// `.gitignore` into every project root and users routinely have unrelated
/// edits open — none of which `git revert -m 1` of a mission merge actually
/// endangers (verified: unrelated dirty/untracked files revert fine;
/// overlapping or staged changes still refuse via git's own guard). The
/// caller's uncommitted work is never stashed or folded into the revert
/// commit either way — `git revert` commits only the inverse of the merge.
///
/// On a revert conflict, aborts the in-progress revert (`git revert
/// --abort`) before returning the error. This differs from
/// `agent_merge_worktree`'s "only remove on failure" contract further up
/// this file: a failed agent merge leaves the AGENT'S OWN disposable
/// worktree/branch intact for retry, but a failed revert here runs directly
/// against the caller's real repository — leaving it stuck mid-conflict
/// would strand the actual project tree, not a throwaway worktree, so this
/// command cleans up after its own failure instead.
///
/// Returns the revert commit's sha on success.
///
/// `async fn` + `spawn_blocking`: same rationale as agent_create_worktree
/// above — git subprocesses must not run on Tauri's main thread.
#[tauri::command]
pub(crate) async fn git_revert_merge(
    repo_path: String,
    merge_sha: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<ProjectRegistry>();
        ensure_repo_in_any_open_project(&repo_path, &registry)?;
        git_revert_merge_inner(&repo_path, &merge_sha)
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("git_revert_merge: blocking task join failed: {}", e)),
    }
}

/// Inner implementation of git_revert_merge — usable in tests without a
/// tauri::State (the project-root guard lives in the outer command).
fn git_revert_merge_inner(repo_path: &str, merge_sha: &str) -> Result<String, String> {
    // 2026-08-05 (os error 267 incident — normalize_for_git's doc comment,
    // util.rs): same class as agent_merge_worktree_inner above — `repo_path`
    // is a caller-supplied path used as `current_dir` for every git call in
    // this function.
    let cwd = normalize_for_git(repo_path);

    // A merge commit is any commit with a second parent (`<sha>^2` resolves).
    // `git revert -m 1` on a non-merge commit fails anyway, but checking
    // this up front produces a clear, purpose-specific error message instead
    // of git's own generic one.
    let parent2 = quiet_command(git_binary())
        .args(["rev-parse", "--verify", "--quiet", &format!("{}^2", merge_sha)])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git_revert_merge: git rev-parse failed: {}", e))?;
    if !parent2.status.success() {
        return Err(format!(
            "git_revert_merge: '{}' is not a merge commit (no second parent) — nothing to revert as a merge",
            merge_sha
        ));
    }

    let revert_out = quiet_command(git_binary())
        .args(["revert", "-m", "1", "--no-edit", merge_sha])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git_revert_merge: git revert failed: {}", e))?;

    if !revert_out.status.success() {
        let stderr = String::from_utf8_lossy(&revert_out.stderr).trim().to_string();
        // Best-effort: leave the caller's real repo clean rather than
        // mid-conflict — see this function's doc comment.
        let _ = quiet_command(git_binary())
            .args(["revert", "--abort"])
            .current_dir(&cwd)
            .output();
        return Err(format!("git_revert_merge: git revert error: {}", stderr));
    }

    git_rev_parse_head(&cwd)
}

#[cfg(test)]
mod tests;
