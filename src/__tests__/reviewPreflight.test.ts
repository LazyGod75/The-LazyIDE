/**
 * reviewPreflight.test.ts — Trust-critical defect #1 (M53 forensics):
 * detectDiffCoverageGap must catch a mission whose diff does NOT represent
 * everything git sees in the worktree — the second, independent layer
 * behind diffParse.ts's own fix (see reviewPreflight.ts's module header for
 * the full M53 story: a real 19-file scaffold reviewed as "README.md,
 * 952 lines added").
 */

import { describe, it, expect } from 'vitest';
import type { GitFile } from '../lib/platform/types';
import { detectDiffCoverageGap, isDiffGenuinelyEmpty } from '../lib/agents/reviewPreflight';

function gf(path: string, status: GitFile['status']): GitFile {
  return { path, status };
}

describe('detectDiffCoverageGap', () => {
  it('returns [] when every git-seen change is reflected in the diff', () => {
    const gitFiles = [gf('README.md', 'M'), gf('src/App.tsx', '?')];
    const diffFiles = [{ filename: 'README.md' }, { filename: 'src/App.tsx' }];
    expect(detectDiffCoverageGap(gitFiles, diffFiles)).toEqual([]);
  });

  it('returns [] for an empty worktree (no changes at all)', () => {
    expect(detectDiffCoverageGap([], [])).toEqual([]);
  });

  // ── The M53 shape: real scaffold left untracked, diff only shows README ──
  it('flags every untracked file missing from the diff (M53 shape)', () => {
    const gitFiles = [
      gf('README.md', 'M'),
      gf('package.json', '?'),
      gf('vite.config.ts', '?'),
      gf('src/App.tsx', '?'),
      gf('src/main.tsx', '?'),
    ];
    // Only the tracked file made it into the diff — exactly what M53 saw.
    const diffFiles = [{ filename: 'README.md' }];
    expect(detectDiffCoverageGap(gitFiles, diffFiles)).toEqual([
      'package.json',
      'src/App.tsx',
      'src/main.tsx',
      'vite.config.ts',
    ]);
  });

  it('flags a modified ("M") tracked file missing from the diff, not only untracked ones', () => {
    const gitFiles = [gf('src/existing.ts', 'M')];
    const diffFiles: { filename: string }[] = [];
    expect(detectDiffCoverageGap(gitFiles, diffFiles)).toEqual(['src/existing.ts']);
  });

  it('flags an added ("A") staged file missing from the diff', () => {
    const gitFiles = [gf('src/new-staged.ts', 'A')];
    const diffFiles: { filename: string }[] = [];
    expect(detectDiffCoverageGap(gitFiles, diffFiles)).toEqual(['src/new-staged.ts']);
  });

  it('never flags a pure deletion ("D") — the tracked-diff path already covers it, no new content to embed', () => {
    const gitFiles = [gf('src/removed.ts', 'D')];
    const diffFiles: { filename: string }[] = [];
    expect(detectDiffCoverageGap(gitFiles, diffFiles)).toEqual([]);
  });

  it('excludes this app\'s own .lazy/ and .lazybrain/ scaffolding — never part of a mission deliverable', () => {
    const gitFiles = [gf('.lazybrain/brain/_cache/fts.sqlite', '?'), gf('.lazy/agents/foo.json', '?')];
    const diffFiles: { filename: string }[] = [];
    expect(detectDiffCoverageGap(gitFiles, diffFiles)).toEqual([]);
  });

  it('is separator-normalizing (Windows paths) when comparing git status paths to diff filenames', () => {
    const gitFiles = [gf('src\\components\\Widget.tsx', '?')];
    const diffFiles = [{ filename: 'src/components/Widget.tsx' }];
    expect(detectDiffCoverageGap(gitFiles, diffFiles)).toEqual([]);
  });

  it('dedupes and sorts the returned gap list', () => {
    const gitFiles = [gf('b.txt', '?'), gf('a.txt', 'M'), gf('a.txt', '?')];
    const diffFiles: { filename: string }[] = [];
    expect(detectDiffCoverageGap(gitFiles, diffFiles)).toEqual(['a.txt', 'b.txt']);
  });
});

/**
 * isDiffGenuinelyEmpty — trust-critical defect #2 (M2 forensics): unlike
 * detectDiffCoverageGap above (a diff with SOME content missing files git
 * can see), this checks for a diff with NO content at all — mission M2's
 * exact shape (worktree left with only the pre-existing README.md, zero
 * commits, diffFiles === []).
 */
describe('isDiffGenuinelyEmpty', () => {
  it('true when every field is empty/zero — M2 repro', () => {
    expect(
      isDiffGenuinelyEmpty({ diffFiles: [], diffSnippet: [], diffAdded: 0, diffRemoved: 0 }),
    ).toBe(true);
  });

  it('false when diffFiles has an entry, even if line counts are both 0 (e.g. a pure rename)', () => {
    expect(
      isDiffGenuinelyEmpty({
        diffFiles: [{ filename: 'src/renamed.ts' }],
        diffSnippet: [],
        diffAdded: 0,
        diffRemoved: 0,
      }),
    ).toBe(false);
  });

  it('false when diffSnippet has lines even though diffFiles/added/removed are all empty/zero', () => {
    expect(
      isDiffGenuinelyEmpty({ diffFiles: [], diffSnippet: ['diff --git a/x b/x'], diffAdded: 0, diffRemoved: 0 }),
    ).toBe(false);
  });

  it('false when diffAdded is non-zero', () => {
    expect(isDiffGenuinelyEmpty({ diffFiles: [], diffSnippet: [], diffAdded: 5, diffRemoved: 0 })).toBe(false);
  });

  it('false when diffRemoved is non-zero (e.g. a pure deletion)', () => {
    expect(isDiffGenuinelyEmpty({ diffFiles: [], diffSnippet: [], diffAdded: 0, diffRemoved: 3 })).toBe(false);
  });
});
