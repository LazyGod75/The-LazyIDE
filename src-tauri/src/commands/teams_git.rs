//! teams_git.rs — Real team-brain git transport (design §10, plan T4.3/T4.4).
//!
//! The two pre-existing single-repo commands (`brain_publish_github`,
//! `import_brain_from_github`) are correct for the personal brain flows they
//! were built for, but unusable for a background sync daemon touching N team
//! repos: they always activate the clone/publish target as the app's ACTIVE
//! brain (Rust's apply_brain_config). This module is the daemon's transport:
//!   - `teams_pull_repo`  — clone on first sync, `git fetch` + `git merge`
//!     (union merge via .gitattributes for `neurons/*.html`, resolved JSON
//!     union for `canvas/*.json`) on every later sync. NEVER touches the
//!     active brain config.
//!   - `teams_push_repo`  — `git add -A` + commit (with the connected
//!     member's identity) + `git push` to origin.
//!
//! Auth: the GitHub OAuth token travels as a per-invocation
//! `-c http.extraheader="AUTHORIZATION: basic <x-access-token:TOKEN>"` git
//! config override — passed on the command line, never written into
//! `.git/config`, so a pushed repo contains no leaked credentials.
//!
//! Conflict policy (spec §10.2 "append-only = zero conflict"):
//!   - `neurons/*.html` are marked `-merge` via `.gitattributes`
//!     (provisioned on clone AND re-healed on every pull): two members
//!     editing the same neuron produce a normal conflict that the sync
//!     daemon resolves by recomposing signed items (recompose.ts), NOT by
//!     a blind union merge.
//!   - `canvas/*.json` are NOT union-mergeable (that would produce invalid
//!     JSON). They are marked `-merge` and resolved here with a domain-aware
//!     JSON union (per-key merge, newest `savedAtMs` wins per item).

use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;

use crate::commands::git::git_binary;
use crate::commands::util::quiet_command;

// ── Result type ──────────────────────────────────────────────────────

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamGitResult {
    pub ok: bool,
    /// "cloned" | "pulled" | "merged" | "up-to-date" | "pushed" |
    /// "nothing-to-push" | "error"
    pub action: String,
    pub message: String,
    pub repo_url: String,
    pub local_dir: String,
}

impl TeamGitResult {
    fn ok(action: &str, message: String, repo_url: &str, local_dir: &str) -> Self {
        Self {
            ok: true,
            action: action.to_string(),
            message,
            repo_url: repo_url.to_string(),
            local_dir: local_dir.to_string(),
        }
    }

    fn err(message: String, repo_url: &str, local_dir: &str) -> Self {
        Self {
            ok: false,
            action: "error".to_string(),
            message,
            repo_url: repo_url.to_string(),
            local_dir: local_dir.to_string(),
        }
    }
}
// ── Auth helper ──────────────────────────────────────────────────────

/// Per-invocation git auth: `-c http.extraheader=...` with the GitHub OAuth
/// token as an `x-access-token` basic-credential. Never persisted.
fn auth_args(token: &str) -> Vec<String> {
    if token.trim().is_empty() {
        return Vec::new();
    }
    let cred = format!("x-access-token:{}", token.trim());
    let encoded = BASE64.encode(cred.as_bytes());
    vec![
        "-c".to_string(),
        format!("http.extraheader=AUTHORIZATION: basic {}", encoded),
    ]
}

// ── .gitattributes provisioning ──────────────────────────────────────

const GITATTRIBUTES_CONTENT: &str = "\
# --- LazyBrain teams: managed merge drivers (auto-generated) ---\n\
neurons/*.html -merge\n\
canvas/*.json -merge\n\
# --- end LazyBrain teams managed drivers ---\n";

fn ensure_gitattributes(local_dir: &str) -> Result<(), String> {
    let path = Path::new(local_dir).join(".gitattributes");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if !existing.contains("LazyBrain teams") {
        let merged = format!("{}{}", existing, GITATTRIBUTES_CONTENT);
        std::fs::write(&path, merged).map_err(|e| format!("write .gitattributes: {}", e))?;
    }
    Ok(())
}

// ── git invocation helpers ───────────────────────────────────────────

fn run_git(local_dir: &str, args: &[&str]) -> Result<String, String> {
    let output = quiet_command(git_binary())
        .args(args)
        .current_dir(local_dir)
        .output()
        .map_err(|e| format!("git failed to start: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!("git: {}", detail));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git_with_auth(local_dir: &str, token: &str, args: &[&str]) -> Result<String, String> {
    let auth = auth_args(token);
    let sub = args.first().copied().unwrap_or("");
    let mut full: Vec<&str> = Vec::with_capacity(2 + auth.len() + args.len());
    full.push(sub);
    for a in &auth {
        full.push(a.as_str());
    }
    full.extend_from_slice(&args[1..]);
    run_git(local_dir, &full)
}

fn configure_identity(local_dir: &str, name: &str, email: &str) {
    let _ = run_git(local_dir, &["config", "user.name", name]);
    let _ = run_git(local_dir, &["config", "user.email", email]);
}

fn branch_is_unborn(local_dir: &str) -> bool {
    run_git(local_dir, &["rev-parse", "--verify", "HEAD"])
        .map(|out| out.is_empty())
        .unwrap_or(true)
}

fn has_any_commit(local_dir: &str) -> bool {
    !branch_is_unborn(local_dir)
}

fn remote_branch_exists(local_dir: &str, remote: &str, branch: &str) -> bool {
    run_git(local_dir, &["ls-remote", "--heads", remote, branch])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false)
}
// ── Canvas JSON union merge ──────────────────────────────────────────

/// JSON union merge for `canvas/*.json` conflicts. Both sides are full
/// snapshot files carrying a `savedAtMs` field; per top-level key the file
/// with the HIGHER `savedAtMs` wins, keys present in only one side survive.
fn merge_canvas_json(ours: &str, theirs: &str) -> Result<String, String> {
    let a: serde_json::Value = serde_json::from_str(ours)
        .map_err(|e| format!("canvas merge: ours unparseable: {}", e))?;
    let b: serde_json::Value = serde_json::from_str(theirs)
        .map_err(|e| format!("canvas merge: theirs unparseable: {}", e))?;

    let a_ms = a.get("savedAtMs").and_then(|v| v.as_i64()).unwrap_or(0);
    let b_ms = b.get("savedAtMs").and_then(|v| v.as_i64()).unwrap_or(0);
    let (newer, older) = if b_ms >= a_ms { (&b, &a) } else { (&a, &b) };

    let mut out = serde_json::Map::new();
    if let Some(obj) = older.as_object() {
        for (k, v) in obj {
            out.insert(k.clone(), v.clone());
        }
    }
    if let Some(obj) = newer.as_object() {
        for (k, v) in obj {
            out.insert(k.clone(), v.clone());
        }
    }
    serde_json::to_string_pretty(&serde_json::Value::Object(out))
        .map_err(|e| format!("canvas merge: serialize: {}", e))
}

/// Resolve unmerged canvas paths after a `git merge` stopped on `-merge`
/// paths. Reads stage 2 (ours) / stage 3 (theirs) from the index, merges
/// them, writes the result to the working tree, stages it.
fn resolve_canvas_conflicts(local_dir: &str) -> Result<Vec<String>, String> {
    let unmerged = run_git(local_dir, &["ls-files", "-u"])?;
    if unmerged.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut paths: Vec<String> = Vec::new();
    for line in unmerged.lines() {
        let Some((_meta, path)) = line.split_once('\t') else {
            continue;
        };
        if path.starts_with("canvas/") && path.ends_with(".json") && !paths.iter().any(|p| p == path)
        {
            paths.push(path.to_string());
        }
    }

    let mut resolved = Vec::new();
    for path in &paths {
        let ours = run_git(local_dir, &["show", &format!(":2:{}", path)])?;
        let theirs = run_git(local_dir, &["show", &format!(":3:{}", path)])?;
        let merged = merge_canvas_json(&ours, &theirs)?;
        std::fs::write(Path::new(local_dir).join(path), merged)
            .map_err(|e| format!("write merged {}: {}", path, e))?;
        run_git(local_dir, &["add", path]).map_err(|e| format!("git add {}: {}", path, e))?;
        resolved.push(path.clone());
    }
    Ok(resolved)
}
// ── Pull ─────────────────────────────────────────────────────────────

fn clone_repo(repo_url: &str, local_dir: &str, token: &str) -> TeamGitResult {
    let auth = auth_args(token);
    let mut args: Vec<&str> = vec!["clone", "--no-recurse-submodules"];
    for a in &auth {
        args.push(a.as_str());
    }
    args.extend_from_slice(&[repo_url, local_dir]);
    let parent = Path::new(local_dir)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".".to_string());
    let output = match quiet_command(git_binary())
        .args(&args)
        .current_dir(&parent)
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            return TeamGitResult::err(format!("git clone failed to start: {}", e), repo_url, local_dir);
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return TeamGitResult::err(format!("git clone: {}", stderr), repo_url, local_dir);
    }
    let _ = ensure_gitattributes(local_dir);
    let _ = run_git(local_dir, &["config", "user.name", "Lazy Team Sync"]);
    let _ = run_git(local_dir, &["config", "user.email", "lazy-sync@localhost"]);
    TeamGitResult::ok("cloned", "cloned team brain repo".to_string(), repo_url, local_dir)
}

fn teams_pull_inner(repo_url: &str, local_dir: &str, token: &str) -> TeamGitResult {
    let dir = Path::new(local_dir);

    if !dir.join(".git").exists() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            if entries.count() > 0 {
                return TeamGitResult::err(
                    "destination directory exists and is not a git clone — refusing to clobber it".to_string(),
                    repo_url,
                    local_dir,
                );
            }
        }
        if let Some(parent) = dir.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        return clone_repo(repo_url, local_dir, token);
    }

    if let Err(e) = ensure_gitattributes(local_dir) {
        return TeamGitResult::err(e, repo_url, local_dir);
    }
    configure_identity(local_dir, "Lazy Team Sync", "lazy-sync@localhost");

    if let Err(e) = run_git_with_auth(local_dir, token, &["fetch", "origin"]) {
        return TeamGitResult::err(format!("git fetch: {}", e), repo_url, local_dir);
    }

    let remote_branch = if remote_branch_exists(local_dir, "origin", "main") {
        "origin/main"
    } else if remote_branch_exists(local_dir, "origin", "master") {
        "origin/master"
    } else {
        return TeamGitResult::ok(
            "up-to-date",
            "remote has no branch yet — nothing to pull".to_string(),
            repo_url,
            local_dir,
        );
    };

    if !has_any_commit(local_dir) {
        if let Err(e) = run_git(local_dir, &["merge", "--no-edit", remote_branch]) {
            return TeamGitResult::err(format!("git merge (initial): {}", e), repo_url, local_dir);
        }
        return TeamGitResult::ok(
            "pulled",
            format!("initial pull from {}", remote_branch),
            repo_url,
            local_dir,
        );
    }

    let local_head = run_git(local_dir, &["rev-parse", "HEAD"]).unwrap_or_default();
    let remote_head = run_git(local_dir, &["rev-parse", remote_branch]).unwrap_or_default();
    if !local_head.is_empty() && local_head == remote_head {
        return TeamGitResult::ok(
            "up-to-date",
            "already up to date with origin".to_string(),
            repo_url,
            local_dir,
        );
    }

    match run_git(local_dir, &["merge", "--no-edit", "--allow-unrelated-histories", remote_branch])
    {
        Ok(_) => TeamGitResult::ok(
            "pulled",
            format!("merged {}", remote_branch),
            repo_url,
            local_dir,
        ),
        Err(merge_err) => match resolve_canvas_conflicts(local_dir) {
            Ok(resolved) if !resolved.is_empty() => match run_git(local_dir, &["commit", "--no-edit"])
            {
                Ok(_) => TeamGitResult::ok(
                    "merged",
                    format!(
                        "merged {} and resolved {} canvas file(s)",
                        remote_branch,
                        resolved.len()
                    ),
                    repo_url,
                    local_dir,
                ),
                Err(commit_err) => TeamGitResult::err(
                    format!(
                        "canvas resolved but finalizing merge commit failed: {} (merge error was: {})",
                        commit_err, merge_err
                    ),
                    repo_url,
                    local_dir,
                ),
            },
            _ => TeamGitResult::err(
                format!(
                    "merge failed and no canvas files were left to resolve: {}",
                    merge_err
                ),
                repo_url,
                local_dir,
            ),
        },
    }
}
// ── Push ─────────────────────────────────────────────────────────────

fn teams_push_inner(
    repo_url: &str,
    local_dir: &str,
    token: &str,
    author_name: &str,
    author_email: &str,
    message: &str,
) -> TeamGitResult {
    let dir = Path::new(local_dir);
    if !dir.join(".git").exists() {
        if let Err(e) = run_git(local_dir, &["init"]) {
            return TeamGitResult::err(format!("git init: {}", e), repo_url, local_dir);
        }
        if let Err(e) = run_git(local_dir, &["remote", "add", "origin", repo_url]) {
            return TeamGitResult::err(format!("git remote add: {}", e), repo_url, local_dir);
        }
    }

    let _ = ensure_gitattributes(local_dir);
    let name = if author_name.trim().is_empty() { "Lazy Team Sync" } else { author_name.trim() };
    let email = if author_email.trim().is_empty() { "lazy-sync@localhost" } else { author_email.trim() };
    configure_identity(local_dir, name, email);

    if let Err(e) = run_git(local_dir, &["add", "-A"]) {
        return TeamGitResult::err(format!("git add: {}", e), repo_url, local_dir);
    }

    let staged = run_git(local_dir, &["diff", "--cached", "--name-only"]).unwrap_or_default();
    if staged.trim().is_empty() && has_any_commit(local_dir) {
        return TeamGitResult::ok(
            "nothing-to-push",
            "no local changes to push".to_string(),
            repo_url,
            local_dir,
        );
    }

    let commit_msg = if message.trim().is_empty() {
        "chore(lazybrain): sync team brain".to_string()
    } else {
        message.trim().to_string()
    };

    if let Err(e) = run_git(local_dir, &["commit", "-m", &commit_msg]) {
        if e.contains("nothing to commit") || e.contains("no changes added") {
            return TeamGitResult::ok(
                "nothing-to-push",
                "no local changes to push".to_string(),
                repo_url,
                local_dir,
            );
        }
        return TeamGitResult::err(format!("git commit: {}", e), repo_url, local_dir);
    }

    if let Err(e) = run_git_with_auth(local_dir, token, &["push", "-u", "origin", "HEAD"]) {
        return TeamGitResult::err(format!("git push: {}", e), repo_url, local_dir);
    }

    TeamGitResult::ok("pushed", "pushed team brain changes".to_string(), repo_url, local_dir)
}

// ── Tauri commands ───────────────────────────────────────────────────

/// Pull (clone-or-update) one team brain repo. Never touches the active
/// brain config. Returns a typed TeamGitResult (never rejects for expected
/// git outcomes).
#[tauri::command]
pub(crate) fn teams_pull_repo(
    repo_url: String,
    local_dir: String,
    token: String,
) -> TeamGitResult {
    teams_pull_inner(&repo_url, &local_dir, &token)
}

/// Commit local changes in one team brain repo and push to origin. The
/// commit author is the connected GitHub user. Never touches the active
/// brain config.
#[tauri::command]
pub(crate) fn teams_push_repo(
    repo_url: String,
    local_dir: String,
    token: String,
    author_name: String,
    author_email: String,
    message: String,
) -> TeamGitResult {
    teams_push_inner(
        &repo_url,
        &local_dir,
        &token,
        &author_name,
        &author_email,
        &message,
    )
}
