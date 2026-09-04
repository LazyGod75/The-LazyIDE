//! Git status/diff/branch-read primitives: `git_status`, `git_diff`,
//! `git_current_branch`, plus `git_binary()` (shared by every sibling
//! module in this directory). Split out of the former flat `git.rs` --
//! see `super::` (this directory's `mod.rs`) for the module map.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::state::ProjectRegistry;
use crate::commands::util::{ensure_repo_in_any_open_project, quiet_command, truncate_on_char_boundary};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String, // "modified" | "added" | "deleted" | "untracked" | "renamed"
}

/// Resolve the git binary: prefer `git` on PATH, but on Windows also try
/// the common Git-for-Windows installation path.
pub(crate) fn git_binary() -> String {
    "git".to_string()
}

/// Run `git status --porcelain=v1 -u` in `repo_path` and parse the output
/// into a list of `GitFileStatus`.
#[tauri::command]
pub(crate) fn git_status(repo_path: String, project_registry: tauri::State<ProjectRegistry>) -> Result<Vec<GitFileStatus>, String> {
    ensure_repo_in_any_open_project(&repo_path, &project_registry)?;
    git_status_inner(&repo_path)
}

fn git_status_inner(repo_path: &str) -> Result<Vec<GitFileStatus>, String> {
    let output = quiet_command(git_binary())
        .args(["status", "--porcelain=v1", "-u"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("git status failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git status error: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut result = Vec::new();

    for line in stdout.lines() {
        if line.len() < 3 {
            continue;
        }
        // Porcelain v1: XY PATH or XY ORIG -> PATH. git's XY status codes and
        // the following separator are documented as always-ASCII, but these
        // slices stay char-boundary-safe defensively rather than trusting an
        // external process's output never to deviate from spec (never-panic
        // on external data).
        let xy = truncate_on_char_boundary(line, 2);
        let path_part = line.get(3..).unwrap_or("").trim();
        // For renames: "R  old -> new", take the last segment
        let file_path = if let Some(arrow) = path_part.find(" -> ") {
            path_part[arrow + 4..].to_string()
        } else {
            path_part.to_string()
        };

        let status = parse_porcelain_status(xy);
        if let Some(s) = status {
            result.push(GitFileStatus { path: file_path, status: s.to_string() });
        }
    }

    Ok(result)
}

fn parse_porcelain_status(xy: &str) -> Option<&'static str> {
    let x = xy.chars().next().unwrap_or(' ');
    let y = xy.chars().nth(1).unwrap_or(' ');

    // Untracked
    if x == '?' && y == '?' {
        return Some("untracked");
    }
    // Deleted (index or working tree)
    if x == 'D' || y == 'D' {
        return Some("deleted");
    }
    // Renamed
    if x == 'R' || y == 'R' {
        return Some("renamed");
    }
    // Added / new file
    if x == 'A' || y == 'A' {
        return Some("added");
    }
    // Modified
    if x == 'M' || y == 'M' || x == 'U' || y == 'U' {
        return Some("modified");
    }

    None
}

/// Return unified diff of `file_path` vs HEAD inside `repo_path`.
/// If `file_path` is empty, returns the full working-tree diff.
/// Falls back to a staged diff vs empty tree for untracked/new files.
#[tauri::command]
pub(crate) fn git_diff(repo_path: String, file_path: String, project_registry: tauri::State<ProjectRegistry>) -> Result<String, String> {
    ensure_repo_in_any_open_project(&repo_path, &project_registry)?;
    git_diff_inner(&repo_path, &file_path)
}

fn git_diff_inner(repo_path: &str, file_path: &str) -> Result<String, String> {
    let path_is_empty = file_path.trim().is_empty();

    // Working-tree vs HEAD (covers modified & deleted)
    let mut args: Vec<&str> = vec!["diff", "HEAD"];
    if !path_is_empty {
        args.push("--");
        args.push(file_path);
    }

    let output = quiet_command(git_binary())
        .args(&args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("git diff failed: {}", e))?;

    let diff = String::from_utf8_lossy(&output.stdout).into_owned();
    if !diff.is_empty() {
        return Ok(diff);
    }

    // New/staged file: diff against the empty tree object
    // (only relevant when file_path is specified — staged new files)
    if !path_is_empty {
        let output2 = quiet_command(git_binary())
            .args([
                "diff",
                "--cached",
                "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
                "--",
                file_path,
            ])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("git diff (staged) failed: {}", e))?;

        Ok(String::from_utf8_lossy(&output2.stdout).into_owned())
    } else {
        Ok(diff)
    }
}

/// Return the current branch name (or a detached HEAD description).
#[tauri::command]
pub(crate) fn git_current_branch(repo_path: String, project_registry: tauri::State<ProjectRegistry>) -> Result<String, String> {
    ensure_repo_in_any_open_project(&repo_path, &project_registry)?;
    // Try gix first for a zero-subprocess branch read
    if let Ok(repo) = gix::open(Path::new(&repo_path)) {
        if let Ok(head) = repo.head() {
            use gix::head::Kind;
            match head.kind {
                Kind::Symbolic(r) => {
                    let name = r.name.shorten().to_string();
                    return Ok(name);
                }
                Kind::Detached { target, .. } => {
                    return Ok(format!("detached@{:.7}", target));
                }
                Kind::Unborn(r) => {
                    return Ok(r.shorten().to_string());
                }
            }
        }
    }

    // Fallback: git CLI
    let output = quiet_command(git_binary())
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("git rev-parse failed: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Create a temp dir, `git init`, commit a file, modify it, then verify
    /// git_status returns it as "modified" and git_diff returns a non-empty diff.
    #[test]
    fn git_status_and_diff_modified_file() {
        let dir = TempDir::new().expect("TempDir::new failed");
        let root = dir.path().to_str().unwrap().to_string();

        // Init repo
        let init = quiet_command("git")
            .args(["init"])
            .current_dir(&root)
            .output()
            .expect("git init failed");
        assert!(init.status.success(), "git init: {}", String::from_utf8_lossy(&init.stderr));

        // Configure identity so commit works without global config
        quiet_command("git")
            .args(["config", "user.email", "test@lazy.dev"])
            .current_dir(&root)
            .output()
            .expect("git config email failed");
        quiet_command("git")
            .args(["config", "user.name", "Lazy Test"])
            .current_dir(&root)
            .output()
            .expect("git config name failed");

        // Write + commit a file
        let file_path = dir.path().join("hello.txt");
        std::fs::write(&file_path, "line one\n").expect("write failed");

        quiet_command("git")
            .args(["add", "hello.txt"])
            .current_dir(&root)
            .output()
            .expect("git add failed");

        let commit = quiet_command("git")
            .args(["commit", "-m", "initial"])
            .current_dir(&root)
            .output()
            .expect("git commit failed");
        assert!(commit.status.success(), "git commit: {}", String::from_utf8_lossy(&commit.stderr));

        // Modify the file (working tree, not staged)
        std::fs::write(&file_path, "line one\nline two\n").expect("write failed");

        // -- git_status must include hello.txt as "modified"
        let statuses = git_status_inner(&root).expect("git_status failed");
        let modified = statuses.iter().any(|s| s.path == "hello.txt" && s.status == "modified");
        assert!(
            modified,
            "Expected hello.txt to be 'modified', got: {:?}",
            statuses
        );

        // -- git_diff must return a non-empty diff
        let diff = git_diff_inner(&root, "hello.txt").expect("git_diff failed");
        assert!(
            !diff.is_empty(),
            "Expected non-empty diff for hello.txt"
        );
        // The diff should contain the new line
        assert!(
            diff.contains("+line two"),
            "Expected '+line two' in diff, got: {:?}",
            diff
        );
    }
}
