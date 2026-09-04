/**
 * `lazy agent "<task>"` command.
 *
 * 1. Create a git worktree: <cwd>/.lazy/worktrees/lazy-cli-<ts>
 * 2. Run `claude -p "<task>" --model <model> --dangerously-skip-permissions`
 *    with cwd=worktree, streaming actions to stdout.
 * 3. Show diff of the worktree vs HEAD.
 * 4. With --apply: commit + merge + remove worktree.
 *    Without --apply: leave worktree in place, print path for review.
 * 5. Capture an agent neuron into the brain.
 */

import process from 'node:process';
import { type Command } from 'commander';
import { resolveBrainPath } from '../lib/paths.js';
import { ensureBrainInit, brainStoreHtml } from '../lib/brain.js';
import { spawnClaude } from '../lib/claude.js';
import { createWorktree, worktreeDiff, mergeWorktree } from '../lib/git.js';
import { buildNeuronHtml } from '../lib/neuron.js';

export function registerAgent(program: Command): void {
  program
    .command('agent <task>')
    .description('Run an autonomous Claude agent in an isolated git worktree')
    .option('--model <model>', 'Claude model alias (haiku/sonnet/opus)', 'haiku')
    .option('--apply', 'Commit and merge the worktree into current branch after agent completes')
    .action(async (task: string, opts: { model: string; apply: boolean }) => {
      const cwd = process.cwd();
      const brainPath = resolveBrainPath(cwd);

      // Ensure brain
      try {
        ensureBrainInit(brainPath);
      } catch (err: unknown) {
        process.stderr.write(`[brain] init warning: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      // 1. Create worktree
      const ts = Date.now();
      const branch = `lazy/cli-${ts}`;

      let worktreePath: string;
      try {
        process.stderr.write(`[agent] Creating worktree on branch ${branch}...\n`);
        worktreePath = createWorktree(cwd, branch);
        process.stderr.write(`[agent] Worktree created: ${worktreePath}\n`);
      } catch (err: unknown) {
        process.stderr.write(`[agent] Failed to create worktree: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
        return;
      }

      // 2. Run agent in worktree
      process.stderr.write(`[agent] Starting Claude agent (model=${opts.model})...\n`);
      process.stderr.write(`[agent] Task: ${task}\n\n`);

      // Wrap task to make it unambiguous — Claude Code needs explicit action framing
      // to avoid asking for clarification when operating in a project directory.

      let agentOutput = '';
      let agentError = '';

      // Prepend imperative prefix to avoid Claude asking for clarification
      const agentPrompt = `Execute this task autonomously using available tools (Write, Bash, Edit, etc.). Do not ask for clarification — just do it:\n\n${task}`;

      try {
        await spawnClaude(
          agentPrompt,
          (chunk) => {
            process.stdout.write(chunk);
            agentOutput += chunk;
          },
          { model: opts.model, cwd: worktreePath, agentMode: true },
        );
        process.stdout.write('\n');
      } catch (err: unknown) {
        agentError = err instanceof Error ? err.message : String(err);
        process.stderr.write(`\n[agent] Agent error: ${agentError}\n`);
        // Don't exit yet — still show diff and clean up
      }

      // 3. Show diff
      process.stderr.write('\n[agent] Changes in worktree:\n');
      const diff = worktreeDiff(worktreePath);
      if (diff.trim()) {
        process.stdout.write(diff);
        process.stdout.write('\n');
      } else {
        process.stdout.write('(no changes)\n');
      }

      // 4. Apply or leave
      if (opts.apply) {
        try {
          process.stderr.write(`[agent] Merging branch ${branch} into current branch...\n`);
          mergeWorktree(cwd, branch);
          process.stderr.write(`[agent] Merge complete. Worktree removed.\n`);
        } catch (err: unknown) {
          process.stderr.write(`[agent] Merge failed: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
          return;
        }
      } else {
        process.stderr.write(`\n[agent] Worktree left for review at: ${worktreePath}\n`);
        process.stderr.write(`[agent] Branch: ${branch}\n`);
        process.stderr.write(`[agent] To apply: lazy agent "${task}" --apply\n`);
        process.stderr.write(`[agent] To discard: git worktree remove --force "${worktreePath}" && git branch -D ${branch}\n`);
      }

      // 5. Capture agent neuron
      const html = buildNeuronHtml({
        kind: 'agent',
        title: `CLI agent: ${task.slice(0, 60)}`,
        text: `Task: ${task}\n\nBranch: ${branch}\nWorktree: ${worktreePath}\nApplied: ${opts.apply}\nOutput summary: ${agentOutput.slice(0, 600)}${agentError ? `\nError: ${agentError}` : ''}`,
        tags: ['cli', 'agent', 'lazy-cli', 'worktree'],
        source: 'lazy-cli:agent',
      });

      try {
        brainStoreHtml(brainPath, html);
      } catch (err: unknown) {
        process.stderr.write(`[brain] store warning: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    });
}
