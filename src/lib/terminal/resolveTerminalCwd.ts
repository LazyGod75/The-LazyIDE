/* resolveTerminalCwd.ts — pure "where should a NEW terminal spawn" decision.
   DEFECT 1 fix (Code space terminal panel opening in the workspace parent,
   e.g. `PS C:\Users\user\Documents\cerveau>` instead of the active
   project): TerminalStrip.tsx used to pass NO `cwd` at all to TerminalView,
   so the Rust side's `resolve_spawn_cwd(None)` fell back to
   `std::env::current_dir()` — the Tauri process's own launch directory, not
   any project the app tracks (src-tauri/src/commands/terminal.rs).

   This is intentionally NOT a component — no hooks, no I/O, no fs check.
   Two authoritative sources the app ALREADY tracks, preferred in order:
     1. `activeFileProjectRoot` — the open file's OWNING project (CodeSpace.tsx's
        `findOwningProject(activeTabPath, openProjects)`, lib/agents/projectForPath.ts).
        Most specific: matches what the user is actually looking at.
     2. `fallbackProjectRoot` — AppContext's `projectRoot`, the left-rail/
        app-wide active project. Used when no file is open yet (a fresh
        Code space with a project loaded but no tab opened).
   Neither set → `undefined`, same contract TerminalView already has for "no
   project open yet" (see TerminalView.test.tsx's own case for this).

   Deliberately does NOT touch disk: a `root` that no longer exists there
   (a registered project whose folder was since deleted/moved — the same
   class of failure CodeSidebarProjects.tsx's `treeError` already handles
   for the file tree) is passed straight through. Rust's own
   `resolve_spawn_cwd` already rejects a missing directory with an honest
   "Working directory does not exist: ..." error, and TerminalView.tsx's
   spawn `.catch()` already surfaces that in the pane + a toast (both
   pre-existing, already tested) — duplicating that check here would just be
   a second, racier copy of the same validation.
*/

export interface ResolveTerminalCwdOptions {
  /** The open file's owning project root, or `null`/`undefined` when no
   *  file is open (no active tab) or the open file has no owning project. */
  activeFileProjectRoot: string | null | undefined;
  /** AppContext's `projectRoot` — the app-wide active project, used when
   *  `activeFileProjectRoot` isn't available. May be `''` before any
   *  project has ever been registered. */
  fallbackProjectRoot: string | null | undefined;
}

/** Trims and treats an empty/whitespace-only string as "not set" — a
 *  registered project entry with a blank `root` (or a fallback that never
 *  got hydrated yet) must fall through to the next tier rather than
 *  spawning the PTY with `cwd: ''`. */
function presence(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveTerminalCwd(options: ResolveTerminalCwdOptions): string | undefined {
  return presence(options.activeFileProjectRoot) ?? presence(options.fallbackProjectRoot);
}
