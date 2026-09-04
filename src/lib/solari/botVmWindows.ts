/* botVmWindows.ts — which LazyBots currently show their connected VM window as
   a canvas node (`botVm:<botId>`). A plain module-level Set + bus events so the
   bot node's ▶ VM toggle and the reconciler/canvas stay decoupled. Ephemeral
   UI state (not persisted) — reopening the app starts with every window closed.
*/

import { emit, on } from '../bus.js';

// Vite dev mode can create multiple module instances (see bus.ts's
// GLOBAL_KEY comment for the full explanation). The `open` Set and `sizes`
// Map must be shared across all instances, so we pin them on globalThis.
const GLOBAL_OPEN_KEY = '__lazyBotVmOpen';
const GLOBAL_SIZES_KEY = '__lazyBotVmSizes';
function getOpenSet(): Set<string> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_OPEN_KEY]) g[GLOBAL_OPEN_KEY] = new Set<string>();
  return g[GLOBAL_OPEN_KEY] as Set<string>;
}
function getSizesMap(): Map<string, { width: number; height: number }> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_SIZES_KEY]) g[GLOBAL_SIZES_KEY] = new Map<string, { width: number; height: number }>();
  return g[GLOBAL_SIZES_KEY] as Map<string, { width: number; height: number }>;
}
const open = getOpenSet();
const sizes = getSizesMap();
export const BOT_VM_WINDOWS_CHANGED = 'botVmWindows:changed';

export interface BotVmWindowSize {
  width: number;
  height: number;
}

export const BOT_VM_WINDOW_DEFAULT_SIZE: BotVmWindowSize = { width: 520, height: 400 };

/** True while the bot's VM window node is shown on the canvas. */
export function isBotVmWindowOpen(botId: string): boolean {
  return open.has(botId);
}

/** Persisted window size (user NodeResizer resizes survive canvas re-renders). */
export function getBotVmWindowSize(botId: string): BotVmWindowSize {
  return sizes.get(botId) ?? BOT_VM_WINDOW_DEFAULT_SIZE;
}

/** Toggle the bot's canvas VM window on/off. */
export function toggleBotVmWindow(botId: string): void {
  if (open.has(botId)) open.delete(botId);
  else open.add(botId);
  emit(BOT_VM_WINDOWS_CHANGED, { botId, open: open.has(botId) });
}

/** Open the bot's canvas VM window — idempotent (never closes an already-open
 *  window). Used by runLazyBotMission to auto-open the connected VM view the
 *  instant a bot mission starts running, mirroring how a local agent's dev
 *  server auto-adds a preview node: the user sees the bot's live session
 *  without having to click "▶ VM" first. Returns true if this call actually
 *  opened the window (false when it was already open). */
export function openBotVmWindow(botId: string): boolean {
  if (open.has(botId)) return false;
  open.add(botId);
  emit(BOT_VM_WINDOWS_CHANGED, { botId, open: true });
  return true;
}

/** Record a user resize (NodeResizer onResizeEnd). */
export function setBotVmWindowSize(botId: string, width: number, height: number): void {
  sizes.set(botId, { width: Math.round(width), height: Math.round(height) });
}

/** Subscribe to window open/close changes. Returns an unsubscribe fn. */
export function subscribeBotVmWindows(
  cb: (info: { botId: string; open: boolean }) => void,
): () => void {
  return on(BOT_VM_WINDOWS_CHANGED, cb);
}

/** Test-only reset. */
export function resetBotVmWindows(): void {
  open.clear();
  sizes.clear();
}

/** Test-only accessor — the set of bot ids whose VM window is open. */
export function _openBotVmWindowsForTests(): ReadonlySet<string> {
  return open;
}
