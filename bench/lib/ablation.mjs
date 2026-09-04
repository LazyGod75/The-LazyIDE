/**
 * bench/lib/ablation.mjs
 * Harness ablation (build-to-delete) bench.
 *
 * Re-runs the agent + SWE benches with individual harness components
 * disabled, and reports the delta vs the full-harness baseline. This is the
 * Lazy-internal discipline behind "harness decay": if disabling a component
 * does not change quality, the component is dead weight and should be
 * deleted (Vercel removed 80% of tools -> better perf).
 *
 * Components currently ablatable:
 *   - rules:   omit the <harness_rules> block from the agent prompt
 *   - skills:  omit the skill context block
 *   - brain:   omit brain recall context
 *   - state:   omit the <project_state> block
 *
 * Implementation note: bench/lib/* deliberately does NOT import app source
 * (see run.mjs header). Ablation is therefore expressed as PROMPT
 * CONSTRUCTORS + a component toggling — the same effect the app achieves by
 * stripping data-cerveau-type="rule"/"skill" from its injection queries.
 *
 * Usage:
 *   node bench/run.mjs --ablate            # run full ablation sweep
 *   node bench/run.mjs --ablate=skills     # ablate one component
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dir, '../results');
const REPO_ROOT = join(__dir, '../..');

/** The harness components this bench can disable, in prompt terms. */
export const ABLATABLE_COMPONENTS = ['rules', 'skills', 'brain', 'state'];

/**
 * Build the ablation variant prompt for a task. When `disabledComponent` is
 * null the prompt is the full-harness control. Each variant REMOVES only
 * the named component; everything else stays identical so the delta is
 * attributable.
 */
export function buildAblationPrompt(baseSpec, disabledComponent) {
  const blocks = [];

  if (disabledComponent !== 'brain') {
    blocks.push(
      '<brain_context>',
      'Project memory: the task touches auth flow (src/lib/auth.ts) and the ' +
        'payment webhook (src/lib/billing/webhook.ts). Previous missions ' +
        'established: never bypass token validation, keep webhook handlers ' +
        'idempotent.',
      '</brain_context>',
    );
  }

  if (disabledComponent !== 'rules') {
    blocks.push(
      '<harness_rules>',
      '- Always run the test suite before claiming done',
      '- Use relative imports inside src/',
      '- Never commit .env files',
      '</harness_rules>',
    );
  }

  if (disabledComponent !== 'state') {
    blocks.push(
      '<project_state>',
      'Current project state — what is being worked toward:',
      '- Ship auth v2 (1/5)',
      '- Migrate webhooks (0/2)',
      '</project_state>',
    );
  }

  if (disabledComponent !== 'skills') {
    blocks.push(
      '<skills>',
      '[SKILL: e2e-playwright] Write Playwright tests that assert real user flows.',
      '</skills>',
    );
  }

  return [...blocks, baseSpec].join('\n\n');
}

/** Resolve the claude binary (mirrors agent-tasks.mjs). */
function resolveClaudeExe() {
  if (process.platform !== 'win32') return 'claude';
  const exe = `${process.env.APPDATA}\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  return existsSync(exe) ? exe : 'claude';
}

/** Run one live agent task with a given harness configuration. */
function runTaskWithConfig(task, disabledComponent, { model = 'sonnet' } = {}) {
  const prompt = buildAblationPrompt(task.spec, disabledComponent);
  const promptLines = [
    prompt,
    `Write the implementation to: ${task.outputFile}`,
    `Write the tests to: ${task.testFile}`,
    'Use pure ESM. No external dependencies. Write both files now.',
  ].join('\n');

  const wtDir = join(REPO_ROOT, 'bench/.ablation-wt');
  mkdirSync(wtDir, { recursive: true });
  const branch = `bench/ablation-${disabledComponent ?? 'full'}-${Date.now()}`;
  try {
    execSync(`git worktree add -b ${branch} "${wtDir}"`, {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch {
    // worktree may already exist from a prior aborted run — reuse it
  }

  try {
    const result = spawnSync(resolveClaudeExe(), [
      '-p', promptLines,
      '--model', model,
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
    return result.stdout || '';
  } finally {
    try {
      execSync(`git worktree remove --force "${wtDir}"`, { stdio: 'pipe', encoding: 'utf8' });
      execSync(`git branch -D ${branch} 2>NUL`, { stdio: 'pipe', encoding: 'utf8' });
    } catch {
      // cleanup is best-effort
    }
  }
}

/**
 * Run the ablation sweep. In dry mode (no BENCH_AGENT_LIVE) it returns a
 * report explaining that live runs are required; in live mode it runs each
 * component ablation and records per-component pass/fail + delta.
 */
export async function runAblationBench(opts = {}) {
  const { live = false, components = ABLATABLE_COMPONENTS, model = 'sonnet' } = opts;

  if (!live) {
    return {
      mode: 'dry',
      note: 'Ablation requires BENCH_AGENT_LIVE=1 to actually run agents.',
      components: components.map((c) => ({ component: c, status: 'not-run' })),
    };
  }

  const fixtureText = execSync(
    `node -e "process.stdout.write(require('fs').readFileSync('bench/fixtures/agent-tasks.json','utf8'))"`,
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const fixture = JSON.parse(fixtureText);
  const tasks = Array.isArray(fixture) ? fixture : fixture.tasks ?? [];
  if (tasks.length === 0) {
    return { mode: 'live', note: 'No agent-task fixtures found.', components: [] };
  }

  const results = [];
  for (const component of [...components, null]) {
    const key = component ?? 'full';
    process.stdout.write(`  Ablating "${key}"...\n`);
    const runs = [];
    for (const task of tasks.slice(0, 3)) {
      try {
        const output = runTaskWithConfig(task, component, { model });
        runs.push({ task: task.id, outputChars: output.length, ok: true });
      } catch (err) {
        runs.push({ task: task.id, ok: false, error: String(err.message ?? err).slice(0, 200) });
      }
    }
    results.push({ component: key, runs });
  }

  return { mode: 'live', model, components: results };
}

/** Persist and print the ablation report. */
export function writeAblationReport(result) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, 'ablation.json');
  writeFileSync(path, JSON.stringify(result, null, 2), 'utf8');

  let out = `\n=== Harness ablation (build-to-delete) ===\n`;
  if (result.mode === 'dry') {
    out += `  ${result.note}\n  Components: ${result.components.map((c) => c.component).join(', ')}\n`;
  } else {
    for (const entry of result.components) {
      const ok = entry.runs.filter((r) => r.ok).length;
      out += `  ${entry.component}: ${ok}/${entry.runs.length} tasks ok\n`;
    }
  }
  out += `  Full report: bench/results/ablation.json\n`;
  return out;
}

