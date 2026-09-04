/**
 * C — Profile "Active projects" cwd normalization tests.
 *
 * - Windows-style paths with different slash/case variants merge into one key
 * - Unix-style paths are rejected when platform is win32 (and vice versa)
 */

import { describe, expect, it } from 'vitest';
import { isCwdPlausible, normalizeCwd } from '../src/commands/profile-update.js';

describe('C — cwd normalization', () => {
  it('backslashes are converted to forward slashes', () => {
    expect(normalizeCwd('C:\\Users\\Alice\\proj')).toBe('c:/users/alice/proj');
  });

  it('trailing slashes are stripped', () => {
    expect(normalizeCwd('C:/Users/Alice/proj/')).toBe('c:/users/alice/proj');
    expect(normalizeCwd('C:\\Users\\Alice\\proj\\')).toBe('c:/users/alice/proj');
  });

  it('drive letters are lowercased', () => {
    expect(normalizeCwd('C:/Users/Alice/proj')).toBe('c:/users/alice/proj');
    expect(normalizeCwd('D:/Work/project')).toBe('d:/work/project');
  });

  it('duplicate slashes are collapsed', () => {
    expect(normalizeCwd('C://Users//Alice//proj')).toBe('c:/users/alice/proj');
  });

  it('three Windows-style variants of the same path produce the same key', () => {
    const a = normalizeCwd('C:\\Users\\Alice\\proj');
    const b = normalizeCwd('C:/Users/Alice/proj/');
    const c = normalizeCwd('c:/users/alice/proj');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe('C — cwd plausibility check', () => {
  it('Windows-style path is plausible on win32', () => {
    expect(isCwdPlausible('c:/users/alice/proj', 'win32')).toBe(true);
  });

  it('Unix /home path is rejected on win32', () => {
    expect(isCwdPlausible('/home/david/project', 'win32')).toBe(false);
  });

  it('Unix /usr path is rejected on win32', () => {
    expect(isCwdPlausible('/usr/local/bin', 'win32')).toBe(false);
  });

  it('Unix /tmp path is rejected on win32', () => {
    expect(isCwdPlausible('/tmp/work', 'win32')).toBe(false);
  });

  it('Unix /var path is rejected on win32', () => {
    expect(isCwdPlausible('/var/log', 'win32')).toBe(false);
  });

  it('Unix /home path is plausible on linux', () => {
    expect(isCwdPlausible('/home/alice/project', 'linux')).toBe(true);
  });

  it('Windows C:/ path is rejected on linux (posix)', () => {
    expect(isCwdPlausible('c:/users/alice/proj', 'linux')).toBe(false);
    expect(isCwdPlausible('D:/work', 'linux')).toBe(false);
  });

  it('relative paths are plausible on any platform (not filtered)', () => {
    expect(isCwdPlausible('some/relative/path', 'win32')).toBe(true);
    expect(isCwdPlausible('some/relative/path', 'linux')).toBe(true);
  });
});
