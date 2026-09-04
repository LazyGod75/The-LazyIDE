/* webAnthropicProvider — Anthropic API calls proxied through the Vite dev server.
   The dev server injects the app's API key server-side (like Cursor's managed mode).
   No API key is ever exposed to the browser.
*/

import type { ModelProvider, ModelInfo, StreamChatRequest } from './types.js';
import { ALL_MODELS } from './registry.js';
import { addUsage } from './costStore.js';
import { buildSystemPrompt } from './systemPrompts.js';
import { sseLines } from './byokProviders.js';

function loadApiKey(): string {
  // BYOK: user can set their own key in localStorage (optional, overrides proxy)
  try {
    return localStorage.getItem('lazy.apikey.anthropic') ?? '';
  } catch {
    return '';
  }
}

async function* streamChatImpl(req: StreamChatRequest): AsyncIterable<string> {
  const byokKey = loadApiKey();

  // If no BYOK key, use the app's managed proxy (Vite dev server injects the key)
  // If BYOK key exists, call Anthropic directly with the user's key
  const url = byokKey
    ? 'https://api.anthropic.com/v1/messages'
    : '/anthropic-api/v1/messages';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };

  if (byokKey) {
    headers['x-api-key'] = byokKey;
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }
  // When using proxy, the dev server injects x-api-key server-side

  // supportsToolLoop: false — this provider streams raw Anthropic SSE text
  // (no ReAct loop; see this file's header) and must never be taught a
  // directive syntax it has nothing to intercept with. See
  // systemPrompts.ts's supportsToolLoop doc comment and managedProvider.ts's
  // header for the 2026-07 defect this same invariant closes elsewhere.
  const system = buildSystemPrompt(req.mode, req.brainRecall, {
    rulesContext: req.rulesContext,
    startupContext: req.startupContext,
    tools: req.tools,
    supportsToolLoop: false,
  });

  const messages = req.messages.map(m => ({ role: m.role, content: m.content }));

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: req.model.id,
      max_tokens: 2048,
      system,
      messages,
      stream: true,
    }),
    signal: req.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    yield `❌ API error ${res.status}: ${errText}\n`;
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    yield '❌ No response body\n';
    return;
  }

  const decoder = new TextDecoder();
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const data of sseLines(reader, decoder)) {
    try {
      const event = JSON.parse(data);

      if (event.type === 'content_block_delta' && event.delta?.text) {
        yield event.delta.text;
      }

      if (event.type === 'message_start' && event.message?.usage) {
        inputTokens = event.message.usage.input_tokens ?? 0;
      }

      if (event.type === 'message_delta' && event.usage) {
        outputTokens = event.usage.output_tokens ?? 0;
      }
    } catch {
      // skip malformed JSON
    }
  }

  if (inputTokens > 0 || outputTokens > 0) {
    addUsage({
      inputTokens,
      outputTokens,
      model: req.model.id,
    });
  }
}

export const webAnthropicProvider: ModelProvider = {
  id: 'anthropic-web',
  label: 'Anthropic (web direct)',

  listModels(): ModelInfo[] {
    return ALL_MODELS.filter(m => m.provider === 'anthropic');
  },

  streamChat(req: StreamChatRequest): AsyncIterable<string> {
    return streamChatImpl(req);
  },
};

export function hasWebAnthropicKey(): boolean {
  // The Vite proxy injects the app's API key server-side, so the web provider
  // is always available in dev mode. BYOK key in localStorage is optional.
  return true;
}
