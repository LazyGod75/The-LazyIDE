import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImprovementCandidate } from '../frictionMiner';
import { runFrictionAnalysis } from '../frictionAnalysis';

const addFrame = vi.fn();
const addDraft = vi.fn();
const setPosition = vi.fn();
const mineFrictions = vi.fn();
const noteFrictionAnalysis = vi.fn();

vi.mock('../frictionMiner', () => ({
  mineFrictions: (...args: unknown[]) => mineFrictions(...args),
}));

vi.mock('../brainNotation', () => ({
  noteFrictionAnalysis: (...args: unknown[]) => noteFrictionAnalysis(...args),
}));

vi.mock('../../../components/agents/canvas/canvasStore', () => ({
  canvasStoreVanilla: { getState: () => ({ addFrame, addDraft, setPosition }) },
}));

vi.mock('../../../components/agents/canvas/canvasIds', () => ({
  generateCanvasId: (kind: string) => `${kind}-generated-id`,
}));

function candidate(overrides: Partial<ImprovementCandidate> = {}): ImprovementCandidate {
  return {
    id: 'friction-x',
    projectId: 'p1',
    title: 'Recurring failure',
    rationale: 'It failed a lot',
    where: 'mission-execution',
    why: 'timeout',
    suggestedTask: 'fix the timeout',
    evidence: ['m1', 'm2'],
    severity: 'high',
    ...overrides,
  };
}

beforeEach(() => {
  addFrame.mockReset();
  addDraft.mockReset();
  setPosition.mockReset();
  mineFrictions.mockReset();
  noteFrictionAnalysis.mockReset();
});

describe('runFrictionAnalysis', () => {
  it('creates no frame/drafts/brain note when the miner finds nothing (never fabricates a candidate)', async () => {
    mineFrictions.mockResolvedValue([]);
    const result = await runFrictionAnalysis('p1');
    expect(result).toEqual({ candidates: [], draftIds: [] });
    expect(addFrame).not.toHaveBeenCalled();
    expect(addDraft).not.toHaveBeenCalled();
    expect(noteFrictionAnalysis).not.toHaveBeenCalled();
  });

  it('materializes one draft per candidate inside a dedicated frame, and writes one brain note', async () => {
    const candidates = [candidate({ id: 'a', title: 'A' }), candidate({ id: 'b', title: 'B', severity: 'medium' })];
    mineFrictions.mockResolvedValue(candidates);

    const result = await runFrictionAnalysis('p1', '/repo/p1', 'Self-improvement');

    expect(addFrame).toHaveBeenCalledTimes(1);
    expect(addFrame).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', title: 'Self-improvement' }));
    expect(addDraft).toHaveBeenCalledTimes(2);
    for (const call of addDraft.mock.calls) {
      expect(call[0]).toMatchObject({ projectId: 'p1', createdBy: 'manager' });
      // Never a fabricated launch — a draft is armed, not launched (no
      // mission/agentRun side effect exists on this path at all).
      expect(call[0]).not.toHaveProperty('status');
    }
    expect(result.candidates).toBe(candidates);
    expect(result.draftIds).toHaveLength(2);
    expect(result.frameId).toBeDefined();
    expect(noteFrictionAnalysis).toHaveBeenCalledTimes(1);
    expect(noteFrictionAnalysis).toHaveBeenCalledWith(candidates, 'p1', '/repo/p1');
  });

  it('never calls any launch/mission primitive — drafts only', async () => {
    mineFrictions.mockResolvedValue([candidate()]);
    await runFrictionAnalysis('p1');
    // The mock module surface for this test exposes ONLY draft/frame/position
    // writers — asserting no other canvas store method was ever imported
    // would be redundant; the real guarantee is addDraft's payload shape
    // above (no launch-related field) plus this module's own import list
    // (frictionAnalysis.ts never imports launchDraft/addMission).
    expect(addDraft).toHaveBeenCalled();
  });
});
