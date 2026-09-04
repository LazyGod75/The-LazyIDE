/**
 * forkFromCheckpoint.test.ts — the checkpoint-fork module had zero test
 * coverage and zero UI entry point before this branch (see
 * MissionDetailCheckpoints.tsx / agentsStore.tsx's forkMissionFromCheckpoint).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadCheckpoint = vi.fn();
const mockWriteCheckpoint = vi.fn();
vi.mock('../checkpointStore', () => ({
  readCheckpoint: (...args: unknown[]) => mockReadCheckpoint(...args),
  writeCheckpoint: (...args: unknown[]) => mockWriteCheckpoint(...args),
}));

const mockNoteFork = vi.fn();
vi.mock('../brainBus', () => ({
  noteFork: (...args: unknown[]) => mockNoteFork(...args),
}));

import { forkFromCheckpoint } from '../forkFromCheckpoint';
import type { GraphIR } from '../types';
import { defaultGraphDefaults } from '../types';

function baseIr(overrides: Partial<GraphIR> = {}): GraphIR {
  return {
    id: 'mission-m1',
    version: 1,
    name: 'Test mission',
    objective: 'Test mission',
    projectId: 'proj-1',
    defaults: defaultGraphDefaults(),
    nodes: [],
    edges: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: 'fork',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('forkFromCheckpoint', () => {
  it('creates a new run and writes a fork checkpoint referencing the parent', async () => {
    mockReadCheckpoint.mockResolvedValue({
      checkpoint: { id: 'cp-1', runId: 'm1', engine: 'managed', stateRef: 'cp-1.json', summary: { turn: 2 }, createdAt: 1000 },
      data: { messages: [], turn: 2, toolCallCount: 1, proofCount: 0, missionStatus: 'running', costUsd: 0.4 },
    });
    mockWriteCheckpoint.mockResolvedValue({ id: 'cp-fork-1', runId: 'run-new', engine: 'managed', stateRef: 'cp-fork-1.json', summary: { turn: 2 }, createdAt: 2000 });

    const ir = baseIr();
    const result = await forkFromCheckpoint('/repo', 'm1', 'cp-1', ir);

    expect(mockReadCheckpoint).toHaveBeenCalledWith('/repo', 'm1', 'cp-1');
    expect(result.forkCheckpointId).toBe('cp-fork-1');
    expect(result.newRunId).toBe(result.newGraphRun.runId);
    expect(result.newGraphRun.checkpoints).toContain('cp-fork-1');

    // writeCheckpoint called against the NEW run id, never the source run.
    const [projectRoot, newRunId, data, opts] = mockWriteCheckpoint.mock.calls[0];
    expect(projectRoot).toBe('/repo');
    expect(newRunId).toBe(result.newRunId);
    expect(newRunId).not.toBe('m1');
    expect(data).toEqual({ messages: [], turn: 2, toolCallCount: 1, proofCount: 0, missionStatus: 'running', costUsd: 0.4 });
    expect(opts).toMatchObject({ parentCheckpointId: 'cp-1' });
  });

  it('never mutates the source run: the fork is a brand-new run id', async () => {
    mockReadCheckpoint.mockResolvedValue({
      checkpoint: { id: 'cp-1', runId: 'm1', engine: 'managed', stateRef: 'cp-1.json', summary: { turn: 0 }, createdAt: 1000 },
      data: { messages: [], turn: 0, toolCallCount: 0, proofCount: 0, missionStatus: 'running' },
    });
    mockWriteCheckpoint.mockResolvedValue({ id: 'cp-fork-2', runId: 'run-new', engine: 'managed', stateRef: 'cp-fork-2.json', summary: { turn: 0 }, createdAt: 2000 });

    const result = await forkFromCheckpoint('/repo', 'm1', 'cp-1', baseIr());

    expect(result.newRunId).not.toBe('m1');
    expect(result.newGraphRun.runId).toBe(result.newRunId);
  });

  it('marks the checkpointed node done in the new run when the checkpoint carries a nodeId', async () => {
    mockReadCheckpoint.mockResolvedValue({
      checkpoint: { id: 'cp-1', runId: 'run-src', nodeId: 's1', engine: 'graph', stateRef: 'cp-1.json', summary: { turn: 1 }, createdAt: 1000 },
      data: { messages: [], turn: 1, toolCallCount: 0, proofCount: 0, missionStatus: 'done', costUsd: 1.2 },
    });
    mockWriteCheckpoint.mockResolvedValue({ id: 'cp-fork-3', runId: 'run-new', engine: 'graph', stateRef: 'cp-fork-3.json', summary: { turn: 1 }, createdAt: 2000 });

    const ir = baseIr({
      nodes: [
        {
          id: 's1',
          kind: 'task',
          label: 'Step 1',
          description: 'Step 1',
          brain: { recall: false, capture: false },
          contract: {},
        } as unknown as GraphIR['nodes'][number],
      ],
    });

    const result = await forkFromCheckpoint('/repo', 'run-src', 'cp-1', ir);

    expect(result.newGraphRun.nodeRuns.s1.status).toBe('done');
    expect(result.newGraphRun.nodeRuns.s1.costUsd).toBe(1.2);
  });

  it('writes a Brain note about the fork via noteFork', async () => {
    mockReadCheckpoint.mockResolvedValue({
      checkpoint: { id: 'cp-1', runId: 'm1', missionId: 'm1', engine: 'managed', stateRef: 'cp-1.json', summary: { turn: 0 }, createdAt: 1000 },
      data: { messages: [], turn: 0, toolCallCount: 0, proofCount: 0, missionStatus: 'running' },
    });
    mockWriteCheckpoint.mockResolvedValue({ id: 'cp-fork-4', runId: 'run-new', engine: 'managed', stateRef: 'cp-fork-4.json', summary: { turn: 0 }, createdAt: 2000 });

    const result = await forkFromCheckpoint('/repo', 'm1', 'cp-1', baseIr());

    expect(mockNoteFork).toHaveBeenCalledWith({
      projectRoot: '/repo',
      parentCheckpointId: 'cp-1',
      newRunId: result.newRunId,
    });
  });
});
