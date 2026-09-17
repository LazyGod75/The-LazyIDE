import { callClaudeCliJsonArray, isClaudeCliAvailable } from '../util/claude-cli.js';
import { getLogger } from '../util/logger.js';
import { parseJsonArrayLoose } from '../util/json-loose.js';
import { callVibeCliJsonArray, isVibeCliAvailable } from '../util/vibe-cli.js';
import { type AnnotateOutput, type SessionInput, annotateSession } from './heuristic.js';
import { emitWikipediaNote } from './template.js';

/**
 * LLM-augmented annotation.
 *
 * Wraps the heuristic annotator: if the output is thin (< 3 facts), tries to
 * enrich via Claude. Two paths in priority order:
 *   1. `ANTHROPIC_API_KEY` set → direct API call (legacy, supports custom quota)
 *   2. Active Claude Code session via the `claude` CLI (default — no extra
 *      key needed)
 *
 * Both paths are best-effort. Any failure (missing CLI, timeout, parse error)
 * silently falls back to the heuristic output. Annotation never blocks capture.
 */
export async function annotateWithLlm(input: SessionInput): Promise<AnnotateOutput> {
  const heuristic = annotateSession(input);
  const log = getLogger();
  const lowConfidence = heuristic.factCount < 3;
  if (!lowConfidence) return heuristic;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  try {
    const backend = resolveExtractorBackend();
    if (backend === 'openai') {
      const upgraded = await callOpenAiEnrich(input, heuristic);
      if (upgraded) return upgraded;
      return heuristic;
    }
    if (backend === 'vibe') {
      if (await isVibeCliAvailable()) {
        const upgraded = await callVibeEnrich(input, heuristic);
        if (upgraded) return upgraded;
      }
      return heuristic;
    }
    if (backend === 'claude-cli') {
      if (await isClaudeCliAvailable()) {
        const upgraded = await callClaudeCliEnrich(input, heuristic);
        if (upgraded) return upgraded;
      }
      return heuristic;
    }
    if (backend === 'lazy-proxy') {
      const upgraded = await callLazyProxyEnrich(input, heuristic);
      if (upgraded) return upgraded;
      return heuristic;
    }
    // backend === 'anthropic'
    if (apiKey) {
      const upgraded = await callClaude(input, heuristic, apiKey);
      if (upgraded) return upgraded;
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'LLM annotator failed, falling back to heuristic');
  }
  return heuristic;
}

interface LlmFact {
  text: string;
  confidence: number;
  kind: 'decision' | 'fact' | 'error' | 'learning';
}

const SYSTEM_PROMPT = `You extract atomic facts from a software engineering session transcript.

Output ONLY a compact JSON array. No prose. No code fence. Each item:
{"text": "fact in 5-25 words ending with a period",
 "confidence": 0.0-1.0,
 "kind": "decision" | "fact" | "error" | "learning"}

Rules:
- Maximum 8 facts.
- Each fact MUST stand alone (no "this", "it", or anaphora).
- "decision" = an explicit choice or course of action.
- "error" = a problem encountered or root cause.
- "learning" = a generalisable insight.
- "fact" = a stable claim about the system.
- Skip greetings, status updates, code listings.
- If session is empty / trivial, output [].`;

async function callClaude(
  input: SessionInput,
  heuristic: AnnotateOutput,
  apiKey: string,
): Promise<AnnotateOutput | null> {
  const body = {
    // Env-overridable: model ids rotate; the caller (LazyIDE seed flow)
    // resolves the current cheap extractor model from its catalog and passes
    // it down rather than baking a versioned id into this file.
    model: process.env.LAZYBRAIN_ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // Q2: 1-hour TTL keeps the annotation system prompt hot across the
        // whole session, not just the 5-minute default. Reduces $ on
        // multi-batch sessions where Haiku runs every ~10 captures.
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: input.text.slice(0, 8000),
      },
    ],
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      // Q2: extended cache TTL requires the beta header.
      'anthropic-beta': 'extended-cache-ttl-2025-04-11',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Claude API ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as { content?: Array<{ type: string; text: string }> };
  const raw = data.content?.find((b) => b.type === 'text')?.text;
  if (!raw) return null;

  let facts: LlmFact[];
  try {
    const json = raw
      .trim()
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '');
    facts = JSON.parse(json);
    if (!Array.isArray(facts)) return null;
  } catch {
    return null;
  }

  // Rebuild HTML with LLM facts merged into heuristic structure
  return rebuildHtmlWithFacts(input, heuristic, facts);
}

/**
 * CLI variant of the enrichment path. Uses the user's active Claude Code
 * session (no separate API key) and falls back gracefully on any failure.
 */
async function callClaudeCliEnrich(
  input: SessionInput,
  heuristic: AnnotateOutput,
): Promise<AnnotateOutput | null> {
  const facts = await callClaudeCliJsonArray<LlmFact>(input.text.slice(0, 8000), {
    system: SYSTEM_PROMPT,
    model: process.env.LAZYBRAIN_CLAUDE_CLI_MODEL ?? 'haiku',
    // 60s (was 20s): claude-cli.ts's spawnClaude cold-starts a full CLI
    // session (MCP servers, hooks, CLAUDE.md) before the prompt is even
    // read; 20s measured too tight and made every note in a real import run
    // fail with "claude CLI timed out after 20000ms". See spawnClaude's
    // comment for the fix (--strict-mcp-config --setting-sources local) and
    // DEFAULT_TIMEOUT_MS's comment for the timing rationale.
    timeoutMs: 60_000,
  });
  if (!facts || facts.length === 0) return null;
  return rebuildHtmlWithFacts(input, heuristic, facts);
}

function rebuildHtmlWithFacts(
  input: SessionInput,
  base: AnnotateOutput,
  facts: LlmFact[],
  extractor = 'llm:claude-haiku-4-5',
): AnnotateOutput {
  const ts = input.timestamp ?? new Date().toISOString();
  const validFacts = facts.filter((f) => f.text && f.text.length > 4).slice(0, 8);
  const inferredType = validFacts.some((f) => f.kind === 'decision') ? 'decision' : base.type;
  const title = validFacts[0]?.text.slice(0, 80) ?? base.id;

  const templateFacts = validFacts.map((f) => ({
    text: f.text,
    confidence: Math.max(0, Math.min(1, f.confidence)),
    kind: f.kind,
    extractor,
  }));

  const html = emitWikipediaNote({
    id: base.id,
    title,
    type: inferredType,
    created: ts,
    source: `session:${input.sessionId}`,
    tier: 'working',
    importance: 0.7,
    tags: base.tags,
    facts: templateFacts,
  });

  return { ...base, html, factCount: validFacts.length };
}

/**
 * Canonical backend type used by both llm.ts (single-note enrichment) and
 * extract.ts (batch extraction). The two callers previously had divergent
 * resolvers; this single export is the source of truth for both.
 */
export type ExtractorBackend = 'anthropic' | 'claude-cli' | 'openai' | 'vibe' | 'lazy-proxy';

/**
 * Resolve which LLM backend to use.
 *
 * Precedence (first match wins):
 *   1. LAZYBRAIN_EXTRACTOR=vibe           → vibe
 *      LAZYBRAIN_EXTRACTOR=devstral       → openai  (local llama.cpp / Mistral)
 *      LAZYBRAIN_EXTRACTOR=anthropic      → anthropic
 *      LAZYBRAIN_EXTRACTOR=haiku          → anthropic  (legacy alias)
 *      LAZYBRAIN_EXTRACTOR=claude         → anthropic  (legacy alias)
 *      LAZYBRAIN_EXTRACTOR=claude-cli     → claude-cli (explicit only; no auto-fallback)
 *      LAZYBRAIN_EXTRACTOR=lazy-proxy     → lazy-proxy (LazyIDE managed rail)
 *   2. ANTHROPIC_API_KEY present (and no explicit override) → anthropic
 *   3. default → openai  (sovereign: local devstral at http://127.0.0.1:8080/v1)
 *
 * The openai path never crashes when no local server is running — callers
 * receive null on fetch failure and fall back to heuristic output.
 * The claude-cli path is intentionally NOT a default fallback; it requires
 * an active Claude Code session and adds latency. Set LAZYBRAIN_EXTRACTOR=claude-cli
 * explicitly when that is the desired path.
 */
export function resolveExtractorBackend(): ExtractorBackend {
  const explicit = process.env.LAZYBRAIN_EXTRACTOR;

  if (explicit === 'vibe') return 'vibe';
  if (explicit === 'devstral') return 'openai';
  if (explicit === 'anthropic' || explicit === 'haiku' || explicit === 'claude') return 'anthropic';
  if (explicit === 'claude-cli') return 'claude-cli';
  if (explicit === 'lazy-proxy') return 'lazy-proxy';

  // No explicit override: ANTHROPIC_API_KEY present → anthropic; else sovereign local
  return process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai';
}

/**
 * @deprecated Use resolveExtractorBackend() — kept for internal callers that
 * imported the old name before unification.
 */
export const resolveLlmBackend = resolveExtractorBackend;

async function callOpenAiEnrich(
  input: SessionInput,
  heuristic: AnnotateOutput,
): Promise<AnnotateOutput | null> {
  const { callOpenAiJsonArray, openAiDefaults } = await import('../util/openai-client.js');
  const facts = await callOpenAiJsonArray<LlmFact>(input.text.slice(0, 8000), {
    system: SYSTEM_PROMPT,
    timeoutMs: 20_000,
  });
  if (!facts || facts.length === 0) return null;
  return rebuildHtmlWithFacts(input, heuristic, facts, `llm:${openAiDefaults().model}`);
}

/**
 * LazyIDE ai-proxy backend — the app's managed rail (incl. the free models
 * "offerts par LazyIDE"). NOT OpenAI-compatible: the Supabase Edge Function
 * takes a custom body ({messages, system, model, request_id, feature})
 * authenticated with the user's session JWT (+ the anon key in `apikey`),
 * and streams raw text deltas interleaved with control lines:
 * `\x1b[reasoning]...` (thinking traces from reasoning models — must be
 * stripped before JSON parsing) and a final `\x1b[usage]{...}` billing
 * marker. Nothing is hardcoded so a rotated catalog never means rebuilding
 * this file.
 *
 * Env (required unless noted):
 *   LAZYBRAIN_PROXY_URL    e.g. https://<ref>.supabase.co/functions/v1/ai-proxy
 *   LAZYBRAIN_PROXY_TOKEN  the caller's Supabase session JWT
 *   LAZYBRAIN_PROXY_MODEL  managed catalog id (e.g. z-ai/glm-5.2:free)
 *   LAZYBRAIN_PROXY_MODELS optional comma-separated ordered candidate list —
 *                          each entry is tried in turn when the previous one
 *                          errors or returns nothing parseable (the free
 *                          routes 429/404 individually; the caller passes the
 *                          whole free group so one dead route never degrades
 *                          the run to heuristic).
 *   LAZYBRAIN_PROXY_ANON   optional `apikey` header (Supabase anon key)
 */
export function lazyProxyModels(): string[] {
  const list = (process.env.LAZYBRAIN_PROXY_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  if (list.length > 0) return list;
  const single = process.env.LAZYBRAIN_PROXY_MODEL?.trim();
  return single ? [single] : [];
}

async function callLazyProxyEnrich(
  input: SessionInput,
  heuristic: AnnotateOutput,
): Promise<AnnotateOutput | null> {
  const url = process.env.LAZYBRAIN_PROXY_URL;
  const token = process.env.LAZYBRAIN_PROXY_TOKEN;
  const models = lazyProxyModels();
  if (!url || !token || models.length === 0) return null;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
  const anon = process.env.LAZYBRAIN_PROXY_ANON;
  if (anon) headers['apikey'] = anon;

  for (const model of models) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        // Same discipline as the other backends' timeoutMs — a hung proxy
        // connection must not stall the whole per-note enrichment loop.
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          messages: [{ role: 'user', content: input.text.slice(0, 8000) }],
          system: SYSTEM_PROMPT,
          model,
          request_id: `brain-import-${Date.now().toString(36)}`,
          feature: 'assistant',
        }),
      });
      if (!res.ok) continue;
      const raw = await res.text();
      const text = raw
        .split('\n')
        .filter((line) => !line.startsWith('\x1B[reasoning]') && !line.startsWith('\x1B[usage]'))
        .join('')
        .trim();
      if (!text) continue;
      const facts = parseJsonArrayLoose(text) as LlmFact[] | null;
      if (Array.isArray(facts) && facts.length > 0) {
        return rebuildHtmlWithFacts(input, heuristic, facts, `llm:${model}`);
      }
    } catch {
      // try the next candidate, else heuristic
    }
  }
  return null;
}

/**
 * Vibe CLI variant of the enrichment path. Uses the user's existing Mistral
 * Vibe installation (no separate API key) and falls back gracefully on any
 * failure. --max-turns 1 constrains the agent to a single completion turn.
 */
async function callVibeEnrich(
  input: SessionInput,
  heuristic: AnnotateOutput,
): Promise<AnnotateOutput | null> {
  const facts = await callVibeCliJsonArray<LlmFact>(input.text.slice(0, 8000), {
    system: SYSTEM_PROMPT,
    timeoutMs: 60_000,
  });
  if (!facts || facts.length === 0) return null;
  return rebuildHtmlWithFacts(input, heuristic, facts, 'llm:vibe');
}
