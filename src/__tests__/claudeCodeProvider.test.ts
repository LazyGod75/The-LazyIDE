/* claudeCodeProvider.test.ts
   Proves the Rust -> Tauri -> TS plumbing for the two gaps fixed alongside
   the assistant chat's structured streamChatEvents channel, on the Claude
   Code CLI subscription path (chat.rs's claude_chat_stream_inner).

   GAP 1 (thinking dropped): chat.rs now forwards extended-thinking text as
   \x1b[reasoning]-marker-prefixed lines on the SAME model://chunk event
   used for visible text (see chat.rs's extract_thinking_from_stream_json +
   mark_reasoning_lines). This test proves streamChatEvents correctly turns
   a marker line arriving on model://chunk into a 'thinking' StreamEvent,
   using the EXISTING extractThinkingText/stripInvisibleLines machinery
   (brainSearchLoop.ts, streamEvents.ts) — zero new TS convention needed,
   confirming those helpers require no changes for this fix.

   GAP 2 (tool narration smeared into text): chat.rs no longer splices a
   "-> Tool `file`" annotation into model://chunk; it only emits the
   structured model://action event (unchanged). This test proves
   claudeCodeProvider.ts's buildRunTurn/streamChatEventsImpl turns that
   event into a running -> done 'tool' StreamEvent, and that editor:openFile
   still fires unconditionally for both the string and events consumers,
   matching the pre-existing contract.

   Honest limitation: this proves the TS-side plumbing is correct GIVEN a
   simulated Rust chunk/action stream. It does NOT prove the real `claude`
   CLI actually emits a "thinking" content block in stream-json for the
   configured model — that can only be verified against the real
   CLI/subscription (see the final report's risk notes).
*/

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { on } from '../lib/bus';
import { StreamTimeoutError } from '../lib/models/streamTimeout';
import type { StreamChatRequest, StreamEvent } from '../lib/models/types';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedListen = listen as ReturnType<typeof vi.fn>;

type PayloadHandler = (event: { payload: unknown }) => void;

/** Captures listen() handlers by event name so the test can fire them
 *  manually — mirrors the global @tauri-apps/api/event mock (setup.ts),
 *  which never calls handlers on its own. Same pattern as
 *  runtimeRetry.test.ts's handler capture against a different
 *  Tauri-event-driven module. */
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

describe('claudeCodeProvider.streamChatEvents — GAP 1 (thinking marker forwarding)', () => {
  it('turns a \\x1b[reasoning] marker line on model://chunk into a thinking StreamEvent, kept out of the text events', async () => {
    const handlers = installListenCapture();

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'claude_chat_stream') {
        const req = args?.req as { id: string } | undefined;
        const id = req?.id;
        if (id) {
          // Simulates chat.rs's claude_chat_stream_inner forwarding a
          // complete extended-thinking block (mark_reasoning_lines' output)
          // followed by the visible answer text, then done.
          handlers.get(`model://chunk/${id}`)?.({
            payload: '\x1b[reasoning]I should check the docs first.\n',
          });
          handlers.get(`model://chunk/${id}`)?.({ payload: 'The answer is 42.\n' });
          handlers.get(`model://done/${id}`)?.({ payload: { inputTokens: 0, outputTokens: 0 } });
        }
      }
      return Promise.resolve(undefined);
    });

    const { claudeCodeProvider } = await import('../lib/models/claudeCodeProvider');
    const events = await collect<StreamEvent>(claudeCodeProvider.streamChatEvents!(baseReq));

    const thinking = events.filter((e): e is Extract<StreamEvent, { type: 'thinking' }> => e.type === 'thinking');
    const text = events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text');

    expect(thinking.map(e => e.text).join('')).toBe('I should check the docs first.');
    expect(text.map(e => e.text).join('')).toContain('The answer is 42.');
    // Reasoning text/marker must never also leak into a text event.
    expect(text.some(e => e.text.includes('reasoning'))).toBe(false);
    expect(text.some(e => e.text.includes('\x1b'))).toBe(false);
  });

  it('is a no-op (only text events) when no reasoning marker is present', async () => {
    const handlers = installListenCapture();

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'claude_chat_stream') {
        const req = args?.req as { id: string } | undefined;
        const id = req?.id;
        if (id) {
          handlers.get(`model://chunk/${id}`)?.({ payload: 'Plain answer, no reasoning.\n' });
          handlers.get(`model://done/${id}`)?.({ payload: { inputTokens: 0, outputTokens: 0 } });
        }
      }
      return Promise.resolve(undefined);
    });

    const { claudeCodeProvider } = await import('../lib/models/claudeCodeProvider');
    const events = await collect<StreamEvent>(claudeCodeProvider.streamChatEvents!(baseReq));

    expect(events.every(e => e.type === 'text')).toBe(true);
    expect(events.map(e => (e.type === 'text' ? e.text : '')).join('')).toContain('Plain answer, no reasoning.');
  });
});

describe('claudeCodeProvider.streamChatEvents — GAP 2 (tool actions as typed events)', () => {
  it('emits a running -> done tool StreamEvent from model://action, with no "-> Tool" text smeared into the answer', async () => {
    const handlers = installListenCapture();

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'claude_chat_stream') {
        const req = args?.req as { id: string } | undefined;
        const id = req?.id;
        if (id) {
          // Simulates the FIXED chat.rs: model://action fires for the
          // tool_use, but chunk_event carries ONLY the visible answer text
          // — no "-> Edit `foo.ts`" annotation spliced in.
          handlers.get(`model://action/${id}`)?.({ payload: { tool: 'Edit', file: '/src/foo.ts' } });
          handlers.get(`model://chunk/${id}`)?.({ payload: 'Done, updated the file.\n' });
          handlers.get(`model://done/${id}`)?.({ payload: { inputTokens: 0, outputTokens: 0 } });
        }
      }
      return Promise.resolve(undefined);
    });

    const { claudeCodeProvider } = await import('../lib/models/claudeCodeProvider');
    const events = await collect<StreamEvent>(claudeCodeProvider.streamChatEvents!(baseReq));

    const toolEvents = events.filter((e): e is Extract<StreamEvent, { type: 'tool' }> => e.type === 'tool');
    const text = events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text');

    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]).toMatchObject({ name: 'Edit', input: { file: '/src/foo.ts' }, status: 'running' });
    expect(toolEvents[1]).toMatchObject({ name: 'Edit', input: { file: '/src/foo.ts' }, status: 'done' });
    // Same id across the running -> done transition, so the UI updates the
    // SAME step in place instead of appending a second one.
    expect(toolEvents[1].id).toBe(toolEvents[0].id);

    expect(text.map(e => e.text).join('')).toContain('Done, updated the file.');
    expect(text.some(e => e.text.includes('→'))).toBe(false);
    expect(text.some(e => e.text.includes('Edit'))).toBe(false);
  });

  it('still fires editor:openFile for a FILE_TOOLS action (unchanged side effect)', async () => {
    const handlers = installListenCapture();
    const opened: Array<{ path: string }> = [];
    const unsub = on('editor:openFile', (payload) => opened.push(payload));

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'claude_chat_stream') {
        const req = args?.req as { id: string } | undefined;
        const id = req?.id;
        if (id) {
          handlers.get(`model://action/${id}`)?.({ payload: { tool: 'Write', file: '/src/new.ts' } });
          handlers.get(`model://done/${id}`)?.({ payload: { inputTokens: 0, outputTokens: 0 } });
        }
      }
      return Promise.resolve(undefined);
    });

    try {
      const { claudeCodeProvider } = await import('../lib/models/claudeCodeProvider');
      await collect<StreamEvent>(claudeCodeProvider.streamChatEvents!(baseReq));
      expect(opened).toEqual([{ path: '/src/new.ts' }]);
    } finally {
      unsub();
    }
  });

  it('does not fire editor:openFile for a non-file tool (e.g. Grep), but still emits a tool StreamEvent', async () => {
    const handlers = installListenCapture();
    const opened: Array<{ path: string }> = [];
    const unsub = on('editor:openFile', (payload) => opened.push(payload));

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'claude_chat_stream') {
        const req = args?.req as { id: string } | undefined;
        const id = req?.id;
        if (id) {
          handlers.get(`model://action/${id}`)?.({ payload: { tool: 'Grep', file: null } });
          handlers.get(`model://done/${id}`)?.({ payload: { inputTokens: 0, outputTokens: 0 } });
        }
      }
      return Promise.resolve(undefined);
    });

    try {
      const { claudeCodeProvider } = await import('../lib/models/claudeCodeProvider');
      const events = await collect<StreamEvent>(claudeCodeProvider.streamChatEvents!(baseReq));

      expect(opened).toEqual([]);
      const toolEvents = events.filter((e): e is Extract<StreamEvent, { type: 'tool' }> => e.type === 'tool');
      expect(toolEvents.map(e => e.name)).toEqual(['Grep', 'Grep']);
      expect(toolEvents.map(e => e.status)).toEqual(['running', 'done']);
    } finally {
      unsub();
    }
  });

  it('the plain-string streamChat path stays clean too (no "-> Tool" annotation, regression guard)', async () => {
    const handlers = installListenCapture();

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'claude_chat_stream') {
        const req = args?.req as { id: string } | undefined;
        const id = req?.id;
        if (id) {
          handlers.get(`model://action/${id}`)?.({ payload: { tool: 'Edit', file: '/src/foo.ts' } });
          handlers.get(`model://chunk/${id}`)?.({ payload: 'Done, updated the file.\n' });
          handlers.get(`model://done/${id}`)?.({ payload: { inputTokens: 0, outputTokens: 0 } });
        }
      }
      return Promise.resolve(undefined);
    });

    const { claudeCodeProvider } = await import('../lib/models/claudeCodeProvider');
    const chunks = await collect<string>(claudeCodeProvider.streamChat(baseReq));
    const combined = chunks.join('');

    expect(combined).toContain('Done, updated the file.');
    expect(combined).not.toContain('→');
    expect(combined).not.toContain('Edit');
  });
});

// ── W-ANSWERPATH: activity watchdog wired into buildRunTurn ────────────────
//
// Regression test for the reported bug: the Code-space assistant on the
// subscription path ("Claude · abonnement") errored out with "the model
// didn't respond in time" after ~40s on a question that needed the CLI to
// actually go check something (e.g. "is lazybackoffice up, how many
// users?") — the CLI was alive and working (native tool_use via Bash/Read),
// but that activity never reset ANY timeout clock, because model://action
// events never fed the queue/timer the old fixed timeout observed. See
// activityWatchdog.ts's doc comment for the full root-cause story.
describe('claudeCodeProvider.streamChatEvents — activity watchdog (subscription-path timeout fix)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes a turn whose ONLY activity is spaced-out tool actions well past the OLD fixed 40s ceiling', async () => {
    const handlers = installListenCapture();

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'claude_chat_stream') {
        const req = args?.req as { id: string } | undefined;
        const id = req?.id;
        if (id) {
          // Three tool actions (no text at all in between) at t=20s/45s/65s —
          // each gap is comfortably under the new 60s silence window, but the
          // 65s cumulative total is well past the OLD 15s-first-token/30s-idle
          // budget that used to kill the turn regardless of this activity.
          setTimeout(() => handlers.get(`model://action/${id}`)?.({ payload: { tool: 'Bash', file: null } }), 20_000);
          setTimeout(() => handlers.get(`model://action/${id}`)?.({ payload: { tool: 'Read', file: null } }), 45_000);
          setTimeout(() => {
            handlers.get(`model://action/${id}`)?.({ payload: { tool: 'Bash', file: null } });
            handlers.get(`model://chunk/${id}`)?.({ payload: 'Oui, le lazybackoffice est fonctionnel, 12 users.\n' });
            handlers.get(`model://done/${id}`)?.({ payload: { inputTokens: 0, outputTokens: 0 } });
          }, 65_000);
        }
      }
      return Promise.resolve(undefined);
    });

    const { claudeCodeProvider } = await import('../lib/models/claudeCodeProvider');
    const collected = collect<StreamEvent>(claudeCodeProvider.streamChatEvents!(baseReq));

    await vi.advanceTimersByTimeAsync(65_000);
    const events = await collected;

    const text = events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text');
    expect(text.map(e => e.text).join('')).toContain('lazybackoffice est fonctionnel');
    const toolEvents = events.filter((e): e is Extract<StreamEvent, { type: 'tool' }> => e.type === 'tool');
    expect(toolEvents.length).toBeGreaterThan(0);
  });

  it('still errors out with StreamTimeoutError("silence") when the CLI genuinely goes silent (no chunk, no action) — the honest-failure case stays intact', async () => {
    const handlers = installListenCapture();

    mockedInvoke.mockImplementation((cmd: string, _args?: Record<string, unknown>) => {
      if (cmd === 'claude_chat_stream') {
        // Deliberately never fires any handler — simulates a truly hung/dead
        // CLI subprocess (spawn succeeded, then nothing, ever).
        void handlers;
      }
      return Promise.resolve(undefined);
    });

    const { claudeCodeProvider } = await import('../lib/models/claudeCodeProvider');
    const collected = collect<StreamEvent>(claudeCodeProvider.streamChatEvents!(baseReq));

    // Attach rejection handlers BEFORE advancing timers (same pattern as
    // streamTimeout.test.ts) so the rejection is never momentarily unhandled.
    const isTimeoutError = expect(collected).rejects.toBeInstanceOf(StreamTimeoutError);
    const hasPhase = expect(collected).rejects.toMatchObject({ phase: 'silence' });

    await vi.advanceTimersByTimeAsync(60_001); // DEFAULT_SILENCE_MS + 1

    await isTimeoutError;
    await hasPhase;
  });
});
