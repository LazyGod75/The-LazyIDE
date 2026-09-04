/**
 * canvasDryRun.test.tsx — W8a deliverable #3: dry-run chain preview.
 * Covers the PURE topological walk (order, stagger, branching, roots,
 * cycle guard), the overlay banner (renders, Rejouer/Fermer callbacks),
 * and the "no store mutation during preview" guarantee.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { I18nProvider } from '../i18n';
import {
  computeDryRunTimeline,
  STAGGER_MS,
  type DryRunEdgeInput,
  type DryRunNodeInput,
} from '../components/agents/canvas/dryrun/dryRunWalk';
import { DryRunOverlay } from '../components/agents/canvas/dryrun/DryRunOverlay';
import { requestDryRun, onDryRunRequest } from '../components/agents/canvas/dryrun/dryRunSignal';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';

// ── Pure walk ────────────────────────────────────────────────────────

const NODES: DryRunNodeInput[] = [
  { id: 'draft:a', type: 'draft' },
  { id: 'mission:b', type: 'mission' },
  { id: 'mission:c', type: 'mission' },
  { id: 'note:n', type: 'note' },
  { id: 'project:p', type: 'project' },
];

function edge(id: string, source: string, target: string, condition: DryRunEdgeInput['condition'] = 'success'): DryRunEdgeInput {
  return { id, source, target, condition };
}

describe('computeDryRunTimeline — topological walk (W8a)', () => {
  it('walks a linear chain in topological order with a 400ms stagger, edges firing mid-slot', () => {
    const timeline = computeDryRunTimeline(NODES, [edge('e1', 'draft:a', 'mission:b'), edge('e2', 'mission:b', 'mission:c')]);
    expect(timeline.nodeSteps).toEqual([
      { id: 'draft:a', at: 0 },
      { id: 'mission:b', at: STAGGER_MS },
      { id: 'mission:c', at: 2 * STAGGER_MS },
    ]);
    expect(timeline.edgeSteps).toEqual([
      { id: 'e1', source: 'draft:a', target: 'mission:b', condition: 'success', at: STAGGER_MS / 2 },
      { id: 'e2', source: 'mission:b', target: 'mission:c', condition: 'success', at: STAGGER_MS + STAGGER_MS / 2 },
    ]);
    expect(timeline.truncated).toBe(false);
    // Last step is mission:c at 2*STAGGER; steady state one stagger later.
    expect(timeline.totalMs).toBe(3 * STAGGER_MS);
  });

  it('starts from EVERY root, deterministically (id order), and only includes chain-connected nodes', () => {
    const timeline = computeDryRunTimeline(NODES, [edge('e1', 'mission:c', 'mission:b'), edge('e2', 'draft:a', 'mission:b')]);
    // Two roots (draft:a and mission:c), sorted by id; mission:b waits for both.
    expect(timeline.nodeSteps.map((s) => s.id)).toEqual(['draft:a', 'mission:c', 'mission:b']);
    // note:n / project:p never appear — not chainable/not chained.
    expect(timeline.nodeSteps.find((s) => s.id === 'note:n')).toBeUndefined();
  });

  it('ignores edges touching non-chainable nodes (project/note)', () => {
    const timeline = computeDryRunTimeline(NODES, [edge('e1', 'project:p', 'mission:b'), edge('e2', 'draft:a', 'note:n')]);
    expect(timeline.nodeSteps).toHaveLength(0);
    expect(timeline.edgeSteps).toHaveLength(0);
  });

  it('cycle guard: a cyclic subgraph is left out and flagged truncated, never an infinite loop', () => {
    const timeline = computeDryRunTimeline(NODES, [
      edge('e1', 'mission:b', 'mission:c'),
      edge('e2', 'mission:c', 'mission:b'), // cycle (impossible via chainValidation — guarded anyway)
      edge('e3', 'draft:a', 'mission:b'),
    ]);
    // draft:a processes (indegree 0); b/c never reach indegree 0.
    expect(timeline.nodeSteps.map((s) => s.id)).toEqual(['draft:a']);
    expect(timeline.truncated).toBe(true);
  });
});

// ── Overlay banner ───────────────────────────────────────────────────

function renderOverlay(onReplay = vi.fn(), onClose = vi.fn(), timeline = computeDryRunTimeline(NODES, [edge('e1', 'draft:a', 'mission:b')])) {
  render(
    <I18nProvider>
      <ReactFlowProvider>
        <DryRunOverlay session={{ timeline, elapsedMs: 10_000 }} onReplay={onReplay} onClose={onClose} />
      </ReactFlowProvider>
    </I18nProvider>,
  );
  return { onReplay, onClose };
}

describe('DryRunOverlay — banner (W8a)', () => {
  it('renders the "no agent launched" banner with working Rejouer/Fermer buttons', () => {
    const { onReplay, onClose } = renderOverlay();
    expect(screen.getByTestId('canvas-dryrun-banner')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-dryrun-overlay')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('canvas-dryrun-replay'));
    expect(onReplay).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('canvas-dryrun-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the empty message (and no Rejouer) when there is nothing to simulate', () => {
    renderOverlay(vi.fn(), vi.fn(), computeDryRunTimeline(NODES, []));
    expect(screen.getByTestId('canvas-dryrun-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-dryrun-replay')).not.toBeInTheDocument();
  });
});

// ── No store mutation ────────────────────────────────────────────────

describe('dry-run preview — read-only guarantee (W8a)', () => {
  beforeEach(() => {
    _resetCanvasStoreForTests();
  });

  it('walking + rendering the overlay never mutates canvasStore (chains untouched, no undo entry)', () => {
    canvasStoreVanilla.getState().addChain({ id: 'c1', sourceRef: 'draft:a', targetRef: 'mission:b', condition: 'success', createdBy: 'user' });
    const before = JSON.stringify({
      chains: canvasStoreVanilla.getState().chains,
      drafts: canvasStoreVanilla.getState().drafts,
      positions: canvasStoreVanilla.getState().positions,
    });
    const undoDepthBefore = canvasStoreVanilla.temporal.getState().pastStates.length;

    computeDryRunTimeline(NODES, [edge('c1', 'draft:a', 'mission:b')]);
    renderOverlay();

    const after = JSON.stringify({
      chains: canvasStoreVanilla.getState().chains,
      drafts: canvasStoreVanilla.getState().drafts,
      positions: canvasStoreVanilla.getState().positions,
    });
    expect(after).toBe(before);
    // No lastFiredAtMs was written either — the chain object is unchanged
    // and no undo history entry appeared during the preview.
    expect(canvasStoreVanilla.getState().chains[0].lastFiredAtMs).toBeUndefined();
    expect(canvasStoreVanilla.temporal.getState().pastStates.length).toBe(undoDepthBefore);
  });
});

// ── Signal wire (context menu -> toolbar hook) ───────────────────────

describe('dryRunSignal (W8a)', () => {
  it('delivers a request to every listener and stops after dispose', () => {
    const listener = vi.fn();
    const dispose = onDryRunRequest(listener);
    requestDryRun();
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
    requestDryRun();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
