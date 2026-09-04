/* botVmState — live state subscription for a LazyBot's Solari VM/session.

   A bot working on Solari produces continuous state signals: browser
   screenshots + URL via the existing `browser:stateChange` bus event, and a
   desktop noVNC stream via the desktop SDK's `stream.start()`. This module is
   the single choke point a UI (BotVmSurface) subscribes to, keeping the
   component dumb. Never imports the Solari SDK eagerly (see solariClient.ts's
   dynamic-import pattern).

   C77: state is keyed by botId. Global browser:stateChange events are only
   forwarded to subscribers of the bot that owns the active mission's session.
   C78: BotVmSurface is the canonical live view; BotVmHost / BotsSpace embed
   the same surface. openDesktopStream is a process-wide singleton so multiple
   hosts never open parallel noVNC sessions.
*/

import { on } from '../bus.js';
import { ensureAgentComputer, getBrowserSession, missionIdForBrowserSession } from './solariSessions.js';
import { botIdForMission, listActiveRunsForBot } from '../bots/botEngine.js';
import type { CdpPage } from './cdpBrowser.js';

export interface BotVmState {
  botId?: string;
  mode: 'browser' | 'desktop';
  url?: string;
  title?: string;
  screenshotDataUrl?: string;
  streamUrl?: string;
  lastAction?: string;
  lastActionAt?: number;
}

const lastStateByBot = new Map<string, BotVmState>();

function resolveBotIdFromBrowserPayload(payload: {
  missionId?: string;
  sessionId?: string;
  botId?: string;
}): string | undefined {
  if (payload.botId) return payload.botId;
  if (payload.missionId) return botIdForMission(payload.missionId);
  if (payload.sessionId) {
    const mid = missionIdForBrowserSession(payload.sessionId);
    return botIdForMission(mid);
  }
  return undefined;
}

/** Subscribe to a bot's live VM/browser state. Returns an unsubscribe fn.
 *  Only events attributable to `botId` (or unmatched legacy events while
 *  this bot has the only active run) are delivered. */
export function subscribeBotVmState(botId: string, cb: (s: BotVmState) => void): () => void;
/** @deprecated Prefer subscribeBotVmState(botId, cb) — global fan-out (pre-C77). */
export function subscribeBotVmState(cb: (s: BotVmState) => void): () => void;
export function subscribeBotVmState(
  botIdOrCb: string | ((s: BotVmState) => void),
  maybeCb?: (s: BotVmState) => void,
): () => void {
  const botId = typeof botIdOrCb === 'string' ? botIdOrCb : undefined;
  const cb = typeof botIdOrCb === 'function' ? botIdOrCb : maybeCb!;
  return on('browser:stateChange', (payload) => {
    const owner = resolveBotIdFromBrowserPayload(payload);
    if (botId) {
      if (owner && owner !== botId) return;
      if (!owner) {
        // Legacy payloads without mission/session: only deliver while this bot
        // has at least one active run (avoids cross-talk when 2+ bots run).
        if (listActiveRunsForBot(botId).length === 0) return;
      }
    }
    const next: BotVmState = {
      botId: owner ?? botId,
      mode: 'browser',
      url: payload.url || undefined,
      title: payload.title || undefined,
      screenshotDataUrl: payload.screenshotDataUrl,
      lastAction: payload.lastAction,
      lastActionAt: payload.lastActionAt,
    };
    if (botId) lastStateByBot.set(botId, next);
    cb(next);
  });
}

export function getLastBotVmState(botId: string): BotVmState | undefined {
  return lastStateByBot.get(botId);
}

/** Result of requesting the shared Agent Computer's live noVNC stream. */
export type DesktopStreamResult =
  | { streamUrl: string; token?: string }
  | { error: string };

let sharedDesktopStream: Promise<DesktopStreamResult> | null = null;
let sharedDesktopStreamValue: Extract<DesktopStreamResult, { streamUrl: string }> | null = null;

/** Start (or reuse) the Agent Computer's live noVNC stream — one stream for
 *  every BotVmSurface / BotVmHost / BotsSpace embed (C78). Optional botId
 *  selects that bot's desktop when C50 isolation is active. */
export async function openDesktopStream(botId?: string): Promise<DesktopStreamResult> {
  if (sharedDesktopStreamValue) return sharedDesktopStreamValue;
  if (sharedDesktopStream) return sharedDesktopStream;
  sharedDesktopStream = (async () => {
    try {
      const { desktop } = await ensureAgentComputer(botId);
      const stream = await desktop.stream.start();
      const value = { streamUrl: stream.streamUrl, token: stream.token };
      sharedDesktopStreamValue = value;
      return value;
    } catch (err) {
      sharedDesktopStream = null;
      return { error: err instanceof Error ? err.message : String(err) };
    }
  })();
  return sharedDesktopStream;
}

/** Tests / hot-reload — drop the shared stream cache. */
export function resetDesktopStreamState(): void {
  sharedDesktopStream = null;
  sharedDesktopStreamValue = null;
}

export interface BrowserTakeover {
  page: CdpPage;
  stop: () => void;
}

function firstLivePage(botId: string): CdpPage | undefined {
  for (const run of listActiveRunsForBot(botId)) {
    const session = getBrowserSession(run.missionId);
    const page = session?.browser.pages[0];
    if (page) return page;
  }
  return undefined;
}

/** CDP takeover of the bot's live browser (login/2FA/captcha) — not noVNC. */
export async function openBrowserTakeover(botId: string): Promise<BrowserTakeover | { error: string }> {
  const page = firstLivePage(botId);
  if (!page) return { error: 'No live browser session for this bot — wait until it opens a page, or use desktop takeover.' };
  return {
    page,
    stop: () => { void page.close(); },
  };
}

/** C78 — single source of truth for the live VM view + stream. */
export const BOT_VM_HOST_CANONICAL =
  'BotVmSurface (canvas LazyBotNode) is the canonical VM host with a single shared stream; floating BotVmHost / BotsSpace embed it, never open a second stream.';
