/* botHandoff — bot-to-bot task handoff.

   A bot can delegate a subtask to another bot by calling the handoff tool.
   This module resolves the target bot, builds a handoff prompt that includes
   the parent bot's context, and launches a new bot run. The parent bot's run
   can optionally wait for the child to complete (blocking handoff) or fire
   and forget (async handoff).
*/

import type { BotConfig, BotMissionInput } from './botTypes.js';
import { getBot } from './botStorage.js';
import { launchBotRun, getBotRuntimeState } from './botEngine.js';

export interface HandoffOpts {
  /** The bot initiating the handoff. */
  fromBot: BotConfig;
  /** The target bot's id, or its name (resolved via getBot). */
  toBotIdOrName: string;
  /** The task to delegate. */
  task: string;
  /** Context from the parent bot's run (e.g. "I was checking prices on Amazon"). */
  context?: string;
  /** Creates the child run as a REAL mission in the agents store (the
   *  caller threads addMission here) - see launchBotRun's doc comment. */
  createMission: (input: BotMissionInput) => Promise<string>;
  /** Model for the child run. */
  model: string;
  /** If true, the parent waits for the child to complete. Default: false (async). */
  blocking?: boolean;
}

export interface HandoffResult {
  success: boolean;
  childBot?: BotConfig;
  childRunId?: string;
  error?: string;
}

/** Resolve a bot by id or name. */
async function resolveBot(idOrName: string): Promise<BotConfig | undefined> {
  const byId = await getBot(idOrName);
  if (byId) return byId;
  // Fallback: search by name (case-insensitive)
  const { listBots } = await import('./botStorage.js');
  const all = await listBots();
  return all.find((b) => b.name.toLowerCase() === idOrName.toLowerCase());
}

/** Build the handoff prompt that combines the child bot's persona with the
 *  parent's context and the delegated task. */
export function buildHandoffPrompt(task: string, context?: string): string {
  const lines: string[] = [];
  if (context) {
    lines.push('=== HANDOFF CONTEXT ===');
    lines.push(context);
    lines.push('');
  }
  lines.push('=== DELEGATED TASK ===');
  lines.push(task);
  return lines.join('\n');
}

/** Execute a bot-to-bot handoff. */
export async function handoffToBot(opts: HandoffOpts): Promise<HandoffResult> {
  const targetBot = await resolveBot(opts.toBotIdOrName);
  if (!targetBot) {
    return { success: false, error: `Bot not found: ${opts.toBotIdOrName}` };
  }
  if (!targetBot.enabled) {
    return { success: false, error: `Bot "${targetBot.name}" is paused` };
  }

  const handoffTask = buildHandoffPrompt(opts.task, opts.context);

  try {
    const run = await launchBotRun(targetBot, handoffTask, {
      createMission: opts.createMission,
      model: opts.model,
    });

    if (opts.blocking) {
      // Wait for the child run to complete by polling runtime state.
      // This is a simple polling loop — for production, a proper event-based
      // wait would be better, but this keeps the dependency surface small.
      const maxWaitMs = 5 * 60 * 1000;
      const pollIntervalMs = 1000;
      const start = Date.now();
      while (Date.now() - start < maxWaitMs) {
        const state = getBotRuntimeState(targetBot.id);
        if (!state.activeRuns.includes(run.missionId)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }

    return { success: true, childBot: targetBot, childRunId: run.id };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
