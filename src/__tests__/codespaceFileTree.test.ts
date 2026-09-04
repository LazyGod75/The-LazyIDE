import { describe, it, expect } from 'vitest';
import { sortEntries, relativeToRoot, updateNodeAt, type CodeTreeNode } from '../components/editor/codespace/fileTree';
import type { DirEntry } from '../lib/platform/types';

function entry(name: string, isDir: boolean, path = name): DirEntry {
  return { name, path, isDir };
}

describe('sortEntries', () => {
  it('sorts directories before files, each alphabetically', () => {
    const result = sortEntries([entry('b.ts', false), entry('zdir', true), entry('a.ts', false), entry('adir', true)]);
    expect(result.map((e) => e.name)).toEqual(['adir', 'zdir', 'a.ts', 'b.ts']);
  });
});

describe('relativeToRoot', () => {
  it('strips the root prefix and normalizes separators', () => {
    expect(relativeToRoot('C:\\proj', 'C:\\proj\\src\\a.ts')).toBe('src/a.ts');
  });

  it('handles forward-slash roots', () => {
    expect(relativeToRoot('/proj', '/proj/src/a.ts')).toBe('src/a.ts');
  });

  it('falls back to the raw normalized path when it does not start with root', () => {
    expect(relativeToRoot('/proj', '/other/a.ts')).toBe('/other/a.ts');
  });

  // Breadcrumb "?" defect (2026-08-15): `root` (typically Rust
  // canonicalize() output, verbatim-prefixed on Windows) and `path` (an
  // editor tab path, which may or may not be) frequently disagree on this
  // prefix alone. Splitting an un-stripped `\\?\` path on separators turns
  // it into its own leading "?" crumb — see BreadcrumbBar.tsx's
  // breadcrumbSegments, which is built on this function.
  it('resolves correctly when path is verbatim-prefixed but root is not (the live breadcrumb repro)', () => {
    const root = String.raw`C:\Users\user\Documents\cerveau\scratchpad\uc-smoke-b`;
    const path = String.raw`\\?\C:\Users\user\Documents\cerveau\scratchpad\uc-smoke-b\app.js`;
    expect(relativeToRoot(root, path)).toBe('app.js');
  });

  it('resolves correctly when both root and path are verbatim-prefixed', () => {
    const root = String.raw`\\?\C:\Users\user\Documents\cerveau\uc-smoke-b`;
    const path = String.raw`\\?\C:\Users\user\Documents\cerveau\uc-smoke-b\src\app.js`;
    expect(relativeToRoot(root, path)).toBe('src/app.js');
  });

  it('resolves correctly for a UNC root/path pair', () => {
    const root = String.raw`\\server\share\repo`;
    const path = String.raw`\\server\share\repo\src\a.ts`;
    expect(relativeToRoot(root, path)).toBe('src/a.ts');
  });

  it('strips the verbatim prefix even in the outside-root fallback (never leaks "\\\\?\\" into the result)', () => {
    const root = String.raw`\\?\C:\Users\user\Documents\cerveau\uc-smoke-b`;
    const path = String.raw`\\?\C:\Users\user\Documents\cerveau\other-project\app.js`;
    const result = relativeToRoot(root, path);
    expect(result).not.toContain('?');
    expect(result).toBe('C:/Users/user/Documents/cerveau/other-project/app.js');
  });
});

describe('updateNodeAt', () => {
  it('updates a top-level node immutably', () => {
    const nodes: CodeTreeNode[] = [
      { entry: entry('a', true), children: null, isExpanded: false },
      { entry: entry('b', false), children: null, isExpanded: false },
    ];
    const next = updateNodeAt(nodes, 'a', (n) => ({ ...n, isExpanded: true }));
    expect(next[0].isExpanded).toBe(true);
    expect(next[1]).toBe(nodes[1]); // untouched node reference preserved
    expect(nodes[0].isExpanded).toBe(false); // original untouched
  });

  it('updates a nested node', () => {
    const nested: CodeTreeNode = { entry: entry('child', false, 'a/child'), children: null, isExpanded: false };
    const nodes: CodeTreeNode[] = [
      { entry: entry('a', true), children: [nested], isExpanded: true },
    ];
    const next = updateNodeAt(nodes, 'a/child', (n) => ({ ...n, isExpanded: true }));
    expect(next[0].children![0].isExpanded).toBe(true);
  });
});
