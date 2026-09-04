/* paths.ts — Shared, pure path helpers for Windows "\\?\" (verbatim /
   extended-length) path handling.

   BACKGROUND: this exact bug class has already been fixed three times in
   this codebase, each time re-deriving the same logic ad hoc:
     1. cli/lib/git.ts's worktree-add used a RELATIVE destination path for
        `git worktree add` instead of an absolute one.
     2. managedAgent.ts's read_file/grep_file/edit_file tool calls needed
        stripVerbatimPrefix() because the `read_file` Tauri command rejects
        the \\?\ prefix (while `write_file` accepts it).
     3. evaluator.ts's resolveWorktreePath() had to join repoPath with a
        separator-aware join instead of a hardcoded '/': repoPath is
        typically get_project_root's Rust std::fs::canonicalize() result,
        which on Windows is \\?\-prefixed (verbatim). Verbatim paths disable
        Win32's '/'-to-'\' separator normalization, so appending
        "/foo/bar" with a literal '/' produces a mixed-separator string
        (e.g. `\\?\C:\...\Lazy/foo/bar`) that Rust's Path::canonicalize()
        fails to resolve even though the directory exists on disk.

   This module centralizes the small pure primitives behind those fixes so a
   4th instance (agentsStore.tsx's discardMission — see its
   resolveDiscardWorktreePath) — and any future one — reuses a tested helper
   instead of re-deriving the same regex/logic ad hoc.

   5th instance (QA B11, 2026-07): runtime.ts's mergeWorktree passed
   `repoPath` straight through to the `agent_merge_worktree` Tauri invoke
   with no normalization at all. resolveProjectRoot (agentsStore.tsx) has
   THREE possible sources for a project root — `get_project_root` (Rust
   canonicalize, always \\?\-prefixed backslash-only on Windows),
   `find_git_root` (git-style forward-slash, never \\?\-prefixed), and
   `get_cwd` — and callers occasionally see a value built by joining one of
   those with ANOTHER separator style upstream. A \\?\-prefixed path with
   even one stray "/" in it disables Win32's separator translation for the
   WHOLE string, so `git merge`'s `Command::current_dir` on the Rust side
   fails with the Windows-specific "os error 267" (ERROR_DIRECTORY) even
   though the directory genuinely exists — a legit, judge-approved mission
   (M11) failed to merge this way while another (M9) merged fine moments
   earlier from the same UI action. Fixed by normalizing ONCE at the
   mergeWorktree boundary (see runtime.ts) via normalizeRepoPathForGit
   below, instead of trusting every caller to have produced a clean path.
   HONESTY NOTE (2026-08-05): the original QA B11 fix only normalized
   `repoPath` — `mergeWorktree`'s `mergeIntoDir` param (the orchestrator
   fan-in merge path) stayed raw and could still hit this exact bug; now
   normalized too, and every worktree invoke in runtime.ts (createWorktree,
   worktreeDiff, discardWorktree) got the same treatment, not just merge.

   CONSOLIDATED: instances 2 and 3 above (managedAgent.ts's
   stripVerbatimPrefix, evaluator.ts's resolveWorktreePath) and
   agentsStore.tsx's resolveDiscardWorktreePath now all import stripVerbatimPrefix
   / joinPath from here instead of keeping local copies. managedAgent.ts
   re-exports stripVerbatimPrefix under its own name (managedAgent.test.ts
   imports it from there) rather than duplicating the implementation.

   6th (missionScopeGuard.ts, 2026-08-01) and 7th (projectForPath.ts /
   CodeSpace.tsx, 2026-08-02) instances are documented on
   normalizeForPathCompare's own doc comment below.

   8th instance (2026-08-15): BreadcrumbBar.tsx split a raw editor tab path
   on separators without stripping the verbatim prefix first, rendering a
   literal "?" as the breadcrumb's leading crumb. Fixed by reusing
   basename/stripVerbatimPrefix here plus a new relativeToRoot helper
   (fileTree.ts) — see that commit for the fix, and BreadcrumbBar.tsx's
   breadcrumbSegments for the current call site.

   9th instance (2026-08-15, structural-hardening pass): unlike instances
   1-8, this one was never a path VALUE reaching UI/comparison code raw —
   it was a raw path embedded mid-sentence inside a Rust command's FREE-
   TEXT error message (`nativeHealth()`'s `details.git`/`details.brain` in
   tauri.ts did `String(err)` straight from a rejected invoke(), and the
   path-jail guard's rejection text names the offending path in full), so
   the Settings Health panel rendered a literal
   `\\?\C:\Users\user\Documents\cerveau` in its technical-detail text.
   None of the whole-string helpers above apply to a value that merely
   CONTAINS a path — added stripVerbatimPrefixesInText below (scans the
   whole string for the prefix instead of only checking index 0) and wired
   it into both nativeHealth() catch handlers.

   STRUCTURAL GUARD (2026-08-15): eight-plus recurrences of the same
   mistake is a process failure, not eight unlucky ones — added a local
   ESLint rule (eslint-rules/no-raw-path-ops.js, wired up in
   eslint.config.js as local/no-raw-path-ops) that flags manual
   backslash-separator splitting/replacing and raw .startsWith()
   containment checks on path-like-named values, pointing the author back
   to this file. See that rule file's own header for why a raw `===`
   equality check was evaluated and deliberately NOT included (too noisy
   against this codebase's real usage), and why a branded NormalizedPath
   type and a single Rust->TS IPC choke point were considered and rejected
   in favor of the lint rule (no single invoke() wrapper exists in this
   codebase — invoke() is called directly ~145 times across 73 files, so
   there is no one boundary to normalize at).
*/

/** Windows extended-length ("verbatim") path prefixes. Plain escaped
 *  strings, not String.raw`...` — a trailing backslash right before the
 *  closing backtick would be lexed as an escaped backtick and corrupt the
 *  rest of the file (same caution as managedAgent.ts). */
const WIN_VERBATIM_UNC_PREFIX = '\\\\?\\UNC\\'; // literal: \\?\UNC\
const WIN_VERBATIM_PREFIX = '\\\\?\\'; // literal: \\?\

/**
 * Strips a leading `\\?\` or `\\?\UNC\` (Windows extended-length /
 * "verbatim") prefix from a path. No-op for any other path (POSIX, plain
 * Windows, or already-stripped). Mirrors managedAgent.ts's
 * stripVerbatimPrefix, which strips this prefix before paths reach the
 * `read_file` Tauri command.
 */
export function stripVerbatimPrefix(p: string): string {
  if (p.startsWith(WIN_VERBATIM_UNC_PREFIX)) {
    return '\\\\' + p.slice(WIN_VERBATIM_UNC_PREFIX.length);
  }
  if (p.startsWith(WIN_VERBATIM_PREFIX)) {
    return p.slice(WIN_VERBATIM_PREFIX.length);
  }
  return p;
}

/**
 * True when `p` is absolute: a Windows drive-letter path (`C:\...` or
 * `C:/...`), a Windows verbatim path (`\\?\...`), a UNC path
 * (`\\server\share...`), or a POSIX-rooted path (`/...`). False for
 * relative paths, empty strings, and Windows drive-relative paths (a lone
 * leading backslash with no drive letter, e.g. `\foo`) — that last case is
 * intentionally out of scope since it doesn't durably resolve without an
 * implicit current drive.
 */
export function isAbsolutePathWin(p: string): boolean {
  if (!p) return false;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true; // C:\... or C:/...
  if (p.startsWith('\\\\')) return true; // \\?\... (verbatim) or \\server\share (UNC)
  if (p.startsWith('/')) return true; // POSIX root
  return false;
}

/**
 * Joins `base` with one or more path segments, always using whichever
 * separator `base` already contains ('\' if it contains a backslash, else
 * '/') — for both the join points AND any separators found inside the
 * segments themselves, which are re-normalized to match rather than left
 * mixed. A trailing separator on `base` is trimmed first so joining never
 * produces a doubled separator.
 *
 * This mirrors how Rust's `Path::join` behaves when `base` is a Windows
 * `\\?\` (verbatim) path: verbatim paths disable '/'-as-separator handling,
 * so a reconstructed path must use '\' throughout, or Path::canonicalize()
 * on the Rust side will fail to resolve it even though the directory
 * exists on disk (see this file's header comment for the bug history).
 * Reusing whatever separator `base` already contains — rather than
 * hardcoding either one — keeps the result internally consistent for both
 * verbatim/Windows and POSIX bases, without needing to know up front which
 * platform produced `base`.
 */
export function joinPath(base: string, ...segments: string[]): string {
  const sep = base.includes('\\') ? '\\' : '/';
  const trimmedBase = base.replace(/[\\/]+$/, '');

  const normalizedSegments = segments
    .map((segment) =>
      segment
        .replace(/[\\/]+/g, sep) // never leave a segment's own separators mixed with base's
        .replace(/^[\\/]+/, '') // avoid a doubled separator at the join point
        .replace(/[\\/]+$/, ''),
    )
    .filter((segment) => segment.length > 0);

  return [trimmedBase, ...normalizedSegments].join(sep);
}

/**
 * Last path segment (Windows or POSIX separators), trailing separators
 * ignored — e.g. `C:\Users\user\demo-shop` and `/home/user/demo-shop`
 * both -> `demo-shop`. Falls back to the input unchanged when it has no
 * separator at all (already a bare name) or is empty.
 *
 * Single shared implementation for every "derive a display name from a
 * project root" call site (F5 fix, post-e2e wave — the Code sidebar used to
 * render a project's raw registry id, e.g. `7f78bbcd6f353bd...`, instead of
 * a friendly name: see CodeSidebarProjects.tsx) AND every "derive a file's
 * display name from its path" call site (e.g. a tool call's `file_path`
 * arg, see liveActionSummary.ts) — same primitive, both domains. Previously
 * re-derived ad hoc in fleetMissions.ts, activityFeedFormat.ts and
 * liveActionSummary.ts; those now import this instead of keeping local
 * copies (see this file's header for the project's policy against
 * re-deriving the same path logic ad hoc).
 */
export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/**
 * Normalizes a repo path for the `agent_merge_worktree` Tauri boundary (QA
 * B11 — see this file's header comment for the "5th instance" bug this
 * fixes). Two steps:
 *   1. Strip a leading \\?\ / \\?\UNC\ verbatim prefix (stripVerbatimPrefix)
 *      — Rust's `Command::current_dir` handles a plain Windows path fine;
 *      it is specifically the verbatim form that disables '/'-to-'\'
 *      translation and turns a stray forward slash into "os error 267".
 *   2. For a Windows-shaped result (drive letter or UNC), normalize every
 *      '/' to '\' — belt-and-braces once the verbatim guard above is gone,
 *      in case the caller's path was itself built by naively concatenating
 *      segments with '/' (git-style, e.g. resolveProjectRoot's
 *      find_git_root fallback).
 *
 * POSIX paths (dev/CI on mac/linux) pass through unchanged — this only
 * rewrites separators for a path that already looks like a Windows path.
 */
export function normalizeRepoPathForGit(p: string): string {
  const stripped = stripVerbatimPrefix(p);
  const looksWindows = /^[a-zA-Z]:[\\/]/.test(stripped) || stripped.startsWith('\\\\');
  return looksWindows ? stripped.replace(/\//g, '\\') : stripped;
}

/**
 * Normalizes a path for EQUALITY/CONTAINMENT comparison only (never for an
 * actual filesystem access): strips a verbatim `\\?\` / `\\?\UNC\` prefix
 * (a resolved project root is typically Rust `canonicalize()` output, always
 * verbatim-prefixed on Windows — see this file's header), unifies separators
 * to `\`, drops a trailing separator, and lower-cases (NTFS is
 * case-insensitive/-preserving, and the drive letter specifically is NOT
 * reliably normalized by `canonicalize()` — see src-tauri's
 * `lowercase_drive_letter` doc comment for the Rust-side twin of this fact).
 * 6th instance of this exact bug class (see this file's header for the
 * first five) — missionScopeGuard.ts's own local copy (2026-08-01) was the
 * 6th; this is the shared home other TS call sites should import instead of
 * re-deriving it locally (7th+ instance: projectForPath.ts / CodeSpace.tsx,
 * 2026-08-02 — see this file's header for the pattern this project already
 * enforces of consolidating instead of re-deriving).
 */
export function normalizeForPathCompare(path: string): string {
  return stripVerbatimPrefix(path.trim())
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

/**
 * True when `candidate` IS `root`, or lies strictly inside it — comparison
 * done via `normalizeForPathCompare` on both sides, so a verbatim-prefix or
 * drive-letter-case mismatch between two otherwise-identical paths never
 * produces a false "outside" result. Empty/blank input on either side is
 * never considered a match (an unresolved root must never accidentally
 * "contain" everything).
 */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  const r = normalizeForPathCompare(root);
  const c = normalizeForPathCompare(candidate);
  if (!r || !c) return false;
  return c === r || c.startsWith(r + '\\');
}

/**
 * Strips every `\\?\` / `\\?\UNC\` verbatim prefix found ANYWHERE inside
 * `text`, not just at index 0 — for free text that has a path embedded in
 * the middle of it rather than BEING a path, the case stripVerbatimPrefix
 * (whole-string, prefix-only) doesn't cover.
 *
 * 9th instance of this bug class (see this file's header for the first
 * eight): Settings Health panel's error details (HealthPanel.tsx's
 * `technicalDetail`) render Rust command failure text verbatim —
 * `nativeHealth()` (tauri.ts) does `details.git = String(err)` /
 * `details.brain = String(err)` straight from a rejected `invoke()` call.
 * When that failure is the path-jail guard's "access denied: '<path>' is
 * outside every registered project root" (commands/util.rs's
 * ensure_repo_in_any_open_project — see nativeHealth's own doc comment on
 * this exact message), `<path>` is frequently a canonicalize() result and
 * therefore verbatim-prefixed, so the literal `\\?\C:\Users\...` leaked
 * into the user-facing panel. A whole-string helper can't fix this: the
 * prefix sits mid-sentence, not at offset 0. Implemented as a manual
 * character scan (not a regex) for the same reason this file avoids
 * String.raw`...\`  elsewhere — see the WIN_VERBATIM_* consts' comment
 * above — a backslash-heavy regex literal is easy to mis-escape silently.
 */
export function stripVerbatimPrefixesInText(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith(WIN_VERBATIM_UNC_PREFIX, i)) {
      result += '\\\\';
      i += WIN_VERBATIM_UNC_PREFIX.length;
    } else if (text.startsWith(WIN_VERBATIM_PREFIX, i)) {
      i += WIN_VERBATIM_PREFIX.length;
    } else {
      result += text[i];
      i += 1;
    }
  }
  return result;
}
