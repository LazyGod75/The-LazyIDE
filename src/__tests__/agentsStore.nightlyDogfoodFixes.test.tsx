/**
 * agentsStore.nightlyDogfoodFixes.test.tsx — regression coverage for three
 * real bugs found during a pure-user dogfood session (2026-08-05):
 *
 *   1. (founder-visible, issue #21) launch_draft on a draft whose projectId
 *      names an OPEN-but-not-ACTIVE project used to refuse honestly
 *      ('projet inactif') instead of auto-activating the project like a
 *      multi-project fleet requires — see agentsStore.tsx's `launch_draft`
 *      executor case, "AUTO-ACTIVATE fix" doc comment.
 *   2. (issue #22) a partial/mid-evaluation judgeVerdict (reviewers array
 *      missing or malformed) crashed managerEngine.ts's formatMissionDetail
 *      with a raw "Cannot read properties of undefined" during the
 *      manager's own grounding/diagnosis pass — see agentsStore.tsx's
 *      `formatMissionDetailSafe` doc comment.
 *   3. (residual, same drive-case/slash bug family as draftLaunch.ts's
 *      launchDraft fix) changeApprovalMode(mode, projectId) compared
 *      `projectId` against the freshly-resolved `activeProjectId` with a
 *      strict `!==`, silently skipping the retroactive re-scan whenever the
 *      two differed only in drive-letter case or slash direction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  AgentsStoreProvider,
  useAgentsStore,
  formatMissionDetailSafe,
} from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import { mergeWorktree } from '../lib/agents/runtime';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { type DraftSpec } from '../components/agents/canvas/canvasTypes';
import { setApprovalMode, _resetApprovalModesForTests } from '../lib/agents/approvalMode';
import type { JudgeVerdict, Mission, ReviewerVerdict } from '../lib/agents/types';

const mockInvoke = vi.mocked(invoke);

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

// Only useAppContextOptional is imported by agentsStore.tsx from this module
// (see its own import line) — mocking just that export, same convention
// agentsStoreCrossProjectRelaunch.test.ts already establishes for the
// sibling cross-project sweep.
const { mockUseAppContextOptional } = vi.hoisted(() => ({
  mockUseAppContextOptional: vi.fn(),
}));
vi.mock('../app/AppContext', () => ({
  useAppContextOptional: mockUseAppContextOptional,
}));

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

function draft(overrides: Partial<DraftSpec> & { id: string }): DraftSpec {
  return { title: `Draft ${overrides.id}`, task: 'do the thing', createdBy: 'user', ...overrides };
}

async function dispatch(
  sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>,
  conversationId: string,
  actions: unknown[],
) {
  vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: actions as never, rawResponse: '' });
  await act(async () => {
    await sendManagerMessage(conversationId, 'do it', 'haiku');
  });
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  vi.mocked(runManagerTurn).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
  mockUseAppContextOptional.mockReset();
  mockUseAppContextOptional.mockReturnValue(null);
  localStorage.setItem('lazy.locale', 'en');
});

afterEach(() => {
  localStorage.removeItem('lazy.locale');
});

// ── Bug #21 — launch_draft auto-activates an OPEN-but-inactive project ──

describe('executeManagerAction — launch_draft auto-activates an open-but-inactive project (issue #21)', () => {
  const ACTIVE_ROOT = 'C:/projects/lazy';
  const OTHER_ROOT = 'C:/projects/lazy-backoffice';
  const OTHER_PROJECT_ID = 'c:/projects/lazy-backoffice';

  function installOpenProjects(switchProject: ReturnType<typeof vi.fn>) {
    mockUseAppContextOptional.mockReturnValue({
      openProjects: [
        { id: 'p-active', root: ACTIVE_ROOT, brainId: null, active: true },
        { id: 'p-other', root: OTHER_ROOT, brainId: null, active: false },
      ],
      activeProjectId: 'p-active',
      switchProject,
    });
  }

  beforeEach(() => {
    // get_project_root reflects whichever project is "active" per the last
    // switchProject call — starts at ACTIVE_ROOT, flips to OTHER_ROOT once
    // the fix's own switchProject(openEntry.id) call resolves (mirroring
    // AppContext.tsx's real setActiveProject + project://changed contract).
    let currentRoot = ACTIVE_ROOT;
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'get_project_root') return currentRoot;
      if (cmd === 'set_active_project') {
        const id = (args as { id?: string } | undefined)?.id;
        currentRoot = id === 'p-other' ? OTHER_ROOT : ACTIVE_ROOT;
        return undefined;
      }
      return undefined;
    });
  });

  it('activates the draft\'s OPEN project, launches, and reports an honest real-result line naming it', async () => {
    const switchProject = vi.fn(async (id: string) => {
      // Real switchProject (AppContext.tsx) awaits the activate command
      // before resolving — the mocked invoke above already updates
      // currentRoot synchronously inside that same call.
      await mockInvoke('set_active_project', { id });
    });
    installOpenProjects(switchProject);

    const draftId = 'draft-backoffice';
    canvasStoreVanilla.getState().addDraft(
      draft({ id: draftId, title: 'Backoffice work', projectId: OTHER_PROJECT_ID }),
    );
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'launch_draft', draftId },
    ]);

    // Real activation primitive called — the SAME one close_project's
    // executor already uses, never a second divergent path.
    expect(switchProject).toHaveBeenCalledWith('p-other');
    // Draft actually launched — remapped away, a real mission exists.
    expect(canvasStoreVanilla.getState().drafts.some((d) => d.id === draftId)).toBe(false);
    expect(result.current.missions.some((m) => m.title === 'Backoffice work')).toBe(true);
    // Honest real-result line mentions the auto-activation (never silent
    // about the side-effecting project switch) — reuses the SAME translated
    // sentence the human's own cross-project "Lancer" flow shows. This is
    // the manager transcript's own "Résultat réel" message (executeManagerAction's
    // outcome.message), never rendered as DOM here (no chat UI mounted by
    // this hook-only test) — read straight from the conversation state.
    const conversation = result.current.conversations[result.current.activeConversationId];
    const realResultText = conversation.messages.map((m) => m.content).join(' | ');
    expect(realResultText).toMatch(/Project "lazy-backoffice" activated/);
  });

  it('keeps the existing honest failure for a draft whose project is NOT open at all', async () => {
    const switchProject = vi.fn();
    mockUseAppContextOptional.mockReturnValue({
      openProjects: [{ id: 'p-active', root: ACTIVE_ROOT, brainId: null, active: true }],
      activeProjectId: 'p-active',
      switchProject,
    });

    const draftId = 'draft-closed-project';
    canvasStoreVanilla.getState().addDraft(
      draft({ id: draftId, title: 'Closed project work', projectId: 'c:/projects/never-opened' }),
    );
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'launch_draft', draftId },
    ]);

    // Never silently opens/registers a new project, never launches.
    expect(switchProject).not.toHaveBeenCalled();
    expect(result.current.missions.length).toBe(missionsBefore);
    expect(canvasStoreVanilla.getState().drafts.some((d) => d.id === draftId)).toBe(true);
  });
});

// ── Bug #22 — verdict-undefined crash path (approval-card judge verdict) ──

describe('formatMissionDetailSafe — defensive guard for a partial judgeVerdict (issue #22)', () => {
  function missionWithVerdict(judgeVerdict: JudgeVerdict): Mission {
    return {
      id: 'M35',
      title: 'Rejected mid-evaluation mission',
      status: 'review',
      model: 'Sonnet 4.6',
      judgeVerdict,
    };
  }

  it('does not throw and produces a usable detail when reviewers is missing (M35 shape: auto-merge raced judge state settling)', () => {
    const partialVerdict = {
      score: 0,
      passed: false,
      risk: 'high',
      createdAt: new Date().toISOString(),
      // reviewers deliberately absent, even though JudgeVerdict declares it
      // required — real in-flight data does not always match the type.
    } as unknown as JudgeVerdict;
    const mission = missionWithVerdict(partialVerdict);

    let detail = '';
    expect(() => {
      detail = formatMissionDetailSafe(mission);
    }).not.toThrow();

    expect(detail).toContain('M35');
    expect(detail).toContain('FAILED');
    // Never mutates the original mission (immutable-update convention).
    expect(mission.judgeVerdict).toBe(partialVerdict);
    expect((mission.judgeVerdict as JudgeVerdict).reviewers).toBeUndefined();
  });

  it('falls back to the honest "évaluation indisponible" label when the verdict is malformed beyond the reviewers-array guard', () => {
    const malformedVerdict: JudgeVerdict = {
      score: 0,
      passed: false,
      risk: 'high',
      createdAt: new Date().toISOString(),
      // Structurally an array (passes the Array.isArray guard) but its one
      // element is not a real ReviewerVerdict — formatMissionDetail's own
      // reviewer-summary loop dereferences `.role` unconditionally.
      reviewers: [null as unknown as ReviewerVerdict],
    };
    const mission = missionWithVerdict(malformedVerdict);

    let detail = '';
    expect(() => {
      detail = formatMissionDetailSafe(mission);
    }).not.toThrow();

    expect(detail).toContain('évaluation indisponible');
  });

  it('still delegates to the real formatMissionDetail output for a healthy, fully-populated verdict', () => {
    const healthyVerdict: JudgeVerdict = {
      score: 88,
      passed: true,
      risk: 'low',
      createdAt: new Date().toISOString(),
      reviewers: [{ role: 'tester', verdict: 'approve', summary: 'looks good' }],
    };
    const mission = missionWithVerdict(healthyVerdict);

    const detail = formatMissionDetailSafe(mission);

    expect(detail).toContain('88/100');
    expect(detail).toContain('PASSED');
    expect(detail).toContain('tester: approve');
  });
});

// ── Bug (residual) — changeApprovalMode drive-case/slash comparison ──────

describe('changeApprovalMode — normalizes projectId vs activeProjectId (drive-case/slash bug family)', () => {
  // NOTE ON THIS TEST ENVIRONMENT: resolveProjectRoot()'s dynamic
  // `await import('@tauri-apps/api/core')` does not resolve through this
  // suite's `invoke` mock (a pre-existing quirk of this worktree's
  // junctioned node_modules — reproduced identically against the untouched
  // b52ce46 baseline, unrelated to this fix), so changeApprovalMode's own
  // `resolveProjectRoot()` always falls through to its documented
  // catch-fallback: `activeProjectId` is deterministically `projectIdFromRoot('.') === '.'`.
  //
  // This test deliberately keeps the MISSION's own owning project (resolved
  // via triggerAutoMergeIfEligible's separate resolveMissionRepoPath ->
  // resolveMissionProjectRoot, which DOES go through the statically-imported
  // — correctly mocked — `invoke`) decoupled from '.', as 'owner-project':
  // without this split, seeding '.' with auto_green before the mission ever
  // reaches review would auto-merge it immediately via the ORDINARY
  // patch-driven choke point (updateMission -> triggerAutoMergeIfEligible),
  // never actually exercising changeApprovalMode's retroactive rescan or
  // its line-8980 comparison at all.
  const ACTIVE_PROJECT_ID = '.'; // what changeApprovalMode's own activeProjectId always resolves to here
  const VARIANT_OF_ACTIVE = './'; // textually different, normalizes to ACTIVE_PROJECT_ID
  const OWNER_PROJECT_ID = 'owner-project'; // the mission's OWN project (decoupled, via journal mock)

  function passingVerdict(): JudgeVerdict {
    return {
      score: 95,
      passed: true,
      risk: 'low',
      reviewers: [{ role: 'tester', verdict: 'approve', summary: '' }],
      createdAt: new Date().toISOString(),
    };
  }

  let capturedMissionId = '';

  beforeEach(() => {
    _resetApprovalModesForTests();
    mockedMergeWorktree.mockReset().mockResolvedValue('mock-merge-sha');
    capturedMissionId = '';
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_project_root') return undefined; // forces the documented catch-fallback -> '.'
      if (cmd === 'project_list') {
        return [{ id: 'reg-owner', root: OWNER_PROJECT_ID, brainId: null, active: false }];
      }
      if (cmd === 'journal_missions_current') {
        return capturedMissionId
          ? [{ mission_id: capturedMissionId, project_id: OWNER_PROJECT_ID, status: 'review', data: '{}', updated_ms: Date.now() }]
          : [];
      }
      return undefined;
    });
  });

  afterEach(() => {
    _resetApprovalModesForTests();
  });

  async function addQueuedMission(
    result: { current: ReturnType<typeof useAgentsStore> },
    title: string,
  ): Promise<string> {
    await act(async () => {
      await result.current.addMission({
        title,
        repo: '.',
        worktree: 'agent/m-normalize',
        modelLabel: 'claude-sonnet-5',
        mode: 'agent',
        orchestrator: false,
      });
    });
    const id = result.current.missions[result.current.missions.length - 1].id;
    // Only from this point on does resolveMissionProjectRoot's journal
    // lookup attribute THIS mission to OWNER_PROJECT_ID — before it, no
    // mission_id is known yet, so the row list stays empty (harmless: no
    // journal-backed mission exists to misattribute).
    capturedMissionId = id;
    return id;
  }

  it('retroactively merges a review mission when changeApprovalMode\'s projectId differs from the resolved activeProjectId only by a trailing slash', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Cross-case retroactive merge');

    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'review', judgeVerdict: passingVerdict() } });
      await Promise.resolve();
      await Promise.resolve();
    });
    // Still in review — OWNER_PROJECT_ID's own mode is still 'manual' (never
    // seeded yet), so the ordinary patch-driven auto-merge check declines.
    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('review');

    // Seed the mission's OWN project's mode directly via the raw persistence
    // function (proven elsewhere in this suite's sibling file to never
    // itself retroactively rescan) — represents "auto_green was already
    // configured for this project" by the time the mode-change below fires.
    await setApprovalMode('auto_green', OWNER_PROJECT_ID);
    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('review');
    // NOTE: ACTIVE_PROJECT_ID ('.') is NOT seeded here — persistApprovalMode
    // inside changeApprovalMode('auto_green', './') sets the override for
    // './' which normalizes to the same key as '.', so getApprovalMode('.')
    // inside the .then callback already sees 'auto_green' without a prior
    // seed. Seeding '.' beforehand would make getApprovalMode('./') return
    // 'auto_green' too (fleet-normalized key match), triggering the
    // `previousMode === mode` early return and skipping the retroactive
    // rescan entirely — the exact gap this test exists to exercise.

    await act(async () => {
      // './' and '.' are the SAME project once normalized (projectIdFromRoot
      // strips the trailing separator), never textually identical — this is
      // the exact comparison the fix changes.
      await result.current.changeApprovalMode('auto_green', VARIANT_OF_ACTIVE);
    });

    // The retroactive rescan is a fire-and-forget async chain (resolveProjectRoot
    // → triggerAutoMergeIfEligible → resolveMissionRepoPath → approveMission →
    // mergeWorktree). Wait for the mission to flip to 'done'.
    await waitFor(() => {
      expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('done');
    }, { timeout: 5000 });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
    expect(mockedMergeWorktree).toHaveBeenCalledTimes(1);
  });

  it('regression guard: a projectId naming a GENUINELY different project still skips the rescan', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addQueuedMission(result, 'Different project untouched');

    await act(async () => {
      result.current.updateMission({ id: missionId, patch: { status: 'review', judgeVerdict: passingVerdict() } });
      await Promise.resolve();
      await Promise.resolve();
    });

    await setApprovalMode('auto_green', OWNER_PROJECT_ID);
    await setApprovalMode('auto_green', ACTIVE_PROJECT_ID);

    await act(async () => {
      // Normalizes to 'c:/projects/some-other-project' — genuinely NOT
      // ACTIVE_PROJECT_ID ('.') under any drive-case/slash normalization.
      await result.current.changeApprovalMode('auto_green', 'c:/projects/some-other-project');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.missions.find((m) => m.id === missionId)!.status).toBe('review');
    expect(mockedMergeWorktree).not.toHaveBeenCalled();
  });
});
