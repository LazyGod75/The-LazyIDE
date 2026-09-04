/**
 * canvasFilter.test.ts — pure search/status/focus-pannes matching helpers
 * from useCanvasFilter.ts (W2b, spec §5 "Search/filter").
 */

import { describe, it, expect } from 'vitest';
import { matchesFocusFailures, matchesSearchQuery, matchesStatusFilters } from '../components/agents/canvas/hooks/useCanvasFilter';
import { makeRef, type DraftSpec, type MissionNodeData, type NoteData, type ScheduleNodeData } from '../components/agents/canvas/canvasTypes';
import type { CanvasReactFlowNode } from '../components/agents/canvas/reconciler';
import type { FleetMission } from '../lib/agents/fleetMissions';
import type { JudgeVerdict } from '../lib/agents/types';

function mission(overrides: Partial<FleetMission> = {}): FleetMission {
  return { id: 'm1', title: 'Fix login bug', status: 'running', stage: 'code', model: 'sonnet-4.6', updatedMs: 1, urgent: false, ...overrides };
}

function verdict(overrides: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return { score: 0.5, passed: true, risk: 'low', reviewers: [], createdAt: new Date().toISOString(), ...overrides };
}

function missionNode(overrides: Partial<FleetMission> = {}): CanvasReactFlowNode {
  const m = mission(overrides);
  const data: MissionNodeData = { mission: m, projectId: 'p1', isActiveProject: true };
  return { id: makeRef('mission', m.id), type: 'mission', position: { x: 0, y: 0 }, data } as unknown as CanvasReactFlowNode;
}

function draftNode(overrides: Partial<DraftSpec> = {}): CanvasReactFlowNode {
  const data: DraftSpec = { id: 'd1', title: 'Testeur nocturne', task: 'run tests', createdBy: 'user', ...overrides };
  return { id: makeRef('draft', data.id), type: 'draft', position: { x: 0, y: 0 }, data } as unknown as CanvasReactFlowNode;
}

function scheduleNode(overrides: Partial<ScheduleNodeData> = {}): CanvasReactFlowNode {
  const data: ScheduleNodeData = { scheduleId: 's1', agentName: 'Éclaireur', cron: '0 9 * * *', cronLabel: 'chaque jour 9h', enabled: true, ...overrides };
  return { id: makeRef('schedule', data.scheduleId), type: 'schedule', position: { x: 0, y: 0 }, data } as unknown as CanvasReactFlowNode;
}

function noteNode(text: string): CanvasReactFlowNode {
  const data: NoteData = { id: 'n1', text };
  return { id: makeRef('note', 'n1'), type: 'note', position: { x: 0, y: 0 }, data } as unknown as CanvasReactFlowNode;
}

function projectNode(): CanvasReactFlowNode {
  return {
    id: makeRef('project', 'p1'),
    type: 'project',
    position: { x: 0, y: 0 },
    data: { projectId: 'p1' } as unknown as CanvasReactFlowNode['data'],
  } as CanvasReactFlowNode;
}

describe('matchesSearchQuery', () => {
  it('empty/blank query always matches', () => {
    expect(matchesSearchQuery(missionNode(), '')).toBe(true);
    expect(matchesSearchQuery(missionNode(), '   ')).toBe(true);
  });

  it('matches mission title case-insensitively', () => {
    expect(matchesSearchQuery(missionNode(), 'LOGIN')).toBe(true);
    expect(matchesSearchQuery(missionNode(), 'nope')).toBe(false);
  });

  it('matches mission model', () => {
    expect(matchesSearchQuery(missionNode(), 'sonnet')).toBe(true);
  });

  it('is diacritic-insensitive', () => {
    expect(matchesSearchQuery(scheduleNode({ agentName: 'Éclaireur' }), 'eclaireur')).toBe(true);
    expect(matchesSearchQuery(scheduleNode({ agentName: 'eclaireur' }), 'éclaireur')).toBe(true);
  });

  it('matches draft title/agent/model', () => {
    const node = draftNode({ agentName: 'tester-bot', model: 'haiku' });
    expect(matchesSearchQuery(node, 'nocturne')).toBe(true);
    expect(matchesSearchQuery(node, 'tester-bot')).toBe(true);
    expect(matchesSearchQuery(node, 'haiku')).toBe(true);
  });

  it('matches note text', () => {
    expect(matchesSearchQuery(noteNode('remember the deploy key'), 'deploy')).toBe(true);
  });

  it('project zones always match (never search targets themselves)', () => {
    expect(matchesSearchQuery(projectNode(), 'anything at all')).toBe(true);
  });
});

describe('matchesStatusFilters', () => {
  it('empty filter set always matches', () => {
    expect(matchesStatusFilters(missionNode({ status: 'failed' }), new Set())).toBe(true);
  });

  it('matches only the selected statuses', () => {
    const filters = new Set<FleetMission['status']>(['failed', 'review']);
    expect(matchesStatusFilters(missionNode({ status: 'failed' }), filters)).toBe(true);
    expect(matchesStatusFilters(missionNode({ status: 'running' }), filters)).toBe(false);
  });

  it('a node with no mission status never matches an active filter', () => {
    const filters = new Set<FleetMission['status']>(['failed']);
    expect(matchesStatusFilters(draftNode(), filters)).toBe(false);
    expect(matchesStatusFilters(noteNode('x'), filters)).toBe(false);
  });

  it('project zones always match', () => {
    expect(matchesStatusFilters(projectNode(), new Set<FleetMission['status']>(['failed']))).toBe(true);
  });
});

describe('matchesFocusFailures', () => {
  it('matches a failed mission', () => {
    expect(matchesFocusFailures(missionNode({ status: 'failed' }))).toBe(true);
  });

  it('matches a review mission with a rejected verdict', () => {
    const node = missionNode({ status: 'review', judgeVerdict: verdict({ passed: false, score: 0.2 }) });
    expect(matchesFocusFailures(node)).toBe(true);
  });

  it('does NOT match a review mission with no verdict yet (not judged, not a panne)', () => {
    expect(matchesFocusFailures(missionNode({ status: 'review' }))).toBe(false);
  });

  it('does NOT match a review mission with an APPROVED verdict', () => {
    const node = missionNode({ status: 'review', judgeVerdict: verdict({ passed: true, score: 0.9 }) });
    expect(matchesFocusFailures(node)).toBe(false);
  });

  it('does NOT match a running/queued/done mission', () => {
    expect(matchesFocusFailures(missionNode({ status: 'running' }))).toBe(false);
    expect(matchesFocusFailures(missionNode({ status: 'done' }))).toBe(false);
  });

  it('does NOT match drafts/schedules/notes (only missions can be a panne)', () => {
    expect(matchesFocusFailures(draftNode())).toBe(false);
    expect(matchesFocusFailures(scheduleNode())).toBe(false);
    expect(matchesFocusFailures(noteNode('x'))).toBe(false);
  });

  it('project zones always match', () => {
    expect(matchesFocusFailures(projectNode())).toBe(true);
  });
});
