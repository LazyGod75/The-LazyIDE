import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../config.js';
import {
  type FingerprintStore,
  computeHash,
  getChangedFiles,
  getOrphanedFingerprints,
  hasChanged,
  loadFingerprints,
  recordProcessed,
  saveFingerprints,
} from '../fingerprints.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lazybrain-fingerprints-'));
  mkdirSync(join(tmpDir, 'brain'), { recursive: true });
  mkdirSync(join(tmpDir, 'cache'), { recursive: true });
  // Point config to our tmp dir
  process.env.LAZYBRAIN_BRAIN_PATH = join(tmpDir, 'brain');
  process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, 'cache');
  resetConfigForTests();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  resetConfigForTests();
});

function writeFile(name: string, content: string): string {
  const fp = join(tmpDir, name);
  writeFileSync(fp, content, 'utf-8');
  return fp;
}

function emptyStore(): FingerprintStore {
  return { version: '1.0.0', generatedAt: new Date().toISOString(), files: {} };
}

// ---------------------------------------------------------------------------
// computeHash
// ---------------------------------------------------------------------------

describe('computeHash', () => {
  it('returns a 64-char hex string (SHA-256)', () => {
    const fp = writeFile('hash-test.txt', 'hello world');
    const hash = computeHash(fp);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('returns the same hash for the same content', () => {
    const fp1 = writeFile('a.txt', 'identical content');
    const fp2 = writeFile('b.txt', 'identical content');
    expect(computeHash(fp1)).toBe(computeHash(fp2));
  });

  it('returns different hashes for different content', () => {
    const fp1 = writeFile('c.txt', 'content A');
    const fp2 = writeFile('d.txt', 'content B');
    expect(computeHash(fp1)).not.toBe(computeHash(fp2));
  });
});

// ---------------------------------------------------------------------------
// hasChanged — new file (no fingerprint)
// ---------------------------------------------------------------------------

describe('hasChanged — new file', () => {
  it('returns true when no fingerprint exists', () => {
    const fp = writeFile('new.txt', 'fresh content');
    const store = emptyStore();
    expect(hasChanged(fp, store)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasChanged — fast path (mtime + size match)
// ---------------------------------------------------------------------------

describe('hasChanged — fast path (unchanged)', () => {
  it('returns false when mtime and size match stored fingerprint', () => {
    const fp = writeFile('stable.txt', 'stable content');
    let store = emptyStore();
    store = recordProcessed(fp, [], store);

    expect(hasChanged(fp, store)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasChanged — modified file (different content)
// ---------------------------------------------------------------------------

describe('hasChanged — modified file', () => {
  it('returns true after file content is changed', () => {
    const fp = writeFile('mutable.txt', 'original content');
    let store = emptyStore();
    store = recordProcessed(fp, [], store);

    // Overwrite with different content and advance mtime so fast-path doesn't
    // short-circuit (same-millisecond writes can have identical mtime on some FS)
    writeFileSync(fp, 'modified content', 'utf-8');
    const nowSec = Date.now() / 1000;
    utimesSync(fp, nowSec + 5, nowSec + 5);

    expect(hasChanged(fp, store)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasChanged — slow path (same content, different mtime)
// ---------------------------------------------------------------------------

describe('hasChanged — slow path (same content, different mtime)', () => {
  it('returns false when content is identical despite different mtime', () => {
    const content = 'same content as before';
    const fp = writeFile('touched.txt', content);
    let store = emptyStore();
    store = recordProcessed(fp, [], store);

    // Advance mtime by 10 seconds without changing content
    const nowSec = Date.now() / 1000;
    utimesSync(fp, nowSec + 10, nowSec + 10);

    // mtime now differs from stored — slow path should detect same hash
    expect(hasChanged(fp, store)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasChanged — missing file
// ---------------------------------------------------------------------------

describe('hasChanged — missing file', () => {
  it('returns true when the file no longer exists', () => {
    const fp = join(tmpDir, 'ghost.txt');
    // Build a fake fingerprint for a non-existent file
    const store: FingerprintStore = {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      files: {
        [fp]: {
          filePath: fp,
          contentHash: 'abc123',
          mtimeMs: Date.now(),
          size: 100,
          processedAt: new Date().toISOString(),
          notesCreated: [],
        },
      },
    };
    expect(hasChanged(fp, store)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recordProcessed
// ---------------------------------------------------------------------------

describe('recordProcessed', () => {
  it('adds a fingerprint entry for the file', () => {
    const fp = writeFile('record.txt', 'some content');
    const store = emptyStore();
    const updated = recordProcessed(fp, ['note-1', 'note-2'], store);

    expect(updated.files[fp]).toBeDefined();
    expect(updated.files[fp].notesCreated).toEqual(['note-1', 'note-2']);
    expect(updated.files[fp].contentHash).toHaveLength(64);
  });

  it('does not mutate the original store', () => {
    const fp = writeFile('immutable.txt', 'content');
    const store = emptyStore();
    recordProcessed(fp, [], store);
    expect(store.files[fp]).toBeUndefined();
  });

  it('updates an existing fingerprint when called again', () => {
    const fp = writeFile('update.txt', 'v1 content');
    let store = emptyStore();
    store = recordProcessed(fp, ['note-v1'], store);

    writeFileSync(fp, 'v2 content', 'utf-8');
    store = recordProcessed(fp, ['note-v2'], store);

    expect(store.files[fp].notesCreated).toEqual(['note-v2']);
  });
});

// ---------------------------------------------------------------------------
// getChangedFiles
// ---------------------------------------------------------------------------

describe('getChangedFiles', () => {
  it('returns only files without fingerprints', () => {
    const fp1 = writeFile('known.txt', 'known');
    const fp2 = writeFile('unknown.txt', 'unknown');
    let store = emptyStore();
    store = recordProcessed(fp1, [], store);

    const changed = getChangedFiles([fp1, fp2], store);
    expect(changed).not.toContain(fp1);
    expect(changed).toContain(fp2);
  });

  it('returns an empty array when all files are unchanged', () => {
    const fp1 = writeFile('f1.txt', 'a');
    const fp2 = writeFile('f2.txt', 'b');
    let store = emptyStore();
    store = recordProcessed(fp1, [], store);
    store = recordProcessed(fp2, [], store);

    expect(getChangedFiles([fp1, fp2], store)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getOrphanedFingerprints
// ---------------------------------------------------------------------------

describe('getOrphanedFingerprints', () => {
  it('returns paths that are tracked but no longer exist', () => {
    const fp = writeFile('ephemeral.txt', 'data');
    let store = emptyStore();
    store = recordProcessed(fp, [], store);

    // Delete the file
    rmSync(fp);

    const orphans = getOrphanedFingerprints(store);
    expect(orphans).toContain(fp);
  });

  it('does not flag existing files as orphans', () => {
    const fp = writeFile('persistent.txt', 'data');
    let store = emptyStore();
    store = recordProcessed(fp, [], store);

    expect(getOrphanedFingerprints(store)).not.toContain(fp);
  });
});

// ---------------------------------------------------------------------------
// loadFingerprints / saveFingerprints round-trip
// ---------------------------------------------------------------------------

describe('loadFingerprints / saveFingerprints', () => {
  it('returns an empty store when no file exists', () => {
    const store = loadFingerprints();
    expect(store.version).toBe('1.0.0');
    expect(store.files).toEqual({});
  });

  it('persists and reloads fingerprints correctly', () => {
    const fp = writeFile('persist.txt', 'persistent content');
    let store = loadFingerprints();
    store = recordProcessed(fp, ['note-abc'], store);
    saveFingerprints(store);

    const reloaded = loadFingerprints();
    expect(reloaded.files[fp]).toBeDefined();
    expect(reloaded.files[fp].notesCreated).toEqual(['note-abc']);
  });

  it('returns empty store when file is corrupted', () => {
    // Write garbage to the store path to simulate corruption
    const storePath = join(tmpDir, 'cache', '.fingerprints.json');
    writeFileSync(storePath, '{ INVALID JSON !!!', 'utf-8');

    const store = loadFingerprints();
    expect(store.files).toEqual({});
  });
});
