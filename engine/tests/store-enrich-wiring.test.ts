/**
 * store-enrich-wiring.test.ts
 *
 * Regression test for a wiring gap: the real desktop app never writes
 * neurons through the `capture` CLI verb (capture.ts) — Rust's
 * `brain_capture` (src-tauri/src/commands/brain/capture.rs) spawns
 * `lazybrain store` over stdin for every in-editor capture (decisions,
 * bugs, learnings, episodic notes). There is no `/store` daemon HTTP route
 * either (see daemon.ts) — the CLI spawn is the only production path.
 *
 * capture.ts and capture-vibe.ts both auto-run `runIncrementalEnrich()`
 * after writing a note, but store.ts (the verb the app actually uses) did
 * not — so a decision/bug typed in the app was written to the brain but
 * NEVER attached to the file-neuron it referenced, and enrich-state.json
 * was never created via this path. See store.ts's runStore for the fix.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeFileNeuron } from '../src/annotator/blocks/composers/file-neuron.js';
import { isConvEligibleNoteHtml, resetEnrichStateForTests } from '../src/commands/enrich.js';
import { runInit } from '../src/commands/init.js';
import { runStore } from '../src/commands/store.js';
import type { CodeNode } from '../src/graph/code-scanner.js';
import { closeDb, indexNote } from '../src/indexer/fts.js';
import { readAllNotes, readNote } from '../src/store/reader.js';
import { writeNote } from '../src/store/writer.js';
import { getConfig, resetConfigForTests } from '../src/util/config.js';

const AUTH_NODE: CodeNode = {
  id: 'file:src/auth.ts',
  title: 'src/auth.ts',
  type: 'file',
  filePath: 'src/auth.ts',
  projectRoot: '/fixture-project',
  language: 'typescript',
  lineCount: 40,
  imports: [],
  exports: ['login'],
};

/**
 * Build neuron HTML in the exact shape Rust's `event_to_html`
 * (src-tauri/src/commands/brain/capture.rs) produces for a CaptureEvent —
 * this is what real in-app captures pipe into `lazybrain store` over stdin.
 */
function eventHtml(opts: { id: string; kind: string; title: string; text: string }): string {
  const now = new Date().toISOString();
  return `<article id="${opts.id}"
     data-cerveau-version="0.2.0"
     data-cerveau-created="${now}"
     data-cerveau-updated="${now}"
     data-cerveau-type="${opts.kind}"
     data-cerveau-source="lazy-ide:capture"
     data-cerveau-tier="working"
     data-cerveau-importance="0.6"
     data-cerveau-tags="test">

  <h2>${opts.title}</h2>

  <p data-cerveau-fact data-cerveau-confidence="1.0" data-cerveau-extracted-by="human">
    ${opts.text}
  </p>
</article>`;
}

function enrichStatePath(): string {
  return join(getConfig().cachePath, 'enrich-state.json');
}

describe('runStore -> incremental enrich wiring (real app capture parity)', () => {
  let tmpDir: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lb-store-enrich-'));
    process.env.LAZYBRAIN_BRAIN_PATH = join(tmpDir, '.lazybrain', 'brain');
    process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, '.lazybrain', '_cache');
    resetConfigForTests();
    await runInit({ path: join(tmpDir, '.lazybrain', 'brain') });
    resetEnrichStateForTests();

    // Seed a file-neuron for src/auth.ts, as `lazybrain graph --cwd` would
    // for a real project.
    const html = composeFileNeuron(AUTH_NODE);
    const written = writeNote(html, { overwrite: true });
    indexNote(readNote(written.path));
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    process.env = { ...savedEnv };
    resetConfigForTests();
  });

  it('attaches a decision captured via `store` (the app write path) to the matching file-neuron', async () => {
    const html = eventHtml({
      id: `decision-test-${Date.now()}`,
      kind: 'decision',
      title: 'Auth hashing decision',
      text: 'decided to use bcrypt for password hashing in src/auth.ts',
    });

    const out = JSON.parse(await runStore({ html }));
    expect(out.id).toBeTruthy();

    const notes = readAllNotes();
    const fileNeuron = notes.find(
      (n) => n.html.includes('data-cerveau-type="file-neuron"') && n.html.includes('src/auth.ts'),
    );
    expect(fileNeuron).toBeDefined();
    expect(fileNeuron!.html).toContain('data-section="decisions"');
    expect(fileNeuron!.html).toContain('decided to use bcrypt for password hashing');
    // Regression guard: the file path mentioned mid/end-of-sentence must keep
    // its extension in the rendered item text (splitIntoSentenceChunks must
    // not let the sentence-splitter treat "src/auth.ts"'s dot as a terminator
    // and silently truncate it to "src/auth").
    expect(fileNeuron!.html).toContain('src/auth.ts');
  });

  it('attaches a bug captured via `store` to the matching file-neuron', async () => {
    const html = eventHtml({
      id: `bug-test-${Date.now()}`,
      kind: 'episodic',
      title: 'Auth bug',
      text: 'bug: login crashed when the token in src/auth.ts expired mid-request',
    });

    await runStore({ html });

    const notes = readAllNotes();
    const fileNeuron = notes.find(
      (n) => n.html.includes('data-cerveau-type="file-neuron"') && n.html.includes('src/auth.ts'),
    );
    expect(fileNeuron).toBeDefined();
    expect(fileNeuron!.html).toContain('data-section="bugs"');
    expect(fileNeuron!.html).toContain('login crashed when the token');
    // Regression guard: "src/auth.ts" sits MID-sentence here (followed by
    // "expired mid-request") — the exact shape that used to get truncated to
    // "src/auth" by the naive `.split(/[.!\n]+/)` sentence splitter.
    expect(fileNeuron!.html).toContain('src/auth.ts');
  });

  // -------------------------------------------------------------------------
  // Regression coverage for the conv->file-neuron attachment bug (2026-07-04):
  // a real conversation stating a decision/bug about a file did NOT attach to
  // that file's neuron, even though the enrichment pipeline ran end-to-end.
  //
  // Root causes fixed in commands/enrich.ts:
  //   1. CLASSIFIERS 'decision'/'idea' patterns required the ACCENTED French
  //      spelling ("décidé"/"idée") — an unaccented "on a decide d'utiliser X"
  //      (very common: fast typing, non-French keyboard layout) matched no
  //      classifier at all and silently fell back to the generic 'activity'
  //      bucket instead of 'decisions'.
  //   2. The naive sentence splitter (`text.split(/[.!\n]+/)`) treated the
  //      '.' in a file extension (e.g. "LocaleSwitcher.tsx") as a sentence
  //      terminator, truncating the classified item's displayed text to
  //      "LocaleSwitcher" (extension silently dropped).
  //
  // These tests exercise the EXACT `runStore` production path (not
  // `runFileNeuronEnrichment` directly) so they prove the fix holds for real
  // app captures, not just for hand-built ConvNote fixtures.
  // -------------------------------------------------------------------------
  describe('French classifier + path-extension regression (2026-07-04)', () => {
    it('attaches an UNACCENTED French decision ("on a decide") to decisions, not activity', async () => {
      const html = eventHtml({
        id: `fr-decision-noaccent-${Date.now()}`,
        kind: 'decision',
        title: 'i18n decision',
        text: "On a decide d'utiliser next-intl dans src/auth.ts parce que c'est la solution native de Next",
      });

      await runStore({ html });

      const notes = readAllNotes();
      const fileNeuron = notes.find(
        (n) => n.html.includes('data-cerveau-type="file-neuron"') && n.html.includes('src/auth.ts'),
      );
      expect(fileNeuron).toBeDefined();
      // Must land in 'decisions', NOT the keyword-less 'activity' fallback.
      expect(fileNeuron!.html).toContain('data-section="decisions"');
      expect(fileNeuron!.html).not.toContain('data-section="activity"');
      // The path mid-sentence must keep its extension.
      expect(fileNeuron!.html).toContain('src/auth.ts');
    });

    it('attaches an ACCENTED French decision ("on a décidé") to decisions (no regression)', async () => {
      const html = eventHtml({
        id: `fr-decision-accent-${Date.now()}`,
        kind: 'decision',
        title: 'i18n decision',
        text: "On a décidé d'utiliser next-intl dans src/auth.ts parce que c'est la solution native de Next",
      });

      await runStore({ html });

      const notes = readAllNotes();
      const fileNeuron = notes.find(
        (n) => n.html.includes('data-cerveau-type="file-neuron"') && n.html.includes('src/auth.ts'),
      );
      expect(fileNeuron).toBeDefined();
      expect(fileNeuron!.html).toContain('data-section="decisions"');
      expect(fileNeuron!.html).toContain('src/auth.ts');
    });

    it('attaches a French bug note ("Bug: ...") to bugs with the file extension intact', async () => {
      const html = eventHtml({
        id: `fr-bug-${Date.now()}`,
        kind: 'episodic',
        title: 'Auth bug',
        text: 'Bug: le token dans src/auth.ts expire trop vite quand on clique en dehors',
      });

      await runStore({ html });

      const notes = readAllNotes();
      const fileNeuron = notes.find(
        (n) => n.html.includes('data-cerveau-type="file-neuron"') && n.html.includes('src/auth.ts'),
      );
      expect(fileNeuron).toBeDefined();
      expect(fileNeuron!.html).toContain('data-section="bugs"');
      expect(fileNeuron!.html).toContain('src/auth.ts');
    });

    it('preserves the existing see-also links and inbound count across a conv-enrichment re-render', async () => {
      // Re-seed the file-neuron with a non-zero inbound + a see-also link,
      // exactly like a real code-scanner render would produce, THEN attach a
      // conversation to it — the re-render must not silently wipe either.
      const seeAlsoHtml = composeFileNeuron(AUTH_NODE, 2, undefined, [
        { id: 'file:src/session.ts', title: 'src/session.ts' },
      ]);
      const seeded = writeNote(seeAlsoHtml, { overwrite: true });
      indexNote(readNote(seeded.path));

      const html = eventHtml({
        id: `decision-preserve-meta-${Date.now()}`,
        kind: 'decision',
        title: 'Auth decision',
        text: 'decided to use argon2 for password hashing in src/auth.ts',
      });
      await runStore({ html });

      const notes = readAllNotes();
      const fileNeuron = notes.find(
        (n) => n.html.includes('data-cerveau-type="file-neuron"') && n.html.includes('src/auth.ts'),
      );
      expect(fileNeuron).toBeDefined();
      expect(fileNeuron!.html).toContain('data-section="decisions"');
      expect(fileNeuron!.html).toContain('data-code-inbound="2"');
      expect(fileNeuron!.html).toContain('data-section="see-also"');
      expect(fileNeuron!.html).toContain('src/session.ts');
    });
  });

  it('creates the enrich-state.json checkpoint, proving runIncrementalEnrich actually ran', async () => {
    expect(existsSync(enrichStatePath())).toBe(false);

    await runStore({
      html: eventHtml({
        id: `checkpoint-test-${Date.now()}`,
        kind: 'episodic',
        title: 'Minimap bug',
        text: 'bug: the minimap crashed when resizing src/auth.ts',
      }),
    });

    expect(existsSync(enrichStatePath())).toBe(true);
  });

  it('does NOT trigger enrichment when the stored HTML is a file-neuron/concept (guard skips the scan)', async () => {
    expect(existsSync(enrichStatePath())).toBe(false);

    // `store` is also the generic write path for non-conversation HTML in
    // some flows — a file-neuron can never carry conversational
    // decisions/bugs, so isConvEligibleNoteHtml must reject it and the
    // readAllNotes() scan must never run (enrich-state.json stays absent).
    const fileNeuronHtml = composeFileNeuron({
      ...AUTH_NODE,
      filePath: 'src/other.ts',
      id: 'file:src/other.ts',
    });
    expect(isConvEligibleNoteHtml(fileNeuronHtml)).toBe(false);

    await runStore({ html: fileNeuronHtml, overwrite: true });

    expect(existsSync(enrichStatePath())).toBe(false);
  });

  it('throttles back-to-back store calls: only the first pays the full enrich scan', async () => {
    await runStore({
      html: eventHtml({
        id: `throttle-a-${Date.now()}`,
        kind: 'decision',
        title: 'First decision',
        text: 'decided to cache sessions in src/auth.ts for speed',
      }),
    });
    const firstState = existsSync(enrichStatePath());
    expect(firstState).toBe(true);
    const firstMtime = statSync(enrichStatePath()).mtimeMs;

    // Second store call arrives immediately after (well within the 10s
    // MIN_INCREMENTAL_INTERVAL_MS throttle window in enrich.ts) — it must
    // still succeed (store itself is never blocked), but the enrichment
    // pass it triggers is throttled: it must NOT re-run the full corpus
    // scan / rewrite the checkpoint again.
    await runStore({
      html: eventHtml({
        id: `throttle-b-${Date.now()}`,
        kind: 'decision',
        title: 'Second decision',
        text: 'decided to add rate limiting in src/auth.ts too',
      }),
    });
    const secondMtime = statSync(enrichStatePath()).mtimeMs;
    expect(secondMtime).toBe(firstMtime);
  });
});
