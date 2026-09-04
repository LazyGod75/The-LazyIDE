/**
 * CanvasView.test.tsx — W1c assembly smoke tests. Mounts the REAL
 * `<CanvasView/>` tree (React Flow + reconciler + canvasStore + node/edge
 * components, wrapped in the same providers Cockpit.tsx renders under) and
 * proves the two acceptance-critical shapes from the plan's W1c section:
 * fixture projects render as a project zone + mission nodes, and zero open
 * projects render the honest empty state instead of a blank canvas.
 *
 * Deeper interaction coverage (drag/chain/toolbar/keyboard) is left to W2's
 * own waves and the W6 screenshot/e2e harness — this file only proves the
 * assembly wires up for real, matching the "renders fixture projects ->
 * project zone + mission nodes appear; empty state on zero projects" bar
 * from the plan.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AppProvider } from '../app/AppContext';
import { AgentsStoreProvider } from '../components/agents/agentsStore';
import { CanvasView, nodeMinimapColor } from '../components/agents/canvas/CanvasView';
import type { CanvasReactFlowNode } from '../components/agents/canvas/reconciler';
import { deriveMissionLiveness, statusAccentColor, typeAccentColor } from '../components/agents/canvas/chrome/nodeChrome';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { makeRef } from '../components/agents/canvas/canvasTypes';
import { emit } from '../lib/bus';
import type { FleetProject } from '../lib/agents/fleetMissions';
import { installReactFlowTestEnv } from './canvasTestEnv';

installReactFlowTestEnv();

// P2-15 — this file's own "surface exposes a target Handle" block below is
// the only place in this file that mounts a REAL terminal surface through
// the full CanvasView tree (every other test here only ever adds mission/
// project/router fixtures). A real TerminalNode mounts the REAL xterm-based
// TerminalView, which needs browser APIs jsdom doesn't provide
// (window.matchMedia) — same reason TerminalNode.test.tsx stubs it
// wholesale rather than polyfilling xterm's own internals.
vi.mock('../components/terminal/TerminalView', () => ({
  TerminalView: () => <div data-testid="stub-terminal-view" />,
}));

// invoke is globally mocked in setup.ts (vi.mock('@tauri-apps/api/core', ...))
// to resolve undefined by default — same convention as appContextProjects.test.tsx.
const mockInvoke = invoke as ReturnType<typeof vi.fn>;

/** Simulates a Tauri runtime (window.__TAURI_INTERNALS__) so
 *  AppContext.projectsHydrated starts `false` instead of the web-mode
 *  "already hydrated" shortcut — same convention as agentsStore.test.tsx's
 *  own simulateTauri/clearTauriSimulation pair. */
function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

function clearTauriSimulation(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

const FIXTURE_PROJECTS: FleetProject[] = [
  {
    projectId: 'demo-shop',
    root: '/fixtures/demo-shop',
    name: 'demo-shop',
    missions: [
      {
        id: 'm-1',
        title: 'Fix checkout bug',
        status: 'running',
        stage: 'code',
        model: 'sonnet',
        liveAction: 'Bash: npm test',
        progress: 42,
        updatedMs: Date.now(),
        urgent: false,
      },
    ],
  },
];

function renderCanvasView(props: Partial<React.ComponentProps<typeof CanvasView>> = {}) {
  return render(
    <I18nProvider>
      <ToastProvider>
        <AppProvider>
          <AgentsStoreProvider>
            <CanvasView
              projects={FIXTURE_PROJECTS}
              highlightIds={new Set()}
              justMergedId={null}
              forceApproveIds={new Set()}
              onOpenMission={() => {}}
              onUrgentAction={() => {}}
              onOpenLibrary={() => {}}
              {...props}
            />
          </AgentsStoreProvider>
        </AppProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

// ── W5b deliverable #5b: 150-node render smoke ────────────────────────
//
// A local fixture builder (deliberately NOT imported from
// canvasPerf.test.ts — every test file in this suite builds its own small
// fixtures, e.g. reconciler.test.ts's own `mission()`/`project()`, rather
// than sharing test-only helpers across files).

const PERF_PROJECT_COUNT = 8;
const PERF_TOTAL_MISSIONS = 150;

function buildPerfFixtureProjects(missionStatus: FleetProject['missions'][number]['status'] = 'running'): FleetProject[] {
  const projects: FleetProject[] = Array.from({ length: PERF_PROJECT_COUNT }, (_, i) => ({
    projectId: `perf-proj-${i}`,
    root: `/fixtures/perf-proj-${i}`,
    name: `Perf Project ${i}`,
    missions: [],
  }));
  for (let i = 0; i < PERF_TOTAL_MISSIONS; i += 1) {
    projects[i % PERF_PROJECT_COUNT]!.missions.push({
      id: `perf-mission-${i}`,
      title: `Perf mission ${i}`,
      status: missionStatus,
      stage: (['plan', 'code', 'test', 'review', 'merged'] as const)[i % 5],
      model: 'sonnet',
      updatedMs: Date.now(),
      urgent: false,
    });
  }
  return projects;
}

// ── W5b deliverable #6: arrival mount animation + fleet-poll placement ──

function oneProjectOneMission(missionId = 'm-1'): FleetProject[] {
  return [
    {
      projectId: 'arrival-proj',
      root: '/fixtures/arrival-proj',
      name: 'arrival-proj',
      missions: [
        { id: missionId, title: 'Existing', status: 'running', stage: 'code', model: 'sonnet', updatedMs: Date.now(), urgent: false },
      ],
    },
  ];
}

function rerenderCanvasView(rerender: (ui: React.ReactElement) => void, projects: FleetProject[]) {
  rerender(
    <I18nProvider>
      <ToastProvider>
        <AppProvider>
          <AgentsStoreProvider>
            <CanvasView
              projects={projects}
              highlightIds={new Set()}
              justMergedId={null}
              forceApproveIds={new Set()}
              onOpenMission={() => {}}
              onUrgentAction={() => {}}
              onOpenLibrary={() => {}}
            />
          </AgentsStoreProvider>
        </AppProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

describe('CanvasView — assistant/fleet-poll arrival (W5b #6)', () => {
  it('a mission added by a later poll (same project, new id) appears at a free position in the right zone with the mount pulse, while the pre-existing mission does not re-bounce', async () => {
    const { rerender } = renderCanvasView({ projects: oneProjectOneMission() });
    expect(await screen.findByTestId('mission-node-m-1')).toBeInTheDocument();

    // Simulate the fleet poll (useFleetMissions) picking up a brand-new
    // mission in the SAME project — the exact shape a real 'agent:launch'
    // -> addMission -> journal -> reconciler arrival takes.
    const withNewArrival: FleetProject[] = [
      {
        ...oneProjectOneMission()[0]!,
        missions: [
          ...oneProjectOneMission()[0]!.missions,
          { id: 'm-2-arrived', title: 'Just launched', status: 'queued', stage: 'plan', model: 'sonnet', updatedMs: Date.now(), urgent: false },
        ],
      },
    ];
    rerenderCanvasView(rerender, withNewArrival);

    const newNode = await screen.findByTestId('rf__node-mission:m-2-arrived');
    expect(newNode.className).toContain('canvas-bounce-once');

    const existingNode = screen.getByTestId('rf__node-mission:m-1');
    expect(existingNode.className).not.toContain('canvas-bounce-once');

    // Placement: the new node is a real child of its project zone (parent
    // attribute lives on the React Flow node data-id, verified via the
    // inner card rendering under the same zone).
    expect(screen.getByTestId('project-node-arrival-proj')).toBeInTheDocument();
    expect(screen.getByTestId('mission-node-m-2-arrived')).toBeInTheDocument();
  });

  it('a full unmount/remount (Cockpit tab-switch equivalent) does NOT re-bounce already-known missions', async () => {
    const missionId = `m-remount-${Date.now()}`;
    const { unmount } = renderCanvasView({ projects: oneProjectOneMission(missionId) });
    await screen.findByTestId(`rf__node-mission:${missionId}`);
    unmount();

    renderCanvasView({ projects: oneProjectOneMission(missionId) });
    const node = await screen.findByTestId(`rf__node-mission:${missionId}`);
    // Real remount behavior fixed by W5b #6: the module-level "seen" set
    // (useCanvasFlowGraph.ts) survives the unmount, so a mission the app
    // already knew about before the tab switch is NOT treated as newly
    // arrived a second time.
    expect(node.className).not.toContain('canvas-bounce-once');
  });
});

describe('CanvasView — O/L/D per-node inspect shortcuts (W5b #2)', () => {
  // NOTE: real node SELECTION in React Flow v12 happens through
  // `@xyflow/system`'s XYDrag pointer-tracking (native pointerdown binding,
  // not a React `onClick`) — jsdom's synthetic `fireEvent.click`/
  // `pointerDown`/`pointerUp` do not drive it (confirmed by direct
  // experiment), so a real end-to-end "click a node, then press O" test
  // is not reliably reproducible under vitest/jsdom for this RF version.
  // The keyboard DISPATCH itself (Ctrl+K / O / L / D branches reading
  // `handlers.onOpenSelectedMission`/etc.) is unit-tested directly against
  // useCanvasKeyboard.ts in canvasKeyboardShortcuts.test.tsx; this test
  // instead proves the "is a no-op with nothing selected" half of the
  // CanvasView-level wiring, which needs no real selection to observe.
  it('is a no-op when nothing is selected (no crash, callback never fires)', async () => {
    const onOpenMission = vi.fn();
    renderCanvasView({ projects: oneProjectOneMission('m-noop'), onOpenMission });
    await screen.findByTestId('rf__node-mission:m-noop');

    fireEvent.mouseEnter(screen.getByTestId('canvas-view'));
    fireEvent.keyDown(window, { key: 'o' });
    fireEvent.keyDown(window, { key: 'l' });
    fireEvent.keyDown(window, { key: 'd' });

    expect(onOpenMission).not.toHaveBeenCalled();
  });
});

describe('CanvasView — toolbar « Masquer mergées » toggle (W5b #3)', () => {
  it('hides a merged mission node once toggled on, and shows it again once toggled off', async () => {
    const projects: FleetProject[] = [
      {
        projectId: 'demo-shop',
        root: '/fixtures/demo-shop',
        name: 'demo-shop',
        missions: [
          { id: 'm-live', title: 'Still running', status: 'running', stage: 'code', model: 'sonnet', updatedMs: Date.now(), urgent: false },
          { id: 'm-done', title: 'Merged already', status: 'done', stage: 'merged', model: 'sonnet', updatedMs: Date.now(), urgent: false },
        ],
      },
    ];
    renderCanvasView({ projects });
    expect(await screen.findByTestId('mission-node-m-done')).toBeInTheDocument();

    // R1b toolbar redesign — "Masquer mergées" now lives inside the "⋯"
    // overflow menu (CanvasToolbar.tsx's OverflowMenu), not directly on the
    // main row.
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    const toggle = await screen.findByTestId('canvas-toolbar-hide-merged');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);

    await waitFor(() => expect(screen.queryByTestId('mission-node-m-done')).not.toBeInTheDocument());
    expect(screen.getByTestId('mission-node-m-live')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(toggle);
    expect(await screen.findByTestId('mission-node-m-done')).toBeInTheDocument();
  });
});

describe('CanvasView — 150-node render smoke (W5b #5b)', () => {
  it('mounts a 150-mission / 8-project fixture without throwing', async () => {
    renderCanvasView({ projects: buildPerfFixtureProjects() });
    expect(await screen.findByTestId('canvas-view')).toBeInTheDocument();
    expect(await screen.findByTestId('mission-node-perf-mission-0')).toBeInTheDocument();
    expect(screen.getByTestId('mission-node-perf-mission-149')).toBeInTheDocument();
  });

  it('remounting with one status change re-renders without throwing', async () => {
    // Explicit generous budget: this smoke renders 150 React Flow nodes
    // TWICE (initial mount + full rerender with a status change) through the
    // whole provider stack in jsdom — under CI load the default 5000ms
    // budget is a coin flip (observed flaking both ways on the same commit).
    // The assertion is "does not throw", not a latency claim, so a 20s cap
    // only removes the flake.
    const { rerender } = renderCanvasView({ projects: buildPerfFixtureProjects('running') });
    expect(await screen.findByTestId('mission-node-perf-mission-0')).toBeInTheDocument();

    const changed = buildPerfFixtureProjects('running');
    changed[0]!.missions[0]!.status = 'done';
    rerender(
      <I18nProvider>
        <ToastProvider>
          <AppProvider>
            <AgentsStoreProvider>
              <CanvasView
                projects={changed}
                highlightIds={new Set()}
                justMergedId={null}
                forceApproveIds={new Set()}
                onOpenMission={() => {}}
                onUrgentAction={() => {}}
                onOpenLibrary={() => {}}
              />
            </AgentsStoreProvider>
          </AppProvider>
        </ToastProvider>
      </I18nProvider>,
    );

    expect(await screen.findByTestId('mission-node-perf-mission-0')).toBeInTheDocument();
    expect(screen.getByTestId('mission-node-perf-mission-149')).toBeInTheDocument();
  }, 20_000);
});

describe('CanvasView — assembly (W1c)', () => {
  it('renders a project zone and its mission node from fixture projects', async () => {
    renderCanvasView();
    expect(await screen.findByTestId('project-node-demo-shop')).toBeInTheDocument();
    expect(await screen.findByTestId('mission-node-m-1')).toBeInTheDocument();
    expect(screen.getByTestId('mission-node-title')).toHaveTextContent('Fix checkout bug');
  });

  it('renders the React Flow toolbar (fit/zoom/minimap) once projects are open, « Bibliothèque » behind the "⋯" overflow (R1b redesign)', async () => {
    renderCanvasView();
    expect(await screen.findByTestId('canvas-toolbar')).toBeInTheDocument();
    // R1b toolbar redesign — « Bibliothèque » no longer sits on the main
    // row; it's folded into the trailing "⋯" overflow menu.
    expect(screen.queryByTestId('open-library-chip')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    expect(await screen.findByTestId('open-library-chip')).toBeInTheDocument();
  });

  it('renders the empty-state hero (no toolbar, no canvas) when zero projects are open', () => {
    renderCanvasView({ projects: [] });
    expect(screen.getByTestId('canvas-empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-view')).not.toBeInTheDocument();
    expect(screen.queryByTestId('canvas-toolbar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('canvas-empty-open-project')).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas-empty-desktop-hint')).toBeInTheDocument();
  });

  // W-FINAL stitch — <PresenceOverlay/> (spec 2c) is mounted unconditionally
  // inside the ReactFlow tree; it's self-contained (no props, resolves org/
  // project/self internally) and renders nothing whenever presence isn't
  // genuinely active. This test env has no signed-in user and no active
  // team/org (AppProvider/AgentsStoreProvider defaults, no auth mocked), so
  // useFleetPresence's own `active` derivation is false here — the real
  // solo/no-org degrade path, not a mocked one (see PresenceOverlay.test.tsx
  // for the mocked-hook chip/halo coverage).
  it('mounts <PresenceOverlay/> which renders nothing solo/no-org', async () => {
    renderCanvasView();
    await screen.findByTestId('project-node-demo-shop');
    expect(screen.queryByTestId('presence-overlay-chips')).not.toBeInTheDocument();
  });
});

// R1b defect #3 — the canvas pane was found rendering UNDER the 460px
// LazyManager rail (nodes/buttons hidden past the rail's left edge). Root
// cause: this component's own top-level wrapper (a flex item inside
// Cockpit.tsx's two-column row) was missing `minWidth: 0` — the flexbox
// "automatic minimum size" (min-width:auto default) let it grow to its
// content's intrinsic width instead of shrinking to the flex-allocated
// column width, so its real DOM box (and the <ReactFlow> it sizes to
// 100%) ended up wider than the visible column and painted under the
// rail. jsdom has no real layout engine (canvasTestEnv.ts's own header),
// so this only proves the STYLE fix is in place — the actual pixel-width
// clipping is confirmed by the e2e re-run (see R1b's own report).
describe('CanvasView — container sizing (R1b defect #3 fix)', () => {
  it('the canvas-view wrapper has minWidth:0 and overflow:hidden so it can shrink inside Cockpit.tsx\'s flex column instead of overflowing under the rail', async () => {
    renderCanvasView();
    const el = await screen.findByTestId('canvas-view');
    expect(el.style.minWidth).toBe('0');
    expect(el.style.overflow).toBe('hidden');
    // jsdom expands the `flex` shorthand to its longhand form (grow/shrink/
    // basis) rather than echoing back the `1` we set — assert the
    // meaningful part (flex-grow) instead of the raw shorthand string.
    expect(el.style.flexGrow).toBe('1');
  });
});

// ── W9 — CanvasPalette's onAddRouter wiring (flagged unwired by W8c,
// closed by useCanvasEditing.ts's handlePaletteAddRouter) ────────────────

describe('CanvasView — palette « + Router » wiring (W9)', () => {
  beforeEach(() => {
    _resetCanvasStoreForTests();
  });
  afterEach(() => {
    _resetCanvasStoreForTests();
  });

  it('a router can be added via the palette path: open palette -> click the router entry -> a real router lands in canvasStore and renders on the canvas', async () => {
    renderCanvasView();
    await screen.findByTestId('project-node-demo-shop');
    expect(canvasStoreVanilla.getState().routers).toHaveLength(0);

    // Open the palette drawer via the toolbar button (same real trigger a
    // human uses — CanvasToolbar.tsx's `onTogglePalette`). fix/canvas-
    // toolbar-oscillation Option B moved palette into the "⋯" overflow menu
    // (it is no longer inline on the main row), so reaching it now goes
    // through the overflow toggle first, same as a real user would.
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    fireEvent.click(screen.getByTestId('canvas-toolbar-palette-toggle-demoted'));
    const routerEntry = await screen.findByTestId('canvas-palette-item-router');

    fireEvent.click(routerEntry);

    // Store-level proof: the real canvasStore.addRouter primitive ran (not
    // a no-op), with the same default 2-branch (success/default) shape
    // CanvasContextMenu.tsx's own "Nouveau routeur ici" entry creates.
    await waitFor(() => expect(canvasStoreVanilla.getState().routers).toHaveLength(1));
    const router = canvasStoreVanilla.getState().routers[0]!;
    expect(router.branches).toHaveLength(2);

    // Render-level proof: the reconciler picked it up and a real router
    // node mounted for it on the very next render.
    expect(await screen.findByTestId(`rf__node-router:${router.id}`)).toBeInTheDocument();
  });
});

// ── R1-final stitch #1 — boot skeleton gate (AppContext.projectsHydrated) ──
//
// Web-mode (the rest of this file's default) starts `projectsHydrated` at
// `true` synchronously (AppContext.tsx's own doc comment: nothing to
// hydrate outside Tauri), so these two tests simulate a real Tauri runtime
// and control `project_list`'s resolution timing directly to observe both
// sides of the gate: the loading window (still in flight) and the moment
// hydration settles with zero projects.

describe('CanvasView — boot skeleton gate (R1-final)', () => {
  beforeEach(() => {
    simulateTauri();
    mockInvoke.mockReset();
  });

  afterEach(() => {
    clearTauriSimulation();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
  });

  it('renders the loading skeleton — never the dead hero, never the live canvas — while hydration is still in flight', async () => {
    // A project_list() that never resolves keeps projectsHydrated at
    // `false` for the lifetime of this test — the honest "still working"
    // window this gate exists to cover.
    mockInvoke.mockImplementation(() => new Promise(() => {}));

    render(
      <I18nProvider>
        <ToastProvider>
          <AppProvider>
            <AgentsStoreProvider>
              <CanvasView
                projects={[]}
                highlightIds={new Set()}
                justMergedId={null}
                forceApproveIds={new Set()}
                onOpenMission={() => {}}
                onUrgentAction={() => {}}
                onOpenLibrary={() => {}}
              />
            </AgentsStoreProvider>
          </AppProvider>
        </ToastProvider>
      </I18nProvider>,
    );

    expect(await screen.findByTestId('canvas-loading-state')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-empty-state')).not.toBeInTheDocument();
    expect(screen.queryByTestId('canvas-view')).not.toBeInTheDocument();
  });

  it('renders the empty-state hero once hydration settles with zero registered projects', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => (cmd === 'project_list' ? [] : undefined));

    render(
      <I18nProvider>
        <ToastProvider>
          <AppProvider>
            <AgentsStoreProvider>
              <CanvasView
                projects={[]}
                highlightIds={new Set()}
                justMergedId={null}
                forceApproveIds={new Set()}
                onOpenMission={() => {}}
                onUrgentAction={() => {}}
                onOpenLibrary={() => {}}
              />
            </AgentsStoreProvider>
          </AppProvider>
        </ToastProvider>
      </I18nProvider>,
    );

    expect(await screen.findByTestId('canvas-empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-loading-state')).not.toBeInTheDocument();
  });
});

// ── R1-final stitch #2 — zone-digest « Lancer un agent » CTA wiring ────────
//
// ProjectGroupNode.tsx's zone-digest CTA (defect #6 fix) emits
// 'canvas:launchAgentForProject' but nothing subscribed yet (bus.ts's own
// doc comment flags this as the orchestrator-stitch handoff). The honest
// wiring opens the SAME quick-create modal the palette/command-bar/
// context-menu already share, pre-targeted at the project's zone.

describe('CanvasView — zone-digest "Lancer un agent" CTA wiring (R1-final)', () => {
  it('opens the quick-create modal when canvas:launchAgentForProject fires for a rendered zone', async () => {
    renderCanvasView();
    await screen.findByTestId('project-node-demo-shop');
    expect(screen.queryByTestId('canvas-quickcreate-modal')).not.toBeInTheDocument();

    act(() => {
      emit('canvas:launchAgentForProject', { projectId: 'demo-shop' });
    });

    expect(await screen.findByTestId('canvas-quickcreate-modal')).toBeInTheDocument();
  });

  it('is a no-op (no modal) for a projectId with no rendered zone', async () => {
    renderCanvasView();
    await screen.findByTestId('project-node-demo-shop');

    act(() => {
      emit('canvas:launchAgentForProject', { projectId: 'not-a-real-project' });
    });

    // Give the effect a tick, then confirm it never opened the modal.
    await waitFor(() => expect(screen.queryByTestId('canvas-quickcreate-modal')).not.toBeInTheDocument());
  });
});

// ── P2-15 fix — preview/terminal/search surfaces expose a real target
//    Handle (React Flow error 008 fix) ──────────────────────────────────
//
// Real QA repro: PreviewNode.tsx/TerminalNode.tsx/SearchNode.tsx rendered NO
// `<Handle>` at all, so reconcilerEdges.ts's `buildSurfaceEdges` edge (id
// `surface:<ownerRef>:<surfaceId>`, mission/zone -> surface) had no
// target-handle bounds for React Flow to anchor to: `getEdgePosition`
// (@xyflow/system) couldn't resolve a target handle, called
// `onError('008', …)` — CanvasView.tsx's `handleFlowError` logged
// "React Flow error 008" on every single reconcile poll, the observed
// console-spam loop — and silently dropped the edge (`EdgeWrapper`'s
// `sourceX === null` bail-out never even mounts it).
//
// canvasTestEnv.ts's ResizeObserver stub never fires (module header), so no
// node in this suite ever reaches xyflow's internal "measured" state and no
// edge actually PAINTS under jsdom (true for every edge kind already, not
// something this fix changes or can prove here) — these tests instead
// assert the concrete, real-DOM root cause directly: each surface kind now
// mounts a `.react-flow__handle` with `data-nodeid` = its own node id and
// the `target` class, which used to not exist AT ALL (`querySelector` would
// have returned null before this fix).
describe('CanvasView — surface nodes expose a target Handle (P2-15, React Flow error 008 fix)', () => {
  beforeEach(() => {
    _resetCanvasStoreForTests();
  });
  afterEach(() => {
    _resetCanvasStoreForTests();
  });

  function targetHandleFor(container: HTMLElement, nodeId: string): Element | null {
    return Array.from(container.querySelectorAll(`.react-flow__handle[data-nodeid="${nodeId}"]`)).find((el) =>
      el.classList.contains('target'),
    ) ?? null;
  }

  it('mounts a real target Handle on a preview surface node, deliberately non-interactive (never a chain-drag affordance)', async () => {
    canvasStoreVanilla.getState().addSurface({
      id: 'preview-1',
      kind: 'preview',
      projectId: 'demo-shop',
      url: 'http://localhost:3000',
      ownerRef: makeRef('mission', 'm-1'),
    });

    const { container } = renderCanvasView();
    await screen.findByTestId('rf__node-preview:preview-1');

    const handle = targetHandleFor(container, makeRef('preview', 'preview-1'));
    expect(handle).not.toBeNull();
    // Never a user-facing "drag to connect" affordance (a preview is not a
    // valid chain endpoint per chainValidation.ts) — deliberately marked
    // non-connectable, unlike MissionNode/DraftNode/etc.'s visible dots.
    expect(handle!.classList.contains('connectable')).toBe(false);
  });

  it('mounts a real target Handle on a terminal surface node too', async () => {
    canvasStoreVanilla.getState().addSurface({
      id: 'terminal-1',
      kind: 'terminal',
      projectId: 'demo-shop',
      cwd: '/repo',
      ownerRef: makeRef('mission', 'm-1'),
    });

    const { container } = renderCanvasView();
    await screen.findByTestId('rf__node-terminal:terminal-1');

    expect(targetHandleFor(container, makeRef('terminal', 'terminal-1'))).not.toBeNull();
  });

  it('mounts a real target Handle on a search surface node too (SearchNode reuses the preview slot)', async () => {
    canvasStoreVanilla.getState().addSurface({
      id: 'search-1',
      kind: 'preview',
      projectId: 'demo-shop',
      ownerRef: makeRef('mission', 'm-1'),
      searchSurface: { history: [] },
    });

    const { container } = renderCanvasView();
    await screen.findByTestId('rf__node-preview:search-1');

    expect(targetHandleFor(container, makeRef('preview', 'search-1'))).not.toBeNull();
  });
});

// fix/canvas-ux R4d (dogfood defect #5) — the minimap used to show "zone
// blobs only, no node dots": a child node reused the EXACT SAME
// `projectColor(projectId)` fill its own parent zone rect already used
// (reconcilerZones.ts's `buildProjectNode`), so a node's minimap rect was
// visually identical to the zone behind it. `nodeMinimapColor` now colors a
// node by its own STATUS (mission/loop) or its iteration status, falling
// back to the node KIND's type accent — never the parent zone's color.
describe('nodeMinimapColor — node dots distinct from their zone (fix/canvas-ux R4d defect #5)', () => {
  function node(overrides: Partial<CanvasReactFlowNode>): CanvasReactFlowNode {
    return { id: 'n1', position: { x: 0, y: 0 }, data: {}, ...overrides } as CanvasReactFlowNode;
  }

  it('a project (zone) node keeps its own zone color', () => {
    const zoneColor = 'hsl(220 65% 62%)';
    const result = nodeMinimapColor(node({ type: 'project', data: { color: zoneColor } } as Partial<CanvasReactFlowNode>));
    expect(result).toBe(zoneColor);
  });

  it('a mission node is colored by its OWN status, never the zone projectColor', () => {
    const running = node({
      type: 'mission',
      data: { projectId: 'p1', mission: { status: 'running', paused: false } },
    } as Partial<CanvasReactFlowNode>);
    const failed = node({
      type: 'mission',
      data: { projectId: 'p1', mission: { status: 'failed', paused: false } },
    } as Partial<CanvasReactFlowNode>);

    expect(nodeMinimapColor(running)).toBe(statusAccentColor(deriveMissionLiveness({ status: 'running', paused: false })));
    expect(nodeMinimapColor(failed)).toBe(statusAccentColor(deriveMissionLiveness({ status: 'failed', paused: false })));
    // The two statuses must render as genuinely different colors — the
    // whole point of the fix (never the same flat projectColor for both).
    expect(nodeMinimapColor(running)).not.toBe(nodeMinimapColor(failed));
  });

  it('an iteration node is colored by its own status field directly', () => {
    const result = nodeMinimapColor(
      node({ type: 'iteration', data: { status: 'done' } } as Partial<CanvasReactFlowNode>),
    );
    expect(result).toBe(statusAccentColor(deriveMissionLiveness({ status: 'done', paused: false })));
  });

  it('a status-less kind (draft/note/router/schedule) falls back to its own type accent, never the zone color', () => {
    const draft = nodeMinimapColor(node({ type: 'draft', data: { projectId: 'p1' } } as Partial<CanvasReactFlowNode>));
    expect(draft).toBe(typeAccentColor('draft'));
  });
});

