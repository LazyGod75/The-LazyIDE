//! Ensures a managed project's `.gitignore` excludes Lazy's own scaffolding
//! (`.lazy/`, `.lazybrain/`) — see `ensure_project_gitignore_excludes_scaffolding`.
//!
//! Called from `set_project` (config.rs) on every project open, BEFORE any
//! of that scaffolding is (re)created. Without this, an agent mission's own
//! `git add -A` (running inside its `.lazy/worktrees/<branch>` worktree) can
//! commit a copy of `.lazy/`/`.lazybrain/`; merging that mission branch back
//! then collides with whatever DIFFERENT untracked copy the main project has
//! separately regenerated at the same path, and `git merge` refuses with
//! "The following untracked working tree files would be overwritten by
//! merge" — the mission gets stuck forever. See
//! `ensure_project_gitignore_excludes_scaffolding`'s doc comment for the
//! full contract, and the `real_git_merge_*` tests below for an end-to-end
//! proof against a real git repo (both with and without this fix).

use std::fs;
use std::path::Path;

/// Directory names Lazy itself creates inside a MANAGED project that must
/// never be tracked in the user's own repository:
///   - `.lazy/`      — agent scratch space: saved agents (`lazy_agent_save`,
///     commands/agent.rs) and mission worktrees (`git worktree add -b
///     <branch> .lazy/worktrees/<branch>`, commands/git.rs /
///     commands/worktree_cleanup.rs).
///   - `.lazybrain/` — the project-local brain (`ensure_brain_init` in
///     sidecar.rs, `resolve_brain_path_core`'s "project" branch) — SQLite
///     FTS index, cached embeddings, and note HTML, all regenerated locally
///     by `index_project::spawn_auto_index_if_needed` / `brain_rebuild_graph`.
///
/// Neither is meaningful to commit: both are machine-local and regenerated
/// on demand, differing byte-for-byte between machines/runs. Worse, leaving
/// them untracked-but-unignored is actively harmful: if an agent mission's
/// own `git add -A` (running inside its `.lazy/worktrees/<branch>`
/// worktree, at a time this exclusion was missing) ever committed a copy of
/// either directory, merging that mission branch back collides with
/// whatever (different) untracked copy the main project has separately
/// regenerated — `git merge` refuses with "The following untracked working
/// tree files would be overwritten by merge", and the mission is stuck
/// forever. Excluding both here means neither is ever staged by
/// `git add -A`/`git add .` again in any worktree checked out from a commit
/// that carries this `.gitignore` — see
/// `ensure_project_gitignore_excludes_scaffolding`'s doc comment.
const PROJECT_GITIGNORE_PATTERNS: [&str; 2] = [".lazy/", ".lazybrain/"];

/// True if `content` already has a line — once trimmed of surrounding
/// whitespace — that is EXACTLY `pattern`. Deliberately narrow (no prefix/
/// substring matching): a more specific existing rule (e.g. `.lazybrain/brain/`
/// or a negated `!.lazy/keep/`) is left alone rather than assumed to already
/// cover the general case, so this never masks an existing custom rule.
fn gitignore_already_has_pattern(content: &str, pattern: &str) -> bool {
    content.lines().any(|line| line.trim() == pattern)
}

/// Idempotently ensure `<project_root>/.gitignore` excludes Lazy's own
/// scaffolding (see `PROJECT_GITIGNORE_PATTERNS`) — called from `set_project`
/// on EVERY project open, i.e. both the moment a project is first opened in
/// Lazy (before `.lazy/`/`.lazybrain/` exist at all) AND every subsequent
/// re-open of an already-polluted project: an existing untracked
/// `.lazybrain/`/`.lazy/` left behind by an older Lazy build gets covered on
/// its very next open here — no separate migration step needed.
///
/// Behavior:
///   - No `.gitignore` yet -> created with just the two patterns.
///   - Existing `.gitignore` missing one or both -> ONLY the missing ones
///     are appended, each on its own line; a missing trailing newline on the
///     existing content is fixed up first so an appended pattern never lands
///     on the same line as whatever was already there.
///   - Existing `.gitignore` already has both (anywhere in the file, in any
///     order — e.g. a user who already added `.lazy/` by hand) -> the file
///     is left byte-for-byte untouched; no write happens at all.
///
/// Fails open and NEVER overwrites content it could not faithfully read: a
/// missing file is treated as empty (fine to create fresh), but any OTHER
/// read error (permissions, a transient lock, ...) aborts without writing —
/// silently treating "unreadable" the same as "empty" would risk replacing
/// real existing content with just these two lines, which is exactly the
/// "never clobber existing content" contract this function must not
/// violate. A write failure is logged and swallowed the same way — this
/// housekeeping step must never block opening a project.
pub(crate) fn ensure_project_gitignore_excludes_scaffolding(project_root: &Path) {
    let path = project_root.join(".gitignore");

    let existing = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            log::warn!(
                "ensure_project_gitignore_excludes_scaffolding: failed to read {}: {} — leaving it untouched",
                path.display(), e
            );
            return;
        }
    };

    let missing: Vec<&str> = PROJECT_GITIGNORE_PATTERNS
        .iter()
        .copied()
        .filter(|pattern| !gitignore_already_has_pattern(&existing, pattern))
        .collect();

    if missing.is_empty() {
        return;
    }

    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    for pattern in &missing {
        updated.push_str(pattern);
        updated.push('\n');
    }

    if let Err(e) = fs::write(&path, updated) {
        log::warn!(
            "ensure_project_gitignore_excludes_scaffolding: failed to write {}: {}",
            path.display(), e
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // git_binary/quiet_command are only needed by the real-git-repo proofs
    // below — scoped to this test module (rather than the file's top level)
    // so a non-test `cargo check`/`cargo build` never reports them unused,
    // since the production code above is pure filesystem, no git involved.
    use crate::commands::git::git_binary;
    use crate::commands::util::quiet_command;

    // ── ensure_project_gitignore_excludes_scaffolding ─────────────────────
    // (.lazy/ + .lazybrain/ must never pollute the user's own git repo)

    #[test]
    fn ensure_project_gitignore_excludes_scaffolding_creates_file_with_both_patterns() {
        let tmp = TempDir::new().expect("TempDir::new");
        ensure_project_gitignore_excludes_scaffolding(tmp.path());

        let content = fs::read_to_string(tmp.path().join(".gitignore")).expect("gitignore must be created");
        assert!(content.lines().any(|l| l.trim() == ".lazy/"), "missing .lazy/ pattern:\n{}", content);
        assert!(content.lines().any(|l| l.trim() == ".lazybrain/"), "missing .lazybrain/ pattern:\n{}", content);
        eprintln!("ensure_project_gitignore_excludes_scaffolding_creates_file_with_both_patterns PASSED");
    }

    #[test]
    fn ensure_project_gitignore_excludes_scaffolding_is_idempotent_no_duplicates() {
        let tmp = TempDir::new().expect("TempDir::new");
        ensure_project_gitignore_excludes_scaffolding(tmp.path());
        let once = fs::read_to_string(tmp.path().join(".gitignore")).expect("read once");

        // Calling repeatedly mirrors reality: set_project runs on EVERY
        // project open, not just the first.
        ensure_project_gitignore_excludes_scaffolding(tmp.path());
        ensure_project_gitignore_excludes_scaffolding(tmp.path());
        let thrice = fs::read_to_string(tmp.path().join(".gitignore")).expect("read thrice");

        assert_eq!(once, thrice, "calling repeatedly must not duplicate or drift");
        assert_eq!(
            thrice.lines().filter(|l| l.trim() == ".lazy/").count(), 1,
            ".lazy/ must appear exactly once:\n{}", thrice
        );
        assert_eq!(
            thrice.lines().filter(|l| l.trim() == ".lazybrain/").count(), 1,
            ".lazybrain/ must appear exactly once:\n{}", thrice
        );
        eprintln!("ensure_project_gitignore_excludes_scaffolding_is_idempotent_no_duplicates PASSED");
    }

    #[test]
    fn ensure_project_gitignore_excludes_scaffolding_preserves_existing_content() {
        let tmp = TempDir::new().expect("TempDir::new");
        fs::write(tmp.path().join(".gitignore"), "node_modules/\ndist/\n").expect("seed existing gitignore");

        ensure_project_gitignore_excludes_scaffolding(tmp.path());

        let content = fs::read_to_string(tmp.path().join(".gitignore")).expect("read");
        assert!(content.contains("node_modules/"), "existing entry must survive:\n{}", content);
        assert!(content.contains("dist/"), "existing entry must survive:\n{}", content);
        assert!(content.lines().any(|l| l.trim() == ".lazy/"), "missing .lazy/:\n{}", content);
        assert!(content.lines().any(|l| l.trim() == ".lazybrain/"), "missing .lazybrain/:\n{}", content);
        eprintln!("ensure_project_gitignore_excludes_scaffolding_preserves_existing_content PASSED");
    }

    #[test]
    fn ensure_project_gitignore_excludes_scaffolding_skips_patterns_already_present() {
        let tmp = TempDir::new().expect("TempDir::new");
        // User already added .lazy/ by hand, in some unrelated position/order.
        fs::write(tmp.path().join(".gitignore"), "# my rules\n.lazy/\nnode_modules/\n").expect("seed");

        ensure_project_gitignore_excludes_scaffolding(tmp.path());

        let content = fs::read_to_string(tmp.path().join(".gitignore")).expect("read");
        assert_eq!(
            content.lines().filter(|l| l.trim() == ".lazy/").count(), 1,
            "an already-present .lazy/ must not be duplicated:\n{}", content
        );
        assert!(
            content.lines().any(|l| l.trim() == ".lazybrain/"),
            "the missing .lazybrain/ must still be appended:\n{}", content
        );
        eprintln!("ensure_project_gitignore_excludes_scaffolding_skips_patterns_already_present PASSED");
    }

    #[test]
    fn ensure_project_gitignore_excludes_scaffolding_handles_missing_trailing_newline() {
        let tmp = TempDir::new().expect("TempDir::new");
        // No trailing newline on the existing content.
        fs::write(tmp.path().join(".gitignore"), "node_modules/").expect("seed without trailing newline");

        ensure_project_gitignore_excludes_scaffolding(tmp.path());

        let content = fs::read_to_string(tmp.path().join(".gitignore")).expect("read");
        assert!(
            content.lines().any(|l| l.trim() == "node_modules/"),
            "existing entry must not be corrupted/merged onto another line: {:?}", content
        );
        assert!(content.lines().any(|l| l.trim() == ".lazy/"), "missing .lazy/: {:?}", content);
        assert!(content.lines().any(|l| l.trim() == ".lazybrain/"), "missing .lazybrain/: {:?}", content);
        assert!(
            !content.contains("node_modules/.lazy"),
            "must not concatenate onto the existing line without a newline: {:?}", content
        );
        eprintln!("ensure_project_gitignore_excludes_scaffolding_handles_missing_trailing_newline PASSED");
    }

    #[test]
    fn ensure_project_gitignore_excludes_scaffolding_is_a_noop_when_nothing_missing() {
        let tmp = TempDir::new().expect("TempDir::new");
        fs::write(tmp.path().join(".gitignore"), ".lazy/\n.lazybrain/\n").expect("seed already-complete gitignore");

        ensure_project_gitignore_excludes_scaffolding(tmp.path());

        let content = fs::read_to_string(tmp.path().join(".gitignore")).expect("read");
        assert_eq!(content, ".lazy/\n.lazybrain/\n", "already-complete file must be left byte-for-byte untouched");
        eprintln!("ensure_project_gitignore_excludes_scaffolding_is_a_noop_when_nothing_missing PASSED");
    }

    // ── real-git-repo proofs (no mocking — actual `git` subprocess) ──────

    fn init_test_git_repo(root: &Path) {
        let init = quiet_command(git_binary())
            .args(["init", "-b", "main"])
            .current_dir(root)
            .output()
            .expect("git init failed to spawn");
        if !init.status.success() {
            // Older git without -b support — fall back to plain init, then
            // force-name the branch so the rest of these tests can always
            // reference "main" regardless of this machine's
            // init.defaultBranch config.
            quiet_command(git_binary())
                .args(["init"])
                .current_dir(root)
                .output()
                .expect("git init (retry) failed to spawn");
            let _ = quiet_command(git_binary()).args(["checkout", "-B", "main"]).current_dir(root).output();
        }
        quiet_command(git_binary())
            .args(["config", "user.email", "test@lazy.dev"])
            .current_dir(root)
            .output()
            .expect("git config email failed");
        quiet_command(git_binary())
            .args(["config", "user.name", "Lazy Test"])
            .current_dir(root)
            .output()
            .expect("git config name failed");

        fs::write(root.join("normal.txt"), "v1\n").expect("write normal.txt");
        quiet_command(git_binary()).args(["add", "normal.txt"]).current_dir(root).output().expect("git add failed");
        let commit = quiet_command(git_binary())
            .args(["commit", "-m", "initial"])
            .current_dir(root)
            .output()
            .expect("git commit failed to spawn");
        assert!(
            commit.status.success(),
            "initial commit must succeed: {}",
            String::from_utf8_lossy(&commit.stderr)
        );
    }

    fn run_git(root: &Path, args: &[&str]) {
        let output = quiet_command(git_binary())
            .args(args)
            .current_dir(root)
            .output()
            .unwrap_or_else(|e| panic!("git {:?} failed to spawn: {}", args, e));
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn run_git_output(root: &Path, args: &[&str]) -> String {
        let output = quiet_command(git_binary())
            .args(args)
            .current_dir(root)
            .output()
            .unwrap_or_else(|e| panic!("git {:?} failed to spawn: {}", args, e));
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    /// Real end-to-end proof for the BUG A fix: a project's `.gitignore` not
    /// excluding `.lazy/`/`.lazybrain/` makes `git merge` refuse with "The
    /// following untracked working tree files would be overwritten by
    /// merge" whenever a mission branch happens to have committed its own
    /// copy of the scaffolding (e.g. an agent's `git add -A` inside its
    /// mission worktree, before this fix existed) and the main working tree
    /// independently has a DIFFERENT untracked copy at the same path (its
    /// own, separately regenerated, auto-index scaffolding).
    ///
    /// Sequence (a REAL git repo — no mocking):
    ///   1. `git init` a repo, one commit on `main`.
    ///   2. Run the REAL fix — `ensure_project_gitignore_excludes_scaffolding`
    ///      — BEFORE any scaffolding exists, exactly as `set_project` does
    ///      on every project open.
    ///   3. Branch to `mission`; write scaffolding content there — `git add
    ///      -A` must SKIP it (now gitignored), so the mission commit carries
    ///      only the normal file change.
    ///   4. Back on `main`, create a DIFFERENT, untracked copy of the same
    ///      scaffolding path (simulating the main working tree's own,
    ///      independently regenerated auto-index output).
    ///   5. `git merge mission` must succeed cleanly — the scaffolding was
    ///      never part of either side's tree, so there is nothing to
    ///      collide on.
    #[test]
    fn real_git_merge_no_longer_collides_with_scaffolding_after_gitignore_fix() {
        let tmp = TempDir::new().expect("TempDir::new");
        let root = tmp.path();

        init_test_git_repo(root);

        // Step 2: run the REAL fix before any scaffolding exists.
        ensure_project_gitignore_excludes_scaffolding(root);
        assert!(root.join(".gitignore").exists(), "gitignore must be created");

        // Step 3: branch, write scaffolding + a normal-file edit, add -A, commit.
        run_git(root, &["checkout", "-b", "mission"]);
        fs::create_dir_all(root.join(".lazybrain").join("brain").join("_cache")).expect("mkdir scaffolding");
        fs::write(root.join(".lazybrain").join("brain").join("_cache").join("fts.sqlite"), "mission-content")
            .expect("write scaffolding on mission");
        fs::write(root.join("normal.txt"), "v2 from mission\n").expect("edit normal file");
        run_git(root, &["add", "-A"]);
        let staged = run_git_output(root, &["diff", "--cached", "--name-only"]);
        assert!(
            !staged.contains(".lazybrain"),
            "gitignored scaffolding must NOT be staged by `git add -A` on the mission branch, staged files:\n{}",
            staged
        );
        assert!(staged.contains("normal.txt"), "the normal file edit must still be staged:\n{}", staged);
        run_git(root, &["commit", "-m", "mission work"]);

        // Step 4: back on main, an INDEPENDENT, untracked, DIFFERENT-content
        // copy of the same scaffolding path — main's own regenerated
        // auto-index output, never committed.
        run_git(root, &["checkout", "main"]);
        fs::create_dir_all(root.join(".lazybrain").join("brain").join("_cache")).expect("mkdir scaffolding on main");
        fs::write(root.join(".lazybrain").join("brain").join("_cache").join("fts.sqlite"), "main-content")
            .expect("write scaffolding on main");

        // Step 5: the actual proof — merge must succeed with no
        // untracked-overwrite collision.
        let merge_output = quiet_command(git_binary())
            .args(["merge", "mission"])
            .current_dir(root)
            .output()
            .expect("git merge failed to spawn");
        let stderr = String::from_utf8_lossy(&merge_output.stderr);
        let stdout = String::from_utf8_lossy(&merge_output.stdout);
        assert!(
            merge_output.status.success(),
            "git merge must succeed once scaffolding is gitignored — exit {}\nstdout: {}\nstderr: {}",
            merge_output.status, stdout, stderr
        );
        assert!(
            !stderr.contains("would be overwritten"),
            "merge output must not mention the untracked-overwrite collision:\n{}",
            stderr
        );

        // main's own untracked scaffolding must survive the merge untouched.
        let main_scaffolding = fs::read_to_string(
            root.join(".lazybrain").join("brain").join("_cache").join("fts.sqlite"),
        )
        .expect("main's own scaffolding file must still exist after merge");
        assert_eq!(main_scaffolding, "main-content", "merge must not have touched main's own untracked scaffolding");

        eprintln!(
            "real_git_merge_no_longer_collides_with_scaffolding_after_gitignore_fix PASSED\nmerge stdout: {}",
            stdout.trim()
        );
    }

    /// Contrast case for the test above: WITHOUT the gitignore fix, the
    /// exact same sequence reproduces the real-world bug verbatim — `git
    /// merge` refuses with "The following untracked working tree files
    /// would be overwritten by merge" naming the scaffolding path. Proves
    /// the fix above is actually load-bearing (removing it makes this fail
    /// the way production failed), not a no-op that happened not to break
    /// anything.
    #[test]
    fn real_git_merge_collides_with_scaffolding_without_the_gitignore_fix() {
        let tmp = TempDir::new().expect("TempDir::new");
        let root = tmp.path();

        init_test_git_repo(root);
        // Deliberately NOT calling ensure_project_gitignore_excludes_scaffolding.

        run_git(root, &["checkout", "-b", "mission"]);
        fs::create_dir_all(root.join(".lazybrain").join("brain").join("_cache")).expect("mkdir scaffolding");
        fs::write(root.join(".lazybrain").join("brain").join("_cache").join("fts.sqlite"), "mission-content")
            .expect("write scaffolding on mission");
        fs::write(root.join("normal.txt"), "v2 from mission\n").expect("edit normal file");
        run_git(root, &["add", "-A"]);
        let staged = run_git_output(root, &["diff", "--cached", "--name-only"]);
        assert!(
            staged.contains(".lazybrain"),
            "test precondition: without gitignore, `git add -A` MUST pick up the scaffolding, staged:\n{}",
            staged
        );
        run_git(root, &["commit", "-m", "mission work"]);

        run_git(root, &["checkout", "main"]);
        fs::create_dir_all(root.join(".lazybrain").join("brain").join("_cache")).expect("mkdir scaffolding on main");
        fs::write(root.join(".lazybrain").join("brain").join("_cache").join("fts.sqlite"), "main-content")
            .expect("write scaffolding on main");

        let merge_output = quiet_command(git_binary())
            .args(["merge", "mission"])
            .current_dir(root)
            .output()
            .expect("git merge failed to spawn");
        let stderr = String::from_utf8_lossy(&merge_output.stderr);

        assert!(
            !merge_output.status.success(),
            "test precondition: without the fix, this exact sequence must reproduce the real bug (merge must FAIL)"
        );
        assert!(
            stderr.contains("would be overwritten"),
            "expected the exact untracked-overwrite collision message, got:\n{}",
            stderr
        );
        assert!(
            stderr.contains(".lazybrain"),
            "collision message must name the scaffolding path, got:\n{}",
            stderr
        );

        // Best-effort cleanup — harmless either way since the TempDir is discarded.
        let _ = quiet_command(git_binary()).args(["merge", "--abort"]).current_dir(root).output();

        eprintln!(
            "real_git_merge_collides_with_scaffolding_without_the_gitignore_fix PASSED (bug reproduced): {}",
            stderr.trim()
        );
    }

    /// "An existing already-polluted project gets fixed on next open" — the
    /// fix runs on EVERY `set_project` call (not just first-ever), so a
    /// project whose `.lazybrain/`/`.lazy/` were created by an OLDER Lazy
    /// build (before this fix existed) — currently untracked and
    /// un-ignored — gets covered the moment the user reopens it, with no
    /// separate migration step.
    #[test]
    fn ensure_project_gitignore_excludes_scaffolding_fixes_already_polluted_project_on_next_open() {
        let tmp = TempDir::new().expect("TempDir::new");
        let root = tmp.path();
        init_test_git_repo(root);

        // Simulate a project already polluted by an older Lazy build:
        // scaffolding exists, untracked, .gitignore does not cover it yet.
        fs::create_dir_all(root.join(".lazybrain").join("brain").join("_cache")).expect("mkdir scaffolding");
        fs::write(root.join(".lazybrain").join("brain").join("_cache").join("fts.sqlite"), "pre-existing")
            .expect("write pre-existing scaffolding");
        fs::create_dir_all(root.join(".lazy").join("agents")).expect("mkdir .lazy scaffolding");

        let status_before = run_git_output(root, &["status", "--porcelain"]);
        assert!(
            status_before.contains(".lazybrain") || status_before.contains(".lazy"),
            "test precondition: pre-existing scaffolding must show up as untracked before the fix runs:\n{}",
            status_before
        );

        // The fix runs on "next open" — exactly what set_project calls.
        ensure_project_gitignore_excludes_scaffolding(root);

        let status_after = run_git_output(root, &["status", "--porcelain"]);
        assert!(
            !status_after.contains(".lazybrain") && !status_after.contains(".lazy"),
            "already-polluted scaffolding must no longer show up as untracked once the project is reopened, git status:\n{}",
            status_after
        );

        eprintln!(
            "ensure_project_gitignore_excludes_scaffolding_fixes_already_polluted_project_on_next_open PASSED\nbefore:\n{}\nafter:\n{}",
            status_before.trim(), status_after.trim()
        );
    }
}
