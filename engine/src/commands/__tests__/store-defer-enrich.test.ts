/* store-defer-enrich.test.ts — regression for the capture-timeout bug:
   a conversation-eligible `store` ran ~30s of incremental enrichment +
   recompose synchronously, past Rust's 30s brain_capture ceiling, so every
   capture timed out and gave up (`brain.capture_failed`). With
   `deferEnrich`, store arms the pending-enrich marker and returns after the
   write+index path; the serve drain does the corpus pass instead. */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumePendingEnrich, pendingEnrichMarkerPath } from '../../store/pending-enrich.js';
import { resetConfigForTests } from '../../util/config.js';

let tmpDir: string;
let brainDir: string;
let cachePath: string;

const CONV_HTML = `<article id="conv-note-test" data-cerveau-version="1" data-cerveau-created="2026-09-12T00:00:00Z" data-cerveau-source="test" data-cerveau-type="decision"><h1>conv note</h1><p>A decision was made about the thing.</p></article>`;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-defer-enrich-'));
  brainDir = join(tmpDir, 'brain');
  cachePath = join(tmpDir, 'cache');
  mkdirSync(join(brainDir, 'notes'), { recursive: true });
  mkdirSync(cachePath, { recursive: true });
  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  process.env.LAZYBRAIN_CACHE_PATH = cachePath;
  process.env.LAZYBRAIN_EMBEDDINGS = '0';
  resetConfigForTests();
});

afterEach(async () => {
  const { closeDb } = await import('../../indexer/fts.js');
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  delete process.env.LAZYBRAIN_EMBEDDINGS;
  resetConfigForTests();
  vi.resetModules();
});

describe('runStore --defer-enrich', () => {
  it('arms the pending-enrich marker for a conv-eligible note instead of running the tail inline', async () => {
    const { runStore } = await import('../store.js');
    await runStore({ html: CONV_HTML, deferEnrich: true });
    expect(existsSync(pendingEnrichMarkerPath())).toBe(true);
  });

  it('still writes and indexes the note synchronously (read-after-write preserved)', async () => {
    const { runStore } = await import('../store.js');
    const { listAll } = await import('../../indexer/fts.js');
    const out = JSON.parse(await runStore({ html: CONV_HTML, deferEnrich: true }));
    expect(out.id).toBe('conv-note-test');
    expect(existsSync(out.path)).toBe(true);
    expect(listAll({ includeExpired: false }).some((n) => n.id === 'conv-note-test')).toBe(true);
  });

  it('does NOT arm the marker for generated note types (not conv-eligible)', async () => {
    const { runStore } = await import('../store.js');
    const neuronHtml = CONV_HTML.replace(
      'data-cerveau-type="decision"',
      'data-cerveau-type="file-neuron"',
    ).replace('conv-note-test', 'conv-neuron-test');
    await runStore({ html: neuronHtml, deferEnrich: true });
    expect(existsSync(pendingEnrichMarkerPath())).toBe(false);
  });

  it('without deferEnrich the marker is not armed (sync path unchanged)', async () => {
    const { runStore } = await import('../store.js');
    await runStore({ html: CONV_HTML });
    expect(existsSync(pendingEnrichMarkerPath())).toBe(false);
  });
});

describe('consumePendingEnrich (serve drain primitive)', () => {
  it('consumes an armed marker once, then reports none', async () => {
    const { armPendingEnrich } = await import('../../store/pending-enrich.js');
    armPendingEnrich('conv-note-test');
    expect(existsSync(pendingEnrichMarkerPath())).toBe(true);
    expect(consumePendingEnrich()).toBe(true);
    expect(existsSync(pendingEnrichMarkerPath())).toBe(false);
    expect(consumePendingEnrich()).toBe(false);
  });

  it('returns false when nothing is armed', () => {
    expect(consumePendingEnrich()).toBe(false);
  });
});
