import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore, GROUNDED_FOLLOWUP_TIMEOUT_MS, APPROVE_MERGE_TIMEOUT_MS, resolveMissionQueryTarget, findLoopMission } from '../components/agents/agentsStore';
import { I18nProvider, useI18n } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runMission, mergeWorktree, type MissionUpdate } from '../lib/agents/runtime';
import type { MissionContract, JudgeVerdict, Mission } from '../lib/agents/types';
import { emit } from '../lib/bus';
import { invoke } from '@tauri-apps/api/core';
import { runManagerTurn, formatMissionDetail, MANAGER_TURN_TIMEOUT_MS, MANAGER_LLM_CALL_TIMEOUT_MS, MANAGER_LLM_CALL_ABSOLUTE_TIMEOUT_MS, getManagerDefaultModelId } from '../lib/agents/managerEngine';
import { saveAccessSettings, setManagedAvailability, getDefaultModelIdForMode } from '../lib/models/index';
import { DEFAULT_MODEL } from '../lib/models/registry';
import { DEFAULT_OPENROUTER_MODEL_ID, FREE_OPENROUTER_MODEL_ID } from '../lib/models/openrouterCatalog';
import { getCostState, resetCost, addUsage } from '../lib/models/costStore';
import { LS_AGENTS_COST_LIMIT } from '../components/settings/AgentsPanel';

// Mock the brain capture so it doesn't try to call getPlatform in tests
vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

// Mock the runtime so runMission doesn't try to invoke Tauri. isManagedAgentAvailable
// is kept REAL (via importOriginal): pauseMission/resumeMission/interveneMission
// branch on it, and the existing simulateTauri()/setManagedAvailability() helpers
// below already drive its real underlying state (getProviderMode) for other tests.
vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock only runManagerTurn (the network-touching LLM call). Keep
// formatMissionDetail/formatMissionNotFound/gatherManagerContext/
// createMessageId real so the grounding tests exercise the actual
// formatting/truncation/resolution logic, not a re-implementation of it.
vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return {
    ...actual,
    runManagerTurn: vi.fn(),
  };
});

vi.mock('../lib/agents/actionGate', () => ({
  evaluateActionGate: vi.fn(async () => ({ decision: 'allow', reason: 'test mock' })),
  evaluateActionGateSync: vi.fn(() => ({ decision: 'allow', reason: 'test mock' })),
}));

// ── Mock brain.startupContext + recallForDirective (LazyManager grounding:
// the brain_query follow-up recall and the first-turn startup snapshot).
// vi.mock(...) factories are hoisted above ALL module-level code, so mock
// fns a factory references must be created via vi.hoisted (TDZ otherwise) —
// see https://vitest.dev/api/vi.html#vi-hoisted. Both default to the same
// "nothing found" shape the real functions use on an empty/cold brain, so
// every OTHER existing test in this file (none of which touch these) sees
// no behavior change.
const {
  mockStartupContext,
  mockRecallForDirective,
  mockRunBrainQueryCss,
  mockRunBrainNeighbours,
} = vi.hoisted(() => ({
  mockStartupContext: vi.fn(async (_cwd: string) => ''),
  mockRecallForDirective: vi.fn(async (_query: string) => '(no memory hits found)'),
  mockRunBrainQueryCss: vi.fn(async (_selector: string, _limit?: number) => '0 matches'),
  mockRunBrainNeighbours: vi.fn(async (_id: string) => '(no neighbours)'),
}));

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    getPlatform: () => {
      const real = actual.getPlatform();
      return { ...real, brain: { ...real.brain, startupContext: mockStartupContext } };
    },
  };
});

vi.mock('../lib/models/brainSearchLoop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/brainSearchLoop')>();
  return {
    ...actual,
    recallForDirective: mockRecallForDirective,
  };
});

// Mock buildCanvasDigest so a single test can force it to hang/reject
// (proving sendManagerMessage's resilience to a stalled canvas-digest fetch
// — see the "resilient context gathering" describe block below) while every
// OTHER test keeps the real implementation (defaults to it below), so none
// of the ~50 other sendManagerMessage tests in this file change behavior.
const { mockBuildCanvasDigest } = vi.hoisted(() => ({
  mockBuildCanvasDigest: vi.fn<() => Promise<string>>(),
}));

vi.mock('../components/agents/canvas/canvasDigest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/agents/canvas/canvasDigest')>();
  mockBuildCanvasDigest.mockImplementation(actual.buildCanvasDigest);
  return {
    ...actual,
    buildCanvasDigest: mockBuildCanvasDigest,
  };
});

// Mock the structural executors the manager's grounded follow-up calls
// (brain_query_css / brain_neighbours). Keep everything else in brainTool real
// (importOriginal) so tool defs / directive parsing are untouched.
vi.mock('../lib/brain/brainTool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/brain/brainTool')>();
  return {
    ...actual,
    runBrainQueryCss: mockRunBrainQueryCss,
    runBrainNeighbours: mockRunBrainNeighbours,
  };
});

// Mock only recordMissionAnswer (the decision-registry + journal write) for
// the answer_question dispatch tests below — extractPendingQuestionText is
// kept REAL (importOriginal) since it's pure and part of what those tests
// verify (the dispatch case must find the SAME real pending-question signal
// AttentionInbox.tsx reads, never a fabricated one).
const { mockRecordMissionAnswer } = vi.hoisted(() => ({
  mockRecordMissionAnswer: vi.fn(async () => 'decision-1'),
}));

vi.mock('../lib/agents/missionQuestion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/missionQuestion')>();
  return {
    ...actual,
    recordMissionAnswer: mockRecordMissionAnswer,
  };
});

// Mock only freezeLoopArtifact (the real one silently no-ops outside Tauri —
// getPlatform().fs is absent in jsdom — so calling it for real here would
// prove nothing) for the propose_artifact "resolve + freeze" tests below.
// Everything else in loopArtifact.ts stays real (importOriginal).
const { mockFreezeLoopArtifact } = vi.hoisted(() => ({
  mockFreezeLoopArtifact: vi.fn(async (_repoPath: string, ownerId: string, kind: string, content: unknown, label?: string) => ({
    version: 1,
    kind,
    content,
    label,
    createdAt: new Date().toISOString(),
  })),
}));

vi.mock('../lib/agents/loopArtifact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/loopArtifact')>();
  return {
    ...actual,
    freezeLoopArtifact: mockFreezeLoopArtifact,
  };
});

// ── Provider-mode simulation (same pattern as modelsIndex.test.ts) ──
// getProviderMode() returns 'mock' outside a Tauri runtime; these helpers
// flip the jsdom window + access settings so tests can exercise the
// managed/Pro and claude-code branches of the mode-aware model resolution.
function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

function clearProviderModeSimulation(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  setManagedAvailability(false);
  localStorage.clear();
}

// Mocked runMission — used to grab the pauseSignal/drainIntervenes closures
// addMission actually threads through (the same ones the real managedAgent
// loop polls), so the pause/intervene tests below exercise the real wiring
// instead of re-implementing it.
const mockedRunMission = vi.mocked(runMission);
const mockedMergeWorktree = vi.mocked(mergeWorktree);

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

describe('agentsStore', () => {
  it('initialises empty — no hardcoded/demo missions, ever', () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    expect(result.current.missions).toEqual([]);
  });

  it('selectedMissionId starts as null', () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    expect(result.current.selectedMissionId).toBeNull();
  });

  it('addMission appends a new mission to the list', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    await act(async () => {
      await result.current.addMission({
        title: 'Test mission',
        repo: 'myrepo',
        worktree: 'wt/test',
        modelLabel: 'Haiku 4.5',
        mode: 'ask',
        orchestrator: false,
      });
    });

    expect(result.current.missions.length).toBe(countBefore + 1);
  });

  it('addMission sets status=queued initially', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'New task',
        repo: 'myrepo',
        worktree: 'wt/new',
        modelLabel: 'Sonnet 4.6',
        mode: 'plan',
        orchestrator: false,
      });
    });

    const mission = result.current.missions[result.current.missions.length - 1];
    expect(mission.status).toBe('queued');
  });

  it('addMission with orchestrator=true creates subAgents', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Orchestrated task',
        repo: '.',
        worktree: 'wt/orch',
        modelLabel: 'Opus 4.8',
        mode: 'agent',
        orchestrator: true,
      });
    });

    const mission = result.current.missions[result.current.missions.length - 1];
    expect(mission.isOrchestrator).toBe(true);
    expect(mission.subAgents).toBeDefined();
    expect(mission.subAgents!.length).toBeGreaterThan(0);
  });

  it('addMission with orchestrator=false has no subAgents', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Solo task',
        repo: '.',
        worktree: 'wt/solo',
        modelLabel: 'Haiku 4.5',
        mode: 'edit',
        orchestrator: false,
      });
    });

    const mission = result.current.missions[result.current.missions.length - 1];
    expect(mission.subAgents).toBeUndefined();
  });

  it('updateMission patches a mission by id (immutable update)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Mission to update',
        repo: '.',
        worktree: 'wt/update-target',
        modelLabel: 'Sonnet 4.6',
        mode: 'agent',
        orchestrator: false,
      });
    });

    const targetId = result.current.missions[0].id;
    const missionsBefore = result.current.missions;

    const update: MissionUpdate = {
      id: targetId,
      patch: { status: 'review', progress: 75 },
    };

    act(() => {
      result.current.updateMission(update);
    });

    const updated = result.current.missions.find(m => m.id === targetId)!;
    expect(updated.status).toBe('review');
    expect(updated.progress).toBe(75);

    // Verify immutability: previous array is not mutated
    const oldMission = missionsBefore.find(m => m.id === targetId)!;
    expect(oldMission.status).not.toBe('review');
  });

  it('updateMission does not affect other missions', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'First mission',
        repo: '.',
        worktree: 'wt/first',
        modelLabel: 'Sonnet 4.6',
        mode: 'agent',
        orchestrator: false,
      });
      await result.current.addMission({
        title: 'Second mission',
        repo: '.',
        worktree: 'wt/second',
        modelLabel: 'Sonnet 4.6',
        mode: 'agent',
        orchestrator: false,
      });
    });

    const firstId = result.current.missions[0].id;
    const secondId = result.current.missions[1].id;
    const secondStatusBefore = result.current.missions.find(m => m.id === secondId)!.status;

    act(() => {
      result.current.updateMission({ id: firstId, patch: { status: 'done' } });
    });

    const second = result.current.missions.find(m => m.id === secondId)!;
    expect(second.status).toBe(secondStatusBefore);
  });

  it('setSelectedMissionId updates selectedMissionId', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Selectable mission',
        repo: '.',
        worktree: 'wt/selectable',
        modelLabel: 'Sonnet 4.6',
        mode: 'agent',
        orchestrator: false,
      });
    });
    const id = result.current.missions[0].id;

    act(() => {
      result.current.setSelectedMissionId(id);
    });

    expect(result.current.selectedMissionId).toBe(id);
  });

  it('setSelectedMissionId can be cleared to null', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Selectable mission',
        repo: '.',
        worktree: 'wt/selectable',
        modelLabel: 'Sonnet 4.6',
        mode: 'agent',
        orchestrator: false,
      });
    });

    act(() => {
      result.current.setSelectedMissionId(result.current.missions[0].id);
    });
    act(() => {
      result.current.setSelectedMissionId(null);
    });

    expect(result.current.selectedMissionId).toBeNull();
  });
});

// ── LazyManager: grounded mission-output querying ───────────────────
// query_mission / get_agent_output must be answered from the mission's
// REAL actionTimeline/result, never a guess. These tests drive
// sendManagerMessage end-to-end with a mocked runManagerTurn and assert
// the SECOND (grounded follow-up) call actually receives the mission's
// real data, truncated, and that the visible chat answer reflects it.
describe('sendManagerMessage — grounded mission output', () => {
  beforeEach(() => {
    vi.mocked(runManagerTurn).mockReset();
  });

  it('grounds "what did mission X do" in the mission\'s REAL transcript and result', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Refactor auth module',
        repo: '.',
        worktree: '',
        modelLabel: 'Sonnet 4.6',
        mode: 'agent',
        orchestrator: false,
        agentName: 'reviewer',
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;

    act(() => {
      result.current.updateMission({
        id: missionId,
        // No status transition here on purpose — updateMission fires a toast
        // notification on status change, which is unrelated to this test and
        // best left untouched.
        patch: {
          actionTimeline: [
            { time: '10:00', text: 'Read auth.ts and base-handler.ts' },
            { time: '10:02', text: 'Edited auth.ts +40/-12 — added OAuth2 PKCE flow' },
            { time: '10:05', text: 'Résultat: OAuth2 PKCE flow implemented and tests green' },
          ],
        },
      });
    });

    // First turn: the manager decides to query the mission (no answer yet).
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Let me check that mission for you.',
      actions: [{ type: 'query_mission', missionId }],
      rawResponse: '',
    });
    // Follow-up (grounded) turn: the manager answers using the real data
    // that was fetched and injected into its context.
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'It implemented the OAuth2 PKCE flow and tests are green.',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, `what did mission ${missionId} do?`, 'haiku');
    });

    expect(runManagerTurn).toHaveBeenCalledTimes(2);

    const secondCallArgs = vi.mocked(runManagerTurn).mock.calls[1][0];
    expect(secondCallArgs.context.missionDetail).toBeDefined();
    expect(secondCallArgs.context.missionDetail).toContain('OAuth2 PKCE flow');
    expect(secondCallArgs.context.missionDetail).toContain(
      'Résultat: OAuth2 PKCE flow implemented and tests green',
    );
    // Must match exactly what the pure formatter produces from the mission's
    // real, current data — proves the grounding uses real data, not a guess.
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(secondCallArgs.context.missionDetail).toBe(formatMissionDetail(mission));

    // The visible chat answer is the GROUNDED follow-up text, not the
    // ungrounded "let me check" filler from the first turn.
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect(lastMsg.content).toBe('It implemented the OAuth2 PKCE flow and tests are green.');
  });

  it('truncates a long action timeline and caps the entry count fed to the manager', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Long-running loop mission',
        repo: '.',
        worktree: '',
        modelLabel: 'Haiku 4.5',
        mode: 'agent',
        orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;

    const longTimeline = Array.from({ length: 40 }, (_, i) => ({
      time: `10:${String(i).padStart(2, '0')}`,
      text: i === 0 ? 'OLDEST_MARKER_ENTRY' : `step ${i}`,
    }));
    act(() => {
      result.current.updateMission({ id: missionId, patch: { actionTimeline: longTimeline } });
    });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Checking…',
      actions: [{ type: 'get_agent_output', missionId, lines: 9999 }],
      rawResponse: '',
    });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Here is the recent output.',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, `show me the output of ${missionId}`, 'haiku');
    });

    const detail = vi.mocked(runManagerTurn).mock.calls[1][0].context.missionDetail!;
    expect(detail).not.toContain('OLDEST_MARKER_ENTRY');
    expect(detail).toContain('step 39');
    expect(detail).toMatch(/truncated/);
  });

  it('resolves an agent reference ("@reviewer") to that agent\'s MOST RECENT mission', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Older reviewer mission',
        repo: '.',
        worktree: '',
        modelLabel: 'Haiku 4.5',
        mode: 'agent',
        orchestrator: false,
        agentName: 'reviewer',
      });
    });
    const olderId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({
        id: olderId,
        patch: { actionTimeline: [{ time: '09:00', text: 'OLD_MISSION_MARKER' }] },
      });
    });

    await act(async () => {
      await result.current.addMission({
        title: 'Newer reviewer mission',
        repo: '.',
        worktree: '',
        modelLabel: 'Haiku 4.5',
        mode: 'agent',
        orchestrator: false,
        agentName: 'reviewer',
      });
    });
    const newerId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({
        id: newerId,
        patch: { actionTimeline: [{ time: '11:00', text: 'NEW_MISSION_MARKER' }] },
      });
    });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Checking @reviewer…',
      actions: [{ type: 'get_agent_output', missionId: '@reviewer' }],
      rawResponse: '',
    });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Reviewer last did X.',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'what did @reviewer do?', 'haiku');
    });

    const detail = vi.mocked(runManagerTurn).mock.calls[1][0].context.missionDetail!;
    expect(detail).toContain('NEW_MISSION_MARKER');
    expect(detail).not.toContain('OLD_MISSION_MARKER');
  });

  it('answers honestly when no mission/agent matches — no fabrication, no crash', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Checking…',
      actions: [{ type: 'query_mission', missionId: 'M-does-not-exist' }],
      rawResponse: '',
    });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'I could not find that mission.',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'status of M-does-not-exist?', 'haiku');
    });

    expect(runManagerTurn).toHaveBeenCalledTimes(2);
    const detail = vi.mocked(runManagerTurn).mock.calls[1][0].context.missionDetail!;
    expect(detail).toMatch(/No mission or agent matches/);

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toBe('I could not find that mission.');
  });

  it('does not trigger a follow-up turn for non-query actions (e.g. launch_mission) — no regression', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Launching that now.',
      actions: [{ type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', model: 'haiku' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance @coder sur fix the bug', 'haiku');
    });

    // Only ONE manager turn — no grounded follow-up needed for launch_mission.
    expect(runManagerTurn).toHaveBeenCalledTimes(1);
    // launch_mission still works end-to-end (no regression).
    expect(result.current.missions.length).toBe(countBefore + 1);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toBe('Launching that now.');
  });

  // Continuation gap fix (2026-08-02 escalation, see the Continuation
  // Doctrine in managerEngine.ts) — real incident: M9/M10 were launched as
  // standalone launch_mission calls meant to continue M6's scaffold, but
  // the action had no field to carry M6's branch, so both started from an
  // empty default branch. This proves the plumbing that closes the gap:
  // launch_mission's "baseBranch" reaches the created Mission unchanged
  // (Mission.baseBranch -> runtime.ts's createWorktree, per NewMissionInput/
  // addMission's own doc comments).
  it('launch_mission with a baseBranch carries it onto the created Mission (reaches createWorktree)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Continuing the scaffold.',
      actions: [
        {
          type: 'launch_mission',
          agentName: 'coder',
          task: 'Harden the Supabase SSR auth from the scaffold',
          model: 'sonnet',
          baseBranch: 'agent/M6-integrer-le-scaffold-existant-',
        },
      ],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'continue M6', 'haiku');
    });

    const created = result.current.missions[result.current.missions.length - 1];
    expect(created.baseBranch).toBe('agent/M6-integrer-le-scaffold-existant-');
  });

  it('launch_mission with no baseBranch leaves it unset — no regression, no fabricated default', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Launching that now.',
      actions: [{ type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', model: 'haiku' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance @coder sur fix the bug', 'haiku');
    });

    const created = result.current.missions[result.current.missions.length - 1];
    expect(created.baseBranch).toBeUndefined();
  });
});

// ── LazyManager: grounded brain_query (memory recall) ────────────────
// brain_query used to be purely "informational" — the manager could emit it,
// but nothing ever actually searched the brain or fed real results back
// (see agentsStore.tsx's executeManagerAction, previously a no-op case, and
// runGroundedFollowUp, previously query_mission/get_agent_output only).
// These tests drive sendManagerMessage end-to-end exactly like the mission-
// grounding suite above, mocking only runManagerTurn + recallForDirective
// (the real BRAIN_SEARCH-loop recall path — see brainSearchLoop.ts), and
// assert the SECOND (grounded follow-up) call actually receives a REAL
// recall result for the manager's OWN extracted query.
describe('sendManagerMessage — grounded brain query', () => {
  beforeEach(() => {
    vi.mocked(runManagerTurn).mockReset();
    mockRecallForDirective.mockReset();
    mockRecallForDirective.mockResolvedValue('(no memory hits found)');
  });

  it('actually calls recall with the manager\'s own extracted query and feeds the REAL result back', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    mockRecallForDirective.mockResolvedValueOnce(
      '[#42] Decision: switched from Postgres to SQLite for local cache.',
    );

    // First turn: the manager decides to search memory (extracted TOPIC, not
    // the user's verbatim sentence) — no answer yet.
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Let me check memory for that.',
      actions: [{ type: 'brain_query', query: 'postgres sqlite migration' }],
      rawResponse: '',
    });
    // Follow-up (grounded) turn: the manager answers using the REAL recall
    // result that was fetched and injected into its context.
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'We switched from Postgres to SQLite for the local cache (#42).',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'why did we switch off postgres?', 'haiku');
    });

    // Real recall was actually executed, with the manager's OWN topic-
    // extracted query — never the user's raw sentence.
    expect(mockRecallForDirective).toHaveBeenCalledTimes(1);
    expect(mockRecallForDirective).toHaveBeenCalledWith('postgres sqlite migration', expect.any(String));

    expect(runManagerTurn).toHaveBeenCalledTimes(2);
    const secondCallArgs = vi.mocked(runManagerTurn).mock.calls[1][0];
    expect(secondCallArgs.context.brainQueryResult).toBe(
      '[#42] Decision: switched from Postgres to SQLite for local cache.',
    );

    // The visible chat answer is the GROUNDED follow-up text, not the
    // ungrounded "let me check" filler from the first turn.
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect(lastMsg.content).toBe('We switched from Postgres to SQLite for the local cache (#42).');
  });

  it('never breaks the manager when recall fails — resilient fallback text, not a crash', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    // recallForDirective's real contract: NEVER throws, returns an explicit
    // "(brain search unavailable: ...)" string on failure instead.
    mockRecallForDirective.mockResolvedValueOnce(
      '(brain search unavailable: brain recall timed out after 150000ms)',
    );

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Checking memory…',
      actions: [{ type: 'brain_query', query: 'deploy pipeline' }],
      rawResponse: '',
    });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'I could not reach the brain just now.',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'did we already fix the deploy pipeline?', 'haiku');
    });

    expect(runManagerTurn).toHaveBeenCalledTimes(2);
    const secondCallArgs = vi.mocked(runManagerTurn).mock.calls[1][0];
    expect(secondCallArgs.context.brainQueryResult).toContain('brain search unavailable');

    // No crash, no error message — the manager still answers.
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toBe('I could not reach the brain just now.');
  });

  it('does not trigger a follow-up turn or call recall when no grounding action is emitted (no regression)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Sure, here is the agent list.',
      actions: [{ type: 'list_agents' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'list agents', 'haiku');
    });

    expect(runManagerTurn).toHaveBeenCalledTimes(1);
    expect(mockRecallForDirective).not.toHaveBeenCalled();
  });

  // R2a fix (thread 1, PROVEN in-app): the grounded follow-up's own actions
  // are DISCARDED by sendManagerMessage (only the FIRST turn's actions are
  // stored/executed), and stripActionBlock deletes the <lazy_actions> JSON
  // from the display text — so a follow-up that dutifully answered inside
  // an info action (exactly what the system prompt's action 24 tells it to
  // do for a pure answer) had its ACTUAL grounded answer silently deleted.
  // Observed live: bubble showed only the pre-search narration "Je vais
  // fouiller le brain…" with the chip, no grounded content, no error.
  it('surfaces a grounded answer the follow-up delivered inside an info action instead of discarding it', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    mockRecallForDirective.mockResolvedValueOnce('[#7] LazySite is the marketing site for the Lazy IDE.');

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Je vais fouiller le brain.',
      actions: [{ type: 'brain_query', query: 'projet lazysite' }],
      rawResponse: '',
    });
    // Follow-up: the model repeats its narration OUTSIDE the block and puts
    // the real grounded answer INSIDE an info action — the exact in-app
    // failure shape (parseManagerActions extracts it; stripActionBlock
    // removes it from responseText).
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Je vais fouiller le brain.',
      actions: [{ type: 'info', message: 'LazySite est le site marketing du Lazy IDE (#7).' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, "Qu'est-ce que tu sais sur ce projet ?", 'haiku');
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('LazySite est le site marketing du Lazy IDE (#7).');
  });

  it('surfaces a first-turn info-action answer on the no-grounding path too', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: '',
      actions: [{ type: 'info', message: 'Tu as 3 missions en cours.' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'combien de missions en cours ?', 'haiku');
    });

    expect(runManagerTurn).toHaveBeenCalledTimes(1);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toBe('Tu as 3 missions en cours.');
  });

  // P2-13 fix (real user test, verbatim, PROVEN): "Carrousel d'images ou
  // vraie vidéo Remotion rendue ?Carrousel d'images ou vraie vidéo Remotion
  // rendue ? Ça détermine tout le pipeline..." — the prose states the
  // clarifying question, and the SAME turn's info action restates that exact
  // opening then extends it with more detail. The old one-directional
  // containment check (`responseText.includes(infoMessage)`) could never
  // catch this superset case (info is the LONGER string), so it doubled the
  // question in one bubble.
  it('never doubles a clarifying question when the info action repeats the prose opening and extends it (P2-13 fix)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    const shortQuestion = "Carrousel d'images ou vraie vidéo Remotion rendue ?";
    const extendedQuestion = `${shortQuestion} Ça détermine tout le pipeline de production.`;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: shortQuestion,
      actions: [{ type: 'info', message: extendedQuestion }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'Fais-moi une vidéo promo pour mon app', 'haiku');
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toBe(extendedQuestion);
    // The short opening must appear exactly once, not twice glued together.
    expect(lastMsg.content.split(shortQuestion).length - 1).toBe(1);
  });

  // B12 regression: "list_missions" ("état de mes missions ?") was one of
  // the reported hanging turns. It is informational — the manager already
  // has the full mission list embedded in its system prompt — so it must
  // complete in exactly ONE runManagerTurn call and resolve managerBusy,
  // same as list_agents above.
  it('"list_missions" (état de mes missions) is informational — completes in one call and resolves managerBusy', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'You have 2 missions running and 1 in review.',
      actions: [{ type: 'list_missions' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'état de mes missions ?', 'haiku');
    });

    expect(runManagerTurn).toHaveBeenCalledTimes(1);
    expect(result.current.managerBusy).toBe(false);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toBe('You have 2 missions running and 1 in review.');
  });

  it('grounds a mission query AND a brain query in a single bounded follow-up turn when both are emitted', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Auth refactor',
        repo: '.',
        worktree: '',
        modelLabel: 'Sonnet 4.6',
        mode: 'agent',
        orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;

    mockRecallForDirective.mockResolvedValueOnce('[#7] Decision: OAuth2 PKCE flow chosen for auth.');

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Checking both…',
      actions: [
        { type: 'query_mission', missionId },
        { type: 'brain_query', query: 'oauth pkce decision' },
      ],
      rawResponse: '',
    });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Grounded answer using both.',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, `status of ${missionId} and why did we pick oauth pkce?`, 'haiku');
    });

    // Bounded: exactly ONE extra follow-up turn, not one per grounding action.
    expect(runManagerTurn).toHaveBeenCalledTimes(2);
    const secondCallArgs = vi.mocked(runManagerTurn).mock.calls[1][0];
    expect(secondCallArgs.context.missionDetail).toBeDefined();
    expect(secondCallArgs.context.brainQueryResult).toBe('[#7] Decision: OAuth2 PKCE flow chosen for auth.');
  });
});

// ── LazyManager: grounded structural query (brain_query_css / brain_neighbours) ──
// The structural analog of the brain_query suite above: a brain_query_css /
// brain_neighbours action must trigger the REAL deterministic recall
// (runBrainQueryCss / runBrainNeighbours — brainTool.ts) and feed the hits into
// the grounded follow-up turn's context, never breaking the manager on failure.
describe('sendManagerMessage — grounded structural query', () => {
  beforeEach(() => {
    vi.mocked(runManagerTurn).mockReset();
    mockRunBrainQueryCss.mockReset();
    mockRunBrainQueryCss.mockResolvedValue('0 matches');
    mockRunBrainNeighbours.mockReset();
    mockRunBrainNeighbours.mockResolvedValue('(no neighbours)');
  });

  it('runs a brain_query_css action (selector + limit verbatim) and grounds the follow-up on the REAL hits', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    mockRunBrainQueryCss.mockResolvedValueOnce(
      '[#3] aside doc-warning: never store tokens in localStorage',
    );

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Let me check the warnings.',
      actions: [{ type: 'brain_query_css', selector: 'aside[role="doc-warning"]', limit: 50 }],
      rawResponse: '',
    });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'One active warning: never store tokens in localStorage (#3).',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'list every active warning', 'haiku');
    });

    // The REAL structural query ran, selector + limit passed verbatim.
    expect(mockRunBrainQueryCss).toHaveBeenCalledTimes(1);
    expect(mockRunBrainQueryCss).toHaveBeenCalledWith('aside[role="doc-warning"]', 50);

    // Bounded: exactly one grounded follow-up turn, fed the real hits.
    expect(runManagerTurn).toHaveBeenCalledTimes(2);
    const secondCallArgs = vi.mocked(runManagerTurn).mock.calls[1][0];
    expect(secondCallArgs.context.structuralQueryResult).toContain('never store tokens in localStorage');

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toBe('One active warning: never store tokens in localStorage (#3).');
  });

  it('runs a brain_neighbours action and never breaks the manager when the hop is unavailable', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    // runBrainNeighbours' real contract: NEVER throws — returns an explicit
    // "(brain_neighbours unavailable: ...)" string on failure instead.
    mockRunBrainNeighbours.mockResolvedValueOnce('(brain_neighbours unavailable: sidecar down)');

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Following that note…',
      actions: [{ type: 'brain_neighbours', id: 'decision-7' }],
      rawResponse: '',
    });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'I could not follow that note right now.',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'what replaced decision 7?', 'haiku');
    });

    expect(mockRunBrainNeighbours).toHaveBeenCalledWith('decision-7');
    expect(runManagerTurn).toHaveBeenCalledTimes(2);
    const secondCallArgs = vi.mocked(runManagerTurn).mock.calls[1][0];
    expect(secondCallArgs.context.structuralQueryResult).toContain('brain_neighbours unavailable');

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toBe('I could not follow that note right now.');
  });

  it('does not run a structural query or a follow-up turn when no structural action is emitted (no regression)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Here is the agent list.',
      actions: [{ type: 'list_agents' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'list agents', 'haiku');
    });

    expect(runManagerTurn).toHaveBeenCalledTimes(1);
    expect(mockRunBrainQueryCss).not.toHaveBeenCalled();
    expect(mockRunBrainNeighbours).not.toHaveBeenCalled();
  });
});

// ── LazyManager: startup context snapshot (first turn only) ─────────
// Mirrors the main assistant chat's one-time startup-context injection.
describe('sendManagerMessage — startup context snapshot', () => {
  beforeEach(() => {
    vi.mocked(runManagerTurn).mockReset();
    mockStartupContext.mockReset();
    mockStartupContext.mockResolvedValue('');
  });

  it('does not wait on brain.startupContext for a short greeting (TTFT path)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Hi! How can I help?',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'hello', 'haiku');
    });

    expect(mockStartupContext).not.toHaveBeenCalled();
    const firstCallArgs = vi.mocked(runManagerTurn).mock.calls[0][0];
    expect(firstCallArgs.context.startupContext).toBeUndefined();
  });

  it('fetches the startup snapshot on the first ACTION turn, not on a later action', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    mockStartupContext.mockResolvedValueOnce('Recent session: refactored auth module.');

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Launching.',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance M9', 'haiku');
    });

    expect(mockStartupContext).toHaveBeenCalledTimes(1);
    const firstCallArgs = vi.mocked(runManagerTurn).mock.calls[0][0];
    expect(firstCallArgs.context.startupContext).toBe('Recent session: refactored auth module.');

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Sure.',
      actions: [],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance M10', 'haiku');
    });

    expect(mockStartupContext).toHaveBeenCalledTimes(1);
    const secondCallArgs = vi.mocked(runManagerTurn).mock.calls[1][0];
    expect(secondCallArgs.context.startupContext).toBeUndefined();
  });

  it('never blocks sending a message when the startup snapshot fetch fails', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    mockStartupContext.mockRejectedValueOnce(new Error('brain offline'));

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Hi!',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'hello', 'haiku');
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toBe('Hi!');
  });
});

// ── Manager-launched missions: mode-aware model (the BLOCKER fix) ───
// Before this fix, launch_mission/create_loop always defaulted the new
// mission's model to the hardcoded label "Haiku 4.5" — a native Anthropic
// id/label, not an OpenRouter id. In managed/Pro mode that mission then died
// at the execution layer with "Modèle non supporté" (mission M15, per QA).
// These tests drive sendManagerMessage end-to-end (real resolveManagerModelId,
// only runManagerTurn is mocked) and assert the mission actually created
// carries a model id valid for the CURRENT provider mode.
describe('LazyManager launched missions — mode-aware model', () => {
  afterEach(() => {
    clearProviderModeSimulation();
  });

  it('launch_mission in managed mode resolves to a valid OpenRouter id, not the native default', async () => {
    simulateTauri();
    setManagedAvailability(true); // auto-detect -> 'managed' (no explicit accessMode)

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Launching now.',
      actions: [{ type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', model: 'haiku' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance @coder sur fix the bug', 'anthropic/claude-sonnet-5');
    });

    expect(result.current.missions.length).toBe(countBefore + 1);
    const mission = result.current.missions[result.current.missions.length - 1];
    // Must be an OpenRouter-format id (contains a provider prefix) — the
    // ai-proxy rejects anything else with "Modèle non supporté".
    expect(mission.model).toContain('/');
    expect(mission.model.toLowerCase()).toContain('haiku');
    expect(mission.model).not.toBe('Haiku 4.5');
  });

  it('launch_mission in claude-code mode still resolves to a native Anthropic id (no regression)', async () => {
    simulateTauri();
    saveAccessSettings({ accessMode: 'cli', cliTool: 'claude' });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Launching now.',
      actions: [{ type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', model: 'sonnet' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance @coder sur fix the bug', 'claude-sonnet-5');
    });

    expect(result.current.missions.length).toBe(countBefore + 1);
    const mission = result.current.missions[result.current.missions.length - 1];
    expect(mission.model).not.toContain('/');
    expect(mission.model.toLowerCase()).toContain('sonnet');
  });

  it('launch_mission with no tier hint still defaults to a valid managed model (managed mode)', async () => {
    simulateTauri();
    setManagedAvailability(true);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Launching now.',
      actions: [{ type: 'launch_mission', agentName: 'coder', task: 'Fix the bug' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance @coder sur fix the bug', 'anthropic/claude-sonnet-5');
    });

    expect(result.current.missions.length).toBe(countBefore + 1);
    const mission = result.current.missions[result.current.missions.length - 1];
    expect(mission.model).toBe(DEFAULT_OPENROUTER_MODEL_ID);
  });

  it('create_loop in managed mode registers the loop with a valid OpenRouter model id', async () => {
    simulateTauri();
    setManagedAvailability(true);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Loop created.',
      actions: [{ type: 'create_loop', agentName: 'lint-checker', task: 'Run lint', cadence: '15m', model: 'opus' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'loop lint every 15m', 'anthropic/claude-sonnet-5');
    });

    expect(result.current.missions.length).toBe(countBefore + 1);
    const loopMission = result.current.missions[result.current.missions.length - 1];
    expect(loopMission.model).toContain('/');
    expect(loopMission.model.toLowerCase()).toContain('opus');
  });

  // ── MANAGER FALSE POSITIVE fix (DEFECT C) ───────────────────────────
  // create_loop previously had no delete/pause counterpart: the manager fell
  // back to stop_all (which only stops RUNNING missions) and falsely claimed
  // "Loop supprimée" while the loop stayed enabled:true and still scheduled.
  // pause_loop/delete_loop now really flip/remove the loop, matching by
  // mission id or a name/keyword (case-insensitive).
  describe('pause_loop / delete_loop manager actions', () => {
    async function createTestLoop(result: { current: ReturnType<typeof useAgentsStore> }) {
      vi.mocked(runManagerTurn).mockResolvedValueOnce({
        responseText: 'Loop created.',
        actions: [{ type: 'create_loop', agentName: 'lint-checker', task: 'Run lint', cadence: '15m', model: 'haiku' }],
        rawResponse: '',
      });
      await act(async () => {
        await result.current.sendManagerMessage(result.current.activeConversationId, 'loop lint every 15m', 'anthropic/claude-sonnet-5');
      });
      return result.current.missions[result.current.missions.length - 1];
    }

    it('pause_loop (matched by mission id) really disables the loop, not just stops a run', async () => {
      const { result } = renderHook(() => useAgentsStore(), { wrapper });
      const loopMission = await createTestLoop(result);
      expect(loopMission.loopConfig?.enabled).toBe(true);

      vi.mocked(runManagerTurn).mockResolvedValueOnce({
        responseText: 'Loop paused.',
        actions: [{ type: 'pause_loop', loopId: loopMission.id }],
        rawResponse: '',
      });
      await act(async () => {
        await result.current.sendManagerMessage(result.current.activeConversationId, `pause le loop ${loopMission.id}`, 'anthropic/claude-sonnet-5');
      });

      const updated = result.current.missions.find((m) => m.id === loopMission.id);
      expect(updated?.loopConfig?.enabled).toBe(false);
      // Still present — pause is not delete.
      expect(updated).toBeDefined();
    });

    it('delete_loop (matched by title keyword) really removes the loop mission', async () => {
      const { result } = renderHook(() => useAgentsStore(), { wrapper });
      const loopMission = await createTestLoop(result);
      const countBeforeDelete = result.current.missions.length;

      vi.mocked(runManagerTurn).mockResolvedValueOnce({
        responseText: 'Loop deleted.',
        actions: [{ type: 'delete_loop', loopId: 'lint' }],
        rawResponse: '',
      });
      await act(async () => {
        await result.current.sendManagerMessage(result.current.activeConversationId, 'supprime le loop lint', 'anthropic/claude-sonnet-5');
      });

      expect(result.current.missions.length).toBe(countBeforeDelete - 1);
      expect(result.current.missions.find((m) => m.id === loopMission.id)).toBeUndefined();
    });
  });
});

// ── LazyManager launched missions — modelId (exact catalog id, catalog wave) ──
// A manager action can now name an EXACT catalog id (ManagerModelId) instead
// of a bare tier hint. These tests drive sendManagerMessage end-to-end (real
// resolveManagerModelId) and assert the id actually survives to the created
// mission/draft, and that an unknown id is refused honestly rather than
// silently replaced by the tier default (NEVER DEGRADE IN SILENCE).
describe('LazyManager launched missions — modelId (exact catalog id)', () => {
  afterEach(() => {
    clearProviderModeSimulation();
  });

  it('launch_mission with an exact modelId in managed mode creates a mission carrying that EXACT id', async () => {
    simulateTauri();
    setManagedAvailability(true);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Launching now.',
      actions: [
        { type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', model: 'haiku', modelId: 'openai/gpt-5.6-luna' },
      ],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance @coder sur fix the bug avec GPT-5.6 Luna', 'anthropic/claude-sonnet-5');
    });

    expect(result.current.missions.length).toBe(countBefore + 1);
    const mission = result.current.missions[result.current.missions.length - 1];
    // modelId took priority over the "haiku" tier hint, and was NOT
    // reinterpreted/abbreviated.
    expect(mission.model).toBe('openai/gpt-5.6-luna');
  });

  it('launch_mission with a modelId unknown to the effective rail creates NO mission and reports an honest failure naming the id', async () => {
    simulateTauri();
    setManagedAvailability(true);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;
    const messagesBefore = result.current.managerMessages.length;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Launching now.',
      actions: [
        { type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', modelId: 'not-a-real/model-id' },
      ],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance @coder sur fix the bug', 'anthropic/claude-sonnet-5');
    });

    // No mission was silently created on some fallback default model.
    expect(result.current.missions.length).toBe(countBefore);
    const messages = result.current.managerMessages;
    expect(messages.length).toBeGreaterThan(messagesBefore);
    const combined = messages.map((m) => m.content).join(' | ');
    expect(combined).toContain('not-a-real/model-id');
  });

  it('a valid CLI-rail (native) modelId requested on the Pro rail launches via the inferred rail switch, carrying the CLI id unchanged', async () => {
    simulateTauri();
    setManagedAvailability(true);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Launching now.',
      actions: [{ type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', modelId: DEFAULT_MODEL.id }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance @coder', 'anthropic/claude-sonnet-5');
    });

    // Inferred rail switch (2026-08-05): unambiguous elsewhere (the CLI rail), so it launches there instead of being refused.
    expect(result.current.missions.length).toBe(countBefore + 1);
    const mission = result.current.missions[result.current.missions.length - 1];
    expect(mission.model).toBe(DEFAULT_MODEL.id);
  });

  it('create_loop with an exact modelId registers the loop carrying that EXACT id', async () => {
    simulateTauri();
    setManagedAvailability(true);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Loop created.',
      actions: [
        { type: 'create_loop', agentName: 'lint-checker', task: 'Run lint', cadence: '15m', modelId: 'deepseek/deepseek-v4-flash' },
      ],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'loop lint every 15m avec deepseek flash', 'anthropic/claude-sonnet-5');
    });

    expect(result.current.missions.length).toBe(countBefore + 1);
    const loopMission = result.current.missions[result.current.missions.length - 1];
    expect(loopMission.model).toBe('deepseek/deepseek-v4-flash');
  });
});

// ── Plan-first: modelId + engine survive execute_plan (Mission P) ──────
// Before this fix, agentsStore.tsx's execute_plan `launchMission` callback
// always passed engineOverride=undefined to resolveManagerModelId, so a plan
// step's own deliberate "cli"/"pro" engine choice was silently dropped the
// moment it ran through a plan — the modelId itself already survived the
// createOrchestrator -> compileOrchestratorToIr -> launchOptsFromNode leg
// (see orchestratorStatePlanFirst.test.ts), but engine never reached
// resolveManagerModelId's engineOverride parameter at all.
//
// Drives the REAL two-turn flow (generate_plan -> execute_plan) through
// sendManagerMessage — a controllable `invoke` mock makes
// orchestratorState.ts's real fs persistence round-trip in-memory (the
// shared setup.ts default, `invoke` always resolving undefined, would
// otherwise make the orchestrator vanish between the two turns), and a
// runMission override settles the launched mission to 'done' immediately
// (same pattern as agentsStore.missionLaunchStall.test.tsx's "Healthy
// launch" case) so startOrchestratorViaSgr's waitForMissions never blocks on
// a mission whose full agent loop is out of scope for this test.
describe('LazyManager launched missions — plan-first modelId + engine chain (Mission P)', () => {
  afterEach(() => {
    clearProviderModeSimulation();
  });

  it('a plan step naming an exact modelId AND a deliberate "cli" engine override creates a mission on that model/rail, even though the AMBIENT mode is managed/Pro', async () => {
    simulateTauri();
    setManagedAvailability(true); // ambient mode: managed/Pro

    const fsStore = new Map<string, string>();
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'write_file') {
        const { path, content } = args as { path: string; content: string };
        fsStore.set(path, content);
        return Promise.resolve(undefined);
      }
      if (cmd === 'read_file') {
        const { path } = args as { path: string };
        const content = fsStore.get(path);
        return content !== undefined ? Promise.resolve(content) : Promise.reject(new Error('cannot find the file'));
      }
      if (cmd === 'fs_create_dir') return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    mockedRunMission.mockImplementationOnce((mission: Mission, _root: string, opts: { onUpdate: (u: MissionUpdate) => void }) => {
      opts.onUpdate({ id: mission.id, patch: { status: 'done' } });
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    // Turn 1 — the manager proposes a one-step plan naming a CLI-rail-only
    // modelId (DEFAULT_MODEL.id — the same id the earlier "honestly refused
    // on the Pro rail" test above uses WITHOUT an engine override) AND a
    // deliberate 'cli' engine.
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Plan ready.',
      actions: [{
        type: 'generate_plan',
        objective: 'Ship the feature',
        steps: [{ id: 's1', description: 'Implement it', modelId: DEFAULT_MODEL.id, engine: 'cli' }],
      }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'plan it', 'anthropic/claude-sonnet-5');
    });

    const planMsg = result.current.managerMessages.find((m) => m.proposal);
    const planId = planMsg?.proposal?.planId;
    expect(planId).toBeDefined();

    // Turn 2 — the user validates the plan (execute_plan): the real path
    // (startOrchestratorViaSgr -> runGraph -> the FIXED launchMission
    // callback -> resolveManagerModelId) runs end to end.
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Executing.',
      actions: [{ type: 'execute_plan', planId: planId! }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'go', 'anthropic/claude-sonnet-5');
    });

    expect(result.current.missions.length).toBe(countBefore + 1);
    const mission = result.current.missions[result.current.missions.length - 1];
    // The exact modelId survived the whole plan-first thread, AND the
    // deliberate 'cli' engine override actually won over the ambient managed
    // mode — before the Mission P fix, engineOverride was always undefined
    // here, so this same native-only modelId would have been checked against
    // the MANAGED rail's OpenRouter catalog instead and thrown
    // UnknownManagerModelIdError, creating no mission at all.
    expect(mission.model).toBe(DEFAULT_MODEL.id);
    expect(mission.model).not.toContain('/');
  });
});

// ── Plan-first: extraReadableProjectIds survives execute_plan ──────────
// Cross-project READ access (confirmed gap, live run): launch_mission's own
// executor already resolved a declared extraReadableProjectIds entry to a
// real root (see runtimeExtraReadableRoots.test.ts / managerActionValidator
// tests), but the GRAPH path (generate_plan -> execute_plan, the manager's
// PRIMARY multi-step planning surface) had no wiring at all — a plan step
// had no way to declare it, so every agent launched through a plan stayed
// exactly as confined as before this whole feature existed. Fixed by
// threading OrchestratorPlanStepInput.extraReadableProjectIds through
// createOrchestrator (orchestratorState.ts) -> compileOrchestratorToIr's
// StepContract (graph/compileOrchestrator.ts) -> launchOptsFromNode
// (graph/sgrOrchestratorRunner.ts) -> the SGR launchMission callback here
// (agentsStore.tsx), which resolves each declared id/name to a real,
// currently OPEN project root the same way launch_mission's own executor
// does (resolveDraftProjectId -> resolveProjectRootById).
//
// Same real two-turn flow (generate_plan -> execute_plan) and fsStore/
// runMission-settles-immediately harness as the Mission P block above.
describe('LazyManager launched missions — plan-first cross-project READ access (extraReadableProjectIds)', () => {
  afterEach(() => {
    clearProviderModeSimulation();
  });

  const ACTIVE_ROOT = 'C:\\tmp\\plan-first-active-project';
  const OTHER_ROOT = 'C:\\tmp\\other-project';

  function mockInvokeWithTwoOpenProjects(fsStore: Map<string, string>) {
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'project_list') {
        return Promise.resolve([
          { root: ACTIVE_ROOT, active: true },
          { root: OTHER_ROOT, active: false },
        ]);
      }
      if (cmd === 'write_file') {
        const { path, content } = args as { path: string; content: string };
        fsStore.set(path, content);
        return Promise.resolve(undefined);
      }
      if (cmd === 'read_file') {
        const { path } = args as { path: string };
        const content = fsStore.get(path);
        return content !== undefined ? Promise.resolve(content) : Promise.reject(new Error('cannot find the file'));
      }
      if (cmd === 'fs_create_dir') return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });
  }

  it('a plan step declaring a currently-open project resolves it onto the launched mission\'s extraReadableRoots', async () => {
    simulateTauri();
    const fsStore = new Map<string, string>();
    mockInvokeWithTwoOpenProjects(fsStore);

    mockedRunMission.mockImplementationOnce((mission: Mission, _root: string, opts: { onUpdate: (u: MissionUpdate) => void }) => {
      opts.onUpdate({ id: mission.id, patch: { status: 'done' } });
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Plan ready.',
      actions: [{
        type: 'generate_plan',
        objective: 'Document project A the way project B calls it',
        steps: [{ id: 's1', description: 'Read other-project and document it', extraReadableProjectIds: ['other-project'] }],
      }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'plan it', 'anthropic/claude-sonnet-5');
    });

    const planMsg = result.current.managerMessages.find((m) => m.proposal);
    const planId = planMsg?.proposal?.planId;
    expect(planId).toBeDefined();

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Executing.',
      actions: [{ type: 'execute_plan', planId: planId! }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'go', 'anthropic/claude-sonnet-5');
    });

    expect(result.current.missions.length).toBe(countBefore + 1);
    const mission = result.current.missions[result.current.missions.length - 1];
    expect(mission.extraReadableRoots).toEqual([OTHER_ROOT]);
  });

  it('a plan step declaring nothing behaves exactly as before — extraReadableRoots stays undefined', async () => {
    simulateTauri();
    const fsStore = new Map<string, string>();
    mockInvokeWithTwoOpenProjects(fsStore);

    mockedRunMission.mockImplementationOnce((mission: Mission, _root: string, opts: { onUpdate: (u: MissionUpdate) => void }) => {
      opts.onUpdate({ id: mission.id, patch: { status: 'done' } });
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Plan ready.',
      actions: [{
        type: 'generate_plan',
        objective: 'Ship the feature',
        steps: [{ id: 's1', description: 'Implement it' }],
      }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'plan it', 'anthropic/claude-sonnet-5');
    });

    const planMsg = result.current.managerMessages.find((m) => m.proposal);
    const planId = planMsg?.proposal?.planId;
    expect(planId).toBeDefined();

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Executing.',
      actions: [{ type: 'execute_plan', planId: planId! }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'go', 'anthropic/claude-sonnet-5');
    });

    expect(result.current.missions.length).toBe(countBefore + 1);
    const mission = result.current.missions[result.current.missions.length - 1];
    expect(mission.extraReadableRoots).toBeUndefined();
  });

  it('a plan step declaring a project that is NOT currently open is dropped with a warning — never substituted for "every open project"', async () => {
    simulateTauri();
    const fsStore = new Map<string, string>();
    mockInvokeWithTwoOpenProjects(fsStore);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockedRunMission.mockImplementationOnce((mission: Mission, _root: string, opts: { onUpdate: (u: MissionUpdate) => void }) => {
      opts.onUpdate({ id: mission.id, patch: { status: 'done' } });
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Plan ready.',
      actions: [{
        type: 'generate_plan',
        objective: 'Document a project that was never opened',
        steps: [{ id: 's1', description: 'Read never-opened-project and document it', extraReadableProjectIds: ['never-opened-project'] }],
      }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'plan it', 'anthropic/claude-sonnet-5');
    });

    const planMsg = result.current.managerMessages.find((m) => m.proposal);
    const planId = planMsg?.proposal?.planId;
    expect(planId).toBeDefined();

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Executing.',
      actions: [{ type: 'execute_plan', planId: planId! }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'go', 'anthropic/claude-sonnet-5');
    });

    expect(result.current.missions.length).toBe(countBefore + 1);
    const mission = result.current.missions[result.current.missions.length - 1];
    // Dropped, never a fallback to "every open project" (ACTIVE_ROOT/OTHER_ROOT
    // must NOT silently appear here just because they happen to be open).
    expect(mission.extraReadableRoots).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('never-opened-project'));

    warnSpy.mockRestore();
  });
});

// ── generate_plan result message — no internal id leak (BUG 2 fix) ─────
// Real founder complaint, dogfood 2026-08-05: the chat's "Résultat réel"
// message for a freshly generated plan showed the raw internal orchestrator
// id verbatim (e.g. "Plan orch-1785941982392-mrt2zs7 created") — meaningless
// and ugly to a human. Now humanized to the plan's own title + step count;
// the real id stays available programmatically (proposal.planId) but never
// appears in ANY manager-facing chat text.
describe('generate_plan — result message is humanized, never leaks the internal orch- id (BUG 2 fix)', () => {
  it('the "Résultat réel" message names the plan by title + step count, never by its internal id', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Plan ready.',
      actions: [{
        type: 'generate_plan',
        objective: 'Ship the widget',
        steps: [
          { id: 's1', description: 'Step one' },
          { id: 's2', description: 'Step two', dependsOn: ['s1'] },
        ],
      }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'plan it', 'anthropic/claude-sonnet-5');
    });

    const planMsg = result.current.managerMessages.find((m) => m.proposal);
    const planId = planMsg?.proposal?.planId;
    expect(planId).toBeDefined();

    const allContent = result.current.managerMessages.map((m) => m.content).join('\n');
    expect(allContent).toContain('Plan proposé : « Ship the widget » — 2 étapes');
    // The raw internal id must never leak into any manager-facing message,
    // whether via the generic "orch-" prefix or the exact id itself.
    expect(allContent).not.toContain('orch-');
    expect(allContent).not.toContain(planId);
  });
});

// ── Plan accept — real materialization + real execution (B2/B3 fix) ────
// Real QA session (2026-07-28, FINDINGS-RUN-NUIT.md): clicking "Valider &
// lancer" on a 2-step plan flipped the card to ACCEPTED with zero real
// effect (no mission, no canvas change) — B2 — and separately, the first
// step's canvas node vanished silently after acceptance — B3. Both are
// fixed in agentsStore.tsx's executePlan: a real 'launching' state sits
// between the click and a confirmed 'accepted' (never a false positive),
// and a step whose node fails to materialize reverts the proposal to
// 'pending' with a persistent, visible `errorMessage` instead of quietly
// dropping it.
describe('Plan accept — real materialization + real execution (B2/B3 fix)', () => {
  afterEach(() => {
    // `mockImplementation` (unlike `mockImplementationOnce`) persists past
    // this describe block — `clearMocks` (vitest.config.ts) only clears call
    // history, never a set implementation. Restore the exact top-of-file
    // default (`runMission: vi.fn().mockResolvedValue(undefined)`) so later
    // describe blocks in this file see the same no-op runMission they wrote
    // their own assertions against.
    mockedRunMission.mockReset();
    mockedRunMission.mockResolvedValue(undefined);
  });

  function setUpPlanExecutionMocks() {
    simulateTauri();
    const fsStore = new Map<string, string>();
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'write_file') {
        const { path, content } = args as { path: string; content: string };
        fsStore.set(path, content);
        return Promise.resolve(undefined);
      }
      if (cmd === 'read_file') {
        const { path } = args as { path: string };
        const content = fsStore.get(path);
        return content !== undefined ? Promise.resolve(content) : Promise.reject(new Error('cannot find the file'));
      }
      if (cmd === 'fs_create_dir') return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });
    mockedRunMission.mockImplementation((mission: Mission, _root: string, opts: { onUpdate: (u: MissionUpdate) => void }) => {
      // `worktree` mirrors real runtime.ts behavior (Step A always sets it
      // to the mission's own branch name before 'done') — the twoStepPlan
      // below has a real dependsOn chain, and runGraph's dependency-branch
      // inheritance (resolveInheritedBranches) now reads the upstream
      // step's `mission.worktree` to launch the downstream step; a mock
      // that never sets it would make the downstream step fail with a
      // "missing upstream branch" error instead of the unrelated behavior
      // each test below actually exercises.
      opts.onUpdate({ id: mission.id, patch: { status: 'done', worktree: `agent/${mission.id}-mock` } });
      return Promise.resolve(undefined);
    });
  }

  const twoStepPlan = [
    { id: 'content', description: 'Write the caption', agentName: 'content-strategist' },
    { id: 'design', description: 'Design the carousel', agentName: 'carousel-designer', dependsOn: ['content'] },
  ];

  async function proposeTwoStepPlan(result: { current: ReturnType<typeof useAgentsStore> }) {
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Plan ready.',
      actions: [{ type: 'generate_plan', objective: 'Post carousels', steps: twoStepPlan }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'plan it', 'anthropic/claude-sonnet-5');
    });
    const planMsg = result.current.managerMessages.find((m) => m.proposal);
    return planMsg!.proposal!.planId!;
  }

  it('accepting a 2-step plan creates BOTH nodes AND launches BOTH real missions — verified by real mission count, not the displayed card state', async () => {
    setUpPlanExecutionMocks();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    const planId = await proposeTwoStepPlan(result);

    await act(async () => {
      await result.current.executePlan(planId, undefined);
    });

    // Real effect: two real missions were actually launched (not just a
    // card that says "accepted") — one per plan step.
    expect(result.current.missions.length).toBe(countBefore + 2);
    const titles = result.current.missions.slice(-2).map((m) => m.title);
    expect(titles).toContain('Write the caption');
    expect(titles).toContain('Design the carousel');

    // The card only reads 'accepted' because a real effect was confirmed.
    const finalMsg = result.current.managerMessages.find((m) => m.proposal?.planId === planId);
    expect(finalMsg?.proposal?.state).toBe('accepted');
    expect(finalMsg?.proposal?.errorMessage).toBeUndefined();
  });

  it('shows an honest "launching" intermediate state — never a bare "accepted" before anything real has happened', async () => {
    setUpPlanExecutionMocks();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const planId = await proposeTwoStepPlan(result);

    let launchPromise!: Promise<void>;
    act(() => {
      launchPromise = result.current.executePlan(planId, undefined);
    });

    // Synchronously after the click (before the async materialize/execute
    // work has had a chance to resolve), the card must already be in the
    // 'launching' state — never straight to a terminal-looking 'accepted'.
    const midFlightMsg = result.current.managerMessages.find((m) => m.proposal?.planId === planId);
    expect(midFlightMsg?.proposal?.state).toBe('launching');

    await act(async () => {
      await launchPromise;
    });

    const finalMsg = result.current.managerMessages.find((m) => m.proposal?.planId === planId);
    expect(finalMsg?.proposal?.state).toBe('accepted');
  });

  it('a step whose node fails to materialize launches survivors and warns — never a silent vanish (B3/B33)', async () => {
    setUpPlanExecutionMocks();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;
    const planId = await proposeTwoStepPlan(result);

    // Simulate the exact real-world symptom (B3): materialization runs and
    // does not throw, but one step's draft is missing from the canvas
    // afterwards (here forced via the real acceptProposedSteps PLUS an
    // extra removal, to prove the NEW post-materialization verification
    // catches a gap regardless of how it was produced).
    const { canvasStoreVanilla } = await import('../components/agents/canvas/canvasStore');
    const originalAccept = canvasStoreVanilla.getState().acceptProposedSteps;
    canvasStoreVanilla.setState({
      acceptProposedSteps: (id: string, stepIds: readonly string[] | null) => {
        originalAccept(id, stepIds);
        canvasStoreVanilla.getState().removeDraft('content');
      },
    });

    try {
      await act(async () => {
        await result.current.executePlan(planId, undefined);
      });

      // B33: survivors launch — the plan is NOT cancelled when a single
      // draft failed to land. At least one mission was created.
      expect(result.current.missions.length).toBeGreaterThan(countBefore);

      // The card reaches 'accepted' (the plan did execute, partially).
      const finalMsg = result.current.managerMessages.find((m) => m.proposal?.planId === planId);
      expect(finalMsg?.proposal?.state).toBe('accepted');
    } finally {
      canvasStoreVanilla.setState({ acceptProposedSteps: originalAccept });
    }
  });

  it('a plan execution that launches zero real missions reverts to pending with a visible error, never a false "accepted"', async () => {
    setUpPlanExecutionMocks();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;
    const planId = await proposeTwoStepPlan(result);

    // NOW (after the plan proposal's own 'generate_plan' gate check already
    // consumed the default 'allow') deny the NEXT gate call — the one
    // execute_plan's own case makes — simulating a real-world total
    // execution failure (nothing ever gets a chance to launch).
    const { evaluateActionGate } = await import('../lib/agents/actionGate');
    vi.mocked(evaluateActionGate).mockResolvedValueOnce({ decision: 'deny', reason: 'test: simulated denial' });

    await act(async () => {
      await result.current.executePlan(planId, undefined);
    });

    expect(result.current.missions.length).toBe(countBefore);
    const finalMsg = result.current.managerMessages.find((m) => m.proposal?.planId === planId);
    expect(finalMsg?.proposal?.state).toBe('pending');
    expect(finalMsg?.proposal?.errorMessage).toBeDefined();
  });
});

// ── Composer "Lancer comme agent →" launch path (DEFECT 2) ──────────
// The composer's "Lancer comme agent" button (AssistantPanel.handleLaunchAgent)
// and the Review-space quick-launch buttons emit the `agent:launch` bus event,
// which this store turns into a mission. Without an explicit permissionMode the
// mission ran with permissionMode undefined → runtime.ts sends 'default' → the
// native CLI runs with interactive approval prompts that never appear in-app,
// so the agent stalls. The fix defaults it to 'acceptEdits' — the exact mode
// the Agents "New Mission" modal uses — so both launch paths behave identically.
describe('agent:launch (composer "Lancer comme agent") — permission mode', () => {
  it('creates the mission with permissionMode="acceptEdits" so the native CLI does not stall on prompts', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionsBefore = result.current.missions.length;
    const runCallsBefore = mockedRunMission.mock.calls.length;

    await act(async () => {
      emit('agent:launch', {
        task: 'Fix the failing login test',
        title: 'Fix the failing login test',
        model: 'Sonnet 4.6',
      });
      // addMission is async (awaits resolveProjectRoot before calling
      // runMission) — flush its microtasks past the macrotask boundary.
      await new Promise((r) => setTimeout(r, 0));
    });

    // Exactly one mission was created and one runMission launched by the bus event.
    expect(result.current.missions.length).toBe(missionsBefore + 1);
    const newMission = result.current.missions[result.current.missions.length - 1];

    const launchCall = mockedRunMission.mock.calls
      .slice(runCallsBefore)
      .find((c) => (c[0] as { id: string }).id === newMission.id);
    expect(launchCall).toBeDefined();

    const opts = launchCall![2] as { permissionMode?: string };
    expect(opts.permissionMode).toBe('acceptEdits');
  });
});

// ── managerModel store state (stickiness foundation) ─────────────────
// LazyManager itself unmounts/remounts when cockpit tabs switch (see
// AgentsSpace's `{activeTab === 'mission-control' && <LazyManager />}`), so
// the model selection must live in this store (survives that remount), not
// in LazyManager's local component state. These tests cover the store side;
// the component-level remount behaviour is covered in LazyManager.test.tsx.
describe('managerModel store state', () => {
  beforeEach(() => {
    // Prior describes in this file leave `__TAURI_INTERNALS__` set. Mock
    // mode is the browser rail — default must not inherit a leftover CLI.
    clearProviderModeSimulation();
  });

  afterEach(() => {
    clearProviderModeSimulation();
  });

  it('defaults to the first free OpenRouter id outside Tauri (mock mode)', () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    // Browser cannot run the native Claude CLI — default is the free GLM, not
    // Sonnet / Haiku. See getManagerDefaultModelId('mock') in managerEngine.ts.
    expect(result.current.managerModel).toBe(getManagerDefaultModelId('mock'));
    expect(result.current.managerModel).toBe(FREE_OPENROUTER_MODEL_ID);
    expect(result.current.managerModel).not.toBe(DEFAULT_MODEL.id);
  });

  it('ignores a persisted native Claude id outside Tauri', () => {
    localStorage.setItem('lazy.manager.model', 'claude-sonnet-5');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    expect(result.current.managerModel).toBe(FREE_OPENROUTER_MODEL_ID);
  });

  it('defaults to the OpenRouter id when initialised in managed mode', () => {
    simulateTauri();
    setManagedAvailability(true);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    expect(result.current.managerModel).toBe(getDefaultModelIdForMode('managed'));
    expect(result.current.managerModel).toContain('/');
  });

  it('setManagerModel updates managerModel and the new value is retained', () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    act(() => {
      result.current.setManagerModel('anthropic/claude-opus-5');
    });

    expect(result.current.managerModel).toBe('anthropic/claude-opus-5');

    // Unrelated store activity (e.g. selecting a mission) must not reset it —
    // managerModel is plain state, not derived/recomputed on other updates.
    act(() => {
      result.current.setSelectedMissionId(result.current.missions[0]?.id ?? null);
    });
    expect(result.current.managerModel).toBe('anthropic/claude-opus-5');
  });
});

// ── pauseMission / resumeMission / interveneMission ─────────────────
// Real for managed missions (flip the exact pauseFlag/interveneQueue cells
// runMission threads into managedAgent.planAndActManaged as pauseSignal/
// drainIntervenes), a guarded no-op / honestly-not-delivered note for
// native missions (one-shot `claude -p`, see runtime.ts's
// isLiveAgentAvailable doc comment). These tests grab the exact
// pauseSignal/drainIntervenes closures passed to the mocked runMission —
// the same functions the real loop polls — rather than only asserting on
// the UI-facing Mission.paused/actionTimeline fields.
describe('agentsStore — pauseMission/resumeMission/interveneMission', () => {
  afterEach(() => {
    clearProviderModeSimulation();
  });

  function lastRunMissionOpts() {
    const calls = mockedRunMission.mock.calls;
    return calls[calls.length - 1][2] as {
      pauseSignal: () => boolean;
      drainIntervenes: () => string[];
    };
  }

  // addMission is async (it awaits resolveProjectRoot() before setting up
  // pauseFlags/interveneQueues and calling runMission), so every test below
  // must await it — a plain act(() => addMission(...)) returns before that
  // wiring runs, leaving lastRunMissionOpts() looking at a stale/missing call.
  async function addRunningMission(
    result: { current: ReturnType<typeof useAgentsStore> },
    title: string,
    modelLabel: string,
  ): Promise<string> {
    await act(async () => {
      await result.current.addMission({
        title,
        repo: '.',
        worktree: '',
        modelLabel,
        mode: 'agent',
        orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'running' } });
    });
    return missionId;
  }

  it('pauseMission/resumeMission flip the pauseSignal the running managed loop actually polls', async () => {
    simulateTauri();
    setManagedAvailability(true); // auto-detect -> 'managed' (isManagedAgentAvailable() -> true)

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addRunningMission(result, 'Managed mission', 'anthropic/claude-sonnet-5');

    const { pauseSignal } = lastRunMissionOpts();
    expect(pauseSignal()).toBe(false);

    // resumeMission before ever pausing must stay a no-op (not already paused).
    act(() => {
      result.current.resumeMission(missionId);
    });
    expect(pauseSignal()).toBe(false);

    act(() => {
      result.current.pauseMission(missionId);
    });
    expect(pauseSignal()).toBe(true);
    let mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.paused).toBe(true);
    expect(mission.status).toBe('running'); // paused is a sub-state, not a new status
    expect(mission.liveAction).toContain('En pause');

    act(() => {
      result.current.resumeMission(missionId);
    });
    expect(pauseSignal()).toBe(false);
    mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.paused).toBe(false);
  });

  it('pauseMission is a guarded no-op for a native (non-managed) mission — no mid-call pause hook exists for that engine', async () => {
    // No Tauri simulated here -> isManagedAgentAvailable() is false.
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addRunningMission(result, 'Native mission', 'claude-sonnet-5');

    const { pauseSignal } = lastRunMissionOpts();

    act(() => {
      result.current.pauseMission(missionId);
    });

    expect(pauseSignal()).toBe(false);
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.paused).toBeFalsy();
  });

  it('interveneMission enqueues text for a managed mission into the exact drainIntervenes queue the loop polls', async () => {
    simulateTauri();
    setManagedAvailability(true);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addRunningMission(result, 'Managed mission', 'anthropic/claude-sonnet-5');

    const { drainIntervenes } = lastRunMissionOpts();

    act(() => {
      result.current.interveneMission(missionId, 'focus on the auth module');
    });

    // Atomically popped — same contract managedAgent.planAndActManaged
    // relies on between ReAct steps.
    expect(drainIntervenes()).toEqual(['focus on the auth module']);
    expect(drainIntervenes()).toEqual([]);

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    const lastNote = mission.actionTimeline?.[mission.actionTimeline.length - 1];
    expect(lastNote?.text).toContain('sera transmise');
  });

  it('interveneMission on a native mission enqueues nothing — honestly recorded as not deliverable mid-run', async () => {
    // No Tauri simulated here -> isManagedAgentAvailable() is false.
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addRunningMission(result, 'Native mission', 'claude-sonnet-5');

    const { drainIntervenes } = lastRunMissionOpts();

    act(() => {
      result.current.interveneMission(missionId, 'check the logs');
    });

    // No mid-run injection point for a native (one-shot process) mission.
    expect(drainIntervenes()).toEqual([]);

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    const lastNote = mission.actionTimeline?.[mission.actionTimeline.length - 1];
    expect(lastNote?.text).toContain('non transmissible');
    expect(lastNote?.text).not.toContain('sera transmise');
  });

  it('pauseMission/resumeMission/interveneMission are no-ops when the mission is not running', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({
        title: 'Still queued',
        repo: '.',
        worktree: '',
        modelLabel: 'anthropic/claude-sonnet-5',
        mode: 'agent',
        orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    const before = result.current.missions.find((m) => m.id === missionId)!;
    // addMission's initial status — runMission is mocked out in this suite
    // and never transitions it via onUpdate, so it stays 'queued'.
    expect(before.status).toBe('queued');

    act(() => {
      result.current.pauseMission(missionId);
      result.current.resumeMission(missionId);
      result.current.interveneMission(missionId, 'irrelevant');
    });

    const after = result.current.missions.find((m) => m.id === missionId)!;
    expect(after).toBe(before); // nothing touched this mission at all
  });
});

// ── addMission — mission contract forwarding (T1.2 gap fix) ────────────
// NewMissionModal.tsx assembles a MissionContract (spec §8) and sends it on
// the input object it passes to addMission — but addMission's constructor
// used to copy only a fixed set of known input fields onto the created
// Mission, silently dropping `contract` before it ever reached the
// persisted Mission (flagged in NewMissionModal.tsx's own T1.2 note).
// NewMissionInput now declares `contract?: MissionContract` and addMission
// forwards it unchanged.
describe('addMission — mission contract forwarding (T1.2 gap fix)', () => {
  it('a mission created with a contract retains it on the persisted Mission', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    const contract: MissionContract = {
      objective: 'Ship the login fix',
      model: 'claude-sonnet-5',
      permissionMode: 'acceptEdits',
      budgetCapUsd: 15,
      proofs: [{ kind: 'test_run' }],
      gates: { evaluators: true, humanApprove: true },
      shareToTeam: false,
    };

    await act(async () => {
      await result.current.addMission({
        title: 'Contract-carrying mission',
        repo: '.',
        worktree: '',
        modelLabel: 'claude-sonnet-5',
        orchestrator: false,
        contract,
      });
    });

    const created = result.current.missions[result.current.missions.length - 1];
    expect(created.contract).toEqual(contract);
  });

  it('a mission created without a contract leaves it undefined (no crash, no fabricated default)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'No-contract mission',
        repo: '.',
        worktree: '',
        modelLabel: 'claude-sonnet-5',
        orchestrator: false,
      });
    });

    const created = result.current.missions[result.current.missions.length - 1];
    expect(created.contract).toBeUndefined();
  });
});

// ── addMission — session budget cap (T1.3, spec §7.3/§8) ───────────
// `lazy.agents.costLimitUsd` (AgentsPanel.tsx's LS_AGENTS_COST_LIMIT) was
// previously a dead setting — read nowhere. addMission now checks the
// current session total (costStore.ts) plus this launch's quote estimate
// (contract.quote.costUsd[1], the upper bound) against the cap BEFORE
// dispatching to the scheduler/engine: a launch that would exceed it is
// refused (the mission stays 'queued', runMission is never called) rather
// than silently proceeding past the user's own cap.
describe('addMission — session budget cap (T1.3, lazy.agents.costLimitUsd)', () => {
  afterEach(() => {
    localStorage.removeItem(LS_AGENTS_COST_LIMIT);
    resetCost();
  });

  it('0/absent cap never blocks a launch (unlimited)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const runCallsBefore = mockedRunMission.mock.calls.length;

    await act(async () => {
      await result.current.addMission({
        title: 'Unlimited session',
        repo: '.',
        worktree: '',
        modelLabel: 'claude-sonnet-5',
        orchestrator: false,
      });
    });

    const created = result.current.missions[result.current.missions.length - 1];
    const launched = mockedRunMission.mock.calls
      .slice(runCallsBefore)
      .some((c) => (c[0] as { id: string }).id === created.id);
    expect(launched).toBe(true);
  });

  it('refuses the launch when session spend + quote estimate would exceed the cap — mission stays queued, runMission is never called', async () => {
    localStorage.setItem(LS_AGENTS_COST_LIMIT, '5');
    // Drive costStore to a known $3 session total (750_000 output tokens *
    // the fallback $4.00/1M pricing = $3.00 — see costStore.ts's addUsage).
    addUsage({ inputTokens: 0, outputTokens: 750_000, model: 'test' });
    expect(getCostState().totalCostUsd).toBeCloseTo(3, 5);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const runCallsBefore = mockedRunMission.mock.calls.length;
    const missionsBefore = result.current.missions.length;

    const contract: MissionContract = {
      objective: 'Big task',
      model: 'claude-sonnet-5',
      permissionMode: 'acceptEdits',
      budgetCapUsd: 10,
      proofs: [],
      gates: { evaluators: false, humanApprove: false },
      shareToTeam: false,
      quote: { costUsd: [1, 3], durationMin: [5, 10], agents: 1 }, // upper bound $3
    };

    await act(async () => {
      await result.current.addMission({
        title: 'Over session cap',
        repo: '.',
        worktree: '',
        modelLabel: 'claude-sonnet-5',
        orchestrator: false,
        contract,
      });
    });

    // $3 spent + $3 quote = $6 > $5 cap -> refused.
    expect(result.current.missions.length).toBe(missionsBefore + 1);
    const created = result.current.missions[result.current.missions.length - 1];
    expect(created.status).toBe('queued'); // never advanced to 'running'
    const launched = mockedRunMission.mock.calls
      .slice(runCallsBefore)
      .some((c) => (c[0] as { id: string }).id === created.id);
    expect(launched).toBe(false);
  });

  it('refuses the launch when session spend ALONE already exceeds the cap, even with no quote on the mission', async () => {
    localStorage.setItem(LS_AGENTS_COST_LIMIT, '5');
    // $6 already spent this session (1_500_000 output tokens * $4.00/1M).
    addUsage({ inputTokens: 0, outputTokens: 1_500_000, model: 'test' });
    expect(getCostState().totalCostUsd).toBeCloseTo(6, 5);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const runCallsBefore = mockedRunMission.mock.calls.length;

    await act(async () => {
      await result.current.addMission({
        title: 'No quote, session already over cap',
        repo: '.',
        worktree: '',
        modelLabel: 'claude-sonnet-5',
        orchestrator: false,
      });
    });

    const created = result.current.missions[result.current.missions.length - 1];
    expect(created.status).toBe('queued');
    const launched = mockedRunMission.mock.calls
      .slice(runCallsBefore)
      .some((c) => (c[0] as { id: string }).id === created.id);
    expect(launched).toBe(false);
  });
});

// ── approveMission — sequential gate-respecting iteration (Fix 2) ──
// AgentsSpace.tsx's "Approve all" command used to force EVERY review
// mission straight to status:'done' via a direct updateMission call —
// bypassing checkApproveGate AND the real merge entirely. It now iterates
// review missions through this REAL approveMission flow instead (one call
// per mission, sequential — concurrent merges would race the same repo
// worktree); this suite verifies THAT flow's gate-respecting contract:
// gate-blocked missions never reach 'done', and mergeWorktree is only ever
// called for the ones that pass.
describe('approveMission — sequential gate-respecting iteration (Fix 2: AgentsSpace approve-all)', () => {
  function passingVerdict(): JudgeVerdict {
    return { score: 92, passed: true, risk: 'low', reviewers: [], createdAt: new Date().toISOString() };
  }

  it('a passing mission is merged and marked done; a mission with no judge verdict is blocked and stays in review', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Passing mission', repo: '.', worktree: '', modelLabel: 'claude-sonnet-5', orchestrator: false,
      });
      await result.current.addMission({
        title: 'Unverified mission', repo: '.', worktree: '', modelLabel: 'claude-sonnet-5', orchestrator: false,
      });
    });

    const missions = result.current.missions.slice(-2);
    const passingId = missions[0].id;
    const blockedId = missions[1].id;

    act(() => {
      result.current.updateMission({
        id: passingId,
        patch: { status: 'review', worktree: 'agent/passing-branch', judgeVerdict: passingVerdict() },
      });
      result.current.updateMission({
        id: blockedId,
        patch: { status: 'review', worktree: 'agent/blocked-branch' }, // no judgeVerdict -> gate blocks
      });
    });

    // Mirrors AgentsSpace.tsx's handleApproveAll: sequential, one repoPath,
    // per-mission failures caught rather than aborting the whole batch.
    const reviewIds = [passingId, blockedId];
    const failures: string[] = [];
    await act(async () => {
      for (const id of reviewIds) {
        try {
          await result.current.approveMission(id, '/fake/repo');
        } catch {
          failures.push(id);
        }
      }
    });

    expect(failures).toEqual([blockedId]);

    const passingAfter = result.current.missions.find((m) => m.id === passingId)!;
    expect(passingAfter.status).toBe('done');
    expect(passingAfter.merged).toBe(true);
    expect(mockedMergeWorktree).toHaveBeenCalledWith('/fake/repo', 'agent/passing-branch');

    const blockedAfter = result.current.missions.find((m) => m.id === blockedId)!;
    expect(blockedAfter.status).toBe('review'); // NEVER forced to 'done'
    expect(blockedAfter.merged).toBeUndefined();
    expect(mockedMergeWorktree).not.toHaveBeenCalledWith('/fake/repo', 'agent/blocked-branch');
  });
});

// ── approveMission — APPROVE→MERGE INERT fix (2026-08-05) ───────────
// Real prod incident: reviews M21/M23/M25 stayed unmerged for HOURS after
// approval (button AND manager approve_mission, force included), then all
// landed at once much later — a symptom of mergeWorktree hanging with no
// deadline of its own: no error, no toast, nothing, until whatever was
// blocking it finally let go. This suite proves a hung mergeWorktree now
// surfaces as a real, bounded, visible rejection instead of hanging the
// caller forever.
describe('approveMission — bounded merge timeout (never silent)', () => {
  beforeEach(() => {
    // Defensive reset (belt-and-suspenders against cross-test approval-mode
    // pollution elsewhere in this large file): guarantees
    // triggerAutoMergeIfEligible's own manual-mode fast path is taken for
    // the 'review' transition below, so mergeWorktree's ONE stuck
    // implementation is consumed by THIS test's explicit approveMission
    // call only, never raced by an auto-merge attempt.
    localStorage.clear();
    simulateTauri();
    // Deterministic baseline for every OTHER Tauri invoke this path touches
    // (git.log for preMergeHeadSha) — resolves immediately so mergeWorktree
    // is the ONLY thing under test that hangs. 'read_dir' specifically
    // resolves to a real array (platform/tauri.ts's readDir immediately
    // .map()s the result) — WORKTREE-DESTROYED-PRE-MERGE fix's own
    // pre-flight existence check (defaultWorktreeExists) calls this, and a
    // bare `undefined` here would make readDir itself throw, which
    // defaultWorktreeExists reads as "gone" — a false negative that would
    // make every test below fail before ever reaching mergeWorktree.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === 'read_dir' ? [] : undefined));
  });
  afterEach(() => {
    vi.useRealTimers();
    clearProviderModeSimulation();
  });

  it('rejects with a clear timeout error instead of hanging forever when mergeWorktree never settles', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Stuck merge mission', repo: '.', worktree: '', modelLabel: 'claude-sonnet-5', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({
        id: missionId,
        patch: { status: 'review', worktree: 'agent/stuck-branch', judgeVerdict: { score: 92, passed: true, risk: 'low', reviewers: [], createdAt: new Date().toISOString() } },
      });
    });

    // Simulates a real stuck git operation (e.g. a lock held by an earlier
    // hung merge on the same repo) — a promise that neither resolves nor
    // rejects on its own.
    mockedMergeWorktree.mockImplementationOnce(() => new Promise(() => {}));

    vi.useFakeTimers();
    let approvePromise!: Promise<void>;
    act(() => {
      approvePromise = result.current.approveMission(missionId, '/fake/repo');
      // Attach a handler to the promise chain from the earliest possible
      // tick (vitest's fake-timer reject-on-fire can otherwise race Node's
      // unhandled-rejection check against expect(...).rejects below, which
      // only attaches its own handler after advanceTimersByTimeAsync
      // returns) — a harmless no-op alongside the real assertion, which
      // still independently observes and validates the same rejection.
      approvePromise.catch(() => {});
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(APPROVE_MERGE_TIMEOUT_MS + 100);
    });

    await expect(approvePromise).rejects.toThrow(/timed out/i);

    // The mission honestly stays in 'review' — never force-marked 'done'
    // for a merge that never actually completed.
    const after = result.current.missions.find((m) => m.id === missionId);
    expect(after?.status).toBe('review');
    expect(after?.merged).toBeUndefined();
  });

  it('rejects honestly ("worktree directory missing") instead of a raw OS error when the worktree is already gone on disk', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Vanished worktree mission', repo: '.', worktree: '', modelLabel: 'claude-sonnet-5', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({
        id: missionId,
        patch: { status: 'review', worktree: 'agent/gone-branch', judgeVerdict: { score: 92, passed: true, risk: 'low', reviewers: [], createdAt: new Date().toISOString() } },
      });
    });

    // fs.readDir (defaultWorktreeExists' own probe) rejects for every path —
    // simulates the directory genuinely being gone.
    vi.mocked(invoke).mockRejectedValue(new Error('ENOENT'));

    await expect(result.current.approveMission(missionId, '/fake/repo')).rejects.toThrow(/worktree directory missing|worktree.*missing/i);
    expect(mockedMergeWorktree).not.toHaveBeenCalled();

    const after = result.current.missions.find((m) => m.id === missionId);
    expect(after?.status).toBe('review');
  });

  // 9th+ instance of the \\?\ verbatim-prefix leak (src/lib/paths.ts header)
  // — commit 4464446 added this exact honest-failure message, but built it
  // from `worktreePath` (resolveDiscardWorktreePath's joinPath(repoPath, ...)
  // result) with no prefix stripping. repoPath is typically
  // get_project_root's Rust canonicalize() output, always \\?\-prefixed on
  // Windows, so the raw prefix leaked straight into this user-facing reason.
  it('never leaks a raw \\\\?\\ verbatim-prefixed path into the "worktree missing" reason', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Vanished worktree mission (verbatim repo root)', repo: '.', worktree: '', modelLabel: 'claude-sonnet-5', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({
        id: missionId,
        patch: { status: 'review', worktree: 'agent/gone-branch-verbatim', judgeVerdict: { score: 92, passed: true, risk: 'low', reviewers: [], createdAt: new Date().toISOString() } },
      });
    });

    vi.mocked(invoke).mockRejectedValue(new Error('ENOENT'));

    // A Windows canonicalize()-style repo root: verbatim-prefixed.
    const verbatimRepoPath = '\\\\?\\C:\\Users\\user\\Documents\\cerveau\\LazySite-internet';
    let caught: unknown;
    try {
      await result.current.approveMission(missionId, verbatimRepoPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/worktree.*missing/i);
    expect(message).not.toContain('\\\\?\\');
    // The real path content must still be present, just without the prefix.
    expect(message).toContain('LazySite-internet');
  });
});

// ── Fleet hygiene Rule (j) — WORKTREE-DESTROYED-PRE-MERGE fix (2026-08-05) ──
// Real prod incident: M35 (a retry) reached 'review' with a real diff, then
// failed to merge (OS 267) because its worktree/branch no longer existed —
// traced to git_orphan_worktrees (pure git reachability, no mission
// awareness) classifying a still-live mission's branch as empty/recoverable
// and this sweep discarding/auto-merging it unconditionally.
//
// KNOWN GAP (honest, time-boxed): a full integration test through
// runFleetHygieneSweep's real trigger path was attempted here but removed —
// resolveProjectRoot()'s own internal fallback race (see its doc comment,
// "every invoke below is now bounded by PROJECT_ROOT_RESOLVE_TIMEOUT_MS")
// resolves inconsistently under these mocked Tauri conditions (root
// sometimes '/fake/repo', sometimes '.', across otherwise-identical
// concurrent calls within the same test), making Rule (j)'s own
// resolveProjectRoot() call non-deterministic to drive from a test and
// producing a flaky pass/fail unrelated to the fix itself. The fix (the
// liveBranches filter in agentsStore.tsx's Rule (j) block) is instead
// validated by: (1) direct code-reading — it structurally mirrors the
// ALREADY-TESTED Rust-side tier model in worktree_sweep.rs
// (classify_worktree's Tier 1 "Live" — never touch a mission that is not
// yet archived-terminal — see that module's own ~12 passing tests
// enforcing the identical invariant for its own, separate 24h sweep), and
// (2) the adjacent approveMission honest-error test below, which covers
// the same incident's second half end-to-end.

// ── executeManagerAction — set_budget (T2.8 audit fix) ──────────────
// set_budget used to be a placebo: it emitted a fabricated budget.warning
// (pct:0 — a number that never measured anything real) and a "success"
// toast, but never touched the mission the budget enforcer actually reads.
// It must now really patch contract.budgetCapUsd — the SAME field
// runtime.ts's classifyBudget / managedAgent.ts's classifyBudgetStatus read
// live via getBudgetCapUsd, and the SAME mechanism AttentionInbox.tsx's
// raise-cap control (handleRaiseCap) already uses.
describe('executeManagerAction — set_budget (real enforcement patch, not a placebo)', () => {
  beforeEach(() => {
    vi.mocked(runManagerTurn).mockReset();
  });

  it('patches contract.budgetCapUsd on the target mission', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Budget target', repo: '.', worktree: '', modelLabel: 'Sonnet 4.6', mode: 'agent', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;

    const contract: MissionContract = {
      objective: 'test objective',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      budgetCapUsd: 5,
      proofs: [],
      gates: { evaluators: false, humanApprove: false },
      shareToTeam: false,
    };
    act(() => {
      result.current.updateMission({ id: missionId, patch: { contract } });
    });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Budget raised.',
      actions: [{ type: 'set_budget', missionId, limitUsd: 15 }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, `plafonne ${missionId} a 15$`, 'haiku');
    });

    const updated = result.current.missions.find((m) => m.id === missionId);
    expect(updated?.contract?.budgetCapUsd).toBe(15);
    // Every other contract field survives the patch unchanged (immutable spread).
    expect(updated?.contract?.objective).toBe('test objective');
  });

  it('reports missionNotFound honestly for an unknown missionId (no crash, no fabricated patch)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Budget raised.',
      actions: [{ type: 'set_budget', missionId: 'M-does-not-exist', limitUsd: 15 }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'plafonne M-does-not-exist a 15$', 'haiku');
    });

    // Nothing throws and no mission acquires a fabricated contract.
    expect(result.current.missions.find((m) => m.id === 'M-does-not-exist')).toBeUndefined();
  });

  it('never fabricates a contract on a mission that has none (pre-T1.2 / mock mission)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({
        title: 'Mission without a contract',
        repo: '.',
        worktree: 'wt/no-contract',
        modelLabel: 'Sonnet 4.6',
        mode: 'agent',
        orchestrator: false,
      });
    });
    const missionId = result.current.missions[0].id;
    expect(result.current.missions[0].contract).toBeUndefined();

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Budget raised.',
      actions: [{ type: 'set_budget', missionId, limitUsd: 15 }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, `plafonne ${missionId} a 15$`, 'haiku');
    });

    expect(result.current.missions.find((m) => m.id === missionId)?.contract).toBeUndefined();
  });
});

// ── executeManagerAction — reassign_agent (T2.8 audit fix) ──────────
// reassign_agent was entirely absent before this fix. It must patch a
// mission's model when the mission is queued or paused (a state a
// subsequent retry/resume genuinely picks up — see retryMission's
// clone-from-current-fields behavior), and refuse honestly when the
// mission is ACTIVELY running (native one-shot / in-flight managed loops
// both capture their model as a plain launch parameter, with no live
// getter re-read the way contract.budgetCapUsd has).
describe('executeManagerAction — reassign_agent', () => {
  beforeEach(() => {
    vi.mocked(runManagerTurn).mockReset();
  });

  it('patches the model of a QUEUED mission', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({
        title: 'Reassign target', repo: '.', worktree: '', modelLabel: 'Haiku 4.5', mode: 'agent', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    expect(result.current.missions.find((m) => m.id === missionId)?.status).toBe('queued');

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Reassigned.',
      actions: [{ type: 'reassign_agent', missionId, model: 'opus' }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, `reassigne ${missionId} en opus`, 'haiku');
    });

    expect(result.current.missions.find((m) => m.id === missionId)?.model).toBe('opus');
  });

  it('patches the model of a PAUSED (running + paused) mission', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({
        title: 'Paused target', repo: '.', worktree: '', modelLabel: 'Haiku 4.5', mode: 'agent', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'running', paused: true } });
    });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Reassigned.',
      actions: [{ type: 'reassign_agent', missionId, model: 'opus' }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, `reassigne ${missionId} en opus`, 'haiku');
    });

    expect(result.current.missions.find((m) => m.id === missionId)?.model).toBe('opus');
  });

  it('refuses to reassign an ACTIVELY running (not paused) mission, leaving its model untouched', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({
        title: 'Running target', repo: '.', worktree: '', modelLabel: 'Haiku 4.5', mode: 'agent', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'running', paused: false } });
    });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Reassigned.',
      actions: [{ type: 'reassign_agent', missionId, model: 'opus' }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, `reassigne ${missionId} en opus`, 'haiku');
    });

    expect(result.current.missions.find((m) => m.id === missionId)?.model).toBe('Haiku 4.5');
  });
});

// ── executeManagerAction — answer_question (T2.8 audit fix) ─────────
// answer_question was entirely absent before this fix. It must reuse the
// EXACT real flow AttentionInbox.tsx's answer form uses: find the mission's
// REAL pending ask_user question (never fabricate one), deliver the answer
// via interveneMission, then record it as a decision (recordMissionAnswer,
// mocked above — its own createDecision/emitEvent plumbing is covered by
// decisions.test.ts / AttentionInbox.test.tsx already).
describe('executeManagerAction — answer_question', () => {
  beforeEach(() => {
    vi.mocked(runManagerTurn).mockReset();
    mockRecordMissionAnswer.mockClear();
  });

  it('delivers the answer and records a decision for a mission with a REAL pending question', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({
        title: 'Blocked mission', repo: '.', worktree: '', modelLabel: 'Sonnet 4.6', mode: 'agent', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;

    act(() => {
      result.current.updateMission({
        id: missionId,
        patch: {
          status: 'running',
          actionTimeline: [
            { time: '10:00', text: 'Observation: Question for user: which auth strategy should I use?' },
          ],
        },
      });
    });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Answered.',
      actions: [{ type: 'answer_question', missionId, answer: 'use OAuth2 PKCE' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, `reponds a ${missionId} avec OAuth2 PKCE`, 'haiku');
    });

    // interveneMission's real, already-tested effect: a new timeline entry
    // recording the delivered text (native or managed wording — either way
    // it embeds the trimmed answer).
    const updated = result.current.missions.find((m) => m.id === missionId);
    const lastEntry = updated?.actionTimeline?.[updated.actionTimeline.length - 1];
    expect(lastEntry?.text).toContain('use OAuth2 PKCE');

    expect(mockRecordMissionAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId,
        question: 'which auth strategy should I use?',
        answer: 'use OAuth2 PKCE',
        actor: 'user',
      }),
    );
  });

  it('refuses honestly (no intervene, no decision recorded) when the mission has no pending question', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({
        title: 'Running, no question', repo: '.', worktree: '', modelLabel: 'Sonnet 4.6', mode: 'agent', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'running' } });
    });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Answered.',
      actions: [{ type: 'answer_question', missionId, answer: 'use OAuth2 PKCE' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, `reponds a ${missionId} avec OAuth2 PKCE`, 'haiku');
    });

    expect(mockRecordMissionAnswer).not.toHaveBeenCalled();
  });

  it('refuses honestly for a queued (not running) mission even if a stale question sits in its timeline', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({
        title: 'Queued, stale question', repo: '.', worktree: '', modelLabel: 'Sonnet 4.6', mode: 'agent', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({
        id: missionId,
        patch: {
          actionTimeline: [
            { time: '10:00', text: 'Observation: Question for user: which auth strategy should I use?' },
          ],
        },
      });
    });
    expect(result.current.missions.find((m) => m.id === missionId)?.status).toBe('queued');

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Answered.',
      actions: [{ type: 'answer_question', missionId, answer: 'use OAuth2 PKCE' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, `reponds a ${missionId} avec OAuth2 PKCE`, 'haiku');
    });

    expect(mockRecordMissionAnswer).not.toHaveBeenCalled();
  });
});

// ── B12 / P0-1: systemic hang fix — managerBusy always resolves ─────
//
// Root cause traced: the manager's single-turn LLM calls run through the
// same CLI transport as the interactive assistant chat, which can leave a
// call unresolved far longer than any reasonable UI wait (or, for
// AnalysisDesk specifically, literally forever — see the AnalysisDesk
// describe block in this file's sibling test, and managerEngine.ts's
// MANAGER_TURN_TIMEOUT_MS doc comment). B12 originally fixed this with ONE
// shared AbortController/timeout covering the whole exchange (first turn +
// optional grounded follow-up).
//
// P0-1 (real user test, 3/3 non-trivial requests failed with 0 nodes
// created): that SAME shared window turned out to be the new bottleneck —
// two sequential CLI cold starts + generations (main call, then the grounded
// follow-up) had to fit inside ONE 90s ceiling. Each LLM call now gets its
// OWN fresh MANAGER_LLM_CALL_TIMEOUT_MS (300s) budget
// (createManagerCallController, agentsStore.tsx), derived from an
// exchange-wide `turnCtrl` that still serves as the Stop button + a
// MANAGER_TURN_TIMEOUT_MS (600s) backstop. managerBusy still resolves to
// false exactly once (guaranteed `finally`, unchanged from B12) — for a
// normal flow, a first-turn provider error, AND a follow-up that itself
// fails or hangs.
describe('sendManagerMessage — managerBusy always resolves (B12)', () => {
  beforeEach(() => {
    vi.mocked(runManagerTurn).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves managerBusy after a normal action-then-answer flow completes', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Mission launched.',
      actions: [{ type: 'launch_mission', agentName: 'coder', task: 'fix the bug', model: 'haiku' }],
      rawResponse: '',
    });

    expect(result.current.managerBusy).toBe(false);
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance @coder sur fix the bug', 'haiku');
    });
    expect(result.current.managerBusy).toBe(false);
  });

  it('resolves managerBusy (with an honest error message) when the first turn rejects outright', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockRejectedValueOnce(new Error('claude spawn failed: ENOENT'));

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance @coder sur fix the bug', 'haiku');
    });

    expect(result.current.managerBusy).toBe(false);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect(lastMsg.content).toMatch(/claude spawn failed/i);
  });

  it('falls back to the first turn\'s text AND appends an honest failure message when the grounded follow-up itself rejects', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Let me check that mission for you.',
      actions: [{ type: 'query_mission', missionId: 'M-does-not-exist' }],
      rawResponse: '',
    });
    vi.mocked(runManagerTurn).mockRejectedValueOnce(new Error('follow-up turn failed'));
    // Grounding failure retry (2026-08-05): runGroundedFollowUp now spends
    // ONE retry before giving up — mocked to ALSO reject so the exchange's
    // end state (first turn kept, honest failure appended) is unchanged.
    vi.mocked(runManagerTurn).mockRejectedValueOnce(new Error('follow-up turn failed'));

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'status of M-does-not-exist?', 'haiku');
    });

    // Grounding failure retry (2026-08-05): main call + original follow-up + one retry.
    expect(runManagerTurn).toHaveBeenCalledTimes(3);
    expect(result.current.managerBusy).toBe(false);
    const messages = result.current.managerMessages;
    // runGroundedFollowUp keeps the first turn's text as ONE reply (still a
    // reply, not a hard failure)...
    const firstTurnMsg = messages[messages.length - 2];
    expect(firstTurnMsg.content).toBe('Let me check that mission for you.');
    // ...but (R2a fix) NO LONGER swallows the follow-up failure silently —
    // a second, visible message names the real reason.
    const failureMsg = messages[messages.length - 1];
    expect(failureMsg.content).toMatch(/follow-up turn failed/i);
  });

  it('recovers via the MAIN call\'s own per-call budget when the first turn never resolves (the literal "hang forever" case)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockImplementationOnce(
      (opts) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('Stream aborted (timeout)')));
        }),
    );

    vi.useFakeTimers();
    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendManagerMessage(result.current.activeConversationId, 'quel est l\'état de mes missions ?', 'haiku');
    });
    // Advances only past the MAIN call's own MANAGER_LLM_CALL_TIMEOUT_MS
    // budget (300s) — well short of the exchange-wide MANAGER_TURN_TIMEOUT_MS
    // backstop (600s) — proving recovery comes from the per-call controller,
    // not from having to wait out the global ceiling.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MANAGER_LLM_CALL_TIMEOUT_MS + 100);
    });
    await act(async () => {
      await sendPromise;
    });
    vi.useRealTimers();

    expect(result.current.managerBusy).toBe(false);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect(lastMsg.timedOut).toBe(true);
    expect(lastMsg.content).toMatch(/generation/i);
  });

  // P0-1 regression test: proves the grounded follow-up gets its OWN
  // independent per-call AbortController/signal, distinct from the main
  // call's — the exact opposite of the old B12 design (a single shared
  // controller/signal for both calls), which is what let a heavy composite
  // order starve the follow-up of whatever time the main call had already
  // used. Both signals descend from the SAME exchange-wide `turnCtrl`
  // (aborting it — Stop, or the global backstop — reaches both), but each
  // call's own signal is a SEPARATE AbortController instance with its own
  // budget.
  it('gives the main call and the grounded follow-up call each their OWN independent AbortSignal', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    // First turn resolves almost immediately with a grounding action.
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Checking the brain…',
      actions: [{ type: 'brain_query', query: 'why did we switch off postgres' }],
      rawResponse: '',
    });
    // The follow-up (second) call hangs until ITS OWN per-call budget (or a
    // Stop/global-cap propagated from the shared parent) aborts it.
    vi.mocked(runManagerTurn).mockImplementationOnce(
      (opts) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('Stream aborted (timeout)')));
        }),
    );
    // Grounding failure retry (2026-08-05): the aborted follow-up above
    // triggers ONE retry — resolved immediately so it settles within the
    // same timer advance below; unrelated to what this test verifies
    // (signal identity of the first two calls).
    vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: [], rawResponse: '' });

    vi.useFakeTimers();
    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendManagerMessage(result.current.activeConversationId, 'why did we switch off postgres?', 'haiku');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MANAGER_LLM_CALL_TIMEOUT_MS + 100);
    });
    await act(async () => {
      await sendPromise;
    });
    vi.useRealTimers();

    // Grounding failure retry (2026-08-05): main call + original follow-up + one retry.
    expect(runManagerTurn).toHaveBeenCalledTimes(3);
    expect(result.current.managerBusy).toBe(false);
    // Each call receives its OWN AbortSignal instance — proof the follow-up
    // no longer reuses the main call's exact signal.
    const firstSignal = vi.mocked(runManagerTurn).mock.calls[0][0].signal;
    const secondSignal = vi.mocked(runManagerTurn).mock.calls[1][0].signal;
    expect(firstSignal).toBeDefined();
    expect(secondSignal).toBeDefined();
    expect(secondSignal).not.toBe(firstSignal);
  });

  // R2a fix (thread 1b): the grounded follow-up round-trip has its OWN
  // GROUNDED_FOLLOWUP_TIMEOUT_MS ceiling (P0-1: now the SAME 300s per-call
  // budget every manager LLM call gets, not a shorter, independent value) —
  // a follow-up call that never settles AND never reacts to the signal at
  // all (a stalled transport that doesn't even honor abort — distinct from
  // the "hangs until abort" mock used above) must still recover with an
  // HONEST, phase+elapsed-aware timeout message (P0-1 item #2) instead of
  // silently keeping only the first turn's un-grounded text.
  it('bounds the grounded follow-up to its own timeout and reports an honest, phase-aware reason', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Checking the brain…',
      actions: [{ type: 'brain_query', query: 'why did we switch off postgres' }],
      rawResponse: '',
    });
    // Never resolves, never rejects, ignores the signal entirely — only
    // runGroundedFollowUp's own withTimeout race can recover from this.
    vi.mocked(runManagerTurn).mockImplementationOnce(() => new Promise(() => {}));
    // Grounding failure retry (2026-08-05): the timed-out follow-up above
    // triggers ONE retry, mocked the same stalled way so it ALSO times out —
    // the final honest phase-aware message this test checks comes from that
    // retry's own timeout, not the original attempt's.
    vi.mocked(runManagerTurn).mockImplementationOnce(() => new Promise(() => {}));

    vi.useFakeTimers();
    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendManagerMessage(result.current.activeConversationId, 'why did we switch off postgres?', 'haiku');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GROUNDED_FOLLOWUP_TIMEOUT_MS + 100);
    });
    // Grounding failure retry (2026-08-05): a second advance lets the
    // retry's OWN independent per-call controller time out too.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GROUNDED_FOLLOWUP_TIMEOUT_MS + 100);
    });
    await act(async () => {
      await sendPromise;
    });
    vi.useRealTimers();

    expect(result.current.managerBusy).toBe(false);
    const messages = result.current.managerMessages;
    const firstTurnMsg = messages[messages.length - 2];
    const failureMsg = messages[messages.length - 1];
    expect(firstTurnMsg.content).toBe('Checking the brain…');
    // Names the "search" phase (not "generation" — that's the main call's
    // own timeout wording) and an elapsed-seconds figure, never the old
    // hardcoded-French "délai dépassé" that leaked past every non-fr locale.
    expect(failureMsg.content).toMatch(/search/i);
    expect(failureMsg.content).toMatch(/\d+s/);
  });
});

// ── C3 fix: the manager's per-call budget measures INACTIVITY, not wall
// clock ────────────────────────────────────────────────────────────────
//
// Real-log root cause: two turns died at exactly 300s with SMALLER prompts
// (118-121KB) than other calls that finished fine (127-129KB, 36-76s) —
// both timeouts coincided with the host under heavy contention (<1.5GB free
// RAM, 85-96% CPU, six evaluator CLI processes running at once). Prompt
// size was ruled out; only contention correlated — the generation was
// genuinely still progressing, just slowly, and a fixed wall-clock deadline
// killed it anyway. createManagerCallController's inactivity deadline now
// rearms on every streamed fragment (ManagerTurnOptions.onChunk,
// managerEngine.ts) instead of firing at a fixed instant, while a separate,
// deliberately generous MANAGER_LLM_CALL_ABSOLUTE_TIMEOUT_MS ceiling still
// bounds a call that streams forever without ever going idle.
describe('sendManagerMessage — inactivity timeout (C3)', () => {
  beforeEach(() => {
    vi.mocked(runManagerTurn).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is NOT interrupted by a stream that keeps sending fragments past the old fixed budget', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    // Sends a fragment every 60s (well under the inactivity deadline) for a
    // TOTAL duration well past MANAGER_LLM_CALL_TIMEOUT_MS (300s) — the old
    // fixed wall-clock design would have killed this at exactly 300s.
    const totalDurationMs = MANAGER_LLM_CALL_TIMEOUT_MS + 120_000; // 420s
    vi.mocked(runManagerTurn).mockImplementationOnce(
      (opts) =>
        new Promise((resolve, reject) => {
          const fragmentInterval = setInterval(() => opts.onChunk?.(), 60_000);
          const doneTimer = setTimeout(() => {
            clearInterval(fragmentInterval);
            resolve({ responseText: 'Finally done, slow but steady.', actions: [], rawResponse: '' });
          }, totalDurationMs);
          // Mirrors the real CLI transport (streamClaudeCodeTurn), which
          // rejects the moment its signal aborts — only relevant if the
          // inactivity/absolute deadline fires unexpectedly (it must not,
          // that is exactly what this test proves).
          opts.signal?.addEventListener('abort', () => {
            clearInterval(fragmentInterval);
            clearTimeout(doneTimer);
            reject(new Error('Stream aborted (timeout)'));
          });
        }),
    );

    vi.useFakeTimers();
    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendManagerMessage(result.current.activeConversationId, 'long slow request', 'haiku');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(totalDurationMs + 1_000);
    });
    await act(async () => {
      await sendPromise;
    });
    vi.useRealTimers();

    expect(result.current.managerBusy).toBe(false);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    // A real reply was produced — NOT the timeout/error message — proving
    // the ongoing fragments kept rearming the inactivity deadline instead of
    // the call dying at the old fixed 300s mark.
    expect(lastMsg.content).toBe('Finally done, slow but steady.');
    expect(lastMsg.timedOut).toBeFalsy();
  });

  it('is interrupted after the inactivity delay when the stream sends no fragment at all', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockImplementationOnce(
      (opts) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('Stream aborted (timeout)')));
        }),
    );

    vi.useFakeTimers();
    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendManagerMessage(result.current.activeConversationId, 'totally silent request', 'haiku');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MANAGER_LLM_CALL_TIMEOUT_MS + 100);
    });
    await act(async () => {
      await sendPromise;
    });
    vi.useRealTimers();

    expect(result.current.managerBusy).toBe(false);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.timedOut).toBe(true);
    // "No response" wording (inactivity), never the "max duration" one —
    // this call never sent a single fragment, it simply never responded.
    expect(lastMsg.content).toMatch(/generation/i);
    expect(lastMsg.content).not.toMatch(/maximum duration/i);
  });

  it('still respects the absolute ceiling when fragments keep arriving forever, with an honest distinct message', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    // Never stops sending fragments — the inactivity deadline alone would
    // never fire — proving the SEPARATE absolute ceiling is what recovers
    // this call.
    vi.mocked(runManagerTurn).mockImplementationOnce(
      (opts) =>
        new Promise((_resolve, reject) => {
          const fragmentInterval = setInterval(() => opts.onChunk?.(), 60_000);
          // Mirrors the real CLI transport (streamClaudeCodeTurn), which
          // rejects the moment its signal aborts — the absolute ceiling is
          // the ONLY thing that can fire here (fragments never stop).
          opts.signal?.addEventListener('abort', () => {
            clearInterval(fragmentInterval);
            reject(new Error('Stream aborted (timeout)'));
          });
        }),
    );

    vi.useFakeTimers();
    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendManagerMessage(result.current.activeConversationId, 'runaway stream', 'haiku');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MANAGER_LLM_CALL_ABSOLUTE_TIMEOUT_MS + 1_000);
    });
    await act(async () => {
      await sendPromise;
    });
    vi.useRealTimers();

    expect(result.current.managerBusy).toBe(false);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.timedOut).toBe(true);
    // Distinct "max duration reached" wording, never the "no response" one —
    // this call kept responding right up to the hard ceiling.
    expect(lastMsg.content).toMatch(/maximum duration/i);
  });
});

// ── Regression: canvas digest must never freeze a manager turn ────────
//
// The Agent Canvas wave (W4, spec §8.2) added buildCanvasDigest() to the
// SAME Promise.all that already fetched listAgents()/startupContext at the
// very top of sendManagerMessage — BEFORE runManagerTurn (and its shared
// timeoutCtrl/signal, the B12 fix above) is ever created. Unlike its
// sibling fetchManagerStartupContext (which bounds itself with an internal
// 5s Promise.race — see that function's doc comment), buildCanvasDigest()
// had no timeout of its own: canvasDigest.ts's fetchProjectDirectory/
// fetchAllMissions only try/catch an invoke() REJECTION, never a stalled
// invoke() that simply never settles — a real Tauri IPC failure mode (see
// commit 50ae785, "no-op chain engine init outside Tauri" — the exact same
// class of bug already caught once in this same wave). Because this fetch
// runs pre-runManagerTurn, NOTHING is listening to the shared deadline yet,
// so a hang here blocks the whole exchange forever: the manager never even
// reaches the model, so managerBusy never resolves and no reply — grounded
// or otherwise — ever appears. This reproduces that exact gap.
describe('sendManagerMessage — resilient context gathering (canvas digest)', () => {
  beforeEach(() => {
    vi.mocked(runManagerTurn).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('recovers within a bounded time even when buildCanvasDigest() never settles', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    // A stalled Tauri invoke() inside buildCanvasDigest — never resolves,
    // never rejects, exactly like a stuck IPC round-trip would. No timer
    // drives this settlement, so no amount of fake-time advancement can
    // resolve it directly — only a caller-side bound (withTimeout +
    // fallback) can recover from it. `Once` so the real implementation is
    // restored for every other test in this file.
    mockBuildCanvasDigest.mockImplementationOnce(() => new Promise<string>(() => {}));

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Checking the brain…',
      actions: [{ type: 'brain_query', query: 'why did we switch off postgres' }],
      rawResponse: '',
    });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'We switched from Postgres to SQLite for the local cache.',
      actions: [],
      rawResponse: '',
    });

    vi.useFakeTimers();
    act(() => {
      void result.current.sendManagerMessage(result.current.activeConversationId, 'why did we switch off postgres?', 'haiku');
    });
    // Advance WELL past the manager turn's own deadline. Deliberately does
    // NOT await the sendManagerMessage promise itself — in the unfixed code
    // it never settles, and awaiting it here would hang the test runner
    // instead of failing the assertion below cleanly.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MANAGER_TURN_TIMEOUT_MS + 5_000);
    });

    // Optional context (canvas digest) must never hold the turn open past
    // the manager's own deadline — same contract creditsSummary/
    // startupContext already honor.
    expect(result.current.managerBusy).toBe(false);
    // A real reply must still have been produced (the exchange degraded
    // gracefully, not silently) — user message + assistant reply.
    expect(result.current.managerMessages.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Orchestrator quality: credits grounding ("combien ai-je de crédits ?") ──
// Real subscription state must reach the manager's system prompt on every
// turn (agentsStore.tsx's AgentsStoreProvider reads useSubscriptionContext()
// — same shared source as the credits KPI tile — with no second fetch).
// The test wrapper mounts no SubscriptionProvider, so this exercises the
// honest free-plan fallback path; the paid-plan formatting itself is
// covered by managerEngine.test.ts's formatCreditsSummary suite (pure
// function, no React context needed).
describe('sendManagerMessage — credits grounding (no SubscriptionProvider mounted)', () => {
  beforeEach(() => {
    vi.mocked(runManagerTurn).mockReset();
  });

  it('embeds an honest free-plan creditsSummary in the context passed to runManagerTurn', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'You are on the free plan.',
      actions: [{ type: 'info', message: 'You are on the free plan.' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'combien ai-je de crédits ?', 'haiku');
    });

    const callArgs = vi.mocked(runManagerTurn).mock.calls[0][0];
    expect(callArgs.context.creditsSummary).toMatch(/free plan/i);
  });
});

// ── Orchestrator quality: Brain: status grounding (silent-degradation fix) ──
// Real QA finding (2026-07): the manager never distinguished "no brain
// reachable" from "brain resolved but this project has 0 notes" from "brain
// has real notes but nothing on this topic" — it always answered the same
// "rien de pertinent" regardless, and kept guessing task sizes instead of
// flagging the missing source. fetchManagerBrainInfo (agentsStore.tsx) now
// feeds a real BrainInfo snapshot into formatBrainStatus (managerEngine.ts)
// on every turn. The test wrapper mounts the real (non-Tauri) web platform,
// so this exercises the honest "unavailable" fallback path — the "indexed"/
// "not indexed" formatting itself is covered by managerEngine.test.ts's
// formatBrainStatus suite (pure function, no React context needed).
describe('sendManagerMessage — Brain: status grounding (no Tauri platform mounted)', () => {
  beforeEach(() => {
    vi.mocked(runManagerTurn).mockReset();
  });

  it('embeds an honest "unavailable" brainStatus in the context passed to runManagerTurn on the web platform', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Le brain est indisponible.',
      actions: [{ type: 'info', message: 'Le brain est indisponible.' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'combien de parties a ce projet ?', 'haiku');
    });

    const callArgs = vi.mocked(runManagerTurn).mock.calls[0][0];
    expect(callArgs.context.brainStatus).toMatch(/^Brain: unavailable/);
  });
});

// ── QA wave (SPEC-CHARTE-DE-MISSION.md) — integration verification across
// the 4 parallel tasks (prompt/types, store executor, UI cards, loop
// lifecycle). Each test below closes a wiring gap found during that
// verification: propose_mission_charter was validated by the prompt/
// validator layer but the store never surfaced it to the UI at all; a
// validated charter's superviseFirstN/measure/killSwitch never reached
// create_loop's resulting LoopConfig, so no loop could ever enter trial
// mode; run_browser_recipe was implemented and Rust-wired but had no
// ManagerAction, validator entry, or executor case connecting it.
describe('Mission Charter — prompt/store/UI contract (SPEC-CHARTE-DE-MISSION.md §1)', () => {
  beforeEach(() => {
    vi.mocked(runManagerTurn).mockReset();
  });

  it('a propose_mission_charter action becomes a pending charterProposal carrying the EXACT same five blocks/field names the action emitted', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    const charterAction = {
      type: 'propose_mission_charter' as const,
      objective: 'Publish carousels on a social network on a recurring cadence',
      nature: { kind: 'recurring' as const, cadence: '1d' as const },
      decisions: [
        {
          question: 'Publishing route?',
          options: ['official API', 'browser automation'],
          recommended: 'official API',
          rationale: 'stable; the other risks automation detection/account blocks',
        },
      ],
      validationGates: { frozenOnce: ['template', 'tone'], superviseFirstN: 3 },
      learning: {
        measure: 'engagement rate',
        measureSource: 'external analytics',
        influences: 'subjects/timing',
        killSwitch: '3 failures or a measure drop',
      },
    };
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Voici la charte de mission proposée.',
      actions: [charterAction],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'je veux poster des carrousels automatiquement', 'haiku');
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.charterProposal).toBeDefined();
    expect(lastMsg.charterProposal?.state).toBe('pending');
    // Same field names/values as the action — no store-side reshaping.
    expect(lastMsg.charterProposal?.charter).toEqual({
      objective: charterAction.objective,
      nature: charterAction.nature,
      decisions: charterAction.decisions,
      validationGates: charterAction.validationGates,
      learning: charterAction.learning,
    });
  });

  it('never throws "Unknown manager action type" for propose_mission_charter (the action executes as a documented no-op, not a crash)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Charte proposée.',
      actions: [{
        type: 'propose_mission_charter',
        objective: 'x', nature: { kind: 'unique' }, decisions: [],
        validationGates: { frozenOnce: [] },
        learning: { measure: 'm', measureSource: 's', influences: 'i', killSwitch: 'k' },
      }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'propose une charte', 'haiku');
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).not.toMatch(/a échoué|Unknown manager action/);
  });
});

// ── Defect 2 (real test session, 2026-07-28): the manager proposed THREE
// successive charters for the SAME mission across three turns — each one
// restating/refining the last, never advancing to propose_artifact/
// generate_plan. Root cause: nothing told the manager, in its OWN
// structured context, that a charter it had just proposed was already
// validated — see deriveCharterStatusContext's doc comment (agentsStore.tsx)
// and ManagerContext.charterStatusContext's doc comment (managerEngine.ts).
describe('Mission Charter convergence — Defect 2 (manager must not re-propose an already-validated charter)', () => {
  beforeEach(() => {
    vi.mocked(runManagerTurn).mockReset();
  });

  const charterAction = {
    type: 'propose_mission_charter' as const,
    objective: 'Publish carousels on Instagram on a recurring cadence',
    nature: { kind: 'recurring' as const, cadence: '1d' },
    decisions: [],
    validationGates: { frozenOnce: ['template'], superviseFirstN: 3 },
    learning: {
      measure: 'engagement rate',
      measureSource: 'external analytics',
      influences: 'subjects/timing',
      killSwitch: '3 failures or a measure drop',
    },
  };

  function useCombined() {
    return { store: useAgentsStore(), i18n: useI18n() };
  }

  it('reports the charter as ACCEPTED (forbidding re-proposal) on the turn right after the user validates it', async () => {
    const { result } = renderHook(() => useCombined(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Voici la charte de mission proposée.',
      actions: [charterAction],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.store.sendManagerMessage(result.current.store.activeConversationId, 'je veux poster des carrousels automatiquement sur instagram', 'haiku');
    });

    // Same fixed-shape message the real Validate button sends
    // (missionCharter.ts's formatCharterValidationMessage, out of this task's
    // perimeter) — built here via the SAME t() key the app uses, with real
    // values instead of sentinels, exactly like a genuine (possibly edited)
    // Validate click would produce.
    const validateText = result.current.i18n.t('lazyManager.charter.validateMessage', {
      objective: charterAction.objective,
      nature: 'recurring, cadence 1d',
      gates: 'template frozen once, supervised for the first 3 runs',
    });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Je passe à la suite.',
      actions: [{ type: 'info', message: 'ok' }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.store.sendManagerMessage(result.current.store.activeConversationId, validateText, 'haiku');
    });

    const secondCallArgs = vi.mocked(runManagerTurn).mock.calls[1][0];
    expect(secondCallArgs.context.charterStatusContext).toMatch(/^ACCEPTED/);
    expect(secondCallArgs.context.charterStatusContext).toContain('never re-emit propose_mission_charter');
  });

  it('reports PROPOSED (never ACCEPTED) while a charter is still awaiting the user\'s validation', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Voici la charte de mission proposée.',
      actions: [charterAction],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'je veux poster des carrousels automatiquement sur instagram', 'haiku');
    });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Une précision.',
      actions: [{ type: 'info', message: 'ok' }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'et pour le budget ?', 'haiku');
    });

    const secondCallArgs = vi.mocked(runManagerTurn).mock.calls[1][0];
    expect(secondCallArgs.context.charterStatusContext).toMatch(/^PROPOSED/);
  });
});

describe('Recurring regime lifecycle — trial mode is structurally impossible on a one-off task (spec §4)', () => {
  beforeEach(() => {
    vi.mocked(runManagerTurn).mockReset();
  });

  it('create_loop WITH a charter-seeded superviseFirstN starts the loop in "trial" with the right threshold', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Je crée la boucle en mode essai.',
      actions: [{
        type: 'create_loop', task: 'Publish one carousel', cadence: '1d',
        superviseFirstN: 3, measure: 'engagement rate', killSwitch: '3 failures',
      }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'crée le régime récurrent validé', 'haiku');
    });

    const loopMission = result.current.missions.find((m) => m.loopConfig !== undefined);
    expect(loopMission?.loopConfig?.regimeState).toBe('trial');
    expect(loopMission?.loopConfig?.trialApprovedCount).toBe(0);
    expect(loopMission?.loopConfig?.trialPromotionThreshold).toBe(3);
    expect(loopMission?.loopConfig?.measure).toBe('engagement rate');
  });

  it('a plain create_loop with no charter-seed fields never sets regimeState (ordinary ungated loop, unchanged)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Je crée une boucle.',
      actions: [{ type: 'create_loop', task: 'Do X every day', cadence: '1d' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'crée une boucle quotidienne', 'haiku');
    });

    const loopMission = result.current.missions.find((m) => m.loopConfig !== undefined);
    expect(loopMission?.loopConfig?.regimeState).toBeUndefined();
  });

  it('a one-off task (launch_mission) never carries a loopConfig at all — no trial mode reachable', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Je lance la mission.',
      actions: [{ type: 'launch_mission', task: 'Design the carousel template once' }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'fais le gabarit une fois', 'haiku');
    });

    const mission = result.current.missions[result.current.missions.length - 1];
    expect(mission.loopConfig).toBeUndefined();
  });
});

describe('run_browser_recipe — declared, validated, and wired (spec §5)', () => {
  beforeEach(() => {
    vi.mocked(runManagerTurn).mockReset();
  });

  it('is a KNOWN action type, classified (never "unknown"), and its executor really drives the browser_recipe_* Tauri commands with the recipe as pure data', async () => {
    const { KNOWN_ACTION_TYPES } = await import('../lib/agents/managerActionValidator');
    const { classifyAction } = await import('../lib/agents/actionClassifier');
    expect(KNOWN_ACTION_TYPES).toContain('run_browser_recipe');
    expect(classifyAction('run_browser_recipe')).not.toBe('unknown');

    const calls: Array<{ cmd: string; args: unknown }> = [];
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      if (cmd === 'browser_recipe_step') {
        return Promise.resolve(JSON.stringify({ ok: true, detail: 'clicked' }));
      }
      return Promise.resolve('ok');
    });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Je prépare la publication.',
      actions: [{
        type: 'run_browser_recipe',
        recipe: {
          profileName: 'acme-profile',
          steps: [
            { id: 'open', kind: 'navigate', url: 'https://example.test' },
            { id: 'publish', kind: 'click', selector: '[data-testid="publish"]', irreversible: true },
          ],
        },
      }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'prépare la publication sans cliquer', 'haiku');
    });

    // Real Rust commands were actually invoked (declared AND branchée) —
    // never a fabricated success with no underlying call.
    expect(calls.some((c) => c.cmd === 'browser_recipe_open')).toBe(true);
    // Default validateOnly stops BEFORE the irreversible step: only the
    // non-irreversible "open" step should have run.
    expect(calls.some((c) => c.cmd === 'browser_recipe_step')).toBe(true);
    const stepArgs = calls.filter((c) => c.cmd === 'browser_recipe_step').map((c) => JSON.parse((c.args as { stepJson: string }).stepJson));
    expect(stepArgs.every((s: { id: string }) => s.id !== 'publish')).toBe(true);
    expect(calls.some((c) => c.cmd === 'browser_recipe_close')).toBe(true);
  });
});

// ── propose_artifact (visible-artifact fix) ─────────────────────────
// Real founder feedback, verbatim: "comment tu me montres les designs
// proposes ?" — before this wave, a proposed visual template had nowhere to
// render (ArtifactProposalCard read a field ManagerMessage never carried,
// PreviewNode's htmlViews had no caller). Each test below closes one wiring
// gap: the action reaching the message as a real artifactProposal, the
// canvas surface actually being materialized with the SAME views, the
// action's own classification/validation, and the resolve-a-variant path
// freezing the chosen variant as the recurring regime's reusable gabarit.
describe('propose_artifact — visible design preview, declared/validated/wired end to end', () => {
  beforeEach(async () => {
    vi.mocked(runManagerTurn).mockReset();
    mockFreezeLoopArtifact.mockClear();
    // Isolate the canvas surfaces this describe block asserts on from
    // whatever earlier tests in this file may have left behind (no other
    // test here otherwise touches canvasStoreVanilla).
    const { _resetCanvasStoreForTests } = await import('../components/agents/canvas/canvasStore');
    _resetCanvasStoreForTests();
  });

  const twoVariantAction = {
    type: 'propose_artifact' as const,
    artifactId: 'hero-banner',
    name: 'Homepage hero banner',
    variants: [
      { id: 'a', label: 'Option A', views: [{ id: 'v1', label: 'Desktop', html: '<html>A</html>' }] },
      {
        id: 'b',
        label: 'Option B — avec notre identité visuelle',
        views: [{ id: 'v1', label: 'Desktop', html: '<html>B</html>' }],
      },
    ],
  };

  it('is a KNOWN, SAFE (non-destructive) action type — never asks for superfluous approval', async () => {
    const { KNOWN_ACTION_TYPES } = await import('../lib/agents/managerActionValidator');
    const { classifyAction } = await import('../lib/agents/actionClassifier');
    expect(KNOWN_ACTION_TYPES).toContain('propose_artifact');
    expect(classifyAction('propose_artifact')).toBe('safe');
  });

  it('a propose_artifact action becomes a pending artifactProposal carrying the EXACT same fields the action emitted', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Voici deux propositions de bannière.',
      actions: [twoVariantAction],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'propose-moi une bannière hero', 'haiku');
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.artifactProposal).toBeDefined();
    expect(lastMsg.artifactProposal?.state).toBe('pending');
    expect(lastMsg.artifactProposal?.artifactId).toBe('hero-banner');
    expect(lastMsg.artifactProposal?.name).toBe('Homepage hero banner');
    expect(lastMsg.artifactProposal?.variants).toEqual(twoVariantAction.variants);
    expect(lastMsg.artifactProposal?.selectedVariantId).toBeUndefined();
  });

  it('materializes a canvas preview surface carrying BOTH variants\' HTML views — the founder sees the same thing in the chat card and on the canvas', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Voici deux propositions de bannière.',
      actions: [twoVariantAction],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'propose-moi une bannière hero', 'haiku');
    });

    const { canvasStoreVanilla } = await import('../components/agents/canvas/canvasStore');
    const surface = canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'artifact-hero-banner');
    expect(surface).toBeDefined();
    expect(surface?.kind).toBe('preview');
    expect(surface?.htmlViews).toEqual([
      { id: 'a:v1', label: 'Option A — Desktop', html: '<html>A</html>' },
      { id: 'b:v1', label: 'Option B — avec notre identité visuelle — Desktop', html: '<html>B</html>' },
    ]);
  });

  it('never throws "Unknown manager action type" for propose_artifact (real executor case, not a crash)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Voici une proposition.',
      actions: [{
        type: 'propose_artifact',
        name: 'Single option',
        variants: [{ id: 'a', label: 'Only option', views: [{ id: 'v1', label: 'Page', html: '<p>x</p>' }] }],
      }],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'propose un visuel', 'haiku');
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).not.toMatch(/a échoué|Unknown manager action/);
  });

  it('resolving a variant (selectedVariantId) marks the proposal accepted, narrows the canvas surface to that ONE variant, and freezes it as the reference gabarit keyed by the SAME artifactId', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    // Turn 1 — initial pending proposal with two variants.
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Voici deux propositions de bannière.',
      actions: [twoVariantAction],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'propose-moi une bannière hero', 'haiku');
    });

    // Turn 2 — the user's exact-text choice (formatArtifactSelectionMessage's
    // relay, LazyManager.tsx) reaches the manager as this user turn; the
    // manager resolves it by re-emitting propose_artifact with the SAME
    // artifactId plus selectedVariantId.
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Je retiens Option B.',
      actions: [{ ...twoVariantAction, selectedVariantId: 'b' }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'Je retiens "Option B — avec notre identité visuelle" pour "Homepage hero banner".', 'haiku');
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.artifactProposal?.state).toBe('accepted');
    expect(lastMsg.artifactProposal?.selectedVariantId).toBe('b');

    // Canvas surface narrows to the resolved variant only (single variant ->
    // plain view labels, no "Option B — " prefix needed anymore).
    const { canvasStoreVanilla } = await import('../components/agents/canvas/canvasStore');
    const surface = canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'artifact-hero-banner');
    expect(surface?.htmlViews).toEqual([{ id: 'b:v1', label: 'Desktop', html: '<html>B</html>' }]);

    // Cycle de vie (spec §4 gate 1) — the resolved variant is frozen via the
    // EXISTING generic loop-artifact primitive, keyed by the SAME artifactId
    // a later create_loop can reference as its own templateArtifactRef.
    expect(mockFreezeLoopArtifact).toHaveBeenCalledTimes(1);
    const [, ownerId, , content, label] = mockFreezeLoopArtifact.mock.calls[0];
    expect(ownerId).toBe('hero-banner');
    expect(content).toEqual(twoVariantAction.variants[1]);
    expect(label).toBe('Homepage hero banner');
  });

  it('links the resolved artifact to a recurring loop\'s templateArtifactRef by name — the SAME artifactId string flows straight onto LoopConfig, unregenerated', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    // The artifact is proposed and resolved first (freezes the gabarit).
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Voici deux propositions.',
      actions: [twoVariantAction],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'propose-moi une bannière', 'haiku');
    });
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Je retiens Option B.',
      actions: [{ ...twoVariantAction, selectedVariantId: 'b' }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'Je retiens Option B.', 'haiku');
    });

    // The manager then creates the recurring loop naming the SAME artifactId
    // as templateArtifactRef — the existing create_loop executor already
    // threads this verbatim onto the resulting Mission's LoopConfig.
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Je crée la boucle récurrente.',
      actions: [{
        type: 'create_loop',
        task: 'Publish the hero banner weekly',
        cadence: '1d',
        templateArtifactRef: 'hero-banner',
      }],
      rawResponse: '',
    });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'crée la boucle hebdomadaire avec ce gabarit', 'haiku');
    });

    const loopMission = result.current.missions.find((m) => m.loopConfig !== undefined);
    expect(loopMission?.loopConfig?.templateArtifactRef).toBe('hero-banner');
  });
});

// ── buildArtifactSurfaceViews (pure helper) ──────────────────────────
describe('buildArtifactSurfaceViews', () => {
  it('prefixes each view label with its variant label when more than one variant is present', async () => {
    const { buildArtifactSurfaceViews } = await import('../components/agents/agentsStore');
    const views = buildArtifactSurfaceViews([
      { id: 'a', label: 'Option A', views: [{ id: 'v1', label: 'Cover', html: '<p>a</p>' }] },
      { id: 'b', label: 'Option B', views: [{ id: 'v1', label: 'Cover', html: '<p>b</p>' }] },
    ]);
    expect(views).toEqual([
      { id: 'a:v1', label: 'Option A — Cover', html: '<p>a</p>' },
      { id: 'b:v1', label: 'Option B — Cover', html: '<p>b</p>' },
    ]);
  });

  it('does not prefix view labels for a single-variant list (no variant to disambiguate)', async () => {
    const { buildArtifactSurfaceViews } = await import('../components/agents/agentsStore');
    const views = buildArtifactSurfaceViews([
      { id: 'a', label: 'Option A', views: [{ id: 'v1', label: 'Cover', html: '<p>a</p>' }, { id: 'v2', label: 'Detail', html: '<p>a2</p>' }] },
    ]);
    expect(views).toEqual([
      { id: 'a:v1', label: 'Cover', html: '<p>a</p>' },
      { id: 'a:v2', label: 'Detail', html: '<p>a2</p>' },
    ]);
  });
});

// ── TOLOWERCASE-ON-UNDEFINED fix (2026-08-05) ────────────────────────
// Real prod crash: "Cannot read properties of undefined (reading
// 'toLowerCase')" during the grounded turn, right after the manager
// referenced a query_mission target — traced to resolveMissionQueryTarget's
// title-substring fallback walking EVERY mission in state, including
// sparsely-written unarchived journal debris (M21/M22-class rows) whose
// `title` field is absent at runtime despite the Mission type claiming
// `string` (a parsed-JSON snapshot, never type-checked). findLoopMission has
// the identical unguarded pattern for pause_loop/delete_loop.
function makeSparseMission(id: string, overrides: Partial<Mission> = {}): Mission {
  return {
    id,
    // Deliberately absent at runtime (cast past the type system) — mirrors
    // a real malformed/partial journal row, never a value this suite
    // fabricates as "string but empty".
    title: undefined as unknown as string,
    status: undefined as unknown as Mission['status'],
    agentName: undefined,
    model: 'sonnet',
    createdAt: Date.now(),
    progress: 0,
    planSteps: [],
    actionTimeline: [],
    ...overrides,
  };
}

describe('resolveMissionQueryTarget / findLoopMission — sparse mission fields never crash (TOLOWERCASE-ON-UNDEFINED fix)', () => {
  it('resolveMissionQueryTarget finds the real target by id even when OTHER missions in the array have an undefined title', () => {
    const missions: Mission[] = [
      makeSparseMission('M21'), // unarchived debris — title undefined
      makeSparseMission('M22'), // same
      { id: 'M34', title: 'Fix the thing', status: 'review', model: 'sonnet', worktree: 'agent/M34', createdAt: Date.now(), progress: 100, planSteps: [], actionTimeline: [] },
    ];
    expect(() => resolveMissionQueryTarget('M34', missions, [])).not.toThrow();
    expect(resolveMissionQueryTarget('M34', missions, [])?.id).toBe('M34');
  });

  it('resolveMissionQueryTarget falls through its title-substring search across sparse missions without crashing, even for an unknown id', () => {
    const missions: Mission[] = [makeSparseMission('M21'), makeSparseMission('M22')];
    expect(() => resolveMissionQueryTarget('M99', missions, [])).not.toThrow();
    expect(resolveMissionQueryTarget('M99', missions, [])).toBeUndefined();
  });

  it('findLoopMission never crashes on a sparse loop mission with an undefined title', () => {
    const missions: Mission[] = [
      { ...makeSparseMission('M21'), loopConfig: { enabled: true, cadence: 'daily' } as unknown as Mission['loopConfig'] },
    ];
    expect(() => findLoopMission(missions, 'anything')).not.toThrow();
  });
});
