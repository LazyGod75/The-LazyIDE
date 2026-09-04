/* botManagerContext — the LazyManager's per-turn view of the saved LazyBots.

   Pure helpers, no storage and no Tauri: agentsStore.tsx builds the
   summaries from listBots() + getBotRuntimeState(), buildManagerDynamicContext
   (managerEngine.ts) renders them into the system prompt every turn, the
   LAYER 2 repair call reuses the same rendering so it can fill "botId", and
   the deterministic LazyBot fallback (managerLazyBotFallback.ts) resolves the
   user's own wording against the same list.

   Why this exists (live repro, 2026-09-02, DeepSeek / MiniMax as manager
   model): run_lazybot REQUIRES the bot's real id ("bot_..."), but nothing in
   the per-turn context ever listed the saved bots — the model had to chain
   list_lazybots → grounded follow-up → run_lazybot, and weaker models kept
   announcing "Je lance SolariTest..." in prose without ever emitting the
   block. Putting the ids in front of the model every turn (and accepting the
   bot's NAME as a reference) removes the two-step dance entirely.
*/

import type { BotConfig } from './botTypes.js';
import type { BotLastTime } from './botRuntimeStore.js';

export interface LazyBotSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  autonomy: BotConfig['autonomy'];
  /** Enabled cloud capabilities, e.g. ['browser'] or ['browser', 'sandbox']. */
  capabilities: string[];
  /** Currently running missions for this bot (botEngine runtime state). */
  activeRuns: number;
  /** Optional "last time this bot found X" for manager digest (D97). */
  lastTime?: BotLastTime;
}

export function summarizeLazyBot(
  bot: BotConfig,
  activeRuns: number,
  lastTime?: BotLastTime,
): LazyBotSummary {
  const caps: string[] = [];
  if (bot.capabilities?.browser) caps.push('browser');
  if (bot.capabilities?.desktop) caps.push('desktop');
  if (bot.capabilities?.sandbox) caps.push('sandbox');
  return {
    id: bot.id,
    name: bot.name,
    description: bot.description ?? '',
    enabled: bot.enabled !== false,
    autonomy: bot.autonomy,
    capabilities: caps,
    activeRuns,
    ...(lastTime ? { lastTime } : {}),
  };
}

/** One line per bot, ids first so a model copying the line gets the exact
 *  id run_lazybot/stop_lazybot/update_lazybot need. */
export function formatLazyBotLines(bots: readonly LazyBotSummary[]): string[] {
  return bots.map((b) => {
    const caps = b.capabilities.length > 0 ? b.capabilities.join('+') : 'no cloud capability';
    const desc = b.description.trim().length > 0 ? ` — ${b.description.trim().slice(0, 80)}` : '';
    const last = b.lastTime
      ? ` · last: ${b.lastTime.report.trim().slice(0, 80) || b.lastTime.task}`
      : '';
    return (
      `- botId: "${b.id}" · name: "${b.name}" · ${caps} · autonomy: ${b.autonomy} · ` +
      `${b.enabled ? 'enabled' : 'DISABLED'} · active runs: ${b.activeRuns}${desc}${last}`
    );
  });
}

/** Exportable digest line: "last time this bot found X" (D97). */
export function formatBotLastTimeDigest(botName: string, last: BotLastTime): string {
  const report = last.report.trim().slice(0, 240);
  return `last time "${botName}" ran "${last.task}" → ${report || '(no report)'}`;
}

/** The block injected into the manager's dynamic context. Always rendered
 *  when the caller supplied a list (even an empty one) so the model never
 *  has to guess whether bots exist. */
export function formatLazyBotsContext(bots: readonly LazyBotSummary[]): string {
  if (bots.length === 0) {
    return '(no LazyBots saved yet — create_lazybot first, after asking the user for a name)';
  }
  return formatLazyBotLines(bots).join('\n');
}

function normalizeLoose(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** "bot_solaritest" / "bot-solari-test" / "lazybot_scraper_web": a model
 *  that knows ids look like "bot_…" but did not copy the real one slugs the
 *  NAME behind the prefix. The prefix carries no information — drop it. */
function stripBotPrefix(s: string): string {
  return s.replace(/^(?:lazy)?bot[\s_-]*/i, '');
}

/**
 * Resolves a bot reference the way a human (or a weaker model) writes it:
 * the exact id, the id in any case, the bot's name in any case, the name
 * with spaces/dashes/accents stripped ("solari-test" → "SolariTest"), the
 * name slugged behind a "bot_" prefix ("bot_solaritest" — live repro with
 * DeepSeek as manager, 2026-09-02), and finally a UNIQUE prefix of either.
 * Returns undefined when nothing matches or when a prefix is ambiguous —
 * never guesses between two bots.
 */
export function resolveLazyBotRef<T extends { id: string; name: string }>(
  bots: readonly T[],
  ref: string | undefined,
): T | undefined {
  if (typeof ref !== 'string') return undefined;
  const wanted = ref.trim();
  if (wanted.length === 0) return undefined;
  const exact = bots.find((b) => b.id === wanted);
  if (exact) return exact;
  const lower = wanted.toLowerCase();
  const byIdCi = bots.find((b) => b.id.toLowerCase() === lower);
  if (byIdCi) return byIdCi;
  const byName = bots.find((b) => b.name.trim().toLowerCase() === lower);
  if (byName) return byName;
  const loose = normalizeLoose(wanted);
  if (loose.length === 0) return undefined;
  const byLooseName = bots.filter((b) => normalizeLoose(b.name) === loose);
  if (byLooseName.length === 1) return byLooseName[0];
  const unprefixed = normalizeLoose(stripBotPrefix(wanted));
  if (unprefixed.length > 0 && unprefixed !== loose) {
    const bySluggedName = bots.filter((b) => normalizeLoose(b.name) === unprefixed);
    if (bySluggedName.length === 1) return bySluggedName[0];
  }
  const byPrefix = bots.filter(
    (b) => b.id.toLowerCase().startsWith(lower) || normalizeLoose(b.name).startsWith(loose),
  );
  return byPrefix.length === 1 ? byPrefix[0] : undefined;
}
