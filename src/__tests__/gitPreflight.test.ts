/**
 * gitPreflight.test.ts — P43 git preflight for the mission runner's merge
 * step. Covers the pure collision math (computeCollidingUntrackedPaths),
 * worktree path derivation, and the injectable orchestration wrapper — see
 * src/lib/agents/gitPreflight.ts's own module header for the full context
 * (the root cause — .gitignore covering .lazy/.lazybrain — is already fixed
 * Rust-side; this module covers the remaining generic untracked-collision
 * case).
 */

import { describe, it, expect, vi } from 'vitest';
import type { GitFile } from '../lib/platform/types';
import {
  computeCollidingUntrackedPaths,
  worktreePathForBranch,
  checkMergeUntrackedCollision,
  buildUntrackedCollisionError,
  type GitPreflightDeps,
} from '../lib/agents/gitPreflight';

function gf(path: string, status: GitFile['status']): GitFile {
  return { path, status };
}

// ── computeCollidingUntrackedPaths (pure) ───────────────────────────────

describe('computeCollidingUntrackedPaths', () => {
  it('returns [] when the main repo has no untracked files at all', () => {
    const main: GitFile[] = [gf('src/app.ts', 'M')];
    const worktree: GitFile[] = [gf('notes.md', '?')];
    expect(computeCollidingUntrackedPaths(main, worktree)).toEqual([]);
  });

  it('returns [] when nothing on the worktree side touches the same path', () => {
    const main: GitFile[] = [gf('notes.md', '?')];
    const worktree: GitFile[] = [gf('src/app.ts', 'M')];
    expect(computeCollidingUntrackedPaths(main, worktree)).toEqual([]);
  });

  it('flags a real collision: same untracked path on both sides', () => {
    const main: GitFile[] = [gf('scratch/output.json', '?')];
    const worktree: GitFile[] = [gf('scratch/output.json', 'A')];
    expect(computeCollidingUntrackedPaths(main, worktree)).toEqual(['scratch/output.json']);
  });

  it('is case-insensitive and separator-normalizing (Windows paths)', () => {
    const main: GitFile[] = [gf('Scratch\\Output.json', '?')];
    const worktree: GitFile[] = [gf('scratch/output.json', 'A')];
    expect(computeCollidingUntrackedPaths(main, worktree)).toEqual(['scratch/output.json']);
  });

  it('excludes .lazy/ and .lazybrain/ scaffolding on both sides (already fixed at the root via .gitignore)', () => {
    const main: GitFile[] = [gf('.lazybrain/brain/_cache/fts.sqlite', '?'), gf('.lazy/agents/foo.json', '?')];
    const worktree: GitFile[] = [gf('.lazybrain/brain/_cache/fts.sqlite', 'A'), gf('.lazy/agents/foo.json', 'A')];
    expect(computeCollidingUntrackedPaths(main, worktree)).toEqual([]);
  });

  it('sorts and dedupes the returned collision list', () => {
    const main: GitFile[] = [gf('b.txt', '?'), gf('a.txt', '?')];
    const worktree: GitFile[] = [gf('b.txt', 'A'), gf('a.txt', 'M'), gf('a.txt', 'A')];
    expect(computeCollidingUntrackedPaths(main, worktree)).toEqual(['a.txt', 'b.txt']);
  });

  it('a main file that is tracked-but-modified (not untracked) never collides', () => {
    // Only '?' (untracked) on the main side is a real "would be overwritten
    // by merge" risk — a tracked modification is an ordinary merge concern
    // git itself already handles (conflict markers), not this module's job.
    const main: GitFile[] = [gf('src/shared.ts', 'M')];
    const worktree: GitFile[] = [gf('src/shared.ts', 'M')];
    expect(computeCollidingUntrackedPaths(main, worktree)).toEqual([]);
  });
});

// ── worktreePathForBranch ────────────────────────────────────────────────

describe('worktreePathForBranch', () => {
  it('mirrors git.rs\'s safe_branch sanitization for a plain slug', () => {
    expect(worktreePathForBranch('C:\\proj\\demo', 'agent/M9')).toBe('C:\\proj\\demo\\.lazy\\worktrees\\agent-M9');
  });

  it('keeps alphanumeric, - and _ untouched', () => {
    expect(worktreePathForBranch('/repo', 'feat_my-branch123')).toBe('/repo/.lazy/worktrees/feat_my-branch123');
  });

  it('replaces every other character with -', () => {
    expect(worktreePathForBranch('/repo', 'agent:M9@2')).toBe('/repo/.lazy/worktrees/agent-M9-2');
  });
});

// ── checkMergeUntrackedCollision (injectable orchestration) ─────────────

describe('checkMergeUntrackedCollision', () => {
  function makeDeps(overrides: Partial<GitPreflightDeps> = {}): GitPreflightDeps {
    return {
      gitStatus: vi.fn().mockResolvedValue({ files: [] }),
      ...overrides,
    };
  }

  it('returns [] when neither side reports anything untracked', async () => {
    const deps = makeDeps();
    const result = await checkMergeUntrackedCollision('C:\\proj\\demo', 'agent/M1', deps);
    expect(result).toEqual([]);
  });

  it('queries git_status for both the repo root AND the derived worktree path', async () => {
    const gitStatus = vi.fn().mockResolvedValue({ files: [] });
    const deps = makeDeps({ gitStatus });

    await checkMergeUntrackedCollision('C:\\proj\\demo', 'agent/M1', deps);

    expect(gitStatus).toHaveBeenCalledWith('C:\\proj\\demo');
    expect(gitStatus).toHaveBeenCalledWith('C:\\proj\\demo\\.lazy\\worktrees\\agent-M1');
  });

  it('surfaces a real collision end to end', async () => {
    const gitStatus = vi.fn().mockImplementation(async (path: string) => {
      if (path === 'C:\\proj\\demo') return { files: [gf('generated/report.txt', '?')] };
      return { files: [gf('generated/report.txt', 'A')] };
    });
    const deps = makeDeps({ gitStatus });

    const result = await checkMergeUntrackedCollision('C:\\proj\\demo', 'agent/M1', deps);

    expect(result).toEqual(['generated/report.txt']);
  });

  it('degrades to no collision (never throws) when a gitStatus call rejects', async () => {
    const gitStatus = vi.fn().mockRejectedValue(new Error('not a git repository'));
    const deps = makeDeps({ gitStatus });

    await expect(checkMergeUntrackedCollision('C:\\proj\\demo', 'agent/M1', deps)).resolves.toEqual([]);
  });
});

// ── buildUntrackedCollisionError ─────────────────────────────────────────

describe('buildUntrackedCollisionError', () => {
  it('constructs (never throws) an ApproveBlockedError carrying the translated, file-listing reason', () => {
    const t = vi.fn((key: string, params?: Record<string, string | number>) => `${key}:${JSON.stringify(params)}`);

    const error = buildUntrackedCollisionError(['a.txt', 'b.txt'], t);

    expect(error.name).toBe('ApproveBlockedError');
    expect(t).toHaveBeenCalledWith('agents.merge.untrackedCollision', { files: 'a.txt, b.txt' });
    expect(error.reason).toBe(t.mock.results[0].value);
  });
});
