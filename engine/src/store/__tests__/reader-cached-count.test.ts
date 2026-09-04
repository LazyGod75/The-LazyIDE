/**
 * reader-cached-count.test.ts — countAllNoteFilesCached() must always return
 * the same answer as the uncached countAllNoteFiles(), while avoiding a full
 * recursive readdir when nothing changed. See store/reader.ts's doc comment
 * on countAllNoteFilesCached() for the per-month mtime-gating design this
 * exercises.
 */

import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';
import {
  countAllNoteFiles,
  countAllNoteFilesCached,
  resetNoteFileCountCacheForTests,
} from '../reader.js';

let tmpDir: string;
let brainDir: string;
let notesPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-reader-count-'));
  brainDir = join(tmpDir, 'brain');
  notesPath = join(brainDir, 'notes');
  mkdirSync(notesPath, { recursive: true });
  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, 'cache');
  resetConfigForTests();
  resetNoteFileCountCacheForTests();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  resetConfigForTests();
});

function writeMonthNote(month: string, id: string): void {
  const dir = join(notesPath, month);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.html`),
    `<article id="${id}" data-cerveau-created="2026-01-01T00:00:00Z"><h1>${id}</h1></article>`,
    'utf-8',
  );
}

/**
 * A real caller of countAllNoteFilesCached() never re-checks in the same
 * sub-millisecond JS tick as the write that changed the directory it's
 * gated on (a fresh CLI process, or a `serve` request arriving after
 * IPC/network round-trip, is always at least several ms downstream). Tests
 * that write, THEN assert the cache observed the change, insert this delay
 * between the two so they exercise that realistic gap instead of a window
 * narrow enough for NTFS to coalesce two directory-mtime updates into one.
 */
function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('countAllNoteFilesCached', () => {
  it('matches the uncached count on an empty brain', () => {
    expect(countAllNoteFilesCached()).toBe(countAllNoteFiles());
    expect(countAllNoteFilesCached()).toBe(0);
  });

  it('matches the uncached count after notes are added to a single month', () => {
    writeMonthNote('2026-07', 'a');
    writeMonthNote('2026-07', 'b');
    expect(countAllNoteFilesCached()).toBe(2);
    expect(countAllNoteFilesCached()).toBe(countAllNoteFiles());
  });

  it('detects a new note added to an EXISTING month directory (mtime-gated cache must not go stale)', async () => {
    writeMonthNote('2026-07', 'a');
    expect(countAllNoteFilesCached()).toBe(1); // warms the per-month cache entry

    await tick();
    writeMonthNote('2026-07', 'b'); // same month dir, new file -> bumps its mtime
    expect(countAllNoteFilesCached()).toBe(2);
    expect(countAllNoteFilesCached()).toBe(countAllNoteFiles());
  });

  it('detects notes added to a BRAND NEW month directory', async () => {
    writeMonthNote('2026-07', 'a');
    expect(countAllNoteFilesCached()).toBe(1);

    await tick();
    writeMonthNote('2026-08', 'b'); // new subdirectory entirely
    expect(countAllNoteFilesCached()).toBe(2);
    expect(countAllNoteFilesCached()).toBe(countAllNoteFiles());
  });

  it('detects a deleted note (count goes down, not just up)', async () => {
    writeMonthNote('2026-07', 'a');
    writeMonthNote('2026-07', 'b');
    expect(countAllNoteFilesCached()).toBe(2);

    // A real caller never checks in the same sub-millisecond tick as the
    // write that changed the directory (a fresh CLI process, or a `serve`
    // request arriving after IPC/network round-trip, is always at least
    // several ms downstream) — but back-to-back synchronous fs calls within
    // one JS tick CAN observe NTFS coalesce two directory-mtime updates into
    // one, which is exactly what this small delay avoids asserting past.
    await new Promise((resolve) => setTimeout(resolve, 20));
    unlinkSync(join(notesPath, '2026-07', 'a.html'));
    expect(countAllNoteFilesCached()).toBe(1);
    expect(countAllNoteFilesCached()).toBe(countAllNoteFiles());
  });

  it('is correct across multiple months, only some of which changed between calls', async () => {
    writeMonthNote('2026-06', 'a');
    writeMonthNote('2026-07', 'b');
    writeMonthNote('2026-08', 'c');
    expect(countAllNoteFilesCached()).toBe(3);

    // Only touch 2026-08; 2026-06/2026-07 must be served from cache and
    // still contribute the correct (unchanged) counts.
    await tick();
    writeMonthNote('2026-08', 'd');
    expect(countAllNoteFilesCached()).toBe(4);
    expect(countAllNoteFilesCached()).toBe(countAllNoteFiles());
  });
});
