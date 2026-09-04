/**
 * edgeDropPicker.test.tsx — R2b connectionUx §5 (edge-drop node picker,
 * the flagship deliverable). Covers the pure parts (chrome/
 * edgeDropTargeting.ts's `computeCompatibleTargets`, the shared basis
 * for both the search-light highlight and the picker's own eventual
 * chain validation) plus a fixture render of the picker component itself
 * — same seam as canvasCommandBar.test.tsx (`listAgents()` mocked, no
 * ReactFlow/canvasStore provider needed since this component is a plain
 * fixed overlay with its own local state).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { computeCompatibleTargets, type TargetableNode } from '../components/agents/canvas/chrome/edgeDropTargeting';
import { EdgeDropNodePicker } from '../components/agents/canvas/chrome/EdgeDropNodePicker';
import { makeRef, type Chain } from '../components/agents/canvas/canvasTypes';
import type { StoredAgent } from '../lib/agents/agentsStorage';

// ── computeCompatibleTargets (pure) ───────────────────────────────────

describe('computeCompatibleTargets (chrome/edgeDropTargeting.ts)', () => {
  const missionRef = makeRef('mission', 'm1');
  const draftRef = makeRef('draft', 'd1');
  const queuedRef = makeRef('mission', 'm2');
  const runningRef = makeRef('mission', 'm3');
  const loopRef = makeRef('loop', 'l1');

  const nodes: TargetableNode[] = [
    { id: missionRef, type: 'mission', data: { mission: { status: 'running' } } },
    { id: draftRef, type: 'draft', data: {} },
    { id: queuedRef, type: 'mission', data: { mission: { status: 'queued' } } },
    { id: runningRef, type: 'mission', data: { mission: { status: 'running' } } },
    { id: loopRef, type: 'loop', data: {} },
  ];

  it('excludes the source node itself', () => {
    const compatible = computeCompatibleTargets([], missionRef, nodes);
    expect(compatible.has(missionRef)).toBe(false);
  });

  it('includes a draft target and a QUEUED mission, excludes a RUNNING mission and a loop', () => {
    const compatible = computeCompatibleTargets([], missionRef, nodes);
    expect(compatible.has(draftRef)).toBe(true);
    expect(compatible.has(queuedRef)).toBe(true);
    expect(compatible.has(runningRef)).toBe(false);
    expect(compatible.has(loopRef)).toBe(false);
  });

  it('excludes a target that would close a cycle', () => {
    const chains: Chain[] = [{ id: 'c1', sourceRef: draftRef, targetRef: missionRef, condition: 'success', createdBy: 'user' }];
    // draftRef -> missionRef already exists; missionRef -> draftRef would cycle.
    const compatible = computeCompatibleTargets(chains, missionRef, nodes);
    expect(compatible.has(draftRef)).toBe(false);
  });
});

// ── EdgeDropNodePicker (fixture render) ───────────────────────────────

const FIXTURE_AGENTS: StoredAgent[] = [
  {
    scope: 'user',
    agent: {
      id: 'agent-tester',
      name: 'tester',
      displayName: 'Testeur',
      description: 'Écrit des tests',
      modelTier: 'sonnet',
      triggers: {},
      memory: 'none',
      isolation: 'worktree',
    },
  } as unknown as StoredAgent,
];

vi.mock('../lib/agents/agentsStorage', () => ({
  listAgents: vi.fn(async () => FIXTURE_AGENTS),
}));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('lazy.locale', 'fr');
});

function renderPicker(overrides: Partial<React.ComponentProps<typeof EdgeDropNodePicker>> = {}) {
  const props = {
    screenPosition: { x: 200, y: 150 },
    onSelect: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  const view = render(
    <I18nProvider>
      <EdgeDropNodePicker {...props} />
    </I18nProvider>,
  );
  return { ...view, props };
}

describe('EdgeDropNodePicker', () => {
  it('lists the blank draft entry, the router entry, and library agents', async () => {
    renderPicker();
    expect(screen.getByTestId('edge-drop-node-picker-item-draft-blank')).toBeInTheDocument();
    expect(screen.getByTestId('edge-drop-node-picker-item-router')).toBeInTheDocument();
    await screen.findByTestId('edge-drop-node-picker-item-agent-agent-tester');
  });

  it('filters entries as the user types', async () => {
    renderPicker();
    await screen.findByTestId('edge-drop-node-picker-item-agent-agent-tester');
    fireEvent.change(screen.getByTestId('edge-drop-node-picker-search'), { target: { value: 'testeur' } });
    expect(screen.getByTestId('edge-drop-node-picker-item-agent-agent-tester')).toBeInTheDocument();
    expect(screen.queryByTestId('edge-drop-node-picker-item-draft-blank')).not.toBeInTheDocument();
    expect(screen.queryByTestId('edge-drop-node-picker-item-router')).not.toBeInTheDocument();
  });

  it('selecting the router entry calls onSelect with a router choice', () => {
    const { props } = renderPicker();
    fireEvent.click(screen.getByTestId('edge-drop-node-picker-item-router'));
    expect(props.onSelect).toHaveBeenCalledWith({ kind: 'router' });
  });

  it('selecting the blank-draft entry calls onSelect with an empty draft choice', () => {
    const { props } = renderPicker();
    fireEvent.click(screen.getByTestId('edge-drop-node-picker-item-draft-blank'));
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'draft', task: '' }));
  });

  it('selecting a library agent calls onSelect carrying its agentName/model', async () => {
    const { props } = renderPicker();
    await screen.findByTestId('edge-drop-node-picker-item-agent-agent-tester');
    fireEvent.click(screen.getByTestId('edge-drop-node-picker-item-agent-agent-tester'));
    expect(props.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'draft', title: 'Testeur', agentName: 'tester', model: 'sonnet' }),
    );
  });

  it('Escape cancels cleanly without selecting anything', () => {
    const { props } = renderPicker();
    fireEvent.keyDown(screen.getByTestId('edge-drop-node-picker'), { key: 'Escape' });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('clicking away (outside the picker) cancels', () => {
    const { props } = renderPicker();
    fireEvent.mouseDown(document.body);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  // fix/canvas-ux R6a BLOQUANT #2 — this popover only ever clamped the LEFT
  // edge before (screenPosition.x - width/2, clamped); `top` was
  // unconditionally `screenPosition.y + 12`, so a drop near the BOTTOM of
  // the viewport could push its own options below the fold. Same
  // chrome/popoverPosition.ts flip/clamp treatment as GateFeedbackPopover.
  describe('viewport clamp (fix/canvas-ux R6a BLOQUANT #2)', () => {
    const originalInnerHeight = window.innerHeight;
    const originalInnerWidth = window.innerWidth;

    afterEach(() => {
      Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true });
      Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true });
      vi.restoreAllMocks();
    });

    it('flips ABOVE the drop point when dropped near the bottom of the viewport', () => {
      Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
      Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(220);
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320);

      renderPicker({ screenPosition: { x: 700, y: 820 } });
      const picker = screen.getByTestId('edge-drop-node-picker');
      const top = parseFloat(picker.style.top);
      expect(top).toBeLessThan(820);
      expect(top + 220).toBeLessThanOrEqual(844);
    });

    it('clamps horizontally so the picker never renders off the right edge', () => {
      Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320);

      renderPicker({ screenPosition: { x: 1430, y: 100 } });
      const picker = screen.getByTestId('edge-drop-node-picker');
      const left = parseFloat(picker.style.left);
      expect(left + 320).toBeLessThanOrEqual(1440);
    });
  });
});
