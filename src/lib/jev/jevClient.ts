/* jevClient.ts — client for the TypeSafe Jev API.

   Two transports, one contract:
   - Desktop (Tauri): invoke('jev_ask') — the Rust side reads the key from
     the OS vault itself and POSTs server-side (api.typesafe.ai emits no
     Access-Control-Allow-Origin, so a WebView fetch can never read the
     response; running the call in Rust is also the "credentials
     server-side" posture TypeSafe recommends — the key never enters JS).
   - Browser (no Tauri IPC): direct fetch with the localStorage-fallback
     key — this is the documented browser path for BYOK keys. It will
     degrade honestly on CORS-blocking deployments.

   Contract (https://docs.typesafe.ai — check the live docs before
   touching the wire format):
     POST https://api.typesafe.ai/v1/systemone
     Authorization: Bearer <key>
     { state, model, questions } -> { model, answers, usage }

   Fail-safe rules every caller relies on:
   - throws JevError on no key / HTTP error / timeout / malformed payload
   - NEVER throws for network-level rejection without tagging it —
     callers wrap in try/catch and fall back to deterministic behavior
   - retried once on 429/5xx with a short backoff; 401 is definitive
*/

import { invoke } from '@tauri-apps/api/core';
import { getJevBrowserKey, isJevModeOn, isJevRuntimeTauri } from './jevMode.js';
import {
  JEV_DEFAULT_MODEL,
  JEV_DEFAULT_TIMEOUT_MS,
  type JevAnswer,
  type JevQuestion,
  type JevResponse,
} from './jevTypes.js';

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 529]);
const RETRY_DELAY_MS = 600;
const MAX_QUESTIONS_PER_CALL = 24;

export class JevError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'JevError';
    this.status = status;
  }
}

export interface JevAskOptions {
  model?: string;
  timeoutMs?: number;
  /** External cancellation (e.g. component unmount). Combined with the
   *  internal timeout via AbortSignal.any where available. */
  signal?: AbortSignal;
}

function validateQuestions(questions: Record<string, JevQuestion>): void {
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new JevError('jev: questions map is empty');
  if (ids.length > MAX_QUESTIONS_PER_CALL) {
    throw new JevError(`jev: too many questions (${ids.length} > ${MAX_QUESTIONS_PER_CALL})`);
  }
  for (const [id, q] of Object.entries(questions)) {
    if (!id.trim()) throw new JevError('jev: question id must be a non-empty string');
    if (!q || typeof q !== 'object') throw new JevError(`jev: question "${id}" is malformed`);
    if (q.type !== 'noul' && q.type !== 'choice' && q.type !== 'score') {
      throw new JevError(`jev: question "${id}" has unknown type "${String(q.type)}"`);
    }
  }
}

function validateAnswers(raw: unknown): Record<string, JevAnswer> {
  if (!raw || typeof raw !== 'object') throw new JevError('jev: malformed response (answers)');
  const answers = raw as Record<string, unknown>;
  for (const [id, answer] of Object.entries(answers)) {
    const a = answer as JevAnswer | null;
    if (!a || typeof a !== 'object' || (a.type !== 'noul' && a.type !== 'choice' && a.type !== 'score')) {
      throw new JevError(`jev: malformed answer for "${id}"`);
    }
    if (a.type === 'noul' && typeof a.noul !== 'number') {
      throw new JevError(`jev: malformed noul for "${id}"`);
    }
    if (a.type === 'choice' && typeof a.choice !== 'string') {
      throw new JevError(`jev: malformed choice for "${id}"`);
    }
    if (a.type === 'score' && typeof a.score !== 'number') {
      throw new JevError(`jev: malformed score for "${id}"`);
    }
  }
  return answers as Record<string, JevAnswer>;
}

function toResponse(json: Record<string, unknown>, model: string): JevResponse {
  return {
    model: typeof json.model === 'string' ? json.model : model,
    answers: validateAnswers(json.answers),
    usage: json.usage as JevResponse['usage'],
  };
}

// ── Desktop transport: Rust owns the call + the key ─────────────────

async function jevAskTauri(
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: JevAskOptions,
): Promise<JevResponse> {
  const model = opts.model ?? JEV_DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;

  const call = invoke<Record<string, unknown>>('jev_ask', {
    state: state ?? {},
    questions,
    model,
    timeoutMs,
  });

  // AbortSignal cancels the JS await (the Rust call still completes in
  // the background — a judgment is tiny, the wasted work is bounded).
  const json = await (opts.signal
    ? Promise.race([
        call,
        new Promise<never>((_, reject) => {
          if (opts.signal!.aborted) reject(new JevError('jev: aborted'));
          else opts.signal!.addEventListener('abort', () => reject(new JevError('jev: aborted')), { once: true });
        }),
      ])
    : call);
  return toResponse(json as Record<string, unknown>, model);
}

// ── Browser transport: direct fetch (no Tauri IPC available) ────────

async function postOnce(
  body: Record<string, unknown>,
  signal: AbortSignal,
  key: string,
): Promise<Response> {
  return fetch(JEV_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal,
  });
}

async function jevAskFetch(
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: JevAskOptions,
): Promise<JevResponse> {
  const key = getJevBrowserKey();
  const timeoutMs = opts.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal
    ? (typeof AbortSignal.any === 'function'
        ? AbortSignal.any([opts.signal, timeoutSignal])
        : timeoutSignal)
    : timeoutSignal;

  const body = {
    state: state ?? {},
    model: opts.model ?? JEV_DEFAULT_MODEL,
    questions,
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const res = await postOnce(body, signal, key);
      if (res.ok) {
        return toResponse(await res.json() as Record<string, unknown>, body.model);
      }
      const text = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new JevError(`jev: authentication failed (HTTP ${res.status})`, res.status);
      }
      if (!RETRYABLE_STATUSES.has(res.status) || attempt === 1) {
        throw new JevError(
          `jev: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`,
          res.status,
        );
      }
      lastError = new JevError(`jev: HTTP ${res.status}`, res.status);
    } catch (err) {
      if (err instanceof JevError) throw err;
      // AbortError / TypeError (network, CORS) — retryable once.
      lastError = err;
      if (attempt === 1) break;
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  if (signal.aborted) throw new JevError('jev: request timed out or was aborted');
  throw new JevError(`jev: request failed — ${msg}`);
}

/**
 * Ask Jev typed questions about `state`. Throws JevError on every
 * failure mode — callers MUST catch and fall back; this is an
 * enhancement primitive, never a hard dependency.
 *
 * Also refuses to run when Jev mode is off (defense in depth — callers
 * should have already gated on isJevModeOn, this is the last gate).
 */
export async function jevAsk(
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: JevAskOptions = {},
): Promise<JevResponse> {
  if (!isJevModeOn()) throw new JevError('jev: mode is off or no TypeSafe key configured');
  validateQuestions(questions);
  return isJevRuntimeTauri() ? jevAskTauri(state, questions, opts) : jevAskFetch(state, questions, opts);
}

// ── Convenience builders used by the enhancement call sites ─────────

/** One noul question: P(yes) for `instructions` applied to `state`. */
export async function jevNoul(
  state: unknown,
  instructions: unknown,
  opts: JevAskOptions = {},
): Promise<number> {
  const res = await jevAsk(state, { q: { type: 'noul', instructions } }, opts);
  const a = res.answers.q;
  if (a?.type !== 'noul') throw new JevError('jev: missing noul answer');
  return a.noul;
}

export interface JevChoiceResult {
  choice: string;
  confidence: number;
  probability: number;
}

/** One choice question over `options` (option ids, not descriptions). */
export async function jevChoice(
  state: unknown,
  instructions: unknown,
  options: readonly string[],
  opts: JevAskOptions = {},
): Promise<JevChoiceResult> {
  const criteria = Object.fromEntries(options.map((o) => [o, o]));
  const res = await jevAsk(
    state,
    { q: { type: 'choice', instructions, criteria } },
    opts,
  );
  const a = res.answers.q;
  if (a?.type !== 'choice') throw new JevError('jev: missing choice answer');
  return {
    choice: a.choice,
    confidence: a.confidence ?? 0,
    probability: a.probabilities?.[a.choice] ?? 0,
  };
}
