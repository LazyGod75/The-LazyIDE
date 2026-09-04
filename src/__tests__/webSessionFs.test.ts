import { describe, it, expect } from 'vitest';
import { dirEntriesFromSession } from '../lib/platform/webSessionFs';

describe('dirEntriesFromSession', () => {
  it('returns nothing when the session map is empty', () => {
    expect(dirEntriesFromSession([], '/project')).toEqual([]);
  });

  it('lists only immediate children of the requested directory', () => {
    const files = [
      '/project/src/a.ts',
      '/project/src/lib/b.ts',
      '/project/README.md',
      '/other/x.ts',
    ];
    const top = dirEntriesFromSession(files, '/project');
    expect(top).toEqual([
      { name: 'src', path: '/project/src', isDir: true },
      { name: 'README.md', path: '/project/README.md', isDir: false },
    ]);
    expect(dirEntriesFromSession(files, '/project/src')).toEqual([
      { name: 'lib', path: '/project/src/lib', isDir: true },
      { name: 'a.ts', path: '/project/src/a.ts', isDir: false },
    ]);
  });
});
