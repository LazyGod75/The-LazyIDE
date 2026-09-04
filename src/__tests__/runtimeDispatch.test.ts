/**
 * Tests for the planAndAct routing table (mode -> engine) in runtime.ts.
 *
 * Bug being regression-tested: isManagedAgentAvailable() used to also return
 * true for 'claude-code', and was checked BEFORE isLiveAgentAvailable() in
 * planAndAct, so real claude-code missions were silently routed onto the
 * managed (ai-proxy) ReAct loop in managedAgent.ts instead of the native
 * agent_run loop (planAndActLive). Separately, 'pro' / 'live-key' / 'mock' on
 * the Tauri desktop runtime used to silently fall through to the scripted
 * placeholder loop (which fakes success by writing LAZY_AGENT_NOTES.md)
 * instead of failing the mission explicitly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { invoke } from '@tauri-apps/api/core';

// ── Mock getProviderMode so each test controls the active mode directly ───
vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProviderMode: vi.fn(),
  };
});

// ── Mock the managed agent loop — routing tests only need proof it was (or
// wasn't) called; its internals are already covered by managedAgent.test.ts.
vi.mock('../lib/agents/managedAgent', () => ({
  planAndActManaged: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock platform (brain recall) — required by planAndActLive ─────────────
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

import {
  planAndAct,
  isManagedAgentAvailable,
  isLiveAgentAvailable,
} from '../lib/agents/runtime';
import type { PlanStep } from '../lib/agents/types';
import type { ProviderMode } from '../lib/models/index';
import { getProviderMode } from '../lib/models/index';
import { planAndActManaged } from '../lib/agents/managedAgent';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedGetProviderMode = getProviderMode as ReturnType<typeof vi.fn>;
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
});

afterEach(() => {
  setTauriRuntime(false);
});

// ── Pure gating helpers: the exact functions the original bug lived in ────

describe('isManagedAgentAvailable / isLiveAgentAvailable routing table', () => {
  const cases: Array<{ mode: ProviderMode; managed: boolean; live: boolean }> = [
    { mode: 'claude-code', managed: false, live: true },
    { mode: 'codex', managed: false, live: true },
    { mode: 'managed', managed: true, live: false },
    { mode: 'pro', managed: false, live: false },
    { mode: 'live-key', managed: false, live: false },
    { mode: 'mock', managed: false, live: false },
  ];

  for (const { mode, managed, live } of cases) {
    it(`mode="${mode}" (Tauri) -> managed=${managed}, live=${live}`, () => {
      mockedGetProviderMode.mockReturnValue(mode);
      expect(isManagedAgentAvailable()).toBe(managed);
      expect(isLiveAgentAvailable()).toBe(live);
    });
  }

  it('every mode is false for both helpers outside the Tauri runtime', () => {
    setTauriRuntime(false);
    for (const { mode } of cases) {
      mockedGetProviderMode.mockReturnValue(mode);
      expect(isManagedAgentAvailable()).toBe(false);
      expect(isLiveAgentAvailable()).toBe(false);
    }
  });

  it('claude-code and managed are mutually exclusive (regression for the original bug)', () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    // The bug: isManagedAgentAvailable() used to ALSO return true here, and
    // was checked before isLiveAgentAvailable() in planAndAct, so claude-code
    // missions silently ran on the managed ReAct loop instead of the native one.
    expect(isManagedAgentAvailable()).toBe(false);
    expect(isLiveAgentAvailable()).toBe(true);
  });
});

// ── planAndAct dispatcher: end-to-end routing per mode ─────────────────────

describe('planAndAct dispatcher', () => {
  it('claude-code routes to the native live loop (invokes agent_run, not managedAgent)', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    // stopSignal=true lets planAndActLive's wait loop resolve immediately
    // (agent_run_kill) instead of hanging on the mocked listen() that never
    // fires its done/error handlers — the routing proof (invoke('agent_run'))
    // already happened earlier in the same synchronous-until-first-await run.
    const opts = makeOpts({ tool: 'claude', model: 'haiku', stopSignal: vi.fn(() => true) });

    await planAndAct(opts);

    expect(mockedInvoke).toHaveBeenCalledWith(
      'agent_run',
      expect.objectContaining({
        req: expect.objectContaining({ id: 'test-mission-1', tool: 'claude' }),
      }),
    );
    expect(mockedPlanAndActManaged).not.toHaveBeenCalled();
  });

  it('codex routes to the native live loop (unchanged)', async () => {
    mockedGetProviderMode.mockReturnValue('codex');
    const opts = makeOpts({ tool: 'codex', model: 'haiku', stopSignal: vi.fn(() => true) });

    await planAndAct(opts);

    expect(mockedInvoke).toHaveBeenCalledWith(
      'agent_run',
      expect.objectContaining({
        req: expect.objectContaining({ id: 'test-mission-1', tool: 'codex' }),
      }),
    );
    expect(mockedPlanAndActManaged).not.toHaveBeenCalled();
  });

  it('managed routes to planAndActManaged, unchanged', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    const opts = makeOpts({ managedModel: 'openrouter/some-model' });

    await planAndAct(opts);

    expect(mockedPlanAndActManaged).toHaveBeenCalledTimes(1);
    expect(mockedPlanAndActManaged).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'openrouter/some-model' }),
    );
    expect(mockedInvoke).not.toHaveBeenCalledWith('agent_run', expect.anything());
  });

  it.each(['pro', 'live-key', 'mock'] as const)(
    'mode="%s" on the desktop runtime fails explicitly instead of faking success',
    async (mode) => {
      mockedGetProviderMode.mockReturnValue(mode);
      const opts = makeOpts();

      await planAndAct(opts);

      expect(mockedPlanAndActManaged).not.toHaveBeenCalled();
      expect(mockedInvoke).not.toHaveBeenCalledWith('agent_run', expect.anything());
      expect(mockedInvoke).not.toHaveBeenCalledWith('write_file', expect.anything());

      expect(opts.onAction).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Erreur agent:') }),
      );
      expect(opts.onProgress).toHaveBeenCalledWith(100);
    },
  );

  it('mode="mock" outside the Tauri runtime (web demo) keeps the scripted placeholder loop', async () => {
    vi.useFakeTimers();
    try {
      setTauriRuntime(false);
      mockedGetProviderMode.mockReturnValue('mock');
      const opts = makeOpts();

      const pending = planAndAct(opts);
      await vi.runAllTimersAsync();
      await pending;

      // planAndActScripted writes the placeholder notes file — the only
      // surface where that is legitimate (no Tauri IPC backend exists there).
      expect(mockedInvoke).toHaveBeenCalledWith(
        'write_file',
        expect.objectContaining({ path: expect.stringContaining('LAZY_AGENT_NOTES.md') }),
      );
      expect(opts.onProgress).toHaveBeenCalledWith(100);
    } finally {
      vi.useRealTimers();
    }
  });
});
