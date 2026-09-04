/**
 * Minimal OpenAI-compatible chat-completions client.
 *
 * Default target is Vibe's local llama.cpp endpoint (http://127.0.0.1:8080/v1,
 * model "devstral", $0, offline). Point it at https://api.mistral.ai/v1 with
 * LAZYBRAIN_OPENAI_MODEL=devstral-small-latest + MISTRAL_API_KEY for the
 * cheap cloud profile. No SDK dependency; plain fetch.
 *
 * Env (all optional):
 *   LAZYBRAIN_OPENAI_BASE_URL     default http://127.0.0.1:8080/v1
 *   LAZYBRAIN_OPENAI_MODEL        default devstral
 *   LAZYBRAIN_OPENAI_API_KEY_ENV  name of the env var holding the key
 *                                 (default MISTRAL_API_KEY; empty key = no header)
 */

import { parseJsonArrayLoose } from './json-loose.js';
import { getLogger } from './logger.js';

export interface OpenAiOptions {
  baseUrl?: string;
  model?: string;
  system?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

export function openAiDefaults(): { baseUrl: string; model: string; apiKey: string | undefined } {
  const baseUrl = process.env.LAZYBRAIN_OPENAI_BASE_URL ?? 'http://127.0.0.1:8080/v1';
  const model = process.env.LAZYBRAIN_OPENAI_MODEL ?? 'devstral';
  const keyEnv = process.env.LAZYBRAIN_OPENAI_API_KEY_ENV ?? 'MISTRAL_API_KEY';
  return { baseUrl, model, apiKey: process.env[keyEnv] };
}

export async function callOpenAi(prompt: string, opts: OpenAiOptions = {}): Promise<string | null> {
  if (!prompt) return null;
  const defaults = openAiDefaults();
  const baseUrl = (opts.baseUrl ?? defaults.baseUrl).replace(/\/$/, '');
  const model = opts.model ?? defaults.model;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: prompt });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (defaults.apiKey) headers.authorization = `Bearer ${defaults.apiKey}`;
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      getLogger().warn({ status: resp.status }, 'openai-client: non-200');
      return null;
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === 'string' && content.length > 0 ? content : null;
  } catch (err) {
    getLogger().warn({ err: (err as Error).message }, 'openai-client failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function callOpenAiJsonArray<T = unknown>(
  prompt: string,
  opts: OpenAiOptions = {},
): Promise<T[] | null> {
  const raw = await callOpenAi(prompt, opts);
  if (!raw) return null;
  return parseJsonArrayLoose<T>(raw);
}
