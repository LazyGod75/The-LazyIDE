/* botTopicalRecall — bot-scoped topical context for prelude: 'bot' (D93).

   Loads lastTime + recent run history + learning lines for the same botId
   without touching the repo harness / coding brain prelude. Kept in bots/
   so managedAgentPrepare can call it without importing rust brain ops.
*/

import { loadBotLastTime, listBotRunHistory, formatBotLastTime } from './botRuntimeStore.js';
import { getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';
import { getCachedProjectRoot } from '../agents/projectRootCache.js';

const BOT_LEARNING_FILE = '.lazy/bot-learning.jsonl';
let learningRoot: string | null = null;

export function setBotTopicalRecallRoot(root: string): void {
  learningRoot = root;
}

async function readRecentLearning(botId: string, limit = 3): Promise<string[]> {
  const root = learningRoot ?? getCachedProjectRoot() ?? '';
  if (!root) return [];
  try {
    const raw = await getPlatform().fs.readFile(joinPath(root, BOT_LEARNING_FILE));
    const lines = raw.split('\n').filter(Boolean).reverse();
    const out: string[] = [];
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as { botId?: string; task?: string; report?: string };
        if (rec.botId !== botId) continue;
        out.push(`${rec.task ?? ''}: ${(rec.report ?? '').slice(0, 240)}`);
        if (out.length >= limit) break;
      } catch {
        // skip bad lines
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Build a short topical block for the same botId (no harness / no repo recall). */
export async function loadBotTopicalContext(botId: string, task?: string): Promise<string> {
  const parts: string[] = [];
  if (task) parts.push(`Current task: ${task}`);
  const last = await loadBotLastTime(botId);
  if (last) parts.push(formatBotLastTime(last));
  const history = await listBotRunHistory(botId);
  for (const run of history.slice(0, 3)) {
    if (run.summary) parts.push(`Prior run (${run.completedAt ?? run.startedAt}): ${run.summary.slice(0, 200)}`);
  }
  const learning = await readRecentLearning(botId);
  for (const line of learning) parts.push(`Learned: ${line}`);
  if (parts.length === 0) return '';
  return `<bot_topical botId="${botId}">\n${parts.join('\n')}\n</bot_topical>`;
}
