import { callClaudeCliJsonArray, isClaudeCliAvailable } from '../util/claude-cli.js';
import { getLogger } from '../util/logger.js';
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
    model: 'claude-haiku-4-5-20251001',
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
    model: 'haiku',
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
export type ExtractorBackend = 'anthropic' | 'claude-cli' | 'openai' | 'vibe';

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
