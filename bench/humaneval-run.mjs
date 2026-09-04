/**
 * bench/humaneval-run.mjs â€” FULL HumanEval benchmark (164 problems).
 *
 * The complete, official OpenAI HumanEval dataset (164 Python problems) is
 * fetched from HuggingFace, each problem is solved by:
 *   1. BASELINE: DeepSeek single-shot (one prompt, no verification feedback)
 *   2. LAZY:     DeepSeek orchestrated (up to 3 attempts with real test
 *                failure feedback â€” the LazyManager loop)
 * Solutions are executed against the OFFICIAL test harness (check(candidate)
 * pattern) with the real Python interpreter. pass@1 is reported for both,
 * plus token usage and cost (DeepSeek pricing).
 *
 * Usage: DEEPSEEK_API_KEY=sk-... node bench/humaneval-run.mjs
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, '..');
const WORKSPACE = join(REPO_ROOT, 'bench/humaneval-ws');

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.error('[humaneval] DEEPSEEK_API_KEY is not set - refusing to run without a real key.');
  process.exit(1);
}
const API_URL = process.env.DEEPSEEK_API_URL ?? 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
const HUMANEVAL_URL = process.env.HUMANEVAL_URL ?? 'https://datasets-server.huggingface.co/rows?dataset=openai_humaneval&config=default&split=test&offset=0&length=164';
const HUMANEVAL_FILE = join(REPO_ROOT, 'bench/humaneval.jsonl');

// DeepSeek V4-flash pricing (per 1M tokens): input cache-miss $0.14, output $0.28
const PRICE_INPUT_PER_M = 0.14;
const PRICE_OUTPUT_PER_M = 0.28;

let totalTokens = { baseline: { in: 0, out: 0 }, lazy: { in: 0, out: 0 } };

async function chat(system, user, maxTokens = 4096) {
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
    throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const usage = data.usage;
  return { text: data.choices?.[0]?.message?.content ?? '', usage };
}

function extractCode(raw) {
  const fence = /```(?:python|py)?\s*\n([\s\S]*?)```/g;
  const blocks = [...raw.matchAll(fence)].map((m) => m[1].trim());
  return blocks.length > 0 ? blocks[0] : raw.trim();
}

/** Run the official HumanEval test harness for one problem. */
function runProblemTest(problem, solution) {
  const dir = join(WORKSPACE, 'run');
  mkdirSync(dir, { recursive: true });
  const testCode = [problem.prompt, solution, '', problem.test, '', `check(${problem.entry_point})`].join('\n');
  const file = join(dir, 'test_problem.py');
  writeFileSync(file, testCode, 'utf8');
  try {
    const out = execSync(`python "${file}"`, { cwd: dir, encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
    return { passed: true, output: out };
  } catch (err) {
    return { passed: false, output: String(err.stdout ?? '').slice(0, 600) + String(err.stderr ?? '').slice(0, 400) };
  }
}

// â”€â”€ BASELINE: single-shot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function baselineSolve(problem) {
  const system = 'You are a Python expert. Write ONLY the function implementation requested, as one fenced python code block. No explanation, no tests, no main block.';
  const user = `Complete the following Python function according to its docstring. Output ONLY the code in a fenced block:\n\n${problem.prompt}`;
  const { text, usage } = await chat(system, user);
  totalTokens.baseline.in += usage?.prompt_tokens ?? 0;
  totalTokens.baseline.out += usage?.completion_tokens ?? 0;
  return extractCode(text);
}

// â”€â”€ LAZY: orchestrated with test feedback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function lazySolve(problem, maxAttempts = 3) {
  const system = 'You are a Python expert fixing/implementing a function. Output ONLY the function implementation as a fenced python block.';
  let result = { passed: false, output: '' };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const feedback = attempt === 1
      ? ''
      : `\n\nYour previous attempt FAILED the test with this error output:\n${result.output.slice(0, 1000)}\nFix the root cause and output the corrected function only.`;
    const user = `Complete the following Python function so it passes its test. Output ONLY the code:\n\n${problem.prompt}${feedback}`;
    const { text, usage } = await chat(system, user);
    totalTokens.lazy.in += usage?.prompt_tokens ?? 0;
    totalTokens.lazy.out += usage?.completion_tokens ?? 0;
    const solution = extractCode(text);
    result = runProblemTest(problem, solution);
    if (result.passed) break;
  }
  return result;
}

// â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function fetchDataset() {
  // Prefer the local official dataset file (bench/humaneval.jsonl, 164 problems).
  if (existsSync(HUMANEVAL_FILE)) {
    const lines = readFileSync(HUMANEVAL_FILE, 'utf8').split('\n').filter((l) => l.trim());
    console.log(`[humaneval] Loaded local official dataset: ${lines.length} problems`);
    return lines.map((l) => JSON.parse(l));
  }
  console.log(`[humaneval] Fetching full HumanEval dataset from HuggingFace...`);
  const res = await fetch(HUMANEVAL_URL);
  if (!res.ok) throw new Error(`HuggingFace ${res.status}`);
  const data = await res.json();
  const rows = data.rows ?? [];
  if (rows.length < 150) {
    throw new Error(`Expected ~164 problems, got ${rows.length} - dataset fetch incomplete`);
  }
  return rows.map((r) => r.row);
}

async function main() {
  console.log(`[humaneval] model=${MODEL}`);
  mkdirSync(WORKSPACE, { recursive: true });
  rmSync(join(WORKSPACE, 'run'), { recursive: true, force: true });

  const problems = await fetchDataset();
  console.log(`[humaneval] Dataset: ${problems.length} problems (FULL)`);

  const results = [];
  const t0 = Date.now();
  for (let i = 0; i < problems.length; i++) {
    const p = problems[i];
    const id = p.task_id ?? `problem-${i}`;
    let bPassed = false;
    try {
      const sol = await baselineSolve(p);
      bPassed = runProblemTest(p, sol).passed;
    } catch (e) {
      console.error(`[${id}] baseline error: ${e.message}`);
    }
    let lPassed = false;
    try {
      lPassed = (await lazySolve(p)).passed;
    } catch (e) {
      console.error(`[${id}] lazy error: ${e.message}`);
    }
    results.push({ id, baseline: bPassed, lazy: lPassed });
    if ((i + 1) % 10 === 0 || i === problems.length - 1) {
      const b = results.filter((r) => r.baseline).length;
      const l = results.filter((r) => r.lazy).length;
      console.log(`[humaneval] ${i + 1}/${problems.length} - baseline ${b} (${Math.round((b / (i + 1)) * 100)}%) | lazy ${l} (${Math.round((l / (i + 1)) * 100)}%) | ${Date.now() - t0}ms`);
    }
  }

  const bCount = results.filter((r) => r.baseline).length;
  const lCount = results.filter((r) => r.lazy).length;
  const bPct = Math.round((bCount / results.length) * 1000) / 10;
  const lPct = Math.round((lCount / results.length) * 1000) / 10;

  const bCost = (totalTokens.baseline.in / 1e6) * PRICE_INPUT_PER_M + (totalTokens.baseline.out / 1e6) * PRICE_OUTPUT_PER_M;
  const lCost = (totalTokens.lazy.in / 1e6) * PRICE_INPUT_PER_M + (totalTokens.lazy.out / 1e6) * PRICE_OUTPUT_PER_M;

  console.log('\n==============================================');
  console.log('  HUMANEVAL FULL BENCHMARK (164 problems)');
  console.log('==============================================');
  console.log(`  baseline (DeepSeek solo): ${bCount}/${results.length} = ${bPct}%`);
  console.log(`  Lazy orchestrated:        ${lCount}/${results.length} = ${lPct}%`);
  console.log(`  Lazy added value:         +${(lPct - bPct).toFixed(1)} points`);
  console.log('  --- tokens & cost ---');
  console.log(`  baseline: ${totalTokens.baseline.in.toLocaleString()} in / ${totalTokens.baseline.out.toLocaleString()} out = $${bCost.toFixed(4)}`);
  console.log(`  lazy:     ${totalTokens.lazy.in.toLocaleString()} in / ${totalTokens.lazy.out.toLocaleString()} out = $${lCost.toFixed(4)}`);
  console.log('==============================================');

  const out = {
    benchmark: 'humaneval-full',
    model: MODEL,
    problems: results.length,
    baseline: { passed: bCount, pct: bPct, tokens: totalTokens.baseline, costUsd: bCost },
    lazy: { passed: lCount, pct: lPct, tokens: totalTokens.lazy, costUsd: lCost },
    results,
  };
  writeFileSync(join(REPO_ROOT, 'bench/results/humaneval-latest.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('Results written to bench/results/humaneval-latest.json');
}

main().catch((e) => {
  console.error('[humaneval] fatal:', e);
  process.exit(1);
});
