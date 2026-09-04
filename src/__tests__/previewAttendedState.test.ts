/**
 * Tests for previewAttendedState.ts — P59's pure "live-when-attended"
 * reducer. Exhaustively covers each gate independently so the combined
 * `iframeLive` decision can't silently regress to "always live" (the
 * original freeze bug) or "never live" (would break the feature outright).
 */

import { describe, it, expect } from 'vitest';
import { derivePreviewAttendedState, type PreviewAttendedSignals } from '../components/agents/canvas/nodes/previewAttendedState';

function signals(overrides: Partial<PreviewAttendedSignals> = {}): PreviewAttendedSignals {
  return {
    selected: false,
    hovered: false,
    pinnedLive: false,
    isLiveWinner: true,
    gesturePaused: false,
    reachable: true,
    ...overrides,
  };
}

describe('derivePreviewAttendedState — attended', () => {
  it('is not attended when neither selected, hovered, nor pinned', () => {
    expect(derivePreviewAttendedState(signals()).attended).toBe(false);
  });

  it('selected alone is attended', () => {
    expect(derivePreviewAttendedState(signals({ selected: true })).attended).toBe(true);
  });

  it('hovered alone is attended', () => {
    expect(derivePreviewAttendedState(signals({ hovered: true })).attended).toBe(true);
  });

  it('pinnedLive alone is attended (the "expand to a live panel" affordance)', () => {
    expect(derivePreviewAttendedState(signals({ pinnedLive: true })).attended).toBe(true);
  });
});

describe('derivePreviewAttendedState — iframeLive (the actual display:none gate)', () => {
  it('is live when attended, reachable, the single-live-slot winner, and no gesture is in flight', () => {
    expect(derivePreviewAttendedState(signals({ selected: true })).iframeLive).toBe(true);
  });

  it('is never live when not attended at all, even if every other gate would allow it', () => {
    expect(derivePreviewAttendedState(signals()).iframeLive).toBe(false);
  });

  it('is never live while unreachable — pausing display must never contradict the LIVE/OFFLINE badge', () => {
    expect(derivePreviewAttendedState(signals({ selected: true, reachable: false })).iframeLive).toBe(false);
  });

  it('is never live when it lost the single-live-slot race to another attended preview', () => {
    expect(derivePreviewAttendedState(signals({ selected: true, isLiveWinner: false })).iframeLive).toBe(false);
  });

  it('is never live during the canvas-gesture pause window, even if fully attended and winning', () => {
    expect(derivePreviewAttendedState(signals({ selected: true, gesturePaused: true })).iframeLive).toBe(false);
  });

  it('attended-but-not-yet-reachable (still "starting") never renders a live iframe either', () => {
    expect(derivePreviewAttendedState(signals({ hovered: true, reachable: false, isLiveWinner: false })).iframeLive).toBe(false);
  });
});
