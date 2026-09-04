/* Brain Canvas — signal pulses traveling along memory links (canvas/pulses.ts). */

import { describe, it, expect } from 'vitest';
import { PULSE_COUNT, advancePulse, buildPulses } from '../components/brain/canvas/pulses';
import type { PulseState } from '../components/brain/canvas/pulses';

describe('canvas/pulses — buildPulses', () => {
  it('defaults to 16 pulses, matching the design handoff', () => {
    expect(PULSE_COUNT).toBe(16);
    expect(buildPulses(10)).toHaveLength(16);
  });

  it('returns an empty pool when there are no edges to ride', () => {
    expect(buildPulses(0)).toEqual([]);
  });

  it('is deterministic for a given (edgeCount, count, seed)', () => {
    const a = buildPulses(12, 16, 7);
    const b = buildPulses(12, 16, 7);
    expect(a).toEqual(b);
  });

  it('assigns every pulse a valid edge index and t/speed within documented ranges', () => {
    const edgeCount = 5;
    const pulses = buildPulses(edgeCount, 30, 3);
    for (const pulse of pulses) {
      expect(pulse.edgeIndex).toBeGreaterThanOrEqual(0);
      expect(pulse.edgeIndex).toBeLessThan(edgeCount);
      expect(pulse.t).toBeGreaterThanOrEqual(0);
      expect(pulse.t).toBeLessThan(1);
      expect(pulse.speed).toBeGreaterThanOrEqual(0.004);
      expect(pulse.speed).toBeLessThan(0.012 + 1e-9);
    }
  });
});

describe('canvas/pulses — advancePulse', () => {
  it('advances t by speed without wrapping', () => {
    const pulse: PulseState = { edgeIndex: 0, t: 0.5, speed: 0.1 };
    const arrived = advancePulse(pulse);
    expect(arrived).toBe(false);
    expect(pulse.t).toBeCloseTo(0.6, 10);
  });

  it('wraps at 1 and reports arrival', () => {
    const pulse: PulseState = { edgeIndex: 0, t: 0.95, speed: 0.1 };
    const arrived = advancePulse(pulse);
    expect(arrived).toBe(true);
    expect(pulse.t).toBeCloseTo(0.05, 10);
  });

  it('mutates the pulse object in place (hot-path contract — no allocation)', () => {
    const pulse: PulseState = { edgeIndex: 2, t: 0.1, speed: 0.05 };
    const same = pulse;
    advancePulse(pulse);
    expect(same).toBe(pulse);
    expect(same.t).toBeCloseTo(0.15, 10);
  });
});
