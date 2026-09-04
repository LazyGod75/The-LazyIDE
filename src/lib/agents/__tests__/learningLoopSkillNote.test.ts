/* learningLoopSkillNote.test.ts — P2: skill-shaped memory capture on a
   passing verdict (learningLoop.ts's captureSkillNote). Mirrors
   brainAndState.test.ts's platform mock convention. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runLearningLoop } from '../learningLoop';
import type { Mission, JudgeVerdict } from '../types';

// vi.hoisted: vi.mock factories below are hoisted above this module's own
// top-level statements, so a plain `const captureMock = vi.fn()` referenced
// inside them would throw "Cannot access before initialization" — wrapping
// the shared mock in vi.hoisted() runs it before the mock factories need it.
const captureMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../platform', () => ({
  getPlatform: () => ({ brain: { capture: captureMock } }),
}));

vi.mock('../../brain/capture', () => ({
  captureAgentMission: vi.fn(),
  // learningLoop.ts now routes both its captures through captureRawEvent
  // (the retry/give-up pipeline) instead of calling platform.brain.capture
  // directly — aliased to the SAME captureMock so skillNoteEvents() below
  // keeps seeing exactly what it did before this fix.
  captureRawEvent: captureMock,
}));

function makeVerdict(overrides: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    score: 85,
    passed: true,
    risk: 'low',
    reviewers: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'm1',
    title: 'Add retry logic',
    status: 'done',
    model: 'claude-sonnet-5',
    ...overrides,
  };
}

function skillNoteEvents(): Array<{ tags?: string[]; text: string }> {
  return captureMock.mock.calls
    .map(([event]) => event as { tags?: string[]; text: string })
    .filter((event) => event.tags?.includes('skill') ?? false);
}

beforeEach(() => {
  captureMock.mockClear();
});

describe('runLearningLoop — skill-shaped memory (P2)', () => {
  it('writes exactly one skill note on a real passing verdict, with tags + provenance', async () => {
    const mission = makeMission({ judgeVerdict: makeVerdict({ score: 95 }) });
    await runLearningLoop(mission);

    const events = skillNoteEvents();
    expect(events).toHaveLength(1);
    expect(events[0].tags).toEqual(expect.arrayContaining(['skill', 'confidence:high', 'engine:native', 'mission:m1']));
    expect(events[0].text).toContain('WHAT worked');
    expect(events[0].text).toContain('WHEN to reuse');
    expect(events[0].text).toContain('Provenance: mission m1');
  });

  it('tags a managed-engine mission correctly (model id contains a slash) with medium confidence near the floor', async () => {
    const mission = makeMission({ model: 'anthropic/claude-sonnet-5', judgeVerdict: makeVerdict({ score: 75 }) });
    await runLearningLoop(mission);

    const [event] = skillNoteEvents();
    expect(event.tags).toContain('engine:managed');
    expect(event.tags).toContain('confidence:medium');
  });

  it('never writes a skill note when the verdict failed', async () => {
    const mission = makeMission({ judgeVerdict: makeVerdict({ passed: false, score: 40 }) });
    await runLearningLoop(mission);
    expect(skillNoteEvents()).toHaveLength(0);
  });

  it('never writes a skill note when there is no verdict at all', async () => {
    await runLearningLoop(makeMission());
    expect(skillNoteEvents()).toHaveLength(0);
  });

  it('never writes a skill note for a fabricated/scoreUnavailable verdict, even when marked passed (honesty contract)', async () => {
    const mission = makeMission({ judgeVerdict: makeVerdict({ passed: true, score: 0, scoreUnavailable: true }) });
    await runLearningLoop(mission);
    expect(skillNoteEvents()).toHaveLength(0);
  });

  it('never writes a skill note below the score floor', async () => {
    const mission = makeMission({ judgeVerdict: makeVerdict({ passed: true, score: 65 }) });
    await runLearningLoop(mission);
    expect(skillNoteEvents()).toHaveLength(0);
  });
});
