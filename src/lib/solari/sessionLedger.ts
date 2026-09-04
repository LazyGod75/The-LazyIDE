/* sessionLedger.ts — Persisted Solari session ledger (.lazy/solari-sessions.json).

   Shared by solariSessions.ts (browser sessions + sandboxes) and
   agentComputer.ts (the one shared desktop): the ledger is the source of
   truth for crash recovery, so every open/release is a serialized
   read-modify-write, and a missing or corrupt file simply starts fresh.
   Splitting it into its own module keeps both consumers under the repo's
   line budget and avoids an import cycle between them.

   Schema (versioned, additive):
     {
       "version": "1.0.0",
       "browserSessions": [{ "id", "missionId", "botId?", "profileId?", "openedAt", "longLived?" }],
       "sandboxes": [{ "id", "missionId", "openedAt" }],
       "agentComputer": { "desktopId"?, "volumeId"?, "lastSnapshotId"? },
       "agentComputersByBotId": { "<botId>": { "desktopId"?, "volumeId"?, "lastSnapshotId"? } }
     }
   The agentComputer fields arrive additively (volume first, then desktop,
   then snapshots), so all three are optional here. Per-bot desktops (C50)
   live in agentComputersByBotId without removing the shared AC fallback.
*/

import { getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';
import { getCachedProjectRoot } from '../agents/projectRootCache.js';
import { getSolariClients } from './solariClient.js';

// ── Constants ──────────────────────────────────────────────────────

export const LEDGER_FILE = '.lazy/solari-sessions.json';
export const LEDGER_VERSION = '1.0.0';
export const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
export const WORKSPACE_MOUNT_PATH = '/workspace';
export const WORKSPACE_VOLUME_NAME = 'lazybot-workspace';

// ── Types ──────────────────────────────────────────────────────────

/** Persisted Agent Computer fields; created additively as ids arrive. */
export interface AgentComputerLedger {
  desktopId?: string;
  volumeId?: string;
  lastSnapshotId?: string;
}

export interface LedgerBrowserSession {
  id: string;
  missionId: string;
  botId?: string;
  profileId?: string;
  openedAt: number;
  /** When true, releaseBrowser parks the session for the bot instead of destroying CDP (C49). */
  longLived?: boolean;
}

export interface LedgerSandbox {
  id: string;
  missionId: string;
  openedAt: number;
}

export interface LedgerState {
  version: string;
  browserSessions: LedgerBrowserSession[];
  sandboxes: LedgerSandbox[];
  agentComputer: AgentComputerLedger | null;
  /** Per-bot Agent Computers (C50). Shared `agentComputer` remains the no-botId fallback. */
  agentComputersByBotId: Record<string, AgentComputerLedger>;
}

// ── Module state ───────────────────────────────────────────────────

let ledgerRoot: string | null = null;

// Serializes ledger read-modify-write cycles so concurrent opens/releases
// never interleave and lose an update.
let ledgerOpTail: Promise<unknown> = Promise.resolve();

export function enqueueLedgerOp<T>(op: () => Promise<T>): Promise<T> {
  const run = ledgerOpTail.then(op, op);
  ledgerOpTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ── Ledger IO ──────────────────────────────────────────────────────

/** Set the project root that hosts .lazy/solari-sessions.json. Defaults to
 *  the cached project root; override for tests and unusual setups. */
export function setSolariSessionsRoot(root: string): void {
  ledgerRoot = root;
}

function ledgerRootPath(): string {
  return ledgerRoot ?? getCachedProjectRoot() ?? '';
}

function ledgerFilePath(): string {
  return joinPath(ledgerRootPath(), LEDGER_FILE);
}

function emptyLedger(): LedgerState {
  return {
    version: LEDGER_VERSION,
    browserSessions: [],
    sandboxes: [],
    agentComputer: null,
    agentComputersByBotId: {},
  };
}

function isBrowserEntry(value: unknown): value is LedgerBrowserSession {
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.missionId === 'string' && typeof record.openedAt === 'number';
}

function normalizeAgentComputerLedger(value: unknown): AgentComputerLedger | null {
  if (typeof value !== 'object' || value === null) return null;
  const ac = value as Record<string, unknown>;
  return {
    ...(typeof ac.desktopId === 'string' ? { desktopId: ac.desktopId } : {}),
    ...(typeof ac.volumeId === 'string' ? { volumeId: ac.volumeId } : {}),
    ...(typeof ac.lastSnapshotId === 'string' ? { lastSnapshotId: ac.lastSnapshotId } : {}),
  };
}

function isSandboxEntry(value: unknown): value is LedgerSandbox {
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.missionId === 'string' && typeof record.openedAt === 'number';
}

function normalizeLedger(raw: unknown): LedgerState {
  const state = emptyLedger();
  if (typeof raw !== 'object' || raw === null) return state;
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.browserSessions)) {
    state.browserSessions = record.browserSessions.filter(isBrowserEntry).map((s) => {
      const row = s as LedgerBrowserSession & Record<string, unknown>;
      return {
        id: row.id,
        missionId: row.missionId,
        openedAt: row.openedAt,
        ...(typeof row.botId === 'string' ? { botId: row.botId } : {}),
        ...(typeof row.profileId === 'string' ? { profileId: row.profileId } : {}),
        ...(row.longLived === true ? { longLived: true } : {}),
      };
    });
  }
  if (Array.isArray(record.sandboxes)) state.sandboxes = record.sandboxes.filter(isSandboxEntry);
  state.agentComputer = normalizeAgentComputerLedger(record.agentComputer);
  if (typeof record.agentComputersByBotId === 'object' && record.agentComputersByBotId !== null) {
    const byBot: Record<string, AgentComputerLedger> = {};
    for (const [botId, value] of Object.entries(record.agentComputersByBotId as Record<string, unknown>)) {
      const ac = normalizeAgentComputerLedger(value);
      if (ac && (ac.desktopId || ac.volumeId || ac.lastSnapshotId)) byBot[botId] = ac;
    }
    state.agentComputersByBotId = byBot;
  }
  return state;
}

/** Read the persisted ledger; a missing or corrupt file yields a fresh one. */
export async function readLedger(): Promise<LedgerState> {
  const platform = getPlatform();
  if (!platform?.fs) return emptyLedger();
  try {
    const raw = await platform.fs.readFile(ledgerFilePath());
    return normalizeLedger(JSON.parse(raw));
  } catch {
    return emptyLedger();
  }
}

/** Write the ledger, tolerating platform IO failures with a warn (never throws). */
export async function writeLedger(state: LedgerState): Promise<void> {
  const platform = getPlatform();
  if (!platform?.fs) return;
  try {
    await platform.fs.createDir(joinPath(ledgerRootPath(), '.lazy'));
    await platform.fs.writeFile(ledgerFilePath(), JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('[solariSessions] Failed to persist session ledger:', err);
  }
}

/** Serialized read-modify-write against the persisted ledger. */
export function updateLedger(mutate: (state: LedgerState) => LedgerState): Promise<void> {
  return enqueueLedgerOp(async () => {
    const state = await readLedger();
    await writeLedger(mutate(state));
  });
}

// ── Shared workspace volume ────────────────────────────────────────

/** Return the shared workspace volume id, creating it exactly once (serialized
 *  against the ledger) under the name "lazybot-workspace". Lives here because
 *  both sandboxes and the Agent Computer mount it. */
export async function ensureWorkspaceVolume(): Promise<string> {
  const clients = await getSolariClients();
  return enqueueLedgerOp(async () => {
    const state = await readLedger();
    if (state.agentComputer?.volumeId) return state.agentComputer.volumeId;
    const volume = await clients.sandbox.volumes.create({ name: WORKSPACE_VOLUME_NAME });
    await writeLedger({
      ...state,
      agentComputer: { ...(state.agentComputer ?? {}), volumeId: volume.volumeId },
    });
    return volume.volumeId;
  });
}

