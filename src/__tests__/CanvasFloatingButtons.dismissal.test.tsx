/**
 * CanvasFloatingButtons.dismissal.test.tsx — audit coverage for the canvas
 * floating buttons (Agent Library / MCP Servers), the other surface named
 * in the founder bug fix alongside the cockpit rail popovers.
 *
 * These two popups already carried a full-bleed backdrop at a higher
 * z-index than their own toggle buttons, which in a real browser makes the
 * close-then-reopen race unreachable (a re-click never even reaches the
 * button — the backdrop intercepts it first, closing the popup). This
 * suite proves all three affordances now go through the shared
 * useDismissable hook (consolidated, see CanvasFloatingButtons.tsx's header
 * comment) with no regression: open on click, close on re-click, close on
 * outside click, close on Escape.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { CanvasFloatingButtons } from '../components/agents/canvas/CanvasFloatingButtons';

function renderButtons() {
  return render(
    <I18nProvider>
      <CanvasFloatingButtons onRunAgent={() => {}} />
    </I18nProvider>,
  );
}

describe('CanvasFloatingButtons — Agent Library popup dismissal', () => {
  it('opens on click', () => {
    renderButtons();
    fireEvent.click(screen.getByTestId('canvas-floating-library'));
    expect(screen.getByTestId('canvas-library-popup')).toBeInTheDocument();
  });

  it('re-clicking the same button while open closes it (does not reopen)', () => {
    renderButtons();
    const btn = screen.getByTestId('canvas-floating-library');

    fireEvent.click(btn);
    expect(screen.getByTestId('canvas-library-popup')).toBeInTheDocument();

    fireEvent.pointerDown(btn);
    fireEvent.click(btn);

    expect(screen.queryByTestId('canvas-library-popup')).not.toBeInTheDocument();
  });

  it('clicking outside closes it', () => {
    renderButtons();
    fireEvent.click(screen.getByTestId('canvas-floating-library'));
    expect(screen.getByTestId('canvas-library-popup')).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByTestId('canvas-library-popup')).not.toBeInTheDocument();
  });

  it('pressing Escape closes it', () => {
    renderButtons();
    fireEvent.click(screen.getByTestId('canvas-floating-library'));
    expect(screen.getByTestId('canvas-library-popup')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByTestId('canvas-library-popup')).not.toBeInTheDocument();
  });
});

describe('CanvasFloatingButtons — MCP Servers popup dismissal', () => {
  it('opens on click and closes on re-click', () => {
    renderButtons();
    const btn = screen.getByTestId('canvas-floating-mcp');

    fireEvent.click(btn);
    expect(screen.getByTestId('canvas-mcp-popup')).toBeInTheDocument();

    fireEvent.pointerDown(btn);
    fireEvent.click(btn);

    expect(screen.queryByTestId('canvas-mcp-popup')).not.toBeInTheDocument();
  });

  it('opening MCP while Library is open closes Library', () => {
    renderButtons();
    fireEvent.click(screen.getByTestId('canvas-floating-library'));
    expect(screen.getByTestId('canvas-library-popup')).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByTestId('canvas-floating-mcp'));
    fireEvent.click(screen.getByTestId('canvas-floating-mcp'));

    expect(screen.queryByTestId('canvas-library-popup')).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas-mcp-popup')).toBeInTheDocument();
  });
});
