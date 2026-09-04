import { describe, it, expect } from 'vitest';
import { findOwningProject } from '../lib/agents/projectForPath';

describe('findOwningProject', () => {
  const projects = [
    { id: 'lazysite', root: 'C:\\proj\\lazysite' },
    { id: 'gameon', root: 'C:\\proj\\gameon' },
  ];

  it('matches a file directly under a project root', () => {
    expect(findOwningProject('C:\\proj\\lazysite\\src\\a.ts', projects)?.id).toBe('lazysite');
  });

  it('matches a file under a mission worktree path', () => {
    expect(findOwningProject('C:\\proj\\gameon\\.lazy\\worktrees\\agent-x\\src\\a.rs', projects)?.id).toBe('gameon');
  });

  it('returns null for a path outside every open project', () => {
    expect(findOwningProject('C:\\other\\a.ts', projects)).toBeNull();
  });

  it('prefers the most specific (longest) root on nested projects', () => {
    const nested = [
      { id: 'outer', root: 'C:\\proj' },
      { id: 'inner', root: 'C:\\proj\\inner' },
    ];
    expect(findOwningProject('C:\\proj\\inner\\a.ts', nested)?.id).toBe('inner');
  });
});
