import { describe, it, expect } from 'vitest';
import { firstDivergence } from '../components/editor/codespace/useLiveWorktreeTail';

describe('firstDivergence', () => {
  it('returns 0 when the arrays differ from the start', () => {
    expect(firstDivergence(['a'], ['b'])).toBe(0);
  });

  it('returns the index of new appended lines', () => {
    expect(firstDivergence(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(2);
  });

  it('returns next.length when next is an unchanged prefix (nothing new)', () => {
    expect(firstDivergence(['a', 'b', 'c'], ['a', 'b'])).toBe(2);
  });

  it('returns 0 for two empty arrays', () => {
    expect(firstDivergence([], [])).toBe(0);
  });

  it('detects a changed line mid-file even without length growth', () => {
    expect(firstDivergence(['a', 'b', 'c'], ['a', 'X', 'c'])).toBe(1);
  });
});
