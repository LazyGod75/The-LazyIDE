/**
 * neuronTitle.ts — regression coverage for a real, observed Brain-space UI
 * bug: a neuron derived from a mission prompt rendered raw HTML markup AND
 * was hard-truncated mid-tag with no ellipsis —
 *   'Mission: Créer un fichier index.html à la racine du projet avec un
 *    <title>Lazy demo</titl'
 * — in both the neuron detail panel and the "new items" timeline strip.
 * formatNeuronTitle() must (a) strip markup so no `<tag>` fragment ever
 * renders, complete or dangling, and (b) truncate on a word boundary with a
 * real ellipsis character, never mid-word and never silently.
 */
import { describe, it, expect } from 'vitest';
import { formatNeuronTitle } from '../lib/brain/neuronTitle';

describe('formatNeuronTitle', () => {
  it('strips a dangling, mid-tag-truncated markup fragment (the real repro)', () => {
    const raw = 'Mission: Créer un fichier index.html à la racine du projet avec un <title>Lazy demo</titl';
    const result = formatNeuronTitle(raw, 200);
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).not.toContain('titl');
    expect(result).toBe('Mission: Créer un fichier index.html à la racine du projet avec un Lazy demo');
  });

  it('strips complete, well-formed tags', () => {
    const raw = 'Mission: write <title>Lazy demo</title> into index.html';
    const result = formatNeuronTitle(raw, 200);
    expect(result).not.toMatch(/<[^>]*>/);
    expect(result).toBe('Mission: write Lazy demo into index.html');
  });

  it('leaves plain text with no markup unchanged (shorter than the limit)', () => {
    expect(formatNeuronTitle('Fix the login bug', 200)).toBe('Fix the login bug');
  });

  it('returns the text unchanged when it is exactly at the limit', () => {
    const text = 'x'.repeat(40);
    expect(formatNeuronTitle(text, 40)).toBe(text);
  });

  it('truncates on a word boundary with a real ellipsis when over the limit', () => {
    const text = 'Créer un fichier index.html à la racine du projet actif pour la démo Lazy';
    const result = formatNeuronTitle(text, 40);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result.endsWith('…')).toBe(true);
    // Never mid-word: strip the ellipsis and the remainder must be whole words.
    const withoutEllipsis = result.slice(0, -1);
    expect(text.startsWith(withoutEllipsis)).toBe(true);
    expect(text[withoutEllipsis.length]).toBe(' ');
  });

  it('never exceeds maxLen even for a single very long word', () => {
    const result = formatNeuronTitle('x'.repeat(200), 40);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result.endsWith('…')).toBe(true);
  });

  it('handles null/undefined defensively, returning an empty string', () => {
    expect(formatNeuronTitle(undefined, 40)).toBe('');
    expect(formatNeuronTitle(null, 40)).toBe('');
  });

  it('is idempotent — reformatting an already-formatted title changes nothing', () => {
    const once = formatNeuronTitle('a fairly long neuron title about a mission', 20);
    const twice = formatNeuronTitle(once, 20);
    expect(twice).toBe(once);
  });
});
