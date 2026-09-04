import { describe, expect, it, beforeEach } from 'vitest';
import {
  loadPersistedGoals,
  persistConversationGoal,
  clearPersistedGoal,
} from '../lib/agents/managerGoalPersist';
import type { ConversationGoal } from '../lib/agents/managerEngine';

const goal = (text: string): ConversationGoal => ({
  goalText: text,
  createdAt: 1,
  extensionsUsed: 0,
  status: 'active',
  researchOnlyStreak: 0,
});

beforeEach(() => {
  localStorage.clear();
});

describe('managerGoalPersist', () => {
  it('round-trips a goal across reload', () => {
    persistConversationGoal('c1', goal('lance M9'));
    const map = loadPersistedGoals();
    expect(map.get('c1')?.goalText).toBe('lance M9');
    expect(map.get('c1')?.status).toBe('active');
  });

  it('clears a persisted goal', () => {
    persistConversationGoal('c1', goal('x'));
    clearPersistedGoal('c1');
    expect(loadPersistedGoals().has('c1')).toBe(false);
  });
});
