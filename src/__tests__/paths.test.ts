/**
 * Tests for src/lib/paths.ts — shared Windows "\\?\" (verbatim) path helpers.
 *
 * Regression context: this is the 4th time this codebase has had to deal
 * with the \\?\ verbatim-path bug class (see paths.ts's header comment for
 * the first three). These helpers back agentsStore.tsx's discardMission
 * fix — see agentsStore.discard.test.ts for that regression coverage.
 */

import { describe, it, expect } from 'vitest';
import {
  stripVerbatimPrefix,
  isAbsolutePathWin,
  joinPath,
  basename,
  normalizeRepoPathForGit,
  normalizeForPathCompare,
  isPathWithinRoot,
  stripVerbatimPrefixesInText,
} from '../lib/paths';
import { stripVerbatimPrefix as managedAgentStripVerbatimPrefix } from '../lib/agents/managedAgent';

// ── stripVerbatimPrefix ─────────────────────────────────────────────

describe('stripVerbatimPrefix', () => {
  it('strips a plain Windows verbatim prefix', () => {
    const prefixed = String.raw`\\?\C:\Users\dev\repo`;
    expect(stripVerbatimPrefix(prefixed)).toBe(String.raw`C:\Users\dev\repo`);
  });

  it('strips a UNC verbatim prefix down to a standard UNC path', () => {
    const prefixed = String.raw`\\?\UNC\server\share\repo`;
    expect(stripVerbatimPrefix(prefixed)).toBe(String.raw`\\server\share\repo`);
  });

  it('is a no-op for POSIX paths', () => {
    expect(stripVerbatimPrefix('/tmp/repo/file.ts')).toBe('/tmp/repo/file.ts');
  });

  it('is a no-op for already-normal Windows paths without the verbatim prefix', () => {
    const normal = String.raw`C:\Users\dev\repo`;
    expect(stripVerbatimPrefix(normal)).toBe(normal);
  });
});

// ── isAbsolutePathWin ────────────────────────────────────────────────

describe('isAbsolutePathWin', () => {
  it('is true for a Windows drive-letter path with backslashes', () => {
    expect(isAbsolutePathWin(String.raw`C:\Users\dev\repo`)).toBe(true);
  });

  it('is true for a Windows drive-letter path with forward slashes', () => {
    expect(isAbsolutePathWin('C:/Users/dev/repo')).toBe(true);
  });

  it('is true for a Windows verbatim (\\\\?\\) path', () => {
    expect(isAbsolutePathWin(String.raw`\\?\C:\Users\dev\repo`)).toBe(true);
  });

  it('is true for a UNC path', () => {
    expect(isAbsolutePathWin(String.raw`\\server\share\repo`)).toBe(true);
  });

  it('is true for a POSIX-rooted path', () => {
    expect(isAbsolutePathWin('/home/dev/repo')).toBe(true);
  });

  it('is false for a relative path', () => {
    expect(isAbsolutePathWin('relative/path')).toBe(false);
  });

  it('is false for an empty string', () => {
    expect(isAbsolutePathWin('')).toBe(false);
  });

  it('is false for a drive-relative path (single leading backslash, no drive letter)', () => {
    expect(isAbsolutePathWin(String.raw`\foo\bar`)).toBe(false);
  });
});

// ── joinPath ─────────────────────────────────────────────────────────

describe('joinPath', () => {
  it('joins segments onto a Windows verbatim (\\\\?\\) base using backslash throughout, never introducing a "/"', () => {
    const base = String.raw`\\?\C:\Users\user\Documents\cerveau\Lazy`;
    const result = joinPath(base, '.lazy', 'worktrees', 'agent-m-review-fix-thing');

    expect(result).toBe(
      String.raw`\\?\C:\Users\user\Documents\cerveau\Lazy\.lazy\worktrees\agent-m-review-fix-thing`,
    );
    expect(result).not.toContain('/');
  });

  it('joins segments onto a POSIX base using forward slash', () => {
    const result = joinPath('/repo', '.lazy', 'worktrees', 'mission-1');
    expect(result).toBe('/repo/.lazy/worktrees/mission-1');
  });

  it('trims a trailing backslash from a Windows base before joining (no doubled separator)', () => {
    // Plain escaped string, not String.raw`...` — a trailing backslash right
    // before the closing backtick would be lexed as an escaped backtick and
    // corrupt the rest of the file (see paths.ts's header comment).
    const result = joinPath('C:\\Users\\user\\Lazy\\', '.lazy', 'worktrees', 'agent-x');
    expect(result).toBe(String.raw`C:\Users\user\Lazy\.lazy\worktrees\agent-x`);
  });

  it('trims a trailing forward slash from a POSIX base before joining (no doubled separator)', () => {
    const result = joinPath('/repo/', '.lazy', 'worktrees', 'agent-x');
    expect(result).toBe('/repo/.lazy/worktrees/agent-x');
  });

  it('joins segments onto a UNC base using backslash throughout', () => {
    const base = String.raw`\\server\share\repo`;
    const result = joinPath(base, '.lazy', 'worktrees', 'agent-x');
    expect(result).toBe(String.raw`\\server\share\repo\.lazy\worktrees\agent-x`);
    expect(result).not.toContain('/');
  });

  it('never mixes separators even when a segment itself contains the opposite separator', () => {
    const base = String.raw`\\?\C:\repo`;
    const result = joinPath(base, 'sub/dir', 'file.ts');
    expect(result).toBe(String.raw`\\?\C:\repo\sub\dir\file.ts`);
    expect(result).not.toContain('/');
  });

  it('returns the trimmed base unchanged when no segments are given', () => {
    // Plain escaped string here too — see the comment above.
    expect(joinPath('C:\\Users\\user\\Lazy\\')).toBe(String.raw`C:\Users\user\Lazy`);
  });
});

// ── Consolidation guard (see paths.ts's header comment) ─────────────
//
// managedAgent.ts's stripVerbatimPrefix used to be a local duplicate of this
// exact logic; it now imports and re-exports this module's implementation
// instead. This guards against that drifting back into a second,
// potentially-inconsistent copy.

describe('stripVerbatimPrefix — shared across consumers', () => {
  it('managedAgent.ts re-exports the exact same function as this module (no duplicated implementation)', () => {
    expect(managedAgentStripVerbatimPrefix).toBe(stripVerbatimPrefix);
  });
});

// ── basename ──────────────────────────────────────────────────────
// F5 fix (post-e2e wave): the Code sidebar rendered a project's raw
// registry id (a hash, e.g. "7f78bbcd6f353bd...") instead of a friendly
// display name — this is the single shared helper every "derive a display
// name from a root/path" call site now uses (fleetMissions.ts,
// activityFeedFormat.ts, liveActionSummary.ts, CodeSidebarProjects.tsx).

describe('basename', () => {
  it('extracts the last segment of a Windows path', () => {
    expect(basename('C:\\Users\\user\\Documents\\cerveau\\demo-shop')).toBe('demo-shop');
  });

  it('extracts the last segment of a POSIX path', () => {
    expect(basename('/home/user/projects/demo-shop')).toBe('demo-shop');
  });

  it('ignores a trailing separator', () => {
    expect(basename('C:\\Users\\user\\demo-shop\\')).toBe('demo-shop');
    expect(basename('/home/user/demo-shop/')).toBe('demo-shop');
  });

  it('returns the input unchanged when there is no separator', () => {
    expect(basename('demo-shop')).toBe('demo-shop');
  });

  it('returns the input unchanged for an empty string', () => {
    expect(basename('')).toBe('');
  });

  it('handles a mixed-separator path (verbatim-stripped Windows path joined with "/")', () => {
    expect(basename('C:\\Users\\user/demo-shop')).toBe('demo-shop');
  });
});

// ── normalizeRepoPathForGit (QA B11 — "os error 267" regression) ────────

describe('normalizeRepoPathForGit', () => {
  it('strips the verbatim prefix and leaves a clean backslash path untouched', () => {
    const prefixed = String.raw`\\?\C:\Users\user\Documents\cerveau\demo-shop`;
    expect(normalizeRepoPathForGit(prefixed)).toBe(String.raw`C:\Users\user\Documents\cerveau\demo-shop`);
  });

  it('strips the verbatim prefix AND fixes a mixed-separator verbatim path (the actual "os error 267" repro)', () => {
    // Exactly the shape a naive `${repoPath}/sub` concatenation onto a
    // \\?\-prefixed base would produce — Win32 rejects this under the
    // verbatim namespace with ERROR_DIRECTORY (267) even though the
    // directory exists on disk.
    const mixed = String.raw`\\?\C:\Users\user\demo-shop` + '/sub/dir';
    expect(normalizeRepoPathForGit(mixed)).toBe(String.raw`C:\Users\user\demo-shop\sub\dir`);
    expect(normalizeRepoPathForGit(mixed)).not.toContain('/');
  });

  it('normalizes a forward-slash git-style Windows path (find_git_root fallback shape) to backslashes', () => {
    expect(normalizeRepoPathForGit('C:/Users/user/demo-shop')).toBe(String.raw`C:\Users\user\demo-shop`);
  });

  it('is a no-op for POSIX paths (dev/CI on mac/linux)', () => {
    expect(normalizeRepoPathForGit('/home/dev/demo-shop')).toBe('/home/dev/demo-shop');
  });

  it('is a no-op for an already-clean plain Windows path', () => {
    const clean = String.raw`C:\Users\user\demo-shop`;
    expect(normalizeRepoPathForGit(clean)).toBe(clean);
  });
});

// ── normalizeForPathCompare / isPathWithinRoot (2026-08-02 —
//    missionScopeGuard false-positive fix; the 6th+ instance of the
//    verbatim/case bug class, see this file's header) ──────────────────

describe('normalizeForPathCompare', () => {
  it('strips a verbatim prefix, unifies separators, and lower-cases', () => {
    expect(normalizeForPathCompare(String.raw`\\?\C:\Users\user\Demo`)).toBe(String.raw`c:\users\user\demo`);
  });

  it('unifies forward slashes to backslashes', () => {
    expect(normalizeForPathCompare('C:/Users/user/Demo')).toBe(String.raw`c:\users\user\demo`);
  });

  it('drops a trailing separator', () => {
    const withTrailingSep = String.raw`C:\Users\user\Demo` + '\\';
    expect(normalizeForPathCompare(withTrailingSep)).toBe(String.raw`c:\users\user\demo`);
  });
});

describe('isPathWithinRoot', () => {
  it('is true when a verbatim-prefixed root matches a plain, differently-cased same directory', () => {
    expect(
      isPathWithinRoot(
        String.raw`\\?\C:\Users\user\Documents\cerveau\lazy-backoffice`,
        String.raw`c:\Users\user\Documents\cerveau\lazy-backoffice`,
      ),
    ).toBe(true);
  });

  it('is true for a descendant regardless of drive-letter case', () => {
    expect(isPathWithinRoot(String.raw`C:\proj\lazysite`, String.raw`c:\proj\LAZYSITE\src\a.ts`)).toBe(true);
  });

  it('is true for a descendant with mixed forward/back slashes', () => {
    expect(isPathWithinRoot(String.raw`C:\proj\lazysite`, 'C:/proj/lazysite/src/a.ts')).toBe(true);
  });

  it('is false for an unrelated sibling directory', () => {
    expect(isPathWithinRoot(String.raw`C:\proj\lazysite`, String.raw`C:\proj\gameon`)).toBe(false);
  });

  it('is false for a sibling directory sharing a name PREFIX (…\\Lazy vs …\\LazySite-internet)', () => {
    expect(
      isPathWithinRoot(
        String.raw`C:\Users\user\Documents\cerveau\Lazy`,
        String.raw`C:\Users\user\Documents\cerveau\LazySite-internet\src\a.ts`,
      ),
    ).toBe(false);
  });

  it('is false when either side is empty', () => {
    expect(isPathWithinRoot('', String.raw`C:\proj\lazysite`)).toBe(false);
    expect(isPathWithinRoot(String.raw`C:\proj\lazysite`, '')).toBe(false);
  });
});

// ── stripVerbatimPrefixesInText (9th instance — Settings Health panel
//    rendering a raw "\\?\C:\Users\user\Documents\cerveau" error detail
//    verbatim; see this file's header and paths.ts's own doc comment on
//    this function for the full history) ──────────────────────────────

describe('stripVerbatimPrefixesInText', () => {
  it('strips a verbatim prefix embedded mid-sentence in a Rust error message', () => {
    const msg =
      "access denied: '" +
      String.raw`\\?\C:\Users\user\Documents\cerveau` +
      "' is outside every registered project root (8 checked)";
    expect(stripVerbatimPrefixesInText(msg)).toBe(
      "access denied: 'C:\\Users\\user\\Documents\\cerveau' is outside every registered project root (8 checked)",
    );
  });

  it('strips a UNC verbatim prefix embedded mid-sentence', () => {
    const msg = 'failed to read ' + String.raw`\\?\UNC\server\share\repo` + ': not found';
    expect(stripVerbatimPrefixesInText(msg)).toBe(
      'failed to read ' + String.raw`\\server\share\repo` + ': not found',
    );
  });

  it('strips multiple occurrences in the same string', () => {
    const msg =
      String.raw`\\?\C:\a` + ' does not match ' + String.raw`\\?\C:\b`;
    expect(stripVerbatimPrefixesInText(msg)).toBe(String.raw`C:\a` + ' does not match ' + String.raw`C:\b`);
  });

  it('is a no-op for text with no verbatim prefix at all', () => {
    const msg = "access denied: '.' is outside every registered project root";
    expect(stripVerbatimPrefixesInText(msg)).toBe(msg);
  });

  it('is a no-op for an empty string', () => {
    expect(stripVerbatimPrefixesInText('')).toBe('');
  });

  it('behaves the same as stripVerbatimPrefix when the whole string IS just a path', () => {
    const prefixed = String.raw`\\?\C:\Users\dev\repo`;
    expect(stripVerbatimPrefixesInText(prefixed)).toBe(stripVerbatimPrefix(prefixed));
  });
});
