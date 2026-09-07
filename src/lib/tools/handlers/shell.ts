/* Shell/build-domain tool handlers: run_command/run_tests/run_lint/
   run_build. Extracted verbatim from toolRuntime.ts's executeTool switch. */

import { invoke } from '@tauri-apps/api/core';
import type { ToolExecutionContext } from './types.js';

/** Floor for run_command/run_shell's timeoutMs (below, 'run_command' case).
 *  A cold `npx`/interpreter start routinely exceeds 3-5s — a lower request
 *  is raised here rather than honored, so a self-verification step doesn't
 *  fail the whole mission on a slow-start false negative. */
const MIN_RUN_COMMAND_TIMEOUT_MS = 10_000;

/** Formats a run_shell/run_worktree_script result into the exit-code +
 *  (possibly truncated) output observation string the model sees — shared
 *  by both branches of the 'run_command' case (general run_shell path and
 *  the scoped run_worktree_script path) so they produce identical output
 *  shapes regardless of which one actually ran the command. */
function formatRunCommandResult(result: { stdout: string; stderr: string; exitCode: number }): string {
  const output = result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : '');
  if (!output.trim()) return `[exit ${result.exitCode}]\nCommand ran successfully, no output.`;
  const truncated = output.length > 2000 ? output.slice(0, 2000) + '\n... (truncated)' : output;
  return `[exit ${result.exitCode}]\n${truncated}`;
}

export async function runCommand(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const command = String(args.command ?? '');
  const requestedTimeoutMs = Number(args.timeout_ms ?? 30000);
  const timeoutMs = Math.max(requestedTimeoutMs, MIN_RUN_COMMAND_TIMEOUT_MS);
  if (!command) return 'ERROR: No command provided';

  // Scoped worktree-script path (M12 dogfood fix, BLOQUANT #3): an
  // acceptEdits/full mission running an allowlisted package.json/cargo
  // script has already been let through checkToolExecution's narrow
  // bypass (managedToolPermissions.ts) even if the general Bash rule is
  // ask/exclude — is_worktree_script_eligible re-derives that same
  // narrow eligibility server-side (never trusts the JS-side decision)
  // PLUS the one check the JS gate cannot make: that `rootPath` really
  // is a mission worktree, not the raw project root. Only when eligible
  // do we execute via run_worktree_script; otherwise this falls straight
  // through to the ordinary run_shell path below, unchanged from before
  // this fix — every non-qualifying call behaves exactly as it always did.
  //
  // SECURITY (audit CRITICAL): "not eligible" (eligible === false) is
  // safe to fall through to run_shell — the command was never confirmed
  // to need confinement, so the general path is its default. But once
  // eligibility is confirmed and the scoped run_worktree_script itself
  // fails (timeout, IPC error, or the command started then failed), the
  // call MUST NOT degrade to the unconfined run_shell path — a command
  // that was meant to be confined can never end up running unconfined.
  // The eligibility check and the scoped execution are therefore in
  // SEPARATE try blocks: only the eligibility check may fall through; a
  // confirmed-eligible-but-failed scoped execution returns an honest
  // error instead.
  const permissionMode = ctx.policy.permissionMode;
  if (permissionMode === 'acceptEdits' || permissionMode === 'full') {
    let eligible = false;
    try {
      eligible = await invoke<boolean>('is_worktree_script_eligible', {
        command,
        cwd: rootPath,
        permissionMode,
      });
    } catch {
      // Eligibility check itself failed (e.g. IPC hiccup) — cannot
      // confirm eligibility, so fall through to the general run_shell
      // path below, the default unconfined path this command would have
      // used anyway when the scoped mechanism is unavailable.
    }
    if (eligible) {
      try {
        const scoped = await invoke<{ stdout: string; stderr: string; exitCode: number }>(
          'run_worktree_script',
          { command, cwd: rootPath, timeoutMs, permissionMode },
        );
        return formatRunCommandResult(scoped);
      } catch (err) {
        // Scoped execution started (eligibility was confirmed) but then
        // failed — timeout, IPC error, or the command itself failed after
        // starting. Do NOT fall through to run_shell: a command that was
        // meant to be confined must never degrade to unconfined execution.
        // Return an honest error so the model sees a real failed step.
        return `ERROR: scoped worktree-script execution failed (command was eligible but confined execution errored): ${String(err)}`;
      }
    }
  }

  const result = await invoke<{ stdout: string; stderr: string; exitCode: number }>('run_shell', { command, cwd: rootPath, timeoutMs });
  return formatRunCommandResult(result);
}

export async function runTests(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const file = args.file ? String(args.file) : undefined;
  const pattern = args.pattern ? String(args.pattern) : undefined;
  const result = await invoke<{ ok: boolean; passed: number; failed: number; raw: string }>('run_tests', {
    repoPath: rootPath,
    fileFilter: file,
    patternFilter: pattern,
  });
  return `Tests: ${result.passed} passed, ${result.failed} failed${result.ok ? '' : ' (FAILED)'}${result.raw ? `\n${result.raw.slice(0, 1000)}` : ''}`;
}

export async function runLint(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const file = args.file ? String(args.file) : '';
  try {
    const cmd = file ? `npx eslint ${file} --format compact 2>&1 || npx biome check ${file} 2>&1` : `npm run lint 2>&1`;
    const result = await invoke<{ stdout: string; stderr: string; exitCode: number }>('run_shell', {
      command: cmd,
      cwd: rootPath,
      timeoutMs: 30000,
    });
    const output = (result.stdout + result.stderr).trim();
    if (!output) return 'No lint issues';
    return output.slice(0, 2000);
  } catch (err) {
    return `ERROR: run_lint failed: ${String(err)}`;
  }
}

export async function runBuild(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  try {
    const result = await invoke<{ stdout: string; stderr: string; exitCode: number }>('run_shell', {
      command: 'npm run build 2>&1',
      cwd: rootPath,
      timeoutMs: 120000,
    });
    if (result.exitCode === 0) return 'Build OK';
    const errors = (result.stdout + result.stderr).split('\n').filter(l => /error|Error|ERROR/.test(l)).slice(0, 10).join('\n');
    return `Build FAILED (exit ${result.exitCode})\n${errors.slice(0, 2000)}`;
  } catch (err) {
    return `ERROR: run_build failed: ${String(err)}`;
  }
}
