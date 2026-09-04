/**
 * bench/deepseek-run.mjs - REAL benchmark run against the DeepSeek API.
 *
 * Runs 3 agent-tasks (write impl+tests from scratch) and 3 SWE-tasks
 * (fix/refactor/create impl so seeded tests pass) against the DeepSeek API,
 * scored with the same checkers as the existing bench.
 *
 * Usage: DEEPSEEK_API_KEY=sk-... node bench/deepseek-run.mjs
 * The key is read from the environment ONLY - never hardcoded or committed.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, '..');
const WORKSPACE = join(REPO_ROOT, 'bench/ds-workspace');

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.error('[deepseek-run] DEEPSEEK_API_KEY is not set - refusing to run without a real key.');
  process.exit(1);
}

const API_URL = process.env.DEEPSEEK_API_URL ?? 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';

/** One chat completion call. Returns the assistant text. */
async function chat(system, user) {
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
      max_tokens: 4096,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeepSeek API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/** Extract fenced code blocks; falls back to the raw text. */
function extractCodeBlock(text) {
  const fence = /```(?:js|javascript|ts|typescript|mjs|json)?\s*\n([\s\S]*?)```/g;
  const blocks = [...text.matchAll(fence)].map((m) => m[1].trim());
  return blocks.length > 0 ? blocks.join('\n\n') : text.trim();
}

/** Split a response into { impl, test } by fenced code blocks. */
function splitImplTest(raw) {
  const blocks = [...raw.matchAll(/```(?:js|javascript|ts|typescript|mjs)?\s*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  return { impl: blocks[0] ?? extractCodeBlock(raw), test: blocks[1] ?? '' };
}

// â”€â”€ Agent tasks (write impl + test from scratch) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const AGENT_TASKS = [
  {
    id: 'task-pure-fn-clamp',
    spec: 'Write a pure ESM function clamp(value, min, max) that returns value clamped to [min, max]. No mutation. Export it as default. Include a passing test file that covers: value below min, value above max, value within range, min === max edge case.',
    implFile: 'clamp.mjs',
    testFile: 'clamp.test.mjs',
    checks: [
      { id: 'exports-default', pattern: 'export default' },
      { id: 'no-mutation', patternAbsent: '\\.\\w+ = [^=]' },
      { id: 'handles-below-min', testPattern: 'below|min|lower|less' },
      { id: 'handles-above-max', testPattern: 'above|max|higher|greater' },
      { id: 'handles-within-range', testPattern: 'within|range|between|inside' },
    ],
  },
  {
    id: 'task-pure-fn-groupby',
    spec: 'Write a pure ESM function groupBy(array, keyFn) that returns a new object grouping array elements by the string key returned by keyFn. No mutation of the input array. Export as default. Include a test file with at least 3 assertions.',
    implFile: 'groupBy.mjs',
    testFile: 'groupBy.test.mjs',
    checks: [
      { id: 'exports-default', pattern: 'export default' },
      { id: 'returns-object', pattern: '\\{\\}' },
      { id: 'no-input-mutation', patternAbsent: '\\.push\\(' },
      { id: 'test-assertions', testMinOccurrences: { pattern: 'assert', min: 3 } },
    ],
  },
  {
    id: 'task-pure-fn-debounce',
    spec: 'Write a pure ESM function debounce(fn, delayMs) that returns a debounced version of fn. No mutation of the input. Export as default. Include a test file with at least 3 assertions.',
    implFile: 'debounce.mjs',
    testFile: 'debounce.test.mjs',
    checks: [
      { id: 'exports-default', pattern: 'export default' },
      { id: 'uses-timeout', pattern: 'setTimeout' },
      { id: 'test-assertions', testMinOccurrences: { pattern: 'assert', min: 3 } },
    ],
  },
];

/** Regex-based scoring (same semantics as bench/lib/agent-tasks.mjs). */
function scoreAgentTask(task, impl, test) {
  const results = [];
  for (const check of task.checks) {
    let passed = false;
    let detail = '';
    if (check.pattern !== undefined) {
      passed = new RegExp(check.pattern, 'i').test(impl);
      detail = passed ? 'pattern found' : `pattern not found: ${check.pattern}`;
    } else if (check.patternAbsent !== undefined) {
      passed = !new RegExp(check.patternAbsent, 'i').test(impl);
      detail = passed ? 'forbidden absent' : `forbidden present: ${check.patternAbsent}`;
    } else if (check.testPattern !== undefined) {
      passed = new RegExp(check.testPattern, 'i').test(test);
      detail = passed ? 'test pattern found' : `test pattern not found: ${check.testPattern}`;
    } else if (check.testMinOccurrences !== undefined) {
      const count = (test.match(new RegExp(check.testMinOccurrences.pattern, 'gi')) ?? []).length;
      passed = count >= check.testMinOccurrences.min;
      detail = `found ${count}, need ${check.testMinOccurrences.min}`;
    }
    results.push({ id: check.id, passed, detail });
  }
  const passedCount = results.filter((r) => r.passed).length;
  return { results, passedCount, total: results.length, score: results.length ? passedCount / results.length : 0 };
}

async function runAgentTasks() {
  console.log('\n=== AGENT TASKS (DeepSeek writes impl + tests) ===\n');
  const out = [];
  for (const task of AGENT_TASKS) {
    const t0 = Date.now();
    const user = [
      task.spec,
      `Write the implementation to ${task.implFile} and the tests to ${task.testFile}.`,
      'Reply with ONLY the two files as fenced code blocks (```mjs ... ```), implementation first, tests second. No explanation.',
    ].join('\n');
    try {
      const raw = await chat(
        'You are a senior JavaScript engineer. Write correct, complete ESM code. Never include prose outside code fences.',
        user,
      );
      const { impl, test } = splitImplTest(raw);
      const { score, passedCount, total } = scoreAgentTask(task, impl, test);
      out.push({ id: task.id, score, passedCount, total, durationMs: Date.now() - t0 });
      console.log(`[${task.id}] score ${passedCount}/${total} (${Math.round(score * 100)}%) - ${Date.now() - t0}ms`);
      mkdirSync(join(WORKSPACE, 'agent'), { recursive: true });
      writeFileSync(join(WORKSPACE, 'agent', task.implFile), impl, 'utf8');
      writeFileSync(join(WORKSPACE, 'agent', task.testFile), test, 'utf8');
    } catch (err) {
      out.push({ id: task.id, score: 0, error: err.message, durationMs: Date.now() - t0 });
      console.error(`[${task.id}] ERROR: ${err.message}`);
    }
  }
  const graded = out.filter((o) => o.error === undefined);
  const avg = graded.length ? graded.reduce((s, o) => s + o.score, 0) / graded.length : 0;
  console.log(`\nAgent tasks: ${graded.length}/${out.length} graded - avg score ${(avg * 100).toFixed(0)}%`);
  return { out, avg, graded: graded.length };
}

// â”€â”€ SWE tasks (modify/create impl so seeded tests pass) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const SWE_TASKS = [
  {
    id: 'swe-bugfix-debounce',
    spec: 'The debounce function in debounce.mjs has a bug: it fires fn immediately on first call instead of waiting delayMs. Fix it so that fn only fires after delayMs of silence. The timer must be cleared on each call. Do not change the test file.',
    setupFiles: [
      { path: 'debounce.mjs', content: 'export default function debounce(fn, delayMs) {\n  let timer;\n  return function (...args) {\n    fn(...args);  // BUG: fires immediately\n    timer = setTimeout(() => {}, delayMs);\n  };\n}\n' },
      { path: 'debounce.test.mjs', content: "import assert from 'node:assert';\nimport { test } from 'node:test';\nimport debounce from './debounce.mjs';\n\ntest('fn does not fire immediately', () => {\n  let calls = 0;\n  const d = debounce(() => calls++, 50);\n  d();\n  assert.strictEqual(calls, 0);\n});\n\ntest('fn fires after delay', async () => {\n  let calls = 0;\n  const d = debounce(() => calls++, 50);\n  d();\n  await new Promise(r => setTimeout(r, 80));\n  assert.strictEqual(calls, 1);\n});\n\ntest('fn does not fire if called again within delay', async () => {\n  let calls = 0;\n  const d = debounce(() => calls++, 50);\n  d();\n  await new Promise(r => setTimeout(r, 30));\n  d();\n  await new Promise(r => setTimeout(r, 30));\n  assert.strictEqual(calls, 0);\n  await new Promise(r => setTimeout(r, 30));\n  assert.strictEqual(calls, 1);\n});\n" },
    ],
    testCommand: 'node --test debounce.test.mjs',
    implFile: 'debounce.mjs',
    checks: [
      { id: 'test-passes', testPasses: true },
      { id: 'uses-clearTimeout', pattern: 'clearTimeout' },
    ],
  },
  {
    id: 'swe-refactor-callback-to-async',
    spec: 'Refactor fetchData in api.mjs from callback style to async/await. The function should return a Promise that resolves with the data. Remove the callback parameter. Keep the same URL and error handling behavior. Do not change the test file.',
    setupFiles: [
      { path: 'api.mjs', content: "// Callback-based fetchData - refactor to async/await\nexport function fetchData(url, callback) {\n  setTimeout(() => {\n    if (url.includes('error')) {\n      callback(new Error('Network error'), null);\n    } else {\n      callback(null, { url, data: 'response-' + url });\n    }\n  }, 10);\n}\n" },
      { path: 'api.test.mjs', content: "import assert from 'node:assert';\nimport { test } from 'node:test';\nimport { fetchData } from './api.mjs';\n\ntest('fetchData returns a Promise', () => {\n  const result = fetchData('https://api.example.com/users');\n  assert.ok(result instanceof Promise);\n});\n\ntest('fetchData resolves with data', async () => {\n  const result = await fetchData('https://api.example.com/users');\n  assert.deepStrictEqual(result, { url: 'https://api.example.com/users', data: 'response-https://api.example.com/users' });\n});\n\ntest('fetchData rejects on error URL', async () => {\n  await assert.rejects(() => fetchData('https://api.example.com/error'), /Network error/);\n});\n\ntest('fetchData has no callback parameter', () => {\n  assert.strictEqual(fetchData.length, 1);\n});\n" },
    ],
    testCommand: 'node --test api.test.mjs',
    implFile: 'api.mjs',
    checks: [
      { id: 'test-passes', testPasses: true },
      { id: 'returns-promise', pattern: 'async|Promise' },
      { id: 'no-callback-param', patternAbsent: 'callback' },
    ],
  },
  {
    id: 'swe-greenfield-queue',
    spec: 'Implement a simple FIFO queue in queue.mjs. Export class Queue with methods enqueue(item), dequeue() (returns undefined when empty), and size(). No external dependencies. Do not change the test file.',
    setupFiles: [
      { path: 'queue.test.mjs', content: "import assert from 'node:assert';\nimport { test } from 'node:test';\nimport { Queue } from './queue.mjs';\n\ntest('starts empty', () => {\n  const q = new Queue();\n  assert.strictEqual(q.size(), 0);\n});\n\ntest('enqueue then dequeue FIFO', () => {\n  const q = new Queue();\n  q.enqueue(1); q.enqueue(2); q.enqueue(3);\n  assert.strictEqual(q.dequeue(), 1);\n  assert.strictEqual(q.dequeue(), 2);\n  assert.strictEqual(q.dequeue(), 3);\n});\n\ntest('dequeue empty returns undefined', () => {\n  const q = new Queue();\n  assert.strictEqual(q.dequeue(), undefined);\n});\n\ntest('size tracks items', () => {\n  const q = new Queue();\n  q.enqueue('a'); q.enqueue('b');\n  assert.strictEqual(q.size(), 2);\n  q.dequeue();\n  assert.strictEqual(q.size(), 1);\n});\n" },
    ],
    testCommand: 'node --test queue.test.mjs',
    implFile: 'queue.mjs',
    checks: [
      { id: 'test-passes', testPasses: true },
      { id: 'exports-queue', pattern: 'export class Queue|export default' },
    ],
  },
];

function scoreSweTask(task, impl, testPassed) {
  const results = [];
  for (const check of task.checks) {
    let passed = false;
    let detail = '';
    if (check.testPasses !== undefined) {
      passed = testPassed;
      detail = testPassed ? 'tests pass' : 'tests fail';
    } else if (check.pattern !== undefined) {
      passed = new RegExp(check.pattern, 'i').test(impl);
      detail = passed ? 'pattern found' : `pattern not found: ${check.pattern}`;
    } else if (check.patternAbsent !== undefined) {
      passed = !new RegExp(check.patternAbsent, 'i').test(impl);
      detail = passed ? 'forbidden absent' : `forbidden present: ${check.patternAbsent}`;
    }
    results.push({ id: check.id, passed, detail });
  }
  const passedCount = results.filter((r) => r.passed).length;
  return { results, passedCount, total: results.length, score: results.length ? passedCount / results.length : 0 };
}

async function runSweTasks() {
  console.log('\n=== SWE TASKS (DeepSeek fixes/refactors/creates impl, agent loop) ===\n');
  const out = [];
  for (const task of SWE_TASKS) {
    const t0 = Date.now();
    const dir = join(WORKSPACE, 'swe', task.id);
    mkdirSync(dir, { recursive: true });
    for (const f of task.setupFiles) writeFileSync(join(dir, f.path), f.content, 'utf8');

    const testFileName = task.setupFiles.find((f) => f.path.endsWith('.test.mjs'))?.path;
    const existingImpl = task.setupFiles.find((f) => f.path === task.implFile);
    const basePrompt = [
      task.spec,
      `The test file is already at ${testFileName} - do NOT modify it.`,
      existingImpl
        ? `The current implementation at ${task.implFile} is:\n\`\`\`mjs\n${existingImpl.content}\n\`\`\`\nModify it to satisfy the spec AND the tests. Preserve the existing behavior/mock semantics (e.g. the setTimeout mock) unless the spec explicitly changes it. Do NOT introduce real network calls or new dependencies.`
        : `Write your implementation to ${task.implFile}.`,
      'Reply with ONLY the implementation file as one fenced code block (```mjs ... ```). No explanation.',
    ].join('\n');

    // AGENT LOOP (the honest measure of an orchestrator's value): single-shot
    // prompts measure the raw model; a real agent runs the tests and feeds
    // failures back. Max 3 attempts - same bounded-retry philosophy as Lazy's
    // own loopSupervision.
    let impl = '';
    let testPassed = false;
    let testOutput = '';
    let attempts = 0;
    const MAX_ATTEMPTS = 3;
    try {
      while (attempts < MAX_ATTEMPTS) {
        attempts += 1;
        const feedback = attempts === 1
          ? ''
          : `\n\nYour previous implementation FAILED the tests with this output:\n${testOutput.slice(0, 1200)}\nFix the implementation and reply with the corrected file only.`;
        const raw = await chat(
          'You are a senior JavaScript engineer. Write correct, complete ESM code. Never include prose outside code fences.',
          basePrompt + feedback,
        );
        impl = extractCodeBlock(raw);
        writeFileSync(join(dir, task.implFile), impl, 'utf8');

        try {
          testOutput = execSync(task.testCommand, { cwd: dir, encoding: 'utf8', timeout: 30_000, stdio: 'pipe' });
          testPassed = true;
          break;
        } catch (err) {
          testOutput = String(err.stdout ?? err.stderr ?? err.message).slice(0, 400);
          if (attempts >= MAX_ATTEMPTS) break;
        }
      }

      const { score, passedCount, total } = scoreSweTask(task, impl, testPassed);
      out.push({ id: task.id, score, passedCount, total, testPassed, attempts, durationMs: Date.now() - t0 });
      console.log(`[${task.id}] score ${passedCount}/${total} (${Math.round(score * 100)}%) - tests ${testPassed ? 'PASS' : 'FAIL'} - attempts ${attempts} - ${Date.now() - t0}ms`);
      if (!testPassed) console.log(`    test output: ${testOutput.slice(0, 200).replace(/\n/g, ' ')}`);
    } catch (err) {
      out.push({ id: task.id, score: 0, error: err.message, durationMs: Date.now() - t0 });
      console.error(`[${task.id}] ERROR: ${err.message}`);
    }
  }
  const graded = out.filter((o) => o.error === undefined);
  const avg = graded.length ? graded.reduce((s, o) => s + o.score, 0) / graded.length : 0;
  console.log(`\nSWE tasks: ${graded.length}/${out.length} graded - avg score ${(avg * 100).toFixed(0)}%`);
  return { out, avg, graded: graded.length };
}

// â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function main() {
  console.log(`[deepseek-run] model=${MODEL} api=${API_URL}`);
  mkdirSync(WORKSPACE, { recursive: true });
  const agent = await runAgentTasks();
  const swe = await runSweTasks();

  const all = [...agent.out, ...swe.out].filter((o) => o.error === undefined);
  const overall = all.length ? all.reduce((s, o) => s + o.score, 0) / all.length : 0;
  console.log('\n==============================================');
  console.log('  DEEPSEEK BENCHMARK SUMMARY');
  console.log('==============================================');
  console.log(`  model               : ${MODEL}`);
  console.log(`  agent tasks graded  : ${agent.graded}/3 (avg ${(agent.avg * 100).toFixed(0)}%)`);
  console.log(`  SWE tasks graded    : ${swe.graded}/3 (avg ${(swe.avg * 100).toFixed(0)}%)`);
  console.log(`  overall avg score   : ${(overall * 100).toFixed(0)}%`);
  console.log('==============================================');
}

main().catch((err) => {
  console.error('[deepseek-run] fatal:', err);
  process.exit(1);
});
