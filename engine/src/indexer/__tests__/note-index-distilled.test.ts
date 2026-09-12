/**
 * Regression: distilled fields must reach the FTS index.
 *
 * Aliases/questions/entities live in HTML ATTRIBUTE values (meta content=,
 * details data-q=, data-cerveau-entities) — never in textContent — so
 * stripTags() alone could not surface them to BM25. indexNote() now appends
 * them to the indexed text (see note-index.ts's distilled-field injection).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';

let tmpDir: string;
let notesPath: string;

function writeNote(id: string, html: string): string {
  const fp = join(notesPath, `${id}.html`);
  writeFileSync(fp, html, 'utf-8');
  return fp;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-distilled-'));
  notesPath = join(tmpDir, 'brain', 'notes');
  mkdirSync(notesPath, { recursive: true });
  process.env.LAZYBRAIN_BRAIN_PATH = join(tmpDir, 'brain');
  process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, 'cache');
  resetConfigForTests();
});

afterEach(async () => {
  const { closeDb } = await import('../fts.js');
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  resetConfigForTests();
  vi.resetModules();
});

describe('indexNote — distilled fields reach FTS', () => {
  it('an alias-only token ("pg") matches a note whose body never says it', async () => {
    const { indexNote } = await import('../fts.js');
    const { searchFts } = await import('../fts.js');
    const { readNote } = await import('../../store/reader.js');
    const fp = writeNote(
      'postgres-note',
      `<article id="postgres-note" data-cerveau-type="note" data-cerveau-created="2026-01-01T00:00:00Z"><head><meta name="aliases" content="pg,postgresql"></head><h1>Postgres tuning</h1><p>Connection pool sizing and vacuum cadence.</p></article>`,
    );
    indexNote(readNote(fp));
    const hits = searchFts('pg');
    expect(hits.map((h) => h.id)).toContain('postgres-note');
  });

  it('a question token from details[data-q] reaches FTS', async () => {
    const { indexNote, searchFts } = await import('../fts.js');
    const { readNote } = await import('../../store/reader.js');
    const fp = writeNote(
      'why-note',
      `<article id="why-note" data-cerveau-type="decision" data-cerveau-created="2026-01-01T00:00:00Z"><h1>Auth broker</h1><p>Mobile and web share one broker.</p><details data-q="why-pkce-instead-of-cookies"><summary>Why?</summary>Because session cookies broke the webview.</details></article>`,
    );
    indexNote(readNote(fp));
    const hits = searchFts('pkce');
    expect(hits.map((h) => h.id)).toContain('why-note');
  });

  it('tldr section terms get extra BM25 weight (duplicate injection is deliberate)', async () => {
    const { indexNote, searchFts } = await import('../fts.js');
    const { readNote } = await import('../../store/reader.js');
    // Note A mentions "quixotic" once in body; note B has it in a tldr
    // section AND once in body — B must rank first.
    const a = writeNote(
      'note-a',
      `<article id="note-a" data-cerveau-type="note" data-cerveau-created="2026-01-01T00:00:00Z"><h1>A</h1><p>Some quixotic endeavour.</p></article>`,
    );
    const b = writeNote(
      'note-b',
      `<article id="note-b" data-cerveau-type="note" data-cerveau-created="2026-01-01T00:00:00Z"><h1>B</h1><section data-section="tldr"><p>A quixotic plan.</p></section><p>Body.</p></article>`,
    );
    indexNote(readNote(a));
    indexNote(readNote(b));
    const hits = searchFts('quixotic');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0].id).toBe('note-b');
  });
});
