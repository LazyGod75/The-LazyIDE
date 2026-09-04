/**
 * CodeStatusBar.test.tsx
 *
 * 'editor:cursor' bus event branch-in: CodeStatusBar previously had no
 * consumer for cursor line/col at all (its predecessor StatusBar.tsx was
 * removed in an earlier wave, leaving EditorPane.tsx's emission going
 * nowhere). CodeSpace.tsx now subscribes and passes `cursorPosition`
 * through — these tests cover the presentational half of that wiring.
 *
 * Breadcrumb defect follow-up (2026-08-15): a prior version rendered
 * cursorPosition as "X:Y" right next to `totalLines`, which — despite being
 * the document's total line COUNT, not a position — was ALSO labeled
 * "Ln {n}". Two disagreeing "line" readouts sat side by side (e.g.
 * "1:1  Ln 2"). Now there is exactly ONE position readout ("Ln {line}, Col
 * {col}", VS Code's own convention), and `totalLines` gets an unambiguous
 * "{n} lines" label instead.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { CodeStatusBar } from '../components/editor/codespace/CodeStatusBar';

const baseProps = {
  projectName: 'lazy',
  projectColor: '#7C5CFF',
  branchOrWorktree: null,
  language: 'TypeScript',
  totalLines: 240,
  diffStat: null,
};

describe('CodeStatusBar cursor position', () => {
  it('renders nothing for cursor position when null (e.g. no active tab)', () => {
    render(<CodeStatusBar {...baseProps} cursorPosition={null} />);
    expect(screen.queryByText(/^Ln \d+, Col \d+$/)).toBeNull();
  });

  it('renders 1-based "Ln {line}, Col {col}" when a cursor position is provided', () => {
    render(<CodeStatusBar {...baseProps} cursorPosition={{ line: 12, col: 5 }} />);
    expect(screen.getByText('Ln 12, Col 5')).toBeInTheDocument();
  });

  it('never renders two disagreeing line readouts at once', () => {
    render(<CodeStatusBar {...baseProps} cursorPosition={{ line: 1, col: 1 }} />);
    // Exactly one element says "Ln " — the cursor position. totalLines no
    // longer shares that prefix.
    expect(screen.getAllByText(/^Ln /)).toHaveLength(1);
    expect(screen.getByText('Ln 1, Col 1')).toBeInTheDocument();
  });

  it('labels the total line count distinctly from the cursor position', () => {
    render(<CodeStatusBar {...baseProps} cursorPosition={{ line: 1, col: 1 }} />);
    expect(screen.getByText('240 lines')).toBeInTheDocument();
    expect(screen.queryByText('Ln 240')).toBeNull();
  });

  it('singularizes the total line count for a 1-line file', () => {
    render(<CodeStatusBar {...baseProps} totalLines={1} cursorPosition={null} />);
    expect(screen.getByText('1 line')).toBeInTheDocument();
  });
});
