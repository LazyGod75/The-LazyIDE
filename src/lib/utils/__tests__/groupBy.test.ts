import { describe, it, expect } from 'vitest';
import groupBy from '../groupBy';

describe('groupBy', () => {
  it('groups elements by the string key returned by keyFn', () => {
    const result = groupBy([1, 2, 3, 4], (n) => (n % 2 === 0 ? 'even' : 'odd'));
    expect(result).toEqual({ even: [2, 4], odd: [1, 3] });
  });

  it('does not mutate the input array', () => {
    const input = [{ id: 1 }, { id: 2 }];
    const frozen = Object.freeze([...input]);
    groupBy(frozen, (item) => String(item.id));
    expect(frozen).toEqual([{ id: 1 }, { id: 2 }]);
    expect(frozen.length).toBe(2);
  });

  it('returns an empty object for an empty array', () => {
    expect(groupBy([], () => 'any')).toEqual({});
  });

  it('preserves insertion order within each group', () => {
    const words = ['apple', 'banana', 'avocado', 'blueberry', 'apricot'];
    const result = groupBy(words, (w) => w[0]);
    expect(result.a).toEqual(['apple', 'avocado', 'apricot']);
    expect(result.b).toEqual(['banana', 'blueberry']);
  });
});
