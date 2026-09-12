/* prune-observer-infobox.test.ts — regression: the claude-mem-observer
   policy used to flag ~92% of a real brain (3,246/3,508 notes) because
   isObserverNote tag-stripped the whole article, turning the standard
   <aside class="infobox"> provenance dl ("Source session:dream-…", "Type
   reference Status active") into text matching isAgentMetaText's
   leaked-metadata signatures — which exist for conversation transcripts,
   not stored notes. The infobox is now removed before the check. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';

let tmpDir: string;
let brainDir: string;

/** A well-formed captured note — the exact shape every app capture writes. */
const NORMAL_NOTE = `<article id="normal-note" data-cerveau-version="1" data-cerveau-created="2026-09-12T00:00:00Z" data-cerveau-source="session:dream-88a5673a" data-cerveau-type="reference" data-cerveau-tags="auth security">
<header><h2>Normal knowledge note</h2>
<aside class="infobox"><dl>
<dt>Type</dt><dd>reference</dd>
<dt>Status</dt><dd>active</dd>
<dt>Tags</dt><dd>auth, security</dd>
<dt>Source</dt><dd>session:dream-88a5673a</dd>
</dl></aside></header>
<section data-section="tldr"><p>A real note about auth token rotation.</p></section>
<section data-section="summary"><p>The token refresh path rotates the session token on each call.</p></section>
</article>`;

/** Real observer residue: the observer template text lands in the BODY. */
const OBSERVER_BODY_NOTE = `<article id="observer-note" data-cerveau-version="1" data-cerveau-created="2026-09-12T00:00:00Z" data-cerveau-source="manual" data-cerveau-type="reference">
<h2>observer residue</h2>
<section data-section="tldr"><p>CRITICAL: Record what was LEARNED this turn.</p></section>
</article>`;

/** Observer residue via the source attribute. */
const OBSERVER_SOURCE_NOTE = `<article id="observer-src-note" data-cerveau-version="1" data-cerveau-created="2026-09-12T00:00:00Z" data-cerveau-source="claude-mem-observer" data-cerveau-type="reference">
<h2>observer by source</h2>
<section data-section="tldr"><p>Anything.</p></section>
</article>`;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-prune-infobox-'));
  brainDir = join(tmpDir, 'brain');
  mkdirSync(join(brainDir, 'notes'), { recursive: true });
  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, 'cache');
  resetConfigForTests();
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

describe('runPrune — claude-mem-observer policy', () => {
  it('does NOT flag a normal captured note just because its infobox carries a session source', async () => {
    writeFileSync(join(brainDir, 'notes', 'normal.html'), NORMAL_NOTE, 'utf8');
    const { runPrune } = await import('../prune.js');
    const report = runPrune({ policy: 'claude-mem-observer', dryRun: true });
    expect(report.counts['claude-mem-observer']).toBe(0);
    expect(report.candidates).toHaveLength(0);
  });

  it('still flags notes whose BODY carries observer template text', async () => {
    writeFileSync(join(brainDir, 'notes', 'obs.html'), OBSERVER_BODY_NOTE, 'utf8');
    const { runPrune } = await import('../prune.js');
    const report = runPrune({ policy: 'claude-mem-observer', dryRun: true });
    expect(report.counts['claude-mem-observer']).toBe(1);
  });

  it('still flags notes whose data-cerveau-source names an observer', async () => {
    writeFileSync(join(brainDir, 'notes', 'obs-src.html'), OBSERVER_SOURCE_NOTE, 'utf8');
    const { runPrune } = await import('../prune.js');
    const report = runPrune({ policy: 'claude-mem-observer', dryRun: true });
    expect(report.counts['claude-mem-observer']).toBe(1);
  });
});
