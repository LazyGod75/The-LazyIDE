/**
 * dedupeAdjacentParagraphs — display-side mitigation for the diagnosed
 * manager stutter (real user report, verbatim, 2026-07-28): the same
 * clarifying question rendered twice, back-to-back, in the same assistant
 * bubble. See dedupeMessageText.ts's own module doc comment for the
 * diagnosed root cause (out of this task's locked perimeter) and why this
 * file is a display-side mitigation rather than the real fix.
 */
import { describe, it, expect } from 'vitest';
import { dedupeAdjacentParagraphs } from '../components/lazyManager/dedupeMessageText';

describe('dedupeAdjacentParagraphs', () => {
  it('collapses an exact-duplicate adjacent paragraph (the reported defect, verbatim)', () => {
    const sentence = "Carrousel d'images ou vraie vidéo Remotion animée ? Ça détermine tout le pipeline de production.";
    const content = `${sentence}\n\n${sentence}`;
    expect(dedupeAdjacentParagraphs(content)).toBe(sentence);
  });

  it('collapses the second reported defect (desktop shortcut vs Electron app)', () => {
    const sentence = 'Raccourci desktop vers un dashboard web, ou vraie appli Electron séparée ?';
    const content = `${sentence}\n\n${sentence}`;
    expect(dedupeAdjacentParagraphs(content)).toBe(sentence);
  });

  it('leaves a single-paragraph message completely untouched', () => {
    const content = 'Une seule phrase, sans duplication.';
    expect(dedupeAdjacentParagraphs(content)).toBe(content);
  });

  it('keeps two genuinely different consecutive paragraphs (no false-positive collapse)', () => {
    const content = 'Première question.\n\nDeuxième question, différente.';
    expect(dedupeAdjacentParagraphs(content)).toBe(content);
  });

  it('only collapses ADJACENT duplicates — a non-adjacent repeat (legitimate callback) survives', () => {
    const content = 'X.\n\nY.\n\nX.';
    expect(dedupeAdjacentParagraphs(content)).toBe(content);
  });

  it('collapses more than one adjacent duplicate in a row (3x repeat -> 1)', () => {
    const sentence = 'Répétée trois fois.';
    const content = `${sentence}\n\n${sentence}\n\n${sentence}`;
    expect(dedupeAdjacentParagraphs(content)).toBe(sentence);
  });

  it('tolerates surrounding whitespace differences when comparing (trim before compare)', () => {
    const content = 'Même phrase.  \n\n  Même phrase.';
    expect(dedupeAdjacentParagraphs(content)).toBe('Même phrase.');
  });

  it('preserves an empty string unchanged', () => {
    expect(dedupeAdjacentParagraphs('')).toBe('');
  });
});
