import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  notifyCanvasViewportMoving,
  getCanvasGesturePaused,
  subscribeCanvasGesturePause,
  GESTURE_PAUSE_TAIL_MS,
  _resetCanvasGesturePauseForTests,
} from '../components/agents/canvas/chrome/canvasGesturePause';

beforeEach(() => {
  _resetCanvasGesturePauseForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  _resetCanvasGesturePauseForTests();
});

describe('canvasGesturePause', () => {
  it('ignores the first notify (mount read is not a gesture)', () => {
    notifyCanvasViewportMoving();
    expect(getCanvasGesturePaused()).toBe(false);
  });

  it('pauses on the second notify and lifts after the settle tail', () => {
    const ticks: boolean[] = [];
    const unsub = subscribeCanvasGesturePause(() => ticks.push(getCanvasGesturePaused()));
    notifyCanvasViewportMoving();
    notifyCanvasViewportMoving();
    expect(getCanvasGesturePaused()).toBe(true);
    expect(ticks).toEqual([true]);

    vi.advanceTimersByTime(GESTURE_PAUSE_TAIL_MS - 1);
    expect(getCanvasGesturePaused()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(getCanvasGesturePaused()).toBe(false);
    expect(ticks).toEqual([true, false]);
    unsub();
  });

  it('does not re-notify subscribers while already paused (no per-frame React commits)', () => {
    let commits = 0;
    const unsub = subscribeCanvasGesturePause(() => { commits += 1; });
    notifyCanvasViewportMoving();
    notifyCanvasViewportMoving();
    expect(commits).toBe(1);
    notifyCanvasViewportMoving();
    notifyCanvasViewportMoving();
    expect(commits).toBe(1);
    unsub();
  });
});
