/* dream-noise-checkpoint.test.ts — Phase 0.5's incremental scan. The
   full-corpus readNote+stripNote per dream run was a major share of dream
   exceeding its 600s maintenance ceiling on a 5k-note brain (measured:
   dream still burning a full core + 2.2GB at >10min when killed). The
   checkpoint scans only notes modified since the last completed pass,
   falling back to a full scan on a rules-version bump. */

import { describe, expect, it } from 'vitest';
import type { IndexedNote } from '../../indexer/note-types.js';
import { type NoiseCleanupState, selectNoiseCleanupCandidates } from '../dream.js';

function note(id: string, mtime_ms: number): IndexedNote {
  return { id, mtime_ms } as IndexedNote;
}

describe('selectNoiseCleanupCandidates', () => {
  const notes = [note('old', 1000), note('new', 5000), note('undated', 0)];

  it('scans everything when the rules version changed (or no checkpoint exists)', () => {
    expect(selectNoiseCleanupCandidates(notes, { lastRunMs: 0, rulesVersion: 0 })).toHaveLength(3);
  });

  it('scans only notes modified after the last pass', () => {
    const state: NoiseCleanupState = { lastRunMs: 2000, rulesVersion: 1 };
    const picked = selectNoiseCleanupCandidates(notes, state);
    expect(picked.map((n) => n.id)).toEqual(['new', 'undated']);
  });

  it('never skips an undated note (mtime_ms = 0 means unverifiable, not old)', () => {
    const state: NoiseCleanupState = { lastRunMs: Number.MAX_SAFE_INTEGER, rulesVersion: 1 };
    const picked = selectNoiseCleanupCandidates([note('undated', 0), note('old', 1)], state);
    expect(picked.map((n) => n.id)).toEqual(['undated']);
  });
});
