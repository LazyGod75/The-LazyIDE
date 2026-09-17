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
   falls back to a FRESH VM (the volume survives — only the dead desktopId
   is replaced); keeping the stale id would brick every future call.
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

/** Poll desktop.health() until ready (VM boot can lag the control connect).
 *  Throws a clear error after ~30s so missions fail fast instead of clicking
 *  into a half-booted desktop. */
async function awaitDesktopReady(desktop: Desktop): Promise<void> {
  const health = (desktop as Desktop & { health?: () => Promise<{ ready?: boolean }> }).health;
  if (typeof health !== 'function') return; // older SDK — nothing to gate on
  const deadline = Date.now() + 30_000;
  let last: { ready?: boolean } | undefined;
  while (Date.now() < deadline) {
    try {
      last = await health.call(desktop);
      if (last?.ready !== false) return;
    } catch {
      // transient — keep polling until the deadline
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error('Agent Computer is not ready (health check still pending after 30s) — retry shortly');
}

/** A desktop record that can never serve a control channel again: past its
 *  expiresAt, or reported in a terminal state by the API ("gone" is what
 *  Solari returns for a reclaimed VM — expiresAt is null there, so the
 *  status check is what catches it). */
export function desktopRecordIsDead(info: unknown): boolean {
  const rec = info as { expiresAt?: string | null; status?: string } | undefined;
  const expiresAt = Date.parse(String(rec?.expiresAt ?? ''));
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return true;
  const status = String(rec?.status ?? '').toLowerCase();
  return ['gone', 'destroyed', 'terminated', 'failed', 'stopped', 'expired'].includes(status);
}

async function reconnectDesktop(clients: SolariClients, desktopId: string): Promise<Desktop> {
  // Cheap liveness gate first: `get` returns the record (incl. expiresAt +
  // status) without touching the control channel. A dead session can never
  // serve RPCs — skip straight to the caller's fresh-VM fallback instead of
  // burning the connect timeout on a corpse.
  const info = await clients.desktop.get(desktopId);
  if (desktopRecordIsDead(info)) {
    throw new Error(`desktop ${desktopId.slice(0, 16)}… is dead (status/expiry)`);
  }
  const desktop = await clients.desktop.connect(desktopId);
  await openControlChannel(desktop);
  await awaitDesktopReady(desktop);
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
  const base = {
    template: DESKTOP_TEMPLATE,
    timeoutMs: SESSION_TIMEOUT_MS,
    lifecycle: { onTimeout: 'pause' as const },
  };
  // Same best-effort volume policy as openSandbox: some Solari backends
  // reject `volumes` (501 "volumes not yet available on gcp") — retry bare.
  let desktop;
  try {
    desktop = await clients.desktop.create({
      ...base,
      volumes: [{ volumeId, path: WORKSPACE_MOUNT_PATH }],
    });
  } catch {
    desktop = await clients.desktop.create(base);
  }
  await openControlChannel(desktop);
  await awaitDesktopReady(desktop);
  const patch = { desktopId: desktop.id, volumeId };
  if (botId) await persistBot(botId, patch);
  else await persistShared(patch);
  return { desktop, desktopId: desktop.id, volumeId, botId };
}

/** Re-attach or create the Agent Computer. Pass botId for a dedicated VM (C50).
 *  A persisted desktopId that fails reconnect (expired/destroyed VM — the
 *  ledger does not know it died, e.g. a hung brain turn burned past the
 *  session's expiresAt) MUST fall through to createDesktop — otherwise one
 *  stale ledger entry bricks every future cloud_desktop_* call forever
 *  (real incident: connect() TimeoutError loop after the VM expired). */
export async function ensureAgentComputer(botId?: string): Promise<AgentComputerHandle> {
  const clients = await getSolariClients();
  const volumeId = await ensureWorkspaceVolume();
  const ledger = await readLedger();

  if (botId) {
    const entry = ledger.agentComputersByBotId[botId];
    const desktopId = entry?.desktopId;
    if (desktopId) {
      try {
        const desktop = await reconnectDesktop(clients, desktopId);
        return { desktop, desktopId, volumeId: entry?.volumeId ?? volumeId, botId };
      } catch {
        // stale/dead desktop — free its concurrency slot, then fresh VM
        await destroyQuietly(clients, desktopId);
      }
    }
    return createDesktop(clients, volumeId, botId);
  }

  const desktopId = ledger.agentComputer?.desktopId;
  if (desktopId) {
    try {
      const desktop = await reconnectDesktop(clients, desktopId);
      return { desktop, desktopId, volumeId };
    } catch {
      await destroyQuietly(clients, desktopId);
    }
  }
  return createDesktop(clients, volumeId);
}

/** Best-effort destroy of a desktop we just proved unreachable — a dead VM
 *  still counts against the concurrency cap until deleted server-side, so
 *  leaving it would make the very next create() hit 429/ConcurrencyLimit.
 *  Never throws: the desktop may already be gone. */
export async function destroyQuietly(clients: SolariClients, desktopId: string): Promise<void> {
  try {
    await clients.desktop.destroy(desktopId);
  } catch {
    // already gone / not ours — nothing to free
  }
}

export async function snapshotAgentComputer(label?: string, botId?: string): Promise<string> {
  const handle = await ensureAgentComputer(botId);
  const snapshotId = await handle.desktop.snapshot(label);
  if (botId) await persistBot(botId, { lastSnapshotId: snapshotId });
  else await persistShared({ lastSnapshotId: snapshotId });
  return snapshotId;
}

/** Revert the (bot's or shared) Agent Computer to a snapshot — defaults to
 *  the ledger's lastSnapshotId (the post-run checkpoint). Recovery-ladder
 *  step: "reset to durable snapshot". */
export async function revertAgentComputer(botId?: string, snapshotId?: string): Promise<void> {
  const clients = await getSolariClients();
  const ledger = await readLedger();
  const entry = botId ? ledger.agentComputersByBotId[botId] : ledger.agentComputer;
  const target = snapshotId ?? entry?.lastSnapshotId;
  if (!target) throw new Error('No snapshot recorded for this computer — run it once first');
  const handle = await ensureAgentComputer(botId);
  const revert = (handle.desktop as Desktop & { revert?: (id: string) => Promise<unknown> }).revert;
  if (typeof revert !== 'function') throw new Error('Desktop SDK does not expose revert()');
  await revert.call(handle.desktop, target);
  await awaitDesktopReady(handle.desktop);
  void clients;
}

/** Clear in-memory mutex state — tests and hot-reload only. */
export function resetAgentComputerState(): void {
  mutexByScope.clear();
}
