/* missionPush.ts — POST-MERGE push for a just-approved mission (plumbing fix).
 *
 * Root cause this fixes (verified on the founder's backoffice test repo):
 * approveMissionInner merged the mission's worktree branch into the target
 * branch LOCALLY and then stopped — the repo's Git.push (tauri git_push) was
 * never called, so the merged commit stayed local. The whole mission loop
 * (worktree -> agent -> commit -> merge) worked, but nothing was ever pushed
 * to the remote: worktrees accumulated on seed commits, "main" never moved,
 * and there was no honest signal to the user about what did/didn't reach the
 * remote. This module is the missing final leg: push after a successful merge.
 *
 * Contract (honesty — "on ne te ment jamais sur ce qui a été fait"):
 *   - Never blocks the merge outcome already reported. The mission is
 *     already terminal ('done') by the time this runs; a push failure must
 *     not retroactively turn a successful merge into an error.
 *   - Never fabricates a push that didn't happen. Returns a discriminated
 *     result so the caller can journal exactly which of these occurred:
 *       pushed        — `git push` exited 0 (work IS on the remote).
 *       skipped_no_remote / skipped_no_upstream — nothing to push to; the
 *                     merge stays local, and the caller must not claim the
 *                     remote has it.
 *       failed        — a real push error (network, auth, rejected); the
 *                     merge is local-only and the caller surfaces this
 *                     honestly.
 *   - Web/mock (non-Tauri): never attempts a real push; returns the honest
 *     "no remote" skip so no test ever sees a fake push or a spurious reject.
 */

import { isTauri } from '../platform/index.js';

export type MissionPushResult =
  | { outcome: 'pushed' }
  | { outcome: 'skipped_no_remote' }
  | { outcome: 'skipped_no_upstream' }
  | { outcome: 'failed'; reason: string };

export interface MissionPushDeps {
  isTauri: () => boolean;
  repoHasRemote: (repoPath: string) => Promise<boolean>;
  repoHasUpstream: (repoPath: string) => Promise<boolean>;
  pushGit: (repoPath: string) => Promise<void>;
}

/**
 * Whether a push would even have a destination. Pure check: on the web/mock
 * platform there is never a real remote, so we short-circuit before any git
 * round trip. Returns `true` only on Tauri (where a remote may exist).
 */
export function canPushOnThisPlatform(): boolean {
  return isTauri();
}

/**
 * Push the repo's current branch to its remote, post-merge.
 *
 * On web/mock, or when the repo has no remote/upstream, this returns the
 * honest `skipped_*` result without ever touching git. On a real Tauri repo
 * with a configured remote + upstream, it runs `git push` (via the platform's
 * existing `Git.push`, which maps to Rust's `git_push`).
 *
 * NEVER throws: every failure path yields a `failed`/`skipped` result so the
 * caller can journal the truth without the push ever crashing the mission
 * lifecycle that already succeeded in merging.
 */
export async function pushAfterMissionMerge(
  repoPath: string,
  deps: MissionPushDeps,
): Promise<MissionPushResult> {
  if (!deps.isTauri || !deps.isTauri()) {
    return { outcome: 'skipped_no_remote' };
  }

  // Fast path: a repo with no remote can't be pushed — don't even inspect
  // upstream, and never claim a push that couldn't have happened.
  let hasRemote: boolean;
  try {
    hasRemote = await deps.repoHasRemote(repoPath);
  } catch {
    // Can't prove a remote exists -> treat as no-remote (honest: unknown is
    // not "pushed"), and let the caller surface the merge-as-local status.
    return { outcome: 'skipped_no_remote' };
  }
  if (!hasRemote) {
    return { outcome: 'skipped_no_remote' };
  }

  let hasUpstream: boolean;
  try {
    hasUpstream = await deps.repoHasUpstream(repoPath);
  } catch {
    hasUpstream = false;
  }
  if (!hasUpstream) {
    return { outcome: 'skipped_no_upstream' };
  }

  try {
    await deps.pushGit(repoPath);
    return { outcome: 'pushed' };
  } catch (err) {
    return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}
