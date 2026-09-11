/**
 * synthesize-indexing.test.ts — regression test for the root-cause bug found
 * in the disk-vs-index drift audit: runSynthesize() wrote topic-overview /
 * brain-index notes to disk via writeNote() but never called indexNote(),
 * so every synthesized page was invisible to the SQLite index (FTS +
 * structural queries) until an unrelated `index-rebuild` swept it up. Fixed
 * alongside this test: indexNote() is now called synchronously right after
 * each writeNote() in synthesize.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';

let tmpDir: string;
let brainDir: string;
let notesPath: string;
let cachePath: string;

function sourceNote(id: string, topic: string): string {
  return `<article id="${id}" data-cerveau-type="decision" data-cerveau-topic="${topic}" data-cerveau-tags="${topic}" data-cerveau-importance="0.8" data-cerveau-created="2026-01-01T00:00:00Z" data-cerveau-version="0.2.0" data-cerveau-source="test"><h1>${id}</h1><p data-cerveau-fact data-cerveau-confidence="1.0" data-cerveau-extracted-by="human">Decision body for ${id}.</p></article>`;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-synthesize-index-'));
  brainDir = join(tmpDir, 'brain');
  notesPath = join(brainDir, 'notes');
  cachePath = join(tmpDir, 'cache');
  mkdirSync(notesPath, { recursive: true });
  mkdirSync(cachePath, { recursive: true });
  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  process.env.LAZYBRAIN_CACHE_PATH = cachePath;
  resetConfigForTests();

  writeFileSync(join(notesPath, 'a.html'), sourceNote('a', 'acme'), 'utf-8');
  writeFileSync(join(notesPath, 'b.html'), sourceNote('b', 'acme'), 'utf-8');
});

afterEach(async () => {
  const { closeDb } = await import('../../indexer/fts.js');
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  resetConfigForTests();
  vi.resetModules();
});

describe('runSynthesize — generated pages are indexed, not just written to disk', () => {
  it('the topic-overview page it writes is queryable via the SQLite index immediately', async () => {
    const { runSynthesize } = await import('../synthesize.js');
    const report = await runSynthesize({ dryRun: false });

    expect(report.synthesized.length).toBeGreaterThan(0);
    expect(report.errors).toEqual([]);

    const { listAll } = await import('../../indexer/fts.js');
    const indexed = listAll({ includeExpired: true });
    const overview = indexed.find((n) => n.type === 'topic-overview' && n.topic === 'acme');
    expect(overview).toBeDefined();
  });
});
