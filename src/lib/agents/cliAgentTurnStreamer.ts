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
import type { PlanAndActManagedOpts } from './managedAgent.js';

export type CliEngineMode = 'claude-code' | 'codex';

export type AgentTurnStreamer = NonNullable<PlanAndActManagedOpts['streamTurn']>;

const TIER_WORD = /haiku|sonnet|opus/;

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
  return (loadAccessSettings().cliTool ?? 'claude') === 'codex' ? 'codex' : 'claude-code';
}

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
  return { messages, model, mode: 'ask', rulesContext: opts.system, signal: opts.signal };
}

/**
 * Build a planAndActManaged `streamTurn` backed by the given CLI. The model
 * id is normalized once per turn so a bot saved with a tier word or a picker
 * label still reaches the CLI as a real id.
 */
export function createCliAgentTurnStreamer(mode: CliEngineMode): AgentTurnStreamer {
  return async function* cliTurn(opts) {
    const nativeModel = toNativeCliModelId(opts.model);
    if (mode === 'codex') {
      yield* cliBackendProvider('codex').streamChat(buildCodexRequest(opts, nativeModel));
      return;
    }
    yield* streamClaudeCodeTurn({
      messages: opts.messages,
      system: opts.system,
      model: nativeModel,
      signal: opts.signal,
    });
  };
}
