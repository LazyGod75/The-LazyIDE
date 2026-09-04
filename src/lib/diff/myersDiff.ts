// myersDiff.ts — Myers diff algorithm for computing minimal diffs between
// old and new file content. Used by:
//   - The editor for streaming diff display (green/red line overlays)
//   - The agent search_replace tool for instant apply
//   - The /diff slash command to show proposed changes
//
// Based on Eugene Myers' paper "An O(ND) Difference Algorithm and Its Variations"
// Adapted for line-level diffing with support for inline (character-level) diffs
// within changed lines.

// ── Types ─────────────────────────────────────────────────────────

export type DiffLineType = 'same' | 'added' | 'removed';

export interface DiffLine {
  type: DiffLineType;
  line: string;
  /** Line number in the old file (1-indexed, undefined for added lines) */
  oldLineNumber?: number;
  /** Line number in the new file (1-indexed, undefined for removed lines) */
  newLineNumber?: number;
}

export interface DiffResult {
  lines: DiffLine[];
  addedCount: number;
  removedCount: number;
  /** True when there are no changes */
  identical: boolean;
}

// ── Myers algorithm ───────────────────────────────────────────────

/**
 * Compute the shortest edit script between two arrays of lines using
 * the Myers diff algorithm. Returns a list of DiffLine entries.
 */
export function myersDiff(oldContent: string, newContent: string): DiffResult {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const n = oldLines.length;
  const m = newLines.length;

  // Trivial case: identical content
  if (oldContent === newContent) {
    return {
      lines: oldLines.map((line, i) => ({
        type: 'same' as const,
        line,
        oldLineNumber: i + 1,
        newLineNumber: i + 1,
      })),
      addedCount: 0,
      removedCount: 0,
      identical: true,
    };
  }

  // Trivial case: one side is empty
  if (n === 0 && m === 0) {
    return { lines: [], addedCount: 0, removedCount: 0, identical: true };
  }

  // Myers algorithm — find the shortest edit script
  // V[k] stores the furthest-reaching x on diagonal k
  const max = n + m;
  const v: number[] = new Array(2 * max + 1).fill(0);
  const trace: number[][] = [];

  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push([...v]);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
        x = v[k + 1 + max]; // Down (insert)
      } else {
        x = v[k - 1 + max] + 1; // Right (delete)
      }
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      v[k + max] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }

  // Backtrack to build the edit script
  const script: Array<{ type: 'same' | 'added' | 'removed'; oldIdx: number; newIdx: number }> = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0; d--) {
    const vPrev = trace[d];
    const k = x - y;

    let prevK: number;
    if (k === -d || (k !== d && vPrev[k - 1 + max] < vPrev[k + 1 + max])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = vPrev[prevK + max] ?? 0;
    const prevY = prevX - prevK;

    // Common lines (snake)
    while (x > prevX && y > prevY) {
      x--;
      y--;
      script.push({ type: 'same', oldIdx: x, newIdx: y });
    }

    if (d > 0) {
      if (x === prevX) {
        // Insert
        y--;
        script.push({ type: 'added', oldIdx: -1, newIdx: y });
      } else {
        // Delete
        x--;
        script.push({ type: 'removed', oldIdx: x, newIdx: -1 });
      }
    }
  }

  script.reverse();

  // Build DiffLine array
  const lines: DiffLine[] = [];
  let addedCount = 0;
  let removedCount = 0;

  for (const entry of script) {
    if (entry.type === 'same') {
      lines.push({
        type: 'same',
        line: oldLines[entry.oldIdx],
        oldLineNumber: entry.oldIdx + 1,
        newLineNumber: entry.newIdx + 1,
      });
    } else if (entry.type === 'added') {
      lines.push({
        type: 'added',
        line: newLines[entry.newIdx],
        newLineNumber: entry.newIdx + 1,
      });
      addedCount++;
    } else {
      lines.push({
        type: 'removed',
        line: oldLines[entry.oldIdx],
        oldLineNumber: entry.oldIdx + 1,
      });
      removedCount++;
    }
  }

  return { lines, addedCount, removedCount, identical: false };
}

// ── Streaming diff generator ──────────────────────────────────────

/**
 * Generator that yields DiffLine entries one at a time.
 * Used for streaming diff display in the editor — the UI can
 * render lines progressively as they're computed.
 */
export function* generateDiffLines(oldContent: string, newContent: string): Generator<DiffLine> {
  const result = myersDiff(oldContent, newContent);
  for (const line of result.lines) {
    yield line;
  }
}

// ── Inline (character-level) diff ─────────────────────────────────

/**
 * Compute character-level diff between two single lines.
 * Returns segments marked as same/added/removed.
 */
export interface InlineDiffSegment {
  type: DiffLineType;
  text: string;
}

export function inlineDiff(oldLine: string, newLine: string): InlineDiffSegment[] {
  if (oldLine === newLine) {
    return [{ type: 'same', text: oldLine }];
  }

  // Simple LCS-based character diff
  const a = oldLine;
  const b = newLine;
  const n = a.length;
  const m = b.length;

  // Build LCS table
  const dp: number[][] = Array(n + 1).fill(null).map(() => Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build segments
  const segments: InlineDiffSegment[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      segments.unshift({ type: 'same', text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      segments.unshift({ type: 'added', text: b[j - 1] });
      j--;
    } else {
      segments.unshift({ type: 'removed', text: a[i - 1] });
      i--;
    }
  }

  // Merge consecutive segments of same type
  const merged: InlineDiffSegment[] = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (last && last.type === seg.type) {
      last.text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged;
}

// ── Diff formatting ───────────────────────────────────────────────

/**
 * Format a DiffResult as a unified diff string (like `git diff`).
 */
export function formatUnifiedDiff(oldContent: string, newContent: string, oldPath: string, newPath: string): string {
  const result = myersDiff(oldContent, newContent);
  if (result.identical) return '';

  const lines: string[] = [];
  lines.push(`--- ${oldPath}`);
  lines.push(`+++ ${newPath}`);

  let oldLine = 1;
  let newLine = 1;

  for (const dl of result.lines) {
    if (dl.type === 'same') {
      // Track line numbers
      oldLine = dl.oldLineNumber ?? oldLine;
      newLine = dl.newLineNumber ?? newLine;
    }
  }

  // Group into hunks
  let inHunk = false;
  // No initializer: always assigned (from `i - 3`) before use, right below,
  // each time a new hunk starts — an initial value here would never be read.
  let hunkStart: number;
  let hunkLines: string[] = [];
  let oldStart = 0;
  let newStart = 0;
  let oldCount = 0;
  let newCount = 0;

  for (let i = 0; i < result.lines.length; i++) {
    const dl = result.lines[i];
    const isChange = dl.type !== 'same';

    if (!inHunk && isChange) {
      // Start a new hunk with 3 lines of context before
      hunkStart = Math.max(0, i - 3);
      oldStart = (result.lines[hunkStart].oldLineNumber ?? 1);
      newStart = (result.lines[hunkStart].newLineNumber ?? 1);
      hunkLines = [];
      oldCount = 0;
      newCount = 0;
      inHunk = true;

      // Add context lines before
      for (let j = hunkStart; j < i; j++) {
        hunkLines.push(` ${result.lines[j].line}`);
        oldCount++;
        newCount++;
      }
    }

    if (inHunk) {
      if (dl.type === 'same') {
        hunkLines.push(` ${dl.line}`);
        oldCount++;
        newCount++;
      } else if (dl.type === 'added') {
        hunkLines.push(`+${dl.line}`);
        newCount++;
      } else {
        hunkLines.push(`-${dl.line}`);
        oldCount++;
      }

      // Check if we should close the hunk (3+ context lines after last change)
      if (isChange) {
        // Look ahead for more changes within 3 lines
        let hasMoreChanges = false;
        for (let j = i + 1; j < Math.min(result.lines.length, i + 4); j++) {
          if (result.lines[j].type !== 'same') {
            hasMoreChanges = true;
            break;
          }
        }
        if (!hasMoreChanges) {
          // Add up to 3 context lines after
          for (let j = i + 1; j < Math.min(result.lines.length, i + 4); j++) {
            hunkLines.push(` ${result.lines[j].line}`);
            oldCount++;
            newCount++;
          }
          lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
          lines.push(...hunkLines);
          inHunk = false;
        }
      }
    }
  }

  // Close any remaining hunk
  if (inHunk) {
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    lines.push(...hunkLines);
  }

  return lines.join('\n');
}

// ── Apply diff ────────────────────────────────────────────────────

/**
 * Apply a DiffResult to old content to produce new content.
 * This is the inverse of myersDiff — given the old content and a diff,
 * produce the new content.
 */
export function applyDiff(diff: DiffResult): string {
  const lines: string[] = [];
  for (const dl of diff.lines) {
    if (dl.type === 'same' || dl.type === 'added') {
      lines.push(dl.line);
    }
  }
  return lines.join('\n');
}

/**
 * Apply a search/replace operation to file content.
 * Returns the new content, or null if the search string was not found.
 */
export function applySearchReplace(
  content: string,
  search: string,
  replace: string,
  replaceAll: boolean = false,
): string | null {
  if (!content.includes(search)) return null;
  if (replaceAll) {
    return content.split(search).join(replace);
  }
  // Replace first occurrence only
  const idx = content.indexOf(search);
  return content.slice(0, idx) + replace + content.slice(idx + search.length);
}
