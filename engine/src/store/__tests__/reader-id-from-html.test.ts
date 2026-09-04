/**
 * reader-id-from-html.test.ts — regression coverage for the greedy-regex bug
 * in reader.ts's idFromHtml() (private helper, exercised via the public
 * readNote() contract).
 *
 * Bug: `<article\b[^>]*\bid\s*=...` used a GREEDY `[^>]*`, which backtracks
 * from the end of the tag and so matches the LAST `\bid\s*=` occurrence in
 * the article's attribute list, not the first. A note whose `<article>` tag
 * carries both the real `id="..."` attribute and a `data-cerveau-author-id`
 * (a team/multi-author capture note) resolved note.id to the AUTHOR id
 * instead of the real note id — silently, no thrown error. Found on a real
 * production note (source: lazy-ide:agents) during this audit: 1 of 9930
 * notes on the real brain carry data-cerveau-author-id, and this is exactly
 * the one where the bug fired.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNote } from '../reader.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-reader-id-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeAndRead(html: string): string {
  const fp = join(tmpDir, 'note.html');
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(fp, html, 'utf-8');
  return readNote(fp).id;
}

describe('readNote — id resolution is not fooled by an -id-suffixed attribute', () => {
  it('resolves the real id when data-cerveau-author-id follows it (the real-brain shape)', () => {
    const id = writeAndRead(
      '<article id="mission-real-note-id" data-cerveau-type="episodic" ' +
        'data-cerveau-author="davidlazyide" data-cerveau-author-id="a90b099a-025d-410c-b40f-ac139873f0b3">' +
        '<h2>Mission</h2><p>body</p></article>',
    );
    expect(id).toBe('mission-real-note-id');
  });

  it('resolves the real id when data-cerveau-author-id precedes it (order must not matter)', () => {
    const id = writeAndRead(
      '<article data-cerveau-author-id="a90b099a-025d-410c-b40f-ac139873f0b3" ' +
        'data-cerveau-author="davidlazyide" id="mission-real-note-id" data-cerveau-type="episodic">' +
        '<h2>Mission</h2><p>body</p></article>',
    );
    expect(id).toBe('mission-real-note-id');
  });

  it('resolves the real id across a multi-line article tag (the real composer template shape)', () => {
    const id = writeAndRead(
      '<article\n' +
        '  id="mission-real-note-id"\n' +
        '  data-cerveau-type="episodic"\n' +
        '  data-cerveau-author-id="a90b099a-025d-410c-b40f-ac139873f0b3">\n' +
        '<h2>Mission</h2><p>body</p></article>',
    );
    expect(id).toBe('mission-real-note-id');
  });

  it('still resolves a plain note with only a bare id attribute (no regression)', () => {
    const id = writeAndRead(
      '<article id="plain-note" data-cerveau-type="episodic"><h2>T</h2><p>body</p></article>',
    );
    expect(id).toBe('plain-note');
  });

  it('is not fooled by other -id-suffixed attributes (item-id, cerveau-id-like names)', () => {
    const id = writeAndRead(
      '<article data-cerveau-item-id="item-999" id="real-id" data-cerveau-project-id="proj-1">' +
        '<h2>T</h2><p>body</p></article>',
    );
    expect(id).toBe('real-id');
  });

  it('resolves the id of a <memory-batch> root (compress.ts consolidated-batch notes)', () => {
    // Regression: the article-only regex left note.id === '' for every
    // memory-batch note, which — since id is a SQL PRIMARY KEY — made every
    // batch note collide on the same empty id and silently overwrite each
    // other's index row (ON CONFLICT(id) DO UPDATE). See idFromHtml()'s doc
    // comment in reader.ts.
    const id = writeAndRead(
      '<memory-batch id="batch-2026-08-16-all" data-cerveau-type="semantic" ' +
        'data-cerveau-tier="archival"><h2>Consolidated batch</h2><p>body</p></memory-batch>',
    );
    expect(id).toBe('batch-2026-08-16-all');
  });
});
