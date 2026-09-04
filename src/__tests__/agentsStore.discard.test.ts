/**
 * Regression coverage for the 4th Windows "\\?\" verbatim-path bug:
 * agentsStore.tsx's discardMission (the "Rejeter" cockpit action)
 * reconstructed the worktree path with a hardcoded '/' template literal
 * (`${repoPath}/.lazy/worktrees/${safeBranch}`). repoPath is typically
 * get_project_root's canonicalized result, which on Windows is
 * \\?\-prefixed (verbatim) — a literal '/' there produces a
 * mixed-separator string Rust's Path::canonicalize() cannot resolve,
 * breaking discard on Windows even though the directory exists on disk.
 *
 * resolveDiscardWorktreePath is the exported, pure path-construction piece
 * of discardMission (mirrors evaluator.ts's exported resolveWorktreePath,
 * tested the same way) — see agentsStore.tsx for where discardMission
 * calls it. Built on the shared joinPath() helper from src/lib/paths.ts.
 */

import { describe, it, expect } from 'vitest';
import { resolveDiscardWorktreePath } from '../components/agents/agentsStore';

describe('resolveDiscardWorktreePath', () => {
  it('builds a same-separator worktree path for a Windows \\?\\ verbatim repoPath — no literal "/" injected', () => {
    // Plain escaped string, not String.raw`...` — a trailing backslash right
    // before a closing backtick would be lexed as an escaped backtick (see
    // src/lib/paths.ts's header comment).
    const repoPath = '\\\\?\\C:\\Users\\user\\Documents\\cerveau\\Lazy';
    const result = resolveDiscardWorktreePath(repoPath, 'agent/m-review-fix-thing');

    expect(result).toBe(
      '\\\\?\\C:\\Users\\user\\Documents\\cerveau\\Lazy\\.lazy\\worktrees\\agent-m-review-fix-thing',
    );
    expect(result).not.toContain('/');
  });

  it('builds a forward-slash worktree path for a POSIX repoPath (no behavior change)', () => {
    const result = resolveDiscardWorktreePath('/repo', 'agent/x');
    expect(result).toBe('/repo/.lazy/worktrees/agent-x');
  });

  it('sanitizes non-alphanumeric branch characters the same way as before (same regex as the old inline code)', () => {
    const result = resolveDiscardWorktreePath('/repo', 'agent/weird.branch name!');
    expect(result).toBe('/repo/.lazy/worktrees/agent-weird-branch-name-');
  });

  it('trims a trailing separator from repoPath before joining (no doubled separator)', () => {
    const result = resolveDiscardWorktreePath('C:\\Users\\user\\Lazy\\', 'agent/x');
    expect(result).toBe('C:\\Users\\user\\Lazy\\.lazy\\worktrees\\agent-x');
  });
});
