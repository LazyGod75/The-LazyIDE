/* botHandoff — bot-to-bot task handoff.

   A bot can delegate a subtask to another bot by calling the handoff tool.
   This module resolves the target bot, builds a handoff prompt that includes
   the parent bot's context, and launches a new bot run. The parent bot's run
   can optionally wait for the child to complete (blocking handoff) or fire
   and forget (async handoff).
*/

import type { BotConfig, BotMissionInput } from './botTypes.js';
import { getBot, listBots } from './botStorage.js';
import { launchBotRun, getBotRuntimeState } from './botEngine.js';
import { resolveLazyBotRef } from './botManagerContext.js';
import { listBotRunHistory } from './botRuntimeStore.js';

export interface HandoffOpts {
  /** The bot initiating the handoff. */
  fromBot: BotConfig;
  /** The target bot's id, name, slug, or unique prefix. */
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
  /** Whether the caller waited for the child run. */
  blocking?: boolean;
  /** The child run's summary, when it completed within the blocking window. */
  childReport?: string;
}

const MAX_HANDOFF_DEPTH = 4;
const handoffDepth = new Map<string, number>();

/** Resolve a bot by id, name, slug, or unique prefix. */
async function resolveBot(ref: string): Promise<BotConfig | undefined> {
  const exact = await getBot(ref);
  if (exact) return exact;
  const all = await listBots();
  return resolveLazyBotRef(all, ref);
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

/** Reset the handoff depth counters — tests only. */
export function resetHandoffDepth(): void {
  handoffDepth.clear();
}

/** Find a completed child run's summary in the persisted run history. */
async function loadChildReport(botId: string, runId: string, missionId: string): Promise<string | undefined> {
  const history = await listBotRunHistory(botId);
  const completed = history.find(
    (r) => (r.id === runId || r.missionId === missionId) && r.status === 'completed',
  );
  return completed?.summary;
}

/** Execute a bot-to-bot handoff. */
export async function handoffToBot(opts: HandoffOpts): Promise<HandoffResult> {
  const targetBot = await resolveBot(opts.toBotIdOrName);
  if (!targetBot) {
    return { success: false, error: `Bot not found: ${opts.toBotIdOrName}` };
  }
  if (targetBot.id === opts.fromBot.id) {
    return { success: false, error: 'cannot hand off to itself' };
  }
  if (!targetBot.enabled) {
    return { success: false, error: `Bot "${targetBot.name}" is paused` };
  }

  const currentDepth = handoffDepth.get(targetBot.id) ?? 0;
  if (currentDepth >= MAX_HANDOFF_DEPTH) {
    return { success: false, error: 'handoff depth limit reached' };
  }

  const handoffTask = buildHandoffPrompt(opts.task, opts.context);

  try {
    const run = await launchBotRun(targetBot, handoffTask, {
      createMission: opts.createMission,
      model: opts.model,
    });

    handoffDepth.set(targetBot.id, currentDepth + 1);
    let childReport: string | undefined;

    if (opts.blocking) {
      // Wait for the child run to complete by polling runtime state.
      // Blocking callers extend the poll window to 10 minutes.
      const maxWaitMs = 10 * 60 * 1000;
      const pollIntervalMs = 1000;
      const start = Date.now();
      while (Date.now() - start < maxWaitMs) {
        const state = getBotRuntimeState(targetBot.id);
        if (!state.activeRuns.includes(run.missionId)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      childReport = await loadChildReport(targetBot.id, run.id, run.missionId);
    }

    return {
      success: true,
      childBot: targetBot,
      childRunId: run.id,
      ...(opts.blocking ? { blocking: true, childReport } : {}),
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
