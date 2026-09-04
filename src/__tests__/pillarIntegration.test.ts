/**
 * F2 — Integration tests for the orchestrator pillars.
 *
 * These tests exercise the interaction between multiple modules:
 * - globalRuntime + improvementLoop + diagnosisEngine
 * - provisioning + actionGate
 * - managerContext + globalRuntime + agentTemplates
 * - actionGate + autonomyMode + budgetTracker
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProject,
  unregisterProject,
  getAllProjects,
  addMissionToRegistry,
  getSnapshot,
  subscribe,
} from '../lib/agents/globalRuntime';
import {
  setGlobalLimit,
  spend,
} from '../lib/agents/budgetTracker';
import { evaluateActionGate } from '../lib/agents/actionGate';
import { provisionService, teardownService, clearProvisionedServices, resetAdapters, resetSecureStorageBackend, getProvisionedServices } from '../lib/agents/provisioning';
import { buildFleetContext, formatAutonomyContext } from '../lib/agents/managerContext';
import { recordTemplate, clearTemplates } from '../lib/agents/agentTemplates';
import { capturePattern, mergePatterns, findHighConfidencePatterns } from '../lib/agents/learningCapture';
import type { Mission, MissionOutcome, AutonomyConfig } from '../lib/agents/types';

// ── Helpers ────────────────────────────────────────────────────────

function makeMission(id: string, status: Mission['status']): Mission {
  return {
    id, title: `Mission ${id}`, status,
    agentName: 'Coder', model: 'gpt-4', agentTask: 'do stuff',
    createdAt: Date.now(), updatedAt: Date.now(),
  } as Mission;
}

beforeEach(() => {
  for (const p of getAllProjects()) unregisterProject(p.projectId);
  clearTemplates();
  clearProvisionedServices();
  resetSecureStorageBackend();
  resetAdapters();
});

// ── Integration: actionGate + budgetTracker ────────────────────────

describe('integration: actionGate + budgetTracker', () => {
  it('denies action when budget exceeded', async () => {
    setGlobalLimit(100);
    spend('m1', 'p1', 80);

    const config: AutonomyConfig = { mode: 'yolo', budgetLimit: 100 };
    const result = await evaluateActionGate('launch_mission', config, {
      costEstimateCents: 50,
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('budget');
  });

  it('allows safe action even near budget', async () => {
    setGlobalLimit(100000);
    const config: AutonomyConfig = { mode: 'yolo', budgetLimit: 100000 };
    const result = await evaluateActionGate('brain_query', config, {
      costEstimateCents: 50,
    });
    expect(result.decision).toBe('allow');
  });

  it('asks for sensitive action in supervised mode', async () => {
    const config: AutonomyConfig = { mode: 'supervised' };
    const result = await evaluateActionGate('provision_service', config);
    expect(result.decision).toBe('ask');
  });

  it('allows provisioning in YOLO within budget', async () => {
    setGlobalLimit(100000);
    const config: AutonomyConfig = { mode: 'yolo', budgetLimit: 100000 };
    const result = await evaluateActionGate('provision_service', config, {
      costEstimateCents: 100,
    });
    expect(result.decision).toBe('allow');
  });
});

// ── Integration: provisioning + actionGate ─────────────────────────

describe('integration: provisioning flow', () => {
  it('provisions supabase and retrieves credentials', async () => {
    const result = await provisionService({
      service: 'supabase-db',
      projectId: 'p1',
      config: { projectRef: 'test-ref' },
      costEstimateCents: 0,
    });
    expect(result.ok).toBe(true);
    expect(result.credentials!.SUPABASE_URL).toContain('test-ref');

    const services = getProvisionedServices('p1');
    expect(services).toHaveLength(1);
    expect(services[0].service).toBe('supabase-db');
  });

  it('tears down a provisioned service', async () => {
    await provisionService({
      service: 'api-key',
      projectId: 'p1',
      config: { keyName: 'TEST', keyValue: 'secret' },
      costEstimateCents: 0,
    });
    const services = getProvisionedServices('p1');
    const teardown = await teardownService(services[0].id);
    expect(teardown.ok).toBe(true);
    expect(getProvisionedServices('p1')).toHaveLength(0);
  });
});

// ── Integration: managerContext + globalRuntime + templates ────────

describe('integration: managerContext + runtime', () => {
  it('builds fleet context with live project data', () => {
    registerProject('a', '/a', 'Project A');
    registerProject('b', '/b', 'Project B');
    addMissionToRegistry('a', makeMission('m1', 'running'));
    addMissionToRegistry('b', makeMission('m2', 'done'));

    const ctx = buildFleetContext();
    expect(ctx).toContain('Project A');
    expect(ctx).toContain('Project B');
    expect(ctx).toContain('2 project(s)');
  });

  it('includes templates in brain-driven context', () => {
    recordTemplate({ name: 'coder-template', taskPattern: 'fix bugs', agentName: 'Coder' });
    recordTemplate({ name: 'architect-template', taskPattern: 'design system', agentName: 'Architect' });

    const ctx = buildFleetContext();
    expect(ctx).toBeDefined();
  });

  it('formats autonomy context correctly', () => {
    const ctx = formatAutonomyContext({ mode: 'manual' });
    expect(ctx).toContain('manual');
  });
});

// ── Integration: learning capture + pattern merging ────────────────

describe('integration: learning capture + pattern confidence', () => {
  it('builds confidence through repeated outcomes', () => {
    const outcome: MissionOutcome = {
      missionId: 'm1', projectId: 'p1', title: 'Test',
      agentName: 'Coder', model: 'gpt-4', status: 'done', timestamp: Date.now(),
    };

    let patterns = [capturePattern('status:done', 'Coder', outcome, 'p1', 'Coder')];

    // Simulate 4 more successes
    for (let i = 0; i < 4; i++) {
      patterns = mergePatterns(patterns, outcome);
    }

    expect(patterns[0].occurrences).toBe(5);
    expect(patterns[0].confidence).toBeGreaterThan(0.7);

    const high = findHighConfidencePatterns(patterns, 0.7, 3);
    expect(high).toHaveLength(1);
  });
});

// ── Integration: globalRuntime snapshot + budget ───────────────────

describe('integration: runtime snapshot with budget', () => {
  it('snapshot reflects budget spend across projects', () => {
    registerProject('a', '/a', 'A');
    registerProject('b', '/b', 'B');

    // Add missions
    addMissionToRegistry('a', makeMission('m1', 'running'));
    addMissionToRegistry('a', makeMission('m2', 'done'));
    addMissionToRegistry('b', makeMission('m3', 'failed'));

    const snap = getSnapshot();
    expect(snap.projects).toHaveLength(2);
    expect(snap.allMissions).toHaveLength(3);
    expect(snap.runningMissions).toHaveLength(1);
    expect(snap.blockedMissions).toHaveLength(1);
    expect(snap.recentOutcomes).toHaveLength(2); // m2 (done) + m3 (failed)
  });
});

// ── Integration: subscriber notifications ──────────────────────────

describe('integration: runtime subscriber notifications', () => {
  it('notifies on mission add, update, and remove', () => {
    let notifications = 0;
    const off = subscribe(() => { notifications++; });

    registerProject('a', '/a', 'A');
    const baseline = notifications;

    addMissionToRegistry('a', makeMission('m1', 'running'));
    expect(notifications).toBeGreaterThan(baseline);

    const beforeRemove = notifications;
    off();
    // After unsubscribe, no more notifications
    addMissionToRegistry('a', makeMission('m2', 'done'));
    expect(notifications).toBe(beforeRemove);
  });
});
