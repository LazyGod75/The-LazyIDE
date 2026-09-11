/**
 * P1-1 — auto-linker precision bug.
 *
 * buildEntityIndex() built surface aliases from note TAGS with first-writer-wins
 * and no document-frequency guard, so a generic tag present on many notes (e.g.
 * "typescript"/"code" on every TypeScript file-neuron) made ONE note capture
 * every future mention of that word across the whole corpus — confirmed in
 * production as 240 "mentions" edges collapsing onto a single wrong file-neuron.
 *
 * Fix mirrors graph/structural-edges.ts's TOO_GENERIC_RATIO: a tag is only used
 * as an alias source when it appears on at most that fraction of notes.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildEntityIndex, detectMentions } from '../entities.js';
import { TOO_GENERIC_RATIO } from '../structural-edges.js';

function fileNeuronNote(id: string, language = 'typescript') {
  // Mirrors the real tag string composeFileNeuron renders:
  // `data-cerveau-tags="code ${language} ${projectName} file-neuron"`
  return { id, title: id.replace(/^file-/, ''), tags: `code ${language} acme file-neuron` };
}

describe('buildEntityIndex — document-frequency guard on tag aliases (P1-1)', () => {
  it('reproduces the pathology BEFORE the fix is understood: many notes share the "typescript" tag', () => {
    // Sanity check on the fixture shape itself — not a behavioural assertion.
    const notes = Array.from({ length: 20 }, (_, i) => fileNeuronNote(`file-src-mod-${i}-ts`));
    expect(notes.every((n) => n.tags.includes('typescript'))).toBe(true);
  });

  it('does NOT let a generic tag ("typescript"/"code") become an alias when it exceeds TOO_GENERIC_RATIO', () => {
    // 20 TypeScript file-neurons — well above the too-generic threshold at any
    // reasonable corpus size (max(2, floor(20*0.08)) = 2).
    const notes = Array.from({ length: 20 }, (_, i) => fileNeuronNote(`file-src-mod-${i}-ts`));
    const index = buildEntityIndex(notes);

    expect(index.bySurface.has('typescript')).toBe(false);
    expect(index.bySurface.has('code')).toBe(false);
    expect(index.bySurface.has('file-neuron')).toBe(false);
  });

  it('BEFORE/AFTER: a corpus-wide mention of "typescript" no longer resolves to a single hub note', () => {
    const notes = Array.from({ length: 30 }, (_, i) => fileNeuronNote(`file-src-mod-${i}-ts`));
    const index = buildEntityIndex(notes);

    // Simulate the auto-linker scanning 30 unrelated conversation notes, each
    // mentioning "typescript" in prose — none of them should link to any of
    // the 30 file-neurons via the generic tag (no attribution is safer than a
    // false one). BEFORE the fix, every one of these would resolve to note #0
    // (first-writer-wins on the "typescript" surface) — a 30-to-1 pathology
    // analogous to the reported 240-to-1 case.
    let hubHits = 0;
    for (let i = 0; i < 30; i++) {
      const mentions = detectMentions(
        `We discussed typescript configuration in conversation ${i}.`,
        index,
      );
      const hitsHub = mentions.some((m) => m.id === 'file-src-mod-0-ts');
      if (hitsHub) hubHits++;
    }
    expect(hubHits).toBe(0);
  });

  it('still allows a genuinely rare tag to become an alias (not over-corrected)', () => {
    const notes = [
      fileNeuronNote('file-a-ts'),
      fileNeuronNote('file-b-ts'),
      {
        id: 'file-payment-gateway-ts',
        title: 'payment-gateway',
        tags: 'code typescript acme file-neuron stripewebhook',
      },
    ];
    const index = buildEntityIndex(notes);
    // "stripewebhook" (rare, DF=1) should still be usable as an alias.
    expect(index.bySurface.get('stripewebhook')).toBe('file-payment-gateway-ts');
  });

  it('title and slug aliases are NOT subject to the tag document-frequency guard', () => {
    // Even with many notes, a note's own (near-unique) title must still work.
    const notes = Array.from({ length: 20 }, (_, i) => ({
      ...fileNeuronNote(`file-src-mod-${i}-ts`),
      title: `UniqueModule${i}`,
    }));
    const index = buildEntityIndex(notes);
    expect(index.bySurface.get('uniquemodule5')).toBe('file-src-mod-5-ts');
  });

  it('uses the same TOO_GENERIC_RATIO constant as structural-edges.ts (no duplicated magic number)', () => {
    expect(TOO_GENERIC_RATIO).toBe(0.08);
  });
});

describe('buildEntityIndex — deterministic ordering + non-silent collision (first-writer-wins)', () => {
  it('resolves alias collisions the same way regardless of input array order', () => {
    const noteA = { id: 'note-b-second', title: 'SharedTitleWord', tags: '' };
    const noteB = { id: 'note-a-first', title: 'SharedTitleWord', tags: '' };

    const forward = buildEntityIndex([noteA, noteB]);
    const reversed = buildEntityIndex([noteB, noteA]);

    // Regardless of input order, the id-sorted processing order means
    // "note-a-first" (sorts first) always wins the collision.
    expect(forward.bySurface.get('sharedtitleword')).toBe('note-a-first');
    expect(reversed.bySurface.get('sharedtitleword')).toBe('note-a-first');
  });

  it('logs (does not silently drop) an alias collision', async () => {
    const logger = await import('../../util/logger.js');
    const debugSpy = vi.spyOn(logger.getLogger(), 'debug');

    const notes = [
      { id: 'note-a-first', title: 'SharedTitleWord', tags: '' },
      { id: 'note-b-second', title: 'SharedTitleWord', tags: '' },
    ];
    buildEntityIndex(notes);

    const loggedCollision = debugSpy.mock.calls.some(
      (call) => typeof call[1] === 'string' && call[1].includes('alias collision'),
    );
    expect(loggedCollision).toBe(true);
    debugSpy.mockRestore();
  });
});
