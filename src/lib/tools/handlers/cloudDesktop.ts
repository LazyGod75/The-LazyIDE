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
  type AgentComputerHandle,
} from '../../solari/solariSessions.js';
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
  emitActivity(ctx, 'cloud_desktop_mouse_click', 'Mouse click', `(${x}, ${y})`);
  try {
    const { desktop } = await ensureFor(ctx);
    await desktop.mouse.click(x, y, { button });
    return `Clicked at (${x}, ${y}).`;
  } catch (err) {
    return errorMessage('cloud_desktop_mouse_click', err);
  }
}

export async function cloudDesktopMouseMove(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const x = numberArg(args.x);
  const y = numberArg(args.y);
  emitActivity(ctx, 'cloud_desktop_mouse_move', 'Mouse move', `(${x}, ${y})`);
  try {
    const { desktop } = await ensureFor(ctx);
    await desktop.mouse.move(x, y);
    return `Moved mouse to (${x}, ${y}).`;
  } catch (err) {
    return errorMessage('cloud_desktop_mouse_move', err);
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
