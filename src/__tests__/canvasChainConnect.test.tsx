/**
 * canvasChainConnect.test.tsx — useCanvasChainConnect.ts (W2b, spec §5
 * "Connection UX", §7, deliverable #6 "Wire React Flow onConnect"). Proves
 * `handleConnect` (drag-handle-to-handle) and `isValidConnection` (live
 * drag-hover feedback) both go through the SAME `validateChain` rules as
 * the pre-existing click-to-connect flow — a valid connect adds a real
 * Chain to canvasStore, an invalid one is rejected with a toast and never
 * mutates the store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ToastProvider } from '../components/ui/Toast';
import { I18nProvider } from '../i18n';
import { useCanvasChainConnect } from '../components/agents/canvas/hooks/useCanvasChainConnect';
import { _resetCanvasStoreForTests, canvasStoreVanilla } from '../components/agents/canvas/canvasStore';
import { makeRef, type DraftSpec, type MissionNodeData } from '../components/agents/canvas/canvasTypes';
import type { CanvasReactFlowNode } from '../components/agents/canvas/reconciler';
import type { FleetMission } from '../lib/agents/fleetMissions';

function mission(overrides: Partial<FleetMission> = {}): FleetMission {
  return { id: 'm1', title: 'Fix bug', status: 'running', stage: 'code', model: 'sonnet', updatedMs: 1, urgent: false, ...overrides };
}

function missionNode(overrides: Partial<FleetMission> = {}): CanvasReactFlowNode {
  const m = mission(overrides);
  const data: MissionNodeData = { mission: m, projectId: 'p1', isActiveProject: true };
  return { id: makeRef('mission', m.id), type: 'mission', position: { x: 0, y: 0 }, data } as unknown as CanvasReactFlowNode;
}

function draftNode(id = 'd1'): CanvasReactFlowNode {
  const data: DraftSpec = { id, title: 'Draft', task: 'run it', createdBy: 'user', projectId: 'p1' };
  return { id: makeRef('draft', id), type: 'draft', position: { x: 0, y: 0 }, data } as unknown as CanvasReactFlowNode;
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>{children}</ToastProvider>
    </I18nProvider>
  );
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  // validateChain's rejection reasons are now resolved via t() (W5a i18n
  // sweep — chainValidation.ts returns a `reasonKey`, see its header) —
  // pin the locale so the toast text this suite asserts on verbatim is
  // deterministic regardless of what a previous test file left in
  // localStorage (see LazyManagerRail.signals.test.tsx's identical note).
  localStorage.setItem('lazy.locale', 'fr');
});

afterEach(() => {
  localStorage.removeItem('lazy.locale');
});

describe('useCanvasChainConnect — handleConnect (drag-handle onConnect)', () => {
  it('a valid connection (running mission -> draft) adds a real Chain to canvasStore', () => {
    const nodes = [missionNode({ status: 'running' }), draftNode()];
    const { result } = renderHook(() => useCanvasChainConnect({ nodes }), { wrapper });

    act(() => {
      result.current.handleConnect({ source: makeRef('mission', 'm1'), target: makeRef('draft', 'd1'), sourceHandle: null, targetHandle: null });
    });

    const chains = canvasStoreVanilla.getState().chains;
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({ sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'success', createdBy: 'user' });
  });

  it('an invalid connection (running mission -> running mission) is rejected: no chain added, a toast fires with the real rejection reason', () => {
    const nodes = [missionNode({ status: 'running' }), missionNode({ id: 'm2', status: 'running' })];
    const { result } = renderHook(() => useCanvasChainConnect({ nodes }), { wrapper });

    act(() => {
      result.current.handleConnect({ source: makeRef('mission', 'm1'), target: makeRef('mission', 'm2'), sourceHandle: null, targetHandle: null });
    });

    expect(canvasStoreVanilla.getState().chains).toHaveLength(0);
    // The toast surfaces validateChain's own rejection reason verbatim —
    // proves this really went through validateChain, not a generic message.
    expect(screen.getByText('La cible doit être un draft ou une mission en file d’attente.')).toBeInTheDocument();
  });

  it('a self-connection (source === target) is rejected, never added', () => {
    const nodes = [missionNode({ status: 'running' })];
    const { result } = renderHook(() => useCanvasChainConnect({ nodes }), { wrapper });

    act(() => {
      result.current.handleConnect({ source: makeRef('mission', 'm1'), target: makeRef('mission', 'm1'), sourceHandle: null, targetHandle: null });
    });

    expect(canvasStoreVanilla.getState().chains).toHaveLength(0);
  });

  it('a connection with a missing source/target is silently ignored (no crash)', () => {
    const nodes = [missionNode()];
    const { result } = renderHook(() => useCanvasChainConnect({ nodes }), { wrapper });

    expect(() => {
      act(() => {
        result.current.handleConnect({ source: '', target: makeRef('mission', 'm1'), sourceHandle: null, targetHandle: null });
      });
    }).not.toThrow();
    expect(canvasStoreVanilla.getState().chains).toHaveLength(0);
  });
});

describe('useCanvasChainConnect — isValidConnection (live drag-hover feedback)', () => {
  it('returns true for a valid target (draft), false for an invalid one (running mission), never toasts', () => {
    const nodes = [missionNode({ status: 'running' }), draftNode(), missionNode({ id: 'm2', status: 'running' })];
    const { result } = renderHook(() => useCanvasChainConnect({ nodes }), { wrapper });

    expect(result.current.isValidConnection({ source: makeRef('mission', 'm1'), target: makeRef('draft', 'd1'), sourceHandle: null, targetHandle: null })).toBe(true);
    expect(result.current.isValidConnection({ source: makeRef('mission', 'm1'), target: makeRef('mission', 'm2'), sourceHandle: null, targetHandle: null })).toBe(false);
    // Purely a check — never mutates the store.
    expect(canvasStoreVanilla.getState().chains).toHaveLength(0);
  });

  it('returns false when the target node cannot be resolved from the live node list', () => {
    const nodes = [missionNode({ status: 'running' })];
    const { result } = renderHook(() => useCanvasChainConnect({ nodes }), { wrapper });
    expect(result.current.isValidConnection({ source: makeRef('mission', 'm1'), target: makeRef('draft', 'unknown'), sourceHandle: null, targetHandle: null })).toBe(false);
  });
});

describe('useCanvasChainConnect — click-to-connect (handleNodeClick)', () => {
  it('does nothing when no chainSource is armed', () => {
    const nodes = [missionNode(), draftNode()];
    const { result } = renderHook(() => useCanvasChainConnect({ nodes }), { wrapper });
    act(() => {
      result.current.handleNodeClick(undefined, draftNode());
    });
    expect(canvasStoreVanilla.getState().chains).toHaveLength(0);
  });

  it('clicking the armed source itself cancels (no chain created)', () => {
    const nodes = [missionNode({ status: 'running' }), draftNode()];
    const { result } = renderHook(() => useCanvasChainConnect({ nodes }), { wrapper });
    act(() => {
      result.current.setChainSource(makeRef('mission', 'm1'));
    });
    act(() => {
      result.current.handleNodeClick(undefined, missionNode({ status: 'running' }));
    });
    expect(result.current.chainSource).toBeNull();
    expect(canvasStoreVanilla.getState().chains).toHaveLength(0);
  });

  it('clicking a valid target while armed creates the chain and disarms', () => {
    const nodes = [missionNode({ status: 'running' }), draftNode()];
    const { result } = renderHook(() => useCanvasChainConnect({ nodes }), { wrapper });
    act(() => {
      result.current.setChainSource(makeRef('mission', 'm1'));
    });
    act(() => {
      result.current.handleNodeClick(undefined, draftNode());
    });
    expect(result.current.chainSource).toBeNull();
    expect(canvasStoreVanilla.getState().chains).toHaveLength(1);
  });
});
