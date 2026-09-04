/**
 * lib/answerModel.mjs — the ONE fixed answering model, held constant across
 * every retrieval configuration (only retrieval varies — see run.mjs).
 *
 * Reuses the exact same invocation shape as src/cli/lib/agentLoop.ts's
 * claudeCall(): `claude -p <prompt> --model <model> --output-format json
 * --safe-mode`. Reusing this rather than inventing a second calling
 * convention keeps this harness consistent with how the rest of this repo
 * already benchmarks the claude backend.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const ANSWER_MODEL = process.env.TOKEN_ECON_MODEL ?? 'haiku';

/**
 * On Windows, spawn('claude') fails: the npm global is a .cmd shim that
 * needs shell:true, which mangles newlines in the -p argument. Same
 * resolution src/cli/lib/claude.ts uses — discover claude.exe directly so it
 * can be spawned without a shell.
 */
function resolveClaudeExe() {
  if (process.platform !== 'win32') return 'claude';
  const appData = process.env.APPDATA ?? 'C:\\Users\\Default\\AppData\\Roaming';
  const exe = `${appData}\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  return existsSync(exe) ? exe : 'claude';
}

const CLAUDE_EXE = resolveClaudeExe();

const PROMPT_TEMPLATE = (contextText, question) =>
  `You are answering a question about a specific codebase using ONLY the CONTEXT below. ` +
  `Be specific: cite exact function/variable/flag names and values when you know them. ` +
  `If the context does not contain the answer, say so plainly instead of guessing.\n\n` +
  `CONTEXT:\n${contextText || '(no context provided)'}\n\n` +
  `QUESTION: ${question}\n\nANSWER:`;

export function buildPrompt(contextText, question) {
  return PROMPT_TEMPLATE(contextText, question);
}

/**
 * Call the fixed answering model. Returns { text, usage, raw }.
 * Throws on a non-zero exit code — callers should catch and record failures
 * rather than silently treating an error as "no answer / incorrect".
 */
export function callAnswerModel(contextText, question, { model = ANSWER_MODEL } = {}) {
  return callRawPrompt(buildPrompt(contextText, question), model);
}

// This MUST be a closed-book completion: --safe-mode alone still leaves the
// CLI's built-in tools (Read/Bash/Glob/Grep/...) functional, and haiku will
// happily go read the REAL file straight off disk instead of using the
// injected context — which would silently invalidate every measurement in
// this harness (every config would "win" by reading the ground truth
// directly). --disallowedTools blocks every built-in tool so the model can
// only answer from the prompt text.
const NO_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'ExitPlanMode',
];

/** Call the model with a fully-formed prompt (no template applied) — used by the LLM judge. */
export function callRawPrompt(prompt, model = ANSWER_MODEL) {
  const result = spawnSync(
    CLAUDE_EXE,
    [
      '-p', prompt,
      '--model', model,
      '--output-format', 'json',
      '--safe-mode',
      '--disallowedTools', NO_TOOLS.join(','),
    ],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`claude exited ${result.status}: ${(result.stderr ?? '').slice(0, 500)}`);
  }
  const raw = (result.stdout ?? '').trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: raw, usage: null, raw };
  }
  const text = typeof parsed.result === 'string' && parsed.result.length > 0 ? parsed.result : raw;
  const usage = parsed.usage
    ? {
        inputTokens: parsed.usage.input_tokens ?? 0,
        outputTokens: parsed.usage.output_tokens ?? 0,
        cacheReadInputTokens: parsed.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: parsed.usage.cache_creation_input_tokens ?? 0,
        costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0,
      }
    : null;
  return { text, usage, raw: parsed };
}
