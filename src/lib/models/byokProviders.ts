/* byokProviders — first-class BYOK providers for Lazy.

   Every provider a user can bring their own key to, with the same ease as
   the Claude CLI / LazyPro rails: a card in ProvidersPanel, a key field in
   Settings > Models, a pre-filled base URL, and a model list.

   Two wire formats are supported:
   - 'openai'   : POST {base}/chat/completions with `Authorization: Bearer`
                  (DeepSeek, OpenRouter, xAI, Groq, Mistral, OpenAI, any
                  OpenAI-compatible gateway).
   - 'anthropic': POST {base}/v1/messages with `x-api-key` (Anthropic and
                  Anthropic-compatible gateways, e.g. DeepSeek's
                  https://api.deepseek.com/anthropic).

   Persistence — never sent to Lazy, but the API key's storage differs by
   platform (audit 2026-08-12: the old scheme stored the raw key in
   localStorage, a plain SQLite file readable by any process running as the
   same OS user):
   - Desktop (Tauri): the API key lives in the OS credential vault (see
     ../vault/vaultClient.ts, backed by src-tauri/src/commands/vault.rs's
     `keyring`-based store). loadByokKey/saveByokKey/hasByokKey stay
     SYNCHRONOUS — every existing caller here (resolveByokAgentTurnStreamer,
     createOpenAICompatProvider, scheduler.ts, anthropicProvider.ts,
     SettingsSpace.tsx) calls them synchronously — by keeping an in-memory
     mirror (`byokVaultCache`) that's warmed once at startup via
     `initByokVault()` (which also runs the one-time localStorage->vault
     migration) and kept in sync on every save.
   - Browser / Playwright (non-Tauri): there is no OS credential vault
     inside a browser tab, so this is an EXPLICIT, intentional fallback —
     the key still lives in localStorage under `lazy.apikey.<provider>`,
     unchanged from before this file's vault integration.
   - lazy.baseurl.<provider>  : base URL override (default = provider default)
   - lazy.model.<provider>    : model override (default = provider default)
   (baseUrl/model overrides are not secrets — left in localStorage on every
   platform, desktop included.)

   The desktop WebView CSP (tauri.conf.json) must list every provider host in
   connect-src — the security audit keeps that list scoped to known providers.
*/

import type { ModelInfo, ModelProvider, StreamChatRequest } from './types.js';
import { buildSystemPrompt } from './systemPrompts.js';
import { buildCacheableSystemBlocks, type SystemContentBlock } from './managedProvider.js';
import { getSecretRaw, setSecret, deleteSecret, migrateByokKeysToVault, byokVaultKey } from '../vault/vaultClient.js';

/** Same Tauri-sentinel check as ../platform/index.js's isTauri(), duplicated
 *  (rather than imported) so this module has no dependency on the platform
 *  module — several existing test suites (managerEngine.test.ts,
 *  runtimeModelRouting.test.ts) `vi.mock('../lib/platform', ...)` with a
 *  partial mock that doesn't export isTauri, and this file must keep
 *  working unmodified there. */
function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ── Provider definitions ───────────────────────────────────────────

export type ByokProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'openrouter'
  | 'xai'
  | 'groq'
  | 'mistral';

export interface ByokModelDef {
  id: string;
  label: string;
}

export interface ByokProviderDef {
  id: ByokProvider;
  label: string;
  apiFormat: 'openai' | 'anthropic';
  defaultBaseUrl: string;
  defaultModel: string;
  models: ByokModelDef[];
}

export const BYOK_PROVIDER_DEFS: ByokProviderDef[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    apiFormat: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat (V4 Flash)' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)' },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    apiFormat: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-v4-flash',
    models: [
      { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 Mini' },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'x-ai/grok-4', label: 'Grok 4' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    apiFormat: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.4-mini',
    models: [
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
    ],
  },
  {
    id: 'xai',
    label: 'xAI',
    apiFormat: 'openai',
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4-mini',
    models: [
      { id: 'grok-4-mini', label: 'Grok 4 Mini' },
      { id: 'grok-4', label: 'Grok 4' },
    ],
  },
  {
    id: 'groq',
    label: 'Groq',
    apiFormat: 'openai',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-4-maverick',
    models: [
      { id: 'llama-4-maverick', label: 'Llama 4 Maverick' },
      { id: 'qwen-2.5-coder-32b', label: 'Qwen 2.5 Coder 32B' },
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    apiFormat: 'openai',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    models: [
      { id: 'mistral-small-latest', label: 'Mistral Small' },
      { id: 'mistral-large-latest', label: 'Mistral Large' },
      { id: 'codestral-latest', label: 'Codestral' },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    apiFormat: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5',
    models: [
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
    ],
  },
  // google intentionally has no def yet: its API is neither OpenAI- nor
  // Anthropic-compatible; the type stays for forward-compat.
];

export function resolveByokDef(provider: ByokProvider | undefined): ByokProviderDef | undefined {
  return BYOK_PROVIDER_DEFS.find((d) => d.id === provider);
}


// ── API key persistence (vault on desktop, localStorage on web) ───

const KEY_PREFIX = 'lazy.apikey.';
const URL_PREFIX = 'lazy.baseurl.';
const MODEL_PREFIX = 'lazy.model.';

// Regression (2026-08-12, live-app audit): a plain module-level `const
// byokVaultCache = new Map()` is reset to empty the instant this module is
// re-evaluated — which a dev-mode Vite/HMR reload of THIS file OR of
// anything it transitively depends on can trigger at any point after boot,
// with nothing to re-run initByokVault() afterwards. The vault itself was
// never the problem (confirmed: `secret_get`/`secret_presence` both return
// the real, valid key on request) — the in-memory mirror silently going
// back to empty was. `window` survives module re-evaluation, so the cache
// now lives there instead of in module scope; getByokVaultCache() is the
// only thing allowed to touch it.
declare global {
  interface Window {
    __lazyByokVaultCache?: Map<ByokProvider, string>;
    /** Diagnostic marker for live verification (never holds secret values —
     *  only provider ids): set by initByokVault() so `hasByokKey`/
     *  `loadByokKey` returning empty can be told apart from "warm never ran
     *  or never finished" by reading `window.__lazyByokVaultReady` from a
     *  live page. */
    __lazyByokVaultReady?: { ready: boolean; warmed: string[]; failed: string[] };
    /** Boolean-only (never the raw key) live-verification hook for
     *  hasByokKey — lets a CDP-attached probe check "does the app now see
     *  this provider's key" without needing a separate dynamic import that
     *  may or may not resolve to the SAME module instance the app itself
     *  is using (see this file's initByokVault doc comment). */
    __lazyByokDebugHasKey?: (provider: string) => boolean;
  }
}

function getByokVaultCache(): Map<ByokProvider, string> {
  if (typeof window === 'undefined') return new Map();
  if (!window.__lazyByokVaultCache) window.__lazyByokVaultCache = new Map();
  return window.__lazyByokVaultCache;
}

/** Test-only: clears the in-memory vault-mirror cache. `localStorage.clear()`
 *  alone does NOT reset this (it's separate, in-memory, Tauri-path state) —
 *  a test that calls `saveByokKey(...)` while simulating Tauri (setting
 *  `window.__TAURI_INTERNALS__`) must call this in its cleanup or the entry
 *  leaks into every later test in the same file. */
export function resetByokVaultCacheForTests(): void {
  getByokVaultCache().clear();
  if (typeof window !== 'undefined') window.__lazyByokVaultReady = undefined;
}

/**
 * Desktop-only startup hook: runs the one-time localStorage->vault
 * migration (see vaultClient.ts's migrateByokKeysToVault — silent, no-op
 * when there's nothing to migrate) and warms the vault-mirror cache so
 * loadByokKey/hasByokKey can stay synchronous. `src/main.tsx` AWAITS this
 * before mounting the app, so no routing decision (mission model selection,
 * the manager sending a turn) can observe a cold cache — a race here was
 * candidate #1 for the live-app bug this fixes. A no-op in the browser
 * build (no vault to warm — WebPlatform keeps using localStorage directly).
 *
 * Resilience: migration and every per-provider vault read are individually
 * isolated (try/catch, Promise.allSettled) — ONE provider's failure (a
 * never-configured provider, a transient vault error) can no longer prevent
 * every other provider, including a validly-keyed one, from warming. That
 * was candidate #3 (`getSecretRaw` failing for one def aborting the whole
 * `Promise.all`) and turned out to compound the module-reset issue above:
 * a single early rejection meant the cache warm never even started.
 */
export async function initByokVault(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await migrateByokKeysToVault();
  } catch (err) {
    console.error('[byokProviders] BYOK localStorage->vault migration failed (continuing to warm the cache anyway)',
      err instanceof Error ? err.message : String(err));
  }
  const cache = getByokVaultCache();
  const warmed: string[] = [];
  const failed: string[] = [];
  await Promise.allSettled(
    BYOK_PROVIDER_DEFS.map(async (def) => {
      try {
        const raw = await getSecretRaw(byokVaultKey(def.id));
        if (raw) {
          cache.set(def.id, raw);
          warmed.push(def.id);
        }
      } catch (err) {
        failed.push(def.id);
        // Never log `raw` — only which provider's vault read failed.
        console.error(`[byokProviders] vault read failed for ${def.id}`, err instanceof Error ? err.message : String(err));
      }
    }),
  );
  if (typeof window !== 'undefined') window.__lazyByokVaultReady = { ready: true, warmed, failed };
}

export function loadByokKey(provider: ByokProvider): string {
  if (isTauriRuntime()) {
    const cached = getByokVaultCache().get(provider);
    if (cached) return cached;
    // Last-resort read-only fallback, kept for defense in depth even though
    // the cache above should now be reliably warmed (see initByokVault's
    // header comment for what used to make it unreliable): saveByokKey
    // never WRITES here under Tauri, so this can only ever surface a stale
    // pre-migration value, never reintroduce a plaintext write path.
    try {
      return localStorage.getItem(`${KEY_PREFIX}${provider}`) ?? '';
    } catch {
      return '';
    }
  }
  // Browser fallback: no OS vault inside a tab — explicit, unchanged
  // localStorage behavior (see this file's header comment).
  try {
    return localStorage.getItem(`${KEY_PREFIX}${provider}`) ?? '';
  } catch {
    return '';
  }
}

export function saveByokKey(provider: ByokProvider, key: string): void {
  if (isTauriRuntime()) {
    const trimmed = key.trim();
    const cache = getByokVaultCache();
    if (trimmed) {
      cache.set(provider, key); // synchronous: readers see it immediately
      void setSecret(byokVaultKey(provider), key).catch((err: unknown) => {
        // Never log `key` — only the fact/reason a write failed.
        console.error(
          `[byokProviders] failed to persist ${provider} key to the vault`,
          err instanceof Error ? err.message : String(err),
        );
      });
    } else {
      cache.delete(provider);
      void deleteSecret(byokVaultKey(provider)).catch((err: unknown) => {
        console.error(
          `[byokProviders] failed to delete ${provider} key from the vault`,
          err instanceof Error ? err.message : String(err),
        );
      });
    }
    return;
  }
  // Browser fallback: no OS vault inside a tab — explicit, unchanged
  // localStorage behavior (see this file's header comment).
  try {
    if (key.trim()) localStorage.setItem(`${KEY_PREFIX}${provider}`, key);
    else localStorage.removeItem(`${KEY_PREFIX}${provider}`);
  } catch {
    // localStorage unavailable — ignore
  }
}

export function hasByokKey(provider: ByokProvider): boolean {
  return loadByokKey(provider).trim().length > 0;
}

if (typeof window !== 'undefined') {
  window.__lazyByokDebugHasKey = (provider: string) => hasByokKey(provider as ByokProvider);
}

export function loadByokBaseUrl(provider: ByokProvider): string {
  try {
    return localStorage.getItem(`${URL_PREFIX}${provider}`) ?? '';
  } catch {
    return '';
  }
}

export function saveByokBaseUrl(provider: ByokProvider, url: string): void {
  try {
    if (url.trim()) localStorage.setItem(`${URL_PREFIX}${provider}`, url);
    else localStorage.removeItem(`${URL_PREFIX}${provider}`);
  } catch {
    // ignore
  }
}

export function loadByokModel(provider: ByokProvider): string {
  try {
    return localStorage.getItem(`${MODEL_PREFIX}${provider}`) ?? '';
  } catch {
    return '';
  }
}

export function saveByokModel(provider: ByokProvider, model: string): void {
  try {
    if (model.trim()) localStorage.setItem(`${MODEL_PREFIX}${provider}`, model);
    else localStorage.removeItem(`${MODEL_PREFIX}${provider}`);
  } catch {
    // ignore
  }
}

/** Effective base URL for a provider (user override or default). */
export function effectiveByokBaseUrl(def: ByokProviderDef): string {
  return loadByokBaseUrl(def.id) || def.defaultBaseUrl;
}

/** Effective model id for a provider (user override or default). */
export function effectiveByokModel(def: ByokProviderDef): string {
  return loadByokModel(def.id) || def.defaultModel;
}

/** ModelInfo list for a provider (override first, then the def catalog). */
export function byokModelInfos(def: ByokProviderDef): ModelInfo[] {
  const override = loadByokModel(def.id);
  const models = override
    ? [{ id: override, label: override, provider: def.id, description: def.label }]
    : def.models.map((m) => ({
        id: m.id,
        label: m.label,
        provider: def.id,
        description: def.label,
      }));
  return models;
}

export function findByokModel(def: ByokProviderDef, modelId: string): ModelInfo | undefined {
  return byokModelInfos(def).find((m) => m.id === modelId);
}


// ── Agent-turn streamer (mission ReAct loop, BYOK wave) ────────────

/** Contract of the managed engine's per-turn streamer (streamManagedAgentTurn):
 *  yields raw text chunks for one LLM turn. The BYOK adapter below satisfies
 *  the same shape so planAndActManaged's full ReAct loop (THOUGHT/ACTION/ARGS
 *  parsing, toolRuntime execution, budgets, proofs) can run missions on
 *  DeepSeek/OpenRouter/xAI/Groq/Mistral/OpenAI without any CLI.
 */
export interface ByokAgentTurnOpts {
  messages: Array<{ role: string; content: string }>;
  system: string;
  model: string;
  signal?: AbortSignal;
  /** Static/dynamic split for prompt caching — honored on providers whose
   *  API accepts content-block `cache_control` (OpenRouter chat-completions,
   *  native Anthropic); ignored everywhere else. */
  cacheableSystem?: { core: string; dynamic: string };
  maxTokens?: number;
}

export type ByokAgentTurnStreamer = (opts: ByokAgentTurnOpts) => AsyncIterable<string>;

/** Translates a model id into a provider's NATIVE namespace (real incident,
 *  2026-08-03 mission M1): the managed loop's PRM/Reflexion/handoff side
 *  calls reuse the mission's BYOK streamer with CHEAP_MODEL
 *  ("deepseek/deepseek-v4-flash", an OpenRouter-catalog id), which used to
 *  go through UNMANGLED to the native DeepSeek API — 400 "supported API
 *  model names are deepseek-v4-pro or deepseek-v4-flash, but you passed
 *  deepseek/deepseek-v4-flash", silently killing every verifier call for
 *  the whole run. OpenRouter is the ONE provider whose ids must keep their
 *  "<vendor>/" prefix; every native API (DeepSeek, xAI, Groq, Mistral,
 *  OpenAI) needs it stripped. An id already in the provider's own catalog
 *  (deepseek-chat) passes through unchanged. */
export function toNativeByokModelId(def: ByokProviderDef, modelId: string): string {
  if (def.id === 'openrouter') return modelId;
  if (def.models.some((m) => m.id === modelId)) return modelId;
  const slash = modelId.indexOf('/');
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}

/** Resolves the BYOK provider whose catalog contains `modelId` and whose key
 *  is set — returns a streamer bound to that provider, or undefined when the
 *  model is not a BYOK catalog id (native/pro/managed ids fall through). */
export function resolveByokAgentTurnStreamer(modelId: string | undefined): ByokAgentTurnStreamer | undefined {
  if (!modelId) return undefined;
  const def = BYOK_PROVIDER_DEFS.find(
    (d) => d.id !== 'anthropic' && d.models.some((m) => m.id === modelId),
  );
  if (!def || !hasByokKey(def.id)) return undefined;
  const apiKey = loadByokKey(def.id);
  const baseUrl = effectiveByokBaseUrl(def);
  const rawStream = def.apiFormat === 'anthropic' ? streamAnthropicCompatRaw : streamOpenAICompatRaw;
  // DeepSeek's docs recommend temperature 0.0 for coding/math tasks (their
  // "temperature settings by scenario" table; default is 1.0 when omitted).
  // The mission ReAct loop this streamer serves is exactly that: every turn
  // must parse as a strict THOUGHT/ACTION/ARGS block, so determinism directly
  // improves tool-call-format reliability. Scoped to DeepSeek only — left
  // undefined (provider default, unchanged from before this change) for the
  // other providers sharing this same streamer (OpenRouter/xAI/Groq/Mistral/
  // OpenAI), since 0.0 is not a documented recommendation for those and
  // hasn't been verified safe for them here.
  const temperature = def.id === 'deepseek' ? 0 : undefined;
  // cache_control blocks: only providers whose wire format accepts the
  // Anthropic "explicit breakpoint" shape — OpenRouter's chat-completions
  // endpoint and the native Anthropic /v1/messages API both read
  // cache_control off system content blocks directly. Every other provider
  // (DeepSeek/xAI/Groq/Mistral/OpenAI) gets the flat string unchanged.
  const supportsCacheBlocks = def.id === 'openrouter' || def.apiFormat === 'anthropic';
  return (opts) =>
    rawStream({
      baseUrl,
      apiKey,
      model: toNativeByokModelId(def, opts.model),
      system: opts.system,
      systemBlocks:
        supportsCacheBlocks && opts.cacheableSystem
          ? buildCacheableSystemBlocks(opts.cacheableSystem.core, opts.cacheableSystem.dynamic)
          : undefined,
      messages: opts.messages,
      maxTokens: opts.maxTokens ?? 8192,
      temperature,
      signal: opts.signal,
      providerId: def.id,
    });
}

// ── Raw streaming (used by the manager rail and one-shot features) ──

export interface RawStreamOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  /** Cache-aware system content (Anthropic "explicit breakpoint" blocks) —
   *  when set, REPLACES `system` on the wire. Only pass on providers that
   *  accept content-block cache_control (OpenRouter, native Anthropic). */
  systemBlocks?: SystemContentBlock[];
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
  /** Omitted (undefined) falls back to the provider's own default — JSON.stringify
   *  drops an undefined value, so existing callers that never set this are
   *  byte-for-byte unaffected. See resolveByokAgentTurnStreamer for the one
   *  caller that sets this today (DeepSeek missions, temperature 0). */
  temperature?: number;
  signal?: AbortSignal;
  /** Provider id used ONLY to label a thrown ProviderDefinitiveError (see
   *  below) — e.g. 'deepseek'. Optional so existing external callers
   *  (managerEngine.ts's LazyManager 'live-key' branch) that never set this
   *  keep compiling unchanged; falls back to 'byok' when absent. */
  providerId?: string;
}

// ── Definitive vs transient provider errors ────────────────────────
//
// Real incident (2026-08-05): a user's DeepSeek key ran out of balance
// mid-mission. Every HTTP call came back 402 "Insufficient Balance", but
// streamOpenAICompatRaw/streamAnthropicCompatRaw used to swallow that into a
// yielded "❌ API error 402: …" text chunk instead of throwing — the ReAct
// loop then tried to parse that chunk as THOUGHT/ACTION/ARGS, failed, and
// silently kept calling the same dead key turn after turn (a mission frozen
// at 16% for 10+ minutes, RAM climbing, zero failure status ever set).
//
// 401 (bad key) / 402 (no balance) / 403 (permission) / 404 (unknown model)
// can never succeed by retrying the IDENTICAL request — they are definitive,
// not transient. 429 (rate limit) / 5xx (provider trouble) / network errors
// are deliberately left untouched below: they keep the pre-existing
// yield-error-text-and-return (or throw-on-fetch-failure) behavior so every
// existing retry path (managedAgent.ts's consecutiveFailures loop) is
// unaffected — see this file's test suite for both sides of that contract.

/** Thrown by streamOpenAICompatRaw/streamAnthropicCompatRaw for a definitive
 *  (never-retry) provider error. Callers further up the chain (managedAgent.ts's
 *  step loop, evaluator.ts's judge calls) catch this by `instanceof` — or via
 *  classifyDefinitiveProviderError's message-regex fallback, for a path that
 *  re-throws a generic Error and loses the original instance — to fail fast
 *  instead of retrying a call that can never succeed. */
export class ProviderDefinitiveError extends Error {
  readonly status: number;
  readonly providerId: string;
  readonly shortReason: string;
  constructor(status: number, providerId: string, shortReason: string) {
    super(`${providerId} definitive error ${status}: ${shortReason}`);
    this.name = 'ProviderDefinitiveError';
    this.status = status;
    this.providerId = providerId;
    this.shortReason = shortReason;
  }
}

const DEFINITIVE_STATUS_CODES = new Set([401, 402, 403, 404]);

/** Best-effort extraction of a short, human-scannable reason from a
 *  provider's raw error body (OpenAI/DeepSeek-style `{error:{message}}`,
 *  Anthropic-style `{error:{message}}` too, or plain text) — never throws,
 *  always bounded-length. */
function extractShortReason(status: number, errText: string): string {
  try {
    const parsed = JSON.parse(errText) as { error?: { message?: string } | string; message?: string };
    const msg = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message;
    if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 200);
  } catch {
    // Not JSON — fall through to the raw text below.
  }
  const trimmed = errText.trim();
  return trimmed ? trimmed.slice(0, 200) : `HTTP ${status}`;
}

/** Fallback pattern for a definitive provider error that reaches a caller
 *  already unwrapped (a generic Error whose message still carries the
 *  provider's status/text — e.g. re-thrown by an intermediate layer that
 *  lost the original ProviderDefinitiveError instance). Only consulted when
 *  `err` isn't already a ProviderDefinitiveError — see
 *  classifyDefinitiveProviderError. Exported so managedAgent.ts/evaluator.ts
 *  tests can assert against the exact same pattern this module uses. */
export const DEFINITIVE_PROVIDER_ERROR_PATTERN = /\b(401|402|403)\b|Insufficient Balance|invalid api key/i;

/**
 * Normalizes any caught error into `{providerId, shortReason}` when it is
 * (or, via the message-regex fallback, looks like) a definitive provider
 * error — or `undefined` otherwise. The single classification choke point
 * shared by managedAgent.ts's mission step loop and evaluator.ts's judge
 * calls, so both fail fast on exactly the same rule instead of drifting.
 */
export function classifyDefinitiveProviderError(
  err: unknown,
): { providerId: string; shortReason: string } | undefined {
  if (err instanceof ProviderDefinitiveError) {
    return { providerId: err.providerId, shortReason: err.shortReason };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (DEFINITIVE_PROVIDER_ERROR_PATTERN.test(message)) {
    return { providerId: 'unknown', shortReason: message.slice(0, 200) };
  }
  return undefined;
}

/** Splits a fetch ReadableStream into decoded `data: ` SSE payloads, buffering
 *  partial lines across chunks and skipping the `[DONE]` sentinel. Shared by
 *  every raw-SSE provider (byokProviders' own OpenAI-compat/Anthropic-compat
 *  streamers, webAnthropicProvider, localProvider) — previously reimplemented
 *  identically in each. */
export function sseLines(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: TextDecoder): AsyncGenerator<string> {
  let buffer = '';
  return (async function* () {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        yield data;
      }
    }
  })();
}

/** OpenAI-compatible chat/completions streaming — yields raw text chunks. */
export async function* streamOpenAICompatRaw(opts: RawStreamOpts): AsyncIterable<string> {
  const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [{ role: 'system', content: opts.systemBlocks ?? opts.system }, ...opts.messages],
      stream: true,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    // Definitive (401/402/403/404) — throw instead of yielding fake content;
    // see this file's "Definitive vs transient provider errors" section.
    if (DEFINITIVE_STATUS_CODES.has(res.status)) {
      throw new ProviderDefinitiveError(res.status, opts.providerId ?? 'byok', extractShortReason(res.status, errText));
    }
    // Transient (429/5xx/other) — UNCHANGED existing behavior: yield an
    // honest error chunk and return, letting the caller's own retry path
    // (e.g. managedAgent.ts's consecutiveFailures loop) handle it as before.
    yield `❌ API error ${res.status}: ${errText}\n`;
    return;
  }
  if (!res.body) {
    yield '❌ No response body\n';
    return;
  }
  for await (const data of sseLines(res.body.getReader(), new TextDecoder())) {
    try {
      const event = JSON.parse(data);
      const delta = event.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) yield delta;
    } catch {
      // skip malformed JSON
    }
  }
}

/** Anthropic-compatible /v1/messages streaming — yields raw text chunks. */
export async function* streamAnthropicCompatRaw(opts: RawStreamOpts): AsyncIterable<string> {
  const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.systemBlocks ?? opts.system,
      messages: opts.messages,
      stream: true,
      temperature: opts.temperature,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    // Definitive (401/402/403/404) — throw instead of yielding fake content;
    // see this file's "Definitive vs transient provider errors" section.
    if (DEFINITIVE_STATUS_CODES.has(res.status)) {
      throw new ProviderDefinitiveError(res.status, opts.providerId ?? 'byok', extractShortReason(res.status, errText));
    }
    // Transient (429/5xx/other) — UNCHANGED existing behavior.
    yield `❌ API error ${res.status}: ${errText}\n`;
    return;
  }
  if (!res.body) {
    yield '❌ No response body\n';
    return;
  }
  for await (const data of sseLines(res.body.getReader(), new TextDecoder())) {
    try {
      const event = JSON.parse(data);
      if (event.type === 'content_block_delta' && event.delta?.text) {
        yield event.delta.text;
      }
    } catch {
      // skip malformed JSON
    }
  }
}

// ── ModelProvider adapter (assistant chat) ─────────────────────────

/** i18n translate function shape — same contract as readiness.ts's
 *  Translate (matches useI18n().t exactly). Declared locally rather than
 *  imported from readiness.ts to avoid a circular import (readiness.ts
 *  already imports FROM this file). `t` is threaded in from getProvider()
 *  (models/index.ts), which the assistant chat's only caller with real i18n
 *  context (assistantStore.tsx) supplies — every other getProvider() caller
 *  omits it, so the label/error text falls back to its ORIGINAL hardcoded
 *  French, same "omitting it is never a behavior change" contract used
 *  throughout runtime.ts/managedAgent.ts/readiness.ts. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

export function createOpenAICompatProvider(def: ByokProviderDef, t?: Translate): ModelProvider {
  return {
    id: def.id,
    label: t ? t('models.byok.chatLabel', { provider: def.label }) : `${def.label} (BYOK)`,

    listModels(): ModelInfo[] {
      return byokModelInfos(def);
    },

    async *streamChat(req: StreamChatRequest): AsyncIterable<string> {
      const apiKey = loadByokKey(def.id);
      if (!apiKey) {
        yield t
          ? `❌ ${t('models.byok.noKeyConfigured', { provider: def.label })}\n`
          : `❌ Aucune clé API ${def.label} configurée. Ajoute-la dans Réglages > Modèles.\n`;
        return;
      }
      const system = buildSystemPrompt(req.mode, req.brainRecall, {
        rulesContext: req.rulesContext,
        startupContext: req.startupContext,
        skillContext: req.skillContext,
        tools: req.tools,
        supportsToolLoop: false,
      });
      const model = req.model.id || effectiveByokModel(def);
      const messages = req.messages.map((m) => ({ role: m.role, content: m.content }));
      yield* streamOpenAICompatRaw({
        baseUrl: effectiveByokBaseUrl(def),
        apiKey,
        model,
        system,
        messages,
        signal: req.signal,
        providerId: def.id,
      });
    },
  };
}
