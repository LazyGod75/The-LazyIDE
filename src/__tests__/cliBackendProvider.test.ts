/* cliBackendProvider.test.ts
   Proves the Rust -> Tauri -> TS plumbing for the 'claude' CLI backend
   (cliBackendProvider('claude')), which shares chat.rs's
   claude_chat_stream_inner with claudeCodeProvider.ts via the generic
   agent_cli_chat_stream Tauri command — see chat.rs's agent_cli_chat_stream
   dispatcher. Mirrors claudeCodeProvider.test.ts's two gaps; kept as a
   separate file/copy rather than shared test helpers, consistent with this
   module's own existing duplication of buildRunTurn/createQueue (see
   cliBackendProvider.ts's doc comments).

   GAP 1 (thinking dropped) and GAP 2 (tool narration smeared into text) —
   see claudeCodeProvider.test.ts's module doc comment for the full
   explanation; identical mechanism, different Tauri command name
   (agent_cli_chat_stream vs claude_chat_stream) and request shape (adds a
   `tool` field).

   The 'codex' backend is NOT covered here: codex_chat_stream_inner has no
   tool_use handling and never emits model://action, so GAP 2 is inert for
   it (see cliBackendProvider.ts's module comment above toolActionToEvents).
   listModels/isCliBackendAvailable coverage for both backends already
   exists in modelsIndex.test.ts.
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { on } from '../lib/bus';
import type { StreamChatRequest, StreamEvent } from '../lib/models/types';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedListen = listen as ReturnType<typeof vi.fn>;

type PayloadHandler = (event: { payload: unknown }) => void;

function installListenCapture(): Map<string, PayloadHandler> {
  const handlers = new Map<string, PayloadHandler>();
  mockedListen.mockImplementation((eventName: string, handler: PayloadHandler) => {
    handlers.set(eventName, handler);
    return Promise.resolve(() => { handlers.delete(eventName); });
  });
  return handlers;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

const baseReq: StreamChatRequest = {
  messages: [{ id: 'u1', role: 'user', content: 'hi' }],
  model: { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic', description: '' },
  mode: 'ask',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cliBackendProvider('claude').streamChatEvents — GAP 1 (thinking marker forwarding)", () => {
  it('turns a \\x1b[reasoning] marker line on model://chunk into a thinking StreamEvent', async () => {
    const handlers = installListenCapture();

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'agent_cli_chat_stream') {
        const req = args?.req as { id: string; tool: string } | undefined;
        const id = req?.id;
        if (id && req?.tool === 'claude') {
          handlers.get(`model://chunk/${id}`)?.({
            payload: '\x1b[reasoning]I should check the docs first.\n',
          });
          handlers.get(`model://chunk/${id}`)?.({ payload: 'The answer is 42.\n' });
          handlers.get(`model://done/${id}`)?.({ payload: { inputTokens: 0, outputTokens: 0 } });
        }
      }
      return Promise.resolve(undefined);
    });

    const { cliBackendProvider } = await import('../lib/models/cliBackendProvider');
    const provider = cliBackendProvider('claude');
    const events = await collect<StreamEvent>(provider.streamChatEvents!(baseReq));

    const thinking = events.filter((e): e is Extract<StreamEvent, { type: 'thinking' }> => e.type === 'thinking');
    const text = events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text');

    expect(thinking.map(e => e.text).join('')).toBe('I should check the docs first.');
    expect(text.map(e => e.text).join('')).toContain('The answer is 42.');
    expect(text.some(e => e.text.includes('\x1b'))).toBe(false);
  });
});

describe("cliBackendProvider('claude').streamChatEvents — GAP 2 (tool actions as typed events)", () => {
  it('emits a running -> done tool StreamEvent from model://action, with no "-> Tool" text smeared into the answer', async () => {
    const handlers = installListenCapture();

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'agent_cli_chat_stream') {
        const req = args?.req as { id: string; tool: string } | undefined;
        const id = req?.id;
        if (id && req?.tool === 'claude') {
          handlers.get(`model://action/${id}`)?.({ payload: { tool: 'Edit', file: '/src/foo.ts' } });
          handlers.get(`model://chunk/${id}`)?.({ payload: 'Done, updated the file.\n' });
          handlers.get(`model://done/${id}`)?.({ payload: { inputTokens: 0, outputTokens: 0 } });
        }
      }
      return Promise.resolve(undefined);
    });

    const { cliBackendProvider } = await import('../lib/models/cliBackendProvider');
    const provider = cliBackendProvider('claude');
    const events = await collect<StreamEvent>(provider.streamChatEvents!(baseReq));

    const toolEvents = events.filter((e): e is Extract<StreamEvent, { type: 'tool' }> => e.type === 'tool');
    const text = events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text');

    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]).toMatchObject({ name: 'Edit', input: { file: '/src/foo.ts' }, status: 'running' });
    expect(toolEvents[1]).toMatchObject({ name: 'Edit', input: { file: '/src/foo.ts' }, status: 'done' });
    expect(toolEvents[1].id).toBe(toolEvents[0].id);

    expect(text.map(e => e.text).join('')).toContain('Done, updated the file.');
    expect(text.some(e => e.text.includes('→'))).toBe(false);
  });

  it('still fires editor:openFile for a FILE_TOOLS action (unchanged side effect)', async () => {
    const handlers = installListenCapture();
    const opened: Array<{ path: string }> = [];
    const unsub = on('editor:openFile', (payload) => opened.push(payload));

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'agent_cli_chat_stream') {
        const req = args?.req as { id: string; tool: string } | undefined;
        const id = req?.id;
        if (id && req?.tool === 'claude') {
          handlers.get(`model://action/${id}`)?.({ payload: { tool: 'MultiEdit', file: '/src/new.ts' } });
          handlers.get(`model://done/${id}`)?.({ payload: { inputTokens: 0, outputTokens: 0 } });
        }
      }
      return Promise.resolve(undefined);
    });

    try {
      const { cliBackendProvider } = await import('../lib/models/cliBackendProvider');
      const provider = cliBackendProvider('claude');
      await collect<StreamEvent>(provider.streamChatEvents!(baseReq));
      expect(opened).toEqual([{ path: '/src/new.ts' }]);
    } finally {
      unsub();
    }
  });

  it('the plain-string streamChat path stays clean too (no "-> Tool" annotation, regression guard)', async () => {
    const handlers = installListenCapture();

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'agent_cli_chat_stream') {
        const req = args?.req as { id: string; tool: string } | undefined;
        const id = req?.id;
        if (id && req?.tool === 'claude') {
          handlers.get(`model://action/${id}`)?.({ payload: { tool: 'Edit', file: '/src/foo.ts' } });
          handlers.get(`model://chunk/${id}`)?.({ payload: 'Done, updated the file.\n' });
          handlers.get(`model://done/${id}`)?.({ payload: { inputTokens: 0, outputTokens: 0 } });
        }
      }
      return Promise.resolve(undefined);
    });

    const { cliBackendProvider } = await import('../lib/models/cliBackendProvider');
    const provider = cliBackendProvider('claude');
    const chunks = await collect<string>(provider.streamChat(baseReq));
    const combined = chunks.join('');

    expect(combined).toContain('Done, updated the file.');
    expect(combined).not.toContain('→');
  });
});
