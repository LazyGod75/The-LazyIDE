import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { type ExtractorBackend, resolveExtractorBackend } from '../annotator/llm.js';
import { listAll } from '../indexer/fts.js';
import { indexNote } from '../indexer/fts.js';
import { stripNote } from '../retrieval/strip.js';
import { readNote } from '../store/reader.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';

export interface ExtractCliOptions {
  batchSize?: number;
  dryRun?: boolean;
  pretty?: boolean;
}

// Re-export so external callers that imported from extract.ts continue to work.
export type { ExtractorBackend };
export { resolveExtractorBackend };

function openAiModelName(): string {
  return process.env.LAZYBRAIN_OPENAI_MODEL ?? 'devstral';
}

interface PendingNote {
  id: string;
  path: string;
  text: string;
}

interface LlmFact {
  for: string; // note id
  text: string;
  kind: 'decision' | 'fact' | 'error' | 'learning';
  confidence: number;
}

/**
 * Batch LLM extraction for low-quality notes (mem0-style, opt-in).
 *
 * Runs only when `LAZYBRAIN_EXTRACTOR=haiku` and `ANTHROPIC_API_KEY` are set.
 * Per session cost (≤ 10 notes × ~500 tokens prompt): ≈ $0.001 with prompt cache.
 *
 * Selection: notes whose extractor is heuristic AND all confidences < 0.6
 * OR factCount === 0. Limits to `batchSize` per invocation (default 10).
 */
export async function runExtract(opts: ExtractCliOptions): Promise<string> {
  const start = Date.now();
  // Enabled when LAZYBRAIN_EXTRACTOR is set to any recognised value.
  // 'anthropic' / legacy aliases (haiku, claude) require an API key; the
  // enabled check is loose here — the backend guard below catches the missing-key case.
  const enabled = Boolean(process.env.LAZYBRAIN_EXTRACTOR);
  // Four backends (resolved via the canonical resolver in annotator/llm.ts):
  //   'openai'     — local llama.cpp / Mistral (LAZYBRAIN_EXTRACTOR=devstral)
  //   'anthropic'  — Anthropic direct API via ANTHROPIC_API_KEY
  //   'claude-cli' — Claude Code CLI, reuses active subscription (LAZYBRAIN_EXTRACTOR=claude-cli only)
  //   'vibe'       — Mistral Vibe CLI, reuses the user's Vibe Mistral subscription
  const backend = resolveExtractorBackend();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!enabled) {
    return JSON.stringify({
      status: 'disabled',
      reason: 'LAZYBRAIN_EXTRACTOR not set (try LAZYBRAIN_EXTRACTOR=devstral or vibe)',
    });
  }
  if (backend === 'anthropic' && !apiKey) {
    return JSON.stringify({
      status: 'disabled',
      reason: 'backend=anthropic requires ANTHROPIC_API_KEY',
    });
  }

  const batchSize = opts.batchSize ?? 10;
  const pending = selectPending(batchSize);
  if (pending.length === 0) {
    return JSON.stringify({ status: 'noop', reason: 'nothing to extract' });
  }

  if (opts.dryRun) {
    return JSON.stringify({ status: 'dry-run', backend, candidates: pending.map((p) => p.id) });
  }

  let upgraded = 0;
  try {
    const facts =
      backend === 'anthropic' && apiKey
        ? await callHaikuBatch(pending, apiKey)
        : backend === 'openai'
          ? await callOpenAiBatch(pending)
          : backend === 'vibe'
            ? await callVibeBatch(pending)
            : await callClaudeCli(pending); // claude-cli
    if (facts.length === 0) {
      return JSON.stringify({ status: 'ok', upgraded: 0, processed: pending.length });
    }
    // Group by note id, patch each
    const byNote = new Map<string, LlmFact[]>();
    for (const f of facts) {
      const list = byNote.get(f.for) ?? [];
      list.push(f);
      byNote.set(f.for, list);
    }
    for (const note of pending) {
      const noteFacts = byNote.get(note.id) ?? [];
      if (noteFacts.length === 0) continue;
      try {
        const extractedBy =
          backend === 'openai'
            ? `llm:${openAiModelName()}`
            : backend === 'vibe'
              ? 'llm:vibe'
              : 'llm:claude-haiku-4-5';
        patchNoteWithFacts(note.path, noteFacts, extractedBy);
        indexNote(readNote(note.path));
        upgraded += 1;
      } catch {
        // best-effort
      }
    }
  } catch (err) {
    logTelemetry({
      event: 'error',
      ts: nowIso(),
      where: 'extract',
      message: (err as Error).message,
    });
    return JSON.stringify({ status: 'error', message: (err as Error).message });
  }

  const payload = {
    status: 'ok',
    processed: pending.length,
    upgraded,
    duration_ms: Date.now() - start,
  };
  return opts.pretty
    ? `Extracted ${upgraded}/${pending.length} notes (Haiku batch, ${payload.duration_ms}ms)`
    : JSON.stringify(payload);
}

function selectPending(limit: number): PendingNote[] {
  const all = listAll({ includeExpired: false });
  const out: PendingNote[] = [];
  for (const n of all) {
    if (n.path.includes('batches')) continue;
    if (out.length >= limit) break;
    try {
      const html = readFileSync(n.path, 'utf8');
      // Skip if already LLM-extracted
      if (/data-cerveau-extracted-by="llm:/.test(html)) continue;
      const stripped = stripNote(html);
      const lowQuality =
        stripped.facts.length === 0 ||
        stripped.facts.every((f) => f.confidence < 0.6 && f.extractor === 'heuristic');
      if (!lowQuality) continue;
      const text = stripped.text || stripped.facts.map((f) => f.text).join('\n');
      if (text.length < 40) continue;
      out.push({ id: n.id, path: n.path, text: text.slice(0, 1200) });
    } catch {
      // skip
    }
  }
  return out;
}

const SYSTEM_PROMPT = `You extract atomic facts from short engineering notes for a persistent memory system.

Output ONLY a JSON array. No prose. No code fence. Schema per item:
{"for":"<note-id>","text":"fact in 5-25 words ending with a period","kind":"decision|fact|error|learning","confidence":0.0-1.0}

Rules:
- Up to 3 facts per note. Skip a note entirely when nothing meaningful can be extracted.
- "decision" = explicit choice ("we picked X").
- "error" = problem or root cause.
- "learning" = generalisable insight.
- "fact" = stable claim about the system.
- Each fact MUST stand alone (no "it", "this", "we" without referent).
- Skip code, file paths, command output unless it's a decision or error.`;

async function callHaikuBatch(notes: PendingNote[], apiKey: string): Promise<LlmFact[]> {
  const userBlocks = notes.map((n) => `--- note id: ${n.id}\n${n.text}`).join('\n\n');

  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: userBlocks,
      },
    ],
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Claude API ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as {
    content?: Array<{ type: string; text: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const raw = data.content?.find((b) => b.type === 'text')?.text;
  if (!raw) return [];

  let parsed: LlmFact[];
  try {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '');
    parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
  } catch {
    return [];
  }

  logTelemetry({
    event: 'capture',
    ts: nowIso(),
    tokens_in: data.usage?.input_tokens ?? 0,
    tokens_out_html: data.usage?.output_tokens ?? 0,
    duration_ms: 0,
  });

  return parsed.filter(
    (f) => typeof f.for === 'string' && typeof f.text === 'string' && f.text.length >= 4,
  );
}

async function callOpenAiBatch(notes: PendingNote[]): Promise<LlmFact[]> {
  const { callOpenAiJsonArray } = await import('../util/openai-client.js');
  const userBlocks = notes.map((n) => `--- note id: ${n.id}\n${n.text}`).join('\n\n');
  const parsed = await callOpenAiJsonArray<LlmFact>(
    `INPUT:\n${userBlocks}\n\nReturn ONLY the JSON array, no prose.`,
    { system: SYSTEM_PROMPT, maxTokens: 2048 },
  );
  if (!parsed) return [];
  logTelemetry({
    event: 'capture',
    ts: nowIso(),
    tokens_in: Math.ceil(userBlocks.length / 4),
    tokens_out_html: 0,
    duration_ms: 0,
  });
  return parsed.filter(
    (f) => typeof f.for === 'string' && typeof f.text === 'string' && f.text.length >= 4,
  );
}

/**
 * Spawn `vibe -p "<prompt>" --output text --max-turns 1 --trust` to reuse the
 * user's existing Mistral Vibe installation and its configured Mistral account.
 * No separate API key needed — quota comes from the user's Vibe subscription.
 *
 * --max-turns 1 ensures one assistant turn only, preventing multi-step tool
 * chains. The system prompt demands a pure JSON array response, making tool use
 * very unlikely on the single available turn.
 */
async function callVibeBatch(notes: PendingNote[]): Promise<LlmFact[]> {
  const { callVibeCliJsonArray } = await import('../util/vibe-cli.js');
  const userBlocks = notes.map((n) => `--- note id: ${n.id}\n${n.text}`).join('\n\n');
  const prompt = `INPUT:\n${userBlocks}\n\nReturn ONLY the JSON array, no prose.`;

  const parsed = await callVibeCliJsonArray<LlmFact>(prompt, {
    system: SYSTEM_PROMPT,
    timeoutMs: 60_000,
  });
  if (!parsed) return [];

  logTelemetry({
    event: 'capture',
    ts: nowIso(),
    tokens_in: Math.ceil((SYSTEM_PROMPT.length + prompt.length) / 4),
    tokens_out_html: 0,
    duration_ms: 0,
  });

  return parsed.filter(
    (f) => typeof f.for === 'string' && typeof f.text === 'string' && f.text.length >= 4,
  );
}

/**
 * Spawn `claude --print --output-format json` to reuse the active Claude Code
 * subscription instead of consuming a separate API key. Quota comes from the
 * user's existing session; no second key needed.
 *
 * The CLI input is a single prompt combining the system instructions and the
 * note batch. Output is parsed from the JSON response shape that `claude`
 * produces in `--output-format json` mode.
 */
async function callClaudeCli(notes: PendingNote[]): Promise<LlmFact[]> {
  const userBlocks = notes.map((n) => `--- note id: ${n.id}\n${n.text}`).join('\n\n');
  const prompt = `${SYSTEM_PROMPT}\n\nINPUT:\n${userBlocks}\n\nReturn ONLY the JSON array, no prose.`;

  const stdout = await runClaudeCli(prompt);
  if (!stdout) return [];

  // claude --output-format json wraps the response. Extract the text content.
  let textPayload = stdout;
  try {
    const parsed = JSON.parse(stdout) as { result?: string; content?: string; text?: string };
    textPayload = parsed.result ?? parsed.content ?? parsed.text ?? stdout;
  } catch {
    // not JSON envelope, treat raw stdout as the response text
  }

  // The model's response should itself be a JSON array — extract it
  let raw = textPayload.trim();
  // Strip code fences if present
  raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```\s*$/, '');
  // Find the array brackets defensively (model may add stray prose)
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  const arrSrc = raw.slice(start, end + 1);

  let parsed: LlmFact[];
  try {
    parsed = JSON.parse(arrSrc);
    if (!Array.isArray(parsed)) return [];
  } catch {
    return [];
  }

  logTelemetry({
    event: 'capture',
    ts: nowIso(),
    tokens_in: Math.ceil(prompt.length / 4),
    tokens_out_html: Math.ceil(arrSrc.length / 4),
    duration_ms: 0,
  });

  return parsed.filter(
    (f) => typeof f.for === 'string' && typeof f.text === 'string' && f.text.length >= 4,
  );
}

function runClaudeCli(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Resolve the claude CLI by name — relies on user PATH being set in the
    // daemon's spawn environment (we extend PATH in the hook _run.sh already).
    const cli = process.env.LAZYBRAIN_CLAUDE_BIN ?? 'claude';
    const args = [
      '--print',
      '--output-format',
      'json',
      '--model',
      'haiku',
      '--permission-mode',
      'plan',
    ];
    const child = spawn(cli, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      reject(new Error(`claude CLI spawn failed: ${err.message}`));
    });
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude CLI exit ${code}: ${stderr.slice(0, 200)}`));
    });
    // Some Claude Code versions accept prompt via stdin; --print --prompt is also valid.
    child.stdin.end(prompt);
  });
}

function patchNoteWithFacts(
  path: string,
  facts: LlmFact[],
  extractedBy = 'llm:claude-haiku-4-5',
): void {
  const html = readFileSync(path, 'utf8');
  const cleanedFacts = facts.slice(0, 3);
  const factsHtml = cleanedFacts
    .map((f) => {
      const conf = Math.max(0, Math.min(1, f.confidence ?? 0.7)).toFixed(2);
      return `  <p data-cerveau-fact data-cerveau-confidence="${conf}" data-cerveau-extracted-by="${extractedBy}" data-cerveau-kind="${f.kind}">${escapeHtml(f.text)}</p>`;
    })
    .join('\n');

  // Insert before </article> (or </section>), keep existing structure.
  const patched = html.replace(/(<\/(article|section)>\s*)$/, `${factsHtml}\n$1`);
  writeFileSync(path, patched, 'utf8');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
