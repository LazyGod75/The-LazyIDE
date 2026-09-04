import { describe, expect, it, beforeEach } from 'vitest';
import { getCharterDecision, recordCharterDecision } from '../lib/agents/managerCharterStore';

beforeEach(() => {
  localStorage.clear();
});

describe('managerCharterStore', () => {
  it('remembers an accepted charter across reads', () => {
    recordCharterDecision('conv_1', 'ch_9', 'accepted');
    expect(getCharterDecision('conv_1', 'ch_9')).toBe('accepted');
    expect(getCharterDecision('conv_1', 'other')).toBeUndefined();
  });

  it('overwrites a prior decision for the same charter', () => {
    recordCharterDecision('conv_1', 'ch_9', 'rejected');
    recordCharterDecision('conv_1', 'ch_9', 'accepted');
    expect(getCharterDecision('conv_1', 'ch_9')).toBe('accepted');
  });
});
