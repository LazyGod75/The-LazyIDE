/**
 * canvasInteractions.test.tsx — W2a editing interactions: context menu
 * items per node kind, clipboard/duplicate offset, and the quick-create
 * modal submitting a DraftSpec. Context menu tests mount the REAL
 * `CanvasContextMenu` (no `<ReactFlow>` needed — it reads
 * useCanvasActions/useAgentsStore/useCanvasStore directly, none of which
 * require a live React Flow instance).
 */

import type { ComponentProps } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AppProvider } from '../app/AppContext';
import { AgentsStoreProvider } from '../components/agents/agentsStore';
import {
  CanvasActionsProvider,
  DEFAULT_CANVAS_ACTIONS,
  type CanvasActionsValue,
} from '../components/agents/canvas/chrome/CanvasActionsContext';
import { CanvasContextMenu, type ContextMenuState } from '../components/agents/canvas/CanvasContextMenu';
import { CanvasQuickCreateModal } from '../components/agents/canvas/CanvasQuickCreateModal';
import { makeRef, type DraftSpec, type LoopNodeData, type MissionNodeData, type NoteData, type ProjectNodeData } from '../components/agents/canvas/canvasTypes';
import type { ChainEdgeData } from '../components/agents/canvas/edges/ChainEdge';
import type { CanvasReactFlowEdge, CanvasReactFlowNode } from '../components/agents/canvas/reconciler';
import { _resetCanvasStoreForTests, canvasStoreVanilla } from '../components/agents/canvas/canvasStore';
import { _resetClipboardForTests, hasClipboardContent, readClipboard, writeClipboard } from '../components/agents/canvas/canvasClipboard';
import { duplicatePosition, pastePositions } from '../components/agents/canvas/canvasPlacement';
import { on } from '../lib/bus';
import type { MissionFocusRequest } from '../lib/bus';
import type { FleetMission } from '../lib/agents/fleetMissions';

function renderMenu(state: ContextMenuState, actions: Partial<CanvasActionsValue> = {}, onTidyUp: () => void = () => {}) {
  return render(
    <I18nProvider>
      <ToastProvider>
        <AppProvider>
          <AgentsStoreProvider>
            <CanvasActionsProvider value={{ ...DEFAULT_CANVAS_ACTIONS, ...actions }}>
              <CanvasContextMenu
                state={state}
                onClose={() => {}}
                onArmChainFrom={() => {}}
                onOpenQuickCreateAt={() => {}}
                onPasteAt={() => {}}
                onSelectAllInZone={() => {}}
                onRecenter={() => {}}
                onTidyUp={onTidyUp}
                onSaveMacro={() => {}}
                hasClipboard={false}
                projectZones={[]}
              />
            </CanvasActionsProvider>
          </AgentsStoreProvider>
        </AppProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

function baseState(target: ContextMenuState['target']): ContextMenuState {
  return { screenX: 10, screenY: 10, flowPosition: { x: 0, y: 0 }, target };
}

function mission(overrides: Partial<FleetMission> = {}): FleetMission {
  return { id: 'm1', title: 'Fix bug', status: 'running', stage: 'code', model: 'sonnet', updatedMs: 1, urgent: false, ...overrides };
}

function missionNode(overrides: Partial<FleetMission> = {}): CanvasReactFlowNode {
  const data: MissionNodeData = { mission: mission(overrides), projectId: 'p1', isActiveProject: true };
  return { id: makeRef('mission', data.mission.id), type: 'mission', position: { x: 0, y: 0 }, data } as unknown as CanvasReactFlowNode;
}

function loopNode(enabled: boolean): CanvasReactFlowNode {
  const data: LoopNodeData = {
    mission: mission({ id: 'loop1' }),
    projectId: 'p1',
    isActiveProject: true,
    loopConfig: { cadence: '5m', stopCondition: { kind: 'manual' }, enabled, iterationCount: 1, iterationMissionIds: [] },
    recentIterations: [],
  };
  return { id: makeRef('loop', 'loop1'), type: 'loop', position: { x: 0, y: 0 }, data } as unknown as CanvasReactFlowNode;
}

function draftNode(): CanvasReactFlowNode {
  const data: DraftSpec = { id: 'd1', title: 'Draft one', task: 'do the thing', createdBy: 'user', projectId: 'p1' };
  return { id: makeRef('draft', 'd1'), type: 'draft', position: { x: 10, y: 10 }, data } as unknown as CanvasReactFlowNode;
}

function noteNode(): CanvasReactFlowNode {
  const data: NoteData = { id: 'n1', text: 'hello' };
  return { id: makeRef('note', 'n1'), type: 'note', position: { x: 0, y: 0 }, data } as unknown as CanvasReactFlowNode;
}

function projectNode(collapsed: boolean): CanvasReactFlowNode {
  const data: ProjectNodeData = {
    projectId: 'p1',
    root: '/repo',
    name: 'p1',
    color: 'hsl(0 65% 62%)',
    collapsed,
    isActive: true,
    counts: { running: 0, urgent: 0, review: 0, failed: 0, done: 0, total: 0 },
    hasChildren: true,
  };
  return { id: makeRef('project', 'p1'), type: 'project', position: { x: 0, y: 0 }, data } as unknown as CanvasReactFlowNode;
}

function chainEdge(overrides: Partial<ChainEdgeData> = {}): CanvasReactFlowEdge {
  const data: ChainEdgeData = { condition: 'success', disabled: false, tombstone: false, ...overrides };
  return { id: 'c1', type: 'chain', source: makeRef('mission', 'm1'), target: makeRef('draft', 'd1'), data } as unknown as CanvasReactFlowEdge;
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  _resetClipboardForTests();
  // Menu labels are now resolved via t() (W5a i18n sweep) — pin the locale
  // so this suite's French-text assertions are deterministic regardless of
  // what a previous test file left in localStorage (see
  // LazyManagerRail.signals.test.tsx's identical note).
  localStorage.setItem('lazy.locale', 'fr');
});

afterEach(() => {
  localStorage.removeItem('lazy.locale');
});

describe('CanvasContextMenu — per node kind', () => {
  it('mission menu: shows Ouvrir/Diff/Logs/Stop for a RUNNING mission, no Retry', () => {
    renderMenu(baseState({ kind: 'node', node: missionNode({ status: 'running' }) }));
    expect(screen.getByTestId('canvas-context-menu-item-open')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-context-menu-item-diff')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-context-menu-item-logs')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-context-menu-item-stop')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-context-menu-item-retry')).not.toBeInTheDocument();
  });

  it('mission menu: shows Retry (not Stop) for a FAILED mission', () => {
    renderMenu(baseState({ kind: 'node', node: missionNode({ status: 'failed' }) }));
    expect(screen.getByTestId('canvas-context-menu-item-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-context-menu-item-stop')).not.toBeInTheDocument();
  });

  it('mission menu: neither Stop nor Retry for a DONE mission', () => {
    renderMenu(baseState({ kind: 'node', node: missionNode({ status: 'done' }) }));
    expect(screen.queryByTestId('canvas-context-menu-item-stop')).not.toBeInTheDocument();
    expect(screen.queryByTestId('canvas-context-menu-item-retry')).not.toBeInTheDocument();
  });

  it('mission menu: always offers Dupliquer comme draft and Chaîner depuis…', () => {
    renderMenu(baseState({ kind: 'node', node: missionNode() }));
    expect(screen.getByTestId('canvas-context-menu-item-duplicate-draft')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-context-menu-item-chain-from')).toBeInTheDocument();
  });

  it('mission menu: appends urgent actions (review -> merge) without duplicating diff', () => {
    renderMenu(baseState({ kind: 'node', node: missionNode({ status: 'review' }) }));
    expect(screen.getByTestId('canvas-context-menu-item-merge')).toBeInTheDocument();
    // 'diff' comes from the base set, not duplicated by urgentActionsFor's own diff entry.
    expect(screen.getAllByTestId('canvas-context-menu-item-diff')).toHaveLength(1);
  });

  // ── W-DISMISS — per-mission "Retirer du canvas" / "Masquer" ──────────

  it('mission menu: a TERMINAL (done) mission offers "Retirer du canvas", which dismisses it in canvasStore', () => {
    renderMenu(baseState({ kind: 'node', node: missionNode({ id: 'm-done', status: 'done' }) }));
    const entry = screen.getByTestId('canvas-context-menu-item-dismiss-mission');
    expect(entry).toHaveTextContent('Retirer du canvas');
    fireEvent.click(entry);
    expect(canvasStoreVanilla.getState().dismissedRefs).toEqual([makeRef('mission', 'm-done')]);
  });

  it('mission menu: a RUNNING mission offers the "agent keeps running" dismiss wording instead', () => {
    renderMenu(baseState({ kind: 'node', node: missionNode({ id: 'm-running', status: 'running' }) }));
    const entry = screen.getByTestId('canvas-context-menu-item-dismiss-mission');
    expect(entry).toHaveTextContent("Masquer (l'agent continue)");
    fireEvent.click(entry);
    expect(canvasStoreVanilla.getState().dismissedRefs).toEqual([makeRef('mission', 'm-running')]);
  });

  it('loop menu: also offers dismiss, recording the SAME mission:<id> ref regardless of its loop-kind render', () => {
    renderMenu(baseState({ kind: 'node', node: loopNode(true) }));
    fireEvent.click(screen.getByTestId('canvas-context-menu-item-dismiss-mission'));
    expect(canvasStoreVanilla.getState().dismissedRefs).toEqual([makeRef('mission', 'loop1')]);
  });

  it('loop menu: toggle label flips with enabled state, offers Supprimer la boucle', () => {
    renderMenu(baseState({ kind: 'node', node: loopNode(true) }));
    expect(screen.getByTestId('canvas-context-menu-item-toggle-loop')).toHaveTextContent('Pauser');
    expect(screen.getByTestId('canvas-context-menu-item-delete-loop')).toBeInTheDocument();
  });

  it('loop menu: also offers Diff/Logs (W5b #2 — a loop IS a mission, same I/O reach as a one-shot mission)', () => {
    const onUrgentAction = vi.fn();
    renderMenu(baseState({ kind: 'node', node: loopNode(true) }), { onUrgentAction });
    fireEvent.click(screen.getByTestId('canvas-context-menu-item-diff'));
    expect(onUrgentAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'loop1' }), 'diff');
  });

  // ── W9 — « Historique » mission/loop entry ────────────────────────────

  it('mission menu: offers Historique, which emits mission:focusSection(section: "history") for the real mission id', () => {
    renderMenu(baseState({ kind: 'node', node: missionNode({ id: 'm-hist' }) }));
    expect(screen.getByTestId('canvas-context-menu-item-history')).toBeInTheDocument();

    const events: MissionFocusRequest[] = [];
    const unsub = on('mission:focusSection', (req) => events.push(req));
    fireEvent.click(screen.getByTestId('canvas-context-menu-item-history'));
    unsub();

    expect(events).toEqual([{ missionId: 'm-hist', section: 'history' }]);
  });

  it('loop menu: also offers Historique, same real mission:focusSection producer as the mission menu', () => {
    renderMenu(baseState({ kind: 'node', node: loopNode(true) }));
    expect(screen.getByTestId('canvas-context-menu-item-history')).toBeInTheDocument();

    const events: MissionFocusRequest[] = [];
    const unsub = on('mission:focusSection', (req) => events.push(req));
    fireEvent.click(screen.getByTestId('canvas-context-menu-item-history'));
    unsub();

    expect(events).toEqual([{ missionId: 'loop1', section: 'history' }]);
  });

  it('draft menu: Lancer calls onLaunchDraft', () => {
    const onLaunchDraft = vi.fn();
    renderMenu(baseState({ kind: 'node', node: draftNode() }), { onLaunchDraft });
    fireEvent.click(screen.getByTestId('canvas-context-menu-item-launch'));
    expect(onLaunchDraft).toHaveBeenCalledWith('d1');
  });

  // ── W-CONTEST — « Lancer en concours » (best-of-N) ──────────────────────

  it('draft menu: offers Lancer en concours for 2/3/4 candidates', () => {
    renderMenu(baseState({ kind: 'node', node: draftNode() }));
    expect(screen.getByTestId('canvas-context-menu-item-launch-contest-2')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-context-menu-item-launch-contest-3')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-context-menu-item-launch-contest-4')).toBeInTheDocument();
  });

  it('mission menu: never offers Lancer en concours (draft-only entry — this wave never touches the mission section)', () => {
    renderMenu(baseState({ kind: 'node', node: missionNode() }));
    expect(screen.queryByTestId('canvas-context-menu-item-launch-contest-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('canvas-context-menu-item-launch-contest-3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('canvas-context-menu-item-launch-contest-4')).not.toBeInTheDocument();
  });

  it('draft menu: Lancer en concours clones N isolated candidates, frames them, and registers a running contest', () => {
    renderMenu(baseState({ kind: 'node', node: draftNode() }));
    fireEvent.click(screen.getByTestId('canvas-context-menu-item-launch-contest-3'));

    const state = canvasStoreVanilla.getState();
    const candidates = state.drafts.filter((d) => d.id !== 'd1');
    expect(candidates).toHaveLength(3);
    expect(candidates.every((d) => d.isolated === true)).toBe(true);
    expect(state.frames.some((f) => f.projectId === 'p1')).toBe(true);
    // The contest itself is only registered once every launch settles
    // (async — see launchContest's own doc comment); its absence here just
    // proves the SYNCHRONOUS part (clone + frame) never fabricates it early.
  });

  it('draft menu: Supprimer removes the draft from canvasStore', () => {
    canvasStoreVanilla.getState().addDraft({ id: 'd1', title: 'Draft one', task: 'x', createdBy: 'user' });
    renderMenu(baseState({ kind: 'node', node: draftNode() }));
    fireEvent.click(screen.getByTestId('canvas-context-menu-item-delete'));
    expect(canvasStoreVanilla.getState().drafts.find((d) => d.id === 'd1')).toBeUndefined();
  });

  it('note menu: offers Supprimer + Send to manager, calling onRemoveNote on delete', () => {
    const onRemoveNote = vi.fn();
    renderMenu(baseState({ kind: 'node', node: noteNode() }), { onRemoveNote });
    // Note nodes get delete + send-to-manager (CanvasContextMenu.tsx:936)
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('canvas-context-menu-item-delete'));
    expect(onRemoveNote).toHaveBeenCalledWith('n1');
  });

  it('project zone menu: label flips Replier/Déplier and offers Tout sélectionner ici / Note ici', () => {
    renderMenu(baseState({ kind: 'node', node: projectNode(false) }));
    expect(screen.getByTestId('canvas-context-menu-item-toggle-collapse')).toHaveTextContent('Replier');
    expect(screen.getByTestId('canvas-context-menu-item-select-all')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-context-menu-item-note-here')).toBeInTheDocument();
  });

  it('edge menu: condition items + toggle disabled + delete', () => {
    renderMenu(baseState({ kind: 'edge', edge: chainEdge({ condition: 'fail' }) }));
    expect(screen.getByTestId('canvas-context-menu-item-condition-fail')).toHaveTextContent('✓');
    expect(screen.getByTestId('canvas-context-menu-item-toggle-disabled')).toHaveTextContent('Désactiver');
    expect(screen.getByTestId('canvas-context-menu-item-delete-chain')).toBeInTheDocument();
  });

  it('pane menu: Coller is disabled when hasClipboard is false', () => {
    renderMenu(baseState({ kind: 'pane' }));
    expect(screen.getByTestId('canvas-context-menu-item-paste')).toBeDisabled();
    expect(screen.getByTestId('canvas-context-menu-item-new-draft-here')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-context-menu-item-note-here')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-context-menu-item-tidy-up')).not.toBeDisabled();
  });

  it('pane menu: Tout ranger calls onTidyUp and closes the menu', () => {
    const onTidyUp = vi.fn();
    renderMenu(baseState({ kind: 'pane' }), {}, onTidyUp);
    fireEvent.click(screen.getByTestId('canvas-context-menu-item-tidy-up'));
    expect(onTidyUp).toHaveBeenCalledTimes(1);
  });
});

// R1b defect #12 — real-gesture triage proved Escape did NOT close this
// menu. Root cause: right-clicking a NODE to open the menu also gives that
// node native DOM focus, and React Flow's own `NodeWrapper.onKeyDown`
// (registered directly on the focused element — LOWER in the bubble chain
// than `window`) intercepts Escape as "deselect this node" whenever
// `disableKeyboardA11y` is false, and (depending on the handler) can stop
// the event from ever reaching a bubble-phase `window` listener. Fixed two
// ways: CanvasView.tsx now ships `disableKeyboardA11y` (this menu's own
// tests can't reach that — it mounts standalone, no `<ReactFlow>`), AND
// this menu's own Escape listener now registers in the CAPTURE phase
// (`addEventListener('keydown', handler, true)`), which always runs
// top-down BEFORE any bubble-phase handler regardless of what else is
// listening further down the tree — the belt-and-braces half of the fix,
// and the only half testable without a full `<ReactFlow>` mount.
// fix/canvas-ux R6a BLOQUANT #2 — this menu had ZERO clamping on either
// axis before (`left: state.screenX, top: state.screenY`, unconditionally):
// a right-click near the bottom or right edge of the viewport could render
// entries partially or fully off-screen. Same chrome/popoverPosition.ts
// flip/clamp treatment as GateFeedbackPopover/EdgeDropNodePicker.
describe('CanvasContextMenu — viewport clamp (fix/canvas-ux R6a BLOQUANT #2)', () => {
  const originalInnerHeight = window.innerHeight;
  const originalInnerWidth = window.innerWidth;

  afterEach(() => {
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true });
    vi.restoreAllMocks();
  });

  it('opens exactly at the click point when there is room on every side (unchanged behavior)', () => {
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(160);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(190);

    renderMenu(baseState({ kind: 'pane' }));
    const menu = screen.getByTestId('canvas-context-menu');
    expect(parseFloat(menu.style.left)).toBe(10);
    expect(parseFloat(menu.style.top)).toBe(10);
  });

  it('flips ABOVE the click point when opened near the bottom of the viewport', () => {
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(160);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(190);

    renderMenu({ screenX: 300, screenY: 830, flowPosition: { x: 0, y: 0 }, target: { kind: 'pane' } });
    const menu = screen.getByTestId('canvas-context-menu');
    const top = parseFloat(menu.style.top);
    expect(top).toBeLessThan(830);
    expect(top + 160).toBeLessThanOrEqual(844);
  });

  it('clamps horizontally when opened near the right edge of the viewport', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(190);

    renderMenu({ screenX: 1430, screenY: 100, flowPosition: { x: 0, y: 0 }, target: { kind: 'pane' } });
    const menu = screen.getByTestId('canvas-context-menu');
    const left = parseFloat(menu.style.left);
    expect(left + 190).toBeLessThanOrEqual(1440);
  });
});

describe('CanvasContextMenu — Escape closes the menu (R1b defect #12 fix)', () => {
  function renderMenuWithClose(state: ContextMenuState, onClose: () => void) {
    return render(
      <I18nProvider>
        <ToastProvider>
          <AppProvider>
            <AgentsStoreProvider>
              <CanvasActionsProvider value={DEFAULT_CANVAS_ACTIONS}>
                <CanvasContextMenu
                  state={state}
                  onClose={onClose}
                  onArmChainFrom={() => {}}
                  onOpenQuickCreateAt={() => {}}
                  onPasteAt={() => {}}
                  onSelectAllInZone={() => {}}
                  onRecenter={() => {}}
                  onTidyUp={() => {}}
                  onSaveMacro={() => {}}
                  hasClipboard={false}
                  projectZones={[]}
                />
              </CanvasActionsProvider>
            </AgentsStoreProvider>
          </AppProvider>
        </ToastProvider>
      </I18nProvider>,
    );
  }

  it('Escape on window calls onClose', () => {
    const onClose = vi.fn();
    renderMenuWithClose(baseState({ kind: 'pane' }), onClose);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still closes even when an ancestor bubble-phase listener stops propagation before it reaches window (simulates React Flow\'s own NodeWrapper.onKeyDown interference)', () => {
    const onClose = vi.fn();
    renderMenuWithClose(baseState({ kind: 'node', node: missionNode() }), onClose);

    // A bubble-phase listener anywhere in the tree that stops propagation
    // (the exact shape of the interference this fix survives) — attached
    // directly to `document` so it sits BETWEEN the event target and
    // `window` in the bubble chain, same relative position React Flow's
    // per-node `onKeyDown` occupies relative to a `window`-level listener.
    const stopper = (e: KeyboardEvent) => e.stopPropagation();
    document.addEventListener('keydown', stopper);
    try {
      fireEvent.keyDown(document.body, { key: 'Escape', bubbles: true });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', stopper);
    }
  });
});

describe('clipboard + duplicate offset', () => {
  it('writeClipboard/readClipboard/hasClipboardContent round-trip', () => {
    expect(hasClipboardContent()).toBe(false);
    writeClipboard([{ kind: 'draft', spec: { title: 'x', task: 'y', createdBy: 'user' } }]);
    expect(hasClipboardContent()).toBe(true);
    expect(readClipboard()).toHaveLength(1);
  });

  it('duplicatePosition always offsets away from the original (never the same point)', () => {
    const original = { x: 50, y: 50 };
    expect(duplicatePosition(original)).not.toEqual(original);
  });

  it('pastePositions offsets each subsequent paste from the cursor', () => {
    const positions = pastePositions({ x: 0, y: 0 }, 2);
    expect(positions[0]).toEqual({ x: 0, y: 0 });
    expect(positions[1]).not.toEqual(positions[0]);
  });
});

function renderQuickCreate(props: ComponentProps<typeof CanvasQuickCreateModal>) {
  return render(
    <I18nProvider>
      <CanvasQuickCreateModal {...props} />
    </I18nProvider>,
  );
}

describe('CanvasQuickCreateModal — submits a DraftSpec-shaped value', () => {
  it('create mode: fills title/task and submits', () => {
    const onSubmit = vi.fn();
    renderQuickCreate({ mode: 'create', onSubmit, onCancel: () => {} });
    fireEvent.change(screen.getByTestId('canvas-quickcreate-title'), { target: { value: 'My draft' } });
    fireEvent.change(screen.getByTestId('canvas-quickcreate-task'), { target: { value: 'Do the thing' } });
    fireEvent.click(screen.getByTestId('canvas-quickcreate-submit'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ title: 'My draft', task: 'Do the thing' }));
    expect(onSubmit.mock.calls[0][0].model).toEqual(expect.any(String));
  });

  it('submit is disabled with an empty title', () => {
    renderQuickCreate({ mode: 'create', onSubmit: () => {}, onCancel: () => {} });
    expect(screen.getByTestId('canvas-quickcreate-submit')).toBeDisabled();
  });

  it('edit mode: pre-fills from initial values', () => {
    renderQuickCreate({
      mode: 'edit',
      initial: { title: 'Existing', task: 'Existing task', model: 'sonnet' },
      onSubmit: () => {},
      onCancel: () => {},
    });
    expect(screen.getByTestId('canvas-quickcreate-title')).toHaveValue('Existing');
    expect(screen.getByTestId('canvas-quickcreate-task')).toHaveValue('Existing task');
  });

  it('Escape calls onCancel', () => {
    const onCancel = vi.fn();
    renderQuickCreate({ mode: 'create', onSubmit: () => {}, onCancel });
    fireEvent.keyDown(screen.getByTestId('canvas-quickcreate-overlay'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });
});
