import { describe, expect, it } from 'vitest';
import {
  canonicalProjectSegment,
  normalizeCwd,
  splitHyphenated,
  stripUserPrefix,
} from '../cwd-normalizer.js';

// ---------------------------------------------------------------------------
// stripUserPrefix
// ---------------------------------------------------------------------------
describe('stripUserPrefix', () => {
  it('removes ~ shorthand', () => {
    const result = stripUserPrefix('~/projects/acme');
    expect(result).not.toMatch(/^~/);
    expect(result).toContain('projects/acme');
  });

  it('removes %USERPROFILE% literal', () => {
    const result = stripUserPrefix('%USERPROFILE%\\Documents\\Acme');
    expect(result).not.toMatch(/%userprofile%/i);
  });

  it('normalizes backslashes to forward slashes', () => {
    const result = stripUserPrefix('C:\\Users\\user\\Documents\\Acme');
    expect(result).not.toContain('\\');
  });
});

// ---------------------------------------------------------------------------
// splitHyphenated
// ---------------------------------------------------------------------------
describe('splitHyphenated', () => {
  it('splits hyphenated project name into multiple segments', () => {
    expect(splitHyphenated('Acme-Tracking-cal')).toEqual(['Acme', 'Tracking', 'cal']);
  });

  it('returns single segment when no hyphen present', () => {
    expect(splitHyphenated('acme')).toEqual(['acme']);
  });

  it('handles double hyphens by filtering empty parts', () => {
    const result = splitHyphenated('foo--bar');
    expect(result).not.toContain('');
    expect(result).toContain('foo');
    expect(result).toContain('bar');
  });
});

// ---------------------------------------------------------------------------
// normalizeCwd — happy paths
// ---------------------------------------------------------------------------
describe('normalizeCwd', () => {
  it('handles Windows backslash path', () => {
    const result = normalizeCwd('C:\\Users\\user\\Documents\\Acme\\marketing');
    expect(result).not.toBeNull();
    expect(result!.project).toBe('acme');
    expect(result!.segments).toContain('marketing');
    expect(result!.topicPath).toBe('acme/marketing');
  });

  it('handles Windows mixed-separator path', () => {
    const result = normalizeCwd('C:/Users/user/Documents/Acme-Tracking-cal');
    expect(result).not.toBeNull();
    // "Acme-Tracking-cal" should be split by hyphens
    expect(result!.project).toBe('acme');
    expect(result!.segments).toContain('tracking');
    expect(result!.segments).toContain('cal');
  });

  it('handles Unix-style path', () => {
    const result = normalizeCwd('/home/user/projects/acme/cal');
    expect(result).not.toBeNull();
    expect(result!.project).toBe('acme');
    expect(result!.topicPath).toBe('acme/cal');
  });

  it('handles purely hyphenated project name (no slashes after prefix strip)', () => {
    const result = normalizeCwd('C:/Users/user/Documents/Acme-Tracking-cal');
    expect(result).not.toBeNull();
    expect(result!.topicPath).toBe('acme/tracking/cal');
    expect(result!.segments).toEqual(['acme', 'tracking', 'cal']);
  });

  it('lowercases all segments', () => {
    const result = normalizeCwd('C:\\Users\\user\\Documents\\ACME\\MARKETING');
    expect(result).not.toBeNull();
    expect(result!.topicPath).toBe('acme/marketing');
  });

  it('strips common dev container folders (Documents, Projects)', () => {
    const result = normalizeCwd('/home/user/projects/acme');
    expect(result).not.toBeNull();
    expect(result!.segments).not.toContain('projects');
    expect(result!.project).toBe('acme');
  });

  it('strips "Code" and "Workspace" dev containers', () => {
    const r1 = normalizeCwd('/home/user/Code/myapp');
    expect(r1!.project).toBe('myapp');

    const r2 = normalizeCwd('/home/user/Workspace/myapp');
    expect(r2!.project).toBe('myapp');
  });

  it('preserves the raw input', () => {
    const raw = 'C:\\Users\\user\\Documents\\Acme\\marketing';
    const result = normalizeCwd(raw);
    expect(result!.raw).toBe(raw);
  });

  it('returns null for a system path', () => {
    const result = normalizeCwd('C:\\Windows\\System32');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = normalizeCwd('');
    expect(result).toBeNull();
  });

  it('handles path with tilde shorthand', () => {
    const result = normalizeCwd('~/dev/acme/backend');
    expect(result).not.toBeNull();
    expect(result!.project).toBe('acme');
    expect(result!.topicPath).toBe('acme/backend');
  });

  it('sets project to first segment', () => {
    const result = normalizeCwd('/home/user/projects/myproject/feature/auth');
    expect(result).not.toBeNull();
    expect(result!.project).toBe('myproject');
    expect(result!.segments[0]).toBe('myproject');
  });
});

// ---------------------------------------------------------------------------
// canonicalProjectSegment — topic-case unification
// ---------------------------------------------------------------------------
describe('canonicalProjectSegment', () => {
  it('lowercases an upper-case directory name', () => {
    expect(canonicalProjectSegment('Acme')).toBe('acme');
  });

  it('lowercases an all-caps directory name', () => {
    expect(canonicalProjectSegment('ACME')).toBe('acme');
  });

  it('leaves an already-lowercase name unchanged', () => {
    expect(canonicalProjectSegment('acme')).toBe('acme');
  });

  it('lowercases mixed-case names', () => {
    expect(canonicalProjectSegment('AdminPanel')).toBe('adminpanel');
    expect(canonicalProjectSegment('Tradelab')).toBe('tradelab');
  });
});

// ---------------------------------------------------------------------------
// Cross-path canonical unification — the core regression guard
// Proves that a code-scanner project dir and a conversation cwd
// resolve to the SAME canonical first topic segment.
// ---------------------------------------------------------------------------
describe('canonical topic unification: code dir vs conversation cwd', () => {
  it('"Acme" directory and "C:/Users/user/Documents/Acme" cwd both map to "acme"', () => {
    // Code-scanner path: basename("C:/path/to/Acme") → "Acme" → canonicalProjectSegment
    const codeDirName = 'Acme';
    const codeSegment = canonicalProjectSegment(codeDirName);

    // Conversation path: normalizeCwd produces lowercase project
    const convResult = normalizeCwd('C:/Users/user/Documents/Acme');
    expect(convResult).not.toBeNull();
    const convSegment = convResult!.project;

    expect(codeSegment).toBe('acme');
    expect(convSegment).toBe('acme');
    expect(codeSegment).toBe(convSegment);
  });

  it('"Tradelab" directory and "/home/user/projects/Tradelab/strategy" cwd map to "tradelab"', () => {
    const codeSegment = canonicalProjectSegment('Tradelab');
    const convResult = normalizeCwd('/home/user/projects/Tradelab/strategy');
    expect(convResult).not.toBeNull();
    const convSegment = convResult!.project;

    expect(codeSegment).toBe('tradelab');
    expect(convSegment).toBe('tradelab');
    expect(codeSegment).toBe(convSegment);
  });

  it('"AdminPanel" directory and ".../adminpanel" cwd map to the same segment', () => {
    const codeSegment = canonicalProjectSegment('AdminPanel');
    const convResult = normalizeCwd('/home/user/projects/adminpanel');
    expect(convResult).not.toBeNull();
    const convSegment = convResult!.project;

    expect(codeSegment).toBe(convSegment);
  });
});
