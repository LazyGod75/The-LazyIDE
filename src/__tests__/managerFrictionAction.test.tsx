/**
 * End-to-end (store-level) test for the `analyze_frictions` ManagerAction
 * (Pillar D5 v1 — see src/lib/agents/frictionAnalysis.ts). Exercises the SAME
 * real path every other Agent Canvas action does (see managerCanvasActions.
 * test.tsx): parse -> sendManagerMessage -> executeManagerAction's switch ->
 * this new case. The mining/materialization internals are covered on their
 * own (frictionMiner.test.ts, frictionAnalysis.test.ts) and mocked here so
 * this test isolates the executor WIRING: project resolution, the toast
 * copy, and the canvas:highlight emission.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, screen } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { on } from '../lib/bus';
import { runManagerTurn } from '../lib/agents/managerEngine';
import { runFrictionAnalysis } from '../lib/agents/frictionAnalysis';
import { _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';

const mockInvoke = vi.mocked(invoke);

function installProjects(projects: Array<{ root: string; active: boolean }>): void {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'project_list') {
      return projects.map((p, i) => ({ id: `reg-${i}`, root: p.root, brainId: null, active: p.active }));
    }
    return undefined;
  });
}

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

vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return {
    ...actual,
    runManagerTurn: vi.fn(),
  };
});

vi.mock('../lib/agents/frictionAnalysis', () => ({
  runFrictionAnalysis: vi.fn(),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

async function dispatch(sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>, conversationId: string, actions: unknown[]) {
  vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: actions as never, rawResponse: '' });
  await act(async () => {
    await sendManagerMessage(conversationId, 'do it', 'haiku');
  });
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  vi.mocked(runManagerTurn).mockReset();
  vi.mocked(runFrictionAnalysis).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
  localStorage.setItem('lazy.locale', 'en');
});

describe('executeManagerAction — analyze_frictions', () => {
  it('runs the friction analysis for a known project and reports the candidate count', async () => {
    installProjects([{ root: 'proj-1', active: false }]);
    vi.mocked(runFrictionAnalysis).mockResolvedValue({
      candidates: [
        { id: 'a', projectId: 'proj-1', title: 'A', rationale: 'r', where: 'w', why: 'y', suggestedTask: 't', evidence: [], severity: 'high' },
        { id: 'b', projectId: 'proj-1', title: 'B', rationale: 'r', where: 'w', why: 'y', suggestedTask: 't', evidence: [], severity: 'low' },
      ],
      frameId: 'frame-1',
      draftIds: ['draft-1', 'draft-2'],
    });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const highlights: string[][] = [];
    const off = on('canvas:highlight', ({ refs }) => highlights.push(refs));

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'analyze_frictions', projectId: 'proj-1' }]);

    expect(runFrictionAnalysis).toHaveBeenCalledWith('proj-1', undefined, 'Self-improvement');
    expect(screen.getByText('2 improvement candidate(s) added to the canvas')).toBeInTheDocument();
    expect(highlights).toHaveLength(1);
    expect(highlights[0]).toEqual(expect.arrayContaining(['frame:frame-1', 'draft:draft-1', 'draft:draft-2']));
    off();
  });

  it('reports honestly when no friction is found — never fabricates a candidate', async () => {
    installProjects([{ root: 'proj-1', active: true }]);
    vi.mocked(runFrictionAnalysis).mockResolvedValue({ candidates: [], draftIds: [] });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'analyze_frictions' }]);

    expect(screen.getByText('No recurring friction detected on this project')).toBeInTheDocument();
  });

  it('reports honestly when there is no resolvable target project', async () => {
    installProjects([]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'analyze_frictions' }]);

    expect(screen.getByText('No target project to analyze frictions for')).toBeInTheDocument();
    expect(runFrictionAnalysis).not.toHaveBeenCalled();
  });
});
