/* cloudSandbox.ts — cloud_* sandbox tool handlers. Each operates on the
   mission's ephemeral Solari sandbox (solariSessions.ts), keyed by
   ctx.missionId; they never run in the assistant chat or the LazyManager.
*/

import type { ToolExecutionContext } from './types.js';
import { getSandbox, openSandbox, releaseSandbox } from '../../solari/solariSessions.js';
import { emit } from '../../bus.js';
import {
  byteLength,
  emitActivity,
  errorMessage,
  MISSION_REQUIRED,
  numberArg,
  optionalString,
  truncate,
} from './cloudShared.js';
import type { CodeLanguage, CommandHandle, RunCodeResult } from '@solarisdk/core';
import type { Sandbox } from '@solarisdk/sandbox';

function noSandbox(): string {
  return 'ERROR: no sandbox — call cloud_sandbox_open first';
}

const VALID_LANGUAGES: readonly string[] = ['python', 'javascript', 'typescript', 'bash', 'r'];

/** Deadline for a single `code.*` control-channel call — the SDK's own
 *  timeout is 300s, and a sandbox template without the code kernel lets the
 *  call hang to that full deadline (real incident, M121: ~374s stalled on
 *  code.context.create, then surfaced as a generic "unexpected Solari
 *  error"). 60s is still generous for a kernel create/run on a live sandbox. */
const CODE_KERNEL_TIMEOUT_MS = 60_000;

/** Missions whose sandbox proved it does not serve the `code.*` family —
 *  later run_code calls skip straight to the commands.run fallback instead
 *  of burning another deadline. */
const kernelDeadMissions = new Set<string>();

const codeContextRegistry = new Map<string, string>();
const commandRegistry = new Map<
  string,
  Map<string, { handle: CommandHandle; output: string; done: boolean; exitCode?: number }>
>();

function contextKey(missionId: string, language: string): string {
  return `${missionId}::${language}`;
}

function codeLanguage(value: unknown): CodeLanguage {
  const lang = optionalString(value) ?? 'python';
  return VALID_LANGUAGES.includes(lang) ? (lang as CodeLanguage) : 'python';
}

/** Local deadline marker for a `code.*` call that never answered in time —
 *  distinct from the SDK's own TimeoutError so the fallback decision can see
 *  "we gave up on the kernel path", not just "Solari was slow". */
class KernelTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`Solari call "${method}" did not answer within ${ms}ms`);
    this.name = 'KernelTimeoutError';
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number, method: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new KernelTimeoutError(method, ms)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Interpreter for the commands.run fallback, per run_code language. The
 *  snippet is written to a temp file (no shell-quoting issues) and executed
 *  with the template's stock interpreter. */
const EXEC_RUNNERS: Record<CodeLanguage, { ext: string; command: (path: string) => string }> = {
  python: { ext: 'py', command: (p) => `python3 "${p}"` },
  javascript: { ext: 'js', command: (p) => `node "${p}"` },
  typescript: { ext: 'ts', command: (p) => `npx -y tsx "${p}"` },
  bash: { ext: 'sh', command: (p) => `bash "${p}"` },
  r: { ext: 'R', command: (p) => `Rscript "${p}"` },
};

/** Fallback for sandboxes whose guest does not serve the `code.*` family:
 *  run the snippet through `commands.run` — the `cmd.*` channel every
 *  template supports. Loses kernel state and rich outputs; the marker line
 *  keeps that degradation honest for the agent. */
async function runCodeViaExec(
  sandbox: Sandbox,
  code: string,
  language: CodeLanguage,
): Promise<string> {
  const runner = EXEC_RUNNERS[language];
  const path = `/tmp/lazy_code_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${runner.ext}`;
  await sandbox.files.write(path, code);
  const result = await sandbox.commands.run(runner.command(path));
  return truncate(
    `[kernel unavailable — ran via commands.run; no state/charts]\nexit: ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    4000,
  );
}

function stringArrayArg(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  return undefined;
}

export async function cloudSandboxOpen(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  emitActivity(ctx, 'cloud_sandbox_open', 'Open sandbox');
  try {
    const opts: { template?: string; cpu?: number; memMb?: number } = {};
    const template = optionalString(args.template);
    if (template) opts.template = template;
    const cpu = numberArg(args.cpu, 0);
    if (cpu > 0) opts.cpu = cpu;
    const memMb = numberArg(args.mem_mb, 0);
    if (memMb > 0) opts.memMb = memMb;
    const handle = await openSandbox(ctx.missionId, opts);
    return `Sandbox opened (id: ${handle.sandbox.sandboxId}).`;
  } catch (err) {
    return errorMessage('cloud_sandbox_open', err);
  }
}

export async function cloudSandboxClose(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  emitActivity(ctx, 'cloud_sandbox_close', 'Close sandbox');
  try {
    await releaseSandbox(ctx.missionId);
    for (const key of codeContextRegistry.keys()) {
      if (key.startsWith(`${ctx.missionId}::`)) codeContextRegistry.delete(key);
    }
    commandRegistry.delete(ctx.missionId);
    kernelDeadMissions.delete(ctx.missionId);
    return 'Sandbox closed.';
  } catch (err) {
    return errorMessage('cloud_sandbox_close', err);
  }
}

export async function cloudSandboxReadFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const path = optionalString(args.path);
  if (!path) return 'ERROR: No path provided';
  emitActivity(ctx, 'cloud_sandbox_read_file', 'Read file', path);
  try {
    const handle = getSandbox(ctx.missionId);
    if (!handle) return noSandbox();
    const content = await handle.sandbox.files.readText(path);
    return truncate(content);
  } catch (err) {
    return errorMessage('cloud_sandbox_read_file', err);
  }
}

export async function cloudSandboxFileList(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const path = optionalString(args.path) ?? '.';
  emitActivity(ctx, 'cloud_sandbox_file_list', 'List files', path);
  try {
    const handle = getSandbox(ctx.missionId);
    if (!handle) return noSandbox();
    const entries = await handle.sandbox.files.list(path);
    if (entries.length === 0) return 'Empty directory.';
    return entries.map((e) => `${e.dir ? 'd/' : 'f/'}${e.name} (${e.size} bytes)`).join('\n');
  } catch (err) {
    return errorMessage('cloud_sandbox_file_list', err);
  }
}

export async function cloudSandboxWriteFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const path = optionalString(args.path);
  const content = optionalString(args.content);
  if (!path) return 'ERROR: No path provided';
  if (!content) return 'ERROR: No content provided';
  emitActivity(ctx, 'cloud_sandbox_write_file', 'Write file', path);
  try {
    const handle = getSandbox(ctx.missionId);
    if (!handle) return noSandbox();
    await handle.sandbox.files.write(path, content);
    return `Wrote ${byteLength(content)} bytes to ${path}`;
  } catch (err) {
    return errorMessage('cloud_sandbox_write_file', err);
  }
}

export async function cloudSandboxExec(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const command = optionalString(args.command);
  if (!command) return 'ERROR: No command provided';
  const cwd = optionalString(args.cwd);
  emitActivity(ctx, 'cloud_sandbox_exec', 'Run command', command);
  try {
    const handle = getSandbox(ctx.missionId);
    if (!handle) return noSandbox();
    const result = await handle.sandbox.commands.run(command, cwd ? { cwd } : undefined);
    return truncate(`exit: ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  } catch (err) {
    return errorMessage('cloud_sandbox_exec', err);
  }
}

export async function cloudSandboxPreviewUrl(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const port = numberArg(args.port, 0);
  if (port <= 0) return 'ERROR: No valid port provided';
  emitActivity(ctx, 'cloud_sandbox_preview_url', 'Get preview URL', `:${port}`);
  try {
    const handle = getSandbox(ctx.missionId);
    if (!handle) return noSandbox();
    const result = await handle.sandbox.previewUrl(port);
    return result.url;
  } catch (err) {
    return errorMessage('cloud_sandbox_preview_url', err);
  }
}

export async function cloudSandboxRunCode(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const code = optionalString(args.code);
  if (!code) return 'ERROR: No code provided';
  const language = codeLanguage(args.language);
  emitActivity(ctx, 'cloud_sandbox_run_code', 'Run code', language);
  try {
    const handle = getSandbox(ctx.missionId);
    if (!handle) return noSandbox();

    // The `code.*` kernel path: bounded so a template without the kernel
    // cannot stall the whole mission at the SDK's 300s deadline. ANY throw
    // here (timeout, refused RPC, dropped channel) marks the kernel dead for
    // this mission and falls through to the commands.run fallback — a code
    // error inside the snippet itself arrives via result.error, not a throw.
    if (!kernelDeadMissions.has(ctx.missionId)) {
      try {
        let contextId = optionalString(args.context_id);
        if (!contextId) {
          const key = contextKey(ctx.missionId, language);
          contextId = codeContextRegistry.get(key);
          if (!contextId) {
            contextId = await withDeadline(
              handle.sandbox.createCodeContext(language),
              CODE_KERNEL_TIMEOUT_MS,
              'code.context.create',
            );
            codeContextRegistry.set(key, contextId);
          }
        }
        const result = await withDeadline(
          handle.sandbox.runCode(code, { language, contextId }),
          CODE_KERNEL_TIMEOUT_MS,
          'code.run',
        );
        return formatRunCodeResult(result, ctx);
      } catch (err) {
        kernelDeadMissions.add(ctx.missionId);
        console.warn('[cloud_sandbox_run_code] code.* path failed — falling back to commands.run:', err);
      }
    }
    return await runCodeViaExec(handle.sandbox, code, language);
  } catch (err) {
    return errorMessage('cloud_sandbox_run_code', err);
  }
}

/** Formats a `code.run` result (stdout/stderr, errors, charts) into the
 *  observation text the agent sees. */
function formatRunCodeResult(
  result: RunCodeResult,
  ctx: ToolExecutionContext,
): string {
  const parts: string[] = [];
  for (const item of result.results) {
    if ((item.type === 'stdout' || item.type === 'stderr') && item.text) parts.push(item.text);
  }

  if (result.error) {
    if (typeof result.error === 'string') {
      parts.push(`Error: ${result.error}`);
    } else {
      const { name, message, traceback } = result.error;
      if (name) parts.push(`Error: ${name}: ${message ?? ''}`);
      if (traceback) parts.push(traceback);
    }
  }

  for (const item of result.results) {
    if (item.png) {
      const chartType = item.chart?.type ?? 'image';
      const chartTitle = item.chart?.title ?? 'chart';
      parts.push(`[chart] ${chartType} ${chartTitle}`);
      emit('browser:stateChange', {
        missionId: ctx.missionId,
        isOpen: true,
        url: '',
        title: 'Sandbox chart',
        lastAction: 'cloud_sandbox_run_code',
        lastActionAt: Date.now(),
        screenshotDataUrl: `data:image/png;base64,${item.png}`,
      });
    }
  }

  if (result.charts.length > 0) {
    for (const chart of result.charts) {
      parts.push(`Chart: ${chart.type}${chart.title ? ` - ${chart.title}` : ''}`);
    }
  }

  return truncate(parts.join('\n').trim(), 4000);
}

export async function cloudSandboxFileSearch(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const query = optionalString(args.query);
  if (!query) return 'ERROR: No query provided';
  const path = optionalString(args.path) ?? '/workspace';
  const maxResults = numberArg(args.max_results, 50);
  emitActivity(ctx, 'cloud_sandbox_file_search', 'Search files', query);
  try {
    const handle = getSandbox(ctx.missionId);
    if (!handle) return noSandbox();
    const matches = await handle.sandbox.files.search(path, query, maxResults);
    if (matches.length === 0) return 'No matches.';
    return truncate(matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n'));
  } catch (err) {
    return errorMessage('cloud_sandbox_file_search', err);
  }
}

export async function cloudSandboxDownload(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const path = optionalString(args.path);
  if (!path) return 'ERROR: No path provided';
  emitActivity(ctx, 'cloud_sandbox_download', 'Download URL', path);
  try {
    const handle = getSandbox(ctx.missionId);
    if (!handle) return noSandbox();
    const result = await handle.sandbox.downloadUrl(path);
    return `URL: ${result.url}${result.expiresAt ? `\nExpires: ${result.expiresAt}` : ''}`;
  } catch (err) {
    return errorMessage('cloud_sandbox_download', err);
  }
}

export async function cloudSandboxUpload(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const path = optionalString(args.path);
  const content = optionalString(args.content);
  if (!path) return 'ERROR: No path provided';
  if (!content) return 'ERROR: No content provided';
  emitActivity(ctx, 'cloud_sandbox_upload', 'Upload file', path);
  try {
    const handle = getSandbox(ctx.missionId);
    if (!handle) return noSandbox();
    await handle.sandbox.files.upload(path, content);
    return `Wrote ${byteLength(content)} bytes to ${path}`;
  } catch (err) {
    return errorMessage('cloud_sandbox_upload', err);
  }
}

export async function cloudSandboxCommandStart(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const command = optionalString(args.command);
  if (!command) return 'ERROR: No command provided';
  const cmdArgs = stringArrayArg(args.args);
  const cwd = optionalString(args.cwd);
  emitActivity(ctx, 'cloud_sandbox_command_start', 'Start command', command);
  try {
    const handle = getSandbox(ctx.missionId);
    if (!handle) return noSandbox();
    const opts: { args?: string[]; cwd?: string } = {};
    if (cmdArgs) opts.args = cmdArgs;
    if (cwd) opts.cwd = cwd;
    const cmdHandle = await handle.sandbox.commands.start(command, opts);
    const entry: { handle: CommandHandle; output: string; done: boolean; exitCode?: number } = {
      handle: cmdHandle,
      output: '',
      done: false,
    };
    cmdHandle.onData((chunk) => {
      entry.output += `${chunk.stream}: ${chunk.data}`;
      if (entry.output.length > 50 * 1024) entry.output = entry.output.slice(-50 * 1024);
    });
    cmdHandle
      .wait()
      .then((exitCode) => {
        entry.done = true;
        entry.exitCode = exitCode;
      })
      .catch(() => {
        entry.done = true;
      });
    let missionCommands = commandRegistry.get(ctx.missionId);
    if (!missionCommands) {
      missionCommands = new Map();
      commandRegistry.set(ctx.missionId, missionCommands);
    }
    missionCommands.set(cmdHandle.cmdId, entry);
    return `Command started (cmdId: ${cmdHandle.cmdId})`;
  } catch (err) {
    return errorMessage('cloud_sandbox_command_start', err);
  }
}

export async function cloudSandboxCommandPoll(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const cmdId = optionalString(args.cmd_id);
  if (!cmdId) return 'ERROR: No cmd_id provided';
  emitActivity(ctx, 'cloud_sandbox_command_poll', 'Poll command', cmdId);
  try {
    const missionCommands = commandRegistry.get(ctx.missionId);
    const entry = missionCommands?.get(cmdId);
    if (!entry) return 'ERROR: Unknown command id';
    const parts = [entry.output];
    if (entry.done) parts.push(`\n\n[done] exit: ${entry.exitCode ?? 'unknown'}`);
    else parts.push('\n\n[running]');
    return truncate(parts.join(''));
  } catch (err) {
    return errorMessage('cloud_sandbox_command_poll', err);
  }
}
