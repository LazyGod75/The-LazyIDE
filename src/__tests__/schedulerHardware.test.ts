import { describe, it, expect } from 'vitest';
import {
  defaultMaxParallelFromHardware,
  MAX_PARALLEL_CEILING,
  MAX_PARALLEL_FLOOR,
  MAX_PARALLEL_HARD_MAX,
  resolveGlobalMaxParallel,
} from '../lib/agents/schedulerHardware';

describe('defaultMaxParallelFromHardware', () => {
  it('floors at 3 for missing / invalid core counts', () => {
    expect(defaultMaxParallelFromHardware(0)).toBe(MAX_PARALLEL_FLOOR);
    expect(defaultMaxParallelFromHardware(-4)).toBe(MAX_PARALLEL_FLOOR);
    expect(defaultMaxParallelFromHardware(Number.NaN)).toBe(MAX_PARALLEL_FLOOR);
  });

  it('scales cores/2 inside 3–8 (Cursor default ceiling)', () => {
    expect(defaultMaxParallelFromHardware(4)).toBe(MAX_PARALLEL_FLOOR);
    expect(defaultMaxParallelFromHardware(8)).toBe(4);
    expect(defaultMaxParallelFromHardware(16)).toBe(MAX_PARALLEL_CEILING);
    expect(defaultMaxParallelFromHardware(64)).toBe(MAX_PARALLEL_CEILING);
  });

  it('does not use the settings input hard-max as the default', () => {
    expect(MAX_PARALLEL_HARD_MAX).toBe(20);
    expect(defaultMaxParallelFromHardware(40)).toBe(MAX_PARALLEL_CEILING);
  });
});

describe('resolveGlobalMaxParallel', () => {
  it('uses the hardware default when the key is absent or blank', () => {
    expect(resolveGlobalMaxParallel(null, 8)).toBe(4);
    expect(resolveGlobalMaxParallel('  ', 16)).toBe(MAX_PARALLEL_CEILING);
  });

  it('lets a saved positive integer win', () => {
    expect(resolveGlobalMaxParallel('2', 16)).toBe(2);
    expect(resolveGlobalMaxParallel('20', 4)).toBe(20);
  });

  it('keeps 0 and invalid as unlimited', () => {
    expect(resolveGlobalMaxParallel('0', 8)).toBe(Infinity);
    expect(resolveGlobalMaxParallel('nope', 8)).toBe(Infinity);
  });
});
