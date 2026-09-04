/* agentComputer.ts — Solari desktop Agent Computer(s) + FIFO mutex.

   Shared path (no botId): exactly ONE desktop per app user — persistent,
   paused by idle timeout, resumed on demand. All callers share it through
   a FIFO mutex (re-entrant for the holder).

   Per-bot path (C50): when ensureAgentComputer(botId) / acquireAgentComputer
   (missionId, botId) are used, each bot gets its own desktop persisted in
   ledger.agentComputersByBotId[botId]. Mutexes are keyed per bot so two bots
   can drive their VMs concurrently. The shared /workspace volume is still
   mounted on every desktop so file handoff keeps working.

   Persistence lives in sessionLedger.ts. A failed control-channel connect
   NEVER wipes the ledger or creates a blank VM.
*/

import type { Desktop } from '@solarisdk/desktop';
import { getSolariClients, type SolariClients } from './solariClient.js';
import {
  readLedger,
  updateLedger,
  ensureWorkspaceVolume,
  SESSION_TIMEOUT_MS,
  WORKSPACE_MOUNT_PATH,
  type AgentComputerLedger,
} from './sessionLedger.js';

const DESKTOP_TEMPLATE = 'default';
const CONTROL_CONNECT_TIMEOUT_MS = 20_000;
const CONTROL_CONNECT_ATTEMPTS = 2;
const SHARED_MUTEX_KEY = '__shared__';

export interface AgentComputerHandle {
  desktop: Desktop;
  desktopId: string;
  volumeId: string;
  botId?: string;
}

/** Status note — per-bot desktops are live via agentComputersByBotId (C50). */
export const DESKTOP_PER_BOT_ROADMAP =
  'C50: per-bot desktop VMs via ledger.agentComputersByBotId[botId]; ' +
  'shared Agent Computer (no botId) remains the fallback + /workspace mount.';

/** Mutex / ledger key: mission-only today; botId:missionId when isolation is used. */
export function desktopOwnerKey(missionId: string, botId?: string): string {
  return botId ? `${botId}:${missionId}` : missionId;
}

interface MutexBucket {
  holder: string | null;
  queue: Array<{ missionId: string; resolve: (release: () => void) => void }>;
}

const mutexByScope = new Map<string, MutexBucket>();

function mutexScope(botId?: string): string {
  return botId ?? SHARED_MUTEX_KEY;
}

function getMutex(botId?: string): MutexBucket {
  const key = mutexScope(botId);
  let bucket = mutexByScope.get(key);
  if (!bucket) {
    bucket = { holder: null, queue: [] };
    mutexByScope.set(key, bucket);
  }
  return bucket;
}

/** Resolve once this bot's (or the shared) Agent Computer is free. */
export async function acquireAgentComputer(missionId: string, botId?: string): Promise<() => void> {
  const key = desktopOwnerKey(missionId, botId);
  const bucket = getMutex(botId);
  if (bucket.holder === key || bucket.holder === missionId) return () => undefined;
  if (bucket.holder === null) {
    bucket.holder = key;
    return () => releaseAgentComputer(missionId, botId);
  }
  return new Promise<() => void>((resolve) => {
    bucket.queue.push({ missionId: key, resolve });
  });
}

export function releaseAgentComputer(missionId: string, botId?: string): void {
  const key = desktopOwnerKey(missionId, botId);
  const bucket = getMutex(botId);
  if (bucket.holder !== key && bucket.holder !== missionId) return;
  bucket.holder = null;
  const next = bucket.queue.shift();
  if (next) {
    bucket.holder = next.missionId;
    next.resolve(() => releaseAgentComputer(next.missionId, botId));
  }
}

export function isAgentComputerHeldBy(missionId: string, botId?: string): boolean {
  const key = desktopOwnerKey(missionId, botId);
  const bucket = getMutex(botId);
  return bucket.holder === key || bucket.holder === missionId;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Agent Computer control connect timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function controlConnect(desktop: Desktop): () => Promise<unknown> {
  const fn = (desktop as Desktop & { connect?: () => Promise<unknown> }).connect;
  if (typeof fn !== 'function') {
    throw new Error('Agent Computer control channel is missing connect()');
  }
  return () => fn.call(desktop);
}

async function openControlChannel(desktop: Desktop): Promise<void> {
  const connect = controlConnect(desktop);
  let lastErr: unknown;
  for (let i = 0; i < CONTROL_CONNECT_ATTEMPTS; i++) {
    try {
      await withTimeout(connect(), CONTROL_CONNECT_TIMEOUT_MS);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function reconnectDesktop(clients: SolariClients, desktopId: string): Promise<Desktop> {
  const desktop = await clients.desktop.connect(desktopId);
  await openControlChannel(desktop);
  return desktop;
}

async function persistShared(ledger: AgentComputerLedger): Promise<void> {
  await updateLedger((state) => ({
    ...state,
    agentComputer: { ...(state.agentComputer ?? {}), ...ledger },
  }));
}

async function persistBot(botId: string, ledger: AgentComputerLedger): Promise<void> {
  await updateLedger((state) => ({
    ...state,
    agentComputersByBotId: {
      ...state.agentComputersByBotId,
      [botId]: { ...(state.agentComputersByBotId[botId] ?? {}), ...ledger },
    },
  }));
}

async function createDesktop(
  clients: SolariClients,
  volumeId: string,
  botId?: string,
): Promise<AgentComputerHandle> {
  const desktop = await clients.desktop.create({
    template: DESKTOP_TEMPLATE,
    timeoutMs: SESSION_TIMEOUT_MS,
    lifecycle: { onTimeout: 'pause' },
    volumes: [{ volumeId, path: WORKSPACE_MOUNT_PATH }],
  });
  await openControlChannel(desktop);
  const patch = { desktopId: desktop.id, volumeId };
  if (botId) await persistBot(botId, patch);
  else await persistShared(patch);
  return { desktop, desktopId: desktop.id, volumeId, botId };
}

/** Re-attach or create the Agent Computer. Pass botId for a dedicated VM (C50). */
export async function ensureAgentComputer(botId?: string): Promise<AgentComputerHandle> {
  const clients = await getSolariClients();
  const volumeId = await ensureWorkspaceVolume();
  const ledger = await readLedger();

  if (botId) {
    const entry = ledger.agentComputersByBotId[botId];
    const desktopId = entry?.desktopId;
    if (desktopId) {
      const desktop = await reconnectDesktop(clients, desktopId);
      return { desktop, desktopId, volumeId: entry?.volumeId ?? volumeId, botId };
    }
    return createDesktop(clients, volumeId, botId);
  }

  const desktopId = ledger.agentComputer?.desktopId;
  if (desktopId) {
    const desktop = await reconnectDesktop(clients, desktopId);
    return { desktop, desktopId, volumeId };
  }
  return createDesktop(clients, volumeId);
}

export async function snapshotAgentComputer(label?: string, botId?: string): Promise<string> {
  const handle = await ensureAgentComputer(botId);
  const snapshotId = await handle.desktop.snapshot(label);
  if (botId) await persistBot(botId, { lastSnapshotId: snapshotId });
  else await persistShared({ lastSnapshotId: snapshotId });
  return snapshotId;
}

/** Clear in-memory mutex state — tests and hot-reload only. */
export function resetAgentComputerState(): void {
  mutexByScope.clear();
}
