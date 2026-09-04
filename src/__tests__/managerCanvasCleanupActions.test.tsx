/**
 * Tests for the LazyManager canvas cleanup actions (B2/P0-4): the manager
 * used to have NO way to clear the canvas (only delete_mission/delete_loop/
 * unchain/stop_all existed) — a real user test asked it to "vide
 * complètement le canvas" and "enlève le projet Lazy du canvas" and got
 * nothing / an honest "not available" reply. This suite covers the new
 * ManagerAction variants (clear_canvas, archive_mission, archive_terminated,
 * delete_draft/note/router/join/frame, close_surface, close_project),
 * parsing + the executor (agentsStore.tsx's executeManagerAction)
 * dispatching each through the SAME real canvasStoreVanilla/archiveMission/
 * deleteMission/AppContext.closeProject primitives the context menu/toolbar
 * already use — no parallel path — plus the collapse_project name-resolution
 * bug fix (it used to key `collapsed` off a raw, possibly-unresolved
 * projectId, so a project referenced by NAME silently did nothing).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { AppProvider, useAppContext } from '../app/AppContext';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { parseManagerActions, buildManagerSystemPrompt, runManagerTurn } from '../lib/agents/managerEngine';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { makeRef, type DraftSpec } from '../components/agents/canvas/canvasTypes';

const mockInvoke = vi.mocked(invoke);

/** Same fake `project_list` directory helper as managerCanvasActions.test.tsx
 *  — `root` doubles as both the resolved journal projectId (projectIdFromRoot
 *  is near-identity for a plain string with no separators) and the digest's
 *  display name. */
function installProjects(projects: Array<{ root: string; active: boolean }>): void {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'project_list') {
      return projects.map((p, i) => ({ id: `reg-${i}`, root: p.root, brainId: null, active: p.active }));
    }
    return undefined;
  });
}

function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

function clearTauriSimulation(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

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

beforeEach(() => {
  _resetCanvasStoreForTests();
  vi.mocked(runManagerTurn).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

async function dispatch(sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>, conversationId: string, actions: unknown[]) {
  vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: actions as never, rawResponse: '' });
  await act(async () => {
    await sendManagerMessage(conversationId, 'do it', 'haiku');
  });
}

// ── Parsing ────────────────────────────────────────────────────────────

describe('parseManagerActions — canvas cleanup actions (B2/P0-4)', () => {
  const cases: Array<{ name: string; json: string }> = [
    { name: 'clear_canvas (scope only)', json: '{"type": "clear_canvas", "scope": "terminated"}' },
    { name: 'clear_canvas (full)', json: '{"type": "clear_canvas", "scope": "all", "mode": "delete", "projectId": "demo-shop", "olderThanHours": 48, "refs": ["draft:a"]}' },
    { name: 'archive_mission', json: '{"type": "archive_mission", "missionId": "M12"}' },
    { name: 'archive_terminated', json: '{"type": "archive_terminated"}' },
    { name: 'archive_terminated (projectId)', json: '{"type": "archive_terminated", "projectId": "demo-shop"}' },
    { name: 'delete_draft', json: '{"type": "delete_draft", "draftId": "draft-1"}' },
    { name: 'delete_note', json: '{"type": "delete_note", "noteId": "note-1"}' },
    { name: 'delete_router', json: '{"type": "delete_router", "routerId": "router-1"}' },
    { name: 'delete_join', json: '{"type": "delete_join", "joinId": "join-1"}' },
    { name: 'delete_frame', json: '{"type": "delete_frame", "frameId": "frame-1"}' },
    { name: 'close_surface', json: '{"type": "close_surface", "surfaceId": "surface-1"}' },
    { name: 'close_project', json: '{"type": "close_project"}' },
    { name: 'close_project (projectId)', json: '{"type": "close_project", "projectId": "demo-shop"}' },
  ];

  for (const { name, json } of cases) {
    it(`parses ${name}`, () => {
      const text = `<lazy_actions>\n[${json}]\n</lazy_actions>`;
      const actions = parseManagerActions(text);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toEqual(JSON.parse(json));
    });
  }
});

describe('buildManagerSystemPrompt — documents canvas cleanup actions', () => {
  it('documents all 10 new action types in the catalog', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    for (const action of [
      'clear_canvas', 'archive_mission', 'archive_terminated', 'delete_draft',
      'delete_note', 'delete_router', 'delete_join', 'delete_frame',
      'close_surface', 'close_project',
    ]) {
      expect(prompt).toContain(`"type": "${action}"`);
    }
  });
});

// ── clear_canvas ─────────────────────────────────────────────────────────

describe('executeManagerAction — clear_canvas', () => {
  it('scope "terminated" archives (default) every done/failed/cancelled mission, never a queued one', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Done one', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const doneId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: doneId, patch: { status: 'done' } });
    });
    await act(async () => {
      await result.current.addMission({ title: 'Still queued', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const queuedId = result.current.missions[result.current.missions.length - 1].id;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'terminated' }]);

    expect(result.current.missions.find((m) => m.id === doneId)?.archived).toBe(true);
    expect(result.current.missions.find((m) => m.id === queuedId)?.archived).toBeFalsy();
    expect(result.current.missions.find((m) => m.id === queuedId)?.status).toBe('queued');
  });

  it('scope "terminated" with mode "delete" truly removes the mission from state (irreversible)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Failed one', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const failedId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: failedId, patch: { status: 'failed' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'terminated', mode: 'delete' }]);

    expect(result.current.missions.find((m) => m.id === failedId)).toBeUndefined();
  });

  it('scope "failed" only targets failed missions, never a done one', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Done one', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const doneId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: doneId, patch: { status: 'done' } });
    });
    await act(async () => {
      await result.current.addMission({ title: 'Failed one', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const failedId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: failedId, patch: { status: 'failed' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'failed' }]);

    expect(result.current.missions.find((m) => m.id === failedId)?.archived).toBe(true);
    expect(result.current.missions.find((m) => m.id === doneId)?.archived).toBeFalsy();
  });

  it('scope "drafts" removes every draft regardless of project, ignores notes/missions', async () => {
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd2', projectId: 'proj-a' }));
    canvasStoreVanilla.getState().addNote({ id: 'n1', text: 'keep me' });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'drafts' }]);

    expect(canvasStoreVanilla.getState().drafts).toHaveLength(0);
    expect(canvasStoreVanilla.getState().notes).toHaveLength(1);
  });

  it('scope "notes" removes every note only', async () => {
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addNote({ id: 'n1', text: 'x' });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'notes' }]);

    expect(canvasStoreVanilla.getState().notes).toHaveLength(0);
    expect(canvasStoreVanilla.getState().drafts).toHaveLength(1);
  });

  it('scope "surfaces" removes every terminal/preview surface node', async () => {
    canvasStoreVanilla.getState().addSurface({ id: 's1', kind: 'terminal' });
    canvasStoreVanilla.getState().addSurface({ id: 's2', kind: 'preview', url: 'http://localhost:3000' });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'surfaces' }]);

    expect(canvasStoreVanilla.getState().surfaces).toHaveLength(0);
  });

  it('scope "all" clears every kind in one sweep and archives every terminal mission — no cap', async () => {
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addNote({ id: 'n1', text: 'x' });
    canvasStoreVanilla.getState().addSurface({ id: 's1', kind: 'terminal' });
    canvasStoreVanilla.getState().addRouter({ id: 'r1', branches: [{ id: 'b1', label: 'x', condition: { kind: 'default' } }] });
    canvasStoreVanilla.getState().addJoin({ id: 'j1', sourceRefs: [], mode: 'all_success' });
    canvasStoreVanilla.getState().addFrame({ id: 'f1', title: 'Group', width: 100, height: 100 });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Done', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'done' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'all' }]);

    expect(canvasStoreVanilla.getState().drafts).toHaveLength(0);
    expect(canvasStoreVanilla.getState().notes).toHaveLength(0);
    expect(canvasStoreVanilla.getState().surfaces).toHaveLength(0);
    expect(canvasStoreVanilla.getState().routers).toHaveLength(0);
    expect(canvasStoreVanilla.getState().joins).toHaveLength(0);
    expect(canvasStoreVanilla.getState().frames).toHaveLength(0);
    expect(result.current.missions.find((m) => m.id === missionId)?.archived).toBe(true);
  });

  it('scope "project" narrows drafts to ONE project zone, leaves other projects/Transverse untouched', async () => {
    installProjects([{ root: 'proj-a', active: true }, { root: 'proj-b', active: false }]);
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd-a', projectId: 'proj-a' }));
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd-b', projectId: 'proj-b' }));
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd-transverse' }));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'project', projectId: 'proj-a' }]);

    expect(canvasStoreVanilla.getState().drafts.map((d) => d.id).sort()).toEqual(['d-b', 'd-transverse']);
  });

  it('scope "project" with an unresolvable projectId clears nothing and reports honestly', async () => {
    localStorage.setItem('lazy.locale', 'en');
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'project', projectId: 'ghost' }]);

    expect(canvasStoreVanilla.getState().drafts).toHaveLength(1);
    expect(screen.getByText('Project "ghost" not found — nothing cleared')).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });

  it('scope "selection" clears exactly the named refs, nothing else', async () => {
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addNote({ id: 'n1', text: 'x' });
    canvasStoreVanilla.getState().addNote({ id: 'n2', text: 'keep me' });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'clear_canvas', scope: 'selection', refs: [makeRef('draft', 'd1'), makeRef('note', 'n1')] },
    ]);

    expect(canvasStoreVanilla.getState().drafts).toHaveLength(0);
    expect(canvasStoreVanilla.getState().notes.map((n) => n.id)).toEqual(['n2']);
  });

  it('scope "selection" with no refs given reports honestly and clears nothing', async () => {
    localStorage.setItem('lazy.locale', 'en');
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'selection' }]);

    expect(canvasStoreVanilla.getState().drafts).toHaveLength(1);
    expect(screen.getByText('Scope "selection" needs at least one ref in "refs" — nothing cleared')).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });

  it('reports honestly when nothing matches the scope ("aucun élément à nettoyer")', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'drafts' }]);

    expect(screen.getByText('Nothing to clean up — no matching item found')).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });

  it('reports honestly for an unrecognized scope (untrusted runtime JSON) — never silently clears everything ("portée inconnue")', async () => {
    localStorage.setItem('lazy.locale', 'en');
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'bogus' }]);

    expect(canvasStoreVanilla.getState().drafts).toHaveLength(1);
    expect(screen.getByText('Unknown clear_canvas scope: "bogus" — nothing cleared')).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });

  it('reports the real count and refs of everything cleared — an exploitable result, not just prose', async () => {
    localStorage.setItem('lazy.locale', 'en');
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addNote({ id: 'n1', text: 'x' });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'all' }]);

    expect(screen.getByText('2 item(s) cleared — draft:d1, note:n1')).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });
});

// ── clear_canvas — review-status missions are never silently swept (P0 fix) ──
// Real user test: the manager promised to archive review-status missions
// under scope "terminated", the executor silently excluded them (defensible
// on its own — a review-status mission is awaiting a human approve/reject
// decision), then a follow-up explicit "archive toutes celles en revue"
// request hit the same silent exclusion and reported "rien à nettoyer" in
// front of 27 still-visible missions. This suite proves the fix: the
// executor's own result ALWAYS names the exact count/refs of any
// review-status mission a scope left behind (never a bare "nothing to clean
// up"), and `includeReview: true` is the one explicit, opt-in way to
// actually sweep them in.

describe('executeManagerAction — clear_canvas honestly reports review-status missions left behind (P0 fix)', () => {
  it('scope "terminated" reports the exact review-excluded count/ref even when nothing else matches', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'In review', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const reviewId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: reviewId, patch: { status: 'review' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'terminated' }]);

    expect(result.current.missions.find((m) => m.id === reviewId)?.archived).toBeFalsy();
    expect(
      screen.getByText(
        `Nothing to clean up — no matching item found 1 mission(s) in review not affected (mission:${reviewId}) — awaiting a human decision; add "includeReview": true to clear_canvas to sweep them in too (the pending decision is then lost, approval required)`,
      ),
    ).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });

  it('scope "terminated" reports a real done count AND the review-excluded notice together', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Done', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const doneId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: doneId, patch: { status: 'done' } });
    });
    await act(async () => {
      await result.current.addMission({ title: 'In review', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const reviewId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: reviewId, patch: { status: 'review' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'terminated' }]);

    expect(result.current.missions.find((m) => m.id === doneId)?.archived).toBe(true);
    expect(result.current.missions.find((m) => m.id === reviewId)?.archived).toBeFalsy();
    expect(
      screen.getByText(
        `1 item(s) cleared — mission:${doneId} 1 mission(s) in review not affected (mission:${reviewId}) — awaiting a human decision; add "includeReview": true to clear_canvas to sweep them in too (the pending decision is then lost, approval required)`,
      ),
    ).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });

  it('"includeReview": true actually sweeps the review mission in (archived) and drops the excluded-notice', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'In review', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const reviewId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: reviewId, patch: { status: 'review' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'terminated', includeReview: true }]);

    expect(result.current.missions.find((m) => m.id === reviewId)?.archived).toBe(true);
    expect(screen.getByText(`1 item(s) cleared — mission:${reviewId}`)).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });

  it('scope "failed" never reports a review-excluded notice — review was never in play for this scope', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'In review', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const reviewId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: reviewId, patch: { status: 'review' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'failed' }]);

    expect(screen.getByText('Nothing to clean up — no matching item found')).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });
});

// ── archive_mission / archive_terminated ─────────────────────────────────

describe('executeManagerAction — archive_mission / archive_terminated', () => {
  it('archive_mission archives a terminal mission explicitly (never deletes)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Ship it', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'done' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'archive_mission', missionId }]);

    const mission = result.current.missions.find((m) => m.id === missionId);
    expect(mission).toBeDefined();
    expect(mission?.archived).toBe(true);
  });

  it('archive_mission refuses honestly for a non-terminal mission', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Still queued', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'archive_mission', missionId }]);

    expect(result.current.missions.find((m) => m.id === missionId)?.archived).toBeFalsy();
    // LOUD REFUSAL (THE SYSTEMIC BUG fix, 2026-08-06): the refusal is now
    // the dedicated hardcoded FR toast message pointing at the action that
    // DOES work on an active mission (delete_mission), not the old i18n'd
    // "archiveNotTerminal" chat text — see agentsStore.tsx's
    // ARCHIVE_REFUSED_ACTIVE_MISSION_MESSAGE doc comment.
    expect(
      screen.getByText('Mission encore active — archivage refusé. Utilise la suppression pour retirer une mission en cours.'),
    ).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });

  it('archive_mission reports honestly for an unknown missionId', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'archive_mission', missionId: 'M-ghost' }]);

    expect(screen.getByText('Mission M-ghost not found')).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });

  it('archive_terminated bulk-archives every terminal mission, ignores a queued one', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Done', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const doneId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: doneId, patch: { status: 'done' } });
    });
    await act(async () => {
      await result.current.addMission({ title: 'Still queued', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const queuedId = result.current.missions[result.current.missions.length - 1].id;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'archive_terminated' }]);

    expect(result.current.missions.find((m) => m.id === doneId)?.archived).toBe(true);
    expect(result.current.missions.find((m) => m.id === queuedId)?.archived).toBeFalsy();
  });

  it('archive_terminated reports honestly when nothing to archive', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'archive_terminated' }]);

    expect(screen.getByText('Nothing to clean up — no matching item found')).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });

  // P0 fix — archive_terminated's own doc comment calls it a shorthand for
  // clear_canvas's "terminated" scope, so it must report a left-behind
  // review-status mission the SAME honest way, never a bare "nothing to
  // archive" in front of a canvas that still shows it.
  it('archive_terminated reports a left-behind review mission honestly, same as clear_canvas', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'In review', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const reviewId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: reviewId, patch: { status: 'review' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'archive_terminated' }]);

    expect(result.current.missions.find((m) => m.id === reviewId)?.archived).toBeFalsy();
    expect(
      screen.getByText(
        `Nothing to clean up — no matching item found 1 mission(s) in review not affected (mission:${reviewId}) — awaiting a human decision; add "includeReview": true to clear_canvas to sweep them in too (the pending decision is then lost, approval required)`,
      ),
    ).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });

  it('archive_terminated reports honestly when projectId does not name the ACTIVE project', async () => {
    localStorage.setItem('lazy.locale', 'en');
    installProjects([{ root: 'active-proj', active: true }, { root: 'other-proj', active: false }]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Done', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const doneId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: doneId, patch: { status: 'done' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'archive_terminated', projectId: 'other-proj' }]);

    expect(result.current.missions.find((m) => m.id === doneId)?.archived).toBeFalsy();
    expect(
      screen.getByText('Project "other-proj" is not the active project — its missions cannot be archived from here'),
    ).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });
});

// ── delete_mission — P0-3 fix: honest failure on a stale/non-existent id,
// and a grounded real-result message (see managerCanvasCleanupActions'
// sibling suite below for clear_canvas/archive_terminated's own coverage).
// Real user test: a manager reply narrated "Mxx supprimée" for missions
// that had already been auto-archived (invisible on the canvas) — the OLD
// executor silently called deleteMission on a non-existent id with no
// exception, so the caller recorded a phantom success.

describe('executeManagerAction — delete_mission (P0-3 fix)', () => {
  it('reports an HONEST failure for a missionId that no longer exists — never a phantom success', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'delete_mission', missionId: 'M-ghost' }]);

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toBe('Action delete_mission failed: Mission M-ghost not found');
    localStorage.removeItem('lazy.locale');
  });

  it('archives a TERMINAL mission and appends the REAL grounded outcome to the chat transcript', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Done one', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'done' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'delete_mission', missionId }]);

    expect(result.current.missions.find((m) => m.id === missionId)?.archived).toBe(true);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toBe(`Real outcome: Mission ${missionId} archived`);
    localStorage.removeItem('lazy.locale');
  });

  it('deletes a NON-terminal mission outright and appends the REAL grounded outcome', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Still queued', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'delete_mission', missionId }]);

    expect(result.current.missions.find((m) => m.id === missionId)).toBeUndefined();
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toBe(`Real outcome: Mission ${missionId} deleted`);
    localStorage.removeItem('lazy.locale');
  });
});

// ── Grounded real-result message appended to the chat transcript (P0-3 fix)
// The chat bubble must reflect what REALLY happened, sourced from
// executeManagerAction's own return value — never the model's own
// free-form prose (proven live to diverge completely: "17 missions
// supprimées" narrated while exactly ONE mission actually vanished).

describe('executeManagerAction — grounded real-result message appended to chat (P0-3 fix)', () => {
  it('clear_canvas appends the REAL result to the chat transcript, not just an ephemeral toast', async () => {
    localStorage.setItem('lazy.locale', 'en');
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addNote({ id: 'n1', text: 'x' });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'all' }]);

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toBe('Real outcome: 2 item(s) cleared — draft:d1, note:n1');
    localStorage.removeItem('lazy.locale');
  });

  it('archive_terminated appends the REAL count to the chat transcript', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Done', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const doneId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: doneId, patch: { status: 'done' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'archive_terminated' }]);

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toBe(`Real outcome: 1 terminal mission(s) archived (${doneId})`);
    localStorage.removeItem('lazy.locale');
  });

  it('a bulk cleanup that affects NOTHING still reports it honestly in the chat transcript (never a fabricated count)', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'drafts' }]);

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toBe('Real outcome: Nothing to clean up — no matching item found');
    localStorage.removeItem('lazy.locale');
  });
});

// ── Single-node delete/close actions ─────────────────────────────────────

describe('executeManagerAction — delete_draft / delete_note / delete_router / delete_join / delete_frame / close_surface', () => {
  it('delete_draft removes an existing draft', async () => {
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'delete_draft', draftId: 'd1' }]);
    expect(canvasStoreVanilla.getState().drafts).toHaveLength(0);
  });

  it('delete_draft reports honestly for an unknown id', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'delete_draft', draftId: 'ghost' }]);
    expect(screen.getByText('Draft ghost not found')).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });

  it('delete_note removes an existing note', async () => {
    canvasStoreVanilla.getState().addNote({ id: 'n1', text: 'x' });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'delete_note', noteId: 'n1' }]);
    expect(canvasStoreVanilla.getState().notes).toHaveLength(0);
  });

  it('delete_note reports honestly for an unknown id', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'delete_note', noteId: 'ghost' }]);
    expect(screen.getByText('Note ghost not found')).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });

  it('delete_router removes an existing router', async () => {
    canvasStoreVanilla.getState().addRouter({ id: 'r1', branches: [{ id: 'b1', label: 'x', condition: { kind: 'default' } }] });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'delete_router', routerId: 'r1' }]);
    expect(canvasStoreVanilla.getState().routers).toHaveLength(0);
  });

  it('delete_join removes an existing join', async () => {
    canvasStoreVanilla.getState().addJoin({ id: 'j1', sourceRefs: [], mode: 'all_success' });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'delete_join', joinId: 'j1' }]);
    expect(canvasStoreVanilla.getState().joins).toHaveLength(0);
  });

  it('delete_frame removes an existing frame — never its contained nodes (a frame is furniture, not ownership)', async () => {
    canvasStoreVanilla.getState().addFrame({ id: 'f1', title: 'Group', width: 100, height: 100 });
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'delete_frame', frameId: 'f1' }]);
    expect(canvasStoreVanilla.getState().frames).toHaveLength(0);
    expect(canvasStoreVanilla.getState().drafts).toHaveLength(1);
  });

  it('close_surface removes an existing surface', async () => {
    canvasStoreVanilla.getState().addSurface({ id: 's1', kind: 'terminal' });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'close_surface', surfaceId: 's1' }]);
    expect(canvasStoreVanilla.getState().surfaces).toHaveLength(0);
  });

  it('close_surface reports honestly for an unknown id', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'close_surface', surfaceId: 'ghost' }]);
    expect(screen.getByText('Surface ghost not found')).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });
});

// ── reject_plan — retroactive plan-proposal rejection (types.ts) ────────
//
// The manager's only prior way to clear a pending plan proposal was the
// chat card's own "Rejeter" button, scoped to THIS turn's own card. This
// action makes canvasStore's rejectProposedPlan reachable retroactively, by
// planId, for an OLDER proposal left orphaned at 'planning' — the manual
// counterpart of canvasProposalCleanup.ts's automatic stale-proposal sweep.
describe('executeManagerAction — reject_plan (retroactive plan-proposal rejection)', () => {
  it('removes every draft tagged with the planId, leaving unrelated drafts untouched', async () => {
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1', proposedPlanId: 'plan-x', projectId: 'proj-a' }));
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd2', proposedPlanId: 'plan-x', projectId: 'proj-a' }));
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd3' })); // real, unrelated draft — must survive
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'reject_plan', planId: 'plan-x' }]);
    expect(canvasStoreVanilla.getState().drafts.map((d) => d.id)).toEqual(['d3']);
  });

  it('also removes joins tagged with the planId (fan-in previews, not just drafts)', async () => {
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1', proposedPlanId: 'plan-y', projectId: 'proj-a' }));
    canvasStoreVanilla.getState().addJoin({ id: 'j1', proposedPlanId: 'plan-y', sourceRefs: [], mode: 'all_success' });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'reject_plan', planId: 'plan-y' }]);
    expect(canvasStoreVanilla.getState().drafts).toHaveLength(0);
    expect(canvasStoreVanilla.getState().joins).toHaveLength(0);
  });

  it('reports honestly when nothing on the canvas is tagged with the planId (never a silent no-op success)', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'reject_plan', planId: 'plan-ghost' }]);
    expect(screen.getByText('Plan plan-ghost not found')).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });
});

// ── collapse_project — real-user bug fix ─────────────────────────────────

describe('executeManagerAction — collapse_project resolves a project NAME, not just a raw id (bug fix)', () => {
  it('resolves a project display name to its real id before toggling collapsed', async () => {
    installProjects([{ root: 'Lazy', active: true }]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    // The manager referring to the project by its lowercase display name
    // (as it routinely does — the digest shows both id and name) used to
    // silently toggle a bogus 'lazy' entry that nothing on the canvas reads.
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'collapse_project', projectId: 'lazy', collapsed: true }]);

    expect(canvasStoreVanilla.getState().collapsed['Lazy']).toBe(true);
    expect(canvasStoreVanilla.getState().collapsed['lazy']).toBeUndefined();
  });

  it('still falls back to the raw value when it resolves to nothing (never regresses the pre-fix behavior)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'collapse_project', projectId: 'proj-1', collapsed: true }]);
    expect(canvasStoreVanilla.getState().collapsed['proj-1']).toBe(true);
  });
});

// ── close_project ─────────────────────────────────────────────────────────

describe('executeManagerAction — close_project', () => {
  it('reports honestly when project management is unavailable (no AppProvider ancestor)', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'close_project', projectId: 'demo' }]);
    expect(screen.getByText('Project management is not available here')).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });
});

describe('executeManagerAction — close_project (with a real AppProvider ancestor)', () => {
  function appWrapper({ children }: { children: React.ReactNode }) {
    return (
      <AppProvider>
        <I18nProvider>
          <ToastProvider>
            <AgentsStoreProvider>{children}</AgentsStoreProvider>
          </ToastProvider>
        </I18nProvider>
      </AppProvider>
    );
  }

  function useCombined() {
    return { app: useAppContext(), store: useAgentsStore() };
  }

  beforeEach(() => {
    simulateTauri();
  });

  afterEach(() => {
    clearTauriSimulation();
  });

  it('closes a non-active project directly — no switch needed', async () => {
    const projects = [
      { id: 'reg-active', root: 'active-root', brainId: null, active: true },
      { id: 'reg-other', root: 'other-root', brainId: null, active: false },
    ];
    mockInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'project_list') return projects;
      if (cmd === 'project_close') {
        const idx = projects.findIndex((p) => p.id === (args as { id?: string } | undefined)?.id);
        if (idx >= 0) projects.splice(idx, 1);
        return undefined;
      }
      return undefined;
    });

    const { result } = renderHook(() => useCombined(), { wrapper: appWrapper });
    await waitFor(() => expect(result.current.app.openProjects).toHaveLength(2));

    // 'other-root' — the journal projectId (a bare root string is
    // near-identity, see installProjects's own doc comment) — not the
    // registry id 'reg-other' the manager never sees.
    await dispatch(result.current.store.sendManagerMessage, result.current.store.activeConversationId, [{ type: 'close_project', projectId: 'other-root' }]);

    await waitFor(() => expect(result.current.app.openProjects).toHaveLength(1));
    expect(result.current.app.openProjects[0].id).toBe('reg-active');
  });

  it('switches to another open project first when closing the ACTIVE one (AppContext.closeProject would otherwise reject)', async () => {
    const projects = [
      { id: 'reg-active', root: 'active-root', brainId: null, active: true },
      { id: 'reg-other', root: 'other-root', brainId: null, active: false },
    ];
    const setActiveCalls: string[] = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'project_list') return projects;
      if (cmd === 'project_set_active') {
        const id = (args as { id?: string } | undefined)?.id;
        setActiveCalls.push(String(id));
        for (const p of projects) p.active = p.id === id;
        return undefined;
      }
      if (cmd === 'project_close') {
        const idx = projects.findIndex((p) => p.id === (args as { id?: string } | undefined)?.id);
        if (idx >= 0) projects.splice(idx, 1);
        return undefined;
      }
      return undefined;
    });

    const { result } = renderHook(() => useCombined(), { wrapper: appWrapper });
    await waitFor(() => expect(result.current.app.openProjects).toHaveLength(2));

    await dispatch(result.current.store.sendManagerMessage, result.current.store.activeConversationId, [{ type: 'close_project', projectId: 'active-root' }]);

    await waitFor(() => expect(result.current.app.openProjects).toHaveLength(1));
    expect(setActiveCalls).toContain('reg-other');
    expect(result.current.app.openProjects[0].id).toBe('reg-other');
  });

  it('reports an honest reason when the Rust command itself fails', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const projects = [{ id: 'reg-only', root: 'only-root', brainId: null, active: true }];
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'project_list') return projects;
      if (cmd === 'project_close') throw new Error('cannot close the last open project');
      return undefined;
    });

    const { result } = renderHook(() => useCombined(), { wrapper: appWrapper });
    await waitFor(() => expect(result.current.app.openProjects).toHaveLength(1));

    await dispatch(result.current.store.sendManagerMessage, result.current.store.activeConversationId, [{ type: 'close_project', projectId: 'only-root' }]);

    expect(result.current.app.openProjects).toHaveLength(1);
    expect(
      screen.getByText('Could not close project "only-root": cannot close the last open project'),
    ).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });
});
