/* botShare — sanitised bot sharing for LazyBots.

   When a user shares a bot, the BotConfig must be sanitised to remove any
   private data (Solari profile ids, routine history, timestamps) before it
   leaves the user's machine. The sanitised config is then encoded into a
   portable deep-link that another user can import.

   Security: the sanitiser is the ONLY function that produces a shareable
   bot. Never share a raw BotConfig — always go through sanitiseBotForShare.
*/

import type { BotConfig, BotRoutine } from './botTypes.js';

/** A sanitised bot config — safe to share. */
export interface ShareableBot {
  name: string;
  description: string;
  systemPrompt: string;
  autonomy: BotConfig['autonomy'];
  capabilities: BotConfig['capabilities'];
  /** Routines are kept (they're part of the bot's value) but lastRunAt is
   *  stripped — a shared bot should not carry the original user's run history. */
  routines: SanitisedRoutine[];
  /** The share format version — for forward compatibility. */
  shareVersion: string;
}

interface SanitisedRoutine {
  id: string;
  name: string;
  schedule: string;
  task: string;
  enabled: boolean;
}

export const SHARE_VERSION = '1.0.0';

/** Sanitise a BotConfig for sharing. Removes all private data. */
export function sanitiseBotForShare(bot: BotConfig): ShareableBot {
  return {
    name: bot.name,
    description: bot.description,
    systemPrompt: bot.systemPrompt,
    autonomy: bot.autonomy,
    capabilities: bot.capabilities,
    routines: bot.routines.map(sanitiseRoutine),
    shareVersion: SHARE_VERSION,
  };
}

function sanitiseRoutine(routine: BotRoutine): SanitisedRoutine {
  return {
    id: routine.id,
    name: routine.name,
    schedule: routine.schedule,
    task: routine.task,
    enabled: routine.enabled,
    // lastRunAt is deliberately stripped — it's the original user's history.
  };
}

/** Import a ShareableBot into a full BotConfig with a fresh id. */
export function importShareableBot(
  shared: ShareableBot,
  generateId: () => string = () => `bot_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
): BotConfig {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    name: shared.name,
    description: shared.description,
    systemPrompt: shared.systemPrompt,
    autonomy: shared.autonomy,
    capabilities: shared.capabilities,
    routines: shared.routines.map((r) => ({
      id: r.id,
      name: r.name,
      schedule: r.schedule,
      task: r.task,
      enabled: r.enabled,
      lastRunAt: null,
    })),
    // profileIds starts empty — the importing user attaches their own profiles.
    profileIds: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

/** Validate that a ShareableBot has all required fields with correct types.
 *  Returns an error string if invalid, null if valid. */
export function validateShareableBot(shared: unknown): string | null {
  if (typeof shared !== 'object' || shared === null) return 'Invalid: not an object';
  const record = shared as Record<string, unknown>;
  if (typeof record.name !== 'string') return 'Invalid: name must be a string';
  if (typeof record.systemPrompt !== 'string') return 'Invalid: systemPrompt must be a string';
  if (typeof record.autonomy !== 'string' || !['manual', 'supervised', 'yolo'].includes(record.autonomy)) {
    return 'Invalid: autonomy must be manual, supervised, or yolo';
  }
  if (typeof record.capabilities !== 'object' || record.capabilities === null) {
    return 'Invalid: capabilities must be an object';
  }
  if (!Array.isArray(record.routines)) return 'Invalid: routines must be an array';
  return null;
}
