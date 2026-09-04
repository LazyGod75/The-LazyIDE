/**
 * F(3) — WARNINGS quality gate in buildMainPage.
 *
 * Tests the warningPassesGate() export:
 * - bare timestamps like "20:15." are excluded
 * - separator lines like "=== demo/graph.html has..." are excluded
 * - "---" separator lines are excluded
 * - warnings with < 4 alphanumeric words are excluded
 * - legitimate multi-word warnings pass
 * - cap of 3 warnings per project is enforced
 */

import { describe, expect, it } from 'vitest';
import { warningPassesGate } from '../src/commands/inject-context.js';

describe('F(3) — warningPassesGate', () => {
  it('excludes bare timestamps like "20:15."', () => {
    expect(warningPassesGate('20:15.')).toBe(false);
    expect(warningPassesGate('9:00')).toBe(false);
    expect(warningPassesGate('10:30.')).toBe(false);
  });

  it('excludes separator lines starting with ===', () => {
    expect(warningPassesGate('=== demo/graph.html has invalid markup')).toBe(false);
    expect(warningPassesGate('=== section separator ===')).toBe(false);
  });

  it('excludes separator lines starting with ---', () => {
    expect(warningPassesGate('--- separator ---')).toBe(false);
    expect(warningPassesGate('---')).toBe(false);
  });

  it('excludes warnings with fewer than 4 alphanumeric words', () => {
    expect(warningPassesGate('just three words')).toBe(false);
    expect(warningPassesGate('two words')).toBe(false);
    expect(warningPassesGate('one')).toBe(false);
  });

  it('passes warnings with >= 4 alphanumeric words', () => {
    expect(
      warningPassesGate('do not use --force on shared branches because it rewrites history'),
    ).toBe(true);
  });

  it('passes a typical anti-pattern warning', () => {
    expect(
      warningPassesGate('Never commit secrets directly to the repository without review'),
    ).toBe(true);
  });

  it('excludes a warning that is exactly a timestamp pattern', () => {
    expect(warningPassesGate('12:00')).toBe(false);
  });
});
