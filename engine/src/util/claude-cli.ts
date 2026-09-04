/**
 * Claude CLI wrapper — reuses the active Claude Code session instead of a
 * standalone API key. The daemon spawns `claude --print --output-format json`
 * and reads back the response. The user's existing quota covers the request.
 *
 * Used by:
 *   - annotator/llm.ts        (single-note enrichment)
 *   - retrieval/multi-query.ts (RRF paraphrase generation)
 *   - retrieval/hyde.ts       (hypothetical document synthesis)
 *   - commands/extract.ts     (batch fact extraction)
 *
 * When the CLI is missing or the spawn fails, callers fall back to heuristic
 * paths so retrieval never blocks on availability.
 */

import { spawn } from 'node:child_process';
import { parseJsonArrayLoose } from './json-loose.js';
import { getLogger } from './logger.js';

export interface ClaudeCliOptions {
  /** Model alias the CLI understands: 'haiku' | 'sonnet' | 'opus'. Defaults to haiku. */
  model?: 'haiku' | 'sonnet' | 'opus';
  /** Hard wall-clock budget; the child is SIGKILLed past this. */
  timeoutMs?: number;
  /** Optional system prompt — concatenated before the user input. */
  system?: string;
  /** Override path/name of the claude binary (env LAZYBRAIN_CLAUDE_BIN wins if set). */
  binary?: string;
}

/**
 * Default per-call timeout. `spawnClaude` already passes `--strict-mcp-config
 * --setting-sources local` to skip the user's MCP servers / hooks / global
 * CLAUDE.md (see that function's comment), but even with those flags a cold
 * local cache plus the first Anthropic-side prompt-cache write can take several
 * seconds; 60s matches the sibling CLI wrapper's budget (vibe-cli.ts) and
 * leaves comfortable headroom instead of the previous 20s, which measured
 * consistently too tight (9-10s even warm, uninstrumented cold runs regularly
 * exceeded it — see engine/src/annotator/llm.ts's history for the incident).
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Run a single Claude CLI request and return the text payload. Returns null on
 * any failure (missing binary, non-zero exit, parse failure) so callers can
 * default-fail to their non-LLM code path.
 */
export async function callClaudeCli(
  prompt: string,
  opts: ClaudeCliOptions = {},
): Promise<string | null> {
  if (!prompt || prompt.length === 0) return null;
  const model = opts.model ?? 'haiku';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cli = opts.binary ?? process.env.LAZYBRAIN_CLAUDE_BIN ?? 'claude';
  const fullPrompt = opts.system ? `${opts.system}\n\n${prompt}` : prompt;

  try {
    const stdout = await spawnClaude(cli, fullPrompt, model, timeoutMs);
    if (!stdout) return null;
    return extractTextFromJsonEnvelope(stdout);
  } catch (err) {
    getLogger().warn({ err: (err as Error).message }, 'claude-cli failed');
    return null;
  }
}

/**
 * Convenience: call the CLI expecting a JSON array reply (e.g. fact lists,
 * paraphrase lists). Tolerates stray prose around the array.
 */
export async function callClaudeCliJsonArray<T = unknown>(
  prompt: string,
  opts: ClaudeCliOptions = {},
): Promise<T[] | null> {
  const raw = await callClaudeCli(prompt, opts);
  if (!raw) return null;
  return parseJsonArrayLoose<T>(raw);
}

/**
 * Test whether the Claude CLI is reachable. Cached in memory to avoid spawning
 * a probe on every retrieval turn.
 */
let cliAvailable: boolean | null = null;
let cliCheckedAt = 0;
const CLI_AVAILABILITY_TTL_MS = 60_000;

export async function isClaudeCliAvailable(): Promise<boolean> {
  const now = Date.now();
  if (cliAvailable !== null && now - cliCheckedAt < CLI_AVAILABILITY_TTL_MS) {
    return cliAvailable;
  }
  cliCheckedAt = now;
  try {
    const cli = process.env.LAZYBRAIN_CLAUDE_BIN ?? 'claude';
    cliAvailable = await new Promise<boolean>((resolve) => {
      const child = spawn(cli, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32',
      });
      let ok = false;
      child.stdout.on('data', () => {
        ok = true;
      });
      child.once('error', () => resolve(false));
      child.once('close', (code) => resolve(ok || code === 0));
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* */
        }
        resolve(false);
      }, 5_000);
    });
  } catch {
    cliAvailable = false;
  }
  return cliAvailable;
}

/**
 * Higher-level capability test: a feature like HyDE / RRF should use the CLI
 * iff the env says so AND the CLI is reachable. The env flag lets a user opt
 * out even when the CLI is installed.
 */
export async function llmAvailable(envFlag: string): Promise<boolean> {
  // The env-var convention: empty/"0"/"false" → disabled, anything else → enabled.
  const flag = process.env[envFlag] ?? '';
  const enabled = flag !== '' && flag !== '0' && flag.toLowerCase() !== 'false';
  if (!enabled) return false;
  // Honour the legacy ANTHROPIC_API_KEY path too — some users will set it.
  if (process.env.ANTHROPIC_API_KEY) return true;
  return isClaudeCliAvailable();
}

function spawnClaude(
  cli: string,
  prompt: string,
  model: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--output-format',
      'json',
      '--model',
      model,
      '--permission-mode',
      'default',
      // Skip the user's MCP servers, hooks, and global/project CLAUDE.md —
      // this is a single headless text-in/JSON-out call with no tool use, but
      // without these flags `claude` bootstraps a full interactive-equivalent
      // session (every configured MCP server, SessionStart hooks, the whole
      // CLAUDE.md hierarchy) before it even looks at the prompt. Measured
      // impact: ~9.4s wall / $0.11 without these flags vs ~3.7s / $0.02 with
      // them, on a machine with a non-trivial global CLAUDE.md and several
      // MCP servers configured — on a cold cache (no recent identical system
      // prompt to reuse server-side) this gap widens well past the old 20s
      // timeout, which is why every note failed, not just some. Mirrors the
      // same fix already proven in src-tauri/src/commands/chat.rs's
      // claude_chat_stream_inner (see its "ephemeral Q&A call" comment).
      '--strict-mcp-config',
      '--setting-sources',
      'local',
    ];
    // permission-mode "default" (not "plan"): this call never needs tool use
    // (pure text extraction), and "plan" was observed to silently route part
    // of the request through an extra, more expensive model turn (a second
    // "claude-sonnet-5" line item appeared in usage/cost even though --model
    // haiku was requested) — additional latency and ~5x cost for no benefit,
    // since a plan can never be interactively approved in --print mode
    // anyway. "default" still auto-denies (never hangs on) any tool call the
    // model might unexpectedly attempt in a non-interactive session.
    //
    // On Windows, the `claude` shim is a .cmd / .ps1 that must be invoked via
    // shell; but if we pass the full path (with spaces) wrapped in quotes,
    // shell=true is what makes it parse correctly. The previous failure ("n'est
    // pas reconnu") happened when the daemon's spawn env stripped PATH; we
    // explicitly inherit it now.
    const child = spawn(cli, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
      env: { ...process.env, PATH: process.env.PATH },
    });
    let stdout = '';
    let stderr = '';
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* */
      }
      // Include whatever stderr arrived before the kill — previously silently
      // dropped on the timeout path (only used on the non-zero-exit branch
      // below), which is why past timeout logs carried zero diagnostic detail.
      const detail = stderr.trim() ? ` — stderr so far: ${stderr.trim().slice(0, 300)}` : '';
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms${detail}`));
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.once('error', (err) => {
      clearTimeout(killTimer);
      reject(new Error(`claude CLI spawn failed: ${err.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(killTimer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude CLI exit ${code}: ${stderr.slice(0, 200)}`));
    });
    child.stdin.end(prompt);
  });
}

function extractTextFromJsonEnvelope(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      result?: string;
      content?: string;
      text?: string;
      messages?: Array<{ content?: unknown }>;
    };
    if (typeof parsed.result === 'string') return parsed.result;
    if (typeof parsed.content === 'string') return parsed.content;
    if (typeof parsed.text === 'string') return parsed.text;
    // Some claude CLI versions wrap response in messages[]
    if (Array.isArray(parsed.messages)) {
      for (const m of parsed.messages) {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
          for (const block of m.content) {
            if (
              typeof block === 'object' &&
              block &&
              'text' in block &&
              typeof (block as { text: unknown }).text === 'string'
            ) {
              return (block as { text: string }).text;
            }
          }
        }
      }
    }
  } catch {
    // not a JSON envelope; treat the raw stdout as the response body
  }
  return trimmed;
}
