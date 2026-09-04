/**
 * Tests for the Agent Canvas W4 LazyManager actions (spec §8.1/§8.2):
 * parsing the 10 new ManagerAction variants, the canvas digest's system
 * prompt injection, and the executor (agentsStore.tsx's
 * executeManagerAction) dispatching each action through the SAME real
 * canvasStoreVanilla/chainValidation/bus primitives the UI uses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, screen } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { on } from '../lib/bus';
import { parseManagerActions, buildManagerSystemPrompt, runManagerTurn } from '../lib/agents/managerEngine';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { makeRef, type DraftSpec } from '../components/agents/canvas/canvasTypes';

const mockInvoke = vi.mocked(invoke);

/** Installs a fake `project_list` response (the REAL open-project directory
 *  resolveDraftProjectId/buildCanvasDigest read from) — every other invoke
 *  command keeps resolving `undefined`, the same default setup.ts's global
 *  mock already provides, so tests that don't care about project targeting
 *  are unaffected. `root` doubles as both the resolved projectId
 *  (projectIdFromRoot is near-identity for a plain string with no
 *  separators — see lib/journal/projectId.ts) and the digest's display
 *  name (basename falls back to the whole string when there's no
 *  separator) — enough to test id-matching and name-matching alike. */
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

vi.mock('../lib/agents/actionGate', () => ({
  evaluateActionGate: vi.fn(async () => ({ decision: 'allow', reason: 'test mock' })),
  evaluateActionGateSync: vi.fn(() => ({ decision: 'allow', reason: 'test mock' })),
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

function draft(overrides: Partial<DraftSpec> & { id: string }): DraftSpec {
  return { title: `Draft ${overrides.id}`, task: 'do the thing', createdBy: 'user', ...overrides };
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  vi.mocked(runManagerTurn).mockReset();
  // Same default every non-project-targeting test already implicitly relied
  // on (setup.ts's global mock) — explicit here since installProjects below
  // now also touches this same mock.
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

// ── Parsing ────────────────────────────────────────────────────────────

describe('parseManagerActions — Agent Canvas actions (W4)', () => {
  const cases: Array<{ name: string; json: string }> = [
    { name: 'canvas_overview', json: '{"type": "canvas_overview"}' },
    { name: 'create_draft', json: '{"type": "create_draft", "task": "write tests", "agentName": "tester", "model": "haiku", "projectId": "proj-1", "title": "Tests"}' },
    { name: 'create_draft (alias)', json: '{"type": "create_draft", "task": "write tests", "alias": "a"}' },
    { name: 'launch_draft', json: '{"type": "launch_draft", "draftId": "draft-1"}' },
    { name: 'launch_draft (draftAlias)', json: '{"type": "launch_draft", "draftAlias": "a"}' },
    { name: 'chain_agents (draftId target)', json: '{"type": "chain_agents", "sourceRef": "mission:M1", "target": {"draftId": "draft-1"}, "condition": "success"}' },
    { name: 'chain_agents (inline target)', json: '{"type": "chain_agents", "sourceRef": "mission:M1", "target": {"task": "review", "agentName": "reviewer"}}' },
    { name: 'chain_agents (sourceAlias + targetAlias)', json: '{"type": "chain_agents", "sourceAlias": "a", "target": {"targetAlias": "b"}, "condition": "success"}' },
    { name: 'unchain', json: '{"type": "unchain", "chainId": "chain-1"}' },
    { name: 'arrange_canvas', json: '{"type": "arrange_canvas", "scope": "proj-1", "mode": "lanes"}' },
    { name: 'focus_canvas', json: '{"type": "focus_canvas", "ref": "mission:M1"}' },
    { name: 'focus_canvas (refAlias)', json: '{"type": "focus_canvas", "refAlias": "a"}' },
    { name: 'move_node', json: '{"type": "move_node", "ref": "draft:D1", "x": 100, "y": 200}' },
    { name: 'move_node (refAlias)', json: '{"type": "move_node", "refAlias": "a", "x": 100, "y": 200}' },
    { name: 'canvas_note', json: '{"type": "canvas_note", "text": "hello", "projectId": "proj-1"}' },
    { name: 'collapse_project', json: '{"type": "collapse_project", "projectId": "proj-1", "collapsed": true}' },
    { name: 'open_report', json: '{"type": "open_report"}' },
    { name: 'open_report (projectId)', json: '{"type": "open_report", "projectId": "proj-1"}' },
  ];

  for (const { name, json } of cases) {
    it(`parses ${name}`, () => {
      const text = `<lazy_actions>\n[${json}]\n</lazy_actions>`;
      const actions = parseManagerActions(text);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toEqual(JSON.parse(json));
    });
  }
});

// ── System prompt: canvas digest injection ──────────────────────────────

describe('buildManagerSystemPrompt — canvas digest injection', () => {
  it('embeds the canvas digest block when canvasDigest is present', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [], canvasDigest: 'Projects:\n- alpha (proj-1): running:1' });
    expect(prompt).toContain('### Agent Canvas (real, live board state)');
    expect(prompt).toContain('proj-1');
  });

  it('omits the canvas digest block entirely when absent', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).not.toContain('### Agent Canvas (real, live board state)');
  });

  it('documents all 10 new action types in the catalog', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    for (const action of [
      'canvas_overview', 'create_draft', 'launch_draft', 'chain_agents',
      'unchain', 'arrange_canvas', 'focus_canvas', 'move_node', 'canvas_note', 'collapse_project',
    ]) {
      expect(prompt).toContain(`"type": "${action}"`);
    }
  });
});

// ── Executor dispatch ────────────────────────────────────────────────────

async function dispatch(sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>, conversationId: string, actions: unknown[]) {
  vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: actions as never, rawResponse: '' });
  await act(async () => {
    await sendManagerMessage(conversationId, 'do it', 'haiku');
  });
}

describe('executeManagerAction — create_draft', () => {
  it('arms a new Draft on the canvas and emits a highlight pulse', async () => {
    // 'proj-1' must be a KNOWN project id for the resolution to pass it
    // through as-is (W6e) — see the dedicated "project targeting" describe
    // block below for the default/name/unresolvable cases.
    installProjects([{ root: 'proj-1', active: false }]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const highlights: string[][] = [];
    const off = on('canvas:highlight', ({ refs }) => highlights.push(refs));

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'create_draft', task: 'write tests', agentName: 'tester', model: 'haiku', projectId: 'proj-1', title: 'Write tests' },
    ]);

    const drafts = canvasStoreVanilla.getState().drafts;
    expect(drafts).toHaveLength(1);
    // R13 (model-routing fix, M22 dogfood) — action.model is a bare TIER HINT
    // ("haiku"), never the final model id/label a launch should carry. It
    // must be resolved (resolveManagerModelId) to a real registry id at
    // create_draft time — the literal string 'haiku' is NOT a valid
    // OpenRouter id, and forwarding it unresolved is exactly what caused a
    // manager-created Haiku draft to bill as Sonnet once launched in managed
    // mode (the managed provider silently fell back to its own default for
    // an id it didn't recognize).
    expect(drafts[0]).toMatchObject({ title: 'Write tests', task: 'write tests', agentName: 'tester', projectId: 'proj-1', createdBy: 'manager' });
    expect(drafts[0].model).not.toBe('haiku');
    expect(drafts[0].model?.toLowerCase()).toContain('haiku');
    expect(highlights).toHaveLength(1);
    expect(highlights[0][0]).toBe(makeRef('draft', drafts[0].id));
    off();
  });

  it('leaves model undefined when the manager omits it (no forced resolution to a default)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'create_draft', task: 'no model specified' }]);
    const drafts = canvasStoreVanilla.getState().drafts;
    expect(drafts[0].model).toBeUndefined();
  });

  it('defaults the title to a truncated task when omitted', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'create_draft', task: 'A'.repeat(80) }]);
    const drafts = canvasStoreVanilla.getState().drafts;
    expect(drafts[0].title).toBe('A'.repeat(60));
  });

  // ── modelId (exact catalog id, catalog wave) ────────────────────────
  it('an exact modelId takes priority over the "model" tier hint and is stored verbatim', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'create_draft', task: 'write tests', model: 'haiku', modelId: 'claude-opus-5' },
    ]);
    const drafts = canvasStoreVanilla.getState().drafts;
    expect(drafts[0].model).toBe('claude-opus-5');
  });

  it('tolerantly normalizes a vendor-prefixed modelId from the other rail onto the active rail (accepted, not silently reinterpreted)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const messagesBefore = result.current.managerMessages.length;
    // 'anthropic/claude-sonnet-5' is a real OpenRouter-style id, but this
    // test's default (non-Tauri) provider mode resolves to the native/CLI
    // rail. Since the tolerant-normalization wave (231a597), a vendor
    // prefix that strips cleanly to a REAL id on the active rail is
    // accepted — the draft is created carrying the normalized id, with the
    // switch made explicit in a tagged console trace rather than a silent
    // rewrite (see managerEngine.ts's warnModelIdNormalized).
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'create_draft', task: 'write tests', modelId: 'anthropic/claude-sonnet-5' },
    ]);
    const drafts = canvasStoreVanilla.getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0].model).toBe('claude-sonnet-5');
    const messages = result.current.managerMessages;
    expect(messages.length).toBeGreaterThan(messagesBefore);
  });
});

// ── Project targeting (W6e) ──────────────────────────────────────────────
//
// Real-app finding: a manager reply that fired create_draft (and
// chain_agents' inline target spec, which arms a fresh draft the same way)
// with no projectId — or one that didn't match any REAL open project —
// used to pass that value straight through, so the draft silently landed in
// the Transverse zone even when the user clearly meant "put it in the
// project I'm looking at". These tests cover resolveDraftProjectId's three
// paths (canvasDigest.ts): default-to-active, name resolution, and the
// honest unresolvable fallback + toast.

describe('executeManagerAction — create_draft project targeting (W6e)', () => {
  beforeEach(() => {
    // Pin the locale so the toast text asserted verbatim below is
    // deterministic regardless of what a previous test file left in
    // localStorage (same convention as canvasChainConnect.test.tsx).
    localStorage.setItem('lazy.locale', 'en');
  });

  afterEach(() => {
    localStorage.removeItem('lazy.locale');
  });

  it('defaults to the ACTIVE project when projectId is omitted', async () => {
    installProjects([
      { root: 'other-project', active: false },
      { root: 'scratch', active: true },
    ]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'create_draft', task: 'write tests' }]);

    const drafts = canvasStoreVanilla.getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0].projectId).toBe('scratch');
  });

  it('places the draft in the Transverse zone when projectId is omitted and no project is active', async () => {
    installProjects([{ root: 'some-project', active: false }]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'create_draft', task: 'write tests' }]);

    expect(canvasStoreVanilla.getState().drafts[0].projectId).toBeUndefined();
  });

  it('resolves projectId by exact known id even when it is not the active project', async () => {
    installProjects([
      { root: 'scratch', active: true },
      { root: 'other-project', active: false },
    ]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'create_draft', task: 'write tests', projectId: 'other-project' },
    ]);

    expect(canvasStoreVanilla.getState().drafts[0].projectId).toBe('other-project');
  });

  it('resolves projectId by project NAME case-insensitively when it does not match a known id', async () => {
    installProjects([{ root: 'Scratch', active: false }]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      // 'scratch' (lowercase) is not the known id ('Scratch', case-sensitive)
      // but matches the project's display name case-insensitively.
      { type: 'create_draft', task: 'write tests', projectId: 'scratch' },
    ]);

    expect(canvasStoreVanilla.getState().drafts[0].projectId).toBe('Scratch');
  });

  it('keeps Transverse and emits an honest "not found" toast when projectId is unresolvable', async () => {
    installProjects([{ root: 'scratch', active: true }]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'create_draft', task: 'write tests', title: 'Write tests', projectId: 'nonexistent-project' },
    ]);

    const drafts = canvasStoreVanilla.getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0].projectId).toBeUndefined();
    expect(
      screen.getByText('Draft created: Write tests — project "nonexistent-project" not found, placed in the Transverse zone'),
    ).toBeInTheDocument();
  });

  it('chain_agents inline target spec applies the SAME resolution: defaults to active', async () => {
    installProjects([{ root: 'scratch', active: true }]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'chain_agents', sourceRef: 'mission:M-upstream', target: { task: 'review' } },
    ]);

    const drafts = canvasStoreVanilla.getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0].projectId).toBe('scratch');
  });

  it('chain_agents inline target spec inherits the SOURCE mission\'s real project when projectId is blank and a DIFFERENT project is active (2026-08-02 mid-plan-continuation fix)', async () => {
    // Active project is 'lazy', but NOT where the source mission actually
    // ran (its journal row below says 'backoffice') — installProjects alone
    // is not enough here since the fix also needs journal_missions_current.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'project_list') {
        return [
          { id: 'reg-0', root: 'lazy', brainId: null, active: true },
          { id: 'reg-1', root: 'backoffice', brainId: null, active: false },
        ];
      }
      if (cmd === 'journal_missions_current') {
        return [{ mission_id: 'M-upstream', project_id: 'backoffice', status: 'done', data: '{}', updated_ms: Date.now() }];
      }
      return undefined;
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'chain_agents', sourceRef: 'mission:M-upstream', target: { task: 'continue the plan' } },
    ]);

    const drafts = canvasStoreVanilla.getState().drafts;
    expect(drafts).toHaveLength(1);
    // NOT 'lazy' (the active project) — the chain's own source mission is
    // journaled under 'backoffice', so the new step must land there too.
    expect(drafts[0].projectId).toBe('backoffice');
  });

  it('chain_agents inline target spec falls back to Transverse + honest toast for an unresolvable projectId', async () => {
    installProjects([{ root: 'scratch', active: true }]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'chain_agents', sourceRef: 'mission:M-upstream', target: { task: 'review', title: 'Review', projectId: 'ghost-project' } },
    ]);

    const drafts = canvasStoreVanilla.getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0].projectId).toBeUndefined();
    // The chain itself still gets created — an unresolvable project targets
    // Transverse honestly, it never blocks the rest of the action.
    expect(canvasStoreVanilla.getState().chains).toHaveLength(1);
    expect(
      screen.getByText('Draft created: Review — project "ghost-project" not found, placed in the Transverse zone'),
    ).toBeInTheDocument();
  });
});

describe('executeManagerAction — launch_draft', () => {
  it('launches an existing draft into a real mission', async () => {
    const draftId = 'draft-1';
    canvasStoreVanilla.getState().addDraft(draft({ id: draftId, title: 'Launchable' }));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'launch_draft', draftId }]);

    expect(canvasStoreVanilla.getState().drafts.some((d) => d.id === draftId)).toBe(false);
    expect(result.current.missions.some((m) => m.title === 'Launchable')).toBe(true);
  });

  it('refuses honestly for a draft belonging to a different (inactive) project — never fakes a launch', async () => {
    const draftId = 'draft-cross';
    canvasStoreVanilla.getState().addDraft(draft({ id: draftId, title: 'Cross project', projectId: 'some-other-project-id' }));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'launch_draft', draftId }]);

    // Not launched, not silently dropped either — the draft is still there.
    expect(result.current.missions.length).toBe(missionsBefore);
    expect(canvasStoreVanilla.getState().drafts.some((d) => d.id === draftId)).toBe(true);
  });

  it('reports an honest reason for an unknown draftId', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionsBefore = result.current.missions.length;
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'launch_draft', draftId: 'does-not-exist' }]);
    expect(result.current.missions.length).toBe(missionsBefore);
  });
});

describe('executeManagerAction — chain_agents', () => {
  it('chains an existing draft target and emits a highlight pulse on both ends', async () => {
    const draftId = 'draft-1';
    canvasStoreVanilla.getState().addDraft(draft({ id: draftId }));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const highlights: string[][] = [];
    const off = on('canvas:highlight', ({ refs }) => highlights.push(refs));

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'chain_agents', sourceRef: 'mission:M-upstream', target: { draftId }, condition: 'success' },
    ]);

    const chains = canvasStoreVanilla.getState().chains;
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({ sourceRef: 'mission:M-upstream', targetRef: makeRef('draft', draftId), condition: 'success', createdBy: 'manager' });
    expect(highlights[0]).toEqual(['mission:M-upstream', makeRef('draft', draftId)]);
    off();
  });

  it('chains to a fresh inline-spec target by arming a draft first', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'chain_agents', sourceRef: 'mission:M-upstream', target: { task: 'review the diff', agentName: 'reviewer' } },
    ]);

    const drafts = canvasStoreVanilla.getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ task: 'review the diff', agentName: 'reviewer', createdBy: 'manager' });
    const chains = canvasStoreVanilla.getState().chains;
    expect(chains[0].targetRef).toBe(makeRef('draft', drafts[0].id));
    // Default condition when omitted.
    expect(chains[0].condition).toBe('success');
  });

  it('rejects an invalid source ref honestly (not mission:/loop:) without creating anything', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'chain_agents', sourceRef: 'draft:not-a-source', target: { task: 'x' } },
    ]);

    expect(canvasStoreVanilla.getState().chains).toHaveLength(0);
    expect(canvasStoreVanilla.getState().drafts).toHaveLength(0);
  });

  it('rejects a self-chain via the real chainValidation rules (never forced)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Self target', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    expect(result.current.missions.find((m) => m.id === missionId)?.status).toBe('queued');

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'chain_agents', sourceRef: makeRef('mission', missionId), target: { missionId } },
    ]);

    expect(canvasStoreVanilla.getState().chains).toHaveLength(0);
  });

  it('rejects a missionId target that is not queued (real chainValidation rule, honest reason)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Not queued', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'done' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'chain_agents', sourceRef: 'mission:M-upstream', target: { missionId } },
    ]);

    expect(canvasStoreVanilla.getState().chains).toHaveLength(0);
  });

  it('reports honestly when the missionId target does not exist', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'chain_agents', sourceRef: 'mission:M-upstream', target: { missionId: 'M-does-not-exist' } },
    ]);
    expect(canvasStoreVanilla.getState().chains).toHaveLength(0);
  });
});

// ── R13 — delete_mission maps to archive for TERMINAL missions ──────────
// Never destroys journal history: a terminal (done/failed/cancelled)
// mission's delete_mission request is honored as an archive (Mission.archived
// additive flag), matching the canvas context menu's own "Archiver" vs
// "Supprimer" split. Only a non-terminal mission keeps the old destructive
// behavior (removed from state entirely).

describe('executeManagerAction — delete_mission maps to archive for terminal missions (R13)', () => {
  it('archives (never deletes) a DONE mission — mission stays in state with archived: true', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Ship it', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'done' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'delete_mission', missionId }]);

    const mission = result.current.missions.find((m) => m.id === missionId);
    expect(mission).toBeDefined();
    expect(mission?.archived).toBe(true);
  });

  it('archives (never deletes) a FAILED mission', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Broke', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'failed' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'delete_mission', missionId }]);

    const mission = result.current.missions.find((m) => m.id === missionId);
    expect(mission?.archived).toBe(true);
    expect(mission?.status).toBe('failed'); // status itself is untouched — archive is additive only
  });

  it('still truly deletes a non-terminal (queued) mission — unchanged legacy behavior', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({ title: 'Still queued', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    expect(result.current.missions.find((m) => m.id === missionId)?.status).toBe('queued');

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'delete_mission', missionId }]);

    expect(result.current.missions.find((m) => m.id === missionId)).toBeUndefined();
  });
});

describe('executeManagerAction — unchain', () => {
  it('removes an existing chain', async () => {
    canvasStoreVanilla.getState().addChain({
      id: 'chain-1',
      sourceRef: 'mission:M1',
      targetRef: makeRef('draft', 'D1'),
      condition: 'success',
      createdBy: 'manager',
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'unchain', chainId: 'chain-1' }]);

    expect(canvasStoreVanilla.getState().chains).toHaveLength(0);
  });

  it('reports honestly for an unknown chainId (no crash)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'unchain', chainId: 'does-not-exist' }]);
    expect(canvasStoreVanilla.getState().chains).toHaveLength(0);
  });
});

describe('executeManagerAction — move_node / canvas_note / collapse_project', () => {
  it('move_node sets the position for a well-formed ref', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'move_node', ref: makeRef('draft', 'D1'), x: 111, y: 222 }]);
    expect(canvasStoreVanilla.getState().positions[makeRef('draft', 'D1')]).toEqual({ x: 111, y: 222 });
  });

  it('move_node rejects a malformed ref honestly', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'move_node', ref: 'not-a-ref', x: 1, y: 1 }]);
    expect(canvasStoreVanilla.getState().positions['not-a-ref']).toBeUndefined();
  });

  it('canvas_note adds a sticky note and pulses it', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const highlights: string[][] = [];
    const off = on('canvas:highlight', ({ refs }) => highlights.push(refs));

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'canvas_note', text: 'hello board', projectId: 'proj-1' }]);

    const notes = canvasStoreVanilla.getState().notes;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ text: 'hello board', projectId: 'proj-1' });
    expect(highlights[0][0]).toBe(makeRef('note', notes[0].id));
    off();
  });

  it('collapse_project toggles collapsed to the requested state exactly once (idempotent)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'collapse_project', projectId: 'proj-1', collapsed: true }]);
    expect(canvasStoreVanilla.getState().collapsed['proj-1']).toBe(true);

    // Calling it again with the SAME target state must not re-toggle back to false.
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'collapse_project', projectId: 'proj-1', collapsed: true }]);
    expect(canvasStoreVanilla.getState().collapsed['proj-1']).toBe(true);

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'collapse_project', projectId: 'proj-1', collapsed: false }]);
    expect(canvasStoreVanilla.getState().collapsed['proj-1']).toBe(false);
  });
});

describe('executeManagerAction — arrange_canvas / focus_canvas bus routing', () => {
  it('arrange_canvas emits canvas:arrange with the scope/mode verbatim', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const events: Array<{ scope?: string; mode?: string }> = [];
    const off = on('canvas:arrange', (payload) => events.push(payload));

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'arrange_canvas', scope: 'proj-1', mode: 'lanes' }]);

    expect(events).toEqual([{ scope: 'proj-1', mode: 'lanes' }]);
    off();
  });

  it('focus_canvas emits nav:navigateSpace("agents") then canvas:focus for a well-formed ref', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const navEvents: string[] = [];
    const focusEvents: string[] = [];
    const offNav = on('nav:navigateSpace', (payload) => navEvents.push(payload as string));
    const offFocus = on('canvas:focus', ({ ref }) => focusEvents.push(ref));

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'focus_canvas', ref: 'mission:M1' }]);

    expect(navEvents).toEqual(['agents']);
    expect(focusEvents).toEqual(['mission:M1']);
    offNav();
    offFocus();
  });

  it('focus_canvas rejects a malformed ref honestly, never emits canvas:focus', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const focusEvents: string[] = [];
    const offFocus = on('canvas:focus', ({ ref }) => focusEvents.push(ref));

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'focus_canvas', ref: 'not-a-ref' }]);

    expect(focusEvents).toEqual([]);
    offFocus();
  });
});

describe('executeManagerAction — intra-turn aliases (W6d)', () => {
  // Real-app e2e finding: a manager reply that both creates a draft AND
  // needs to chain/focus/move/launch it in the SAME reply had no way to
  // reference that draft — its id is only generated when create_draft
  // actually runs (agentsStore.tsx's generateCanvasId), so the model could
  // never know it ahead of time. These tests cover the alias fields added to
  // create_draft/chain_agents/focus_canvas/move_node/launch_draft
  // (lib/agents/types.ts) and their resolution via the executor's per-reply
  // aliasMap (agentsStore.tsx's resolveAliasedRef).

  it('happy path: create x2 + chain via aliases + focus via alias, all in ONE reply', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const focusEvents: string[] = [];
    const offFocus = on('canvas:focus', ({ ref }) => focusEvents.push(ref));

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'create_draft', alias: 'a', task: 'write tests', title: 'Draft A' },
      { type: 'create_draft', alias: 'b', task: 'review the diff', title: 'Draft B' },
      { type: 'chain_agents', sourceAlias: 'a', target: { targetAlias: 'b' }, condition: 'success' },
      { type: 'focus_canvas', refAlias: 'a' },
    ]);

    const drafts = canvasStoreVanilla.getState().drafts;
    expect(drafts).toHaveLength(2);
    const draftA = drafts.find((d) => d.title === 'Draft A')!;
    const draftB = drafts.find((d) => d.title === 'Draft B')!;
    expect(draftA).toBeDefined();
    expect(draftB).toBeDefined();

    const chains = canvasStoreVanilla.getState().chains;
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({
      sourceRef: makeRef('draft', draftA.id),
      targetRef: makeRef('draft', draftB.id),
      condition: 'success',
      createdBy: 'manager',
    });

    expect(focusEvents).toEqual([makeRef('draft', draftA.id)]);
    offFocus();
  });

  it('move_node resolves refAlias to the draft created earlier in the same reply', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'create_draft', alias: 'a', task: 'write tests' },
      { type: 'move_node', refAlias: 'a', x: 111, y: 222 },
    ]);

    const draft = canvasStoreVanilla.getState().drafts[0];
    expect(canvasStoreVanilla.getState().positions[makeRef('draft', draft.id)]).toEqual({ x: 111, y: 222 });
  });

  it('launch_draft resolves draftAlias to the draft created earlier in the same reply', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'create_draft', alias: 'a', task: 'write tests', title: 'Aliased launch' },
      { type: 'launch_draft', draftAlias: 'a' },
    ]);

    expect(canvasStoreVanilla.getState().drafts).toHaveLength(0);
    expect(result.current.missions.some((m) => m.title === 'Aliased launch')).toBe(true);
  });

  it('reports an honest reason for an unknown chain_agents sourceAlias — never half-applies the inline target', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'chain_agents', sourceAlias: 'ghost', target: { task: 'x' } },
    ]);

    expect(canvasStoreVanilla.getState().chains).toHaveLength(0);
    expect(canvasStoreVanilla.getState().drafts).toHaveLength(0);
  });

  it('reports an honest reason for an unknown chain_agents targetAlias', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'create_draft', alias: 'a', task: 'write tests' },
      { type: 'chain_agents', sourceAlias: 'a', target: { targetAlias: 'ghost' } },
    ]);

    expect(canvasStoreVanilla.getState().chains).toHaveLength(0);
  });

  it('reports an honest reason for an unknown focus_canvas refAlias — never emits canvas:focus', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const focusEvents: string[] = [];
    const offFocus = on('canvas:focus', ({ ref }) => focusEvents.push(ref));

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'focus_canvas', refAlias: 'ghost' }]);

    expect(focusEvents).toEqual([]);
    offFocus();
  });

  it('reports an honest reason for an unknown move_node refAlias — never sets a position', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'move_node', refAlias: 'ghost', x: 1, y: 1 }]);

    expect(Object.keys(canvasStoreVanilla.getState().positions)).toHaveLength(0);
  });

  it('reports an honest reason for an unknown launch_draft draftAlias — never launches a mission', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'launch_draft', draftAlias: 'ghost' }]);

    expect(result.current.missions.length).toBe(missionsBefore);
  });

  it('aliases resolve strictly BACKWARDS within a reply: an alias referenced before its create_draft has run is an honest error, never forward-resolved', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'chain_agents', sourceAlias: 'a', target: { task: 'x' } },
      { type: 'create_draft', alias: 'a', task: 'write tests' },
    ]);

    // chain_agents ran FIRST, before 'a' existed in the alias map — rejected,
    // and the create_draft AFTER it still runs on its own (one draft from
    // that create_draft, none from the rejected chain's inline target).
    expect(canvasStoreVanilla.getState().chains).toHaveLength(0);
    expect(canvasStoreVanilla.getState().drafts).toHaveLength(1);
  });

  it('a literal sourceRef naming a draft (not via alias) is still rejected — the relaxed source-kind check only applies to alias-resolved sources', async () => {
    const draftId = 'draft-literal';
    canvasStoreVanilla.getState().addDraft(draft({ id: draftId }));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'chain_agents', sourceRef: makeRef('draft', draftId), target: { task: 'x' } },
    ]);

    expect(canvasStoreVanilla.getState().chains).toHaveLength(0);
  });
});

describe('executeManagerAction — canvas_overview is a pure marker (no-op)', () => {
  it('does nothing to the canvas store (data already lives in the system prompt)', async () => {
    canvasStoreVanilla.getState().addDraft(draft({ id: 'D1' }));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'canvas_overview' }]);

    expect(canvasStoreVanilla.getState().drafts).toHaveLength(1);
  });

  it('sendManagerMessage fetches a fresh canvas digest for action requests', async () => {
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'ok',
      actions: [{ type: 'info', message: 'hi' }] as never,
      rawResponse: '',
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.sendManagerMessage(
        result.current.activeConversationId,
        'lance le canvas overview',
        'haiku',
      );
    });

    const call = vi.mocked(runManagerTurn).mock.calls[0][0];
    expect(call.context.canvasDigest).toBeDefined();
  });
});

// ── W9 — open_report ─────────────────────────────────────────────────────

describe('executeManagerAction — open_report', () => {
  it('omitting projectId emits report:open for the ACTIVE project (same resolve-by-active choke point as create_draft)', async () => {
    installProjects([
      { root: 'other-project', active: false },
      { root: 'scratch', active: true },
    ]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const events: Array<{ projectId?: string }> = [];
    const unsub = on('report:open', (payload) => events.push(payload));

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'open_report' }]);
    unsub();

    expect(events).toEqual([{ projectId: 'scratch' }]);
  });

  it('resolves a known projectId verbatim', async () => {
    installProjects([{ root: 'scratch', active: true }]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const events: Array<{ projectId?: string }> = [];
    const unsub = on('report:open', (payload) => events.push(payload));

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'open_report', projectId: 'scratch' }]);
    unsub();

    expect(events).toEqual([{ projectId: 'scratch' }]);
  });

  it('resolves a project NAME case-insensitively, same as create_draft', async () => {
    installProjects([{ root: 'Scratch', active: false }]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const events: Array<{ projectId?: string }> = [];
    const unsub = on('report:open', (payload) => events.push(payload));

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'open_report', projectId: 'scratch' }]);
    unsub();

    expect(events).toEqual([{ projectId: 'Scratch' }]);
  });

  it('an unresolvable projectId emits an honest "not found" toast AND still emits report:open with no projectId — the consumer\'s own "omitted -> active project" fallback (lib/bus.ts), never a silently wrong project', async () => {
    localStorage.setItem('lazy.locale', 'en');
    installProjects([{ root: 'scratch', active: true }]);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const events: Array<{ projectId?: string }> = [];
    const unsub = on('report:open', (payload) => events.push(payload));

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'open_report', projectId: 'nonexistent-project' }]);
    unsub();

    expect(events).toEqual([{ projectId: undefined }]);
    expect(
      screen.getByText('Project "nonexistent-project" not found — showing the report for the active project instead'),
    ).toBeInTheDocument();
    localStorage.removeItem('lazy.locale');
  });
});
