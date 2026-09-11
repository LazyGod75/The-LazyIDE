/**
 * db.test.ts — Test SQLite connection pragmas.
 *
 * Verifies that both writable and readonly connections have proper
 * busy_timeout settings to prevent SQLITE_BUSY errors under concurrent access.
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, getReadonlyDb } from '../src/indexer/db.js';
import { resetConfigForTests } from '../src/util/config.js';

describe('db — SQLite connection pragmas', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    resetConfigForTests();
    const brainDir = mkdtempSync(join(tmpdir(), 'lb-db-test-'));
    mkdirSync(join(brainDir, '_cache'), { recursive: true });
    process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
    process.env.LAZYBRAIN_CACHE_PATH = join(brainDir, '_cache');
    resetConfigForTests();
  });

  afterEach(() => {
    closeDb();
    process.env = { ...savedEnv };
    resetConfigForTests();
  });

  it('getDb() connection has busy_timeout = 5000', () => {
    const db = getDb();
    const result = db.prepare('PRAGMA busy_timeout').get() as Record<string, unknown>;
    // PRAGMA busy_timeout returns a single value under the 'timeout' key
    expect(result.timeout).toBe(5000);
  });

  it('getReadonlyDb() connection has busy_timeout = 5000', () => {
    // Ensure the writable connection is initialized first so the DB file exists
    getDb();

    const readonlyDb = getReadonlyDb();
    const result = readonlyDb.prepare('PRAGMA busy_timeout').get() as Record<string, unknown>;
    // PRAGMA busy_timeout returns a single value under the 'timeout' key
    expect(result.timeout).toBe(5000);
  });

  it('both connections use WAL journal mode', () => {
    const db = getDb();
    const readonlyDb = getReadonlyDb();

    const writableResult = db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>;
    const readonlyResult = readonlyDb.prepare('PRAGMA journal_mode').get() as Record<
      string,
      unknown
    >;

    expect(String(writableResult.journal_mode).toLowerCase()).toBe('wal');
    expect(String(readonlyResult.journal_mode).toLowerCase()).toBe('wal');
  });
});
