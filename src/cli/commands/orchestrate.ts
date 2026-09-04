/**
 * `lazy orchestrate "<task>"` command — LazyManager-style orchestration.
 *
 * The founder's directive: the CLI must behave like the LazyManager (scan
 * the repo, plan, execute steps with verification, then merge) or
 * benchmarking it proves nothing about the product. This command runs the
 * SAME cycle the desktop manager runs, headless:
 *
 *   1. Create a git worktree (isolated, like the app's agent worktrees).
 *   2. SCAN the repo (real structure/package.json/README/code) — the manager
 *      measures the terrain before sizing, never guesses.
 *   3. PLAN the task into ordered steps with verification commands (the
 *      model's generate_plan equivalent).
 *   4. EXECUTE each step through the model with the scanned context, then
 *      VERIFY with the step's real command (tests/build), feeding failures
 *      back with bounded retries (the judge loop equivalent).
 *   5. On full success: commit + merge into the current branch (local-only
 *      friendly — a repo with no remote merges locally and says so).
 *      On any failed step: leave the worktree for review, never fake a pass.
 *
 * Backend: DeepSeek via DEEPSEEK_API_KEY (spares the Claude subscription);
 * same code path as the app's managed provider (OpenAI-compatible).
 */

import process from 'node:process';
import { type Command } from 'commander';
import { resolveBrainPath } from '../lib/paths.js';
import { ensureBrainInit, brainStoreHtml } from '../lib/brain.js';
import { createWorktree, mergeWorktree } from '../lib/git.js';
import { buildNeuronHtml } from '../lib/neuron.js';
import { runOrchestratedMission } from '../lib/orchestrator.js';

export function registerOrchestrate(program: Command): void {
  program
    .command('orchestrate <task>')
    .description('Run a LazyManager-style orchestrated mission (scan -> plan -> steps -> verify -> merge) in an isolated git worktree')
    .option('--max-steps <n>', 'Max plan steps', '8')
    .option('--max-attempts <n>', 'Max attempts per step', '3')
    .option('--no-apply', 'Leave the worktree for review instead of merging on success')
    .action(async (task: string, opts: { maxSteps: string; maxAttempts: string; apply: boolean }) => {
      const cwd = process.cwd();
      const brainPath = resolveBrainPath(cwd);

      try {
        ensureBrainInit(brainPath);
      } catch (err: unknown) {
        process.stderr.write(`[brain] init warning: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      // 1. Worktree (same isolation as the app's agent worktrees).
      const ts = Date.now();
      const branch = `lazy/orch-${ts}`;
      let worktreePath: string;
      try {
        process.stderr.write(`[orchestrate] Creating worktree on branch ${branch}...\n`);
        worktreePath = createWorktree(cwd, branch);
        process.stderr.write(`[orchestrate] Worktree: ${worktreePath}\n`);
      } catch (err: unknown) {
        process.stderr.write(`[orchestrate] Failed to create worktree: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
        return;
      }

      // 2-4. SCAN -> PLAN -> EXECUTE/VERIFY (the LazyManager cycle).
      let result;
      try {
        result = await runOrchestratedMission({
          worktreePath,
          task,
          maxSteps: Number(opts.maxSteps) || 8,
          maxAttemptsPerStep: Number(opts.maxAttempts) || 3,
        });
      } catch (err: unknown) {
        process.stderr.write(`[orchestrate] Mission error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.stderr.write(`[orchestrate] Worktree left for review at: ${worktreePath}\n`);
        process.exit(1);
        return;
      }

      // 5. Report each step honestly.
      for (const step of result.steps) {
        const mark = step.status === 'passed' ? 'PASS' : 'FAIL';
        process.stderr.write(`[orchestrate]   [${mark}] ${step.id} ${step.title} (${step.attempts} attempt(s))\n`);
        if (step.status === 'failed' && step.error) {
          process.stderr.write(`[orchestrate]       ${step.error.slice(0, 300).replace(/\n/g, ' ')}\n`);
        }
      }

      if (!result.ok) {
        process.stderr.write(`[orchestrate] Mission FAILED — worktree left for review at: ${worktreePath}\n`);
        process.stderr.write(`[orchestrate] Branch: ${branch}\n`);
        process.exit(1);
        return;
      }

      if (!opts.apply) {
        process.stderr.write(`[orchestrate] All steps passed — worktree left for review (--no-apply).\n`);
        process.stderr.write(`[orchestrate] Branch: ${branch}\n`);
        return;
      }

      // Merge on verified success (same gate semantics as approveMission).
      try {
        process.stderr.write(`[orchestrate] All steps passed — merging ${branch} into current branch...\n`);
        mergeWorktree(cwd, branch);
        process.stderr.write(`[orchestrate] Merge complete.\n`);
      } catch (err: unknown) {
        process.stderr.write(`[orchestrate] Merge failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
        return;
      }

      // Capture the mission outcome into the brain (like the app's capture).
      try {
        const html = buildNeuronHtml({
          kind: 'agent',
          title: `Orchestrated mission: ${task.slice(0, 60)}`,
          text: `Task: ${task}\n\nPlan:\n${result.planText.slice(0, 1200)}\n\nSteps: ${result.steps.map((s) => `${s.id}:${s.status}`).join(', ')}\nSummary: ${result.summary}`,
          tags: ['cli', 'orchestrate', 'lazy-cli', 'plan'],
          source: 'lazy-cli:orchestrate',
        });
        brainStoreHtml(brainPath, html);
      } catch (err: unknown) {
        process.stderr.write(`[brain] store warning: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    });
}
