import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlanStep } from '../lib/agents/types';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { runPlanAndActScripted } from '../lib/agents/planAndActScripted';

function opts(stop = false) {
  const actions: string[] = [];
  const steps: Array<{ i: number; state: string }> = [];
  return {
    actions,
    steps,
    input: {
      missionId: 'M1',
      missionTitle: 'Fix login',
      worktreePath: '/wt',
      steps: [] as PlanStep[],
      onStep: (i: number, state: PlanStep['state']) => { steps.push({ i, state }); },
      onAction: (e: { text: string }) => { actions.push(e.text); },
      onProgress: () => undefined,
      stopSignal: () => stop,
    },
  };
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockRejectedValue(new Error('no tauri'));
});

describe('runPlanAndActScripted', () => {
  it('stops before writing notes when stopSignal is already true', async () => {
    const { input, actions } = opts(true);
    await runPlanAndActScripted(input);
    expect(invoke).not.toHaveBeenCalled();
    expect(actions.some((a) => a.includes('LAZY_AGENT_NOTES'))).toBe(false);
  });

  it('writes LAZY_AGENT_NOTES.md when IPC is available', async () => {
    invoke.mockResolvedValue(undefined);
    const { input, actions } = opts(false);
    await runPlanAndActScripted(input);
    expect(invoke).toHaveBeenCalledWith('write_file', expect.objectContaining({
      path: '/wt/LAZY_AGENT_NOTES.md',
    }));
    expect(actions.some((a) => a.includes('LAZY_AGENT_NOTES.md'))).toBe(true);
  });
});
