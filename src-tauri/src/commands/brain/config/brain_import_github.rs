//! `import_brain_from_github` and the clone + brain-shape validation it
//! depends on.

use std::fs;
use std::path::Path;

use tauri::Manager;

use crate::state::{ProjectRegistry, ProjectState};
use crate::commands::brain::sidecar::BrainState;
use crate::commands::util::quiet_command;
use crate::commands::git::git_binary;

use super::brain_config_apply::apply_brain_config;
use super::path_resolve::BrainInfo;

/// True if `dir` directly contains anything resembling brain note content
/// (html/md/json files) at its top level — the "flat leaf" shape a custom
/// brain folder may have with no `brain/` subdirectory of its own.
fn directory_has_brain_files(dir: &Path) -> bool {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if matches!(ext, "html" | "htm" | "md" | "json") {
                    return true;
                }
            }
        }
    }
    false
}

/// Honest brain-shape check for a freshly cloned directory: accepts either
/// the `<root>/{brain/, .lazybrain-config.json}` layout `brain_publish_github`
/// produces, or a flat leaf directory containing note files directly.
/// Anything else is rejected with a clear message instead of silently
/// adopting an unrelated repo as the active brain.
fn validate_cloned_brain(dest: &Path) -> Result<(), String> {
    if dest.join("brain").is_dir()
        || dest.join(".lazybrain-config.json").is_file()
        || directory_has_brain_files(dest)
    {
        return Ok(());
    }
    Err(format!(
        "'{}' does not look like a LazyBrain brain (no brain/ directory, .lazybrain-config.json, or note files found) — refusing to adopt it as the active brain",
        dest.display()
    ))
}

/// `git clone <url> <dest>`. Honest, specific errors for the two most
/// common failure modes: `dest` already existing with content (git clone
/// refuses this; caught here first with a clearer message) and `git` itself
/// failing (bad URL, auth required, network down — private repos need
/// credentials already configured for this machine's git; see
/// `import_brain_from_github`'s doc comment).
fn clone_brain_repo(url: &str, dest: &Path) -> Result<(), String> {
    if url.trim().is_empty() {
        return Err("import_brain_from_github: url must not be empty".to_string());
    }
    if dest.exists() {
        let has_entries = fs::read_dir(dest)
            .map_err(|e| format!("cannot read destination '{}': {}", dest.display(), e))?
            .next()
            .is_some();
        if has_entries {
            return Err(format!(
                "destination '{}' already exists and is not empty — choose an empty or new folder",
                dest.display()
            ));
        }
    }
    let dest_str = dest.to_string_lossy().into_owned();
    let output = quiet_command(git_binary())
        .args(["clone", url, dest_str.as_str()])
        .output()
        .map_err(|e| format!("failed to run git: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "git clone failed: {}. Check the URL, and that git has access — private repos need credentials (SSH key or a credential helper) already configured for this machine's git, same as any other git clone.",
            stderr.trim()
        ));
    }
    Ok(())
}

/// Clone a brain published to GitHub (via `brain_publish_github`, or any
/// repo shaped like one) and adopt it as the active "custom" brain — the
/// UI-driven counterpart to manually setting `LAZYBRAIN_BRAIN_PATH` and
/// cloning by hand.
///
/// Pipeline: `git clone url dest` -> validate the clone looks like a brain
/// -> persist `{mode: "custom", path: dest}` (reuses `apply_brain_config`,
/// same as `set_brain_config`) -> restart the sidecar -> return the fresh
/// `BrainInfo`. The clone is removed if validation fails, so a rejected
/// import never leaves a half-adopted directory behind.
///
/// Honest limits: this shells out to the system `git`, so private repos
/// need working credentials already configured for it (SSH key / credential
/// helper / cached HTTPS token) — there is no in-app auth flow. No GitHub
/// API calls are made, so anything a plain `git clone` itself can't reach
/// (auth failure, rate limiting, network down) surfaces as git's own
/// stderr, passed through as-is.
///
/// `async fn` + `spawn_blocking`: `clone_brain_repo` blocks on a `git clone`
/// child process — seconds to minutes depending on repo size/network — on
/// top of `apply_brain_config`'s own `restart_brain_sidecar` cost (see
/// `brain_retry_sidecar`'s doc comment). The single heaviest command in this
/// file; leaving it on the main thread would freeze the entire IPC surface
/// for the whole clone, and running it on an async worker would hit the
/// `reqwest::blocking` panic documented on `project_register`.
#[tauri::command]
pub(crate) async fn import_brain_from_github(
    url: String,
    dest: String,
    app: tauri::AppHandle,
) -> Result<BrainInfo, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let dest_path = Path::new(&dest);
        clone_brain_repo(&url, dest_path)?;

        if let Err(message) = validate_cloned_brain(dest_path) {
            let _ = fs::remove_dir_all(dest_path); // best-effort: don't leave a rejected clone behind
            return Err(message);
        }

        let project_state = app.state::<ProjectState>();
        let brain_state = app.state::<BrainState>();
        let registry = app.state::<ProjectRegistry>();
        apply_brain_config("custom", Some(&dest), &app, &project_state, &brain_state, &registry)
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("import_brain_from_github: blocking task join failed: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn validate_cloned_brain_accepts_brain_subdir() {
        let tmp = TempDir::new().expect("TempDir::new");
        std::fs::create_dir_all(tmp.path().join("brain")).expect("mkdir brain");
        validate_cloned_brain(tmp.path()).expect("a brain/ subdir must be accepted");
        eprintln!("validate_cloned_brain_accepts_brain_subdir PASSED");
    }

    #[test]
    fn validate_cloned_brain_accepts_lazybrain_config_file() {
        let tmp = TempDir::new().expect("TempDir::new");
        std::fs::write(tmp.path().join(".lazybrain-config.json"), "{}").expect("write config");
        validate_cloned_brain(tmp.path()).expect(".lazybrain-config.json must be accepted");
        eprintln!("validate_cloned_brain_accepts_lazybrain_config_file PASSED");
    }

    #[test]
    fn validate_cloned_brain_accepts_flat_note_files() {
        let tmp = TempDir::new().expect("TempDir::new");
        std::fs::write(tmp.path().join("some-note.html"), "<html></html>").expect("write note");
        validate_cloned_brain(tmp.path()).expect("flat note files must be accepted");
        eprintln!("validate_cloned_brain_accepts_flat_note_files PASSED");
    }

    /// The task's explicit "reject a non-brain dir" case: a directory with
    /// unrelated content (no brain/, no .lazybrain-config.json, no note
    /// files) must be rejected with an actionable message rather than
    /// silently adopted as the active brain.
    #[test]
    fn validate_cloned_brain_rejects_directory_with_no_brain_signal() {
        let tmp = TempDir::new().expect("TempDir::new");
        std::fs::write(tmp.path().join("README.txt"), "just a readme").expect("write unrelated file");

        let err = validate_cloned_brain(tmp.path()).expect_err("an unrelated repo must be rejected");
        assert!(err.contains("does not look like a LazyBrain brain"), "{}", err);
        eprintln!("validate_cloned_brain_rejects_directory_with_no_brain_signal PASSED");
    }

    #[test]
    fn clone_brain_repo_rejects_empty_url() {
        let tmp = TempDir::new().expect("TempDir::new");
        let dest = tmp.path().join("dest");
        let err = clone_brain_repo("", &dest).expect_err("empty url must be rejected");
        assert!(err.contains("must not be empty"), "{}", err);
        eprintln!("clone_brain_repo_rejects_empty_url PASSED");
    }

    /// No network involved: the non-empty-destination check runs before
    /// `git` is ever invoked.
    #[test]
    fn clone_brain_repo_rejects_nonempty_existing_destination() {
        let tmp = TempDir::new().expect("TempDir::new");
        std::fs::write(tmp.path().join("marker.txt"), "already here").expect("write marker");

        let err = clone_brain_repo("https://example.com/some/repo.git", tmp.path())
            .expect_err("a nonempty existing destination must be rejected");
        assert!(err.contains("already exists and is not empty"), "{}", err);
        eprintln!("clone_brain_repo_rejects_nonempty_existing_destination PASSED");
    }
}
