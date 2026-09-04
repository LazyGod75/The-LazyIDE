/* graph/__tests__/graphRunStore.test.ts — item 6 (2026-08-15 audit, D7 fix)
   acceptance tests: GraphRun is now actually persisted to disk, and a run
   left in a "was actively executing" status is reconciled to an honest
   'interrupted' state instead of reading as a phantom running graph after
   a restart. See graphRunStore.ts's own header comment for the full defect
   writeup and documented scope.
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { saveGraphRun, loadGraphRun, listGraphRuns, reconcilePhantomGraphRuns } from '../graphRunStore';
import type { GraphRun } from '../types';

const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const createDirMock = vi.fn();
const readDirMock = vi.fn();

vi.mock('../../../platform', () => ({
  getPlatform: () => ({
    fs: {
      readFile: readFileMock,
      writeFile: writeFileMock,
      createDir: createDirMock,
      readDir: readDirMock,
    },
  }),
}));

function makeRun(overrides?: Partial<GraphRun>): GraphRun {
  return {
    runId: 'run-1',
    graphId: 'g1',
    graphVersion: 1,
    status: 'running',
    nodeRuns: {},
    nodeOutputs: {},
    budget: { spentUsd: 0 },
    replanCount: 0,
    checkpoints: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('graphRunStore — saveGraphRun/loadGraphRun (item 6, D7 fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists the FULL GraphRun (nodeOutputs included) to a run-scoped file, not just a lossy projection', async () => {
    const run = makeRun({ nodeOutputs: { a: { text: 'result of node a' } } });
    await saveGraphRun('/proj', run);

    expect(writeFileMock).toHaveBeenCalled();
    const [path, content] = writeFileMock.mock.calls[0];
    expect(path).toContain('graph-runs');
    expect(path).toContain('run-1');
    const written = JSON.parse(content);
    expect(written.nodeOutputs).toEqual({ a: { text: 'result of node a' } });
    expect(written.status).toBe('running');
  });

  it('loads a persisted run back by id', async () => {
    const run = makeRun({ status: 'done' });
    readFileMock.mockResolvedValue(JSON.stringify(run));

    const loaded = await loadGraphRun('/proj', 'run-1');
    expect(loaded?.runId).toBe('run-1');
    expect(loaded?.status).toBe('done');
  });

  it('a save failure never throws — best-effort, same convention as orchestratorState.ts', async () => {
    writeFileMock.mockRejectedValue(new Error('disk full'));
    await expect(saveGraphRun('/proj', makeRun())).resolves.toBeUndefined();
  });

  it('loadGraphRun returns undefined (never throws) when the file is missing', async () => {
    readFileMock.mockRejectedValue(new Error('No such file'));
    const loaded = await loadGraphRun('/proj', 'missing-run');
    expect(loaded).toBeUndefined();
  });
});

describe('graphRunStore — listGraphRuns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns [] when the graph-runs directory has never been created', async () => {
    readDirMock.mockRejectedValue(new Error('No such file or directory'));
    const runs = await listGraphRuns('/proj');
    expect(runs).toEqual([]);
  });

  it('lists every persisted run, skipping an unreadable file rather than failing the whole listing', async () => {
    readDirMock.mockResolvedValue([
      { name: 'run-1.json', path: '/proj/.lazy/graph-runs/run-1.json', isDir: false },
      { name: 'run-2.json', path: '/proj/.lazy/graph-runs/run-2.json', isDir: false },
      { name: 'notes.txt', path: '/proj/.lazy/graph-runs/notes.txt', isDir: false },
    ]);
    readFileMock.mockImplementation(async (path: string) => {
      if (path.includes('run-1')) return JSON.stringify(makeRun({ runId: 'run-1' }));
      throw new Error('corrupt');
    });

    const runs = await listGraphRuns('/proj');
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe('run-1');
  });
});

describe('graphRunStore — reconcilePhantomGraphRuns (D7 fix, "no phantom running graph after a restart")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rewrites a run stuck in "running" to "interrupted" and persists the fix', async () => {
    readDirMock.mockResolvedValue([{ name: 'run-1.json', path: '/proj/.lazy/graph-runs/run-1.json', isDir: false }]);
    readFileMock.mockResolvedValue(JSON.stringify(makeRun({ runId: 'run-1', status: 'running' })));

    const reconciled = await reconcilePhantomGraphRuns('/proj');

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].status).toBe('interrupted');
    expect(writeFileMock).toHaveBeenCalled();
    const written = JSON.parse(writeFileMock.mock.calls[0][1]);
    expect(written.status).toBe('interrupted');
  });

  it('also reconciles a "paused" run — the in-memory pause registry is lost on restart too', async () => {
    readDirMock.mockResolvedValue([{ name: 'run-1.json', path: '/proj/.lazy/graph-runs/run-1.json', isDir: false }]);
    readFileMock.mockResolvedValue(JSON.stringify(makeRun({ runId: 'run-1', status: 'paused' })));

    const reconciled = await reconcilePhantomGraphRuns('/proj');
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].status).toBe('interrupted');
  });

  it('leaves a genuinely terminal run (done/failed/cancelled) and an already-interrupted run untouched', async () => {
    readDirMock.mockResolvedValue([
      { name: 'run-done.json', path: '/proj/.lazy/graph-runs/run-done.json', isDir: false },
      { name: 'run-interrupted.json', path: '/proj/.lazy/graph-runs/run-interrupted.json', isDir: false },
    ]);
    readFileMock.mockImplementation(async (path: string) => {
      if (path.includes('run-done')) return JSON.stringify(makeRun({ runId: 'run-done', status: 'done' }));
      return JSON.stringify(makeRun({ runId: 'run-interrupted', status: 'interrupted' }));
    });

    const reconciled = await reconcilePhantomGraphRuns('/proj');
    expect(reconciled).toEqual([]);
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});
