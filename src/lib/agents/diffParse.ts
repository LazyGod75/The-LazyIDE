/* diffParse.ts — Pure helper to parse unified diff output into per-file stats.
   No dependencies. No side effects. Fully testable.
*/

export interface DiffFileEntry {
  filename: string;
  added: number;
  removed: number;
}

/**
 * parseDiffFiles — parse a unified diff string into per-file added/removed line counts.
 *
 * Recognises `diff --git a/<x> b/<y>` headers.
 * For renames, uses the b/ (new) path.
 * Counts lines starting with `+` (not `+++`) as added,
 * lines starting with `-` (not `---`) as removed.
 *
 * ALSO recognises a bare `+++ b/<file>` line as its own file boundary, not
 * only `diff --git` — trust-critical defect #1 fix (M53 forensics,
 * lazy-backoffice: mission produced a real 19-file Vite scaffold, but its
 * review saw only "README.md, 952 lines added"). Root cause:
 * agent_worktree_diff_inner (src-tauri/src/commands/git.rs) inlines each
 * UNTRACKED file it finds as a synthetic
 * `\n--- /dev/null\n+++ b/<file>\n@@ -0,0 +1,N @@\n+...` block, appended
 * one after another with NO `diff --git` header of its own (only a real
 * `git diff HEAD` on a TRACKED file produces that header). Before this fix,
 * this parser only ever started a new entry on `diff --git`, so every
 * untracked file's `+` lines silently glommed onto whichever tracked file's
 * entry happened to be open when its block began (or were dropped entirely
 * if none was) — the diff genuinely contained all 19 files, but this parser
 * mis-attributed 857 of README.md's reported 952 "added" lines to files
 * that were never README.md at all.
 *
 * Safe for a REAL `diff --git` block too: its own `+++ b/<file>` line
 * always names the SAME file the header immediately above it already
 * opened, so this only re-affirms `current` (no reset, no duplicate entry)
 * rather than starting a new one.
 *
 * Returns [] for empty or non-diff input.
 */
export function parseDiffFiles(rawDiff: string): DiffFileEntry[] {
  if (!rawDiff || rawDiff.trim().length === 0) {
    return [];
  }

  const result: DiffFileEntry[] = [];
  let current: DiffFileEntry | null = null;

  for (const line of rawDiff.split('\n')) {
    // New file header: diff --git a/foo b/bar
    const headerMatch = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (headerMatch) {
      if (current) {
        result.push(current);
      }
      current = { filename: headerMatch[1], added: 0, removed: 0 };
      continue;
    }

    // `+++ b/<file>` boundary — see this function's doc comment above for
    // why this is needed independently of `diff --git`. Only starts a NEW
    // entry when this file differs from (or there is no) currently open
    // one; a real diff --git block's own +++ line names the file already
    // open and is simply consumed here without resetting its counts.
    const plusMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (plusMatch) {
      const filename = plusMatch[1];
      if (!current || current.filename !== filename) {
        if (current) result.push(current);
        current = { filename, added: 0, removed: 0 };
      }
      continue;
    }

    if (!current) continue;

    // Count added lines (starts with + but not +++)
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current = { ...current, added: current.added + 1 };
      continue;
    }

    // Count removed lines (starts with - but not ---)
    if (line.startsWith('-') && !line.startsWith('---')) {
      current = { ...current, removed: current.removed + 1 };
    }
  }

  if (current) {
    result.push(current);
  }

  return result;
}
