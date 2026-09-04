/* managerLazyBotFallback — deterministic last resort for "lance le bot X".

   Live repro (2026-09-02, DeepSeek then MiniMax as the LazyManager model):
   the user asked to run the Solari bot "SolariTest" on https://example.com,
   the model REPLIED "Je lance maintenant SolariTest sur https://example.com
   via le navigateur cloud Solari." — and emitted no <lazy_actions> block.
   The PROMISE-STALL nudge (LAYER 1) and the extraction repair call (LAYER 2)
   both ran the SAME weak model again and both came back prose-only, so the
   turn ended on the honest "[system] No executable action was emitted"
   notice. Honest, but the founder's requirement is that LazyBots run
   regardless of which model drives the manager (BYOK, CLI, LazyPro).

   This LAYER 3 does not ask the model anything: when (a) the turn already
   failed through LAYER 1 + LAYER 2, (b) the USER's own message carries a
   run verb, and (c) that message (or the model's own announcement) names a
   saved LazyBot unambiguously, it reconstructs the one action the user
   asked for — run_lazybot with the bot's real id and the user's request as
   the task. The action then flows through the ordinary action gate exactly
   like a model-emitted one (approval card in supervised/manual autonomy),
   and the reply carries an explicit notice saying the action was
   reconstructed, never pretending the model emitted it.

   Deliberately narrow: no run verb → nothing; two bots plausibly named →
   nothing (never guess between bots); a generic "le bot" wording only
   resolves when exactly ONE enabled bot exists.
*/

import type { LazyBotSummary } from '../bots/botManagerContext.js';
import type { ManagerAction } from './types.js';

/** FR/EN run verbs a user writes when asking a bot to do something. Kept
 *  strict (whole words) so "pourquoi le bot a échoué ?" never matches. */
const RUN_VERB_RE =
  /(?:^|[^a-zà-ÿ])(?:lance|lances|lancer|relance|relancer|d[ée]marre|d[ée]marrer|ex[ée]cute|ex[ée]cuter|fais tourner|fait tourner|utilise|utiliser|envoie|envoyer|run|launch|start|execute|trigger|kick off|fire up)(?:$|[^a-zà-ÿ])/i;

/** Generic bot wording — only ever used when a single enabled bot exists. */
const GENERIC_BOT_RE = /(?:^|[^a-z])(?:lazy ?bots?|bots?)(?:$|[^a-z])/i;

/** Longest task forwarded to the bot — a pasted transcript must not become
 *  a novel-length mission prompt. */
export const MAX_LAZYBOT_FALLBACK_TASK_CHARS = 4000;

export interface LazyBotRunIntent {
  bot: LazyBotSummary;
  task: string;
  matchedBy: 'id' | 'name' | 'only-bot';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeLoose(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function mentionsBot(text: string, bot: LazyBotSummary): 'id' | 'name' | undefined {
  if (bot.id.length >= 4 && text.toLowerCase().includes(bot.id.toLowerCase())) return 'id';
  const name = bot.name.trim();
  if (name.length < 3) return undefined;
  const wordRe = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(name)}(?:$|[^a-z0-9])`, 'i');
  if (wordRe.test(text)) return 'name';
  // "solari-test" / "solari test" → "SolariTest": loose form, but only for
  // names long enough that a substring hit is not a coincidence.
  const loose = normalizeLoose(name);
  if (loose.length >= 6 && normalizeLoose(text).includes(loose)) return 'name';
  return undefined;
}

/**
 * Reads the user's request (primary) and the model's announced prose
 * (secondary, only to find WHICH bot) and returns the single bot run the
 * user asked for, or undefined when the situation is not unambiguous.
 */
export function detectLazyBotRunIntent(
  userText: string,
  announcedText: string,
  bots: readonly LazyBotSummary[] | undefined,
): LazyBotRunIntent | undefined {
  if (!bots || bots.length === 0) return undefined;
  const user = typeof userText === 'string' ? userText.trim() : '';
  if (user.length === 0 || !RUN_VERB_RE.test(user)) return undefined;
  const announced = typeof announcedText === 'string' ? announcedText : '';
  const task = user.slice(0, MAX_LAZYBOT_FALLBACK_TASK_CHARS);

  const inUser = bots
    .map((bot) => ({ bot, by: mentionsBot(user, bot) }))
    .filter((m): m is { bot: LazyBotSummary; by: 'id' | 'name' } => m.by !== undefined);
  if (inUser.length === 1) return { bot: inUser[0].bot, task, matchedBy: inUser[0].by };
  if (inUser.length > 1) return undefined;

  const inAnnounced = bots
    .map((bot) => ({ bot, by: mentionsBot(announced, bot) }))
    .filter((m): m is { bot: LazyBotSummary; by: 'id' | 'name' } => m.by !== undefined);
  if (inAnnounced.length === 1) return { bot: inAnnounced[0].bot, task, matchedBy: inAnnounced[0].by };
  if (inAnnounced.length > 1) return undefined;

  if (GENERIC_BOT_RE.test(user)) {
    const enabled = bots.filter((b) => b.enabled);
    if (enabled.length === 1) return { bot: enabled[0], task, matchedBy: 'only-bot' };
  }
  return undefined;
}

export function buildLazyBotRunAction(intent: LazyBotRunIntent): ManagerAction {
  return { type: 'run_lazybot', botId: intent.bot.id, task: intent.task };
}

/** The user-visible notice that replaces the generic "nothing was done"
 *  failure notice when LAYER 3 reconstructed the action — the model's
 *  own text stays alongside it, exactly as for the failure notice. */
export function formatLazyBotFallbackNotice(locale: string | undefined, botName: string): string {
  return locale?.toLowerCase().startsWith('fr')
    ? `[système] Le modèle n'a pas émis d'action exploitable — l'action run_lazybot pour « ${botName} » a été reconstruite à partir de ta demande.`
    : `[system] The model emitted no executable action — the run_lazybot action for "${botName}" was reconstructed from your request.`;
}

const STOP_MISSION_RE = /(?:arr[êe]te|stoppe|stop|annule|cancel|kill)\s+(?:la\s+)?(?:mission\s+)?(M\d+)\b/i;
const STOP_BOT_VERB_RE = /(?:arr[êe]te|stoppe|stop|annule|cancel)\s+(?:le\s+|la\s+)?(?:bot|lazybot)\b/i;
const CREATE_BOT_RE = /(?:cr[ée]e|create|ajoute|add)\s+(?:un\s+|le\s+|a\s+)?(?:nouveau\s+|new\s+)?(?:bot|lazybot)\s+(?:named\s+|nomm[ée]e?\s+|appel[ée]e?\s+)?["']?([A-Za-z][\w-]{2,30})/i;
const LAUNCH_MISSION_RE = /(?:lance|lancer|launch|start|d[ée]marre)\s+(?:une\s+|la\s+|a\s+)?mission\b/i;

function uniquelyNamedBot(
  text: string,
  bots: readonly LazyBotSummary[],
): LazyBotSummary | undefined {
  const named = bots
    .map((bot) => ({ bot, by: mentionsBot(text, bot) }))
    .filter((m): m is { bot: LazyBotSummary; by: 'id' | 'name' } => m.by !== undefined);
  return named.length === 1 ? named[0].bot : undefined;
}

/**
 * LAYER 3 for any unambiguous imperative — run/stop/create a bot or
 * stop/launch a mission. Conservative: two plausible bots → nothing;
 * a vague "lance une mission" without a task → nothing.
 */
export function detectDeterministicManagerAction(
  userText: string,
  announcedText: string,
  bots: readonly LazyBotSummary[] | undefined,
): ManagerAction | undefined {
  const runIntent = detectLazyBotRunIntent(userText, announcedText, bots);
  if (runIntent) return buildLazyBotRunAction(runIntent);

  const user = typeof userText === 'string' ? userText.trim() : '';
  if (!user) return undefined;

  const stopMission = user.match(STOP_MISSION_RE);
  if (stopMission?.[1]) return { type: 'stop_mission', missionId: stopMission[1] };

  if (STOP_BOT_VERB_RE.test(user) && bots && bots.length > 0) {
    const named = uniquelyNamedBot(user, bots);
    if (named) return { type: 'stop_lazybot', botId: named.id };
    const enabled = bots.filter((b) => b.enabled);
    if (GENERIC_BOT_RE.test(user) && enabled.length === 1) {
      return { type: 'stop_lazybot', botId: enabled[0].id };
    }
  }

  const created = user.match(CREATE_BOT_RE);
  if (created?.[1]) return { type: 'create_lazybot', name: created[1], systemPrompt: '' };

  if (bots && bots.length > 0 && /(?:modifie|update|change)\s+(?:le\s+)?(?:bot|lazybot)\b/i.test(user)) {
    const named = uniquelyNamedBot(user, bots);
    if (named) {
      if (/\b(disable|d[ée]sactive|pause)\b/i.test(user)) {
        return { type: 'update_lazybot', botId: named.id, patch: { enabled: false } };
      }
      if (/\b(enable|active|r[ée]active)\b/i.test(user)) {
        return { type: 'update_lazybot', botId: named.id, patch: { enabled: true } };
      }
    }
  }

  if (LAUNCH_MISSION_RE.test(user) && !GENERIC_BOT_RE.test(user)) {
    const taskMatch = user.match(/mission\s+(?:pour\s+|to\s+|de\s+)?(.{12,400})/i);
    const task = taskMatch?.[1]?.trim();
    if (task) return { type: 'launch_mission', task };
  }

  return undefined;
}

export function formatDeterministicFallbackNotice(locale: string | undefined, action: ManagerAction): string {
  const fr = locale?.toLowerCase().startsWith('fr');
  if (action.type === 'run_lazybot') {
    return formatLazyBotFallbackNotice(locale, action.botId);
  }
  const label = action.type;
  return fr
    ? `[système] Le modèle n'a pas émis d'action exploitable — l'action ${label} a été reconstruite à partir de ta demande.`
    : `[system] The model emitted no executable action — the ${label} action was reconstructed from your request.`;
}
