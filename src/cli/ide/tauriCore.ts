/**
 * src/cli/ide/tauriCore.ts — headless shim for `@tauri-apps/api/core`'s `invoke`.
 *
 * The IDE tool runtime (src/lib/tools/toolRuntime.ts) executes filesystem tools
 * through Tauri commands. To run the SAME runtime headless (benchmark containers,
 * CI), this shim maps exactly the commands the agent tools use to node:fs and
 * child_process. The set of commands is audited against toolRuntime.ts; any new
 * command added there must be handled here too (it throws loudly otherwise, so
 * it can never silently no-op).
 */

import { readFileSync, writeFileSync, renameSync, rmSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

/** Real cwd for run_shell when the IDE passes a project-relative command. */
function resolveCwd(args: Record<string, unknown>): string | undefined {
  if (args.cwd && typeof args.cwd === 'string' && args.cwd.trim()) return args.cwd;
  return process.cwd();
}

/** Execute a shell command (the IDE's run_shell semantics: command string, shell:true). */
function runShell(command: string, cwd: string | undefined, timeoutMs: number): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    exitCode: r.status ?? -1,
  };
}

/**
 * Dispatch a Tauri command to a Node implementation. Kept as a plain function
 * so esbuild can bundle it without Tauri. Returns the same shapes the Rust
 * commands return (verified against src-tauri's command signatures).
 */
export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  switch (cmd) {
    case 'read_file': {
      const path = String(args.path);
      const maxBytes = Number(args.maxBytes ?? 0);
      const content = readFileSync(path, 'utf8');
      const text =
        maxBytes > 0 && content.length > maxBytes
          ? `${content.slice(0, maxBytes)}\n...[truncated at ${maxBytes} chars]`
          : content;
      return text as T;
    }
    case 'write_file': {
      const path = String(args.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, String(args.content ?? ''), 'utf8');
      return undefined as T;
    }
    case 'fs_rename':
      renameSync(String(args.oldPath), String(args.newPath));
      return undefined as T;
    case 'fs_remove':
      rmSync(String(args.path), { recursive: true, force: true });
      return undefined as T;
    case 'read_dir': {
      const path = String(args.path);
      return readdirSync(path, { withFileTypes: true }).map((e) => ({
        name: e.name,
        path: join(path, e.name),
        kind: e.isDirectory() ? 'directory' : 'file',
      })) as T;
    }
    case 'run_shell': {
      const command = String(args.command ?? '');
      const timeoutMs = Number(args.timeoutMs ?? 120_000);
      return runShell(command, resolveCwd(args), timeoutMs) as T;
    }
    case 'run_tests': {
      const command = String(args.command ?? '');
      const cwd = args.cwd ? String(args.cwd) : undefined;
      const timeoutMs = Number(args.timeoutMs ?? 600_000);
      const r = spawnSync(command, {
        cwd,
        shell: true,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      const ok = r.status === 0;
      return {
        ok,
        passed: ok ? 1 : 0,
        failed: ok ? 0 : 1,
        raw: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(0, 12000),
      } as T;
    }
    case 'git_status': {
      const repoPath = String(args.repoPath ?? '');
      const r = spawnSync('git', ['-C', repoPath, 'status', '--porcelain'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      const entries: Array<{ path: string; status: string }> = [];
      for (const line of (r.stdout ?? '').split('\n')) {
        const m = /^(.{1,2})\s+(.+)$/.exec(line);
        if (m) entries.push({ path: m[2], status: m[1].trim() });
      }
      return entries as T;
    }
    case 'git_diff': {
      const repoPath = String(args.repoPath ?? '');
      const filePath = String(args.filePath ?? '');
      const r = spawnSync('git', ['-C', repoPath, 'diff', 'HEAD', '--', filePath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      return (r.stdout ?? '').slice(0, 24000) as T;
    }
    case 'git_stage': {
      const repoPath = String(args.repoPath ?? '');
      const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
      spawnSync('git', ['-C', repoPath, 'add', '--', ...paths], { encoding: 'utf8', stdio: 'pipe' });
      return undefined as T;
    }
    case 'git_commit': {
      const repoPath = String(args.repoPath ?? '');
      const message = String(args.message ?? '');
      spawnSync(
        'git',
        ['-C', repoPath, '-c', 'user.name=lazy-idebench', '-c', 'user.email=lazy-idebench@local', 'commit', '-m', message],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      return undefined as T;
    }
    case 'is_worktree_script_eligible':
      // Headless harness has no worktree scripts — never eligible.
      return false as T;
    case 'lsp_request':
      throw new Error('lsp_request is not available in the headless IDE harness');
    default:
      throw new Error(`headless invoke: unsupported Tauri command "${cmd}" — add it to src/cli/ide/tauriCore.ts`);
  }
}

/** Also export the command-name set so the harness can assert coverage. */
export const SUPPORTED_COMMANDS = new Set([
  'read_file',
  'write_file',
  'fs_rename',
  'fs_remove',
  'read_dir',
  'run_shell',
  'run_tests',
  'git_status',
  'git_diff',
  'git_stage',
  'git_commit',
  'is_worktree_script_eligible',
  'lsp_request',
]);

// Avoid unused-import lint for statSync (kept for parity with Rust read_dir stat).
void statSync;
