/**
 * Tests for planAndAct's PER-MISSION model-based routing (routing-by-chosen-
 * model): a managed/OpenRouter id (contains '/') must route to the managed
 * ReAct loop with the id forwarded UNMANGLED, regardless of provider; a
 * native Claude id/label (no '/') must route to the native agent_run loop;
 * and a mismatch between the chosen model's engine family and what's
 * actually ready (Pro inactive/out of credits, or no CLI detected) must fail
 * the mission early with a clear reason instead of silently running on the
 * wrong engine. See runtime.ts's classifyMissionModel / isManagedModelReady
 * / isNativeModelReady / planAndAct for the implementation this covers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { invoke } from '@tauri-apps/api/core';

// ── Mock getProviderMode only — every other export (hasManagedCreditsActive,
// getProPlanState, isCliBackendAvailable, setManagedAvailability,
// setProPlanActive) stays REAL so this file can drive the mode-INDEPENDENT
// readiness signals the new routing actually uses, independent of whatever
// accessMode getProviderMode() would otherwise resolve to. ─────────────────
vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProviderMode: vi.fn(() => 'mock' as const),
  };
});

// ── Mock the managed agent loop — routing tests only need proof it was (or
// wasn't) called, and with which model id; internals are already covered by
// managedAgent.test.ts. ─────────────────────────────────────────────────────
vi.mock('../lib/agents/managedAgent', () => ({
  planAndActManaged: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock platform (brain recall) — required by planAndActLive/runMission ──
vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    brain: {
      recall: vi.fn().mockResolvedValue({
        injectedContext: '',
        nodes: [],
        tokensInjected: 0,
        tokensSaved: 0,
      }),
      capture: vi.fn().mockResolvedValue(undefined),
      startupContext: vi.fn().mockResolvedValue(''),
    },
  })),
}));

vi.mock('../lib/brain/context', () => ({
  normalizeRecall: vi.fn((r: unknown) => r),
  buildPromptBrainContext: vi.fn(() => ''),
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

import { planAndAct, classifyMissionModel } from '../lib/agents/runtime';
import type { PlanStep } from '../lib/agents/types';
import { setManagedAvailability, setProPlanActive } from '../lib/models/index';
import { planAndActManaged } from '../lib/agents/managedAgent';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedPlanAndActManaged = planAndActManaged as ReturnType<typeof vi.fn>;

/** Toggle the global flag that isTauriRuntime() reads. */
function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) {
    w['__TAURI_INTERNALS__'] = {};
  } else {
    delete w['__TAURI_INTERNALS__'];
  }
}

function makeSteps(): PlanStep[] {
  return [
    { label: 'Initialisation', state: 'todo' as const },
    { label: 'Analyse', state: 'todo' as const },
    { label: 'Implémentation', state: 'todo' as const },
    { label: 'Tests', state: 'todo' as const },
    { label: 'Diff', state: 'todo' as const },
  ];
}

function makeOpts(overrides: Partial<Parameters<typeof planAndAct>[0]> = {}) {
  return {
    missionId: 'test-mission-1',
    missionTitle: 'Test task',
    worktreePath: '/tmp/wt/test',
    steps: makeSteps(),
    onStep: vi.fn(),
    onAction: vi.fn(),
    onProgress: vi.fn(),
    stopSignal: vi.fn(() => false),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedInvoke.mockResolvedValue(undefined);
  setTauriRuntime(true);
  // Cold-start default (_managedActive=false) — tests that need managed
  // ready call setManagedAvailability(true) themselves.
  setManagedAvailability(false);
});

afterEach(() => {
  setTauriRuntime(false);
});

describe('classifyMissionModel', () => {
  it('classifies an OpenRouter id (any provider) as managed', () => {
    expect(classifyMissionModel('openai/gpt-5.5')).toBe('managed');
    expect(classifyMissionModel('anthropic/claude-sonnet-5')).toBe('managed');
    expect(classifyMissionModel('google/gemini-3.5-flash')).toBe('managed');
    expect(classifyMissionModel('x-ai/grok-4.3')).toBe('managed');
    expect(classifyMissionModel('deepseek/deepseek-v4-flash')).toBe('managed');
    expect(classifyMissionModel('meta-llama/llama-4-maverick')).toBe('managed');
  });

  it('classifies a native Claude id/label as native', () => {
    expect(classifyMissionModel('claude-sonnet-5')).toBe('native');
    expect(classifyMissionModel('Claude Sonnet 5')).toBe('native');
  });

  it('BYOK wave: a BYOK catalog id with its key set routes to byok', () => {
    localStorage.setItem('lazy.apikey.deepseek', 'sk-test');
    expect(classifyMissionModel('deepseek-chat')).toBe('byok');
    expect(classifyMissionModel('deepseek-reasoner')).toBe('byok');
    // groq catalog id with no key stays native (no silent byok)
    expect(classifyMissionModel('llama-4-maverick')).toBe('native');
  });

  it('BYOK wave: a BYOK catalog id WITHOUT a key stays native (no silent byok)', () => {
    localStorage.removeItem('lazy.apikey.deepseek');
    expect(classifyMissionModel('deepseek-chat')).toBe('native');
  });

  it('returns undefined for an absent/empty model (callers fall back to mode-based routing)', () => {
    expect(classifyMissionModel(undefined)).toBeUndefined();
    expect(classifyMissionModel('')).toBeUndefined();
  });
});

describe('planAndAct — routing by chosen model', () => {
  it('a managed id (openai/gpt-5.5) routes to the managed loop with the id forwarded unmangled', async () => {
    setManagedAvailability(true);
    const opts = makeOpts({ managedModel: 'openai/gpt-5.5' });

    await planAndAct(opts);

    expect(mockedPlanAndActManaged).toHaveBeenCalledTimes(1);
    expect(mockedPlanAndActManaged).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'openai/gpt-5.5' }),
    );
    expect(mockedInvoke).not.toHaveBeenCalledWith('agent_run', expect.anything());
  });

  it('a native id (claude-sonnet-5) routes to the native live loop', async () => {
    // stopSignal=true lets planAndActLive's wait loop resolve immediately
    // (agent_run_kill) instead of hanging on the mocked listen() (setup.ts)
    // that never fires its done/error handlers — the routing proof
    // (invoke('agent_run')) already happened earlier in the same
    // synchronous-until-first-await run, same technique as
    // runtimeDispatch.test.ts.
    const opts = makeOpts({
      managedModel: 'claude-sonnet-5',
      tool: 'claude',
      model: 'sonnet',
      stopSignal: vi.fn(() => true),
    });

    await planAndAct(opts);

    expect(mockedInvoke).toHaveBeenCalledWith(
      'agent_run',
      expect.objectContaining({
        req: expect.objectContaining({ id: 'test-mission-1', tool: 'claude' }),
      }),
    );
    expect(mockedPlanAndActManaged).not.toHaveBeenCalled();
  });

  it('a managed id with Pro inactive fails early with a clear reason instead of a silent wrong-model run', async () => {
    setManagedAvailability(false);
    // Settle the cold-start 'unknown' plan state to a confirmed 'inactive' —
    // isManagedModelReady() treats 'unknown' as optimistically ready, so the
    // mismatch only triggers once the plan state is genuinely settled.
    setProPlanActive(false);
    const opts = makeOpts({ managedModel: 'openai/gpt-5.5' });

    await planAndAct(opts);

    expect(mockedPlanAndActManaged).not.toHaveBeenCalled();
    expect(mockedInvoke).not.toHaveBeenCalledWith('agent_run', expect.anything());
    expect(opts.onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringMatching(/^Erreur agent:.*LazyPro/),
      }),
    );
    expect(opts.onProgress).toHaveBeenCalledWith(100);
    // Every plan step is marked as errored, same terminal shape as the
    // pre-existing planAndActUnavailable path.
    expect(opts.onStep).toHaveBeenCalledTimes(5);
  });
});
