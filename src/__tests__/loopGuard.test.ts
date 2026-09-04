/**
 * Unit tests for the general loop-stall guard (src/lib/agents/loopGuard.ts).
 */

import { describe, expect, it } from 'vitest';
import { detectStall, signatureOf, type ToolCallRecord } from '../lib/agents/loopGuard';

const read = (path: string): ToolCallRecord => ({ name: 'read_file', args: { path } });
const search = (pattern: string): ToolCallRecord => ({ name: 'search_code', args: { pattern } });
const edit = (path: string): ToolCallRecord => ({ name: 'edit_file', args: { path, old_text: 'a', new_text: 'b' } });

describe('signatureOf', () => {
  it('distinguishes tool+args', () => {
    expect(signatureOf(read('a.ts'))).not.toBe(signatureOf(read('b.ts')));
    expect(signatureOf(read('a.ts'))).toBe(signatureOf(read('a.ts')));
  });
});

describe('detectStall — exact repeat', () => {
  it('fires when the same call repeats', () => {
    const history = [search('CheckerContext'), search('CheckerContext'), search('CheckerContext')];
    const v = detectStall(history, { repeatThreshold: 2 });
    expect(v.stalled).toBe(true);
    expect(v.message).toContain('STALL GUARD');
    expect(v.message).toContain('search_code');
  });

  it('does not fire on distinct calls', () => {
    const history = [search('a'), read('a.ts'), search('b'), read('b.ts')];
    expect(detectStall(history, { repeatThreshold: 2 }).stalled).toBe(false);
  });
});

// These fixtures use DISTINCT arguments on purpose. detectStall runs the
// exact-repeat check first, so a history of identical calls trips that rule
// and never reaches the no-progress one — which is correct behaviour (five
// identical searches IS a stall), but it would mean these tests never
// exercise the rule they are named after.
describe('detectStall — no progress', () => {
  it('fires when no edit tool in the window', () => {
    const history = Array.from({ length: 10 }, (_, i) =>
      i % 2 ? search(`pattern-${i}`) : read(`f${i}.ts`),
    );
    const v = detectStall(history, { noEditWindow: 10 });
    expect(v.stalled).toBe(true);
    expect(v.message).toContain('without changing any file');
  });

  it('does not fire when an edit happened in the window', () => {
    const history = [
      ...Array.from({ length: 9 }, (_, i) => search(`pattern-${i}`)),
      edit('a.ts'),
    ];
    expect(detectStall(history, { noEditWindow: 10 }).stalled).toBe(false);
  });

  it('does not fire before the window fills', () => {
    const history = [search('x'), search('x')];
    expect(detectStall(history, { noEditWindow: 10 }).stalled).toBe(false);
  });
});

describe('detectStall — no stall', () => {
  it('returns stalled=false on an empty history', () => {
    expect(detectStall([]).stalled).toBe(false);
  });
});
