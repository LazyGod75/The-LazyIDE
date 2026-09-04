/**
 * Tests for toolPermissions.ts — the glob-based allow/ask/exclude
 * permission engine wired into the managed agent loop's executeTool path
 * (see managedToolPermissions.ts / managedToolPermissions.test.ts for the
 * integration layer built on top of this module).
 *
 * Focus: resolvePermission's mode semantics, in particular the removal of
 * the 'auto' mode bypass that used to short-circuit straight to 'allow'
 * for every tool call — including ones an explicit 'exclude' rule was
 * supposed to block. That bypass was the audit's CRITICAL finding; this
 * suite pins the fix down directly, independent of the managed loop.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolvePermission,
  matchesPattern,
  getMergedRules,
  DEFAULT_RULES,
  saveProjectPermissions,
  saveUserPermissions,
  loadUserPermissions,
  loadProjectPermissions,
} from '../lib/agents/toolPermissions';
import type { PermissionRule } from '../lib/agents/toolPermissions';

function rule(
  pattern: string,
  level: PermissionRule['level'],
  source: PermissionRule['source'] = 'project',
): PermissionRule {
  return { pattern, level, source, createdAt: '' };
}

beforeEach(() => {
  localStorage.clear();
});

// ── matchesPattern ────────────────────────────────────────────────

describe('matchesPattern', () => {
  it('matches a bare tool name (no glob) against any arg', () => {
    expect(matchesPattern('Bash', 'Bash', 'npm install')).toBe(true);
    expect(matchesPattern('Bash', 'Bash', undefined)).toBe(true);
  });

  it('does not match a different tool name', () => {
    expect(matchesPattern('Bash', 'Write', 'npm install')).toBe(false);
  });

  it('matches a glob against the tool argument', () => {
    expect(matchesPattern('Bash(npm install*)', 'Bash', 'npm install foo')).toBe(true);
    expect(matchesPattern('Bash(npm install*)', 'Bash', 'npm test')).toBe(false);
  });

  it('requires an arg when the pattern carries a glob', () => {
    expect(matchesPattern('Write(*.env)', 'Write', undefined)).toBe(false);
  });

  it('the wildcard tool "*" matches any tool name (same arg glob, different tool names)', () => {
    expect(matchesPattern('*(secrets/**)', 'Write', 'secrets/keys.json')).toBe(true);
    expect(matchesPattern('*(secrets/**)', 'Bash', 'secrets/keys.json')).toBe(true);
    expect(matchesPattern('*(secrets/**)', 'Write', 'src/index.ts')).toBe(false);
  });

  it('a single "*" does not cross "/", "**" does — matters for run_command patterns', () => {
    expect(matchesPattern('Bash(rm -rf*)', 'Bash', 'rm -rf /tmp/build')).toBe(false);
    expect(matchesPattern('Bash(rm -rf**)', 'Bash', 'rm -rf /tmp/build')).toBe(true);
  });
});

// ── resolvePermission ──────────────────────────────────────────────

describe('resolvePermission', () => {
  it('readonly mode allows read-only tool names regardless of rules', () => {
    expect(resolvePermission('Read', undefined, [], 'readonly')).toBe('allow');
    expect(resolvePermission('Grep', 'foo', [], 'readonly')).toBe('allow');
  });

  it('readonly mode excludes non-read tools even when a rule would allow them', () => {
    const rules = [rule('Bash', 'allow')];
    expect(resolvePermission('Bash', 'npm test', rules, 'readonly')).toBe('exclude');
  });

  it('default mode with no rules falls back to DEFAULT_RULES', () => {
    expect(resolvePermission('Read', undefined, [], 'default')).toBe('allow');
    expect(resolvePermission('Bash', 'npm test', [], 'default')).toBe('ask');
  });

  it('an explicit rule takes precedence over DEFAULT_RULES', () => {
    const rules = [rule('Bash', 'allow')];
    expect(resolvePermission('Bash', 'npm test', rules, 'default')).toBe('allow');
  });

  it('SECURITY FIX: auto mode no longer bypasses an explicit exclude rule', () => {
    const rules = [rule('Bash', 'exclude')];
    // Previously resolvePermission(..., 'auto') short-circuited straight to
    // 'allow' unconditionally, silently bypassing exactly this exclusion —
    // the audit's CRITICAL finding.
    expect(resolvePermission('Bash', 'rm -rf /', rules, 'auto')).toBe('exclude');
  });

  it('auto mode still allows an explicit allow rule (no regression for the common case)', () => {
    const rules = [rule('Bash', 'allow')];
    expect(resolvePermission('Bash', 'npm test', rules, 'auto')).toBe('allow');
  });

  it('auto mode honestly reports an "ask" verdict rather than silently allowing it', () => {
    // resolvePermission's job is only to report what the rules say — what a
    // caller DOES with 'ask' while unattended is its own decision (see
    // managedToolPermissions.checkToolPermission).
    expect(resolvePermission('Bash', 'npm test', [], 'auto')).toBe('ask');
  });

  it('auto and default modes resolve identically once readonly is out of the picture', () => {
    const rules = [rule('Write(**/*.env)', 'exclude')];
    expect(resolvePermission('Write', 'src/.env', rules, 'auto')).toBe(
      resolvePermission('Write', 'src/.env', rules, 'default'),
    );
  });

  it('rules are checked in array order — first match wins (precedence is caller-defined)', () => {
    const rules = [rule('Bash', 'exclude', 'project'), rule('Bash', 'allow', 'user')];
    expect(resolvePermission('Bash', 'npm test', rules, 'default')).toBe('exclude');
  });
});

// ── getMergedRules ──────────────────────────────────────────────────

describe('getMergedRules', () => {
  it('orders project rules before user rules before DEFAULT_RULES', () => {
    saveProjectPermissions({ rules: [rule('Bash', 'exclude', 'project')] });
    saveUserPermissions({ rules: [rule('Bash', 'allow', 'user')] });

    const bashRules = getMergedRules().filter((r) => r.pattern === 'Bash');
    expect(bashRules.map((r) => r.source)).toEqual(['project', 'user', 'default']);
  });

  it('returns just DEFAULT_RULES when nothing is configured', () => {
    expect(getMergedRules()).toEqual(DEFAULT_RULES);
  });
});

// ── B4: loadUserPermissions / loadProjectPermissions — corrupted-file
// validation. SECURITY: a corrupted or hand-edited permissions file must
// never be trusted into a more permissive state — invalid rules are dropped,
// never granted.
describe('loadUserPermissions / loadProjectPermissions — invalid data handling', () => {
  it('drops a rule whose level is not one of allow/ask/exclude', () => {
    localStorage.setItem(
      'lazy.permissions.user',
      JSON.stringify({ rules: [{ pattern: 'Bash', level: 'superadmin', source: 'user', createdAt: '' }] }),
    );
    expect(loadUserPermissions().rules).toEqual([]);
  });

  it('drops a rule whose pattern is not a string', () => {
    localStorage.setItem(
      'lazy.permissions.user',
      JSON.stringify({ rules: [{ pattern: 42, level: 'allow', source: 'user', createdAt: '' }] }),
    );
    expect(loadUserPermissions().rules).toEqual([]);
  });

  it('keeps a valid rule while dropping an invalid one in the same array', () => {
    localStorage.setItem(
      'lazy.permissions.user',
      JSON.stringify({
        rules: [
          { pattern: 'Bash', level: 'ask', source: 'user', createdAt: '2026-01-01' },
          { pattern: 'Write', level: 'god-mode', source: 'user', createdAt: '2026-01-01' },
        ],
      }),
    );
    expect(loadUserPermissions().rules).toEqual([
      { pattern: 'Bash', level: 'ask', source: 'user', createdAt: '2026-01-01' },
    ]);
  });

  it('falls back to empty rules when the top-level shape is not { rules: [...] }', () => {
    localStorage.setItem('lazy.permissions.user', JSON.stringify({ rules: 'everything' }));
    expect(loadUserPermissions().rules).toEqual([]);
  });

  it('falls back to empty rules when the stored value is a JSON array, not an object', () => {
    localStorage.setItem('lazy.permissions.project', JSON.stringify([{ pattern: 'Bash', level: 'allow' }]));
    expect(loadProjectPermissions().rules).toEqual([]);
  });

  it('falls back to empty rules on unparsable JSON', () => {
    localStorage.setItem('lazy.permissions.user', 'not json at all {');
    expect(loadUserPermissions().rules).toEqual([]);
  });

  it('a well-formed permissions file round-trips unchanged (regression pin)', () => {
    const rules: PermissionRule[] = [rule('Bash(rm -rf**)', 'exclude', 'user')];
    saveUserPermissions({ rules });
    expect(loadUserPermissions().rules).toEqual(rules);
  });
});
