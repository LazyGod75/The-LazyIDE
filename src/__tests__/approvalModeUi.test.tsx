/**
 * approvalModeUi.test.tsx — W-MODES-ui: the zone-header badge (per-project
 * override) and the canvas toolbar's "⋯" overflow-menu entry (global
 * default), both driving the REAL engine primitive
 * (agentsStore.tsx's `changeApprovalMode` -> approvalMode.ts's
 * `setApprovalMode`/`getApprovalMode`) landed by W-MODES-engine (8149b84).
 *
 * Covers:
 *  - the zone badge renders per mode (manual/auto_green/full_auto), with a
 *    distinct `data-approval-mode` signal, and is absent when the zone has
 *    no mode at all (the synthetic Transverse zone);
 *  - clicking the zone badge opens the 3-option popover, and picking an
 *    option calls the REAL changeApprovalMode (verified via
 *    approvalMode.ts's own getApprovalMode, never a mocked store);
 *  - the canvas toolbar's overflow-menu "Mode d'approbation par défaut"
 *    entry opens the SAME popover component and changes the GLOBAL default
 *    (no projectId) through the same real primitive.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ReactFlowProvider } from '@xyflow/react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AgentsStoreProvider } from '../components/agents/agentsStore';
import { ProjectGroupNodeCard } from '../components/agents/canvas/nodes/ProjectGroupNode';
import { CanvasToolbar } from '../components/agents/canvas/CanvasToolbar';
import type { ProjectNodeData } from '../components/agents/canvas/canvasTypes';
import { getApprovalMode, _resetApprovalModesForTests } from '../lib/agents/approvalMode';

const mockInvoke = vi.mocked(invoke);

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

beforeEach(() => {
  localStorage.setItem('lazy.locale', 'fr');
  _resetApprovalModesForTests();
  localStorage.removeItem('lazy.agents.approvalModes');
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async () => undefined);
});

afterEach(() => {
  cleanup();
  _resetApprovalModesForTests();
  localStorage.removeItem('lazy.agents.approvalModes');
  localStorage.removeItem('lazy.locale');
});

function makeProjectData(overrides: Partial<ProjectNodeData> = {}): ProjectNodeData {
  return {
    projectId: 'p1',
    root: '/repo/p1',
    name: 'demo-shop',
    color: 'hsl(220 65% 62%)',
    collapsed: false,
    isActive: true,
    counts: { running: 0, urgent: 0, review: 0, failed: 0, done: 0, total: 0 },
    hasChildren: true,
    ...overrides,
  };
}

function renderZone(data: ProjectNodeData) {
  return render(
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>
          <ProjectGroupNodeCard data={data} />
        </AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

describe('ProjectGroupNode — approval-mode zone badge (W-MODES-ui deliverable #1)', () => {
  // Visual sweep #8 — labels now carry an explicit "Merge :" prefix so this
  // badge never reads as the same control as the global autonomy bar
  // (Manuel/Supervisé/Yolo).
  it.each([
    ['manual', 'Merge : manuel'],
    ['auto_green', 'Merge : auto si vert'],
    ['full_auto', 'Merge : full auto'],
  ] as const)('renders the %s badge with the correct label + data-approval-mode signal', (mode, label) => {
    const data = makeProjectData({ approvalMode: mode });
    renderZone(data);
    const badge = screen.getByTestId('project-node-approval-mode-badge');
    expect(badge).toHaveAttribute('data-approval-mode', mode);
    expect(badge).toHaveTextContent(label);
  });

  it('omits the badge entirely when the zone carries no approval mode (e.g. the synthetic Transverse zone)', () => {
    const data = makeProjectData({ approvalMode: undefined });
    renderZone(data);
    expect(screen.queryByTestId('project-node-approval-mode-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-node-approval-mode-badge-trigger')).not.toBeInTheDocument();
  });

  it('clicking the badge opens the popover without also collapsing the zone', () => {
    const data = makeProjectData({ approvalMode: 'manual' });
    renderZone(data);
    fireEvent.click(screen.getByTestId('project-node-approval-mode-badge-trigger'));
    expect(screen.getByTestId('zone-approval-mode-popover')).toBeInTheDocument();
    // The header's own onClick (collapse toggle) must not also have fired.
    expect(screen.getByTestId('project-node-chevron')).toHaveTextContent('▼');
  });

  it('picking an option calls the REAL changeApprovalMode for this project, verified via approvalMode.ts getApprovalMode', async () => {
    const data = makeProjectData({ projectId: 'demo-shop', approvalMode: 'manual' });
    renderZone(data);
    fireEvent.click(screen.getByTestId('project-node-approval-mode-badge-trigger'));
    fireEvent.click(screen.getByTestId('zone-approval-mode-option-full_auto'));

    await waitFor(() => expect(getApprovalMode('demo-shop')).toBe('full_auto'));
    // Never touches the global default or another project.
    expect(getApprovalMode()).toBe('manual');
    expect(getApprovalMode('other-project')).toBe('manual');
    // Popover closes after selection.
    expect(screen.queryByTestId('zone-approval-mode-popover')).not.toBeInTheDocument();
  });

  it('the collapsed pill and the aggregate summary chip render the SAME badge as display-only chrome (no trigger button)', () => {
    const collapsed = makeProjectData({ approvalMode: 'full_auto', collapsed: true });
    const { unmount } = renderZone(collapsed);
    expect(screen.getByTestId('project-node-approval-mode-badge')).toHaveAttribute('data-approval-mode', 'full_auto');
    unmount();

    const aggregate = makeProjectData({ approvalMode: 'full_auto', counts: { running: 1, urgent: 0, review: 0, failed: 0, done: 0, total: 1 } });
    render(
      <I18nProvider>
        <ToastProvider>
          <AgentsStoreProvider>
            <ProjectGroupNodeCard data={aggregate} aggregate />
          </AgentsStoreProvider>
        </ToastProvider>
      </I18nProvider>,
    );
    expect(screen.getByTestId('zone-agg-approval-mode-badge')).toHaveAttribute('data-approval-mode', 'full_auto');
  });
});

describe('CanvasToolbar — global default approval-mode selector (W-MODES-ui deliverable #2)', () => {
  function baseProps() {
    return {
      minimapEnabled: true,
      onToggleMinimap: vi.fn(),
      onOpenLibrary: vi.fn(),
      canUndo: false,
      canRedo: false,
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      snapEnabled: false,
      onToggleSnap: vi.fn(),
      paletteOpen: false,
      onTogglePalette: vi.fn(),
      onRunLayout: vi.fn(),
      onTidyZones: vi.fn(),
      laneModeEnabled: false,
      onToggleLaneMode: vi.fn(),
      hasSelection: false,
      onZoomToSelection: vi.fn(),
      selectedDraftId: null as string | null,
      onLaunchSelectedDraft: vi.fn(),
      searchQuery: '',
      onSearchChange: vi.fn(),
      failureCount: 0,
      onFocusFailures: vi.fn(),
      onOpenShortcuts: vi.fn(),
      hideMergedEnabled: false,
      onToggleHideMerged: vi.fn(),
      wheelMode: 'zoom' as 'zoom' | 'scroll',
      onToggleWheelMode: vi.fn(),
      replayActive: false,
      onToggleReplay: vi.fn(),
      onExportCanvas: vi.fn(),
      onImportCanvasFile: vi.fn(),
      onExportYaml: vi.fn(),
      onImportYamlFile: vi.fn(),
      onGitExport: vi.fn(),
      onExportMcp: vi.fn(),
      followActiveEnabled: false,
      onToggleFollowActive: vi.fn(),
    };
  }

  function renderToolbar() {
    render(
      <I18nProvider>
        <ToastProvider>
          <AgentsStoreProvider>
            <ReactFlowProvider>
              <CanvasToolbar {...baseProps()} />
            </ReactFlowProvider>
          </AgentsStoreProvider>
        </ToastProvider>
      </I18nProvider>,
    );
  }

  it('the overflow menu shows the current global default mode as a badge', async () => {
    renderToolbar();
    // approvalMode.ts loads asynchronously (ensureApprovalModesLoaded) —
    // let that settle before interacting, same convention every other
    // module-singleton-store test in this suite follows.
    await waitFor(() => expect(getApprovalMode()).toBe('manual'));
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    expect(screen.getByTestId('canvas-toolbar-approval-mode-default-badge')).toHaveAttribute('data-approval-mode', 'manual');
  });

  it('opens the 3-option popover and changing selection calls the REAL changeApprovalMode with no projectId (global default)', async () => {
    renderToolbar();
    await waitFor(() => expect(getApprovalMode()).toBe('manual'));
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    fireEvent.click(screen.getByTestId('canvas-toolbar-approval-mode-default'));
    expect(screen.getByTestId('toolbar-approval-mode-popover')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('toolbar-approval-mode-option-auto_green'));
    await waitFor(() => expect(getApprovalMode()).toBe('auto_green'));
    // A project with no explicit override now inherits the new default.
    expect(getApprovalMode('any-project-without-override')).toBe('auto_green');
  });
});
