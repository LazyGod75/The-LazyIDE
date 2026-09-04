//! Filesystem commands (read/write/rename/remove/create) and the
//! project-path jailing helpers that keep every fs operation confined to the
//! active project root.

use std::fs;
use std::io::{Read, Write};

use serde::{Deserialize, Serialize};

use crate::commands::util::{normalize_separators, strip_verbatim_prefix};
use crate::state::{ProjectRegistry, ProjectState};

#[derive(Serialize, Deserialize, Debug)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub kind: String, // "file" | "dir"
}

/// List immediate children of a directory.
#[tauri::command]
pub(crate) fn read_dir(path: String, project_registry: tauri::State<ProjectRegistry>) -> Result<Vec<DirEntry>, String> {
    let safe_path = ensure_path_in_any_open_project(&path, &project_registry)?;
    let entries = fs::read_dir(&safe_path)
        .map_err(|e| format!("read_dir failed for '{}': {}", safe_path.display(), e))?;

    let mut result: Vec<DirEntry> = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("entry error: {}", e))?;
        let meta = entry
            .metadata()
            .map_err(|e| format!("metadata error: {}", e))?;

        let name = entry.file_name().to_string_lossy().into_owned();
        let full_path = entry.path().to_string_lossy().into_owned();
        let kind = if meta.is_dir() {
            "dir".to_string()
        } else {
            "file".to_string()
        };

        result.push(DirEntry {
            name,
            path: full_path,
            kind,
        });
    }

    result.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(result)
}

/// Return the current project root (set via set_project, or cwd on first run).
#[tauri::command]
pub(crate) fn get_project_root(state: tauri::State<ProjectState>) -> Result<String, String> {
    state.0.lock()
        .map(|g| g.clone())
        .map_err(|e| format!("project state lock failed: {}", e))
}

/// Return the current working directory as a fallback project root.
#[tauri::command]
pub(crate) fn get_cwd() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("get_cwd failed: {}", e))
}

/// Walk up from cwd to find the nearest directory containing a .git folder.
/// Returns the git repo root, or the cwd if none found.
#[tauri::command]
pub(crate) fn find_git_root() -> Result<String, String> {
    let mut dir = std::env::current_dir()
        .map_err(|e| format!("find_git_root: cwd failed: {}", e))?;
    loop {
        if dir.join(".git").exists() {
            return Ok(dir.to_string_lossy().into_owned());
        }
        if !dir.pop() {
            break;
        }
    }
    // Fallback to cwd
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("find_git_root: cwd fallback failed: {}", e))
}

/// Strip Windows verbatim path prefixes (`\\?\UNC\` or `\\?\`) and lowercase.
/// Used as a fallback containment check when `Path::starts_with` fails due to prefix differences.
fn strip_verbatim(p: &str) -> String {
    let s = if p.starts_with(r"\\?\UNC\") {
        &p[8..]
    } else if p.starts_with(r"\\?\") {
        &p[4..]
    } else {
        p
    };
    s.to_lowercase()
}

/// Strips a Windows verbatim (`\\?\` / `\\?\UNC\`) prefix from `p` before a
/// `.canonicalize()` call, mimicking the `dunce` crate's `simplified()`
/// (`dunce` is not a Cargo dependency here — see Cargo.toml — so this
/// delegates to `util::strip_verbatim_prefix` rather than re-implementing
/// the same prefix-stripping logic a third time in this file; contrast
/// `strip_verbatim` above, which ALSO lowercases for the comparison-only
/// fallback in `path_is_within` and is therefore not reusable for this).
///
/// ROOT CAUSE this fixes (real-app QA, worktree agent mission): a
/// `\\?\`-prefixed ("verbatim"/extended-length) path disables Win32's
/// automatic path parsing, INCLUDING resolution of `.` (this directory) and
/// `..` (parent directory) components — they are sent to the filesystem as
/// literal, nonexistent path segments instead of being collapsed. Every
/// project/worktree root in this codebase is verbatim on Windows
/// (`std::fs::canonicalize()`'s own return value — see `set_project` in
/// commands/brain/config.rs and `agent_create_worktree_inner` in
/// commands/git.rs) and flows back from the frontend as the root a relative
/// tool-call path is resolved against (toolRuntime.ts's `resolvePath`). A
/// candidate of "." — what a managed agent emits to mean "list the project
/// root" — becomes `<verbatim root>\.`, which `Path::canonicalize()` cannot
/// open: the leading `\\?\` makes Rust's std take an "already verbatim,
/// pass it straight through" fast path internally, skipping the lexical
/// `.`/`..` normalization a plain (non-verbatim) path would get. This is
/// the confirmed mechanism behind the real-app failure
/// `read_dir: {"path":"."}` -> "ERROR: path canonicalize failed for
/// '\\?\C:\...\agent-M18-...'" (and identically for find_file/glob, which
/// resolve the same way through `resolvePath`).
///
/// Stripping the prefix before `.canonicalize()` restores normal parsing so
/// `.`/`..` resolve correctly. `canonicalize()`'s OWN return value is still
/// verbatim afterward regardless (a Windows API behavior — `GetFinalPathNameByHandleW`
/// always returns the `\\?\` form — not something this helper needs to
/// prevent); downstream containment checks already tolerate that via
/// `path_is_within`'s stripped-prefix fallback below. Also safe for
/// genuinely long paths: if the resolved absolute path still exceeds the
/// short-path threshold, Rust's std re-applies the verbatim prefix
/// internally before the actual Win32 call, so this never reintroduces the
/// "Filename too long" failures `agent_create_worktree_inner` already works
/// around. No-op (returns `p` unchanged) for any path that isn't
/// verbatim-prefixed, so it is safe to apply unconditionally at every
/// canonicalize call site in this file.
fn dunce_simplify(p: &str) -> String {
    strip_verbatim_prefix(p)
}

/// Returns true if `target` (canonicalized) is within or equal to `root` (canonicalized).
/// Falls back to a verbatim-prefix-stripped, case-insensitive string comparison to handle
/// the Windows quirk where `canonicalize()` may add or omit the `\\?\` extended-path prefix
/// depending on path length, causing `Path::starts_with` to return false for valid sub-paths.
fn path_is_within(target: &std::path::Path, root: &std::path::Path) -> bool {
    if target.starts_with(root) {
        return true;
    }
    // Fallback: compare string representations with verbatim prefix stripped and lowercased.
    let t = strip_verbatim(&target.to_string_lossy());
    let r = strip_verbatim(&root.to_string_lossy());
    // Ensure root is treated as a directory boundary — append separator if absent.
    let r_prefix = if r.ends_with(std::path::MAIN_SEPARATOR) {
        r.clone()
    } else {
        format!("{}{}", r, std::path::MAIN_SEPARATOR)
    };
    // target == root (exact match) or target is strictly inside root/
    t == r || t.starts_with(&r_prefix)
}

/// Resolves the effective project root — the given `root` string, or (when
/// empty, i.e. no project has been opened yet) the process cwd — normalizes
/// its separators, and canonicalizes it. Shared by ensure_path_in_project_root
/// and ensure_write_path_in_project_root so the "no project open yet"
/// fallback and the Windows separator-normalization fix (see
/// util::normalize_separators) live in exactly one place.
fn canonicalize_effective_root(root: &str) -> Result<std::path::PathBuf, String> {
    let root = if root.is_empty() {
        std::env::current_dir()
            .map_err(|e| format!("no project root set and cwd failed: {}", e))?
            .to_string_lossy()
            .into_owned()
    } else {
        root.to_string()
    };

    let normalized_root = dunce_simplify(&normalize_separators(&root));
    std::path::Path::new(&normalized_root)
        .canonicalize()
        .map_err(|e| format!("project root canonicalize failed: {}", e))
}

/// Check that a path is within the project root or a known safe directory.
/// Returns the canonicalized path if safe, or an error if outside scope.
///
/// Root-string variant — separated from ensure_path_in_project so it can be
/// unit-tested without a tauri::State (mirrors util.rs's
/// ensure_repo_in_project_root / ensure_repo_in_project split).
///
/// CRITICAL: `path` is normalized (see util::normalize_separators) before
/// canonicalize(). This is the actual fix for the missionQueue/artifacts
/// "access denied ... outside project root" bug: `path` here is what a
/// caller (e.g. TS's `${repoPath}/.lazy/artifacts`) built by joining a
/// verbatim (`\\?\`-prefixed) canonicalized repoPath with a hardcoded '/'.
/// Without normalizing first, canonicalize() on that mixed string fails
/// outright with ERROR_INVALID_NAME (confirmed empirically, OS error 123) —
/// never even reaching the containment check below.
fn ensure_path_in_project_root(path: &str, root: &str) -> Result<std::path::PathBuf, String> {
    // dunce_simplify (not just normalize_separators) is CRITICAL here: `path`
    // is frequently a relative candidate joined onto an already-verbatim
    // root (e.g. toolRuntime.ts's resolvePath(worktreePath, '.')), and a
    // verbatim string cannot have its '.'/'..' components resolved by
    // canonicalize() — see dunce_simplify's doc comment for the full
    // mechanism and the real-app bug this fixes.
    let normalized_path = dunce_simplify(&normalize_separators(path));
    let project_root = canonicalize_effective_root(root)?;

    // 2026-08-12 fix (live repro: orchestratorState.ts's read of a fresh
    // project's never-created `.lazy/orchestrators.json` — never a git/
    // agent/shell/lsp call, so util.rs's `ensure_repo_in_project_root` 2026-
    // 08-04 "accept a not-yet-existing lexically-inside path" fix never
    // covered this SEPARATE, parallel implementation backing read_file/
    // read_dir): this function used to canonicalize the FULL candidate
    // unconditionally and, on failure (the target simply does not exist
    // yet — completely normal for a fresh project's optional state file),
    // return "path canonicalize failed for '...'" — which
    // `ensure_path_in_project_roots` below then wraps as "access denied:
    // ... is outside every registered project root", a false security-
    // sounding denial for a perfectly ordinary not-yet-created file.
    //
    // Lexical fast path first (component-wise, verbatim-prefix-and-case
    // normalized via `strip_verbatim` on BOTH sides — the exact `\\?\`
    // asymmetry that defeated util.rs's own equivalent fast path before its
    // 2026-08-12 fix is avoided here from the start by using the same
    // helper for both operands), deliberately rejecting a '..' component (a
    // '..' path whose resolution happens to stay inside the project is
    // still fine — the canonicalize + `path_is_within` pass below proves it
    // once the target exists). A lexically-inside candidate that does not
    // exist yet is ACCEPTED here, returned un-canonicalized (canonicalize()
    // cannot resolve a target that isn't there) — the caller's own fs
    // operation right after this guard (fs::metadata/read_to_string/
    // read_dir) then reports its own honest, un-misleading "not found"
    // error. A lexically-inside candidate that DOES exist is additionally
    // canonicalized and re-verified, so a symlink planted inside the
    // project that resolves outside is still denied.
    let candidate = std::path::Path::new(&normalized_path);
    let has_dotdot = candidate
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir));

    if !has_dotdot {
        let root_key = strip_verbatim(&project_root.to_string_lossy());
        let root_prefix = if root_key.ends_with(std::path::MAIN_SEPARATOR) {
            root_key.clone()
        } else {
            format!("{}{}", root_key, std::path::MAIN_SEPARATOR)
        };
        let t = strip_verbatim(&normalized_path);
        if t == root_key || t.starts_with(&root_prefix) {
            match candidate.canonicalize() {
                Ok(real) => {
                    if path_is_within(&real, &project_root) {
                        return Ok(real);
                    }
                    return Err(format!(
                        "access denied: path '{}' resolves outside project root '{}'",
                        path,
                        project_root.display()
                    ));
                }
                // Target does not exist (yet) — lexically inside the
                // project, accept: the fs call right after this guard
                // reports not-found itself, honestly.
                Err(_) => return Ok(candidate.to_path_buf()),
            }
        }
    }

    // Existing-target fallback: canonicalize and compare. Covers '..' paths
    // and symlinks for targets that exist; a non-existent '..' path (or any
    // other non-existent path that failed the lexical check) is denied with
    // the same honest error as before.
    let target = candidate
        .canonicalize()
        .map_err(|e| format!("path canonicalize failed for '{}': {}", path, e))?;

    if !path_is_within(&target, &project_root) {
        return Err(format!(
            "access denied: path '{}' is outside project root '{}'",
            target.display(),
            project_root.display()
        ));
    }

    Ok(target)
}

/// Multi-root counterpart of `ensure_path_in_project_root`: validates that
/// `path` is inside ANY ONE of `roots`, not just a single root — mirrors
/// `util::ensure_repo_in_project_roots`'s try-each-root shape. Falls back to
/// `ensure_path_in_project_root`'s own "no project open yet" cwd behavior
/// (via an empty root string) ONLY when `roots` itself is empty — exactly
/// the pre-multi-root semantics for "nothing registered yet"; a single
/// non-empty root never fell back to cwd, so a single-entry `roots` list
/// does not either (byte-identical single-project behavior).
fn ensure_path_in_project_roots(path: &str, roots: &[String]) -> Result<std::path::PathBuf, String> {
    if roots.is_empty() {
        return ensure_path_in_project_root(path, "");
    }
    let mut last_err = String::new();
    for root in roots {
        match ensure_path_in_project_root(path, root) {
            Ok(p) => return Ok(p),
            Err(e) => last_err = e,
        }
    }
    Err(format!(
        "access denied: '{}' is outside every registered project root ({} checked) — last error: {}",
        path,
        roots.len(),
        last_err
    ))
}

/// Thin tauri::State wrapper around `ensure_path_in_project_roots` — the
/// multi-project counterpart of the (now removed) `ensure_path_in_project`,
/// which checked only the single legacy `ProjectState` root. A path under
/// ANY currently open project (not just the active one) is accepted — a
/// background (registered, not active) project's files must remain
/// reachable.
fn ensure_path_in_any_open_project(path: &str, registry: &tauri::State<ProjectRegistry>) -> Result<std::path::PathBuf, String> {
    let roots = registry.0.lock()
        .map_err(|e| format!("project registry lock failed: {}", e))?
        .all_roots();
    ensure_path_in_project_roots(path, &roots)
}

/// Check that a path's parent directory is within the project root.
/// Used for write operations where the target file may not exist yet.
///
/// Root-string variant — see ensure_path_in_project_root's doc comment for
/// why this is split out, and for the general fix rationale.
///
/// CRITICAL (2nd half of the same fix): `input_path` is built from the
/// *normalized* path, not the raw one. Pre-fix, `Path::exists()` on a
/// mixed-separator verbatim path always reports false (a '/' inside a
/// verbatim string names nothing real), so this function ALWAYS took this
/// "doesn't exist yet" branch for such paths — and `Path::parent()` /
/// `file_name()` on the raw (unnormalized) path then split on the wrong
/// separator, walking to the wrong (too-shallow) ancestor and failing the
/// containment check below even for a path genuinely inside the project
/// root. Normalizing first makes `.exists()` accurate again and makes
/// `.parent()` / `.file_name()` split on the intended boundary.
///
/// MULTI-LEVEL-MISSING fix (real-app QA, run-6c: managed mission's
/// `attach_proof` "access denied" on a freshly-registered scratch project):
/// this used to canonicalize the IMMEDIATE parent unconditionally, which
/// itself fails with "parent canonicalize failed" (OS error 3, "path not
/// found") whenever that parent ALSO doesn't exist yet — e.g. a brand-new
/// project's very first `.lazy/artifacts/<missionId>` write, where NEITHER
/// `.lazy` NOR `.lazy/artifacts` exists on disk yet. That failure still
/// reads as "access denied: ... outside every registered project root" once
/// the multi-root caller (`ensure_write_path_in_project_roots`) wraps it —
/// indistinguishable, from the caller's or the log's point of view, from a
/// genuine containment violation, even though the candidate was a perfectly
/// ordinary descendant of the registered root the whole time. `fs_create_dir`
/// is meant to behave like `create_dir_all` (create every missing ancestor
/// in one call) — canonicalize() requires its target to exist, so this now
/// walks UP from the target to the NEAREST ancestor that already exists
/// (`find_nearest_existing_ancestor` below), canonicalizes and
/// containment-checks THAT (existing, real) ancestor, and re-joins the
/// missing trailing segments onto it. A single missing level (the pre-fix
/// case) is unaffected: the loop still stops at the immediate parent.
fn ensure_write_path_in_project_root(path: &str, root: &str) -> Result<std::path::PathBuf, String> {
    // See ensure_path_in_project_root's comment: dunce_simplify must run
    // before ANY use of this path (not just the eventual canonicalize()
    // below) — `.exists()` a few lines down goes through the same
    // verbatim-disables-dot-resolution mechanism, so a '.'/'..'-carrying
    // candidate would misreport as "doesn't exist" without this too.
    let normalized_path = dunce_simplify(&normalize_separators(path));
    let input_path = std::path::Path::new(&normalized_path);

    // If the file already exists, canonicalize it directly.
    if input_path.exists() {
        return ensure_path_in_project_root(path, root);
    }

    let (existing_ancestor, missing_components) = find_nearest_existing_ancestor(input_path)
        .ok_or_else(|| format!("invalid path: no existing ancestor found for '{}'", path))?;

    // A '.'/'..' component can't be resolved by canonicalize() while it's
    // still part of the NOT-YET-EXISTING tail (an already-existing '..' was
    // already collapsed away by the OS during the `.exists()` walk above) —
    // reject it here rather than let `create_dir_all` later create a
    // literal, meaningless ".."-named directory or silently stand in for a
    // real escape once created. Never weakens the existing-path escape
    // check below: this only ever adds a rejection, never removes one.
    if missing_components.iter().any(|c| c.as_os_str() == "." || c.as_os_str() == "..") {
        return Err(format!(
            "access denied: '{}' contains a '.' or '..' segment that does not resolve against an existing directory",
            path
        ));
    }

    let canonical_existing = existing_ancestor.canonicalize().map_err(|e| {
        format!("ancestor canonicalize failed for '{}': {}", existing_ancestor.display(), e)
    })?;

    let project_root = canonicalize_effective_root(root)?;

    if !path_is_within(&canonical_existing, &project_root) {
        return Err(format!(
            "access denied: path '{}' is outside project root '{}'",
            path,
            project_root.display()
        ));
    }

    let mut result = canonical_existing;
    for component in missing_components.into_iter().rev() {
        result = result.join(component);
    }
    Ok(result)
}

/// Walks up from `path` to the nearest ancestor directory that already
/// exists on disk, returning that ancestor plus every trailing component
/// popped off along the way (in "closest to `path`" order — i.e. reversed
/// relative to the final path, since each is pushed as we walk upward).
/// Returns `None` only if `path` has no parent at all (already at a root),
/// which should never happen for a real absolute path rooted under an
/// existing project.
fn find_nearest_existing_ancestor(
    path: &std::path::Path,
) -> Option<(std::path::PathBuf, Vec<std::ffi::OsString>)> {
    let mut missing = Vec::new();
    let mut cursor = path;
    loop {
        if cursor.exists() {
            return Some((cursor.to_path_buf(), missing));
        }
        let name = cursor.file_name()?;
        missing.push(name.to_os_string());
        cursor = cursor.parent()?;
    }
}

/// Multi-root counterpart of `ensure_write_path_in_project_root` — see
/// `ensure_path_in_project_roots`'s doc comment above for the shared
/// try-each-root / empty-roots-falls-back-to-cwd rationale (identical here,
/// just for the write-path variant).
fn ensure_write_path_in_project_roots(path: &str, roots: &[String]) -> Result<std::path::PathBuf, String> {
    if roots.is_empty() {
        return ensure_write_path_in_project_root(path, "");
    }
    let mut last_err = String::new();
    for root in roots {
        match ensure_write_path_in_project_root(path, root) {
            Ok(p) => return Ok(p),
            Err(e) => last_err = e,
        }
    }
    Err(format!(
        "access denied: '{}' is outside every registered project root ({} checked) — last error: {}",
        path,
        roots.len(),
        last_err
    ))
}

/// Thin tauri::State wrapper around `ensure_write_path_in_project_roots` —
/// the multi-project counterpart of the (now removed)
/// `ensure_write_path_in_project`, which checked only the single legacy
/// `ProjectState` root.
fn ensure_write_path_in_any_open_project(path: &str, registry: &tauri::State<ProjectRegistry>) -> Result<std::path::PathBuf, String> {
    let roots = registry.0.lock()
        .map_err(|e| format!("project registry lock failed: {}", e))?
        .all_roots();
    ensure_write_path_in_project_roots(path, &roots)
}

/// Absolute ceiling for read_file, applied even when the caller passes an
/// explicit `max_bytes` larger than this. Beyond this a file is refused
/// (editor path) or hard-truncated (tool path) rather than fully buffered —
/// see `decide_read_cap`.
const DEFAULT_MAX_READ_BYTES: u64 = 20_000_000; // 20 MB

/// How read_file should handle a file of a given size against the
/// requested cap. Pure/testable: no filesystem I/O.
#[derive(Debug, PartialEq, Eq)]
enum ReadCapDecision {
    /// Within the effective cap — read the whole file normally.
    Full,
    /// The caller explicitly passed `max_bytes` and the file exceeds it:
    /// read only the first `cap` bytes and mark the result as truncated.
    /// Safe for tool-runtime callers (read_file/grep_file tools), which
    /// only ever display a window of the content and never write it back.
    Truncate(u64),
    /// The caller passed no `max_bytes` (the editor's open-file path, which
    /// DOES write content back via write_file/save) and the file exceeds
    /// the absolute ceiling: refuse rather than silently truncate — a
    /// truncated buffer could otherwise get saved back over the real file.
    TooLarge { cap: u64 },
}

/// Decide how to read a file of `size` bytes given an optional
/// caller-specified `max_bytes` and the absolute ceiling `default_cap`.
fn decide_read_cap(size: u64, max_bytes: Option<u64>, default_cap: u64) -> ReadCapDecision {
    let effective_cap = max_bytes.unwrap_or(default_cap).min(default_cap);
    if size <= effective_cap {
        ReadCapDecision::Full
    } else if max_bytes.is_some() {
        ReadCapDecision::Truncate(effective_cap)
    } else {
        ReadCapDecision::TooLarge { cap: effective_cap }
    }
}

/// Read at most `cap` bytes from the start of a file, decoding lossily —
/// an exact byte cut can land mid-UTF-8-codepoint, which is acceptable for
/// a truncated tool-observation preview (unlike a normal full read).
fn read_first_bytes_lossy(path: &std::path::Path, cap: u64) -> std::io::Result<String> {
    let file = fs::File::open(path)?;
    let mut buf = Vec::new();
    file.take(cap).read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Read a file and return its UTF-8 content.
///
/// `max_bytes` bounds how much of the file is read; defaults to
/// DEFAULT_MAX_READ_BYTES (20 MB) and is clamped to it either way — see
/// `decide_read_cap` for the full truncate-vs-refuse policy.
#[tauri::command]
pub(crate) fn read_file(
    path: String,
    max_bytes: Option<u64>,
    project_registry: tauri::State<ProjectRegistry>,
) -> Result<String, String> {
    let safe_path = ensure_path_in_any_open_project(&path, &project_registry)?;
    let size = fs::metadata(&safe_path)
        .map_err(|e| format!("read_file: metadata failed for '{}': {}", safe_path.display(), e))?
        .len();

    match decide_read_cap(size, max_bytes, DEFAULT_MAX_READ_BYTES) {
        ReadCapDecision::Full => fs::read_to_string(&safe_path)
            .map_err(|e| format!("read_file failed for '{}': {}", safe_path.display(), e)),
        ReadCapDecision::Truncate(cap) => {
            let content = read_first_bytes_lossy(&safe_path, cap)
                .map_err(|e| format!("read_file failed for '{}': {}", safe_path.display(), e))?;
            Ok(format!(
                "{}\n\n[TRUNCATED: showing first {} of {} bytes]",
                content, cap, size,
            ))
        }
        ReadCapDecision::TooLarge { cap } => Err(format!(
            "read_file: '{}' is {} bytes, over the {} byte read ceiling",
            safe_path.display(),
            size,
            cap,
        )),
    }
}

/// Testable core of `read_text_file` — takes the registered project roots
/// directly (not a `tauri::State`), same `xxx_inner` split convention as
/// `read_file_base64_inner` above. Goes through the SAME read-path jail
/// (`ensure_path_in_project_roots`) as every other read in this file.
pub(crate) fn read_text_file_inner(path: &str, roots: &[String]) -> Result<String, String> {
    let safe_path = ensure_path_in_project_roots(path, roots)?;
    let size = fs::metadata(&safe_path)
        .map_err(|e| format!("read_text_file: metadata failed for '{}': {}", safe_path.display(), e))?
        .len();

    match decide_read_cap(size, None, DEFAULT_MAX_READ_BYTES) {
        ReadCapDecision::Full => fs::read_to_string(&safe_path)
            .map_err(|e| format!("read_text_file failed for '{}': {}", safe_path.display(), e)),
        _ => Err(format!(
            "read_text_file: '{}' is {} bytes, over the {} byte read ceiling",
            safe_path.display(),
            size,
            DEFAULT_MAX_READ_BYTES,
        )),
    }
}

/// Read a file and return its full UTF-8 content, with no `max_bytes`
/// window/truncate option — used by traceJournal.ts's `readTraceEntries`
/// to load the whole `.lazy/run-traces.jsonl` journal for line-by-line
/// parsing (a truncated JSONL read would silently drop trailing entries,
/// unlike read_file's tool-preview truncation which is fine to be partial).
/// Thin wrapper: same read-path jail and the same DEFAULT_MAX_READ_BYTES
/// ceiling as `read_file`, reusing `decide_read_cap`'s sizing decision with
/// `max_bytes: None` so a file over the ceiling is refused outright rather
/// than partially read.
#[tauri::command]
pub(crate) fn read_text_file(
    path: String,
    project_registry: tauri::State<ProjectRegistry>,
) -> Result<String, String> {
    let roots = project_registry
        .0
        .lock()
        .map_err(|e| format!("project registry lock failed: {}", e))?
        .all_roots();
    read_text_file_inner(&path, &roots)
}

/// Absolute ceiling for read_file_base64 — deliberately smaller than
/// DEFAULT_MAX_READ_BYTES (the UTF-8 text read_file ceiling): binary
/// artifacts (screenshots) are always fully buffered and base64-encoded in
/// memory (no truncate-and-mark-partial option makes sense for an image —
/// a truncated PNG is not a valid image), so this cap exists purely to
/// bound worst-case memory/IPC-payload size for a single call. 8 MB of raw
/// bytes -> ~10.9 MB of base64 text, comfortably under the ~5 MB *rendered*
/// inline-size guard artifactImage.ts applies on top (that guard measures
/// the base64 STRING length after this command already succeeded) — this
/// Rust-side ceiling only needs to stop a pathologically large file from
/// ever being read into memory at all, not enforce the UI's own display
/// budget (which artifactImage.ts owns and can tighten independently).
const MAX_BASE64_READ_BYTES: u64 = 8_000_000; // 8 MB

/// Testable core of `read_file_base64` — takes the registered project roots
/// directly (not a `tauri::State`) so it can be exercised in a plain unit
/// test without a running Tauri app, same `xxx_inner` split convention
/// already used by canvas.rs/git.rs/journal.rs's own State-free command
/// bodies. Goes through the SAME project-root jailing guard as every other
/// read in this file (`ensure_path_in_project_roots`) — no separate/weaker
/// containment check for binary reads.
pub(crate) fn read_file_base64_inner(path: &str, roots: &[String]) -> Result<String, String> {
    let safe_path = ensure_path_in_project_roots(path, roots)?;
    let size = fs::metadata(&safe_path)
        .map_err(|e| format!("read_file_base64: metadata failed for '{}': {}", safe_path.display(), e))?
        .len();
    if size > MAX_BASE64_READ_BYTES {
        return Err(format!(
            "read_file_base64: '{}' is {} bytes, over the {} byte read ceiling",
            safe_path.display(),
            size,
            MAX_BASE64_READ_BYTES,
        ));
    }
    let bytes = fs::read(&safe_path)
        .map_err(|e| format!("read_file_base64 failed for '{}': {}", safe_path.display(), e))?;
    Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes))
}

/// Read a file and return its content base64-encoded — the binary-safe
/// counterpart of `read_file` (which requires valid UTF-8 and therefore
/// fails outright on a real PNG/JPEG screenshot artifact; see
/// src/components/agents/report/artifactImage.ts's module header for the
/// exact gap this closes).
#[tauri::command]
pub(crate) fn read_file_base64(
    path: String,
    project_registry: tauri::State<ProjectRegistry>,
) -> Result<String, String> {
    let roots = project_registry
        .0
        .lock()
        .map_err(|e| format!("project registry lock failed: {}", e))?
        .all_roots();
    read_file_base64_inner(&path, &roots)
}

/// Write UTF-8 content to a file, creating it if it doesn't exist.
#[tauri::command]
pub(crate) fn write_file(path: String, content: String, project_registry: tauri::State<ProjectRegistry>) -> Result<(), String> {
    let safe_path = ensure_write_path_in_any_open_project(&path, &project_registry)?;
    if let Some(parent) = safe_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all failed for '{}': {}", parent.display(), e))?;
    }
    fs::write(&safe_path, content)
        .map_err(|e| format!("write_file failed for '{}': {}", safe_path.display(), e))
}

/// Testable core of `append_to_file` — takes the registered project roots
/// directly (not a `tauri::State`), same `xxx_inner` split convention as
/// `read_file_base64_inner` / `read_text_file_inner` above. Goes through
/// the SAME write-path jail (`ensure_write_path_in_project_roots`) as
/// `write_file` — without it this would be an arbitrary-file-append
/// primitive reachable from a managed agent's tool calls.
pub(crate) fn append_to_file_inner(path: &str, content: &str, roots: &[String]) -> Result<(), String> {
    let safe_path = ensure_write_path_in_project_roots(path, roots)?;
    if let Some(parent) = safe_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("append_to_file: create_dir_all failed for '{}': {}", parent.display(), e))?;
    }
    let mut file = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&safe_path)
        .map_err(|e| format!("append_to_file: open failed for '{}': {}", safe_path.display(), e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("append_to_file: write failed for '{}': {}", safe_path.display(), e))
}

/// Append UTF-8 content to a file, creating the file (and its parent
/// directories) if it doesn't exist yet — the append-only counterpart of
/// `write_file`, used by traceJournal.ts's `appendTraceEntry` to grow
/// `.lazy/run-traces.jsonl` one JSON line per node completion without
/// re-reading and re-writing the whole file every time.
#[tauri::command]
pub(crate) fn append_to_file(path: String, content: String, project_registry: tauri::State<ProjectRegistry>) -> Result<(), String> {
    let roots = project_registry
        .0
        .lock()
        .map_err(|e| format!("project registry lock failed: {}", e))?
        .all_roots();
    append_to_file_inner(&path, &content, &roots)
}

/// Rename (move) a file or directory within the project root.
///
/// Both `old_path` and `new_path` must be inside the project root.
/// The parent directory of `new_path` must exist.
#[tauri::command]
pub(crate) fn fs_rename(
    old_path: String,
    new_path: String,
    project_registry: tauri::State<ProjectRegistry>,
) -> Result<(), String> {
    let safe_old = ensure_path_in_any_open_project(&old_path, &project_registry)?;
    let safe_new = ensure_write_path_in_any_open_project(&new_path, &project_registry)?;
    fs::rename(&safe_old, &safe_new)
        .map_err(|e| format!("fs_rename failed '{}' -> '{}': {}", safe_old.display(), safe_new.display(), e))
}

/// Remove a file or directory recursively within the project root.
///
/// Silently succeeds if the path does not exist.
#[tauri::command]
pub(crate) fn fs_remove(path: String, project_registry: tauri::State<ProjectRegistry>) -> Result<(), String> {
    let safe_path = ensure_path_in_any_open_project(&path, &project_registry)?;
    if safe_path.is_dir() {
        fs::remove_dir_all(&safe_path)
            .map_err(|e| format!("fs_remove (dir) failed for '{}': {}", safe_path.display(), e))
    } else {
        fs::remove_file(&safe_path)
            .map_err(|e| format!("fs_remove (file) failed for '{}': {}", safe_path.display(), e))
    }
}

/// Create an empty file at `path` within the project root.
///
/// Creates parent directories as needed. No-ops if the file already exists
/// (does not truncate existing content).
#[tauri::command]
pub(crate) fn fs_create_file(path: String, project_registry: tauri::State<ProjectRegistry>) -> Result<(), String> {
    let safe_path = ensure_write_path_in_any_open_project(&path, &project_registry)?;
    if let Some(parent) = safe_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("fs_create_file: create_dir_all failed: {}", e))?;
    }
    if !safe_path.exists() {
        fs::write(&safe_path, b"")
            .map_err(|e| format!("fs_create_file: write failed for '{}': {}", safe_path.display(), e))?;
    }
    Ok(())
}

/// Create a directory (and all parents) at `path` within the project root.
#[tauri::command]
pub(crate) fn fs_create_dir(path: String, project_registry: tauri::State<ProjectRegistry>) -> Result<(), String> {
    let safe_path = ensure_write_path_in_any_open_project(&path, &project_registry)?;
    fs::create_dir_all(&safe_path)
        .map_err(|e| format!("fs_create_dir failed for '{}': {}", safe_path.display(), e))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression coverage for the real-app QA bug: missionQueue.ts /
    /// artifacts.ts built paths like `${repoPath}/.lazy/artifacts` by string
    /// concatenation. repoPath is typically get_project_root's own
    /// std::fs::canonicalize() output (verbatim `\\?\`-prefixed on Windows),
    /// so the result mixes a backslash verbatim base with a forward-slash
    /// suffix. This is what fs_create_dir / write_file / read_file actually
    /// run (via ensure_write_path_in_project / ensure_path_in_project) —
    /// the code path the "[missionQueue] Failed to persist queue: access
    /// denied ..." / "[artifacts] Failed to save: access denied ..." console
    /// errors came from.

    fn make_temp_test_dir(label: &str) -> std::path::PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "lazy_fs_test_{}_{}_{}",
            std::process::id(),
            label,
            unique
        ));
        std::fs::create_dir_all(&dir).expect("failed to create temp test dir");
        dir
    }

    /// ensure_path_in_project_root (backs read_file/read_dir/fs_remove):
    /// accepts a mixed-separator path to an *already-existing* nested dir —
    /// exactly the shape `${repoPath}/.lazy/artifacts` produces once `.lazy`
    /// has already been created by an earlier call.
    #[test]
    fn ensure_path_in_project_root_accepts_mixed_separator_existing_subpath() {
        let root = make_temp_test_dir("read_ok");
        std::fs::create_dir_all(root.join(".lazy").join("artifacts")).unwrap();
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        assert!(root_str.starts_with(r"\\?\"), "sanity: expected a verbatim root, got {}", root_str);

        let mixed = format!("{}/.lazy/artifacts", root_str);
        let result = ensure_path_in_project_root(&mixed, &root_str);
        assert!(result.is_ok(), "expected mixed-separator existing subpath to be accepted, got: {:?}", result);

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_path_in_project_root_accepts_mixed_separator_existing_subpath PASSED");
    }

    // ── 2026-08-12 fix: read_file's OWN jail (ensure_path_in_project_root)
    //    never accepted a not-yet-existing lexically-inside candidate ──────
    //
    // Real repro: orchestratorState.ts's `loadOrchestratorsJson` calls
    // `getPlatform().fs.readFile(...)` -> Rust `read_file` -> THIS function
    // (not util.rs's `ensure_repo_in_project_root`, which backs git/agent/
    // shell/lsp commands and already got the "accept a not-yet-existing
    // path" fix on 2026-08-04) for a project's `.lazy/orchestrators.json`
    // that has never been created — unconditionally canonicalized the whole
    // candidate and, on the resulting NotFound, reported "path canonicalize
    // failed for '...'", which the multi-root wrapper below then turned
    // into a false "access denied: ... is outside every registered project
    // root". This is a SEPARATE code path from util.rs's fix (confirmed:
    // read_file's call chain is read_file -> ensure_path_in_any_open_project
    // -> ensure_path_in_project_roots -> ensure_path_in_project_root, all
    // defined in THIS file, never touching util.rs).

    /// A not-yet-created file under a registered root — the exact shape of
    /// a fresh project's `.lazy/orchestrators.json` — must be accepted by
    /// the READ-path guard `read_file` actually goes through.
    #[test]
    fn ensure_path_in_project_root_accepts_nonexistent_file_under_registered_root() {
        let root = make_temp_test_dir("read_nonexistent_ok");
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();

        let never_created = format!("{}\\.lazy\\orchestrators.json", root_str);
        assert!(
            !std::path::Path::new(&never_created).exists(),
            "test precondition: the target must not exist on disk"
        );

        let result = ensure_path_in_project_root(&never_created, &root_str);
        assert!(
            result.is_ok(),
            "a not-yet-created file lexically inside a registered root must be accepted by the read-path guard, got: {:?}",
            result
        );

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_path_in_project_root_accepts_nonexistent_file_under_registered_root PASSED");
    }

    /// Same shape as the live repro verbatim: both the registered root and
    /// the not-yet-existing candidate carry `\\?\` (exactly what
    /// `project_register_inner`'s canonicalize() output and a caller
    /// building `{root}\.lazy\orchestrators.json` off of it produce).
    #[test]
    fn ensure_path_in_project_root_accepts_verbatim_prefixed_nonexistent_path() {
        let root = make_temp_test_dir("read_nonexistent_verbatim_ok");
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        assert!(root_str.starts_with(r"\\?\"), "sanity: canonicalize() must yield a verbatim path on Windows");

        let never_created = format!("{}\\.lazy\\orchestrators.json", root_str);
        assert!(never_created.starts_with(r"\\?\"));
        assert!(!std::path::Path::new(&never_created).exists());

        let result = ensure_path_in_project_root(&never_created, &root_str);
        assert!(
            result.is_ok(),
            "a \\\\?\\-prefixed not-yet-created path under a \\\\?\\-prefixed registered root must be accepted, got: {:?}",
            result
        );

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_path_in_project_root_accepts_verbatim_prefixed_nonexistent_path PASSED");
    }

    /// A genuinely out-of-root path that also does not exist must still be
    /// denied — the not-yet-existing acceptance above must never widen into
    /// "anything missing is fine". Proven through the full multi-root
    /// entry point (`ensure_path_in_project_roots`, what
    /// `ensure_path_in_any_open_project`/`read_file` actually call) with
    /// SEVERAL registered roots, mirroring the live repro's "6 checked".
    #[test]
    fn ensure_path_in_project_roots_rejects_nonexistent_path_outside_every_root() {
        let root_a = make_temp_test_dir("read_reject_root_a");
        let root_b = make_temp_test_dir("read_reject_root_b");
        let sibling = make_temp_test_dir("read_reject_sibling");
        let root_a_str = root_a.canonicalize().unwrap().to_string_lossy().to_string();
        let root_b_str = root_b.canonicalize().unwrap().to_string_lossy().to_string();
        let sibling_str = sibling.canonicalize().unwrap().to_string_lossy().to_string();

        let never_created_outside = format!("{}\\never-created.json", sibling_str);
        assert!(!std::path::Path::new(&never_created_outside).exists());

        let roots = vec![root_a_str, root_b_str];
        let result = ensure_path_in_project_roots(&never_created_outside, &roots);
        assert!(
            result.is_err(),
            "a not-yet-existing path OUTSIDE every registered root must still be denied, got: {:?}",
            result
        );

        std::fs::remove_dir_all(&root_a).ok();
        std::fs::remove_dir_all(&root_b).ok();
        std::fs::remove_dir_all(&sibling).ok();
        eprintln!("ensure_path_in_project_roots_rejects_nonexistent_path_outside_every_root PASSED");
    }

    /// End-to-end shape of the live repro: the freshly-registered project is
    /// the LAST of several currently-registered roots (mirrors "6 checked"),
    /// and its own `.lazy/orchestrators.json` has never been created — must
    /// be accepted through the exact multi-root entry point `read_file`
    /// calls, not just the single-root function.
    #[test]
    fn ensure_path_in_project_roots_accepts_nonexistent_orchestrators_json_among_several_roots() {
        let other_a = make_temp_test_dir("read_multi_other_a");
        let other_b = make_temp_test_dir("read_multi_other_b");
        let fresh = make_temp_test_dir("read_multi_fresh_project");
        let other_a_str = other_a.canonicalize().unwrap().to_string_lossy().to_string();
        let other_b_str = other_b.canonicalize().unwrap().to_string_lossy().to_string();
        let fresh_str = fresh.canonicalize().unwrap().to_string_lossy().to_string();

        let never_created = format!("{}\\.lazy\\orchestrators.json", fresh_str);
        assert!(!std::path::Path::new(&never_created).exists());

        let roots = vec![other_a_str, other_b_str, fresh_str];
        let result = ensure_path_in_project_roots(&never_created, &roots);
        assert!(
            result.is_ok(),
            "a not-yet-created .lazy/orchestrators.json under the LAST of several registered roots must be accepted, got: {:?}",
            result
        );

        std::fs::remove_dir_all(&other_a).ok();
        std::fs::remove_dir_all(&other_b).ok();
        std::fs::remove_dir_all(&fresh).ok();
        eprintln!("ensure_path_in_project_roots_accepts_nonexistent_orchestrators_json_among_several_roots PASSED");
    }

    /// ensure_write_path_in_project_root (backs write_file/fs_create_dir):
    /// accepts creating `.lazy` itself the very first time (parent == root,
    /// nothing exists yet) — the missionQueue.ts `writeQueue`
    /// `createDir(`${repoPath}/.lazy`)` call on a brand-new project.
    #[test]
    fn ensure_write_path_in_project_root_accepts_first_time_lazy_dir_creation() {
        let root = make_temp_test_dir("write_fresh");
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();

        let mixed = format!("{}/.lazy", root_str);
        let result = ensure_write_path_in_project_root(&mixed, &root_str);
        assert!(result.is_ok(), "expected first-time '.lazy' creation to be accepted, got: {:?}", result);
        assert_eq!(result.unwrap(), root.canonicalize().unwrap().join(".lazy"));

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_write_path_in_project_root_accepts_first_time_lazy_dir_creation PASSED");
    }

    /// ensure_write_path_in_project_root accepts a mixed-separator path to a
    /// not-yet-existing *file* inside an already-existing `.lazy` dir — the
    /// missionQueue.ts `writeQueue` `writeFile(`${repoPath}/.lazy/mission-queue.json`)`
    /// call on a project that already has a `.lazy` dir.
    #[test]
    fn ensure_write_path_in_project_root_accepts_mixed_separator_new_file_in_existing_dir() {
        let root = make_temp_test_dir("write_existing_dir");
        std::fs::create_dir_all(root.join(".lazy")).unwrap();
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();

        let mixed = format!("{}/.lazy/mission-queue.json", root_str);
        let result = ensure_write_path_in_project_root(&mixed, &root_str);
        assert!(result.is_ok(), "expected mixed-separator new-file path to be accepted, got: {:?}", result);
        assert_eq!(
            result.unwrap(),
            root.canonicalize().unwrap().join(".lazy").join("mission-queue.json"),
        );

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_write_path_in_project_root_accepts_mixed_separator_new_file_in_existing_dir PASSED");
    }

    /// ensure_write_path_in_project_root accepts overwriting a mixed-separator
    /// path to an *already-existing* file — artifacts.ts's `saveArtifacts`
    /// writeFile call on the 2nd+ save of the same mission's artifacts.
    #[test]
    fn ensure_write_path_in_project_root_accepts_mixed_separator_existing_file_overwrite() {
        let root = make_temp_test_dir("write_overwrite");
        std::fs::create_dir_all(root.join(".lazy").join("artifacts")).unwrap();
        std::fs::write(root.join(".lazy").join("artifacts").join("m1.json"), b"{}").unwrap();
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();

        let mixed = format!("{}/.lazy/artifacts/m1.json", root_str);
        let result = ensure_write_path_in_project_root(&mixed, &root_str);
        assert!(result.is_ok(), "expected mixed-separator existing-file overwrite to be accepted, got: {:?}", result);

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_write_path_in_project_root_accepts_mixed_separator_existing_file_overwrite PASSED");
    }

    /// A genuinely-outside sibling directory must still be denied by both
    /// root-string variants — the fix must not weaken containment.
    #[test]
    fn ensure_path_in_project_root_and_write_variant_reject_outside_sibling() {
        let root = make_temp_test_dir("outside_root");
        let sibling = make_temp_test_dir("outside_sibling");
        std::fs::write(sibling.join("evil.json"), b"{}").unwrap();

        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        let sibling_dir_str = sibling.canonicalize().unwrap().to_string_lossy().to_string();
        let sibling_file_str = format!("{}/evil.json", sibling_dir_str);
        let sibling_new_file_str = format!("{}/not-yet-created.json", sibling_dir_str);

        assert!(
            ensure_path_in_project_root(&sibling_dir_str, &root_str).is_err(),
            "read variant must reject an existing directory outside root"
        );
        assert!(
            ensure_write_path_in_project_root(&sibling_file_str, &root_str).is_err(),
            "write variant must reject an existing file outside root"
        );
        assert!(
            ensure_write_path_in_project_root(&sibling_new_file_str, &root_str).is_err(),
            "write variant must reject a not-yet-existing file whose parent is outside root"
        );

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&sibling).ok();
        eprintln!("ensure_path_in_project_root_and_write_variant_reject_outside_sibling PASSED");
    }

    /// A '..'-escape attempt (mixed with a forward-slash-joined verbatim
    /// base) must still be rejected by both variants.
    #[test]
    fn ensure_path_in_project_root_and_write_variant_reject_dotdot_escape() {
        let root = make_temp_test_dir("dotdot_root");
        let inner = root.join("inner");
        std::fs::create_dir_all(&inner).unwrap();

        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        let inner_verbatim = inner.canonicalize().unwrap().to_string_lossy().to_string();
        let escape = format!("{}/../../", inner_verbatim);

        assert!(
            ensure_path_in_project_root(&escape, &root_str).is_err(),
            "read variant must reject a '..' escape"
        );
        assert!(
            ensure_write_path_in_project_root(&format!("{}nonexistent.json", escape), &root_str).is_err(),
            "write variant must reject a '..' escape"
        );

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_path_in_project_root_and_write_variant_reject_dotdot_escape PASSED");
    }

    // ── dunce_simplify: '.'/'..' resolution against a verbatim root ────
    //
    // Regression coverage for the real-app QA bug hit during a managed-agent
    // mission in a git worktree: `read_dir: {"path":"."}` / `find_file`
    // failed with "ERROR: path canonicalize failed for '\\?\C:\...\
    // agent-M18-...'" while `read_file("package.json")` (no dot component)
    // worked fine. See dunce_simplify's own doc comment for the confirmed
    // mechanism (verbatim paths disable Win32's '.'/'..' resolution).
    //
    // Side effect worth calling out: the dotdot-escape test just above
    // (`ensure_path_in_project_root_and_write_variant_reject_dotdot_escape`)
    // still passes after this fix, but now for the RIGHT reason — before
    // dunce_simplify, a verbatim '..'-carrying path failed to canonicalize
    // AT ALL (an accidental Err), which only coincidentally matched
    // `.is_err()`; now it canonicalizes successfully to a real location
    // outside root and is explicitly rejected by path_is_within. Strictly
    // more robust, not just unbroken.

    /// THE regression test: a "." candidate (exactly what toolRuntime.ts's
    /// `resolvePath(rootPath, '.')` produces) must resolve against a
    /// verbatim (canonicalized) root instead of failing to canonicalize.
    #[test]
    fn ensure_path_in_project_root_resolves_dot_candidate_against_verbatim_root() {
        let root = make_temp_test_dir("dot_candidate_root");
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        assert!(root_str.starts_with(r"\\?\"), "sanity: expected a verbatim root, got {}", root_str);

        let dot_candidate = format!("{}/.", root_str);
        let result = ensure_path_in_project_root(&dot_candidate, &root_str);
        assert!(
            result.is_ok(),
            "expected '.' to resolve against a verbatim root, got: {:?}",
            result
        );
        assert_eq!(
            result.unwrap(),
            root.canonicalize().unwrap(),
            "'.' must resolve to the root itself"
        );

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_path_in_project_root_resolves_dot_candidate_against_verbatim_root PASSED");
    }

    /// A "." candidate against a PLAIN (non-verbatim) root must keep working
    /// too — dunce_simplify is a no-op for an already-plain root, so this
    /// guards against the fix regressing the case that already worked.
    #[test]
    fn ensure_path_in_project_root_resolves_dot_candidate_against_plain_root() {
        let root = make_temp_test_dir("dot_candidate_plain_root");
        let root_str = root.to_string_lossy().to_string(); // deliberately NOT canonicalized

        let dot_candidate = format!("{}/.", root_str);
        let result = ensure_path_in_project_root(&dot_candidate, &root_str);
        assert!(
            result.is_ok(),
            "expected '.' to resolve against a plain (non-verbatim) root too, got: {:?}",
            result
        );

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_path_in_project_root_resolves_dot_candidate_against_plain_root PASSED");
    }

    /// A legitimate (non-escaping) '..' inside a relative candidate — e.g. a
    /// tool call resolving "sub/../sibling" that stays inside the root —
    /// must now resolve instead of failing outright, proving '..'
    /// resolution (not just rejection of a malicious escape) works against
    /// a verbatim root too. Mixed-form: the candidate's root segment is
    /// verbatim while the '..'-carrying suffix was appended with a plain
    /// forward slash (the exact shape resolvePath/joinPath produce).
    #[test]
    fn ensure_path_in_project_root_resolves_relative_dotdot_that_stays_inside_root() {
        let root = make_temp_test_dir("dotdot_inside_root");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(root.join("sibling")).unwrap();
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();

        let candidate = format!("{}/sub/../sibling", root_str);
        let result = ensure_path_in_project_root(&candidate, &root_str);
        assert!(
            result.is_ok(),
            "expected an in-root '..' traversal to resolve, got: {:?}",
            result
        );
        assert_eq!(result.unwrap(), root.canonicalize().unwrap().join("sibling"));

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_path_in_project_root_resolves_relative_dotdot_that_stays_inside_root PASSED");
    }

    /// A sibling directory whose name merely starts with the project root's
    /// name (e.g. 'qa-project-evil' vs 'qa-project') must NOT pass — proves
    /// path_is_within's component-wise comparison (not a naive string
    /// prefix) still holds after the normalize_separators fix.
    #[test]
    fn ensure_path_in_project_root_rejects_name_prefix_sibling() {
        let parent = make_temp_test_dir("prefix_parent");
        let root = parent.join("qa-project");
        let sibling = parent.join("qa-project-evil");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();

        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        let sibling_str = sibling.canonicalize().unwrap().to_string_lossy().to_string();

        let result = ensure_path_in_project_root(&sibling_str, &root_str);
        assert!(
            result.is_err(),
            "expected name-prefix sibling 'qa-project-evil' to be rejected against root 'qa-project', got: {:?}",
            result
        );

        std::fs::remove_dir_all(&parent).ok();
        eprintln!("ensure_path_in_project_root_rejects_name_prefix_sibling PASSED");
    }

    /// decide_read_cap: sizes within the effective cap always read in
    /// full, regardless of whether max_bytes was specified.
    #[test]
    fn decide_read_cap_within_cap_reads_full() {
        assert_eq!(decide_read_cap(100, None, 1_000), ReadCapDecision::Full);
        assert_eq!(decide_read_cap(100, Some(500), 1_000), ReadCapDecision::Full);
        eprintln!("decide_read_cap_within_cap_reads_full PASSED");
    }

    /// decide_read_cap: an explicit max_bytes over the file size truncates
    /// (with a marker) instead of refusing — the tool-runtime read_file/
    /// grep_file path only ever displays a window and never writes back,
    /// so a bounded lossy read is safe there.
    #[test]
    fn decide_read_cap_explicit_max_bytes_truncates() {
        assert_eq!(decide_read_cap(10_000, Some(1_000), 20_000_000), ReadCapDecision::Truncate(1_000));
        eprintln!("decide_read_cap_explicit_max_bytes_truncates PASSED");
    }

    /// decide_read_cap: no max_bytes (the editor's open-file path, which
    /// DOES write content back on save) over the absolute ceiling refuses
    /// instead of silently truncating — a truncated buffer could otherwise
    /// get saved back over the real, larger file. Also proves an explicit
    /// max_bytes larger than the ceiling is clamped down to it, so nobody
    /// can request more than DEFAULT_MAX_READ_BYTES via this command.
    #[test]
    fn decide_read_cap_over_ceiling_refuses_or_clamps() {
        assert_eq!(
            decide_read_cap(30_000_000, None, 20_000_000),
            ReadCapDecision::TooLarge { cap: 20_000_000 },
        );
        assert_eq!(
            decide_read_cap(25_000_000, Some(50_000_000), 20_000_000),
            ReadCapDecision::Truncate(20_000_000),
        );
        eprintln!("decide_read_cap_over_ceiling_refuses_or_clamps PASSED");
    }

    /// path_is_within itself (previously untested): exact match and nested
    /// paths are within; unrelated and name-prefix-sibling paths are not.
    #[test]
    fn path_is_within_pure_function_cases() {
        let root = make_temp_test_dir("piw_root");
        let nested = root.join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        let sibling = make_temp_test_dir("piw_sibling");

        let root_c = root.canonicalize().unwrap();
        let nested_c = nested.canonicalize().unwrap();
        let sibling_c = sibling.canonicalize().unwrap();

        assert!(path_is_within(&root_c, &root_c), "root is within itself");
        assert!(path_is_within(&nested_c, &root_c), "nested dir is within root");
        assert!(!path_is_within(&sibling_c, &root_c), "unrelated sibling is not within root");

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&sibling).ok();
        eprintln!("path_is_within_pure_function_cases PASSED");
    }

    // ── Multi-root allowlist (read_dir/read_file/write_file/fs_rename/
    // fs_remove/fs_create_file/fs_create_dir's project-root gate) ──────────
    //
    // fs.rs keeps its own local ensure_path_in_project_root /
    // ensure_write_path_in_project_root (parallel to, not the same function
    // as, util.rs's ensure_repo_in_project_root — see this file's module doc
    // comment), so it needs its own multi-root variants too. These prove the
    // same "background project accepted, foreign path rejected" contract
    // util.rs's ensure_repo_in_project_roots already guarantees for the
    // git/shell/agent/lsp commands.

    /// A path under the SECOND registered root (a "background" project —
    /// registered but not active) must be accepted by the read-path gate; a
    /// path under a directory that was never registered at all must still be
    /// denied.
    #[test]
    fn ensure_path_in_project_roots_accepts_background_root_and_rejects_foreign_path() {
        let active = make_temp_test_dir("multi_read_active");
        let background = make_temp_test_dir("multi_read_background");
        std::fs::create_dir_all(background.join("src")).unwrap();
        let foreign = make_temp_test_dir("multi_read_foreign");

        let active_str = active.canonicalize().unwrap().to_string_lossy().to_string();
        let background_str = background.canonicalize().unwrap().to_string_lossy().to_string();
        let background_src_str = format!("{}/src", background_str);
        let foreign_str = foreign.canonicalize().unwrap().to_string_lossy().to_string();

        let roots = vec![active_str, background_str];

        assert!(
            ensure_path_in_project_roots(&background_src_str, &roots).is_ok(),
            "a path under a registered-but-not-active (background) root must be accepted"
        );
        assert!(
            ensure_path_in_project_roots(&foreign_str, &roots).is_err(),
            "a path outside every registered root must still be rejected"
        );

        std::fs::remove_dir_all(&active).ok();
        std::fs::remove_dir_all(&background).ok();
        std::fs::remove_dir_all(&foreign).ok();
        eprintln!("ensure_path_in_project_roots_accepts_background_root_and_rejects_foreign_path PASSED");
    }

    /// Same contract as above, for the write-path gate: a not-yet-existing
    /// file whose parent is the SECOND (background) registered root is
    /// accepted; one whose parent was never registered at all is denied.
    #[test]
    fn ensure_write_path_in_project_roots_accepts_background_root_and_rejects_foreign_path() {
        let active = make_temp_test_dir("multi_write_active");
        let background = make_temp_test_dir("multi_write_background");
        let foreign = make_temp_test_dir("multi_write_foreign");

        let active_str = active.canonicalize().unwrap().to_string_lossy().to_string();
        let background_str = background.canonicalize().unwrap().to_string_lossy().to_string();
        let foreign_str = foreign.canonicalize().unwrap().to_string_lossy().to_string();
        let background_new_file = format!("{}/new-note.json", background_str);
        let foreign_new_file = format!("{}/evil.json", foreign_str);

        let roots = vec![active_str, background_str];

        assert!(
            ensure_write_path_in_project_roots(&background_new_file, &roots).is_ok(),
            "a not-yet-existing file under a background root must be accepted"
        );
        assert!(
            ensure_write_path_in_project_roots(&foreign_new_file, &roots).is_err(),
            "a not-yet-existing file outside every registered root must still be rejected"
        );

        std::fs::remove_dir_all(&active).ok();
        std::fs::remove_dir_all(&background).ok();
        std::fs::remove_dir_all(&foreign).ok();
        eprintln!("ensure_write_path_in_project_roots_accepts_background_root_and_rejects_foreign_path PASSED");
    }

    /// An empty roots list ("nothing registered yet") must fall back to cwd,
    /// exactly like the legacy single-root `root == ""` case did
    /// (`canonicalize_effective_root`) — adopting multi-root support must not
    /// regress the pre-project-open behavior (e.g. onboarding/file-picker
    /// flows before any folder has been opened).
    #[test]
    fn ensure_path_in_project_roots_falls_back_to_cwd_when_nothing_is_registered() {
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        let result = ensure_path_in_project_roots(&cwd.to_string_lossy(), &[]);
        assert!(result.is_ok(), "an empty roots list must fall back to cwd, got: {:?}", result);
        eprintln!("ensure_path_in_project_roots_falls_back_to_cwd_when_nothing_is_registered PASSED");
    }

    // ── BUG 1 repro (run-6c): attach_proof "access denied" on a registered
    // scratch project ────────────────────────────────────────────────────
    //
    // Real-app transcript: a managed mission running against a registered
    // project ("alpha") whose root sits several levels deep under the OS
    // temp directory (mirroring a coding-agent's own scratch-workspace
    // convention: `<temp>\<tool>\<mangled-cwd>\<session-id>\scratchpad\
    // <project>`) called ACTION: attach_proof (kind: test_run). Storage
    // (proofs.ts's storeProofText -> proofsDir -> joinPath) builds the
    // artifact directory as `joinPath(projectRoot, '.lazy/artifacts',
    // missionId)`. Critically, `projectRoot` here IS the registered,
    // canonicalized (verbatim `\\?\`-prefixed) root — so joinPath (which
    // picks '\\' as its separator whenever `base` already contains one)
    // produces an ALL-BACKSLASH, ALREADY-VERBATIM candidate. That is a
    // DIFFERENT shape than every mixed-separator regression test above
    // (which all use a forward-slash-joined suffix onto a verbatim base) —
    // this reproduces the ACTUAL shape proofs.ts hands to fs_create_dir/
    // write_file, to find out whether the jail's containment check holds
    // for it too.

    /// Builds a directory nested several levels under the OS temp dir,
    /// mirroring the real bug's scratch-workspace path shape (as opposed to
    /// `make_temp_test_dir`'s single flat segment).
    fn make_nested_scratch_dir(project_label: &str) -> std::path::PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir()
            .join("claude")
            .join("C--Users-David-Documents-cerveau")
            .join(format!("sess-{}-{}", std::process::id(), unique))
            .join("scratchpad")
            .join(project_label);
        std::fs::create_dir_all(&dir).expect("failed to create nested scratch test dir");
        dir
    }

    /// THE regression test: a mission's proof-artifact directory — an
    /// all-backslash, already-verbatim candidate built the way
    /// proofs.ts's joinPath actually builds it — must be accepted under a
    /// registered root that is ITSELF verbatim and several levels deep.
    #[test]
    fn ensure_write_path_in_project_root_accepts_verbatim_joinpath_style_proof_dir_under_nested_registered_root() {
        let root = make_nested_scratch_dir("alpha");
        // Mirrors project_register_inner exactly (commands/brain/config.rs):
        // Path::new(&path).canonicalize() with NO pre-normalization — this
        // is the string that lands in ProjectEntry.root / all_roots().
        let registered_root = root.canonicalize().unwrap().to_string_lossy().to_string();
        assert!(
            registered_root.starts_with(r"\\?\"),
            "sanity: registered root must be verbatim, got {}",
            registered_root
        );

        // Mirrors artifacts.ts having already run for this mission
        // (saveArtifacts creates .lazy/artifacts as a side effect of writing
        // <missionId>.json) before attach_proof's first call.
        std::fs::create_dir_all(
            std::path::Path::new(&registered_root).join(".lazy").join("artifacts"),
        )
        .unwrap();

        // Mirrors proofs.ts's proofsDir(): joinPath(projectRoot,
        // '.lazy/artifacts', safeId). projectRoot already contains '\\', so
        // joinPath's separator choice is '\\' throughout — an all-backslash,
        // already-verbatim candidate, never mixed with '/'.
        let mission_dir_candidate = format!(r"{}\.lazy\artifacts\M18-test-mission", registered_root);

        let result = ensure_write_path_in_project_root(&mission_dir_candidate, &registered_root);
        assert!(
            result.is_ok(),
            "expected the mission's proof directory (a verbatim descendant of a verbatim, nested registered root) to be accepted, got: {:?}",
            result
        );

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_write_path_in_project_root_accepts_verbatim_joinpath_style_proof_dir_under_nested_registered_root PASSED");
    }

    /// THE actual repro (run-6c, BUG 1 root cause): a BRAND NEW scratch
    /// project's very FIRST write under `.lazy/` — i.e. NEITHER `.lazy` NOR
    /// `.lazy/artifacts` exist yet (unlike every test above, which
    /// pre-creates `.lazy/artifacts` to mirror artifacts.ts's mission-
    /// snapshot save having already run). Pre-fix, this failed with "parent
    /// canonicalize failed for '...\.lazy\artifacts': ... (os error 3)" —
    /// wrapped by the multi-root caller into the exact "access denied:
    /// '<verbatim path>' is outside every registered project root (...) —
    /// last error: ..." text the real bug's ERROR line shows (the wrapper
    /// uses that wording for EVERY per-root failure, not only a genuine
    /// containment violation) — even though the candidate was a perfectly
    /// ordinary, verbatim descendant of a verbatim registered root the
    /// whole time. Now walks up to the nearest EXISTING ancestor (here: the
    /// project root itself, 3 levels up) instead of assuming the immediate
    /// parent exists.
    #[test]
    fn ensure_write_path_in_project_root_creates_multiple_missing_ancestor_levels_at_once() {
        let root = make_nested_scratch_dir("brand-new-alpha");
        let registered_root = root.canonicalize().unwrap().to_string_lossy().to_string();
        // Deliberately do NOT pre-create .lazy or .lazy/artifacts — this is
        // the first-ever write under .lazy/ for this project: THREE levels
        // (.lazy, artifacts, the missionId dir) are all missing at once.

        let mission_dir_candidate = format!(r"{}\.lazy\artifacts\M18-test-mission", registered_root);
        let result = ensure_write_path_in_project_root(&mission_dir_candidate, &registered_root);
        assert!(
            result.is_ok(),
            "expected a proof directory 3 levels of missing ancestors deep to be accepted under its own registered root, got: {:?}",
            result
        );
        assert_eq!(
            result.unwrap(),
            std::path::Path::new(&registered_root).join(".lazy").join("artifacts").join("M18-test-mission"),
        );

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_write_path_in_project_root_creates_multiple_missing_ancestor_levels_at_once PASSED");
    }

    /// The multi-level-missing-ancestor walk must not weaken the jail: a
    /// candidate whose missing chain walks up PAST the project root
    /// entirely (root's own parent doesn't exist under any registered root)
    /// must still be rejected, not silently accepted because the walk found
    /// SOME existing ancestor further up the tree.
    #[test]
    fn ensure_write_path_in_project_root_rejects_multi_level_missing_path_outside_root() {
        let root = make_nested_scratch_dir("contained-project");
        let registered_root = root.canonicalize().unwrap().to_string_lossy().to_string();

        // Sibling of `root`'s own scratchpad parent — several levels
        // missing (evil, .lazy, artifacts), but the nearest EXISTING
        // ancestor once fully walked up is the "scratchpad" directory
        // itself (root's parent), which is OUTSIDE the registered root.
        let scratchpad_dir = std::path::Path::new(&registered_root)
            .parent()
            .expect("root must have a parent (scratchpad dir)");
        let escape_candidate = scratchpad_dir
            .join("evil-sibling")
            .join(".lazy")
            .join("artifacts")
            .join("M18-test-mission");

        let result = ensure_write_path_in_project_root(
            &escape_candidate.to_string_lossy(),
            &registered_root,
        );
        assert!(
            result.is_err(),
            "a multi-level-missing path outside the registered root must still be rejected, got: {:?}",
            result
        );
        assert!(result.unwrap_err().contains("outside project root"));

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_write_path_in_project_root_rejects_multi_level_missing_path_outside_root PASSED");
    }

    /// A `.`/`..` component inside the NOT-YET-EXISTING trailing segment
    /// (as opposed to one that already resolves away against an existing
    /// prefix, which the OS collapses transparently during the ancestor
    /// walk's own `.exists()` checks — see `find_nearest_existing_ancestor`'s
    /// doc comment) that walks PAST the registered root entirely (here:
    /// TWO levels — one cancels the missing segment, the second cancels the
    /// registered root itself, landing in root's own parent) must still be
    /// rejected by the final containment check, not silently accepted
    /// because some ancestor further up the real filesystem happens to
    /// exist.
    #[test]
    fn ensure_write_path_in_project_root_rejects_dotdot_in_missing_tail_that_escapes_root() {
        let root = make_temp_test_dir("dotdot_missing_tail");
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();

        // "not-created\..\.." — the first '..' cancels "not-created", the
        // second cancels the registered root itself, landing in root's own
        // (real, existing) parent — a genuine escape, entirely within a
        // not-yet-existing tail.
        let candidate = format!(r"{}\not-created\..\..\evil\file.txt", root_str);
        let result = ensure_write_path_in_project_root(&candidate, &root_str);
        assert!(
            result.is_err(),
            "a '..' escape inside the not-yet-existing tail must still be rejected, got: {:?}",
            result
        );

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_write_path_in_project_root_rejects_dotdot_in_missing_tail_that_escapes_root PASSED");
    }

    /// Same shape, exercised through the ACTUAL multi-root entry point
    /// (`ensure_write_path_in_any_open_project`'s non-State inner function)
    /// attach_proof's fs_create_dir/write_file calls really go through, and
    /// covering BOTH calls storeProofText makes (createDir then writeFile).
    #[test]
    fn ensure_write_path_in_project_roots_accepts_verbatim_joinpath_style_proof_dir_and_file_under_nested_registered_root() {
        let root = make_nested_scratch_dir("alpha2");
        let registered_root = root.canonicalize().unwrap().to_string_lossy().to_string();
        std::fs::create_dir_all(
            std::path::Path::new(&registered_root).join(".lazy").join("artifacts"),
        )
        .unwrap();

        let roots = vec![registered_root.clone()];
        let mission_dir_candidate = format!(r"{}\.lazy\artifacts\M18-test-mission", registered_root);

        // Step 1: fs_create_dir(dir) — the directory does not exist yet.
        let dir_result = ensure_write_path_in_project_roots(&mission_dir_candidate, &roots);
        assert!(
            dir_result.is_ok(),
            "expected the proof directory to be creatable under the registered root, got: {:?}",
            dir_result
        );
        std::fs::create_dir_all(dir_result.unwrap()).unwrap();

        // Step 2: write_file(filePath) — the file inside it does not exist yet.
        let file_candidate = format!(r"{}\test_run-1.txt", mission_dir_candidate);
        let file_result = ensure_write_path_in_project_roots(&file_candidate, &roots);
        assert!(
            file_result.is_ok(),
            "expected the proof text file to be writable under the registered root, got: {:?}",
            file_result
        );

        std::fs::remove_dir_all(&root).ok();
        eprintln!("ensure_write_path_in_project_roots_accepts_verbatim_joinpath_style_proof_dir_and_file_under_nested_registered_root PASSED");
    }

    // ── read_file_base64 (W9 stitch #1: binary-safe screenshot thumbnails) ──
    //
    // read_file (UTF-8-only) fails outright on a real PNG/JPEG artifact —
    // see this file's `read_file_base64_inner` doc comment and
    // src/components/agents/report/artifactImage.ts's module header for the
    // full gap this closes. These tests cover the same two properties every
    // other command in this file is tested for: an allowed path inside a
    // registered project root round-trips correctly, and a path outside
    // every registered root is denied — plus the base64-specific size
    // ceiling.

    /// A PNG-shaped (non-UTF-8) binary fixture inside a registered project
    /// root is read and base64-encoded byte-for-byte — proves this succeeds
    /// on exactly the input shape that makes `read_file` fail (invalid
    /// UTF-8: a raw 0x89 PNG magic byte can never be valid UTF-8 continuation
    /// data).
    #[test]
    fn read_file_base64_inner_encodes_binary_file_inside_project_root() {
        let root = make_temp_test_dir("base64_ok");
        // Real PNG file-signature bytes (0x89 'P' 'N' 'G' \r \n 0x1A \n) —
        // not valid UTF-8, would hard-fail `fs::read_to_string` (read_file).
        let png_bytes: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        std::fs::write(root.join("shot.png"), png_bytes).unwrap();
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        let path = format!("{}/shot.png", root_str);

        let result = read_file_base64_inner(&path, &[root_str]);
        assert!(result.is_ok(), "expected binary file inside root to be readable, got: {:?}", result);

        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD.decode(result.unwrap()).unwrap();
        assert_eq!(decoded, png_bytes, "decoded base64 must round-trip the exact original bytes");

        std::fs::remove_dir_all(&root).ok();
        eprintln!("read_file_base64_inner_encodes_binary_file_inside_project_root PASSED");
    }

    /// A path outside every registered root must be denied — the same
    /// containment guarantee every other read command in this file gets via
    /// `ensure_path_in_project_roots`, proving `read_file_base64_inner`
    /// actually goes through it rather than a separate/weaker check.
    #[test]
    fn read_file_base64_inner_rejects_path_outside_every_registered_root() {
        let root = make_temp_test_dir("base64_deny_root");
        let outside = make_temp_test_dir("base64_deny_outside");
        std::fs::write(outside.join("evil.png"), [0x89, 0x50, 0x4E, 0x47]).unwrap();

        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        let outside_str = outside.canonicalize().unwrap().to_string_lossy().to_string();
        let path = format!("{}/evil.png", outside_str);

        let result = read_file_base64_inner(&path, &[root_str]);
        assert!(result.is_err(), "expected a path outside every registered root to be denied, got: {:?}", result);
        assert!(result.unwrap_err().contains("outside"));

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
        eprintln!("read_file_base64_inner_rejects_path_outside_every_registered_root PASSED");
    }

    /// A file under a SECOND (background, not-active) registered root is
    /// still accepted — same multi-root allowlist contract every other
    /// command's `_roots` variant already guarantees (see the
    /// `ensure_path_in_project_roots_accepts_background_root_and_rejects_foreign_path`
    /// test above).
    #[test]
    fn read_file_base64_inner_accepts_background_registered_root() {
        let active = make_temp_test_dir("base64_multi_active");
        let background = make_temp_test_dir("base64_multi_background");
        std::fs::write(background.join("shot.png"), [0x89, 0x50, 0x4E, 0x47]).unwrap();

        let active_str = active.canonicalize().unwrap().to_string_lossy().to_string();
        let background_str = background.canonicalize().unwrap().to_string_lossy().to_string();
        let path = format!("{}/shot.png", background_str);

        let result = read_file_base64_inner(&path, &[active_str, background_str]);
        assert!(result.is_ok(), "expected a file under a background registered root to be accepted, got: {:?}", result);

        std::fs::remove_dir_all(&active).ok();
        std::fs::remove_dir_all(&background).ok();
        eprintln!("read_file_base64_inner_accepts_background_registered_root PASSED");
    }

    /// A file over MAX_BASE64_READ_BYTES is refused outright (never
    /// silently truncated — a truncated PNG is not a valid image, unlike
    /// read_file's text-truncation-with-marker convenience for a tool
    /// preview).
    #[test]
    fn read_file_base64_inner_refuses_file_over_the_size_ceiling() {
        let root = make_temp_test_dir("base64_too_large");
        let oversized = vec![0u8; (MAX_BASE64_READ_BYTES + 1) as usize];
        std::fs::write(root.join("huge.png"), &oversized).unwrap();
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        let path = format!("{}/huge.png", root_str);

        let result = read_file_base64_inner(&path, &[root_str]);
        assert!(result.is_err(), "expected an over-ceiling file to be refused, got size {} bytes", oversized.len());
        assert!(result.unwrap_err().contains("read ceiling"));

        std::fs::remove_dir_all(&root).ok();
        eprintln!("read_file_base64_inner_refuses_file_over_the_size_ceiling PASSED");
    }

    // ── read_text_file / append_to_file (Phase 6 trace journal: the two
    // commands traceJournal.ts calls to persist run-traces.jsonl to disk) ──

    /// read_text_file_inner reads back the full content of an existing file
    /// inside a registered project root — the happy path readTraceEntries
    /// relies on to load the whole journal for line-by-line parsing.
    #[test]
    fn read_text_file_inner_reads_existing_file_inside_project_root() {
        let root = make_temp_test_dir("read_text_ok");
        std::fs::write(root.join("run-traces.jsonl"), "{\"a\":1}\n{\"b\":2}\n").unwrap();
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        let path = format!("{}/run-traces.jsonl", root_str);

        let result = read_text_file_inner(&path, &[root_str]);
        assert_eq!(result, Ok("{\"a\":1}\n{\"b\":2}\n".to_string()));

        std::fs::remove_dir_all(&root).ok();
        eprintln!("read_text_file_inner_reads_existing_file_inside_project_root PASSED");
    }

    /// A path outside every registered root must be denied — same
    /// containment guarantee as every other read command in this file.
    #[test]
    fn read_text_file_inner_rejects_path_outside_every_registered_root() {
        let root = make_temp_test_dir("read_text_deny_root");
        let outside = make_temp_test_dir("read_text_deny_outside");
        std::fs::write(outside.join("evil.jsonl"), "{}").unwrap();

        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        let outside_str = outside.canonicalize().unwrap().to_string_lossy().to_string();
        let path = format!("{}/evil.jsonl", outside_str);

        let result = read_text_file_inner(&path, &[root_str]);
        assert!(result.is_err(), "expected a path outside every registered root to be denied, got: {:?}", result);
        assert!(result.unwrap_err().contains("outside"));

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
        eprintln!("read_text_file_inner_rejects_path_outside_every_registered_root PASSED");
    }

    /// append_to_file_inner must be refused for a path outside every
    /// registered project root — the jail must hold for the append path
    /// exactly like it does for write_file, or this is an arbitrary-file-
    /// write primitive exposed to a managed agent's tool calls.
    #[test]
    fn append_to_file_inner_rejects_path_outside_every_registered_root() {
        let root = make_temp_test_dir("append_deny_root");
        let outside = make_temp_test_dir("append_deny_outside");

        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        let outside_str = outside.canonicalize().unwrap().to_string_lossy().to_string();
        let path = format!("{}/evil.jsonl", outside_str);

        let result = append_to_file_inner(&path, "{\"x\":1}\n", &[root_str]);
        assert!(result.is_err(), "expected an append outside every registered root to be denied, got: {:?}", result);
        assert!(!outside.join("evil.jsonl").exists(), "the jail must prevent the file from being created at all");

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
        eprintln!("append_to_file_inner_rejects_path_outside_every_registered_root PASSED");
    }

    /// append_to_file_inner creates the file (and its content) when it does
    /// not exist yet — the very first trace entry of a fresh project's
    /// run-traces.jsonl.
    #[test]
    fn append_to_file_inner_creates_file_when_missing() {
        let root = make_temp_test_dir("append_create");
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        let path = format!("{}/.lazy/run-traces.jsonl", root_str);

        let result = append_to_file_inner(&path, "{\"a\":1}\n", &[root_str]);
        assert!(result.is_ok(), "expected the missing file (and parent dir) to be created, got: {:?}", result);

        let written = std::fs::read_to_string(root.join(".lazy").join("run-traces.jsonl")).unwrap();
        assert_eq!(written, "{\"a\":1}\n");

        std::fs::remove_dir_all(&root).ok();
        eprintln!("append_to_file_inner_creates_file_when_missing PASSED");
    }

    /// append_to_file_inner concatenates onto an existing file's content
    /// rather than overwriting it — the append-only property the trace
    /// journal depends on across multiple node completions.
    #[test]
    fn append_to_file_inner_concatenates_onto_existing_content() {
        let root = make_temp_test_dir("append_concat");
        std::fs::write(root.join("run-traces.jsonl"), "{\"a\":1}\n").unwrap();
        let root_str = root.canonicalize().unwrap().to_string_lossy().to_string();
        let path = format!("{}/run-traces.jsonl", root_str);

        let first = append_to_file_inner(&path, "{\"b\":2}\n", &[root_str.clone()]);
        assert!(first.is_ok(), "expected first append to succeed, got: {:?}", first);
        let second = append_to_file_inner(&path, "{\"c\":3}\n", &[root_str]);
        assert!(second.is_ok(), "expected second append to succeed, got: {:?}", second);

        let written = std::fs::read_to_string(root.join("run-traces.jsonl")).unwrap();
        assert_eq!(written, "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n");

        std::fs::remove_dir_all(&root).ok();
        eprintln!("append_to_file_inner_concatenates_onto_existing_content PASSED");
    }
}
