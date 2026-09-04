//! Branch-level read primitives: `git_orphan_worktrees` (fleet-hygiene rule
//! j), `git_branches`, `git_log`. Split out of the former flat `git.rs` --
//! see `super::` (this directory's `mod.rs`) for the module map.

use serde::{Deserialize, Serialize};

use crate::state::ProjectRegistry;
use crate::commands::util::{ensure_repo_in_any_open_project, quiet_command};

use super::status::git_binary;

/// One orphan agent-worktree branch, classified against the CURRENT branch's
/// HEAD — see `git_orphan_worktrees`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OrphanWorktreeBranch {
    pub name: String,
    pub head_sha: String,
    pub contained_in_target: bool,
}

/// Result of `git_orphan_worktrees`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OrphanWorktreesResult {
    /// Branches carrying REAL work not reachable from the current HEAD —
    /// the caller should merge these, never delete them.
    pub recoverable: Vec<OrphanWorktreeBranch>,
    /// Branches whose HEAD is already contained in the current branch —
    /// nothing to lose; the caller may delete them.
    pub empty: Vec<OrphanWorktreeBranch>,
}

/// Inner probe shared by the `git_orphan_worktrees` command and unit tests.
///
/// Lists every branch matching the app's agent-worktree naming (`agent/*`,
/// or the older `M<n>-<role>-wt` fleet shape), skips main/master, and for
/// each computes:
///   - `head_sha`: `git rev-parse <branch>`
///   - `contained_in_target`: `git merge-base --is-ancestor <sha> HEAD`
///     (exit 0 = reachable = already merged = empty; non-zero = carries work
///     not yet in the current branch = recoverable). Reachability is the REAL
///     git answer — never approximated from log slicing.
fn git_orphan_worktrees_inner(repo_path: &str) -> Result<OrphanWorktreesResult, String> {
    let list_out = quiet_command(git_binary())
        .args(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("git orphan_worktrees: branch list failed: {}", e))?;
    if !list_out.status.success() {
        let stderr = String::from_utf8_lossy(&list_out.stderr);
        return Err(format!("git orphan_worktrees: branch list error: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&list_out.stdout);

    let mut recoverable = Vec::new();
    let mut empty = Vec::new();

    for line in stdout.lines() {
        let branch = line.trim();
        if branch.is_empty() || branch == "main" || branch == "master" {
            continue;
        }
        // Only the app's own agent-worktree branches are candidates — never
        // the user's personal branches (feature/*, fix/*, etc.).
        if !(branch.starts_with("agent/") || is_old_fleet_worktree_branch(branch)) {
            continue;
        }

        let head_out = quiet_command(git_binary())
            .args(["rev-parse", branch])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("git orphan_worktrees: rev-parse {} failed: {}", branch, e))?;
        let head_sha = String::from_utf8_lossy(&head_out.stdout).trim().to_string();
        if head_sha.is_empty() {
            // Unresolvable head — safe to delete, meaningless to merge.
            empty.push(OrphanWorktreeBranch { name: branch.to_string(), head_sha: String::new(), contained_in_target: false });
            continue;
        }

        let anc_out = quiet_command(git_binary())
            .args(["merge-base", "--is-ancestor", &head_sha, "HEAD"])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("git orphan_worktrees: merge-base for {} failed: {}", branch, e))?;
        let contained_in_target = anc_out.status.success();

        let entry = OrphanWorktreeBranch { name: branch.to_string(), head_sha, contained_in_target };
        if contained_in_target {
            empty.push(entry);
        } else {
            recoverable.push(entry);
        }
    }

    Ok(OrphanWorktreesResult { recoverable, empty })
}

/// True for the older fleet naming shape (`M6-implémenteur-wt`,
/// `M10-testeur-wt`): a `M<n>-` prefix plus a `-wt` suffix (role worktree).
fn is_old_fleet_worktree_branch(branch: &str) -> bool {
    let bytes = branch.as_bytes();
    // M<n>-...-wt
    if bytes.len() < 5 || bytes[0] != b'M' {
        return false;
    }
    let digits_end = bytes.iter().skip(1).take_while(|b| b.is_ascii_digit()).count();
    if digits_end == 0 || 1 + digits_end >= bytes.len() || bytes[1 + digits_end] != b'-' {
        return false;
    }
    branch.ends_with("-wt")
}

/// Enumerate the app's orphan agent-worktree branches, classified as
/// recoverable (real unmerged work) vs empty (already contained in HEAD) —
/// the data the fleet-hygiene rule (j) needs to recover work and clean
/// debris automatically. Does NOT merge or delete anything itself; the
/// frontend applies the plan through the app's real merge/discard primitives.
#[tauri::command]
pub(crate) fn git_orphan_worktrees(repo_path: String, project_registry: tauri::State<ProjectRegistry>) -> Result<OrphanWorktreesResult, String> {
    ensure_repo_in_any_open_project(&repo_path, &project_registry)?;
    git_orphan_worktrees_inner(&repo_path)
}


/// List all local branches.
///
/// Runs: `git -C <repo_path> branch --format=%(refname:short)`
/// Returns a Vec of branch name strings.
#[tauri::command]
pub(crate) fn git_branches(repo_path: String, project_registry: tauri::State<ProjectRegistry>) -> Result<Vec<String>, String> {
    ensure_repo_in_any_open_project(&repo_path, &project_registry)?;
    let output = quiet_command(git_binary())
        .args(["branch", "--format=%(refname:short)"])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("git branches: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git branches error: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let branches: Vec<String> = stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Ok(branches)
}

/// Log entry returned by git_log.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GitLogEntry {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
}

/// Return commit log entries for a repository.
///
/// Runs: `git -C <repo_path> log --pretty=format:<sep>%H<sep>%s<sep>%an<sep>%ai -n <limit>`
/// Returns up to `limit` entries (default 50).
#[tauri::command]
pub(crate) fn git_log(repo_path: String, limit: Option<u32>, project_registry: tauri::State<ProjectRegistry>) -> Result<Vec<GitLogEntry>, String> {
    ensure_repo_in_any_open_project(&repo_path, &project_registry)?;
    let n = limit.unwrap_or(50).to_string();
    // Use NUL as field delimiter and newline as record delimiter to handle commas/pipes in values.
    let format = "%H%x00%s%x00%an%x00%ai";
    let output = quiet_command(git_binary())
        .args(["log", &format!("--pretty=format:{}", format), "-n", &n])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("git log: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git log error: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(4, '\x00').collect();
        if parts.len() == 4 {
            entries.push(GitLogEntry {
                hash:    parts[0].trim().to_string(),
                subject: parts[1].trim().to_string(),
                author:  parts[2].trim().to_string(),
                date:    parts[3].trim().to_string(),
            });
        }
    }
    Ok(entries)
}


#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_git_repo(dir: &TempDir) -> String {
        let root = dir.path().to_str().unwrap().to_string();

        quiet_command("git")
            .args(["init"])
            .current_dir(&root)
            .output()
            .expect("git init");
        quiet_command("git")
            .args(["config", "user.email", "agent@lazy.dev"])
            .current_dir(&root)
            .output()
            .expect("git config email");
        quiet_command("git")
            .args(["config", "user.name", "Lazy Agent"])
            .current_dir(&root)
            .output()
            .expect("git config name");

        // Seed commit so HEAD exists
        let seed = dir.path().join("README.md");
        std::fs::write(&seed, "# Lazy test repo\n").expect("write README");
        quiet_command("git")
            .args(["add", "README.md"])
            .current_dir(&root)
            .output()
            .expect("git add");
        quiet_command("git")
            .args(["commit", "-m", "initial"])
            .current_dir(&root)
            .output()
            .expect("git commit");

        root
    }

    // ── Multi-root allowlist (every git command's project-root gate) ────
    //
    // Every #[tauri::command] above now gates via
    // util::ensure_repo_in_any_open_project, which reads ALL open roots from
    // the ProjectRegistry (not just the single legacy ProjectState root) —
    // see state.rs's ProjectState/ProjectRegistry doc comments. This proves
    // the scenario that motivated the change: a mission running against a
    // repo registered as a BACKGROUND project (registered, but not the
    // active one) must be accepted, while a repo that was never registered
    // at all must still be denied.

    #[test]
    fn git_command_gate_accepts_background_registered_repo_and_rejects_foreign_one() {
        let active_dir = TempDir::new().expect("TempDir (active)");
        let active_repo = setup_git_repo(&active_dir);
        let background_dir = TempDir::new().expect("TempDir (background)");
        let background_repo = setup_git_repo(&background_dir);
        let foreign_dir = TempDir::new().expect("TempDir (foreign, never registered)");
        let foreign_repo = foreign_dir.path().to_str().unwrap().to_string();

        let mut registry = crate::state::RegistryInner::default();
        registry.register(crate::state::ProjectEntry {
            id: "active".to_string(),
            root: active_repo,
            brain_id: None,
        });
        registry.register(crate::state::ProjectEntry {
            id: "background".to_string(),
            root: background_repo.clone(),
            brain_id: None,
        });
        registry.set_active("active").expect("set_active");

        let roots = registry.all_roots();

        assert!(
            crate::commands::util::ensure_repo_in_project_roots(&background_repo, &roots).is_ok(),
            "a repo registered but not active (background project) must be accepted"
        );
        assert!(
            crate::commands::util::ensure_repo_in_project_roots(&foreign_repo, &roots).is_err(),
            "a repo that was never registered must still be rejected"
        );
        eprintln!("git_command_gate_accepts_background_registered_repo_and_rejects_foreign_one PASSED");
    }

    /// Rule (j) — `git_orphan_worktrees_inner` must classify a real branch
    /// carrying unmerged work as RECOVERABLE, an already-merged agent branch
    /// as EMPTY, and must NEVER touch a user's personal branch (feature/*).
    #[test]
    fn git_orphan_worktrees_classifies_recoverable_vs_empty_and_skips_personal_branches() {
        let dir = TempDir::new().expect("TempDir::new failed");
        let root = setup_git_repo(&dir);

        // Personal branch the app must never touch.
        quiet_command("git")
            .args(["checkout", "-b", "feature/my-thing"])
            .current_dir(&root)
            .output()
            .expect("checkout feature");
        let feature_file = dir.path().join("feature.md");
        std::fs::write(&feature_file, "# feature\n").expect("write feature.md");
        quiet_command("git")
            .args(["add", "feature.md"])
            .current_dir(&root)
            .output()
            .expect("git add feature");
        quiet_command("git")
            .args(["commit", "-m", "feature work"])
            .current_dir(&root)
            .output()
            .expect("git commit feature");
        quiet_command("git")
            .args(["checkout", "master"])
            .current_dir(&root)
            .output()
            .expect("checkout master");

        // agent/merged — branch already contained in master (empty).
        quiet_command("git")
            .args(["checkout", "-b", "agent/merged"])
            .current_dir(&root)
            .output()
            .expect("checkout agent/merged");
        quiet_command("git")
            .args(["checkout", "master"])
            .current_dir(&root)
            .output()
            .expect("checkout master 2");

        // agent/recoverable — real unmerged commit (recoverable work).
        quiet_command("git")
            .args(["checkout", "-b", "agent/recoverable"])
            .current_dir(&root)
            .output()
            .expect("checkout agent/recoverable");
        let work_file = dir.path().join("scaffold.txt");
        std::fs::write(&work_file, "# scaffold\n").expect("write scaffold.txt");
        quiet_command("git")
            .args(["add", "scaffold.txt"])
            .current_dir(&root)
            .output()
            .expect("git add scaffold");
        quiet_command("git")
            .args(["commit", "-m", "real scaffold work"])
            .current_dir(&root)
            .output()
            .expect("git commit scaffold");
        quiet_command("git")
            .args(["checkout", "master"])
            .current_dir(&root)
            .output()
            .expect("checkout master 3");

        let result = git_orphan_worktrees_inner(&root).expect("git_orphan_worktrees_inner");

        let recoverable_names: Vec<&str> = result.recoverable.iter().map(|b| b.name.as_str()).collect();
        let empty_names: Vec<&str> = result.empty.iter().map(|b| b.name.as_str()).collect();

        assert!(
            recoverable_names.contains(&"agent/recoverable"),
            "agent/recoverable carries unmerged work and must be recoverable, got recoverable={:?} empty={:?}",
            recoverable_names,
            empty_names
        );
        assert!(
            empty_names.contains(&"agent/merged"),
            "agent/merged is contained in master and must be empty, got recoverable={:?} empty={:?}",
            recoverable_names,
            empty_names
        );
        assert!(
            !recoverable_names.contains(&"feature/my-thing") && !empty_names.contains(&"feature/my-thing"),
            "a personal feature branch must never be touched by rule (j), got recoverable={:?} empty={:?}",
            recoverable_names,
            empty_names
        );
        assert!(
            !recoverable_names.contains(&"master") && !empty_names.contains(&"master"),
            "master itself must never be listed as an orphan"
        );
        eprintln!("git_orphan_worktrees_classifies_recoverable_vs_empty_and_skips_personal_branches PASSED");
    }
}
