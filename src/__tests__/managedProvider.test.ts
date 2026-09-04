/* managedProvider.test.ts
   Unit tests for the brain_search ReAct shim in managedProvider.

   Covers:
   1. stripInvisibleLines — strips reasoning and BRAIN_SEARCH lines
   2. Deduplication of identical BRAIN_SEARCH queries (Bug 1)
   3. Forced-final-answer path when max rounds are reached (Bug 1)
   4. Reasoning / directive text stripped from streamed UI output (Bug 2)
*/

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  stripInvisibleLines,
  parseUsageMarker,
  streamManagedAgentTurn,
  createManagedLineBuffer,
  buildCacheableSystemBlocks,
  resolveProxySystemField,
} from '../lib/models/managedProvider';
import type { RealUsage } from '../lib/models/managedProvider';
import { MAX_TOOL_ROUNDS } from '../lib/models/assistantToolLoop';
import { parseBrainSearchDirective } from '../lib/brain/brainTool';
import { addUsage } from '../lib/models/costStore';
import { emit } from '../lib/bus';

// ── Helper ────────────────────────────────────────────────────────

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

// ── stripInvisibleLines ───────────────────────────────────────────

describe('stripInvisibleLines', () => {
  it('passes through normal text unchanged', () => {
    expect(stripInvisibleLines('Hello, world!')).toBe('Hello, world!');
  });

  it('strips reasoning-channel lines (\\x1b[reasoning] prefix)', () => {
    const input = '\x1b[reasoning]I am thinking...\nHere is my answer.';
    expect(stripInvisibleLines(input)).toBe('Here is my answer.');
  });

  it('strips BRAIN_SEARCH directive lines', () => {
    const input = 'BRAIN_SEARCH: what is the auth flow\nSome visible text.';
    expect(stripInvisibleLines(input)).toBe('Some visible text.');
  });

  it('strips indented BRAIN_SEARCH lines', () => {
    const input = '  BRAIN_SEARCH: some query\nAnswer here.';
    expect(stripInvisibleLines(input)).toBe('Answer here.');
  });

  it('strips the real-usage marker line (\\x1b[usage] prefix)', () => {
    const input = 'Here is my answer.\n\x1b[usage]{"inputTokens":10,"outputTokens":5,"costUsd":0.001}';
    expect(stripInvisibleLines(input)).toBe('Here is my answer.');
  });

  it('strips both reasoning and directive lines from mixed text', () => {
    const input = [
      '\x1b[reasoning]Let me search for that.',
      'BRAIN_SEARCH: lazy ide architecture',
      'Based on the results, here is the answer.',
    ].join('\n');
    expect(stripInvisibleLines(input)).toBe('Based on the results, here is the answer.');
  });

  it('preserves empty lines that are not reasoning or directives', () => {
    const input = 'Line one.\n\nLine two.';
    expect(stripInvisibleLines(input)).toBe('Line one.\n\nLine two.');
  });

  it('returns empty string when all lines are stripped', () => {
    const input = '\x1b[reasoning]thinking\nBRAIN_SEARCH: foo';
    expect(stripInvisibleLines(input)).toBe('');
  });
});

// ── parseBrainSearchDirective ─────────────────────────────────────

describe('parseBrainSearchDirective', () => {
  it('returns null for normal prose', () => {
    expect(parseBrainSearchDirective('Here is the answer.')).toBeNull();
  });

  it('parses a simple directive', () => {
    expect(parseBrainSearchDirective('BRAIN_SEARCH: lazy ide brain')).toBe('lazy ide brain');
  });

  it('strips reasoning lines before parsing', () => {
    const text = '\x1b[reasoning]I should search.\nBRAIN_SEARCH: auth flow';
    expect(parseBrainSearchDirective(text)).toBe('auth flow');
  });

  it('returns null for empty text', () => {
    expect(parseBrainSearchDirective('')).toBeNull();
    expect(parseBrainSearchDirective('   ')).toBeNull();
  });

  it('returns the last directive when multiple are present', () => {
    const text = 'BRAIN_SEARCH: first query\nBRAIN_SEARCH: second query';
    expect(parseBrainSearchDirective(text)).toBe('second query');
  });
});

// ── parseUsageMarker ──────────────────────────────────────────────
// Client-side parser for ai-proxy's post-settlement \x1b[usage] marker
// (see settleAndRecord in supabase/functions/ai-proxy/index.ts). Must
// degrade to null (never throw) for anything unexpected, so an older or
// differently-shaped proxy deployment cannot crash the client.

describe('parseUsageMarker', () => {
  it('parses a valid usage marker line', () => {
    const line = '\x1b[usage]{"inputTokens":120,"outputTokens":45,"costUsd":0.00234}';
    expect(parseUsageMarker(line)).toEqual({ inputTokens: 120, outputTokens: 45, costUsd: 0.00234 });
  });

  it('parses the marker when it appears after other text on the same line', () => {
    const line = 'trailing\x1b[usage]{"inputTokens":1,"outputTokens":2,"costUsd":0.5}';
    expect(parseUsageMarker(line)).toEqual({ inputTokens: 1, outputTokens: 2, costUsd: 0.5 });
  });

  it('returns null when the marker is absent (plain text, older proxy)', () => {
    expect(parseUsageMarker('This is a plain answer.')).toBeNull();
    expect(parseUsageMarker('')).toBeNull();
  });

  it('returns null for malformed JSON after the marker', () => {
    expect(parseUsageMarker('\x1b[usage]{not valid json}')).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    expect(parseUsageMarker('\x1b[usage]{"inputTokens":10,"outputTokens":5}')).toBeNull();
  });

  it('returns null when a field has the wrong type', () => {
    expect(parseUsageMarker('\x1b[usage]{"inputTokens":"10","outputTokens":5,"costUsd":0.1}')).toBeNull();
  });

  it('returns null for an empty JSON object', () => {
    expect(parseUsageMarker('\x1b[usage]{}')).toBeNull();
  });

  // ── Cache fields (prompt caching — chantier: cache observability) ──
  // Additive to the marker shape: the three required fields above stay the
  // sole gate for validity. Backward/forward compatible in both directions
  // — an older proxy's marker (no cache keys) parses exactly as before, and
  // a malformed cache key never invalidates the whole marker.

  it('parses the cache fields when present alongside the required ones', () => {
    const line =
      '\x1b[usage]{"inputTokens":5000,"outputTokens":200,"costUsd":0.012,' +
      '"cacheReadTokens":4500,"cacheCreationTokens":0,"cacheSavingsUsd":0.045}';
    expect(parseUsageMarker(line)).toEqual({
      inputTokens: 5000,
      outputTokens: 200,
      costUsd: 0.012,
      cacheReadTokens: 4500,
      cacheCreationTokens: 0,
      cacheSavingsUsd: 0.045,
    });
  });

  it('omits the cache fields entirely (not present-as-undefined) when the marker predates them (older ai-proxy deployment)', () => {
    const line = '\x1b[usage]{"inputTokens":120,"outputTokens":45,"costUsd":0.00234}';
    const parsed = parseUsageMarker(line);
    expect(parsed).toEqual({ inputTokens: 120, outputTokens: 45, costUsd: 0.00234 });
    expect(parsed).not.toHaveProperty('cacheReadTokens');
    expect(parsed).not.toHaveProperty('cacheCreationTokens');
    expect(parsed).not.toHaveProperty('cacheSavingsUsd');
  });

  it('a cache-priming call reports a NEGATIVE cacheSavingsUsd (the write premium costs more than plain input) without being rejected', () => {
    const line =
      '\x1b[usage]{"inputTokens":50000,"outputTokens":100,"costUsd":0.15,' +
      '"cacheReadTokens":0,"cacheCreationTokens":49000,"cacheSavingsUsd":-0.031}';
    expect(parseUsageMarker(line)?.cacheSavingsUsd).toBe(-0.031);
  });

  it('drops only the malformed cache field, keeping the real settled token/cost numbers intact', () => {
    const line =
      '\x1b[usage]{"inputTokens":10,"outputTokens":5,"costUsd":0.001,"cacheReadTokens":"not-a-number"}';
    const parsed = parseUsageMarker(line);
    expect(parsed).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.001 });
    expect(parsed).not.toHaveProperty('cacheReadTokens');
  });
});

// ── ReAct shim integration (mocked streamProxyBody) ──────────────
//
// We test the shim behaviour by mocking the Supabase client and the
// fetchProxy function. We import the module AFTER mocking its deps.

// Mock Supabase so auth.getSession() returns a fake token.
vi.mock('../lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      }),
    },
  },
}));

// Mock env vars.
vi.mock('../lib/env', () => ({
  supabaseAnonKey: 'test-anon-key',
  getAiProxyUrl: () => 'https://mock.proxy/ai',
}));

// Mock accessSettings to return a predictable model.
vi.mock('../lib/models/accessSettings', () => ({
  loadAccessSettings: vi.fn(() => ({ model: 'anthropic/claude-haiku' })),
}));

// Mock openrouterCatalog.
vi.mock('../lib/models/openrouterCatalog', () => ({
  OPENROUTER_MODELS: [],
  DEFAULT_OPENROUTER_MODEL_ID: 'anthropic/claude-haiku',
  findOpenRouterModel: vi.fn(() => ({ reasoning: false })),
  priceBadge: vi.fn(() => '$'),
}));

// Mock system prompt builder. Keeps the REST of the module's real exports
// (via importOriginal) — managedProvider.ts now pulls in assistantToolLoop.ts
// -> toolRuntime.ts -> managedToolPermissions.ts -> managedAgentPolicy.ts,
// which references systemPrompts.ts's RECALL_TEACHING at ITS OWN module-eval
// time; a factory that only returns `buildSystemPrompt` left that binding
// undefined and crashed the whole suite at collection time.
vi.mock('../lib/models/systemPrompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/systemPrompts')>();
  return {
    ...actual,
    buildSystemPrompt: vi.fn(() => 'system'),
  };
});

// Mock costStore.
vi.mock('../lib/models/costStore', () => ({
  addUsage: vi.fn(),
  addBrainSavings: vi.fn(),
  recordRecallSaving: vi.fn(),
  getCost: vi.fn(() => ({ inputTokens: 0, outputTokens: 0, cost: 0 })),
  useCostStore: vi.fn(() => ({ inputTokens: 0, outputTokens: 0, cost: 0 })),
}));

// Mock brain recall.
vi.mock('../lib/brain/context', () => ({
  normalizeRecall: vi.fn(r => r),
}));

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    brain: {
      recallScoped: vi.fn().mockResolvedValue({ injectedContext: 'brain results', nodes: [] }),
      // Structural recall backends (brain_query_css / brain_neighbours) —
      // predictable strings so the structural-directive shim tests below can
      // assert the managed loop feeds real hits back into the next turn.
      queryCss: vi.fn().mockResolvedValue('#7 Decision: use SQLite for local cache'),
      neighbours: vi.fn().mockResolvedValue('#7 -> replaced-by #12'),
    },
  })),
}));

// Mock the bus — only `emit` is used by managedProvider.ts's
// notifyWalletMaybeStale (BUG-1/BUG-3(c)); nothing else in this file's
// dependency chain (assistantToolLoop/toolRuntime/managedToolPermissions)
// touches the bus, so a full replacement is safe.
vi.mock('../lib/bus', () => ({
  emit: vi.fn(),
}));

// Helper: encode a string as a ReadableStream so we can fake fetch responses.
function makeStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Like makeStream, but enqueues each string as its OWN separate chunk —
 *  simulates a real fetch ReadableStream where a chunk boundary can land
 *  anywhere, including mid-marker (the M12 dogfood JSON-leak bug: see
 *  createManagedLineBuffer's doc comment in managedProvider.ts). makeStream
 *  above always delivers the whole text as one chunk, so it can never
 *  exercise this class of bug. */
function makeMultiChunkStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collectAgentTurn(
  opts: Parameters<typeof streamManagedAgentTurn>[0],
): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of streamManagedAgentTurn(opts)) chunks.push(chunk);
  return chunks;
}

// ── streamManagedAgentTurn — real usage marker (managedAgent.ts's loop) ──
// Covers Task A's client-side contract for the agent-turn path: the
// \x1b[usage] marker is stripped from yielded text and reported via
// onUsage instead — with and without the marker present (older proxy).

describe('streamManagedAgentTurn — real usage marker', () => {
  const mockedAddUsage = addUsage as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockedAddUsage.mockClear();
  });

  it('strips the usage marker from yielded text and invokes onUsage with the parsed payload', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeStream(
        'THOUGHT: done\nACTION: FINAL\nARGS: {}\n\x1b[usage]{"inputTokens":120,"outputTokens":45,"costUsd":0.00234}',
      ),
    } as unknown as Response);

    const onUsage = vi.fn();
    const chunks = await collectAgentTurn({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'system',
      model: 'anthropic/claude-haiku-4.5',
      onUsage,
    });
    const combined = chunks.join('');

    expect(combined).not.toContain('\x1b[usage]');
    expect(combined).not.toContain('inputTokens');
    expect(combined).toContain('ACTION: FINAL');

    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 120, outputTokens: 45, costUsd: 0.00234 });

    // Bonus fix: the session-local cost badge also prefers the real usage
    // over the ceil(chars/4) estimate when the marker is present.
    expect(mockedAddUsage).toHaveBeenCalledWith({
      inputTokens: 120,
      outputTokens: 45,
      model: 'anthropic/claude-haiku-4.5',
      // Forwarding the settled cost instead of letting costStore estimate.
      costUsd: 0.00234,
    });
  });

  it('forwards cache fields from the marker into both onUsage and costStore.addUsage — observable, not assumed', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeStream(
        'THOUGHT: done\nACTION: FINAL\nARGS: {}\n' +
          '\x1b[usage]{"inputTokens":6000,"outputTokens":180,"costUsd":0.02,' +
          '"cacheReadTokens":5400,"cacheCreationTokens":0,"cacheSavingsUsd":0.061}',
      ),
    } as unknown as Response);

    const onUsage = vi.fn();
    await collectAgentTurn({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'system',
      model: 'anthropic/claude-haiku-4.5',
      onUsage,
    });

    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 6000,
      outputTokens: 180,
      costUsd: 0.02,
      cacheReadTokens: 5400,
      cacheCreationTokens: 0,
      cacheSavingsUsd: 0.061,
    });
    expect(mockedAddUsage).toHaveBeenCalledWith({
      inputTokens: 6000,
      outputTokens: 180,
      model: 'anthropic/claude-haiku-4.5',
      costUsd: 0.02,
      cacheReadTokens: 5400,
      cacheCreationTokens: 0,
      cacheSavingsUsd: 0.061,
    });
  });

  it('never calls onUsage when the marker is absent (older ai-proxy deployment)', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeStream('THOUGHT: done\nACTION: FINAL\nARGS: {}'),
    } as unknown as Response);

    const onUsage = vi.fn();
    const chunks = await collectAgentTurn({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'system',
      model: 'anthropic/claude-haiku-4.5',
      onUsage,
    });

    expect(chunks.join('')).toContain('ACTION: FINAL');
    expect(onUsage).not.toHaveBeenCalled();

    // Falls back to the pre-existing ceil(chars/4) estimate.
    expect(mockedAddUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, model: 'anthropic/claude-haiku-4.5' }),
    );
  });

  it('does not throw when no onUsage callback is provided', async () => {
    // The marker is always preceded by a newline on the wire (see ai-proxy's
    // `\n\x1b[usage]${...}` enqueue) so it lands as its own line regardless
    // of chunk boundaries — matched here, not glued to the prior text.
    //
    // The trailing '\n' before the (now-stripped) marker line is preserved
    // rather than collapsed — createManagedLineBuffer's line-at-a-time
    // buffering (needed to fix the M12 JSON-leak bug: see its doc comment)
    // yields "done\n" as soon as that line is known complete, before the
    // marker portion (a separate, not-yet-complete buffered remainder) is
    // even seen — it cannot retroactively un-yield that newline once the
    // marker later resolves to empty. Harmless in every real call site: both
    // runManagerTurn (sanitizeManagerDisplayText's final `.trim()`) and
    // evaluator.ts's runManagedEvaluatorAgent (regex JSON extraction over
    // the full accumulated text) are unaffected by one trailing newline.
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeStream('done\n\x1b[usage]{"inputTokens":1,"outputTokens":1,"costUsd":0.0001}'),
    } as unknown as Response);

    const chunks = await collectAgentTurn({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'system',
      model: 'anthropic/claude-haiku-4.5',
    });
    expect(chunks.join('')).toBe('done\n');
  });

  it('ignores a malformed usage marker: strips it and never invokes onUsage', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeStream('done\n\x1b[usage]{not valid json}'),
    } as unknown as Response);

    const onUsage = vi.fn();
    const chunks = await collectAgentTurn({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'system',
      model: 'anthropic/claude-haiku-4.5',
      onUsage,
    });

    expect(chunks.join('')).not.toContain('\x1b[usage]');
    expect(onUsage).not.toHaveBeenCalled();
  });
});

// ── Prompt caching (chantier 2) — buildCacheableSystemBlocks /
// resolveProxySystemField ──────────────────────────────────────────
// The wire-format split (STATIC cache_control block + DYNAMIC uncached
// block) must never lose or reorder any text. Emitted only when BOTH the
// caller opts in (cacheableSystem) AND the proxy is known to support it
// (supportsCacheBlocks) AND the model is Anthropic-family — otherwise
// always flattens back to a plain string, byte-identical to the pre-caching
// wire format. AI_PROXY_SUPPORTS_CACHE_BLOCKS now defaults to true (the
// matching ai-proxy patch — supabase/functions/ai-proxy/pricing.ts's
// SystemContent shape — ships in this same change; see that constant's doc
// comment in managedProvider.ts for the deploy-ordering requirement this
// implies). `supportsCacheBlocks` stays an explicit parameter below
// specifically so these tests can pin BOTH the "proxy supports it" and
// "proxy predates the patch / rollback" cases regardless of the module
// default.

describe('buildCacheableSystemBlocks', () => {
  it('marks the static block with cache_control: ephemeral and leaves the dynamic block uncached', () => {
    const blocks = buildCacheableSystemBlocks('STATIC CORE', 'dynamic per-turn state');
    expect(blocks).toEqual([
      { type: 'text', text: 'STATIC CORE', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'dynamic per-turn state' },
    ]);
  });

  it('concatenating the blocks\' text reproduces the exact flattened string', () => {
    const core = 'You are the LazyManager...';
    const dynamic = '\n\n### Current Missions\n- M1: [done] ...';
    const blocks = buildCacheableSystemBlocks(core, dynamic);
    const reconstructed = blocks.map((b) => b.text).join('');
    expect(reconstructed).toBe(`${core}${dynamic}`);
  });

  it('omits the dynamic block entirely when empty rather than sending an empty text block', () => {
    const blocks = buildCacheableSystemBlocks('STATIC CORE', '');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'text', text: 'STATIC CORE', cache_control: { type: 'ephemeral' } });
  });
});

describe('resolveProxySystemField', () => {
  const core = 'STATIC CORE';
  const dynamic = '\n\nDYNAMIC STATE';
  const flatFallback = `${core}${dynamic}`;

  it('returns the flat `system` string unchanged when cacheableSystem is absent (every pre-wave caller)', () => {
    const result = resolveProxySystemField({ system: 'plain system', model: 'anthropic/claude-sonnet-5' });
    expect(result).toBe('plain system');
  });

  it('flattens to a byte-identical string when explicitly told the proxy does not support cache blocks (rollback / pre-deploy safety)', () => {
    const result = resolveProxySystemField(
      {
        system: flatFallback,
        model: 'anthropic/claude-sonnet-5',
        cacheableSystem: { core, dynamic },
      },
      false,
    );
    expect(result).toBe(flatFallback);
  });

  it('flattens to a byte-identical string for a non-Anthropic model even when supportsCacheBlocks is true', () => {
    const result = resolveProxySystemField(
      { system: flatFallback, model: 'openai/gpt-5.4', cacheableSystem: { core, dynamic } },
      true,
    );
    expect(result).toBe(flatFallback);
  });

  it('emits the real two-block array only when BOTH supportsCacheBlocks is true AND the model is Anthropic-family', () => {
    const result = resolveProxySystemField(
      { system: flatFallback, model: 'anthropic/claude-sonnet-5', cacheableSystem: { core, dynamic } },
      true,
    );
    expect(result).toEqual([
      { type: 'text', text: core, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: dynamic },
    ]);
    // Never loses or reorders content relative to the flat fallback.
    expect((result as { text: string }[]).map((b) => b.text).join('')).toBe(flatFallback);
  });

  it('flattens to a single string by default (pre-deploy safety: AI_PROXY_SUPPORTS_CACHE_BLOCKS is false until ai-proxy ships)', () => {
    // Same call as the previous test, but relying on the module's own
    // default instead of pinning supportsCacheBlocks=true — this is what
    // every real caller (managerEngine.ts's runManagerTurn) actually does.
    // While AI_PROXY_SUPPORTS_CACHE_BLOCKS is false (pre-deploy safety gate),
    // the system must be flattened to a single string to avoid 500s on the
    // deployed proxy that still expects `body.system.trim()` to work.
    const result = resolveProxySystemField({
      system: flatFallback,
      model: 'anthropic/claude-sonnet-5',
      cacheableSystem: { core, dynamic },
    });
    expect(result).toBe(flatFallback);
  });

  it('still flattens by default for a non-Anthropic model (the true default only ever affects Anthropic-family models)', () => {
    const result = resolveProxySystemField({
      system: flatFallback,
      model: 'openai/gpt-5.4',
      cacheableSystem: { core, dynamic },
    });
    expect(result).toBe(flatFallback);
  });
});

// ── BUG-1/BUG-3(c) — wallet-maybe-stale notice, coalesced ────────────
// notifyWalletMaybeStale is not exported directly; exercised through its two
// call sites (a no_credits proxy error, and a settled real-usage marker).
// Coalesced to one 'billing:walletMaybeStale' emit per 5s window so a
// parallel fleet hammering the same wall doesn't spam the header badge
// subscriber (AccountChip.tsx, wave B) with N identical refreshes.

describe('streamManagedAgentTurn — wallet-maybe-stale notice coalescing', () => {
  const mockedEmit = emit as ReturnType<typeof vi.fn>;

  // The coalescing window lives in managedProvider.ts's module-level
  // lastWalletStaleNoticeMs, shared by every test in this FILE — including
  // the "real usage marker" tests above, which also trip the settled-usage
  // call site. `epoch` grows by 100s (10s » the 5s window) each test and is
  // added on top of the real "now" vi.useFakeTimers() pins at test start, so
  // every test in this block starts guaranteed-outside the window regardless
  // of what real or fake time an earlier test left behind.
  let epoch = 0;

  beforeEach(() => {
    mockedEmit.mockClear();
    epoch += 100_000;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + epoch);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function attemptNoCreditsCall(): Promise<void> {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 402,
      json: async () => ({ error: 'Crédits insuffisants', code: 'no_credits' }),
    } as unknown as Response);

    await expect(
      collectAgentTurn({
        messages: [{ role: 'user', content: 'hi' }],
        system: 'system',
        model: 'anthropic/claude-haiku-4.5',
      }),
    ).rejects.toThrow();
  }

  it('emits once for repeats within the 5s window, then again once the window elapses', async () => {
    await attemptNoCreditsCall();
    await attemptNoCreditsCall();
    await attemptNoCreditsCall();

    expect(mockedEmit).toHaveBeenCalledTimes(1);
    expect(mockedEmit).toHaveBeenCalledWith('billing:walletMaybeStale', undefined);

    vi.setSystemTime(Date.now() + 5_001);
    await attemptNoCreditsCall();

    expect(mockedEmit).toHaveBeenCalledTimes(2);
  });

  it('also fires when a real spend settles (settledUsage present in the finally block)', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeStream(
        'THOUGHT: done\nACTION: FINAL\nARGS: {}\n\x1b[usage]{"inputTokens":10,"outputTokens":5,"costUsd":0.001}',
      ),
    } as unknown as Response);

    await collectAgentTurn({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'system',
      model: 'anthropic/claude-haiku-4.5',
    });

    expect(mockedEmit).toHaveBeenCalledWith('billing:walletMaybeStale', undefined);
  });
});

// ── createManagedLineBuffer — M12 dogfood fix (JSON leak, MAJEUR #4) ──────
// Real friction-log capture: a manager reply rendered as
// "…prêt.40,"outputTokens":536,"costUsd":0.0567}" — a fetch ReadableStream
// chunk boundary split the \x1b[usage] marker itself; the first chunk's
// tail ("\x1b[usage]{"inputTokens":11") DID look like the marker and was
// dropped, but the second chunk's head ("40,"outputTokens":536,...}") no
// longer started with the marker prefix, so it sailed through unfiltered
// and got glued onto the previous chunk's visible text with no separator.
// These tests pin the fix at the pure-function level (no fetch mocking
// needed) by feeding the exact split shape directly.

describe('createManagedLineBuffer — pure buffering + classification', () => {
  function collectUsage(): { onUsage: (u: RealUsage) => void; captured: RealUsage[] } {
    const captured: RealUsage[] = [];
    return { onUsage: (u) => captured.push(u), captured };
  }

  it('reassembles a usage marker split exactly across two chunks — no leaked tail, usage still captured', () => {
    const { onUsage, captured } = collectUsage();
    const buf = createManagedLineBuffer(onUsage);

    // Exact real-world split: chunk 1 ends mid-marker, chunk 2 has the tail.
    const visible1 = buf.feed('Voilà, tout est prêt.\n\x1b[usage]{"inputTokens":11');
    const visible2 = buf.feed('40,"outputTokens":536,"costUsd":0.0567}');
    const tail = buf.flush();

    const combined = visible1 + visible2 + tail;
    expect(combined).not.toContain('outputTokens');
    expect(combined).not.toContain('costUsd');
    expect(combined).not.toMatch(/^\d+,"outputTokens/); // the exact leaked shape
    expect(combined.trim()).toBe('Voilà, tout est prêt.');

    expect(captured).toEqual([{ inputTokens: 1140, outputTokens: 536, costUsd: 0.0567 }]);
  });

  it('splits the marker at every possible byte offset without ever leaking a fragment', () => {
    const line = 'Réponse finale.\n\x1b[usage]{"inputTokens":1140,"outputTokens":536,"costUsd":0.0567}';
    for (let cut = 1; cut < line.length; cut++) {
      const { onUsage, captured } = collectUsage();
      const buf = createManagedLineBuffer(onUsage);
      const v1 = buf.feed(line.slice(0, cut));
      const v2 = buf.feed(line.slice(cut));
      const tail = buf.flush();
      const combined = v1 + v2 + tail;

      expect(combined, `cut at ${cut}`).not.toContain('outputTokens');
      expect(combined, `cut at ${cut}`).not.toContain('costUsd');
      expect(combined.trim(), `cut at ${cut}`).toBe('Réponse finale.');
      expect(captured, `cut at ${cut}`).toEqual([{ inputTokens: 1140, outputTokens: 536, costUsd: 0.0567 }]);
    }
  });

  it('keeps prose that shares a line with the marker (no newline between them)', () => {
    const { onUsage, captured } = collectUsage();
    const buf = createManagedLineBuffer(onUsage);
    const visible = buf.feed('Tout est prêt.\x1b[usage]{"inputTokens":5,"outputTokens":2,"costUsd":0.001}');
    const tail = buf.flush();

    expect(visible + tail).toBe('Tout est prêt.');
    expect(captured).toEqual([{ inputTokens: 5, outputTokens: 2, costUsd: 0.001 }]);
  });

  it('never strips ordinary text containing braces (e.g. a JSON code snippet in the answer)', () => {
    const { onUsage } = collectUsage();
    const buf = createManagedLineBuffer(onUsage);
    const snippet = 'Voici un exemple : `{"foo": "bar", "count": 3}` dans le code.';
    const visible = buf.feed(`${snippet}\n`);
    const tail = buf.flush();

    expect(visible + tail).toBe(`${snippet}\n`);
  });

  it('never strips braces even when split across chunks, as long as they are not the usage marker shape', () => {
    const { onUsage } = collectUsage();
    const buf = createManagedLineBuffer(onUsage);
    const line = 'Config: {"a": 1, "b": 2}\n';
    const v1 = buf.feed(line.slice(0, 10));
    const v2 = buf.feed(line.slice(10));
    expect(v1 + v2).toBe(line);
  });

  it('drops a whole reasoning-channel line regardless of chunk split', () => {
    const { onUsage } = collectUsage();
    const buf = createManagedLineBuffer(onUsage);
    const v1 = buf.feed('\x1b[reason');
    const v2 = buf.feed('ing]thinking about it\nReal answer.\n');
    expect(v1 + v2).toBe('Real answer.\n');
  });

  it('recognizes a bare "[usage]" marker even without the ESC byte', () => {
    const { onUsage, captured } = collectUsage();
    const buf = createManagedLineBuffer(onUsage);
    const visible = buf.feed('Answer.[usage]{"inputTokens":3,"outputTokens":1,"costUsd":0.0001}');
    const tail = buf.flush();
    expect(visible + tail).toBe('Answer.');
    expect(captured).toEqual([{ inputTokens: 3, outputTokens: 1, costUsd: 0.0001 }]);
  });

  it('flush() on an empty buffer returns an empty string (never throws)', () => {
    const { onUsage } = collectUsage();
    const buf = createManagedLineBuffer(onUsage);
    expect(buf.flush()).toBe('');
  });

  it('ox-alpha wire format (reasoning lines newline-separated by the proxy): only the real answer is visible', () => {
    // Live defect reproduction (stealth/ox-alpha, mandatory-reasoning model):
    // the ai-proxy now newline-separates channel transitions (see its
    // emitSegment), so each \x1b[reasoning] fragment lands on its own line and
    // the answer starts on a fresh line. The buffer must surface ONLY the
    // answer — never chain-of-thought fragments like "Per" / "Hmm, there".
    const { onUsage, captured } = collectUsage();
    const buf = createManagedLineBuffer(onUsage);

    // Simulate the fixed proxy's exact output shape for the HELLO TEST probe:
    // reasoning deltas (each on its own line) then the content glued after the
    // last reasoning fragment, then the usage marker line.
    const wire =
      '\x1b[reasoning]The\n' +
      '\x1b[reasoning] user is asking me to say\n' +
      '\x1b[reasoning] exactly "HELLO TEST".\n' +
      'HELLO TEST\n' +
      '\x1b[usage]{"inputTokens":93,"outputTokens":37,"costUsd":0,"cacheReadTokens":64,"cacheCreationTokens":0,"cacheSavingsUsd":0}';

    const v1 = buf.feed(wire.slice(0, 40));
    const v2 = buf.feed(wire.slice(40, 90));
    const v3 = buf.feed(wire.slice(90));
    const tail = buf.flush();

    const combined = v1 + v2 + v3 + tail;
    expect(combined.trim()).toBe('HELLO TEST');
    expect(combined).not.toContain('reasoning]');
    expect(combined).not.toContain('asking me');
    expect(combined).not.toContain('outputTokens');
    expect(captured).toEqual([{
      inputTokens: 93,
      outputTokens: 37,
      costUsd: 0,
      cacheReadTokens: 64,
      cacheCreationTokens: 0,
      cacheSavingsUsd: 0,
    }]);
  });
});

describe('streamManagedAgentTurn — end-to-end reproduction of the exact reported leak', () => {
  const mockedAddUsage = addUsage as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockedAddUsage.mockClear();
  });

  it('never leaks a usage-marker fragment when the proxy stream splits the marker across two fetch chunks', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeMultiChunkStream([
        'Voilà, tout est prêt.\n\x1b[usage]{"inputTokens":11',
        '40,"outputTokens":536,"costUsd":0.0567}',
      ]),
    } as unknown as Response);

    const onUsage = vi.fn();
    const chunks = await collectAgentTurn({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'system',
      model: 'anthropic/claude-haiku-4.5',
      onUsage,
    });
    const combined = chunks.join('');

    expect(combined).not.toContain('outputTokens');
    expect(combined).not.toContain('costUsd');
    expect(combined.trim()).toBe('Voilà, tout est prêt.');
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 1140, outputTokens: 536, costUsd: 0.0567 });
  });
});

describe('streamChatImpl ReAct shim', () => {
  let managedProvider: typeof import('../lib/models/managedProvider');

  beforeEach(async () => {
    vi.resetModules();
    // Re-import after vi.resetModules so mocks apply freshly.
    managedProvider = await import('../lib/models/managedProvider');
  });

  it('does not strip normal prose (no reasoning, no directive)', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeStream('This is a plain answer.'),
    } as unknown as Response);

    const req = {
      messages: [{ id: 'u1', role: 'user' as const, content: 'hello' }],
      model: { id: 'anthropic/claude-haiku', label: 'Haiku', provider: 'anthropic', description: '' },
      mode: 'ask' as const,
    };

    const chunks = await collect(managedProvider.managedProvider.streamChat(req));
    expect(chunks.join('')).toContain('This is a plain answer.');
  });

  it('strips the trailing real-usage marker from the interactive chat output', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeStream(
        'This is a plain answer.\n\x1b[usage]{"inputTokens":42,"outputTokens":13,"costUsd":0.0012}',
      ),
    } as unknown as Response);

    const req = {
      messages: [{ id: 'u1', role: 'user' as const, content: 'hello' }],
      model: { id: 'anthropic/claude-haiku', label: 'Haiku', provider: 'anthropic', description: '' },
      mode: 'ask' as const,
    };

    const chunks = await collect(managedProvider.managedProvider.streamChat(req));
    const combined = chunks.join('');

    expect(combined).toContain('This is a plain answer.');
    expect(combined).not.toContain('\x1b[usage]');
    expect(combined).not.toContain('inputTokens');
    expect(combined).not.toContain('costUsd');
  });

  it('strips BRAIN_SEARCH directive from UI output and yields status line', async () => {
    // Round 1: model emits a directive.
    // Round 2 (forced by mock): model emits a final answer.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        body: makeStream('BRAIN_SEARCH: lazy ide architecture\n'),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        body: makeStream('The Lazy IDE uses a Tauri shell with React.\n'),
      } as unknown as Response);
    global.fetch = fetchMock;

    const req = {
      messages: [{ id: 'u1', role: 'user' as const, content: 'how is lazy ide built?' }],
      model: { id: 'anthropic/claude-haiku', label: 'Haiku', provider: 'anthropic', description: '' },
      mode: 'ask' as const,
      tools: [{ name: 'brain_search', description: '', input_schema: { type: 'object' as const, properties: {}, required: [] } }],
    };

    const chunks = await collect(managedProvider.managedProvider.streamChat(req));
    const combined = chunks.join('');

    // Directive line must NOT appear in the visible output.
    expect(combined).not.toContain('BRAIN_SEARCH:');
    // A clean status line must appear instead.
    expect(combined).toContain('Recherche mémoire');
    expect(combined).toContain('lazy ide architecture');
    // The final answer must appear.
    expect(combined).toContain('The Lazy IDE uses a Tauri shell');
  });

  it('strips reasoning-channel lines from UI output', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeStream('\x1b[reasoning]I should answer directly.\nHere is my answer.\n'),
    } as unknown as Response);

    const req = {
      messages: [{ id: 'u1', role: 'user' as const, content: 'test' }],
      model: { id: 'anthropic/claude-haiku', label: 'Haiku', provider: 'anthropic', description: '' },
      mode: 'ask' as const,
    };

    const chunks = await collect(managedProvider.managedProvider.streamChat(req));
    const combined = chunks.join('');

    expect(combined).not.toContain('\x1b[reasoning]');
    expect(combined).not.toContain('I should answer directly.');
    expect(combined).toContain('Here is my answer.');
  });

  it('deduplicate: does not re-run the same BRAIN_SEARCH query twice', async () => {
    // Round 1: directive for query "auth flow".
    // Round 2: same directive (duplicate) → shim sends nudge.
    // Round 3 (nudge response): final answer.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        body: makeStream('BRAIN_SEARCH: auth flow\n'),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        body: makeStream('BRAIN_SEARCH: auth flow\n'),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        body: makeStream('Auth uses Supabase JWT.\n'),
      } as unknown as Response);
    global.fetch = fetchMock;

    const req = {
      messages: [{ id: 'u1', role: 'user' as const, content: 'how does auth work?' }],
      model: { id: 'anthropic/claude-haiku', label: 'Haiku', provider: 'anthropic', description: '' },
      mode: 'ask' as const,
      tools: [{ name: 'brain_search', description: '', input_schema: { type: 'object' as const, properties: {}, required: [] } }],
    };

    const chunks = await collect(managedProvider.managedProvider.streamChat(req));
    const combined = chunks.join('');

    // The directive itself must not appear in UI output.
    expect(combined).not.toContain('BRAIN_SEARCH:');
    // The forced final answer must appear.
    expect(combined).toContain('Auth uses Supabase JWT.');
    // fetch was called exactly 3 times: directive, duplicate, nudge-response.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('forces a final answer when max rounds are exhausted (shared MAX_TOOL_ROUNDS budget)', async () => {
    // managedProvider now delegates its round cap to assistantToolLoop.ts's
    // MAX_TOOL_ROUNDS (5) instead of its own retired MAX_BRAIN_SEARCH_ROUNDS
    // (3) — see managedProvider.ts's header. All MAX_TOOL_ROUNDS rounds
    // return a distinct directive, then the forced-final round (round index
    // === MAX_TOOL_ROUNDS) returns a prose answer.
    const fetchMock = vi.fn();
    for (let i = 1; i <= MAX_TOOL_ROUNDS; i++) {
      fetchMock.mockResolvedValueOnce({ ok: true, body: makeStream(`BRAIN_SEARCH: q${i}\n`) } as unknown as Response);
    }
    fetchMock.mockResolvedValueOnce({ ok: true, body: makeStream('Final answer after exhaustion.\n') } as unknown as Response);
    global.fetch = fetchMock;

    const req = {
      messages: [{ id: 'u1', role: 'user' as const, content: 'keep searching forever?' }],
      model: { id: 'anthropic/claude-haiku', label: 'Haiku', provider: 'anthropic', description: '' },
      mode: 'ask' as const,
      tools: [{ name: 'brain_search', description: '', input_schema: { type: 'object' as const, properties: {}, required: [] } }],
    };

    const chunks = await collect(managedProvider.managedProvider.streamChat(req));
    const combined = chunks.join('');

    // No directive leaks.
    expect(combined).not.toContain('BRAIN_SEARCH:');
    // The forced final answer appears.
    expect(combined).toContain('Final answer after exhaustion.');
    expect(fetchMock).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1);
  });

  it('normalizes queries for deduplication (case + whitespace insensitive)', async () => {
    // Round 1: "Auth Flow" (mixed case).
    // Round 2: "  auth flow  " (different casing + whitespace) → treated as duplicate.
    // Round 3 (nudge response): final answer.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, body: makeStream('BRAIN_SEARCH: Auth Flow\n') } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, body: makeStream('BRAIN_SEARCH:   auth flow  \n') } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, body: makeStream('Auth is handled by Supabase.\n') } as unknown as Response);
    global.fetch = fetchMock;

    const req = {
      messages: [{ id: 'u1', role: 'user' as const, content: 'explain auth' }],
      model: { id: 'anthropic/claude-haiku', label: 'Haiku', provider: 'anthropic', description: '' },
      mode: 'ask' as const,
      tools: [{ name: 'brain_search', description: '', input_schema: { type: 'object' as const, properties: {}, required: [] } }],
    };

    const chunks = await collect(managedProvider.managedProvider.streamChat(req));
    const combined = chunks.join('');

    expect(combined).not.toContain('BRAIN_SEARCH:');
    expect(combined).toContain('Auth is handled by Supabase.');
    // Only 3 fetch calls: round 1, round 2 (duplicate detected), nudge response.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fires a BRAIN_QUERY_CSS directive: strips it, yields a status line, and continues to a grounded answer', async () => {
    // Round 1: the model emits a STRUCTURAL directive; round 2: final answer.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        body: makeStream('BRAIN_QUERY_CSS: aside[role="doc-warning"]\n'),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        body: makeStream('There is one active warning to address.\n'),
      } as unknown as Response);
    global.fetch = fetchMock;

    const req = {
      messages: [{ id: 'u1', role: 'user' as const, content: 'list all warnings' }],
      model: { id: 'anthropic/claude-haiku', label: 'Haiku', provider: 'anthropic', description: '' },
      mode: 'ask' as const,
      tools: [{ name: 'brain_search', description: '', input_schema: { type: 'object' as const, properties: {}, required: [] } }],
    };

    const combined = (await collect(managedProvider.managedProvider.streamChat(req))).join('');

    // The raw structural directive must NOT leak; a clean status line appears.
    expect(combined).not.toContain('BRAIN_QUERY_CSS:');
    expect(combined).toContain('Requête mémoire');
    expect(combined).toContain('There is one active warning to address.');
    // Exactly two turns: the directive turn + the grounded answer turn.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ── streamChatEvents — structured counterpart (assistant chat only) ────
//
// managedProvider is the Pro/managed backend — the most common real path
// for subscribers (see index.ts's isManagedActive/managedWithFallback).
// These tests exercise streamChatEventsImpl directly (real fetch mocked,
// same as the string-path tests above), proving the actual production
// loop emits typed thinking/tool/text events — not just a hand-rolled
// fake stream at the store level.

describe('streamChatEvents — structured counterpart', () => {
  let managedProviderModule: typeof import('../lib/models/managedProvider');

  beforeEach(async () => {
    vi.resetModules();
    managedProviderModule = await import('../lib/models/managedProvider');
  });

  async function collectEvents(
    req: Parameters<typeof managedProviderModule.managedProvider.streamChat>[0],
  ) {
    const events: import('../lib/models/types').StreamEvent[] = [];
    for await (const event of managedProviderModule.managedProvider.streamChatEvents!(req)) {
      events.push(event);
    }
    return events;
  }

  it('yields a single text event for a plain prose answer (no tools, no reasoning)', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeStream('This is a plain answer.'),
    } as unknown as Response);

    const events = await collectEvents({
      messages: [{ id: 'u1', role: 'user', content: 'hello' }],
      model: { id: 'anthropic/claude-haiku', label: 'Haiku', provider: 'anthropic', description: '' },
      mode: 'ask',
    });

    expect(events).toEqual([{ type: 'text', id: 'answer', text: 'This is a plain answer.' }]);
  });

  it('yields a thinking event (not a text event) for reasoning-marker content', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeStream('\x1b[reasoning]I should answer directly.\nHere is my answer.\n'),
    } as unknown as Response);

    const events = await collectEvents({
      messages: [{ id: 'u1', role: 'user', content: 'test' }],
      model: { id: 'anthropic/claude-haiku', label: 'Haiku', provider: 'anthropic', description: '' },
      mode: 'ask',
    });

    const thinking = events.filter(e => e.type === 'thinking');
    const text = events.filter(e => e.type === 'text');
    expect(thinking.map(e => (e.type === 'thinking' ? e.text : '')).join('')).toBe('I should answer directly.');
    expect(text.map(e => (e.type === 'text' ? e.text : '')).join('')).toBe('Here is my answer.\n');
    expect(text.some(e => e.type === 'text' && e.text.includes('I should answer directly'))).toBe(false);
  });

  it('yields a running -> done brain_search tool event around the search, then the final answer as text', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, body: makeStream('BRAIN_SEARCH: lazy ide architecture\n') } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, body: makeStream('The Lazy IDE uses a Tauri shell with React.\n') } as unknown as Response);
    global.fetch = fetchMock;

    const events = await collectEvents({
      messages: [{ id: 'u1', role: 'user', content: 'how is lazy ide built?' }],
      model: { id: 'anthropic/claude-haiku', label: 'Haiku', provider: 'anthropic', description: '' },
      mode: 'ask',
      tools: [{ name: 'brain_search', description: '', input_schema: { type: 'object', properties: {}, required: [] } }],
    });

    const toolEvents = events.filter(e => e.type === 'tool');
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]).toMatchObject({ status: 'running', name: 'brain_search', input: { query: 'lazy ide architecture' } });
    expect(toolEvents[1]).toMatchObject({ status: 'done', name: 'brain_search', input: { query: 'lazy ide architecture' } });
    expect(toolEvents[1].id).toBe(toolEvents[0].id);

    // No raw directive text leaks into any text event.
    const text = events.filter(e => e.type === 'text').map(e => (e.type === 'text' ? e.text : '')).join('');
    expect(text).not.toContain('BRAIN_SEARCH:');
    expect(text).toContain('The Lazy IDE uses a Tauri shell');
  });

  it('does not emit a duplicate tool event for a repeated query (dedup nudges instead)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, body: makeStream('BRAIN_SEARCH: auth flow\n') } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, body: makeStream('BRAIN_SEARCH: auth flow\n') } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, body: makeStream('Auth uses Supabase JWT.\n') } as unknown as Response);
    global.fetch = fetchMock;

    const events = await collectEvents({
      messages: [{ id: 'u1', role: 'user', content: 'how does auth work?' }],
      model: { id: 'anthropic/claude-haiku', label: 'Haiku', provider: 'anthropic', description: '' },
      mode: 'ask',
      tools: [{ name: 'brain_search', description: '', input_schema: { type: 'object', properties: {}, required: [] } }],
    });

    expect(events.filter(e => e.type === 'tool')).toHaveLength(2); // running + done, once
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('yields a running -> done brain_query_css tool event around a structural query, then the final answer as text', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, body: makeStream('BRAIN_QUERY_CSS: aside[role="doc-warning"]\n') } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, body: makeStream('One active warning found.\n') } as unknown as Response);
    global.fetch = fetchMock;

    const events = await collectEvents({
      messages: [{ id: 'u1', role: 'user', content: 'list warnings' }],
      model: { id: 'anthropic/claude-haiku', label: 'Haiku', provider: 'anthropic', description: '' },
      mode: 'ask',
      tools: [{ name: 'brain_search', description: '', input_schema: { type: 'object', properties: {}, required: [] } }],
    });

    const toolEvents = events.filter(e => e.type === 'tool');
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]).toMatchObject({ status: 'running', name: 'brain_query_css', input: { selector: 'aside[role="doc-warning"]' } });
    expect(toolEvents[1]).toMatchObject({ status: 'done', name: 'brain_query_css' });
    expect(toolEvents[1].id).toBe(toolEvents[0].id);

    const text = events.filter(e => e.type === 'text').map(e => (e.type === 'text' ? e.text : '')).join('');
    expect(text).not.toContain('BRAIN_QUERY_CSS:');
    expect(text).toContain('One active warning found.');
  });
});
