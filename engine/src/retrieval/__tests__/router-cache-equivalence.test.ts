/**
 * End-to-end equivalence test for the three hot-path caches touched in this
 * change set (loadBacklinks(), notesForCwd()'s cwd-index, and
 * applyPageRank()/computePageRank() reusing listAllWithText() instead of a
 * bespoke listAll() call) — see graph/backlinks.ts, graph/pagerank.ts,
 * retrieval/rankers.ts.
 *
 * Forces level='L3' explicitly (bypassing pickLevel) with the embedder
 * forced unavailable: runL3 falls back to runL2's FTS results internally,
 * but router.ts's applyReranking() still gates applyPageRank() on the
 * REQUESTED finalLevel ('L3'), so the PageRank + backlinks-hydration code
 * paths this change touches run for real, against a real SQLite-backed
 * corpus and a real backlinks.json — no mocks on the modules under test.
 *
 * Assertion: calling route() several times in a row against an unchanged
 * corpus returns the EXACT SAME ordered hit-id list every time, and the
 * neighbours attached by hydration are identical too. If a cache introduced
 * staleness or an ordering bug, repeated calls would drift.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';

let tmpDir: string;
let brainDir: string;
let notesDir: string;

interface Seed {
  id: string;
  cwd: string;
  body: string;
  linksTo?: string;
}

const SEEDS: Seed[] = [
  { id: 'note-w1', cwd: 'C:/proj/alpha', body: 'widgetfoobar pipeline design', linksTo: 'note-w2' },
  { id: 'note-w2', cwd: 'C:/proj/alpha', body: 'widgetfoobar rollout plan', linksTo: 'note-w3' },
  { id: 'note-w3', cwd: 'C:/proj/beta', body: 'widgetfoobar incident review' },
  { id: 'note-w4', cwd: 'C:/proj/alpha/sub', body: 'unrelated housekeeping note' },
  { id: 'note-w5', cwd: 'C:/proj/gamma', body: 'widgetfoobar changelog entry' },
];

function writeSeedFile(seed: Seed): string {
  const link = seed.linksTo
    ? ` <a href="#${seed.linksTo}" data-cerveau-link-type="mentions">ref</a>`
    : '';
  const html = `<article id="${seed.id}" data-cerveau-cwd="${seed.cwd}" data-cerveau-tags=""><h1>${seed.id}</h1><p>${seed.body}</p>${link}</article>`;
  const path = join(notesDir, `${seed.id}.html`);
  writeFileSync(path, html, 'utf8');
  return path;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-router-cache-equiv-test-'));
  brainDir = join(tmpDir, 'brain');
  notesDir = join(brainDir, 'notes', '2026-01');
  mkdirSync(notesDir, { recursive: true });
  mkdirSync(join(tmpDir, 'cache'), { recursive: true });
  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, 'cache');
  resetConfigForTests();
});

afterEach(async () => {
  const { closeDb } = await import('../../indexer/db.js');
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  resetConfigForTests();
});

describe('route() cache equivalence (loadBacklinks + notesForCwd + PageRank corpus reuse)', () => {
  it('returns identical ordered hits and neighbours across repeated calls on an unchanged corpus', async () => {
    const { indexNote } = await import('../../indexer/note-index.js');
    const { readNote, readAllNotes } = await import('../../store/reader.js');
    const { buildBacklinks, saveBacklinks } = await import('../../graph/backlinks.js');
    const { forceEmbedderUnavailableForTests, resetEmbedderForTests } = await import(
      '../../indexer/embeddings.js'
    );
    const { route } = await import('../router.js');

    for (const seed of SEEDS) writeSeedFile(seed);
    for (const seed of SEEDS) {
      indexNote(readNote(join(notesDir, `${seed.id}.html`)));
    }
    saveBacklinks(buildBacklinks(readAllNotes()));

    forceEmbedderUnavailableForTests();
    try {
      const runs: Array<{ ids: string[]; neighbours: unknown[] }> = [];
      for (let i = 0; i < 3; i++) {
        const result = await route({
          query: 'Summarize widgetfoobar pipeline notes for the alpha project team',
          level: 'L3',
          topK: 5,
          cwd: 'C:/proj/alpha',
          hydrateNote: true,
        });
        runs.push({
          ids: result.hits.map((h) => h.id),
          neighbours: result.hits.map((h) => h.neighbours ?? []),
        });
      }

      // All three runs must agree, id-for-id, in the same order.
      expect(runs[1].ids).toEqual(runs[0].ids);
      expect(runs[2].ids).toEqual(runs[0].ids);
      expect(runs[1].neighbours).toEqual(runs[0].neighbours);
      expect(runs[2].neighbours).toEqual(runs[0].neighbours);

      // Sanity: the widgetfoobar notes were actually found (not an
      // all-empty degenerate pass).
      expect(runs[0].ids.length).toBeGreaterThan(0);
      expect(runs[0].ids).toEqual(expect.arrayContaining(['note-w1']));

      // note-w1 links to note-w2 — hydration must have attached that
      // outbound edge from the real (cached) backlinks.json.
      const w1 = runs[0].ids.indexOf('note-w1');
      const w1Neighbours = runs[0].neighbours[w1] as Array<{ id: string; direction: string }>;
      expect(w1Neighbours.some((n) => n.id === 'note-w2' && n.direction === 'out')).toBe(true);
    } finally {
      resetEmbedderForTests();
    }
  }, 30_000);
});
