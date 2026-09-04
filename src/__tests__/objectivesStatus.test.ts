import { describe, it, expect } from 'vitest';
import { deriveObjectiveStatus } from '../lib/objectives/objectivesStatus';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('deriveObjectiveStatus', () => {
  it('returns no-deadline for a permanent rule (no deadline)', () => {
    const status = deriveObjectiveStatus({
      createdAtMs: 0,
      deadlineMs: null,
      targetCount: null,
      currentCount: 0,
    });
    expect(status).toBe('no-deadline');
  });

  it('is on-track when progress is already complete, even past the deadline', () => {
    const now = 10 * DAY_MS;
    const status = deriveObjectiveStatus(
      { createdAtMs: 0, deadlineMs: 5 * DAY_MS, targetCount: 5, currentCount: 5 },
      now,
    );
    expect(status).toBe('on-track');
  });

  it('is late once the deadline has passed with incomplete progress', () => {
    const now = 10 * DAY_MS;
    const status = deriveObjectiveStatus(
      { createdAtMs: 0, deadlineMs: 5 * DAY_MS, targetCount: 9, currentCount: 3 },
      now,
    );
    expect(status).toBe('late');
  });

  it('is on-track when a deadline exists but no fixed target, and the deadline has not passed', () => {
    const now = 2 * DAY_MS;
    const status = deriveObjectiveStatus(
      { createdAtMs: 0, deadlineMs: 5 * DAY_MS, targetCount: null, currentCount: 0 },
      now,
    );
    expect(status).toBe('on-track');
  });

  it('is on-track when ahead of pace (progress ratio exceeds time ratio)', () => {
    // 9-day span, 3 days elapsed (33% of time) but 70% done (7/10).
    const now = 3 * DAY_MS;
    const status = deriveObjectiveStatus(
      { createdAtMs: 0, deadlineMs: 9 * DAY_MS, targetCount: 10, currentCount: 7 },
      now,
    );
    expect(status).toBe('on-track');
  });

  it('is late when behind pace beyond the tolerance, before the deadline', () => {
    // 9-day span, 6 days elapsed (67% of time) but only 20% done (2/10).
    const now = 6 * DAY_MS;
    const status = deriveObjectiveStatus(
      { createdAtMs: 0, deadlineMs: 9 * DAY_MS, targetCount: 10, currentCount: 2 },
      now,
    );
    expect(status).toBe('late');
  });

  it('tolerates a small pacing gap (within 10%) as on-track', () => {
    // 10-day span, 5 days elapsed (50%), progress 42% (within 10% tolerance).
    const now = 5 * DAY_MS;
    const status = deriveObjectiveStatus(
      { createdAtMs: 0, deadlineMs: 10 * DAY_MS, targetCount: 100, currentCount: 42 },
      now,
    );
    expect(status).toBe('on-track');
  });
});
