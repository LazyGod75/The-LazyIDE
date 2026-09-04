import { describe, it, expect } from 'vitest';
import {
  parseOrgScope,
  loadProjectScope,
  type OrgScope,
} from '../lib/brain/scope';

// ── parseOrgScope ─────────────────────────────────────────────────

describe('parseOrgScope', () => {
  it.each<[OrgScope]>([['solo'], ['team'], ['dept'], ['global']])(
    'returns %s for the valid string %s',
    (scope) => {
      expect(parseOrgScope(scope)).toBe(scope);
    },
  );

  it('returns solo for an unknown string', () => {
    expect(parseOrgScope('enterprise')).toBe('solo');
  });

  it('returns solo for undefined', () => {
    expect(parseOrgScope(undefined)).toBe('solo');
  });

  it('returns solo for null', () => {
    expect(parseOrgScope(null)).toBe('solo');
  });

  it('returns solo for a number', () => {
    expect(parseOrgScope(42)).toBe('solo');
  });

  it('returns solo for an object', () => {
    expect(parseOrgScope({ scope: 'team' })).toBe('solo');
  });

  it('returns solo for an empty string', () => {
    expect(parseOrgScope('')).toBe('solo');
  });
});

// ── loadProjectScope ──────────────────────────────────────────────

describe('loadProjectScope', () => {
  it('returns solo when scope.json is absent (readFile throws)', async () => {
    const reader = () => Promise.reject(new Error('ENOENT'));
    const scope = await loadProjectScope('/project', reader);
    expect(scope).toBe('solo');
  });

  it('returns solo when scope.json contains invalid JSON', async () => {
    const reader = () => Promise.resolve('not-json{{{');
    const scope = await loadProjectScope('/project', reader);
    expect(scope).toBe('solo');
  });

  it('parses {"scope":"team"} correctly', async () => {
    const reader = () => Promise.resolve(JSON.stringify({ scope: 'team' }));
    const scope = await loadProjectScope('/project', reader);
    expect(scope).toBe('team');
  });

  it('parses {"scope":"dept"} correctly', async () => {
    const reader = () => Promise.resolve(JSON.stringify({ scope: 'dept' }));
    const scope = await loadProjectScope('/project', reader);
    expect(scope).toBe('dept');
  });

  it('parses {"scope":"global"} correctly', async () => {
    const reader = () => Promise.resolve(JSON.stringify({ scope: 'global' }));
    const scope = await loadProjectScope('/project', reader);
    expect(scope).toBe('global');
  });

  it('parses {"scope":"solo"} explicitly', async () => {
    const reader = () => Promise.resolve(JSON.stringify({ scope: 'solo' }));
    const scope = await loadProjectScope('/project', reader);
    expect(scope).toBe('solo');
  });

  it('parses plain string "team"', async () => {
    const reader = () => Promise.resolve(JSON.stringify('team'));
    const scope = await loadProjectScope('/project', reader);
    expect(scope).toBe('team');
  });

  it('defaults to solo for unknown scope value in JSON', async () => {
    const reader = () => Promise.resolve(JSON.stringify({ scope: 'enterprise' }));
    const scope = await loadProjectScope('/project', reader);
    expect(scope).toBe('solo');
  });

  it('defaults to solo for JSON null', async () => {
    const reader = () => Promise.resolve('null');
    const scope = await loadProjectScope('/project', reader);
    expect(scope).toBe('solo');
  });

  it('builds scope.json path from a root ending with slash', async () => {
    let capturedPath = '';
    const reader = (path: string) => {
      capturedPath = path;
      return Promise.reject(new Error('ENOENT'));
    };
    await loadProjectScope('/project/', reader);
    expect(capturedPath).toBe('/project/scope.json');
  });

  it('builds scope.json path from a root without trailing slash', async () => {
    let capturedPath = '';
    const reader = (path: string) => {
      capturedPath = path;
      return Promise.reject(new Error('ENOENT'));
    };
    await loadProjectScope('/project', reader);
    expect(capturedPath).toBe('/project/scope.json');
  });

  it('parses a valid team scope on its own — the runtime teams gate now lives in teamsActive() (src/lib/features.ts), not in this module', async () => {
    // This module no longer exports a hardcoded gate constant (removed as
    // part of the T4.2 fix — see scope.ts's header comment). Parsing a
    // scope value here says nothing about whether teams routing is
    // actually active for the user; that is teamsActive()'s job, covered
    // in features.test.ts.
    const reader = () => Promise.resolve(JSON.stringify({ scope: 'team' }));
    const scope = await loadProjectScope('/project', reader);
    expect(scope).toBe('team');
  });
});
