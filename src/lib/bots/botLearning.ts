/* botLearning — LazyBot end-of-run learning + long-term memory hooks (D94–D98).

   Keeps bot-scoped records OUT of the code-agent capture path:
     - space: 'bot' / kind: 'lazybot_report' (D95)
     - full report persisted for "last time this bot found X" (D97)
     - bus event `bot:learning` so a Brain indexer can promote to LTM (D98)
       without this module importing rust brain ops / managerEngine.
     - best-effort platform.brain.capture() topical neuron (D98) when available

   Cloud_* → playbooks (D96) is indexed into `.lazy/bot-playbooks.json`.
*/

import { emit } from '../bus.js';
import { getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';
import { getCachedProjectRoot } from '../agents/projectRootCache.js';
import { appendBotRunHistory, recordBotLastTime } from './botRuntimeStore.js';
import type { BotRun } from './botTypes.js';

export const BOT_LEARNING_SPACE = 'bot' as const;
export const BOT_LEARNING_KIND = 'lazybot_report' as const;
export const BOT_LEARNING_FILE = '.lazy/bot-learning.jsonl';
export const BOT_PLAYBOOKS_FILE = '.lazy/bot-playbooks.json';

export interface BotLearningRecord {
  space: typeof BOT_LEARNING_SPACE;
  kind: typeof BOT_LEARNING_KIND;
  botId: string;
  botName?: string;
  missionId: string;
  task: string;
  report: string;
  at: string;
  /** Optional cloud_* tool names seen during the run (D96 playbook seed). */
  cloudTools?: string[];
  conversationId?: string;
}

interface PlaybookIndex {
  version: string;
  byBot: Record<string, { tools: string[]; lastTask?: string; updatedAt: string }>;
}

let learningRoot: string | null = null;

export function setBotLearningRoot(root: string): void {
  learningRoot = root;
}

function rootPath(): string {
  return learningRoot ?? getCachedProjectRoot() ?? '';
}

/** Persist one learning line + emit bus event + optional brain neuron (D94/D98). */
export async function recordBotLearning(rec: BotLearningRecord): Promise<void> {
  const payload: BotLearningRecord = {
    ...rec,
    space: BOT_LEARNING_SPACE,
    kind: BOT_LEARNING_KIND,
  };
  try {
    emit('bot:learning', payload);
  } catch (err) {
    console.warn('[botLearning] emit failed', err);
  }
  const root = rootPath();
  if (root) {
    try {
      const platform = getPlatform();
      await platform.fs.createDir?.(joinPath(root, '.lazy'));
      const path = joinPath(root, BOT_LEARNING_FILE);
      let prev = '';
      try {
        prev = await platform.fs.readFile(path);
      } catch {
        prev = '';
      }
      await platform.fs.writeFile(path, `${prev}${JSON.stringify(payload)}\n`);
    } catch (err) {
      console.warn('[botLearning] persist failed', err);
    }
  }
  await writeBotLearningNeuron(payload);
}

/** D98 — promote a bot learning record to a topical brain neuron when capture exists. */
async function writeBotLearningNeuron(rec: BotLearningRecord): Promise<void> {
  try {
    const platform = getPlatform();
    const capture = platform.brain?.capture;
    if (typeof capture !== 'function') return;
    const topic = `lazybot-${rec.botId}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
    await capture({
      kind: 'learning',
      title: `LazyBot ${rec.botName ?? rec.botId}: ${rec.task.slice(0, 80)}`,
      text: rec.report,
      space: 'topical',
      topic,
      tags: ['lazybot', rec.botId, ...(rec.cloudTools ?? [])],
      source: 'bot-learning',
      upsertIfRicher: true,
      stableId: `lazybot-learning-${rec.botId}-${rec.missionId}`,
    });
  } catch (err) {
    console.warn('[botLearning] brain capture failed', err);
  }
}

/** Extract cloud_* tool names from a free-text timeline for playbook seeding (D96). */
export function extractCloudToolTraces(timelineTexts: readonly string[]): string[] {
  const found = new Set<string>();
  const re = /\bcloud_(?:browser|desktop|sandbox)_[a-z0-9_]+\b/g;
  for (const text of timelineTexts) {
    for (const m of text.matchAll(re)) found.add(m[0]!);
  }
  return [...found];
}

/** D96 — merge cloud_* tool names into `.lazy/bot-playbooks.json` per bot. */
export async function indexCloudPlaybooks(
  botId: string,
  tools: string[],
  meta?: { task?: string; at?: string },
): Promise<void> {
  if (tools.length === 0) return;
  const root = rootPath();
  if (!root) return;
  const platform = getPlatform();
  const path = joinPath(root, BOT_PLAYBOOKS_FILE);
  let index: PlaybookIndex;
  try {
    index = JSON.parse(await platform.fs.readFile(path)) as PlaybookIndex;
    if (!index.byBot) index.byBot = {};
  } catch {
    index = { version: '1.0.0', byBot: {} };
  }
  const prev = index.byBot[botId]?.tools ?? [];
  const merged = [...new Set([...prev, ...tools])];
  index.byBot[botId] = {
    tools: merged,
    lastTask: meta?.task ?? index.byBot[botId]?.lastTask,
    updatedAt: meta?.at ?? new Date().toISOString(),
  };
  try {
    await platform.fs.createDir?.(joinPath(root, '.lazy'));
    await platform.fs.writeFile(path, JSON.stringify(index, null, 2));
  } catch (err) {
    console.warn('[botLearning] playbook index failed', err);
  }
}

/** Convenience: lastTime + history + learning + playbooks after a successful run. */
export async function finalizeBotRunLearning(opts: {
  botId: string;
  botName?: string;
  missionId: string;
  task: string;
  report: string;
  conversationId?: string;
  timelineTexts?: readonly string[];
  run?: BotRun;
}): Promise<void> {
  const at = new Date().toISOString();
  const cloudTools = opts.timelineTexts ? extractCloudToolTraces(opts.timelineTexts) : undefined;
  await recordBotLastTime(opts.botId, { task: opts.task, report: opts.report, at });
  if (opts.run) {
    await appendBotRunHistory({
      ...opts.run,
      status: opts.run.status === 'running' ? 'completed' : opts.run.status,
      completedAt: opts.run.completedAt ?? at,
      summary: opts.report,
    });
  }
  await recordBotLearning({
    space: BOT_LEARNING_SPACE,
    kind: BOT_LEARNING_KIND,
    botId: opts.botId,
    botName: opts.botName,
    missionId: opts.missionId,
    task: opts.task,
    report: opts.report,
    at,
    cloudTools,
    conversationId: opts.conversationId,
  });
  if (cloudTools?.length) {
    await indexCloudPlaybooks(opts.botId, cloudTools, { task: opts.task, at });
  }
}
