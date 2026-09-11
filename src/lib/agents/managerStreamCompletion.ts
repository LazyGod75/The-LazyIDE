/* managerStreamCompletion — per-rail LLM dispatch for LazyManager.

   Measured 2026-08-28: streamManagerCompletion cyclomatic complexity was 21
   (ESLint ratchet ceiling 12). Lives here so managerEngine.ts stays the
   turn/retry loop, not a four-way streamer.
*/

import { streamManagedAgentTurn } from '../models/managedProvider.js';
import type { AgentTurnOpts } from '../models/managedProvider.js';
import { streamClaudeCodeTurn } from '../models/claudeCodeProvider.js';
import { cliBackendProvider } from '../models/cliBackendProvider.js';
import { loadAccessSettings } from '../models/index.js';
import {
  resolveByokDef,
  loadByokKey,
  loadByokModel,
  effectiveByokModel,
  effectiveByokBaseUrl,
  streamOpenAICompatRaw,
  streamAnthropicCompatRaw,
  BYOK_PROVIDER_DEFS,
  hasByokKey,
} from '../models/byokProviders.js';
import type { ByokProviderDef } from '../models/byokProviders.js';
import type { ProviderMode, ChatMessage, ModelInfo, StreamChatRequest } from '../models/index.js';
import { ALL_MODELS } from '../models/registry.js';
import { OPENROUTER_MODELS, DEFAULT_OPENROUTER_MODEL_ID, findOpenRouterModel, isOpenRouterFreeModel, migrateRetiredOpenRouterId } from '../models/openrouterCatalog.js';
import { isDevinModel } from '../models/devinCatalog.js';
import { RECALL_TEACHING } from '../models/systemPrompts.js';
import type { ManagerMessage } from './types.js';

const TIER_WORD = /haiku|sonnet|opus/;

function managedAnthropicModels(): readonly { id: string }[] {
  return OPENROUTER_MODELS.filter((m) => m.provider === 'Anthropic');
}

/**
 * Normalize a manager model value — a tier word ("haiku"/"sonnet"/"opus"), an
 * OpenRouter id ("anthropic/claude-sonnet-5"), or an already-native id — to
 * the native Anthropic-family id consumed by the CLI backends. Both
 * claude-code and codex provider modes accept this same id family (see the
 * id-family note above resolveManagerModelId). Shared by both CLI branches
 * in runManagerTurn.
 */
function toNativeModelId(model: string): string {
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

/**
 * Normalize a manager model value to an id the managed/Pro ai-proxy actually
 * accepts (OpenRouter format only — see managedProvider.ts's streamProxyBody/
 * streamManagedAgentTurn, which forward the model string to the proxy AS-IS,
 * with no translation).
 *
 * The counterpart to toNativeModelId above, needed for the exact same
 * reason: every picker offering a model for the manager's OWN planning turn
 * (LazyManagerRail's manager-model-select, AnalysisDesk's analysis-model
 * select) builds its option list from buildModelPickerOptions, which can
 * offer BOTH a native-id group (claude-sub entitlement) and an OpenRouter-id
 * group (Pro entitlement) AT THE SAME TIME — see modelPickerOptions.ts's
 * module doc comment: a user can hold both entitlements simultaneously even
 * though getProviderMode() only ever resolves to ONE active backend. Picking
 * a native-id option (e.g. 'claude-haiku-4-5') while the resolved mode is
 * 'managed'/'pro' used to forward that native id straight to the ai-proxy
 * unmodified, which rejects it as an unrecognized model — the
 * "ManagedUnavailableError: Modèle non supporté" failure this fixes.
 *
 * Accepts (in priority order): an already-valid OpenRouter id (returned
 * as-is — covers every non-Anthropic managed model too, e.g. 'openai/gpt-5.4'
 * or 'deepseek/deepseek-v4-flash'), a native Anthropic id or bare tier word
 * ('haiku'/'sonnet'/'opus' — mapped to the matching Anthropic OpenRouter
 * entry), else the catalog default.
 */
function toManagedModelId(model: string): string {
  const migrated = migrateRetiredOpenRouterId(model);
  if (findOpenRouterModel(migrated)) return migrated;
  const word = model.toLowerCase().match(TIER_WORD)?.[0];
  if (!word) return DEFAULT_OPENROUTER_MODEL_ID;
  return managedAnthropicModels().find((m) => m.id.toLowerCase().includes(word))?.id ?? DEFAULT_OPENROUTER_MODEL_ID;
}

/**
 * Build the StreamChatRequest used to route a manager turn through the codex
 * CLI backend (cliBackendProvider('codex')).
 *
 * There is no standalone single-turn codex helper (no streamCodexTurn sibling
 * to streamClaudeCodeTurn) — cliBackendProvider is the generic ModelProvider
 * used by the main assistant chat, and its streamChat ALWAYS rebuilds the
 * system prompt internally via buildSystemPrompt(req.mode, ...); StreamChatRequest
 * has no field for a caller-supplied system string. To avoid silently dropping
 * the manager's system prompt (the action schema + live agent/mission state —
 * without it the manager cannot emit valid <lazy_actions>), it is threaded
 * through rulesContext, which IS forwarded verbatim into the final prompt
 * (under a "Project Rules" heading — cosmetically odd but functionally intact).
 * This is the smallest-correct-thing workaround called out in the task; a
 * proper fix would add an exported single-turn codex helper mirroring
 * streamClaudeCodeTurn so the manager can pass its system prompt directly.
 */
function buildCodexStreamRequest(
  messages: ManagerMessage[],
  system: string,
  model: string,
  signal: AbortSignal | undefined,
): StreamChatRequest {
  const nativeModel = toNativeModelId(model);
  const codexMessages: ChatMessage[] = messages.map((m) => ({
    id: m.id,
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  const codexModel: ModelInfo = { id: nativeModel, label: nativeModel, provider: 'openai' };

  return {
    messages: codexMessages,
    model: codexModel,
    mode: 'ask',
    rulesContext: system,
    signal,
  };
}

export const ACTION_FORMAT_REMINDER =
  '=== ACTION FORMAT (critical) === If this reply announces or performs ' +
  'ANY action (launch, delete, open, merge, scan...), it MUST contain the ' +
  'matching <lazy_actions>[{...}]</lazy_actions> block in THIS same reply. ' +
  'Prose without the block does nothing. Pure answers/questions need no block.';

/**
 * Dispatch ONE streamed LLM completion through whichever backend matches
 * `mode` (claude-code CLI, codex CLI, BYOK live-key, or the managed/Pro
 * ai-proxy) and return the fully concatenated raw text. Extracted from
 * runManagerTurn's main retry loop so attemptActionExtractionRepair below
 * can issue its OWN short completion through the exact same routing — same
 * engine/model path the turn already used — without duplicating the
 * four-way branch. `appendRecallTeaching` defaults to true so the main
 * planning loop's own behavior is byte-for-byte unchanged by this
 * extraction; the repair call passes false (see its own doc comment).
 */
interface StreamManagerCompletionOpts {
  mode: ProviderMode;
  model: string;
  system: string;
  cacheableSystem?: { core: string; dynamic: string };
  appendRecallTeaching?: boolean;
  apiMessages: ManagerMessage[];
  signal?: AbortSignal;
  onChunk?: () => void;
  onPartial?: (accumulatedRaw: string) => void;
}

// ── Streaming chunk accumulation (2026-08-12 QA: spliced/duplicated text) ──
//
// BUG (real user repro, verbatim, Claude Sonnet 5 subscription route):
//   "Je lance un agent haiku pour ajouter la fonction sum(a, b) dans
//   index.js avec l'affichage de sum(2,3) au démarrage.js(projet actif
//   uc-smoke-2026-08-12) et affichersum(2,3)` au lancement."
//
// INVESTIGATED (2026-08-12, coordinator-directed re-review — first pass
// shipped a >=8-char "drop an exact adjacent duplicate chunk" guard, which
// was WRONG and has been reverted): that heuristic is destructive (real
// streamed code routinely repeats an identical adjacent chunk — 8 spaces of
// indentation twice, a blank "\n\n" pair, a repeated identifier at a token
// boundary — and would silently delete it, invisibly, in an IDE where
// correctness of generated code matters far more than a rare display glitch)
// AND it does not even match the actual observed corruption: the two halves
// of the real repro are NOT byte-identical to each other (compare "...dans
// index.js avec l'affichage de sum(2,3) au démarrage." against "...index.js
// (projet actif uc-smoke-2026-08-12) et afficher `sum(2,3)` au lancement.")
// — a byte-equality guard would never have fired on the real chunk sequence
// either way.
//
// Three specific hypotheses were checked against the actual owned code:
//   (a) two accumulators/concurrent streams writing into the same message —
//       RULED OUT at this layer: `acc` below is a plain local variable, one
//       per streamManagerCompletion() call, never shared/module-level state.
//       runGroundedFollowUp (agentsStore.tsx) always REPLACES currentTurn
//       sequentially (`currentTurn = nextTurn`, awaited) — it never
//       concatenates two turns' raw text together; every grounded return
//       reads turnDisplayText(currentTurn) from the SINGLE latest turn.
//       Nothing in sendManagerMessage starts a second call for the SAME
//       conversation while a first is still in flight for this repro (no
//       grounding action was involved, so runGroundedFollowUp short-circuits
//       via `findGroundingActions` returning empty). A UI-level double-send
//       race (e.g. a doubled click before the composer disables) was not
//       fully ruled out — it lives in agentsStore.tsx/LazyManagerComposer.tsx,
//       outside this fix's owned files.
//   (b) a prompt-side template splicing project-context annotation into the
//       model's own text — RULED OUT in the TS layer: no "projet actif" /
//       "active project" template string exists anywhere that writes into
//       the SAME variable the transport's chunks land in. The system prompt
//       (buildManagerDynamicContext) and the `acc`/rawResponse accumulator
//       below are structurally separate strings in every one of the four
//       streamManagerCompletion branches — the system prompt is sent AS
//       INPUT to the model, never appended to its OUTPUT after the fact.
//   (c) a retry/reconnect starting a second stream without discarding the
//       first — NO retry exists at the JS layer (streamClaudeCodeTurn /
//       cliBackendProvider / the BYOK raw streamers / streamManagedAgentTurn
//       each issue exactly ONE request per streamManagerCompletion call, no
//       automatic reconnect). Reading src-tauri/src/commands/chat.rs
//       (read-only — out of this fix's editable scope) surfaces a credible
//       mechanism, though NOT provable from a JS unit test: `claude -p
//       --output-format stream-json --verbose` is itself a multi-step
//       internal agent loop that can emit SEVERAL separate "assistant"-typed
//       stream-json lines for one logical LazyManager turn — Rust relays
//       every one of them as an independent model://chunk event with no
//       boundary/reset marker between them (extract_text_from_stream_json,
//       chat.rs:662). A closely related leak from that exact same multi-step
//       behavior (the CLI harness's own synthetic re-prompt text) was
//       already found and fixed there — see that function's own doc comment,
//       chat.rs:647-661. If the external `claude` binary internally
//       self-corrects or retries part of a response, Rust has no way to tell
//       that apart from ordinary multi-part narration (narrate -> tool call
//       -> narrate again), and would relay BOTH renderings, which this file
//       then concatenates in order — a much better structural match for the
//       real repro (two overlapping, non-identical renderings glued
//       together) than a literal duplicate chunk. This is the most likely
//       root cause, but it lives inside src-tauri/chat.rs and, ultimately,
//       the external `claude` CLI's own behavior — both outside this task's
//       editable perimeter (explicitly "Do NOT touch: ... src-tauri/") and
//       not reproducible from a Vitest unit test, which cannot invoke the
//       real external CLI's stream-json output deterministically.
//
// Since no fix at THIS layer can be proven against a real reproduction, the
// coordinator's own fallback applies: never silently drop model output.
// appendManagerChunk below is back to plain, lossless concatenation — the
// final text is ALWAYS the exact, in-order join of every chunk the
// transport ever handed us, full stop. Two NON-DESTRUCTIVE diagnostics are
// added instead, so a future occurrence leaves a trail instead of a silent
// display bug: warnIfDuplicateAdjacentChunk (flags but never drops an exact,
// non-trivial-length repeat — the (mechanism the first, reverted attempt
// guessed at) and warnIfImbalancedCodeSpans (flags an odd backtick count in
// the FINAL text — a cheap, precise signal that would have fired on the real
// repro's own stray unmatched closing backtick). Both only ever log; neither
// ever changes what the user sees.

/** Below this length, an adjacent repeated chunk is never logged — a short,
 *  legitimately-repeated fragment (a stutter, a repeated short word/token) is
 *  common enough that logging it would just be noise, not a real signal.
 *  Mirrors the same "conservative minimum length" convention as
 *  MIN_SELF_REPEAT_CHARS / MIN_DEDUP_SEGMENT_CHARS above. */
const MIN_DUPLICATE_CHUNK_LOG_CHARS = 8;

/**
 * Diagnostic only — never mutates or drops anything. Logs when `chunk` is a
 * byte-identical, non-trivial-length echo of the immediately PRECEDING
 * chunk, which is the transport-duplicate-delivery signature the reverted
 * heuristic targeted (see this section's module doc comment, hypothesis
 * (c)). Kept as a log-only signal because streamed code/markdown routinely
 * contains a legitimate identical adjacent chunk (repeated indentation, a
 * blank-line pair, a repeated identifier at a token boundary) — silently
 * dropping it would corrupt correct output, which is exactly what this
 * replaces.
 */
function warnIfDuplicateAdjacentChunk(previousChunk: string, chunk: string): void {
  if (chunk.length >= MIN_DUPLICATE_CHUNK_LOG_CHARS && chunk === previousChunk) {
    console.warn(
      `[streamManagerCompletion] anomaly: chunk repeated identically back-to-back ` +
      `(${chunk.length} chars) — possible duplicate transport delivery, kept as-is: ` +
      `${JSON.stringify(chunk.slice(0, 80))}`,
    );
  }
}

/** Diagnostic only. An odd number of backtick (`` ` ``) characters in the
 *  FINAL accumulated text means at least one markdown code span never
 *  closed — the exact, precise signature the real repro's own text carried
 *  ("...affichersum(2,3)\` au lancement." — one stray unmatched closing
 *  backtick). A cheap, unambiguous, whole-text check (unlike per-chunk
 *  duplicate detection, code-span balance can only be judged once the full
 *  response is assembled), logged with enough of the surrounding text to
 *  investigate without ever altering what is shown to the user. */
function warnIfImbalancedCodeSpans(text: string): void {
  const backtickCount = (text.match(/`/g) ?? []).length;
  if (backtickCount % 2 !== 0) {
    console.warn(
      `[streamManagerCompletion] anomaly: odd backtick count (${backtickCount}) in the ` +
      `final response text — an unclosed/spliced markdown code span, possibly from an ` +
      `overlapping chunk sequence. Full text kept as-is: ${JSON.stringify(text.slice(0, 400))}`,
    );
  }
}

interface ChunkAccumulatorState {
  text: string;
  previousChunk: string;
}

const EMPTY_CHUNK_ACCUMULATOR: ChunkAccumulatorState = { text: '', previousChunk: '' };

/**
 * Folds ONE incoming stream chunk into the accumulator state. Plain,
 * lossless concatenation — ALWAYS. Never drops or alters a chunk; see this
 * section's own module doc comment for why (a byte-equality drop guard was
 * tried and reverted: destructive on legitimate repeated code/markdown, and
 * did not even match the real repro's own non-identical chunk halves).
 * warnIfDuplicateAdjacentChunk runs alongside as a non-destructive
 * diagnostic only.
 */
function appendManagerChunk(state: ChunkAccumulatorState, chunk: string): ChunkAccumulatorState {
  warnIfDuplicateAdjacentChunk(state.previousChunk, chunk);
  return { text: state.text + chunk, previousChunk: chunk };
}

/**
 * Pure(-ish — see the diagnostic warnings it triggers) counterpart to
 * streamManagerCompletion's own per-branch accumulation loops below (all
 * four call appendManagerChunk in lockstep with this) — reconstructs the
 * final response text from a sequence of raw transport chunks. The result is
 * ALWAYS the exact in-order concatenation of every chunk — see this
 * section's own module doc comment for the investigation that ruled out a
 * fix at this layer, and managerEngine.test.ts's "streaming chunk
 * accumulation" suite for the regression coverage (lossless reconstruction,
 * including a duplicate chunk and a code-span split, plus the two
 * diagnostics firing without altering the text).
 */
export function accumulateManagerChunks(chunks: readonly string[]): string {
  const result = chunks.reduce(appendManagerChunk, EMPTY_CHUNK_ACCUMULATOR).text;
  warnIfImbalancedCodeSpans(result);
  return result;
}

/**
 * Resolves the (non-Anthropic) BYOK provider whose OWN catalog contains
 * `modelId` and whose key is actually configured — e.g. 'deepseek-chat' /
 * 'deepseek-reasoner' (byokProviders.ts's DeepSeek def). Mirrors
 * byokProviders.ts's own resolveByokAgentTurnStreamer (used by the mission
 * ReAct loop for the exact same "does this modelId belong to a keyed BYOK
 * provider" question) as a small LOCAL lookup here — kept local rather than
 * importing that streamer because its ByokAgentTurnOpts contract doesn't
 * match streamManagerCompletion's own raw streamOpenAICompatRaw/
 * streamAnthropicCompatRaw call shape, and because byokProviders.ts itself
 * must stay untouched (its vault/key-storage code was just fixed and
 * verified live).
 *
 * Real bug this closes (DeepSeek-always-fails, 2026-08-12): the picker
 * (modelPickerOptions.ts) computes "is a BYOK model selectable" INDEPENDENTLY
 * of getProviderMode() on purpose — see that module's own header doc comment,
 * "a user can genuinely hold BOTH entitlements at once". But
 * streamManagerCompletion's dispatch below used to key PURELY off the
 * ambient `mode` (getProviderMode()) — so a user with a Claude
 * subscription/Pro plan active (mode resolves 'claude-code'/'managed') who
 * explicitly picked a keyed BYOK model from that SAME independent picker had
 * it silently forwarded to the wrong rail (toNativeModelId('deepseek-chat')
 * sent straight to the Claude CLI, which of course rejects an id it has
 * never heard of — modelsIndex.test.ts documents that exact rejection
 * wording). Checked BEFORE the mode branches below so an explicit,
 * keyed BYOK-catalog selection always wins over the ambient mode, matching
 * what the picker already promised the user it would do.
 *
 * Anthropic is excluded (its native ids are served by the claude-code/
 * live-key branches already, never by this raw-BYOK path) — same exclusion
 * resolveByokAgentTurnStreamer applies for the same reason.
 */
function resolveByokDefForModel(modelId: string): ByokProviderDef | undefined {
  const def = BYOK_PROVIDER_DEFS.find(
    (d) => d.id !== 'anthropic' && d.models.some((m) => m.id === modelId),
  );
  return def && hasByokKey(def.id) ? def : undefined;
}

type IngestChunk = (chunk: string) => void;

async function drainChunks(stream: AsyncIterable<string>, ingest: IngestChunk): Promise<void> {
  for await (const chunk of stream) ingest(chunk);
}

async function streamKeyedByokRail(
  def: ByokProviderDef,
  model: string,
  systemFinal: string,
  apiMessages: ManagerMessage[],
  signal: AbortSignal | undefined,
  ingest: IngestChunk,
): Promise<void> {
  const byokStream = def.apiFormat === 'anthropic' ? streamAnthropicCompatRaw : streamOpenAICompatRaw;
  await drainChunks(byokStream({
    baseUrl: effectiveByokBaseUrl(def),
    apiKey: loadByokKey(def.id),
    model,
    system: systemFinal,
    messages: apiMessages,
    signal,
  }), ingest);
}

async function streamLiveKeyRail(
  model: string,
  systemFinal: string,
  apiMessages: ManagerMessage[],
  signal: AbortSignal | undefined,
  ingest: IngestChunk,
): Promise<void> {
  const byokDef = resolveByokDef(loadAccessSettings().byokProvider);
  if (!byokDef) {
    throw new Error('LazyManager error: aucun provider BYOK sélectionné — choisis-en un dans Réglages > Modèles.');
  }
  const byokApiKey = loadByokKey(byokDef.id);
  if (!byokApiKey) {
    throw new Error(`LazyManager error: aucune clé API ${byokDef.label} configurée — ajoute-la dans Réglages > Modèles.`);
  }
  const byokModel =
    byokDef.models.some((m) => m.id === model) || loadByokModel(byokDef.id) === model
      ? model
      : effectiveByokModel(byokDef);
  const byokStream = byokDef.apiFormat === 'anthropic' ? streamAnthropicCompatRaw : streamOpenAICompatRaw;
  await drainChunks(byokStream({
    baseUrl: effectiveByokBaseUrl(byokDef),
    apiKey: byokApiKey,
    model: byokModel,
    system: systemFinal,
    messages: apiMessages,
    signal,
  }), ingest);
}

/** Managed (Pro/ai-proxy) rail — streams the manager turn through the proxy
 *  and retries transient provider errors. Extracted from dispatchAmbientRail
 *  so that dispatcher stays under the ESLint complexity ratchet. */
async function streamManagedRailWithRetry(
  model: string,
  systemFinal: string,
  cacheableSystemFinal: { core: string; dynamic: string } | undefined,
  apiMessages: ManagerMessage[],
  signal: AbortSignal | undefined,
  ingest: IngestChunk,
): Promise<void> {
  const attempts = isOpenRouterFreeModel(model) ? 3 : 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await drainChunks(streamManagedAgentTurn({
        messages: apiMessages,
        system: systemFinal,
        cacheableSystem: cacheableSystemFinal,
        model: toManagedModelId(model),
        signal,
      } satisfies AgentTurnOpts), ingest);
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const retryable = /fournisseur de modèle|upstream_error|502|503|504|Provider returned error/i.test(msg);
      if (!retryable || attempt === attempts || signal?.aborted) throw err;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr;
}

/** Devin CLI rail (ACP backend, tool 'devin'). Model ids pass through
 *  UNMANGLED — devin's --model flag accepts its own catalog ids AND fuzzy
 *  names ("Accepts the same fuzzy names as /model"), so a devin id like
 *  'swe-2-medium' or a resolved tier word both work; anything invalid
 *  fails honestly in the CLI's own error. Same system-prompt workaround
 *  as buildCodexStreamRequest: threaded through rulesContext (which
 *  cliBackendProvider forwards verbatim into its own buildSystemPrompt —
 *  RECALL_TEACHING already gets appended there for non-'transform' modes,
 *  hence codexSystemFinal, not systemFinal). */
async function streamDevinRail(
  model: string,
  systemFinal: string,
  apiMessages: ManagerMessage[],
  signal: AbortSignal | undefined,
  ingest: IngestChunk,
): Promise<void> {
  const devinMessages: ChatMessage[] = apiMessages.map((m) => ({
    id: m.id,
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  const devinModel: ModelInfo = { id: model, label: model, provider: 'devin' };
  await drainChunks(cliBackendProvider('devin').streamChat({
    messages: devinMessages,
    model: devinModel,
    mode: 'ask',
    rulesContext: systemFinal,
    signal,
  }), ingest);
}

async function dispatchAmbientRail(
  mode: ProviderMode,
  model: string,
  systemFinal: string,
  codexSystemFinal: string,
  cacheableSystemFinal: { core: string; dynamic: string } | undefined,
  apiMessages: ManagerMessage[],
  signal: AbortSignal | undefined,
  ingest: IngestChunk,
): Promise<void> {
  if (mode === 'claude-code') {
    await drainChunks(streamClaudeCodeTurn({
      messages: apiMessages,
      system: systemFinal,
      model: toNativeModelId(model),
      signal,
    }), ingest);
    return;
  }
  if (mode === 'codex') {
    // RECALL_TEACHING is deliberately NOT appended here (matches the main
    // loop's own codex branch) — buildCodexStreamRequest threads `system`
    // through rulesContext into cliBackendProvider's own buildSystemPrompt,
    // which already appends RECALL_TEACHING for any non-'transform' mode.
    await drainChunks(cliBackendProvider('codex').streamChat(
      buildCodexStreamRequest(apiMessages, codexSystemFinal, model, signal),
    ), ingest);
    return;
  }
  if (mode === 'devin') {
    await streamDevinRail(model, codexSystemFinal, apiMessages, signal, ingest);
    return;
  }
  if (mode === 'live-key') {
    await streamLiveKeyRail(model, systemFinal, apiMessages, signal, ingest);
    return;
  }
  if (mode === 'mock' && !model.includes('/')) {
    throw new Error(
      "Claude CLI n'est pas disponible dans le navigateur. Connecte-toi et choisis GLM 5.2, ou ouvre l'app desktop.",
    );
  }
  await streamManagedRailWithRetry(model, systemFinal, cacheableSystemFinal, apiMessages, signal, ingest);
}

export async function streamManagerCompletion(opts: StreamManagerCompletionOpts): Promise<string> {
  const {
    mode, model, system, cacheableSystem, apiMessages, signal, onChunk, onPartial,
    appendRecallTeaching = true,
  } = opts;
  const systemWithTeaching = appendRecallTeaching ? `${system}\n\n${RECALL_TEACHING}` : system;
  // FIX 1 — ACTION_FORMAT_REMINDER appended as the true last content of
  // whatever each rail actually dispatches. `systemFinal` covers
  // claude-code/live-key/managed (all three send `systemWithTeaching`
  // as-is); codex deliberately does NOT read `systemWithTeaching` (see the
  // comment on that branch below), so it gets its own `codexSystemFinal`
  // built from the raw `system` instead — RECALL_TEACHING placement for
  // codex stays exactly as before, untouched by this fix. `cacheableSystemFinal`
  // mirrors the same suffix onto the cache-split `dynamic` half so
  // `core + dynamic` keeps reconstructing `systemFinal` exactly (existing
  // invariant — see runManagerTurn's own cacheableSystem doc comment);
  // `core` itself is never touched.
  const systemFinal = `${systemWithTeaching}\n\n${ACTION_FORMAT_REMINDER}`;
  const codexSystemFinal = `${system}\n\n${ACTION_FORMAT_REMINDER}`;
  const cacheableSystemFinal = cacheableSystem
    ? { core: cacheableSystem.core, dynamic: `${cacheableSystem.dynamic}\n\n${ACTION_FORMAT_REMINDER}` }
    : undefined;
  // accumulateManagerChunks' own doc comment above explains the guard this
  // replaces plain `rawResponse += chunk` with — every branch below folds
  // its chunks through the SAME appendManagerChunk step function.
  let acc: ChunkAccumulatorState = EMPTY_CHUNK_ACCUMULATOR;
  const ingest = (chunk: string): void => {
    acc = appendManagerChunk(acc, chunk);
    onChunk?.();
    onPartial?.(acc.text);
  };

  // Checked BEFORE the ambient-mode branches below — see
  // resolveByokDefForModel's own doc comment for the real bug this fixes
  // (a keyed BYOK-catalog model picked from the picker used to be silently
  // forwarded to whatever rail the ambient mode happened to resolve to,
  // e.g. the Claude CLI, which rejects an id it has never heard of).
  const modelByokDef = resolveByokDefForModel(model);
  if (modelByokDef) {
    await streamKeyedByokRail(modelByokDef, model, systemFinal, apiMessages, signal, ingest);
  } else if (isDevinModel(model)) {
    // Devin-catalog id picked explicitly — same model-driven short-circuit
    // as the BYOK check above: rides the devin ACP rail no matter which
    // ambient mode resolved (getProvider()'s isDevinModel check is the
    // provider-level twin of this branch).
    await streamDevinRail(model, codexSystemFinal, apiMessages, signal, ingest);
  } else {
    await dispatchAmbientRail(
      mode, model, systemFinal, codexSystemFinal, cacheableSystemFinal, apiMessages, signal, ingest,
    );
  }

  warnIfImbalancedCodeSpans(acc.text);
  return acc.text;
}
