/* cliBackendProvider — generic factory for agent-CLI streaming backends.
   Supports 'claude' (Claude Code subscription) and 'codex' (OpenAI Codex CLI).
   Each backend invokes the Tauri `agent_cli_chat_stream` command and yields
   text chunks via the same model:// event protocol.
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

// ── Async queue (identical pattern to claudeCodeProvider) ─────────

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

// ── Interface for done payload ─────────────────────────────────────

interface DonePayload {
  inputTokens: number;
  outputTokens: number;
}

// ── Action payload from model://action ────────────────────────────

interface ActionPayload {
  tool: string;
  file: string | null;
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// ── Tool action -> StreamEvent (structured-events path only) ──────
//
// GAP 2 fix: for the 'claude' backend, chat.rs no longer splices a
// "-> Tool `file`" annotation into the visible model://chunk text stream
// (see chat.rs's claude_chat_stream_inner doc comment) — it only emits the
// structured model://action event, which this file already listens to (see
// buildRunTurn's actionUnsub) for the editor:openFile side effect.
// streamChatEventsImpl additionally turns each action into a 'tool'
// StreamEvent pair so the assistant chat can render it as a distinct step,
// matching brain_search's existing running -> done pattern (see
// brainSearchLoop.ts's withBrainSearchLoopEvents). Inert for the 'codex'
// backend, which never emits model://action (codex_chat_stream_inner has no
// tool_use handling) — this listener simply never fires for it.
//
// Identical pattern to claudeCodeProvider.ts's toolActionToEvents; kept as a
// separate (small) copy rather than a shared import, consistent with this
// module's existing duplication of buildRunTurn/createQueue across the
// three CLI-backed providers (see those functions' own doc comments).

// ── streamChat implementation ─────────────────────────────────────

function generateId(tool: string): string {
  return `${tool}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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
 *   Omitted by the plain string path (streamChatImpl). Does not change the
 *   editor:openFile side effect below, which stays unconditional for both
 *   callers.
 */
function buildRunTurn(
  tool: string,
  req: StreamChatRequest,
  system: string,
  onToolAction?: (action: ActionPayload) => void,
): (turnMessages: Array<{ role: string; content: string }>) => AsyncGenerator<string> {
  return async function* runTurn(
    turnMessages: Array<{ role: string; content: string }>,
  ): AsyncGenerator<string> {
    const id = generateId(tool);
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
      queue.reject(new Error(event.payload ?? `${tool} CLI stream error`));
    });
    unlisteners.push(errorUnsub);

    const actionUnsub = await listen<ActionPayload>(`model://action/${id}`, event => {
      const action = event.payload;
      if (FILE_TOOLS.has(action.tool) && action.file !== null) {
        emit('editor:openFile', { path: action.file });
      }
      onToolAction?.(action);
    });
    unlisteners.push(actionUnsub);

    // Abort signal: reject the queue immediately if the signal fires, and
    // best-effort tree-kill the Rust-side CLI child (claude or codex,
    // whichever `tool` this turn is running) so a timed-out turn
    // (LazyManager's per-turn AbortController) doesn't leave an orphaned
    // process burning the user's subscription quota — the queue reject
    // above only ever stopped the LOCAL consumer, never the actual child
    // process. Previously wired for the 'claude' backend only, via
    // claudeCodeProvider.ts's streamClaudeCodeTurn; this rail (used for both
    // backends' streamChat/streamChatEvents, and the ONLY codex path — see
    // managerEngine.ts's buildCodexStreamRequest doc comment) never called
    // anything, so a codex abort/timeout left its `codex` CLI child running
    // to completion. `${tool}_chat_stream_cancel` follows the naming
    // convention Rust registers for both backends (see chat.rs's
    // claude_chat_stream_cancel / codex_chat_stream_cancel). Fired from an
    // abort path with no user-facing recovery: never awaited, and any
    // failure (including an unknown tool id) is swallowed silently.
    if (req.signal) {
      const onAbort = (): void => {
        queue.reject(new Error('Stream aborted (timeout)'));
        invoke(`${tool}_chat_stream_cancel`, { id }).catch(() => {});
      };
      req.signal.addEventListener('abort', onAbort, { once: true });
      unlisteners.push(() => req.signal?.removeEventListener('abort', onAbort));
    }

    invoke('agent_cli_chat_stream', {
      req: {
        tool,
        id,
        model: req.model.id || undefined,
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
      for (const unsub of unlisteners) {
        unsub();
      }
    }
  };
}

async function* streamChatImpl(tool: string, req: StreamChatRequest): AsyncIterable<string> {
  const settings = loadAccessSettings();
  const system = buildSystemPrompt(req.mode, req.brainRecall, {
    rulesContext: req.rulesContext,
    startupContext: req.startupContext,
    skillContext: req.skillContext,
    tools: req.tools,
    supportsToolLoop: true,
    outputStyles: settings.outputStyles,
  });

  yield* withBrainSearchLoop(req, buildRunTurn(tool, req, system));
}

/** Structured-event counterpart to streamChatImpl — see
 *  withBrainSearchLoopEvents' doc comment. Used only by assistantStore.tsx.
 *
 *  Additionally surfaces tool_use actions (GAP 2 fix, 'claude' backend
 *  only — see the module-level comment above toolActionToEvents):
 *  buildRunTurn's onToolAction hook captures each model://action into
 *  toolEvents (a running+done StreamEvent pair per occurrence), which this
 *  generator drains just before yielding the next text/thinking event from
 *  the underlying loop, plus a final drain after it completes. */
async function* streamChatEventsImpl(tool: string, req: StreamChatRequest): AsyncGenerator<StreamEvent> {
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

  const runTurn = buildRunTurn(tool, req, system, onToolAction);
  for await (const event of withBrainSearchLoopEvents(req, runTurn)) {
    while (toolEvents.length > 0) yield toolEvents.shift()!;
    yield event;
  }
  while (toolEvents.length > 0) yield toolEvents.shift()!;
}

// ── Backend registry ──────────────────────────────────────────────

export interface CliBackendEntry {
  id: string;
  label: string;
  /** Tauri command name used to check availability. */
  detect: () => Promise<boolean>;
}

export const CLI_BACKENDS: CliBackendEntry[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    detect: async () => {
      try {
        const available = await invoke<boolean>('claude_available');
        return available;
      } catch {
        return false;
      }
    },
  },
  {
    id: 'codex',
    label: 'Codex (OpenAI)',
    detect: async () => {
      try {
        const available = await invoke<boolean>('agent_cli_available', { tool: 'codex' });
        return available;
      } catch {
        return false;
      }
    },
  },
];

// ── Factory ───────────────────────────────────────────────────────

/**
 * Returns a ModelProvider backed by the given CLI tool.
 * tool: 'claude' | 'codex' (extensible)
 */
export function cliBackendProvider(tool: string): ModelProvider {
  const entry = CLI_BACKENDS.find(b => b.id === tool);
  const label = entry ? entry.label : tool;

  return {
    id: `cli-${tool}`,
    label: `${label} (CLI)`,

    listModels(): ModelInfo[] {
      // Claude backend -> Anthropic models. Codex -> always [] and NOT a
      // bug: ALL_MODELS is Anthropic-only (registry.ts's module comment —
      // the OpenAI/Google stubs were removed), so there is no in-app
      // catalog to filter down to. The Codex CLI manages its own model
      // selection; see modelPickerOptions.ts's MODEL_MANAGED_BY_CODEX_MESSAGE
      // for how the UI represents this honestly instead of a fake empty
      // "no models configured" state.
      if (tool === 'claude') return ALL_MODELS.filter(m => m.provider === 'anthropic');
      if (tool === 'codex')  return [];
      return ALL_MODELS;
    },

    streamChat(req: StreamChatRequest): AsyncIterable<string> {
      return streamChatImpl(tool, req);
    },

    streamChatEvents(req: StreamChatRequest): AsyncIterable<StreamEvent> {
      return streamChatEventsImpl(tool, req);
    },
  };
}

/** Availability cache keyed by tool id (populated once at startup). */
const _cliAvailability: Record<string, boolean | null> = {};

/** Call once at startup to cache CLI availability for all registered backends. */
export async function detectAllCliBackends(): Promise<void> {
  await Promise.all(
    CLI_BACKENDS.map(async entry => {
      try {
        _cliAvailability[entry.id] = await entry.detect();
      } catch {
        _cliAvailability[entry.id] = false;
      }
    }),
  );
}

/** Synchronous read of cached CLI availability (null = not yet checked). */
export function isCliBackendAvailable(tool: string): boolean | null {
  return _cliAvailability[tool] ?? null;
}
