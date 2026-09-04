/**
 * agentsStore.approvalModes.test.tsx — W-MODES end-to-end coverage: the
 * auto-merge choke point (updateMission/applyRunUpdate ->
 * triggerAutoMergeIfEligible -> the REAL approveMission), the deliberate
 * no-retroactive-merge decision on a mode flip, the auto-merged
 * mission.approved payload shape, and the manual-mode zero-behavior-change
 * regression guarantee. Pure safety-matrix coverage (evaluateAutoMerge/
 * hasSecurityRejection) lives in approveGate.autoMerge.test.ts; CRUD/
 * persistence coverage lives in approvalMode.test.ts — this file is only
 * the store wiring the other two don't exercise.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { mergeWorktree } from '../lib/agents/runtime';
import { emitBuffered } from '../lib/journal/journal';
import { setApprovalMode, _resetApprovalModesForTests } from '../lib/agents/approvalMode';
import type { JudgeVerdict } from '../lib/agents/types';

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

// onMissionTerminalSGR wrapped in a spy over the REAL implementation (same
// import-original pattern as mergeWorktree above) — proves chains fire
// through the SAME existing hook after an auto-merge, no parallel path.
vi.mock('../lib/agents/sgrChainRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/sgrChainRunner')>();
  return {
    ...actual,
    onMissionTerminalSGR: vi.fn(actual.onMissionTerminalSGR),
  };
});

// emitBuffered wrapped in a spy over the REAL implementation — needed to
// assert the mission.approved payload shape below without disabling the
// real journal buffering behavior every other call site in this file
// relies on.
vi.mock('../lib/journal/journal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/journal/journal')>();
  return {
    ...actual,
    emitBuffered: vi.fn(actual.emitBuffered),
  };
});

const mockedMergeWorktree = vi.mocked(mergeWorktree);

function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}
function clearTauriSimulation(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

function passingVerdict(): JudgeVerdict {
  return {
    score: 95,
    passed: true,
    risk: 'low',
    reviewers: [
      { role: 'tester', verdict: 'approve', summary: '' },
      { role: 'reviewer', verdict: 'approve', summary: '' },
      { role: 'security', verdict: 'approve', summary: '' },
    ],
    createdAt: new Date().toISOString(),
  };
}

/**
 * P49 fix coverage: a verdict that PASSED but carries no real numeric score
 * (aggregateVerdict's honest `scoreUnavailable: true` flag — see evaluator.ts
 * — set when neither the judge nor any conclusive reviewer produced a real
 * number, even though a real approve consensus was reached). Manual approve
 * (checkApproveGate) already merges this fine — auto_green must agree
 * (evaluateAutoMerge's own green path never gates on scoreUnavailable, only
 * on `passed`), both on the initial transition into review and via
 * changeApprovalMode's retroactive re-scan.
 */
function passingVerdictNoScore(): JudgeVerdict {
  return { ...passingVerdict(), scoreUnavailable: true };
}

async function addQueuedMission(
  result: { current: ReturnType<typeof useAgentsStore> },
  title: string,
): Promise<string> {
  await act(async () => {
    await result.current.addMission({
      title,
      repo: '.',
      worktree: 'agent/m-modes',
      modelLabel: 'claude-sonnet-5',
      mode: 'agent',
      orchestrator: false,
    });
  });
  return result.current.missions[result.current.missions.length - 1].id;
}

beforeEach(() => {
  _resetApprovalModesForTests();
  // approvalMode.ts falls back to localStorage outside Tauri; even WITH
  // Tauri simulated (window.__TAURI_INTERNALS__), its own resolveActiveProjectRoot
  // best-effort-falls-back-to-localStorage on a mocked invoke that doesn't
  // recognize 'get_project_root'/'read_file' — clearing here prevents a
  // PRIOR test's persisted value from racing AgentsStoreProvider's boot
  // effect (ensureApprovalModesLoaded, fired on every mount) into this one.
  localStorage.clear();
  simulateTauri();
  mockedMergeWorktree.mockReset().mockResolvedValue('mock-merge-sha');
});

afterEach(() => {
  clearTauriSimulation();
  _resetApprovalModesForTests();
  localStorage.clear();
});

describe('W-MODES — manual mode (default): zero behavior change', () => {
  it('a mission reaching review with a passing verdict stays in review — no auto-merge, mergeWorktree never called', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Manual mode regression');

    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'review', judgeVerdict: passingVerdict() } });
      // Let the (skipped) async auto-merge microtask queue drain.
      await Promise.resolve();
      await Promise.resolve();
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('review');
    expect(mission.merged).not.toBe(true);
    expect(mockedMergeWorktree).not.toHaveBeenCalled();
  });
});

describe('W-MODES — auto_green', () => {
  it('auto-merges a mission the instant it reaches review with a passing verdict and no required proofs', async () => {
    await setApprovalMode('auto_green');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Auto-green happy path');

    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'review', judgeVerdict: passingVerdict() } });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
    expect(mockedMergeWorktree).toHaveBeenCalledTimes(1);
  });

  it('P49: auto-merges a PASSED verdict with scoreUnavailable === true (no real signal, but a real approve consensus) on the initial transition', async () => {
    await setApprovalMode('auto_green');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Auto-green passed-noscore transition');

    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'review', judgeVerdict: passingVerdictNoScore() } });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
    expect(mockedMergeWorktree).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-merge a rejected verdict — stays in review for a human, same as manual', async () => {
    await setApprovalMode('auto_green');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Auto-green rejected verdict');

    await act(async () => {
      result.current.updateMission({
        id: missionId,
        patch: { status: 'review', judgeVerdict: { ...passingVerdict(), passed: false } },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('review');
    expect(mockedMergeWorktree).not.toHaveBeenCalled();
  });

  it('the resulting mission.approved journal payload carries actor "auto" + the active mode', async () => {
    vi.mocked(emitBuffered).mockClear();
    await setApprovalMode('auto_green');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Auto-green journal payload');

    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'review', judgeVerdict: passingVerdict() } });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const approvedCall = vi.mocked(emitBuffered).mock.calls.find(([evt]) => evt.type === 'mission.approved' && evt.missionId === missionId);
    expect(approvedCall).toBeDefined();
    const payload = approvedCall![0].payload as { actor?: string; mode?: string };
    expect(payload.actor).toBe('auto');
    expect(payload.mode).toBe('auto_green');
  });

  // Real-user merge-blocker fix (2026-08-03, mission M4 "test-byok-agent.txt"
  // real test): the scripted judge without a live CLI rail returned
  // passed:false + scoreUnavailable:true ("score indisponible"), which
  // BLOCKED the auto-merge of a genuinely real deliverable. auto_green's
  // lazy floor now auto-merges a REAL non-empty deliverable whose verdict
  // was technically unavailable — an evaluator-rail failure, never a code
  // rejection. A conclusive rejection (passed:false WITHOUT
  // scoreUnavailable) still waits for a human (tested above).
  it('auto-merges a REAL deliverable whose verdict is technically unavailable (passed:false + scoreUnavailable:true) — the scripted-judge merge blocker', async () => {
    await setApprovalMode('auto_green');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Auto-green lazy floor');

    await act(async () => {
      result.current.updateMission({
        id: missionId,
        patch: {
          status: 'review',
          judgeVerdict: { ...passingVerdict(), passed: false, scoreUnavailable: true },
          diffAdded: 1,
          diffRemoved: 0,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
    expect(mockedMergeWorktree).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-merge a technically unavailable verdict on an EMPTY deliverable (no diff — nothing real to accept)', async () => {
    await setApprovalMode('auto_green');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Auto-green empty floor');

    await act(async () => {
      result.current.updateMission({
        id: missionId,
        // No diffAdded/diffRemoved on the patch: a fresh mission has NO diff
        // fields at all until the worktree diff is actually computed
        // (isDiffEmpty treats undefined/0 as empty — an explicit `[]` would
        // be truthy and wrongly count as a real deliverable).
        patch: {
          status: 'review',
          judgeVerdict: { ...passingVerdict(), passed: false, scoreUnavailable: true },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('review');
    expect(mockedMergeWorktree).not.toHaveBeenCalled();
  });
});

describe('W-MODES — full_auto floor', () => {
  it('does NOT merge the instant a mission reaches review with no verdict yet (Step D/Step F race fix — evaluation merely pending, not inconclusive)', async () => {
    // W-PROVE bug fix: this used to be exactly the "genuinely inconclusive"
    // test below, minus the judgesApproved marker — but `status: 'review'`
    // with an absent judgeVerdict is ALSO the real shape of runtime.ts's
    // Step D patch (fired well before Step F's evaluateMission() ever
    // resolves), so asserting a merge here was locking in a real bug: every
    // full_auto mission would force-merge the instant its diff was
    // computed, before a single evaluator sub-agent ran. See
    // autoMergeSafetyReplay.test.ts for the full realistic replay.
    await setApprovalMode('full_auto');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Full-auto pending evaluation');

    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'review' } });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('review');
    expect(mockedMergeWorktree).not.toHaveBeenCalled();
  });

  it('force-merges a genuinely inconclusive evaluation (evaluateMission threw — runtime.ts\'s own "no verdict is coming" marker)', async () => {
    await setApprovalMode('full_auto');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Full-auto inconclusive');

    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'review' } });
      await Promise.resolve();
      await Promise.resolve();
    });
    // Still pending at this point — no merge yet (see the test above).
    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('review');

    await act(async () => {
      // runtime.ts's Step F catch block's exact patch shape once
      // evaluateMission() itself has thrown.
      result.current.updateMission({
        id: missionId,
        patch: { judgesApproved: 'évaluation indisponible', liveAction: undefined },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
  });

  it('never merges a real conclusive judge rejection, even in full_auto', async () => {
    await setApprovalMode('full_auto');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Full-auto real rejection floor');

    await act(async () => {
      result.current.updateMission({
        id: missionId,
        patch: { status: 'review', judgeVerdict: { ...passingVerdict(), passed: false } },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('review');
    expect(mockedMergeWorktree).not.toHaveBeenCalled();
  });

  it('never merges a conclusive security rejection, even in full_auto', async () => {
    await setApprovalMode('full_auto');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Full-auto security floor');

    await act(async () => {
      result.current.updateMission({
        id: missionId,
        patch: {
          status: 'review',
          judgeVerdict: { ...passingVerdict(), reviewers: [{ role: 'security', verdict: 'reject', summary: '' }] },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('review');
    expect(mockedMergeWorktree).not.toHaveBeenCalled();
  });
});

describe('W-MODES — approvalMode.ts\'s own setApprovalMode never rescans by itself', () => {
  it('a mission already sitting in review when the RAW persistence-layer setApprovalMode flips to auto is NOT retroactively merged by that call alone', async () => {
    // NOTE: this exercises approvalMode.ts's own `setApprovalMode` directly
    // (imported above), NOT agentsStore.tsx's `changeApprovalMode` — the
    // persistence layer itself still deliberately never rescans (see its
    // own doc comment); the retroactive re-check is specifically
    // `changeApprovalMode`'s job, covered by the next describe block below.
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Already waiting in review');

    // Reaches review while mode is still manual — stays there.
    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'review', judgeVerdict: passingVerdict() } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('review');

    // Flip the mode via the raw persistence function — must not touch this mission.
    await act(async () => {
      await setApprovalMode('auto_green');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('review');
    expect(mockedMergeWorktree).not.toHaveBeenCalled();

    // A LATER real patch to the SAME mission re-checks eligibility and merges.
    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { liveAction: undefined } });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('done');
    expect(mockedMergeWorktree).toHaveBeenCalledTimes(1);
  });
});

describe('W-MODES — changeApprovalMode retroactively merges missions already in review (bug audit wave)', () => {
  it('a mission already sitting in review is retroactively merged the instant changeApprovalMode flips the (global) mode to auto_green', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Retroactive merge target');

    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'review', judgeVerdict: passingVerdict() } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('review');
    expect(mockedMergeWorktree).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.changeApprovalMode('auto_green');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('done');
    expect(result.current.missions.find((m) => m.id === missionId)!.merged).toBe(true);
    expect(mockedMergeWorktree).toHaveBeenCalledTimes(1);
  });

  it('P49: retroactively merges a PASSED verdict with scoreUnavailable === true the instant changeApprovalMode flips to auto_green', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Retroactive merge — passed noscore');

    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'review', judgeVerdict: passingVerdictNoScore() } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('review');
    expect(mockedMergeWorktree).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.changeApprovalMode('auto_green');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('done');
    expect(result.current.missions.find((m) => m.id === missionId)!.merged).toBe(true);
    expect(mockedMergeWorktree).toHaveBeenCalledTimes(1);
  });

  it('does NOT retroactively merge when changeApprovalMode flips to manual (nothing to merge into manual)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Manual flip stays put');

    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'review', judgeVerdict: passingVerdict() } });
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.changeApprovalMode('manual');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('review');
    expect(mockedMergeWorktree).not.toHaveBeenCalled();
  });

  it('a rejected verdict is still NOT retroactively merged by the flip (auto_green safety floor applies here too)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Rejected verdict flip');

    await act(async () => {
      result.current.updateMission({
        id: missionId,
        patch: { status: 'review', judgeVerdict: { ...passingVerdict(), passed: false } },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.changeApprovalMode('auto_green');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('review');
    expect(mockedMergeWorktree).not.toHaveBeenCalled();
  });

  it('re-running changeApprovalMode a second time (mode unchanged) does not double-merge an already-merged mission', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'No double merge');

    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'review', judgeVerdict: passingVerdict() } });
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.changeApprovalMode('auto_green');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('done');
    expect(mockedMergeWorktree).toHaveBeenCalledTimes(1);

    // Flipping to full_auto next — the mission is already 'done', so the
    // rescan loop's own `status === 'review'` filter skips it; no 2nd merge.
    await act(async () => {
      await result.current.changeApprovalMode('full_auto');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedMergeWorktree).toHaveBeenCalledTimes(1);
  });
});

describe('W-MODES — chain fires after an auto-merge (existing onMissionTerminalSGR, no parallel path)', () => {
  it('onMissionTerminalSGR is invoked with the merged (status: "done") mission once auto-merge completes', async () => {
    const { onMissionTerminalSGR } = await import('../lib/agents/sgrChainRunner');
    const mockedOnMissionTerminal = vi.mocked(onMissionTerminalSGR);
    mockedOnMissionTerminal.mockClear();

    await setApprovalMode('auto_green');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Chain-after-auto-merge');
    mockedOnMissionTerminal.mockClear(); // drop the 'queued' launch's own terminal-adjacent calls, if any

    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'review', judgeVerdict: passingVerdict() } });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('done');
    const doneCall = mockedOnMissionTerminal.mock.calls.find(([m]) => m.id === missionId && m.status === 'done');
    expect(doneCall).toBeDefined();
  });
});
