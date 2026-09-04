/* Model gateway — shared types for providers, messages, modes */

import type { BrainRecallResult } from '../platform/types.js';

/** i18n translate function shape — see modelPickerOptions.ts's Translate doc
 *  comment for why this is a local structural type rather than a shared
 *  import. Optional everywhere: omitting `t` falls back to the ORIGINAL
 *  hardcoded French, same contract as the rest of lib/models. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

export type ChatRole = 'user' | 'assistant';

/**
 * 'ask'   — read-only Q&A, cannot modify files.
 * 'plan'  — investigate + return a plan, do not modify files.
 * 'edit'  — agentic: the Composer's "Edit" chat mode. Full file access, the
 *           model applies changes itself via tools and narrates/summarizes
 *           (see systemPrompts.ts's MODE_BASE_PROMPTS.edit and chat.rs's
 *           acceptEdits/--add-dir wiring). Conversational — the app never
 *           treats the raw stream as literal replacement code.
 * 'transform' — single-shot, non-agentic code transform (Ctrl+K inline-edit,
 *           auto-fix). The caller inlines all needed context into the
 *           prompt and treats the ENTIRE response as literal replacement
 *           code, so the model must return ONLY code — no tools, no
 *           narration. Deliberately distinct from 'edit': reusing 'edit'
 *           here was the root cause of a HIGH defect where the Claude Code
 *           CLI backend's agentic narration ("-> Read foo.ts\nDone. ...")
 *           got applied as if it were the replacement code, corrupting the
 *           file. See codeOutputSanitizer.ts for the output-side guard.
 */
export type ChatMode = 'ask' | 'plan' | 'edit' | 'transform';

export interface Citation {
  ref: string;          // e.g. "#auth-oauth"
  label?: string;       // optional display label
}

/** Status of one tool invocation surfaced to the UI (see StreamEvent). */
export type ToolCallStatus = 'running' | 'done' | 'error';

/**
 * One incremental signal from the assistant's structured stream, kept
 * distinct end-to-end (model reasoning / tool-call / final-answer text)
 * instead of being flattened into a single string blob — see
 * brainSearchLoop.ts's withBrainSearchLoopEvents and each provider's
 * streamChatEvents for where these are produced.
 *
 * 'thinking' and 'text' carry incremental text deltas, appended by the
 * reducer (see streamEvents.ts's applyStreamEvent) to the part sharing
 * their `id`. 'tool' carries the FULL current snapshot of that call (a
 * status object arrives whole each time, not fragment-by-fragment), so the
 * reducer replaces rather than appends.
 */
export type StreamEvent =
  | { type: 'thinking'; id: string; text: string }
  | { type: 'tool'; id: string; name: string; input?: unknown; status: ToolCallStatus; resultSummary?: string }
  | { type: 'text'; id: string; text: string };

/**
 * Materialized "step" parts kept on a ChatMessage for rendering — thinking
 * and tool-call steps ONLY. Final-answer prose is deliberately NOT
 * duplicated here: 'text' StreamEvents feed ChatMessage.content directly
 * (see assistantStore's send()), so persistence/capture/citations/CodeBlock
 * keep operating on `content` unchanged, and a plain non-agentic completion
 * naturally ends up with an empty/absent parts array — no "0 steps" chrome
 * to special-case in the renderer (see MessageList.tsx's AssistantMessage).
 */
export type StreamPart = Extract<StreamEvent, { type: 'thinking' } | { type: 'tool' }>;

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  citations?: Citation[];
  codeBlock?: {
    language: string;
    code: string;
    /** Explicit target file for this ONE extracted block, present ONLY
     *  when the fence's own info string named one (e.g.
     *  "```tsx src/components/Foo.tsx") — see parseFenceInfo.ts. Never
     *  inferred from surrounding prose (see MessageList.tsx's Apply-gating
     *  rule, DEFECT 2: a guessed target could point Apply at any file
     *  merely mentioned near the snippet). */
    targetPath?: string;
  };
  /** Ordered thinking/tool-call steps captured while streaming (assistant
   *  chat only). Absent or empty for simple/non-agentic completions, which
   *  render exactly as before this field existed. Not persisted (see
   *  chatPersistence.ts's saveMessages), same as citations/codeBlock. */
  parts?: StreamPart[];
  /** Chat mode active when this (assistant) message was generated — see
   *  ChatMode's doc comment. Set once at creation (assistantStore's send())
   *  and never re-derived from the store's LIVE selected mode, so a later
   *  mode switch never retroactively changes what an older message is
   *  allowed to do. Absent for historical/persisted messages (mode is not
   *  persisted, same as parts/codeBlock/citations) and for the error/user
   *  paths — MessageList.tsx treats "absent" the same as 'ask' (the safe,
   *  Copy-only default) everywhere this matters. */
  mode?: ChatMode;
  isStreaming?: boolean;
  error?: boolean;
  /** True when the user clicked Stop (or pressed Escape) mid-turn — see
   *  assistantStore.tsx's abortStream/send abort branches. Renders a
   *  subtle "interrompu" suffix marker instead of pretending the turn
   *  finished normally; the partial `content` accumulated so far is kept
   *  as-is. */
  interrupted?: boolean;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  description?: string;
}

/**
 * A tool the chat model may invoke mid-response (agentic retrieval).
 * Generic by design — `input_schema` is a JSON Schema object so any tool can
 * be described without coupling to a specific implementation.
 */
export interface ChatTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface StreamChatRequest {
  messages: ChatMessage[];
  model: ModelInfo;
  mode: ChatMode;
  brainRecall?: BrainRecallResult | null;
  rulesContext?: string | null;
  signal?: AbortSignal;
  /** Startup context from the brain's highlights mode — injected only on the first user turn. */
  startupContext?: string;
  /** Semantic skill injection — skills relevant to the user's message, loaded from the brain. */
  skillContext?: string;
  /** Tools the model may invoke during this turn (e.g. brain_search). */
  tools?: ChatTool[];
  /**
   * Stable per-conversation id, forwarded into every brain.recallScoped()
   * call made for this turn — assistantStore.tsx's primary + WS2 fallback
   * recall, and brainSearchLoop.ts's recallForDirective for in-turn
   * BRAIN_SEARCH rounds (withBrainSearchLoop/withBrainSearchLoopEvents read
   * it off this request) — so the engine's session-dedup can skip notes
   * already shown earlier in this same conversation (see search.rs's
   * brain_fetch_recall_scoped `session_id` param). Undefined for callers
   * that don't track a conversation id (inline-edit, autoFix, terminalAi,
   * AiReview, AiCommitMessage, agents) — recall then behaves exactly as
   * before this field existed (no dedup).
   */
  sessionId?: string;
  /**
   * Active project root, forwarded from AppContext (assistantStore.tsx) so
   * assistantToolLoop.ts's tool-directive execution (READ_FILE, SEARCH_CODE,
   * GIT_*, etc.) runs against the project the user actually has open instead
   * of the localStorage key it used to read on its own — that key
   * ('lazy.projectRoot') was never written by any code path, so every tool
   * call silently ran against the backend process's own cwd (see
   * assistantToolLoop.ts's getProjectRoot doc comment). Optional so every
   * caller that doesn't track a project (inline-edit, autoFix, terminalAi,
   * AiReview, AiCommitMessage, agents, and any test/mock built before this
   * field existed) keeps falling back to the old localStorage read unchanged.
   */
  projectRoot?: string;
  /**
   * useI18n().t, forwarded from assistantStore.tsx (the only caller with
   * live i18n context) so the ReAct loop's in-chat status lines
   * (brainSearchLoop.ts's describeBrainDirective, assistantToolLoop.ts's
   * toolDirectiveStatusLine — the plain-string streamChat path used by
   * providers without streamChatEvents) translate instead of always
   * rendering their original hardcoded French. Optional: every other
   * caller (inline-edit, autoFix, terminalAi, AiReview, AiCommitMessage,
   * agents) omits it, same "omitting t is never a behavior change"
   * contract used throughout lib/models.
   */
  t?: Translate;
}

export interface ModelProvider {
  id: string;
  label: string;
  listModels(): ModelInfo[];
  streamChat(req: StreamChatRequest): AsyncIterable<string>;
  /**
   * Optional structured variant of streamChat — yields typed StreamEvents
   * (thinking / tool-call / text) instead of a flattened string, so the
   * assistant chat can render them as distinct UI (collapsible reasoning,
   * tool-call steps, clean final answer) rather than one undifferentiated
   * blob. Only implemented by the providers that run the brain_search
   * ReAct loop (claudeCode/anthropic/cliBackend/managed, plus index.ts's
   * managedWithFallback wrapper). Every other caller (inline-edit, autoFix,
   * terminalAi, AiReview, AiCommitMessage, agents) keeps using the plain
   * streamChat string contract, completely unaffected by this field being
   * optional/absent on mockProvider, webAnthropicProvider, noModelProvider.
   */
  streamChatEvents?(req: StreamChatRequest): AsyncIterable<StreamEvent>;
}
