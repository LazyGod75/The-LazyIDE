/**
 * planAndActLivePause.test.ts — B22 native CLI stop/pause mid-turn.
 *
 * Pause is stop-then-resume: agent_run_kill, capture session_id from done,
 * wait on pauseSignal, then a new agent_run with --resume.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { runPlanAndActLive, type PlanAndActLiveOpts } from '../lib/agents/planAndActLiveSupport';

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    brain: {
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      startupContext: vi.fn().mockResolvedValue(''),
    },
  })),
}));

vi.mock('../lib/brain/context', () => ({
  normalizeRecall: vi.fn((r: unknown) => r),
  buildPromptBrainContext: vi.fn(() => ''),
}));

vi.mock('../lib/brain/federatedRecall.js', () => ({
  federatedRecall: vi.fn().mockResolvedValue({ hits: [], projects: [] }),
  buildCrossProjectContext: vi.fn(() => ''),
}));

vi.mock('../lib/agents/harnessRules.js', () => ({
  loadHarnessSessionBlock: vi.fn().mockResolvedValue(''),
}));

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedListen = listen as ReturnType<typeof vi.fn>;

function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) w['__TAURI_INTERNALS__'] = {};
  else delete w['__TAURI_INTERNALS__'];
}

function baseOpts(overrides: Partial<PlanAndActLiveOpts> = {}): PlanAndActLiveOpts {
  return {
    missionId: 'M42',
    missionTitle: 'Pause test',
    worktreePath: 'C:\\repo\\.lazy\\worktrees\\M42',
    steps: [],
    onStep: vi.fn(),
    onAction: vi.fn(),
    onProgress: vi.fn(),
    stopSignal: () => false,
    pauseSignal: () => false,
    tool: 'claude',
    model: 'sonnet',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setTauriRuntime(true);
});

afterEach(() => {
  setTauriRuntime(false);
});

describe('runPlanAndActLive — native pause/resume', () => {
  it('kills the CLI on pause, waits, then resumes with session_id', async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    mockedListen.mockImplementation((eventName: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(eventName, handler);
      return Promise.resolve(() => { handlers.delete(eventName); });
    });

    let paused = false;
    let runCount = 0;
    const onPaused = vi.fn(() => {
      paused = false;
    });

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'agent_run_kill') return Promise.resolve(undefined);
      if (cmd !== 'agent_run') return Promise.resolve(undefined);

      runCount += 1;
      const req = args?.req as { id: string; session_id?: string } | undefined;
      const id = req?.id ?? 'M42';

      if (runCount === 1) {
        expect(req?.session_id).toBeUndefined();
        paused = true;
        queueMicrotask(() => {
          handlers.get(`agent://done/${id}`)?.({
            payload: {
              result: 'interrupted',
              exit_code: 130,
              session_id: 'sess-pause-1',
            },
          });
        });
        return Promise.resolve(undefined);
      }

      expect(req?.session_id).toBe('sess-pause-1');
      queueMicrotask(() => {
        handlers.get(`agent://done/${id}`)?.({
          payload: { result: 'done', exit_code: 0, session_id: 'sess-pause-1' },
        });
      });
      return Promise.resolve(undefined);
    });

    const opts = baseOpts({
      pauseSignal: () => paused,
      onPaused,
    });

    await runPlanAndActLive(opts);

    expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === 'agent_run_kill')).toBe(true);
    expect(onPaused).toHaveBeenCalledWith('sess-pause-1');
    expect(runCount).toBe(2);
    expect(opts.onAction).toHaveBeenCalled();
  });

  it('honours stopSignal over pause (no resume pass)', async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    mockedListen.mockImplementation((eventName: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(eventName, handler);
      return Promise.resolve(() => { handlers.delete(eventName); });
    });

    let stopped = false;
    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'agent_run_kill') {
        stopped = true;
        return Promise.resolve(undefined);
      }
      if (cmd !== 'agent_run') return Promise.resolve(undefined);
      const req = args?.req as { id: string } | undefined;
      queueMicrotask(() => {
        handlers.get(`agent://done/${req?.id}`)?.({
          payload: { result: 'killed', exit_code: 130, session_id: 'sess-x' },
        });
      });
      return Promise.resolve(undefined);
    });

    const opts = baseOpts({
      stopSignal: () => stopped,
      pauseSignal: () => true,
    });

    await runPlanAndActLive(opts);

    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'agent_run')).toHaveLength(1);
  });
});
