/* botToolHandlers — register bot_* ReAct tools and wrap ask_user / write_file
   for LazyBot missions.

   toolRuntime.ts dispatches through a mutable table (handlers/index.ts). This
   module adds bot_request_intervention / bot_handoff there at boot without
   owning that file, and remaps a bot's write_file into
   `.lazy/bot-deliverables/<botId>/`. ask_user on a bot mission also lights
   the manager-header intervention channel.
*/

import { on } from '../bus.js';
import { toolHandlers } from '../tools/handlers/index.js';
import type { ToolExecutionContext } from '../tools/handlers/types.js';
import { botIdForMission } from './botEngine.js';
import { handoffToBot } from './botHandoff.js';
import { maybeRequestInterventionForPage, requestUserIntervention } from './botRequestIntervention.js';
import { advanceCaptchaResume } from './botCaptchaResume.js';
import { getBot } from './botStorage.js';
import type { BotMissionInput } from './botTypes.js';
import { onCdpPageView } from '../solari/cdpBrowser.js';
import { missionIdForBrowserSession } from '../solari/solariSessions.js';
import {
  BOT_DELIVERABLES_DIR,
  remapBotCloudDeliverablePath,
  remapBotDeliverablePath,
} from './botDeliverablePaths.js';

export { BOT_DELIVERABLES_DIR, remapBotDeliverablePath, remapBotCloudDeliverablePath };

export interface BotToolContext {
  createMission: (input: BotMissionInput) => Promise<string>;
  defaultModel: () => string;
}

let toolContext: BotToolContext | null = null;
let registered = false;
let originalAskUser = toolHandlers.ask_user;
let originalWriteFile = toolHandlers.write_file;
let originalCloudDesktopWrite = toolHandlers.cloud_desktop_file_write;
let originalCloudSandboxWrite = toolHandlers.cloud_sandbox_write_file;
let offApproval: (() => void) | null = null;
let offCdpPageView: (() => void) | null = null;

export function setBotToolContext(ctx: BotToolContext): void {
  toolContext = ctx;
}

export async function handleBotRequestIntervention(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> {
  const reason = String(args.reason ?? args.question ?? 'help');
  const detail = typeof args.detail === 'string'
    ? args.detail
    : typeof args.question === 'string' ? args.question : undefined;
  const botId = botIdForMission(ctx.missionId) ?? String(args.bot_id ?? 'unknown');
  requestUserIntervention(botId, reason, detail);
  if (/captcha/i.test(reason)) {
    const { markCaptchaWaiting } = await import('./botCaptchaResume.js');
    markCaptchaWaiting(botId, detail ?? '');
  }
  return `Intervention requested (${reason}). The human was notified in the manager header — take over the live session, then continue. Poll/wait until the gate clears (captcha resume loop).`;
}

/** bot_wait_for_human — BLOCKING human gate. Unlike bot_request_intervention
 *  (fire-and-forget), this parks the tool call until the human clears the
 *  gate (or timeout): the classic Grok-style "needs you for login/2FA/
 *  captcha" pause. The wait polls the live page when a browser session is
 *  up (advanceCaptchaResume detects the gate gone); for desktop-only gates
 *  the human resolves it from the manager header note. */
export async function handleBotWaitForHuman(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> {
  const botId = botIdForMission(ctx.missionId);
  if (!botId) return 'ERROR: bot_wait_for_human is only available inside a LazyBot run.';
  const reason = String(args.reason ?? 'human input needed');
  const detail = typeof args.detail === 'string' ? args.detail : undefined;
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 300_000, 10_000), 1_800_000);
  requestUserIntervention(botId, reason, detail);
  const {
    waitForCaptchaClear,
    markCaptchaWaiting,
    getCaptchaResumeState,
  } = await import('./botCaptchaResume.js');
  const { getOutstandingIntervention } = await import('./botRequestIntervention.js');
  markCaptchaWaiting(botId, detail ?? reason);
  const { getBrowserSession } = await import('../solari/solariSessions.js');
  const hasPage = (): boolean => Boolean(getBrowserSession(ctx.missionId ?? '')?.browser.pages[0]);
  const state = hasPage()
    ? await waitForCaptchaClear(botId, {
        timeoutMs,
        intervalMs: 2_000,
        probe: async () => {
          const page = getBrowserSession(ctx.missionId ?? '')?.browser.pages[0];
          if (!page) return { title: '', url: '' };
          const [title, url] = await Promise.all([
            page.title().catch(() => ''),
            page.url().catch(() => ''),
          ]);
          return { title, url };
        },
      })
    // Desktop-only gate: no page to probe — wait until the human resolves
    // the intervention from the manager header (markCaptchaSolved) or timeout.
    : await (async () => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (getCaptchaResumeState(botId) === 'solved') return 'solved' as const;
          if (!getOutstandingIntervention(botId)) return 'clear' as const;
          await new Promise((r) => setTimeout(r, 2_000));
        }
        return getCaptchaResumeState(botId);
      })();
  if (state === 'waiting_human') {
    return `TIMEOUT: still waiting for the human after ${Math.round(timeoutMs / 1000)}s. ` +
      `Retry bot_wait_for_human to keep waiting, or continue if the gate cleared.`;
  }
  return `Human gate cleared (${state}) — the human finished the step; resume the task.`;
}

export async function handleBotHandoff(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> {
  if (!toolContext) return 'ERROR: bot_handoff is not wired — open the Bots space once to bind the mission factory.';
  const fromId = botIdForMission(ctx.missionId);
  if (!fromId) return 'ERROR: bot_handoff is only available inside a LazyBot run.';
  const fromBot = await getBot(fromId);
  if (!fromBot) return `ERROR: owning bot "${fromId}" not found.`;
  const to = String(args.to ?? args.bot_id ?? '');
  const task = String(args.task ?? '');
  if (!to || !task) return 'ERROR: bot_handoff requires {"to": "bot_id_or_name", "task": "..."}.';
  const result = await handoffToBot({
    fromBot,
    toBotIdOrName: to,
    task,
    context: typeof args.context === 'string' ? args.context : undefined,
    createMission: toolContext.createMission,
    model: String(args.model ?? toolContext.defaultModel()),
    blocking: args.blocking === true,
  });
  if (!result.success) return `ERROR: bot_handoff failed: ${result.error}`;
  const childReport = 'childReport' in result && result.childReport ? `\nChild report:\n${result.childReport}` : '';
  return `Handoff launched: ${result.childBot?.name} (${result.childRunId}).${childReport}`;
}

async function wrappedAskUser(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const result = await originalAskUser(args, ctx);
  const botId = botIdForMission(ctx.missionId);
  if (botId) requestUserIntervention(botId, 'ask_user', String(args.question ?? ''));
  return result;
}

async function wrappedWriteFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const botId = botIdForMission(ctx.missionId);
  if (!botId) return originalWriteFile(args, ctx);
  const path = String(args.path ?? '');
  return originalWriteFile({ ...args, path: remapBotDeliverablePath(botId, path) }, ctx);
}

async function wrappedCloudDesktopWrite(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const botId = botIdForMission(ctx.missionId);
  if (!botId) return originalCloudDesktopWrite(args, ctx);
  const path = String(args.path ?? '');
  return originalCloudDesktopWrite({ ...args, path: remapBotCloudDeliverablePath(botId, path) }, ctx);
}

async function wrappedCloudSandboxWrite(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const botId = botIdForMission(ctx.missionId);
  if (!botId) return originalCloudSandboxWrite(args, ctx);
  const path = String(args.path ?? '');
  return originalCloudSandboxWrite({ ...args, path: remapBotCloudDeliverablePath(botId, path) }, ctx);
}

function onCloudApproval(pending: { missionId: string; tool: string; page?: { url?: string } }): void {
  const botId = botIdForMission(pending.missionId);
  if (!botId) return;
  requestUserIntervention(botId, 'approval', pending.page?.url ? `${pending.tool} @ ${pending.page.url}` : pending.tool);
}

function onPageView(view: { sessionId: string; url: string; title: string }): void {
  const missionId = missionIdForBrowserSession(view.sessionId);
  const botId = botIdForMission(missionId);
  if (!botId) return;
  maybeRequestInterventionForPage(botId, view.title, view.url);
  advanceCaptchaResume(botId, view.title, view.url);
}

/** Idempotent. Safe to call from BotBootService and from the bot runtime. */
export function registerBotToolHandlers(): void {
  if (registered) return;
  registered = true;
  originalAskUser = toolHandlers.ask_user;
  originalWriteFile = toolHandlers.write_file;
  originalCloudDesktopWrite = toolHandlers.cloud_desktop_file_write;
  originalCloudSandboxWrite = toolHandlers.cloud_sandbox_write_file;
  toolHandlers.bot_request_intervention = handleBotRequestIntervention;
  toolHandlers.bot_wait_for_human = handleBotWaitForHuman;
  toolHandlers.bot_handoff = handleBotHandoff;
  toolHandlers.ask_user = wrappedAskUser;
  toolHandlers.write_file = wrappedWriteFile;
  toolHandlers.cloud_desktop_file_write = wrappedCloudDesktopWrite;
  toolHandlers.cloud_sandbox_write_file = wrappedCloudSandboxWrite;
  offApproval = on('solari:approvalRequest', onCloudApproval);
  offCdpPageView = onCdpPageView(onPageView);
}

/** Tests only — restores the dispatch table wrappers. */
export function resetBotToolHandlers(): void {
  if (!registered) return;
  toolHandlers.ask_user = originalAskUser;
  toolHandlers.write_file = originalWriteFile;
  toolHandlers.cloud_desktop_file_write = originalCloudDesktopWrite;
  toolHandlers.cloud_sandbox_write_file = originalCloudSandboxWrite;
  delete toolHandlers.bot_request_intervention;
  delete toolHandlers.bot_wait_for_human;
  delete toolHandlers.bot_handoff;
  offApproval?.();
  offApproval = null;
  offCdpPageView?.();
  offCdpPageView = null;
  registered = false;
  toolContext = null;
}
