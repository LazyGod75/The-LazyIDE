/**
 * Git worktree helpers for the CLI agent command.
 * Mirrors agent_create_worktree / agent_discard_worktree / agent_worktree_diff in lib.rs.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const GIT = 'git';

function gitSync(args: string[], cwd: string): string {
  const result = execFileSync(GIT, args, { cwd, encoding: 'utf-8' });
  return result.trim();
}

/** Check that a directory is a git repository. */
export function assertGitRepo(repoPath: string): void {
  const result = spawnSync(GIT, ['rev-parse', '--git-dir'], {
    cwd: repoPath,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`'${repoPath}' is not a git repository`);
  }
}

/** Sanitize a string for use as a git branch name / dir name. */
function sanitize(s: string): string {
  return s
    .split('')
    .map(c => (/[\w-]/.test(c) ? c : '-'))
    .join('');
}

/** Create a git worktree for an agent mission.
 *  Returns the absolute worktree path.
 */
export function createWorktree(repoPath: string, branch: string): string {
  assertGitRepo(repoPath);

  const safeBranch = sanitize(branch);
  const wtPath = join(repoPath, '.lazy', 'worktrees', safeBranch);

  gitSync(['worktree', 'add', '-b', branch, wtPath], repoPath);
  return wtPath;
}

/** Get a unified diff of all changes in a worktree (tracked + untracked new files). */
export function worktreeDiff(worktreePath: string): string {
  const trackedDiff = spawnSync(GIT, ['diff', 'HEAD'], {
    cwd: worktreePath,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  let diff = trackedDiff.stdout ?? '';

  // Untracked files
  const ls = spawnSync(GIT, ['ls-files', '--others', '--exclude-standard'], {
    cwd: worktreePath,
    stdio: 'pipe',
    encoding: 'utf-8',
  });

  const untracked = (ls.stdout ?? '').trim();
  if (untracked) {
    for (const fname of untracked.split('\n').filter(Boolean)) {
      const fpath = join(worktreePath, fname);
      if (!existsSync(fpath)) continue;
      const content = readFileSync(fpath, 'utf-8');
      const lineCount = content.split('\n').length;
      diff += `\n--- /dev/null\n+++ b/${fname}\n@@ -0,0 +1,${lineCount} @@\n`;
      for (const line of content.split('\n')) {
        diff += `+${line}\n`;
      }
    }
  }

  return diff;
}

/** Commit everything in the worktree branch and merge into main, then clean up. */
export function mergeWorktree(repoPath: string, branch: string): void {
  const safeBranch = sanitize(branch);
  const wtPath = join(repoPath, '.lazy', 'worktrees', safeBranch);

  // Stage all
  gitSync(['add', '-A'], wtPath);

  // Check if there's something to commit
  const status = spawnSync(GIT, ['status', '--porcelain'], {
    cwd: wtPath,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  const hasChanges = (status.stdout ?? '').trim().length > 0;

  if (hasChanges) {
    gitSync(['commit', '-m', `feat(agent): mission on ${branch}`], wtPath);
  }

  // Merge into current branch
  gitSync(['merge', '--no-ff', branch, '-m', `merge(agent): ${branch}`], repoPath);

  // Post-merge push (plumbing parity with the Tauri app's approveMission:
  // the merge alone leaves the work local-only; this leg pushes when the
  // repo HAS a remote + upstream, and honestly reports the skip otherwise —
  // a local-only project (no remote) must still work, never error).
  pushIfPossible(repoPath, branch);

  // Remove worktree
  spawnSync(GIT, ['worktree', 'remove', '--force', wtPath], {
    cwd: repoPath,
    stdio: 'pipe',
  });

  // Delete branch
  spawnSync(GIT, ['branch', '-d', branch], {
    cwd: repoPath,
    stdio: 'pipe',
  });
}

/**
 * Best-effort, honest post-merge push (CLI flavor of the app's
 * missionPush.ts contract). Three outcomes, all reported to stderr:
 *   - pushed              -> `git push` exited 0
 *   - skipped (no remote / no upstream) -> merge stays local; NOT an error,
 *     because a local-only project has nowhere to push
 *   - failed (real error) -> merge is local-only; surfaced so the user knows
 *     the remote does NOT have the work
 * NEVER throws: a push hiccup must never turn a successful merge into a
 * reported failure.
 */
function pushIfPossible(repoPath: string, branch: string): void {
  // 1. Does the repo have any remote?
  const remotes = spawnSync(GIT, ['remote'], { cwd: repoPath, stdio: 'pipe', encoding: 'utf-8' });
  const hasRemote = remotes.status === 0 && (remotes.stdout ?? '').trim().length > 0;
  if (!hasRemote) {
    process.stderr.write(`[agent] Merge complete (local only — no remote configured for this project).\n`);
    return;
  }

  // 2. Does the current branch track an upstream?
  const upstream = spawnSync(GIT, ['rev-parse', '--abbrev-ref', '@{upstream}'], {
    cwd: repoPath,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (upstream.status !== 0) {
    process.stderr.write(
      `[agent] Merge complete locally — current branch has no upstream to push to.\n` +
      `[agent] To push later: git push -u origin ${branch}\n`,
    );
    return;
  }

  // 3. Real push.
  const push = spawnSync(GIT, ['push'], { cwd: repoPath, stdio: 'pipe', encoding: 'utf-8' });
  if (push.status === 0) {
    process.stderr.write(`[agent] Push complete — work is on the remote.\n`);
  } else {
    process.stderr.write(
      `[agent] Merge complete locally, but push FAILED: ${(push.stderr ?? '').trim() || 'git push error'}\n` +
      `[agent] Your work is safe on the local branch — fix the remote and push manually.\n`,
    );
  }
}

/** Discard a worktree without merging. */
export function discardWorktree(repoPath: string, branch: string): void {
  const safeBranch = sanitize(branch);
  const wtPath = join(repoPath, '.lazy', 'worktrees', safeBranch);

  spawnSync(GIT, ['worktree', 'remove', '--force', wtPath], {
    cwd: repoPath,
    stdio: 'pipe',
  });

  spawnSync(GIT, ['branch', '-D', branch], {
    cwd: repoPath,
    stdio: 'pipe',
  });
}

/** List files changed in a worktree (for display). */
export function listWorktreeFiles(worktreePath: string): string[] {
  const ls = spawnSync(GIT, ['ls-files', '--others', '--modified', '--deleted', '--exclude-standard'], {
    cwd: worktreePath,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  return (ls.stdout ?? '').trim().split('\n').filter(Boolean);
}
