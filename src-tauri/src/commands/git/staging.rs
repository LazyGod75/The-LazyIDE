//! Staging/commit/push primitives: `git_stage`, `git_unstage`, `git_commit`,
//! `git_push`, `git_can_push`. Split out of the former flat `git.rs` -- see
//! `super::` (this directory's `mod.rs`) for the module map.

use serde::{Deserialize, Serialize};

use crate::state::ProjectRegistry;
use crate::commands::util::{ensure_repo_in_any_open_project, quiet_command};

use super::status::git_binary;

/// Stage specific file paths in a repository.
///
/// Runs: `git -C <repo_path> add -- <paths...>`
#[tauri::command]
pub(crate) fn git_stage(repo_path: String, paths: Vec<String>, project_registry: tauri::State<ProjectRegistry>) -> Result<(), String> {
    ensure_repo_in_any_open_project(&repo_path, &project_registry)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["add", "--"];
    let path_refs: Vec<&str> = paths.iter().map(|p| p.as_str()).collect();
    args.extend_from_slice(&path_refs);
    let output = quiet_command(git_binary())
        .args(&args)
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("git stage: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git stage error: {}", stderr.trim()));
    }
    Ok(())
}

/// Unstage specific file paths in a repository.
///
/// Runs: `git -C <repo_path> reset HEAD -- <paths...>`
#[tauri::command]
pub(crate) fn git_unstage(repo_path: String, paths: Vec<String>, project_registry: tauri::State<ProjectRegistry>) -> Result<(), String> {
    ensure_repo_in_any_open_project(&repo_path, &project_registry)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["reset", "HEAD", "--"];
    let path_refs: Vec<&str> = paths.iter().map(|p| p.as_str()).collect();
    args.extend_from_slice(&path_refs);
    let output = quiet_command(git_binary())
        .args(&args)
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("git unstage: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // git reset returns exit 1 on an unborn HEAD — treat as soft warning
        if stderr.contains("ambiguous argument 'HEAD'") {
            return Ok(());
        }
        return Err(format!("git unstage error: {}", stderr.trim()));
    }
    Ok(())
}

/// Commit staged changes in a repository with the given message.
///
/// Runs: `git -C <repo_path> commit -m <message>`
/// Returns a clear Err if there is nothing staged to commit.
#[tauri::command]
pub(crate) fn git_commit(repo_path: String, message: String, project_registry: tauri::State<ProjectRegistry>) -> Result<(), String> {
    ensure_repo_in_any_open_project(&repo_path, &project_registry)?;
    if message.trim().is_empty() {
        return Err("git commit: commit message must not be empty".to_string());
    }
    let output = quiet_command(git_binary())
        .args(["commit", "-m", &message])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("git commit: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let combined = format!("{}{}", stderr.trim(), stdout.trim());
        return Err(format!("git commit error: {}", combined));
    }
    Ok(())
}

/// Push the current branch to its remote tracking branch.
///
/// Runs: `git -C <repo_path> push`
#[tauri::command]
pub(crate) fn git_push(repo_path: String, project_registry: tauri::State<ProjectRegistry>) -> Result<(), String> {
    ensure_repo_in_any_open_project(&repo_path, &project_registry)?;
    let output = quiet_command(git_binary())
        .args(["push"])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("git push: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git push error: {}", stderr.trim()));
    }
    Ok(())
}

/// Result of `git_can_push` — a small, honest probe the post-merge push path
/// (agentsStore's approveMissionInner -> missionPush.ts) uses to decide
/// whether a real `git push` would even have a destination BEFORE attempting
/// it, and to report the truth to the user ("pushed", "skipped: no remote",
/// "skipped: no upstream") instead of blocking on a pointless push attempt.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GitCanPushResult {
    /// Whether the repo has at least one configured remote (`origin` or any).
    pub has_remote: bool,
    /// Whether the current branch has a configured upstream (tracking branch).
    pub has_upstream: bool,
}

/// Non-command inner probe shared by the `git_can_push` command and unit tests.
///
/// `has_remote`: `git -C <repo> remote` non-empty.
/// `has_upstream`: `git -C <repo> rev-parse --abbrev-ref @{upstream}` succeeds.
fn git_can_push_inner(repo_path: &str) -> Result<GitCanPushResult, String> {
    let remote_out = quiet_command(git_binary())
        .args(["remote"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("git can_push: remote probe failed: {}", e))?;
    // A git error reading remotes is a real, reportable failure (the repo
    // exists because the caller already passed the merge), not an absence.
    if !remote_out.status.success() && !remote_out.stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&remote_out.stderr);
        return Err(format!("git can_push: remote probe error: {}", stderr.trim()));
    }
    let remotes = String::from_utf8_lossy(&remote_out.stdout);
    let has_remote = remotes.split_whitespace().count() > 0;

    let up_out = quiet_command(git_binary())
        .args(["rev-parse", "--abbrev-ref", "@{upstream}"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("git can_push: upstream probe failed: {}", e))?;
    let has_upstream = up_out.status.success();

    Ok(GitCanPushResult { has_remote, has_upstream })
}

/// Probe whether a `git push` in `repo_path` would have a destination.
///
/// Returns `{ has_remote, has_upstream }` — the TERMINAL signal the post-merge
/// push path needs. Does NOT push. Never blocks on a real push it can't know
/// the answer to from cheap local git reads.
#[tauri::command]
pub(crate) fn git_can_push(repo_path: String, project_registry: tauri::State<ProjectRegistry>) -> Result<GitCanPushResult, String> {
    ensure_repo_in_any_open_project(&repo_path, &project_registry)?;
    git_can_push_inner(&repo_path)
}
