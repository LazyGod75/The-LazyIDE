/**
 * `lazy bench "<task>"` command — the LazyManager-level benchmark harness.
 *
 * Runs the real tool-loop agent (read_dir / find_file / search_code / read /
 * edit / write / bash) headless on a task, in place (no worktree). This is the
 * container-friendly entry point for Terminal-Bench and DeepSWE runs:
 *
 *   - operates directly on the task repo (--workdir, default: current dir)
 *   - `--commit` commits the final state (DeepSWE grades the committed patch)
 *   - `--json` prints a machine-readable result on stdout
 *
 * Backend: DeepSeek via DEEPSEEK_API_KEY (default) or the Claude CLI.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { type Command } from 'commander';
import { runAgentLoop, type AgentBackend, type AgentLoopEvent } from '../lib/agentLoop.js';

interface BenchOptions {
  workdir?: string;
  taskFile?: string;
  commit: boolean;
  commitMessage?: string;
  maxSteps?: string;
  bashTimeoutMs?: string;
  backend: AgentBackend;
  model?: string;
  brain?: boolean;
  quiet: boolean;
  json: boolean;
}

function commitInPlace(workdir: string, message: string): void {
  try {
    const rev = spawnSync('git', ['rev-parse', '--git-dir'], {
      cwd: workdir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (rev.status !== 0) {
      process.stderr.write('[bench] not a git repository — skipping commit (changes left on disk)\n');
      return;
    }
    spawnSync('git', ['add', '-A'], { cwd: workdir, stdio: 'pipe' });
    const status = spawnSync('git', ['status', '--porcelain'], {
      cwd: workdir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (!(status.stdout ?? '').trim()) {
      process.stderr.write('[bench] no changes to commit\n');
      return;
    }
    // Local identity (-c) so containers without a configured git user still commit.
    const commit = spawnSync(
      'git',
      ['-c', 'user.name=lazy-bench', '-c', 'user.email=lazy-bench@local', 'commit', '-m', message],
      { cwd: workdir, encoding: 'utf8', stdio: 'pipe' },
    );
    if (commit.status === 0) {
      process.stderr.write('[bench] commit ok\n');
    } else {
      process.stderr.write(`[bench] commit FAILED: ${(commit.stderr ?? '').slice(0, 300)}\n`);
    }
  } catch (err) {
    process.stderr.write(`[bench] commit error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

export function registerBench(program: Command): void {
  program
    .command('bench [task]')
    .description(
      'Run the LazyManager-level autonomous agent (real tool loop) on a task, in place — the container-friendly harness for Terminal-Bench / DeepSWE',
    )
    .option('--workdir <path>', 'Directory to operate in (default: current directory)')
    .option('--task-file <path>', 'Read the task from a file instead of the positional argument (DeepSWE: /app/instruction.md)')
    .option('--commit', 'git add -A and commit all changes at the end (DeepSWE requires committed work)')
    .option('--commit-message <msg>', 'Commit message (default: "lazy bench: agent changes")')
    .option('--max-steps <n>', 'Max agent tool iterations (default 60)', '60')
    .option('--bash-timeout-ms <n>', 'Per-command bash timeout in ms (default 120000)', '120000')
    .option('--backend <backend>', 'LLM backend: deepseek (default) | claude', 'deepseek')
    .option('--model <model>', 'Model id/alias override (default: DEEPSEEK_MODEL or deepseek-chat)')
    .option('--brain', 'Inject LazyBrain project-memory context into every prompt')
    .option('--quiet', 'Suppress the transcript on stderr')
    .option('--json', 'Print a JSON result object on stdout')
    .action(async (task: string | undefined, opts: BenchOptions) => {
      const workdir = resolve(opts.workdir ?? process.cwd());
      if (!existsSync(workdir)) {
        process.stderr.write(`[bench] workdir does not exist: ${workdir}\n`);
        process.exit(1);
        return;
      }

      // Resolve the task: --task-file wins (container-friendly), then the positional argument.
      let taskText = task ?? '';
      if (opts.taskFile) {
        if (!existsSync(opts.taskFile)) {
          process.stderr.write(`[bench] task file does not exist: ${opts.taskFile}\n`);
          process.exit(1);
          return;
        }
        taskText = readFileSync(opts.taskFile, 'utf8');
      }
      if (!taskText.trim()) {
        process.stderr.write('[bench] no task provided — pass a task argument or --task-file <path>\n');
        process.exit(1);
        return;
      }

      const onEvent = (evt: AgentLoopEvent): void => {
        if (opts.quiet) return;
        if (evt.type === 'tool') {
          process.stderr.write(`[${evt.index + 1}] ${evt.tool}: ${JSON.stringify(evt.args)}\n`);
        } else if (evt.type === 'observation') {
          process.stderr.write(`Observation: ${String(evt.observation).split('\n').slice(0, 3).join('\n')}\n`);
        } else if (evt.type === 'final') {
          process.stderr.write(`[done] ${evt.summary}\n`);
        } else if (evt.type === 'error') {
          process.stderr.write(`[error] ${evt.error}\n`);
        }
      };

      if (!opts.quiet) {
        process.stderr.write(`[bench] workdir=${workdir} backend=${opts.backend} model=${opts.model ?? '(default)'}\n`);
      }

      let result;
      try {
        result = await runAgentLoop({
          workdir,
          task: taskText,
          backend: opts.backend,
          model: opts.model,
          maxSteps: Number(opts.maxSteps) || 60,
          bashTimeoutMs: Number(opts.bashTimeoutMs) || 120_000,
          brain: Boolean(opts.brain),
          onEvent,
        });
      } catch (err) {
        process.stderr.write(`[bench] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
        return;
      }

      if (opts.commit) {
        commitInPlace(workdir, opts.commitMessage ?? 'lazy bench: agent changes');
      }

      const out = {
        ok: result.ok,
        stoppedBy: result.stoppedBy,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        summary: result.summary,
        workdir,
        lastError: result.lastError ?? null,
        committed: Boolean(opts.commit),
        // Real usage/cost reported by the backend (claude backend JSON mode). Lets
        // A/B benchmark harnesses measure "model alone" vs "LazyIDE loop" cost.
        usage: result.usage ?? null,
        costUsd: result.usage?.costUsd ?? null,
      };
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      }
      if (!opts.quiet) {
        process.stderr.write(
          `[bench] done ok=${result.ok} stoppedBy=${result.stoppedBy} iterations=${result.iterations} toolCalls=${result.toolCalls}\n`,
        );
      }
      // Exit 0 on finish, 2 on max-steps (work may still be graded by the verifier), 1 on error.
      process.exit(result.ok ? 0 : result.stoppedBy === 'error' ? 1 : 2);
    });
}
