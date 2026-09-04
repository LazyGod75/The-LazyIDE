/**
 * Focused test for the `start_preview` ManagerAction (W-DEVPREVIEW):
 * "lance le localhost" / "démarre le serveur de dev" / "montre le site" gets
 * a REAL, safe, non-LLM action instead of the manager either asking
 * permission (Haiku) or launching a worker mission that never actually
 * starts a server and then lies about it (Fable). Exercises the SAME real
 * path every other Agent Canvas action does (see
 * managerCanvasActions.test.tsx): parse -> sendManagerMessage ->
 * executeManagerAction's switch -> this new case.
 *
 * lib/agents/devPreview.ts's own orchestration (port heuristics,
 * reuse-if-running, PTY spawn, idle-stop, pressure gating) is covered on
 * its own (devPreview.test.ts) and mocked here so this test isolates the
 * executor WIRING: project resolution, the devPreview call, the
 * preview-surface upsert (never a duplicate), the camera-focus
 * choreography, and honest failure toasts (never a fabricated running
 * server).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, screen } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { on } from '../lib/bus';
import { parseManagerActions, runManagerTurn } from '../lib/agents/managerEngine';
import { ensureDevServerForProject } from '../lib/agents/devPreview';
import { _resetCanvasStoreForTests, canvasStoreVanilla } from '../components/agents/canvas/canvasStore';
import { makeRef, PREVIEW_FOCUS_MIN_ZOOM, ZOOM_COMPACT } from '../components/agents/canvas/canvasTypes';

const mockInvoke = vi.mocked(invoke);

/** Same helper/convention as managerCanvasActions.test.tsx/
 *  managerFrictionAction.test.tsx — `root` doubles as both the resolved
 *  projectId (projectIdFromRoot is near-identity for a plain string with no
 *  separators) and the real root path start_preview needs to hand
 *  ensureDevServerForProject. */
function installProjects(projects: Array<{ root: string; active: boolean }>): void {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'project_list') {
      return projects.map((p, i) => ({ id: `reg-${i}`, root: p.root, brainId: null, active: p.active }));
    }
    return undefined;
  });
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

// The pipeline itself (port heuristics/reuse/PTY spawn/idle-stop) is
// covered by devPreview.test.ts — this executor test only needs to prove
// the WIRING, so the whole module is replaced with its one entry point the
// executor calls.
vi.mock('../lib/agents/devPreview', () => ({
  ensureDevServerForProject: vi.fn(),
}));

// start_preview is classified 'sensitive' (gate-usability fix, 2026-07-28 —
// it spins up a real dev server process) — the gate policy itself is
// covered by actionGate.test.ts/pendingApprovals.test.tsx; this file only
// tests the executor WIRING (same convention as managerCanvasActions.test.tsx
// and siblings), so the gate is stubbed to always allow.
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

async function dispatch(sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>, conversationId: string, actions: unknown[], text = 'do it') {
  vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: actions as never, rawResponse: '' });
  await act(async () => {
    await sendManagerMessage(conversationId, text, 'haiku');
  });
}

const realLocation = window.location;

beforeEach(() => {
  _resetCanvasStoreForTests();
  vi.mocked(runManagerTurn).mockReset();
  vi.mocked(ensureDevServerForProject).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
  // Pin the locale so the toast text asserted verbatim below is
  // deterministic (same convention as managerFrictionAction.test.tsx).
  localStorage.setItem('lazy.locale', 'en');
  // Self-origin hardening (previewSurface.ts's ensureProjectPreviewSurface,
  // isBlockedSelfOriginUrl) — jsdom's own default origin
  // (http://localhost:3000) happens to collide with the resolved dev-server
  // url every test below mocks `ensureDevServerForProject` to return, which
  // would make the guard fire incidentally here (a real OTHER project's
  // preview, not this app's own dev server). Same fix
  // useCanvasAutoComposition.test.tsx's own beforeEach already applies, for
  // the identical reason (see that file's own comment).
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, origin: 'http://localhost:19999' },
  });
});

afterEach(() => {
  localStorage.removeItem('lazy.locale');
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

describe('parseManagerActions — start_preview', () => {
  it('parses with and without projectId', () => {
    expect(parseManagerActions('<lazy_actions>[{"type": "start_preview"}]</lazy_actions>')).toEqual([
      { type: 'start_preview' },
    ]);
    expect(
      parseManagerActions('<lazy_actions>[{"type": "start_preview", "projectId": "demo-shop"}]</lazy_actions>'),
    ).toEqual([{ type: 'start_preview', projectId: 'demo-shop' }]);
  });
});

describe('executeManagerAction — start_preview', () => {
  it('routes to ensureDevServerForProject with the resolved project id + real root, then shows a live preview and focuses the camera on it', async () => {
    installProjects([{ root: 'proj-1', active: true }]);
    vi.mocked(ensureDevServerForProject).mockResolvedValue({ url: 'http://localhost:3000', port: 3000, reused: false });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const navEvents: string[] = [];
    const focusEvents: Array<{ ref: string; minZoom?: number }> = [];
    const offNav = on('nav:navigateSpace', (payload) => navEvents.push(payload as string));
    const offFocus = on('canvas:focus', (payload) => focusEvents.push(payload));

    // projectId omitted -> defaults to the active project ('proj-1'), the
    // SAME resolution rule as create_draft's own "projectId".
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'start_preview' }]);

    expect(ensureDevServerForProject).toHaveBeenCalledWith('proj-1', 'proj-1', undefined, undefined, expect.objectContaining({ allowElevatedPressure: true }));

    const surfaces = canvasStoreVanilla.getState().surfaces;
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toMatchObject({ kind: 'preview', projectId: 'proj-1', url: 'http://localhost:3000' });
    // Explicit manager action — never the passive auto-detect flag (see
    // SurfaceSpec.autoAdded's own doc comment).
    expect(surfaces[0].autoAdded).toBeFalsy();

    const ref = makeRef('preview', surfaces[0].id);
    expect(navEvents).toEqual(['agents']);
    // Bug fix: start_preview used to fire canvas:focus with no zoom
    // guarantee, so a plain bounding-box fitView could leave the camera at
    // the canvas's global zoom floor (~10%) — an unreadable speck instead
    // of the live localhost the user asked to see. minZoom must be set, and
    // high enough to clear PreviewNode.tsx's own compact-chip LOD tier
    // (ZOOM_COMPACT) so the full interactive iframe actually renders.
    expect(focusEvents).toEqual([{ ref, minZoom: PREVIEW_FOCUS_MIN_ZOOM }]);
    expect(PREVIEW_FOCUS_MIN_ZOOM).toBeGreaterThan(ZOOM_COMPACT);
    expect(screen.getByText('Preview ready: "http://localhost:3000"')).toBeInTheDocument();

    offNav();
    offFocus();
  });

  it('reuses an existing preview surface for the project instead of creating a second one', async () => {
    installProjects([{ root: 'proj-1', active: true }]);
    canvasStoreVanilla.getState().addSurface({ id: 'existing', kind: 'preview', projectId: 'proj-1', url: 'http://localhost:5173' });
    vi.mocked(ensureDevServerForProject).mockResolvedValue({ url: 'http://localhost:5173', port: 5173, reused: true });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const focusEvents: string[] = [];
    const offFocus = on('canvas:focus', ({ ref }) => focusEvents.push(ref));

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'start_preview', projectId: 'proj-1' }]);

    expect(canvasStoreVanilla.getState().surfaces).toHaveLength(1);
    expect(focusEvents).toEqual([makeRef('preview', 'existing')]);
    offFocus();
  });

  it('reports an honest failure toast when the pipeline cannot confirm a server — never fabricates a running preview', async () => {
    installProjects([{ root: 'proj-1', active: true }]);
    vi.mocked(ensureDevServerForProject).mockResolvedValue(null);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const focusEvents: string[] = [];
    const offFocus = on('canvas:focus', ({ ref }) => focusEvents.push(ref));

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'start_preview' }]);

    expect(canvasStoreVanilla.getState().surfaces).toHaveLength(0);
    expect(focusEvents).toEqual([]);
    expect(screen.getByText("Could not start or reach this project's dev server")).toBeInTheDocument();
    offFocus();
  });

  it('reports an honest failure toast when there is no resolvable target project — never calls the pipeline', async () => {
    installProjects([]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'start_preview' }]);

    expect(ensureDevServerForProject).not.toHaveBeenCalled();
    expect(canvasStoreVanilla.getState().surfaces).toHaveLength(0);
    expect(screen.getByText('No target project to start a preview for')).toBeInTheDocument();
  });

  it('resolves an explicit projectId even when it is not the active project', async () => {
    installProjects([
      { root: 'scratch', active: true },
      { root: 'other-project', active: false },
    ]);
    vi.mocked(ensureDevServerForProject).mockResolvedValue({ url: 'http://localhost:5173', port: 5173, reused: true });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'start_preview', projectId: 'other-project' }]);

    expect(ensureDevServerForProject).toHaveBeenCalledWith('other-project', 'other-project', undefined, undefined, expect.objectContaining({ allowElevatedPressure: true }));
  });

  // Mention-routing backstop (2026-08-05 real incident — same defect class
  // as launch_mission's 2026-08-03 fix / generate_plan's 2026-08-04 parity
  // fix): the user had just been talking about a DIFFERENT open project and
  // a bare start_preview (no projectId) still camera-centered the ACTIVE
  // project's empty zone instead. `installProjects` marks ONE project
  // `active: true` here on purpose — the whole point of this guard is that
  // it must win over that active default, not merely apply when nothing is
  // active.
  it('routes a start_preview with no projectId to the OPEN project the user just named in this turn\'s message — never the active one', async () => {
    installProjects([
      { root: 'scratch', active: true },
      { root: 'other-project', active: false },
    ]);
    vi.mocked(ensureDevServerForProject).mockResolvedValue({ url: 'http://localhost:5173', port: 5173, reused: true });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(
      result.current.sendManagerMessage,
      result.current.activeConversationId,
      [{ type: 'start_preview' }],
      'Peux-tu me montrer le site de other-project stp',
    );

    expect(ensureDevServerForProject).toHaveBeenCalledWith('other-project', 'other-project', undefined, undefined, expect.objectContaining({ allowElevatedPressure: true }));
    const surfaces = canvasStoreVanilla.getState().surfaces;
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toMatchObject({ projectId: 'other-project' });
  });

  it('keeps the active-project default when no open project is named in the last message (no false-positive mention routing)', async () => {
    installProjects([
      { root: 'scratch', active: true },
      { root: 'other-project', active: false },
    ]);
    vi.mocked(ensureDevServerForProject).mockResolvedValue({ url: 'http://localhost:3000', port: 3000, reused: false });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(
      result.current.sendManagerMessage,
      result.current.activeConversationId,
      [{ type: 'start_preview' }],
      'lance le localhost stp',
    );

    expect(ensureDevServerForProject).toHaveBeenCalledWith('scratch', 'scratch', undefined, undefined, expect.objectContaining({ allowElevatedPressure: true }));
  });

  // P46+P48 round 2 — devPreview.ts's ensureDevServerForProject already
  // handles a plain static HTML deliverable (root index.html, no
  // package.json at all) the SAME way it handles a framework's
  // scripts.dev — see that module's own doEnsureDevServerForProject/
  // ensureStaticDevServer and devPreview.test.ts for the internal
  // branching. This executor test only needs to prove there is no
  // SEPARATE, framework-only gate here: a project with nothing but a
  // static deliverable must reach the exact same 2-argument call, surface
  // creation and camera-focus as the scripts.dev case above — never a
  // second scripts.dev-only code path, never a rejection.
  it('routes a project with no scripts.dev (a static HTML deliverable) through the exact same ensureDevServerForProject pipeline — no separate framework-only gate', async () => {
    installProjects([{ root: 'static-site', active: true }]);
    // A static deliverable is served via `npx serve` on one of
    // STATIC_SERVER_PORTS (devPreview.ts) rather than a framework's own
    // scripts.dev port — 8080 here is exactly that, never a coincidence.
    vi.mocked(ensureDevServerForProject).mockResolvedValue({ url: 'http://localhost:8080', port: 8080, reused: false });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'start_preview' }]);

    expect(ensureDevServerForProject).toHaveBeenCalledWith('static-site', 'static-site', undefined, undefined, expect.objectContaining({ allowElevatedPressure: true }));
    const surfaces = canvasStoreVanilla.getState().surfaces;
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toMatchObject({ kind: 'preview', projectId: 'static-site', url: 'http://localhost:8080' });
    expect(screen.getByText('Preview ready: "http://localhost:8080"')).toBeInTheDocument();
  });
});

// Preview lifecycle fix — "linked to the agents/missions working on it".
// state.missions only ever holds the ACTIVE project's missions (see
// agentsStore.tsx's changeApprovalMode doc comment) — these tests prove
// BOTH the happy path (active project) and the honesty guard (a
// non-active target must never get attributed the active project's
// running mission).
describe('executeManagerAction — start_preview — ownerRef', () => {
  async function addRunningMission(result: { current: ReturnType<typeof useAgentsStore> }): Promise<string> {
    await act(async () => {
      await result.current.addMission({
        title: 'Working on it',
        repo: '.',
        worktree: '',
        modelLabel: 'sonnet',
        mode: 'agent',
        orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1]!.id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'running' } });
    });
    return missionId;
  }

  it('links the created preview to the active project\'s running mission via ownerRef', async () => {
    installProjects([{ root: 'proj-1', active: true }]);
    vi.mocked(ensureDevServerForProject).mockResolvedValue({ url: 'http://localhost:3000', port: 3000, reused: false });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addRunningMission(result);

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'start_preview' }]);

    const surfaces = canvasStoreVanilla.getState().surfaces;
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]!.ownerRef).toBe(makeRef('mission', missionId));
  });

  it('never attributes the active project\'s running mission to a DIFFERENT (non-active) target project', async () => {
    installProjects([
      { root: 'proj-1', active: true },
      { root: 'other-project', active: false },
    ]);
    vi.mocked(ensureDevServerForProject).mockResolvedValue({ url: 'http://localhost:5173', port: 5173, reused: true });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await addRunningMission(result); // running, but for the ACTIVE project ('proj-1')

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'start_preview', projectId: 'other-project' }]);

    const surfaces = canvasStoreVanilla.getState().surfaces;
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]!.projectId).toBe('other-project');
    expect(surfaces[0]!.ownerRef).toBeUndefined();
  });

  // Same honesty guard as the explicit-projectId test just above, but for
  // the mention-routing backstop (2026-08-05): action.projectId is BLANK
  // here (unlike that test), which used to make isActiveProject's own
  // shortcut vacuously true regardless of where mention-routing actually
  // sent the preview — exactly the fabricated-ownerRef bug this rewrite
  // (dropping that shortcut for an always-fresh re-resolve) closes.
  it('never attributes the active project\'s running mission to a MENTION-ROUTED (non-active) target project either', async () => {
    installProjects([
      { root: 'proj-1', active: true },
      { root: 'other-project', active: false },
    ]);
    vi.mocked(ensureDevServerForProject).mockResolvedValue({ url: 'http://localhost:5173', port: 5173, reused: true });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await addRunningMission(result); // running, but for the ACTIVE project ('proj-1')

    await dispatch(
      result.current.sendManagerMessage,
      result.current.activeConversationId,
      [{ type: 'start_preview' }], // projectId BLANK — routed by mention below
      'Lance-moi le preview de other-project stp',
    );

    const surfaces = canvasStoreVanilla.getState().surfaces;
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]!.projectId).toBe('other-project');
    expect(surfaces[0]!.ownerRef).toBeUndefined();
  });

  it('omits ownerRef when the active project has no running mission (never a fabricated link)', async () => {
    installProjects([{ root: 'proj-1', active: true }]);
    vi.mocked(ensureDevServerForProject).mockResolvedValue({ url: 'http://localhost:3000', port: 3000, reused: false });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'start_preview' }]);

    expect(canvasStoreVanilla.getState().surfaces[0]!.ownerRef).toBeUndefined();
  });
});
