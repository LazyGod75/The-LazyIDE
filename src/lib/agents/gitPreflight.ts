/* gitPreflight.ts — P43 git preflight for the mission runner's merge step.

   ROOT CAUSE ALREADY FIXED (Rust-side, prior wave): a project's `.gitignore`
   excluding `.lazy/`/`.lazybrain/` is already ensured on EVERY project open
   (src-tauri/src/commands/brain/project_gitignore.rs's
   `ensure_project_gitignore_excludes_scaffolding`, wired into `set_project`
   in config.rs) — BEFORE any mission scaffolding ever exists. That fix is
   exactly why `agent_merge_worktree_inner`'s own `git add -A` (git.rs) can
   safely stage a mission worktree's changes without ever picking up this
   app's own infra: the worktree carries the repo's tracked `.gitignore`, so
   `.lazy/`/`.lazybrain/` are never staged from "the runner's own paths" in
   the first place. Nothing further is needed there, and this module never
   duplicates it.

   THIS MODULE's job is deliberately narrower and GENERIC: catch the
   remaining real-world case the gitignore fix above cannot — the mission
   worktree and the main working tree BOTH independently carry an untracked
   copy of some OTHER path (any ordinary file, never app scaffolding, which
   is already gitignored and therefore excluded by isAgentInfraPath below as
   defense-in-depth only). That is exactly the "The following untracked
   working tree files would be overwritten by merge" class of failure
   git.rs's own comments describe — refused BEFORE the merge is even
   attempted, surfaced through the existing ApproveBlockedError path instead
   of a raw git failure toast.

   Deliberately pure + injectable (mirrors devPreview.ts's DevPreviewDeps
   convention): computeCollidingUntrackedPaths is pure path-set math, fully
   unit-tested standalone with no I/O; checkMergeUntrackedCollision is the
   only piece that reads real git status, via getPlatform().git.status(...)
   — the SAME platform boundary already wrapping the existing `git_status`
   Tauri command (see src/lib/platform/tauri.ts) — never a new Rust command.

   RESIDUE FOR WHOEVER OWNS agentsStore.tsx's approveMission (out of this
   wave's ownership, concurrently worked on): this module is NOT yet wired
   into the actual "Merger" click path (mergeWorktree() in runtime.ts /
   approveMission in agentsStore.tsx). Wiring it in is a small, mechanical
   addition — call checkMergeUntrackedCollision(repoPath, branch) right
   before mergeWorktree(...), and if it returns a non-empty list, throw
   buildUntrackedCollisionError(collisions, t) instead of ever calling
   mergeWorktree at all.
*/

import { getPlatform } from '../platform/index.js';
import type { GitFile } from '../platform/types.js';
import { joinPath } from '../paths.js';
import { ApproveBlockedError } from '../../components/agents/approveGate.js';

// ── App-infra exclusion (defense-in-depth mirror of git.rs's
// is_agent_infra_path — see this module's header: the root cause is already
// fixed via .gitignore, this is a belt-and-braces double check, never the
// primary mechanism) ────────────────────────────────────────────────────

const AGENT_INFRA_EXACT = ['.lazy', '.lazybrain'];
const AGENT_INFRA_PREFIXES = ['.lazy/', '.lazybrain/'];

function isAgentInfraPath(relPath: string): boolean {
  // path-lint-ignore: relPath is a git-relative path (git status output),
  // never a raw canonicalize() path — no verbatim prefix to strip here.
  const normalized = relPath.replace(/\\/g, '/');
  return AGENT_INFRA_EXACT.includes(normalized) || AGENT_INFRA_PREFIXES.some((p) => normalized.startsWith(p));
}

function comparablePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// ── Pure collision math ──────────────────────────────────────────────

/**
 * Pure: which of the target repo's OWN untracked files (`mainFiles`) sit at
 * the SAME path as something the mission worktree is about to
 * introduce/modify (`worktreeFiles`) — i.e. would genuinely collide once
 * `agent_merge_worktree_inner`'s `git add -A` + `git merge` runs. A
 * worktree's own `git status` already reports every path that `git add -A`
 * would stage (its own uncommitted work-in-progress), which is exactly what
 * a real merge would bring in.
 *
 * Excludes this app's own `.lazy/`/`.lazybrain` scaffolding on both sides —
 * already handled at the root by the gitignore fix (see this module's
 * header); a real collision here is always some OTHER, genuinely untracked
 * path.
 */
export function computeCollidingUntrackedPaths(
  mainFiles: readonly GitFile[],
  worktreeFiles: readonly GitFile[],
): string[] {
  const mainUntracked = new Set(
    mainFiles.filter((f) => f.status === '?' && !isAgentInfraPath(f.path)).map((f) => comparablePath(f.path)),
  );
  if (mainUntracked.size === 0) return [];

  const collisions = new Set<string>();
  for (const f of worktreeFiles) {
    if (isAgentInfraPath(f.path)) continue;
    if (mainUntracked.has(comparablePath(f.path))) collisions.add(f.path);
  }
  return Array.from(collisions).sort();
}

// ── Worktree path derivation (mirrors git.rs's agent_merge_worktree_inner's
// `safe_branch` sanitization) ──────────────────────────────────────────

/**
 * ASCII mirror of git.rs's `safe_branch` derivation (alphanumeric/-/_ kept,
 * everything else becomes '-') — real branch names this app itself
 * generates are always ASCII slugs, so full Unicode parity with Rust's
 * `char::is_alphanumeric()` is not needed in practice.
 */
export function worktreePathForBranch(repoPath: string, branch: string): string {
  const safeBranch = Array.from(branch)
    .map((c) => (/[A-Za-z0-9_-]/.test(c) ? c : '-'))
    .join('');
  return joinPath(repoPath, '.lazy', 'worktrees', safeBranch);
}

// ── Orchestration (injectable — mirrors devPreview.ts's DevPreviewDeps) ──

export interface GitPreflightDeps {
  /** Same contract as `getPlatform().git.status(path)` (tauri.ts) — a
   *  repo/worktree path that fails to resolve (not a git repo yet, worktree
   *  removed) degrades to an empty file list rather than throwing. */
  gitStatus: (path: string) => Promise<{ files: readonly GitFile[] }>;
}

const realDeps: GitPreflightDeps = {
  gitStatus: (path) => getPlatform().git.status(path),
};

/**
 * Preflight check for a mission's merge: returns the list of the target
 * repo's untracked paths that would collide with what the mission worktree
 * is about to introduce (see computeCollidingUntrackedPaths) — empty when
 * the merge is safe to attempt. Never throws: a `gitStatus` failure on
 * either side (repo not found, worktree already cleaned up) degrades to "no
 * files seen there", same fail-open posture as preflight.ts's own
 * checkConflicts for a query that cannot be answered.
 */
export async function checkMergeUntrackedCollision(
  repoPath: string,
  branch: string,
  deps: GitPreflightDeps = realDeps,
): Promise<string[]> {
  const worktreePath = worktreePathForBranch(repoPath, branch);
  const empty = { files: [] as GitFile[] };
  const [main, worktree] = await Promise.all([
    deps.gitStatus(repoPath).catch(() => empty),
    deps.gitStatus(worktreePath).catch(() => empty),
  ]);
  return computeCollidingUntrackedPaths(main.files, worktree.files);
}

/**
 * Builds the ApproveBlockedError for a non-empty collision list — construct
 * only, never throws itself (same "construct, caller decides when to
 * throw" convention approveGate.ts's checkApproveGate already uses).
 * Accepts `t` as a parameter rather than importing a hook (this is a plain
 * lib module, no React context) — same convention activityFeedFormat.ts's
 * buildFeedEntries already follows for i18n strings assembled outside a
 * component.
 */
export function buildUntrackedCollisionError(
  collisions: readonly string[],
  t: (key: string, params?: Record<string, string | number>) => string,
): ApproveBlockedError {
  return new ApproveBlockedError(t('agents.merge.untrackedCollision', { files: collisions.join(', ') }));
}
