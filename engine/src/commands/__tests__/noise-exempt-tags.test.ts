/**
 * Tests for dream.ts's hasNoiseExemptTag — the guard that stops
 * runNoiseCleanup from invalidating mission/agent/skill-tagged notes just
 * because they are short. See dream.ts's doc comment above
 * NOISE_EXEMPT_TAGS for the full root-cause story.
 */
import { describe, expect, it } from 'vitest';
import { detectNoise, hasNoiseExemptTag } from '../dream.js';

describe('hasNoiseExemptTag', () => {
  it('is true for a note tagged "agent mission"', () => {
    expect(hasNoiseExemptTag('agent mission')).toBe(true);
  });

  it('is true for a note tagged "skill confidence:high engine:native"', () => {
    expect(hasNoiseExemptTag('skill confidence:high engine:native')).toBe(true);
  });

  it('is true when the protected tag is not the first token', () => {
    expect(hasNoiseExemptTag('chat learning mission')).toBe(true);
  });

  it('is false for an untagged/ordinary note', () => {
    expect(hasNoiseExemptTag('edit code')).toBe(false);
  });

  it('is false for null/undefined/empty tags', () => {
    expect(hasNoiseExemptTag(null)).toBe(false);
    expect(hasNoiseExemptTag(undefined)).toBe(false);
    expect(hasNoiseExemptTag('')).toBe(false);
  });

  it('sanity: a sparse kickoff-shaped mission note text still trips detectNoise on its own', () => {
    // This is exactly why the tag exemption is necessary — the text alone
    // (no tag awareness) IS classified as noise by detectNoise().
    const sparseKickoffText = 'Modele : Sonnet 4.6\nWorktree : wt/fix-bug';
    expect(detectNoise(sparseKickoffText)).toBe(true);
  });
});
