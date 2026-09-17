/* cliAgentTurnStreamer — the CLI subscription (claude / codex) as a TEXT
   backend for Lazy's own ReAct loop (planAndActManaged).

   Why this exists. The native CLI rail (planAndActLive -> agent_run) runs the
   CLI's OWN agent: its own tools (files, git, shell) inside a git worktree.
   That is the LOCAL CODE AGENT runtime. A LazyBot is not a code agent — it
   is a Solari cloud computer (cloud_browser_* / cloud_desktop_* /
   cloud_sandbox_*) and those tools only exist inside planAndActManaged. So
   when the user picked a CLI model for a bot, the CLI must serve as the
   bot's BRAIN only — one prompt in, one text reply out — which is exactly
   what PlanAndActManagedOpts.streamTurn abstracts (the BYOK rail already
   plugs in the same way, see resolveByokAgentTurnStreamer).

   Reuses the two CLI chat streamers the LazyManager already drives its own
   turns through (managerStreamCompletion.ts): streamClaudeCodeTurn for
   claude, cliBackendProvider('codex').streamChat for codex. No new
   process-spawn surface is introduced here.
*/

import type { ChatMessage, ModelInfo, StreamChatRequest } from '../models/index.js';
import { loadAccessSettings } from '../models/accessSettings.js';
import { streamClaudeCodeTurn } from '../models/claudeCodeProvider.js';
import { cliBackendProvider } from '../models/cliBackendProvider.js';
import { ALL_MODELS } from '../models/registry.js';
import { isDevinModel } from '../models/devinCatalog.js';
import type { PlanAndActManagedOpts } from './managedAgent.js';

export type CliEngineMode = 'claude-code' | 'codex' | 'devin';

export type AgentTurnStreamer = NonNullable<PlanAndActManagedOpts['streamTurn']>;

const TIER_WORD = /haiku|sonnet|opus/;

/** A brain turn that produces ZERO stream output for this long is hung —
 *  the CLI child (devin acp, claude, codex) is alive but its prompt never
 *  resolves (real incident: a `devin acp` turn sat 15+ min idle with the
 *  mission frozen). Aborting the request signal rejects the queue AND
 *  kills the Rust-side child via `*_chat_stream_cancel` (see
 *  cliBackendProvider.ts's abort wiring), so the ReAct loop records a turn
 *  failure and retries/fails over instead of waiting forever. */
const BRAIN_TURN_IDLE_TIMEOUT_MS = 240_000;

function idleWatch(parent: AbortSignal | undefined): {
  signal: AbortSignal;
  ping(): void;
  dispose(): void;
} {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(
      () => ctrl.abort(new Error(`CLI brain turn produced no output for ${BRAIN_TURN_IDLE_TIMEOUT_MS / 1000}s — aborting the hung stream`)),
      BRAIN_TURN_IDLE_TIMEOUT_MS,
    );
  };
  const onParent = (): void => ctrl.abort(parent?.reason);
  if (parent?.aborted) onParent();
  else parent?.addEventListener('abort', onParent, { once: true });
  arm();
  return {
    signal: ctrl.signal,
    ping: arm,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParent);
    },
  };
}

/** Drives `stream` to completion, resetting the shared idle watchdog on
 *  every chunk so a slow-but-alive turn never trips it — only a truly
 *  silent stream (spawn hang, dead transport, model queue stuck) gets
 *  killed. The watch is created by the caller so its signal is the one
 *  wired into the request. */
async function* withIdleTimeout(
  stream: AsyncIterable<string>,
  idle: ReturnType<typeof idleWatch>,
): AsyncGenerator<string> {
  for await (const chunk of stream) {
    idle.ping();
    yield chunk;
  }
}

/**
 * Normalize a mission model value — a tier word ("haiku"/"sonnet"/"opus"),
 * an OpenRouter id ("anthropic/claude-sonnet-5"), a picker label ("Claude
 * Sonnet 5") or an already-native id — to the native Anthropic-family id the
 * CLI backends consume. Same rules as managerStreamCompletion's private
 * toNativeModelId (kept in sync by cliAgentTurnStreamer.test.ts).
 */
export function toNativeCliModelId(model: string): string {
  const lower = model.toLowerCase();
  const word = lower.match(TIER_WORD)?.[0];
  if (word) {
    const found = ALL_MODELS.find((m) => m.id.toLowerCase().includes(word));
    if (found) return found.id;
  }
  if (ALL_MODELS.some((m) => m.id === model)) return model;
  if (model.includes('/')) return model.split('/')[1].replace(/\./g, '-');
  return model;
}

/** Which CLI a "native" model should be served by — the user's explicit
 *  Settings pick (accessMode 'cli' + cliTool), independent of the CURRENT
 *  global provider mode: a Pro user who selected a CLI model for one bot
 *  still gets the CLI, not the ai-proxy. Defaults to claude. */
export function resolveCliEngineMode(): CliEngineMode {
  const tool = loadAccessSettings().cliTool ?? 'claude';
  if (tool === 'codex') return 'codex';
  if (tool === 'devin') return 'devin';
  return 'claude-code';
}

/** Base persona for a LazyBot brain on a CLI rail. The per-mode personas
 *  actively sabotage the ReAct contract — 'ask' says "you cannot modify
 *  files" (the model refuses to act), 'plan' says "investigate the
 *  codebase" (the model spends minutes exploring with its own tools then
 *  emits a numbered plan, not an ACTION — real incidents M125/M126). This
 *  override keeps only what a text-protocol brain needs; the full contract
 *  still arrives via rulesContext. */
export const BOT_BRAIN_BASE_PROMPT =
  'You are the decision layer of a LazyBot — a text-only planner, not a coding agent. ' +
  'Your ONLY output each turn is the format the system rules below define (a THOUGHT/ACTION/ARGS step, or FINAL when done). ' +
  'You never investigate a codebase, never read files, never call any tool or function yourself: ' +
  'the host executes every ACTION you emit and returns its Observation as the next user message.';

function buildCodexRequest(
  opts: Parameters<AgentTurnStreamer>[0],
  nativeModel: string,
): StreamChatRequest {
  const messages: ChatMessage[] = opts.messages.map((m, i) => ({
    id: `bot-turn-${i}`,
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  const model: ModelInfo = { id: nativeModel, label: nativeModel, provider: 'openai' };
  // cliBackendProvider rebuilds its own system prompt; the ReAct system
  // prompt is threaded through rulesContext, which IS forwarded verbatim
  // (same workaround as managerStreamCompletion.buildCodexStreamRequest).
  return {
    messages,
    model,
    mode: 'ask',
    rulesContext: opts.system,
    basePromptOverride: BOT_BRAIN_BASE_PROMPT,
    signal: opts.signal,
    onToolAction: () => opts.onNativeAction?.(),
  };
}

/** Devin counterpart to buildCodexRequest — same shape (system via
 *  rulesContext), except the model id is NOT normalized: devin's --model
 *  accepts fuzzy names natively, so the raw value is the honest one.
 *  mode is 'plan', NOT 'ask': Devin's ACP modes are session behaviors, and
 *  "ask" means "answer without acting" — under it swe-2 (an agent, not a
 *  raw text model) honestly concludes the cloud_* tools are not in ITS
 *  toolset and replies in prose. "plan" makes it emit the planned actions
 *  as text — exactly what our ReAct loop parses and executes host-side
 *  (verified live: ask → prose refusal, plan → THOUGHT/ACTION blocks). */
function buildDevinRequest(
  opts: Parameters<AgentTurnStreamer>[0],
): StreamChatRequest {
  const messages: ChatMessage[] = opts.messages.map((m, i) => ({
    id: `bot-turn-${i}`,
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  // Agent-shaped brains (swe-2) don't trust a contract that contradicts
  // their own toolset — they probe mcp_list_servers, see no cloud_* entries
  // and refuse in prose (real incident: M125-M130). A synthetic warm-up
  // exchange where the loop ALREADY works beats any paragraph of rules: the
  // model continues the ACTION→Observation pattern instead of auditing it.
  // Only injected before the first real turn — later turns have live
  // ACTION/Observation pairs of their own.
  if (!opts.messages.some((m) => m.role === 'assistant')) {
    messages.unshift(
      {
        id: 'bot-warmup-u',
        role: 'user',
        content: 'Warmup: confirm the action loop works — list the host project files with read_dir.',
      },
      {
        id: 'bot-warmup-a',
        role: 'assistant',
        content: 'THOUGHT: Verify the loop with a local list.\nACTION: read_dir\nARGS: {"path": "."}',
      },
      {
        id: 'bot-warmup-o',
        role: 'user',
        content: 'Observation: ["package.json","src","README.md",".lazy"]',
      },
    );
  }
  const model: ModelInfo = { id: opts.model, label: opts.model, provider: 'devin' };
  return {
    messages,
    model,
    mode: 'plan',
    rulesContext: opts.system,
    basePromptOverride: BOT_BRAIN_BASE_PROMPT,
    signal: opts.signal,
    // swe-2 acts natively even in 'plan' mode (M142: wrote the deliverable
    // via its own ACP tools, then narrated in prose) — count those real
    // tool calls so the loop neither scores the mission toolCount:0 nor
    // treats a work-producing prose turn as a protocol failure.
    onToolAction: () => opts.onNativeAction?.(),
    // Anchor the ACP session to the mission worktree — without it, native
    // writes land in the real project root, defeating worktree isolation.
    sessionCwd: opts.worktreePath,
  };
}

/**
 * Build a planAndActManaged `streamTurn` backed by the given CLI. The model
 * id is normalized once per turn so a bot saved with a tier word or a picker
 * label still reaches the CLI as a real id.
 */
export function createCliAgentTurnStreamer(mode: CliEngineMode): AgentTurnStreamer {
  return async function* cliTurn(opts) {
    // Idle watchdog: the request's signal becomes our derived controller —
    // if the parent (mission stop) aborts we propagate, and if the stream
    // goes silent for BRAIN_TURN_IDLE_TIMEOUT_MS we abort ourselves, which
    // both rejects the local queue and tree-kills the CLI child (see
    // cliBackendProvider's `${tool}_chat_stream_cancel` wiring).
    const idle = idleWatch(opts.signal);
    const turnOpts = { ...opts, signal: idle.signal };
    try {
      // Devin short-circuit: a picked Devin-catalog id (swe-2-medium, ...)
      // rides the devin ACP rail no matter which cliTool `mode` names —
      // the model-driven twin of getProvider()'s isDevinModel check, so a
      // bot saved with a Devin model keeps working when the ambient CLI
      // tool is claude/codex. Devin's --model flag accepts fuzzy names, so
      // non-catalog values (a tier word, a native id) pass through raw and
      // resolve — or fail honestly — on the CLI side.
      if (mode === 'devin' || isDevinModel(opts.model)) {
        yield* withIdleTimeout(
          cliBackendProvider('devin').streamChat(buildDevinRequest(turnOpts)),
          idle,
        );
        return;
      }
      const nativeModel = toNativeCliModelId(opts.model);
      if (mode === 'codex') {
        yield* withIdleTimeout(
          cliBackendProvider('codex').streamChat(buildCodexRequest(turnOpts, nativeModel)),
          idle,
        );
        return;
      }
      yield* withIdleTimeout(
        streamClaudeCodeTurn({
          messages: opts.messages,
          system: opts.system,
          model: nativeModel,
          signal: idle.signal,
        }),
        idle,
      );
    } finally {
      idle.dispose();
    }
  };
}
