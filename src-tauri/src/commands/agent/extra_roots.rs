//! Cross-project READ access for missions: extra project roots a mission's
//! agent may READ from, beyond its own worktree, via the claude CLI's
//! `--add-dir` flag — paired with a generated `--settings` JSON file that
//! denies `Edit`/`Write` under every one of those roots, so the read grant
//! can never widen into a write grant (which `--add-dir` alone would allow
//! under `--permission-mode acceptEdits`).
//!
//! Wired into `agent_run`'s "claude" branch (run.rs): `validate_extra_readable_roots`
//! runs BEFORE the mission thread is even spawned (same choke point as
//! `ensure_repo_in_any_open_project` for `worktree_path`), `build_extra_roots_settings_config`
//! generates the temp deny-rules file, and `build_extra_roots_cli_args` is
//! the pure argv builder the mission thread appends to the `claude` Command.

use std::path::{Path, PathBuf};

use crate::commands::util::{ensure_repo_in_project_roots, normalize_separators, strip_verbatim_prefix};

/// Validate every caller-declared extra readable root against `roots` —
/// every currently OPEN project's own root (`ProjectRegistry::all_roots`).
///
/// SECURITY BOUNDARY: a mission must not be able to widen its own reach to
/// arbitrary disk just by naming a path. This reuses
/// `ensure_repo_in_project_roots` — the SAME containment check every other
/// caller-supplied path in this codebase is gated by (worktree_path, git/fs/
/// shell command targets) — so an extra root is accepted only when it is
/// the exact root of, or a path lexically inside, some currently open
/// project. The FIRST invalid entry fails the whole call (`Err`, naming the
/// rejected path and the real reason) — never silently dropped, never
/// silently widened to "every open project" as a fallback.
///
/// Returns the cleaned (separator-normalized, verbatim-`\\?\`-prefix-
/// stripped, deduplicated) roots on success — safe to use directly as
/// `--add-dir` arguments and as the basis for the generated deny-rules glob
/// patterns.
pub(crate) fn validate_extra_readable_roots(
    requested: &[String],
    roots: &[String],
) -> Result<Vec<String>, String> {
    let mut validated: Vec<String> = Vec::with_capacity(requested.len());
    for candidate in requested {
        ensure_repo_in_project_roots(candidate, roots).map_err(|e| {
            format!(
                "agent_run: extra readable root '{}' is not inside any currently open project \
                 — refusing to widen mission reach: {}",
                candidate, e
            )
        })?;
        let cleaned = strip_verbatim_prefix(&normalize_separators(candidate));
        if !validated.contains(&cleaned) {
            validated.push(cleaned);
        }
    }
    Ok(validated)
}

/// Rewrite a clean absolute path (already through
/// `strip_verbatim_prefix`/`normalize_separators`) into the forward-slash
/// form the claude CLI's gitignore-style settings globs use, prefixed with
/// `//` — the documented marker for an absolute path in a deny/allow rule
/// (`./path` is cwd-relative; `//path` is absolute). Purely a glob-syntax
/// transform (backslash -> forward-slash), never used for filesystem
/// access.
fn to_glob_absolute(path: &str) -> String {
    format!("//{}", path.replace('\\', "/"))
}

/// Build the generated `--settings` JSON denying `Edit`/`Write` under every
/// root in `roots`. Returns `None` when `roots` is empty — a mission that
/// declares no extra readable roots needs no settings file at all (today's
/// unchanged behavior); the caller (run.rs) treats `None` here as "wire
/// nothing", including skipping the `--add-dir` flags themselves (fail
/// CLOSED: `--add-dir` is never added without its paired deny file, even if
/// this write happens to fail for some other reason).
///
/// KNOWN LIMITATION (carry this into any review of this feature): deny
/// rules apply to `Edit`/`Write` tool calls and to Bash commands Claude
/// Code itself recognises as touching a path (`cat`, `head`, `tail`,
/// `sed`, …) — they do NOT constrain an arbitrary subprocess the agent
/// spawns through Bash (e.g. a Python or Node one-liner opening the file
/// directly and writing to it). The CLI has no visibility into what such a
/// subprocess does. Real OS-level enforcement would require sandboxing the
/// child process itself, which is out of scope here — `--add-dir` plus this
/// deny file raises the bar for an honest, well-behaved agent; it is not an
/// airtight boundary against a deliberately evasive one.
pub(crate) fn build_extra_roots_settings_config(mission_id: &str, roots: &[String]) -> Option<PathBuf> {
    if roots.is_empty() {
        return None;
    }

    let deny: Vec<String> = roots
        .iter()
        .flat_map(|r| {
            let glob = to_glob_absolute(r);
            vec![format!("Edit({}/**)", glob), format!("Write({}/**)", glob)]
        })
        .collect();

    let config = serde_json::json!({ "permissions": { "deny": deny } });

    // Mission ids are internally generated, but sanitize defensively before
    // using one as part of a filename — same convention as
    // build_brain_mcp_config (brain_mcp.rs).
    let safe_id: String = mission_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let path = std::env::temp_dir().join(format!("lazy-extra-roots-settings-{}.json", safe_id));

    match std::fs::write(&path, config.to_string()) {
        Ok(()) => {
            log::info!(
                "agent_run: mission {} granted READ access to {} extra project root(s); write denied under each",
                mission_id,
                roots.len()
            );
            Some(path)
        }
        Err(e) => {
            log::warn!("build_extra_roots_settings_config: failed to write {}: {}", path.display(), e);
            None
        }
    }
}

/// Pure argv builder: `--add-dir <root>` once per root, followed by
/// `--settings <settings_path>` — the exact flag sequence run.rs appends to
/// the claude `Command` when extra readable roots are wired for a mission.
/// Kept separate from the `Command`-building code in run.rs (mirrors this
/// crate's `serve_command_args`/`permission_flag`/`tree_kill_args`
/// convention) purely so it is directly unit-testable without spawning a
/// process or inspecting a `std::process::Command`.
pub(crate) fn build_extra_roots_cli_args(roots: &[String], settings_path: &Path) -> Vec<String> {
    let mut args = Vec::with_capacity(roots.len() * 2 + 2);
    for root in roots {
        args.push("--add-dir".to_string());
        args.push(root.clone());
    }
    args.push("--settings".to_string());
    args.push(settings_path.to_string_lossy().into_owned());
    args
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    // ── validate_extra_readable_roots ──────────────────────────────────

    #[test]
    fn validate_extra_readable_roots_accepts_a_registered_root_and_rejects_a_foreign_one() {
        let registered_dir = TempDir::new().expect("TempDir (registered)");
        let foreign_dir = TempDir::new().expect("TempDir (foreign, never registered)");

        let registered_root = registered_dir.path().canonicalize().unwrap().to_string_lossy().to_string();
        let foreign_root = foreign_dir.path().canonicalize().unwrap().to_string_lossy().to_string();
        let roots = vec![registered_root.clone()];

        let ok = super::validate_extra_readable_roots(&[registered_root.clone()], &roots);
        assert!(ok.is_ok(), "a currently registered project root must be accepted, got: {:?}", ok);
        assert_eq!(ok.unwrap().len(), 1, "the validated list must carry exactly the one accepted root");

        let rejected = super::validate_extra_readable_roots(&[foreign_root], &roots);
        assert!(rejected.is_err(), "a root that is not any currently open project must be rejected");
        eprintln!("validate_extra_readable_roots_accepts_a_registered_root_and_rejects_a_foreign_one PASSED");
    }

    /// A caller must not be able to widen a mission's reach by naming a
    /// single bad path alongside good ones — the WHOLE call fails, never a
    /// partial "drop the bad one, keep the rest" silent narrowing.
    #[test]
    fn validate_extra_readable_roots_rejects_the_whole_request_when_any_one_root_is_foreign() {
        let registered_dir = TempDir::new().expect("TempDir (registered)");
        let foreign_dir = TempDir::new().expect("TempDir (foreign)");

        let registered_root = registered_dir.path().canonicalize().unwrap().to_string_lossy().to_string();
        let foreign_root = foreign_dir.path().canonicalize().unwrap().to_string_lossy().to_string();
        let roots = vec![registered_root.clone()];

        let result = super::validate_extra_readable_roots(&[registered_root, foreign_root], &roots);
        assert!(result.is_err(), "one foreign root among several requested must fail the whole request");
        eprintln!("validate_extra_readable_roots_rejects_the_whole_request_when_any_one_root_is_foreign PASSED");
    }

    #[test]
    fn validate_extra_readable_roots_of_an_empty_request_is_an_empty_ok() {
        let result = super::validate_extra_readable_roots(&[], &["C:\\proj".to_string()]);
        assert_eq!(result, Ok(Vec::new()), "no declared extra roots must yield an empty Ok, never an error");
        eprintln!("validate_extra_readable_roots_of_an_empty_request_is_an_empty_ok PASSED");
    }

    #[test]
    fn validate_extra_readable_roots_deduplicates_repeated_entries() {
        let registered_dir = TempDir::new().expect("TempDir (registered)");
        let registered_root = registered_dir.path().canonicalize().unwrap().to_string_lossy().to_string();
        let roots = vec![registered_root.clone()];

        let result = super::validate_extra_readable_roots(&[registered_root.clone(), registered_root], &roots)
            .expect("both entries name the same registered root — must be accepted");
        assert_eq!(result.len(), 1, "a repeated root must be deduplicated, not passed twice to --add-dir");
        eprintln!("validate_extra_readable_roots_deduplicates_repeated_entries PASSED");
    }

    // ── build_extra_roots_settings_config ───────────────────────────────

    #[test]
    fn build_extra_roots_settings_config_is_none_for_an_empty_root_list() {
        let result = super::build_extra_roots_settings_config("mission-empty", &[]);
        assert!(result.is_none(), "no extra roots must mean no settings file at all");
        eprintln!("build_extra_roots_settings_config_is_none_for_an_empty_root_list PASSED");
    }

    /// The generated deny JSON must have the exact shape the CLI docs
    /// specify: `permissions.deny` naming `Edit(<abs>/**)` and
    /// `Write(<abs>/**)` for every extra root, using the `//`-prefixed
    /// absolute-path glob form.
    #[test]
    fn build_extra_roots_settings_config_writes_the_expected_deny_shape() {
        let root = r"C:\Users\dev\other-project".to_string();
        let cfg_path = super::build_extra_roots_settings_config("mission-1", &[root])
            .expect("a non-empty root list must produce a settings file");

        let raw = std::fs::read_to_string(&cfg_path).expect("read generated settings file");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("generated settings must be valid JSON");

        let deny = parsed["permissions"]["deny"].as_array().expect("permissions.deny must be an array");
        let deny_strs: Vec<&str> = deny.iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(
            deny_strs,
            vec![
                "Edit(//C:/Users/dev/other-project/**)",
                "Write(//C:/Users/dev/other-project/**)",
            ],
            "deny rules must cover both Edit and Write under the absolute, forward-slash glob form of the root"
        );

        let _ = std::fs::remove_file(&cfg_path);
        eprintln!("build_extra_roots_settings_config_writes_the_expected_deny_shape PASSED");
    }

    /// Multiple extra roots must each get their own Edit+Write deny pair —
    /// never merged into a single overbroad pattern.
    #[test]
    fn build_extra_roots_settings_config_covers_every_root_independently() {
        let roots = vec![r"C:\proj-a".to_string(), r"C:\proj-b".to_string()];
        let cfg_path = super::build_extra_roots_settings_config("mission-2", &roots)
            .expect("must produce a settings file for two roots");

        let raw = std::fs::read_to_string(&cfg_path).expect("read generated settings file");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("must be valid JSON");
        let deny = parsed["permissions"]["deny"].as_array().expect("deny must be an array");
        assert_eq!(deny.len(), 4, "2 roots x (Edit + Write) = 4 deny entries");

        let _ = std::fs::remove_file(&cfg_path);
        eprintln!("build_extra_roots_settings_config_covers_every_root_independently PASSED");
    }

    // ── build_extra_roots_cli_args ──────────────────────────────────────

    #[test]
    fn build_extra_roots_cli_args_produces_add_dir_per_root_then_settings() {
        let roots = vec![r"C:\proj-a".to_string(), r"C:\proj-b".to_string()];
        let settings_path = std::path::Path::new(r"C:\temp\lazy-extra-roots-settings-m1.json");

        let args = super::build_extra_roots_cli_args(&roots, settings_path);

        assert_eq!(
            args,
            vec![
                "--add-dir".to_string(),
                r"C:\proj-a".to_string(),
                "--add-dir".to_string(),
                r"C:\proj-b".to_string(),
                "--settings".to_string(),
                r"C:\temp\lazy-extra-roots-settings-m1.json".to_string(),
            ],
            "argv must be one --add-dir pair per root, in order, followed by exactly one --settings pair"
        );
        eprintln!("build_extra_roots_cli_args_produces_add_dir_per_root_then_settings PASSED");
    }

    #[test]
    fn build_extra_roots_cli_args_with_one_root_matches_the_documented_single_root_shape() {
        let roots = vec![r"C:\Users\dev\other-project".to_string()];
        let settings_path = std::path::Path::new(r"C:\temp\lazy-extra-roots-settings-m2.json");

        let args = super::build_extra_roots_cli_args(&roots, settings_path);

        assert_eq!(
            args,
            vec![
                "--add-dir".to_string(),
                r"C:\Users\dev\other-project".to_string(),
                "--settings".to_string(),
                r"C:\temp\lazy-extra-roots-settings-m2.json".to_string(),
            ]
        );
        eprintln!("build_extra_roots_cli_args_with_one_root_matches_the_documented_single_root_shape PASSED");
    }
}
