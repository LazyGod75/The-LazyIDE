/* teachMode.test.ts — unit tests for teach-by-demonstration journaling. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  startTeachSession,
  recordTeachStep,
  endTeachSession,
  getActiveTeachSession,
  isTeachModeActive,
  resetTeachMode,
} from '../lib/bots/teachMode';

beforeEach(() => {
  resetTeachMode();
});

describe('startTeachSession', () => {
  it('creates a session and returns its id', () => {
    const id = startTeachSession('bot_1', 'Order from Amazon');
    expect(id).toMatch(/^teach_/);
    expect(isTeachModeActive('bot_1')).toBe(true);
  });

  it('initializes with an empty steps array', () => {
    startTeachSession('bot_1', 'Test skill');
    const session = getActiveTeachSession('bot_1');
    expect(session?.steps).toEqual([]);
    expect(session?.skillName).toBe('Test skill');
  });
});

describe('recordTeachStep', () => {
  it('records a step and returns it with an id and timestamp', () => {
    startTeachSession('bot_1', 'Test skill');
    const step = recordTeachStep('bot_1', {
      kind: 'navigate',
      target: 'https://amazon.com',
    });
    expect(step?.id).toMatch(/^step_/);
    expect(step?.timestamp).toBeTruthy();
    expect(step?.kind).toBe('navigate');
  });

  it('appends steps in order', () => {
    startTeachSession('bot_1', 'Test skill');
    recordTeachStep('bot_1', { kind: 'navigate', target: 'url1' });
    recordTeachStep('bot_1', { kind: 'click', target: 'button1' });
    const session = getActiveTeachSession('bot_1');
    expect(session?.steps).toHaveLength(2);
    expect(session?.steps[0].target).toBe('url1');
    expect(session?.steps[1].target).toBe('button1');
  });

  it('returns null when no active session exists', () => {
    const step = recordTeachStep('nonexistent', { kind: 'click', target: 'btn' });
    expect(step).toBeNull();
  });
});

describe('endTeachSession', () => {
  it('ends the session and returns the completed journal', () => {
    startTeachSession('bot_1', 'Test skill');
    recordTeachStep('bot_1', { kind: 'navigate', target: 'url' });
    const journal = endTeachSession('bot_1');
    expect(journal?.endedAt).toBeTruthy();
    expect(journal?.steps).toHaveLength(1);
    expect(isTeachModeActive('bot_1')).toBe(false);
  });

  it('returns null when no active session exists', () => {
    expect(endTeachSession('nonexistent')).toBeNull();
  });
});

describe('isTeachModeActive', () => {
  it('returns false before a session starts', () => {
    expect(isTeachModeActive('bot_1')).toBe(false);
  });

  it('returns true after a session starts', () => {
    startTeachSession('bot_1', 'Test');
    expect(isTeachModeActive('bot_1')).toBe(true);
  });

  it('returns false after a session ends', () => {
    startTeachSession('bot_1', 'Test');
    endTeachSession('bot_1');
    expect(isTeachModeActive('bot_1')).toBe(false);
  });
});
