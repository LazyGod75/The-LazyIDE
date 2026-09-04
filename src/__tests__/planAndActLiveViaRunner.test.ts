import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();
const runPlanAndActLive = vi.fn().mockResolvedValue(undefined);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock('../lib/agents/planAndActLiveSupport', () => ({
  runPlanAndActLive: (...args: unknown[]) => runPlanAndActLive(...args),
}));

import { runPlanAndActLiveViaRunner } from '../lib/agents/planAndActLiveViaRunner';
import type { PlanAndActLiveOpts } from '../lib/agents/planAndActLiveSupport';

function baseOpts(): PlanAndActLiveOpts {
  return {
    missionId: 'M1',
    missionTitle: 'Fix',
    worktreePath: '/wt',
    steps: [],
    onStep: vi.fn(),
    onAction: vi.fn(),
    onProgress: vi.fn(),
    stopSignal: () => false,
    tool: 'claude',
    model: 'sonnet',
  };
}

beforeEach(() => {
  invoke.mockReset();
  runPlanAndActLive.mockClear();
});

describe('runPlanAndActLiveViaRunner', () => {
  it('falls back to the native live path when the runner is down', async () => {
    invoke.mockRejectedValue(new Error('no runner'));
    const opts = baseOpts();
    await runPlanAndActLiveViaRunner(opts);
    expect(opts.onAction).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/indisponible|unavailable/i),
    }));
    expect(runPlanAndActLive).toHaveBeenCalledOnce();
  });
});
