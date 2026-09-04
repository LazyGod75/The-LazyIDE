/**
 * Vibe CLI wrapper — reuses the user's existing Mistral Vibe installation and
 * its configured Mistral subscription instead of a separate API key. The
 * daemon spawns `vibe --prompt "<prompt>" --output text --trust` and reads back the
 * response. The user's existing Vibe quota covers the request.
 *
 * Used by:
 *   - annotator/llm.ts     (single-note enrichment)
 *   - commands/extract.ts  (batch fact extraction)
 *
 * ## Source findings (mistral-vibe repo, read-only)
 *
 * ### Flags confirmed in vibe/cli/entrypoint.py (argparse)
 *   -p / --prompt TEXT       Programmatic mode: send prompt, print response, exit.
 *   --output text|json|streaming
 *                            Output format (default: "text").
 *                            "text" → TextOutputFormatter → print(final_response)
 *                            Pure assistant text, no envelope. This is what we use.
 *   --max-turns N            Maximum assistant turns (programmatic mode only).
 *   --enabled-tools TOOL     In programmatic mode, passing this disables all OTHER tools.
 *   --trust                  Trust the working directory without an interactive prompt.
 *                            Required for non-interactive automation (suppresses the
 *                            check_and_resolve_trusted_folder dialog).
 *   --agent NAME             Builtin: default, plan, accept-edits, auto-approve.
 *
 * ### stdout in programmatic mode (vibe/core/output_formatters.py)
 *   TextOutputFormatter.finalize() returns self._final_response (the last
 *   AssistantEvent.content string). cli.py then does: `if final_response: print(final_response)`.
 *   Result: stdout is EXACTLY the assistant's final text reply, nothing else.
 *   No JSON envelope, no Rich markup (headless=True suppresses the TUI).
 *
 * ### Tool-execution safety
 *   Vibe -p runs a full agent that CAN use tools. For fact extraction we want a
 *   single completion with no tool calls. We use TWO guards in combination:
 *     1. --max-turns 1  — the agent gets exactly one assistant turn; any tool call
 *        would consume that turn before the final text reply, making multi-step
 *        tool chains impossible.
 *     2. The extraction system prompt demands a pure JSON array response and
 *        explicitly prohibits prose. A model receiving a tightly-scoped
 *        JSON-only instruction rarely reaches for tools.
 *   We intentionally do NOT use --enabled-tools with a garbage value because
 *   that would silently disable all tools (including potential future built-ins
 *   that help structured output). --max-turns 1 is the documented flag for this.
 *
 * When the CLI is missing or the spawn fails, callers fall back to heuristic
 * paths so retrieval never blocks on availability.
 */

import { spawn } from 'node:child_process';
import { parseJsonArrayLoose } from './json-loose.js';
import { getLogger } from './logger.js';

export interface VibeCliOptions {
  /** Hard wall-clock budget; the child is SIGKILLed past this. */
  timeoutMs?: number;
  /** Optional system prompt — prepended before the user prompt (mirrors claude-cli). */
  system?: string;
  /** Override path/name of the vibe binary (env LAZYBRAIN_VIBE_BIN wins if set). */
  binary?: string;
}

/**
 * Default per-call timeout. A Vibe agent turn is slower than a bare LLM call
 * (cold Python start + config load + one Mistral round-trip). 60 s is generous
 * but necessary to avoid false timeouts on loaded machines.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Strip any Rich console markup that may leak from vibe's stderr being mixed
 * into output, or any trailing blank lines. In --output text mode stdout is
 * clean, but we defensive-strip just in case.
 */
export function parseVibeCliOutput(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // Rich markup uses [bold], [red], [/bold], [/] etc. Strip them defensively.
  // Pattern: opening bracket, optional slash (closing tag), optional word chars,
  // optional space/= attribute suffix — but never an empty [] which could clip JSON.
  // In practice --output text + headless=True produces clean text.
  return trimmed.replace(/\[(?:\/\w*|\w+(?:[ =][^\]]*)?)\]/g, '').trim() || null;
}

/**
 * Run a single Vibe CLI request and return the text payload. Returns null on
 * any failure (missing binary, non-zero exit, parse failure) so callers can
 * default-fail to their non-LLM code path.
 */
export async function callVibeCli(
  prompt: string,
  opts: VibeCliOptions = {},
): Promise<string | null> {
  if (!prompt || prompt.length === 0) return null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cli = opts.binary ?? process.env.LAZYBRAIN_VIBE_BIN ?? 'vibe';
  const fullPrompt = opts.system ? `${opts.system}\n\n${prompt}` : prompt;

  try {
    const stdout = await spawnVibe(cli, fullPrompt, timeoutMs);
    if (!stdout) return null;
    return parseVibeCliOutput(stdout);
  } catch (err) {
    getLogger().warn({ err: (err as Error).message }, 'vibe-cli failed');
    return null;
  }
}

/**
 * Convenience: call the CLI expecting a JSON array reply (e.g. fact lists).
 * Tolerates stray prose around the array via parseJsonArrayLoose.
 */
export async function callVibeCliJsonArray<T = unknown>(
  prompt: string,
  opts: VibeCliOptions = {},
): Promise<T[] | null> {
  const raw = await callVibeCli(prompt, opts);
  if (!raw) return null;
  return parseJsonArrayLoose<T>(raw);
}

/**
 * Test whether the Vibe CLI is reachable. Cached in memory (60 s TTL) to
 * avoid spawning a probe on every retrieval turn.
 */
let cliAvailable: boolean | null = null;
let cliCheckedAt = 0;
const CLI_AVAILABILITY_TTL_MS = 60_000;

export async function isVibeCliAvailable(): Promise<boolean> {
  const now = Date.now();
  if (cliAvailable !== null && now - cliCheckedAt < CLI_AVAILABILITY_TTL_MS) {
    return cliAvailable;
  }
  cliCheckedAt = now;
  try {
    const cli = process.env.LAZYBRAIN_VIBE_BIN ?? 'vibe';
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

function spawnVibe(cli: string, prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // --output text  → pure assistant text on stdout (no envelope)
    // --max-turns 1  → safety: one assistant turn, no multi-step tool chains
    // --trust        → skip interactive trust dialog in non-interactive automation
    const args = ['--prompt', prompt, '--output', 'text', '--max-turns', '1', '--trust'];

    const child = spawn(cli, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
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
      reject(new Error(`vibe CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.once('error', (err) => {
      clearTimeout(killTimer);
      reject(new Error(`vibe CLI spawn failed: ${err.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(killTimer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`vibe CLI exit ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}
