import { describe, it, expect } from 'vitest';
import {
  capActionTimeline,
  capManagerMessages,
  pruneMissions,
  MAX_ACTION_TIMELINE_ENTRIES,
  MAX_MANAGER_MESSAGES,
  MAX_INACTIVE_MISSIONS,
} from '../lib/agents/missionCaps';
import type { ActionEvent, ManagerMessage, Mission } from '../lib/agents/types';

function makeTimeline(n: number): ActionEvent[] {
  return Array.from({ length: n }, (_, i) => ({ time: `t${i}`, text: `entry ${i}` }));
}

function makeManagerMessages(n: number): ManagerMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: 'user' as const,
    content: `msg ${i}`,
    timestamp: `${i}`,
  }));
}

function makeMission(id: string, status: Mission['status']): Mission {
  return { id, title: id, status, model: 'test' };
}

describe('capActionTimeline', () => {
  it('leaves a short timeline untouched', () => {
    const entries = makeTimeline(10);
    expect(capActionTimeline(entries)).toEqual(entries);
  });

  it('keeps only the most recent MAX_ACTION_TIMELINE_ENTRIES entries', () => {
    const entries = makeTimeline(MAX_ACTION_TIMELINE_ENTRIES + 50);
    const capped = capActionTimeline(entries);
    expect(capped).toHaveLength(MAX_ACTION_TIMELINE_ENTRIES);
    expect(capped[0]).toEqual(entries[50]);
    expect(capped[capped.length - 1]).toEqual(entries[entries.length - 1]);
  });

  it('does not mutate the input', () => {
    const entries = makeTimeline(MAX_ACTION_TIMELINE_ENTRIES + 5);
    const copy = [...entries];
    capActionTimeline(entries);
    expect(entries).toEqual(copy);
  });
});

describe('capManagerMessages', () => {
  it('leaves a short history untouched', () => {
    const messages = makeManagerMessages(5);
    expect(capManagerMessages(messages)).toEqual(messages);
  });

  it('keeps only the most recent MAX_MANAGER_MESSAGES entries', () => {
    const messages = makeManagerMessages(MAX_MANAGER_MESSAGES + 20);
    const capped = capManagerMessages(messages);
    expect(capped).toHaveLength(MAX_MANAGER_MESSAGES);
    expect(capped[0]).toEqual(messages[20]);
  });
});

describe('pruneMissions', () => {
  it('keeps everything when under the inactive budget', () => {
    const missions = [makeMission('M1', 'done'), makeMission('M2', 'running')];
    expect(pruneMissions(missions)).toEqual(missions);
  });

  it('keeps ALL active-ish missions regardless of count', () => {
    const active = Array.from({ length: MAX_INACTIVE_MISSIONS + 20 }, (_, i) => makeMission(`A${i}`, 'running'));
    expect(pruneMissions(active)).toHaveLength(active.length);
  });

  it('drops the oldest inactive missions beyond the cap, preserving original order', () => {
    const inactive = Array.from({ length: MAX_INACTIVE_MISSIONS + 30 }, (_, i) => makeMission(`D${i}`, 'done'));
    const pruned = pruneMissions(inactive);
    expect(pruned).toHaveLength(MAX_INACTIVE_MISSIONS);
    expect(pruned[0].id).toBe('D30');
    expect(pruned[pruned.length - 1].id).toBe(`D${inactive.length - 1}`);
  });

  it('keeps active missions AND the most recent inactive ones together', () => {
    const missions: Mission[] = [];
    for (let i = 0; i < MAX_INACTIVE_MISSIONS + 10; i++) missions.push(makeMission(`D${i}`, 'done'));
    missions.push(makeMission('R1', 'review'));
    const pruned = pruneMissions(missions);
    expect(pruned.find((m) => m.id === 'R1')).toBeDefined();
    expect(pruned).toHaveLength(MAX_INACTIVE_MISSIONS + 1);
  });

  it('treats a paused running mission as active-ish (paused is a flag on status "running", not its own status)', () => {
    const paused: Mission = { ...makeMission('P1', 'running'), paused: true };
    const inactive = Array.from({ length: MAX_INACTIVE_MISSIONS + 10 }, (_, i) => makeMission(`D${i}`, 'failed'));
    const pruned = pruneMissions([paused, ...inactive]);
    expect(pruned.find((m) => m.id === 'P1')).toBeDefined();
  });
});
