/**
 * writer-regeneration.test.ts — regression coverage for the orphaned-note
 * defect: composers that regenerate an existing note (composeFileNeuron,
 * composeAggregateNeuron, topic-overview, brain-index, concept-*,
 * synthesize.ts's periodic passes) always stamp data-cerveau-created with
 * "now" on every call — see file-neuron.ts/aggregate-neuron.ts. notePath()
 * partitions storage by month, so writeNote() used to compute a BRAND NEW
 * path once the calendar month rolled over between two regenerations of the
 * SAME id — silently orphaning the previous month's file forever, since
 * overwrite:true had nothing to overwrite at the fresh path. Measured on the
 * owner's real brain: 2133 of 2404 unindexed files (89%) were exactly this.
 *
 * writeNote() now resolves the id's existing on-disk path from the SQLite
 * index (writer.ts's resolveExistingNoteLocation) instead of recomputing
 * notePath(id, now), so a regeneration lands back on the SAME file
 * regardless of which month the composer stamps as "created" — and
 * preserves the ORIGINAL created timestamp, stamping data-cerveau-updated
 * instead (mirrors upsertExisting()'s existing rule for the upsertIfRicher
 * path — see upsert.test.ts).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';

let tmpDir: string;
let brainDir: string;

/** Minimal file-neuron-shaped note — same root attributes writer.ts reads. */
function fileNeuronHtml(id: string, createdIso: string, extra = ''): string {
  return `<article id="${id}" data-cerveau-version="0.3.0" data-cerveau-type="file-neuron" data-cerveau-created="${createdIso}" data-cerveau-source="code-scanner:test" data-cerveau-tags="code file-neuron">${extra}<h1>${id}</h1><section data-section="tldr"><p>demo file</p></section></article>`;
}

/** All note file paths under notes/, relative to brainDir, across every month partition. */
function notesFilesFor(dir: string): string[] {
  const notesDir = join(dir, 'notes');
  if (!existsSync(notesDir)) return [];
  const out: string[] = [];
  for (const month of readdirSync(notesDir)) {
    const monthDir = join(notesDir, month);
    for (const f of readdirSync(monthDir)) out.push(join(month, f));
  }
  return out;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-writer-regen-'));
  brainDir = join(tmpDir, 'brain');
  mkdirSync(join(brainDir, 'notes'), { recursive: true });
  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  resetConfigForTests();
});

afterEach(async () => {
  const { closeDb } = await import('../../indexer/db.js');
  closeDb();
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
  resetConfigForTests();
});

describe('writeNote — regenerating an indexed note across a month boundary', () => {
  it('overwrites the SAME file instead of orphaning the prior month copy', async () => {
    const { writeNote } = await import('../writer.js');
    const { indexNote } = await import('../../indexer/fts.js');
    const { readNote } = await import('../reader.js');

    // Generation 1: composeFileNeuron() stamps created = "now" (June run).
    const first = writeNote(fileNeuronHtml('file-demo-module-index-ts', '2026-06-15T00:00:00Z'), {
      overwrite: true,
    });
    indexNote(readNote(first.path)); // real pipeline: graph.ts indexes right after writing
    expect(first.path).toContain(join('notes', '2026-06'));
    expect(notesFilesFor(brainDir)).toHaveLength(1);

    // Generation 2: same id, composer stamps a FRESH "now" in July — the
    // real bug trigger, regardless of whether the file's content changed.
    const second = writeNote(
      fileNeuronHtml(
        'file-demo-module-index-ts',
        '2026-07-02T00:00:00Z',
        '<meta name="regen" content="2">',
      ),
      { overwrite: true },
    );
    indexNote(readNote(second.path));

    // The fix: writeNote() resolved the existing id via the index and wrote
    // back to the SAME path, not a new notes/2026-07/ file.
    expect(second.path).toBe(first.path);
    expect(notesFilesFor(brainDir)).toHaveLength(1); // no orphan left behind
    expect(readFileSync(second.path, 'utf-8')).toContain('name="regen"');
  });

  it('preserves the ORIGINAL created timestamp and stamps updated on regeneration', async () => {
    const { writeNote } = await import('../writer.js');
    const { indexNote } = await import('../../indexer/fts.js');
    const { readNote } = await import('../reader.js');

    const first = writeNote(fileNeuronHtml('file-demo-b-ts', '2026-06-15T00:00:00Z'), {
      overwrite: true,
    });
    indexNote(readNote(first.path));

    const second = writeNote(fileNeuronHtml('file-demo-b-ts', '2026-07-02T00:00:00Z'), {
      overwrite: true,
    });

    const onDisk = readFileSync(second.path, 'utf-8');
    expect(onDisk).toContain('data-cerveau-created="2026-06-15T00:00:00Z"'); // preserved, not "now"
    expect(onDisk).not.toContain('data-cerveau-created="2026-07-02T00:00:00Z"');
    expect(onDisk).toMatch(/data-cerveau-updated="\d{4}-\d{2}-\d{2}T/); // refreshed to now
  });

  it('falls back to notePath(id, created) when the index has no row for this id (stale/missing index)', async () => {
    const { writeNote } = await import('../writer.js');
    // No indexNote() call — simulates a stale/missing index for this id.
    const first = writeNote(fileNeuronHtml('file-never-indexed-ts', '2026-06-15T00:00:00Z'));
    expect(first.path).toContain(join('notes', '2026-06'));

    const second = writeNote(fileNeuronHtml('file-never-indexed-ts', '2026-08-01T00:00:00Z'), {
      overwrite: true,
    });
    // Without an index row to resolve, the write must still succeed — it
    // lands wherever notePath(id, created) says (a fresh month here), which
    // is today's pre-existing behavior, not a new defect: a write must
    // never be silently dropped just because the index is untrustworthy.
    expect(second.path).not.toBe(first.path);
    expect(existsSync(second.path)).toBe(true);
  });
});
