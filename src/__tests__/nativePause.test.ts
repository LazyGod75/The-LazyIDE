import { describe, it, expect } from 'vitest';
import { canNativePause, nativeResumePlan, shouldTreatNativeExitAsPause } from '../lib/agents/nativePause';

describe('shouldTreatNativeExitAsPause', () => {
  it('is true only when pause won over stop', () => {
    expect(shouldTreatNativeExitAsPause({ pauseRequested: true, stopRequested: false })).toBe(true);
    expect(shouldTreatNativeExitAsPause({ pauseRequested: true, stopRequested: true })).toBe(false);
    expect(shouldTreatNativeExitAsPause({ pauseRequested: false, stopRequested: false })).toBe(false);
  });
});

describe('nativeResumePlan', () => {
  it('returns null unless the mission is running and paused with a worktree', () => {
    expect(nativeResumePlan({ status: 'running', paused: true })).toBeNull();
    expect(nativeResumePlan({ status: 'review', paused: true, worktree: 'agent/M1' })).toBeNull();
    expect(nativeResumePlan({ status: 'running', paused: false, worktree: 'agent/M1' })).toBeNull();
  });

  it('keeps the worktree and forwards a captured session id', () => {
    expect(
      nativeResumePlan({
        status: 'running',
        paused: true,
        worktree: '.lazy/worktrees/agent-M1',
        agentMetrics: {
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          toolCount: 0,
          sessionId: 'sess-abc',
        },
      }),
    ).toEqual({ worktree: '.lazy/worktrees/agent-M1', sessionId: 'sess-abc' });
  });
});

describe('canNativePause', () => {
  it('is true for a live unpaused run', () => {
    expect(canNativePause({ status: 'running', paused: false })).toBe(true);
    expect(canNativePause({ status: 'running', paused: true })).toBe(false);
  });
});
