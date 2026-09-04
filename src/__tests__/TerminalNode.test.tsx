/**
 * TerminalNode.test.tsx — R7 (living surfaces). Mocks the real `TerminalView`
 * component (same convention TerminalView.test.tsx already establishes for
 * @xterm/xterm itself — a real xterm canvas needs a real browser backend
 * jsdom doesn't provide) so this test only has to prove what THIS node wires:
 * cwd passed through, close/collapse affordances, nodrag on the terminal
 * body, and the NodeResizer -> canvasStore.updateSurface wiring. `NodeResizer`
 * (an @xyflow/react library component) is stubbed to a prop-capturing no-op —
 * this test verifies OUR contract with it (the props we pass), not xyflow's
 * own drag-resize implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import type { SurfaceSpec } from '../components/agents/canvas/canvasTypes';
import { getTerminalActivity, resetTerminalActivityForTests } from '../lib/agents/terminalActivity';

// Fix 2 (idle-terminal auto-close) — the mocked TerminalView below captures
// its `onActivity` prop so tests can fire it directly, standing in for a
// real PTY data chunk (a real xterm/PTY needs a real browser backend jsdom
// doesn't provide — same reasoning this file's own header already gives for
// mocking TerminalView wholesale).
let capturedOnActivity: ((bytes: number) => void) | undefined;

vi.mock('../components/terminal/TerminalView', () => ({
  TerminalView: ({ cwd, onActivity }: { cwd?: string; onActivity?: (bytes: number) => void }) => {
    capturedOnActivity = onActivity;
    return <div data-testid="mock-terminal-view">{cwd ?? 'no-cwd'}</div>;
  },
}));

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

// Imported AFTER the mocks above (both are hoisted by vitest regardless of
// import order, but keeping the mocks visually first matches this repo's
// existing convention — see TerminalView.test.tsx).
import { TerminalNodeCard } from '../components/agents/canvas/nodes/TerminalNode';

// fix/canvas-legibility — `selected` defaults to `true` here: TerminalNodeCard
// now has an idle-repli tier (LivingPaneCompactCard.test.tsx covers it) that
// collapses an inactive terminal even at full zoom, and this mocked
// TerminalView never calls `onActivity` — every pre-existing test in this
// file asserts on the FULL header/body, so `selected=true` forces that
// tier regardless of idle state (selected always wins — see
// TerminalNode.tsx's own `showFull` doc comment), preserving this file's
// original intent unchanged.
function renderCard(data: SurfaceSpec, selected = true) {
  return render(
    <I18nProvider>
      <TerminalNodeCard data={data} selected={selected} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  resetTerminalActivityForTests();
  capturedResizerProps = null;
  capturedOnActivity = undefined;
});

describe('TerminalNodeCard', () => {
  it('mounts the REAL TerminalView with the surface cwd, inside a nodrag body', () => {
    renderCard({ id: 't1', kind: 'terminal', cwd: '/repo/worktree-a' });

    const mounted = screen.getByTestId('mock-terminal-view');
    expect(mounted).toHaveTextContent('/repo/worktree-a');
    expect(mounted.parentElement).toHaveClass('nodrag');
  });

  it('renders an honest "no directory" label when the surface has no cwd', () => {
    renderCard({ id: 't1', kind: 'terminal' });
    expect(screen.getByTestId('terminal-node-cwd')).toHaveTextContent(/directory|répertoire/i);
  });

  // W-CARDS — a Windows verbatim (`\\?\...`) cwd must never render as its
  // raw, truncated self in the node's visible title (the literal "terminal
  // nodes titled with raw truncated \\?\C:\Users\... paths" bug): the
  // header shows a short basename, while the full (verbatim-stripped) path
  // is still available as the native tooltip.
  it('shows a short basename for a Windows verbatim cwd — never the raw \\\\?\\ path — with the full path as tooltip', () => {
    renderCard({ id: 't1', kind: 'terminal', cwd: '\\\\?\\C:\\Users\\david\\worktrees\\cards' });
    const cwdEl = screen.getByTestId('terminal-node-cwd');
    expect(cwdEl).toHaveTextContent('cards');
    expect(cwdEl.textContent).not.toContain('\\\\?\\');
    expect(cwdEl.getAttribute('title')).toBe('C:\\Users\\david\\worktrees\\cards');
  });

  it('close button removes the surface from canvasStore', () => {
    canvasStoreVanilla.getState().addSurface({ id: 't1', kind: 'terminal', cwd: '/repo' });
    renderCard({ id: 't1', kind: 'terminal', cwd: '/repo' });

    fireEvent.click(screen.getByTestId('terminal-node-close-t1'));

    expect(canvasStoreVanilla.getState().surfaces.find((s) => s.id === 't1')).toBeUndefined();
  });

  // fix/canvas-legibility — the terminal view now stays MOUNTED at all
  // times (only its wrapper's CSS display toggles) — a real fix for the
  // module's own pre-existing doc comment ("the PTY keeps running
  // underneath ... never unmounted"), which this collapse toggle used to
  // silently violate (conditional-render unmount, killing the PTY on every
  // collapse).
  it('collapse hides the terminal body via display:none WITHOUT unmounting it (the PTY session is never torn down by collapsing)', () => {
    renderCard({ id: 't1', kind: 'terminal', cwd: '/repo' });
    const mounted = screen.getByTestId('mock-terminal-view');
    expect(mounted).toBeInTheDocument();
    expect((mounted.parentElement as HTMLElement).style.display).not.toBe('none');

    fireEvent.click(screen.getByTestId('terminal-node-collapse-t1'));

    // Still in the DOM (never unmounted) — only visually hidden.
    expect(screen.getByTestId('mock-terminal-view')).toBeInTheDocument();
    expect((screen.getByTestId('mock-terminal-view').parentElement as HTMLElement).style.display).toBe('none');
    expect(screen.getByTestId('terminal-node-header-t1')).toBeInTheDocument(); // header (and the surface itself) stays mounted
  });

  it('passes NodeResizer a sane min size, and its onResizeEnd persists the new size via updateSurface', () => {
    canvasStoreVanilla.getState().addSurface({ id: 't1', kind: 'terminal' });
    renderCard({ id: 't1', kind: 'terminal' }, true);

    expect(capturedResizerProps?.minWidth).toBeGreaterThan(0);
    expect(capturedResizerProps?.minHeight).toBeGreaterThan(0);

    capturedResizerProps?.onResizeEnd?.(null, { x: 0, y: 0, width: 700, height: 480 });

    const surface = canvasStoreVanilla.getState().surfaces.find((s) => s.id === 't1');
    expect(surface?.width).toBe(700);
    expect(surface?.height).toBe(480);
  });

  // W-CARDS (founder, 2026-07-21) — `showFull` used to ALSO require
  // `zoomLevel === 'full'` (see TerminalNode.tsx's own header): a selected
  // terminal could still get swapped for the compact repli purely by
  // zooming out. Now content-driven only (`selected` / idle activity);
  // `zoomLevel` is still accepted on the prop type for call-site
  // compatibility but no longer read — this proves no zoom subscription
  // remains by rendering identically at the old bucket extremes.
  it('renders identically whether zoomLevel is "chip" or "full" (selected forces the full terminal either way)', () => {
    const { container: chipContainer, unmount } = render(
      <I18nProvider>
        <TerminalNodeCard data={{ id: 't1', kind: 'terminal', cwd: '/repo/worktree-a' }} selected zoomLevel="chip" />
      </I18nProvider>,
    );
    const chipHtml = chipContainer.innerHTML;
    unmount();

    const { container: fullContainer } = render(
      <I18nProvider>
        <TerminalNodeCard data={{ id: 't1', kind: 'terminal', cwd: '/repo/worktree-a' }} selected zoomLevel="full" />
      </I18nProvider>,
    );
    expect(fullContainer.innerHTML).toBe(chipHtml);
  });

  // ── Fix 2 (idle-terminal auto-close) — activity/focus feed fleetHygiene.ts's
  // rule (h) via agentsStore.tsx's sweep; terminalActivity.ts's own tests
  // cover the registry itself, these prove THIS node actually writes to it. ──

  describe('terminalActivity wiring (Fix 2)', () => {
    it('records real PTY output via onActivity into the shared activity registry', () => {
      renderCard({ id: 't1', kind: 'terminal', cwd: '/repo' });
      expect(getTerminalActivity('t1').lastOutputAtMs).toBeUndefined();

      act(() => { capturedOnActivity?.(42); });

      expect(getTerminalActivity('t1').lastOutputAtMs).toBeTypeOf('number');
    });

    it('records focus when selected, but not while unselected', () => {
      renderCard({ id: 't1', kind: 'terminal', cwd: '/repo' }, false);
      expect(getTerminalActivity('t1').lastFocusedAtMs).toBeUndefined();
    });

    it('records focus when the node renders as selected', () => {
      renderCard({ id: 't1', kind: 'terminal', cwd: '/repo' }, true);
      expect(getTerminalActivity('t1').lastFocusedAtMs).toBeTypeOf('number');
    });

    it('close button also clears the tracked activity (removeSurface is the single choke point)', () => {
      canvasStoreVanilla.getState().addSurface({ id: 't1', kind: 'terminal', cwd: '/repo' });
      renderCard({ id: 't1', kind: 'terminal', cwd: '/repo' });
      act(() => { capturedOnActivity?.(10); });
      expect(getTerminalActivity('t1').lastOutputAtMs).toBeTypeOf('number');

      fireEvent.click(screen.getByTestId('terminal-node-close-t1'));

      expect(getTerminalActivity('t1')).toEqual({ lastOutputAtMs: undefined, lastFocusedAtMs: undefined });
    });
  });
});
