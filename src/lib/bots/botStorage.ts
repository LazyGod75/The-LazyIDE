/* botStorage — local persistence for LazyBot configurations (.lazy/bots.json).

   Uses the same platform file IO pattern as sessionLedger.ts: read-modify-write
   with a serialized op queue, tolerate missing/corrupt files by starting fresh.
   Splitting it into its own module keeps botEngine.ts under the line budget.
*/

import { getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';
import { getCachedProjectRoot } from '../agents/projectRootCache.js';
import { emit } from '../bus.js';
import type { BotConfig } from './botTypes.js';

// ── Constants ──────────────────────────────────────────────────────

export const BOTS_FILE = '.lazy/bots.json';
export const BOTS_VERSION = '1.0.0';

interface BotsStore {
  version: string;
  bots: BotConfig[];
}

// ── Module state ───────────────────────────────────────────────────

let botsRoot: string | null = null;

let storeOpTail: Promise<unknown> = Promise.resolve();

function enqueueStoreOp<T>(op: () => Promise<T>): Promise<T> {
  const run = storeOpTail.then(op, op);
  storeOpTail = run.then(() => undefined, () => undefined);
  return run;
}

/** Set the project root that hosts .lazy/bots.json. Defaults to the cached
 *  project root; override for tests. */
export function setBotsRoot(root: string): void {
  botsRoot = root;
}

/** How long a store op waits for resolveProjectRoot() (agentsStore) to
 *  populate the root cache after boot before giving up (30 × 300 ms). */
const ROOT_WAIT_STEPS = 30;
const ROOT_WAIT_STEP_MS = 300;

/** The project root hosting bots.json, or '' when none is known yet.
 *
 *  Never a relative path: resolveProjectRoot() populates the cache ASYNC
 *  shortly after boot, and a read issued before that used to fall through
 *  to a bare ".lazy/bots.json" — resolved by the native side against the
 *  process cwd, i.e. against whatever repo happened to launch the app. The
 *  manager then listed bots that the active project did not have, and
 *  run_lazybot failed 30 s later with "bot not found". Wait (bounded) for
 *  the real root instead, exactly like useCanvasFlowGraph does.
 *
 *  `waitForRoot: false` skips the wait and reads whatever the cache holds
 *  right now ('' → empty store). For callers that have ALREADY awaited
 *  resolveProjectRoot() themselves (the manager turn) the wait can only
 *  cost time: when the cache is still empty at that point there is no
 *  project (web mode, welcome screen, tests) and nothing will ever fill it
 *  — the default wait was adding a flat 3 s (its outer bound) to every
 *  manager turn in that state. */
async function rootPath(waitForRoot = true): Promise<string> {
  if (botsRoot) return botsRoot;
  if (waitForRoot) {
    for (let i = 0; i < ROOT_WAIT_STEPS && !getCachedProjectRoot(); i++) {
      await new Promise((r) => setTimeout(r, ROOT_WAIT_STEP_MS));
    }
  }
  return getCachedProjectRoot() ?? '';
}

export interface ListBotsOptions {
  /** Default true — see rootPath's doc comment. */
  waitForRoot?: boolean;
}

function emptyStore(): BotsStore {
  return { version: BOTS_VERSION, bots: [] };
}

function isBotConfig(value: unknown): value is BotConfig {
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.systemPrompt === 'string' &&
    typeof record.autonomy === 'string'
  );
}

function normalizeStore(raw: unknown): BotsStore {
  const store = emptyStore();
  if (typeof raw !== 'object' || raw === null) return store;
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.bots)) store.bots = record.bots.filter(isBotConfig);
  return store;
}

// ── Store IO ───────────────────────────────────────────────────────

async function readStore(waitForRoot = true): Promise<{ store: BotsStore; root: string }> {
  const root = await rootPath(waitForRoot);
  if (!root) return { store: emptyStore(), root: '' };
  const platform = getPlatform();
  try {
    const content = await platform.fs.readFile(joinPath(root, BOTS_FILE));
    return { store: normalizeStore(JSON.parse(content)), root };
  } catch {
    return { store: emptyStore(), root };
  }
}

/** Write the store back to the SAME root the read used. Re-resolving the
 *  active root here would let a project switch mid-operation overwrite
 *  project B with project A's bots (the read captured A, the write hits B).
 *  The root is captured once at the start of the read-modify-write and bound
 *  to the whole op. */
async function writeStore(root: string, store: BotsStore): Promise<void> {
  if (!root) throw new Error('LazyBots: no active project root — open a project before saving a bot.');
  const platform = getPlatform();
  await platform.fs.createDir?.(root);
  await platform.fs.writeFile(joinPath(root, BOTS_FILE), JSON.stringify(store, null, 2));
}

// ── Public API ─────────────────────────────────────────────────────

/** Read all bots from the store. Returns [] when the store is missing/corrupt. */
export async function listBots(opts?: ListBotsOptions): Promise<BotConfig[]> {
  return enqueueStoreOp(async () => {
    const { store } = await readStore(opts?.waitForRoot ?? true);
    return store.bots;
  });
}

/** Get a single bot by id, or undefined. */
export async function getBot(id: string): Promise<BotConfig | undefined> {
  return enqueueStoreOp(async () => {
    const { store } = await readStore();
    return store.bots.find((b) => b.id === id);
  });
}

/** Upsert a bot (add or update by id). The root is captured once at the start
 *  of the read-modify-write so a project switch mid-op cannot redirect the
 *  write into another project's bot file. */
export async function saveBot(bot: BotConfig): Promise<void> {
  return enqueueStoreOp(async () => {
    const { store, root } = await readStore();
    const idx = store.bots.findIndex((b) => b.id === bot.id);
    if (idx >= 0) {
      store.bots = [...store.bots];
      store.bots[idx] = bot;
    } else {
      store.bots = [...store.bots, bot];
    }
    await writeStore(root, store);
    emit('lazybots:changed', { botId: bot.id });
  });
}

/** Delete a bot by id. Idempotent. */
export async function deleteBot(id: string): Promise<void> {
  return enqueueStoreOp(async () => {
    const { store, root } = await readStore();
    store.bots = store.bots.filter((b) => b.id !== id);
    await writeStore(root, store);
    emit('lazybots:changed', { botId: id });
  });
}

/** Update the enabled flag on a bot. */
export async function setBotEnabled(id: string, enabled: boolean): Promise<void> {
  return enqueueStoreOp(async () => {
    const { store, root } = await readStore();
    const idx = store.bots.findIndex((b) => b.id === id);
    if (idx < 0) return;
    store.bots = [...store.bots];
    store.bots[idx] = { ...store.bots[idx], enabled, updatedAt: new Date().toISOString() };
    await writeStore(root, store);
    emit('lazybots:changed', { botId: id });
  });
}
