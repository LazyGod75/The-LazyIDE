/* projectForPath.ts — pure "which open project owns this absolute path"
   lookup, shared across the Code space's sidebar/banner/status-bar/tabs.
   A tab's path may point either at a project's own working copy or at one
   of its mission worktrees (`<root>/.lazy/worktrees/<branch>/...`) — both
   resolve to the SAME owning project, since the worktree lives under the
   project's own root.
*/

import { basename, isPathWithinRoot, normalizeForPathCompare } from '../paths.js';

export interface ProjectLike {
  id: string;
  root: string;
}

/**
 * Finds the open project whose root is a prefix of `path` (i.e. `path` is
 * that project's own file or lives under one of its mission worktrees).
 * When multiple open projects are nested (rare, but not impossible), the
 * LONGEST matching root wins — the most specific owner.
 *
 * Comparison goes through paths.ts's isPathWithinRoot (verbatim-prefix
 * stripped, case-folded — see that helper's doc comment) rather than a
 * bare separator-only normalize: `project.root` is typically Rust
 * canonicalize() output (verbatim-prefixed) while `path` (an editor tab
 * path) may not be, and either side's drive letter can carry different
 * case than the other — the same mismatch class that caused
 * missionScopeGuard.ts's false-positive incident (2026-08-02).
 */
export function findOwningProject<T extends ProjectLike>(path: string, openProjects: readonly T[]): T | null {
  let best: T | null = null;
  let bestLength = -1;
  for (const project of openProjects) {
    if (!isPathWithinRoot(project.root, path)) continue;
    const rootLength = normalizeForPathCompare(project.root).length;
    if (rootLength > bestLength) {
      best = project;
      bestLength = rootLength;
    }
  }
  return best;
}

/**
 * Resolves a step's declared `extraReadableProjectIds` (raw id/name/path
 * strings — same resolve-by-id-or-name convention as agentsStore.tsx's
 * `resolveDraftProjectId`, whose async, Tauri-backed version is what
 * actually runs at mission-launch time) to real, currently-open project
 * ROOTS, purely from an already-loaded `openProjects` list — no I/O, so
 * this is safe to call synchronously from a render (GraphProposalCard's
 * out-of-scope check, which needs `findOutOfScopeTaskPath`'s third argument
 * — already-resolved roots, not ids). Each declared entry matches either:
 *   - an open project's root itself (path-equality via
 *     `normalizeForPathCompare`, handling a raw path OR an already-`root`-
 *     shaped id, case/verbatim-prefix/separator insensitive), or
 *   - an open project's `basename(root)` (case-insensitive name match).
 * An entry matching neither is silently dropped (never widens scope to
 * "every open project") — same honest "don't guess" contract every other
 * id-or-name resolver in this codebase already follows. Duplicate-safe:
 * the same root is never returned twice even if two declared entries
 * resolve to it.
 */
export function resolveDeclaredProjectRoots<T extends ProjectLike>(
  declared: readonly string[] | undefined,
  openProjects: readonly T[],
): string[] {
  if (!declared || declared.length === 0) return [];
  const roots: string[] = [];
  for (const raw of declared) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const normalizedTarget = normalizeForPathCompare(trimmed);
    const byPath = openProjects.find((p) => normalizeForPathCompare(p.root) === normalizedTarget);
    const needle = trimmed.toLowerCase();
    const match = byPath ?? openProjects.find((p) => basename(p.root).toLowerCase() === needle);
    if (match && !roots.includes(match.root)) roots.push(match.root);
  }
  return roots;
}
