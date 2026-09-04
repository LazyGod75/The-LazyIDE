/**
 * useCanvasFlowGraph.test.ts — BUG 2 structural regression coverage (W6f):
 * a brand-new node and a new edge that references it must never commit into
 * React Flow's controlled `nodes`/`edges` props in the SAME synchronous
 * render pass (see the hook's own `scheduleFrame` doc comment for the full
 * race this avoids — a real-app repro where a chain existed in the store
 * and on disk with zero `.react-flow__edge` elements in the DOM).
 *
 * jsdom has no real ResizeObserver (canvasTestEnv.ts's own header — every
 * `.observe()` call is a no-op stub), so React Flow can never actually
 * measure a node's handle bounds in this test environment regardless of
 * this fix — proving the edge itself eventually PAINTS is done empirically
 * against the real desktop app (see _e2e-canvas-desktop.mjs's phase 2). This
 * test instead proves the structural half that IS deterministic and
 * jsdom-safe: `edges` never updates in the same tick as `nodes`, and it does
 * catch up shortly after.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useCanvasFlowGraph, type UseCanvasFlowGraphParams } from '../components/agents/canvas/hooks/useCanvasFlowGraph';
import { DEFAULT_CANVAS_PREFS, makeRef, type Chain, type DraftSpec } from '../components/agents/canvas/canvasTypes';
import { _resetCanvasStoreForTests, canvasStoreVanilla, useCanvasStore } from '../components/agents/canvas/canvasStore';
import type { FleetProject } from '../lib/agents/fleetMissions';
import type { FleetStateEntry } from '../components/agents/canvas/replay/replayModel';

// Real timers throughout this file — NOT vi.useFakeTimers(). React's own
// scheduler leans on real MessageChannel/setTimeout internals that fake
// timers can deadlock against `act()`'s flush; every assertion on the
// deferred edges commit below goes through `waitFor` (wraps polling in
// `act()`) rather than a bare timer wait, to avoid an "update not wrapped
// in act()" warning.

// Hoisted to module scope and reused UNCHANGED across every render/rerender
// in this file — exactly like the real CanvasView.tsx keeps these
// referentially stable via useMemo/useState/module-level constants in the
// parent. Recreating a fresh array/Set/Map/function on every render (e.g.
// inline defaults inside the renderHook callback) would make
// useCanvasFlowGraph's OWN memoized `reconciled`/`displayNodes` recompute on
// EVERY render — including the automatic re-renders `setNodes`/`setEdges`
// themselves trigger — which is a genuine infinite render loop, not a hook
// bug: new empty array in -> new reconciled array out -> setNodes/setEdges
// see a changed reference -> re-render -> repeat forever.
const EMPTY_PROJECTS: UseCanvasFlowGraphParams['projects'] = [];
const EMPTY_DRAFTS: UseCanvasFlowGraphParams['drafts'] = [];
const EMPTY_CHAINS: UseCanvasFlowGraphParams['chains'] = [];
const EMPTY_NOTES: UseCanvasFlowGraphParams['notes'] = [];
const EMPTY_SCHEDULED: UseCanvasFlowGraphParams['scheduled'] = [];
const EMPTY_POSITIONS: UseCanvasFlowGraphParams['positions'] = {};
const EMPTY_COLLAPSED: UseCanvasFlowGraphParams['collapsed'] = {};
const EMPTY_FORCE_APPROVE_IDS = new Set<string>();
const EMPTY_MISSION_LOOP_META = new Map();
const EMPTY_HIGHLIGHT_IDS = new Set<string>();
const ALWAYS_MATCH = () => true;

function baseParams(overrides: Partial<UseCanvasFlowGraphParams> = {}): UseCanvasFlowGraphParams {
  return {
    projects: EMPTY_PROJECTS,
    drafts: EMPTY_DRAFTS,
    chains: EMPTY_CHAINS,
    notes: EMPTY_NOTES,
    scheduled: EMPTY_SCHEDULED,
    positions: EMPTY_POSITIONS,
    collapsed: EMPTY_COLLAPSED,
    prefs: DEFAULT_CANVAS_PREFS,
    activeProjectId: null,
    forceApproveIds: EMPTY_FORCE_APPROVE_IDS,
    missionLoopMeta: EMPTY_MISSION_LOOP_META,
    highlightIds: EMPTY_HIGHLIGHT_IDS,
    justMergedId: null,
    isFilterActive: false,
    nodeMatches: ALWAYS_MATCH,
    ...overrides,
  };
}

afterEach(() => {
  _resetCanvasStoreForTests();
});

describe('useCanvasFlowGraph — BUG 2 (W6f edges-vs-nodes commit race)', () => {
  it('commits a fresh node+edge pair with nodes FIRST and edges deferred to the next tick, never the same render', async () => {
    const draftA: DraftSpec = { id: 'draft-a', title: 'A', task: 'do a', createdBy: 'user' };
    const draftB: DraftSpec = { id: 'draft-b', title: 'B', task: 'do b', createdBy: 'user' };
    const chain: Chain = {
      id: 'chain-1',
      sourceRef: makeRef('draft', 'draft-a'),
      targetRef: makeRef('draft', 'draft-b'),
      condition: 'success',
      createdBy: 'user',
    };

    const { result, rerender } = renderHook(
      (props: Partial<UseCanvasFlowGraphParams>) => useCanvasFlowGraph(baseParams(props)),
      { initialProps: {} as Partial<UseCanvasFlowGraphParams> },
    );

    // The LazyBots zone node (project:lazybots) is always present — the
    // reconciler emits it whenever `bots` is defined (even empty), and
    // useCanvasFlowGraph always feeds botInputs (starts as []).
    const nonBotZoneNodes = result.current.nodes.filter((n) => n.id !== makeRef('project', 'lazybots'));
    expect(nonBotZoneNodes).toHaveLength(0);
    expect(result.current.edges).toHaveLength(0);

    // The manager creates both drafts AND the chain between them in one
    // reconcile pass — exactly the real-app scenario (W6e).
    rerender({ drafts: [draftA, draftB], chains: [chain] });

    // Nodes are already committed (a plain, immediate effect)...
    expect(result.current.nodes.length).toBeGreaterThanOrEqual(2);
    expect(result.current.nodes.some((n) => n.id === makeRef('draft', 'draft-a'))).toBe(true);
    expect(result.current.nodes.some((n) => n.id === makeRef('draft', 'draft-b'))).toBe(true);
    // ...but edges must NOT have landed yet — this is the structural fix:
    // deferred to the next frame/tick so React Flow has a full paint to
    // measure the two new nodes before the edge is ever handed to it.
    expect(result.current.edges).toHaveLength(0);

    // Past the deferred commit (scheduleFrame's jsdom fallback: a ~16ms
    // timer, since jsdom has no requestAnimationFrame).
    await waitFor(() => expect(result.current.edges).toHaveLength(1));
    expect(result.current.edges[0].id).toBe('chain-1');
  });

  it('reflects the LATEST reconcile on rapid churn instead of a stale pending commit', async () => {
    const draftA: DraftSpec = { id: 'draft-a', title: 'A', task: 'do a', createdBy: 'user' };
    const chainV1: Chain = { id: 'chain-1', sourceRef: makeRef('draft', 'draft-a'), targetRef: makeRef('draft', 'draft-a'), condition: 'success', createdBy: 'user' };

    const { result, rerender } = renderHook(
      (props: Partial<UseCanvasFlowGraphParams>) => useCanvasFlowGraph(baseParams(props)),
      { initialProps: {} as Partial<UseCanvasFlowGraphParams> },
    );

    rerender({ drafts: [draftA], chains: [chainV1] });
    expect(result.current.edges).toHaveLength(0); // still pending — not yet the next tick

    // A second, near-immediate reconcile (e.g. the schedule poll tick)
    // arrives BEFORE the first deferred commit fires — disabling the chain.
    const chainV2: Chain = { ...chainV1, disabled: true };
    rerender({ drafts: [draftA], chains: [chainV2] });

    // Exactly one edge, reflecting the LATEST reconcile — no leaked stale
    // commit from the superseded pending frame.
    await waitFor(() => expect(result.current.edges).toHaveLength(1));
    expect(result.current.edges[0].data?.disabled).toBe(true);
  });
});

// ── W8d Replay — decoration overlay (extends this file per the wave's own
//    brief: "decoration overlay unit via useCanvasFlowGraph test
//    extension") ──────────────────────────────────────────────────────

function fleetProjectFixture(): FleetProject {
  return {
    projectId: 'proj-1',
    root: '/repo',
    name: 'Repo',
    missions: [
      { id: 'm-1', title: 'Mission One', status: 'running', stage: 'code', model: 'sonnet', updatedMs: 0, urgent: false },
      { id: 'm-2', title: 'Mission Two', status: 'running', stage: 'code', model: 'sonnet', updatedMs: 0, urgent: false },
    ],
  };
}

describe('useCanvasFlowGraph — W8d Replay decoration overlay', () => {
  it('leaves nodes fully untouched when `replay` is absent (zero overhead outside Replay mode)', async () => {
    const { result } = renderHook(
      (props: Partial<UseCanvasFlowGraphParams>) => useCanvasFlowGraph(baseParams(props)),
      { initialProps: { projects: [fleetProjectFixture()] } as Partial<UseCanvasFlowGraphParams> },
    );
    await waitFor(() => expect(result.current.nodes.length).toBeGreaterThan(0));
    const missionNode = result.current.nodes.find((n) => n.id === makeRef('mission', 'm-1'));
    expect(missionNode?.className ?? '').not.toContain('canvas-replay-hidden');
  });

  it('hides a mission absent from the replay fleetState and overrides status/stage for one that IS present', async () => {
    const fleetState = new Map<string, FleetStateEntry>([
      ['m-1', { missionId: 'm-1', title: 'Mission One', status: 'done', stage: 'merged', paused: false, existsSince: 0 }],
    ]);

    const { result, rerender } = renderHook(
      (props: Partial<UseCanvasFlowGraphParams>) => useCanvasFlowGraph(baseParams(props)),
      { initialProps: { projects: [fleetProjectFixture()] } as Partial<UseCanvasFlowGraphParams> },
    );
    await waitFor(() => expect(result.current.nodes.length).toBeGreaterThan(0));

    rerender({ projects: [fleetProjectFixture()], replay: { active: true, fleetState, firingChainIds: new Set() } });

    const visible = result.current.nodes.find((n) => n.id === makeRef('mission', 'm-1'));
    const hidden = result.current.nodes.find((n) => n.id === makeRef('mission', 'm-2'));
    expect(hidden?.className ?? '').toContain('canvas-replay-hidden');
    expect(visible?.className ?? '').not.toContain('canvas-replay-hidden');
    const visibleData = visible?.data as { mission: { status: string; stage: string } };
    expect(visibleData.mission.status).toBe('done');
    expect(visibleData.mission.stage).toBe('merged');
  });

  it('exiting replay restores the undecorated nodes on the very next render', async () => {
    const fleetState = new Map<string, FleetStateEntry>([
      ['m-1', { missionId: 'm-1', title: 'Mission One', status: 'done', stage: 'merged', paused: false, existsSince: 0 }],
    ]);
    const { result, rerender } = renderHook(
      (props: Partial<UseCanvasFlowGraphParams>) => useCanvasFlowGraph(baseParams(props)),
      {
        initialProps: {
          projects: [fleetProjectFixture()],
          replay: { active: true, fleetState, firingChainIds: new Set() },
        } as Partial<UseCanvasFlowGraphParams>,
      },
    );
    await waitFor(() =>
      expect(result.current.nodes.find((n) => n.id === makeRef('mission', 'm-2'))?.className).toContain('canvas-replay-hidden'),
    );

    rerender({ projects: [fleetProjectFixture()], replay: { active: false, fleetState, firingChainIds: new Set() } });
    const restored = result.current.nodes.find((n) => n.id === makeRef('mission', 'm-2'));
    expect(restored?.className ?? '').not.toContain('canvas-replay-hidden');
  });

  it('decorates chain edges with a firing pulse for ids in `firingChainIds`, cleared once the tick moves on', async () => {
    const chain: Chain = {
      id: 'chain-1',
      sourceRef: makeRef('mission', 'm-1'),
      targetRef: makeRef('mission', 'm-2'),
      condition: 'success',
      createdBy: 'user',
    };
    const fleetState = new Map<string, FleetStateEntry>([
      ['m-1', { missionId: 'm-1', title: 'Mission One', status: 'running', stage: 'code', paused: false, existsSince: 0 }],
      ['m-2', { missionId: 'm-2', title: 'Mission Two', status: 'running', stage: 'code', paused: false, existsSince: 0 }],
    ]);

    const { result, rerender } = renderHook(
      (props: Partial<UseCanvasFlowGraphParams>) => useCanvasFlowGraph(baseParams(props)),
      {
        initialProps: {
          projects: [fleetProjectFixture()],
          chains: [chain],
          replay: { active: true, fleetState, firingChainIds: new Set(['chain-1']) },
        } as Partial<UseCanvasFlowGraphParams>,
      },
    );

    await waitFor(() => expect(result.current.edges).toHaveLength(1));
    expect(result.current.edges[0].data?.firing).toBe(true);

    rerender({ projects: [fleetProjectFixture()], chains: [chain], replay: { active: true, fleetState, firingChainIds: new Set() } });
    expect(result.current.edges[0].data?.firing).toBeUndefined();
  });
});

// ── fix/canvas-ux R10 — persisted-position declutter glue ─────────────────

describe('useCanvasFlowGraph — R10 (persisted-position declutter)', () => {
  it('onNodesChange marks a committed drag as session-dragged in canvasStore', async () => {
    const { result } = renderHook(
      (props: Partial<UseCanvasFlowGraphParams>) => useCanvasFlowGraph(baseParams(props)),
      { initialProps: { projects: [fleetProjectFixture()] } as Partial<UseCanvasFlowGraphParams> },
    );
    await waitFor(() => expect(result.current.nodes.length).toBeGreaterThan(0));

    const missionRef = makeRef('mission', 'm-1');
    expect(canvasStoreVanilla.getState().sessionDraggedRefs.has(missionRef)).toBe(false);

    act(() => {
      result.current.onNodesChange([
        { id: missionRef, type: 'position', position: { x: 250, y: 250 }, dragging: false },
      ]);
    });

    expect(canvasStoreVanilla.getState().positions[missionRef]).toEqual({ x: 250, y: 250 });
    expect(canvasStoreVanilla.getState().sessionDraggedRefs.has(missionRef)).toBe(true);
  });

  it('an in-flight drag (dragging: true) never marks the ref session-dragged — only the FINAL committed frame does', async () => {
    const { result } = renderHook(
      (props: Partial<UseCanvasFlowGraphParams>) => useCanvasFlowGraph(baseParams(props)),
      { initialProps: { projects: [fleetProjectFixture()] } as Partial<UseCanvasFlowGraphParams> },
    );
    await waitFor(() => expect(result.current.nodes.length).toBeGreaterThan(0));

    const missionRef = makeRef('mission', 'm-1');
    act(() => {
      result.current.onNodesChange([
        { id: missionRef, type: 'position', position: { x: 250, y: 250 }, dragging: true },
      ]);
    });

    expect(canvasStoreVanilla.getState().sessionDraggedRefs.has(missionRef)).toBe(false);
  });

  it('auto-persists a declutter correction back into canvasStore.positions, and it self-stabilizes (no render loop)', async () => {
    const oldRef = makeRef('mission', 'm-1');
    const newRef = makeRef('mission', 'm-2');
    const samePos = { x: 100, y: 100 };

    const project: FleetProject = {
      projectId: 'proj-1',
      root: '/repo',
      name: 'Repo',
      missions: [
        { id: 'm-1', title: 'Old', status: 'running', stage: 'code', model: 'sonnet', updatedMs: 1, urgent: false },
        { id: 'm-2', title: 'New', status: 'running', stage: 'code', model: 'sonnet', updatedMs: 999999, urgent: false },
      ],
    };

    const { result, rerender } = renderHook(
      (props: Partial<UseCanvasFlowGraphParams>) => useCanvasFlowGraph(baseParams(props)),
      { initialProps: { projects: [project], positions: { [oldRef]: samePos, [newRef]: samePos } } as Partial<UseCanvasFlowGraphParams> },
    );

    await waitFor(() => {
      const stored = canvasStoreVanilla.getState().positions[oldRef];
      expect(stored).toBeDefined();
      expect(stored).not.toEqual(samePos);
    });
    // The newer mission is untouched — reconcile() never had a reason to
    // persist it (canvasStoreVanilla.positions only ever receives what the
    // declutter patch actually contains; `newRef` was never part of it).
    const newerNode = result.current.nodes.find((n) => n.id === newRef);
    expect(newerNode?.position).toEqual(samePos);

    // Feeding the CORRECTED position back through as the live `positions`
    // input (exactly what CanvasView.tsx's next render does, since it reads
    // canvasStore.positions) must NOT trigger a second correction — the
    // declutter pass is a stable fixed point once resolved.
    const settled = { ...canvasStoreVanilla.getState().positions };
    rerender({ projects: [project], positions: settled });
    await waitFor(() => expect(result.current.nodes.length).toBeGreaterThan(0));
    expect(canvasStoreVanilla.getState().positions[oldRef]).toEqual(settled[oldRef]);
  });
});

// ── P0 crash fix (real-app repro: "Agents crashed / React error #185,
//    Maximum update depth exceeded") — the test above feeds `positions` as a
//    STATIC prop, which never exercises the actual failure mode: in the real
//    app, `positions` is read LIVE from canvasStore (CanvasView.tsx's own
//    `useCanvasStore((s) => s.positions)`), and this hook's declutter-persist
//    effect (lines ~183-187) writes corrections BACK into that same store —
//    a closed loop. e1b2e60 started restoring a leftover proposed plan's
//    pinned positions on hydrate; when two collide, the fix this file
//    guards against is `setPositions` (canvasStore.ts) allocating a NEW
//    `positions` object even for a value-identical patch, whose changed
//    IDENTITY alone re-triggers the memo that derives the patch — forever.
//    This test closes the SAME loop the real app has, instead of the
//    open-loop shape every other test in this file uses.
describe('useCanvasFlowGraph — R10 declutter-persist effect does not loop when positions are LIVE from the store (fix/canvas-crash)', () => {
  function LiveStorePositionsWrapper(props: Partial<UseCanvasFlowGraphParams>) {
    // Reads `positions` from canvasStore on every render — closing the
    // store -> prop -> effect -> store loop exactly like CanvasView.tsx
    // does, unlike `baseParams`' default (a module-level constant) or the
    // static-prop test above.
    const positions = useCanvasStore((s) => s.positions);
    return useCanvasFlowGraph(baseParams({ ...props, positions }));
  }

  it('a colliding pinned pair resolves and then stays resolved — no unbounded store churn', async () => {
    const oldRef = makeRef('mission', 'm-1');
    const newRef = makeRef('mission', 'm-2');
    const samePos = { x: 100, y: 100 };

    // Seed the collision directly in the store BEFORE mount — mirrors
    // e1b2e60's hydrate() restoring two colliding proposal positions, so the
    // very FIRST reconcile already finds a pinned x pinned overlap.
    canvasStoreVanilla.setState({ positions: { [oldRef]: samePos, [newRef]: samePos } });

    const project: FleetProject = {
      projectId: 'proj-1',
      root: '/repo',
      name: 'Repo',
      missions: [
        { id: 'm-1', title: 'Old', status: 'running', stage: 'code', model: 'sonnet', updatedMs: 1, urgent: false },
        { id: 'm-2', title: 'New', status: 'running', stage: 'code', model: 'sonnet', updatedMs: 999999, urgent: false },
      ],
    };

    let notifyCount = 0;
    const unsubscribe = canvasStoreVanilla.subscribe(() => {
      notifyCount += 1;
    });
    let unmount: (() => void) | undefined;

    try {
      const rendered = renderHook(
        (props: Partial<UseCanvasFlowGraphParams>) => LiveStorePositionsWrapper(props),
        { initialProps: { projects: [project] } as Partial<UseCanvasFlowGraphParams> },
      );
      const { result } = rendered;
      unmount = rendered.unmount;

      // Flush the deferred edges commit (scheduleFrame's jsdom ~16ms
      // fallback — BUG 2 fix, this file's own header) inside an explicit
      // act() window BEFORE the real assertions below: left unflushed here,
      // it can otherwise land in the gap between two `waitFor` polls and
      // trip RTL's "not wrapped in act(...)" warning — this test doesn't
      // care about edges at all, only that nothing outside act() mutates
      // state.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      // The declutter correction lands (the fix must never mask a REAL
      // change — this is the collision genuinely resolving).
      await waitFor(() => expect(canvasStoreVanilla.getState().positions[oldRef]).not.toEqual(samePos));
      const settledPositions = canvasStoreVanilla.getState().positions;
      const notifyCountAfterSettling = notifyCount;

      // Real timers (this file's own header) — give any still-looping
      // effect several more macrotask turns to fire before asserting it
      // never did. A pre-fix `setPositions` would keep notifying here,
      // eventually throwing "Maximum update depth exceeded" instead of
      // ever reaching this point cleanly.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      expect(canvasStoreVanilla.getState().positions).toBe(settledPositions); // same reference — no further writes
      expect(notifyCount).toBe(notifyCountAfterSettling); // no further notifications either
      expect(result.current.nodes.length).toBeGreaterThan(0);
    } finally {
      // Explicit unmount BEFORE this file's own `afterEach` resets
      // canvasStoreVanilla — this test's wrapper is the only one in this
      // file with a top-level `useCanvasStore((s) => s.positions)`
      // subscription (every other test's `positions` arrives as a plain
      // prop), so leaving it mounted across the reset would otherwise
      // trigger an "update not wrapped in act(...)" warning for a
      // subscription this test itself created.
      unmount?.();
      unsubscribe();
    }
  });

  // ── P0 crash, round 2 — the ACTUAL e1b2e60 mechanism, not just a
  //    pre-seeded store: several PROPOSED drafts/joins (proposedPlanId set,
  //    via addProposalPreview) get pinned to a colliding position (the
  //    'canvas:arrange' pass in the real app), then a LATER hydrate() call
  //    (project switch, or any later boot) restores them — canvasStore.ts's
  //    hydrate() `proposalPositions` merge, exercised for real here rather
  //    than assumed. Closes the same store -> prop -> effect -> store loop
  //    as the mission-pair test above, but for the data shape (drafts/joins,
  //    recencyMs always 0, tie-broken by array order — never mission
  //    recency) this round's crash report specifically names.
  it('several PROPOSED drafts+join restored via hydrate() resolve and stay resolved — no unbounded store churn', async () => {
    const planId = 'plan-1';
    const draftIds = ['d1', 'd2', 'd3'];
    const collidePos = { x: 100, y: 100 };

    canvasStoreVanilla.getState().addProposalPreview({
      drafts: draftIds.map((id) => ({ id, title: id, task: 'x', createdBy: 'manager', projectId: 'p1', proposedPlanId: planId }) as DraftSpec),
      chains: [],
      joins: [
        {
          id: 'j1',
          projectId: 'p1',
          name: 'join',
          sourceRefs: draftIds.map((id) => makeRef('draft', id)),
          mode: 'all_success',
          proposedPlanId: planId,
        },
      ],
    });
    // The 'canvas:arrange' pass (agentsStore.tsx) landing all of them on the
    // SAME colliding coordinate — worst case, proves the declutter path
    // regardless of what a real elk layout would actually produce.
    canvasStoreVanilla.getState().setPositions({
      [makeRef('draft', 'd1')]: collidePos,
      [makeRef('draft', 'd2')]: collidePos,
      [makeRef('draft', 'd3')]: collidePos,
      [makeRef('join', 'j1')]: collidePos,
    });
    // A LATER hydrate (project switch back) — "disk" knows nothing about
    // these proposed items; hydrate()'s own `proposalPositions` merge is
    // what carries their pinned positions forward.
    canvasStoreVanilla.getState().hydrate(
      { version: 1, positions: {}, collapsed: {}, prefs: DEFAULT_CANVAS_PREFS, notes: [] },
      { version: 1, chains: [], drafts: [] },
    );

    const project: FleetProject = { projectId: 'p1', root: '/repo/p1', name: 'p1', missions: [] };

    let notifyCount = 0;
    const unsubscribe = canvasStoreVanilla.subscribe(() => {
      notifyCount += 1;
    });
    let unmount: (() => void) | undefined;

    function LiveStoreDraftsJoinsWrapper(props: Partial<UseCanvasFlowGraphParams>) {
      const positions = useCanvasStore((s) => s.positions);
      const drafts = useCanvasStore((s) => s.drafts);
      const joins = useCanvasStore((s) => s.joins);
      return useCanvasFlowGraph(baseParams({ ...props, positions, drafts, joins }));
    }

    try {
      const rendered = renderHook(
        (props: Partial<UseCanvasFlowGraphParams>) => LiveStoreDraftsJoinsWrapper(props),
        { initialProps: { projects: [project] } as Partial<UseCanvasFlowGraphParams> },
      );
      const { result } = rendered;
      unmount = rendered.unmount;

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      await waitFor(() => {
        const stored = canvasStoreVanilla.getState().positions[makeRef('draft', 'd1')];
        expect(stored).toBeDefined();
      });
      const settledPositions = canvasStoreVanilla.getState().positions;
      const notifyCountAfterSettling = notifyCount;

      // Real timers — give any still-looping effect several more macrotask
      // turns to fire before asserting it never did (this is exactly the
      // window a genuine "Maximum update depth exceeded" would blow up in).
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });

      expect(canvasStoreVanilla.getState().positions).toBe(settledPositions);
      expect(notifyCount).toBe(notifyCountAfterSettling);
      expect(result.current.nodes.length).toBeGreaterThan(0);
    } finally {
      unmount?.();
      unsubscribe();
    }
  });
});
