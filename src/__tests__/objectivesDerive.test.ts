import { describe, it, expect } from 'vitest';
import { deriveCurrentCount, shouldPersistDerivedCount } from '../lib/objectives/objectivesDerive';

describe('deriveCurrentCount', () => {
  it('keeps the existing count untouched for an unlinked objective (no project)', () => {
    const count = deriveCurrentCount({ projectId: null, currentCount: 4 }, 9);
    expect(count).toBe(4);
  });

  it('derives from the real merged-mission count for a linked objective with no override', () => {
    const count = deriveCurrentCount({ projectId: 'proj-1', currentCount: 0, manualOverride: false }, 7);
    expect(count).toBe(7);
  });

  it('starts empty (0) when a linked project has no merged missions yet', () => {
    const count = deriveCurrentCount({ projectId: 'proj-1', currentCount: 0 }, 0);
    expect(count).toBe(0);
  });

  it('freezes at the manual value once manualOverride is set, ignoring the real merged count', () => {
    const count = deriveCurrentCount({ projectId: 'proj-1', currentCount: 12, manualOverride: true }, 3);
    expect(count).toBe(12);
  });

  it('resumes tracking the real count as soon as manualOverride is cleared', () => {
    const count = deriveCurrentCount({ projectId: 'proj-1', currentCount: 12, manualOverride: false }, 3);
    expect(count).toBe(3);
  });
});

describe('shouldPersistDerivedCount', () => {
  it('is false when the derived count matches what is already stored', () => {
    expect(shouldPersistDerivedCount({ projectId: 'proj-1', currentCount: 5 }, 5)).toBe(false);
  });

  it('is true when the real merged count has moved past the stored count', () => {
    expect(shouldPersistDerivedCount({ projectId: 'proj-1', currentCount: 5 }, 6)).toBe(true);
  });

  it('is always false for an unlinked objective, however the merged count moves', () => {
    expect(shouldPersistDerivedCount({ projectId: null, currentCount: 5 }, 999)).toBe(false);
  });

  it('is always false for a manually-overridden linked objective', () => {
    expect(shouldPersistDerivedCount({ projectId: 'proj-1', currentCount: 5, manualOverride: true }, 999)).toBe(false);
  });
});
