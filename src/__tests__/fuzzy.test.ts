import { describe, it, expect } from 'vitest';
import { fuzzyScore, fuzzyFilter } from '../components/palette/fuzzy';

describe('fuzzyScore', () => {
  it('empty needle returns score=1 with no indices', () => {
    const result = fuzzyScore('', 'anything');
    expect(result.score).toBe(1);
    expect(result.indices).toHaveLength(0);
  });

  it('returns score=0 when needle not a subsequence of haystack', () => {
    const result = fuzzyScore('xyz', 'abcdef');
    expect(result.score).toBe(0);
    expect(result.indices).toHaveLength(0);
  });

  it('exact match produces higher score than partial-spread match', () => {
    const exact = fuzzyScore('auth', 'auth');
    const spread = fuzzyScore('auth', 'a_u_t_h_module');
    expect(exact.score).toBeGreaterThan(spread.score);
  });

  it('word-boundary bonus: match at position 0 gets +5 bonus', () => {
    // "a" at index 0 → boundary bonus applies
    const result = fuzzyScore('a', 'auth');
    expect(result.score).toBeGreaterThan(1); // at least base + boundary
  });

  it('word-boundary bonus after slash', () => {
    const slashBoundary = fuzzyScore('i', 'src/index.ts');
    // 'i' at 'src/' → index after '/' = word boundary
    // Also 'i' in 'index' at position 4 (after '/')
    expect(slashBoundary.score).toBeGreaterThan(0);
  });

  it('consecutive match bonus: "ab" in "abcde" scores higher than "ab" in "axb"', () => {
    const consecutive = fuzzyScore('ab', 'abcde');
    const nonConsecutive = fuzzyScore('ab', 'axb');
    expect(consecutive.score).toBeGreaterThan(nonConsecutive.score);
  });

  it('short haystack bonus: shorter haystacks score higher for same needle', () => {
    const short = fuzzyScore('ab', 'ab');
    const long = fuzzyScore('ab', 'ab_with_extra_text_padding_here');
    expect(short.score).toBeGreaterThan(long.score);
  });

  it('returns correct match indices', () => {
    const result = fuzzyScore('ac', 'abcd');
    // 'a' at 0, 'c' at 2
    expect(result.indices).toEqual([0, 2]);
  });

  it('is case-insensitive', () => {
    const lower = fuzzyScore('auth', 'AUTH.ts');
    const mixed = fuzzyScore('AUTH', 'auth.ts');
    expect(lower.score).toBeGreaterThan(0);
    expect(mixed.score).toBeGreaterThan(0);
  });

  // QA fix (B8): plain-ASCII query must match accented labels and vice versa.
  describe('accent-insensitive matching', () => {
    it('ASCII needle matches an accented haystack ("theme" -> "Thème")', () => {
      const result = fuzzyScore('theme', 'Thème');
      expect(result.score).toBeGreaterThan(0);
    });

    it('accented needle matches an ASCII haystack ("thème" -> "theme toggle")', () => {
      const result = fuzzyScore('thème', 'theme toggle');
      expect(result.score).toBeGreaterThan(0);
    });

    it('matches across a variety of accents (café, résumé, naïve)', () => {
      expect(fuzzyScore('cafe', 'café').score).toBeGreaterThan(0);
      expect(fuzzyScore('resume', 'résumé').score).toBeGreaterThan(0);
      expect(fuzzyScore('naive', 'naïve').score).toBeGreaterThan(0);
    });

    it('fuzzyFilter surfaces an accented item for an unaccented query', () => {
      const items = [{ id: 1, label: 'Réglages' }, { id: 2, label: 'Terminal' }];
      const result = fuzzyFilter(items, 'reglages', (item) => item.label);
      expect(result).toHaveLength(1);
      expect(result[0].label).toBe('Réglages');
    });
  });
});

describe('fuzzyFilter', () => {
  const items = [
    { id: 1, label: 'auth.ts' },
    { id: 2, label: 'config.ts' },
    { id: 3, label: 'base-handler.ts' },
  ];
  const getLabel = (item: typeof items[0]) => item.label;

  it('empty needle returns all items with score=1', () => {
    const result = fuzzyFilter(items, '', getLabel);
    expect(result).toHaveLength(3);
    result.forEach(r => expect(r.fuzzyScore).toBe(1));
  });

  it('whitespace-only needle returns all items', () => {
    const result = fuzzyFilter(items, '  ', getLabel);
    expect(result).toHaveLength(3);
  });

  it('filters out non-matching items', () => {
    const result = fuzzyFilter(items, 'xyz', getLabel);
    expect(result).toHaveLength(0);
  });

  it('returns results sorted by score descending', () => {
    const result = fuzzyFilter(items, 'con', getLabel);
    // 'config.ts' should match; verify sorted
    expect(result[0].label).toBe('config.ts');
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].fuzzyScore).toBeGreaterThanOrEqual(result[i].fuzzyScore);
    }
  });

  it('attaches fuzzyIndices to each result', () => {
    const result = fuzzyFilter(items, 'au', getLabel);
    expect(result[0].fuzzyIndices).toBeDefined();
    expect(result[0].fuzzyIndices.length).toBeGreaterThan(0);
  });
});
