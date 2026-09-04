/**
 * SearchNode.test.tsx — P-SEARCH (founder directive, verbatim: "la recherche
 * web doit ouvrir une fenêtre liée à l'agent qui demande la recherche et on
 * voit la recherche"). Covers:
 *  - SearchNodeCard's render of the live pendingQuery, history (newest
 *    first), empty state, agent name, and a result row's click -> openExternal.
 *  - The close button forwards to canvasStore's removeSurface.
 *  - PreviewSlotNode's per-instance dispatch: a 'preview' node WITHOUT
 *    data.searchSurface renders as PreviewNode (unchanged real preview),
 *    one WITH it renders as SearchNode — see canvasTypes.ts's
 *    SurfaceSpec.searchSurface doc comment for why this piggy-backs on the
 *    'preview' node-type slot instead of a dedicated CanvasNodeKind.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { I18nProvider } from '../i18n';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import type { SurfaceSpec } from '../components/agents/canvas/canvasTypes';

const openExternalMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/platform/openExternal', () => ({
  openExternal: (url: string) => openExternalMock(url),
}));

// Isolate PreviewSlotNode's dispatch logic from PreviewNode.tsx's own
// reachability-probe machinery (fetch mocking, timers) — irrelevant here,
// covered exhaustively by PreviewNode.test.tsx itself.
vi.mock('../components/agents/canvas/nodes/PreviewNode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/agents/canvas/nodes/PreviewNode')>();
  return {
    ...actual,
    PreviewNode: () => <div data-testid="stub-preview-node" />,
  };
});

import { SearchNodeCard, PreviewSlotNode, type SearchFlowNode } from '../components/agents/canvas/nodes/SearchNode';

function renderCard(data: SurfaceSpec, selected = false) {
  return render(
    <I18nProvider>
      <SearchNodeCard data={data} selected={selected} />
    </I18nProvider>,
  );
}

function makeNodeProps(data: SurfaceSpec, selected = false): NodeProps<SearchFlowNode> {
  return {
    id: data.id,
    type: 'preview',
    data: data as SearchFlowNode['data'],
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    selected,
    draggable: true,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  openExternalMock.mockClear();
});

describe('SearchNodeCard — empty / pending / history rendering', () => {
  it('shows the empty-state message when there is no pending query and no history', () => {
    renderCard({ id: 's1', kind: 'preview', searchSurface: { history: [] } });
    expect(screen.getByTestId('search-node-empty-s1')).toBeInTheDocument();
  });

  it('shows a live pending query banner while a search is in flight, no history yet', () => {
    renderCard({
      id: 's1',
      kind: 'preview',
      searchSurface: { pendingQuery: 'react flow node types', history: [] },
    });
    const pending = screen.getByTestId('search-node-pending-s1');
    expect(pending).toHaveTextContent('react flow node types');
    expect(screen.queryByTestId('search-node-empty-s1')).not.toBeInTheDocument();
  });

  it('renders the agent name in the header when present', () => {
    renderCard({
      id: 's1',
      kind: 'preview',
      searchSurface: { agentName: 'Coder', history: [] },
    });
    expect(screen.getByTestId('search-node-agent-s1')).toHaveTextContent('Coder');
  });

  it('renders history entries newest-first, each with its query and result rows', () => {
    renderCard({
      id: 's1',
      kind: 'preview',
      searchSurface: {
        history: [
          { query: 'second query', results: [{ title: 'Result B', url: 'https://b.example', snippet: 'snippet B' }], atMs: 2000 },
          { query: 'first query', results: [{ title: 'Result A', url: 'https://a.example', snippet: 'snippet A' }], atMs: 1000 },
        ],
      },
    });

    const historyBlocks = screen.getAllByTestId(/^search-node-history-s1-/);
    expect(historyBlocks).toHaveLength(2);
    expect(historyBlocks[0]).toHaveTextContent('second query');
    expect(historyBlocks[1]).toHaveTextContent('first query');
    expect(screen.getByText('Result B')).toBeInTheDocument();
    expect(screen.getByText('Result A')).toBeInTheDocument();
  });

  it('a history entry with zero results shows the "no results" label instead of a blank list', () => {
    renderCard({
      id: 's1',
      kind: 'preview',
      searchSurface: { history: [{ query: 'a query with nothing found', results: [], atMs: 1000 }] },
    });
    expect(screen.getByTestId('search-node-history-s1-0')).toHaveTextContent('No results.');
  });

  it('clicking a result row opens it via openExternal with the result URL', () => {
    renderCard({
      id: 's1',
      kind: 'preview',
      searchSurface: {
        history: [{ query: 'q', results: [{ title: 'Result A', url: 'https://a.example', snippet: '' }], atMs: 1000 }],
      },
    });

    fireEvent.click(screen.getByTestId('search-node-result-s1-0'));
    expect(openExternalMock).toHaveBeenCalledWith('https://a.example');
  });

  it('the close button removes the surface via canvasStore', () => {
    canvasStoreVanilla.getState().addSurface({ id: 's1', kind: 'preview', searchSurface: { history: [] } });
    renderCard(canvasStoreVanilla.getState().surfaces[0]);

    fireEvent.click(screen.getByTestId('search-node-close-s1'));
    expect(canvasStoreVanilla.getState().surfaces.find((s) => s.id === 's1')).toBeUndefined();
  });
});

describe('PreviewSlotNode — per-instance dispatch (data.searchSurface presence)', () => {
  // P2-15 fix — SearchNode/PreviewNode now each mount a real `<Handle>`
  // (see their own module's identical doc comment: the "React Flow error
  // 008" fix), which needs a ReactFlowProvider ancestor to call its
  // internal `useStoreApi()` — same requirement every OTHER node's own RF-
  // registered wrapper already has when mounted for real (canvasNodes.test.tsx's
  // own header), just not previously needed here since this file only ever
  // rendered the Card/stub before.
  function renderSlot(data: SurfaceSpec, selected = false) {
    return render(
      <I18nProvider>
        <ReactFlowProvider>
          <PreviewSlotNode {...makeNodeProps(data, selected)} />
        </ReactFlowProvider>
      </I18nProvider>,
    );
  }

  it('renders SearchNode for a surface that carries searchSurface', () => {
    const data: SurfaceSpec = { id: 's1', kind: 'preview', searchSurface: { history: [] } };
    renderSlot(data);
    expect(screen.getByTestId('search-node-s1')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-preview-node')).not.toBeInTheDocument();
  });

  it('renders PreviewNode unchanged for a real preview (no searchSurface)', () => {
    const data: SurfaceSpec = { id: 's1', kind: 'preview', url: 'http://localhost:5173' };
    renderSlot(data);
    expect(screen.getByTestId('stub-preview-node')).toBeInTheDocument();
    expect(screen.queryByTestId('search-node-s1')).not.toBeInTheDocument();
  });
});
