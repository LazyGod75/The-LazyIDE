/**
 * Tests for Feature C: Active working set — recordTouchedFiles / activeFiles.
 *
 * Covers:
 *   - round-trip: recorded paths are returned by activeFiles
 *   - deduplication: same path recorded twice appears once
 *   - most-recent-first ordering (newer paths prepended)
 *   - cap at ACTIVE_FILES_MAX — oldest paths are dropped
 *   - no-op on undefined sessionId
 *   - clearSession removes both injected IDs and touched files
 *   - existing injected-IDs behavior (alreadyInjected / recordInjected) is unchanged
 *   - activeFiles returns empty array for unknown session
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  activeFiles,
  alreadyInjected,
  clearAllSessions,
  clearSession,
  recordInjected,
  recordTouchedFiles,
  sessionCacheStats,
} from '../src/util/session-cache.js';

// Reset all sessions between tests so state does not leak
afterEach(() => {
  clearAllSessions();
});

describe('recordTouchedFiles / activeFiles', () => {
  it('returns empty array for an unknown session', () => {
    expect(activeFiles('no-such-session')).toEqual([]);
  });

  it('returns empty array when sessionId is undefined', () => {
    expect(activeFiles(undefined)).toEqual([]);
  });

  it('records paths and returns them', () => {
    recordTouchedFiles('s1', ['/a/b/c.ts', '/x/y/z.ts']);
    const files = activeFiles('s1');
    expect(files).toContain('/a/b/c.ts');
    expect(files).toContain('/x/y/z.ts');
  });

  it('deduplicates repeated paths', () => {
    recordTouchedFiles('s1', ['/a/b.ts', '/a/b.ts']);
    recordTouchedFiles('s1', ['/a/b.ts']);
    const files = activeFiles('s1');
    const count = files.filter((p) => p === '/a/b.ts').length;
    expect(count).toBe(1);
  });

  it('prepends newer paths so most-recent comes first', () => {
    recordTouchedFiles('s1', ['/old.ts']);
    recordTouchedFiles('s1', ['/new.ts']);
    const files = activeFiles('s1');
    expect(files[0]).toBe('/new.ts');
    const oldIdx = files.indexOf('/old.ts');
    const newIdx = files.indexOf('/new.ts');
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('preserves modified-before-read ordering within a batch', () => {
    recordTouchedFiles('s1', ['/a/modified.ts', '/b/read.ts']);
    const files = activeFiles('s1');
    expect(files[0]).toBe('/a/modified.ts');
    expect(files[1]).toBe('/b/read.ts');
  });

  it('caps the list at ACTIVE_FILES_MAX — oldest entries are dropped', () => {
    // ACTIVE_FILES_MAX is 20; record 25 distinct paths
    const paths = Array.from({ length: 25 }, (_, i) => `/file-${i}.ts`);
    recordTouchedFiles('s1', paths);
    const files = activeFiles('s1');
    expect(files.length).toBeLessThanOrEqual(20);
    // The batch is kept in input order: files 0-19 are kept, 20-24 are dropped
    expect(files).toContain('/file-0.ts');
    expect(files).toContain('/file-19.ts');
    expect(files).not.toContain('/file-20.ts');
    expect(files).not.toContain('/file-24.ts');
  });

  it('is a no-op when sessionId is undefined', () => {
    recordTouchedFiles(undefined, ['/a/b.ts']);
    expect(activeFiles(undefined)).toEqual([]);
    // No session should have been created
    expect(sessionCacheStats().sessions).toBe(0);
  });

  it('is a no-op when paths array is empty', () => {
    recordTouchedFiles('s1', []);
    expect(activeFiles('s1')).toEqual([]);
  });

  it('clearSession removes touched files', () => {
    recordTouchedFiles('s1', ['/a/b.ts']);
    clearSession('s1');
    expect(activeFiles('s1')).toEqual([]);
  });

  it('clearAllSessions removes touched files from all sessions', () => {
    recordTouchedFiles('s1', ['/a.ts']);
    recordTouchedFiles('s2', ['/b.ts']);
    clearAllSessions();
    expect(activeFiles('s1')).toEqual([]);
    expect(activeFiles('s2')).toEqual([]);
  });

  it('touched files and injected IDs coexist in the same session entry', () => {
    recordTouchedFiles('s1', ['/a.ts']);
    recordInjected('s1', ['note-1', 'note-2']);
    expect(activeFiles('s1')).toContain('/a.ts');
    expect(alreadyInjected('s1').has('note-1')).toBe(true);
  });
});

describe('existing injected-IDs behavior — regression guard', () => {
  it('alreadyInjected returns empty set for unknown session', () => {
    expect(alreadyInjected('nobody').size).toBe(0);
  });

  it('alreadyInjected returns empty set for undefined', () => {
    expect(alreadyInjected(undefined).size).toBe(0);
  });

  it('recordInjected stores and retrieves ids', () => {
    recordInjected('rx', ['n1', 'n2']);
    const seen = alreadyInjected('rx');
    expect(seen.has('n1')).toBe(true);
    expect(seen.has('n2')).toBe(true);
  });

  it('clearSession removes injected ids', () => {
    recordInjected('rx', ['n1']);
    clearSession('rx');
    expect(alreadyInjected('rx').size).toBe(0);
  });

  it('sessionCacheStats counts active sessions and total injected', () => {
    recordInjected('a', ['i1', 'i2']);
    recordInjected('b', ['i3']);
    const stats = sessionCacheStats();
    expect(stats.sessions).toBe(2);
    expect(stats.totalInjected).toBe(3);
  });
});
