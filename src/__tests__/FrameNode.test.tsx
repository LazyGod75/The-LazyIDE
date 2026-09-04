/**
 * FrameNode.test.tsx — W-CLOSE row 2 (canvas scorecard "n8n Canvas Groups"
 * parity gap). `NodeResizer` is stubbed to a prop-capturing no-op, same
 * convention TerminalNode.test.tsx already establishes (this proves OUR
 * contract with it, not xyflow's own drag-resize implementation).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import type { FrameSpec } from '../components/agents/canvas/canvasTypes';

interface CapturedResizerProps {
  isVisible?: boolean;
  minWidth?: number;
  minHeight?: number;
  onResizeEnd?: (event: unknown, params: { x: number; y: number; width: number; height: number }) => void;
}
let capturedResizerProps: CapturedResizerProps | null = null;

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    NodeResizer: (props: CapturedResizerProps) => {
      capturedResizerProps = props;
      return null;
    },
  };
});

import { FrameNodeCard } from '../components/agents/canvas/nodes/FrameNode';

function renderCard(data: FrameSpec, selected = false) {
  return render(
    <I18nProvider>
      <FrameNodeCard data={data} selected={selected} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  capturedResizerProps = null;
});

describe('FrameNodeCard', () => {
  it('renders the title and the given dimensions', () => {
    renderCard({ id: 'f1', title: 'Onboarding flow', width: 400, height: 300 });
    expect(screen.getByTestId('frame-node-title-f1')).toHaveTextContent('Onboarding flow');
    const card = screen.getByTestId('frame-node-f1');
    expect(card).toHaveStyle({ width: '400px', height: '300px' });
  });

  it('falls back to the default footprint when width/height are absent', () => {
    renderCard({ id: 'f1', title: 'Group' } as FrameSpec);
    const card = screen.getByTestId('frame-node-f1');
    expect(card).toHaveStyle({ width: '360px', height: '240px' }); // DEFAULT_FRAME_SIZE
  });

  it('double-clicking the title opens an inline rename input pre-filled with the current title', () => {
    renderCard({ id: 'f1', title: 'Group A', width: 300, height: 200 });
    fireEvent.doubleClick(screen.getByTestId('frame-node-title-f1').parentElement!);
    const input = screen.getByTestId('frame-node-title-input-f1') as HTMLInputElement;
    expect(input.value).toBe('Group A');
  });

  it('Enter commits the renamed title via canvasStore.updateFrame', () => {
    canvasStoreVanilla.getState().addFrame({ id: 'f1', title: 'Group A', width: 300, height: 200 });
    renderCard({ id: 'f1', title: 'Group A', width: 300, height: 200 });

    fireEvent.doubleClick(screen.getByTestId('frame-node-title-f1').parentElement!);
    const input = screen.getByTestId('frame-node-title-input-f1');
    fireEvent.change(input, { target: { value: 'Renamed group' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(canvasStoreVanilla.getState().frames.find((f) => f.id === 'f1')?.title).toBe('Renamed group');
  });

  it('Escape reverts without committing', () => {
    canvasStoreVanilla.getState().addFrame({ id: 'f1', title: 'Group A', width: 300, height: 200 });
    renderCard({ id: 'f1', title: 'Group A', width: 300, height: 200 });

    fireEvent.doubleClick(screen.getByTestId('frame-node-title-f1').parentElement!);
    const input = screen.getByTestId('frame-node-title-input-f1');
    fireEvent.change(input, { target: { value: 'Should not stick' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(canvasStoreVanilla.getState().frames.find((f) => f.id === 'f1')?.title).toBe('Group A');
    expect(screen.queryByTestId('frame-node-title-input-f1')).not.toBeInTheDocument();
  });

  it('remove button removes the frame from canvasStore (never its visually-overlapping siblings)', () => {
    canvasStoreVanilla.getState().addFrame({ id: 'f1', title: 'Group A', width: 300, height: 200 });
    renderCard({ id: 'f1', title: 'Group A', width: 300, height: 200 });

    fireEvent.click(screen.getByTestId('frame-node-remove-f1'));

    expect(canvasStoreVanilla.getState().frames.find((f) => f.id === 'f1')).toBeUndefined();
  });

  it('passes NodeResizer a sane min size, and its onResizeEnd persists the new size via updateFrame', () => {
    canvasStoreVanilla.getState().addFrame({ id: 'f1', title: 'Group A', width: 300, height: 200 });
    renderCard({ id: 'f1', title: 'Group A', width: 300, height: 200 }, true);

    expect(capturedResizerProps?.minWidth).toBeGreaterThan(0);
    expect(capturedResizerProps?.minHeight).toBeGreaterThan(0);
    expect(capturedResizerProps?.isVisible).toBe(true);

    capturedResizerProps?.onResizeEnd?.(null, { x: 0, y: 0, width: 500, height: 350 });

    const frame = canvasStoreVanilla.getState().frames.find((f) => f.id === 'f1');
    expect(frame?.width).toBe(500);
    expect(frame?.height).toBe(350);
  });
});
