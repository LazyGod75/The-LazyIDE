import { describe, it, expect, vi } from 'vitest';
import type { Mission } from '../lib/agents/types';
import { compileLaunchArtifacts, announceMissionRunning } from '../lib/agents/runMissionPrepare';

vi.mock('../lib/platform', () => ({
  getPlatform: () => ({
    brain: { recall: vi.fn().mockRejectedValue(new Error('no brain')) },
  }),
}));

vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn(),
}));

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'M1',
    title: 'Fix login',
    status: 'queued',
    ...overrides,
  } as Mission;
}

describe('runMissionPrepare', () => {
  it('compiles a plan and timeline without brain recall', () => {
    const prep = compileLaunchArtifacts({
      mission: mission(),
      brainRecall: null,
    });
    expect(prep.compiled.graph).toBeDefined();
    expect(prep.initialSteps.length).toBeGreaterThan(0);
    expect(prep.initialTimeline[0]?.text).toMatch(/Mission démarrée/);
    expect(prep.compiled.brainAdapted).toBe(false);
    expect(prep.brainContext.citations).toEqual([]);
  });

  it('flips the mission to running with the compiled plan', () => {
    const prep = compileLaunchArtifacts({ mission: mission(), brainRecall: null });
    const updates: Array<{ status?: string }> = [];
    announceMissionRunning({
      mission: mission(),
      projectId: 'p1',
      prep,
      onUpdate: (u) => updates.push(u.patch),
    });
    expect(updates[0]?.status).toBe('running');
  });
});
