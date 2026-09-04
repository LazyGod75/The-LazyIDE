import { describe, it, expect } from 'vitest';
import { shouldSkipAlreadyFired } from '../lib/agents/chainFireOnce';

describe('shouldSkipAlreadyFired', () => {
  it('allows the first fire (no stamp)', () => {
    expect(shouldSkipAlreadyFired(undefined, 200)).toBe(false);
  });

  it('skips a reconcile of the same or older completion', () => {
    expect(shouldSkipAlreadyFired(200, 200)).toBe(true);
    expect(shouldSkipAlreadyFired(200, 199)).toBe(true);
  });

  it('allows a later completion', () => {
    expect(shouldSkipAlreadyFired(200, 201)).toBe(false);
  });
});
