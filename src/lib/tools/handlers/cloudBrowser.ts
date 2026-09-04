/* cloudBrowser.ts — cloud_* browser tool handlers. Each operates on the
   mission's Solari-hosted browser session (solariSessions.ts), keyed by
   ctx.missionId; they never run in the assistant chat or the LazyManager.
*/

import type { ToolExecutionContext } from './types.js';
import { emit } from '../../bus.js';
import { getSolariClients } from '../../solari/solariClient.js';
import {
  getBrowserSession,
  openBrowserSession,
  releaseBrowser,
} from '../../solari/solariSessions.js';
import {
  bytesToDataUrl,
  emitActivity,
  errorMessage,
  MISSION_REQUIRED,
  numberArg,
  optionalString,
  truncate,
} from './cloudShared.js';

/** The first open page in the mission's default context, or a fresh page. */
async function getSessionPage(missionId: string) {
  const session = getBrowserSession(missionId);
  if (!session) return undefined;
  const context = session.browser.contexts()[0];
  if (context && context.pages().length > 0) return context.pages()[0];
  return await session.browser.newPage();
}

function noSession(): string {
  return 'ERROR: no browser session — call cloud_browser_open first';
}

export async function cloudBrowserOpen(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  emitActivity(ctx, 'cloud_browser_open', 'Open cloud browser session');
  try {
    const { botIdForMission } = await import('../../bots/botEngine.js');
    const botId = botIdForMission(ctx.missionId);
    const handle = await openBrowserSession(ctx.missionId, {
      profileId: optionalString(args.profile_id),
      stealth: args.stealth === true,
      proxyCountry: optionalString(args.proxy_country),
      captcha: args.captcha === true,
      recording: args.recording === true,
      botId,
      // Persona profile sessions stay warm across missions (C49).
      longLived: Boolean(botId && optionalString(args.profile_id)),
    });
    return `Browser session opened (id: ${handle.sessionId}). Use cloud_browser_navigate to go to a URL.`;
  } catch (err) {
    return errorMessage('cloud_browser_open', err);
  }
}

export async function cloudBrowserClose(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  emitActivity(ctx, 'cloud_browser_close', 'Close cloud browser session');
  try {
    // Explicit close is always hard — user/model asked to destroy the session.
    await releaseBrowser(ctx.missionId, { hard: true });
    return 'Browser session closed.';
  } catch (err) {
    return errorMessage('cloud_browser_close', err);
  }
}

export async function cloudBrowserNavigate(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const url = optionalString(args.url);
  if (!url) return 'ERROR: No URL provided';
  emitActivity(ctx, 'cloud_browser_navigate', 'Navigate', url);
  try {
    const page = await getSessionPage(ctx.missionId);
    if (!page) return noSession();
    await page.goto(url);
    const title = await page.title();
    const shot = await page.screenshot();
    emit('browser:stateChange', {
      isOpen: true,
      url,
      title,
      lastAction: 'cloud_browser_navigate',
      lastActionAt: Date.now(),
      screenshotDataUrl: bytesToDataUrl(shot),
      missionId: ctx.missionId,
    });
    return `Navigated to ${url} — title: ${title}`;
  } catch (err) {
    return errorMessage('cloud_browser_navigate', err);
  }
}

export async function cloudBrowserReadPage(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  emitActivity(ctx, 'cloud_browser_read_page', 'Read page');
  try {
    const page = await getSessionPage(ctx.missionId);
    if (!page) return noSession();
    return truncate(await page.content());
  } catch (err) {
    return errorMessage('cloud_browser_read_page', err);
  }
}
export async function cloudBrowserClick(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const selector = optionalString(args.selector);
  const text = optionalString(args.text);
  if (!selector && !text) return 'ERROR: Provide selector or text';
  emitActivity(ctx, 'cloud_browser_click', 'Click', selector ?? text);
  try {
    const page = await getSessionPage(ctx.missionId);
    if (!page) return noSession();
    if (selector) {
      await page.click(selector);
    } else {
      await page.getByText(text as string).click();
    }
    const shot = await page.screenshot();
    const url = await page.url();
    const title = await page.title().catch(() => '');
    emit('browser:stateChange', {
      isOpen: true,
      url,
      title,
      lastAction: 'cloud_browser_click',
      lastActionAt: Date.now(),
      screenshotDataUrl: bytesToDataUrl(shot),
      missionId: ctx.missionId,
    });
    return `Clicked ${selector ?? text}`;
  } catch (err) {
    return errorMessage('cloud_browser_click', err);
  }
}

export async function cloudBrowserType(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const selector = optionalString(args.selector);
  const value = optionalString(args.value);
  if (!selector) return 'ERROR: No selector provided';
  if (!value) return 'ERROR: No value provided';
  emitActivity(ctx, 'cloud_browser_type', 'Type', selector);
  try {
    const page = await getSessionPage(ctx.missionId);
    if (!page) return noSession();
    await page.fill(selector, value);
    return `Filled ${selector} with "${value}"`;
  } catch (err) {
    return errorMessage('cloud_browser_type', err);
  }
}

export async function cloudBrowserScreenshot(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  emitActivity(ctx, 'cloud_browser_screenshot', 'Screenshot');
  try {
    const page = await getSessionPage(ctx.missionId);
    if (!page) return noSession();
    const shot = await page.screenshot({ fullPage: args.full_page === true });
    const url = await page.url();
    const title = await page.title();
    emit('browser:stateChange', {
      isOpen: true,
      url,
      title,
      lastAction: 'cloud_browser_screenshot',
      lastActionAt: Date.now(),
      screenshotDataUrl: bytesToDataUrl(shot),
    });
    return `Screenshot captured — ${url}`;
  } catch (err) {
    return errorMessage('cloud_browser_screenshot', err);
  }
}

export async function cloudBrowserScroll(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const dx = numberArg(args.dx, 0);
  const dy = numberArg(args.dy, 0);
  if (dx === 0 && dy === 0) return 'ERROR: Provide dx or dy';
  emitActivity(ctx, 'cloud_browser_scroll', 'Scroll', `(${dx}, ${dy})`);
  try {
    const page = await getSessionPage(ctx.missionId);
    if (!page) return noSession();
    await page.mouse.wheel(dx, dy);
    const shot = await page.screenshot();
    const url = await page.url();
    const title = await page.title().catch(() => '');
    emit('browser:stateChange', {
      isOpen: true,
      url,
      title,
      lastAction: 'cloud_browser_scroll',
      lastActionAt: Date.now(),
      screenshotDataUrl: bytesToDataUrl(shot),
      missionId: ctx.missionId,
    });
    return `Scrolled by (${dx}, ${dy})`;
  } catch (err) {
    return errorMessage('cloud_browser_scroll', err);
  }
}
export async function cloudBrowserWait(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const selector = optionalString(args.selector);
  const ms = numberArg(args.ms, 0);
  if (!selector && ms === 0) return 'ERROR: Provide selector or ms';
  emitActivity(ctx, 'cloud_browser_wait', 'Wait', selector ?? `${ms}ms`);
  try {
    const page = await getSessionPage(ctx.missionId);
    if (!page) return noSession();
    if (selector) {
      await page.waitForSelector(selector, { timeout: numberArg(args.timeout, 30000) });
      return `Waited for ${selector}`;
    }
    await page.waitForTimeout(ms);
    return `Waited ${ms}ms`;
  } catch (err) {
    return errorMessage('cloud_browser_wait', err);
  }
}

export async function cloudBrowserReplayUrl(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  emitActivity(ctx, 'cloud_browser_replay_url', 'Get replay URL');
  try {
    const session = getBrowserSession(ctx.missionId);
    if (!session) return noSession();
    const clients = await getSolariClients();
    const replay = await clients.browser.sessions.getReplayUrl(session.sessionId);
    return replay.url;
  } catch (err) {
    return errorMessage('cloud_browser_replay_url', err);
  }
}

export async function cloudBrowserProfilesList(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  emitActivity(ctx, 'cloud_browser_profiles_list', 'List browser profiles');
  try {
    const clients = await getSolariClients();
    const profiles = await clients.browser.profiles.list();
    if (profiles.length === 0) return 'No saved browser profiles.';
    return profiles.map((p) => `- ${p.name} (${p.id})`).join('\n');
  } catch (err) {
    return errorMessage('cloud_browser_profiles_list', err);
  }
}

export async function cloudBrowserProfileSave(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  if (!ctx.missionId) return MISSION_REQUIRED;
  const profileId = optionalString(args.profile_id);
  if (!profileId) return 'ERROR: No profile_id provided';
  emitActivity(ctx, 'cloud_browser_profile_save', 'Save browser profile', profileId);
  try {
    const page = await getSessionPage(ctx.missionId);
    if (!page) return noSession();
    const storageState = await page.context().storageState();
    const clients = await getSolariClients();
    await clients.browser.profiles.save(profileId, storageState);
    return `Saved current session storage state to profile ${profileId}.`;
  } catch (err) {
    return errorMessage('cloud_browser_profile_save', err);
  }
}
