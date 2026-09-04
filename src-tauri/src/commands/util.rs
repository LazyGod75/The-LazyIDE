//! Small cross-cutting helpers used by 2+ command modules: quiet process
//! spawning (no console flash on Windows) and CLI-tool / repo path resolution.

use std::ffi::OsStr;
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::sync::{Condvar, Mutex};

use sha1_smol::Sha1;

use crate::state::ProjectRegistry;

/// CREATE_NO_WINDOW — quiet_command's flag so git/node children don't flash a console.
#[cfg(target_os = "windows")]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// BELOW_NORMAL_PRIORITY_CLASS — maintenance / graph rebuild must not starve the IDE.
#[cfg(target_os = "windows")]
pub(crate) const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;

/// Wraps Command::new with CREATE_NO_WINDOW on Windows so child processes
/// (git, claude, codex, node, taskkill) don't pop up visible console windows.
pub(crate) fn quiet_command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Keep CREATE_NO_WINDOW and add below-normal priority. Replacing flags
/// (instead of OR) would drop the no-window bit and flash a console —
/// maintenance.rs used to do that when it set BELOW_NORMAL alone.
#[allow(unused_variables)]
pub(crate) fn apply_below_normal_priority(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }
}

/// Bytes of stderr tail kept in memory by `spawn_stderr_tail` — 64 KiB is
/// comfortably enough to carry the last error/panic message a CLI child
/// wrote, without letting a runaway child (the Bun-based `claude` CLI hitting
/// a JavaScriptCore MemoryExhaustion assertion dumps megabytes of native
/// diagnostics) grow the drain thread's buffer without bound.
pub(crate) const STDERR_TAIL_CAP_BYTES: usize = 64 * 1024;

/// Spawn a background thread that drains `stream` to EOF — preventing the OS
/// pipe buffer from filling up and deadlocking the child (every call site
/// reads stdout concurrently on the same process) — while keeping only the
/// LAST `cap_bytes` bytes in memory instead of the unbounded
/// `read_to_string` this replaces.
///
/// Shared by 4 former near-identical copies (agent_run, spawn_scheduler,
/// codex_chat_stream_inner, claude_chat_stream_inner): each spawned a thread
/// that did `se.read_to_string(&mut buf)` into a plain `String` with no cap.
/// A child that never stops writing to stderr (or one that dumps a huge
/// crash diagnostic all at once) grew that buffer for as long as the child
/// process lived, x4 call sites.
///
/// The TAIL is what matters for error reporting — the text is joined after
/// `child.wait()` and surfaced verbatim in an `agent://error`/`model://error`
/// event, and whatever came LAST is closest to the actual failure; earlier
/// output is typically startup banners/warnings already superseded by the
/// time something goes wrong. A `…(truncated)\n` marker is prepended when
/// bytes were actually dropped, so a short genuine error can never be
/// confused with a silently clipped one.
///
/// Returns a `JoinHandle<String>` — callers `.join()` this exactly where they
/// previously joined the raw `read_to_string` thread, so every call site's
/// post-`child.wait()` handling is unchanged.
pub(crate) fn spawn_stderr_tail(
    mut stream: impl std::io::Read + Send + 'static,
    cap_bytes: usize,
) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut ring: std::collections::VecDeque<u8> = std::collections::VecDeque::new();
        let mut truncated = false;
        let mut chunk = [0u8; 8192];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => break, // EOF — child closed stderr (typically because it exited)
                Ok(n) => {
                    ring.extend(chunk[..n].iter().copied());
                    if ring.len() > cap_bytes {
                        let excess = ring.len() - cap_bytes;
                        ring.drain(..excess);
                        truncated = true;
                    }
                }
                Err(_) => break,
            }
        }
        let bytes: Vec<u8> = ring.into_iter().collect();
        // Lossy: stderr is arbitrary child output and may straddle a
        // multi-byte UTF-8 boundary right at the ring's cut point — matches
        // this codebase's existing convention (see truncate_on_char_boundary's
        // callers) of never panicking on non-boundary-safe text.
        let tail = String::from_utf8_lossy(&bytes).into_owned();
        if truncated {
            format!("…(truncated)\n{}", tail)
        } else {
            tail
        }
    })
}

/// Resolve a CLI program (e.g. "claude") to a concrete executable path,
/// honoring Windows PATHEXT so npm `.cmd` shims are found. Falls back to the
/// bare name (lets the OS resolve) if nothing is found.
pub(crate) fn resolve_cli_program(program: &str) -> std::ffi::OsString {
    #[cfg(windows)]
    {
        // npm shims are .cmd; prefer .cmd/.exe/.bat, then bare.
        let exts = [".cmd", ".exe", ".bat", ""];
        if let Ok(path) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path) {
                for ext in &exts {
                    let cand = dir.join(format!("{}{}", program, ext));
                    if cand.is_file() { return cand.into_os_string(); }
                }
            }
        }
    }
    std::ffi::OsString::from(program)
}

/// Normalizes path separators before any canonicalize/exists/parent call, on
/// Windows only. A Windows "verbatim" (`\\?\`-prefixed) path — which is what
/// every project root in this codebase becomes once passed through
/// `std::fs::canonicalize()` (see get_project_root) — disables Win32's
/// automatic '/'-to-'\' translation: a `/` inside a verbatim string is not a
/// separator at all, just an ordinary (invalid, since NTFS forbids '/' in a
/// filename) character. A caller that joins a suffix onto such a root with a
/// hardcoded '/' (e.g. TS's `${repoPath}/.lazy/artifacts`) therefore produces
/// a string that:
///   - `Path::exists()` always reports false for (the '/'-containing tail
///     doesn't name anything real),
///   - `Path::canonicalize()` fails outright with ERROR_INVALID_NAME (OS
///     error 123, confirmed empirically on this codebase's own dev machine
///     against a real `\\?\`-prefixed temp dir), and
///   - `Path::parent()` / `file_name()` mis-split on the last *backslash*
///     only, silently walking to the wrong (too-shallow) ancestor instead of
///     the intended parent.
/// Replacing every '/' with '\' up front makes all of the above behave
/// exactly as if the caller had joined with the correct separator to begin
/// with — regardless of whether the input happened to be verbatim, plain, or
/// already-clean. No-op on non-Windows, where '/' is the real separator and
/// '\' is a legal filename character that must never be rewritten.
#[cfg(target_os = "windows")]
pub(crate) fn normalize_separators(path: &str) -> String {
    path.replace('/', "\\")
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn normalize_separators(path: &str) -> String {
    path.to_string()
}

/// Strips a leading `\\?\` or `\\?\UNC\` (Windows extended-length /
/// "verbatim") prefix from a path string. No-op for any other path (POSIX,
/// plain Windows, or already-stripped).
///
/// Every project root in this codebase becomes verbatim-prefixed once
/// passed through `std::fs::canonicalize()` (see get_project_root) — fine
/// for `Command::current_dir()` (goes through Win32's SetCurrentDirectory,
/// which tolerates the prefix) PROVIDED the path is otherwise clean; a
/// verbatim path that also carries a stray `/` is NOT fine even as
/// `current_dir` — see `normalize_for_git`'s doc comment below (2026-08-05,
/// os error 267) — but NOT fine as a literal argument handed to
/// git.exe (a Git-for-Windows/MSYS2 binary): confirmed empirically (real git
/// install, real worktree) that `git worktree remove --force <verbatim
/// path>` fails with "fatal: '...' is not a working tree" even for the
/// EXACT directory git itself registered under `git worktree add` — git
/// records/matches worktree paths in non-verbatim form internally, so a
/// verbatim argument never textually matches. This is the same "git chokes
/// on a literal `\\?\`-prefixed argument" class agent_create_worktree_inner
/// (git.rs) already documents for `worktree add` — this fixes the same
/// class on the `remove` side (see worktree_cleanup.rs). Mirrors
/// src/lib/paths.ts's stripVerbatimPrefix on the TypeScript side.
pub(crate) fn strip_verbatim_prefix(path: &str) -> String {
    const UNC_PREFIX: &str = r"\\?\UNC\";
    const PREFIX: &str = r"\\?\";
    if let Some(rest) = path.strip_prefix(UNC_PREFIX) {
        format!(r"\\{}", rest)
    } else if let Some(rest) = path.strip_prefix(PREFIX) {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// Normalizes a path for safe use as a git subprocess's `current_dir`:
/// unify separators to `\` THEN strip a Windows verbatim prefix — the same
/// composition `ensure_repo_in_project_root` below already applies for its
/// own validation, now given a name so every call SITE (not just this one
/// validation function) can reuse it instead of re-deriving the two-call
/// idiom ad hoc.
///
/// 2026-08-05 (os error 267 incident): the note on `strip_verbatim_prefix`
/// above ("fine for `Command::current_dir()`... which tolerates the
/// prefix") is true only for a CLEAN verbatim path. It is NOT true for a
/// verbatim path that also carries even one stray `/` — mixed separators —
/// which is exactly what reaches git.rs's agent worktree lifecycle commands
/// (agent_create_worktree_inner, agent_merge_worktree_inner,
/// agent_worktree_diff_inner, agent_discard_worktree_inner via
/// worktree_cleanup.rs, git_revert_merge_inner) when a caller-supplied path
/// — `repo_path`, `merge_into_dir`, `worktree_path`, or a path this crate
/// itself builds by `Path::join`ing onto one of those — is verbatim
/// (`\\?\`-prefixed, which disables Win32's automatic '/'-to-'\'
/// translation) AND contains a `/` somewhere (e.g. built upstream by
/// naively concatenating a verbatim root with a '/'-joined segment). The
/// stray '/' then reads as an illegal character inside a path component,
/// and `Command::current_dir` — which on Windows goes through
/// `CreateProcessW`'s `lpCurrentDirectory` — fails to SPAWN the child at
/// all with `ERROR_DIRECTORY_NAME_INVALID` ("Nom de répertoire non valide",
/// os error 267), even though the target directory genuinely exists on
/// disk. This surfaces as `"<command>: git <verb> failed: ... (os error
/// 267)"` (the `.map_err` branch — the process never even started — not the
/// `!status.success()` branch, which would read "... error: <git's own
/// stderr>").
///
/// TypeScript already fixes this for the ONE call site QA B11 found
/// (runtime.ts's `mergeWorktree` normalizes `repoPath` via paths.ts's
/// `normalizeRepoPathForGit` before invoking `agent_merge_worktree`) — but
/// that same function's `mergeIntoDir` argument (the orchestrator
/// sub-agent fan-in path, runtime.ts Step E) is passed straight through
/// UN-normalized, which is exactly the "some merges fail, others pass"
/// shape reported in prod: a top-level mission merge (`repoPath` only) has
/// been clean since QA B11; a fan-in merge (`mergeIntoDir` set to a parent
/// worktree's own, un-normalized path) was not. Rather than patch that one
/// remaining TS gap and leave the Rust side trusting every future caller to
/// have already produced a clean path, every git subprocess call in git.rs
/// that takes a caller-supplied or caller-derived path as `current_dir` now
/// routes through this helper first — defense in depth, Rust-side, for
/// every call site, present and future, mirroring paths.ts's
/// `normalizeRepoPathForGit` one layer down the stack instead of depending
/// on it.
pub(crate) fn normalize_for_git(path: &str) -> String {
    strip_verbatim_prefix(&normalize_separators(path))
}

/// Case-folds a path for COMPARISON only, on Windows (case-insensitive/
/// -preserving filesystem) — a no-op on POSIX (case-sensitive). Never use
/// the output for an actual filesystem access, only for the containment
/// check below.
#[cfg(target_os = "windows")]
fn path_key(s: &str) -> String {
    s.to_lowercase()
}
#[cfg(not(target_os = "windows"))]
fn path_key(s: &str) -> String {
    s.to_string()
}

/// Comparison key for JSON path maps (auto-index markers, team-brain match).
///
/// Windows project roots arrive as `C:\…`, `C:/…`, or `\\?\C:\…` (the last is
/// `std::fs::canonicalize()`'s usual output). A string-equality marker then
/// misses on the next open and re-indexes the same tree. This collapses those
/// aliases to one lowercase, forward-slash form — a real key, not a display
/// path, so it is never used for filesystem I/O.
pub(crate) fn stable_path_key(path: &str) -> String {
    let cleaned = strip_verbatim_prefix(&normalize_separators(path));
    let mut unified = cleaned.replace('\\', "/");
    while unified.len() > 3 && unified.ends_with('/') {
        unified.pop();
    }
    path_key(&unified)
}

/// Lowercase JUST a leading Windows drive-letter prefix (`"C:..."` ->
/// `"c:..."`), for STABLE project-id hashing only — never for filesystem
/// access. No-op if `path` does not start with `<ASCII letter>:`, and a
/// total no-op on non-Windows (no drive-letter concept there).
///
/// Narrower than `path_key` above (which folds the WHOLE string for a
/// same-platform containment comparison): every other path component a
/// canonicalized root can contain already reflects stable, real on-disk
/// casing (Windows `canonicalize()`/`GetFinalPathNameByHandleW` resolves to
/// the filesystem's own casing for every component it passes through), so
/// only the drive letter — which a caller may have typed in either case
/// before it ever reaches `canonicalize()` — needs folding to guarantee
/// `project_id_for_root` is stable across otherwise-equivalent inputs.
#[cfg(target_os = "windows")]
fn lowercase_drive_letter(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let mut out = String::with_capacity(path.len());
        out.push((bytes[0] as char).to_ascii_lowercase());
        out.push_str(&path[1..]);
        out
    } else {
        path.to_string()
    }
}

#[cfg(not(target_os = "windows"))]
fn lowercase_drive_letter(path: &str) -> String {
    path.to_string()
}

/// Compute a stable project id (a hex SHA-1 digest) from an ALREADY
/// canonicalized project root (see `ProjectEntry`/`RegistryInner::register`,
/// state.rs). Strips the Windows verbatim `\\?\` prefix and any trailing
/// separator, and folds the drive letter to lowercase (see
/// `lowercase_drive_letter`) before hashing — so the SAME real directory
/// always yields the SAME id regardless of `\\?\`-prefixing, a trailing
/// separator, or drive-letter casing at the call site. Reuses
/// `normalize_separators`/`strip_verbatim_prefix` rather than hand-rolling
/// new path handling, per this module's existing convention.
pub(crate) fn project_id_for_root(canonical_root: &str) -> String {
    let normalized = normalize_separators(canonical_root);
    let stripped = strip_verbatim_prefix(&normalized);
    let trimmed = stripped.trim_end_matches(['\\', '/']);
    let keyed = lowercase_drive_letter(trimmed);

    let mut hasher = Sha1::new();
    hasher.update(keyed.as_bytes());
    hasher.digest().to_string()
}

/// Safety boundary for any destructive worktree-directory removal: `target`
/// must be strictly inside `<repo_path>/.lazy/worktrees/` — the ONLY place
/// agent_create_worktree_inner (git.rs) ever creates a worktree. Used to
/// gate worktree cleanup (see worktree_cleanup.rs) so a path-computation bug
/// on either side (Rust or the TS caller) can never make cleanup remove the
/// main project checkout or anything else on disk.
///
/// Purely lexical: normalizes separators + strips the Windows verbatim
/// prefix + case-folds (Windows only) on both sides, and rejects any `..`
/// path-traversal component — deliberately NOT canonicalize()-based, since
/// canonicalize() requires the target to exist, which would wrongly reject
/// the expected idempotent case of cleaning up an already-removed worktree
/// (e.g. stopMission's direct cleanup racing runMission's own cleanup path
/// — both may legitimately try to discard the same worktree).
///
/// Component-wise via `Path::starts_with` (not a naive string prefix) so a
/// sibling like `.lazy/worktrees-evil` never falsely matches
/// `.lazy/worktrees` — same precaution as this file's own
/// `ensure_repo_in_project_root_rejects_name_prefix_sibling` test below.
pub(crate) fn is_within_agent_worktrees_dir(repo_path: &str, target: &str) -> bool {
    let repo_norm = path_key(&strip_verbatim_prefix(&normalize_separators(repo_path)));
    let target_norm = path_key(&strip_verbatim_prefix(&normalize_separators(target)));

    let target_path = std::path::Path::new(&target_norm);
    if target_path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return false;
    }

    let expected_prefix = std::path::Path::new(&repo_norm).join(".lazy").join("worktrees");
    target_path.starts_with(&expected_prefix) && target_path != expected_prefix
}

/// Multi-project counterpart of `is_within_agent_worktrees_dir`: true when
/// `target` is a mission worktree of ANY currently-registered project root,
/// not just one specific root — the same "any open project" relaxation
/// `ensure_repo_in_project_roots` applies to the plain containment check.
///
/// Used by the scoped worktree-script execution gate (see
/// `run_worktree_script`/`is_worktree_script_eligible` in shell.rs, the M12
/// dogfood fix): a verification mission's cwd must resolve to an actual
/// mission worktree — not merely "somewhere under an open project root" —
/// before the narrow build/test-script allowlist is ever consulted.
pub(crate) fn is_within_any_project_worktrees_dir(target: &str, roots: &[String]) -> bool {
    roots.iter().any(|root| is_within_agent_worktrees_dir(root, target))
}

/// Validate that a path is inside the given project root string.
/// This is the security-critical check that prevents git/agent commands from
/// operating on arbitrary directories outside the user's project.
/// Separated from its `tauri::State`-consuming callers
/// (`ensure_repo_in_project_roots` / `ensure_repo_in_any_open_project` below)
/// so it can be unit-tested without a `tauri::State`.
pub(crate) fn ensure_repo_in_project_root(repo_path: &str, root: &str) -> Result<(), String> {
    // strip_verbatim_prefix before canonicalize (not just normalize_separators)
    // for the same reason fs.rs's dunce_simplify exists: a `\\?\`-prefixed
    // path disables Win32's '.'/'..' resolution, so a candidate built by
    // joining a relative suffix onto an already-verbatim root (e.g.
    // get_project_root's own output) would otherwise fail to canonicalize
    // whenever that suffix carries a '.'/'..' component. No-op here today
    // (git command callers don't currently append such a suffix), applied
    // for consistency with fs.rs and as defense-in-depth for future callers.
    let normalized_repo_path = strip_verbatim_prefix(&normalize_separators(repo_path));

    if root.is_empty() {
        return Err("no project root set — git operation denied".to_string());
    }

    let normalized_root = strip_verbatim_prefix(&normalize_separators(root));
    let project_root = std::path::Path::new(&normalized_root)
        .canonicalize()
        .map_err(|e| format!("project root canonicalize failed: {}", e))?;
    // 2026-08-12 fix (\\?\ mismatch defeating the not-yet-existing-file fast
    // path below) — `Path::canonicalize()` on Windows ALWAYS returns a
    // verbatim (`\\?\`-prefixed) path, REGARDLESS of whether the input we
    // handed it (`normalized_root`, stripped just above) carried that prefix
    // or not — a well-known std::fs::canonicalize quirk on this platform
    // (the same one fs.rs's `dunce_simplify` exists to work around). Without
    // stripping it back off here, `root_key`/`root_prefix` would ALWAYS carry
    // `\\?\` while `t` below (built from `normalized_repo_path`, which had
    // its own verbatim prefix stripped at the top of this function) NEVER
    // does — so `t.starts_with(&root_prefix)` could never match, for ANY
    // candidate, existing or not. This stayed invisible for an EXISTING
    // target because the bottom fallback re-canonicalizes the CANDIDATE too
    // (picking the prefix back up on both sides, by accident); it was fatal
    // for a NOT-YET-EXISTING one, since canonicalize() cannot succeed on a
    // target that does not exist — the lexical fast path below is the ONLY
    // code path that can ever accept one, and this mismatch silently
    // defeated it every time, regardless of the target's real location.
    // Real repro (2026-08-12): a freshly-registered project's own
    // `.lazy/orchestrators.json` — never yet created — was rejected as
    // "outside every registered project root", the exact symptom this fixes.
    let root_key = path_key(&strip_verbatim_prefix(&project_root.to_string_lossy()));
    let root_prefix = if root_key.ends_with(std::path::MAIN_SEPARATOR) {
        root_key.clone()
    } else {
        format!("{}{}", root_key, std::path::MAIN_SEPARATOR)
    };

    let candidate = std::path::Path::new(&normalized_repo_path);

    // REAL-APP FIX (2026-08-04, UC3 dogfood — the run that failed M1/M3):
    // the old code canonicalized the TARGET unconditionally and turned a
    // canonicalize failure into "access denied ... outside every registered
    // project root". But canonicalize() requires the target to EXIST, and an
    // agent legitimately touches plenty of not-yet-existing paths inside its
    // own project: read_file on a file that does not exist yet, write_file
    // creating a brand-new path, find_file scanning a fresh worktree. Those
    // all used to surface as a misleading access-denied, which sent agents
    // (deepseek-chat especially) into a confusion loop — exactly the
    // `consecutive_failures` on M1 (read_dir of its own worktree) seen live.
    //
    // New order: LEXICAL containment first (component-wise, case-folded, and
    // deliberately rejecting '..' components — a '..' path whose resolution
    // happens to stay inside the project is still fine, the canonicalize
    // pass below proves it when the target exists). A lexically-inside path
    // that does not exist yet is ACCEPTED (the fs operation itself then
    // reports not-found, which is honest and actionable). A lexically-inside
    // path that DOES exist is additionally canonicalized and re-verified, so
    // a symlink planted inside the project that resolves outside is still
    // denied — the security boundary never weakens for existing targets.
    let has_dotdot = candidate
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir));

    if !has_dotdot {
        let t = path_key(&normalized_repo_path);
        if t == root_key || t.starts_with(&root_prefix) {
            match candidate.canonicalize() {
                Ok(real) => {
                    // Same strip-before-key rationale as `root_key` above —
                    // `real` just came out of `.canonicalize()` too, so it
                    // ALWAYS carries `\\?\` on Windows regardless of whether
                    // `candidate` did; `root_key` no longer does, so this side
                    // must not either.
                    let rt = path_key(&strip_verbatim_prefix(&real.to_string_lossy()));
                    if rt == root_key || rt.starts_with(&root_prefix) {
                        return Ok(());
                    }
                    return Err(format!(
                        "access denied: path '{}' resolves outside project root '{}'",
                        repo_path,
                        project_root.display()
                    ));
                }
                // Target does not exist (yet) — lexically inside the project,
                // accept: the fs call itself reports not-found if that is the
                // real situation.
                Err(_) => return Ok(()),
            }
        }
    }

    // Existing-target fallback: canonicalize and compare. Covers '..' paths
    // and symlinks for targets that exist; a non-existent '..' path (or any
    // other non-existent path that failed the lexical check) is denied with
    // the same honest error as before.
    let target = candidate
        .canonicalize()
        .map_err(|e| format!("path canonicalize failed for '{}': {}", repo_path, e))?;
    // Same strip-before-key rationale as `root_key`/`rt` above.
    let t = path_key(&strip_verbatim_prefix(&target.to_string_lossy()));
    if t == root_key || t.starts_with(&root_prefix) {
        Ok(())
    } else {
        Err(format!(
            "access denied: path '{}' is outside project root '{}'",
            target.display(),
            project_root.display()
        ))
    }
}

/// Multi-project counterpart of `ensure_repo_in_project_root`: validates that
/// `repo_path` is inside ANY ONE of `roots`, not just a single root — "the
/// security boundary moves, it does not disappear" (spec section 5.1) once
/// more than one project can be open at a time. Tries every candidate root
/// with the exact same canonicalize + `starts_with` containment check
/// `ensure_repo_in_project_root` already uses (see that function's doc
/// comment for the full rationale) and accepts the first match.
///
/// Adopted by every command module that used to gate a caller-supplied path
/// against the single legacy `ProjectState` root (git.rs, shell.rs, agent.rs,
/// lsp.rs — via `ensure_repo_in_any_open_project` below) so a mission running
/// in a registered-but-not-active ("background") project is no longer
/// rejected — the exact scenario this allowlist was introduced for.
pub(crate) fn ensure_repo_in_project_roots(repo_path: &str, roots: &[String]) -> Result<(), String> {
    if roots.is_empty() {
        return Err("no project roots registered — git operation denied".to_string());
    }

    let mut last_err = String::new();
    for root in roots {
        match ensure_repo_in_project_root(repo_path, root) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = e,
        }
    }
    Err(format!(
        "access denied: '{}' is outside every registered project root ({} checked) — last error: {}",
        repo_path,
        roots.len(),
        last_err
    ))
}

/// Wrapper that reads every open root from `ProjectRegistry` and delegates to
/// `ensure_repo_in_project_roots` — the multi-project counterpart of the (now
/// removed) `ensure_repo_in_project`, which checked only the single legacy
/// `ProjectState` root. Wired into every command module that used to call
/// that legacy wrapper (git.rs, shell.rs, agent.rs, lsp.rs).
pub(crate) fn ensure_repo_in_any_open_project(repo_path: &str, registry: &tauri::State<ProjectRegistry>) -> Result<(), String> {
    let roots = registry.0.lock()
        .map_err(|e| format!("project registry lock failed: {}", e))?
        .all_roots();
    ensure_repo_in_project_roots(repo_path, &roots)
}

/// Build the `taskkill` argv that forcefully kills a process AND its full
/// descendant tree on Windows: `/PID <pid> /T /F`.
///
/// `/T` tree-kills descendants — sidecars and CLI missions alike spawn their
/// own child processes (LazyBrain's embeddings worker, claude/codex's shell
/// tool calls) that a plain `Child::kill()` (TerminateProcess on just one
/// handle) does not reach. `/F` forces termination without prompting.
///
/// Pure/unit-tested in isolation (`tree_kill_args_is_well_formed`) since
/// inspecting the `std::process::Command` built from it is awkward — mirrors
/// the `serve_command_args` / `permission_flag` convention used elsewhere in
/// this codebase for the same reason. Single source of truth shared by every
/// exit-time / kill-time cleanup path: `BrainSidecar::stop`,
/// `TeamsSidecar::stop`, `kill_tracked_agent_pids`, and the FORCE half of
/// `interrupt_then_force_kill` (user abort of `agent_run`).
pub(crate) fn tree_kill_args(pid: u32) -> Vec<String> {
    vec!["/PID".to_string(), pid.to_string(), "/T".to_string(), "/F".to_string()]
}

/// Soft interrupt argv: tree-close WITHOUT `/F`.
///
/// Graceful drain: give `claude -p` a Ctrl-C / WM_CLOSE window so it
/// can flush before the force kill. `/T` still covers grandchildren; omitting
/// `/F` is the whole point (see `tree_interrupt_args_is_soft_close_without_force`).
pub(crate) fn tree_interrupt_args(pid: u32) -> Vec<String> {
    vec!["/PID".to_string(), pid.to_string(), "/T".to_string()]
}

/// Drain window after SIGINT / WM_CLOSE before SIGKILL / `taskkill /F`.
pub(crate) const AGENT_INTERRUPT_DRAIN_MS: u64 = 400;

pub(crate) fn force_kill_pid(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = quiet_command("taskkill").args(tree_kill_args(pid)).output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsafe { libc::kill(pid as i32, libc::SIGKILL); }
    }
}

/// User abort of a native CLI mission: SIGINT (Unix) or `taskkill /T`
/// without `/F` (Windows), then force-kill after `AGENT_INTERRUPT_DRAIN_MS`.
/// Exit-time cleanup still uses `tree_kill_args` / SIGKILL immediately —
/// those paths must not wait.
pub(crate) fn interrupt_then_force_kill(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = quiet_command("taskkill").args(tree_interrupt_args(pid)).output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsafe { libc::kill(pid as i32, libc::SIGINT); }
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(AGENT_INTERRUPT_DRAIN_MS));
        force_kill_pid(pid);
    });
}

/// Truncate `s` to at most `max_bytes` bytes WITHOUT splitting a multi-byte
/// UTF-8 character. A plain `&s[..max_bytes]` panics ("byte index N is not
/// a char boundary") whenever a multi-byte character — an accented Latin
/// letter (`é`, `à`), a CJK character, an emoji — straddles the cut point.
///
/// Walks backward from `max_bytes` to the nearest valid char boundary, so
/// the result is always <= max_bytes and always a valid `&str`. Any string
/// containing user- or LLM-generated text (streamed agent/model output,
/// capture titles, git output, ...) can hit the panic this guards against —
/// it hit hardest in commands/agent.rs, where the panic happened inside a
/// detached background thread (the stdout-reader thread spawned by
/// agent_run / spawn_scheduler): the thread dies silently, the mission's
/// `agent://done` event never fires, and Mission Control hangs forever
/// waiting for a completion that will never come.
///
/// Returns `s` unchanged when it is already <= max_bytes (the common case).
pub(crate) fn truncate_on_char_boundary(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ── Bounded concurrency gate ──────────────────────────────────────

/// Reusable blocking counting semaphore shared by every command module that
/// needs to cap how many heavyweight operations (subprocess spawns, blocking
/// HTTP downloads, ...) run at once. Previously each caller hand-rolled its
/// own copy of the identical Mutex+Condvar pattern — web.rs's
/// WEB_OPS_COUNT/WEB_OPS_CVAR/WebOpsGuard/acquire_web_op_slot and
/// brain/capture.rs's CaptureSemaphore/CapturePermit — now unified here.
///
/// Plain `Mutex`+`Condvar` rather than `tokio::sync::Semaphore`: every
/// current caller is a synchronous Tauri command already running on a
/// blocking worker thread, so a blocking wait here needs no async runtime
/// handle and cannot deadlock the UI event loop.
///
/// POISON-SAFE on both `acquire()` and release (Drop): recovers via
/// `unwrap_or_else(|e| e.into_inner())` instead of erroring out or no-oping.
/// A `Mutex` only poisons if a panic unwinds while ITS lock is held — the
/// brief window inside `acquire()`/`release()` itself, not the (typically
/// much longer) window a caller holds a permit for — but if that ever
/// happens, erroring out of `acquire()` would permanently wedge the gate
/// shut for every future caller, and no-oping in `release()` would leak a
/// slot (under-counting capacity forever, eventually starving every
/// caller). Recovering the poisoned guard instead keeps the gate correct
/// either way, exactly like the original CaptureSemaphore already did.
pub(crate) struct BoundedGate {
    capacity: u32,
    count: Mutex<u32>,
    freed: Condvar,
}

impl BoundedGate {
    pub(crate) const fn new(capacity: u32) -> Self {
        Self { capacity, count: Mutex::new(0), freed: Condvar::new() }
    }

    /// Block until fewer than `capacity` permits are outstanding, then take
    /// one and return an RAII guard that releases it on drop — so a permit
    /// is always released on every exit path (success, error, early `?`
    /// return, or a panic unwinding through the guard) without each call
    /// site needing to remember to release explicitly.
    pub(crate) fn acquire(&self) -> BoundedGatePermit<'_> {
        let mut count = self.count.lock().unwrap_or_else(|e| e.into_inner());
        while *count >= self.capacity {
            count = self.freed.wait(count).unwrap_or_else(|e| e.into_inner());
        }
        *count += 1;
        BoundedGatePermit { gate: self }
    }

    /// Non-blocking variant of `acquire()`: takes a permit immediately if one
    /// is available, or returns `None` without waiting when the gate is
    /// already at capacity. For callers that need to reject-fast with a
    /// clear error (e.g. agent_run's mission cap) instead of silently
    /// queuing behind `acquire()`'s blocking wait — queuing here would tie
    /// up the caller's own thread/task for however long it takes a slot to
    /// free, which for long-lived missions can be hours.
    pub(crate) fn try_acquire(&self) -> Option<BoundedGatePermit<'_>> {
        let mut count = self.count.lock().unwrap_or_else(|e| e.into_inner());
        if *count >= self.capacity {
            return None;
        }
        *count += 1;
        Some(BoundedGatePermit { gate: self })
    }

    fn release(&self) {
        let mut count = self.count.lock().unwrap_or_else(|e| e.into_inner());
        *count = count.saturating_sub(1);
        self.freed.notify_one();
    }
}

/// RAII permit returned by `BoundedGate::acquire` — releases its slot (and
/// wakes one waiter) on drop, including on early return via `?` or a panic
/// unwinding through it.
pub(crate) struct BoundedGatePermit<'a> {
    gate: &'a BoundedGate,
}

impl Drop for BoundedGatePermit<'_> {
    fn drop(&mut self) {
        self.gate.release();
    }
}

// ── Abandoned drain-thread accounting ────────────────────────────

/// Process-lifetime count of stdout/stderr drain threads that were detached
/// (never joined) after a bounded post-kill wait expired instead of exiting
/// promptly — see run_shell_inner (commands/shell.rs) and run_tests
/// (test_runner.rs). Both kill their child's process tree on timeout, then
/// give its drain threads a short bounded window to notice EOF and exit; if
/// a grandchild process still holds the child's stdout/stderr pipe handle
/// open past that window, the drain thread stays blocked in its `read()`
/// call indefinitely and is abandoned (detached) rather than joined, to keep
/// the bounded-join promise.
///
/// This counter makes that otherwise-silent leak observable instead of
/// invisible: each detach increments it, and `abandoned_drain_thread_count`
/// exposes the running total (e.g. for a future diagnostics/health-check
/// surface). It intentionally does NOT track WHICH threads or attempt to
/// clean them up — a detached thread blocked in a blocking OS read has no
/// safe way to be cancelled from here; this is purely a leak-visibility aid.
pub(crate) static ABANDONED_DRAIN_THREADS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Record that a drain thread was detached without being joined. Call
/// exactly once per detach, right before dropping/leaking the JoinHandle.
pub(crate) fn record_abandoned_drain_thread() {
    ABANDONED_DRAIN_THREADS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

/// Current process-lifetime total of abandoned drain threads — see
/// `ABANDONED_DRAIN_THREADS`'s doc comment.
pub(crate) fn abandoned_drain_thread_count() -> u64 {
    ABANDONED_DRAIN_THREADS.load(std::sync::atomic::Ordering::Relaxed)
}

/// Diagnostic command exposing `abandoned_drain_thread_count` to the
/// frontend — the process-health panel this counter was always meant to
/// feed (see `ABANDONED_DRAIN_THREADS`'s doc comment) does not exist yet;
/// this only wires the number through so a future panel has a real command
/// to call instead of needing its own plumbing added later.
#[tauri::command]
pub(crate) fn get_abandoned_drain_thread_count() -> u64 {
    abandoned_drain_thread_count()
}

/// Join `handle` if it finishes within `bound`, otherwise abandon it and
/// record the abandonment via `record_abandoned_drain_thread`.
///
/// `std::thread::JoinHandle::join` has no timeout parameter — blocking on it
/// after a kill is exactly the hang this is meant to prevent (a grandchild
/// process can keep the drain thread's pipe `read()` blocked forever even
/// after the tracked child is dead). This instead polls the stable
/// `JoinHandle::is_finished()` (non-blocking) until either it flips true —
/// at which point the real `join()` call is a formality that returns
/// immediately — or `bound` elapses, in which case the handle is dropped
/// (detaching the still-blocked thread) rather than waited on further.
///
/// Used by run_shell_inner (commands/shell.rs) and run_tests
/// (test_runner.rs) for their post-timeout stdout/stderr drain threads —
/// both tree-kill the child first, so in the overwhelmingly common case the
/// drain thread notices EOF and finishes within a few milliseconds; `bound`
/// only matters for the pathological surviving-grandchild case.
pub(crate) fn join_drain_thread_bounded<T: Send + 'static>(
    handle: std::thread::JoinHandle<T>,
    bound: std::time::Duration,
) -> Option<T> {
    let start = std::time::Instant::now();
    loop {
        if handle.is_finished() {
            return handle.join().ok();
        }
        if start.elapsed() >= bound {
            record_abandoned_drain_thread();
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── spawn_stderr_tail ────────────────────────────────────────────

    /// A small write well under the cap must be returned unchanged, with no
    /// truncation marker — the common case (a short error message).
    #[test]
    fn spawn_stderr_tail_returns_short_output_unchanged() {
        let data = b"claude: spawn failed\n".to_vec();
        let handle = spawn_stderr_tail(std::io::Cursor::new(data), 64 * 1024);
        let result = handle.join().expect("thread must not panic");
        assert_eq!(result, "claude: spawn failed\n");
        eprintln!("spawn_stderr_tail_returns_short_output_unchanged PASSED");
    }

    /// A write that exceeds cap_bytes must be reduced to (at most) the last
    /// cap_bytes bytes and carry the truncation marker prefix.
    #[test]
    fn spawn_stderr_tail_keeps_only_the_tail_when_over_cap() {
        // 100 lines of "line-000\n".. "line-099\n" (9 bytes each = 900 bytes),
        // capped to 90 bytes — must keep roughly the last 10 lines only.
        let mut data = Vec::new();
        for i in 0..100 {
            data.extend_from_slice(format!("line-{:03}\n", i).as_bytes());
        }
        let cap = 90usize;
        let handle = spawn_stderr_tail(std::io::Cursor::new(data), cap);
        let result = handle.join().expect("thread must not panic");

        assert!(result.starts_with("…(truncated)\n"), "must carry the truncation marker, got: {}", result);
        assert!(result.contains("line-099"), "the LAST line must survive, got: {}", result);
        assert!(!result.contains("line-000"), "the FIRST line must have been dropped, got: {}", result);
        eprintln!("spawn_stderr_tail_keeps_only_the_tail_when_over_cap PASSED");
    }

    /// Empty stream (child wrote nothing to stderr) must yield an empty
    /// string with no truncation marker — matches the pre-existing
    /// `read_to_string` behavior for a clean/silent run.
    #[test]
    fn spawn_stderr_tail_handles_empty_stream() {
        let handle = spawn_stderr_tail(std::io::Cursor::new(Vec::new()), 64 * 1024);
        let result = handle.join().expect("thread must not panic");
        assert_eq!(result, "");
        eprintln!("spawn_stderr_tail_handles_empty_stream PASSED");
    }

    /// Output exactly at the cap must not be truncated (boundary case: the
    /// drop-only-when-strictly-over check must not off-by-one).
    #[test]
    fn spawn_stderr_tail_does_not_truncate_when_exactly_at_cap() {
        let data = vec![b'x'; 128];
        let handle = spawn_stderr_tail(std::io::Cursor::new(data.clone()), 128);
        let result = handle.join().expect("thread must not panic");
        assert_eq!(result.len(), 128);
        assert!(!result.starts_with("…(truncated)"), "exactly-at-cap must not be marked truncated");
        eprintln!("spawn_stderr_tail_does_not_truncate_when_exactly_at_cap PASSED");
    }

    /// A ring cut landing mid multi-byte UTF-8 character must not panic —
    /// from_utf8_lossy replaces the broken tail with the replacement
    /// character instead of panicking (mirrors truncate_on_char_boundary's
    /// existing multi-byte-safety convention elsewhere in this file).
    #[test]
    fn spawn_stderr_tail_does_not_panic_on_a_boundary_straddling_multibyte_char() {
        // "中" is 3 bytes (0xE4 0xB8 0xAD). Cap to 2 bytes so the cut lands
        // mid-character.
        let data = "中".as_bytes().to_vec();
        let handle = spawn_stderr_tail(std::io::Cursor::new(data), 2);
        let result = handle.join().expect("thread must not panic");
        assert!(result.starts_with("…(truncated)"));
        eprintln!("spawn_stderr_tail_does_not_panic_on_a_boundary_straddling_multibyte_char PASSED (result={:?})", result);
    }

    /// taskkill argv must carry /PID <pid> /T /F, in that order — /T is what
    /// makes this a *tree* kill (the flag this whole fix exists to add), /F
    /// forces termination without an interactive prompt.
    #[test]
    fn tree_kill_args_is_well_formed() {
        let args = tree_kill_args(4242);
        assert_eq!(
            args,
            vec!["/PID", "4242", "/T", "/F"],
            "taskkill argv must be /PID <pid> /T /F in that order"
        );
        eprintln!("tree_kill_args_is_well_formed PASSED (args={:?})", args);
    }

    /// The pid is genuinely interpolated (not a hardcoded placeholder) —
    /// different pids must produce different argv at index 1.
    #[test]
    fn tree_kill_args_interpolates_the_given_pid() {
        assert_eq!(tree_kill_args(1)[1], "1");
        assert_eq!(tree_kill_args(999_999)[1], "999999");
        eprintln!("tree_kill_args_interpolates_the_given_pid PASSED");
    }

    #[test]
    fn tree_interrupt_args_is_soft_close_without_force() {
        let args = tree_interrupt_args(4242);
        assert_eq!(
            args,
            vec!["/PID", "4242", "/T"],
            "soft interrupt must be /PID <pid> /T — no /F"
        );
        assert!(
            !args.iter().any(|a| a == "/F"),
            "SIGINT-equivalent must not force-kill on the first shot"
        );
        eprintln!("tree_interrupt_args_is_soft_close_without_force PASSED (args={:?})", args);
    }

    #[test]
    fn tree_interrupt_args_interpolates_the_given_pid() {
        assert_eq!(tree_interrupt_args(7)[1], "7");
        assert_eq!(tree_interrupt_args(88_001)[1], "88001");
        eprintln!("tree_interrupt_args_interpolates_the_given_pid PASSED");
    }

    // ── truncate_on_char_boundary ────────────────────────────────────

    #[test]
    fn truncate_on_char_boundary_returns_unchanged_when_within_limit() {
        let s = "short string";
        assert_eq!(truncate_on_char_boundary(s, 80), s);
        eprintln!("truncate_on_char_boundary_returns_unchanged_when_within_limit PASSED");
    }

    #[test]
    fn truncate_on_char_boundary_leaves_a_valid_boundary_untouched() {
        // Pure-ASCII cut point — already a valid boundary, no adjustment needed.
        let s = "hello world";
        assert_eq!(truncate_on_char_boundary(s, 5), "hello");
        eprintln!("truncate_on_char_boundary_leaves_a_valid_boundary_untouched PASSED");
    }

    #[test]
    fn truncate_on_char_boundary_handles_accented_text_straddling_the_cut() {
        // 'é' is 2 bytes in UTF-8 (0xC3 0xA9). 79 ASCII bytes then 'é' means
        // byte 79 is 'é's first byte and byte 80 is its continuation byte —
        // exactly the panic condition for a plain &s[..80].
        let s: String = "a".repeat(79) + "é" + "trailing text after the boundary";
        assert!(!s.is_char_boundary(80), "test precondition: 80 must NOT be a char boundary");

        let truncated = truncate_on_char_boundary(&s, 80);

        assert!(truncated.len() <= 80, "must never exceed max_bytes");
        assert!(s.is_char_boundary(truncated.len()), "result must land on a real char boundary");
        assert_eq!(truncated, "a".repeat(79), "must back off to just before the straddling 'é'");
        eprintln!("truncate_on_char_boundary_handles_accented_text_straddling_the_cut PASSED");
    }

    #[test]
    fn truncate_on_char_boundary_handles_cjk_text_straddling_the_cut() {
        // CJK characters are 3 bytes each in UTF-8. 30 copies = 90 bytes;
        // byte 80 falls inside the 27th character (26*3=78, 27*3=81).
        let s: String = "中".repeat(30);
        assert!(!s.is_char_boundary(80), "test precondition: 80 must NOT be a char boundary for 3-byte CJK chars");

        let truncated = truncate_on_char_boundary(&s, 80);

        assert!(truncated.len() <= 80);
        assert!(s.is_char_boundary(truncated.len()));
        assert_eq!(truncated, "中".repeat(26), "must back off to the last fully-contained CJK char (78 bytes)");
        eprintln!("truncate_on_char_boundary_handles_cjk_text_straddling_the_cut PASSED");
    }

    #[test]
    fn truncate_on_char_boundary_handles_emoji_straddling_the_cut() {
        // Emoji (e.g. the rocket) are 4 bytes in UTF-8. 78 ASCII bytes then
        // the emoji means byte 80 lands on its 3rd (continuation) byte.
        let s: String = "x".repeat(78) + "🚀" + "more text after the emoji";
        assert!(!s.is_char_boundary(80), "test precondition: 80 must NOT be a char boundary for a 4-byte emoji starting at 78");

        let truncated = truncate_on_char_boundary(&s, 80);

        assert!(truncated.len() <= 80);
        assert!(s.is_char_boundary(truncated.len()));
        assert_eq!(truncated, "x".repeat(78), "must back off to just before the straddling emoji");
        eprintln!("truncate_on_char_boundary_handles_emoji_straddling_the_cut PASSED");
    }

    #[test]
    fn truncate_on_char_boundary_zero_max_bytes_returns_empty_string() {
        let s: String = "中".repeat(5);
        assert_eq!(truncate_on_char_boundary(&s, 0), "");
        eprintln!("truncate_on_char_boundary_zero_max_bytes_returns_empty_string PASSED");
    }

    // ── ensure_repo_in_project_root: Windows verbatim / mixed-separator paths ──
    //
    // Regression coverage for the real-app QA bug: "[missionQueue] Failed to
    // persist queue: access denied: path '\\?\C:\...\qa-project/.lazy' is
    // outside project root '\\?\C:\...\qa-project'". repoPath is typically
    // std::fs::canonicalize()'s own output (verbatim `\\?\`-prefixed on
    // Windows), and a caller that joins a suffix with a hardcoded '/'
    // produces a mixed-separator string that — before this fix — made
    // Path::exists()/canonicalize()/parent() misbehave (see
    // normalize_separators' doc comment for the exact mechanism, confirmed
    // empirically via a throwaway probe against a real temp dir on this
    // machine: canonicalize() failed with OS error 123 InvalidFilename, and
    // Path::parent() walked to the grandparent instead of the project root).

    fn make_temp_test_dir(label: &str) -> std::path::PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "lazy_util_test_{}_{}_{}",
            std::process::id(),
            label,
            unique
        ));
        std::fs::create_dir_all(&dir).expect("failed to create temp test dir");
        dir
    }

    /// Mixed separators exactly as missionQueue.ts's `writeQueue` built them
    /// pre-fix: a verbatim (`\\?\`-prefixed) canonicalized root with a
    /// forward-slash-joined `.lazy/artifacts` tail.
    #[test]
    fn ensure_repo_in_project_root_accepts_forward_slash_joined_verbatim_subpath() {
        let root = make_temp_test_dir("root_ok");
        std::fs::create_dir_all(root.join(".lazy").join("artifacts")).unwrap();

        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        assert!(
            root_str.starts_with(r"\\?\"),
            "sanity: canonicalize() must yield a verbatim path on Windows, got {}",
            root_str
        );

        let mixed = format!("{}/.lazy/artifacts", root_str);
        let result = ensure_repo_in_project_root(&mixed, &root_str);
        assert!(
            result.is_ok(),
            "expected mixed-separator verbatim subpath to be accepted, got: {:?}",
            result
        );

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_repo_in_project_root_accepts_forward_slash_joined_verbatim_subpath PASSED");
    }

    /// Same shape as missionQueue.ts's `${repoPath}/.lazy/mission-queue.json`
    /// (a mixed-separator *file* path, not just a directory).
    #[test]
    fn ensure_repo_in_project_root_accepts_mixed_separator_file_path() {
        let root = make_temp_test_dir("root_file");
        std::fs::create_dir_all(root.join(".lazy")).unwrap();
        std::fs::write(root.join(".lazy").join("mission-queue.json"), b"{}").unwrap();

        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        let mixed = format!("{}/.lazy/mission-queue.json", root_str);

        let result = ensure_repo_in_project_root(&mixed, &root_str);
        assert!(
            result.is_ok(),
            "expected mixed-separator file path to be accepted, got: {:?}",
            result
        );

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_repo_in_project_root_accepts_mixed_separator_file_path PASSED");
    }

    /// A genuinely-outside sibling directory must still be denied — the fix
    /// must not weaken the containment check itself.
    #[test]
    fn ensure_repo_in_project_root_rejects_sibling_directory_outside_root() {
        let root = make_temp_test_dir("sib_a");
        let sibling = make_temp_test_dir("sib_b");

        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        let sibling_str = sibling.canonicalize().unwrap().to_string_lossy().to_string();

        let result = ensure_repo_in_project_root(&sibling_str, &root_str);
        assert!(
            result.is_err(),
            "expected a genuinely-outside sibling directory to be rejected"
        );
        assert!(result.unwrap_err().contains("outside project root"));

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&sibling).ok();
        eprintln!("ensure_repo_in_project_root_rejects_sibling_directory_outside_root PASSED");
    }

    /// A '..'-escape attempt (mixed with a forward-slash-joined verbatim
    /// base, the most bug-relevant realistic shape) must still resolve to a
    /// location outside the root and be rejected — canonicalize() following
    /// the real filesystem means this holds regardless of whether '..' is
    /// processed before or after separator normalization.
    #[test]
    fn ensure_repo_in_project_root_rejects_dotdot_escape() {
        let root = make_temp_test_dir("dotdot_root");
        let inner = root.join("inner");
        std::fs::create_dir_all(&inner).unwrap();

        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        let inner_verbatim = inner.canonicalize().unwrap().to_string_lossy().to_string();

        // Verbatim base + forward-slash-joined '..' traversal back out past
        // the project root entirely (root's own parent, i.e. the system temp
        // dir) — guaranteed outside root_str.
        let escape = format!("{}/../../", inner_verbatim);
        let result = ensure_repo_in_project_root(&escape, &root_str);
        assert!(
            result.is_err(),
            "expected a '..' escape to be rejected, got: {:?}",
            result
        );

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_repo_in_project_root_rejects_dotdot_escape PASSED");
    }

    /// A sibling directory whose name merely starts with the project root's
    /// name (e.g. 'qa-project-evil' vs 'qa-project') must NOT pass — locks in
    /// that the check is component-wise (Path::starts_with), never a naive
    /// string-prefix comparison, which normalize_separators must not change.
    #[test]
    fn ensure_repo_in_project_root_rejects_name_prefix_sibling() {
        let parent = make_temp_test_dir("prefix_parent");
        let root = parent.join("qa-project");
        let sibling = parent.join("qa-project-evil");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();

        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        let sibling_str = sibling.canonicalize().unwrap().to_string_lossy().to_string();

        let result = ensure_repo_in_project_root(&sibling_str, &root_str);
        assert!(
            result.is_err(),
            "expected name-prefix sibling 'qa-project-evil' to be rejected against root 'qa-project', got: {:?}",
            result
        );

        std::fs::remove_dir_all(&parent).ok();
        eprintln!("ensure_repo_in_project_root_rejects_name_prefix_sibling PASSED");
    }

    // ── 2026-08-12 fix: `\\?\` mismatch silently defeating the
    //    not-yet-existing-target fast path ──────────────────────────────
    //
    // Real repro: a freshly-registered project's `.lazy/orchestrators.json`
    // — never created yet — was rejected as "outside every registered
    // project root", even though it is lexically and actually inside the
    // root. Root cause: `root_key` (derived from re-canonicalizing the
    // root) always carried Windows' `\\?\` verbatim prefix, while `t` (the
    // candidate, built from an ALREADY verbatim-stripped `repo_path`) never
    // did — so the ONLY code path that can ever accept a non-existent
    // target (candidate.canonicalize() fails by definition) could never
    // match. Invisible for an EXISTING target because that case instead
    // falls through to a canonicalize-both-sides comparison, where the same
    // prefix got added back on BOTH sides and canceled out.

    /// A path under a registered root whose FILE does not exist yet (the
    /// exact shape of a fresh project's never-created `.lazy/*.json`) must
    /// be accepted — not treated as a security violation. The containing
    /// directory (`.lazy`) is deliberately NOT created either, so this also
    /// covers a not-yet-existing intermediate directory, not just a
    /// not-yet-existing leaf file.
    #[test]
    fn ensure_repo_in_project_root_accepts_nonexistent_file_under_registered_root() {
        let root = make_temp_test_dir("nonexistent_ok");
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();

        let never_created = format!("{}\\.lazy\\orchestrators.json", root_str);
        assert!(
            !std::path::Path::new(&never_created).exists(),
            "test precondition: the target must not exist on disk"
        );

        let result = ensure_repo_in_project_root(&never_created, &root_str);
        assert!(
            result.is_ok(),
            "a not-yet-created file lexically inside a registered root must be accepted, got: {:?}",
            result
        );

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_repo_in_project_root_accepts_nonexistent_file_under_registered_root PASSED");
    }

    /// Same shape as the live repro verbatim: BOTH the registered root and
    /// the not-yet-existing candidate are `\\?\`-prefixed (exactly what
    /// `project_register_inner`'s `std::fs::canonicalize()` output and a
    /// caller building `{root}\.lazy\orchestrators.json` off of it actually
    /// produce) — locks in that the comparison normalizes the verbatim
    /// prefix on BOTH sides, not just one.
    #[test]
    fn ensure_repo_in_project_root_accepts_verbatim_prefixed_nonexistent_path() {
        let root = make_temp_test_dir("nonexistent_verbatim_ok");
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        assert!(
            root_str.starts_with(r"\\?\"),
            "sanity: canonicalize() must yield a verbatim path on Windows, got {}",
            root_str
        );

        // repo_path itself carries \\?\ too — the real orchestratorState.ts
        // repro path shape (get_project_root()'s own verbatim output, a
        // suffix joined on directly).
        let never_created = format!("{}\\.lazy\\orchestrators.json", root_str);
        assert!(never_created.starts_with(r"\\?\"));
        assert!(!std::path::Path::new(&never_created).exists());

        let result = ensure_repo_in_project_root(&never_created, &root_str);
        assert!(
            result.is_ok(),
            "a \\\\?\\-prefixed not-yet-created path under a \\\\?\\-prefixed registered root must be accepted, got: {:?}",
            result
        );

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_repo_in_project_root_accepts_verbatim_prefixed_nonexistent_path PASSED");
    }

    /// A genuinely out-of-root path that ALSO happens not to exist must
    /// still be denied — the not-yet-existing-target acceptance above must
    /// never widen into "anything that doesn't exist is fine". Locks in
    /// that the fix does not weaken the security boundary.
    #[test]
    fn ensure_repo_in_project_root_rejects_nonexistent_path_outside_root() {
        let root = make_temp_test_dir("nonexistent_reject_root");
        let sibling = make_temp_test_dir("nonexistent_reject_sibling");
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        let sibling_str = sibling.canonicalize().unwrap().to_string_lossy().to_string();

        let never_created_outside = format!("{}\\never-created.json", sibling_str);
        assert!(!std::path::Path::new(&never_created_outside).exists());

        let result = ensure_repo_in_project_root(&never_created_outside, &root_str);
        assert!(
            result.is_err(),
            "a not-yet-existing path OUTSIDE the registered root must still be denied, got: {:?}",
            result
        );

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&sibling).ok();
        eprintln!("ensure_repo_in_project_root_rejects_nonexistent_path_outside_root PASSED");
    }

    // ── ensure_repo_in_project_roots (multi-project allowlist, T0.7) ────

    /// A path under the SECOND registered root (not roots[0]) must be
    /// accepted — the core "any open root, not just the active one" gate
    /// spec section 5.1 requires once more than one project can be open.
    #[test]
    fn ensure_repo_in_project_roots_accepts_the_second_registered_root() {
        let root_a = make_temp_test_dir("multi_root_a");
        let root_b = make_temp_test_dir("multi_root_b");
        let root_a_str = root_a.canonicalize().unwrap().to_string_lossy().to_string();
        let root_b_str = root_b.canonicalize().unwrap().to_string_lossy().to_string();

        let roots = vec![root_a_str.clone(), root_b_str.clone()];
        let result = ensure_repo_in_project_roots(&root_b_str, &roots);
        assert!(result.is_ok(), "path under the second registered root must be accepted, got: {:?}", result);

        std::fs::remove_dir_all(&root_a).ok();
        std::fs::remove_dir_all(&root_b).ok();
        eprintln!("ensure_repo_in_project_roots_accepts_the_second_registered_root PASSED");
    }

    /// A sibling directory that is not among ANY registered root must still
    /// be denied — adding multi-root support must not weaken the
    /// containment check itself.
    #[test]
    fn ensure_repo_in_project_roots_rejects_an_unregistered_sibling() {
        let root_a = make_temp_test_dir("multi_sib_a");
        let sibling = make_temp_test_dir("multi_sib_b");
        let root_a_str = root_a.canonicalize().unwrap().to_string_lossy().to_string();
        let sibling_str = sibling.canonicalize().unwrap().to_string_lossy().to_string();

        let roots = vec![root_a_str];
        let result = ensure_repo_in_project_roots(&sibling_str, &roots);
        assert!(result.is_err(), "a directory outside every registered root must be denied");

        std::fs::remove_dir_all(&root_a).ok();
        std::fs::remove_dir_all(&sibling).ok();
        eprintln!("ensure_repo_in_project_roots_rejects_an_unregistered_sibling PASSED");
    }

    /// Same verbatim + forward-slash-joined shape as
    /// `ensure_repo_in_project_root_accepts_forward_slash_joined_verbatim_subpath`
    /// above, proven through the multi-root entry point too.
    #[test]
    fn ensure_repo_in_project_roots_accepts_verbatim_prefixed_subpath() {
        let root = make_temp_test_dir("multi_verbatim_root");
        std::fs::create_dir_all(root.join(".lazy")).unwrap();
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        assert!(root_str.starts_with(r"\\?\"), "sanity: canonicalize() must yield a verbatim path on Windows");

        let mixed = format!("{}/.lazy", root_str);
        let roots = vec![root_str.clone()];
        let result = ensure_repo_in_project_roots(&mixed, &roots);
        assert!(result.is_ok(), "a \\\\?\\-prefixed root's own subpath must still be accepted, got: {:?}", result);

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_repo_in_project_roots_accepts_verbatim_prefixed_subpath PASSED");
    }

    #[test]
    fn ensure_repo_in_project_roots_rejects_when_no_roots_registered() {
        let result = ensure_repo_in_project_roots(r"C:\anything", &[]);
        assert!(result.is_err(), "an empty allowlist must deny everything, not fail open");
        eprintln!("ensure_repo_in_project_roots_rejects_when_no_roots_registered PASSED");
    }

    /// End-to-end shape of the live repro (2026-08-12, `orchestratorState.ts`
    /// load right after a fresh `open_project`): the freshly-registered
    /// project is ONE of SEVERAL currently-registered roots, and its own
    /// `.lazy/orchestrators.json` has never been created. Before the fix
    /// this failed with "access denied: '...' is outside every registered
    /// project root (N checked) — last error: path canonicalize failed for
    /// '...': ... (os error 3)" even though the path is genuinely inside the
    /// one root that matters.
    #[test]
    fn ensure_repo_in_project_roots_accepts_nonexistent_orchestrators_json_among_several_roots() {
        let other_a = make_temp_test_dir("multi_fresh_other_a");
        let other_b = make_temp_test_dir("multi_fresh_other_b");
        let fresh = make_temp_test_dir("multi_fresh_project");
        let other_a_str = other_a.canonicalize().unwrap().to_string_lossy().to_string();
        let other_b_str = other_b.canonicalize().unwrap().to_string_lossy().to_string();
        let fresh_str = fresh.canonicalize().unwrap().to_string_lossy().to_string();

        let never_created = format!("{}\\.lazy\\orchestrators.json", fresh_str);
        assert!(!std::path::Path::new(&never_created).exists());

        let roots = vec![other_a_str.clone(), other_b_str.clone(), fresh_str.clone()];
        let result = ensure_repo_in_project_roots(&never_created, &roots);
        assert!(
            result.is_ok(),
            "a not-yet-created .lazy/orchestrators.json under the LAST of several registered roots must be accepted, got: {:?}",
            result
        );

        std::fs::remove_dir_all(&other_a).ok();
        std::fs::remove_dir_all(&other_b).ok();
        std::fs::remove_dir_all(&fresh).ok();
        eprintln!("ensure_repo_in_project_roots_accepts_nonexistent_orchestrators_json_among_several_roots PASSED");
    }

    // ── project_id_for_root (stable multi-project ids, T0.7) ────────────

    #[test]
    fn project_id_for_root_is_a_40_char_hex_sha1_digest() {
        let id = project_id_for_root(r"C:\Users\dev\proj");
        assert_eq!(id.len(), 40, "must be a hex SHA-1 digest (40 hex chars), got {} chars: {}", id.len(), id);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()), "must be hex-only, got: {}", id);
        eprintln!("project_id_for_root_is_a_40_char_hex_sha1_digest PASSED");
    }

    #[test]
    fn project_id_for_root_is_stable_across_verbatim_prefix_and_trailing_separator() {
        let plain = project_id_for_root(r"C:\Users\dev\proj");
        let verbatim = project_id_for_root(r"\\?\C:\Users\dev\proj");
        let trailing_sep = project_id_for_root(r"C:\Users\dev\proj\");

        assert_eq!(plain, verbatim, "a \\\\?\\-prefixed and a plain form of the same root must hash identically");
        assert_eq!(plain, trailing_sep, "a trailing separator must not change the id");
        eprintln!("project_id_for_root_is_stable_across_verbatim_prefix_and_trailing_separator PASSED");
    }

    #[test]
    fn project_id_for_root_is_stable_across_drive_letter_case() {
        let upper = project_id_for_root(r"C:\Users\dev\proj");
        let lower = project_id_for_root(r"c:\Users\dev\proj");
        assert_eq!(upper, lower, "drive-letter casing must not change the id");
        eprintln!("project_id_for_root_is_stable_across_drive_letter_case PASSED");
    }

    #[test]
    fn project_id_for_root_differs_for_different_roots() {
        let a = project_id_for_root(r"C:\Users\dev\proj-a");
        let b = project_id_for_root(r"C:\Users\dev\proj-b");
        assert_ne!(a, b, "distinct roots must not collide");
        eprintln!("project_id_for_root_differs_for_different_roots PASSED");
    }

    // ── strip_verbatim_prefix ───────────────────────────────────────

    #[test]
    fn strip_verbatim_prefix_removes_standard_prefix() {
        assert_eq!(strip_verbatim_prefix(r"\\?\C:\Users\a\b"), r"C:\Users\a\b");
        eprintln!("strip_verbatim_prefix_removes_standard_prefix PASSED");
    }

    #[test]
    fn strip_verbatim_prefix_removes_unc_prefix() {
        assert_eq!(strip_verbatim_prefix(r"\\?\UNC\server\share\a"), r"\\server\share\a");
        eprintln!("strip_verbatim_prefix_removes_unc_prefix PASSED");
    }

    #[test]
    fn strip_verbatim_prefix_is_noop_for_plain_windows_path() {
        assert_eq!(strip_verbatim_prefix(r"C:\Users\a\b"), r"C:\Users\a\b");
        eprintln!("strip_verbatim_prefix_is_noop_for_plain_windows_path PASSED");
    }

    #[test]
    fn strip_verbatim_prefix_is_noop_for_posix_path() {
        assert_eq!(strip_verbatim_prefix("/home/a/b"), "/home/a/b");
        eprintln!("strip_verbatim_prefix_is_noop_for_posix_path PASSED");
    }

    // ── normalize_for_git (2026-08-05, os error 267 incident) ───────

    /// THE bug shape: a verbatim path with a stray '/' mixed in (exactly
    /// what runtime.ts's un-normalized `mergeIntoDir` can produce) must come
    /// out fully backslash-only and verbatim-prefix-free — mirrors
    /// paths.ts's `normalizeRepoPathForGit` test of the same name/input
    /// (mergeWorktreePathNormalization.test.ts).
    #[test]
    fn normalize_for_git_strips_verbatim_prefix_and_fixes_mixed_separators() {
        let mixed = r"\\?\C:\Users\user\demo-shop".to_string() + "/sub/dir";
        assert_eq!(normalize_for_git(&mixed), r"C:\Users\user\demo-shop\sub\dir");
        eprintln!("normalize_for_git_strips_verbatim_prefix_and_fixes_mixed_separators PASSED");
    }

    /// An already-clean verbatim path (no stray '/') must lose only the
    /// prefix — the shape every currently-passing verbatim regression test
    /// in git.rs/worktree_cleanup.rs already exercises, so this locks in
    /// that normalize_for_git does not change behavior for that case.
    #[test]
    fn normalize_for_git_leaves_a_clean_verbatim_path_just_unprefixed() {
        assert_eq!(normalize_for_git(r"\\?\C:\Users\user\demo-shop"), r"C:\Users\user\demo-shop");
        eprintln!("normalize_for_git_leaves_a_clean_verbatim_path_just_unprefixed PASSED");
    }

    /// A plain (non-verbatim) Windows path must pass through unchanged.
    #[test]
    fn normalize_for_git_is_noop_for_plain_windows_path() {
        assert_eq!(normalize_for_git(r"C:\Users\user\demo-shop"), r"C:\Users\user\demo-shop");
        eprintln!("normalize_for_git_is_noop_for_plain_windows_path PASSED");
    }

    /// A POSIX path (dev/CI on mac/linux) must pass through unchanged —
    /// normalize_separators is itself a no-op off Windows.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn normalize_for_git_is_noop_for_posix_path() {
        assert_eq!(normalize_for_git("/home/dev/demo-shop"), "/home/dev/demo-shop");
        eprintln!("normalize_for_git_is_noop_for_posix_path PASSED");
    }

    /// A verbatim UNC path (`\\?\UNC\server\share\...`) with a mixed
    /// separator must reconstruct to a plain UNC path (`\\server\share\...`),
    /// not a mangled one — the same UNC reconstruction
    /// strip_verbatim_prefix_removes_unc_prefix already covers alone, now
    /// through the combined helper.
    #[test]
    fn normalize_for_git_handles_mixed_separator_unc_path() {
        let mixed = r"\\?\UNC\server\share".to_string() + "/sub/dir";
        assert_eq!(normalize_for_git(&mixed), r"\\server\share\sub\dir");
        eprintln!("normalize_for_git_handles_mixed_separator_unc_path PASSED");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn stable_path_key_collapses_windows_path_aliases() {
        let a = stable_path_key(r"C:\Users\user\demo-shop");
        let b = stable_path_key("C:/Users/user/demo-shop");
        let c = stable_path_key(r"\\?\C:\Users\user\demo-shop");
        let d = stable_path_key(r"c:\users\david\demo-shop");
        let e = stable_path_key(r"C:\Users\user\demo-shop\");
        assert_eq!(a, b, "backslash vs forward slash");
        assert_eq!(a, c, "verbatim \\\\?\\ prefix");
        assert_eq!(a, d, "drive-letter case");
        assert_eq!(a, e, "trailing separator");
        eprintln!("stable_path_key_collapses_windows_path_aliases PASSED ({a})");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn stable_path_key_is_stable_for_posix_paths() {
        assert_eq!(stable_path_key("/home/dev/demo-shop"), "/home/dev/demo-shop");
        assert_eq!(stable_path_key("/home/dev/demo-shop/"), "/home/dev/demo-shop");
        eprintln!("stable_path_key_is_stable_for_posix_paths PASSED");
    }

    // ── is_within_agent_worktrees_dir ───────────────────────────────

    #[test]
    fn is_within_agent_worktrees_dir_accepts_a_direct_child() {
        assert!(is_within_agent_worktrees_dir(
            r"C:\proj",
            r"C:\proj\.lazy\worktrees\agent-m1",
        ));
        eprintln!("is_within_agent_worktrees_dir_accepts_a_direct_child PASSED");
    }

    #[test]
    fn is_within_agent_worktrees_dir_accepts_verbatim_repo_and_target() {
        assert!(is_within_agent_worktrees_dir(
            r"\\?\C:\proj",
            r"\\?\C:\proj\.lazy\worktrees\agent-m1",
        ));
        eprintln!("is_within_agent_worktrees_dir_accepts_verbatim_repo_and_target PASSED");
    }

    #[test]
    fn is_within_agent_worktrees_dir_accepts_mixed_verbatim_repo_plain_target() {
        // Real-app shape: repo_path from get_project_root (verbatim), target
        // computed independently (e.g. by a test or a future caller) without
        // the prefix — both sides must still normalize to the same thing.
        assert!(is_within_agent_worktrees_dir(
            r"\\?\C:\proj",
            r"C:\proj\.lazy\worktrees\agent-m1",
        ));
        eprintln!("is_within_agent_worktrees_dir_accepts_mixed_verbatim_repo_plain_target PASSED");
    }

    #[test]
    fn is_within_agent_worktrees_dir_rejects_the_worktrees_dir_itself() {
        assert!(!is_within_agent_worktrees_dir(r"C:\proj", r"C:\proj\.lazy\worktrees"));
        eprintln!("is_within_agent_worktrees_dir_rejects_the_worktrees_dir_itself PASSED");
    }

    #[test]
    fn is_within_agent_worktrees_dir_rejects_main_project_checkout() {
        assert!(!is_within_agent_worktrees_dir(r"C:\proj", r"C:\proj"));
        eprintln!("is_within_agent_worktrees_dir_rejects_main_project_checkout PASSED");
    }

    #[test]
    fn is_within_agent_worktrees_dir_rejects_outside_sibling() {
        assert!(!is_within_agent_worktrees_dir(r"C:\proj", r"C:\other\.lazy\worktrees\x"));
        eprintln!("is_within_agent_worktrees_dir_rejects_outside_sibling PASSED");
    }

    #[test]
    fn is_within_agent_worktrees_dir_rejects_prefix_sibling_directory() {
        // 'proj-evil' merely starts with 'proj' — must not match component-wise.
        assert!(!is_within_agent_worktrees_dir(r"C:\proj", r"C:\proj-evil\.lazy\worktrees\x"));
        eprintln!("is_within_agent_worktrees_dir_rejects_prefix_sibling_directory PASSED");
    }

    #[test]
    fn is_within_agent_worktrees_dir_rejects_dotdot_traversal() {
        assert!(!is_within_agent_worktrees_dir(
            r"C:\proj",
            r"C:\proj\.lazy\worktrees\..\..\Windows",
        ));
        eprintln!("is_within_agent_worktrees_dir_rejects_dotdot_traversal PASSED");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn is_within_agent_worktrees_dir_is_case_insensitive_on_windows() {
        assert!(is_within_agent_worktrees_dir(
            r"C:\Proj",
            r"c:\proj\.LAZY\WORKTREES\agent-m1",
        ));
        eprintln!("is_within_agent_worktrees_dir_is_case_insensitive_on_windows PASSED");
    }

    // ── is_within_any_project_worktrees_dir ─────────────────────────

    #[test]
    fn is_within_any_project_worktrees_dir_accepts_a_worktree_of_the_second_root() {
        let roots = vec![r"C:\proj-a".to_string(), r"C:\proj-b".to_string()];
        assert!(is_within_any_project_worktrees_dir(
            r"C:\proj-b\.lazy\worktrees\agent-m1",
            &roots,
        ));
        eprintln!("is_within_any_project_worktrees_dir_accepts_a_worktree_of_the_second_root PASSED");
    }

    #[test]
    fn is_within_any_project_worktrees_dir_rejects_a_root_that_is_not_registered() {
        let roots = vec![r"C:\proj-a".to_string()];
        assert!(!is_within_any_project_worktrees_dir(
            r"C:\proj-unregistered\.lazy\worktrees\agent-m1",
            &roots,
        ));
        eprintln!("is_within_any_project_worktrees_dir_rejects_a_root_that_is_not_registered PASSED");
    }

    #[test]
    fn is_within_any_project_worktrees_dir_rejects_the_project_root_itself() {
        let roots = vec![r"C:\proj-a".to_string()];
        assert!(!is_within_any_project_worktrees_dir(r"C:\proj-a", &roots));
        eprintln!("is_within_any_project_worktrees_dir_rejects_the_project_root_itself PASSED");
    }

    #[test]
    fn is_within_any_project_worktrees_dir_rejects_empty_roots() {
        let roots: Vec<String> = vec![];
        assert!(!is_within_any_project_worktrees_dir(
            r"C:\anywhere\.lazy\worktrees\agent-m1",
            &roots,
        ));
        eprintln!("is_within_any_project_worktrees_dir_rejects_empty_roots PASSED");
    }

    // ── BoundedGate ────────────────────────────────────────────────

    /// Single-threaded roundtrip: releasing the only permit must free a
    /// slot for the very next `acquire()` — proves `release()` actually
    /// decrements (a broken release would deadlock this call forever, since
    /// nothing else is present to notify the waiting thread).
    #[test]
    fn bounded_gate_release_frees_a_slot_for_the_next_acquire() {
        let gate = BoundedGate::new(1);
        let permit = gate.acquire();
        drop(permit);
        let _permit2 = gate.acquire();
        eprintln!("bounded_gate_release_frees_a_slot_for_the_next_acquire PASSED");
    }

    /// Concurrency smoke test: 6 threads all wait on a capacity-2 gate; the
    /// number of permits observed concurrently held must never exceed 2, and
    /// every thread must eventually complete (a hang here means acquire/
    /// release/notify is broken).
    #[test]
    fn bounded_gate_bounds_concurrent_permits() {
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;

        let gate = Arc::new(BoundedGate::new(2));
        let current = Arc::new(AtomicU32::new(0));
        let max_seen = Arc::new(AtomicU32::new(0));

        let handles: Vec<_> = (0..6)
            .map(|_| {
                let gate = Arc::clone(&gate);
                let current = Arc::clone(&current);
                let max_seen = Arc::clone(&max_seen);
                std::thread::spawn(move || {
                    let _permit = gate.acquire();
                    let now = current.fetch_add(1, Ordering::SeqCst) + 1;
                    max_seen.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(30));
                    current.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();

        for h in handles {
            h.join().expect("BoundedGate worker thread panicked");
        }

        let seen = max_seen.load(Ordering::SeqCst);
        assert!(
            seen >= 1 && seen <= 2,
            "expected between 1 and capacity (2) concurrent permits, saw {}",
            seen
        );
        eprintln!("bounded_gate_bounds_concurrent_permits PASSED (max_seen={})", seen);
    }

    /// Poison recovery: panicking while the internal Mutex is locked (the
    /// narrow window acquire()/release() themselves use — NOT the same as a
    /// caller panicking while merely holding a permit, since the internal
    /// lock isn't held for the permit's whole lifetime) must not
    /// permanently wedge the gate shut. `acquire()` must still succeed
    /// (recovering the poisoned guard) instead of hanging or erroring.
    #[test]
    fn bounded_gate_acquire_recovers_from_a_poisoned_internal_mutex() {
        let gate = BoundedGate::new(2);

        let gate_ref = &gate;
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = gate_ref.count.lock().unwrap();
            panic!("simulated panic while holding BoundedGate's internal lock");
        }));
        assert!(panicked.is_err(), "test precondition: the panic must have happened");
        assert!(gate.count.is_poisoned(), "test precondition: the mutex must now be poisoned");

        // Despite the poisoned mutex, acquire() must recover and correctly
        // bound capacity afterward (a 3rd acquire would block forever if
        // release() also failed to recover from the poison).
        let p1 = gate.acquire();
        let p2 = gate.acquire();
        drop(p1);
        drop(p2);
        let _p3 = gate.acquire();
        eprintln!("bounded_gate_acquire_recovers_from_a_poisoned_internal_mutex PASSED");
    }

    /// `try_acquire()` must succeed immediately while under capacity — the
    /// common case (agent_run's mission cap has room).
    #[test]
    fn bounded_gate_try_acquire_succeeds_under_capacity() {
        let gate = BoundedGate::new(2);
        let p1 = gate.try_acquire();
        assert!(p1.is_some(), "first try_acquire under capacity 2 must succeed");
        let p2 = gate.try_acquire();
        assert!(p2.is_some(), "second try_acquire under capacity 2 must succeed");
        eprintln!("bounded_gate_try_acquire_succeeds_under_capacity PASSED");
    }

    /// `try_acquire()` must return `None` (never block) once the gate is at
    /// capacity — this is the whole point of the method: agent_run's
    /// mission-limit rejection depends on this returning immediately instead
    /// of hanging until a slot frees.
    #[test]
    fn bounded_gate_try_acquire_returns_none_at_capacity() {
        let gate = BoundedGate::new(1);
        let _permit = gate.try_acquire().expect("first acquire must succeed");
        let rejected = gate.try_acquire();
        assert!(rejected.is_none(), "try_acquire at capacity must return None, not block");
        eprintln!("bounded_gate_try_acquire_returns_none_at_capacity PASSED");
    }

    /// Dropping a permit taken via `try_acquire()` must free its slot for a
    /// subsequent `try_acquire()`, exactly like `acquire()`'s permit —
    /// both share the same `BoundedGatePermit`/`release()` path.
    #[test]
    fn bounded_gate_try_acquire_permit_release_frees_a_slot() {
        let gate = BoundedGate::new(1);
        let permit = gate.try_acquire().expect("first acquire must succeed");
        assert!(gate.try_acquire().is_none(), "must be at capacity while permit is held");
        drop(permit);
        assert!(gate.try_acquire().is_some(), "slot must be free again after drop");
        eprintln!("bounded_gate_try_acquire_permit_release_frees_a_slot PASSED");
    }

    // ── Abandoned drain-thread counter ───────────────────────────────

    /// `record_abandoned_drain_thread` must increment the counter that
    /// `abandoned_drain_thread_count` reports — this is the only contract
    /// shell.rs/test_runner.rs's detach-without-join paths rely on. Uses a
    /// relative delta (not an absolute value) since this is a shared
    /// process-lifetime static and other tests may run concurrently.
    #[test]
    fn record_abandoned_drain_thread_increments_the_counter() {
        // `>=` rather than `==`: ABANDONED_DRAIN_THREADS is a single
        // process-wide static, and cargo test runs tests in parallel by
        // default — a sibling test exercising the same counter (e.g.
        // join_drain_thread_bounded_abandons_and_records_when_thread_outlives_bound)
        // can legitimately add to it between `before` and `after`. What
        // must hold regardless of test interleaving is that OUR two
        // records advanced it by at least 2.
        let before = abandoned_drain_thread_count();
        record_abandoned_drain_thread();
        record_abandoned_drain_thread();
        let after = abandoned_drain_thread_count();
        assert!(after >= before + 2, "two records must advance the counter by at least 2 (before={}, after={})", before, after);
        eprintln!("record_abandoned_drain_thread_increments_the_counter PASSED (before={}, after={})", before, after);
    }

    // ── join_drain_thread_bounded ────────────────────────────────────

    /// The common case: a thread that finishes well within the bound must
    /// be joined normally and its value returned.
    #[test]
    fn join_drain_thread_bounded_returns_value_when_thread_finishes_in_time() {
        let handle = std::thread::spawn(|| 42u32);
        let result = join_drain_thread_bounded(handle, std::time::Duration::from_millis(500));
        assert_eq!(result, Some(42));
        eprintln!("join_drain_thread_bounded_returns_value_when_thread_finishes_in_time PASSED");
    }

    /// The pathological case (mirrors a drain thread stuck on a grandchild-
    /// held pipe): a thread that outlives the bound must be abandoned
    /// (`None`, not a block) and the abandonment must be recorded exactly
    /// once. The spawned thread sleeps only 300ms (not forever) so this test
    /// itself cannot hang the suite.
    #[test]
    fn join_drain_thread_bounded_abandons_and_records_when_thread_outlives_bound() {
        // `>=` rather than `==` — see record_abandoned_drain_thread_increments_the_counter's
        // comment: ABANDONED_DRAIN_THREADS is a shared process-wide static,
        // and a sibling test running concurrently can legitimately add to it
        // between `before` and `after`. What must hold regardless of test
        // interleaving is that THIS abandonment advanced it by at least 1.
        let before = abandoned_drain_thread_count();
        let handle = std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(300));
            7u32
        });
        let result = join_drain_thread_bounded(handle, std::time::Duration::from_millis(30));
        assert_eq!(result, None, "must abandon (return None) when the thread outlives the bound");
        let after = abandoned_drain_thread_count();
        assert!(after >= before + 1, "abandonment must be recorded (before={}, after={})", before, after);
        eprintln!("join_drain_thread_bounded_abandons_and_records_when_thread_outlives_bound PASSED");
    }
}
