/* managedProvider — Lazy-managed model backend (Pro tier).

   Calls the `ai-proxy` Supabase Edge Function with the user's JWT, streaming
   the proxy's plain-text response body into an AsyncIterable<string>.

   The proxy handles auth, the subscription/credit gate, the upstream model
   call (via OpenRouter), and usage metering + credit decrement. This client
   forwards the conversation, the selected OpenRouter model id, and the
   reasoning effort level.

   When the managed key is not configured server-side, the proxy returns 503
   with code "managed_unavailable"; we throw a typed error so the gateway can
   fall back to the user's other backend and surface a friendly notice.

   Do NOT import from anthropicProvider, claudeCodeProvider, or cliBackendProvider
   here — this file is the managed path only. assistantToolLoop.ts is the one
   deliberate exception (see "ReAct loop" below): it is provider-agnostic and
   already shared by the other three chat providers.

   ReAct loop (brain directives + general tool directives):
   - streamChatImpl delegates to assistantToolLoop.ts's withAssistantToolLoop
     (imported under the withBrainSearchLoop alias — same convention as
     anthropicProvider.ts/claudeCodeProvider.ts/cliBackendProvider.ts) instead
     of hand-rolling its own round loop. resolveManagedTurnContext resolves
     the session + builds the static proxy-body parts ONCE; buildManagedRunTurn
     wraps streamProxyBody as the per-round callback the shared loop drives —
     so auth headers, model id, and usage/credit metering all stay
     centralized in streamProxyBody, never duplicated here.
   - FIX (2026-07 live defect): before this, managedProvider ran its OWN loop
     that only understood BRAIN_SEARCH / BRAIN_QUERY_CSS / BRAIN_NEIGHBOURS
     (via brainTool.ts's parseBrainDirective). General tool directives
     (WEB_SEARCH, WEB_FETCH, READ_FILE, READ_DIR, SEARCH_CODE, GIT_*) taught
     by systemPrompts.ts's ASSISTANT_TOOL_GROUNDING fell straight through as
     unrecognized prose in managed ("Pro · géré") mode: the directive line
     leaked into the visible answer and the model, never receiving a real
     tool result, hallucinated the rest of its response in that same turn.
     withAssistantToolLoop already handles BOTH directive families (see
     parseUnifiedDirective) with the exact same brain-directive behavior this
     file used to hand-roll (same describeBrainDirective/executeBrainDirective
     primitives, same dedup/nudge/forced-final contract) — this file's
     previous MAX_BRAIN_SEARCH_ROUNDS=3 constant is retired in favor of
     assistantToolLoop.ts's shared MAX_TOOL_ROUNDS, so all four chat
     providers now share one round budget.
   - managedProviderEvents.ts's streamChatEventsImpl mirrors this exact same
     delegation with withAssistantToolLoopEvents, reusing this file's
     resolveManagedTurnContext/buildManagedRunTurn instead of duplicating the
     session/baseBody setup a second time.

   Real-usage marker (billing trust — see ai-proxy's settleAndRecord):
   - After settlement, ai-proxy appends one final `\x1b[usage]{...}` line to
     the stream carrying the REAL settled token counts + charged USD cost —
     see parseUsageMarker below. It is an out-of-band channel multiplexed
     into the same plain-text stream, the same convention already used for
     `\x1b[reasoning]` lines (see brainSearchLoop.ts's OUT_OF_BAND_MARKER,
     which strips it from the interactive chat's visible UI text).
   - streamManagedAgentTurn (used by managedAgent.ts's agent loop) parses it
     directly and reports it via the optional `onUsage` callback instead of
     yielding it, so managedAgent.ts can prefer real settled usage over its
     ceil(chars/4) estimate for onMetrics.
   - streamProxyBody (used by the interactive assistant chat, via
     buildManagedRunTurn) captures it the same way to feed costStore's
     addUsage with real token counts.
   - Absent (older ai-proxy deployment) or malformed → both call sites fall
     back to the pre-existing chars/4 estimate, unchanged.
   - T0.4: when missionId/projectId are supplied (managedAgent.ts's calls
     always provide them), streamManagedAgentTurn additionally emits a
     corrective journal spend.tokens event (source 'settled') carrying the
     settled totals — independent of managedAgent.ts's own per-turn
     mission.step/spend.tokens instrumentation, so the journal always has
     the ai-proxy's authoritative figure even if a caller's own estimate
     bookkeeping differs.
*/

import type { ModelProvider, ModelInfo, StreamChatRequest, StreamEvent } from './types.js';
import type { ReasoningEffort } from './openrouterCatalog.js';
import {
  OPENROUTER_MODELS,
  DEFAULT_OPENROUTER_MODEL_ID,
  findOpenRouterModel,
  priceBadge,
} from './openrouterCatalog.js';
import { loadAccessSettings } from './accessSettings.js';
import { supabase } from '../supabase/client.js';
import { addUsage } from './costStore.js';
import { emitBuffered } from '../journal/journal.js';
import { buildSystemPrompt } from './systemPrompts.js';
import { supabaseAnonKey, getAiProxyUrl } from '../env.js';
import { emit } from '../bus.js';
import { stripInvisibleLines } from './brainSearchLoop.js';
import { withAssistantToolLoop as withBrainSearchLoop } from './assistantToolLoop.js';
import { streamChatEventsImpl } from './managedProviderEvents.js';

// Re-export stripInvisibleLines so existing consumers (tests) keep working.
export { stripInvisibleLines };

/** Thrown when the managed backend is unavailable (e.g. key not configured). */
export class ManagedUnavailableError extends Error {
  readonly code: string;
  constructor(message: string, code = 'managed_unavailable') {
    super(message);
    this.name = 'ManagedUnavailableError';
    this.code = code;
  }
}

/** Real (settled, not estimated) usage reported by ai-proxy's final
 *  `\x1b[usage]` marker — see settleAndRecord in supabase/functions/ai-proxy/index.ts. */
export interface RealUsage {
  inputTokens: number;
  outputTokens: number;
  /** Billed USD cost (provider cost * MARKUP) — what the wallet was charged. */
  costUsd: number;
  /** Anthropic prompt-cache READ tokens for this turn (subset of
   *  inputTokens) — undefined on an older ai-proxy deployment that doesn't
   *  emit the field yet, or on a turn that touched no cache. Never used for
   *  billing (costUsd above is always the real charge); purely so the
   *  saving is observable rather than assumed — see ai-proxy's
   *  pricing.ts CostBreakdown. */
  cacheReadTokens?: number;
  /** Anthropic prompt-cache WRITE (creation) tokens for this turn — same
   *  undefined-when-absent contract as cacheReadTokens above. */
  cacheCreationTokens?: number;
  /** Estimated USD this call saved (or, on a cache-priming call with no
   *  reads yet, spent EXTRA) vs. running with no caching at all —
   *  informational only, never billed. See ai-proxy's
   *  CostBreakdown.cacheSavingsUsd for the exact computation. */
  cacheSavingsUsd?: number;
}

/** Builds the optional-cache-fields slice of a costStore.addUsage() call
 *  from a RealUsage record — shared by streamProxyBody and
 *  streamManagedAgentTurn's `finally` blocks below so the two call sites
 *  don't hand-roll the same conditional spread twice. Uses conditional
 *  spread (never an explicit `field: undefined`) so a marker that omitted a
 *  cache field produces a costStore.UsageRecord with that key truly ABSENT,
 *  not present-and-undefined — keeps exact-shape test assertions
 *  (`toEqual`/`toHaveBeenCalledWith`) on the pre-existing 3-field call shape
 *  passing unchanged for an older ai-proxy deployment's marker. */
function cacheFieldsFromRealUsage(
  usage: RealUsage,
): Pick<Partial<RealUsage>, 'cacheReadTokens' | 'cacheCreationTokens' | 'cacheSavingsUsd'> {
  return {
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheCreationTokens !== undefined ? { cacheCreationTokens: usage.cacheCreationTokens } : {}),
    ...(usage.cacheSavingsUsd !== undefined ? { cacheSavingsUsd: usage.cacheSavingsUsd } : {}),
  };
}

// BUG-1/BUG-3 — the header wallet badge (AccountChip.tsx, wave B) can show a
// stale balance for tens of minutes: nothing tells it to refetch when a
// mission's spend actually settles or when the wallet hits empty. Emitting
// 'billing:walletMaybeStale' on the bus lets it refresh on demand instead of
// polling. Coalesced to one emit per WALLET_STALE_NOTICE_WINDOW_MS so a
// parallel fleet hammering the same no_credits wall (or settling several
// missions at once) doesn't spam the subscriber with N identical refreshes.
let lastWalletStaleNoticeMs = 0;
const WALLET_STALE_NOTICE_WINDOW_MS = 5_000;

function notifyWalletMaybeStale(): void {
  const now = Date.now();
  if (now - lastWalletStaleNoticeMs < WALLET_STALE_NOTICE_WINDOW_MS) return;
  lastWalletStaleNoticeMs = now;
  emit('billing:walletMaybeStale', undefined);
}

/** Matches the marker anywhere in a line (not just at its start — same
 *  tolerance as the reasoning marker, see brainSearchLoop.ts) and captures
 *  the single-line JSON payload that follows it. The ESC byte is optional
 *  (`\x1b?`) for the same reason brainSearchLoop.ts's OUT_OF_BAND_MARKER
 *  tolerates it: a bare "[usage]" (ESC byte dropped somewhere in transit)
 *  must still be recognized as the marker, never leak as visible text. */
// eslint-disable-next-line no-control-regex -- intentional: matching the ANSI escape byte itself (same pattern as brainSearchLoop.ts's OUT_OF_BAND_MARKER)
const USAGE_MARKER_RE = /\x1b?\[usage\](\{[^\n\r]*\})/;

/** Reasoning-channel line marker (see brainSearchLoop.ts's OUT_OF_BAND_MARKER
 *  for the same tolerance/rationale) — a whole line starting with this is
 *  chain-of-thought spillover, never real answer text, and is dropped
 *  entirely (unlike the usage marker, which may share a line with real
 *  prose before it — see extractManagedProviderLine). */
// eslint-disable-next-line no-control-regex -- intentional: matching the ANSI escape byte itself
const REASONING_LINE_RE = /^\x1b?\[reasoning\]/;

/**
 * Classifies ONE COMPLETE line of raw managed-provider text (never call this
 * on a chunk that might still be split mid-marker — see createManagedLineBuffer):
 *   - a whole reasoning-channel line is dropped entirely;
 *   - a usage-marker line has any prose BEFORE the marker preserved and the
 *     marker JSON itself removed, with `onUsage` invoked when it parses —
 *     mirrors brainSearchLoop.ts's cleanLine (marker can appear anywhere in
 *     the line, not just at its start, so a chunk-boundary artifact that
 *     glues real prose directly onto the marker with no newline between
 *     them still keeps the prose and drops only the marker);
 *   - any other line passes through unchanged (including a legitimately
 *     blank line, and any line containing ordinary `{`/`}` braces that are
 *     not this exact marker shape).
 */
function extractManagedProviderLine(line: string, onUsage: (usage: RealUsage) => void): string {
  if (REASONING_LINE_RE.test(line)) return '';

  const usage = parseUsageMarker(line);
  if (usage) onUsage(usage);

  const markerIdx = line.search(USAGE_MARKER_RE);
  return markerIdx === -1 ? line : line.slice(0, markerIdx);
}

/**
 * Line-buffered filter for streamManagedAgentTurn's raw proxy text.
 *
 * BUG FIXED (M12 dogfood, MAJEUR #4 — JSON leak in the manager bubble): the
 * previous implementation ran `text.split('\n')` on each raw decoded fetch
 * chunk IN ISOLATION, with no buffering across chunks. A `ReadableStream`
 * chunk boundary has no relationship to the marker's own boundaries, so a
 * chunk could split RIGHT IN THE MIDDLE of `\x1b[usage]{"inputTokens":1140,
 * "outputTokens":536,"costUsd":0.0567}`: the first chunk's tail
 * (`\x1b[usage]{"inputTokens":11`) DID start with the marker prefix and was
 * dropped correctly, but the SECOND chunk's head (`40,"outputTokens":536,
 * "costUsd":0.0567}`) no longer looked like the marker at all — it sailed
 * through unfiltered and got glued directly onto the end of the previous
 * chunk's visible text with no separator, producing exactly the observed
 * `…prêt.40,"outputTokens":536,"costUsd":0.0567}` leak in the manager bubble.
 *
 * Fix: only ever classify a line once it is known COMPLETE (terminated by a
 * real `\n` seen in the raw stream, or the stream has ended) — mirrors the
 * `lineBuffer` pattern already used by assistantToolLoop.ts / brainSearchLoop.ts
 * for the exact same class of problem on the assistant-chat path. Exported
 * as its own buffer object (rather than inlined in the read loop) so the
 * identical buffering + classification logic backing the real stream can be
 * unit-tested by feeding arbitrary chunk splits directly — no fetch/
 * ReadableStream mocking required.
 */
export function createManagedLineBuffer(onUsage: (usage: RealUsage) => void): {
  feed: (text: string) => string;
  flush: () => string;
} {
  let buffer = '';

  // Reconstructs a run of one-or-more '\n'-joined lines from `raw` with
  // reasoning/usage-marker lines removed — mirrors brainSearchLoop.ts's own
  // stripInvisibleLines reconstruction (filter, not blank-in-place): a line
  // that is stripped down to '' AND was not ORIGINALLY blank is dropped from
  // the array entirely before rejoining, so removing it never leaves a
  // stray leading/trailing '\n' behind (the exact artifact `.map(classify)
  // .join('\n')` produced: a dropped FIRST line left a leading '\n', see the
  // "drops a whole reasoning-channel line" regression test). A line that WAS
  // originally blank (a real paragraph break) is always kept.
  const classifyLines = (raw: string): string =>
    raw
      .split('\n')
      .map((line) => {
        const wasBlank = line.trim() === '';
        const cleaned = extractManagedProviderLine(line, onUsage);
        return { cleaned, keep: wasBlank || cleaned !== '' };
      })
      .filter((entry) => entry.keep)
      .map((entry) => entry.cleaned)
      .join('\n');

  return {
    feed(text: string): string {
      buffer += text;
      const lastNewline = buffer.lastIndexOf('\n');
      if (lastNewline === -1) return '';
      const completeLines = buffer.slice(0, lastNewline + 1);
      buffer = buffer.slice(lastNewline + 1);
      return classifyLines(completeLines);
    },
    flush(): string {
      if (!buffer) return '';
      const result = classifyLines(buffer);
      buffer = '';
      return result;
    },
  };
}

/**
 * Parses a `\x1b[usage]{...}` marker line into a RealUsage record. Returns
 * null when the line isn't a usage marker, or the JSON payload doesn't have
 * the expected shape — defensive: an older or differently-shaped ai-proxy
 * deployment must never crash the client, it should just fall back to the
 * chars/4 estimate like before this marker existed.
 *
 * The three cache fields (cacheReadTokens/cacheCreationTokens/
 * cacheSavingsUsd) are OPTIONAL and additive: a marker from an ai-proxy
 * deployment that predates them simply omits the keys, and they are left
 * off the returned object entirely (never set to `undefined` as an own
 * property) rather than failing the whole parse — same tolerance as the
 * three required fields being ABSENT (older proxy) vs. present-but-wrong
 * TYPE (malformed — still only drops the one field, not the whole marker,
 * since a bad cache figure must never mask the real settled token/cost
 * numbers the rest of this object carries).
 */
export function parseUsageMarker(line: string): RealUsage | null {
  const match = USAGE_MARKER_RE.exec(line);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Partial<RealUsage>;
    if (
      typeof parsed.inputTokens !== 'number' ||
      typeof parsed.outputTokens !== 'number' ||
      typeof parsed.costUsd !== 'number'
    ) {
      return null;
    }
    const usage: RealUsage = {
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      costUsd: parsed.costUsd,
    };
    if (typeof parsed.cacheReadTokens === 'number') usage.cacheReadTokens = parsed.cacheReadTokens;
    if (typeof parsed.cacheCreationTokens === 'number') usage.cacheCreationTokens = parsed.cacheCreationTokens;
    if (typeof parsed.cacheSavingsUsd === 'number') usage.cacheSavingsUsd = parsed.cacheSavingsUsd;
    return usage;
  } catch {
    return null;
  }
}

/** Exported for managedProviderEvents.ts's structured-event counterpart. */
export function generateRequestId(): string {
  return `mp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ProxyErrorBody {
  error?: string;
  code?: string;
}

// ── Prompt caching (chantier 2 — stop retransmitting the ~73k-char manager
// core every turn) ──────────────────────────────────────────────────────
//
// Anthropic (and OpenRouter's pass-through for Anthropic models, via its
// chat-completions endpoint's "explicit cache breakpoint" shape — see
// https://openrouter.ai/docs/guides/best-practices/prompt-caching) supports
// marking a system-message content block with `cache_control: { type:
// "ephemeral" }`. A byte-identical repeat of everything up to and including
// that block becomes a cache hit: cheaper AND faster on the next call. This
// only pays off for a block that is IDENTICAL across calls — exactly what
// managerEngine.ts's buildManagerCorePrompt() is (no per-turn state baked
// in), versus buildManagerDynamicContext() which changes every turn and
// must never be cached.

/** The real `cache_control` value Anthropic/OpenRouter expect on a content
 *  block. */
export interface AnthropicCacheControl {
  type: 'ephemeral';
}

/** One block of a system message's `content` array (OpenRouter/Anthropic
 *  "explicit breakpoint" shape) — a plain string `system` is still valid
 *  and is what every caller sends today. */
export interface SystemContentBlock {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl;
}

/**
 * Build the two-block system `content` array for an explicit cache
 * breakpoint: `staticText` carries `cache_control: { type: 'ephemeral' }`
 * (eligible for a cache hit whenever an identical prefix repeats);
 * `dynamicText` (per-turn/per-round state) is a second, uncached block.
 * Concatenating the two blocks' `text` in order reproduces byte-for-byte
 * `staticText + dynamicText` — this only changes the WIRE shape, never
 * what the model actually receives.
 *
 * Omits the dynamic block entirely when empty rather than sending an empty
 * text block.
 */
export function buildCacheableSystemBlocks(staticText: string, dynamicText: string): SystemContentBlock[] {
  const blocks: SystemContentBlock[] = [
    { type: 'text', text: staticText, cache_control: { type: 'ephemeral' } },
  ];
  if (dynamicText.length > 0) {
    blocks.push({ type: 'text', text: dynamicText });
  }
  return blocks;
}

/** A system prompt already split into a STATIC part (identical across
 *  turns/rounds — the cache-eligible prefix) and a DYNAMIC part (per-turn
 *  state, never cached). See AgentTurnOpts.cacheableSystem. */
export interface CacheableSystemPrompt {
  core: string;
  dynamic: string;
}

/** Anthropic-family models only — a non-Anthropic OpenRouter model gets no
 *  benefit from `cache_control` and some providers reject the unrecognized
 *  field outright. Mirrors lazyReasoningBlocks/promptCaching.ts's
 *  isCachingSupportedModel (kept as a small local duplicate rather than an
 *  import: this file lives in src/lib/models/, one layer below src/lib/
 *  agents/ in this codebase's dependency direction — see that no other file
 *  in src/lib/models/ imports from ../agents/). */
function modelSupportsCacheControl(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes('claude') || lower.includes('anthropic') || lower.includes('opus') || lower.includes('sonnet') || lower.includes('haiku');
}

/**
 * Whether the ai-proxy Edge Function (supabase/functions/ai-proxy/index.ts,
 * this repo) accepts an ARRAY of system content blocks (SystemContentBlock[])
 * for ProxyRequestBody.system instead of a plain string.
 *
 * TRUE as of the matching ai-proxy patch in this same change: `system` there
 * is now `string | SystemContentBlock[]` (pricing.ts's SystemContent),
 * validated by `isValidSystemContent`, measured by `systemContentLength`
 * (an array's own `.length` is its block COUNT, not a char count — the
 * pre-patch code read `body.system.length` directly and would have
 * miscomputed the cost-reservation estimate on an array), and forwarded
 * as-is into the OpenRouter system message's `content` by
 * `buildSystemMessages` (see that module's doc comments for the OpenRouter
 * request-shape reference this mirrors). Backward compatible in both
 * directions: a plain string still round-trips unchanged, so an older
 * client build talking to the patched proxy is unaffected.
 *
 * ⚠️ DEPLOY ORDERING — this constant only describes what the CODE in this
 * repo does; it says nothing about what is actually running in production.
 * A client BUILD shipped with this flag `true` will send an array `system`
 * on every managed-mode Anthropic-family call. If that build reaches users
 * BEFORE `supabase functions deploy ai-proxy` has shipped the matching
 * server patch, the OLD deployed handler crashes on `body.system.trim()`
 * (not a function on an array) — every managed chat/mission call 500s until
 * the proxy catches up. The ai-proxy deploy must land first (see the deploy
 * runbook in this change's report). This repo commit does NOT deploy
 * anything by itself — flipping this constant here only takes effect once a
 * built client ships, which is a separate, later step the owner controls.
 *
 * While false (rollback / pre-deploy safety), resolveProxySystemField below
 * always flattens `cacheableSystem` back into a single string
 * BYTE-IDENTICAL to what a caller would have sent as `system` before this
 * field existed.
 *
 * SAFETY GATE (2026-08-15): Set to false until ai-proxy is deployed to production.
 * To enable: (1) deploy `supabase functions deploy ai-proxy --project-ref <supabase-project-ref>`;
 * (2) verify a real call returns `cacheReadTokens > 0` on a second request;
 * (3) flip this flag to true; (4) ship the client build. NEVER ship with this true
 * before the proxy deploy lands.
 */
const AI_PROXY_SUPPORTS_CACHE_BLOCKS = false;

/**
 * Resolve the `system` field of the ai-proxy request body. When the caller
 * supplies `cacheableSystem` AND the deployed proxy is known to support the
 * block shape AND the model actually benefits from Anthropic-style caching,
 * sends the real two-block array; otherwise falls back to a single
 * flattened string, `${core}${dynamic}` — identical to what `opts.system`
 * already holds (see AgentTurnOpts.system's doc comment).
 *
 * `supportsCacheBlocks` is a parameter (default AI_PROXY_SUPPORTS_CACHE_BLOCKS)
 * so tests can exercise the block-building path without faking a proxy
 * deploy.
 */
export function resolveProxySystemField(
  opts: Pick<AgentTurnOpts, 'system' | 'model' | 'cacheableSystem'>,
  supportsCacheBlocks: boolean = AI_PROXY_SUPPORTS_CACHE_BLOCKS,
): string | SystemContentBlock[] {
  const { cacheableSystem } = opts;
  if (!cacheableSystem) return opts.system;
  if (!supportsCacheBlocks || !modelSupportsCacheControl(opts.model)) {
    return `${cacheableSystem.core}${cacheableSystem.dynamic}`;
  }
  return buildCacheableSystemBlocks(cacheableSystem.core, cacheableSystem.dynamic);
}

/** Shape of the JSON body sent to the ai-proxy Edge Function. Exported for
 *  managedProviderEvents.ts's structured-event counterpart. */
export interface ProxyRequestBody {
  messages: Array<{ role: string; content: string }>;
  system: string | SystemContentBlock[];
  model: string;
  request_id: string;
  feature: 'assistant';
  reasoningEffort?: ReasoningEffort;
  webSearch?: boolean;
  responseHealing?: boolean;
  /** Output ceiling for this request. Omitted = the proxy's default (8k).
   *  The proxy clamps it to the model's own maxTokens, so a caller that
   *  expects a long answer can raise it up to OpenRouterModel.maxTokens —
   *  at the cost of a proportionally larger credit reservation. */
  maxTokens?: number;
}

/**
 * POST a proxy body and stream its plain-text response chunks.
 *
 * Tracks output chars into the session-local cost badge (the proxy remains the
 * billing source of truth). Throws ManagedUnavailableError on a non-OK status.
 *
 * Exported (in addition to being used by streamChatImpl/streamManagedAgentTurn
 * below) so managedProviderEvents.ts's structured-event counterpart can reuse
 * this exact same fetch/usage-marker-capture logic instead of a second copy.
 */
export async function* streamProxyBody(
  body: ProxyRequestBody,
  accessToken: string,
  modelId: string,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const res = await fetch(getAiProxyUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let parsed: ProxyErrorBody = {};
    try {
      parsed = (await res.json()) as ProxyErrorBody;
    } catch {
      // non-JSON error body — ignore
    }
    const message = parsed.error ?? `Proxy error ${res.status}`;
    const code = parsed.code ?? String(res.status);
    if (code === 'no_credits') notifyWalletMaybeStale();
    // 503 (key not set) is recoverable — the gateway falls back.
    throw new ManagedUnavailableError(message, code);
  }

  if (!res.body) {
    throw new ManagedUnavailableError('Réponse vide du proxy géré', 'empty_response');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let outputChars = 0;
  // Real settled usage, captured when the proxy's final marker line is seen
  // (see module header). The raw marker text is left in `text` untouched
  // here — it still needs to reach the shared loop's visible-text stripping
  // pass (assistantToolLoop.ts's stripVisibleDirectives, which composes
  // brainSearchLoop.ts's stripInvisibleLines) to be hidden from the UI.
  let realUsage: RealUsage | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) break;
      const text = decoder.decode(value, { stream: true });
      if (text) {
        for (const line of text.split('\n')) {
          const usage = parseUsageMarker(line);
          if (usage) realUsage = usage;
        }
        outputChars += text.length;
        yield text;
      }
    }
  } finally {
    reader.releaseLock();
    // The proxy is the source of truth for billing. Prefer its real settled
    // usage (parseUsageMarker) when present; fall back to the rough ≈4
    // chars/token estimate for older proxy deployments that don't emit the
    // marker yet — identical behavior to before this change.
    if (realUsage) {
      addUsage({
        inputTokens: realUsage.inputTokens,
        outputTokens: realUsage.outputTokens,
        model: modelId,
        ...cacheFieldsFromRealUsage(realUsage),
      });
    } else if (outputChars > 0) {
      addUsage({
        inputTokens: 0,
        outputTokens: Math.ceil(outputChars / 4),
        model: modelId,
      });
    }
  }
}


/** Bundles the per-request context resolved ONCE before the ReAct loop
 *  starts: the session token, the resolved model id, and the static parts of
 *  the proxy body (system prompt, reasoning effort, plugin toggles). Exported
 *  so managedProviderEvents.ts's streamChatEventsImpl can reuse the exact
 *  same resolution instead of a second copy — see this file's header. */
export interface ManagedTurnContext {
  baseBody: ProxyRequestBody;
  accessToken: string;
  modelId: string;
}

/**
 * Resolve the session token, the OpenRouter model id, and the static proxy
 * body (system prompt + reasoning/plugin flags) for one assistant chat
 * request. Called ONCE per streamChatImpl/streamChatEventsImpl invocation —
 * NOT per ReAct round (see buildManagedRunTurn, which re-spreads this into
 * each round's turnBody with a fresh request_id).
 */
export async function resolveManagedTurnContext(req: StreamChatRequest): Promise<ManagedTurnContext> {
  // Resolve the current session JWT.
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    throw new ManagedUnavailableError(
      'Session requise pour le mode géré',
      'not_subscribed',
    );
  }

  // Resolve the OpenRouter model id from AccessSettings.
  // Fall back to the catalog default when the user has not selected one yet.
  const settings = loadAccessSettings();
  const modelId = settings.model ?? DEFAULT_OPENROUTER_MODEL_ID;
  const catalogEntry = findOpenRouterModel(modelId);

  const system = buildSystemPrompt(req.mode, req.brainRecall, {
    rulesContext: req.rulesContext,
    startupContext: req.startupContext,
    skillContext: req.skillContext,
    tools: req.tools,
    // This provider DOES run the shared tool loop (see buildManagedRunTurn
    // below) — see systemPrompts.ts's supportsToolLoop doc comment for why
    // this must be declared explicitly rather than relying on the default.
    supportsToolLoop: true,
    // Forward user-selected output styles (terse prose, less code, etc.)
    outputStyles: settings.outputStyles,
  });

  // Static parts of the proxy body, reused across every round — `messages`
  // is always overwritten per round by buildManagedRunTurn, so its value
  // here is an unused placeholder.
  const baseBody: ProxyRequestBody = {
    messages: [],
    system,
    model: modelId,
    request_id: generateRequestId(),
    feature: 'assistant',
  };

  if (catalogEntry?.reasoning === true) {
    const effort: ReasoningEffort = settings.reasoningEffort ?? 'medium';
    baseBody.reasoningEffort = effort;
  }

  // Forward plugin toggles when the model supports them.
  if (settings.webSearch === true && catalogEntry?.webSearch === true) {
    baseBody.webSearch = true;
  }
  if (settings.responseHealing === true) {
    baseBody.responseHealing = true;
  }

  return { baseBody, accessToken, modelId };
}

/**
 * Build the per-round `runTurn` callback that withAssistantToolLoop /
 * withAssistantToolLoopEvents drive — one call per ReAct round, each with
 * that round's full message history. Reuses streamProxyBody (the SAME
 * fetch/auth-header/usage-marker-capture logic streamManagedAgentTurn
 * already relies on) so nothing about the wire protocol or credit metering
 * is duplicated here — see this file's header.
 */
export function buildManagedRunTurn(
  ctx: ManagedTurnContext,
  signal?: AbortSignal,
): (turnMessages: Array<{ role: string; content: string }>) => AsyncGenerator<string> {
  return async function* runTurn(
    turnMessages: Array<{ role: string; content: string }>,
  ): AsyncGenerator<string> {
    // Apply Caveman compression when enabled in AccessSettings.
    const settings = loadAccessSettings();
    let messagesToSend = turnMessages;
    if (settings.compressionEnabled) {
      const { compressMessages } = await import('../compression/index.js');
      const result = compressMessages(turnMessages, {
        enabled: true,
        intensity: settings.compressionIntensity ?? 'full',
      });
      messagesToSend = result.messages;
    }

    const turnBody: ProxyRequestBody = {
      ...ctx.baseBody,
      messages: messagesToSend,
      request_id: generateRequestId(),
    };
    yield* streamProxyBody(turnBody, ctx.accessToken, ctx.modelId, signal);
  };
}

/**
 * Stream one assistant-chat turn through the managed backend, running the
 * SAME extended ReAct loop (brain directives + general tool directives —
 * WEB_SEARCH, WEB_FETCH, READ_FILE, READ_DIR, SEARCH_CODE, GIT_*) as
 * anthropicProvider/claudeCodeProvider/cliBackendProvider. See this file's
 * header for why this used to be a separate, narrower loop.
 */
async function* streamChatImpl(req: StreamChatRequest): AsyncIterable<string> {
  const ctx = await resolveManagedTurnContext(req);
  yield* withBrainSearchLoop(req, buildManagedRunTurn(ctx, req.signal));
}

/** Map an OpenRouterModel to the ModelInfo shape expected by ModelProvider. */
function toModelInfo(m: (typeof OPENROUTER_MODELS)[number]): ModelInfo {
  const badge = priceBadge(m);
  return {
    id: m.id,
    label: m.label,
    provider: m.provider,
    description: `${m.tier} · ${badge}`,
  };
}

// ── Agent turn streaming ──────────────────────────────────────────

export interface AgentTurnOpts {
  messages: Array<{ role: string; content: string }>;
  /** Always the full flat system prompt (core + dynamic concatenated) —
   *  the exact text sent to the model whenever `cacheableSystem` below is
   *  absent, or the model doesn't support caching, or AI_PROXY_SUPPORTS_CACHE_BLOCKS
   *  has been rolled back to false. Every existing caller keeps passing
   *  this exactly as before; it is never dropped, only sometimes replaced
   *  on the wire by the equivalent cache-block array. */
  system: string;
  model: string;
  signal?: AbortSignal;
  /** Optional cache-aware split of `system` into a STATIC core (identical
   *  across turns/rounds for the SAME caller — e.g. managerEngine.ts's
   *  buildManagerCorePrompt) and a DYNAMIC per-turn remainder. See
   *  resolveProxySystemField/AI_PROXY_SUPPORTS_CACHE_BLOCKS above for
   *  exactly when this is honored — always safe to pass: `system` above
   *  remains the guaranteed-identical fallback otherwise. `core + dynamic`
   *  MUST reconstruct `system` exactly for the fallback to be lossless. */
  cacheableSystem?: CacheableSystemPrompt;
  /** Reasoning effort forwarded to the proxy when the model supports it.
   *  Mirrors AccessSettings.reasoningEffort / MissionContract.effort. */
  reasoningEffort?: ReasoningEffort;
  /** Invoked synchronously (from inside the read loop) when the proxy's
   *  final `\x1b[usage]` marker is parsed — see module header. Lets callers
   *  (managedAgent.ts) prefer real settled usage over the chars/4 estimate
   *  for THIS turn. Never called when the marker is absent or malformed
   *  (older ai-proxy deployment — the caller keeps its existing fallback). */
  onUsage?: (usage: RealUsage) => void;
  /** Journal identity (T0.4) — when both are present, a settled real-usage
   *  marker also emits a corrective spend.tokens journal event (source
   *  'settled') carrying the ai-proxy's settled totals. Optional so a
   *  caller with no mission/project context (or an older call site) simply
   *  gets the pre-existing onUsage/addUsage behavior with no journal
   *  side effect. */
  missionId?: string;
  projectId?: string;
}

/**
 * Stream a single agent turn via the ai-proxy, using the provided model id
 * (OpenRouter format, e.g. 'anthropic/claude-sonnet-5').
 *
 * Reasoning chunks (lines prefixed with \x1b[reasoning]) and the trailing
 * real-usage marker (lines prefixed with \x1b[usage] — reported via
 * opts.onUsage instead) are filtered out before yielding to the caller.
 */
export async function* streamManagedAgentTurn(opts: AgentTurnOpts): AsyncIterable<string> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    throw new ManagedUnavailableError(
      'Session requise pour le mode géré (agent)',
      'not_subscribed',
    );
  }

  const body: ProxyRequestBody = {
    messages: opts.messages,
    system: resolveProxySystemField(opts),
    model: opts.model,
    request_id: generateRequestId(),
    feature: 'assistant',
    ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
  };

  const res = await fetch(getAiProxyUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    let parsed: ProxyErrorBody = {};
    try {
      parsed = (await res.json()) as ProxyErrorBody;
    } catch {
      // non-JSON error body — ignore
    }
    const message = parsed.error ?? `Proxy error ${res.status}`;
    const code = parsed.code ?? String(res.status);
    if (code === 'no_credits') notifyWalletMaybeStale();
    throw new ManagedUnavailableError(message, code);
  }

  if (!res.body) {
    throw new ManagedUnavailableError('Réponse vide du proxy géré (agent)', 'empty_response');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let outputChars = 0;
  // Real settled usage for THIS turn, captured when the marker line is seen
  // — used both to notify opts.onUsage (managedAgent.ts's onMetrics) and to
  // improve this turn's contribution to the session-local cost badge below.
  // A one-field mutable box (not a bare `let` reassigned from inside the
  // createManagedLineBuffer callback below): TypeScript's control-flow
  // narrowing does not track a `let` mutated only from within a passed-in
  // callback, so a later `if (capturedUsage.value)` read would otherwise
  // narrow against the variable's ORIGINAL `null` initializer instead of
  // its true possible types, typing the guarded block as `never`. Mutating
  // a property on an object read through this same reference sidesteps
  // that limitation entirely.
  const capturedUsage: { value: RealUsage | null } = { value: null };
  // Line-buffered filter — see createManagedLineBuffer's doc comment for why
  // this must never classify a raw decoded chunk in isolation (a chunk
  // boundary can split the usage marker itself, leaking its tail as visible
  // text — the exact manager-bubble JSON leak this buffer exists to fix).
  const lineBuffer = createManagedLineBuffer((usage: RealUsage) => {
    capturedUsage.value = usage;
    opts.onUsage?.(usage);
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (opts.signal?.aborted) break;
      const text = decoder.decode(value, { stream: true });
      if (!text) continue;
      const visible = lineBuffer.feed(text);
      if (visible) {
        outputChars += visible.length;
        yield visible;
      }
    }
    // Stream ended — the buffer's trailing partial line (no terminating
    // '\n' was ever seen for it) is now known-complete: no more bytes are
    // coming that could still finish a split marker, so it is safe to
    // classify and flush.
    const tail = lineBuffer.flush();
    if (tail) {
      outputChars += tail.length;
      yield tail;
    }
  } finally {
    reader.releaseLock();
    const settledUsage = capturedUsage.value;
    if (settledUsage) {
      addUsage({
        inputTokens: settledUsage.inputTokens,
        outputTokens: settledUsage.outputTokens,
        model: opts.model,
        // Forward the REAL settled cost (0 for free models like ox alpha) so
        // costStore never re-estimates a free turn at the hard-coded Haiku
        // rates and surfaces a fake "~1 credit" in the manager/agent UI.
        costUsd: settledUsage.costUsd,
        ...cacheFieldsFromRealUsage(settledUsage),
      });
      // BUG-3(c) — a real spend just settled; the header wallet badge may
      // now be stale (coalesced, see notifyWalletMaybeStale's doc comment).
      notifyWalletMaybeStale();
      // T0.4 — corrective journal event: the ai-proxy's settled totals
      // supersede whatever estimate the caller (managedAgent.ts) may already
      // have reported for this turn. Carries the settled totals rather than
      // a delta against that estimate — this function has no visibility
      // into what the caller already emitted (that bookkeeping lives in
      // managedAgent.ts's own closure), so the settled totals are the only
      // figure it can report accurately.
      //
      // Cache fields (cacheReadTokens/cacheCreationTokens/cacheSavingsUsd)
      // are deliberately NOT added to this payload — spend.tokens is a
      // fixed shape consumed by the Rust journal store (journal.ts maps
      // exactly tokens_in/tokens_out/cost_usd), out of this change's
      // perimeter. costStore.addUsage above is the observable surface for
      // cache savings this wave; extending the journal event is a separate,
      // cross-cutting follow-up.
      if (opts.missionId && opts.projectId) {
        emitBuffered({
          tsMs: Date.now(),
          projectId: opts.projectId,
          missionId: opts.missionId,
          actor: 'agent',
          type: 'spend.tokens',
          payload: {
            tokensIn: settledUsage.inputTokens,
            tokensOut: settledUsage.outputTokens,
            costUsd: settledUsage.costUsd,
            source: 'settled',
          },
        });
      }
    } else if (outputChars > 0) {
      addUsage({
        inputTokens: 0,
        outputTokens: Math.ceil(outputChars / 4),
        model: opts.model,
      });
    }
  }
}

export const managedProvider: ModelProvider = {
  id: 'managed',
  label: 'Pro · géré',

  listModels(): ModelInfo[] {
    return OPENROUTER_MODELS.map(toModelInfo);
  },

  streamChat(req: StreamChatRequest): AsyncIterable<string> {
    return streamChatImpl(req);
  },

  streamChatEvents(req: StreamChatRequest): AsyncIterable<StreamEvent> {
    return streamChatEventsImpl(req);
  },
};
