/* applyTeachSkill — persist a compiled teach overlay into the bot persona (C81). */

import { getBot, saveBot } from './botStorage.js';
import type { BotConfig } from './botTypes.js';

export const TEACH_SKILL_MARKER = '=== TEACH SKILL ===';

/** Merge a compiled skill overlay into the bot's systemPrompt and save. */
export async function applyTeachSkillToPersona(botId: string, overlay: string): Promise<BotConfig | null> {
  const bot = await getBot(botId);
  if (!bot) return null;
  const trimmed = overlay.trim();
  if (!trimmed) return bot;
  const idx = bot.systemPrompt.indexOf(TEACH_SKILL_MARKER);
  const base = (idx >= 0 ? bot.systemPrompt.slice(0, idx) : bot.systemPrompt).trimEnd();
  const next: BotConfig = {
    ...bot,
    systemPrompt: `${base}\n\n${TEACH_SKILL_MARKER}\n${trimmed}\n`,
    updatedAt: new Date().toISOString(),
  };
  await saveBot(next);
  return next;
}
