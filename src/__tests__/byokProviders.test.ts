import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BYOK_PROVIDER_DEFS,
  resolveByokDef,
  saveByokKey,
  loadByokKey,
  hasByokKey,
  saveByokBaseUrl,
  loadByokBaseUrl,
  saveByokModel,
  loadByokModel,
  effectiveByokBaseUrl,
  effectiveByokModel,
  createOpenAICompatProvider,
  streamOpenAICompatRaw,
  streamAnthropicCompatRaw,
  resolveByokAgentTurnStreamer,
  ProviderDefinitiveError,
  classifyDefinitiveProviderError,
} from '../lib/models/byokProviders';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('BYOK provider definitions', () => {
  it('exposes every supportable provider with a base URL and at least one model', () => {
    expect(BYOK_PROVIDER_DEFS.length).toBeGreaterThanOrEqual(7);
    for (const def of BYOK_PROVIDER_DEFS) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.defaultBaseUrl.startsWith('https://')).toBe(true);
      expect(def.models.length).toBeGreaterThan(0);
      expect(def.models.some((m) => m.id === def.defaultModel)).toBe(true);
    }
  });

  it('deepseek is OpenAI-compatible with deepseek-chat as default', () => {
    const def = resolveByokDef('deepseek')!;
    expect(def.apiFormat).toBe('openai');
    expect(def.defaultBaseUrl).toBe('https://api.deepseek.com');
    expect(def.defaultModel).toBe('deepseek-chat');
  });
});

describe('localStorage helpers', () => {
  it('round-trips key, base URL and model per provider', () => {
    saveByokKey('deepseek', 'sk-test');
    expect(loadByokKey('deepseek')).toBe('sk-test');
    expect(hasByokKey('deepseek')).toBe(true);
    expect(hasByokKey('openrouter')).toBe(false);

    saveByokBaseUrl('deepseek', 'https://gateway.example.com');
    expect(loadByokBaseUrl('deepseek')).toBe('https://gateway.example.com');

    saveByokModel('deepseek', 'deepseek-reasoner');
    expect(loadByokModel('deepseek')).toBe('deepseek-reasoner');
  });

  it('empty key removes the entry', () => {
    saveByokKey('deepseek', 'sk-test');
    saveByokKey('deepseek', '   ');
    expect(hasByokKey('deepseek')).toBe(false);
  });

  it('effective values fall back to the provider defaults', () => {
    const def = resolveByokDef('deepseek')!;
    expect(effectiveByokBaseUrl(def)).toBe('https://api.deepseek.com');
    expect(effectiveByokModel(def)).toBe('deepseek-chat');

    saveByokBaseUrl('deepseek', 'https://custom.example.com/v1');
    saveByokModel('deepseek', 'my-model');
    expect(effectiveByokBaseUrl(def)).toBe('https://custom.example.com/v1');
    expect(effectiveByokModel(def)).toBe('my-model');
  });
});

describe('streamOpenAICompatRaw', () => {
  it('yields text chunks and stops on [DONE]', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"content":"Bonjour"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" Lazy"}}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const chunks: string[] = [];
    for await (const c of streamOpenAICompatRaw({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(c);
    }

    expect(chunks.join('')).toBe('Bonjour Lazy');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('deepseek-chat');
    expect(body.messages[0].role).toBe('system');
  });

  it('omits temperature entirely when not passed (back-compat: undefined is dropped by JSON.stringify)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    const chunks: string[] = [];
    for await (const c of streamOpenAICompatRaw({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      system: 'sys',
      messages: [],
    })) {
      chunks.push(c);
    }
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect('temperature' in body).toBe(false);
  });

  it('sends an explicit temperature when passed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    const chunks: string[] = [];
    for await (const c of streamOpenAICompatRaw({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      system: 'sys',
      messages: [],
      temperature: 0,
    })) {
      chunks.push(c);
    }
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.temperature).toBe(0);
  });

  it('yields an honest error chunk on a TRANSIENT non-200 (500) — never retried at this layer, but never thrown either', async () => {
    // 401 used to be covered by this exact test before the fail-fast
    // classification below — 401 is now DEFINITIVE (throws), so this test
    // was moved to 500 (a genuinely transient status) to keep covering the
    // "yield an honest error chunk and return" contract for the codes that
    // must still support the caller's own retry (managedAgent.ts's
    // consecutiveFailures loop) — see the "definitive provider errors" describe below.
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const chunks: string[] = [];
    for await (const c of streamOpenAICompatRaw({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      system: 'sys',
      messages: [],
    })) {
      chunks.push(c);
    }
    expect(chunks.join('')).toMatch(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('yields an honest error chunk on 429 (rate limit) — transient, unchanged behavior', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })));
    const chunks: string[] = [];
    for await (const c of streamOpenAICompatRaw({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      system: 'sys',
      messages: [],
    })) {
      chunks.push(c);
    }
    expect(chunks.join('')).toMatch(/429/);
  });
});

// ── Definitive vs transient provider errors (2026-08-05 DeepSeek 402 incident) ──
//
// 401/402/403/404 must THROW a typed ProviderDefinitiveError (single fetch
// attempt, never a fake content chunk) instead of the old
// yield-error-text-and-return behavior — that old behavior is exactly what
// let a mission's ReAct loop try to parse "❌ API error 402: …" as
// THOUGHT/ACTION/ARGS and silently keep calling the same dead key.

describe('streamOpenAICompatRaw / streamAnthropicCompatRaw — definitive provider errors', () => {
  it('streamOpenAICompatRaw throws ProviderDefinitiveError on 402 (Insufficient Balance) — exactly one fetch attempt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), { status: 402 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const consume = async () => {
      for await (const _c of streamOpenAICompatRaw({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-test',
        model: 'deepseek-chat',
        system: 'sys',
        messages: [],
        providerId: 'deepseek',
      })) {
        // no-op — the throw must happen before any chunk is yielded
      }
    };

    await expect(consume()).rejects.toMatchObject({
      name: 'ProviderDefinitiveError',
      status: 402,
      providerId: 'deepseek',
      shortReason: 'Insufficient Balance',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('streamOpenAICompatRaw throws for 401/403/404 too; defaults providerId to "byok" when not passed', async () => {
    for (const status of [401, 403, 404]) {
      const fetchMock = vi.fn().mockResolvedValue(new Response('denied', { status }));
      vi.stubGlobal('fetch', fetchMock);
      const consume = async () => {
        for await (const _c of streamOpenAICompatRaw({
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk-test',
          model: 'deepseek-chat',
          system: 'sys',
          messages: [],
        })) {
          // no-op
        }
      };
      await expect(consume()).rejects.toMatchObject({ status, providerId: 'byok' });
    }
  });

  it('streamAnthropicCompatRaw throws ProviderDefinitiveError on 402 too — exactly one fetch attempt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), { status: 402 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const consume = async () => {
      for await (const _c of streamAnthropicCompatRaw({
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiKey: 'sk-test',
        model: 'deepseek-chat',
        system: 'sys',
        messages: [],
        providerId: 'deepseek',
      })) {
        // no-op
      }
    };

    await expect(consume()).rejects.toMatchObject({ name: 'ProviderDefinitiveError', status: 402 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolveByokAgentTurnStreamer propagates providerId into the thrown error (real mission call shape)', async () => {
    saveByokKey('deepseek', 'sk-test');
    const streamer = resolveByokAgentTurnStreamer('deepseek-chat');
    expect(streamer).toBeDefined();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), { status: 402 })),
    );

    const consume = async () => {
      for await (const _c of streamer!({
        messages: [{ role: 'user', content: 'Task: fix the bug' }],
        system: 'You are a coding agent.',
        model: 'deepseek-chat',
      })) {
        // no-op
      }
    };
    await expect(consume()).rejects.toMatchObject({ providerId: 'deepseek', status: 402 });
  });
});

describe('streamAnthropicCompatRaw', () => {
  it('yields content_block_delta text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"content_block_delta","delta":{"text":"Salut"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ])));

    const chunks: string[] = [];
    for await (const c of streamAnthropicCompatRaw({
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      system: 'sys',
      messages: [],
    })) {
      chunks.push(c);
    }
    expect(chunks.join('')).toBe('Salut');
  });
});

describe('createOpenAICompatProvider (assistant adapter)', () => {
  it('streams through the configured provider and model', async () => {
    const def = resolveByokDef('deepseek')!;
    saveByokKey('deepseek', 'sk-test');
    const provider = createOpenAICompatProvider(def);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"content":"Réponse"}}]}\n\n',
      'data: [DONE]\n\n',
    ])));

    const chunks: string[] = [];
    for await (const c of provider.streamChat({
      mode: 'ask',
      model: { id: 'deepseek-chat', label: 'DeepSeek Chat', provider: 'deepseek' },
      messages: [{ role: 'user', content: 'test' }],
    } as never)) {
      chunks.push(c);
    }
    expect(chunks.join('')).toBe('Réponse');
  });

  it('yields a setup hint when no key is configured', async () => {
    const def = resolveByokDef('deepseek')!;
    const provider = createOpenAICompatProvider(def);
    const chunks: string[] = [];
    for await (const c of provider.streamChat({
      mode: 'ask',
      model: { id: 'deepseek-chat', label: 'DeepSeek Chat', provider: 'deepseek' },
      messages: [],
    } as never)) {
      chunks.push(c);
    }
    expect(chunks.join('')).toMatch(/clé API/i);
  });

  it('does NOT set an explicit temperature (assistant/ask surface is unaffected by the mission-only DeepSeek change)', async () => {
    const def = resolveByokDef('deepseek')!;
    saveByokKey('deepseek', 'sk-test');
    const provider = createOpenAICompatProvider(def);
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    const chunks: string[] = [];
    for await (const c of provider.streamChat({
      mode: 'ask',
      model: { id: 'deepseek-chat', label: 'DeepSeek Chat', provider: 'deepseek' },
      messages: [{ role: 'user', content: 'test' }],
    } as never)) {
      chunks.push(c);
    }
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect('temperature' in body).toBe(false);
  });
});

// ── resolveByokAgentTurnStreamer (mission ReAct loop) ──────────────
//
// This is the streamer runtime.ts binds into planAndActManaged's
// `streamTurn` for a BYOK mission (see managedAgent.ts's streamAgentTurn) —
// the actual per-step request path for a DeepSeek mission, distinct from
// createOpenAICompatProvider above (assistant/ask surface, untouched).
describe('resolveByokAgentTurnStreamer — mission temperature (DeepSeek)', () => {
  it('sends temperature 0 for a DeepSeek mission (DeepSeek recommends 0.0 for coding)', async () => {
    saveByokKey('deepseek', 'sk-test');
    const streamer = resolveByokAgentTurnStreamer('deepseek-chat');
    expect(streamer).toBeDefined();

    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    const chunks: string[] = [];
    for await (const c of streamer!({
      messages: [{ role: 'user', content: 'Task: fix the bug' }],
      system: 'You are a coding agent.',
      model: 'deepseek-chat',
    })) {
      chunks.push(c);
    }

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.temperature).toBe(0);
  });

  it('does not force temperature for a non-DeepSeek BYOK provider sharing the same streamer (OpenRouter)', async () => {
    saveByokKey('openrouter', 'sk-test');
    const streamer = resolveByokAgentTurnStreamer('deepseek/deepseek-v4-flash');
    expect(streamer).toBeDefined();

    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    const chunks: string[] = [];
    for await (const c of streamer!({
      messages: [{ role: 'user', content: 'Task: fix the bug' }],
      system: 'You are a coding agent.',
      model: 'deepseek/deepseek-v4-flash',
    })) {
      chunks.push(c);
    }

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect('temperature' in body).toBe(false);
  });

  it('returns undefined when no DeepSeek key is configured (unchanged contract)', () => {
    expect(resolveByokAgentTurnStreamer('deepseek-chat')).toBeUndefined();
  });
});

// ── ProviderDefinitiveError / classifyDefinitiveProviderError (unit) ──────
// The single classification choke point shared by managedAgent.ts's step
// loop and evaluator.ts's judge calls (task 4d — type/classification tests).

describe('ProviderDefinitiveError', () => {
  it('carries status/providerId/shortReason and a recognizable name', () => {
    const err = new ProviderDefinitiveError(402, 'deepseek', 'Insufficient Balance');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ProviderDefinitiveError');
    expect(err.status).toBe(402);
    expect(err.providerId).toBe('deepseek');
    expect(err.shortReason).toBe('Insufficient Balance');
  });
});

describe('classifyDefinitiveProviderError', () => {
  it('classifies a real ProviderDefinitiveError by instanceof', () => {
    const err = new ProviderDefinitiveError(403, 'openrouter', 'permission denied for model');
    expect(classifyDefinitiveProviderError(err)).toEqual({
      providerId: 'openrouter',
      shortReason: 'permission denied for model',
    });
  });

  it.each([
    ['contains a bare 401', new Error('Request failed with status 401')],
    ['contains a bare 402', new Error('upstream replied 402')],
    ['contains a bare 403', new Error('403 from provider')],
    ['contains "Insufficient Balance"', new Error('DeepSeek: Insufficient Balance')],
    ['contains "invalid api key"', new Error('OpenAI error: invalid api key provided')],
  ])('falls back to the message regex when the error is unwrapped: %s', (_label, err) => {
    const result = classifyDefinitiveProviderError(err);
    expect(result).toBeDefined();
    expect(result?.providerId).toBe('unknown');
  });

  it('returns undefined for a transient/unrelated error (429, network, generic)', () => {
    expect(classifyDefinitiveProviderError(new Error('429 Too Many Requests'))).toBeUndefined();
    expect(classifyDefinitiveProviderError(new Error('network timeout'))).toBeUndefined();
    expect(classifyDefinitiveProviderError(new Error('unexpected token in JSON'))).toBeUndefined();
    expect(classifyDefinitiveProviderError(new TypeError('Failed to fetch'))).toBeUndefined();
  });

  it('does not false-positive on 404 unless the message actually says so (404 is intentionally NOT in the regex fallback — only real ProviderDefinitiveError carries it)', () => {
    // The message-regex fallback only covers 401/402/403 + phrase matches by
    // design (see DEFINITIVE_PROVIDER_ERROR_PATTERN) — 404 unwrapped-message
    // detection is a known, documented gap; a real thrown
    // ProviderDefinitiveError(404, …) is still classified correctly (covered
    // by the instanceof test above and the byokProviders 401/403/404 test).
    expect(classifyDefinitiveProviderError(new Error('resource not found'))).toBeUndefined();
  });

  it('handles a non-Error thrown value without throwing itself', () => {
    expect(classifyDefinitiveProviderError('Insufficient Balance')).toEqual({
      providerId: 'unknown',
      shortReason: 'Insufficient Balance',
    });
    expect(classifyDefinitiveProviderError(undefined)).toBeUndefined();
  });
});
