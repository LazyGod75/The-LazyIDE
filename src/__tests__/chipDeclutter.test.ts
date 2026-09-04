/**
 * chipDeclutter.test.ts — fix/canvas-legibility: pure unit tests for
 * chrome/chipDeclutter.ts's `computeChipVisibility`, the mission
 * billboard-chip screen-space declutter algorithm (see that module's own
 * header for the full rationale).
 */

import { describe, it, expect } from 'vitest';
import { CHIP_PRIORITY, computeChipVisibility, type ChipCandidate } from '../components/agents/canvas/chrome/chipDeclutter';

describe('computeChipVisibility', () => {
  it('no collision -> every candidate stays visible', () => {
    const candidates: ChipCandidate[] = [
      { id: 'a', screenX: 0, screenY: 0, priority: CHIP_PRIORITY.running },
      { id: 'b', screenX: 400, screenY: 0, priority: CHIP_PRIORITY.queued },
      { id: 'c', screenX: 0, screenY: 200, priority: CHIP_PRIORITY.done },
    ];
    const visibility = computeChipVisibility(candidates, 140);
    expect(visibility.get('a')).toBe(true);
    expect(visibility.get('b')).toBe(true);
    expect(visibility.get('c')).toBe(true);
  });

  it('a collision in the same cell keeps only the highest-priority (lowest number) candidate', () => {
    const candidates: ChipCandidate[] = [
      { id: 'low-priority', screenX: 10, screenY: 10, priority: CHIP_PRIORITY.done },
      { id: 'high-priority', screenX: 15, screenY: 12, priority: CHIP_PRIORITY.failed },
    ];
    const visibility = computeChipVisibility(candidates, 140);
    expect(visibility.get('high-priority')).toBe(true);
    expect(visibility.get('low-priority')).toBe(false);
  });

  it('priority order is honored end-to-end: failed > decision > running > queued > done', () => {
    expect(CHIP_PRIORITY.failed).toBeLessThan(CHIP_PRIORITY.decision);
    expect(CHIP_PRIORITY.decision).toBeLessThan(CHIP_PRIORITY.running);
    expect(CHIP_PRIORITY.running).toBeLessThan(CHIP_PRIORITY.queued);
    expect(CHIP_PRIORITY.queued).toBeLessThan(CHIP_PRIORITY.done);

    const candidates: ChipCandidate[] = [
      { id: 'done', screenX: 0, screenY: 0, priority: CHIP_PRIORITY.done },
      { id: 'queued', screenX: 1, screenY: 1, priority: CHIP_PRIORITY.queued },
      { id: 'running', screenX: 2, screenY: 1, priority: CHIP_PRIORITY.running },
      { id: 'decision', screenX: 3, screenY: 0, priority: CHIP_PRIORITY.decision },
      { id: 'failed', screenX: 4, screenY: 1, priority: CHIP_PRIORITY.failed },
    ];
    // All in the same tiny cell (cellPx=1000 forces everything into cell 0:0).
    const visibility = computeChipVisibility(candidates, 1000);
    expect(visibility.get('failed')).toBe(true);
    expect(visibility.get('decision')).toBe(false);
    expect(visibility.get('running')).toBe(false);
    expect(visibility.get('queued')).toBe(false);
    expect(visibility.get('done')).toBe(false);
  });

  it('is deterministic — same input always yields the same result', () => {
    const candidates: ChipCandidate[] = [
      { id: 'a', screenX: 5, screenY: 5, priority: CHIP_PRIORITY.running },
      { id: 'b', screenX: 8, screenY: 6, priority: CHIP_PRIORITY.running },
    ];
    const first = computeChipVisibility(candidates, 140);
    const second = computeChipVisibility(candidates, 140);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it('an empty candidate list returns an empty map', () => {
    expect(computeChipVisibility([], 140).size).toBe(0);
  });
});
