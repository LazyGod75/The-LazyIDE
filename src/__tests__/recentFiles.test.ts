/* recentFiles.ts — per-project "recently opened" file MRU, used by
   EditorEmptyState.tsx to give the Code space's empty editor state real
   content instead of a bare placeholder. Locks the contract: root-scoped
   localStorage (normalized the same way editorStore.tsx's tabsStorageKey
   already is — a `\\?\`-prefixed root and its plain equivalent share one
   list), most-recent-first, deduped by path, capped, and resilient to
   corrupt/missing storage.
*/

import { describe, it, expect, beforeEach } from 'vitest';
import { getRecentFiles, recordRecentFile, removeRecentFile } from '../lib/editor/recentFiles';

const ROOT = 'C:/repo';

beforeEach(() => {
  localStorage.clear();
});

describe('recentFiles — recording and reading', () => {
  it('returns [] for a project with no recorded history', () => {
    expect(getRecentFiles(ROOT)).toEqual([]);
  });

  it('records an opened file and returns it most-recent-first', () => {
    recordRecentFile(ROOT, `${ROOT}/a.ts`, 'a.ts');
    recordRecentFile(ROOT, `${ROOT}/b.ts`, 'b.ts');

    expect(getRecentFiles(ROOT)).toEqual([
      { path: `${ROOT}/b.ts`, filename: 'b.ts' },
      { path: `${ROOT}/a.ts`, filename: 'a.ts' },
    ]);
  });

  it('moves an already-recorded path to the front instead of duplicating it', () => {
    recordRecentFile(ROOT, `${ROOT}/a.ts`, 'a.ts');
    recordRecentFile(ROOT, `${ROOT}/b.ts`, 'b.ts');
    recordRecentFile(ROOT, `${ROOT}/a.ts`, 'a.ts');

    expect(getRecentFiles(ROOT)).toEqual([
      { path: `${ROOT}/a.ts`, filename: 'a.ts' },
      { path: `${ROOT}/b.ts`, filename: 'b.ts' },
    ]);
  });

  it('caps the list at 8 entries, dropping the oldest', () => {
    for (let i = 0; i < 10; i++) {
      recordRecentFile(ROOT, `${ROOT}/file-${i}.ts`, `file-${i}.ts`);
    }

    const entries = getRecentFiles(ROOT);
    expect(entries).toHaveLength(8);
    expect(entries[0]).toEqual({ path: `${ROOT}/file-9.ts`, filename: 'file-9.ts' });
    expect(entries.some((e) => e.path === `${ROOT}/file-0.ts`)).toBe(false);
    expect(entries.some((e) => e.path === `${ROOT}/file-1.ts`)).toBe(false);
  });

  it('no-ops for an empty root — never throws, never records under a bogus key', () => {
    recordRecentFile('', `${ROOT}/a.ts`, 'a.ts');
    expect(getRecentFiles('')).toEqual([]);
  });

  it('scopes entries per project root — one project never sees another\'s history', () => {
    recordRecentFile(ROOT, `${ROOT}/a.ts`, 'a.ts');
    recordRecentFile('C:/other-repo', `C:/other-repo/z.ts`, 'z.ts');

    expect(getRecentFiles(ROOT)).toEqual([{ path: `${ROOT}/a.ts`, filename: 'a.ts' }]);
    expect(getRecentFiles('C:/other-repo')).toEqual([{ path: 'C:/other-repo/z.ts', filename: 'z.ts' }]);
  });

  it('a \\\\?\\-prefixed root and its plain equivalent share the same recorded list', () => {
    recordRecentFile('\\\\?\\C:\\repo', 'C:\\repo\\a.ts', 'a.ts');
    expect(getRecentFiles('C:\\repo')).toEqual([{ path: 'C:\\repo\\a.ts', filename: 'a.ts' }]);
  });

  it('ignores corrupt JSON already sitting in localStorage rather than throwing', () => {
    localStorage.setItem('lazy.editor.recentFiles.C:/repo', 'not json');
    expect(getRecentFiles(ROOT)).toEqual([]);
  });
});

describe('recentFiles — removal (a recent entry whose file no longer exists)', () => {
  it('drops the entry so it stops reappearing as a dead link', () => {
    recordRecentFile(ROOT, `${ROOT}/a.ts`, 'a.ts');
    recordRecentFile(ROOT, `${ROOT}/b.ts`, 'b.ts');

    removeRecentFile(ROOT, `${ROOT}/a.ts`);

    expect(getRecentFiles(ROOT)).toEqual([{ path: `${ROOT}/b.ts`, filename: 'b.ts' }]);
  });

  it('no-ops for an empty root', () => {
    recordRecentFile(ROOT, `${ROOT}/a.ts`, 'a.ts');
    removeRecentFile('', `${ROOT}/a.ts`);
    expect(getRecentFiles(ROOT)).toEqual([{ path: `${ROOT}/a.ts`, filename: 'a.ts' }]);
  });
});
