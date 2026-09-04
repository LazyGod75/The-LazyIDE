/**
 * bench/lib/agent-tasks.mjs
 * Agent task benchmark engine.
 *
 * Two modes:
 *   1. dry     — default; scores pre-existing output files if found,
 *                otherwise reports 'not-run' without failing.
 *   2. live    — opt-in via BENCH_AGENT_LIVE=1; runs a real agent via
 *                the claude CLI (requires ANTHROPIC_API_KEY).
 *
 * Scoring is purely file-based: regex pattern checks against
 * the output .mjs and test .mjs files written by the agent.
 *
 * This module does NOT import any app source; it is a standalone harness.
 */

import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dir, '../fixtures/agent-tasks.json');
const REPO_ROOT = join(__dir, '../..');

/** Resolve the real claude binary (same discovery as src/cli/lib/claude.ts). */
function resolveClaudeExe() {
  if (process.platform !== 'win32') return 'claude';
  const exe = `${process.env.APPDATA}\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  return existsSync(exe) ? exe : 'claude';
}

/**
 * Run `claude` CLI to generate output for a task.
 *
 * LIVE-MODE FIX (verified defect): the old implementation used
 * `claude --print` — a pure text-mode call with NO file-writing tools — so
 * the impl/test files were never created and every live run scored 0/3 (the
 * harness was measuring nothing). We now spawn claude in agent mode (same
 * flags as the app's own CLI, src/cli/lib/claude.ts) inside a throwaway git
 * worktree so it has real Write tools, then copy the produced files into
 * bench/agent-output for the existing scoring path to read.
 */
function runAgentForTask(task) {
  const outDir = join(REPO_ROOT, 'bench/agent-output');
  mkdirSync(outDir, { recursive: true });

  const prompt = [
    task.spec,
    `Write the implementation to: ${task.outputFile}`,
    `Write the tests to: ${task.testFile}`,
    'Use pure ESM. No external dependencies. Write both files now.',
  ].join('\n');

  const wtDir = join(REPO_ROOT, 'bench/.agent-wt');
  mkdirSync(wtDir, { recursive: true });
  const branch = `bench/agent-${Date.now()}`;

  // A fresh worktree gives the agent a clean, real workspace to write into.
  execSync(`git worktree add -b ${branch} "${wtDir}"`, {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });

  try {
    const result = spawnSync(resolveClaudeExe(), [
      '-p', prompt,
      '--model', 'sonnet',
      '--output-format', 'text',
      '--safe-mode',
      '--dangerously-skip-permissions',
    ], {
      cwd: wtDir,
      encoding: 'utf8',
      timeout: 180_000,
      env: process.env,
    });
    if (result.status !== 0) {
      throw new Error(`agent exit ${result.status}: ${(result.stderr || '').slice(0, 500)}`);
    }
  } finally {
    // Copy whatever the agent produced into the scored paths (relative to
    // the worktree root — the prompt told it to write task.outputFile which
    // is already a repo-relative path like bench/agent-output/clamp.mjs).
    for (const rel of [task.outputFile, task.testFile]) {
      const src = join(wtDir, rel.replace(/^bench\/agent-output\//, ''));
      const dst = join(REPO_ROOT, rel);
      if (existsSync(src)) {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
      }
    }
    // Remove the throwaway worktree + branch regardless of agent success.
    execSync(`git worktree remove --force "${wtDir}"`, { cwd: REPO_ROOT, stdio: 'pipe' });
    execSync(`git branch -D ${branch}`, { cwd: REPO_ROOT, stdio: 'pipe' });
  }
  return '';
}

/** Count regex occurrences in a string. */
function countMatches(text, pattern) {
  const re = new RegExp(pattern, 'gi');
  return (text.match(re) ?? []).length;
}

/** Score a single task against its checker spec. */
function scoreTask(task, implContent, testContent) {
  const checkResults = [];

  for (const check of task.scorer.checks) {
    let passed = false;
    let detail = '';

    if (check.pattern !== undefined) {
      const re = new RegExp(check.pattern, 'i');
      passed = re.test(implContent);
      detail = passed ? 'pattern found' : `pattern not found: ${check.pattern}`;
    } else if (check.patternAbsent !== undefined) {
      const re = new RegExp(check.patternAbsent, 'i');
      passed = !re.test(implContent);
      detail = passed ? 'forbidden pattern absent' : `forbidden pattern present: ${check.patternAbsent}`;
    } else if (check.testPattern !== undefined) {
      const re = new RegExp(check.testPattern, 'i');
      passed = re.test(testContent);
      detail = passed ? 'test pattern found' : `test pattern not found: ${check.testPattern}`;
    } else if (check.testMinOccurrences !== undefined) {
      const count = countMatches(testContent, check.testMinOccurrences.pattern);
      passed = count >= check.testMinOccurrences.min;
      detail = `found ${count} occurrences, need ${check.testMinOccurrences.min}`;
    }

    checkResults.push({
      id: check.id,
      description: check.description,
      passed,
      detail,
    });
  }

  const passedCount = checkResults.filter((c) => c.passed).length;
  const score = checkResults.length > 0 ? passedCount / checkResults.length : 0;

  return { checks: checkResults, score: Math.round(score * 100) / 100, passedCount, totalChecks: checkResults.length };
}

/**
 * Run the full agent task benchmark.
 * @param {object} opts
 * @param {boolean} opts.live    - call real agent CLI (default false)
 * @returns {AgentBenchResult}
 */
export async function runAgentBench({ live = false } = {}) {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const { tasks } = fixture;

  let cliAvailable = false;
  if (live) {
    try {
      execSync('claude --version', { timeout: 5_000, stdio: 'pipe' });
      cliAvailable = true;
    } catch {
      cliAvailable = false;
    }
  }

  const effectiveLive = live && cliAvailable;
  const taskResults = [];

  for (const task of tasks) {
    const t0 = Date.now();
    const implPath = join(REPO_ROOT, task.outputFile);
    const testPath = join(REPO_ROOT, task.testFile);

    let status = 'not-run';
    let agentRaw = null;
    let implContent = '';
    let testContent = '';

    if (effectiveLive) {
      status = 'agent-called';
      try {
        agentRaw = runAgentForTask(task);
        status = 'agent-done';
      } catch (err) {
        status = 'agent-error';
        agentRaw = String(err.message ?? err);
      }
    }

    // Read output files if they exist (may have been written by agent or pre-seeded)
    if (existsSync(implPath)) {
      implContent = readFileSync(implPath, 'utf8');
    }
    if (existsSync(testPath)) {
      testContent = readFileSync(testPath, 'utf8');
    }

    const hasOutput = implContent.length > 0 || testContent.length > 0;
    const scoring = hasOutput
      ? scoreTask(task, implContent, testContent)
      : { checks: [], score: 0, passedCount: 0, totalChecks: task.scorer.checks.length };

    const durationMs = Date.now() - t0;

    taskResults.push({
      id: task.id,
      title: task.title,
      status: hasOutput ? (status === 'not-run' ? 'pre-seeded' : status) : status,
      durationMs,
      hasOutput,
      implPath: task.outputFile,
      testPath: task.testFile,
      score: scoring.score,
      passedChecks: scoring.passedCount,
      totalChecks: scoring.totalChecks,
      checks: scoring.checks,
      agentRawLength: agentRaw ? agentRaw.length : null,
    });
  }

  const gradedTasks = taskResults.filter((t) => t.hasOutput);
  const avgScore = gradedTasks.length > 0
    ? gradedTasks.reduce((s, t) => s + t.score, 0) / gradedTasks.length
    : null;

  return {
    bench: 'agent-tasks',
    mode: effectiveLive ? 'live' : 'dry',
    cliAvailable,
    taskCount: tasks.length,
    gradedCount: gradedTasks.length,
    avgScore: avgScore !== null ? Math.round(avgScore * 100) / 100 : null,
    tasks: taskResults,
  };
}
