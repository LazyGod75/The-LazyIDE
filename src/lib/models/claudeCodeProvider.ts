/* claudeCodeProvider — streaming adapter via the Claude Code CLI (subscription auth).
   Calls the Tauri `claude_chat_stream` command; yields text chunks as AsyncIterable<string>.
   No API key needed: the CLI reads the user's Claude subscription from the OS keychain.
*/

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ModelProvider, ModelInfo, StreamChatRequest, StreamEvent } from './types.js';
import { ALL_MODELS } from './registry.js';
import { addUsage } from './costStore.js';
import { buildSystemPrompt } from './systemPrompts.js';
import { loadAccessSettings } from './accessSettings.js';
import { emit } from '../bus.js';
import { withAssistantToolLoop as withBrainSearchLoop, withAssistantToolLoopEvents as withBrainSearchLoopEvents } from './assistantToolLoop.js';
import { createActivityWatchdog } from './activityWatchdog.js';

// ── Helpers ─────────────────────────────────────────────────────────

function generateId(): string {
  return `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Usage payload from model://done ──────────────────────────────

interface DonePayload {
  inputTokens: number;
  outputTokens: number;
}

// ── Action payload from model://action ───────────────────────────

interface ActionPayload {
  tool: string;
  file: string | null;
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// ── Tool action -> StreamEvent (structured-events path only) ──────
//
// GAP 2 fix: chat.rs no longer splices a "-> Tool `file`" annotation into
// the visible model://chunk text stream (see chat.rs's claude_chat_stream_inner
// doc comment) — it only emits the structured model://action event, which
// this file already listens to (see buildRunTurn's actionUnsub) for the
// editor:openFile side effect. streamChatEventsImpl additionally turns each
// action into a 'tool' StreamEvent pair so the assistant chat can render it
// as a distinct step, matching brain_search's existing running -> done
// pattern (see brainSearchLoop.ts's withBrainSearchLoopEvents).
//
// Rust only signals a tool_use ONCE (when the CLI's stream-json line
// mentions it) — there is no separate "tool finished" event from the CLI
// subprocess, so 'done' follows 'running' immediately rather than tracking
// real completion. This is disclosed, not fabricated: two distinct `yield`s
// still produce two distinct state updates in the consumer (assistantStore.tsx),
// so the step visibly transitions running -> done instead of only ever
// appearing "done".

function generateToolEventId(): string {
  return `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Converts one model://action payload into its running/done StreamEvent
 *  pair, sharing one id so applyStreamEvent's reducer replaces (not
 *  duplicates) the step in place. */
function toolActionToEvents(action: ActionPayload): [StreamEvent, StreamEvent] {
  const id = generateToolEventId();
  const input = { file: action.file };
  return [
    { type: 'tool', id, name: action.tool, input, status: 'running' },
    { type: 'tool', id, name: action.tool, input, status: 'done' },
  ];
}

// ── Async queue helper (same pattern as anthropicProvider) ────────

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
  const waiting: Array<{ resolve: (r: IteratorResult<string>) => void; reject: (e: Error) => void }> = [];
  let done = false;
  let error: Error | null = null;

  function drainNext(w: { resolve: (r: IteratorResult<string>) => void; reject: (e: Error) => void }): void {
    if (error) {
      w.reject(error);
      return;
    }
    if (buffer.length > 0) {
      const entry = buffer.shift()!;
      w.resolve({ value: entry.text, done: false });
    } else if (done) {
      w.resolve({ value: undefined as unknown as string, done: true });
    } else {
      waiting.push(w);
    }
  }

  return {
    push(entry: QueueEntry): void {
      if (done) return;
      if (waiting.length > 0) {
        const waiter = waiting.shift()!;
        waiter.resolve({ value: entry.text, done: false });
      } else {
        buffer.push(entry);
      }
    },

    close(): void {
      done = true;
      for (const waiter of waiting) {
        waiter.resolve({ value: undefined as unknown as string, done: true });
      }
      waiting.length = 0;
    },

    reject(err: Error): void {
      error = err;
      done = true;
      for (const waiter of waiting) {
        waiter.reject(err);
      }
      waiting.length = 0;
    },

    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        next(): Promise<IteratorResult<string>> {
          if (error) return Promise.reject(error);
          return new Promise<IteratorResult<string>>((resolve, reject) => drainNext({ resolve, reject }));
        },
      };
    },
  };
}

// ── streamChat implementation ────────────────────────────────────

/**
 * Builds the single-turn helper — called once per ReAct round with the
 * round's messages. A fresh id is generated on each call so Tauri events
 * never cross-talk. Factored out of streamChatImpl so BOTH the plain
 * string path (withBrainSearchLoop, below) and the structured-events path
 * (withBrainSearchLoopEvents, streamChatEventsImpl) share this exact same
 * Tauri event-listener wiring instead of maintaining two copies of it.
 *
 * @param onToolAction  Optional hook fired synchronously for EVERY
 *   model://action occurrence (all tools, not just FILE_TOOLS) — used only
 *   by streamChatEventsImpl to surface tool calls as 'tool' StreamEvents.
 *   Omitted by the plain string path (streamChatImpl), which never produces
 *   tool-call events. Does not change the editor:openFile side effect below,
 *   which stays unconditional for both callers.
 */
function buildRunTurn(
  req: StreamChatRequest,
  system: string,
  onToolAction?: (action: ActionPayload) => void,
): (turnMessages: Array<{ role: string; content: string }>) => AsyncGenerator<string> {
  return async function* runTurn(
    turnMessages: Array<{ role: string; content: string }>,
  ): AsyncGenerator<string> {
    const id = generateId();
    const queue = createQueue();
    const unlisteners: Array<() => void> = [];

    // Activity-based watchdog (replaces a fixed total-turn timeout — see
    // activityWatchdog.ts's doc comment for the full root-cause story).
    // ping() is called below on EVERY raw Tauri event this turn receives —
    // chunk (text/thinking) AND action (native CLI tool_use) — so a CLI
    // that is genuinely working (e.g. a Bash/Read round trip before it can
    // answer) is never mistaken for a dead one. onTimeout rejects the SAME
    // queue the model://error handler already rejects on, which unblocks
    // the `for await` below immediately instead of leaving it waiting on an
    // entry that will never arrive.
    const watchdog = createActivityWatchdog({
      signal: req.signal,
      onTimeout: (err) => queue.reject(err),
    });

    const chunkUnsub = await listen<string>(`model://chunk/${id}`, event => {
      watchdog.ping();
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
      queue.reject(new Error(event.payload ?? 'Claude Code stream error'));
    });
    unlisteners.push(errorUnsub);

    const actionUnsub = await listen<ActionPayload>(`model://action/${id}`, event => {
      watchdog.ping();
      const action = event.payload;
      if (FILE_TOOLS.has(action.tool) && action.file !== null) {
        emit('editor:openFile', { path: action.file });
      }
      onToolAction?.(action);
    });
    unlisteners.push(actionUnsub);

    invoke('claude_chat_stream', {
      req: {
        id,
        model: req.model.id,
        system,
        messages: turnMessages,
        mode: req.mode,
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
      watchdog.dispose();
      for (const unsub of unlisteners) {
        unsub();
      }
    }
  };
}

async function* streamChatImpl(req: StreamChatRequest): AsyncIterable<string> {
  const settings = loadAccessSettings();
  const system = buildSystemPrompt(req.mode, req.brainRecall, {
    rulesContext: req.rulesContext,
    startupContext: req.startupContext,
    skillContext: req.skillContext,
    tools: req.tools,
    supportsToolLoop: true,
    outputStyles: settings.outputStyles,
  });

  yield* withBrainSearchLoop(req, buildRunTurn(req, system));
}

/** Structured-event counterpart to streamChatImpl — see
 *  withBrainSearchLoopEvents' doc comment. Used only by assistantStore.tsx.
 *
 *  Additionally surfaces tool_use actions (GAP 2 fix): buildRunTurn's
 *  onToolAction hook captures each model://action into toolEvents (a
 *  running+done StreamEvent pair per occurrence — see toolActionToEvents),
 *  which this generator drains just before yielding the next text/thinking
 *  event from the underlying loop, plus a final drain after it completes.
 *  This keeps a tool step positioned close to where it occurred in the raw
 *  stream without requiring withBrainSearchLoopEvents (shared with
 *  anthropicProvider/cliBackendProvider, and NOT owned by this fix) to know
 *  anything about tool actions at all. */
async function* streamChatEventsImpl(req: StreamChatRequest): AsyncGenerator<StreamEvent> {
  const settings = loadAccessSettings();
  const system = buildSystemPrompt(req.mode, req.brainRecall, {
    rulesContext: req.rulesContext,
    startupContext: req.startupContext,
    skillContext: req.skillContext,
    tools: req.tools,
    supportsToolLoop: true,
    outputStyles: settings.outputStyles,
  });

  const toolEvents: StreamEvent[] = [];
  const onToolAction = (action: ActionPayload): void => {
    toolEvents.push(...toolActionToEvents(action));
  };

  const runTurn = buildRunTurn(req, system, onToolAction);
  for await (const event of withBrainSearchLoopEvents(req, runTurn)) {
    while (toolEvents.length > 0) yield toolEvents.shift()!;
    yield event;
  }
  while (toolEvents.length > 0) yield toolEvents.shift()!;
}

// ── ModelProvider export ─────────────────────────────────────────

export const claudeCodeProvider: ModelProvider = {
  id: 'claude-code',
  label: 'Claude Code (abonnement)',

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

/** Check (async, Tauri-side) whether the claude CLI is available. */
export async function isClaudeCodeAvailable(): Promise<boolean> {
  try {
    const available = await invoke<boolean>('claude_available');
    return available;
  } catch {
    return false;
  }
}

// ── Standalone agent/manager turn streaming ────────────────────────

export interface ClaudeCodeTurnOpts {
  messages: Array<{ role: string; content: string }>;
  system: string;
  model: string;
  signal?: AbortSignal;
}

/**
 * Stream a single turn via the Claude Code CLI (subscription auth).
 * Same protocol as streamManagedAgentTurn but uses the user's Claude
 * subscription instead of OpenRouter — no API key or Pro subscription needed.
 *
 * Yields text chunks as AsyncIterable<string>.
 */
export async function* streamClaudeCodeTurn(
  opts: ClaudeCodeTurnOpts,
): AsyncIterable<string> {
  const id = generateId();
  const queue = createQueue();
  const unlisteners: Array<() => void> = [];

  const chunkUnsub = await listen<string>(`model://chunk/${id}`, (event) => {
    queue.push({ type: 'chunk', text: event.payload });
  });
  unlisteners.push(chunkUnsub);

  const doneUnsub = await listen<DonePayload>(`model://done/${id}`, (event) => {
    const usage = event.payload;
    if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
      addUsage({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        model: opts.model,
      });
    }
    queue.close();
  });
  unlisteners.push(doneUnsub);

  const errorUnsub = await listen<string>(`model://error/${id}`, (event) => {
    queue.reject(new Error(event.payload ?? 'Claude Code stream error'));
  });
  unlisteners.push(errorUnsub);

  // Abort signal: reject the queue immediately if the signal fires, and
  // best-effort tree-kill the Rust-side `claude` CLI child so a timed-out
  // turn (LazyManager's per-turn AbortController) doesn't leave an orphaned
  // process burning the user's Claude subscription quota — the queue reject
  // above only ever stopped the LOCAL consumer, never the actual child
  // process (see claude_chat_stream_cancel's doc comment in chat.rs). Fired
  // from an abort path with no user-facing recovery, so the invoke() call is
  // never awaited and any failure is swallowed silently.
  if (opts.signal) {
    const onAbort = () => {
      queue.reject(new Error('Stream aborted (timeout)'));
      invoke('claude_chat_stream_cancel', { id }).catch(() => {});
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    unlisteners.push(() => opts.signal?.removeEventListener('abort', onAbort));
  }

  invoke('claude_chat_stream', {
    req: {
      id,
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      mode: 'ask',
    },
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    queue.reject(new Error(msg));
  });

  try {
    for await (const chunk of queue) {
      if (opts.signal?.aborted) break;
      yield chunk;
    }
  } finally {
    for (const unsub of unlisteners) {
      unsub();
    }
  }
}
