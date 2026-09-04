//! "Publish brain to GitHub": turns the active brain directory into a git
//! repo the user can share, restoring the old solo-brain convention. See
//! brain_publish_github's doc comment for the full resolve-remote flow.

use std::fs;
use std::path::Path;
use std::process::Stdio;

use serde::{Deserialize, Serialize};

use crate::state::ProjectState;
use crate::commands::util::quiet_command;
use crate::commands::git::git_binary;
use crate::commands::brain::sidecar::http_client;
use crate::commands::brain::config::get_brain_info_inner;

/// Result of `brain_publish_github`. `#[serde(rename_all = "camelCase")]`
/// is a no-op here (no multi-word fields) but kept for consistency with
/// the rest of this file's IPC result structs.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BrainPublishResult {
    pub ok: bool,
    pub url: Option<String>,
    pub message: String,
}

/// Resolve the ROOT brain directory to publish from a `get_brain_info()`
/// path. See module doc above: if the path's last component is literally
/// `brain`, publish its parent; otherwise (a non-standard override that
/// doesn't follow the `<root>/brain` convention) publish the path as-is
/// rather than guessing at a parent that may not exist.
fn resolve_publish_root(brain_path: &str) -> std::path::PathBuf {
    let path = Path::new(brain_path);
    let is_brain_leaf = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == "brain")
        .unwrap_or(false);
    if is_brain_leaf {
        path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| path.to_path_buf())
    } else {
        path.to_path_buf()
    }
}

/// Guard against publishing a nonexistent or empty directory — a `git init`
/// in a random empty folder would "succeed" but be useless and confusing.
fn validate_publish_root(root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Err(format!("brain directory does not exist: {}", root.display()));
    }
    if !root.is_dir() {
        return Err(format!("brain path is not a directory: {}", root.display()));
    }
    let has_entries = fs::read_dir(root)
        .map_err(|e| format!("cannot read brain directory {}: {}", root.display(), e))?
        .next()
        .is_some();
    if !has_entries {
        return Err(format!("brain directory is empty — nothing to publish: {}", root.display()));
    }
    Ok(())
}

const BRAIN_GITIGNORE_BEGIN: &str = "# --- LazyBrain publish: managed patterns (auto-generated) ---";

const BRAIN_GITIGNORE_END: &str = "# --- end LazyBrain publish managed patterns ---";

/// Patterns for regenerable/cache artifacts that must never be published —
/// derived indexes, dream-run backups, downloaded embedding models.
/// Deliberately never matches `brain/` or `.lazybrain-config.json` (both
/// stay tracked so the published repo is self-contained).
fn brain_gitignore_patterns() -> &'static str {
    "_cache/\n\
_cache_dream_init/\n\
_clean_brain_backup/\n\
# Any underscore-prefixed directory is a LazyBrain-internal/regenerable\n\
# artifact by convention — covers future cache dirs without editing this file.\n\
_*/\n\
*.db\n\
*.db-wal\n\
*.db-shm\n\
# Downloaded local embedding models: large and re-downloadable, not user notes.\n\
models/\n\
*.log\n\
# Internal bookkeeping written by ensure_brain_init's failure-caching —\n\
# never a user note (see commands/brain/sidecar.rs).\n\
.lazybrain-init-failed\n"
}

fn brain_gitignore_block() -> String {
    format!("{}\n{}{}\n", BRAIN_GITIGNORE_BEGIN, brain_gitignore_patterns(), BRAIN_GITIGNORE_END)
}

/// Pure merge: add the managed patterns to whatever `.gitignore` content
/// (if any) already exists at the brain root, without dropping the user's
/// own custom entries and without re-appending on every publish.
///   - No existing file -> the managed block alone.
///   - Existing content, no managed markers yet -> content is kept
///     verbatim, the managed block is appended after a blank line.
///   - Existing content already containing the managed markers -> the
///     region between them is replaced with the current patterns (so a
///     future change to the pattern list self-heals on the next publish),
///     everything else is left untouched.
fn merge_gitignore(existing: Option<&str>) -> String {
    let block = brain_gitignore_block();
    let existing = match existing {
        Some(s) if !s.trim().is_empty() => s,
        _ => return block,
    };

    match (existing.find(BRAIN_GITIGNORE_BEGIN), existing.find(BRAIN_GITIGNORE_END)) {
        (Some(start), Some(end)) if end >= start => {
            let end_of_marker = end + BRAIN_GITIGNORE_END.len();
            let before = &existing[..start];
            let after = existing[end_of_marker..].trim_start_matches('\n');
            format!("{}{}{}", before, block, after)
        }
        _ => {
            let mut combined = existing.to_string();
            if !combined.ends_with('\n') {
                combined.push('\n');
            }
            combined.push('\n');
            combined.push_str(&block);
            combined
        }
    }
}

fn write_merged_gitignore(root: &Path) -> Result<(), String> {
    let gitignore_path = root.join(".gitignore");
    let existing = fs::read_to_string(&gitignore_path).ok();
    let merged = merge_gitignore(existing.as_deref());
    fs::write(&gitignore_path, merged)
        .map_err(|e| format!("failed to write .gitignore: {}", e))
}

/// `git init` the brain root if it isn't already a repo. Tries to name the
/// initial branch `main` (matching GitHub's default); older git versions
/// that don't support `-b` fall back to a plain `init` (whatever the local
/// `init.defaultBranch` config says, or git's own legacy default).
fn git_init_if_needed(root: &Path) -> Result<(), String> {
    if root.join(".git").exists() {
        return Ok(());
    }
    let output = quiet_command(git_binary())
        .args(["init", "-b", "main"])
        .current_dir(root)
        .output()
        .map_err(|e| format!("git init: {}", e))?;
    if output.status.success() {
        return Ok(());
    }
    let retry = quiet_command(git_binary())
        .args(["init"])
        .current_dir(root)
        .output()
        .map_err(|e| format!("git init (retry): {}", e))?;
    if !retry.status.success() {
        return Err(format!("git init failed: {}", String::from_utf8_lossy(&retry.stderr).trim()));
    }
    Ok(())
}

fn git_add_all(root: &Path) -> Result<(), String> {
    let output = quiet_command(git_binary())
        .args(["add", "-A"])
        .current_dir(root)
        .output()
        .map_err(|e| format!("git add: {}", e))?;
    if !output.status.success() {
        return Err(format!("git add error: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(())
}

/// Distinguishes "created a new commit" from "nothing to commit" (expected
/// and harmless on a re-publish with no changes) from a hard git failure.
enum CommitOutcome {
    Committed,
    NothingToCommit,
}

fn git_commit_publish(root: &Path) -> Result<CommitOutcome, String> {
    let output = quiet_command(git_binary())
        .args(["commit", "-m", "Publish brain"])
        .current_dir(root)
        .output()
        .map_err(|e| format!("git commit: {}", e))?;
    if output.status.success() {
        return Ok(CommitOutcome::Committed);
    }
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if combined.contains("nothing to commit") {
        return Ok(CommitOutcome::NothingToCommit);
    }
    Err(format!("git commit error: {}", combined.trim()))
}

/// True once the repo has at least one commit (`HEAD` resolves). Used to
/// tell "re-publishing with no changes" (fine — HEAD already exists) apart
/// from "this brain has no publishable content at all" (nothing ever
/// committed, e.g. everything is gitignored) which needs an honest message
/// instead of attempting a push that has nothing to push.
fn has_any_commit(root: &Path) -> bool {
    quiet_command(git_binary())
        .args(["rev-parse", "--verify", "-q", "HEAD"])
        .current_dir(root)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// List paths currently staged (index vs HEAD; on an unborn HEAD this is
/// simply everything in the index). Used to tell "there is genuinely
/// nothing but the housekeeping .gitignore to publish" apart from "there is
/// real brain content" on a brand new repo — see
/// `brain_publish_github_inner`'s pre-first-commit check.
fn staged_paths(root: &Path) -> Result<Vec<String>, String> {
    let output = quiet_command(git_binary())
        .args(["diff", "--cached", "--name-only"])
        .current_dir(root)
        .output()
        .map_err(|e| format!("git diff --cached: {}", e))?;
    if !output.status.success() {
        return Err(format!("git diff --cached error: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

fn get_origin_url(root: &Path) -> Option<String> {
    let output = quiet_command(git_binary())
        .args(["remote", "get-url", "origin"])
        .current_dir(root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() { None } else { Some(url) }
}

fn add_remote_origin(root: &Path, url: &str) -> Result<(), String> {
    let output = quiet_command(git_binary())
        .args(["remote", "add", "origin", url])
        .current_dir(root)
        .output()
        .map_err(|e| format!("git remote add: {}", e))?;
    if !output.status.success() {
        return Err(format!("git remote add error: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(())
}

fn current_branch(root: &Path) -> Result<String, String> {
    let output = quiet_command(git_binary())
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(root)
        .output()
        .map_err(|e| format!("git rev-parse: {}", e))?;
    if !output.status.success() {
        return Err(format!("git rev-parse error: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        return Err("no current branch (detached HEAD)".to_string());
    }
    Ok(branch)
}

fn push_to_origin(root: &Path, branch: &str) -> Result<(), String> {
    let output = quiet_command(git_binary())
        .args(["push", "-u", "origin", branch])
        .current_dir(root)
        .output()
        .map_err(|e| format!("git push: {}", e))?;
    if !output.status.success() {
        return Err(format!("git push error: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(())
}

/// Best-effort conversion of a git remote URL into a clickable
/// `https://github.com/<owner>/<repo>` URL for display. Handles the two
/// common GitHub forms (HTTPS with a `.git` suffix, SSH `git@github.com:`);
/// any other remote (self-hosted, non-GitHub) is returned unchanged — this
/// is a display nicety, not a correctness requirement.
fn normalize_repo_url_for_display(url: &str) -> String {
    let trimmed = url.trim();
    let without_git_suffix = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    if let Some(rest) = without_git_suffix.strip_prefix("git@github.com:") {
        return format!("https://github.com/{}", rest);
    }
    without_git_suffix.to_string()
}

/// Whether the `gh` CLI is reachable on PATH. Not installed on every
/// machine (confirmed NOT installed on the reference dev machine this
/// feature was built on) — this is checked lazily at call time, never
/// assumed.
fn gh_available() -> bool {
    quiet_command("gh")
        .args(["--version"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Derive a reasonable default repo name from the brain root's folder name
/// (e.g. a user-named brain dir like `Lazy-Brain-David` transfers
/// directly). A generic/implementation-detail folder name like
/// `.lazybrain` falls back to a descriptive default instead of publishing
/// a dot-file-looking repo name.
fn default_repo_name(root: &Path) -> String {
    let raw = root.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let base = if raw.is_empty() || raw.eq_ignore_ascii_case(".lazybrain") {
        "lazybrain-brain"
    } else {
        raw
    };
    let sanitized: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    let trimmed = sanitized.trim_matches('-');
    if trimmed.is_empty() { "lazybrain-brain".to_string() } else { trimmed.to_string() }
}

/// Create a GitHub repo via `gh repo create` and wire it as `origin`. `gh`
/// prints the new repo's URL on success; if stdout parsing comes up empty
/// (an older/newer gh output format), fall back to reading the `origin`
/// remote that `--remote=origin` just configured.
///
/// Always creates the repo `--private` — the brain is personal memory and
/// notes, and must never be publishable to a public repository. There is
/// intentionally no way to pass a visibility flag through this function;
/// see the module doc and BrainPublishOptions in src/lib/platform/tauri.ts.
fn gh_create_repo(root: &Path, name: &str) -> Result<String, String> {
    let output = quiet_command("gh")
        .args(["repo", "create", name, "--private", "--source=.", "--remote=origin"])
        .current_dir(root)
        .output()
        .map_err(|e| format!("gh repo create: {}", e))?;
    if !output.status.success() {
        return Err(format!("gh repo create error: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        Ok(stdout)
    } else {
        get_origin_url(root).ok_or_else(|| "gh repo create succeeded but returned no URL".to_string())
    }
}

/// Read a GitHub token from the environment. Checked only when both `gh`
/// and an existing/user-provided remote are unavailable — the last
/// automatic-creation fallback before an honest "no remote configured"
/// status.
fn github_token_from_env() -> Option<String> {
    std::env::var("GITHUB_TOKEN")
        .ok()
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var("GH_TOKEN").ok().filter(|v| !v.is_empty()))
}

/// Minimal shape of GitHub's `POST /user/repos` response — only the fields
/// this command actually reads.
#[derive(Deserialize)]
struct GhCreateRepoResponse {
    html_url: Option<String>,
    clone_url: Option<String>,
}

/// Create a repo via the GitHub REST API using a personal access token.
/// Returns `(clone_url, html_url)` — clone_url is used to configure the
/// `origin` remote, html_url is the clickable link shown to the user.
///
/// Always requests `"private": true` — see `gh_create_repo`'s doc comment;
/// the brain must never be publishable to a public repository.
fn create_repo_via_api(token: &str, name: &str) -> Result<(String, String), String> {
    let body = serde_json::json!({ "name": name, "private": true });
    let resp = http_client()
        .post("https://api.github.com/user/repos")
        .header("Authorization", format!("token {}", token))
        .header("User-Agent", "lazy-ide")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&body)
        .send()
        .map_err(|e| format!("GitHub API request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().unwrap_or_default();
        return Err(format!("GitHub API create repo failed ({}): {}", status, text));
    }
    let parsed: GhCreateRepoResponse = resp
        .json()
        .map_err(|e| format!("GitHub API: unexpected response: {}", e))?;
    let clone_url = parsed
        .clone_url
        .ok_or_else(|| "GitHub API response missing clone_url".to_string())?;
    let html_url = parsed.html_url.unwrap_or_else(|| clone_url.clone());
    Ok((clone_url, html_url))
}

/// Resolve the current branch and push it to `origin`, converting both
/// failure modes into the shared `BrainPublishResult` shape.
fn finish_with_push(root: &Path, origin_for_display: &str, ok_message: String) -> BrainPublishResult {
    let branch = match current_branch(root) {
        Ok(b) => b,
        Err(message) => return BrainPublishResult { ok: false, url: None, message },
    };
    if let Err(e) = push_to_origin(root, &branch) {
        return BrainPublishResult { ok: false, url: None, message: format!("push failed: {}", e) };
    }
    BrainPublishResult {
        ok: true,
        url: Some(normalize_repo_url_for_display(origin_for_display)),
        message: ok_message,
    }
}

/// Extracts `(owner, repo)` from a GitHub remote URL — HTTPS
/// (`https://github.com/owner/repo[.git]`) or SSH
/// (`git@github.com:owner/repo[.git]`) forms. Returns `None` for anything
/// else (self-hosted/non-GitHub remotes), which callers must treat as
/// "visibility cannot be determined via the API" rather than guessing.
fn parse_github_owner_repo(url: &str) -> Option<(String, String)> {
    let trimmed = url.trim();
    let without_git = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let path = without_git
        .strip_prefix("git@github.com:")
        .or_else(|| without_git.strip_prefix("ssh://git@github.com/"))
        .or_else(|| without_git.strip_prefix("https://github.com/"))
        .or_else(|| without_git.strip_prefix("http://github.com/"))?;
    let mut parts = path.splitn(2, '/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

/// Visibility of an existing GitHub repo via `gh repo view` — run inside
/// `root` so `gh` resolves the repo from the `origin` remote that must
/// already be configured by the time this is called. Returns the
/// upper-cased GitHub visibility string ("PUBLIC" / "PRIVATE" / "INTERNAL"),
/// or `None` if `gh` fails (not authenticated, repo not found/no access,
/// output unparseable) — never guesses.
fn gh_repo_view_visibility(root: &Path) -> Option<String> {
    let output = quiet_command("gh")
        .args(["repo", "view", "--json", "visibility", "-q", ".visibility"])
        .current_dir(root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text.to_uppercase())
    }
}

/// Minimal shape of GitHub's `GET /repos/{owner}/{repo}` response — only
/// the visibility-relevant fields. `visibility` is preferred when present
/// (distinguishes `internal` from `public`); `private` is the fallback for
/// older API responses that omit it.
#[derive(Deserialize)]
struct GhRepoVisibilityResponse {
    private: Option<bool>,
    visibility: Option<String>,
}

/// Visibility of an existing GitHub repo via the REST API using a personal
/// access token — the fallback when `gh` is unavailable. `None` on any
/// failure (network, auth, non-GitHub remote, unparseable response); never
/// guesses.
fn api_repo_visibility(token: &str, owner: &str, repo: &str) -> Option<String> {
    let resp = http_client()
        .get(format!("https://api.github.com/repos/{}/{}", owner, repo))
        .header("Authorization", format!("token {}", token))
        .header("User-Agent", "lazy-ide")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let parsed: GhRepoVisibilityResponse = resp.json().ok()?;
    if let Some(v) = parsed.visibility {
        return Some(v.to_uppercase());
    }
    parsed.private.map(|p| if p { "PRIVATE".to_string() } else { "PUBLIC".to_string() })
}

/// Determines the visibility of an already-configured `origin` remote:
/// `gh repo view` first (if `gh` is on PATH), then the REST API with a
/// `GITHUB_TOKEN`/`GH_TOKEN` env var (if set and the remote parses as a
/// GitHub URL). `None` means "could not be determined" — callers MUST
/// refuse to push in that case rather than assuming private.
fn remote_visibility(root: &Path, origin_url: &str) -> Option<String> {
    if gh_available() {
        if let Some(v) = gh_repo_view_visibility(root) {
            return Some(v);
        }
    }
    let token = github_token_from_env()?;
    let (owner, repo) = parse_github_owner_repo(origin_url)?;
    api_repo_visibility(&token, &owner, &repo)
}

/// Pure accept/refuse decision given a resolved (or unresolved) GitHub
/// visibility string — isolated from the actual gh/API lookup
/// (`remote_visibility`) so the decision logic itself is unit-testable
/// without network or `gh` access. The owner's explicit decision: the
/// brain (personal memory and notes) must NEVER be published to a public
/// repository. Only "PRIVATE" (case-insensitive) is accepted — a
/// public/internal repo, or a repo whose visibility could not be
/// determined at all, is refused with an explanation instead of silently
/// pushing and warning afterward.
fn visibility_allows_push(visibility: Option<&str>) -> Result<(), String> {
    match visibility {
        Some(v) if v.eq_ignore_ascii_case("PRIVATE") => Ok(()),
        Some(v) => Err(format!(
            "Refusing to publish: the connected GitHub repository is {} — the brain (your personal notes and memory) must never be pushed to a repository that is not private. Make the repository private on GitHub, or disconnect it and let Lazy create a new private one.",
            v.to_lowercase()
        )),
        None => Err("Refusing to publish: could not verify the connected GitHub repository's visibility. Install the gh CLI (and sign in), or set a GITHUB_TOKEN/GH_TOKEN environment variable, then try again — the brain is never pushed without confirming the repository is private.".to_string()),
    }
}

fn check_visibility_then_push(root: &Path, origin_url: &str, ok_message: String) -> BrainPublishResult {
    let visibility = remote_visibility(root, origin_url);
    match visibility_allows_push(visibility.as_deref()) {
        Ok(()) => finish_with_push(root, origin_url, ok_message),
        Err(message) => BrainPublishResult { ok: false, url: None, message },
    }
}

/// Remote resolution + push, once the working tree is committed: existing
/// `origin` wins, then a caller-provided URL, then `gh`, then a token, then
/// an honest "no remote configured" status. See module doc for the full
/// rationale. Every branch that pushes to a remote NOT created by this
/// function in the same call (existing `origin`, or a caller-provided URL)
/// goes through `check_visibility_then_push` first — repos this function
/// creates itself (`gh`/token paths) are always created private (see
/// `gh_create_repo`/`create_repo_via_api`), so no separate check is needed
/// there.
fn resolve_remote_and_push(root: &Path, remote_url: Option<String>) -> BrainPublishResult {
    if let Some(existing_origin) = get_origin_url(root) {
        return check_visibility_then_push(root, &existing_origin, "Published successfully.".to_string());
    }

    if let Some(url) = remote_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if let Err(message) = add_remote_origin(root, url) {
            return BrainPublishResult { ok: false, url: None, message };
        }
        return check_visibility_then_push(root, url, "Published successfully.".to_string());
    }

    let repo_name = default_repo_name(root);

    if gh_available() {
        return match gh_create_repo(root, &repo_name) {
            Ok(url) => finish_with_push(root, &url, "Published successfully (private repo created via gh).".to_string()),
            Err(e) => BrainPublishResult {
                ok: false,
                url: None,
                message: format!("Automatic repo creation via gh failed: {}. Provide an existing GitHub repo URL instead.", e),
            },
        };
    }

    if let Some(token) = github_token_from_env() {
        return match create_repo_via_api(&token, &repo_name) {
            Ok((clone_url, html_url)) => {
                if let Err(message) = add_remote_origin(root, &clone_url) {
                    return BrainPublishResult { ok: false, url: None, message };
                }
                finish_with_push(root, &html_url, "Published successfully (private repo created via GitHub API token).".to_string())
            }
            Err(e) => BrainPublishResult {
                ok: false,
                url: None,
                message: format!("Automatic repo creation via GitHub API failed: {}. Provide an existing GitHub repo URL instead.", e),
            },
        };
    }

    BrainPublishResult {
        ok: false,
        url: None,
        message: "No remote configured. Create an empty private GitHub repo and paste its URL, or install gh (GitHub CLI) / set a GITHUB_TOKEN env var for automatic private creation.".to_string(),
    }
}

/// Full publish pipeline for an already-resolved brain root. Never returns
/// Err — every failure mode becomes `BrainPublishResult { ok: false, .. }`
/// (see module doc). Split out from the `#[tauri::command]` wrapper so it
/// can be unit-tested against a `TempDir` without a live Tauri `State`.
fn brain_publish_github_inner(
    root: &Path,
    remote_url: Option<String>,
) -> BrainPublishResult {
    if let Err(message) = validate_publish_root(root) {
        return BrainPublishResult { ok: false, url: None, message };
    }
    if let Err(e) = git_init_if_needed(root) {
        return BrainPublishResult { ok: false, url: None, message: format!("git init failed: {}", e) };
    }
    if let Err(message) = write_merged_gitignore(root) {
        return BrainPublishResult { ok: false, url: None, message };
    }
    if let Err(message) = git_add_all(root) {
        return BrainPublishResult { ok: false, url: None, message };
    }

    // Before the very first commit, check whether there is anything staged
    // beyond the housekeeping .gitignore file itself. A brain root that only
    // contains cache/regenerable content (already excluded above) still
    // stages a *new* .gitignore on this first run, so `git commit` alone
    // would happily create a nearly-empty repo instead of surfacing an
    // honest "nothing to publish" status. This check only applies pre-first-
    // commit: a repeat publish with zero changes (has_any_commit == true)
    // is the normal "nothing new since last time" case, handled below by
    // tolerating CommitOutcome::NothingToCommit.
    if !has_any_commit(root) {
        match staged_paths(root) {
            Ok(paths) if paths.is_empty() || (paths.len() == 1 && paths[0] == ".gitignore") => {
                return BrainPublishResult {
                    ok: false,
                    url: None,
                    message: format!(
                        "Nothing to publish: {} only contains excluded/regenerable files (caches). Add content under brain/ before publishing.",
                        root.display()
                    ),
                };
            }
            Ok(_) => {}
            Err(message) => return BrainPublishResult { ok: false, url: None, message },
        }
    }

    if let Err(message) = git_commit_publish(root).map(|_outcome: CommitOutcome| ()) {
        return BrainPublishResult { ok: false, url: None, message };
    }

    resolve_remote_and_push(root, remote_url)
}

/// Publish the active brain (see `get_brain_info`) as a GitHub repo.
///
/// `remote_url` — an existing (ideally empty) GitHub repo URL to push to;
/// this is the primary path while `gh` is not installed.
///
/// There is deliberately no visibility parameter here: the brain is
/// personal data (memory and notes) and must never be published to a
/// public repository. Repos this command creates itself (gh/token
/// auto-create) are always private (see `gh_create_repo`/
/// `create_repo_via_api`); pushing to an already-existing remote (either
/// `origin` or a caller-provided `remote_url`) is refused unless that
/// remote's visibility can be confirmed private (see
/// `check_visibility_then_push`).
#[tauri::command]
pub(crate) fn brain_publish_github(
    remote_url: Option<String>,
    project_state: tauri::State<ProjectState>,
) -> Result<BrainPublishResult, String> {
    let root_str = project_state.0.lock()
        .map(|g| g.clone())
        .map_err(|e| format!("project state lock failed: {}", e))?;
    let root_opt = if root_str.is_empty() { None } else { Some(root_str.as_str()) };
    let info = get_brain_info_inner(root_opt);
    let publish_root = resolve_publish_root(&info.path);

    Ok(brain_publish_github_inner(&publish_root, remote_url))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Configure a local (repo-scoped) git identity so commits succeed
    /// regardless of this machine's global git config — same approach as
    /// `git_status_and_diff_modified_file` above. Must be called AFTER the
    /// repo has been `git init`-ed (a local `git config` has nowhere to
    /// write before `.git/` exists).
    fn configure_git_identity(root: &std::path::Path) {
        quiet_command("git")
            .args(["config", "user.email", "test@lazy.dev"])
            .current_dir(root)
            .output()
            .expect("git config email failed");
        quiet_command("git")
            .args(["config", "user.name", "Lazy Test"])
            .current_dir(root)
            .output()
            .expect("git config name failed");
    }

    #[test]
    fn merge_gitignore_creates_block_when_no_existing_file() {
        let result = merge_gitignore(None);
        for pattern in ["_cache/", "_cache_dream_init/", "_clean_brain_backup/", "*.db-wal", "*.db-shm"] {
            assert!(result.contains(pattern), "expected pattern {:?} in:\n{}", pattern, result);
        }
        // brain/ and the config file must never be matched by the managed block.
        assert!(!result.lines().any(|l| l.trim() == "brain/"), "brain/ must never be ignored:\n{}", result);
        assert!(
            !result.lines().any(|l| l.trim() == ".lazybrain-config.json"),
            "config must never be ignored:\n{}", result
        );
        eprintln!("merge_gitignore_creates_block_when_no_existing_file PASSED");
    }

    #[test]
    fn merge_gitignore_preserves_custom_content_and_appends_block() {
        let existing = "# my own notes\ndrafts/\n";
        let result = merge_gitignore(Some(existing));
        assert!(result.contains("drafts/"), "custom entry must be preserved:\n{}", result);
        assert!(result.contains("_cache/"), "managed patterns must be appended:\n{}", result);
        eprintln!("merge_gitignore_preserves_custom_content_and_appends_block PASSED");
    }

    #[test]
    fn merge_gitignore_is_idempotent_on_already_merged_content() {
        let once = merge_gitignore(None);
        let twice = merge_gitignore(Some(&once));
        assert_eq!(once, twice, "re-merging already-merged content must not duplicate or drift");
        eprintln!("merge_gitignore_is_idempotent_on_already_merged_content PASSED");
    }

    #[test]
    fn merge_gitignore_keeps_custom_content_stable_when_re_merged_alongside_managed_block() {
        let existing = "# my own notes\ndrafts/\n";
        let first = merge_gitignore(Some(existing));
        let second = merge_gitignore(Some(&first));
        assert_eq!(first, second, "custom content + managed block must be stable across re-publishes");
        assert!(second.contains("drafts/"));
        eprintln!("merge_gitignore_keeps_custom_content_stable_when_re_merged_alongside_managed_block PASSED");
    }

    #[test]
    fn resolve_publish_root_strips_trailing_brain_component() {
        assert_eq!(
            resolve_publish_root("C:/Users/X/Documents/Lazy-Brain-David/brain"),
            std::path::PathBuf::from("C:/Users/X/Documents/Lazy-Brain-David")
        );
        assert_eq!(
            resolve_publish_root("/home/x/.lazybrain/brain"),
            std::path::PathBuf::from("/home/x/.lazybrain")
        );
        eprintln!("resolve_publish_root_strips_trailing_brain_component PASSED");
    }

    #[test]
    fn resolve_publish_root_returns_unchanged_when_not_brain_leaf() {
        assert_eq!(
            resolve_publish_root("/some/custom/override/dir"),
            std::path::PathBuf::from("/some/custom/override/dir")
        );
        eprintln!("resolve_publish_root_returns_unchanged_when_not_brain_leaf PASSED");
    }

    #[test]
    fn normalize_repo_url_for_display_converts_ssh_to_https() {
        assert_eq!(
            normalize_repo_url_for_display("git@github.com:LazyGod75/LazyBrain.git"),
            "https://github.com/LazyGod75/LazyBrain"
        );
        eprintln!("normalize_repo_url_for_display_converts_ssh_to_https PASSED");
    }

    #[test]
    fn normalize_repo_url_for_display_strips_git_suffix_from_https() {
        assert_eq!(
            normalize_repo_url_for_display("https://github.com/LazyGod75/LazyBrain.git"),
            "https://github.com/LazyGod75/LazyBrain"
        );
        assert_eq!(
            normalize_repo_url_for_display("https://github.com/LazyGod75/LazyBrain"),
            "https://github.com/LazyGod75/LazyBrain"
        );
        eprintln!("normalize_repo_url_for_display_strips_git_suffix_from_https PASSED");
    }

    #[test]
    fn default_repo_name_falls_back_for_dotlazybrain_folder() {
        let root = std::path::Path::new("/home/x/.lazybrain");
        assert_eq!(default_repo_name(root), "lazybrain-brain");
        eprintln!("default_repo_name_falls_back_for_dotlazybrain_folder PASSED");
    }

    #[test]
    fn default_repo_name_sanitizes_invalid_characters() {
        let root = std::path::Path::new("/home/x/My Brain (2026)");
        let name = default_repo_name(root);
        assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'));
        assert!(!name.is_empty());
        eprintln!("default_repo_name_sanitizes_invalid_characters PASSED");
    }

    #[test]
    fn validate_publish_root_rejects_missing_dir() {
        let err = validate_publish_root(std::path::Path::new("/definitely/not/a/real/path/lazy-test"))
            .expect_err("missing dir must be rejected");
        assert!(err.contains("does not exist"), "{}", err);
        eprintln!("validate_publish_root_rejects_missing_dir PASSED");
    }

    #[test]
    fn validate_publish_root_rejects_empty_dir() {
        let dir = TempDir::new().expect("TempDir::new");
        let err = validate_publish_root(dir.path()).expect_err("empty dir must be rejected");
        assert!(err.contains("empty"), "{}", err);
        eprintln!("validate_publish_root_rejects_empty_dir PASSED");
    }

    #[test]
    fn validate_publish_root_accepts_nonempty_dir() {
        let dir = TempDir::new().expect("TempDir::new");
        std::fs::write(dir.path().join("marker.txt"), "x").expect("write marker");
        validate_publish_root(dir.path()).expect("nonempty dir must be accepted");
        eprintln!("validate_publish_root_accepts_nonempty_dir PASSED");
    }

    /// The task's explicit "nothing-to-commit handling with a temp repo"
    /// case: an empty repo has nothing staged, so committing must report
    /// NothingToCommit instead of a hard error.
    #[test]
    fn git_commit_publish_reports_nothing_to_commit_on_empty_repo() {
        let dir = TempDir::new().expect("TempDir::new");
        let root = dir.path();
        git_init_if_needed(root).expect("git init failed");
        configure_git_identity(root);

        git_add_all(root).expect("git add -A on empty dir should not fail");
        let outcome = git_commit_publish(root).expect("git_commit_publish failed");
        assert!(matches!(outcome, CommitOutcome::NothingToCommit));
        assert!(!has_any_commit(root), "empty repo must have no HEAD yet");
        eprintln!("git_commit_publish_reports_nothing_to_commit_on_empty_repo PASSED");
    }

    /// Re-publishing with no changes after a real commit must also report
    /// NothingToCommit (not an error) — the common "publish again, nothing
    /// changed" case.
    #[test]
    fn git_commit_publish_commits_then_reports_nothing_to_commit_on_second_call() {
        let dir = TempDir::new().expect("TempDir::new");
        let root = dir.path();
        git_init_if_needed(root).expect("git init failed");
        configure_git_identity(root);

        std::fs::write(root.join("note.txt"), "hello brain\n").expect("write note");
        git_add_all(root).expect("git add failed");
        let first = git_commit_publish(root).expect("first commit failed");
        assert!(matches!(first, CommitOutcome::Committed));
        assert!(has_any_commit(root));

        // No changes since — re-publishing must be a soft no-op, not an error.
        git_add_all(root).expect("second git add failed");
        let second = git_commit_publish(root).expect("second commit call failed");
        assert!(matches!(second, CommitOutcome::NothingToCommit));
        eprintln!("git_commit_publish_commits_then_reports_nothing_to_commit_on_second_call PASSED");
    }

    /// End-to-end (git-only, no network/gh) check that the gitignore
    /// produced for a publish excludes cache dirs while keeping brain
    /// content and the config file, mirroring the real
    /// `<root>/{brain,.lazybrain-config.json,_cache}` layout.
    #[test]
    fn publish_helpers_exclude_cache_dirs_and_keep_brain_content() {
        let dir = TempDir::new().expect("TempDir::new");
        let root = dir.path();

        std::fs::create_dir_all(root.join("brain")).expect("mkdir brain");
        std::fs::write(root.join("brain").join("notes.txt"), "a note\n").expect("write notes");
        std::fs::write(root.join(".lazybrain-config.json"), "{}").expect("write config");
        std::fs::create_dir_all(root.join("_cache")).expect("mkdir _cache");
        std::fs::write(root.join("_cache").join("junk.bin"), "regenerable").expect("write cache junk");

        git_init_if_needed(root).expect("git init failed");
        configure_git_identity(root);
        write_merged_gitignore(root).expect("write gitignore failed");
        git_add_all(root).expect("git add failed");
        let outcome = git_commit_publish(root).expect("commit failed");
        assert!(matches!(outcome, CommitOutcome::Committed));

        let tracked = quiet_command("git")
            .args(["ls-files"])
            .current_dir(root)
            .output()
            .expect("git ls-files failed");
        let tracked_files = String::from_utf8_lossy(&tracked.stdout);

        assert!(tracked_files.contains("brain/notes.txt"), "brain/ content must be tracked:\n{}", tracked_files);
        assert!(tracked_files.contains(".lazybrain-config.json"), "config must be tracked:\n{}", tracked_files);
        assert!(!tracked_files.contains("_cache/"), "cache dir must be excluded:\n{}", tracked_files);
        eprintln!("publish_helpers_exclude_cache_dirs_and_keep_brain_content PASSED");
    }

    /// Orchestrator-level guard: a nonexistent publish root must fail fast
    /// with an actionable message and never attempt `git init`.
    #[test]
    fn brain_publish_github_inner_rejects_missing_directory() {
        let result = brain_publish_github_inner(
            std::path::Path::new("/definitely/not/a/real/path/lazy-test-missing"),
            None,
        );
        assert!(!result.ok);
        assert!(result.url.is_none());
        assert!(result.message.contains("does not exist"), "{}", result.message);
        eprintln!("brain_publish_github_inner_rejects_missing_directory PASSED");
    }

    /// Orchestrator-level, network-free: a brain root that only contains
    /// gitignored cache content has nothing staged beyond the housekeeping
    /// .gitignore on the very first publish — this must surface as an
    /// honest "nothing to publish" message before ever committing or
    /// attempting a push against no history. Pre-init + configure identity
    /// locally (mirroring the helper tests above) so the internal commit
    /// step would succeed regardless of this machine's global git config;
    /// brain_publish_github_inner's own git_init_if_needed simply no-ops
    /// since `.git` already exists.
    #[test]
    fn brain_publish_github_inner_reports_nothing_to_publish_when_only_cache_present() {
        let dir = TempDir::new().expect("TempDir::new");
        let root = dir.path();
        std::fs::create_dir_all(root.join("_cache")).expect("mkdir _cache");
        std::fs::write(root.join("_cache").join("junk.bin"), "regenerable").expect("write cache junk");

        git_init_if_needed(root).expect("pre-init failed");
        configure_git_identity(root);

        let result = brain_publish_github_inner(root, None);
        assert!(!result.ok);
        assert!(result.message.contains("Nothing to publish"), "{}", result.message);
        eprintln!("brain_publish_github_inner_reports_nothing_to_publish_when_only_cache_present PASSED");
    }

    // ── Task B: public-repo push must be refused ───────────────────────

    #[test]
    fn visibility_allows_push_accepts_private_case_insensitively() {
        assert!(visibility_allows_push(Some("PRIVATE")).is_ok());
        assert!(visibility_allows_push(Some("private")).is_ok());
        eprintln!("visibility_allows_push_accepts_private_case_insensitively PASSED");
    }

    #[test]
    fn visibility_allows_push_refuses_public() {
        let err = visibility_allows_push(Some("PUBLIC")).expect_err("public must be refused");
        assert!(err.to_lowercase().contains("public"), "{}", err);
        assert!(err.contains("Refusing to publish"), "{}", err);
        eprintln!("visibility_allows_push_refuses_public PASSED");
    }

    #[test]
    fn visibility_allows_push_refuses_internal() {
        let err = visibility_allows_push(Some("INTERNAL")).expect_err("internal must be refused");
        assert!(err.to_lowercase().contains("internal"), "{}", err);
        eprintln!("visibility_allows_push_refuses_internal PASSED");
    }

    #[test]
    fn visibility_allows_push_refuses_when_undetermined() {
        let err = visibility_allows_push(None).expect_err("unknown visibility must be refused, not assumed private");
        assert!(err.contains("could not verify"), "{}", err);
        eprintln!("visibility_allows_push_refuses_when_undetermined PASSED");
    }

    #[test]
    fn parse_github_owner_repo_handles_https_and_ssh() {
        assert_eq!(
            parse_github_owner_repo("https://github.com/LazyGod75/LazyBrain.git"),
            Some(("LazyGod75".to_string(), "LazyBrain".to_string()))
        );
        assert_eq!(
            parse_github_owner_repo("git@github.com:LazyGod75/LazyBrain.git"),
            Some(("LazyGod75".to_string(), "LazyBrain".to_string()))
        );
        assert_eq!(parse_github_owner_repo("https://gitlab.com/x/y.git"), None);
        eprintln!("parse_github_owner_repo_handles_https_and_ssh PASSED");
    }

    /// The core Task B regression: a brain root with an already-configured
    /// `origin` that is NOT a real/reachable GitHub remote (so visibility
    /// can never be resolved via gh or the API in this sandboxed test run)
    /// must be refused rather than pushed. This exercises the exact code
    /// path hit when `origin` already exists — `resolve_remote_and_push`'s
    /// first branch — without any network access.
    #[test]
    fn resolve_remote_and_push_refuses_when_existing_origin_visibility_cannot_be_verified() {
        let dir = TempDir::new().expect("TempDir::new");
        let root = dir.path();
        git_init_if_needed(root).expect("git init failed");
        configure_git_identity(root);
        std::fs::write(root.join("note.txt"), "hello brain\n").expect("write note");
        git_add_all(root).expect("git add failed");
        git_commit_publish(root).expect("commit failed");

        // A syntactically valid but unreachable-in-CI GitHub URL: gh is
        // either absent or unauthenticated in the test sandbox, and no
        // GITHUB_TOKEN/GH_TOKEN env var is set, so remote_visibility must
        // resolve to None and the push must never be attempted.
        add_remote_origin(root, "https://github.com/lazy-test-org/definitely-not-a-real-repo.git")
            .expect("add remote failed");

        std::env::remove_var("GITHUB_TOKEN");
        std::env::remove_var("GH_TOKEN");

        let result = resolve_remote_and_push(root, None);
        assert!(!result.ok, "push must be refused when visibility cannot be verified");
        assert!(result.url.is_none());
        assert!(
            result.message.contains("could not verify") || result.message.contains("Refusing to publish"),
            "{}",
            result.message
        );
        eprintln!("resolve_remote_and_push_refuses_when_existing_origin_visibility_cannot_be_verified PASSED");
    }

    /// "Pushing to a private one still works": once `visibility_allows_push`
    /// has confirmed private (tested above in isolation), the actual push
    /// mechanics (`finish_with_push` — used by every accepting branch of
    /// `check_visibility_then_push`/`resolve_remote_and_push`) must still
    /// complete successfully. Uses a local bare repo as the remote (no
    /// GitHub/network access available in this sandbox) — real git push
    /// plumbing, same as this file's other local-bare-repo tests.
    #[test]
    fn finish_with_push_succeeds_against_a_real_remote() {
        let work_dir = TempDir::new().expect("TempDir::new (work)");
        let bare_dir = TempDir::new().expect("TempDir::new (bare)");
        let root = work_dir.path();
        let bare_path = bare_dir.path();

        // A bare repo stands in for "an existing private GitHub repo" —
        // once visibility_allows_push has said Ok, finish_with_push doesn't
        // care what host it's talking to, only that git push succeeds.
        let init_bare = quiet_command(git_binary())
            .args(["init", "--bare"])
            .current_dir(bare_path)
            .output()
            .expect("git init --bare failed");
        assert!(init_bare.status.success());

        git_init_if_needed(root).expect("git init failed");
        configure_git_identity(root);
        std::fs::write(root.join("note.txt"), "hello brain\n").expect("write note");
        git_add_all(root).expect("git add failed");
        git_commit_publish(root).expect("commit failed");

        let bare_url = bare_path.to_string_lossy().to_string();
        add_remote_origin(root, &bare_url).expect("add remote failed");

        let result = finish_with_push(root, &bare_url, "Published successfully.".to_string());
        assert!(result.ok, "{}", result.message);
        assert!(result.url.is_some());
        eprintln!("finish_with_push_succeeds_against_a_real_remote PASSED");
    }

    /// Compile-time guard: this assigning `gh_create_repo`/`create_repo_via_api`
    /// to these exact 2-arg function-pointer types proves neither takes a
    /// `private`/visibility argument anymore — a caller physically cannot
    /// pass `false` through them. Fails to compile (not just fails at
    /// runtime) if either signature regains a visibility parameter.
    #[test]
    fn gh_create_repo_and_create_repo_via_api_no_longer_accept_a_visibility_parameter() {
        let _: fn(&Path, &str) -> Result<String, String> = gh_create_repo;
        let _: fn(&str, &str) -> Result<(String, String), String> = create_repo_via_api;
        eprintln!("gh_create_repo_and_create_repo_via_api_no_longer_accept_a_visibility_parameter PASSED");
    }
}
