import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProviderMode: vi.fn(() => 'claude-code'),
    isCliBackendAvailable: vi.fn(() => true),
  };
});

vi.mock('../lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
    },
  },
}));

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    brain: {
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      capture: vi.fn().mockResolvedValue(undefined),
      startupContext: vi.fn().mockResolvedValue(''),
    },
  })),
}));

vi.mock('../lib/brain/context', () => ({
  normalizeRecall: vi.fn((r: unknown) => r),
  buildPromptBrainContext: vi.fn(() => ''),
}));

import { runMission } from '../lib/agents/runtime';
import type { Mission } from '../lib/agents/types';
import { FREE_OPENROUTER_MODEL_ID } from '../lib/models/openrouterCatalog';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedListen = listen as ReturnType<typeof vi.fn>;

function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) w['__TAURI_INTERNALS__'] = {};
  else delete w['__TAURI_INTERNALS__'];
}

beforeEach(() => {
  vi.clearAllMocks();
  setTauriRuntime(true);
  mockedListen.mockResolvedValue(() => undefined);
});

afterEach(() => {
  setTauriRuntime(false);
});

describe('runMission session gate (B23)', () => {
  it('fails before worktree when a free OpenRouter model lacks a JWT', async () => {
    const onUpdate = vi.fn();
    const mission: Mission = {
      id: 'M-free',
      title: 'Free rail',
      status: 'queued',
      model: FREE_OPENROUTER_MODEL_ID,
    };

    await runMission(mission, 'C:\\repo', { onUpdate });

    const worktreeCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'agent_create_worktree');
    expect(worktreeCalls).toHaveLength(0);
    const failed = onUpdate.mock.calls.find(
      ([update]) => (update as { patch?: { status?: string } }).patch?.status === 'failed',
    );
    expect(failed).toBeTruthy();
  });
});
