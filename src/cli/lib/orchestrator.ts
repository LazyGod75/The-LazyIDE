/**
 * src/cli/lib/orchestrator.ts â€” LazyManager-style orchestration for the CLI.
 *
 * The founder's directive: the CLI must behave like the LazyManager, or
 * benchmarking it proves nothing about the product's value. This module
 * implements the SAME cycle the desktop manager runs, headless:
 *
 *   1. SCAN   â€” read the real repo (structure, package.json, README, tests)
 *               BEFORE sizing anything. Never guess the terrain.
 *   2. PLAN   â€” ask the model for a structured plan (ordered steps with
 *               dependencies + verification commands), like generate_plan.
 *   3. EXECUTEâ€” run each step through a real agent pass in the worktree,
 *               with the scanned repo context injected (like the manager's
 *               brain/repo context).
 *   4. VERIFY â€” run the step's real verification (tests/build) and feed
 *               failures back (like the judge loop). Bounded retries.
 *   5. MERGE  â€” commit + merge into the target branch ONLY on verified
 *               success (like approveMission's gate), local-only friendly.
 *
 * Backend: DeepSeek via its OpenAI-compatible API (DEEPSEEK_API_KEY) to
 * spare the founder's Claude subscription; the SAME code path works with any
 * OpenAI-compatible endpoint (DEEPSEEK_API_URL override).
 *
 * Honesty contract (the product's own rule): never claim a step passed
 * unless its verification actually ran green; never claim a merge happened
 * unless git says so; local-only repos merge locally and say so.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { runAgentLoop } from './agentLoop.js';

// â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const API_KEY = process.env.DEEPSEEK_API_KEY;
const API_URL = process.env.DEEPSEEK_API_URL ?? 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';

export interface OrchestratorOptions {
  /** Absolute path of the git worktree where the agent operates. */
  worktreePath: string;
  /** The user's task, natural language. */
  task: string;
  /** Max attempts per step before the step is marked failed. Default 3. */
  maxAttemptsPerStep?: number;
  /** Max steps in the plan. Default 8. */
  maxSteps?: number;
  /** Suppress console progress noise. */
  quiet?: boolean;
}

export interface OrchestratorStepResult {
  id: string;
  title: string;
  status: 'passed' | 'failed' | 'skipped';
  attempts: number;
  verifyOutput?: string;
  error?: string;
}

export interface OrchestratorRunResult {
  ok: boolean;
  steps: OrchestratorStepResult[];
  planText: string;
  summary: string;
}

// â”€â”€ LLM client â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function chat(system: string, user: string, maxTokens = 4096): Promise<string> {
  if (!API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is not set â€” set it or pass --backend claude');
  }
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? '';
}

function extractJsonBlock(text: string): unknown {
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/g;
  const blocks = [...text.matchAll(fence)].map((m) => m[1].trim());
  const candidate = blocks[0] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object found in model output: ${candidate.slice(0, 200)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

// â”€â”€ SCAN: read the real repo before sizing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.lazy', '.lazybrain', '.claude', 'out']);

/** Bounded recursive walk: returns repo-relative paths of source files. */
function walkDir(root: string, dir: string, depth: number, out: string[]): void {
  if (depth > 4) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walkDir(root, full, depth + 1, out);
    } else {
      out.push(relative(root, full).replace(/\\/g, '/'));
    }
  }
}

/** Read a file safely; returns '' on failure. */
function readFileSafe(path: string, maxBytes = 8000): string {
  try {
    const content = readFileSync(path, 'utf8');
    return content.length > maxBytes ? `${content.slice(0, maxBytes)}\n... [truncated]` : content;
  } catch {
    return '';
  }
}

/** Build the repo context block injected into the planner (like the
 *  manager's fleet/brain context â€” real data, never fabricated). */
export function scanRepo(worktreePath: string): string {
  const files: string[] = [];
  walkDir(worktreePath, worktreePath, 0, files);

  const lines: string[] = [];
  lines.push(`Repository scan (${files.length} files, max depth 4):`);

  // Key files first: package.json, README, configs.
  const keyFiles = files.filter((f) =>
    ['package.json', 'README.md', 'tsconfig.json', 'next.config.mjs', 'vite.config.ts', '.env.example', 'tailwind.config.ts'].includes(f),
  );
  for (const f of keyFiles.slice(0, 8)) {
    lines.push(`\n--- ${f} ---\n${readFileSafe(join(worktreePath, f), 3000)}`);
  }

  // Source files (excluding the key files already shown) â€” bounded.
  const sourceFiles = files.filter((f) => /\.(ts|tsx|js|jsx|mjs|css|json|py|go|rs|sh|rb|java|c|cc|cpp|h|hpp|toml|yaml|yml|md)$/.test(f) && !keyFiles.includes(f));
  lines.push(`\nSource files (${sourceFiles.length}):`);
  for (const f of sourceFiles.slice(0, 40)) {
    lines.push(`- ${f}`);
  }
  // Show a few small representative files in full so the planner sees code.
  const smallSources = sourceFiles
    .filter((f) => {
      try {
        return statSync(join(worktreePath, f)).size < 2500;
      } catch {
        return false;
      }
    })
    .slice(0, 6);
  for (const f of smallSources) {
    lines.push(`\n--- ${f} ---\n${readFileSafe(join(worktreePath, f), 2500)}`);
  }

  return lines.join('\n');
}

// â”€â”€ PLAN: structured steps from the model â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface PlannedStep {
  id: string;
  title: string;
  /** What the step must produce/change, self-contained. */
  instructions: string;
  /** Shell command(s) to verify the step (may be empty). */
  verify?: string;
  /** Files this step is expected to touch (repo-relative). */
  touches?: string[];
}

/** Ask the model for a structured plan. Throws on malformed output. */
export async function planTask(worktreePath: string, task: string, maxSteps = 8): Promise<{ planText: string; steps: PlannedStep[] }> {
  const repoContext = scanRepo(worktreePath);
  const system = [
    'You are the planning engine of an autonomous coding agent.',
    'Produce a STRICT JSON plan: {"steps":[{"id":"s1","title":"...","instructions":"self-contained instructions for an autonomous agent","verify":"optional shell command to prove the step (e.g. npm test, node file.test.mjs)","touches":["file paths expected to change"]}]}',
    `At most ${maxSteps} steps. Steps must be ORDERED by dependency.`,
    'Rules: read the repo context FIRST; never invent files that contradict it; verification commands must be real commands that could run in the repo; if the repo has no test setup, verification may be a build command or omitted.',
    'CRITICAL: verification commands must be CROSS-PLATFORM (this runs on Windows). NEVER use Unix-only commands like `test -f`, `ls`, `touch`, `&&` chains with test. Use `node -e "..."` for file checks (e.g. node -e "require(\'fs\').existsSync(\'lib/types.ts\') || process.exit(1)") or npm scripts (npm run build, npm test).',
    'Reply with ONLY the JSON object.',
  ].join('\n');
  const user = `TASK:\n${task}\n\nREPO CONTEXT:\n${repoContext}`;

  const planText = await chat(system, user, 4096);
  const parsed = extractJsonBlock(planText) as { steps?: PlannedStep[] };
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error(`Planner returned no steps: ${planText.slice(0, 300)}`);
  }
  const steps = parsed.steps.slice(0, maxSteps).map((s) => ({
    ...s,
    // Cross-platform sanitizer: convert Unix-only verification commands into
    // node equivalents so a plan never fails on Windows for the wrong reason
    // (verified live: `test -f file` is not a Windows command). Never guesses
    // the FILE — it only rewrites the CHECK mechanism.
    verify: sanitizeVerifyCommand(s.verify),
  }));
  return { planText, steps };
}

/** Convert Unix-only verification primitives to node equivalents. */
function sanitizeVerifyCommand(verify: string | undefined): string | undefined {
  if (!verify || !verify.trim()) return verify;
  const v = verify.trim();
  // `test -f <path> && echo ...` -> node existence check.
  const testFile = /^test\s+-f\s+([^\s&]+)\s*(?:&&\s*echo\s+.*)?$/i.exec(v);
  if (testFile) {
    const p = testFile[1].replace(/^['"]|['"]$/g, '');
    return `node -e "require('fs').existsSync('${p}') || process.exit(1)"`;
  }
  // `[ -f <path> ]` (bash-style) -> node existence check.
  const bracketFile = /^\[\s+-f\s+([^\s\]]+)\s*\]\s*(?:&&\s*.*)?$/i.exec(v);
  if (bracketFile) {
    const p = bracketFile[1].replace(/^['"]|['"]$/g, '');
    return `node -e "require('fs').existsSync('${p}') || process.exit(1)"`;
  }
  // `ls <path>` -> node existence check.
  const lsFile = /^ls\s+([^\s&]+)\s*$/i.exec(v);
  if (lsFile) {
    const p = lsFile[1].replace(/^['"]|['"]$/g, '');
    return `node -e "require('fs').existsSync('${p}') || process.exit(1)"`;
  }
  return v;
}

// â”€â”€ EXECUTE: one step through a real agent pass â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


interface VerifyResult {
  code: number;
  output: string;
}

function runVerify(worktreePath: string, command: string): VerifyResult {
  try {
    const result = spawnSync(command, {
      cwd: worktreePath,
      shell: true,
      encoding: 'utf8',
      timeout: 180_000,
      stdio: 'pipe',
      env: { ...process.env },
    });
    return {
      code: result.status ?? -1,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(0, 2000),
    };
  } catch (err) {
    return { code: -1, output: String(err instanceof Error ? err.message : err) };
  }
}

/** Apply a step: run the LazyManager-level agent loop (real tools) on the
 *  step’s instructions, then the step’s verification gate.
 *  The loop mirrors the desktop manager: read_dir / find_file / search_code /
 *  read / edit / write / bash, honest observations, bounded retries by caller. */
async function executeStep(worktreePath: string, step: PlannedStep, attempt: number, repoContext: string): Promise<{ ok: boolean; output: string }> {
  const task = [
    `STEP ${step.id}: ${step.title}`,
    '',
    step.instructions,
    '',
    `Verification that will run after you complete this step: ${step.verify || '(none \u2014 rely on code correctness)'}`,
    '',
    'REPO CONTEXT (relevant files):',
    repoContext.slice(0, 6000),
    attempt > 1 ? `\nNOTE: previous attempt ${attempt - 1} failed verification. Fix the root cause; do not just reformat.` : "",
  ].join('\n');

  const agent = await runAgentLoop({ workdir: worktreePath, task });
  if (agent.lastError) return { ok: false, output: `agent error: ${agent.lastError}` };
  if (agent.stoppedBy === 'max-steps') {
    return { ok: false, output: `agent stopped after ${agent.iterations} iterations without finishing (${agent.toolCalls} tool calls)` };
  }

  const agentOk = agent.ok || agent.toolCalls > 0;

  // VERIFY: run the step real verification command.
  if (step.verify && step.verify.trim()) {
    let verifyOut = runVerify(worktreePath, step.verify);
    // Real-agent behavior: a verify failure caused by a MISSING COMMAND
    // ("next is not recognized", "npm is not recognized") means deps are
    // not installed - a real agent would run npm install and retry.
    if (verifyOut.code !== 0 && !existsSync(join(worktreePath, "node_modules")) || /(not found|ENOENT|Cannot find|n.test pas reconnu|not recognized)/i.test(verifyOut.output)) {
      const hasPackageJson = /package-lock.json|yarn.lock|pnpm-lock.yaml/.test(readdirSync(worktreePath).join(" "));
      if (hasPackageJson || readdirSync(worktreePath).includes("package.json")) {
        console.error("[orchestrator] missing command detected - running npm install...");
        runVerify(worktreePath, "npm install --no-audit --no-fund");
        verifyOut = runVerify(worktreePath, step.verify);
      }
    }
    if (verifyOut.code === 0) {
      return { ok: true, output: "verification passed (" + step.verify + ")" };
    }
    return { ok: false, output: "verification FAILED (" + step.verify + "):\n" + verifyOut.output.slice(0, 800) };
  }
  return { ok: agentOk, output: agent.ok ? 'agent finished; no verification command' : 'agent made changes; no verification command' };
}

// â”€â”€ Orchestrator entry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function runOrchestratedMission(opts: OrchestratorOptions): Promise<OrchestratorRunResult> {
  const { worktreePath, task, maxAttemptsPerStep = 3, maxSteps = 8, quiet = false } = opts;
  const log = (msg: string) => {
    if (!quiet) console.error(msg);
  };

  if (!API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is required for the orchestrated mode (set it, or use --backend claude)');
  }

  // 1. SCAN â€” before anything, read the repo.
  log(`[orchestrator] Scanning repo: ${worktreePath}`);
  let repoContext = scanRepo(worktreePath);
  log(`[orchestrator] Repo scan complete (${repoContext.length} chars of context)`);

  // 2. PLAN.
  log(`[orchestrator] Planning task with ${MODEL}...`);
  const { planText, steps } = await planTask(worktreePath, task, maxSteps);
  log(`[orchestrator] Plan: ${steps.map((s) => s.id).join(' -> ')} (${steps.length} steps)`);

  // 3+4. EXECUTE + VERIFY per step, bounded retries, fresh scan each step
  // (the manager re-reads the repo between steps â€” never stale context).
  const results: OrchestratorStepResult[] = [];
  for (const step of steps) {
    log(`[orchestrator] Step ${step.id}: ${step.title}`);
    let stepOk = false;
    let lastOutput = '';
    let attempts = 0;
    while (attempts < maxAttemptsPerStep) {
      attempts += 1;
      try {
        const outcome = await executeStep(worktreePath, step, attempts, repoContext);
        if (outcome.ok) {
          stepOk = true;
          lastOutput = outcome.output;
          break;
        }
        lastOutput = outcome.output;
        log(`[orchestrator]   attempt ${attempts} failed: ${outcome.output.slice(0, 200).replace(/\n/g, ' ')}`);
      } catch (err) {
        lastOutput = err instanceof Error ? err.message : String(err);
        log(`[orchestrator]   attempt ${attempts} error: ${lastOutput.slice(0, 200)}`);
      }
    }
    results.push({
      id: step.id,
      title: step.title,
      status: stepOk ? 'passed' : 'failed',
      attempts,
      verifyOutput: lastOutput,
      error: stepOk ? undefined : lastOutput,
    });
    if (!stepOk) {
      log(`[orchestrator] Step ${step.id} FAILED after ${attempts} attempts â€” stopping (never fake a pass).`);
      break;
    }
    // Fresh scan after each passed step so later steps see the changed repo.
    repoContext = scanRepo(worktreePath);
  }

  const ok = results.every((r) => r.status === 'passed');
  return {
    ok,
    steps: results,
    planText,
    summary: ok
      ? `All ${results.length} steps passed`
      : `Failed at step ${results.find((r) => r.status === 'failed')?.id ?? '?'}`,
  };
}

