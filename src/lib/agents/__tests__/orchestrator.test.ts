/* orchestrator.test.ts — Unit coverage for new orchestrator/autonomy/learning modules. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getEffectiveAutonomy,
  isSafeAction,
  isSensitiveAction,
  mapModeToApproval,
} from '../autonomyMode';
import { evaluateActionGate } from '../actionGate';
import { parseRules, evaluateRule } from '../customRules';
import {
  spend,
  setMissionLimit,
  setProjectLimit,
  setGlobalLimit,
  getMissionBudget,
  getProjectBudget,
  getGlobalBudget,
  isOverBudget,
} from '../budgetTracker';
import { buildFleetContext, buildBrainDrivenContext, formatAutonomyContext } from '../managerContext';
import { observeMissionOutcome } from '../observationEngine';
import { diagnose } from '../diagnosisEngine';
import { capturePattern, mergePatterns } from '../learningCapture';
import { runImprovementLoop } from '../improvementLoop';
import { registerProject, setProjectMissions } from '../globalRuntime';
import type { Mission, DecisionPattern } from '../types';

function makeMission(id: string, status: Mission['status']): Mission {
  return {
    id,
    title: `Mission ${id}`,
    status,
    model: 'claude-sonnet',
    worktree: '',
    createdAt: Date.now(),
    progress: 0,
    planSteps: [],
    actionTimeline: [],
  };
}

describe('autonomyMode', () => {
  it('returns default supervised config', () => {
    const cfg = getEffectiveAutonomy();
    expect(cfg.mode).toBe('supervised');
  });

  it('classifies safe and sensitive actions', () => {
    expect(isSafeAction('brain_query')).toBe(true);
    expect(isSensitiveAction('launch_mission')).toBe(true);
  });

  it('maps autonomy modes to approval levels', () => {
    expect(mapModeToApproval('manual')).toBe('default');
    expect(mapModeToApproval('yolo')).toBe('full');
    expect(mapModeToApproval('supervised')).toBe('acceptEdits');
  });
});

describe('actionGate', () => {
  it('asks for every action in manual mode', async () => {
    const gate = await evaluateActionGate('brain_query', getEffectiveAutonomy({ mode: 'manual' }));
    expect(gate.decision).toBe('ask');
  });

  it('allows safe actions in supervised mode', async () => {
    const gate = await evaluateActionGate('brain_query', getEffectiveAutonomy({ mode: 'supervised' }));
    expect(gate.decision).toBe('allow');
  });

  it('asks for sensitive actions in supervised mode', async () => {
    const gate = await evaluateActionGate('launch_mission', getEffectiveAutonomy({ mode: 'supervised' }));
    expect(gate.decision).toBe('ask');
  });

  it('denies actions on the denied list', async () => {
    const gate = await evaluateActionGate('launch_mission', getEffectiveAutonomy({ deniedActions: ['launch_mission'] }));
    expect(gate.decision).toBe('deny');
  });
});

describe('customRules', () => {
  it('parses a JSON rule list', () => {
    const rules = parseRules('[{"id":"r1","condition":"action=launch_mission","action":"ask"}]');
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('r1');
  });

  it('evaluates a simple action rule', () => {
    const [rule] = parseRules('[{"id":"r1","condition":"action=launch_mission","action":"ask"}]');
    expect(evaluateRule(rule, { actionType: 'launch_mission' })).toBe(true);
    expect(evaluateRule(rule, { actionType: 'brain_query' })).toBe(false);
  });
});

describe('budgetTracker', () => {
  beforeEach(() => {
    setGlobalLimit(undefined);
    setMissionLimit('m1', undefined);
    setProjectLimit('p1', undefined);
  });

  it('tracks spend across mission, project and global', () => {
    spend('m1', 'p1', 50);
    expect(getMissionBudget('m1').spentCents).toBe(50);
    expect(getProjectBudget('p1').spentCents).toBe(50);
    expect(getGlobalBudget().spentCents).toBe(50);
  });

  it('detects over budget', () => {
    setMissionLimit('m1', 100);
    spend('m1', 'p1', 150);
    expect(isOverBudget('m1', 'p1')).toBe(true);
  });
});

describe('managerContext', () => {
  it('formats fleet context without crashing', () => {
    expect(typeof buildFleetContext()).toBe('string');
  });

  it('formats brain-driven context', () => {
    expect(typeof buildBrainDrivenContext('test')).toBe('string');
  });

  it('formats autonomy context', () => {
    expect(formatAutonomyContext({ mode: 'yolo' })).toContain('yolo');
  });
});

describe('observationEngine', () => {
  it('builds a MissionOutcome from a Mission', () => {
    const mission = makeMission('m1', 'done');
    const outcome = observeMissionOutcome(mission, 'p1');
    expect(outcome.missionId).toBe('m1');
    expect(outcome.projectId).toBe('p1');
    expect(outcome.status).toBe('done');
  });
});

describe('diagnosisEngine', () => {
  it('categorizes a type error', async () => {
    const outcome = {
      missionId: 'm1',
      projectId: 'p1',
      title: 't',
      model: 'claude-sonnet',
      status: 'failed' as const,
      errorMessage: 'TypeScript type mismatch',
      timestamp: Date.now(),
    };
    const d = await diagnose(outcome);
    expect(d.category).toBe('type_error');
    expect(d.confidence).toBeGreaterThan(0);
  });
});

describe('learningCapture', () => {
  it('captures a decision pattern', () => {
    const outcome = {
      missionId: 'm1',
      projectId: 'p1',
      title: 't',
      model: 'claude-sonnet',
      status: 'done' as const,
      timestamp: Date.now(),
    };
    const pattern = capturePattern('trigger', 'action', outcome, 'p1');
    expect(pattern.outcome).toBe('success');
    expect(pattern.trigger).toBe('trigger');
  });

  it('merges patterns with same outcome', () => {
    const patterns: DecisionPattern[] = [
      { id: 'p1', trigger: 't', action: 'a', outcome: 'success', confidence: 0.5, occurrences: 1, lastSeen: 0 },
    ];
    const outcome = {
      missionId: 'm2',
      projectId: 'p1',
      title: 't',
      model: 'claude-sonnet',
      status: 'done' as const,
      timestamp: Date.now(),
    };
    const merged = mergePatterns(patterns, outcome);
    expect(merged[0].occurrences).toBe(2);
    expect(merged[0].confidence).toBeGreaterThan(0.5);
  });
});

describe('improvementLoop', () => {
  it('returns empty for an unknown project', async () => {
    const suggestions = await runImprovementLoop('unknown');
    expect(suggestions).toEqual([]);
  });

  it('suggests fixes for failed missions', async () => {
    registerProject('p-test', '/tmp/p-test', 'Test Project');
    const mission = makeMission('m1', 'failed');
    mission.statusReason = 'Test suite failed';
    mission.agentMetrics = { durationMs: 1000, inputTokens: 0, outputTokens: 0, costUsd: 1, toolCount: 0 };
    setProjectMissions('p-test', [mission]);
    const suggestions = await runImprovementLoop('p-test');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].projectId).toBe('p-test');
  });
});
