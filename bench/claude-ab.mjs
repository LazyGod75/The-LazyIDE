#!/usr/bin/env node
/**
 * bench/claude-ab.mjs — Controlled A/B benchmark:
 *   "Claude seul" vs "Claude + Brain (graphe de contexte)" vs "Claude dans LazyIDE".
 *
 * La thèse mesurée est celle que Graft (NanoNets) publie : le gain vient du
 * CONTEXTE injecté à chaque prompt, pas du modèle. Ici le "graphe de contexte"
 * est le brain LazyBrain du projet (neurons / FTS / graph) :
 *
 *   Arm A  "Claude seul"            claude -p, froid, SANS outils et SANS brain
 *                                    (fichiers nécessaires collés dans le prompt)
 *   Arm C  "Claude + Brain"         idem arm A mais avec le contexte LazyBrain
 *                                    rappelé (inject-context) ajouté au prompt
 *   Arm B  "Claude dans LazyIDE"    dist/cli/idebench.cjs — le harness IDE officiel :
 *                                    VRAI runtime d'outils (src/lib/tools/toolRuntime.ts),
 *                                    VRAI system prompt (src/lib/agents/managedAgentPolicy.ts),
 *                                    VRAI registry (src/lib/agents/toolRegistry.ts) — le
 *                                    même code que l'IDE, shimmé uniquement pour Tauri invoke
 *                                    — avec --backend claude --brain (contexte LazyBrain
 *                                    injecté dans le system prompt à chaque tour + boucle
 *                                    ReAct THOUGHT/ACTION/ARGS du LazyManager)
 *
 * Métriques (comptées à l'identique dans les 3 bras, depuis le JSON du CLI claude) :
 *   - résolu (la MÊME porte de passage : `node --test <testfile>` / scorer patterns)
 *   - coût USD (total_cost_usd renvoyé par le CLI claude, même comptabilité)
 *   - wall-clock, tokens, et (bras B) appels d'outils / itérations
 *
 * Prérequis : `npm run build:cli` + `npm run build:idebench`, CLI `claude` connecté,
 * `LazyBrain/dist/bin/lazybrain.js` présent (chemin dev auto-découvert), Node >= 20.
 *
 * Usage :
 *   node bench/claude-ab.mjs                  # run complet (agent + swe, sonnet)
 *   node bench/claude-ab.mjs --model haiku    # même modèle dans les 3 bras
 *   node bench/claude-ab.mjs --tasks swe      # swe | agent | all
 *   node bench/claude-ab.mjs --arm a          # a | c | b | ac | cb | both (défaut)
 *   node bench/claude-ab.mjs --max-steps 40   # budget boucle (bras B)
 *   node bench/claude-ab.mjs --keep           # garder les workdirs scratch
 *
 * Sorties :
 *   bench/results/claude-ab.json          résultats structurés complets
 *   bench/results/claude-ab-report.md     rapport comparatif
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, '..');
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli', 'lazy.cjs');
const IDEBENCH_PATH = join(REPO_ROOT, 'dist', 'cli', 'idebench.cjs');
const RESULTS_DIR = join(__dir, 'results');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
}

const MODEL = arg('model', 'sonnet');
const BACKEND = arg('backend', 'claude'); // claude (CLI) | deepseek (API)
const TASKS_FILTER = arg('tasks', 'all'); // all | agent | swe
const TASK_ID = arg('task', ''); // optional single task id
const ARM_FILTER = arg('arm', 'both'); // both | a | c | b | ac | cb
const MAX_STEPS = Number(arg('max-steps', '40'));
const KEEP_WS = process.argv.includes('--keep');

// DeepSeek (backend=deepseek): API endpoint + pricing (USD per 1M tokens).
// Prices documented for deepseek-v4-flash; override with env vars.
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_URL = process.env.DEEPSEEK_API_URL ?? 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
const PRICE_INPUT = Number(process.env.DEEPSEEK_PRICE_INPUT_M ?? 0.14); // $/M input (cache-miss)
const PRICE_OUTPUT = Number(process.env.DEEPSEEK_PRICE_OUTPUT_M ?? 0.28); // $/M output
const PRICE_CACHE_HIT = Number(process.env.DEEPSEEK_PRICE_CACHE_HIT_M ?? 0.014); // $/M input (cache hit)
// Scratch workdirs are per-backend so concurrent claude + deepseek runs never clash.
const WS_ROOT = join(__dir, 'claude-ab-ws', BACKEND);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the real claude binary (same discovery as src/cli/lib/claude.ts). */
function resolveClaudeExe() {
  if (process.platform !== 'win32') return 'claude';
  const appData = process.env.APPDATA ?? 'C:\\Users\\Default\\AppData\\Roaming';
  const exe = `${appData}\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  return existsSync(exe) ? exe : 'claude';
}

const CLAUDE_CMD = resolveClaudeExe();

/** Resolve lazybrain.js (same priority as src/cli/lib/paths.ts dev path). */
function resolveLazybrainScript() {
  const envScript = process.env.LAZYBRAIN_SCRIPT;
  if (envScript && existsSync(envScript)) return envScript;
  const devScript = join(REPO_ROOT, '..', 'LazyBrain', 'dist', 'bin', 'lazybrain.js');
  if (existsSync(devScript)) return devScript;
  return null;
}

const LAZYBRAIN_SCRIPT = resolveLazybrainScript();

/** Run lazybrain with args. Returns { ok, stdout, stderr, error }. */
function runBrain(args, { input } = {}) {
  if (!LAZYBRAIN_SCRIPT) return { ok: false, stdout: '', stderr: '', error: 'lazybrain.js not found' };
  const result = spawnSync(process.execPath, [LAZYBRAIN_SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return { ok: false, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: `lazybrain exit ${result.status}` };
  }
  return { ok: true, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: null };
}

/** Extract fenced code blocks from a model answer. */
function extractFences(text) {
  const re = /```(?:js|javascript|ts|typescript|mjs|esm|json|py|python|go|rs|rust|sh|bash)?\s*\n([\s\S]*?)```/g;
  return [...text.matchAll(re)].map((m) => m[1].trim());
}

/** Safe basename of a fixture path (strip bench/swe-workspace/, bench/agent-output/, dirs). */
function relBasename(p) {
  return p.replace(/\\/g, '/').split('/').pop();
}


/** Run the claude CLI once. Returns { ok, text, usage, costUsd, durationMs, error }. */
function runClaude(prompt, { cwd } = {}) {
  const t0 = Date.now();
  const result = spawnSync(
    CLAUDE_CMD,
    ['-p', prompt, '--model', MODEL, '--output-format', 'json', '--safe-mode'],
    { cwd, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const durationMs = Date.now() - t0;
  if (result.status !== 0) {
    return { ok: false, text: '', costUsd: 0, durationMs, error: `claude exit ${result.status}: ${(result.stderr ?? '').slice(0, 300)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse((result.stdout ?? '').trim());
  } catch {
    return { ok: false, text: (result.stdout ?? '').trim(), costUsd: 0, durationMs, error: 'claude output was not JSON' };
  }
  const usage = parsed.usage ?? {};
  return {
    ok: parsed.is_error !== true,
    text: typeof parsed.result === 'string' ? parsed.result : (result.stdout ?? '').trim(),
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    },
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0,
    durationMs,
  };
}

/** Run one DeepSeek chat completion (solo arm, no tools). Returns { ok, text, usage, costUsd, durationMs, error }. */
async function runDeepseek(prompt) {
  if (!DEEPSEEK_KEY) return { ok: false, text: '', costUsd: 0, durationMs: 0, error: 'DEEPSEEK_API_KEY is not set' };
  const t0 = Date.now();
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 8192,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, text: '', costUsd: 0, durationMs: Date.now() - t0, error: `deepseek API ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = await res.json();
    const u = data.usage ?? {};
    const inputTokens = (u.prompt_tokens ?? 0) - (u.prompt_cache_hit_tokens ?? 0);
    const cacheHitTokens = u.prompt_cache_hit_tokens ?? 0;
    const outputTokens = u.completion_tokens ?? 0;
    const costUsd =
      (inputTokens * PRICE_INPUT + cacheHitTokens * PRICE_CACHE_HIT + outputTokens * PRICE_OUTPUT) / 1_000_000;
    return {
      ok: true,
      text: data.choices?.[0]?.message?.content ?? '',
      usage: {
        inputTokens,
        outputTokens,
        cacheReadInputTokens: cacheHitTokens,
        cacheCreationInputTokens: 0,
        totalTokens: inputTokens + cacheHitTokens + outputTokens,
      },
      costUsd,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return { ok: false, text: '', costUsd: 0, durationMs: Date.now() - t0, error: String(err.message ?? err) };
  }
}

/** Run `node --test <testFile>` in a workdir. Returns { passed, output }. */
function runNodeTest(workdir, testFileRel) {
  try {
    const result = spawnSync(process.execPath, ['--test', testFileRel], {
      cwd: workdir,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: 'pipe',
    });
    return { passed: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(0, 800) };
  } catch (err) {
    return { passed: false, output: String(err.message ?? err).slice(0, 800) };
  }
}

/**
 * Seed a LazyBrain for a task: init the brain + store one neuron per setup file
 * (the file content as a fact, tagged by filename). Mirrors how the IDE brain
 * accumulates knowledge of the repo. Returns the brain path or null on failure.
 */
function seedBrain(task, workdir) {
  if (!LAZYBRAIN_SCRIPT) return null;
  const brainPath = join(workdir, '.lazybrain', 'brain');
  const init = runBrain(['--brain', brainPath, 'init']);
  if (!init.ok) return null;

  const files = task.kind === 'swe' ? task.setupFiles : [];
  for (const f of files) {
    const id = `bench-${task.id}-${relBasename(f.rel).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40)}`;
    const esc = String(f.content).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<article id="${id}"\n  data-cerveau-version="0.1.0"\n  data-cerveau-created="2026-08-12T00:00:00Z"\n  data-cerveau-type="decision"\n  data-cerveau-source="lazy-bench:seed"\n  data-cerveau-tier="working"\n  data-cerveau-importance="0.9"\n  data-cerveau-tags="benchmark ${task.id} source-file">\n  <h2>File ${f.rel}</h2>\n  <p data-cerveau-fact data-cerveau-confidence="1.0" data-cerveau-extracted-by="human">\n    Source file ${f.rel} of task ${task.id}:\\n<pre><code>${esc}</code></pre>\n  </p>\n</article>`;
    runBrain(['--brain', brainPath, 'store', '--from-stdin'], { input: html });
  }

  // Build the searchable index + graph so recall finds the seeded nodes.
  runBrain(['--brain', brainPath, 'index-rebuild']);
  runBrain(['--brain', brainPath, 'graph', '--quiet']);
  return brainPath;
}

/**
 * Recall brain context for a query (inject-context turn mode, same call as
 * src/cli/lib/brain.ts brainRecall). Returns stripped context or ''.
 */
function recallBrain(brainPath, query) {
  if (!brainPath) return '';
  const res = runBrain([
    '--brain', brainPath,
    'inject-context', '--mode', 'turn', '--query', query,
    '--max-tokens', '2000', '--format', 'compact',
  ]);
  if (!res.ok) return '';
  // Strip the "[LAZYBRAIN] Memory hits below..." header line that is not content.
  const out = (res.stdout ?? '').trim();
  return out.replace(/^\[LAZYBRAIN\][^\n]*\n?/, '').trim();
}


/** Fixture pattern scorer (same semantics as bench/lib/agent-tasks.mjs). */
function scorePatternChecks(checks, implContent, testContent) {
  const results = [];
  for (const check of checks) {
    let passed = true;
    let detail = 'ok';
    if (check.pattern !== undefined) {
      passed = new RegExp(check.pattern).test(implContent);
      detail = passed ? 'pattern found' : `pattern not found: ${check.pattern}`;
    } else if (check.patternAbsent !== undefined) {
      passed = !new RegExp(check.patternAbsent).test(implContent);
      detail = passed ? 'pattern absent' : `pattern present: ${check.patternAbsent}`;
    } else if (check.testPattern !== undefined) {
      passed = new RegExp(check.testPattern).test(testContent);
      detail = passed ? 'test pattern found' : `test pattern not found: ${check.testPattern}`;
    } else if (check.testMinOccurrences !== undefined) {
      const count = (testContent.match(new RegExp(check.testMinOccurrences.pattern, 'g')) ?? []).length;
      passed = count >= check.testMinOccurrences.min;
      detail = `found ${count} occurrences, need ${check.testMinOccurrences.min}`;
    }
    results.push({ id: check.id, passed, detail });
  }
  const passedCount = results.filter((r) => r.passed).length;
  return {
    passedCount,
    totalChecks: results.length,
    score: results.length > 0 ? Math.round((passedCount / results.length) * 100) / 100 : 0,
    results,
  };
}

// ---------------------------------------------------------------------------
// Task loading & normalization
// ---------------------------------------------------------------------------

function loadTasks() {
  const agentFixture = JSON.parse(readFileSync(join(__dir, 'fixtures/agent-tasks.json'), 'utf8'));
  const sweFixture = JSON.parse(readFileSync(join(__dir, 'fixtures/swe-tasks.json'), 'utf8'));

  const agentTasks = agentFixture.tasks.map((t) => ({
    ...t,
    kind: 'agent',
    implRel: relBasename(t.outputFile),
    testRel: relBasename(t.testFile),
    setupFiles: [],
  }));

  const sweTasks = sweFixture.tasks.map((t) => ({
    ...t,
    kind: 'swe',
    // Re-map the fixture's repo-relative setup paths onto the task workdir root.
    setupFiles: (t.setupFiles ?? []).map((f) => ({ rel: relBasename(f.path), content: f.content })),
    implRel: relBasename(t.implFile),
    testRel: relBasename(t.testFile),
  }));

  if (TASKS_FILTER === 'agent') return agentTasks;
  if (TASKS_FILTER === 'swe') return sweTasks;
  return [...agentTasks, ...sweTasks];
}

// ---------------------------------------------------------------------------
// Arm A — "Claude seul" (cold, no tools, no brain)
// ---------------------------------------------------------------------------

function buildColdPrompt(task) {
  const lines = [
    'You are a senior software engineer. Solve the task below. You have NO file access and NO tools — everything you need is in this prompt.',
    '',
    `TASK:\n${task.spec}`,
  ];

  if (task.kind === 'swe') {
    for (const f of task.setupFiles) {
      lines.push('', `FILE ${f.rel}:`, '```', f.content, '```');
    }
    lines.push(
      '',
      `Output ONLY the complete corrected content of ${task.implRel} inside a single markdown code fence.`,
      'Output nothing outside the fence — no explanations, no test file.',
    );
  } else {
    lines.push(
      '',
      `Write the implementation to ${task.implRel} and a test file to ${task.testRel}.`,
      'Output TWO markdown code fences, in this order:',
      `1. the complete ${task.implRel} implementation`,
      `2. the complete ${task.testRel} test`,
      'Output nothing outside the fences.',
    );
  }
  return lines.join('\n');
}

/** Seed the workdir files (tests for swe) so the SAME grader can score both arms. */
function seedWorkdir(task, workdir) {
  if (task.kind === 'swe') {
    for (const f of task.setupFiles) writeFileSync(join(workdir, f.rel), f.content, 'utf8');
  }
}

async function runArm(task, workdir, prompt) {
  const res = BACKEND === 'claude' ? runClaude(prompt, { cwd: workdir }) : await runDeepseek(prompt);
  res.prompt = prompt;

  // Write what the model produced into the workdir so the same grader scores it.
  const fences = extractFences(res.text);
  let wroteImpl = false;
  let wroteTest = false;
  if (task.kind === 'swe') {
    if (fences.length > 0) {
      writeFileSync(join(workdir, task.implRel), fences[0], 'utf8');
      wroteImpl = true;
    }
  } else {
    if (fences.length > 0) writeFileSync(join(workdir, task.implRel), fences[0], 'utf8');
    if (fences.length > 1) writeFileSync(join(workdir, task.testRel), fences[1], 'utf8');
    wroteImpl = fences.length > 0;
    wroteTest = fences.length > 1;
  }

  return {
    ...res,
    wallClockMs: res.durationMs ?? 0,
    wroteImpl,
    wroteTest,
    fences: fences.length,
    rawLength: res.text.length,
  };
}

/**
 * Run the solo model with the given prompt, optionally prepending brain context
 * (arm C). Dispatches to the claude CLI or the DeepSeek API. Returns the run object.
 */
async function runSoloWithContext(task, workdir, brainPath, withBrain) {
  let prompt = buildColdPrompt(task);
  if (withBrain && brainPath) {
    const ctx = recallBrain(brainPath, task.spec);
    if (ctx) {
      prompt = `[Brain context from LazyBrain project memory]\n${ctx}\n[End of brain context]\n\n${prompt}`;
    }
  }
  return { ...(await runArm(task, workdir, prompt)), brainInjected: Boolean(withBrain && brainPath) };
}


// ---------------------------------------------------------------------------
// Arm B — "Model dans LazyIDE"
//
// DeepSeek:  dist/cli/idebench.cjs --backend deepseek — the OFFICIAL IDE harness
//            (real toolRuntime + managedAgentPolicy ReAct + toolRegistry) = the
//            desktop LazyManager managed loop, headless. 100% faithful.
// Claude:    Claude Code NATIVE (`claude -p --dangerously-skip-permissions` in
//            the task workdir) — how the IDE actually runs Claude (claudeCode-
//            Provider → claude CLI subprocess with its own Read/Edit/Write/Bash
//            tools). Claude Code REFUSES the LazyManager THOUGHT/ACTION/ARGS
//            format (anti role-play / prompt-injection guard), so the faithful
//            "Claude in the IDE" arm is Claude Code's own loop.
// ---------------------------------------------------------------------------

function runArmB(task, workdir, brainPath) {
  const t0 = Date.now();
  // Symmetry with arm A: agent tasks must name the files the grader reads
  // (impl/test), exactly like the cold prompt does.
  const taskPrompt =
    task.kind === 'agent'
      ? `${task.spec}\n\nWrite the implementation to ${task.implRel} and the tests to ${task.testRel} in the working directory.`
      : task.spec;
  const args = [
    IDEBENCH_PATH,
    taskPrompt,
    '--workdir', workdir,
    '--backend', BACKEND,
    '--model', MODEL,
    '--max-steps', String(MAX_STEPS),
    '--quiet',
  ];
  if (brainPath) args.push('--brain');
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 1_800_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const wallClockMs = Date.now() - t0;

  let parsed = null;
  try {
    parsed = JSON.parse((result.stdout ?? '').trim());
  } catch {
    parsed = { ok: false, parseError: true, stdout: (result.stdout ?? '').slice(0, 2000) };
  }

  const usage = parsed.usage ?? {};
  return {
    ok: parsed.ok === true,
    stoppedBy: parsed.stoppedBy ?? 'unknown',
    iterations: parsed.iterations ?? 0,
    toolCalls: parsed.toolCalls ?? 0,
    costUsd: typeof parsed.costUsd === 'number' ? parsed.costUsd : 0,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
      totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0),
    },
    wallClockMs,
    lastError: parsed.lastError ?? (parsed.parseError ? 'idebench stdout was not JSON' : null),
    raw: JSON.stringify(parsed).slice(0, 2000),
  };
}

/**
 * Arm B for Claude: Claude Code NATIVE loop in the task workdir
 * (`claude -p --dangerously-skip-permissions`), optionally + brain context.
 * One claude call = Claude Code's full internal agentic loop.
 */
function runArmBClaude(task, workdir, brainPath) {
  // Symmetry with arm A: agent tasks must name the files the grader reads.
  let prompt =
    task.kind === 'agent'
      ? `${task.spec}\n\nWrite the implementation to ${task.implRel} and the tests to ${task.testRel} in the working directory.`
      : task.spec;
  if (brainPath) {
    const ctx = recallBrain(brainPath, task.spec);
    if (ctx) {
      prompt = `[Brain context from LazyBrain project memory]\n${ctx}\n[End of brain context]\n\n${prompt}`;
    }
  }
  const t0 = Date.now();
  const result = spawnSync(
    CLAUDE_CMD,
    ['-p', prompt, '--model', MODEL, '--output-format', 'json', '--safe-mode', '--dangerously-skip-permissions'],
    { cwd: workdir, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const wallClockMs = Date.now() - t0;
  if (result.status !== 0) {
    return { ok: false, stoppedBy: 'error', iterations: 0, toolCalls: 0, costUsd: 0, usage: { totalTokens: 0 }, wallClockMs, lastError: `claude exit ${result.status}: ${(result.stderr ?? '').slice(0, 300)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse((result.stdout ?? '').trim());
  } catch {
    return { ok: false, stoppedBy: 'error', iterations: 0, toolCalls: 0, costUsd: 0, usage: { totalTokens: 0 }, wallClockMs, lastError: 'claude output was not JSON' };
  }
  const usage = parsed.usage ?? {};
  const numTurns = parsed.num_turns ?? 1;
  return {
    ok: parsed.is_error !== true,
    stoppedBy: parsed.is_error === true ? 'error' : 'finish',
    iterations: numTurns,
    toolCalls: numTurns,
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0,
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    },
    wallClockMs,
    lastError: parsed.is_error === true ? String(parsed.result ?? '').slice(0, 500) : null,
    raw: (parsed.result ?? '').slice(0, 2000),
  };
}

// ---------------------------------------------------------------------------
// Grading (the SAME gate for every arm)
// ---------------------------------------------------------------------------

function gradeTask(task, workdir) {
  if (task.kind === 'swe') {
    const implPath = join(workdir, task.implRel);
    const testPath = join(workdir, task.testRel);
    const hasImpl = existsSync(implPath) && readFileSync(implPath, 'utf8').trim().length > 0;
    const hasTest = existsSync(testPath);
    const testRun = hasTest ? runNodeTest(workdir, task.testRel) : { passed: false, output: 'test file missing' };
    const checks = (task.scoring?.checks ?? []).filter((c) => c.id !== 'test-passes');
    const pattern = scorePatternChecks(checks, hasImpl ? readFileSync(implPath, 'utf8') : '', '');
    const testPassed = testRun.passed;
    const score = testPassed ? 1 : pattern.totalChecks > 0 ? pattern.passedCount / pattern.totalChecks : 0;
    return { testPassed, testOutput: testRun.output, score, passedChecks: testPassed ? pattern.totalChecks : pattern.passedCount, totalChecks: pattern.totalChecks, solved: testPassed, hasImpl };
  }

  // agent task
  const implPath = join(workdir, task.implRel);
  const testPath = join(workdir, task.testRel);
  const hasImpl = existsSync(implPath) && readFileSync(implPath, 'utf8').trim().length > 0;
  const hasTest = existsSync(testPath);
  const implContent = hasImpl ? readFileSync(implPath, 'utf8') : '';
  const testContent = hasTest ? readFileSync(testPath, 'utf8') : '';
  const pattern = scorePatternChecks(task.scorer?.checks ?? [], implContent, testContent);
  let testRun = null;
  if (hasTest) {
    const r = runNodeTest(workdir, task.testRel);
    testRun = { passed: r.passed, output: r.output };
  }
  return {
    testPassed: testRun?.passed ?? false,
    testOutput: testRun?.output ?? 'n/a',
    score: pattern.score,
    passedChecks: pattern.passedCount,
    totalChecks: pattern.totalChecks,
    solved: pattern.score >= 1,
    hasImpl,
  };
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Which arms to run based on --arm. */
function armsToRun() {
  const f = ARM_FILTER;
  if (f === 'a' || f === 'c' || f === 'b') return [f];
  if (f === 'ac') return ['a', 'c'];
  if (f === 'cb') return ['c', 'b'];
  return ['a', 'c', 'b'];
}

async function main() {
  // Regenerate the markdown report from an existing results JSON (no new runs).
  if (process.argv.includes('--report-only')) {
    const jsonPath = join(RESULTS_DIR, `claude-ab-${BACKEND}.json`);
    if (!existsSync(jsonPath)) {
      process.stderr.write(`[claude-ab] --report-only: ${jsonPath} not found\n`);
      process.exit(1);
    }
    const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const report = buildReport(data.runs, data.aggregate, {
      arms: data.arms,
      backend: data.backend,
      model: data.model,
      maxSteps: data.maxSteps,
      tasks: data.tasksFilter,
    });
    writeFileSync(join(RESULTS_DIR, `claude-ab-${BACKEND}-report.md`), report, 'utf8');
    process.stdout.write(`${report}\n`);
    process.exit(0);
  }

  if (!existsSync(CLI_PATH)) {
    process.stderr.write(`[claude-ab] dist/cli/lazy.cjs not found — run "npm run build:cli" first.\n`);
    process.exit(1);
  }
  if (!existsSync(IDEBENCH_PATH)) {
    process.stderr.write(`[claude-ab] dist/cli/idebench.cjs not found — run "npm run build:idebench" first.\n`);
    process.exit(1);
  }

  // Single-instance lock per backend: two harness processes writing the same
  // results file corrupt the benchmark. Refuse to start if another is alive.
  mkdirSync(RESULTS_DIR, { recursive: true });
  const LOCK = join(RESULTS_DIR, `claude-ab-${BACKEND}.lock`);
  if (existsSync(LOCK)) {
    const oldPid = Number(readFileSync(LOCK, 'utf8').trim());
    let alive = false;
    try {
      process.kill(oldPid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) {
      process.stderr.write(`[claude-ab] another run (pid ${oldPid}, backend=${BACKEND}) is active — exiting.\n`);
      process.exit(3);
    }
  }
  writeFileSync(LOCK, String(process.pid), 'utf8');
  process.on('exit', () => {
    try {
      rmSync(LOCK, { force: true });
    } catch {
      /* ignore */
    }
  });
  if (BACKEND === 'claude') {
    const probe = runClaude('Reply with exactly: OK');
    if (!probe.ok || !probe.text.includes('OK')) {
      process.stderr.write(`[claude-ab] claude CLI is not responding correctly (${probe.error ?? probe.text.slice(0, 120)}). Sign in with "claude" first.\n`);
      process.exit(1);
    }
  } else if (!DEEPSEEK_KEY) {
    process.stderr.write('[claude-ab] backend=deepseek requires DEEPSEEK_API_KEY\n');
    process.exit(1);
  }
  if (!LAZYBRAIN_SCRIPT) {
    process.stderr.write('[claude-ab] WARNING: lazybrain.js not found — brain arms (C/B) will run without brain context. Build LazyBrain or set LAZYBRAIN_SCRIPT.\n');
  }

  const arms = armsToRun();
  let tasks = loadTasks();
  if (TASK_ID) {
    tasks = tasks.filter((t) => t.id === TASK_ID);
    if (tasks.length === 0) {
      process.stderr.write(`[claude-ab] no task with id "${TASK_ID}"\n`);
      process.exit(1);
    }
  }
  process.stdout.write(`[claude-ab] backend=${BACKEND} model=${MODEL} arms=${arms.join(',')} tasks=${tasks.length} (${TASKS_FILTER}) steps=${MAX_STEPS} brain=${LAZYBRAIN_SCRIPT ? 'yes' : 'no'}\n`);
  if (tasks.length === 0) {
    process.stderr.write('[claude-ab] no tasks selected (--tasks agent|swe|all)\n');
    process.exit(1);
  }

  if (existsSync(WS_ROOT) && !KEEP_WS) rmSync(WS_ROOT, { recursive: true, force: true });
  mkdirSync(WS_ROOT, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });

  const runs = [];

  for (const task of tasks) {
    process.stdout.write(`\n=== ${task.id} (${task.kind}) — ${task.title}\n`);
    const run = { id: task.id, kind: task.kind, title: task.title, spec: task.spec, a: null, c: null, b: null, gradeA: null, gradeC: null, gradeB: null };

    for (const arm of arms) {
      const workdir = join(WS_ROOT, arm, task.id);
      mkdirSync(workdir, { recursive: true });
      seedWorkdir(task, workdir);

      if (arm === 'a') {
        process.stdout.write(`  [A] ${BACKEND} seul (froid, sans outils, sans brain)...\n`);
        run.a = await runSoloWithContext(task, workdir, null, false);
        run.gradeA = gradeTask(task, workdir);
        process.stdout.write(`      ${run.gradeA.solved ? 'SOLVED' : 'FAILED'} score=${run.gradeA.score} cost=$${run.a.costUsd.toFixed(4)} ${(run.a.wallClockMs / 1000).toFixed(1)}s\n`);
      } else if (arm === 'c') {
        process.stdout.write(`  [C] ${BACKEND} + Brain (contexte injecté, sans outils)...\n`);
        const brainPath = seedBrain(task, workdir);
        run.c = await runSoloWithContext(task, workdir, brainPath, true);
        run.gradeC = gradeTask(task, workdir);
        process.stdout.write(`      ${run.gradeC.solved ? 'SOLVED' : 'FAILED'} score=${run.gradeC.score} cost=$${run.c.costUsd.toFixed(4)} ${(run.c.wallClockMs / 1000).toFixed(1)}s brain=${run.c.brainInjected ? 'injected' : 'empty'}\n`);
      } else {
        const brainPath = seedBrain(task, workdir);
        if (BACKEND === 'claude') {
          process.stdout.write(`  [B] Claude dans LazyIDE (Claude Code natif, brain + outils, cwd=workdir)...\n`);
          run.b = runArmBClaude(task, workdir, brainPath);
        } else {
          process.stdout.write(`  [B] idebench (VRAI LazyManager headless, deepseek, brain + outils, max ${MAX_STEPS} steps)...\n`);
          run.b = runArmB(task, workdir, brainPath);
        }
        run.gradeB = gradeTask(task, workdir);
        process.stdout.write(`      ${run.gradeB.solved ? 'SOLVED' : 'FAILED'} score=${run.gradeB.score} cost=$${run.b.costUsd.toFixed(4)} ${(run.b.wallClockMs / 1000).toFixed(1)}s toolCalls=${run.b.toolCalls} iterations=${run.b.iterations} ${run.b.stoppedBy}\n`);
      }
    }

    runs.push(run);
  }


  // --- Aggregates ---
  const agg = {};
  for (const arm of arms) {
    const key = `grade${arm.toUpperCase()}`;
    const graded = runs.filter((r) => r[key] !== null);
    const solved = graded.filter((r) => r[key].solved).length;
    const cost = graded.reduce((s, r) => s + r[arm].costUsd, 0);
    const time = graded.reduce((s, r) => s + r[arm].wallClockMs, 0);
    const tokens = graded.reduce((s, r) => s + (r[arm].usage?.totalTokens ?? 0), 0);
    const toolCalls = arm === 'b' ? graded.reduce((s, r) => s + (r.b.toolCalls ?? 0), 0) : null;
    const avgScore = graded.length > 0 ? graded.reduce((s, r) => s + r[key].score, 0) / graded.length : 0;
    const costPerSolved = solved > 0 ? cost / solved : null;
    agg[arm] = {
      taskCount: graded.length,
      solved,
      solvedRate: graded.length > 0 ? solved / graded.length : 0,
      avgScore: Math.round(avgScore * 100) / 100,
      costUsd: Math.round(cost * 10000) / 10000,
      costPerSolvedUsd: costPerSolved !== null ? Math.round(costPerSolved * 10000) / 10000 : null,
      wallClockMs: time,
      totalTokens: tokens,
      toolCalls,
    };
  }

  const OUT_SUFFIX = `-${BACKEND}`;
  const report = buildReport(runs, agg, { arms, backend: BACKEND, model: MODEL, maxSteps: MAX_STEPS, tasks: TASKS_FILTER });
  writeFileSync(join(RESULTS_DIR, `claude-ab${OUT_SUFFIX}.json`), JSON.stringify({
    timestamp: new Date().toISOString(),
    backend: BACKEND,
    model: MODEL,
    maxSteps: MAX_STEPS,
    tasksFilter: TASKS_FILTER,
    arms,
    claude: CLAUDE_CMD,
    deepseekModel: DEEPSEEK_MODEL,
    deepseekPricing: { inputPerM: PRICE_INPUT, outputPerM: PRICE_OUTPUT, cacheHitPerM: PRICE_CACHE_HIT },
    lazybrain: LAZYBRAIN_SCRIPT,
    methodology: {
      armA: `${BACKEND} cold single-shot — no tools, no brain; files pasted into the prompt`,
      armC: `arm A + LazyBrain inject-context (repo memory graph) added to the prompt — no tools`,
      armB: BACKEND === 'claude'
        ? 'claude -p --dangerously-skip-permissions in the task workdir (Claude Code NATIVE loop — the IDE\'s real Claude integration via claudeCodeProvider; Claude Code refuses the LazyManager THOUGHT/ACTION/ARGS format) + brain context'
        : 'idebench.cjs (official IDE harness: REAL toolRuntime + managedAgentPolicy + toolRegistry, Tauri invoke shimmed) --backend deepseek --brain = desktop LazyManager managed loop, headless',
      cost: BACKEND === 'claude'
        ? 'sum of claude CLI total_cost_usd per LLM call (identical accounting in every arm)'
        : 'tokens billed from DeepSeek API usage at documented V4-Flash prices (see deepseekPricing)',
      gate: 'node --test <testfile> for swe tasks; pattern scorer for agent tasks (same code for every arm)',
    },
    aggregate: agg,
    runs,
  }, null, 2), 'utf8');
  writeFileSync(join(RESULTS_DIR, `claude-ab${OUT_SUFFIX}-report.md`), report, 'utf8');

  process.stdout.write(`\n${report}\n`);
  process.stdout.write(`\n[claude-ab] JSON: bench/results/claude-ab${OUT_SUFFIX}.json\n`);
  process.stdout.write(`[claude-ab] Report: bench/results/claude-ab${OUT_SUFFIX}-report.md\n`);
}

main().catch((err) => {
  process.stderr.write(`[claude-ab] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});


// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmtPct(x) {
  return `${Math.round(x * 100)}%`;
}

function fmtSec(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildReport(runs, agg, ctx) {
  const arms = ctx.arms;
  const has = (a) => Boolean(agg[a]);
  const modelLabel = ctx.backend === 'deepseek' ? 'DeepSeek' : 'Claude';

  const lines = [];
  lines.push(`# ${modelLabel} seul vs ${modelLabel} + Brain vs ${modelLabel} dans LazyIDE — A/B Benchmark`);
  lines.push('');
  lines.push(`- **Backend / Modèle :** \`${ctx.backend}\` / \`${ctx.model}\` (identique dans tous les bras)`);
  lines.push(`- **Tâches :** ${runs.length} (${runs.filter((r) => r.kind === 'swe').length} SWE-style, ${runs.filter((r) => r.kind === 'agent').length} agent) — filtre \`${ctx.tasks}\``);
  lines.push(`- **Budget bras B :** ${ctx.maxSteps} steps max`);
  lines.push(`- **Date :** ${new Date().toISOString()}`);
  lines.push('');

  lines.push('## Résultats agrégés');
  lines.push('');
  const label = { a: `${modelLabel} seul`, c: `${modelLabel} + Brain`, b: `${modelLabel} dans LazyIDE` };
  const head = ['| Métrique'];
  for (const a of arms) head[0] += ` | ${label[a]}`;
  head[0] += ' |';
  const sep = ['|:--'];
  for (let i = 0; i < arms.length; i += 1) sep.push(':--:');
  sep.push('|');
  lines.push(head[0]);
  lines.push(sep.join('|'));

  const rowVal = (a, fmt) => (has(a) ? fmt(agg[a]) : '—');
  const row = (cells) => `| ${cells.join(' | ')} |`;

  lines.push(row(['Résolu', ...arms.map((a) => rowVal(a, (x) => `${x.solved}/${x.taskCount} (${fmtPct(x.solvedRate)})`))]));
  lines.push(row(['Score moyen', ...arms.map((a) => rowVal(a, (x) => String(x.avgScore)))]));
  lines.push(row(['Coût total', ...arms.map((a) => rowVal(a, (x) => `$${x.costUsd.toFixed(4)}`))]));
  lines.push(row(['Coût / résolue', ...arms.map((a) => rowVal(a, (x) => (x.costPerSolvedUsd !== null ? `$${x.costPerSolvedUsd.toFixed(4)}` : 'n/a')))]));
  lines.push(row(['Temps wall-clock', ...arms.map((a) => rowVal(a, (x) => fmtSec(x.wallClockMs)))]));
  lines.push(row(['Tokens (total)', ...arms.map((a) => rowVal(a, (x) => x.totalTokens.toLocaleString()))]));
  if (has('b')) lines.push(row(['Appels d\'outils (B)', ...arms.map((a) => (a === 'b' ? String(agg.b.toolCalls) : '—'))]));
  lines.push('');



  // Deltas when we have the pairs.
  const deltaPairs = [];
  if (has('a') && has('c')) deltaPairs.push(['a', 'c', 'gain du brain (seul → +brain)']);
  if (has('c') && has('b')) deltaPairs.push(['c', 'b', 'gain de la boucle LazyIDE (+brain → +outils)']);
  if (has('a') && has('b')) deltaPairs.push(['a', 'b', 'gain total LazyIDE (seul → IDE)']);
  if (deltaPairs.length > 0) {
    lines.push('## Deltas (ce que ça prouve)');
    lines.push('');
    lines.push('| Comparaison | Δ résolu | Δ score | Δ coût | Δ temps |');
    lines.push('|:--|:--:|:--:|:--:|:--:|');
    for (const [from, to, name] of deltaPairs) {
      const df = agg[to].solvedRate - agg[from].solvedRate;
      const dScore = agg[to].avgScore - agg[from].avgScore;
      const dCost = agg[from].costUsd > 0 ? ((agg[to].costUsd - agg[from].costUsd) / agg[from].costUsd) * 100 : 0;
      const dTime = agg[from].wallClockMs > 0 ? ((agg[to].wallClockMs - agg[from].wallClockMs) / agg[from].wallClockMs) * 100 : 0;
      const p = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pts`;
      const pc = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
      lines.push(`| ${name} | ${p(df)} | ${dScore >= 0 ? '+' : ''}${dScore.toFixed(2)} | ${pc(dCost)} | ${pc(dTime)} |`);
    }
    lines.push('');
  }

  lines.push('## Détail par tâche');
  lines.push('');
  const detHead = ['| Tâche'];
  for (const a of arms) detHead.push(`| ${label[a]} (score / résolue / coût / temps${a === 'b' ? ' / outils' : ''})`);
  detHead.push('|');
  lines.push(detHead.join(''));
  lines.push(`|:--${'|:--:'.repeat(arms.length)}|`);
  for (const r of runs) {
    const cells = [r.id];
    for (const a of arms) {
      const g = r[`grade${a.toUpperCase()}`];
      if (!g || !r[a]) {
        cells.push('—');
      } else {
        cells.push(`${g.solved ? '✅' : '❌'} ${g.score} · $${r[a].costUsd.toFixed(4)} · ${fmtSec(r[a].wallClockMs)}${a === 'b' ? ` · ${r[a].toolCalls} outils` : ''}`);
      }
    }
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('');

  lines.push('## Méthodologie (contrôles d\u2019honnêteté)');
  lines.push('');
  lines.push('1. **Même modèle** (`--model`, défaut sonnet) dans les trois bras.');
  lines.push('2. **Mêmes tâches** : mêmes fixtures, même spec, mêmes fichiers seedés.');
  lines.push('3. **Même porte de passage (grader)** : `node --test <testfile>` pour les tâches SWE, scorer de patterns pour les tâches agent — code identique pour chaque bras.');
  lines.push('4. **Bras A = Claude seul** : `claude -p` cold, sans outils, sans brain (`--safe-mode`, pas de `--dangerously-skip-permissions`), fichiers collés dans le prompt. Un seul essai.');
  lines.push('5. **Bras C = Claude + Brain** : le contexte LazyBrain rappelé (`inject-context`) est ajouté au prompt — même appel, sans outils. Isole la valeur du graphe de mémoire.');
  lines.push(`6. **Bras B = ${ctx.backend} dans LazyIDE** : ${ctx.backend === 'claude'
    ? '`claude -p --dangerously-skip-permissions` dans le workdir de la tâche — la boucle Claude Code NATIVE (l\u2019intégration Claude réelle de l\u2019IDE via claudeCodeProvider). Claude Code REFUSE le format ReAct du LazyManager (garde anti role-play/prompt-injection, vérifié) : c\u2019est donc la seule façon fidèle de faire tourner Claude dans l\u2019IDE.'
    : '`dist/cli/idebench.cjs --backend deepseek --brain` — le harness IDE officiel du repo (le même qui sert aux runs DeepSWE) : VRAI runtime d\u2019outils `toolRuntime.ts`, VRAI system prompt `managedAgentPolicy.ts` (ReAct), VRAI registry — le LazyManager desktop, headless, avec le brain injecté à chaque prompt.'}`);
  lines.push(`7. **Coût mesuré pareil** : ${ctx.backend === 'deepseek'
    ? 'tokens DeepSeek facturés aux prix V4-Flash documentés (input, output, cache-hit) — même table dans les trois bras.'
    : 'somme des `total_cost_usd` renvoyés par le CLI claude dans les trois bras (aucun prix supposé).'}`);
  lines.push('8. Le brain est seedé avec les fichiers de la tâche (comme l\u2019IDE indexe le repo) et identique pour C et B.');
  lines.push('');

  if (has('a') && has('b')) {
    const bBeatsA = agg.b.solvedRate > agg.a.solvedRate;
    const cBeatsA = has('c') && agg.c.solvedRate > agg.a.solvedRate;
    if (bBeatsA) {
      lines.push('> **Conclusion :** la boucle LazyIDE (brain + outils) bat le modèle seul — l\u2019écart A→C isole le gain du graphe de contexte LazyBrain, l\u2019écart C→B le gain de l\u2019orchestration. C\u2019est la même thèse que Graft, mesurée pour LazyIDE avec la même méthode contrôlée.');
    } else if (cBeatsA) {
      lines.push('> **Conclusion :** le contexte LazyBrain injecté (bras C) bat le modèle seul — c\u2019est la valeur du graphe de mémoire. La boucle d\u2019outils (B) est au niveau du seul sur ce sous-ensemble : vérifier le budget de steps et les outils disponibles pour la creuser.');
    } else if (agg.b.solvedRate < agg.a.solvedRate) {
      lines.push('> **Conclusion :** sur ce sous-ensemble, la boucle LazyIDE est en retrait du modèle seul — les deltas C→B et A→B indiquent où investir (contexte, outils, budget de steps). Relancer avec plus de tâches pour une mesure stable.');
    } else {
      lines.push('> **Conclusion :** la boucle LazyIDE (B) est au niveau du modèle seul (A) sur ce sous-ensemble — relancer avec plus de tâches pour écarter la variance.');
    }
  } else {
    lines.push('> Pour une conclusion solide, lancer les trois bras sur le même sous-ensemble : `node bench/claude-ab.mjs` (défaut : arms a,c,b).');
  }
  return lines.join('\n');
}
