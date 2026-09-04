import { describe, it, expect } from 'vitest';
import { parseDiffFiles } from '../lib/agents/diffParse';

const REALISTIC_DIFF = `diff --git a/src/lib/agents/runtime.ts b/src/lib/agents/runtime.ts
index a1b2c3d..e4f5g6h 100644
--- a/src/lib/agents/runtime.ts
+++ b/src/lib/agents/runtime.ts
@@ -1,5 +1,8 @@
 import { invoke } from '@tauri-apps/api/core';
+import { parseDiffFiles } from './diffParse';
+import type { DiffFileEntry } from './diffParse';

 export interface MissionUpdate {
   id: string;
-  patch: Partial<Mission>;
+  patch: Partial<Mission> & { diffFiles?: DiffFileEntry[] };
 }
diff --git a/src/lib/agents/diffParse.ts b/src/lib/agents/diffParse.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/lib/agents/diffParse.ts
@@ -0,0 +1,10 @@
+export interface DiffFileEntry {
+  filename: string;
+  added: number;
+  removed: number;
+}
+
+export function parseDiffFiles(rawDiff: string): DiffFileEntry[] {
+  return [];
+}
`;

describe('parseDiffFiles', () => {
  it('returns [] for empty string', () => {
    expect(parseDiffFiles('')).toEqual([]);
  });

  it('returns [] for whitespace-only string', () => {
    expect(parseDiffFiles('   \n\n  ')).toEqual([]);
  });

  it('parses a realistic multi-file diff correctly', () => {
    const result = parseDiffFiles(REALISTIC_DIFF);

    expect(result).toHaveLength(2);

    const runtime = result.find((f) => f.filename === 'src/lib/agents/runtime.ts');
    expect(runtime).toBeDefined();
    // +import { parseDiffFiles }, +import type, +  patch: Partial<...
    expect(runtime!.added).toBe(3);
    // -  patch: Partial<Mission>;
    expect(runtime!.removed).toBe(1);

    const diffParse = result.find((f) => f.filename === 'src/lib/agents/diffParse.ts');
    expect(diffParse).toBeDefined();
    // 9 lines with + in the new-file block (including blank line +)
    expect(diffParse!.added).toBe(9);
    expect(diffParse!.removed).toBe(0);
  });

  it('handles a rename — uses b/ (new) path as filename', () => {
    const renameDiff = `diff --git a/old/path/file.ts b/new/path/renamed.ts
similarity index 85%
rename from old/path/file.ts
rename to new/path/renamed.ts
--- a/old/path/file.ts
+++ b/new/path/renamed.ts
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 2;
+const y = 99;
 export { x, y };
`;
    const result = parseDiffFiles(renameDiff);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('new/path/renamed.ts');
    expect(result[0].added).toBe(1);
    expect(result[0].removed).toBe(1);
  });

  it('handles a file with only additions (new file)', () => {
    const newFileDiff = `diff --git a/src/new-module.ts b/src/new-module.ts
new file mode 100644
index 0000000..abcdef0
--- /dev/null
+++ b/src/new-module.ts
@@ -0,0 +1,5 @@
+export const A = 1;
+export const B = 2;
+export const C = 3;
+export const D = 4;
+export const E = 5;
`;
    const result = parseDiffFiles(newFileDiff);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('src/new-module.ts');
    expect(result[0].added).toBe(5);
    expect(result[0].removed).toBe(0);
  });

  it('does not count +++ or --- header lines', () => {
    const diff = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1,2 +1,2 @@
-const x = 1;
+const x = 42;
`;
    const result = parseDiffFiles(diff);
    expect(result).toHaveLength(1);
    expect(result[0].added).toBe(1);
    expect(result[0].removed).toBe(1);
  });

  it('returns correct total across all files when summed', () => {
    const result = parseDiffFiles(REALISTIC_DIFF);
    const totalAdded = result.reduce((sum, f) => sum + f.added, 0);
    const totalRemoved = result.reduce((sum, f) => sum + f.removed, 0);
    // runtime: 3 added, 1 removed; diffParse: 9 added, 0 removed
    expect(totalAdded).toBe(12);
    expect(totalRemoved).toBe(1);
  });

  // ── Trust-critical defect #1 (M53 forensics) ─────────────────────────
  // agent_worktree_diff_inner (git.rs) inlines each untracked file as a
  // synthetic "--- /dev/null\n+++ b/<file>\n@@ ...@@" block with NO
  // `diff --git` header of its own. Before the fix, every one of these
  // blocks' `+` lines glommed onto whichever tracked `diff --git` file
  // happened to be open — reproducing exactly what M53's real review saw:
  // a 1-line README diff (95 real added lines) reported as "952 lines
  // added", because 857 lines from 18 other untracked scaffold files were
  // silently counted as README.md's own.
  describe('untracked files inlined WITHOUT a diff --git header (M53 shape)', () => {
    // Mirrors agent_worktree_diff_inner's exact output shape: one real
    // `git diff HEAD` block for a TRACKED, modified file, followed by
    // several synthetic untracked-file blocks with no `diff --git` line.
    const M53_SHAPE_DIFF = `diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,4 @@
 # Admin Dashboard
+## Setup
+Run npm install.
 More text.

--- /dev/null
+++ b/package.json
@@ -0,0 +1,3 @@
+{
+  "name": "admin-dashboard"
+}

--- /dev/null
+++ b/src/App.tsx
@@ -0,0 +1,2 @@
+export function App() {}
+export default App;

--- /dev/null
+++ b/vite.config.ts
@@ -0,0 +1,1 @@
+export default {};
`;

    it('attributes each untracked file to its OWN entry instead of glomming onto the preceding tracked file', () => {
      const result = parseDiffFiles(M53_SHAPE_DIFF);
      const byName = new Map(result.map((f) => [f.filename, f]));

      expect(byName.size).toBe(4);

      // README.md must show ONLY its own real 2 added lines — never
      // inflated by the untracked blocks that follow it in the raw string.
      expect(byName.get('README.md')).toEqual({ filename: 'README.md', added: 2, removed: 0 });
      expect(byName.get('package.json')).toEqual({ filename: 'package.json', added: 3, removed: 0 });
      expect(byName.get('src/App.tsx')).toEqual({ filename: 'src/App.tsx', added: 2, removed: 0 });
      expect(byName.get('vite.config.ts')).toEqual({ filename: 'vite.config.ts', added: 1, removed: 0 });
    });

    it('never reports a single file with the whole diff\'s line count (the exact M53 symptom)', () => {
      const result = parseDiffFiles(M53_SHAPE_DIFF);
      const totalAdded = result.reduce((sum, f) => sum + f.added, 0);
      // Sanity: the parser still accounts for every added line SOMEWHERE...
      expect(totalAdded).toBe(8);
      // ...but no single entry (e.g. README.md) claims the whole total —
      // that "one file, all the lines" shape is exactly what M53 showed.
      for (const entry of result) {
        expect(entry.added).toBeLessThan(totalAdded);
      }
    });

    it('handles consecutive untracked blocks with no tracked diff --git at all', () => {
      const onlyUntracked = `--- /dev/null
+++ b/a.txt
@@ -0,0 +1,1 @@
+hello

--- /dev/null
+++ b/b.txt
@@ -0,0 +1,2 @@
+line1
+line2
`;
      const result = parseDiffFiles(onlyUntracked);
      expect(result).toHaveLength(2);
      expect(result.find((f) => f.filename === 'a.txt')).toEqual({ filename: 'a.txt', added: 1, removed: 0 });
      expect(result.find((f) => f.filename === 'b.txt')).toEqual({ filename: 'b.txt', added: 2, removed: 0 });
    });
  });
});
