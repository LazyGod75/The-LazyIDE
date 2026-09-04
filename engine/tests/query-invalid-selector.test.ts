/**
 * QUERY ERRORS — invalid CSS selectors must produce a clear error, exit 1.
 * Valid selectors with zero matches must produce an empty result (no error).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runQuery } from '../src/commands/query.js';
import { closeDb } from '../src/indexer/fts.js';
import { structuralQuery } from '../src/indexer/structural.js';
import { resetConfigForTests } from '../src/util/config.js';

let brainDir: string;

function setupNote(id: string, body: string): void {
  const html = `<article id="${id}" data-cerveau-type="reference"><h2>${id}</h2><p>${body}</p></article>`;
  const notesDir = join(brainDir, 'notes');
  writeFileSync(join(notesDir, `${id}.html`), html, 'utf8');
}

describe('QUERY ERRORS — CSS selector validation', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    brainDir = mkdtempSync(join(tmpdir(), 'lb-query-'));
    mkdirSync(join(brainDir, 'notes'), { recursive: true });
    mkdirSync(join(brainDir, '_cache'), { recursive: true });
    process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
    process.env.LAZYBRAIN_CACHE_PATH = join(brainDir, '_cache');
    resetConfigForTests();
    setupNote('note-one', 'Decision text with some content');
  });

  afterEach(() => {
    closeDb();
    process.env = { ...savedEnv };
    resetConfigForTests();
  });

  it('structuralQuery throws for an invalid CSS selector', () => {
    expect(() => structuralQuery('bogus[selector!!')).toThrow(/Invalid CSS selector/);
  });

  it('structuralQuery error message contains the invalid selector', () => {
    const selector = 'bogus[selector!!';
    try {
      structuralQuery(selector);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain(selector);
    }
  });

  it('structuralQuery returns empty array for valid selector with no matches', () => {
    const hits = structuralQuery('section[data-nonexistent="xyz"]');
    expect(hits).toEqual([]);
  });

  it('structuralQuery returns hits for a valid matching selector', () => {
    const hits = structuralQuery('article[data-cerveau-type="reference"]');
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it('runQuery throws for an invalid selector', () => {
    expect(() => runQuery({ selector: 'bogus[selector!!' })).toThrow(/Invalid CSS selector/);
  });

  it('runQuery returns JSON with count=0 for valid selector with no matches', () => {
    const result = runQuery({ selector: 'section[data-nonexistent="xyz"]' });
    const parsed = JSON.parse(result) as { count: number };
    expect(parsed.count).toBe(0);
  });

  it('runQuery pretty-prints 0 matches without error for valid empty result', () => {
    const result = runQuery({ selector: 'section[data-nonexistent="xyz"]', pretty: true });
    expect(result).toContain('0 matches');
  });

  it('runQuery --strip returns empty string for valid selector with no matches', () => {
    const result = runQuery({ selector: 'section[data-nonexistent="xyz"]', strip: true });
    expect(result).toBe('');
  });
});
