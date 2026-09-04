/**
 * Tests for CanvasDraftVersionsPanel.tsx — the « Versions » dropdown
 * (draft version history, Activepieces parity). List/select/diff/restore
 * behavior only (relative-time formatting itself is exercised implicitly).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { CanvasDraftVersionsPanel } from '../components/agents/canvas/CanvasDraftVersionsPanel';
import type { DraftVersion } from '../components/agents/canvas/canvasTypes';

function renderPanel(versions: DraftVersion[], onRestore = vi.fn()) {
  render(
    <I18nProvider>
      <CanvasDraftVersionsPanel versions={versions} current={{ title: 'Current title', task: 'current task' }} onRestore={onRestore} />
    </I18nProvider>,
  );
  return { onRestore };
}

describe('CanvasDraftVersionsPanel', () => {
  it('shows the version count on the toggle, and the list only once opened', () => {
    renderPanel([
      { ts: 1000, title: 'v1', task: 't1' },
      { ts: 2000, title: 'v2', task: 't2' },
    ]);

    expect(screen.getByTestId('canvas-quickcreate-versions-toggle')).toHaveTextContent('(2)');
    expect(screen.queryByTestId('canvas-quickcreate-versions-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('canvas-quickcreate-versions-toggle'));
    expect(screen.getByTestId('canvas-quickcreate-versions-panel')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-quickcreate-version-2000')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-quickcreate-version-1000')).toBeInTheDocument();
  });

  it('lists versions newest-first', () => {
    renderPanel([
      { ts: 1000, title: 'oldest', task: 't1' },
      { ts: 2000, title: 'middle', task: 't2' },
      { ts: 3000, title: 'newest', task: 't3' },
    ]);
    fireEvent.click(screen.getByTestId('canvas-quickcreate-versions-toggle'));

    const rows = screen.getAllByTestId(/canvas-quickcreate-version-\d+/);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('newest'),
      expect.stringContaining('middle'),
      expect.stringContaining('oldest'),
    ]);
  });

  it('selecting a version shows a two-pane diff (selected vs current)', () => {
    renderPanel([{ ts: 1000, title: 'Old title', task: 'old task' }]);
    fireEvent.click(screen.getByTestId('canvas-quickcreate-versions-toggle'));
    fireEvent.click(screen.getByTestId('canvas-quickcreate-version-1000'));

    expect(screen.getByTestId('canvas-quickcreate-diff-selected')).toHaveTextContent('Old title');
    expect(screen.getByTestId('canvas-quickcreate-diff-selected')).toHaveTextContent('old task');
    expect(screen.getByTestId('canvas-quickcreate-diff-current')).toHaveTextContent('Current title');
    expect(screen.getByTestId('canvas-quickcreate-diff-current')).toHaveTextContent('current task');
  });

  it('clicking a selected version again deselects it (toggle)', () => {
    renderPanel([{ ts: 1000, title: 'Old title', task: 'old task' }]);
    fireEvent.click(screen.getByTestId('canvas-quickcreate-versions-toggle'));
    fireEvent.click(screen.getByTestId('canvas-quickcreate-version-1000'));
    expect(screen.getByTestId('canvas-quickcreate-diff-selected')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('canvas-quickcreate-version-1000'));
    expect(screen.queryByTestId('canvas-quickcreate-diff-selected')).not.toBeInTheDocument();
  });

  it('Restaurer calls onRestore with the selected version ts, then closes the selection/panel', () => {
    const { onRestore } = renderPanel([{ ts: 1000, title: 'Old title', task: 'old task' }]);
    fireEvent.click(screen.getByTestId('canvas-quickcreate-versions-toggle'));
    fireEvent.click(screen.getByTestId('canvas-quickcreate-version-1000'));

    fireEvent.click(screen.getByTestId('canvas-quickcreate-version-restore'));

    expect(onRestore).toHaveBeenCalledWith(1000);
    expect(screen.queryByTestId('canvas-quickcreate-versions-panel')).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no versions yet', () => {
    renderPanel([]);
    fireEvent.click(screen.getByTestId('canvas-quickcreate-versions-toggle'));
    expect(screen.getByTestId('canvas-quickcreate-versions-panel')).toHaveTextContent(/no earlier version|aucune version/i);
  });
});
