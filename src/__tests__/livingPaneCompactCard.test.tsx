/**
 * livingPaneCompactCard.test.tsx — fix/canvas-legibility: the "living
 * surfaces" repli-compact tier (nodes/LivingPaneCompactCard.tsx), covering
 * both consumers — TerminalNodeCard's idle-byte threshold and
 * PreviewNodeCard's "no URL yet" collapse. QA evidence this replaces:
 * "96%-47%: huge living panes render as near-black rectangles (idle
 * PowerShell prompt, empty browser pane saying 'Aucune adresse'), no
 * mission titles visible, terrible signal/noise."
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import type { SurfaceSpec } from '../components/agents/canvas/canvasTypes';

// ── TerminalNodeCard ────────────────────────────────────────────────────

let capturedOnActivity: ((bytes: number) => void) | undefined;
vi.mock('../components/terminal/TerminalView', () => ({
  TerminalView: ({ cwd, onActivity }: { cwd?: string; onActivity?: (bytes: number) => void }) => {
    capturedOnActivity = onActivity;
    return <div data-testid="mock-terminal-view">{cwd ?? 'no-cwd'}</div>;
  },
}));

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    NodeResizer: () => null,
  };
});

import { TerminalNodeCard } from '../components/agents/canvas/nodes/TerminalNode';
import { PreviewNodeCard } from '../components/agents/canvas/nodes/PreviewNode';

function renderTerminal(data: SurfaceSpec, selected = false) {
  return render(
    <I18nProvider>
      <TerminalNodeCard data={data} selected={selected} zoomLevel="full" />
    </I18nProvider>,
  );
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  capturedOnActivity = undefined;
});

describe('TerminalNodeCard — idle repli (fix/canvas-legibility)', () => {
  it('a fresh terminal (no activity yet) renders the compact living-pane card, not the huge full body', () => {
    renderTerminal({ id: 't1', kind: 'terminal', cwd: '/repo/worktree-a' });
    expect(screen.getByTestId('living-pane-chip-terminal-t1')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-node-header-t1')).not.toBeInTheDocument();
  });

  it('the REAL TerminalView instance stays mounted even while the compact card is showing (PTY never dies)', () => {
    renderTerminal({ id: 't1', kind: 'terminal', cwd: '/repo/worktree-a' });
    expect(screen.getByTestId('mock-terminal-view')).toBeInTheDocument();
  });

  it('crossing the activity threshold switches to the full terminal body', () => {
    renderTerminal({ id: 't1', kind: 'terminal', cwd: '/repo/worktree-a' });
    expect(screen.getByTestId('living-pane-chip-terminal-t1')).toBeInTheDocument();

    act(() => {
      capturedOnActivity?.(500); // above the 300-byte idle threshold
    });

    expect(screen.getByTestId('terminal-node-header-t1')).toBeInTheDocument();
    expect(screen.queryByTestId('living-pane-chip-terminal-t1')).not.toBeInTheDocument();
  });

  it('`selected` always forces the full terminal, even while idle', () => {
    renderTerminal({ id: 't1', kind: 'terminal', cwd: '/repo/worktree-a' }, true);
    expect(screen.getByTestId('terminal-node-header-t1')).toBeInTheDocument();
    expect(screen.queryByTestId('living-pane-chip-terminal-t1')).not.toBeInTheDocument();
  });

  it('a few bytes below the threshold (the initial prompt banner) still reads as idle', () => {
    renderTerminal({ id: 't1', kind: 'terminal', cwd: '/repo/worktree-a' });
    act(() => {
      capturedOnActivity?.(100);
    });
    expect(screen.getByTestId('living-pane-chip-terminal-t1')).toBeInTheDocument();
  });

  // W-CARDS (founder, 2026-07-21) — LivingPaneCompactCard.tsx used to carry
  // a `transform: scale(var(--canvas-lod-mission-chip-scale, 1))` to hold a
  // constant on-screen size at any dezoom (the exact "constant screen-size
  // trickery" the founder's rule bans). Removed: the repli now scales
  // naturally with React Flow's own viewport transform, like any other
  // node — this asserts no `transform` style remains on the compact card.
  it('carries no constant-screen-size transform (scales naturally with the canvas)', () => {
    renderTerminal({ id: 't1', kind: 'terminal', cwd: '/repo/worktree-a' });
    const chip = screen.getByTestId('living-pane-chip-terminal-t1');
    expect(chip.style.transform).toBe('');
  });
});

// ── PreviewNodeCard ──────────────────────────────────────────────────────

function renderPreview(data: SurfaceSpec, selected = false, zoomLevel: 'chip' | 'compact' | 'full' = 'full') {
  return render(
    <I18nProvider>
      <PreviewNodeCard data={data} selected={selected} zoomLevel={zoomLevel} />
    </I18nProvider>,
  );
}

describe('PreviewNodeCard — no-URL repli (fix/canvas-legibility)', () => {
  it('a preview with no URL yet renders the compact living-pane card, not the huge "Aucune adresse" body', () => {
    canvasStoreVanilla.getState().addSurface({ id: 'p1', kind: 'preview' });
    renderPreview({ id: 'p1', kind: 'preview' });
    expect(screen.getByTestId('living-pane-chip-preview-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-node-empty-p1')).not.toBeInTheDocument();
  });

  it('a preview WITH a url renders the full card at full zoom (never collapsed just for having a url)', () => {
    canvasStoreVanilla.getState().addSurface({ id: 'p1', kind: 'preview', url: 'http://localhost:3000' });
    renderPreview({ id: 'p1', kind: 'preview', url: 'http://localhost:3000' });
    expect(screen.queryByTestId('living-pane-chip-preview-p1')).not.toBeInTheDocument();
    expect(screen.getByTestId(`preview-node-url-input-p1`)).toBeInTheDocument();
  });

  it('below full zoom, a preview with a URL still collapses to the compact go-live card', () => {
    canvasStoreVanilla.getState().addSurface({ id: 'p1', kind: 'preview', url: 'http://localhost:3000' });
    renderPreview({ id: 'p1', kind: 'preview', url: 'http://localhost:3000' }, false, 'compact');
    // A preview WITH a url gets the substantial go-live card (url + status +
    // "Voir en direct") at compact tiers, never the anonymous no-url chip —
    // see PreviewNode.tsx's own comment on the repli tiers.
    expect(screen.getByTestId('preview-node-golive-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('living-pane-chip-preview-p1')).not.toBeInTheDocument();
  });
});
