/**
 * recompose-all.test.ts — fixture-brain tests for the authored-item
 * extraction fix (deriveAuthoredKind / extractAuthoredItem / runRecomposeAll).
 *
 * Ground truth this guards: `data-cerveau-kind` on a capture note's
 * <article> is never written by any capture path (CaptureEvent.itemKind has
 * no TypeScript caller that sets it — grep-verified across the whole repo).
 * The old extractAuthoredItem read only that attribute, so `if (!kind)
 * return null` fired for EVERY note; the whole authored-items pipeline
 * feeding file-neuron enrichment was silently a no-op. deriveAuthoredKind()
 * now falls back to data-cerveau-type ("decision") and data-cerveau-tags
 * (bug/warning/idea/rule/qa/activity) — the two fields capture.rs's
 * event_to_html genuinely populates for every note.
 *
 * Coverage (mission Step 5):
 *  1. deriveAuthoredKind — explicit attribute wins, type="decision" fallback,
 *     tags fallback, fixed multi-match priority order, no signal -> undefined.
 *  2. extractAuthoredItem — non-null for a note with authored facts (no
 *     explicit kind, realistic shape); still null for author-id-less /
 *     about-less / fact-less notes (unauthored notes stay unauthored).
 *  3. runRecomposeAll — authored items actually land in the matching
 *     file-neuron's enrichment sections; idempotent re-run; unrelated
 *     file-neurons untouched.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';
import { TAG_KIND_PRIORITY, deriveAuthoredKind, extractAuthoredItem } from '../recompose-all.js';

// ── deriveAuthoredKind / extractAuthoredItem — pure, no brain needed ───────

describe('deriveAuthoredKind', () => {
  it('uses the explicit data-cerveau-kind attribute when present (forward compat)', () => {
    const html = `<article data-cerveau-kind="rule" data-cerveau-type="episodic" data-cerveau-tags="bug"></article>`;
    expect(deriveAuthoredKind(html)).toBe('rule');
  });

  it('falls back to data-cerveau-type="decision" when no explicit kind is present', () => {
    const html = `<article data-cerveau-type="decision" data-cerveau-tags="stripe payments"></article>`;
    expect(deriveAuthoredKind(html)).toBe('decision');
  });

  it('falls back to a whole-word tag match from the itemKind vocabulary', () => {
    const html = `<article data-cerveau-type="episodic" data-cerveau-tags="stripe bug webhook"></article>`;
    expect(deriveAuthoredKind(html)).toBe('bug');
  });

  it('does not false-positive on a tag that merely CONTAINS a vocabulary word', () => {
    // "debugging" contains "bug" as a substring but is not the whole-word tag "bug".
    const html = `<article data-cerveau-type="episodic" data-cerveau-tags="debugging session"></article>`;
    expect(deriveAuthoredKind(html)).toBeUndefined();
  });

  it('picks the first TAG_KIND_PRIORITY match when several vocabulary tags are present (documented rule)', () => {
    const html = `<article data-cerveau-type="episodic" data-cerveau-tags="idea qa bug"></article>`;
    // bug outranks idea and qa in TAG_KIND_PRIORITY.
    expect(TAG_KIND_PRIORITY.indexOf('bug')).toBeLessThan(TAG_KIND_PRIORITY.indexOf('idea'));
    expect(deriveAuthoredKind(html)).toBe('bug');
  });

  it('type="decision" takes priority over a tag match (documented rule)', () => {
    const html = `<article data-cerveau-type="decision" data-cerveau-tags="bug"></article>`;
    expect(deriveAuthoredKind(html)).toBe('decision');
  });

  it('returns undefined for a note with no kind signal at all (genuinely unauthored)', () => {
    const html = `<article data-cerveau-type="episodic" data-cerveau-tags="misc"></article>`;
    expect(deriveAuthoredKind(html)).toBeUndefined();
  });
});

function realisticCaptureNote(opts: {
  authorId?: string;
  about?: string;
  type?: string;
  tags?: string;
  fact?: string;
}): string {
  const {
    authorId = 'user-1',
    about = 'file:src/payments/stripe.ts',
    type = 'decision',
    tags = 'stripe',
    fact = 'Some authored fact.',
  } = opts;
  const authorIdAttr = authorId ? ` data-cerveau-author-id="${authorId}"` : '';
  const aboutAttr = about ? ` data-cerveau-about="${about}"` : '';
  const factP = fact ? `<p data-cerveau-fact>${fact}</p>` : '';
  return `<article id="note-1" data-cerveau-type="${type}" data-cerveau-tags="${tags}"${authorIdAttr}${aboutAttr}>${factP}</article>`;
}

describe('extractAuthoredItem', () => {
  it('returns a non-null item for a realistic capture note with no explicit kind attribute', () => {
    const html = realisticCaptureNote({
      type: 'decision',
      tags: 'stripe payments',
      fact: 'Use idempotency keys.',
    });
    const item = extractAuthoredItem(html, 'note-1');
    expect(item).not.toBeNull();
    expect(item?.kind).toBe('decision');
    expect(item?.text).toBe('Use idempotency keys.');
    expect(item?.about).toBe('file:src/payments/stripe.ts');
  });

  it('returns a non-null bug item derived from tags, with type left as episodic', () => {
    const html = realisticCaptureNote({
      type: 'episodic',
      tags: 'stripe bug webhook',
      fact: 'Webhook secret missing crashes silently.',
    });
    const item = extractAuthoredItem(html, 'note-2');
    expect(item?.kind).toBe('bug');
  });

  it('still returns null for a genuinely empty note (no author-id at all)', () => {
    const html = `<article data-cerveau-type="episodic" data-cerveau-tags="misc"><p data-cerveau-fact>Just a note.</p></article>`;
    expect(extractAuthoredItem(html, 'note-3')).toBeNull();
  });

  it('still returns null when data-cerveau-about is missing (unscoped capture)', () => {
    const html = realisticCaptureNote({ about: '', fact: 'No target file.' });
    expect(extractAuthoredItem(html, 'note-4')).toBeNull();
  });

  it('still returns null when there is no kind signal at all (type + tags both generic)', () => {
    const html = realisticCaptureNote({ type: 'episodic', tags: 'misc', fact: 'Untyped note.' });
    expect(extractAuthoredItem(html, 'note-5')).toBeNull();
  });

  it('still returns null when the fact paragraph is empty/absent', () => {
    const html = realisticCaptureNote({ fact: '' });
    expect(extractAuthoredItem(html, 'note-6')).toBeNull();
  });
});

// ── runRecomposeAll — fixture-brain integration ─────────────────────────────

let tmpDir: string;
let brainDir: string;
let notesDir: string;
let cacheDir: string;

function writeNoteFile(id: string, html: string): string {
  mkdirSync(notesDir, { recursive: true });
  const fp = join(notesDir, `${id}.html`);
  writeFileSync(fp, html, 'utf-8');
  return fp;
}

const FILE_PATH = 'src/payments/stripe.ts';
const FILE_NEURON_ID = 'file-fixture-stripe-ts';

function structuralFileNeuronHtml(): string {
  // Signature-only shape (matches composeFileNeuron's structural sections;
  // see engine/src/annotator/blocks/composers/file-neuron.ts) — no
  // decisions/bugs/etc. sections, exactly what a freshly code-scanned
  // file-neuron looks like before any enrichment.
  return `<article id="${FILE_NEURON_ID}" data-cerveau-version="0.2.0" data-cerveau-created="2026-08-14T00:00:00Z" data-cerveau-source="code-scanner:fixture" data-cerveau-type="file-neuron" data-code-file="${FILE_PATH}" data-cerveau-tags="code typescript fixture file-neuron">
<section data-section="tldr"><p>typescript file with 3 functions</p></section>
<section data-section="architecture"><h3>Imports &amp; Exports</h3></section>
</article>`;
}

function captureNoteHtml(
  id: string,
  opts: { type: string; tags: string; fact: string; about?: string },
): string {
  const about = opts.about ?? `file:${FILE_PATH}`;
  return `<article id="${id}" data-cerveau-type="${opts.type}" data-cerveau-tags="${opts.tags}" data-cerveau-author-id="user-1" data-cerveau-about="${about}">
  <p data-cerveau-fact>${opts.fact}</p>
</article>`;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-recompose-all-'));
  brainDir = join(tmpDir, 'brain');
  notesDir = join(brainDir, 'notes', '2026-08');
  cacheDir = join(tmpDir, 'cache');
  mkdirSync(notesDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  process.env.LAZYBRAIN_CACHE_PATH = cacheDir;
  resetConfigForTests();
});

afterEach(async () => {
  const { closeDb } = await import('../../indexer/fts.js');
  closeDb();
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  resetConfigForTests();
  vi.resetModules();
});

describe('runRecomposeAll — fixture brain', () => {
  it('patches decision/bug items (kind derived, not read directly) into the matching file-neuron', async () => {
    writeNoteFile(FILE_NEURON_ID, structuralFileNeuronHtml());
    writeNoteFile(
      'decision-1',
      captureNoteHtml('decision-1', {
        type: 'decision',
        tags: 'stripe payments',
        fact: 'Use idempotency keys derived from customer+amount+day.',
      }),
    );
    writeNoteFile(
      'bug-1',
      captureNoteHtml('bug-1', {
        type: 'episodic',
        tags: 'stripe bug webhook',
        fact: 'Missing webhook secret throws an unhelpful error.',
      }),
    );

    const { runRecomposeAll } = await import('../recompose-all.js');
    const report = await runRecomposeAll();

    expect(report.authoredItemsFound).toBe(2);
    expect(report.fileNeuronsRecomposed).toBe(1);
    expect(report.errors).toEqual([]);

    const patched = readFileSync(join(notesDir, `${FILE_NEURON_ID}.html`), 'utf-8');
    expect(patched).toContain('data-section="decisions"');
    expect(patched).toContain('Use idempotency keys derived from customer+amount+day.');
    expect(patched).toContain('data-section="bugs"');
    expect(patched).toContain('Missing webhook secret throws an unhelpful error.');
  });

  it('is a no-op (skipped) when the brain has no author-id-carrying notes at all (solo brain)', async () => {
    writeNoteFile(FILE_NEURON_ID, structuralFileNeuronHtml());
    writeNoteFile(
      'plain-1',
      `<article id="plain-1" data-cerveau-type="episodic" data-cerveau-tags="misc"><p data-cerveau-fact>No author attribution.</p></article>`,
    );

    const { runRecomposeAll } = await import('../recompose-all.js');
    const report = await runRecomposeAll();

    expect(report.skipped).toBe(true);
    expect(report.authoredItemsFound).toBe(0);
    expect(report.fileNeuronsRecomposed).toBe(0);

    const untouched = readFileSync(join(notesDir, `${FILE_NEURON_ID}.html`), 'utf-8');
    expect(untouched).not.toContain('data-section="decisions"');
  });

  it('is idempotent: a second run produces byte-identical output and touches no other file-neuron', async () => {
    writeNoteFile(FILE_NEURON_ID, structuralFileNeuronHtml());
    writeNoteFile(
      'other-file-neuron',
      `<article id="other-file-neuron" data-cerveau-version="0.2.0" data-cerveau-created="2026-08-14T00:00:00Z" data-cerveau-source="code-scanner:fixture" data-cerveau-type="file-neuron" data-code-file="src/unrelated.ts"><section data-section="tldr"><p>unrelated</p></section></article>`,
    );
    writeNoteFile(
      'decision-1',
      captureNoteHtml('decision-1', { type: 'decision', tags: 'stripe', fact: 'Decision fact.' }),
    );

    const { runRecomposeAll } = await import('../recompose-all.js');
    const first = await runRecomposeAll();
    expect(first.fileNeuronsRecomposed).toBe(1);
    const afterFirst = readFileSync(join(notesDir, `${FILE_NEURON_ID}.html`), 'utf-8');
    const otherAfterFirst = readFileSync(join(notesDir, 'other-file-neuron.html'), 'utf-8');

    const second = await runRecomposeAll();
    const afterSecond = readFileSync(join(notesDir, `${FILE_NEURON_ID}.html`), 'utf-8');
    const otherAfterSecond = readFileSync(join(notesDir, 'other-file-neuron.html'), 'utf-8');

    expect(afterSecond).toBe(afterFirst);
    // The unrelated file-neuron (different data-code-file) must never be touched.
    expect(otherAfterSecond).toBe(otherAfterFirst);
    expect(otherAfterSecond).not.toContain('data-section="decisions"');
    expect(second.fileNeuronsRecomposed).toBeGreaterThanOrEqual(0);
  });
});
