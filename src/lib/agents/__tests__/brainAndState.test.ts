/* brainAndState.test.ts — Unit coverage for Brain Notation Engine and Orchestrator State persistence. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  noteMissionOutcome,
  noteUserDecision,
  noteManagerDecision,
  noteDiagnosis,
  noteDecisionPattern,
  noteProvisioningRecipe,
  noteAgentTemplate,
  missionToOutcome,
} from '../brainNotation';
import {
  createOrchestrator,
  getOrchestrator,
  updateOrchestrator,
  deleteOrchestrator,
  listOrchestrators,
} from '../orchestratorState';
import type { Mission, MissionOutcome, OrchestratorState } from '../types';

const captureMock = vi.fn().mockResolvedValue({ id: 'n1', path: '/mock', sizeBytes: 0, attrsCount: 0 });
const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const createDirMock = vi.fn();

vi.mock('../../platform', () => ({
  getPlatform: () => ({
    brain: { capture: captureMock },
    fs: {
      readFile: readFileMock,
      writeFile: writeFileMock,
      createDir: createDirMock,
    },
  }),
}));

function makeMission(status: Mission['status']): Mission {
  return {
    id: 'm1',
    title: 'Test mission',
    status,
    model: 'claude-sonnet',
    worktree: '',
    createdAt: Date.now(),
    progress: 0,
    planSteps: [],
    actionTimeline: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Realistic read_file rejection shape (matches Rust's std::io::Error
  // Display: always ends in the locale-independent "(os error N)" — see
  // lib/fsErrors.ts's isMissingFileReadError, which orchestratorState.ts
  // uses to treat this as "no orchestrators.json yet" rather than a real
  // failure worth a console.warn).
  readFileMock.mockRejectedValue(new Error('read_file: metadata failed: cannot find the file (os error 2)'));
  writeFileMock.mockResolvedValue(undefined);
  createDirMock.mockResolvedValue(undefined);
});

describe('brainNotation', () => {
  it('notes a mission outcome', () => {
    const outcome: MissionOutcome = {
      missionId: 'm1',
      projectId: 'p1',
      title: 'Test',
      model: 'claude-sonnet',
      status: 'done',
      timestamp: Date.now(),
    };
    noteMissionOutcome(outcome);
    expect(captureMock).toHaveBeenCalled();
    const event = captureMock.mock.calls[0][0];
    expect(event).toMatchObject({ kind: 'agent', source: 'lazy-ide:orchestrator' });
    expect(event.tags).toContain('outcome.success');
  });

  it('notes a user decision', () => {
    noteUserDecision('Approve mission m1?', 'approve', { missionId: 'm1' });
    expect(captureMock).toHaveBeenCalled();
    const event = captureMock.mock.calls[0][0];
    expect(event.tags).toContain('decision.user');
  });

  it('notes a manager decision', () => {
    noteManagerDecision('launch_mission', 'user asked for feature', 'success');
    expect(captureMock).toHaveBeenCalled();
    const event = captureMock.mock.calls[0][0];
    expect(event.tags).toContain('decision.manager');
  });

  it('notes a diagnosis', () => {
    noteDiagnosis({ errorCategory: 'type_error', rootCause: 'TS2345 in props', suggestedFix: 'add missing prop', confidence: 0.85 });
    expect(captureMock).toHaveBeenCalled();
    const event = captureMock.mock.calls[0][0];
    expect(event.tags).toContain('diagnosis');
  });

  it('notes a decision pattern', () => {
    noteDecisionPattern({
      id: 'pat-1',
      trigger: 'refactor auth',
      action: 'launch_mission',
      outcome: 'success',
      confidence: 0.8,
      occurrences: 1,
      lastSeen: Date.now(),
      projectId: 'p1',
    });
    expect(captureMock).toHaveBeenCalled();
    const event = captureMock.mock.calls[0][0];
    expect(event.tags).toContain('pattern');
  });

  it('notes a provisioning recipe', () => {
    noteProvisioningRecipe('supabase-db', 'supabase', { region: 'us-east-1' });
    expect(captureMock).toHaveBeenCalled();
    const event = captureMock.mock.calls[0][0];
    expect(event.tags).toContain('provisioning.recipe');
  });

  it('notes an agent template', () => {
    noteAgentTemplate('TestAgent', { role: 'tester' }, makeMission('done'));
    expect(captureMock).toHaveBeenCalled();
    const event = captureMock.mock.calls[0][0];
    expect(event.tags).toContain('agent.template');
  });

  it('converts a mission to an outcome', () => {
    const mission = makeMission('done');
    const outcome = missionToOutcome(mission, 'p1');
    expect(outcome.missionId).toBe('m1');
    expect(outcome.projectId).toBe('p1');
    expect(outcome.status).toBe('done');
  });
});

describe('orchestratorState', () => {
  it('creates and persists an orchestrator', async () => {
    const root = '/tmp/proj';
    const orch = await createOrchestrator({
      projectRoot: root,
      projectId: 'p1',
      name: 'Test plan',
      objective: 'Refactor auth',
      steps: [{ description: 'Extract service' }],
    });
    expect(orch.name).toBe('Test plan');
    expect(orch.steps).toHaveLength(1);
    expect(writeFileMock).toHaveBeenCalled();
    const savedPath = writeFileMock.mock.calls[0][0];
    expect(savedPath).toContain('orchestrators.json');
  });

  it('reads an existing orchestrator', async () => {
    const root = '/tmp/proj';
    const existing: OrchestratorState = {
      id: 'o1',
      name: 'Existing',
      projectId: 'p1',
      targetProjectIds: [],
      objective: 'x',
      steps: [],
      currentStep: 0,
      status: 'planning',
      budget: { spentCents: 0 },
      childMissionIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      autonomyLevel: 'supervised',
    };
    readFileMock.mockResolvedValue(JSON.stringify([existing]));
    const loaded = await getOrchestrator(root, 'o1');
    expect(loaded?.id).toBe('o1');
  });

  it('updates an orchestrator', async () => {
    const root = '/tmp/proj';
    readFileMock.mockResolvedValue(JSON.stringify([{ id: 'o1', name: 'Old', projectId: 'p1', targetProjectIds: [], objective: 'x', steps: [], currentStep: 0, status: 'planning', budget: { spentCents: 0 }, childMissionIds: [], createdAt: 0, updatedAt: 0, autonomyLevel: 'supervised' }]));
    const updated = await updateOrchestrator(root, 'o1', { name: 'Updated' });
    expect(updated).toBeTruthy();
    expect(updated?.name).toBe('Updated');
  });

  it('deletes an orchestrator', async () => {
    const root = '/tmp/proj';
    readFileMock.mockResolvedValue(JSON.stringify([{ id: 'o1', name: 'x', projectId: 'p1', targetProjectIds: [], objective: 'x', steps: [], currentStep: 0, status: 'planning', budget: { spentCents: 0 }, childMissionIds: [], createdAt: 0, updatedAt: 0, autonomyLevel: 'supervised' }]));
    const removed = await deleteOrchestrator(root, 'o1');
    expect(removed).toBe(true);
  });

  it('lists orchestrators', async () => {
    const root = '/tmp/proj';
    readFileMock.mockResolvedValue(JSON.stringify([{ id: 'o1', name: 'x', projectId: 'p1', targetProjectIds: [], objective: 'x', steps: [], currentStep: 0, status: 'planning', budget: { spentCents: 0 }, childMissionIds: [], createdAt: 0, updatedAt: 0, autonomyLevel: 'supervised' }]));
    const list = await listOrchestrators(root);
    expect(list).toHaveLength(1);
  });
});
