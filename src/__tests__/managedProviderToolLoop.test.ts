/* managedProviderToolLoop.test.ts — managed provider's general tool-directive
   round trip (READ_FILE, WEB_SEARCH, ...) via the shared assistantToolLoop.

   Regression coverage for the 2026-07 live defect: in "Pro · géré" (managed)
   mode, the model emitted `READ_FILE: README.md` as literal text with zero
   tool execution, then hallucinated the file's content — because
   managedProvider.ts ran its OWN ReAct loop that only recognized
   BRAIN_SEARCH/BRAIN_QUERY_CSS/BRAIN_NEIGHBOURS directives (see
   managedProvider.ts's header). The fix wires managedProvider's
   streamChatImpl/streamChatEventsImpl through assistantToolLoop.ts's
   withAssistantToolLoop/withAssistantToolLoopEvents — the same extended loop
   already used by anthropicProvider/claudeCodeProvider/cliBackendProvider —
   so general tool directives are now actually executed instead of leaking
   into the visible answer.

   Mirrors managedProvider.test.ts's mocking setup (supabase session, env,
   accessSettings, openrouterCatalog, systemPrompts, costStore, brain/context,
   platform) plus one addition: '../lib/tools/toolRuntime''s executeTool is
   mocked — this is the single seam assistantToolLoop.ts calls to actually
   invoke a tool — so the READ_FILE directive resolves to a fake file body
   instead of attempting a real Tauri invoke() call (there is no Tauri
   runtime in the test environment). '../lib/tools/toolProfiles' is left
   UNMOCKED so the test also exercises the real assistant-surface permission
   check (read_file is allowed there).
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamEvent } from '../lib/models/types';

// ── Mocks (same fakes as managedProvider.test.ts) ─────────────────

vi.mock('../lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      }),
    },
  },
}));

vi.mock('../lib/env', () => ({
  supabaseAnonKey: 'test-anon-key',
  getAiProxyUrl: () => 'https://mock.proxy/ai',
}));

vi.mock('../lib/models/accessSettings', () => ({
  loadAccessSettings: vi.fn(() => ({ model: 'anthropic/claude-haiku' })),
}));

vi.mock('../lib/models/openrouterCatalog', () => ({
  OPENROUTER_MODELS: [],
  DEFAULT_OPENROUTER_MODEL_ID: 'anthropic/claude-haiku',
  findOpenRouterModel: vi.fn(() => ({ reasoning: false })),
  priceBadge: vi.fn(() => '$'),
}));

// See managedProvider.test.ts's identical mock for why importOriginal is
// required here: managedProvider.ts -> assistantToolLoop.ts -> toolRuntime.ts
// -> managedToolPermissions.ts -> managedAgentPolicy.ts references
// systemPrompts.ts's RECALL_TEACHING at that module's own eval time.
vi.mock('../lib/models/systemPrompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/systemPrompts')>();
  return {
    ...actual,
    buildSystemPrompt: vi.fn(() => 'system'),
  };
});

vi.mock('../lib/models/costStore', () => ({
  addUsage: vi.fn(),
  addBrainSavings: vi.fn(),
  recordRecallSaving: vi.fn(),
  getCost: vi.fn(() => ({ inputTokens: 0, outputTokens: 0, cost: 0 })),
  useCostStore: vi.fn(() => ({ inputTokens: 0, outputTokens: 0, cost: 0 })),
}));

vi.mock('../lib/brain/context', () => ({
  normalizeRecall: vi.fn(r => r),
}));

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    brain: {
      recallScoped: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [] }),
      queryCss: vi.fn().mockResolvedValue('0 matches'),
      neighbours: vi.fn().mockResolvedValue(''),
    },
  })),
}));

// The seam assistantToolLoop.ts calls for every general tool directive —
// mocked so READ_FILE resolves to a fake body instead of a real Tauri
// invoke() call (there is no Tauri runtime in this test environment).
const mockExecuteTool = vi.fn();
vi.mock('../lib/tools/toolRuntime', () => ({
  executeTool: (...args: unknown[]) => mockExecuteTool(...args),
}));

// ── Helpers ────────────────────────────────────────────────────────

function makeStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

const baseReq = {
  messages: [{ id: 'u1', role: 'user' as const, content: 'what does the README say?' }],
  model: { id: 'anthropic/claude-haiku', label: 'Haiku', provider: 'anthropic', description: '' },
  mode: 'ask' as const,
  tools: [{ name: 'read_file', description: '', input_schema: { type: 'object' as const, properties: {}, required: [] } }],
};

describe('managedProvider — general tool-directive loop (READ_FILE)', () => {
  let managedProvider: typeof import('../lib/models/managedProvider');

  beforeEach(async () => {
    vi.resetModules();
    mockExecuteTool.mockReset();
    managedProvider = await import('../lib/models/managedProvider');
  });

  it('streamChat: intercepts READ_FILE, executes it via the tool runtime, and feeds the real result back for a grounded follow-up', async () => {
    mockExecuteTool.mockResolvedValueOnce(
      '--- lines 1-3 of 3 ---\n# Lazy IDE\nA lazy but capable coding IDE.\nSee docs/ for more.',
    );

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, body: makeStream('READ_FILE: README.md\n') } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, body: makeStream('The README describes Lazy IDE, a lazy but capable coding IDE.\n') } as unknown as Response);
    global.fetch = fetchMock;

    const chunks = await collect(managedProvider.managedProvider.streamChat(baseReq));
    const combined = chunks.join('');

    // The raw directive must never reach the visible answer.
    expect(combined).not.toContain('READ_FILE:');
    // A clean status line replaces it.
    expect(combined).toContain('Lecture fichier');
    // The grounded follow-up (informed by the REAL tool result) is present.
    expect(combined).toContain('The README describes Lazy IDE');

    // The tool was actually executed — not skipped, not hallucinated.
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(mockExecuteTool).toHaveBeenCalledWith(
      'read_file',
      { path: 'README.md' },
      expect.objectContaining({ agentMode: 'default' }),
    );

    // Exactly two proxy round-trips: the directive round + the grounded
    // follow-up round — proves a SECOND round actually happened (the bug
    // report's "zero tool steps ran" symptom is gone).
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The real tool result (not a guess) was appended to the conversation
    // history sent for the follow-up round.
    const followUpBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    const historyText = (followUpBody.messages as Array<{ content: string }>)
      .map(m => m.content)
      .join('\n');
    expect(historyText).toContain('read_file results for "README.md"');
    expect(historyText).toContain('A lazy but capable coding IDE.');
  });

  it('streamChatEvents: yields a running -> done read_file tool event, no directive text leaks, and the final answer is a text event', async () => {
    mockExecuteTool.mockResolvedValueOnce('# Lazy IDE\nA lazy but capable coding IDE.');

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, body: makeStream('READ_FILE: README.md\n') } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, body: makeStream('The README describes Lazy IDE.\n') } as unknown as Response);
    global.fetch = fetchMock;

    const events: StreamEvent[] = [];
    for await (const event of managedProvider.managedProvider.streamChatEvents!(baseReq)) {
      events.push(event);
    }

    const toolEvents = events.filter(e => e.type === 'tool');
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]).toMatchObject({ status: 'running', name: 'read_file', input: { path: 'README.md' } });
    expect(toolEvents[1]).toMatchObject({ status: 'done', name: 'read_file' });
    expect(toolEvents[1].id).toBe(toolEvents[0].id);

    const text = events
      .filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text')
      .map(e => e.text)
      .join('');
    expect(text).not.toContain('READ_FILE:');
    expect(text).toContain('The README describes Lazy IDE.');

    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
  });

  it('does not execute the tool or force a follow-up round when the model answers directly (no directive)', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeStream('The README describes Lazy IDE without needing to read it again.'),
    } as unknown as Response);

    const chunks = await collect(managedProvider.managedProvider.streamChat(baseReq));

    expect(chunks.join('')).toContain('The README describes Lazy IDE');
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });
});
