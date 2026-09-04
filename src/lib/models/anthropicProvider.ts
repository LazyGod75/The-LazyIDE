/* anthropicProvider — real Anthropic streaming adapter via Rust bridge.
   Calls the Tauri `model_chat_stream` command; yields text chunks as an
   AsyncIterable<string>. Falls back gracefully when not in a Tauri context.
*/

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ModelProvider, ModelInfo, StreamChatRequest, StreamEvent } from './types.js';
import { ALL_MODELS } from './registry.js';
import { addUsage } from './costStore.js';
import { buildSystemPrompt } from './systemPrompts.js';
import { loadAccessSettings } from './accessSettings.js';
import { withAssistantToolLoop as withBrainSearchLoop, withAssistantToolLoopEvents as withBrainSearchLoopEvents } from './assistantToolLoop.js';
// Secret-storage hardening (audit 2026-08-12): the Anthropic BYOK key now
// lives in the OS credential vault on desktop, not always in localStorage —
// this Tauri-only provider must read it through byokProviders.ts's
// vault-aware loadByokKey('anthropic'), not localStorage directly (that
// direct read would silently go stale for any user who has migrated).
import { loadByokKey } from './byokProviders.js';

// ── Helpers ────────────────────────────────────────────────────────

function generateId(): string {
  return `mc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadApiKey(): string {
  return loadByokKey('anthropic');
}

// ── Usage payload from model://done ──────────────────────────────

interface DonePayload {
  inputTokens: number;
  outputTokens: number;
}

// ── Async queue helper ────────────────────────────────────────────
// Bridges event-listener callbacks into an async iterator.

interface QueueEntry {
  type: 'chunk';
  text: string;
}

interface Queue {
  push: (entry: QueueEntry) => void;
  close: () => void;
  reject: (err: Error) => void;
  [Symbol.asyncIterator]: () => AsyncIterator<string>;
}

function createQueue(): Queue {
  const buffer: QueueEntry[] = [];
  const waiting: Array<(value: IteratorResult<string>) => void> = [];
  let done = false;
  let error: Error | null = null;

  function resolve(resolve_fn: (v: IteratorResult<string>) => void): void {
    if (error) {
      // Error is terminal — should not happen after done, but guard anyway
      resolve_fn({ value: undefined as unknown as string, done: true });
      return;
    }
    if (buffer.length > 0) {
      const entry = buffer.shift()!;
      resolve_fn({ value: entry.text, done: false });
    } else if (done) {
      resolve_fn({ value: undefined as unknown as string, done: true });
    } else {
      waiting.push(resolve_fn);
    }
  }

  return {
    push(entry: QueueEntry): void {
      if (done) return;
      if (waiting.length > 0) {
        const waiter = waiting.shift()!;
        waiter({ value: entry.text, done: false });
      } else {
        buffer.push(entry);
      }
    },

    close(): void {
      done = true;
      for (const waiter of waiting) {
        waiter({ value: undefined as unknown as string, done: true });
      }
      waiting.length = 0;
    },

    reject(err: Error): void {
      error = err;
      done = true;
      for (const waiter of waiting) {
        waiter({ value: undefined as unknown as string, done: true });
      }
      waiting.length = 0;
    },

    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        next(): Promise<IteratorResult<string>> {
          if (error) return Promise.reject(error);
          return new Promise<IteratorResult<string>>(resolve);
        },
      };
    },
  };
}

// ── streamChat implementation ─────────────────────────────────────

/**
 * Builds the single-turn helper — called once per ReAct round with the
 * round's messages. A fresh id is generated on each call so Tauri events
 * never cross-talk. Factored out of streamChatImpl so BOTH the plain
 * string path (withBrainSearchLoop, below) and the structured-events path
 * (withBrainSearchLoopEvents, streamChatEventsImpl) share this exact same
 * Tauri event-listener wiring instead of maintaining two copies of it.
 */
function buildRunTurn(
  req: StreamChatRequest,
  system: string,
  apiKey: string,
): (turnMessages: Array<{ role: string; content: string }>) => AsyncGenerator<string> {
  return async function* runTurn(
    turnMessages: Array<{ role: string; content: string }>,
  ): AsyncGenerator<string> {
    const id = generateId();
    const queue = createQueue();
    const unlisteners: Array<() => void> = [];

    const chunkUnsub = await listen<string>(`model://chunk/${id}`, event => {
      queue.push({ type: 'chunk', text: event.payload });
    });
    unlisteners.push(chunkUnsub);

    const doneUnsub = await listen<DonePayload>(`model://done/${id}`, event => {
      const usage = event.payload;
      if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
        addUsage({
          inputTokens:  usage.inputTokens,
          outputTokens: usage.outputTokens,
          model: req.model.id,
        });
      }
      queue.close();
    });
    unlisteners.push(doneUnsub);

    const errorUnsub = await listen<string>(`model://error/${id}`, event => {
      queue.reject(new Error(event.payload ?? 'Anthropic stream error'));
    });
    unlisteners.push(errorUnsub);

    // Fire-and-forget invoke — errors are caught via model://error event
    invoke('model_chat_stream', {
      req: {
        id,
        provider: 'anthropic',
        model: req.model.id,
        system,
        messages: turnMessages,
        apiKey: apiKey || undefined,
        maxTokens: 2048,
      },
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      queue.reject(new Error(msg));
    });

    try {
      for await (const chunk of queue) {
        if (req.signal?.aborted) break;
        yield chunk;
      }
    } finally {
      for (const unsub of unlisteners) {
        unsub();
      }
    }
  };
}

async function* streamChatImpl(req: StreamChatRequest): AsyncIterable<string> {
  const apiKey = loadApiKey();
  const settings = loadAccessSettings();
  const system = buildSystemPrompt(req.mode, req.brainRecall, {
    rulesContext: req.rulesContext,
    startupContext: req.startupContext,
    skillContext: req.skillContext,
    tools: req.tools,
    supportsToolLoop: true,
    outputStyles: settings.outputStyles,
  });

  yield* withBrainSearchLoop(req, buildRunTurn(req, system, apiKey));
}

/** Structured-event counterpart to streamChatImpl — see
 *  withBrainSearchLoopEvents' doc comment. Used only by assistantStore.tsx. */
async function* streamChatEventsImpl(req: StreamChatRequest): AsyncGenerator<StreamEvent> {
  const apiKey = loadApiKey();
  const settings = loadAccessSettings();
  const system = buildSystemPrompt(req.mode, req.brainRecall, {
    rulesContext: req.rulesContext,
    startupContext: req.startupContext,
    skillContext: req.skillContext,
    tools: req.tools,
    supportsToolLoop: true,
    outputStyles: settings.outputStyles,
  });

  yield* withBrainSearchLoopEvents(req, buildRunTurn(req, system, apiKey));
}

// ── ModelProvider export ──────────────────────────────────────────

export const anthropicProvider: ModelProvider = {
  id: 'anthropic',
  label: 'Anthropic (live)',

  listModels(): ModelInfo[] {
    return ALL_MODELS.filter(m => m.provider === 'anthropic');
  },

  streamChat(req: StreamChatRequest): AsyncIterable<string> {
    return streamChatImpl(req);
  },

  streamChatEvents(req: StreamChatRequest): AsyncIterable<StreamEvent> {
    return streamChatEventsImpl(req);
  },
};

/** True when an Anthropic API key is configured (vault on desktop,
    localStorage on web — see byokProviders.ts's hasByokKey; env-var check
    is done separately at the Rust layer). */
export function hasAnthropicKey(): boolean {
  return loadByokKey('anthropic').trim().length > 0;
}
