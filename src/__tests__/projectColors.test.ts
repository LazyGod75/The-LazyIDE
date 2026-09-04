import { describe, it, expect } from 'vitest';
import { colorForProject } from '../lib/projectColors';

describe('colorForProject', () => {
  it('is deterministic — same id always yields the same color', () => {
    const a = colorForProject('c:/users/dev/lazysite');
    const b = colorForProject('c:/users/dev/lazysite');
    expect(a).toBe(b);
  });

  it('returns a valid hex color string', () => {
    expect(colorForProject('any-project')).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('distributes different ids across multiple distinct colors', () => {
    const ids = ['lazysite', 'gameon', 'mobile-app', 'trading-bot', 'docs-site', 'random-6', 'another-7'];
    const colors = new Set(ids.map(colorForProject));
    // Not asserting every id gets a unique color (hash collisions are
    // allowed/expected once the palette is exhausted) — just that we don't
    // collapse everything onto a single color.
    expect(colors.size).toBeGreaterThan(1);
  });

  it('falls back to a stable color for an empty id', () => {
    expect(colorForProject('')).toBe(colorForProject(''));
    expect(colorForProject('')).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('is order-independent — differs only by id content, not call order', () => {
    const first = colorForProject('projectA');
    colorForProject('projectB');
    colorForProject('projectC');
    const firstAgain = colorForProject('projectA');
    expect(first).toBe(firstAgain);
  });
});
