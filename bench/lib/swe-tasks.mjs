/**
 * bench/lib/swe-tasks.mjs
 * SWE-bench-like task scoring engine.
 *
 * Modes:
 *   1. dry (default) — writes setup files, runs tests on existing impl, scores
 *   2. live — calls an agent (claude CLI) to generate the fix/impl, then runs tests
 *
 * Scoring:
 *   - test-run: executes `node --test <testFile>` and checks exit code 0
 *   - pattern checks: regex on the implementation file
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dir, '../fixtures/swe-tasks.json');
const REPO_ROOT = join(__dir, '../..');
const WORKSPACE = join(REPO_ROOT, 'bench/swe-workspace');

/** Resolve the real claude binary (same discovery as src/cli/lib/claude.ts). */
function resolveClaudeExe() {
  if (process.platform !== 'win32') return 'claude';
  const exe = `${process.env.APPDATA}\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  return existsSync(exe) ? exe : 'claude';
}

/**
 * Run a real agent to produce the implementation.
 *
 * LIVE-MODE FIX (verified defect): the old implementation used
 * `claude --print` — a pure text-mode call with NO file-editing tools — so
 * the impl file was never modified and every live run scored 0/3 (the
 * harness was measuring nothing). We now spawn claude in agent mode (same
 * flags as the app's own CLI, src/cli/lib/claude.ts) inside a throwaway git
 * worktree where the setup files already exist, then copy the produced impl
 * back into bench/swe-workspace for the existing test/scoring path to use.
 */
function runAgentForTask(task) {
  const implPath = join(REPO_ROOT, task.implFile);
  const testPath = join(REPO_ROOT, task.testFile);

  const prompt = [
    task.spec,
    `The test file is already at ${testPath} — do NOT modify it.`,
    `Write your implementation to ${implPath}.`,
    'Use pure ESM. No external dependencies.',
  ].join('\n');

  // Throwaway worktree seeded with the SAME setup files (tests + buggy impl)
  // so the agent edits a real file with its real Write/Edit tools.
  const wtDir = join(REPO_ROOT, 'bench/.swe-wt');
  mkdirSync(wtDir, { recursive: true });
  const branch = `bench/swe-${Date.now()}`;
  execSync(`git worktree add -b ${branch} "${wtDir}"`, {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });

  try {
    // Seed the worktree with the same setup files the scoring path uses.
    for (const file of task.setupFiles ?? []) {
      const rel = file.path.replace(/^bench\/swe-workspace\//, '');
      const dst = join(wtDir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, file.content, 'utf8');
    }

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
    // Copy the agent's modified impl back into the scored location.
    const wtImpl = join(wtDir, task.implFile.replace(/^bench\/swe-workspace\//, ''));
    if (existsSync(wtImpl)) {
      mkdirSync(dirname(implPath), { recursive: true });
      copyFileSync(wtImpl, implPath);
    }
    // Remove the throwaway worktree + branch regardless of agent success.
    execSync(`git worktree remove --force "${wtDir}"`, { cwd: REPO_ROOT, stdio: 'pipe' });
    execSync(`git branch -D ${branch}`, { cwd: REPO_ROOT, stdio: 'pipe' });
  }
  return '';
}

function countMatches(text, pattern) {
  const re = new RegExp(pattern, 'gi');
  return (text.match(re) ?? []).length;
}

function scoreTask(task, implContent, testPassed) {
  const checks = [];

  for (const check of task.scoring.checks) {
    let passed = false;
    let detail = '';

    if (check.id === 'test-passes') {
      passed = testPassed;
      detail = passed ? 'all tests passed' : 'tests failed or errored';
    } else if (check.pattern !== undefined) {
      const re = new RegExp(check.pattern, 'i');
      passed = re.test(implContent);
      detail = passed ? 'pattern found' : `pattern not found: ${check.pattern}`;
    } else if (check.patternAbsent !== undefined) {
      const re = new RegExp(check.patternAbsent, 'i');
      passed = !re.test(implContent);
      detail = passed ? 'forbidden pattern absent' : `forbidden pattern present: ${check.patternAbsent}`;
    }

    checks.push({ id: check.id, description: check.description, passed, detail });
  }

  const passedCount = checks.filter((c) => c.passed).length;
  const score = checks.length > 0 ? passedCount / checks.length : 0;

  return {
    checks,
    score: Math.round(score * 100) / 100,
    passedCount,
    totalChecks: checks.length,
    testPassed,
  };
}

function runTests(task) {
  try {
    const result = execSync(task.testCommand, {
      timeout: 30_000,
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdio: 'pipe',
    });
    return { passed: true, output: result };
  } catch (err) {
    return { passed: false, output: err.stdout ?? err.stderr ?? String(err) };
  }
}

export async function runSweBench({ live = false } = {}) {
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

  // Clean and recreate workspace
  if (existsSync(WORKSPACE)) {
    rmSync(WORKSPACE, { recursive: true, force: true });
  }
  mkdirSync(WORKSPACE, { recursive: true });

  for (const task of tasks) {
    const t0 = Date.now();

    // Write setup files (tests + initial impl if provided)
    for (const file of task.setupFiles ?? []) {
      const filePath = join(REPO_ROOT, file.path);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, file.content, 'utf8');
    }

    let status = 'setup-written';
    let agentRaw = null;

    // If live, call agent to generate implementation
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

    // Read implementation file
    const implPath = join(REPO_ROOT, task.implFile);
    let implContent = '';
    if (existsSync(implPath)) {
      implContent = readFileSync(implPath, 'utf8');
    }

    // Run tests if implementation exists
    let testResult = { passed: false, output: 'no implementation' };
    if (implContent.length > 0) {
      testResult = runTests(task);
      status = testResult.passed ? 'tests-passed' : 'tests-failed';
    } else if (status === 'setup-written') {
      status = 'no-impl';
    }

    const scoring = scoreTask(task, implContent, testResult.passed);
    const durationMs = Date.now() - t0;

    taskResults.push({
      id: task.id,
      title: task.title,
      category: task.category,
      difficulty: task.difficulty,
      status,
      durationMs,
      hasImpl: implContent.length > 0,
      testPassed: testResult.passed,
      testOutput: testResult.output?.substring(0, 500),
      score: scoring.score,
      passedChecks: scoring.passedCount,
      totalChecks: scoring.totalChecks,
      checks: scoring.checks,
      agentRawLength: agentRaw ? agentRaw.length : null,
    });
  }

  const gradedTasks = taskResults.filter((t) => t.hasImpl);
  const passedTasks = taskResults.filter((t) => t.testPassed);
  const avgScore = gradedTasks.length > 0
    ? gradedTasks.reduce((s, t) => s + t.score, 0) / gradedTasks.length
    : null;

  return {
    bench: 'swe-tasks',
    mode: effectiveLive ? 'live' : 'dry',
    cliAvailable,
    taskCount: tasks.length,
    gradedCount: gradedTasks.length,
    passedCount: passedTasks.length,
    passRate: tasks.length > 0 ? Math.round((passedTasks.length / tasks.length) * 100) / 100 : 0,
    avgScore: avgScore !== null ? Math.round(avgScore * 100) / 100 : null,
    tasks: taskResults,
  };
}
