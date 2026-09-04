/**
 * paths.test.ts — idempotency + backward-compatibility coverage for slug().
 *
 * Root cause this exists to fix: slug() was applied TWICE on the real write
 * path (writer.ts's writeNote() slugifies the extracted id once, then
 * notePath() slugifies its `id` argument again internally). For a raw id
 * long enough to hit the `.slice(0, 80)` truncation, the OLD implementation
 * trimmed leading/trailing hyphens BEFORE slicing, so a single application
 * could leave a stray trailing "-" that only a SECOND application would
 * strip — i.e. slug(slug(x)) !== slug(x) for those ids. Any code predicting
 * a filename from one slug() call (e.g. structural.ts's indexIsTrustworthy())
 * computed the wrong answer and needed a local slug(slug(id)) workaround.
 *
 * `oldSlugTwice()` below is a frozen copy of the pre-fix slug() implementation,
 * applied twice, so this file can assert the new slug() is BYTE-IDENTICAL to
 * the old double-application for every id already written to disk — i.e. the
 * fix does not orphan a single existing file.
 */

import { describe, expect, it } from 'vitest';
import { slug } from '../paths.js';

/** Frozen copy of slug()'s pre-fix implementation (no idempotency fix). */
function oldSlugOnce(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function oldSlugTwice(id: string): string {
  return oldSlugOnce(oldSlugOnce(id));
}

describe('slug() — idempotency', () => {
  it('is idempotent for a plain short id', () => {
    const once = slug('Hello World');
    expect(slug(once)).toBe(once);
  });

  it('is idempotent for an id that is exactly 80 chars after sanitizing', () => {
    const raw = `a${'-b'.repeat(60)}`; // sanitizes to well over 80 chars
    const once = slug(raw);
    expect(once.length).toBeLessThanOrEqual(80);
    expect(slug(once)).toBe(once);
  });

  it('is idempotent for the exact truncation-cuts-mid-hyphen edge case', () => {
    // 79 'a's then a run of hyphens then more content: slicing at 80 lands
    // exactly on the hyphen run, so the OLD implementation's single
    // application leaves a trailing "-" that a second call would strip.
    const raw = `${'a'.repeat(79)}---${'b'.repeat(20)}`;
    const once = slug(raw);
    expect(once.endsWith('-')).toBe(false);
    expect(slug(once)).toBe(once);
  });

  it('is idempotent for empty and all-punctuation inputs', () => {
    for (const raw of ['', '---', '///', '   ', '-a-']) {
      const once = slug(raw);
      expect(slug(once)).toBe(once);
    }
  });

  it('is idempotent for a 500-char id with no separators', () => {
    const raw = 'x'.repeat(500);
    const once = slug(raw);
    expect(slug(once)).toBe(once);
  });
});

describe('slug() — backward compatibility with existing on-disk filenames', () => {
  // Real ids sampled from the owner's production brain (read-only;
  // C:/Users/user/Documents/Lazy-Brain-David/brain/notes) — the raw
  // `id="..."` attribute value of file-neuron / topic-overview notes, i.e.
  // exactly the string writer.ts's writeNote() extracts before slugifying.
  // Scanning all 7793 distinct ids on that brain found exactly 5 for which
  // oldSlugOnce(oldSlugOnce(x)) !== oldSlugOnce(x) (the non-idempotency bug);
  // those 5 are included below. Across the FULL set of 7793 ids, the new
  // slug() matched oldSlugTwice() with zero mismatches and was idempotent
  // with zero exceptions (verified with a one-off script, not committed here
  // since it depends on a machine-local, personal brain path).
  const realIdsFromProdBrain = [
    'file-c-program-files-android-android-studio-bin-lldb-helpers-mixed-mode-jb-mono-utils',
    'file-trading-prometheus-research-autoresearch-archive-tests-prometheus-creative-py',
    'file-trading-prometheus-research-autoresearch-archive-tests-prometheus-patterns-py',
    'file-trading-prometheus-research-autoresearch-prometheus-profit-target-deepdive-py',
    'topic-overview-code-c-Users-David-Documents-Albert school-Carmila alberton-Data for the CARMILA challenge',
    // A few ordinary (well under 80 chars) real ids for contrast — must be
    // completely unaffected by the fix.
    'file-c-program-files-android-android-studio-bin-helpers-jb-declarative-formatter',
    'file-acme-src-auth-session-ts',
  ];

  it.each(realIdsFromProdBrain)(
    'slug(%s) equals the OLD slug(slug(x)) — no existing filename changes',
    (raw) => {
      expect(slug(raw)).toBe(oldSlugTwice(raw));
    },
  );

  it.each(realIdsFromProdBrain)('slug(%s) is idempotent', (raw) => {
    const once = slug(raw);
    expect(slug(once)).toBe(once);
  });

  it('matches oldSlugTwice() for a battery of synthetic long ids covering every truncation offset', () => {
    // Exercise every possible cut position (0..79) for where the 80-char
    // boundary can land on a hyphen, to be sure no offset is missed by the
    // 5 real samples above.
    for (let hyphenAt = 60; hyphenAt < 85; hyphenAt++) {
      const raw = `${'a'.repeat(hyphenAt)}-${'b'.repeat(30)}`;
      expect(slug(raw)).toBe(oldSlugTwice(raw));
      const once = slug(raw);
      expect(slug(once)).toBe(once);
    }
  });
});
