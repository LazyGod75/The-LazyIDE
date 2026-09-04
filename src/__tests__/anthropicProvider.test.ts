/* anthropicProvider.test.ts
   Proves the Rust -> Tauri -> TS plumbing for GAP 1 (thinking dropped) on
   the BYOK Anthropic SSE path (chat.rs's stream_anthropic / parse_anthropic_sse).

   chat.rs now forwards extended-thinking content — accumulated across
   thinking_delta SSE events and flushed once the reasoning stretch ends —
   as \x1b[reasoning]-marker-prefixed lines on the SAME model://chunk event
   used for visible text (see chat.rs's mark_reasoning_lines). This test
   proves streamChatEvents correctly turns a marker line arriving on
   model://chunk into a 'thinking' StreamEvent, using the EXISTING
   extractThinkingText/stripInvisibleLines machinery (brainSearchLoop.ts,
   streamEvents.ts) — zero new TS convention needed.

   GAP 2 (tool_use narration) does not apply to this provider: the BYOK
   Anthropic SSE path (stream_anthropic) has no tool_use handling and never
   emits model://action — anthropicProvider.ts's buildRunTurn only listens
   to chunk/done/error, confirmed by inspection (no actionUnsub here).

   Honest limitations (see the final report):
   - This proves the TS-side plumbing is correct GIVEN a simulated Rust
     chunk stream. It does not prove the LIVE Anthropic API would ever
     actually send a thinking_delta event on this path: stream_anthropic's
     request body does not set a top-level "thinking" parameter, so
     extended thinking is never requested — enabling it is a separate,
     out-of-scope product/cost decision (BYOK request bodies bill the
     user's own key), not part of this forwarding fix.
   - It does not prove parse_anthropic_sse's field-name choice
     (delta.thinking, not delta.text) against a live API response — that
     was verified against Anthropic's documented Messages API streaming
     reference instead (see chat.rs's Rust unit tests for the wire-shape
     assertions).
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
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
  model: { id: 'claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic', description: '' },
  mode: 'ask',
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('anthropicProvider.streamChatEvents — GAP 1 (thinking marker forwarding)', () => {
  it('turns a \\x1b[reasoning] marker line on model://chunk into a thinking StreamEvent, kept out of the text events', async () => {
    const handlers = installListenCapture();

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'model_chat_stream') {
        const req = args?.req as { id: string } | undefined;
        const id = req?.id;
        if (id) {
          // Simulates stream_anthropic flushing an accumulated thinking_delta
          // stretch (mark_reasoning_lines' output) once the reasoning ends,
          // immediately followed by the visible text_delta stream.
          handlers.get(`model://chunk/${id}`)?.({
            payload: '\x1b[reasoning]Let me consider the tradeoffs.\n',
          });
          handlers.get(`model://chunk/${id}`)?.({ payload: 'Here is my recommendation.\n' });
          handlers.get(`model://done/${id}`)?.({ payload: { inputTokens: 10, outputTokens: 5 } });
        }
      }
      return Promise.resolve(undefined);
    });

    const { anthropicProvider } = await import('../lib/models/anthropicProvider');
    const events = await collect<StreamEvent>(anthropicProvider.streamChatEvents!(baseReq));

    const thinking = events.filter((e): e is Extract<StreamEvent, { type: 'thinking' }> => e.type === 'thinking');
    const text = events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text');

    expect(thinking.map(e => e.text).join('')).toBe('Let me consider the tradeoffs.');
    expect(text.map(e => e.text).join('')).toContain('Here is my recommendation.');
    expect(text.some(e => e.text.includes('reasoning'))).toBe(false);
    expect(text.some(e => e.text.includes('\x1b'))).toBe(false);
  });

  it('reconstructs multi-fragment thinking text without losing inter-word spacing', async () => {
    // Regression guard mirroring chat.rs's mark_reasoning_lines_preserves_
    // internal_word_spacing Rust test: the marker line arrives as ONE
    // already-buffered chunk (Rust accumulates thinking_delta fragments
    // before marking), so no word-boundary space is lost to the TS side's
    // per-line .trim() (extractThinkingLine in streamEvents.ts).
    const handlers = installListenCapture();

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'model_chat_stream') {
        const req = args?.req as { id: string } | undefined;
        const id = req?.id;
        if (id) {
          handlers.get(`model://chunk/${id}`)?.({
            payload: '\x1b[reasoning]I should check the docs first.\n',
          });
          handlers.get(`model://done/${id}`)?.({ payload: { inputTokens: 0, outputTokens: 0 } });
        }
      }
      return Promise.resolve(undefined);
    });

    const { anthropicProvider } = await import('../lib/models/anthropicProvider');
    const events = await collect<StreamEvent>(anthropicProvider.streamChatEvents!(baseReq));
    const thinking = events.filter((e): e is Extract<StreamEvent, { type: 'thinking' }> => e.type === 'thinking');

    expect(thinking.map(e => e.text).join('')).toBe('I should check the docs first.');
  });

  it('is a no-op (only text events) when no reasoning marker is present', async () => {
    const handlers = installListenCapture();

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'model_chat_stream') {
        const req = args?.req as { id: string } | undefined;
        const id = req?.id;
        if (id) {
          handlers.get(`model://chunk/${id}`)?.({ payload: 'Plain answer, no reasoning.\n' });
          handlers.get(`model://done/${id}`)?.({ payload: { inputTokens: 0, outputTokens: 0 } });
        }
      }
      return Promise.resolve(undefined);
    });

    const { anthropicProvider } = await import('../lib/models/anthropicProvider');
    const events = await collect<StreamEvent>(anthropicProvider.streamChatEvents!(baseReq));

    expect(events.every(e => e.type === 'text')).toBe(true);
    expect(events.map(e => (e.type === 'text' ? e.text : '')).join('')).toContain('Plain answer, no reasoning.');
  });
});
