/**
 * structural-untrustworthy-telemetry.test.ts — verifies indexIsTrustworthy()'s
 * visibility fix in structural.ts: a disk-vs-index mismatch must (a) still
 * return COMPLETE results via the full-scan fallback (correctness never
 * regresses) and (b) be OBSERVABLE — a telemetry 'index_untrustworthy' event
 * on every occurrence, plus a one-time stderr warning (mirrors
 * reranker.ts's rerankFallback() dedup pattern).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';

const logTelemetryMock = vi.fn();
const warnMock = vi.fn();

vi.mock('../../util/telemetry.js', async () => {
  const actual = await vi.importActual<typeof import('../../util/telemetry.js')>(
    '../../util/telemetry.js',
  );
  return { ...actual, logTelemetry: logTelemetryMock };
});

vi.mock('../../util/logger.js', () => ({
  getLogger: () => ({ warn: warnMock, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  resetLoggerForTests: vi.fn(),
}));

let tmpDir: string;
let brainDir: string;
let notesPath: string;
let cachePath: string;

function noteHtml(id: string, type: string): string {
  return (
    `<article id="${id}" data-cerveau-type="${type}" data-cerveau-tags="urgent" ` +
    `data-cerveau-created="2026-01-01T00:00:00Z"><h1>${id}</h1><p>Body text for ${id}.</p></article>`
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-structural-telemetry-'));
  brainDir = join(tmpDir, 'brain');
  notesPath = join(brainDir, 'notes');
  cachePath = join(tmpDir, 'cache');
  mkdirSync(notesPath, { recursive: true });
  mkdirSync(cachePath, { recursive: true });
  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  process.env.LAZYBRAIN_CACHE_PATH = cachePath;
  resetConfigForTests();
  logTelemetryMock.mockClear();
  warnMock.mockClear();
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

describe('structuralQuery — untrustworthy-index visibility', () => {
  it('logs an index_untrustworthy telemetry event with the exact counts, and still returns complete results', async () => {
    const { indexNote } = await import('../fts.js');
    const { readNote } = await import('../../store/reader.js');

    const indexedPath = join(notesPath, 'indexed.html');
    writeFileSync(indexedPath, noteHtml('indexed', 'bug'), 'utf-8');
    indexNote(readNote(indexedPath));

    // Orphan: written to disk but never indexed — the exact drift class the
    // audit found (dream.ts / synthesize.ts write paths, pre-fix).
    writeFileSync(join(notesPath, 'orphan.html'), noteHtml('orphan', 'bug'), 'utf-8');

    const { structuralQuery } = await import('../structural.js');
    const hits = structuralQuery('[data-cerveau-type="bug"]', { limit: 50 });

    // Correctness: full-scan fallback still finds BOTH notes.
    expect(hits.map((h) => h.noteId).sort()).toEqual(['indexed', 'orphan']);

    // Visibility: telemetry fired with the exact indexed/disk/missing counts.
    expect(logTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'index_untrustworthy',
        indexed_notes: 1,
        disk_notes: 2,
        missing: 1,
      }),
    );
  });

  it('logs the telemetry event on every occurrence, but warns to stderr only once', async () => {
    writeFileSync(join(notesPath, 'orphan.html'), noteHtml('orphan', 'bug'), 'utf-8');

    const { structuralQuery, resetIndexTrustworthyWarningForTests } = await import(
      '../structural.js'
    );
    resetIndexTrustworthyWarningForTests();

    structuralQuery('[data-cerveau-type="bug"]', { limit: 50 });
    structuralQuery('[data-cerveau-type="bug"]', { limit: 50 });
    structuralQuery('[data-cerveau-type="bug"]', { limit: 50 });

    expect(logTelemetryMock).toHaveBeenCalledTimes(3);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('does not log index_untrustworthy (nor warn) once disk and index agree', async () => {
    const { indexNote } = await import('../fts.js');
    const { readNote } = await import('../../store/reader.js');
    const { structuralQuery, resetIndexTrustworthyWarningForTests } = await import(
      '../structural.js'
    );
    resetIndexTrustworthyWarningForTests();

    const p = join(notesPath, 'only.html');
    writeFileSync(p, noteHtml('only', 'bug'), 'utf-8');
    indexNote(readNote(p));

    structuralQuery('[data-cerveau-type="bug"]', { limit: 50 });

    expect(logTelemetryMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });
});
