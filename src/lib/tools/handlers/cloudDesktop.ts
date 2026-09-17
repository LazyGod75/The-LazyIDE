/* cloudDesktop.ts — cloud_* desktop tool handlers for Agent Computer(s)
   (agentComputer.ts via solariSessions.ts). When the mission belongs to a
   LazyBot, ensure/acquire use that botId so each bot gets its own VM (C50);
   otherwise the shared Agent Computer is used. cloud_desktop_open acquires
   the FIFO mutex once; other desktop tools only ensure the handle.
*/

import type { ToolExecutionContext } from './types.js';
import { emit } from '../../bus.js';
import {
  acquireAgentComputer,
  ensureAgentComputer,
  releaseAgentComputer,
  snapshotAgentComputer,
  type AgentComputerHandle,
} from '../../solari/solariSessions.js';
import { revertAgentComputer } from '../../solari/agentComputer.js';
import { botIdForMission } from '../../bots/botEngine.js';
import {
  byteLength,
  bytesToDataUrl,
  emitActivity,
  errorMessage,
  MISSION_REQUIRED,
  numberArg,
  optionalString,
  truncate,
} from './cloudShared.js';

function resolveBotId(ctx: ToolExecutionContext): string | undefined {
  return ctx.missionId ? botIdForMission(ctx.missionId) ?? undefined : undefined;
}

async function ensureFor(ctx: ToolExecutionContext): Promise<AgentComputerHandle> {
  return ensureAgentComputer(resolveBotId(ctx));
}

export async function cloudDesktopOpen(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  emitActivity(ctx, 'cloud_desktop_open', 'Acquire Agent Computer');
  try {
    const id = resolveBotId(ctx);
    const handle = await ensureAgentComputer(id);
    await acquireAgentComputer(ctx.missionId, id);
    return `Agent Computer acquired (desktop: ${handle.desktopId}). Use cloud_desktop_* tools to interact.`;
  } catch (err) {
    return errorMessage('cloud_desktop_open', err);
  }
}

export async function cloudDesktopClose(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  emitActivity(ctx, 'cloud_desktop_close', 'Release Agent Computer');
  releaseAgentComputer(ctx.missionId, resolveBotId(ctx));
  return 'Agent Computer released.';
}

export async function cloudDesktopScreenshot(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  emitActivity(ctx, 'cloud_desktop_screenshot', 'Desktop screenshot');
  try {
    const { desktop } = await ensureFor(ctx);
    const bytes = await desktop.screenshot();
    emit('browser:stateChange', {
      isOpen: true,
      missionId: ctx.missionId,
      botId: resolveBotId(ctx),
      url: '',
      title: 'Agent Computer',
      lastAction: 'cloud_desktop_screenshot',
      lastActionAt: Date.now(),
      screenshotDataUrl: bytesToDataUrl(bytes),
    });
    return 'Desktop screenshot captured.';
  } catch (err) {
    return errorMessage('cloud_desktop_screenshot', err);
  }
}

export async function cloudDesktopStreamUrl(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  emitActivity(ctx, 'cloud_desktop_stream_url', 'Get desktop stream URL');
  try {
    const { desktop } = await ensureFor(ctx);
    const stream = await desktop.stream.start();
    const token = stream.token ? ` (token: ${stream.token})` : '';
    return `Stream URL: ${stream.streamUrl}${token}`;
  } catch (err) {
    return errorMessage('cloud_desktop_stream_url', err);
  }
}

export async function cloudDesktopMouseClick(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const x = numberArg(args.x);
  const y = numberArg(args.y);
  const raw = optionalString(args.button);
  const button: 'left' | 'right' | 'middle' = raw === 'right' || raw === 'middle' ? raw : 'left';
  const humanize = args.humanize === true;
  emitActivity(ctx, 'cloud_desktop_mouse_click', 'Mouse click', `(${x}, ${y})`);
  try {
    const { desktop } = await ensureFor(ctx);
    if (humanize) await desktop.mouse.move(x, y, { humanize: true });
    await desktop.mouse.click(x, y, { button, ...(humanize ? { humanize: true } : {}) });
    return `Clicked at (${x}, ${y})${humanize ? ' (humanized)' : ''}.`;
  } catch (err) {
    return errorMessage('cloud_desktop_mouse_click', err);
  }
}

export async function cloudDesktopMouseMove(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const x = numberArg(args.x);
  const y = numberArg(args.y);
  const humanize = args.humanize === true;
  emitActivity(ctx, 'cloud_desktop_mouse_move', 'Mouse move', `(${x}, ${y})`);
  try {
    const { desktop } = await ensureFor(ctx);
    await desktop.mouse.move(x, y, humanize ? { humanize: true } : undefined);
    return `Moved mouse to (${x}, ${y})${humanize ? ' (humanized)' : ''}.`;
  } catch (err) {
    return errorMessage('cloud_desktop_mouse_move', err);
  }
}

export async function cloudDesktopMouseScroll(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const dx = numberArg(args.dx, 0);
  const dy = numberArg(args.dy, 0);
  if (dx === 0 && dy === 0) return 'ERROR: Provide dx or dy';
  emitActivity(ctx, 'cloud_desktop_mouse_scroll', 'Mouse scroll', `(${dx}, ${dy})`);
  try {
    const { desktop } = await ensureFor(ctx);
    // SDK scroll(x, y) — the pair is the scroll delta, humanize is optional.
    await desktop.mouse.scroll(dx, dy, args.humanize === true ? { humanize: true } : undefined);
    return `Scrolled by (${dx}, ${dy}).`;
  } catch (err) {
    return errorMessage('cloud_desktop_mouse_scroll', err);
  }
}

export async function cloudDesktopAppOpen(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const name = optionalString(args.name);
  if (!name) return 'ERROR: No app name provided';
  const appArgs = Array.isArray(args.args) ? args.args.map(String) : undefined;
  emitActivity(ctx, 'cloud_desktop_app_open', 'Open app', name);
  try {
    const { desktop } = await ensureFor(ctx);
    const pid = await desktop.open(name, appArgs);
    return `Launched "${name}" (pid ${pid}).`;
  } catch (err) {
    return errorMessage('cloud_desktop_app_open', err);
  }
}

export async function cloudDesktopProcessList(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  emitActivity(ctx, 'cloud_desktop_process_list', 'List processes');
  try {
    const { desktop } = await ensureFor(ctx);
    const processes = await desktop.process.list();
    if (processes.length === 0) return 'No processes reported.';
    return truncate(processes.map((p) => `${p.pid}\t${p.name}${p.cmd ? ` — ${p.cmd}` : ''}`).join('\n'));
  } catch (err) {
    return errorMessage('cloud_desktop_process_list', err);
  }
}

export async function cloudDesktopKeyboardPress(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const key = optionalString(args.key);
  const keys = Array.isArray(args.keys) ? args.keys.map(String) : undefined;
  if (!key && (!keys || keys.length === 0)) return 'ERROR: Provide key or keys';
  emitActivity(ctx, 'cloud_desktop_keyboard_press', 'Keyboard press', key ?? keys?.join('+'));
  try {
    const { desktop } = await ensureFor(ctx);
    await desktop.keyboard.press(keys ?? (key as string));
    return `Pressed ${key ?? keys?.join('+')}.`;
  } catch (err) {
    return errorMessage('cloud_desktop_keyboard_press', err);
  }
}

export async function cloudDesktopKeyboardType(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const text = optionalString(args.text);
  if (!text) return 'ERROR: No text provided';
  emitActivity(ctx, 'cloud_desktop_keyboard_type', 'Keyboard type');
  try {
    const { desktop } = await ensureFor(ctx);
    await desktop.keyboard.type(text);
    return `Typed ${text.length} characters.`;
  } catch (err) {
    return errorMessage('cloud_desktop_keyboard_type', err);
  }
}

export async function cloudDesktopKeyboardHotkey(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  if (!Array.isArray(args.keys) || args.keys.length === 0) return 'ERROR: Provide keys array';
  const keys = args.keys.map(String);
  emitActivity(ctx, 'cloud_desktop_keyboard_hotkey', 'Keyboard hotkey', keys.join('+'));
  try {
    const { desktop } = await ensureFor(ctx);
    await desktop.keyboard.hotkey(...keys);
    return `Pressed hotkey ${keys.join('+')}.`;
  } catch (err) {
    return errorMessage('cloud_desktop_keyboard_hotkey', err);
  }
}

export async function cloudDesktopExec(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const command = optionalString(args.command);
  if (!command) return 'ERROR: No command provided';
  const cwd = optionalString(args.cwd);
  emitActivity(ctx, 'cloud_desktop_exec', 'Run command', command);
  try {
    const { desktop } = await ensureFor(ctx);
    const result = await desktop.exec(command, cwd ? { cwd } : undefined);
    return truncate(`exit: ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  } catch (err) {
    return errorMessage('cloud_desktop_exec', err);
  }
}

export async function cloudDesktopClipboardGet(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  emitActivity(ctx, 'cloud_desktop_clipboard_get', 'Read clipboard');
  try {
    const { desktop } = await ensureFor(ctx);
    return await desktop.clipboard.get();
  } catch (err) {
    return errorMessage('cloud_desktop_clipboard_get', err);
  }
}

export async function cloudDesktopClipboardSet(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const text = optionalString(args.text);
  if (!text) return 'ERROR: No text provided';
  emitActivity(ctx, 'cloud_desktop_clipboard_set', 'Write clipboard');
  try {
    const { desktop } = await ensureFor(ctx);
    await desktop.clipboard.set(text);
    return 'Clipboard set.';
  } catch (err) {
    return errorMessage('cloud_desktop_clipboard_set', err);
  }
}

export async function cloudDesktopFileWrite(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const path = optionalString(args.path);
  const content = optionalString(args.content);
  if (!path) return 'ERROR: No path provided';
  if (!content) return 'ERROR: No content provided';
  emitActivity(ctx, 'cloud_desktop_file_write', 'Write file', path);
  try {
    const { desktop } = await ensureFor(ctx);
    await desktop.fs.write(path, content);
    return `Wrote ${byteLength(content)} bytes to ${path}`;
  } catch (err) {
    return errorMessage('cloud_desktop_file_write', err);
  }
}

export async function cloudDesktopFileRead(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const path = optionalString(args.path);
  if (!path) return 'ERROR: No path provided';
  emitActivity(ctx, 'cloud_desktop_file_read', 'Read file', path);
  try {
    const { desktop } = await ensureFor(ctx);
    return truncate(await desktop.fs.readText(path));
  } catch (err) {
    return errorMessage('cloud_desktop_file_read', err);
  }
}

export async function cloudDesktopFileList(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const path = optionalString(args.path) ?? '/workspace';
  emitActivity(ctx, 'cloud_desktop_file_list', 'List files', path);
  try {
    const { desktop } = await ensureFor(ctx);
    const entries = await desktop.fs.list(path);
    if (entries.length === 0) return `Empty directory: ${path}`;
    return truncate(entries.map((e) => `${e.dir ? 'd' : '-'} ${e.name}`).join('\n'));
  } catch (err) {
    return errorMessage('cloud_desktop_file_list', err);
  }
}

export async function cloudDesktopSnapshot(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const label = optionalString(args.label) ?? 'manual';
  emitActivity(ctx, 'cloud_desktop_snapshot', 'Snapshot desktop', label);
  try {
    const snapshotId = await snapshotAgentComputer(label, resolveBotId(ctx));
    return `Snapshot captured (id: ${snapshotId}). Revert with cloud_desktop_revert.`;
  } catch (err) {
    return errorMessage('cloud_desktop_snapshot', err);
  }
}

export async function cloudDesktopRevert(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const snapshotId = optionalString(args.snapshot_id);
  emitActivity(ctx, 'cloud_desktop_revert', 'Revert desktop', snapshotId ?? 'last');
  try {
    await revertAgentComputer(resolveBotId(ctx), snapshotId);
    return `Desktop reverted${snapshotId ? ` to ${snapshotId}` : ' to the last snapshot'}.`;
  } catch (err) {
    return errorMessage('cloud_desktop_revert', err);
  }
}
