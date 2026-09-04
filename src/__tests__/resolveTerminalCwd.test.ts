/**
 * resolveTerminalCwd.test.ts
 *
 * DEFECT 1 regression coverage: the Code space terminal panel used to spawn
 * with no cwd at all, landing in the Tauri process's own launch directory
 * (the workspace parent) instead of the active project — see
 * resolveTerminalCwd.ts's own header for the full root-cause writeup.
 */

import { describe, it, expect } from 'vitest';
import { resolveTerminalCwd } from '../lib/terminal/resolveTerminalCwd';

describe('resolveTerminalCwd', () => {
  it('prefers the active (open file\'s owning) project when set', () => {
    const cwd = resolveTerminalCwd({
      activeFileProjectRoot: 'C:\\Users\\user\\Documents\\cerveau\\uc-smoke-b',
      fallbackProjectRoot: 'C:\\Users\\user\\Documents\\cerveau\\Lazy',
    });
    expect(cwd).toBe('C:\\Users\\user\\Documents\\cerveau\\uc-smoke-b');
  });

  it('falls back to the app-wide active project when no file is open (activeFileProjectRoot not set)', () => {
    const cwd = resolveTerminalCwd({
      activeFileProjectRoot: null,
      fallbackProjectRoot: 'C:\\Users\\user\\Documents\\cerveau\\Lazy',
    });
    expect(cwd).toBe('C:\\Users\\user\\Documents\\cerveau\\Lazy');
  });

  it('falls back when activeFileProjectRoot is undefined (no owning project found)', () => {
    const cwd = resolveTerminalCwd({
      activeFileProjectRoot: undefined,
      fallbackProjectRoot: 'C:\\Users\\user\\Documents\\cerveau\\Lazy',
    });
    expect(cwd).toBe('C:\\Users\\user\\Documents\\cerveau\\Lazy');
  });

  it('returns undefined when neither source is set (nothing active yet) — the honest "no project" contract TerminalView already has', () => {
    const cwd = resolveTerminalCwd({ activeFileProjectRoot: null, fallbackProjectRoot: '' });
    expect(cwd).toBeUndefined();
  });

  it('treats a project entry whose root is missing/blank (e.g. its folder was deleted on disk, same class as CodeSidebarProjects\' treeError) as not set, falling through instead of spawning with cwd: \'\'', () => {
    const cwd = resolveTerminalCwd({ activeFileProjectRoot: '', fallbackProjectRoot: 'C:\\Users\\user\\Documents\\cerveau\\Lazy' });
    expect(cwd).toBe('C:\\Users\\user\\Documents\\cerveau\\Lazy');
  });

  it('treats a whitespace-only root the same way as blank', () => {
    const cwd = resolveTerminalCwd({ activeFileProjectRoot: '   ', fallbackProjectRoot: 'C:\\Users\\user\\Documents\\cerveau\\Lazy' });
    expect(cwd).toBe('C:\\Users\\user\\Documents\\cerveau\\Lazy');
  });

  it('returns undefined when both the active and fallback roots are blank', () => {
    const cwd = resolveTerminalCwd({ activeFileProjectRoot: '', fallbackProjectRoot: '  ' });
    expect(cwd).toBeUndefined();
  });
});
