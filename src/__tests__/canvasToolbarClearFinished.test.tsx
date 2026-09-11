/**
 * canvasToolbarClearFinished.test.tsx — W-CLEAR-FINISHED: the canvas-wide
 * "Nettoyer les terminées" toolbar button (CanvasToolbar.tsx). Recon finding:
 * the pre-existing "Archiver les terminées" only ever lived per-zone
 * (CanvasContextMenu.tsx's `projectEntries`), so a mission sitting in a
 * COLLAPSED zone or a project the canvas doesn't have open could never be
 * bulk-archived. This button reads `agentsStore.missions` directly (the
 * FULL fleet, never scoped to one zone's currently-rendered node list) and
 * calls the SAME `archiveTerminalMissions` primitive the per-zone action
 * uses — mocked here (same technique as canvasGatePopover.test.tsx) so this
 * suite can seed arbitrary missions without going through a real mission
 * launch.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { I18nProvider } from '../i18n';
import { CanvasToolbar } from '../components/agents/canvas/CanvasToolbar';
import type { Mission } from '../lib/agents/types';

const archiveTerminalMissionsSpy = vi.fn();
let mockMissions: Mission[] = [];

vi.mock('../components/agents/agentsStore', () => ({
  useAgentsStoreOptional: () => ({
    missions: mockMissions,
    archiveTerminalMissions: archiveTerminalMissionsSpy,
    changeApprovalMode: vi.fn(),
  }),
  useAgentsStoreMissionsOptional: () => mockMissions,
  useAgentsStoreActionsOptional: () => ({
    archiveTerminalMissions: archiveTerminalMissionsSpy,
    changeApprovalMode: vi.fn(),
  }),
}));

function mission(overrides: Partial<Mission> & { id: string }): Mission {
  return { title: overrides.id, status: 'running', model: 'sonnet', archived: false, ...overrides };
}

afterEach(() => {
  cleanup();
  archiveTerminalMissionsSpy.mockClear();
  mockMissions = [];
});

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
      <ReactFlowProvider>
        <CanvasToolbar {...baseProps()} />
      </ReactFlowProvider>
    </I18nProvider>,
  );
}

describe('CanvasToolbar — clear finished (W-CLEAR-FINISHED)', () => {
  it('is disabled when there is nothing terminal to clear', () => {
    mockMissions = [mission({ id: 'm1', status: 'running' })];
    renderToolbar();
    expect(screen.getByTestId('canvas-toolbar-clear-finished')).toBeDisabled();
  });

  it('is enabled once at least one terminal, non-archived mission exists', () => {
    mockMissions = [mission({ id: 'm1', status: 'done' })];
    renderToolbar();
    expect(screen.getByTestId('canvas-toolbar-clear-finished')).not.toBeDisabled();
  });

  it('clicking archives every terminal mission ACROSS EVERY project/zone in one call', () => {
    mockMissions = [
      mission({ id: 'p1-done', status: 'done' }),
      mission({ id: 'p1-running', status: 'running' }),
      // A mission belonging to a DIFFERENT / currently-unopened project zone —
      // the per-zone "Archiver les terminées" action can never reach this one
      // (it only ever sees the zone's own currently-rendered nodes); this
      // button must still reach it since it reads the full fleet directly.
      mission({ id: 'p2-failed', status: 'failed' }),
      mission({ id: 'p2-cancelled', status: 'cancelled' }),
      // Already archived — must NOT be re-submitted.
      mission({ id: 'already-archived', status: 'done', archived: true }),
    ];
    renderToolbar();

    fireEvent.click(screen.getByTestId('canvas-toolbar-clear-finished'));

    expect(archiveTerminalMissionsSpy).toHaveBeenCalledTimes(1);
    const idsPassed = archiveTerminalMissionsSpy.mock.calls[0][0] as string[];
    expect(new Set(idsPassed)).toEqual(new Set(['p1-done', 'p2-failed', 'p2-cancelled']));
  });

  it('the tooltip reflects the terminal count', () => {
    mockMissions = [mission({ id: 'm1', status: 'done' }), mission({ id: 'm2', status: 'failed' })];
    renderToolbar();
    const title = screen.getByTestId('canvas-toolbar-clear-finished').getAttribute('title');
    expect(title).toContain('2');
  });
});
