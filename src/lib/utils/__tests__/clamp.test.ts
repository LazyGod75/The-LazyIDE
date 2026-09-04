import { describe, it, expect } from 'vitest';
import clamp from '../clamp';

describe('clamp', () => {
  it('returns min when value is below min', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it('returns max when value is above max', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('returns value unchanged when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('returns min (== max) when min === max, regardless of value', () => {
    expect(clamp(7, 5, 5)).toBe(5);
    expect(clamp(-100, 5, 5)).toBe(5);
    expect(clamp(100, 5, 5)).toBe(5);
  });
});
