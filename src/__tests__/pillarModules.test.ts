/**
 * F1 tests — globalRuntime, orchestratorState, budgetTracker, autonomyMode,
 * customRules, brainNotation, observationEngine, improvementLoop,
 * learningCapture, managerContext, agentTemplates.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProject,
  unregisterProject,
  getProject,
  getAllProjects,
  getAllMissions,
  getRunningMissions,
  getBlockedMissions,
  findMissionById,
  findMissionProjectId,
  updateMissionInRegistry,
  addMissionToRegistry,
  removeMissionFromRegistry,
  setProjectLoops,
  getAllLoops,
  setProjectOrchestrators,
  getAllOrchestrators,
  findOrchestratorById,
  addProjectSpend,
  setProjectBudget,
  getGlobalBudget,
  getSnapshot,
  subscribe,
  markInterruptedAfterCrash,
} from '../lib/agents/globalRuntime';
import type { Mission, LoopConfig, OrchestratorState, MissionOutcome, DecisionPattern } from '../lib/agents/types';

function makeMission(id: string, status: Mission['status'], _projectId: string): Mission {
  return {
    id,
    title: `Mission ${id}`,
    status,
    agentName: 'Coder',
    model: 'gpt-4',
    agentTask: 'do stuff',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Mission;
}

// ── globalRuntime ──────────────────────────────────────────────────

describe('globalRuntime', () => {
  beforeEach(() => {
    for (const p of getAllProjects()) unregisterProject(p.projectId);
  });

  it('registers and retrieves a project', () => {
    const state = registerProject('a', '/root/a', 'Project A');
    expect(state.projectId).toBe('a');
    expect(getProject('a')).toBeDefined();
    expect(getProject('nonexistent')).toBeUndefined();
  });

  it('lists all projects', () => {
    registerProject('a', '/a', 'A');
    registerProject('b', '/b', 'B');
    expect(getAllProjects()).toHaveLength(2);
  });

  it('unregisters a project', () => {
    registerProject('a', '/a', 'A');
    unregisterProject('a');
    expect(getProject('a')).toBeUndefined();
  });

  it('adds and finds missions across projects', () => {
    registerProject('a', '/a', 'A');
    registerProject('b', '/b', 'B');
    const m1 = makeMission('m1', 'running', 'a');
    const m2 = makeMission('m2', 'done', 'b');
    addMissionToRegistry('a', m1);
    addMissionToRegistry('b', m2);
    expect(getAllMissions()).toHaveLength(2);
    expect(getRunningMissions()).toHaveLength(1);
    expect(getBlockedMissions()).toHaveLength(0);
    expect(findMissionById('m1')).toBeDefined();
    expect(findMissionProjectId('m2')).toBe('b');
  });

  it('updates a mission in registry', () => {
    registerProject('a', '/a', 'A');
    addMissionToRegistry('a', makeMission('m1', 'running', 'a'));
    const updated = updateMissionInRegistry({ id: 'm1', patch: { status: 'done' } });
    expect(updated?.status).toBe('done');
    expect(findMissionById('m1')?.status).toBe('done');
  });

  it('removes a mission from registry', () => {
    registerProject('a', '/a', 'A');
    addMissionToRegistry('a', makeMission('m1', 'running', 'a'));
    removeMissionFromRegistry('m1');
    expect(findMissionById('m1')).toBeUndefined();
  });

  it('manages loops and orchestrators', () => {
    registerProject('a', '/a', 'A');
    const loop = { id: 'l1', intervalMs: 5000, missionTemplate: {} } as unknown as LoopConfig;
    setProjectLoops('a', [loop]);
    expect(getAllLoops()).toHaveLength(1);

    const orch: OrchestratorState = {
      id: 'o1', name: 'Plan A', projectId: 'a', targetProjectIds: ['a'],
      objective: 'test', steps: [], currentStep: 0, status: 'planning',
      budget: { spentCents: 0 }, childMissionIds: [], createdAt: Date.now(), updatedAt: Date.now(),
      autonomyLevel: 'supervised',
    };
    setProjectOrchestrators('a', [orch]);
    expect(getAllOrchestrators()).toHaveLength(1);
    expect(findOrchestratorById('o1')).toBeDefined();
  });

  it('tracks budget', () => {
    registerProject('a', '/a', 'A');
    setProjectBudget('a', 1000);
    addProjectSpend('a', 300);
    const budget = getGlobalBudget();
    expect(budget.spentCents).toBe(300);
    expect(budget.limitCents).toBe(1000);
  });

  it('produces a snapshot', () => {
    registerProject('a', '/a', 'A');
    addMissionToRegistry('a', makeMission('m1', 'running', 'a'));
    addMissionToRegistry('a', makeMission('m2', 'failed', 'a'));
    const snap = getSnapshot();
    expect(snap.projects).toHaveLength(1);
    expect(snap.runningMissions).toHaveLength(1);
    expect(snap.blockedMissions).toHaveLength(1);
  });

  it('notifies subscribers on change', () => {
    let called = 0;
    const off = subscribe(() => { called++; });
    registerProject('a', '/a', 'A');
    expect(called).toBeGreaterThan(0);
    off();
  });

  it('marks running missions as interrupted after crash', () => {
    registerProject('a', '/a', 'A');
    addMissionToRegistry('a', makeMission('m1', 'running', 'a'));
    addMissionToRegistry('a', makeMission('m2', 'done', 'a'));
    const interrupted = markInterruptedAfterCrash();
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0].id).toBe('m1');
    expect(findMissionById('m1')?.status).toBe('failed');
    expect(findMissionById('m1')?.statusReason).toBe('interrupted_by_crash');
  });
});

// ── budgetTracker ──────────────────────────────────────────────────

import {
  setMissionLimit,
  setProjectLimit,
  spend,
  getMissionBudget,
  getProjectBudget,
  isOverBudget,
  wouldExceedBudget,
  estimateMissionCostCents,
} from '../lib/agents/budgetTracker';

describe('budgetTracker', () => {
  it('tracks mission spend', () => {
    setMissionLimit('bt-m1', 100);
    spend('bt-m1', 'bt-p1', 50);
    expect(getMissionBudget('bt-m1').spentCents).toBe(50);
    expect(isOverBudget('bt-m1', 'bt-p1')).toBe(false);
    spend('bt-m1', 'bt-p1', 60);
    expect(isOverBudget('bt-m1', 'bt-p1')).toBe(true);
  });

  it('tracks project spend', () => {
    setProjectLimit('bt-p2', 200);
    spend('bt-m2', 'bt-p2', 100);
    expect(getProjectBudget('bt-p2').spentCents).toBe(100);
    expect(wouldExceedBudget('bt-m3', 'bt-p2', 150)).toBe(true);
    expect(wouldExceedBudget('bt-m3', 'bt-p2', 50)).toBe(false);
  });

  it('estimates mission cost', () => {
    expect(estimateMissionCostCents('gpt-4', 10)).toBe(10);
    expect(estimateMissionCostCents('gpt-4')).toBe(10);
    expect(estimateMissionCostCents('gpt-4', 0)).toBe(1);
  });
});

// ── autonomyMode ───────────────────────────────────────────────────

import {
  getEffectiveAutonomy,
  isSafeAction,
  isSensitiveAction,
  mapModeToApproval,
  SENSITIVE_ACTIONS,
} from '../lib/agents/autonomyMode';

describe('autonomyMode', () => {
  it('provides default autonomy config', () => {
    const config = getEffectiveAutonomy();
    expect(config.mode).toBe('supervised');
  });

  it('merges partial config', () => {
    const config = getEffectiveAutonomy({ mode: 'yolo', budgetLimit: 5000 });
    expect(config.mode).toBe('yolo');
    expect(config.budgetLimit).toBe(5000);
    expect(config.crossProjectPolicy).toBe('ask'); // default kept
  });

  it('classifies safe actions', () => {
    expect(isSafeAction('brain_query')).toBe(true);
    expect(isSafeAction('launch_mission')).toBe(false);
  });

  it('classifies sensitive actions', () => {
    expect(isSensitiveAction('launch_mission')).toBe(true);
    expect(isSensitiveAction('brain_query')).toBe(false);
  });

  it('maps modes to approval levels', () => {
    expect(mapModeToApproval('manual')).toBe('default');
    expect(mapModeToApproval('supervised')).toBe('acceptEdits');
    expect(mapModeToApproval('yolo')).toBe('full');
  });

  it('includes provision_service in sensitive actions', () => {
    expect(SENSITIVE_ACTIONS.has('provision_service')).toBe(true);
    expect(SENSITIVE_ACTIONS.has('teardown_service')).toBe(true);
  });
});

// ── customRules ────────────────────────────────────────────────────

import { parseRules, evaluateRule, type CustomRule } from '../lib/agents/customRules';

describe('customRules', () => {
  it('parses valid rules from JSON', () => {
    const json = JSON.stringify([
      { id: 'r1', condition: 'action=launch_mission', action: 'ask', message: 'Confirm launch' },
      { id: 'r2', condition: 'cost>500', action: 'deny' },
    ]);
    const rules = parseRules(json);
    expect(rules).toHaveLength(2);
    expect(rules[0].id).toBe('r1');
  });

  it('returns empty for invalid JSON', () => {
    expect(parseRules('not json')).toEqual([]);
    expect(parseRules('{}')).toEqual([]);
  });

  it('evaluates action= condition', () => {
    const rule: CustomRule = { id: 'r1', condition: 'action=launch_mission', action: 'ask' };
    expect(evaluateRule(rule, { actionType: 'launch_mission' })).toBe(true);
    expect(evaluateRule(rule, { actionType: 'brain_query' })).toBe(false);
  });

  it('evaluates cost> condition', () => {
    const rule: CustomRule = { id: 'r1', condition: 'cost>500', action: 'deny' };
    expect(evaluateRule(rule, { actionType: 'launch_mission', costEstimateCents: 600 })).toBe(true);
    expect(evaluateRule(rule, { actionType: 'launch_mission', costEstimateCents: 400 })).toBe(false);
  });

  it('evaluates project= condition', () => {
    const rule: CustomRule = { id: 'r1', condition: 'project=my-proj', action: 'deny' };
    expect(evaluateRule(rule, { actionType: 'x', projectId: 'my-proj' })).toBe(true);
    expect(evaluateRule(rule, { actionType: 'x', projectId: 'other' })).toBe(false);
  });

  it('evaluates AND conditions', () => {
    const rule: CustomRule = { id: 'r1', condition: 'action=launch_mission AND cost>500', action: 'ask' };
    expect(evaluateRule(rule, { actionType: 'launch_mission', costEstimateCents: 600 })).toBe(true);
    expect(evaluateRule(rule, { actionType: 'launch_mission', costEstimateCents: 400 })).toBe(false);
    expect(evaluateRule(rule, { actionType: 'brain_query', costEstimateCents: 600 })).toBe(false);
  });
});

// ── brainNotation ──────────────────────────────────────────────────

import {
  missionToOutcome,
  noteMissionOutcome,
  noteUserDecision,
  noteManagerDecision,
  noteDiagnosis,
  noteDecisionPattern,
  noteProvisioningRecipe,
  noteAgentTemplate,
  buildInsight,
} from '../lib/agents/brainNotation';
describe('brainNotation', () => {
  it('converts mission to outcome', () => {
    const mission = {
      id: 'm1', title: 'Test mission', status: 'done',
      agentName: 'Coder', model: 'gpt-4', agentTask: 'do stuff',
    } as Mission;
    const outcome = missionToOutcome(mission, 'proj-1');
    expect(outcome.missionId).toBe('m1');
    expect(outcome.projectId).toBe('proj-1');
    expect(outcome.status).toBe('done');
    expect(outcome.title).toBe('Test mission');
  });

  it('builds insight payload', () => {
    const insight = buildInsight('outcome.success', 'Title', 'Description');
    expect(insight.kind).toBe('outcome.success');
    expect(insight.title).toBe('Title');
    expect(insight.actionable).toBe(false); // success is not actionable
  });

  it('noteMissionOutcome does not throw', () => {
    const outcome: MissionOutcome = {
      missionId: 'm1', projectId: 'p1', title: 'Test', agentName: 'Coder',
      model: 'gpt-4', status: 'done', timestamp: Date.now(),
    };
    expect(() => noteMissionOutcome(outcome)).not.toThrow();
  });

  it('noteUserDecision does not throw', () => {
    expect(() => noteUserDecision('What?', 'Yes', { projectId: 'p1' })).not.toThrow();
  });

  it('noteManagerDecision does not throw', () => {
    expect(() => noteManagerDecision('launch_mission', 'needed', 'success')).not.toThrow();
  });

  it('noteDiagnosis does not throw', () => {
    expect(() => noteDiagnosis({ errorCategory: 'type_error', rootCause: 'missing type', suggestedFix: 'add type', confidence: 0.8 })).not.toThrow();
  });

  it('noteDecisionPattern does not throw', () => {
    const pattern: DecisionPattern = {
      id: 'p1', trigger: 'test', action: 'run', outcome: 'success',
      confidence: 0.8, occurrences: 3, lastSeen: Date.now(),
    };
    expect(() => noteDecisionPattern(pattern)).not.toThrow();
  });

  it('noteProvisioningRecipe does not throw', () => {
    expect(() => noteProvisioningRecipe('supabase-db', 'supabase', { tier: 'free' })).not.toThrow();
  });

  it('noteAgentTemplate does not throw', () => {
    const mission = { id: 'm1', title: 'Test', agentName: 'Coder' } as Mission;
    expect(() => noteAgentTemplate('tmpl1', { model: 'gpt-4' }, mission)).not.toThrow();
  });
});

// ── observationEngine ──────────────────────────────────────────────

import { observeMissionOutcome } from '../lib/agents/observationEngine';

describe('observationEngine', () => {
  it('observes a mission outcome without throwing', () => {
    const mission = {
      id: 'm1', title: 'Test', status: 'done',
      agentName: 'Coder', model: 'gpt-4', agentTask: 'do stuff',
      agentMetrics: { durationMs: 5000, costUsd: 0.5 },
    } as Mission;
    const outcome = observeMissionOutcome(mission, 'proj-1');
    expect(outcome.missionId).toBe('m1');
    expect(outcome.durationMs).toBe(5000);
    expect(outcome.costCents).toBe(50);
  });
});

// ── learningCapture ────────────────────────────────────────────────

import { capturePattern, mergePatterns, findHighConfidencePatterns } from '../lib/agents/learningCapture';

describe('learningCapture', () => {
  it('captures a pattern from an outcome', () => {
    const outcome: MissionOutcome = {
      missionId: 'm1', projectId: 'p1', title: 'Test', agentName: 'Coder',
      model: 'gpt-4', status: 'done', timestamp: Date.now(),
    };
    const pattern = capturePattern('status:done', 'Coder', outcome, 'p1', 'Coder');
    expect(pattern.trigger).toBe('status:done');
    expect(pattern.outcome).toBe('success');
    expect(pattern.occurrences).toBe(1);
    expect(pattern.confidence).toBe(0.5);
  });

  it('merges patterns with matching outcomes', () => {
    const outcome: MissionOutcome = {
      missionId: 'm1', projectId: 'p1', title: 'Test', agentName: 'Coder',
      model: 'gpt-4', status: 'done', timestamp: Date.now(),
    };
    const existing = [
      { id: 'p1', trigger: 't', action: 'a', outcome: 'success' as const, confidence: 0.5, occurrences: 2, lastSeen: Date.now() },
    ];
    const merged = mergePatterns(existing, outcome);
    expect(merged[0].occurrences).toBe(3);
    expect(merged[0].confidence).toBeGreaterThan(0.5);
  });

  it('finds high-confidence patterns', () => {
    const patterns = [
      { id: 'p1', trigger: 't', action: 'a', outcome: 'success' as const, confidence: 0.9, occurrences: 5, lastSeen: Date.now() },
      { id: 'p2', trigger: 't', action: 'a', outcome: 'failure' as const, confidence: 0.6, occurrences: 2, lastSeen: Date.now() },
    ];
    const high = findHighConfidencePatterns(patterns);
    expect(high).toHaveLength(1);
    expect(high[0].id).toBe('p1');
  });
});

// ── agentTemplates ─────────────────────────────────────────────────

import { recordTemplate, listAgentTemplates, findTemplate, templateFromMission, clearTemplates } from '../lib/agents/agentTemplates';

describe('agentTemplates', () => {
  beforeEach(() => clearTemplates());

  it('records and lists templates', () => {
    recordTemplate({ name: 'tmpl1', taskPattern: 'fix bugs', agentName: 'Coder' });
    expect(listAgentTemplates()).toHaveLength(1);
  });

  it('finds a template by name', () => {
    recordTemplate({ name: 'tmpl1', taskPattern: 'fix bugs' });
    expect(findTemplate('tmpl1')).toBeDefined();
    expect(findTemplate('nonexistent')).toBeUndefined();
  });

  it('creates template from mission', () => {
    const mission = { id: 'm1', title: 'Fix bug', agentName: 'Coder', agentTask: 'fix the bug', model: 'gpt-4' } as Mission;
    const tmpl = templateFromMission(mission);
    expect(tmpl.agentName).toBe('Coder');
    expect(tmpl.taskPattern).toBe('fix the bug');
    expect(tmpl.modelTier).toBe('gpt-4');
  });
});

// ── managerContext ─────────────────────────────────────────────────

import { buildFleetContext, buildBrainDrivenContext, formatAutonomyContext } from '../lib/agents/managerContext';

describe('managerContext', () => {
  beforeEach(() => {
    for (const p of getAllProjects()) unregisterProject(p.projectId);
    clearTemplates();
  });

  it('builds fleet context with no projects', () => {
    const ctx = buildFleetContext();
    expect(ctx).toContain('Fleet status');
    expect(ctx).toContain('0 project(s)');
  });

  it('builds fleet context with projects', () => {
    registerProject('a', '/a', 'Project A');
    const ctx = buildFleetContext();
    expect(ctx).toContain('Project A');
    expect(ctx).toContain('Global budget');
  });

  it('builds brain-driven context', () => {
    recordTemplate({ name: 'tmpl1', taskPattern: 'fix bugs' });
    const ctx = buildBrainDrivenContext('test query');
    expect(ctx).toContain('test query');
    expect(ctx).toContain('tmpl1');
  });

  it('formats autonomy context', () => {
    const ctx = formatAutonomyContext({ mode: 'yolo', budgetLimit: 5000 });
    expect(ctx).toContain('yolo');
  });
});
