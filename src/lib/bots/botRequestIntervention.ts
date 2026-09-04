/* botRequestIntervention — LazyBot → LazyManager human-intervention channel.

   A running bot uses this to ask the human to take over when it hits a step
   only a person can complete (login, 2FA, captcha, account takeover, a
   payment confirmation, ...). Emits a bus event on 'bot:intervention'; the
   LazyManager UI subscribes and surfaces the outstanding request (see
   LazyManagerHeader.tsx's data-testid="bot-intervention-<botId>" note).

   The bot run keeps running while the request is outstanding — the human
   answers by taking over the live browser/desktop session, or by asking the
   LazyManager to stop the bot run (stop_lazybot). This module deliberately
   has no knowledge of the agent loop: it is the single, tiny choke point a
   bot runtime calls, keeping the messaging contract one exported function.
*/

import { emit } from '../bus.js';

export type HumanGateKind = 'login' | '2fa' | 'captcha';

export interface BotIntervention {
  botId: string;
  reason: string;
  detail?: string;
  at: number;
}

const outstanding = new Map<string, BotIntervention>();

const CAPTCHA_RE = /captcha|recaptcha|hcaptcha|turnstile|just a moment|are you a robot|cdn-cgi\/challenge|bot check/i;
const TWOFA_RE = /two[\s-]?factor|2fa|\botp\b|verification code|\/2fa\b|\/verify/i;
const LOGIN_RE = /sign[\s-]?in|log[\s-]?in|authentif|accounts\.google|\/login|\/signin/i;

/** Classify a live page as a human-only gate, or null for ordinary pages. */
export function detectHumanGate(title: string, url: string, extra?: string): HumanGateKind | null {
  const hay = `${title}\n${url}\n${extra ?? ''}`;
  if (CAPTCHA_RE.test(hay)) return 'captcha';
  if (TWOFA_RE.test(hay)) return '2fa';
  if (LOGIN_RE.test(hay)) return 'login';
  return null;
}

/** Ask the human to intervene on a running bot (e.g. a login/2FA/takeover).
 *  Pure signal: never blocks, never throws, never mutates bot config. */
export function requestUserIntervention(botId: string, reason: string, detail?: string): void {
  try {
    const payload: BotIntervention = { botId, reason, detail, at: Date.now() };
    outstanding.set(botId, payload);
    emit('bot:intervention', payload);
    console.info(`[bot:intervention] ${botId}: ${reason}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    console.warn('[bot:intervention] emit failed', err);
  }
}

/** Detect a human gate on a live page and, if any, request intervention. */
export function maybeRequestInterventionForPage(
  botId: string,
  title: string,
  url: string,
  extra?: string,
): HumanGateKind | null {
  const kind = detectHumanGate(title, url, extra);
  if (kind) requestUserIntervention(botId, kind, url);
  return kind;
}

/** Outstanding intervention for a bot, if any. */
export function getOutstandingIntervention(botId: string): BotIntervention | undefined {
  return outstanding.get(botId);
}

export function listOutstandingInterventions(): BotIntervention[] {
  return [...outstanding.values()];
}

export function clearIntervention(botId: string): void {
  outstanding.delete(botId);
}

/** Tests and hot-reload only. */
export function resetInterventions(): void {
  outstanding.clear();
}
