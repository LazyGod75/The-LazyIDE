/* Git-domain tool handlers: status/diff/log/commit/review_diff/create_pr.
   Extracted verbatim from toolRuntime.ts's executeTool switch. */

import { invoke } from '@tauri-apps/api/core';
import type { ToolExecutionContext } from './types.js';

export async function gitStatus(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  try {
    const result = await invoke<Array<{ path: string; status: string }>>('git_status', { repoPath: rootPath });
    if (result.length === 0) return 'Working tree clean';
    return result.map(e => `${e.status} ${e.path}`).join('\n');
  } catch (err) {
    return `ERROR: git_status failed: ${String(err)}`;
  }
}

export async function gitDiff(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const filePath = args.path ? String(args.path) : '';
  try {
    const diff = await invoke<string>('git_diff', { repoPath: rootPath, filePath });
    if (!diff.trim()) return 'No changes';
    return diff.slice(0, 2000);
  } catch (err) {
    return `ERROR: git_diff failed: ${String(err)}`;
  }
}

export async function gitLog(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const count = Number(args.count ?? 10);
  try {
    const result = await invoke<{ stdout: string; stderr: string; exitCode: number }>('run_shell', {
      command: `git log --oneline -${count}`,
      cwd: rootPath,
      timeoutMs: 10000,
    });
    return result.stdout.trim() || 'No commits';
  } catch (err) {
    return `ERROR: git_log failed: ${String(err)}`;
  }
}

export async function gitCommit(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
  const message = String(args.message ?? '');
  if (!message) return 'ERROR: No commit message provided';
  try {
    await invoke<void>('git_stage', { repoPath: rootPath, paths });
    await invoke<void>('git_commit', { repoPath: rootPath, message });
    return `Committed: ${message}`;
  } catch (err) {
    return `ERROR: git_commit failed: ${String(err)}`;
  }
}

export async function reviewDiff(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  try {
    const diff = await invoke<string>('git_diff', { repoPath: rootPath, filePath: '' });
    if (!diff.trim()) return 'No changes made in this mission';
    return diff.slice(0, 3000);
  } catch (err) {
    return `ERROR: review_diff failed: ${String(err)}`;
  }
}

export async function gitCreatePr(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const title = String(args.title ?? '');
  const body = String(args.body ?? '');
  const base = args.base ? String(args.base) : '';
  const draft = args.draft === true;
  if (!title) return 'ERROR: No PR title provided';
  try {
    // Push the current branch first
    await invoke<void>('git_push', { repoPath: rootPath });
    // Build gh pr create command
    const escapedTitle = title.replace(/'/g, "'\\''");
    const escapedBody = body.replace(/'/g, "'\\''");
    let cmd = `gh pr create --title '${escapedTitle}' --body '${escapedBody}'`;
    if (base) cmd += ` --base ${base}`;
    if (draft) cmd += ' --draft';
    const result = await invoke<{ stdout: string; stderr: string; exitCode: number }>('run_shell', {
      command: cmd,
      cwd: rootPath,
      timeoutMs: 30000,
    });
    if (result.exitCode !== 0) {
      const errOutput = (result.stderr + result.stdout).trim();
      return `ERROR: gh pr create failed (exit ${result.exitCode}): ${errOutput.slice(0, 500)}`;
    }
    const prUrl = result.stdout.trim();
    return `Pull request created: ${prUrl}`;
  } catch (err) {
    return `ERROR: git_create_pr failed: ${String(err)}`;
  }
}
