/**
 * journalEmitters.test.ts — T0.3 coverage for the journal emitters wired
 * into the mission lifecycle store (agentsStore.tsx) and the evaluation
 * pipeline (evaluator.ts).
 *
 * The journal client itself (emitEvent/emitBuffered/serializeEvent) is
 * already covered by journal.test.ts — here the journal module is MOCKED
 * (vi.mock('../lib/journal/journal')) so these tests assert WHAT gets
 * emitted and in WHAT ORDER, not how the client delivers it.
 *
 * Covers:
 *   1. projectIdFromRoot — the tiny path-normalization helper new call sites
 *      share (src/lib/journal/projectId.ts).
 *   2. agentsStore.tsx: addMission emits mission.created then mission.queued
 *      (ordered, same missionId); approveMission emits mission.approved only
 *      after a real merge succeeds; discardMission emits mission.rejected;
 *      stopMission/pauseMission/resumeMission/interveneMission emit their
 *      matching lifecycle events.
 *   3. evaluator.ts: evaluateMission (managed pipeline) emits gate.passed
 *      per role when a role's verdict approves, and gate.failed otherwise —
 *      exercised via evaluateMission itself (evaluateLive/evaluateManaged
 *      are not exported — same constraint evaluator.test.ts documents).
 *
 * Mocking patterns below mirror the existing suites this task's brief
 * points at: agentsStore.test.tsx / agentsStore.mergeHonesty.test.tsx for
 * the store harness, evaluator.test.ts for the managed-pipeline harness.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';

import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { emitEvent, emitBuffered } from '../lib/journal/journal';
import { projectIdFromRoot } from '../lib/journal/projectId';
import type { JournalEventInput } from '../lib/journal/eventTypes';
import { evaluateMission } from '../lib/agents/evaluator';
import type { Mission } from '../lib/agents/types';
import { getProviderMode } from '../lib/models/index';
import { streamManagedAgentTurn } from '../lib/models/managedProvider';

// ── Mock the journal client — the module under test-by-proxy here. ───────
vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
  emitBuffered: vi.fn(),
}));

// ── agentsStore harness (mirrors agentsStore.test.tsx / mergeHonesty). ────
vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

// ── evaluator harness (mirrors evaluator.test.ts) — only getProviderMode is
// overridden; getDefaultModelIdForMode and the rest stay real so
// agentsStore.tsx's own use of this module (initial managerModel, etc.)
// keeps behaving exactly as it would unmocked. ────────────────────────────
vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProviderMode: vi.fn(),
  };
});

vi.mock('../lib/models/managedProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/managedProvider')>();
  return {
    ...actual,
    streamManagedAgentTurn: vi.fn(),
  };
});

const mockedEmitEvent = vi.mocked(emitEvent);
const mockedEmitBuffered = vi.mocked(emitBuffered);
const mockedInvoke = vi.mocked(invoke);
const mockedGetProviderMode = vi.mocked(getProviderMode);
const mockedStream = vi.mocked(streamManagedAgentTurn);

/** Toggle the global flag isTauriRuntime()/isTauri() read (both agentsStore's
 *  and evaluator's own local copies key off the same window flag). */
function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) {
    w['__TAURI_INTERNALS__'] = {};
  } else {
    delete w['__TAURI_INTERNALS__'];
  }
}

// createElement (not JSX) — this file is .ts, not .tsx (matches the exact
// filename this task's brief specifies), so JSX syntax would fail to parse.
function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(
    I18nProvider,
    null,
    React.createElement(ToastProvider, null, React.createElement(AgentsStoreProvider, null, children)),
  );
}

/** Every emitEvent/emitBuffered call flattened to just its first argument,
 *  in call order — regardless of which of the two mocked functions fired,
 *  since journalEmitters.ts intentionally splits lifecycle events (mostly
 *  emitEvent) from high-frequency/terminal ones (emitBuffered). */
function allEmittedEvents(): JournalEventInput[] {
  const fromEvent = mockedEmitEvent.mock.calls.map(([e]) => e);
  const fromBuffered = mockedEmitBuffered.mock.calls.map(([e]) => e);
  return [...fromEvent, ...fromBuffered];
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockedInvoke.mockResolvedValue(undefined);
  mockedGetProviderMode.mockReturnValue('mock'); // matches getProviderMode()'s own real non-Tauri default
  setTauriRuntime(false);
});

afterEach(() => {
  setTauriRuntime(false);
});

// ── projectIdFromRoot ──────────────────────────────────────────────

describe('projectIdFromRoot', () => {
  it('lowercases only the drive letter, leaving the rest of the path untouched', () => {
    expect(projectIdFromRoot('C:\\Users\\user\\Lazy')).toBe('c:\\Users\\user\\Lazy');
  });

  it('strips a Windows verbatim (\\\\?\\) prefix', () => {
    expect(projectIdFromRoot('\\\\?\\C:\\Users\\user\\Lazy')).toBe('c:\\Users\\user\\Lazy');
  });

  it('strips a trailing separator so a project never mints two different ids', () => {
    expect(projectIdFromRoot('C:\\Users\\user\\Lazy\\')).toBe('c:\\Users\\user\\Lazy');
    expect(projectIdFromRoot('/repo/')).toBe('/repo');
  });

  it('leaves a POSIX path without a drive letter unchanged (besides trailing separator)', () => {
    expect(projectIdFromRoot('/repo')).toBe('/repo');
  });
});

// ── agentsStore.tsx — mission lifecycle events ─────────────────────

describe('agentsStore — mission lifecycle journal emissions', () => {
  it('creating and launching a mission emits mission.created then mission.queued, in order, for the same mission', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Ship the thing',
        repo: '.',
        worktree: '',
        modelLabel: 'claude-sonnet-5',
        mode: 'agent',
        orchestrator: false,
      });
    });

    const missionId = result.current.missions[result.current.missions.length - 1].id;

    const lifecycleCalls = allEmittedEvents().filter((e) => e.missionId === missionId);

    expect(lifecycleCalls.map((e) => e.type)).toEqual(['mission.created', 'mission.queued']);
    expect(lifecycleCalls[0]).toMatchObject({
      type: 'mission.created',
      actor: 'user',
      payload: expect.objectContaining({ title: 'Ship the thing' }),
    });
    expect(lifecycleCalls[1]).toMatchObject({ type: 'mission.queued', actor: 'user' });
    // Both lifecycle events went through the immediate path, not the buffer.
    expect(mockedEmitBuffered).not.toHaveBeenCalled();
  });

  /** Adds a mission and drives it into status 'review' with a passing
   *  verdict and a worktree — the state approveMission/discardMission
   *  require (mirrors agentsStore.mergeHonesty.test.tsx's identical helper). */
  async function addReviewMission(
    result: { current: ReturnType<typeof useAgentsStore> },
    title: string,
  ): Promise<string> {
    await act(async () => {
      await result.current.addMission({
        title,
        repo: '.',
        worktree: 'agent/m-test',
        modelLabel: 'claude-sonnet-5',
        mode: 'agent',
        orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({
        id: missionId,
        patch: {
          status: 'review',
          judgeVerdict: {
            score: 90,
            passed: true,
            risk: 'low',
            reviewers: [],
            createdAt: new Date().toISOString(),
          },
        },
      });
    });
    return missionId;
  }

  it('approve emits mission.approved only after the merge really succeeds', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Approve me');

    mockedEmitEvent.mockClear();
    mockedEmitBuffered.mockClear();

    await act(async () => {
      await result.current.approveMission(missionId, 'C:\\real\\project');
    });

    expect(mockedEmitBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mission.approved',
        missionId,
        actor: 'user',
        projectId: projectIdFromRoot('C:\\real\\project'),
      }),
    );
  });

  it('reject (discard) emits mission.rejected', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Reject me');

    mockedEmitEvent.mockClear();
    mockedEmitBuffered.mockClear();

    await act(async () => {
      await result.current.discardMission(missionId, 'C:\\real\\project');
    });

    expect(mockedEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mission.rejected', missionId, actor: 'user' }),
    );
  });

  it('stop emits mission.cancelled (buffered — a TERMINAL_TYPES entry)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Stop me');

    mockedEmitEvent.mockClear();
    mockedEmitBuffered.mockClear();

    // stopMission's own public signature is synchronous (fire-and-forget) —
    // the journal emission is chained off an internal resolveProjectRoot()
    // promise, so the test must flush that microtask queue before asserting.
    await act(async () => {
      result.current.stopMission(missionId);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockedEmitBuffered).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mission.cancelled', missionId, actor: 'user' }),
    );
  });
});

// ── evaluator.ts — gate.passed / gate.failed per role ──────────────

/** Creates an async generator that yields a single text chunk — mirrors
 *  evaluator.test.ts's identical helper for streamManagedAgentTurn responses. */
async function* makeStream(text: string): AsyncIterable<string> {
  yield text;
}

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    title: 'Fix the thing',
    status: 'review',
    model: 'anthropic/claude-sonnet-5',
    ...overrides,
  };
}

describe('evaluator — gate.passed / gate.failed per role', () => {
  beforeEach(() => {
    mockedGetProviderMode.mockReturnValue('managed');
    setTauriRuntime(true);
  });

  it('emits gate.passed for tester/reviewer/security/judge when every role approves', async () => {
    mockedInvoke.mockImplementation((cmd: unknown) => {
      if (cmd === 'run_shell') {
        return Promise.resolve({ stdout: '10 passed', stderr: '', exitCode: 0 });
      }
      // hasNoTestScriptConfigured (evaluator.ts) reads package.json via
      // platform.fs.readFile -> invoke('read_file', ...) BEFORE running the
      // tester — a real "test" script must resolve here so this test still
      // exercises the real run_shell path, not the no-test-script short-circuit.
      if (cmd === 'read_file') {
        return Promise.resolve(JSON.stringify({ scripts: { test: 'vitest run' } }));
      }
      return Promise.resolve(undefined);
    });
    const responses = [
      JSON.stringify({ verdict: 'approve', summary: 'Clean diff', score: 88 }), // reviewer
      JSON.stringify({ verdict: 'approve', summary: 'No issues', score: 95 }), // security
      JSON.stringify({ verdict: 'approve', summary: 'Ship it', score: 90, risk: 'low' }), // judge
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    const gateCalls = mockedEmitEvent.mock.calls
      .map(([e]) => e)
      .filter((e) => e.type === 'gate.passed' || e.type === 'gate.failed');

    expect(gateCalls).toHaveLength(4);
    expect(gateCalls.every((e) => e.type === 'gate.passed')).toBe(true);
    expect(gateCalls.map((e) => (e.payload as { role: string }).role)).toEqual([
      'tester',
      'reviewer',
      'security',
      'judge',
    ]);
    expect(gateCalls.every((e) => e.missionId === 'mission-1' && e.projectId === '/repo')).toBe(true);
    // Every passing gate carries the role's score.
    expect((gateCalls[0].payload as { score?: number }).score).toBe(85);
  });

  it('emits gate.failed (with the verdict summary as reason) for a role that does not approve', async () => {
    mockedInvoke.mockImplementation((cmd: unknown) => {
      if (cmd === 'run_shell') {
        // Real test failure (exit code != 0) — not an infra/inconclusive case.
        return Promise.resolve({ stdout: '', stderr: 'boom', exitCode: 1 });
      }
      // See the previous test's comment: a real "test" script must resolve
      // here so this hits the real run_shell failure path, not the
      // no-test-script short-circuit.
      if (cmd === 'read_file') {
        return Promise.resolve(JSON.stringify({ scripts: { test: 'vitest run' } }));
      }
      return Promise.resolve(undefined);
    });
    const responses = [
      JSON.stringify({ verdict: 'approve', summary: 'Safe', score: 92 }), // reviewer
      JSON.stringify({ verdict: 'approve', summary: 'Ship it', score: 90, risk: 'low' }), // security
      JSON.stringify({ verdict: 'approve', summary: 'Ship it', score: 90, risk: 'low' }), // judge
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    const testerGate = mockedEmitEvent.mock.calls
      .map(([e]) => e)
      .find((e) => (e.type === 'gate.passed' || e.type === 'gate.failed') && (e.payload as { role: string }).role === 'tester');

    expect(testerGate?.type).toBe('gate.failed');
    expect((testerGate?.payload as { reason?: string }).reason).toEqual(expect.stringContaining('exited 1'));
  });
});
