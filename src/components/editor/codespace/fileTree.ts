/* fileTree.ts — small, real-fs-backed directory tree for the Code space's
   multi-project sidebar (design-code.md §4.2). Deliberately NOT a reuse of
   FileExplorer.tsx's heavier virtualized/rename/drag tree — the redesign's
   sidebar renders N trees side by side (one per open project) with a much
   simpler per-row visual contract (color dot, agent indicator, git badge),
   so a minimal lazy-expand tree keeps each project's footprint small.
*/

import type { DirEntry, Platform } from '../../../lib/platform/types';
import { stripVerbatimPrefix } from '../../../lib/paths';

/** Internal IDE directories that must never surface in the file tree —
 *  mirrors FileExplorer.tsx's own HIDDEN_DIRS so the two trees stay
 *  consistent about what counts as "project files". */
const HIDDEN_DIRS = new Set(['.lazybrain', '.lazy', '.git', 'node_modules']);

export interface CodeTreeNode {
  entry: DirEntry;
  /** null = children not fetched yet (collapsed, never expanded). */
  children: CodeTreeNode[] | null;
  isExpanded: boolean;
}

/** Directories first (alpha), then files (alpha) — stable, predictable
 *  ordering matching most editors' file trees. */
export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Reads one directory level and returns freshly-built (unexpanded) nodes. */
export async function loadLevel(platform: Platform, dirPath: string): Promise<CodeTreeNode[]> {
  const entries = await platform.fs.readDir(dirPath);
  const visible = entries.filter((e) => !(e.isDir && HIDDEN_DIRS.has(e.name)));
  return sortEntries(visible).map((entry) => ({ entry, children: null, isExpanded: false }));
}

/** Project-relative path (forward-slash normalized) for a file/dir under
 *  `root`. Falls back to the raw path when it doesn't actually start with
 *  root (defensive — should not happen for anything reachable via the
 *  tree itself).
 *
 *  Strips a leading `\\?\` / `\\?\UNC\` (Windows extended-length /
 *  "verbatim") prefix from BOTH sides via paths.ts's shared
 *  stripVerbatimPrefix before comparing — `root` and `path` frequently come
 *  from different sources (a project root from `get_project_root`'s Rust
 *  `canonicalize()`, always verbatim-prefixed on Windows, vs. a tab path
 *  from `readDir`/an editor open call, which may or may not be) and a
 *  mismatch on just this prefix used to make `startsWith` fail even for a
 *  file genuinely under `root`, falling through to the raw path with its
 *  `\\?\` prefix intact — e.g. the Code space breadcrumb splitting that
 *  prefix's `?` into its own leading crumb. See paths.ts's header comment
 *  for this bug class's history across the codebase. */
export function relativeToRoot(root: string, path: string): string {
  const normalizedRoot = stripVerbatimPrefix(root).replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedPath = stripVerbatimPrefix(path).replace(/\\/g, '/');
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath;
}

/** Replaces the node at `targetPath` (by DirEntry.path) anywhere in the
 *  tree with the result of `updater`, immutably. Used to expand/collapse a
 *  single node without rebuilding the whole tree. */
export function updateNodeAt(
  nodes: CodeTreeNode[],
  targetPath: string,
  updater: (node: CodeTreeNode) => CodeTreeNode,
): CodeTreeNode[] {
  return nodes.map((node) => {
    if (node.entry.path === targetPath) return updater(node);
    if (node.children) return { ...node, children: updateNodeAt(node.children, targetPath, updater) };
    return node;
  });
}
