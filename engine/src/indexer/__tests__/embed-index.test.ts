/**
 * Tests that index-time note writes populate note_embeddings.
 *
 * Context: previously, upsertNoteEmbedding was only ever called LAZILY from
 * the L3 query path (resolveCorpusVectors in retrieval/levels/l3.ts). A
 * freshly indexed brain — e.g. right after `graph --cwd` + `index-rebuild` —
 * had zero rows in note_embeddings, so semantic/hybrid (L3) recall had
 * nothing to match against until a user's first query paid the full
 * embed-everything cost inline. embed-index.ts's embedNotesForIndex() now
 * runs as part of indexing itself (rebuildAll / runIncrementalUpdate /
 * graph's code-scan write path), reusing the SAME resolveCorpusVectors()
 * cache path L3 already relies on.
 *
 * The ONNX model itself is mocked out (getEmbedder/embed) so this suite is
 * fast and hermetic — it verifies the WIRING (index-time writes reach
 * upsertNoteEmbedding via the shared embed-index.ts pass), not the model.
 * hashKey/MODEL_ID/isEmbedderUnavailable are left real (vi.importActual) so
 * the content-hash cache-diffing logic under test is the genuine article.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';

// ---------------------------------------------------------------------------
// Mock the ONNX embedder only — everything else (hashing, SQLite cache diff,
// FTS indexing) runs for real against a real temp SQLite DB.
// ---------------------------------------------------------------------------

vi.mock('../embeddings.js', async () => {
  const actual = await vi.importActual<typeof import('../embeddings.js')>('../embeddings.js');
  return {
    ...actual,
    getEmbedder: vi.fn(async () => ({}) as unknown),
    embed: vi.fn(async (texts: string[]) =>
      texts.map((t) => {
        const v = new Float32Array(768);
        for (let i = 0; i < v.length; i++) {
          v[i] = ((t.charCodeAt(i % Math.max(t.length, 1)) || 1) % 97) / 97;
        }
        return v;
      }),
    ),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let brainDir: string;
let notesPath: string;
let cachePath: string;

function noteHtml(id: string, title: string): string {
  return (
    `<article id="${id}" data-cerveau-type="note" data-cerveau-tags="" ` +
    `data-cerveau-created="2026-01-01T00:00:00Z"><h1>${title}</h1><p>Body text for ${title}.</p></article>`
  );
}

function writeNote(name: string, content: string): string {
  const fp = join(notesPath, name);
  writeFileSync(fp, content, 'utf-8');
  return fp;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-embed-index-test-'));
  brainDir = join(tmpDir, 'brain');
  notesPath = join(brainDir, 'notes');
  cachePath = join(tmpDir, 'cache');
  mkdirSync(notesPath, { recursive: true });
  mkdirSync(cachePath, { recursive: true });

  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  process.env.LAZYBRAIN_CACHE_PATH = cachePath;
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
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('index-time embedding pass', () => {
  it('runIncrementalUpdate populates note_embeddings for newly indexed notes', async () => {
    writeNote('a.html', noteHtml('note-a', 'Note A'));
    writeNote('b.html', noteHtml('note-b', 'Note B'));

    const { runIncrementalUpdate } = await import('../../commands/index-update.js');
    const result = await runIncrementalUpdate();
    expect(result.indexed).toBe(2);
    expect(result.failed).toBe(0);

    const { loadAllStoredEmbeddings } = await import('../fts.js');
    const stored = loadAllStoredEmbeddings();
    expect(stored.size).toBe(2);
    expect(stored.has('note-a')).toBe(true);
    expect(stored.has('note-b')).toBe(true);
  });

  it('rebuildAll (--full) populates note_embeddings for every note', async () => {
    writeNote('c.html', noteHtml('note-c', 'Note C'));
    writeNote('d.html', noteHtml('note-d', 'Note D'));
    writeNote('e.html', noteHtml('note-e', 'Note E'));

    const { rebuildAll, loadAllStoredEmbeddings } = await import('../fts.js');
    const result = await rebuildAll();
    expect(result.indexed).toBe(3);
    expect(result.failed).toBe(0);

    const stored = loadAllStoredEmbeddings();
    expect(stored.size).toBe(3);
  });

  it('is cache-aware across incremental runs: unchanged files are not re-embedded', async () => {
    writeNote('f.html', noteHtml('note-f', 'Note F'));
    const { runIncrementalUpdate } = await import('../../commands/index-update.js');
    const { embed } = await import('../embeddings.js');

    await runIncrementalUpdate();
    expect(vi.mocked(embed)).toHaveBeenCalledTimes(1);

    // Second run: nothing changed on disk -> the fingerprint check skips the
    // note entirely, so it never reaches embedNotesForIndex -> embed() must
    // not be called again.
    const second = await runIncrementalUpdate();
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(1);
    expect(vi.mocked(embed)).toHaveBeenCalledTimes(1);
  });

  it('is cache-aware by content hash: a --full rebuild of unchanged notes re-embeds nothing', async () => {
    writeNote('g.html', noteHtml('note-g', 'Note G'));
    writeNote('h.html', noteHtml('note-h', 'Note H'));
    const { rebuildAll } = await import('../fts.js');
    const { embed } = await import('../embeddings.js');

    // First full rebuild: both notes are missing from note_embeddings -> embed() runs once.
    await rebuildAll();
    expect(vi.mocked(embed)).toHaveBeenCalledTimes(1);

    // Second full rebuild: note-index.ts wipes and re-indexes ALL notes
    // again (indexNote() runs for every note, unlike the incremental path),
    // but the note content — and therefore the embed-text hash — is
    // unchanged, so resolveCorpusVectors() must find a cache hit for both
    // and make zero additional embed() calls. This isolates the SQLite
    // content-hash cache from the separate file-fingerprint skip tested
    // above.
    await rebuildAll();
    expect(vi.mocked(embed)).toHaveBeenCalledTimes(1);

    const { loadAllStoredEmbeddings } = await import('../fts.js');
    expect(loadAllStoredEmbeddings().size).toBe(2);
  });

  it('never throws when the embedder is unavailable — FTS index still succeeds', async () => {
    const { getEmbedder } = await import('../embeddings.js');
    vi.mocked(getEmbedder).mockResolvedValueOnce(null);

    writeNote('i.html', noteHtml('note-i', 'Note I'));
    const { runIncrementalUpdate } = await import('../../commands/index-update.js');
    const result = await runIncrementalUpdate();

    expect(result.indexed).toBe(1);
    expect(result.failed).toBe(0);

    const { countAllNotes, loadAllStoredEmbeddings } = await import('../fts.js');
    expect(countAllNotes()).toBe(1);
    expect(loadAllStoredEmbeddings().size).toBe(0);
  });
});
