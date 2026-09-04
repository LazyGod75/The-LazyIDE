/* botRuntimeStore — persist live LazyBot runs across an app crash.

   In-memory maps in botEngine.ts die with the process. Missions themselves
   are already persisted by the agents store; this file keeps the bot-side
   bookkeeping (which mission belongs to which bot, last completed task)
   in `.lazy/bot-runtime.json` so a restart does not look like "no runs".
*/

import { getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';
import { getCachedProjectRoot } from '../agents/projectRootCache.js';
import type { BotRun } from './botTypes.js';

export const BOT_RUNTIME_FILE = '.lazy/bot-runtime.json';
export const BOT_RUNTIME_VERSION = '1.0.0';
/** Cap completed-run history per bot (C53 — mirrors Grok's ~20 run records). */
export const MAX_BOT_RUN_HISTORY = 20;

export interface BotLastTime {
  task: string;
  report: string;
  at: string;
}

interface RuntimeFile {
  version: string;
  /** Currently running missions (crash recovery). */
  runs: BotRun[];
  /** Completed/cancelled/failed runs with summaries, newest first (C53). */
  history: BotRun[];
  lastTime: Record<string, BotLastTime>;
}

let runtimeRoot: string | null = null;
let opTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = opTail.then(op, op);
  opTail = run.then(() => undefined, () => undefined);
  return run;
}

export function setBotRuntimeRoot(root: string): void {
  runtimeRoot = root;
}

function rootPath(): string {
  return runtimeRoot ?? getCachedProjectRoot() ?? '';
}

function filePath(): string {
  return joinPath(rootPath(), BOT_RUNTIME_FILE);
}

function emptyFile(): RuntimeFile {
  return { version: BOT_RUNTIME_VERSION, runs: [], history: [], lastTime: {} };
}

function isBotRun(value: unknown): value is BotRun {
  const r = value as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.botId === 'string' && typeof r.missionId === 'string';
}

function normalize(raw: unknown): RuntimeFile {
  const out = emptyFile();
  if (typeof raw !== 'object' || raw === null) return out;
  const rec = raw as Record<string, unknown>;
  if (Array.isArray(rec.runs)) out.runs = rec.runs.filter(isBotRun);
  if (Array.isArray(rec.history)) out.history = rec.history.filter(isBotRun);
  if (rec.lastTime && typeof rec.lastTime === 'object') {
    out.lastTime = rec.lastTime as Record<string, BotLastTime>;
  }
  return out;
}

async function readFile(): Promise<RuntimeFile> {
  const root = rootPath();
  if (!root) return emptyFile();
  const platform = getPlatform();
  try {
    return normalize(JSON.parse(await platform.fs.readFile(filePath())));
  } catch {
    return emptyFile();
  }
}

async function writeFile(state: RuntimeFile): Promise<void> {
  const root = rootPath();
  if (!root) return;
  const platform = getPlatform();
  try {
    await platform.fs.createDir?.(joinPath(root, '.lazy'));
    await platform.fs.writeFile(filePath(), JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('[botRuntime] persist failed:', err);
  }
}

export async function persistActiveRuns(runs: BotRun[]): Promise<void> {
  return enqueue(async () => {
    const state = await readFile();
    state.runs = runs.filter((r) => r.status === 'running');
    await writeFile(state);
  });
}

export async function loadPersistedRuns(): Promise<BotRun[]> {
  return enqueue(async () => (await readFile()).runs.filter((r) => r.status === 'running'));
}

export async function recordBotLastTime(botId: string, last: BotLastTime): Promise<void> {
  return enqueue(async () => {
    const state = await readFile();
    state.lastTime = { ...state.lastTime, [botId]: last };
    await writeFile(state);
  });
}

export async function loadBotLastTime(botId: string): Promise<BotLastTime | undefined> {
  return enqueue(async () => (await readFile()).lastTime[botId]);
}

/** Append a finished run (with summary) to history, newest first, capped (C53). */
export async function appendBotRunHistory(run: BotRun): Promise<void> {
  return enqueue(async () => {
    const state = await readFile();
    const withoutDup = state.history.filter((r) => r.missionId !== run.missionId);
    const forBot = [run, ...withoutDup.filter((r) => r.botId === run.botId)].slice(0, MAX_BOT_RUN_HISTORY);
    const others = withoutDup.filter((r) => r.botId !== run.botId);
    state.history = [...forBot, ...others];
    await writeFile(state);
  });
}

export async function listBotRunHistory(botId: string): Promise<BotRun[]> {
  return enqueue(async () => (await readFile()).history.filter((r) => r.botId === botId));
}

export function formatBotLastTime(last: BotLastTime): string {
  return `Last time (${last.at}): ${last.task} — ${last.report}`;
}
