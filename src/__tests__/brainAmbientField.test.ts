/* Brain Canvas — ambient "cortex density" field + halo motes (canvas/ambientField.ts). */

import { describe, it, expect } from 'vitest';
import {
  AMBIENT_POINT_COUNT,
  MOTE_COUNT,
  buildAmbientField,
  buildMotes,
} from '../components/brain/canvas/ambientField';

describe('canvas/ambientField — buildAmbientField', () => {
  it('defaults to 2400 points, matching the design handoff', () => {
    expect(AMBIENT_POINT_COUNT).toBe(2400);
    const field = buildAmbientField();
    expect(field.count).toBe(2400);
    expect(field.positions).toHaveLength(2400 * 3);
    expect(field.meta).toHaveLength(2400 * 2);
  });

  it('respects a custom point count', () => {
    const field = buildAmbientField(50, 1);
    expect(field.count).toBe(50);
    expect(field.positions).toHaveLength(150);
    expect(field.meta).toHaveLength(100);
  });

  it('is fully deterministic for a given (count, seed)', () => {
    const a = buildAmbientField(200, 42);
    const b = buildAmbientField(200, 42);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.meta)).toEqual(Array.from(b.meta));
  });

  it('produces a different field for a different seed', () => {
    const a = buildAmbientField(200, 1);
    const b = buildAmbientField(200, 2);
    expect(Array.from(a.positions)).not.toEqual(Array.from(b.positions));
  });

  it('keeps every position within the expected stretched-lobe bounds', () => {
    const field = buildAmbientField(500, 7);
    for (let i = 0; i < field.count; i++) {
      expect(Math.abs(field.positions[i * 3])).toBeLessThanOrEqual(1.4);
      expect(Math.abs(field.positions[i * 3 + 1])).toBeLessThanOrEqual(1.4);
      expect(Math.abs(field.positions[i * 3 + 2])).toBeLessThanOrEqual(1.4);
    }
  });

  it('keeps meta phase/amplitude within their documented ranges', () => {
    const field = buildAmbientField(500, 7);
    for (let i = 0; i < field.count; i++) {
      const phase = field.meta[i * 2];
      const amplitude = field.meta[i * 2 + 1];
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(6.29);
      expect(amplitude).toBeGreaterThanOrEqual(0.08);
      expect(amplitude).toBeLessThan(0.31);
    }
  });
});

describe('canvas/ambientField — buildMotes', () => {
  it('defaults to 40 motes, matching the design handoff', () => {
    expect(MOTE_COUNT).toBe(40);
    expect(buildMotes()).toHaveLength(40);
  });

  it('is deterministic for a given (count, seed)', () => {
    const a = buildMotes(10, 99);
    const b = buildMotes(10, 99);
    expect(a).toEqual(b);
  });

  it('keeps every mote field within its documented range', () => {
    const motes = buildMotes(40, 99);
    for (const mote of motes) {
      expect(mote.angle).toBeGreaterThanOrEqual(0);
      expect(mote.angle).toBeLessThan(Math.PI * 2 + 1e-9);
      expect(mote.radiusFactor).toBeGreaterThanOrEqual(0.3);
      expect(mote.radiusFactor).toBeLessThan(1.16);
      expect(Math.abs(mote.speed)).toBeLessThan(0.0006 + 1e-9);
      expect(mote.size).toBeGreaterThanOrEqual(0.5);
      expect(mote.size).toBeLessThan(1.71);
    }
  });
});
