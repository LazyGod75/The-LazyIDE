/**
 * Tests for the LazyManager LazyBot lifecycle actions: delete_lazybot,
 * resolve_bot_intervention, sweep_solari, lazybot_runs, toggle_bot_vm.
 *
 * Motivation (user requirement: "le lazymanager doit pouvoir tout faire"):
 * the Bots surface has NO management UI — the LazyManager chat is the only
 * CRUD surface for LazyBots, and deleteBot()/sweepOrphans()/the header's
 * resolve button previously had no manager action at all (console-only).
 *
 * The suite drives the REAL executor path — parse-free: runManagerTurn is
 * mocked to emit the action, then sendManagerMessage runs the ordinary
 * gate+dispatch+execute chain (same harness as
 * managerCanvasCleanupActions.test.tsx) so assertions observe the real
 * store/FS outcomes plus the grounded "Real outcome" chat message.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import {
  listBots, saveBot, getBot, setBotsRoot,
} from '../lib/bots/botStorage';
import {
  setBotRuntimeRoot, listBotRunHistory, appendBotRunHistory,
} from '../lib/bots/botRuntimeStore';
import { registerBotRun, listActiveRunsForBot } from '../lib/bots/botEngine';
import {
  requestUserIntervention, getOutstandingIntervention, resetInterventions,
} from '../lib/bots/botRequestIntervention';
import {
  isBotVmWindowOpen, openBotVmWindow, resetBotVmWindows,
} from '../lib/solari/botVmWindows';
import {
  isTeachModeActive, recordTeachStep, resetTeachMode,
} from '../lib/bots/teachMode';
import { TEACH_SKILL_MARKER } from '../lib/bots/applyTeachSkill';
import type { BotConfig } from '../lib/bots/botTypes';

const mockInvoke = vi.mocked(invoke);

// ── In-memory platform fs (bots.json + bot-runtime.json + solari ledger) ──
// WebPlatform.fs.createDir rejects in the browser runtime, so the platform
// module is mocked like botStorage.test.ts — every OTHER platform surface is
// preserved via importOriginal spread.
const memFs = new Map<string, string>();
const readFile = vi.fn(async (path: string) => {
  const content = memFs.get(path);
  if (content === undefined) throw new Error(`not found: ${path}`);
  return content;
});
const writeFile = vi.fn(async (path: string, content: string) => {
  memFs.set(path, content);
});
const createDir = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    getPlatform: vi.fn(() => ({
      ...actual.getPlatform(),
      fs: { ...actual.getPlatform().fs, readFile, writeFile, createDir },
    })),
  };
});

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
  return { ...actual, runManagerTurn: vi.fn() };
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

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot_1',
    name: 'QA Bot',
    description: 'test bot',
    systemPrompt: 'You are a test bot.',
    autonomy: 'supervised',
    capabilities: { browser: true, desktop: false, sandbox: false, maxConcurrentSessions: 1 },
    routines: [],
    profileIds: [],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function dispatch(
  sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>,
  conversationId: string,
  actions: unknown[],
) {
  vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: actions as never, rawResponse: '' });
  await act(async () => {
    await sendManagerMessage(conversationId, 'do it', 'haiku');
  });
}

beforeEach(() => {
  memFs.clear();
  readFile.mockClear();
  writeFile.mockClear();
  createDir.mockClear();
  setBotsRoot('/repo');
  setBotRuntimeRoot('/repo');
  resetInterventions();
  resetBotVmWindows();
  resetTeachMode();
  vi.mocked(runManagerTurn).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

// ── delete_lazybot ──────────────────────────────────────────────────────

describe('executeManagerAction — delete_lazybot', () => {
  it('deletes an existing bot by id and reports it in the grounded result', async () => {
    localStorage.setItem('lazy.locale', 'en');
    await saveBot(makeBot());
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'delete_lazybot', botId: 'bot_1' },
    ]);

    expect(await getBot('bot_1')).toBeUndefined();
    expect(await listBots()).toHaveLength(0);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('Real outcome: delete_lazybot: deleted LazyBot "QA Bot" (bot_1)');
    localStorage.removeItem('lazy.locale');
  });

  it('resolves a bot by NAME, deletes it, and names it in the result', async () => {
    localStorage.setItem('lazy.locale', 'en');
    await saveBot(makeBot({ id: 'bot_abc', name: 'NightScraper' }));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'delete_lazybot', botId: 'NightScraper' },
    ]);

    expect(await getBot('bot_abc')).toBeUndefined();
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('"NightScraper" (bot_abc)');
    localStorage.removeItem('lazy.locale');
  });

  it('fails honestly for an unknown bot — nothing deleted', async () => {
    localStorage.setItem('lazy.locale', 'en');
    await saveBot(makeBot());
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'delete_lazybot', botId: 'ghost' },
    ]);

    expect(await listBots()).toHaveLength(1);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('no LazyBot matches "ghost"');
    localStorage.removeItem('lazy.locale');
  });

  it('stops active runs before deleting — no orphaned run bookkeeping', async () => {
    localStorage.setItem('lazy.locale', 'en');
    await saveBot(makeBot());
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    let runMissionId = '';
    act(() => {
      runMissionId = registerBotRun('bot_1', 'M_live').missionId;
    });
    expect(listActiveRunsForBot('bot_1')).toHaveLength(1);

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'delete_lazybot', botId: 'bot_1' },
    ]);

    expect(await getBot('bot_1')).toBeUndefined();
    expect(listActiveRunsForBot('bot_1')).toHaveLength(0);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('stopped 1 active run(s) first');
    void runMissionId;
    localStorage.removeItem('lazy.locale');
  });

  it('closes an open VM window so the derived botVm canvas node disappears', async () => {
    await saveBot(makeBot());
    openBotVmWindow('bot_1');
    expect(isBotVmWindowOpen('bot_1')).toBe(true);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'delete_lazybot', botId: 'bot_1' },
    ]);

    expect(isBotVmWindowOpen('bot_1')).toBe(false);
  });
});

// ── resolve_bot_intervention ────────────────────────────────────────────

describe('executeManagerAction — resolve_bot_intervention', () => {
  it('clears an outstanding human gate (same as the header button)', async () => {
    localStorage.setItem('lazy.locale', 'en');
    await saveBot(makeBot());
    requestUserIntervention('bot_1', 'captcha', 'https://example.com/login');
    expect(getOutstandingIntervention('bot_1')).toBeDefined();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'resolve_bot_intervention', botId: 'bot_1' },
    ]);

    expect(getOutstandingIntervention('bot_1')).toBeUndefined();
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('marked the human gate on "QA Bot" (bot_1) solved');
    localStorage.removeItem('lazy.locale');
  });

  it('reports honestly when the bot has nothing outstanding', async () => {
    localStorage.setItem('lazy.locale', 'en');
    await saveBot(makeBot());
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'resolve_bot_intervention', botId: 'bot_1' },
    ]);

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('no outstanding human gate');
    localStorage.removeItem('lazy.locale');
  });
});

// ── sweep_solari / lazybot_runs / toggle_bot_vm ─────────────────────────

describe('executeManagerAction — sweep_solari', () => {
  it('runs the orphan sweep without throwing and reports completion', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'sweep_solari' },
    ]);

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('sweep_solari: orphan sweep complete');
    localStorage.removeItem('lazy.locale');
  });
});

describe('executeManagerAction — lazybot_runs', () => {
  it('lists persisted run history entries for the bot', async () => {
    localStorage.setItem('lazy.locale', 'en');
    await saveBot(makeBot());
    await appendBotRunHistory({
      id: 'run_M1', botId: 'bot_1', missionId: 'M1',
      status: 'completed', startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z', summary: 'scraped example.com',
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'lazybot_runs', botId: 'bot_1' },
    ]);

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('lazybot_runs "QA Bot" (bot_1)');
    expect(lastMsg.content).toContain('M1 [completed]');
    expect(lastMsg.content).toContain('scraped example.com');
    localStorage.removeItem('lazy.locale');
  });

  it('reports honestly when the bot has no run history', async () => {
    localStorage.setItem('lazy.locale', 'en');
    await saveBot(makeBot());
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'lazybot_runs', botId: 'bot_1' },
    ]);

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('(no run history for "QA Bot")');
    localStorage.removeItem('lazy.locale');
  });
});

describe('executeManagerAction — toggle_bot_vm', () => {
  it('opens the VM window, then closes it again', async () => {
    localStorage.setItem('lazy.locale', 'en');
    await saveBot(makeBot());
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'toggle_bot_vm', botId: 'bot_1', open: true },
    ]);
    expect(isBotVmWindowOpen('bot_1')).toBe(true);

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'toggle_bot_vm', botId: 'bot_1', open: false },
    ]);
    expect(isBotVmWindowOpen('bot_1')).toBe(false);
    localStorage.removeItem('lazy.locale');
  });

  it('fails honestly for an unknown bot', async () => {
    localStorage.setItem('lazy.locale', 'en');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'toggle_bot_vm', botId: 'ghost' },
    ]);

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('no LazyBot matches "ghost"');
    localStorage.removeItem('lazy.locale');
  });
});

// ── teach_lazybot ───────────────────────────────────────────────────────

describe('executeManagerAction — teach_lazybot', () => {
  it('mode "start" opens the VM window and begins recording', async () => {
    localStorage.setItem('lazy.locale', 'en');
    await saveBot(makeBot());
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'teach_lazybot', botId: 'bot_1', mode: 'start', skillName: 'Order flow' },
    ]);

    expect(isTeachModeActive('bot_1')).toBe(true);
    expect(isBotVmWindowOpen('bot_1')).toBe(true);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('recording started for "QA Bot"');
    expect(lastMsg.content).toContain('"Order flow"');
    localStorage.removeItem('lazy.locale');
  });

  it('mode "stop" compiles the journal into the system prompt (single marker)', async () => {
    localStorage.setItem('lazy.locale', 'en');
    await saveBot(makeBot());
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'teach_lazybot', botId: 'bot_1', mode: 'start', skillName: 'Order flow' },
    ]);
    recordTeachStep('bot_1', { kind: 'navigate', target: 'https://shop.example.com' });
    recordTeachStep('bot_1', { kind: 'click', target: "the 'Buy' button", selector: '#buy' });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'teach_lazybot', botId: 'bot_1', mode: 'stop' },
    ]);

    expect(isTeachModeActive('bot_1')).toBe(false);
    const bot = await getBot('bot_1');
    expect(bot!.systemPrompt).toContain(TEACH_SKILL_MARKER);
    expect(bot!.systemPrompt).toContain('Skill: Order flow');
    expect(bot!.systemPrompt).toContain('https://shop.example.com');
    expect(bot!.systemPrompt).toContain('Click the \'Buy\' button');
    // Exactly ONE section header — the overlay's own LEARNED SKILL banner is
    // stripped on merge (no stacked banners in the persisted persona).
    expect(bot!.systemPrompt.match(/===/g)).toHaveLength(2);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('compiled "Order flow" (2 step(s))');
    localStorage.removeItem('lazy.locale');
  });

  it('a second teach replaces the prior block instead of appending', async () => {
    await saveBot(makeBot());
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'teach_lazybot', botId: 'bot_1', mode: 'start', skillName: 'First' },
    ]);
    recordTeachStep('bot_1', { kind: 'navigate', target: 'https://a.example.com' });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'teach_lazybot', botId: 'bot_1', mode: 'stop' },
    ]);
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'teach_lazybot', botId: 'bot_1', mode: 'start', skillName: 'Second' },
    ]);
    recordTeachStep('bot_1', { kind: 'navigate', target: 'https://b.example.com' });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'teach_lazybot', botId: 'bot_1', mode: 'stop' },
    ]);

    const bot = await getBot('bot_1');
    expect(bot!.systemPrompt.match(new RegExp(TEACH_SKILL_MARKER.replace(/[= ]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(bot!.systemPrompt).toContain('b.example.com');
    expect(bot!.systemPrompt).not.toContain('a.example.com');
  });

  it('stop with no session and stop with 0 steps both report honestly', async () => {
    localStorage.setItem('lazy.locale', 'en');
    await saveBot(makeBot());
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'teach_lazybot', botId: 'bot_1', mode: 'stop' },
    ]);
    let lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('no active teach session');

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'teach_lazybot', botId: 'bot_1', mode: 'start' },
    ]);
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'teach_lazybot', botId: 'bot_1', mode: 'stop' },
    ]);
    lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('recorded 0 steps');
    expect((await getBot('bot_1'))!.systemPrompt).not.toContain(TEACH_SKILL_MARKER);
    localStorage.removeItem('lazy.locale');
  });

  it('start twice reports already-recording instead of resetting the journal', async () => {
    localStorage.setItem('lazy.locale', 'en');
    await saveBot(makeBot());
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'teach_lazybot', botId: 'bot_1', mode: 'start' },
    ]);
    recordTeachStep('bot_1', { kind: 'navigate', target: 'https://x.example.com' });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'teach_lazybot', botId: 'bot_1', mode: 'start' },
    ]);

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('already recording');
    localStorage.removeItem('lazy.locale');
  });
});

// ── run history survives bot deletion (documented behavior) ─────────────

describe('delete_lazybot — run history is kept', () => {
  it('a deleted bot keeps its .lazy run history (listBotRunHistory still returns it)', async () => {
    await saveBot(makeBot());
    await appendBotRunHistory({
      id: 'run_M9', botId: 'bot_1', missionId: 'M9',
      status: 'completed', startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z', summary: 'kept',
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'delete_lazybot', botId: 'bot_1' },
    ]);

    expect(await getBot('bot_1')).toBeUndefined();
    expect(await listBotRunHistory('bot_1')).toHaveLength(1);
  });
});
