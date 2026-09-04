/* botCaptchaResume — captcha / human-gate resume loop for LazyBots (C59).

   Solari can auto-solve some captchas when launch.captcha=true, but many
   sites still need a human. This module tracks outstanding captcha gates per
   bot and exposes a resume signal the ReAct loop / takeover UI can poll so
   the bot continues AFTER the human (or Solari solver) clears the page —
   rather than treating "captcha detected" as a terminal flag.
*/

import { detectHumanGate, clearIntervention, getOutstandingIntervention } from './botRequestIntervention.js';

export type CaptchaResumeState = 'clear' | 'waiting_human' | 'solved';

const waiting = new Map<string, { url: string; at: number }>();
const solvedAt = new Map<string, number>();

/** Record that a bot hit a captcha/login wall and is waiting for takeover. */
export function markCaptchaWaiting(botId: string, url: string): void {
  waiting.set(botId, { url, at: Date.now() });
  solvedAt.delete(botId);
}

/** Human (or solver) cleared the gate — bot may resume tools. */
export function markCaptchaSolved(botId: string): void {
  waiting.delete(botId);
  solvedAt.set(botId, Date.now());
  clearIntervention(botId);
}

export function getCaptchaResumeState(botId: string): CaptchaResumeState {
  if (waiting.has(botId)) return 'waiting_human';
  if (solvedAt.has(botId)) return 'solved';
  return 'clear';
}

/**
 * Inspect a live page: if it is still a human gate, keep waiting; if it was
 * waiting and the page is now ordinary, mark solved and return 'solved'.
 */
export function advanceCaptchaResume(
  botId: string,
  title: string,
  url: string,
  extra?: string,
): CaptchaResumeState {
  const gate = detectHumanGate(title, url, extra);
  if (gate === 'captcha' || gate === 'login' || gate === '2fa') {
    markCaptchaWaiting(botId, url);
    return 'waiting_human';
  }
  if (waiting.has(botId) || getOutstandingIntervention(botId)?.reason === 'captcha') {
    markCaptchaSolved(botId);
    return 'solved';
  }
  return getCaptchaResumeState(botId);
}

export interface WaitForCaptchaClearOpts {
  /** Probe the live page (title/url/extra). Called on each poll tick. */
  probe: () => { title: string; url: string; extra?: string } | Promise<{ title: string; url: string; extra?: string }>;
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Poll until the captcha/login wall clears (or timeout). Use after
 * bot_request_intervention / takeover so the ReAct loop can resume tools
 * instead of treating the gate as terminal (C59).
 */
export async function waitForCaptchaClear(
  botId: string,
  opts: WaitForCaptchaClearOpts,
): Promise<CaptchaResumeState> {
  const intervalMs = opts.intervalMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (opts.signal?.aborted) return getCaptchaResumeState(botId);
    const view = await opts.probe();
    const state = advanceCaptchaResume(botId, view.title, view.url, view.extra);
    if (state === 'solved' || state === 'clear') return state;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
  return getCaptchaResumeState(botId);
}

export function resetCaptchaResume(): void {
  waiting.clear();
  solvedAt.clear();
}
