/**
 * Tests for projectOrdering.ts's orderActiveFirst — F6 fix (post-e2e fix
 * wave): the Code sidebar's PROJETS section must render the active project
 * first (and, per CodeSidebarProjects.tsx, expanded by default).
 */

import { describe, it, expect } from 'vitest';
import { orderActiveFirst } from '../lib/projectOrdering';

interface Entry {
  id: string;
  label: string;
}

function entries(...ids: string[]): Entry[] {
  return ids.map((id) => ({ id, label: id }));
}

describe('orderActiveFirst', () => {
  it('moves the active entry to the front, preserving the relative order of the rest', () => {
    const result = orderActiveFirst(entries('a', 'b', 'c'), 'b');
    expect(result.map((e) => e.id)).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op (order-wise) when the active entry is already first', () => {
    const result = orderActiveFirst(entries('a', 'b', 'c'), 'a');
    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns a copy unchanged when activeId is null', () => {
    const input = entries('a', 'b', 'c');
    const result = orderActiveFirst(input, null);
    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(result).not.toBe(input);
  });

  it('returns a copy unchanged when activeId matches no entry', () => {
    const result = orderActiveFirst(entries('a', 'b', 'c'), 'ghost');
    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('handles an empty list', () => {
    expect(orderActiveFirst([], 'a')).toEqual([]);
  });

  it('handles a single-entry list', () => {
    expect(orderActiveFirst(entries('a'), 'a').map((e) => e.id)).toEqual(['a']);
  });

  it('never mutates the input array', () => {
    const input = entries('a', 'b', 'c');
    const snapshot = [...input];
    orderActiveFirst(input, 'c');
    expect(input).toEqual(snapshot);
  });
});
