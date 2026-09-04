/**
 * Tests for canvasStore.ts — zundo undo/redo scoping (user edits only,
 * viewport/hydrate excluded) and remapDraftToMission's atomicity.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { canvasStoreVanilla, isPositionsPatchNoop, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { DEFAULT_CANVAS_PREFS, makeRef, type CanvasLayoutFileV1, type ChainsFileV1 } from '../components/agents/canvas/canvasTypes';
import { captureMacro, instantiateMacro } from '../components/agents/canvas/canvasMacros';
import { reconcile } from '../components/agents/canvas/reconciler';
import type { FleetProject } from '../lib/agents/fleetMissions';

beforeEach(() => {
  _resetCanvasStoreForTests();
});

function pastLength(): number {
  return canvasStoreVanilla.temporal.getState().pastStates.length;
}

describe('canvasStore — undo/redo scoping', () => {
  it('tracks a position edit in history', () => {
    const before = pastLength();
    canvasStoreVanilla.getState().setPosition(makeRef('mission', 'm1'), { x: 10, y: 20 });
    expect(pastLength()).toBe(before + 1);
    expect(canvasStoreVanilla.getState().positions[makeRef('mission', 'm1')]).toEqual({ x: 10, y: 20 });
  });

  it('does not track a viewport-only change in history', () => {
    canvasStoreVanilla.getState().setPosition(makeRef('mission', 'm1'), { x: 10, y: 20 });
    const afterPosition = pastLength();

    canvasStoreVanilla.getState().setViewport({ x: 5, y: 5, zoom: 1.5 });
    canvasStoreVanilla.getState().setViewport({ x: 9, y: 9, zoom: 2 });

    expect(pastLength()).toBe(afterPosition);
    expect(canvasStoreVanilla.getState().viewport).toEqual({ x: 9, y: 9, zoom: 2 });
  });

  it('undo reverts a position edit but leaves viewport untouched', () => {
    canvasStoreVanilla.getState().setPosition(makeRef('mission', 'm1'), { x: 10, y: 20 });
    canvasStoreVanilla.getState().setViewport({ x: 99, y: 99, zoom: 2 });

    canvasStoreVanilla.temporal.getState().undo();

    expect(canvasStoreVanilla.getState().positions[makeRef('mission', 'm1')]).toBeUndefined();
    expect(canvasStoreVanilla.getState().viewport).toEqual({ x: 99, y: 99, zoom: 2 });
  });

  it('does not track a prefs-only change in history (sticky UI toggle, not undoable content)', () => {
    const before = pastLength();
    canvasStoreVanilla.getState().setPrefs({ hideMerged: true });
    expect(pastLength()).toBe(before);
    expect(canvasStoreVanilla.getState().prefs.hideMerged).toBe(true);
  });

  it('hydrate never creates a history entry, even though it changes the tracked slice', () => {
    canvasStoreVanilla.getState().setPosition(makeRef('mission', 'm1'), { x: 1, y: 1 });
    const beforeHydrate = pastLength();

    const layout: CanvasLayoutFileV1 = {
      version: 1,
      positions: { [makeRef('mission', 'm2')]: { x: 5, y: 5 } },
      collapsed: { proj1: true },
      prefs: DEFAULT_CANVAS_PREFS,
      notes: [{ id: 'n1', text: 'hello' }],
    };
    const chainsFile: ChainsFileV1 = { version: 1, chains: [], drafts: [] };

    canvasStoreVanilla.getState().hydrate(layout, chainsFile);

    expect(pastLength()).toBe(beforeHydrate);
    expect(canvasStoreVanilla.getState().positions).toEqual(layout.positions);
    expect(canvasStoreVanilla.getState().collapsed).toEqual({ proj1: true });
    expect(canvasStoreVanilla.getState().notes).toEqual(layout.notes);
  });

  it('hydrate(null, null) resets tracked facts to defaults without an undo step', () => {
    canvasStoreVanilla.getState().setPosition(makeRef('mission', 'm1'), { x: 1, y: 1 });
    const beforeHydrate = pastLength();

    canvasStoreVanilla.getState().hydrate(null, null);

    expect(pastLength()).toBe(beforeHydrate);
    expect(canvasStoreVanilla.getState().positions).toEqual({});
    expect(canvasStoreVanilla.getState().drafts).toEqual([]);
  });

  it('resume() after hydrate leaves tracking on for subsequent user edits', () => {
    canvasStoreVanilla.getState().hydrate(null, null);
    const before = pastLength();
    canvasStoreVanilla.getState().setPosition(makeRef('mission', 'm3'), { x: 3, y: 3 });
    expect(pastLength()).toBe(before + 1);
  });
});

describe('canvasStore — remapDraftToMission atomicity', () => {
  function seedDraftWithPositionAndChain() {
    const draftRef = makeRef('draft', 'd1');
    const store = canvasStoreVanilla.getState();
    store.addDraft({ id: 'd1', title: 'Draft title', task: 'do the thing', createdBy: 'user' });
    store.setPosition(draftRef, { x: 50, y: 60 });
    store.addChain({
      id: 'c1',
      sourceRef: makeRef('mission', 'm0'),
      targetRef: draftRef,
      condition: 'success',
      createdBy: 'user',
    });
    return draftRef;
  }

  it('rewrites the position key, rewrites chain refs, and removes the draft — in one history step', () => {
    const draftRef = seedDraftWithPositionAndChain();
    const beforeCount = pastLength();

    canvasStoreVanilla.getState().remapDraftToMission('d1', 'm1');

    expect(pastLength()).toBe(beforeCount + 1);

    const state = canvasStoreVanilla.getState();
    expect(state.drafts).toHaveLength(0);
    expect(state.positions[draftRef]).toBeUndefined();
    expect(state.positions[makeRef('mission', 'm1')]).toEqual({ x: 50, y: 60 });
    expect(state.chains[0].targetRef).toBe(makeRef('mission', 'm1'));
    expect(state.chains[0].sourceRef).toBe(makeRef('mission', 'm0')); // untouched — was never the draft ref
  });

  it('undo reverts the whole remap atomically (position, chain, and draft all come back together)', () => {
    const draftRef = seedDraftWithPositionAndChain();
    canvasStoreVanilla.getState().remapDraftToMission('d1', 'm1');

    canvasStoreVanilla.temporal.getState().undo();

    const state = canvasStoreVanilla.getState();
    expect(state.drafts).toHaveLength(1);
    expect(state.drafts[0].id).toBe('d1');
    expect(state.positions[draftRef]).toEqual({ x: 50, y: 60 });
    expect(state.positions[makeRef('mission', 'm1')]).toBeUndefined();
    expect(state.chains[0].targetRef).toBe(draftRef);
  });

  it('is a no-op for an unknown draftId (never half-applies)', () => {
    seedDraftWithPositionAndChain();
    const before = canvasStoreVanilla.getState();
    const beforeCount = pastLength();

    canvasStoreVanilla.getState().remapDraftToMission('does-not-exist', 'm9');

    expect(canvasStoreVanilla.getState().drafts).toEqual(before.drafts);
    expect(canvasStoreVanilla.getState().chains).toEqual(before.chains);
    expect(canvasStoreVanilla.getState().positions).toEqual(before.positions);
    expect(pastLength()).toBe(beforeCount);
  });

  it('preserves a draft with no stored position (nothing to carry over)', () => {
    canvasStoreVanilla.getState().addDraft({ id: 'd2', title: 'T', task: 'x', createdBy: 'manager' });

    canvasStoreVanilla.getState().remapDraftToMission('d2', 'm2');

    const state = canvasStoreVanilla.getState();
    expect(state.drafts).toHaveLength(0);
    expect(state.positions[makeRef('mission', 'm2')]).toBeUndefined();
    expect(state.positions[makeRef('draft', 'd2')]).toBeUndefined();
  });
});

describe('canvasStore — immutability', () => {
  it('setPositions merges without mutating the previous positions object', () => {
    const store = canvasStoreVanilla.getState();
    store.setPosition(makeRef('mission', 'a'), { x: 1, y: 1 });
    const prevPositions = canvasStoreVanilla.getState().positions;

    store.setPositions({ [makeRef('mission', 'b')]: { x: 2, y: 2 } });

    expect(canvasStoreVanilla.getState().positions).not.toBe(prevPositions);
    expect(prevPositions[makeRef('mission', 'b')]).toBeUndefined(); // old object untouched
    expect(canvasStoreVanilla.getState().positions).toEqual({
      [makeRef('mission', 'a')]: { x: 1, y: 1 },
      [makeRef('mission', 'b')]: { x: 2, y: 2 },
    });
  });
});

// ── fix(canvas): setPositions value-equality no-op (P0 crash fix) ────────
//
// Real-app repro: e1b2e60 started restoring a leftover proposed plan's
// pinned positions on hydrate; when two restored positions collide, the R10
// declutter pass (useCanvasFlowGraph.ts) recomputes the SAME correction on
// every reconcile — a non-empty, but VALUE-IDENTICAL patch every time. The
// old `setPositions` always spread-merged into a brand-new `positions`
// object even when nothing changed, and that changed IDENTITY alone
// re-triggered the memo that derives the patch — "Maximum update depth
// exceeded" (React error #185), reproduced live at boot. These tests pin
// down the fix at the store level: a value-identical patch must not
// allocate a new `positions` object or notify subscribers, while a
// genuinely different patch must still apply exactly as before.
describe('canvasStore — setPositions value-equality no-op (fix/canvas-crash)', () => {
  it('does not change the positions object identity when the patch is value-identical to what is already stored', () => {
    const ref = makeRef('mission', 'm1');
    canvasStoreVanilla.getState().setPosition(ref, { x: 10, y: 20 });
    const positionsBefore = canvasStoreVanilla.getState().positions;

    canvasStoreVanilla.getState().setPositions({ [ref]: { x: 10, y: 20 } });

    expect(canvasStoreVanilla.getState().positions).toBe(positionsBefore); // same object reference — no new allocation
  });

  it('does not notify subscribers for a value-identical patch (the actual render-loop guard)', () => {
    const ref = makeRef('mission', 'm1');
    canvasStoreVanilla.getState().setPosition(ref, { x: 10, y: 20 });

    let notified = 0;
    const unsubscribe = canvasStoreVanilla.subscribe(() => {
      notified += 1;
    });
    try {
      canvasStoreVanilla.getState().setPositions({ [ref]: { x: 10, y: 20 } });
      expect(notified).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it('does not push an undo/redo history entry for a value-identical patch', () => {
    const ref = makeRef('mission', 'm1');
    canvasStoreVanilla.getState().setPosition(ref, { x: 10, y: 20 });
    const before = pastLength();

    canvasStoreVanilla.getState().setPositions({ [ref]: { x: 10, y: 20 } });

    expect(pastLength()).toBe(before);
  });

  it('still applies a genuinely different value in the SAME patch — the no-op guard never masks a real change', () => {
    const refA = makeRef('mission', 'a');
    const refB = makeRef('mission', 'b');
    canvasStoreVanilla.getState().setPosition(refA, { x: 10, y: 20 });
    canvasStoreVanilla.getState().setPosition(refB, { x: 1, y: 1 });
    const positionsBefore = canvasStoreVanilla.getState().positions;

    // refA unchanged, refB genuinely moved — a mixed patch must still apply.
    canvasStoreVanilla.getState().setPositions({ [refA]: { x: 10, y: 20 }, [refB]: { x: 99, y: 99 } });

    expect(canvasStoreVanilla.getState().positions).not.toBe(positionsBefore);
    expect(canvasStoreVanilla.getState().positions[refA]).toEqual({ x: 10, y: 20 });
    expect(canvasStoreVanilla.getState().positions[refB]).toEqual({ x: 99, y: 99 });
  });

  it('still applies a patch introducing a brand-new ref (not previously stored)', () => {
    const ref = makeRef('mission', 'new');
    const positionsBefore = canvasStoreVanilla.getState().positions;

    canvasStoreVanilla.getState().setPositions({ [ref]: { x: 5, y: 5 } });

    expect(canvasStoreVanilla.getState().positions).not.toBe(positionsBefore);
    expect(canvasStoreVanilla.getState().positions[ref]).toEqual({ x: 5, y: 5 });
  });

  it('treats an empty patch as a no-op (the pre-existing guard, still true after this fix)', () => {
    canvasStoreVanilla.getState().setPosition(makeRef('mission', 'm1'), { x: 10, y: 20 });
    const positionsBefore = canvasStoreVanilla.getState().positions;

    canvasStoreVanilla.getState().setPositions({});

    expect(canvasStoreVanilla.getState().positions).toBe(positionsBefore);
  });
});

describe('canvasStore — isPositionsPatchNoop (pure helper)', () => {
  it('is true for an empty patch regardless of current state', () => {
    expect(isPositionsPatchNoop({ [makeRef('mission', 'a')]: { x: 1, y: 1 } }, {})).toBe(true);
  });

  it('is true when every patch entry exactly matches the current value', () => {
    const ref = makeRef('mission', 'a');
    expect(isPositionsPatchNoop({ [ref]: { x: 1, y: 1 } }, { [ref]: { x: 1, y: 1 } })).toBe(true);
  });

  it('is false when a patch entry differs on x or y', () => {
    const ref = makeRef('mission', 'a');
    expect(isPositionsPatchNoop({ [ref]: { x: 1, y: 1 } }, { [ref]: { x: 2, y: 1 } })).toBe(false);
    expect(isPositionsPatchNoop({ [ref]: { x: 1, y: 1 } }, { [ref]: { x: 1, y: 2 } })).toBe(false);
  });

  it('is false when a patch ref is not present in the current state (a genuinely new node)', () => {
    const ref = makeRef('mission', 'new');
    expect(isPositionsPatchNoop({}, { [ref]: { x: 0, y: 0 } })).toBe(false);
  });

  it('is false when only SOME entries match (a mixed patch is never treated as a no-op)', () => {
    const refA = makeRef('mission', 'a');
    const refB = makeRef('mission', 'b');
    expect(
      isPositionsPatchNoop(
        { [refA]: { x: 1, y: 1 } },
        { [refA]: { x: 1, y: 1 }, [refB]: { x: 2, y: 2 } },
      ),
    ).toBe(false);
  });

  // ── P0 crash, round 2 — NaN-safe coordinate equality ──────────────────
  //
  // Plain `!==` treats `NaN !== NaN` as `true`. A coordinate that is (or
  // ever becomes) NaN would therefore make this function return `false`
  // FOREVER for that ref, even across two calls with the exact same NaN
  // value — defeating both this function's own no-op detection and,
  // transitively, `setPositions`'s Object.is bail-out (round 1's fix): a
  // "value-identical" NaN patch would keep allocating a new `positions`
  // object and notifying subscribers, reopening the exact render loop
  // round 1 closed for every OTHER coordinate value.
  it('is true when a NaN coordinate repeats verbatim (NaN-safe equality, round 2 fix)', () => {
    const ref = makeRef('draft', 'd1');
    expect(isPositionsPatchNoop({ [ref]: { x: NaN, y: 5 } }, { [ref]: { x: NaN, y: 5 } })).toBe(true);
    expect(isPositionsPatchNoop({ [ref]: { x: 5, y: NaN } }, { [ref]: { x: 5, y: NaN } })).toBe(true);
  });

  it('is still false when a NaN coordinate patch would genuinely change a real number', () => {
    const ref = makeRef('draft', 'd1');
    expect(isPositionsPatchNoop({ [ref]: { x: 5, y: 5 } }, { [ref]: { x: NaN, y: 5 } })).toBe(false);
    expect(isPositionsPatchNoop({ [ref]: { x: NaN, y: 5 } }, { [ref]: { x: 5, y: 5 } })).toBe(false);
  });

  it('treats -0 and 0 as equal (a declutter/migration pass alternating sign-of-zero must still read as unchanged)', () => {
    const ref = makeRef('draft', 'd1');
    expect(isPositionsPatchNoop({ [ref]: { x: -0, y: 0 } }, { [ref]: { x: 0, y: -0 } })).toBe(true);
  });
});

describe('canvasStore — markChainFired (W3, chainEngine.ts)', () => {
  function seedChain(): void {
    canvasStoreVanilla.getState().addChain({
      id: 'c1',
      sourceRef: makeRef('mission', 'm1'),
      targetRef: makeRef('draft', 'd1'),
      condition: 'success',
      createdBy: 'user',
    });
  }

  it('sets lastFiredAtMs on the matching chain, immutably', () => {
    seedChain();
    const before = canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!;

    canvasStoreVanilla.getState().markChainFired('c1', 12345);

    const after = canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!;
    expect(after.lastFiredAtMs).toBe(12345);
    expect(after).not.toBe(before); // new object, never mutated in place
    expect(before.lastFiredAtMs).toBeUndefined(); // original object left untouched
  });

  it('is a no-op for an unknown chainId', () => {
    seedChain();
    const chainsBefore = canvasStoreVanilla.getState().chains;

    canvasStoreVanilla.getState().markChainFired('does-not-exist', 999);

    expect(canvasStoreVanilla.getState().chains.map((c) => ({ ...c }))).toEqual(chainsBefore.map((c) => ({ ...c })));
  });

  it('leaves every OTHER chain untouched', () => {
    seedChain();
    canvasStoreVanilla.getState().addChain({
      id: 'c2',
      sourceRef: makeRef('mission', 'm2'),
      targetRef: makeRef('draft', 'd2'),
      condition: 'always',
      createdBy: 'user',
    });

    canvasStoreVanilla.getState().markChainFired('c1', 500);

    const c2 = canvasStoreVanilla.getState().chains.find((c) => c.id === 'c2')!;
    expect(c2.lastFiredAtMs).toBeUndefined();
  });

  it('is EXCLUDED from undo/redo history, exactly like hydrate()', () => {
    seedChain();
    const beforeMark = pastLength();

    canvasStoreVanilla.getState().markChainFired('c1', 777);

    expect(pastLength()).toBe(beforeMark); // no new history entry pushed
    expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.lastFiredAtMs).toBe(777);
  });

  it('does not itself add an undo step, but a LATER undo still reverts past it (zundo snapshots the whole tracked slice, not per-field — same characteristic hydrate() has)', () => {
    seedChain();
    canvasStoreVanilla.getState().setPosition(makeRef('mission', 'm1'), { x: 10, y: 10 });
    const afterPositionEdit = pastLength();

    canvasStoreVanilla.getState().markChainFired('c1', 999); // must not itself push a history entry
    expect(pastLength()).toBe(afterPositionEdit);
    expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.lastFiredAtMs).toBe(999);

    // Undoing the position edit restores zundo's pastState snapshot of the
    // WHOLE tracked slice as it was captured BEFORE that edit — which
    // chronologically predates markChainFired too, so chains reverts along
    // with positions. This is expected/documented (not a bug this test
    // guards against): markChainFired only guarantees it never becomes ITS
    // OWN undo step, not that it survives an undo targeting an earlier one.
    canvasStoreVanilla.temporal.getState().undo();
    expect(canvasStoreVanilla.getState().positions[makeRef('mission', 'm1')]).toBeUndefined();
    expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.lastFiredAtMs).toBeUndefined();
  });
});

// ── fix/canvas-ux R7 — living surfaces (terminal/preview nodes) + the
//    mission live-panel expand state. Same conventions this file already
//    established for drafts/notes/routers/markChainFired above. ──────────

describe('canvasStore — living surfaces (R7)', () => {
  it('addSurface/updateSurface/removeSurface behave like the existing draft/note actions', () => {
    const before = pastLength();
    canvasStoreVanilla.getState().addSurface({ id: 's1', kind: 'terminal', cwd: '/repo' });
    expect(pastLength()).toBe(before + 1);
    expect(canvasStoreVanilla.getState().surfaces).toEqual([{ id: 's1', kind: 'terminal', cwd: '/repo' }]);

    canvasStoreVanilla.getState().updateSurface('s1', { width: 600, height: 400 });
    expect(canvasStoreVanilla.getState().surfaces[0]).toEqual({ id: 's1', kind: 'terminal', cwd: '/repo', width: 600, height: 400 });

    canvasStoreVanilla.getState().removeSurface('s1');
    expect(canvasStoreVanilla.getState().surfaces).toEqual([]);
  });

  it('updateSurface is a no-op for an unknown id (never half-applies)', () => {
    canvasStoreVanilla.getState().addSurface({ id: 's1', kind: 'preview' });
    const before = canvasStoreVanilla.getState().surfaces;

    canvasStoreVanilla.getState().updateSurface('does-not-exist', { url: 'http://localhost:3000' });

    expect(canvasStoreVanilla.getState().surfaces).toEqual(before);
  });

  it('setExpandedPanel expands (stores dims) then collapses (removes the entry) immutably', () => {
    const missionRef = makeRef('mission', 'm1');
    canvasStoreVanilla.getState().setExpandedPanel(missionRef, { width: 520, height: 420 });
    expect(canvasStoreVanilla.getState().expandedPanels[missionRef]).toEqual({ width: 520, height: 420 });

    canvasStoreVanilla.getState().setExpandedPanel(missionRef, { width: 600, height: 500 });
    expect(canvasStoreVanilla.getState().expandedPanels[missionRef]).toEqual({ width: 600, height: 500 });

    canvasStoreVanilla.getState().setExpandedPanel(missionRef, null);
    expect(canvasStoreVanilla.getState().expandedPanels[missionRef]).toBeUndefined();
    expect(canvasStoreVanilla.getState().expandedPanels).toEqual({});
  });

  it('is tracked in undo/redo history, same as drafts/notes/collapsed', () => {
    const missionRef = makeRef('mission', 'm1');
    const before = pastLength();
    canvasStoreVanilla.getState().setExpandedPanel(missionRef, { width: 520, height: 420 });
    expect(pastLength()).toBe(before + 1);

    canvasStoreVanilla.temporal.getState().undo();
    expect(canvasStoreVanilla.getState().expandedPanels[missionRef]).toBeUndefined();
  });

  it('reportWebSearch("searching") creates a new preview-kind surface with a live pendingQuery and no history', () => {
    canvasStoreVanilla.getState().reportWebSearch({
      missionId: 'm1',
      agentName: 'Coder',
      projectId: 'p1',
      query: 'react flow node types',
      status: 'searching',
      results: [],
    });

    const surface = canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'search:m1');
    expect(surface).toBeDefined();
    expect(surface?.kind).toBe('preview');
    expect(surface?.ownerRef).toBe(makeRef('mission', 'm1'));
    expect(surface?.searchSurface).toEqual({ agentName: 'Coder', pendingQuery: 'react flow node types', history: [] });
  });

  it('reportWebSearch("done") clears pendingQuery and pushes a history entry, newest first', () => {
    canvasStoreVanilla.getState().reportWebSearch({
      missionId: 'm1',
      agentName: 'Coder',
      projectId: 'p1',
      query: 'first query',
      status: 'searching',
      results: [],
    });
    canvasStoreVanilla.getState().reportWebSearch({
      missionId: 'm1',
      projectId: 'p1',
      query: 'first query',
      status: 'done',
      results: [{ title: 'Result A', url: 'https://a.example', snippet: 'snippet A' }],
    });

    const surface = canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'search:m1');
    expect(surface?.searchSurface?.pendingQuery).toBeUndefined();
    expect(surface?.searchSurface?.history).toHaveLength(1);
    expect(surface?.searchSurface?.history[0].query).toBe('first query');
    expect(surface?.searchSurface?.history[0].results).toEqual([
      { title: 'Result A', url: 'https://a.example', snippet: 'snippet A' },
    ]);
    // agentName from the earlier 'searching' call is preserved even though
    // this 'done' event omits it.
    expect(surface?.searchSurface?.agentName).toBe('Coder');

    canvasStoreVanilla.getState().reportWebSearch({
      missionId: 'm1',
      projectId: 'p1',
      query: 'second query',
      status: 'done',
      results: [],
    });
    const updated = canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'search:m1');
    expect(updated?.searchSurface?.history.map((h) => h.query)).toEqual(['second query', 'first query']);
  });

  it('reportWebSearch("error") clears pendingQuery without adding a history entry', () => {
    canvasStoreVanilla.getState().reportWebSearch({
      missionId: 'm1',
      projectId: 'p1',
      query: 'a failing query',
      status: 'searching',
      results: [],
    });
    canvasStoreVanilla.getState().reportWebSearch({
      missionId: 'm1',
      projectId: 'p1',
      query: 'a failing query',
      status: 'error',
      results: [],
    });

    const surface = canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'search:m1');
    expect(surface?.searchSurface?.pendingQuery).toBeUndefined();
    expect(surface?.searchSurface?.history).toEqual([]);
  });

  it('reportWebSearch caps history at SEARCH_HISTORY_CAP (5), dropping the oldest', () => {
    for (let i = 0; i < 6; i++) {
      canvasStoreVanilla.getState().reportWebSearch({
        missionId: 'm1',
        projectId: 'p1',
        query: `query ${i}`,
        status: 'done',
        results: [],
      });
    }
    const surface = canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'search:m1');
    expect(surface?.searchSurface?.history).toHaveLength(5);
    expect(surface?.searchSurface?.history.map((h) => h.query)).toEqual([
      'query 5', 'query 4', 'query 3', 'query 2', 'query 1',
    ]);
  });

  it('reportWebSearch upserts the SAME surface for repeated searches by one mission, never spawning a second', () => {
    canvasStoreVanilla.getState().reportWebSearch({
      missionId: 'm1', projectId: 'p1', query: 'q1', status: 'done', results: [],
    });
    canvasStoreVanilla.getState().reportWebSearch({
      missionId: 'm1', projectId: 'p1', query: 'q2', status: 'done', results: [],
    });

    const matches = canvasStoreVanilla.getState().surfaces.filter((s) => s.id === 'search:m1');
    expect(matches).toHaveLength(1);
  });

  it('hydrate() round-trips surfaces/expandedPanels from layout.json, defaulting to empty when absent (legacy file)', () => {
    const layout: CanvasLayoutFileV1 = {
      version: 1,
      positions: {},
      collapsed: {},
      prefs: DEFAULT_CANVAS_PREFS,
      notes: [],
      surfaces: [{ id: 's1', kind: 'terminal', cwd: '/repo' }],
      expandedPanels: { [makeRef('mission', 'm1')]: { width: 520, height: 420 } },
    };
    canvasStoreVanilla.getState().hydrate(layout, { version: 1, chains: [], drafts: [] });

    expect(canvasStoreVanilla.getState().surfaces).toEqual(layout.surfaces);
    expect(canvasStoreVanilla.getState().expandedPanels).toEqual(layout.expandedPanels);

    // Legacy layout.json (written before this field existed) — absent, not corrupt.
    const legacyLayout: CanvasLayoutFileV1 = { version: 1, positions: {}, collapsed: {}, prefs: DEFAULT_CANVAS_PREFS, notes: [] };
    canvasStoreVanilla.getState().hydrate(legacyLayout, { version: 1, chains: [], drafts: [] });
    expect(canvasStoreVanilla.getState().surfaces).toEqual([]);
    expect(canvasStoreVanilla.getState().expandedPanels).toEqual({});
  });

  // ── upsertArtifactSurface (visible-artifact fix, propose_artifact action) ──
  it('upsertArtifactSurface creates a preview-kind surface carrying the given htmlViews and returns its real NodeRef', () => {
    const views = [{ id: 'v1', label: 'Page 1', html: '<p>hello</p>' }];
    const ref = canvasStoreVanilla.getState().upsertArtifactSurface('artifact-hero', views, { projectId: 'p1' });

    expect(ref).toBe(makeRef('preview', 'artifact-hero'));
    const surface = canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'artifact-hero');
    expect(surface).toEqual({ id: 'artifact-hero', kind: 'preview', projectId: 'p1', htmlViews: views });
  });

  it('upsertArtifactSurface called again for the SAME id updates the surface in place, never spawning a second node', () => {
    canvasStoreVanilla.getState().upsertArtifactSurface('artifact-hero', [{ id: 'v1', label: 'Option A', html: '<p>A</p>' }]);
    canvasStoreVanilla.getState().upsertArtifactSurface('artifact-hero', [{ id: 'v1', label: 'Resolved', html: '<p>resolved</p>' }]);

    const matches = canvasStoreVanilla.getState().surfaces.filter((s) => s.id === 'artifact-hero');
    expect(matches).toHaveLength(1);
    expect(matches[0].htmlViews).toEqual([{ id: 'v1', label: 'Resolved', html: '<p>resolved</p>' }]);
  });

  it('upsertArtifactSurface is tracked in undo/redo history, same as other surface writes', () => {
    const before = pastLength();
    canvasStoreVanilla.getState().upsertArtifactSurface('artifact-hero', [{ id: 'v1', label: 'Page 1', html: '<p>x</p>' }]);
    expect(pastLength()).toBe(before + 1);
  });

  // ── upsertBrowserProofSurface (Mission B — proof window) ──────────────
  it('upsertBrowserProofSurface creates a preview-kind surface with the given view + ownerRefs and returns its real NodeRef', () => {
    const ref = canvasStoreVanilla.getState().upsertBrowserProofSurface(
      'browserProof-acme',
      { id: 'run-1', label: 'Run 1', html: '<p>run 1</p>' },
      { ownerRefs: [makeRef('mission', 'm1')], projectId: 'p1' },
    );

    expect(ref).toBe(makeRef('preview', 'browserProof-acme'));
    const surface = canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'browserProof-acme');
    expect(surface?.kind).toBe('preview');
    expect(surface?.htmlViews).toEqual([{ id: 'run-1', label: 'Run 1', html: '<p>run 1</p>' }]);
    expect(surface?.activeViewId).toBe('run-1');
    expect(surface?.ownerRefs).toEqual([makeRef('mission', 'm1')]);
  });

  it('a second call for the SAME surface id APPENDS a new view (never replaces history) and jumps activeViewId to it', () => {
    canvasStoreVanilla.getState().upsertBrowserProofSurface(
      'browserProof-acme',
      { id: 'run-1', label: 'Run 1', html: '<p>run 1</p>' },
      { ownerRefs: [makeRef('mission', 'm1')] },
    );
    canvasStoreVanilla.getState().upsertBrowserProofSurface(
      'browserProof-acme',
      { id: 'run-2', label: 'Run 2', html: '<p>run 2</p>' },
      { ownerRefs: [makeRef('mission', 'm1')] },
    );

    const matches = canvasStoreVanilla.getState().surfaces.filter((s) => s.id === 'browserProof-acme');
    expect(matches).toHaveLength(1);
    expect(matches[0].htmlViews?.map((v) => v.id)).toEqual(['run-1', 'run-2']);
    expect(matches[0].activeViewId).toBe('run-2');
  });

  it('unions ownerRefs across calls (a second contributing mission joins the roster, never evicting the first)', () => {
    canvasStoreVanilla.getState().upsertBrowserProofSurface(
      'browserProof-acme',
      { id: 'run-1', label: 'Run 1', html: '<p>run 1</p>' },
      { ownerRefs: [makeRef('mission', 'm1')] },
    );
    canvasStoreVanilla.getState().upsertBrowserProofSurface(
      'browserProof-acme',
      { id: 'run-2', label: 'Run 2', html: '<p>run 2</p>' },
      { ownerRefs: [makeRef('mission', 'm2')] },
    );

    const surface = canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'browserProof-acme');
    expect(surface?.ownerRefs).toEqual([makeRef('mission', 'm1'), makeRef('mission', 'm2')]);
  });

  it('caps accumulated views at BROWSER_PROOF_RUN_CAP (5), dropping the oldest run', () => {
    for (let i = 0; i < 7; i++) {
      canvasStoreVanilla.getState().upsertBrowserProofSurface(
        'browserProof-acme',
        { id: `run-${i}`, label: `Run ${i}`, html: `<p>${i}</p>` },
        { ownerRefs: [makeRef('mission', 'm1')] },
      );
    }
    const surface = canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'browserProof-acme');
    expect(surface?.htmlViews?.map((v) => v.id)).toEqual(['run-2', 'run-3', 'run-4', 'run-5', 'run-6']);
  });

  it('is tracked in undo/redo history, same as upsertArtifactSurface', () => {
    const before = pastLength();
    canvasStoreVanilla.getState().upsertBrowserProofSurface(
      'browserProof-acme',
      { id: 'run-1', label: 'Run 1', html: '<p>x</p>' },
      { ownerRefs: [makeRef('mission', 'm1')] },
    );
    expect(pastLength()).toBe(before + 1);
  });
});

describe('canvasStore — frames / Canvas Groups (W-CLOSE row 2)', () => {
  it('addFrame/updateFrame/removeFrame behave like the existing surface actions', () => {
    const before = pastLength();
    canvasStoreVanilla.getState().addFrame({ id: 'f1', title: 'Group A', width: 300, height: 200 });
    expect(pastLength()).toBe(before + 1);
    expect(canvasStoreVanilla.getState().frames).toEqual([{ id: 'f1', title: 'Group A', width: 300, height: 200 }]);

    canvasStoreVanilla.getState().updateFrame('f1', { title: 'Renamed', width: 400 });
    expect(canvasStoreVanilla.getState().frames[0]).toEqual({ id: 'f1', title: 'Renamed', width: 400, height: 200 });

    canvasStoreVanilla.getState().removeFrame('f1');
    expect(canvasStoreVanilla.getState().frames).toEqual([]);
  });

  it('updateFrame is a no-op for an unknown id (never half-applies)', () => {
    canvasStoreVanilla.getState().addFrame({ id: 'f1', title: 'Group', width: 300, height: 200 });
    const before = canvasStoreVanilla.getState().frames;

    canvasStoreVanilla.getState().updateFrame('does-not-exist', { title: 'Ghost' });

    expect(canvasStoreVanilla.getState().frames).toEqual(before);
  });

  it('hydrate() round-trips frames from layout.json, defaulting to empty when absent (legacy file)', () => {
    const layout: CanvasLayoutFileV1 = {
      version: 1,
      positions: {},
      collapsed: {},
      prefs: DEFAULT_CANVAS_PREFS,
      notes: [],
      frames: [{ id: 'f1', projectId: 'p1', title: 'Group A', width: 300, height: 200 }],
    };
    canvasStoreVanilla.getState().hydrate(layout, { version: 1, chains: [], drafts: [] });
    expect(canvasStoreVanilla.getState().frames).toEqual(layout.frames);

    // Legacy layout.json (written before this field existed) — absent, not corrupt.
    const legacyLayout: CanvasLayoutFileV1 = { version: 1, positions: {}, collapsed: {}, prefs: DEFAULT_CANVAS_PREFS, notes: [] };
    canvasStoreVanilla.getState().hydrate(legacyLayout, { version: 1, chains: [], drafts: [] });
    expect(canvasStoreVanilla.getState().frames).toEqual([]);
  });
});

// ── R10: sessionDraggedRefs (persisted-position declutter) ────────────────

describe('canvasStore — sessionDraggedRefs (R10)', () => {
  it('starts empty', () => {
    expect(canvasStoreVanilla.getState().sessionDraggedRefs.size).toBe(0);
  });

  it('markSessionDragged adds a ref immutably (additive — never removes one)', () => {
    const ref = makeRef('mission', 'm1');
    const before = canvasStoreVanilla.getState().sessionDraggedRefs;

    canvasStoreVanilla.getState().markSessionDragged(ref);

    const after = canvasStoreVanilla.getState().sessionDraggedRefs;
    expect(after).not.toBe(before); // new Set instance — immutable update
    expect(after.has(ref)).toBe(true);
    expect(before.has(ref)).toBe(false); // the original Set is untouched
  });

  it('marking the same ref twice is a no-op (same Set reference, no needless churn)', () => {
    const ref = makeRef('mission', 'm1');
    canvasStoreVanilla.getState().markSessionDragged(ref);
    const afterFirst = canvasStoreVanilla.getState().sessionDraggedRefs;

    canvasStoreVanilla.getState().markSessionDragged(ref);
    const afterSecond = canvasStoreVanilla.getState().sessionDraggedRefs;

    expect(afterSecond).toBe(afterFirst);
  });

  it('is NOT part of undo/redo history — marking a ref pushes no history entry', () => {
    const before = pastLength();
    canvasStoreVanilla.getState().markSessionDragged(makeRef('mission', 'm1'));
    expect(pastLength()).toBe(before);
  });

  it('hydrate() resets sessionDraggedRefs — a fresh load starts a fresh session', () => {
    canvasStoreVanilla.getState().markSessionDragged(makeRef('mission', 'm1'));
    expect(canvasStoreVanilla.getState().sessionDraggedRefs.size).toBe(1);

    canvasStoreVanilla.getState().hydrate(null, null);

    expect(canvasStoreVanilla.getState().sessionDraggedRefs.size).toBe(0);
  });
});

// ── W-DISMISS: dismissedRefs (per-mission "Retirer du canvas") ────────────

describe('canvasStore — dismissMission (W-DISMISS)', () => {
  it('starts empty', () => {
    expect(canvasStoreVanilla.getState().dismissedRefs).toEqual([]);
  });

  it('dismissMission appends a mission:<id> ref immutably', () => {
    const before = canvasStoreVanilla.getState().dismissedRefs;

    canvasStoreVanilla.getState().dismissMission('m1');

    const after = canvasStoreVanilla.getState().dismissedRefs;
    expect(after).not.toBe(before); // new array instance — immutable update
    expect(after).toEqual([makeRef('mission', 'm1')]);
    expect(before).toEqual([]); // the original array is untouched
  });

  it('records the mission:<id> kind regardless of whether the mission currently renders as a loop', () => {
    canvasStoreVanilla.getState().dismissMission('loop1');
    expect(canvasStoreVanilla.getState().dismissedRefs).toEqual([makeRef('mission', 'loop1')]);
  });

  it('dismissing the same mission id twice is a no-op (deduped, no needless churn)', () => {
    canvasStoreVanilla.getState().dismissMission('m1');
    const afterFirst = canvasStoreVanilla.getState().dismissedRefs;

    canvasStoreVanilla.getState().dismissMission('m1');
    const afterSecond = canvasStoreVanilla.getState().dismissedRefs;

    expect(afterSecond).toBe(afterFirst);
  });

  it('is part of undo/redo history — a user edit, unlike sessionDraggedRefs', () => {
    const before = pastLength();
    canvasStoreVanilla.getState().dismissMission('m1');
    expect(pastLength()).toBe(before + 1);

    canvasStoreVanilla.temporal.getState().undo();
    expect(canvasStoreVanilla.getState().dismissedRefs).toEqual([]);
  });

  it('hydrate() restores dismissedRefs from a persisted layout, defaulting to [] when absent', () => {
    const layout: CanvasLayoutFileV1 = {
      version: 1,
      positions: {},
      collapsed: {},
      prefs: DEFAULT_CANVAS_PREFS,
      notes: [],
      dismissedRefs: [makeRef('mission', 'm1'), makeRef('mission', 'm2')],
    };
    canvasStoreVanilla.getState().hydrate(layout, null);
    expect(canvasStoreVanilla.getState().dismissedRefs).toEqual([makeRef('mission', 'm1'), makeRef('mission', 'm2')]);

    canvasStoreVanilla.getState().hydrate(null, null);
    expect(canvasStoreVanilla.getState().dismissedRefs).toEqual([]);
  });
});

describe('canvasStore — draft version history (updateDraft auto-versioning)', () => {
  function seedDraft(): void {
    canvasStoreVanilla.getState().addDraft({ id: 'd1', title: 'v1 title', task: 'v1 task', model: 'sonnet', createdBy: 'user' });
  }

  it('appends a version snapshot on every updateDraft call', () => {
    seedDraft();
    expect(canvasStoreVanilla.getState().draftVersions.d1).toBeUndefined();

    canvasStoreVanilla.getState().updateDraft('d1', { title: 'v2 title', task: 'v2 task' });

    const versions = canvasStoreVanilla.getState().draftVersions.d1!;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ title: 'v2 title', task: 'v2 task', model: 'sonnet' });
    expect(typeof versions[0]!.ts).toBe('number');
  });

  it('accumulates one snapshot per edit, in order', () => {
    seedDraft();
    canvasStoreVanilla.getState().updateDraft('d1', { title: 'v2' });
    canvasStoreVanilla.getState().updateDraft('d1', { title: 'v3' });
    canvasStoreVanilla.getState().updateDraft('d1', { title: 'v4' });

    const versions = canvasStoreVanilla.getState().draftVersions.d1!;
    expect(versions.map((v) => v.title)).toEqual(['v2', 'v3', 'v4']);
  });

  it('caps history at DRAFT_VERSION_CAP, dropping the OLDEST first', () => {
    seedDraft();
    for (let i = 0; i < 25; i += 1) {
      canvasStoreVanilla.getState().updateDraft('d1', { title: `v${i}` });
    }
    const versions = canvasStoreVanilla.getState().draftVersions.d1!;
    expect(versions.length).toBe(20);
    expect(versions[0]!.title).toBe('v5'); // oldest 5 (v0..v4) dropped
    expect(versions[versions.length - 1]!.title).toBe('v24');
  });

  it('is a no-op (no version, no draft change) for an unknown draft id', () => {
    seedDraft();
    const before = canvasStoreVanilla.getState();

    canvasStoreVanilla.getState().updateDraft('does-not-exist', { title: 'x' });

    expect(canvasStoreVanilla.getState().drafts).toEqual(before.drafts);
    expect(canvasStoreVanilla.getState().draftVersions).toEqual(before.draftVersions);
  });

  it('removeDraft clears that draft id out of draftVersions (no orphaned history)', () => {
    seedDraft();
    canvasStoreVanilla.getState().updateDraft('d1', { title: 'v2' });
    expect(canvasStoreVanilla.getState().draftVersions.d1).toBeDefined();

    canvasStoreVanilla.getState().removeDraft('d1');

    expect(canvasStoreVanilla.getState().draftVersions.d1).toBeUndefined();
  });

  it('remapDraftToMission clears draftVersions for the launched draft', () => {
    seedDraft();
    canvasStoreVanilla.getState().updateDraft('d1', { title: 'v2' });

    canvasStoreVanilla.getState().remapDraftToMission('d1', 'm1');

    expect(canvasStoreVanilla.getState().draftVersions.d1).toBeUndefined();
  });

  it('restoreDraftVersion re-applies the old fields as a NEW version, never rewriting history', () => {
    seedDraft();
    canvasStoreVanilla.getState().updateDraft('d1', { title: 'v2 title', task: 'v2 task' });
    const versions = canvasStoreVanilla.getState().draftVersions.d1!;
    const v1Ts = versions[0]!.ts; // the snapshot captured right after the v2 edit reflects v2's OWN fields

    // Edit once more so there's an OLDER snapshot to restore.
    canvasStoreVanilla.getState().updateDraft('d1', { title: 'v3 title', task: 'v3 task' });

    canvasStoreVanilla.getState().restoreDraftVersion('d1', v1Ts);

    const draft = canvasStoreVanilla.getState().drafts.find((d) => d.id === 'd1')!;
    expect(draft.title).toBe('v2 title');
    expect(draft.task).toBe('v2 task');

    const finalVersions = canvasStoreVanilla.getState().draftVersions.d1!;
    expect(finalVersions).toHaveLength(3); // v2-edit, v3-edit, restore-as-v2 — never truncated
    expect(finalVersions[2]).toMatchObject({ title: 'v2 title', task: 'v2 task' });
  });

  it('restoreDraftVersion is a no-op for an unknown draftId or ts', () => {
    seedDraft();
    canvasStoreVanilla.getState().updateDraft('d1', { title: 'v2' });
    const before = canvasStoreVanilla.getState();

    canvasStoreVanilla.getState().restoreDraftVersion('d1', 999999999);
    canvasStoreVanilla.getState().restoreDraftVersion('does-not-exist', before.draftVersions.d1![0]!.ts);

    expect(canvasStoreVanilla.getState().drafts).toEqual(before.drafts);
    expect(canvasStoreVanilla.getState().draftVersions).toEqual(before.draftVersions);
  });
});

describe('canvasStore — group macros', () => {
  const sampleMacro = {
    id: 'macro-1',
    name: 'Tester + reviewer',
    description: 'a group',
    drafts: [],
    routers: [],
    notes: [],
    chains: [],
    positions: {},
    createdAtMs: 1000,
  };

  it('addMacro/removeMacro/renameMacro round-trip', () => {
    canvasStoreVanilla.getState().addMacro(sampleMacro);
    expect(canvasStoreVanilla.getState().macros).toHaveLength(1);

    canvasStoreVanilla.getState().renameMacro('macro-1', { name: 'New name' });
    expect(canvasStoreVanilla.getState().macros[0]!.name).toBe('New name');
    expect(canvasStoreVanilla.getState().macros[0]!.description).toBe('a group'); // untouched

    canvasStoreVanilla.getState().removeMacro('macro-1');
    expect(canvasStoreVanilla.getState().macros).toHaveLength(0);
  });

  it('instantiateMacroResult merges drafts/routers/notes/chains/positions atomically (one history entry)', () => {
    const beforeCount = pastLength();

    canvasStoreVanilla.getState().instantiateMacroResult({
      drafts: [{ id: 'fresh-d1', title: 'T', task: 't', createdBy: 'user' }],
      routers: [],
      notes: [{ id: 'fresh-n1', text: 'x' }],
      chains: [{ id: 'fresh-c1', sourceRef: makeRef('draft', 'fresh-d1'), targetRef: makeRef('note', 'fresh-n1'), condition: 'success', createdBy: 'user' }],
      positions: { [makeRef('draft', 'fresh-d1')]: { x: 10, y: 20 } },
    });

    expect(pastLength()).toBe(beforeCount + 1);
    const state = canvasStoreVanilla.getState();
    expect(state.drafts.map((d) => d.id)).toContain('fresh-d1');
    expect(state.notes.map((n) => n.id)).toContain('fresh-n1');
    expect(state.chains.map((c) => c.id)).toContain('fresh-c1');
    expect(state.positions[makeRef('draft', 'fresh-d1')]).toEqual({ x: 10, y: 20 });
  });

  it('macros/draftVersions round-trip through hydrate()', () => {
    canvasStoreVanilla.getState().hydrate(null, {
      version: 1,
      chains: [],
      drafts: [],
      macros: [sampleMacro],
      draftVersions: { d1: [{ ts: 1, title: 'a', task: 'b' }] },
    });

    expect(canvasStoreVanilla.getState().macros).toEqual([sampleMacro]);
    expect(canvasStoreVanilla.getState().draftVersions).toEqual({ d1: [{ ts: 1, title: 'a', task: 'b' }] });
  });

  it('hydrate(null, null) resets macros/draftVersions to defaults', () => {
    canvasStoreVanilla.getState().addMacro(sampleMacro);
    canvasStoreVanilla.getState().hydrate(null, null);

    expect(canvasStoreVanilla.getState().macros).toEqual([]);
    expect(canvasStoreVanilla.getState().draftVersions).toEqual({});
  });

  it('a macro captured on one project instantiates cleanly on a different project (global store, no per-project scoping)', () => {
    // W-CLOSE row 3 (scorecard "AutoGen Studio Gallery" gap, re-examined):
    // macros live in canvasStore's `macros` slice, which canvasPersistence.ts's
    // own header already documents as GLOBAL, project-INDEPENDENT storage —
    // canvasMacros.test.ts covers the pure captureMacro/instantiateMacro
    // remap in isolation; this proves the same claim through the actual
    // STORE end to end: a macro captured from project A's drafts, once added
    // to the store, instantiates a fresh project-B-owned draft while the
    // original template (still keyed on its own capture-time id) is left
    // completely untouched — i.e. reusable again for a third project.
    const captured = captureMacro(
      { drafts: [{ id: 'a1', title: 'Implémenter', task: 'do X', createdBy: 'user', projectId: 'proj-A' }], routers: [], notes: [], chains: [], positions: {} },
      [makeRef('draft', 'a1')],
      'Starter kit',
      undefined,
    );
    canvasStoreVanilla.getState().addMacro(captured);

    const result = instantiateMacro(captured, { x: 0, y: 0 }, 'proj-B', []);
    canvasStoreVanilla.getState().instantiateMacroResult(result);

    const state = canvasStoreVanilla.getState();
    expect(state.macros).toHaveLength(1);
    expect(state.macros[0]!.id).toBe(captured.id); // template untouched, still reusable
    const projectBDrafts = state.drafts.filter((d) => d.projectId === 'proj-B');
    expect(projectBDrafts).toHaveLength(1);
    expect(projectBDrafts[0]!.id).not.toBe('a1'); // fresh id, never the template's own
  });
});

describe('canvasStore — mergeImportedCanvas (W-CLOSE row 4, export/import)', () => {
  it('merges drafts/routers/notes/chains/macros/frames/positions atomically (one history entry)', () => {
    const beforeCount = pastLength();

    canvasStoreVanilla.getState().mergeImportedCanvas({
      drafts: [{ id: 'imp-d1', title: 'T', task: 't', createdBy: 'user' }],
      routers: [],
      joins: [],
      notes: [{ id: 'imp-n1', text: 'x' }],
      chains: [{ id: 'imp-c1', sourceRef: makeRef('draft', 'imp-d1'), targetRef: makeRef('note', 'imp-n1'), condition: 'success', createdBy: 'user' }],
      macros: [{ id: 'imp-m1', name: 'Imported macro', drafts: [], routers: [], notes: [], chains: [], positions: {}, createdAtMs: 1 }],
      frames: [{ id: 'imp-f1', title: 'Imported group', width: 300, height: 200 }],
      contests: [{ id: 'imp-k1', draftTemplateId: 'imp-d1', missionIds: [], status: 'running', createdAtMs: 1 }],
      positions: { [makeRef('draft', 'imp-d1')]: { x: 10, y: 20 } },
    });

    expect(pastLength()).toBe(beforeCount + 1);
    const state = canvasStoreVanilla.getState();
    expect(state.drafts.map((d) => d.id)).toContain('imp-d1');
    expect(state.notes.map((n) => n.id)).toContain('imp-n1');
    expect(state.chains.map((c) => c.id)).toContain('imp-c1');
    expect(state.macros.map((m) => m.id)).toContain('imp-m1');
    expect(state.frames.map((f) => f.id)).toContain('imp-f1');
    expect(state.contests.map((c) => c.id)).toContain('imp-k1');
    expect(state.positions[makeRef('draft', 'imp-d1')]).toEqual({ x: 10, y: 20 });
  });

  it('appends onto (never replaces) existing content', () => {
    canvasStoreVanilla.getState().addDraft({ id: 'existing-d1', title: 'Existing', task: 't', createdBy: 'user' });
    canvasStoreVanilla.getState().mergeImportedCanvas({
      drafts: [{ id: 'imp-d2', title: 'Imported', task: 't', createdBy: 'user' }],
      routers: [],
      joins: [],
      notes: [],
      chains: [],
      macros: [],
      frames: [],
      contests: [],
      positions: {},
    });
    const ids = canvasStoreVanilla.getState().drafts.map((d) => d.id);
    expect(ids).toContain('existing-d1');
    expect(ids).toContain('imp-d2');
  });
});

describe('canvasStore — join (fan-in) CRUD', () => {
  it('addJoin/removeJoin add and remove a join', () => {
    canvasStoreVanilla.getState().addJoin({ id: 'j1', mode: 'all_success', sourceRefs: [makeRef('mission', 'm1'), makeRef('mission', 'm2')] });
    expect(canvasStoreVanilla.getState().joins.map((j) => j.id)).toContain('j1');

    canvasStoreVanilla.getState().removeJoin('j1');
    expect(canvasStoreVanilla.getState().joins.map((j) => j.id)).not.toContain('j1');
  });

  it('updateJoin patches name/mode/sourceRefs immutably (never mutates the original object)', () => {
    const original = { id: 'j1', mode: 'all_success' as const, sourceRefs: [makeRef('mission', 'm1'), makeRef('mission', 'm2')] };
    canvasStoreVanilla.getState().addJoin(original);

    canvasStoreVanilla.getState().updateJoin('j1', { name: 'Fan-in', mode: 'all_settled' });

    expect(original.mode).toBe('all_success'); // the original object was never touched
    const updated = canvasStoreVanilla.getState().joins.find((j) => j.id === 'j1');
    expect(updated).toMatchObject({ name: 'Fan-in', mode: 'all_settled' });
  });

  it('updateJoin is a no-op for an unknown id', () => {
    canvasStoreVanilla.getState().addJoin({ id: 'j1', mode: 'all_success', sourceRefs: [makeRef('mission', 'm1'), makeRef('mission', 'm2')] });
    canvasStoreVanilla.getState().updateJoin('does-not-exist', { name: 'x' });
    expect(canvasStoreVanilla.getState().joins.find((j) => j.id === 'j1')?.name).toBeUndefined();
  });

  it('addChain wires a new source into the target join\'s sourceRefs when targetRef is a join', () => {
    canvasStoreVanilla.getState().addJoin({ id: 'j1', mode: 'all_success', sourceRefs: [makeRef('mission', 'm1')] });

    canvasStoreVanilla.getState().addChain({
      id: 'c1',
      sourceRef: makeRef('mission', 'm2'),
      targetRef: makeRef('join', 'j1'),
      condition: 'success',
      createdBy: 'user',
    });

    expect(canvasStoreVanilla.getState().joins.find((j) => j.id === 'j1')?.sourceRefs).toEqual([
      makeRef('mission', 'm1'),
      makeRef('mission', 'm2'),
    ]);
    expect(canvasStoreVanilla.getState().chains.map((c) => c.id)).toContain('c1');
  });

  it('addChain never double-adds the same source to a join (idempotent)', () => {
    canvasStoreVanilla.getState().addJoin({ id: 'j1', mode: 'all_success', sourceRefs: [makeRef('mission', 'm1')] });
    canvasStoreVanilla.getState().addChain({
      id: 'c1',
      sourceRef: makeRef('mission', 'm1'),
      targetRef: makeRef('join', 'j1'),
      condition: 'success',
      createdBy: 'user',
    });
    expect(canvasStoreVanilla.getState().joins.find((j) => j.id === 'j1')?.sourceRefs).toEqual([makeRef('mission', 'm1')]);
  });

  it('addChain targeting a non-join ref never touches joins at all', () => {
    canvasStoreVanilla.getState().addJoin({ id: 'j1', mode: 'all_success', sourceRefs: [makeRef('mission', 'm1')] });
    canvasStoreVanilla.getState().addChain({
      id: 'c1',
      sourceRef: makeRef('mission', 'm2'),
      targetRef: makeRef('draft', 'd1'),
      condition: 'success',
      createdBy: 'user',
    });
    expect(canvasStoreVanilla.getState().joins.find((j) => j.id === 'j1')?.sourceRefs).toEqual([makeRef('mission', 'm1')]);
  });

  it('hydrate() restores joins from a chains.json file (V1-compatible: absent joins hydrates to [])', () => {
    const chainsFile: ChainsFileV1 = {
      version: 1,
      chains: [],
      drafts: [],
      joins: [{ id: 'j1', mode: 'all_success', sourceRefs: [makeRef('mission', 'm1'), makeRef('mission', 'm2')] }],
    };
    canvasStoreVanilla.getState().hydrate(null, chainsFile);
    expect(canvasStoreVanilla.getState().joins).toHaveLength(1);

    canvasStoreVanilla.getState().hydrate(null, { version: 1, chains: [], drafts: [] });
    expect(canvasStoreVanilla.getState().joins).toEqual([]);
  });
});

describe('canvasStore — contest (best-of-N) CRUD (W-CONTEST)', () => {
  it('addContest/removeContest add and remove a contest', () => {
    canvasStoreVanilla.getState().addContest({ id: 'k1', draftTemplateId: 'd1', missionIds: ['m1', 'm2'], status: 'running', createdAtMs: 1 });
    expect(canvasStoreVanilla.getState().contests.map((c) => c.id)).toContain('k1');

    canvasStoreVanilla.getState().removeContest('k1');
    expect(canvasStoreVanilla.getState().contests.map((c) => c.id)).not.toContain('k1');
  });

  it('completeContest sets status + winnerId immutably, leaving every other contest untouched', () => {
    canvasStoreVanilla.getState().addContest({ id: 'k1', draftTemplateId: 'd1', missionIds: ['m1', 'm2'], status: 'running', createdAtMs: 1 });
    canvasStoreVanilla.getState().addContest({ id: 'k2', draftTemplateId: 'd2', missionIds: ['m3', 'm4'], status: 'running', createdAtMs: 2 });
    const before = canvasStoreVanilla.getState().contests.find((c) => c.id === 'k1')!;

    canvasStoreVanilla.getState().completeContest('k1', 'm1');

    const after = canvasStoreVanilla.getState().contests.find((c) => c.id === 'k1')!;
    expect(after).toMatchObject({ status: 'completed', winnerId: 'm1' });
    expect(after).not.toBe(before); // new object, never mutated in place
    expect(before.status).toBe('running'); // original object left untouched

    const other = canvasStoreVanilla.getState().contests.find((c) => c.id === 'k2')!;
    expect(other.status).toBe('running');
  });

  it('completeContest with an undefined winnerId records the honest no-winner case', () => {
    canvasStoreVanilla.getState().addContest({ id: 'k1', draftTemplateId: 'd1', missionIds: ['m1', 'm2'], status: 'running', createdAtMs: 1 });
    canvasStoreVanilla.getState().completeContest('k1', undefined);
    const after = canvasStoreVanilla.getState().contests.find((c) => c.id === 'k1')!;
    expect(after.status).toBe('completed');
    expect(after.winnerId).toBeUndefined();
  });

  it('completeContest is a no-op for an unknown contest id', () => {
    canvasStoreVanilla.getState().addContest({ id: 'k1', draftTemplateId: 'd1', missionIds: ['m1'], status: 'running', createdAtMs: 1 });
    const before = canvasStoreVanilla.getState().contests;
    canvasStoreVanilla.getState().completeContest('does-not-exist', 'm1');
    expect(canvasStoreVanilla.getState().contests.map((c) => ({ ...c }))).toEqual(before.map((c) => ({ ...c })));
  });

  it('completeContest is EXCLUDED from undo/redo history, exactly like markChainFired', () => {
    canvasStoreVanilla.getState().addContest({ id: 'k1', draftTemplateId: 'd1', missionIds: ['m1'], status: 'running', createdAtMs: 1 });
    const beforeComplete = pastLength();

    canvasStoreVanilla.getState().completeContest('k1', 'm1');

    expect(pastLength()).toBe(beforeComplete); // no new history entry pushed
    expect(canvasStoreVanilla.getState().contests.find((c) => c.id === 'k1')!.status).toBe('completed');
  });

  it('hydrate() restores contests from a chains.json file (V1-compatible: absent contests hydrates to [])', () => {
    const chainsFile: ChainsFileV1 = {
      version: 1,
      chains: [],
      drafts: [],
      contests: [{ id: 'k1', draftTemplateId: 'd1', missionIds: ['m1', 'm2'], status: 'running', createdAtMs: 1 }],
    };
    canvasStoreVanilla.getState().hydrate(null, chainsFile);
    expect(canvasStoreVanilla.getState().contests).toHaveLength(1);

    canvasStoreVanilla.getState().hydrate(null, { version: 1, chains: [], drafts: [] });
    expect(canvasStoreVanilla.getState().contests).toEqual([]);
  });
});

describe('canvasStore — plan proposal preview (chantier 3, plan-first canvas)', () => {
  function seedProposedPlan(planId: string) {
    const store = canvasStoreVanilla.getState();
    store.addProposalPreview({
      drafts: [
        { id: 'stepA', title: 'Step A', task: 'do A', createdBy: 'manager', proposedPlanId: planId },
        { id: 'stepB', title: 'Step B', task: 'do B', createdBy: 'manager', proposedPlanId: planId },
      ],
      chains: [
        {
          id: 'c-a-b',
          sourceRef: makeRef('draft', 'stepA'),
          targetRef: makeRef('draft', 'stepB'),
          condition: 'success',
          createdBy: 'manager',
          proposedPlanId: planId,
        },
      ],
      joins: [],
    });
  }

  it('addProposalPreview appends drafts/chains tagged with proposedPlanId (never launches anything)', () => {
    seedProposedPlan('plan1');
    const state = canvasStoreVanilla.getState();
    expect(state.drafts.map((d) => d.id)).toEqual(['stepA', 'stepB']);
    expect(state.drafts.every((d) => d.proposedPlanId === 'plan1')).toBe(true);
    expect(state.chains[0].proposedPlanId).toBe('plan1');
  });

  it('keeps a pending preview and its position when canvas hydration finishes after the plan was proposed', () => {
    seedProposedPlan('plan1');
    canvasStoreVanilla.getState().setPosition(makeRef('draft', 'stepA'), { x: 80, y: 44 });

    const layout: CanvasLayoutFileV1 = {
      version: 1,
      positions: { [makeRef('draft', 'persisted')]: { x: 12, y: 18 } },
      collapsed: {},
      prefs: DEFAULT_CANVAS_PREFS,
      notes: [],
    };
    const chainsFile: ChainsFileV1 = {
      version: 1,
      chains: [],
      drafts: [{ id: 'persisted', title: 'Persisted', task: 'persisted task', createdBy: 'user' }],
    };

    canvasStoreVanilla.getState().hydrate(layout, chainsFile);

    const state = canvasStoreVanilla.getState();
    expect(state.drafts.map((draft) => draft.id).sort()).toEqual(['persisted', 'stepA', 'stepB']);
    expect(state.positions[makeRef('draft', 'stepA')]).toEqual({ x: 80, y: 44 });
    expect(state.positions[makeRef('draft', 'persisted')]).toEqual({ x: 12, y: 18 });
  });

  it('acceptProposedSteps(planId, null) materializes every step in place — same ids, no new nodes, proposedPlanId cleared', () => {
    seedProposedPlan('plan1');

    canvasStoreVanilla.getState().acceptProposedSteps('plan1', null);

    const state = canvasStoreVanilla.getState();
    expect(state.drafts.map((d) => d.id).sort()).toEqual(['stepA', 'stepB']); // SAME ids — no delete+recreate
    expect(state.drafts.every((d) => d.proposedPlanId === undefined)).toBe(true);
    expect(state.chains).toHaveLength(1);
    expect(state.chains[0].proposedPlanId).toBeUndefined();
  });

  it('partial validation: an unselected step is removed, its dangling chain is dropped, the accepted step survives active', () => {
    seedProposedPlan('plan1');

    canvasStoreVanilla.getState().acceptProposedSteps('plan1', ['stepA']);

    const state = canvasStoreVanilla.getState();
    expect(state.drafts.map((d) => d.id)).toEqual(['stepA']);
    expect(state.drafts[0].proposedPlanId).toBeUndefined();
    // The chain stepA->stepB dangles onto a removed step — dropped, never
    // left pointing at a node that no longer exists.
    expect(state.chains).toHaveLength(0);
  });

  it('rejectProposedPlan removes every drafted/chained primitive tagged with that planId — no orphaned ghosts', () => {
    seedProposedPlan('plan1');

    canvasStoreVanilla.getState().rejectProposedPlan('plan1');

    const state = canvasStoreVanilla.getState();
    expect(state.drafts).toHaveLength(0);
    expect(state.chains).toHaveLength(0);
  });

  it('a join proposal below MIN_JOIN_SOURCES after partial validation is dropped, not left half-wired', () => {
    const store = canvasStoreVanilla.getState();
    store.addProposalPreview({
      drafts: [
        { id: 'stepA', title: 'A', task: 'a', createdBy: 'manager', proposedPlanId: 'plan1' },
        { id: 'stepB', title: 'B', task: 'b', createdBy: 'manager', proposedPlanId: 'plan1' },
      ],
      chains: [],
      joins: [
        {
          id: 'join1',
          mode: 'all_success',
          sourceRefs: [makeRef('draft', 'stepA'), makeRef('draft', 'stepB')],
          proposedPlanId: 'plan1',
        },
      ],
    });

    canvasStoreVanilla.getState().acceptProposedSteps('plan1', ['stepA']); // stepB rejected

    const state = canvasStoreVanilla.getState();
    expect(state.joins).toHaveLength(0); // 1 surviving source < MIN_JOIN_SOURCES(2) — dropped
  });

  it('does not disturb a normal (non-proposed) draft, and a rejected plan never touches an already-accepted step from the SAME planId', () => {
    const store = canvasStoreVanilla.getState();
    store.addDraft({ id: 'manual1', title: 'Manual', task: 'x', createdBy: 'user' });
    seedProposedPlan('plan1');

    canvasStoreVanilla.getState().acceptProposedSteps('plan1', ['stepA']);
    expect(canvasStoreVanilla.getState().drafts.map((d) => d.id).sort()).toEqual(['manual1', 'stepA']);

    // stepA is already materialized (proposedPlanId cleared) — a later
    // reject of the SAME planId (e.g. a stray double-click) must not
    // retroactively undo an already-accepted step; only the untouched
    // manual draft and the now-active stepA remain.
    canvasStoreVanilla.getState().rejectProposedPlan('plan1');
    expect(canvasStoreVanilla.getState().drafts.map((d) => d.id).sort()).toEqual(['manual1', 'stepA']);
  });

  it('remapDraftToMission on an accepted (materialized) step preserves identity into the mission — the final continuity leg', () => {
    seedProposedPlan('plan1');
    canvasStoreVanilla.getState().acceptProposedSteps('plan1', null);
    canvasStoreVanilla.getState().setPosition(makeRef('draft', 'stepA'), { x: 42, y: 7 });

    canvasStoreVanilla.getState().remapDraftToMission('stepA', 'M1');

    const state = canvasStoreVanilla.getState();
    expect(state.drafts.map((d) => d.id)).toEqual(['stepB']); // stepA is gone — now a mission
    expect(state.positions[makeRef('mission', 'M1')]).toEqual({ x: 42, y: 7 });
    expect(state.chains[0].sourceRef).toBe(makeRef('mission', 'M1')); // rewritten, not dangling
  });
});

// ── P0 crash, round 3 — canvas-side ref-uniqueness backstop ───────────
//
// Live repro (spy on the running app, 2026-08-01): two INDEPENDENT plans
// (generated in different manager turns — e1b2e60 keeps a plan's proposed
// drafts alive across hydrate(), so this reaches across sessions) each
// produced a step called "audit". Two DraftSpec objects, but
// makeRef('draft', 'audit') collapses them onto the ONE SAME NodeRef —
// canvasStore's `positions` map has exactly one slot for that shared key,
// so the reconciler's declutter pass can never separate them: every pass
// rediscovers the "same" collision and nudges by
// findFreePosition's shelf step (draft width 260 + SCAN_MARGIN 16 =
// 276px), forever — see reconcilerConvergence.test.ts's own "round 3"
// section for the raw mechanism proof, and canvasRefIntegrity.ts's header
// for the full writeup.
describe('canvasStore — ref-uniqueness backstop (P0 crash, round 3)', () => {
  it('addProposalPreview renames a SECOND plan\'s colliding draft id, keeps the FIRST plan\'s draft untouched, and rewrites the chain that referenced it', () => {
    const store = canvasStoreVanilla.getState();
    store.addProposalPreview({
      drafts: [{ id: 'audit', title: 'Audit (plan A)', task: 'x', createdBy: 'manager', proposedPlanId: 'planA' }],
      chains: [],
      joins: [],
    });
    store.addProposalPreview({
      drafts: [
        { id: 'audit', title: 'Audit (plan B)', task: 'x', createdBy: 'manager', proposedPlanId: 'planB' },
        { id: 'verify', title: 'Verify (plan B)', task: 'x', createdBy: 'manager', proposedPlanId: 'planB' },
      ],
      chains: [
        {
          id: 'c-audit-verify',
          sourceRef: makeRef('draft', 'audit'),
          targetRef: makeRef('draft', 'verify'),
          condition: 'success',
          createdBy: 'manager',
          proposedPlanId: 'planB',
        },
      ],
      joins: [],
    });

    const state = canvasStoreVanilla.getState();
    // No two drafts ever share a NodeRef — the invariant this wave adds.
    const refs = state.drafts.map((d) => makeRef('draft', d.id));
    expect(new Set(refs).size).toBe(refs.length);

    const planADraft = state.drafts.find((d) => d.proposedPlanId === 'planA')!;
    const planBAuditDraft = state.drafts.find((d) => d.proposedPlanId === 'planB' && d.title === 'Audit (plan B)')!;
    expect(planADraft.id).toBe('audit'); // first occupant keeps its id
    expect(planBAuditDraft.id).not.toBe('audit'); // the later arrival was renamed instead

    // The chain that pointed at plan B's OWN "audit" draft was rewritten to
    // the new ref, not left dangling on the old shared one.
    const chain = state.chains.find((c) => c.id === 'c-audit-verify')!;
    expect(chain.sourceRef).toBe(makeRef('draft', planBAuditDraft.id));
  });

  it('hydrate() repairs an already-corrupted persisted file (two drafts sharing an id, written before this fix existed) without deleting either one\'s content', () => {
    const chainsFile: ChainsFileV1 = {
      version: 1,
      chains: [
        {
          id: 'c1',
          sourceRef: makeRef('draft', 'audit'),
          targetRef: makeRef('draft', 'verify'),
          condition: 'success',
          createdBy: 'manager',
        },
      ],
      // Two DIFFERENT drafts, same id — exactly the shape a pre-fix
      // chains.json could already carry on disk (this wave's own P3 repair
      // target), constructed directly rather than through
      // addProposalPreview (which already guards against this) to exercise
      // the LEGACY-DATA path specifically.
      drafts: [
        { id: 'audit', title: 'Audit (first)', task: 'x', createdBy: 'manager' },
        { id: 'audit', title: 'Audit (second)', task: 'x', createdBy: 'manager' },
        { id: 'verify', title: 'Verify', task: 'x', createdBy: 'manager' },
      ],
    };

    canvasStoreVanilla.getState().hydrate(null, chainsFile);

    const state = canvasStoreVanilla.getState();
    expect(state.drafts).toHaveLength(3); // both "audit" drafts survive — repaired, not deleted
    const refs = state.drafts.map((d) => makeRef('draft', d.id));
    expect(new Set(refs).size).toBe(3); // but never share a ref anymore
    expect(state.drafts.map((d) => d.title).sort()).toEqual(['Audit (first)', 'Audit (second)', 'Verify']);
    // The chain into the renamed "second" draft never happened to exist in
    // this fixture (both drafts happened to be named "audit" but only ONE
    // was ever a real chain target) — the surviving chain still resolves.
    expect(state.chains[0].targetRef).toBe(makeRef('draft', 'verify'));
  });

  it('hydrate() drops an absurd out-of-bounds persisted position (this exact bug\'s unbounded drift) instead of leaving the node invisible', () => {
    const layout: CanvasLayoutFileV1 = {
      version: 1,
      positions: {
        [makeRef('draft', 'drifted')]: { x: 337196, y: 36 }, // real drift coordinates from the live crash
        [makeRef('draft', 'normal')]: { x: 120, y: 80 },
      },
      collapsed: {},
      prefs: DEFAULT_CANVAS_PREFS,
      notes: [],
    };
    const chainsFile: ChainsFileV1 = {
      version: 1,
      chains: [],
      drafts: [
        { id: 'drifted', title: 'Drifted', task: 'x', createdBy: 'manager' },
        { id: 'normal', title: 'Normal', task: 'x', createdBy: 'manager' },
      ],
    };

    canvasStoreVanilla.getState().hydrate(layout, chainsFile);

    const state = canvasStoreVanilla.getState();
    expect(state.positions[makeRef('draft', 'drifted')]).toBeUndefined(); // dropped, never invented a replacement
    expect(state.positions[makeRef('draft', 'normal')]).toEqual({ x: 120, y: 80 }); // untouched
    expect(state.drafts.some((d) => d.id === 'drifted')).toBe(true); // content preserved — only geometry repaired
  });

  it('END-TO-END: two proposed plans sharing a step id, hydrated together, then the REAL R10 loop converges (would diverge pre-fix — see reconcilerConvergence.test.ts\'s own "round 3" proof of the raw mechanism)', () => {
    // Two plans generated in different manager turns both left a
    // "proposedPlanId"-tagged "audit" draft behind — carried across a
    // hydrate() exactly like e1b2e60 intends for a single pending plan,
    // exercised here for TWO colliding ones at once.
    const store = canvasStoreVanilla.getState();
    store.addProposalPreview({
      drafts: [{ id: 'audit', title: 'Audit (plan A)', task: 'x', createdBy: 'manager', projectId: 'p1', proposedPlanId: 'planA' }],
      chains: [],
      joins: [],
    });
    store.addProposalPreview({
      drafts: [{ id: 'audit', title: 'Audit (plan B)', task: 'x', createdBy: 'manager', projectId: 'p1', proposedPlanId: 'planB' }],
      chains: [],
      joins: [],
    });
    // Both landed on the exact same colliding coordinate — worst case,
    // same as the live spy's own starting point.
    const collidePos = { x: 337196, y: 36 };
    const draftIds = canvasStoreVanilla.getState().drafts.map((d) => makeRef('draft', d.id));
    canvasStoreVanilla.getState().setPositions(Object.fromEntries(draftIds.map((ref) => [ref, collidePos])));

    // A LATER hydrate (project switch back) — "disk" knows nothing about
    // these proposed items; hydrate()'s own proposalPositions merge is what
    // carries their pinned positions forward (same mechanism
    // useCanvasFlowGraph.test.ts's own round-2 regression exercises).
    canvasStoreVanilla.getState().hydrate(
      { version: 1, positions: {}, collapsed: {}, prefs: DEFAULT_CANVAS_PREFS, notes: [] },
      { version: 1, chains: [], drafts: [] },
    );

    const hydrated = canvasStoreVanilla.getState();
    const refs = hydrated.drafts.map((d) => makeRef('draft', d.id));
    expect(new Set(refs).size).toBe(refs.length); // no collision survived hydrate

    const project: FleetProject = { projectId: 'p1', root: '/repo/p1', name: 'p1', missions: [] };
    let positions = { ...hydrated.positions };
    let converged = false;
    for (let i = 0; i < 10; i += 1) {
      const result = reconcile({
        projects: [project],
        drafts: hydrated.drafts,
        chains: hydrated.chains,
        notes: [],
        scheduled: [],
        joins: hydrated.joins,
        positions,
        collapsed: {},
        prefs: DEFAULT_CANVAS_PREFS,
      });
      if (Object.keys(result.declutteredPositions).length === 0) {
        converged = true;
        break;
      }
      positions = { ...positions, ...result.declutteredPositions };
    }
    expect(converged).toBe(true);
  });
});
