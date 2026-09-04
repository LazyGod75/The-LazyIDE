/**
 * Tests for codegraph/registry.ts's getRepoByPath — B4: path comparison
 * consolidation.
 *
 * getRepoByPath used to do its own ad hoc path comparison
 * (`path.replace(/\\/g, '/')`), which does not strip a Windows verbatim
 * `\\?\` prefix. paths.ts centralizes that logic (normalizeForPathCompare)
 * after 7 documented ad hoc re-derivations of this exact bug class — see
 * that file's header. This suite pins the fix: a repo registered under its
 * verbatim form must be found via a plain classic-form lookup path.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getRepoByPath } from '../lib/codegraph/registry';
import type { RepoEntry } from '../lib/codegraph/types';

const REGISTRY_KEY = 'lazy.codegraph.registry';

function seedRegistry(entries: RepoEntry[]): void {
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(entries));
}

function entry(path: string): RepoEntry {
  return { name: 'demo', path, indexedAt: 0, lastCommit: null, nodeCount: 0, edgeCount: 0 };
}

beforeEach(() => {
  localStorage.clear();
});

describe('getRepoByPath', () => {
  it('finds a repo registered under a Windows verbatim (\\\\?\\) prefix via a plain classic-form path', () => {
    seedRegistry([entry('\\\\?\\C:\\Users\\user\\Documents\\cerveau\\Lazy')]);
    const found = getRepoByPath('C:\\Users\\user\\Documents\\cerveau\\Lazy');
    expect(found?.name).toBe('demo');
  });

  it('finds a repo registered with backslashes via a forward-slash lookup path', () => {
    seedRegistry([entry('C:\\Users\\user\\Documents\\cerveau\\Lazy')]);
    const found = getRepoByPath('C:/Users/user/Documents/cerveau/Lazy');
    expect(found?.name).toBe('demo');
  });

  it('returns null for a path that is genuinely not registered', () => {
    seedRegistry([entry('C:\\Users\\user\\Documents\\cerveau\\Lazy')]);
    expect(getRepoByPath('C:\\Users\\user\\Documents\\cerveau\\OtherRepo')).toBeNull();
  });

  it('matches regardless of a trailing separator', () => {
    seedRegistry([entry('C:\\Users\\user\\Documents\\cerveau\\Lazy\\')]);
    expect(getRepoByPath('C:\\Users\\user\\Documents\\cerveau\\Lazy')?.name).toBe('demo');
  });
});
