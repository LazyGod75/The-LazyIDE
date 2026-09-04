/**
 * JoinNode.test.tsx — W-JOIN: JoinNodeCard render (mode badge, per-source
 * arrival dots, name fallback, remove-source floor, delete). Mirrors
 * FrameNode.test.tsx's `renderCard` convention (no @xyflow/react mocking
 * needed here — JoinNodeCard takes `zoomLevel` as a plain prop and never
 * touches NodeResizer/RF context directly, same as RouterNodeCard).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { JoinNodeCard } from '../components/agents/canvas/nodes/JoinNode';
import type { JoinNodeData } from '../components/agents/canvas/canvasTypes';

function renderCard(data: JoinNodeData, selected = false) {
  return render(
    <I18nProvider>
      <JoinNodeCard data={data} selected={selected} />
    </I18nProvider>,
  );
}

function joinData(overrides: Partial<JoinNodeData> = {}): JoinNodeData {
  return {
    joinId: 'j1',
    mode: 'all_success',
    sources: [
      { ref: 'mission:m1', title: 'Mission A', status: 'satisfied' },
      { ref: 'mission:m2', title: 'Mission B', status: 'pending' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  _resetCanvasStoreForTests();
});

describe('JoinNodeCard', () => {
  it('renders the given name, falling back to the generic label when absent', () => {
    renderCard(joinData({ name: 'Fan-in A+B' }));
    expect(screen.getByTestId('join-node-name-j1')).toHaveTextContent('Fan-in A+B');

    renderCard(joinData({ joinId: 'j2', name: undefined }));
    expect(screen.getByTestId('join-node-name-j2')).toHaveTextContent('Join'); // en locale default
  });

  it('shows the correct mode badge for all_success vs all_settled', () => {
    renderCard(joinData({ mode: 'all_success' }));
    expect(screen.getByTestId('join-node-mode-j1')).toHaveTextContent('All succeeded');

    renderCard(joinData({ joinId: 'j2', mode: 'all_settled' }));
    expect(screen.getByTestId('join-node-mode-j2')).toHaveTextContent('All settled');
  });

  it('renders one row per source, each with its own title', () => {
    renderCard(joinData());
    expect(screen.getByTestId('join-node-source-mission:m1')).toHaveTextContent('Mission A');
    expect(screen.getByTestId('join-node-source-mission:m2')).toHaveTextContent('Mission B');
  });

  it('gives a satisfied source a visibly different dot color than a pending one', () => {
    renderCard(joinData());
    const satisfiedDot = screen.getByTestId('join-node-source-dot-mission:m1');
    const pendingDot = screen.getByTestId('join-node-source-dot-mission:m2');
    expect(satisfiedDot.style.background).not.toBe(pendingDot.style.background);
  });

  it('hides the remove-source button at the MIN_JOIN_SOURCES floor (2 sources)', () => {
    renderCard(joinData());
    expect(screen.queryByTestId('join-node-source-remove-mission:m1')).not.toBeInTheDocument();
  });

  it('shows the remove-source button above the floor, and it unwires that source via updateJoin', () => {
    canvasStoreVanilla.getState().addJoin({ id: 'j1', mode: 'all_success', sourceRefs: ['mission:m1', 'mission:m2', 'mission:m3'] });
    renderCard(
      joinData({
        sources: [
          { ref: 'mission:m1', title: 'Mission A', status: 'satisfied' },
          { ref: 'mission:m2', title: 'Mission B', status: 'satisfied' },
          { ref: 'mission:m3', title: 'Mission C', status: 'pending' },
        ],
      }),
    );

    fireEvent.click(screen.getByTestId('join-node-source-remove-mission:m3'));

    expect(canvasStoreVanilla.getState().joins.find((j) => j.id === 'j1')?.sourceRefs).toEqual(['mission:m1', 'mission:m2']);
  });

  it('delete button removes the join from canvasStore', () => {
    canvasStoreVanilla.getState().addJoin({ id: 'j1', mode: 'all_success', sourceRefs: ['mission:m1', 'mission:m2'] });
    renderCard(joinData());

    fireEvent.click(screen.getByTestId('join-node-delete-j1'));

    expect(canvasStoreVanilla.getState().joins.find((j) => j.id === 'j1')).toBeUndefined();
  });

  // W-CARDS (founder, 2026-07-21) — the old `zoomLevel === 'chip'` dot swap
  // is retired: the diamond + source-list panel is the ONE layout at every
  // zoom, exactly like MissionNode.tsx. `zoomLevel` stays accepted on the
  // prop type for call-site compatibility but no longer changes the render.
  it('renders the full diamond + name at zoomLevel "chip" too — no more dot swap', () => {
    render(
      <I18nProvider>
        <JoinNodeCard data={joinData()} zoomLevel="chip" />
      </I18nProvider>,
    );
    expect(screen.queryByTestId('join-node-dot-j1')).not.toBeInTheDocument();
    expect(screen.getByTestId('join-node-name-j1')).toBeInTheDocument();
  });

  // De-adaptation proof — no zoom subscription remains: the render is
  // identical whether `zoomLevel` is the old dot bucket or full.
  it('renders identically whether zoomLevel is "chip" or "full" — no zoom-driven branch remains', () => {
    const { container: chipContainer, unmount } = render(
      <I18nProvider>
        <JoinNodeCard data={joinData()} zoomLevel="chip" />
      </I18nProvider>,
    );
    const chipHtml = chipContainer.innerHTML;
    unmount();

    const { container: fullContainer } = render(
      <I18nProvider>
        <JoinNodeCard data={joinData()} zoomLevel="full" />
      </I18nProvider>,
    );
    expect(fullContainer.innerHTML).toBe(chipHtml);
  });
});
