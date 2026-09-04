/**
 * canvasHoverActions.test.tsx — W8a deliverable #1: hover quick-action
 * strips on mission/loop/draft cards, wired exclusively to real
 * CanvasActionsContext handlers (plus the two pre-existing primitives the
 * context never carried: agentsStore stopMission — omitted without a
 * provider — and canvasStore removeDraft). Also covers the W8a fold/expand
 * chevrons' store wiring. W-CARDS: the mission card's hover strip (and its
 * expand chevron) is no longer zoom-gated at all — see MissionNode.tsx's
 * own header for why the old dot/chip/compact tiers were retired.
 */

import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { I18nProvider } from '../i18n';
import type { FleetMission } from '../lib/agents/fleetMissions';
import type { DraftSpec, LoopNodeData, MissionNodeData } from '../components/agents/canvas/canvasTypes';
import { MissionNodeCard } from '../components/agents/canvas/nodes/MissionNode';
import { LoopNodeCard } from '../components/agents/canvas/nodes/LoopNode';
import { DraftNodeCard } from '../components/agents/canvas/nodes/DraftNode';
import { IterationNodeCard } from '../components/agents/canvas/nodes/IterationNode';
import {
  CanvasActionsProvider,
  DEFAULT_CANVAS_ACTIONS,
  type CanvasActionsValue,
} from '../components/agents/canvas/chrome/CanvasActionsContext';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';

function makeMission(overrides: Partial<FleetMission> = {}): FleetMission {
  return { id: 'm1', title: 'Fix login bug', status: 'running', stage: 'code', model: 'sonnet-4.6', updatedMs: 1, urgent: false, ...overrides };
}

function makeMissionData(overrides: Partial<MissionNodeData> = {}, missionOverrides: Partial<FleetMission> = {}): MissionNodeData {
  return { mission: makeMission(missionOverrides), projectId: 'p1', isActiveProject: true, ...overrides };
}

function makeLoopData(missionOverrides: Partial<FleetMission> = {}, enabled = true): LoopNodeData {
  return {
    mission: makeMission({ id: 'l1', title: 'Watcher', ...missionOverrides }),
    projectId: 'p1',
    isActiveProject: true,
    loopConfig: { cadence: '5m', stopCondition: { kind: 'manual' }, enabled, iterationCount: 3, iterationMissionIds: [] },
    recentIterations: [{ id: 'it1', status: 'done', iteration: 3 }],
  };
}

const DRAFT: DraftSpec = { id: 'd1', title: 'Draft', task: 'do x', createdBy: 'user' };

function withActions(children: ReactNode, actions: Partial<CanvasActionsValue> = {}) {
  return (
    <I18nProvider>
      <CanvasActionsProvider value={{ ...DEFAULT_CANVAS_ACTIONS, ...actions }}>{children}</CanvasActionsProvider>
    </I18nProvider>
  );
}

beforeEach(() => {
  _resetCanvasStoreForTests();
});

describe('MissionNodeCard — hover quick-actions (W8a)', () => {
  it('compact zoom: shows Ouvrir + Logs wired to real handlers; retry replaces stop for a failed mission', () => {
    const onOpenMission = vi.fn();
    const onUrgentAction = vi.fn();
    const data = makeMissionData({}, { status: 'failed' });
    render(withActions(<MissionNodeCard data={data} zoomLevel="compact" />, { onOpenMission, onUrgentAction }));

    fireEvent.click(screen.getByTestId('hover-action-open'));
    expect(onOpenMission).toHaveBeenCalledWith('m1');
    fireEvent.click(screen.getByTestId('hover-action-logs'));
    expect(onUrgentAction).toHaveBeenCalledWith(data.mission, 'logs');
    fireEvent.click(screen.getByTestId('hover-action-retry'));
    expect(onUrgentAction).toHaveBeenCalledWith(data.mission, 'retry');
    expect(screen.queryByTestId('hover-action-stop')).not.toBeInTheDocument();
  });

  it('running mission outside an AgentsStoreProvider: Stop is omitted (honest degradation), never a dead button', () => {
    render(withActions(<MissionNodeCard data={makeMissionData()} zoomLevel="full" />));
    expect(screen.getByTestId('hover-action-open')).toBeInTheDocument();
    expect(screen.queryByTestId('hover-action-stop')).not.toBeInTheDocument();
  });

  // W-CARDS — the hover strip is no longer zoom-gated: the card is always
  // its one full layout, so the strip is always present too.
  it('chip zoom: the hover strip is present (one constant card, no more chip-tier summary)', () => {
    render(withActions(<MissionNodeCard data={makeMissionData()} zoomLevel="chip" />));
    expect(screen.getByTestId('hover-action-open')).toBeInTheDocument();
  });

  it('hover buttons stop pointerdown propagation (must not start a node drag)', () => {
    render(withActions(<MissionNodeCard data={makeMissionData()} zoomLevel="full" />));
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    const stopSpy = vi.spyOn(event, 'stopPropagation');
    screen.getByTestId('hover-action-open').dispatchEvent(event);
    expect(stopSpy).toHaveBeenCalled();
  });
});

describe('MissionNodeCard — expand chevron folded into the hover strip, no corner collision (R11)', () => {
  // R10 dogfood follow-up (_e2e-r10-followup.mjs's `clickNodeButtonDiag`):
  // the "agrandir" chevron used to be a SEPARATE header-row button at the
  // card's top-right, the exact corner nodeChrome.tsx's `NodeCard` also
  // absolutely-positions the fading-in hover-actions strip over (z-index 2)
  // — on hover, the strip painted OVER the chevron, making it unclickable
  // at exactly the moment (hover) it was supposed to be reachable. Fixed by
  // folding "expand" INTO the strip as its first action (MissionNode.tsx's
  // own header) — this proves both halves of the fix: one coherent DOM
  // container (no second, independently-positioned element to collide with)
  // and genuine clickability of both the expand action and every other
  // hover action alongside it.
  it('at full zoom, the expand chevron and the other hover actions share ONE strip — both are clickable, nothing occludes the other', () => {
    const onOpenMission = vi.fn();
    // Clicking the expand action re-renders into MissionNodeCard's expanded
    // branch, which mounts a real `<NodeResizer>` (@xyflow/react) — that
    // needs a real ReactFlowProvider ancestor, unlike every other case in
    // this file (which never triggers the expand transition).
    render(<ReactFlowProvider>{withActions(<MissionNodeCard data={makeMissionData()} zoomLevel="full" />, { onOpenMission })}</ReactFlowProvider>);

    const strip = screen.getByRole('group', { name: /actions/i });
    const expandBtn = screen.getByTestId('mission-node-expand-m1');
    const openBtn = screen.getByTestId('hover-action-open');

    // One coherent corner: both actions are DOM siblings inside the SAME
    // strip container — no separate absolutely-positioned header button
    // left behind to fight it for the same pixels.
    expect(strip).toContainElement(expandBtn);
    expect(strip).toContainElement(openBtn);
    // "as its first action" (task instruction) — expand leads the strip.
    expect(strip.firstElementChild).toBe(expandBtn);

    // Both are genuinely clickable — the actual point of the fix, not just
    // "present in the DOM". `open` first: expanding the panel replaces the
    // WHOLE card (MissionNodeCard's own doc comment — "takes over the
    // WHOLE render") so the strip captured above is torn down once expand
    // fires; clicking `open` afterward would just be clicking a detached
    // node.
    fireEvent.click(openBtn);
    expect(onOpenMission).toHaveBeenCalledWith('m1');
    fireEvent.click(expandBtn);
    expect(canvasStoreVanilla.getState().expandedPanels['mission:m1']).toBeDefined();
  });

  // W-CARDS — one constant card, no more compact/chip summary tier to
  // reserve the expand chevron away from.
  it('the expand chevron is present at every zoom (compact/chip included — one constant card)', () => {
    const { rerender } = render(withActions(<MissionNodeCard data={makeMissionData()} zoomLevel="compact" />));
    expect(screen.getByTestId('mission-node-expand-m1')).toBeInTheDocument();
    rerender(withActions(<MissionNodeCard data={makeMissionData()} zoomLevel="chip" />));
    expect(screen.getByTestId('mission-node-expand-m1')).toBeInTheDocument();
  });
});

describe('MissionNodeCard — orchestrator fold chevron + badge (W8a)', () => {
  it('renders the chevron only for orchestrators, toggles canvasStore, and shows the folded badge with worst-status dot', () => {
    const plain = makeMissionData();
    const { unmount } = render(withActions(<MissionNodeCard data={plain} zoomLevel="full" />));
    expect(screen.queryByTestId('mission-node-fold-m1')).not.toBeInTheDocument();
    unmount();

    const orchestrator = makeMissionData({ subMissionCount: 3, worstSubMissionStatus: 'failed' });
    render(withActions(<MissionNodeCard data={orchestrator} zoomLevel="full" />));
    expect(screen.queryByTestId('mission-node-fold-badge-m1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mission-node-fold-m1'));
    expect(canvasStoreVanilla.getState().prefs.foldedOrchestrators?.m1).toBe(true);
    const badge = screen.getByTestId('mission-node-fold-badge-m1');
    expect(badge).toHaveTextContent('3');
    expect(screen.getByTestId('mission-node-fold-badge-dot')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mission-node-fold-m1'));
    expect(canvasStoreVanilla.getState().prefs.foldedOrchestrators?.m1).toBe(false);
    expect(screen.queryByTestId('mission-node-fold-badge-m1')).not.toBeInTheDocument();
  });
});

describe('LoopNodeCard — hover quick-actions + expand chevron (W8a)', () => {
  it('enabled loop: Ouvrir + Pause + Passer la prochaine, all through context handlers', () => {
    const onOpenMission = vi.fn();
    const onToggleLoop = vi.fn();
    const onSkipLoopNextRun = vi.fn();
    render(
      withActions(<LoopNodeCard data={makeLoopData()} nowMs={0} zoomLevel="compact" />, {
        onOpenMission,
        onToggleLoop,
        onSkipLoopNextRun,
      }),
    );

    fireEvent.click(screen.getByTestId('hover-action-open'));
    expect(onOpenMission).toHaveBeenCalledWith('l1');
    fireEvent.click(screen.getByTestId('hover-action-pause'));
    expect(onToggleLoop).toHaveBeenCalledWith('l1', false);
    fireEvent.click(screen.getByTestId('hover-action-skip'));
    expect(onSkipLoopNextRun).toHaveBeenCalledWith('l1');
  });

  it('disabled loop: Pause becomes Reprendre (resume) and re-enables through the same handler', () => {
    const onToggleLoop = vi.fn();
    render(withActions(<LoopNodeCard data={makeLoopData({}, false)} nowMs={0} zoomLevel="full" />, { onToggleLoop }));
    expect(screen.queryByTestId('hover-action-pause')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('hover-action-resume'));
    expect(onToggleLoop).toHaveBeenCalledWith('l1', true);
  });

  it('expand chevron toggles canvasStore prefs.expandedLoops', () => {
    render(withActions(<LoopNodeCard data={makeLoopData()} nowMs={0} zoomLevel="full" />));
    const chevron = screen.getByTestId('loop-node-expand-l1');
    expect(chevron).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chevron);
    expect(canvasStoreVanilla.getState().prefs.expandedLoops?.l1).toBe(true);
    expect(screen.getByTestId('loop-node-expand-l1')).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('DraftNodeCard — hover quick-actions (W8a)', () => {
  it('Lancer/Éditer go through context handlers; Supprimer removes the draft via canvasStore', () => {
    canvasStoreVanilla.getState().addDraft(DRAFT);
    const onLaunchDraft = vi.fn();
    const onEditDraft = vi.fn();
    render(withActions(<DraftNodeCard data={DRAFT} zoomLevel="compact" />, { onLaunchDraft, onEditDraft }));

    fireEvent.click(screen.getByTestId('hover-action-launch'));
    expect(onLaunchDraft).toHaveBeenCalledWith('d1');
    fireEvent.click(screen.getByTestId('hover-action-edit'));
    expect(onEditDraft).toHaveBeenCalledWith('d1');
    fireEvent.click(screen.getByTestId('hover-action-delete'));
    expect(canvasStoreVanilla.getState().drafts).toHaveLength(0);
  });
});

describe('IterationNodeCard — read-only mini card (W8a)', () => {
  it('renders status dot + title + number and opens the iteration mission on click', () => {
    const onOpenIteration = vi.fn();
    render(
      withActions(
        <IterationNodeCard data={{ missionId: 'it1', title: 'Iter one', status: 'failed', iteration: 7, loopMissionId: 'l1' }} />,
        { onOpenIteration },
      ),
    );
    expect(screen.getByTestId('iteration-node-title')).toHaveTextContent('Iter one');
    expect(screen.getByTestId('iteration-node-number')).toHaveTextContent('#7');
    fireEvent.click(screen.getByTestId('iteration-node-it1'));
    expect(onOpenIteration).toHaveBeenCalledWith('it1');
  });
});
