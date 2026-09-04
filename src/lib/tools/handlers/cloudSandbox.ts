/* cloudSandbox.ts — cloud_* sandbox tool handlers. Each operates on the
   mission's ephemeral Solari sandbox (solariSessions.ts), keyed by
   ctx.missionId; they never run in the assistant chat or the LazyManager.
*/

import type { ToolExecutionContext } from './types.js';
import { getSandbox, openSandbox, releaseSandbox } from '../../solari/solariSessions.js';
import {
  byteLength,
  emitActivity,
  errorMessage,
  MISSION_REQUIRED,
  numberArg,
  optionalString,
  truncate,
} from './cloudShared.js';

function noSandbox(): string {
  return 'ERROR: no sandbox — call cloud_sandbox_open first';
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
