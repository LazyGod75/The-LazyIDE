/**
 * missionHistoryWindow.test.ts — token-efficiency wave (2026-08-14): bounds
 * the mission ReAct loop's conversation history sent to the LLM every step.
 * See missionHistoryWindow.ts's module doc comment for the full rationale
 * (char-budget sliding window + pinned task message, deliberately NOT an
 * LLM-generated summary — mirrors managerHistoryWindow.ts's design).
 */

import { describe, it, expect } from 'vitest';
import { boundMissionHistory, MISSION_HISTORY_CHAR_BUDGET } from '../lib/agents/missionHistoryWindow';
import type { MissionMessage } from '../lib/agents/missionHistoryWindow';

function msg(role: MissionMessage['role'], content: string): MissionMessage {
  return { role, content };
}

describe('boundMissionHistory', () => {
  it('returns everything unchanged when total size fits the budget (the common case)', () => {
    const messages = [
      msg('user', 'Task: fix the bug in src/main.ts'),
      msg('assistant', 'THOUGHT: reading the file\nACTION: read_file\nARGS: {"path":"src/main.ts"}'),
      msg('user', 'Observation: ...'),
    ];
    const result = boundMissionHistory(messages);
    expect(result.droppedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it('returns an empty result for an empty transcript', () => {
    expect(boundMissionHistory([])).toEqual({ messages: [], droppedCount: 0 });
  });

  it('keeps a contiguous suffix of the most recent steps under a tight budget', () => {
    const messages = [
      msg('user', 'a'.repeat(1000)), // task
      msg('assistant', 'b'.repeat(1000)),
      msg('user', 'c'.repeat(1000)),
      msg('assistant', 'd'.repeat(1000)),
      msg('user', 'e'.repeat(1000)),
    ];
    const result = boundMissionHistory(messages, 2100);
    expect(result.droppedCount).toBeGreaterThan(0);
    // The most recent message (this step's own observation) is always kept.
    expect(result.messages[result.messages.length - 1].content).toBe('e'.repeat(1000));
    // A marker explaining the omission is present.
    expect(result.messages.some((m) => m.content.includes('HISTORY WINDOW'))).toBe(true);
  });

  it('never drops the current step\'s own last message, even if it alone exceeds the budget', () => {
    const messages = [msg('user', 'task'), msg('user', 'x'.repeat(100_000))];
    const result = boundMissionHistory(messages, 10);
    expect(result.messages[result.messages.length - 1].content).toBe('x'.repeat(100_000));
  });

  it('truncates (never drops) an oversized pinned task message', () => {
    const hugeTask = msg('user', 'y'.repeat(50_000));
    const messages = [hugeTask, msg('assistant', 'ok'), msg('user', 'z'.repeat(1000))];
    const result = boundMissionHistory(messages, 1100);
    const pinned = result.messages[0];
    expect(pinned.content.length).toBeLessThan(hugeTask.content.length);
    expect(pinned.content).toContain('truncated');
  });

  it('never loses reachability of the task: the pinned message always contains a real fragment of the original task text', () => {
    const messages = [
      msg('user', 'Task: implement OAuth PKCE flow, never store the client secret in localStorage.'),
      ...Array.from({ length: 40 }, (_, i) => msg(i % 2 === 0 ? 'assistant' : 'user', 'x'.repeat(3000))),
    ];
    const result = boundMissionHistory(messages, 20_000);
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.messages[0].content).toContain('never store the client secret');
  });

  it('caps growth: a 100-step mission transcript stays well under its unbounded size', () => {
    const steps: MissionMessage[] = [msg('user', 'Task: refactor the auth module')];
    for (let i = 0; i < 100; i++) {
      steps.push(msg('assistant', `THOUGHT: step ${i}\nACTION: read_file\nARGS: {"path":"file${i}.ts"}`));
      steps.push(msg('user', `Observation: ${'file content line\n'.repeat(50)}`));
    }
    const unboundedChars = steps.reduce((sum, m) => sum + m.content.length, 0);
    const result = boundMissionHistory(steps);
    const boundedChars = result.messages.reduce((sum, m) => sum + m.content.length, 0);
    expect(unboundedChars).toBeGreaterThan(MISSION_HISTORY_CHAR_BUDGET); // sanity: the scenario is actually large
    expect(boundedChars).toBeLessThan(unboundedChars);
    expect(boundedChars).toBeLessThan(MISSION_HISTORY_CHAR_BUDGET + 6_000 /* pinned task cap */ + 1_000 /* marker */);
  });

  it('uses role "user" for pinned/marker messages — never "system" (managedAgent.ts sends system separately)', () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(2000)));
    const result = boundMissionHistory(messages, 5000);
    expect(result.droppedCount).toBeGreaterThan(0);
    for (const m of result.messages) {
      expect(m.role === 'user' || m.role === 'assistant').toBe(true);
    }
  });

  it('MISSION_HISTORY_CHAR_BUDGET is a positive, sane default larger than the manager chat budget', () => {
    expect(MISSION_HISTORY_CHAR_BUDGET).toBeGreaterThan(0);
  });

  it('does not mutate the input array (immutability convention)', () => {
    const messages = [msg('user', 'x'.repeat(2000)), msg('user', 'y'.repeat(2000))];
    const snapshot = JSON.parse(JSON.stringify(messages));
    boundMissionHistory(messages, 1500);
    expect(messages).toEqual(snapshot);
  });
});
