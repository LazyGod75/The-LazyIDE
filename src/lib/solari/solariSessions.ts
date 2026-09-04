/* solariSessions.ts — Solari session registry for LazyBot.

   Hybrid lifecycle model (see .lazy/dispatch/a2.md):
   1. Browser sessions are per-mission by default. With botId+longLived (C49)
      a persona/profile session is parked across missions instead of destroyed.
   2. Desktop: shared Agent Computer (no botId) OR per-bot VMs via
      ledger.agentComputersByBotId (C50) when ensureAgentComputer(botId) is used.
   3. Sandboxes are per-mission-run (ephemeral, pause-on-idle).
   A shared volume is mounted at /workspace on every desktop/sandbox.
*/

import type { CloudCdpBrowser } from './cdpBrowser.js';
import type { Sandbox } from '@solarisdk/sandbox';
import { getSolariClients, solariCdpProxyBase, type CloudBrowserLaunchOptions } from './solariClient.js';
import {
  readLedger,
  updateLedger,
  ensureWorkspaceVolume,
  SESSION_TIMEOUT_MS,
  WORKSPACE_MOUNT_PATH,
} from './sessionLedger.js';
import {
  ensureAgentComputer,
  acquireAgentComputer,
  releaseAgentComputer,
  snapshotAgentComputer,
  isAgentComputerHeldBy,
  resetAgentComputerState,
} from './agentComputer.js';
import type { AgentComputerHandle } from './agentComputer.js';

export {
  ensureAgentComputer,
  acquireAgentComputer,
  releaseAgentComputer,
  snapshotAgentComputer,
  type AgentComputerHandle,
};

export {
  setSolariSessionsRoot,
  readLedger,
  updateLedger,
  ensureWorkspaceVolume,
  WORKSPACE_MOUNT_PATH,
  WORKSPACE_VOLUME_NAME,
} from './sessionLedger.js';
export type { AgentComputerLedger, LedgerBrowserSession, LedgerSandbox, LedgerState } from './sessionLedger.js';

// ── Types ──────────────────────────────────────────────────────────

export interface OpenBrowserSessionOptions {
  profileId?: string;
  stealth?: boolean;
  proxyCountry?: string;
  captcha?: boolean;
  recording?: boolean;
  /** Owning LazyBot — enables long-lived persona reuse (C49). */
  botId?: string;
  /** Keep CDP + Solari profile session across mission release (C49). */
  longLived?: boolean;
}

export interface BrowserSessionHandle {
  sessionId: string;
  browser: CloudCdpBrowser;
  close(): Promise<void>;
}

export interface OpenSandboxOptions {
  template?: string;
  cpu?: number;
  memMb?: number;
}

export interface SandboxHandle {
  sandbox: Sandbox;
  close(): Promise<void>;
}

// ── Module state ───────────────────────────────────────────────────

interface BrowserEntry {
  handle: BrowserSessionHandle;
  profileId?: string;
  botId?: string;
  longLived?: boolean;
  openedAt: number;
}

const browserRegistry = new Map<string, BrowserEntry>();
/** Long-lived persona sessions keyed by botId (C49) — survive mission release. */
const botBrowserRegistry = new Map<string, BrowserEntry>();

interface SandboxEntry {
  handle: SandboxHandle;
  openedAt: number;
}

const sandboxRegistry = new Map<string, SandboxEntry>();

interface ProfileQueue {
  holder: string | null;
  waiters: Array<{ missionId: string; resolve: () => void }>;
}

const profileLocks = new Map<string, ProfileQueue>();

// ── Profile lock ───────────────────────────────────────────────────

function getProfileQueue(profileId: string): ProfileQueue {
  let queue = profileLocks.get(profileId);
  if (!queue) {
    queue = { holder: null, waiters: [] };
    profileLocks.set(profileId, queue);
  }
  return queue;
}

/** Waits (FIFO) until the profile is free, then marks it held by missionId. */
function acquireProfileLock(profileId: string, missionId: string): Promise<void> {
  const queue = getProfileQueue(profileId);
  if (queue.holder === null || queue.holder === missionId) {
    queue.holder = missionId;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    queue.waiters.push({ missionId, resolve });
  });
}

/** Releases the profile lock and hands it to the next FIFO waiter, if any. */
function releaseProfileLock(profileId: string, missionId: string): void {
  const queue = profileLocks.get(profileId);
  if (!queue || queue.holder !== missionId) return;
  queue.holder = null;
  const next = queue.waiters.shift();
  if (next) {
    queue.holder = next.missionId;
    next.resolve();
  }
  if (queue.holder === null) profileLocks.delete(profileId);
}

// ── Browser sessions ───────────────────────────────────────────────

function buildLaunchOptions(opts: OpenBrowserSessionOptions): CloudBrowserLaunchOptions {
  const launch: CloudBrowserLaunchOptions = {};
  if (opts.profileId) launch.profileId = opts.profileId;
  // Managed proxy egress requires the stealth shim (SDK contract), so a
  // proxyCountry without an explicit stealth flag still enables it.
  if (opts.stealth || opts.proxyCountry) launch.stealth = true;
  if (opts.proxyCountry) launch.proxy = { country: opts.proxyCountry };
  if (opts.captcha) launch.captcha = true;
  if (opts.recording) launch.recording = true;
  return launch;
}

function personaKey(botId: string, profileId?: string): string {
  return `${botId}::${profileId ?? ''}`;
}

/** Open (or reuse) a mission's browser session, enforcing the profile lock.
 *  With botId+longLived, reuses the bot's parked persona session across missions (C49). */
export async function openBrowserSession(
  missionId: string,
  opts: OpenBrowserSessionOptions = {},
): Promise<BrowserSessionHandle> {
  const existing = browserRegistry.get(missionId);
  if (existing) {
    if (existing.profileId === opts.profileId && existing.botId === opts.botId) return existing.handle;
    await releaseBrowser(missionId, { hard: true });
  }

  // C49 — adopt a parked long-lived persona session for this bot+profile
  if (opts.botId && opts.longLived) {
    const parked = botBrowserRegistry.get(personaKey(opts.botId, opts.profileId));
    if (parked) {
      browserRegistry.set(missionId, { ...parked, longLived: true });
      await updateLedger((state) => ({
        ...state,
        browserSessions: [
          ...state.browserSessions.filter((s) => s.id !== parked.handle.sessionId),
          {
            id: parked.handle.sessionId,
            missionId,
            botId: opts.botId,
            profileId: opts.profileId,
            openedAt: parked.openedAt,
            longLived: true,
          },
        ],
      }));
      return parked.handle;
    }
  }

  const clients = await getSolariClients();
  if (opts.profileId) await acquireProfileLock(opts.profileId, missionId);
  try {
    const browser = await clients.browser.launch(buildLaunchOptions(opts));
    const openedAt = Date.now();
    const handle: BrowserSessionHandle = {
      sessionId: browser.id,
      browser,
      close: () => releaseBrowser(missionId, { hard: true }),
    };
    const entry: BrowserEntry = {
      handle,
      profileId: opts.profileId,
      botId: opts.botId,
      longLived: opts.longLived === true,
      openedAt,
    };
    browserRegistry.set(missionId, entry);
    if (opts.botId && opts.longLived) {
      botBrowserRegistry.set(personaKey(opts.botId, opts.profileId), entry);
    }
    await updateLedger((state) => ({
      ...state,
      browserSessions: [
        ...state.browserSessions.filter((s) => s.missionId !== missionId && s.id !== browser.id),
        {
          id: browser.id,
          missionId,
          botId: opts.botId,
          profileId: opts.profileId,
          openedAt,
          ...(opts.longLived ? { longLived: true } : {}),
        },
      ],
    }));
    return handle;
  } catch (err) {
    if (opts.profileId) releaseProfileLock(opts.profileId, missionId);
    throw err;
  }
}

export function missionIdForBrowserSession(sessionId: string): string | undefined {
  for (const [missionId, entry] of browserRegistry) {
    if (entry.handle.sessionId === sessionId) return missionId;
  }
  return undefined;
}

/** The active browser handle for a mission, or undefined. */
export function getBrowserSession(missionId: string): BrowserSessionHandle | undefined {
  return browserRegistry.get(missionId)?.handle;
}

/**
 * C49 — Re-attach CDP to a ledger browser session after a process crash.
 * Long-lived persona/cookies live in the Solari profile (profileId); this
 * restores the live control channel. Returns null when the ledger has
 * no session for this mission (or botId when provided).
 */
export async function resumeBrowserSession(
  missionId: string,
  botId?: string,
): Promise<BrowserSessionHandle | null> {
  const existing = browserRegistry.get(missionId);
  if (existing) return existing.handle;
  const ledger = await readLedger();
  const entry =
    ledger.browserSessions.find((s) => s.missionId === missionId)
    ?? (botId
      ? ledger.browserSessions.find((s) => s.botId === botId && s.longLived)
      : undefined);
  if (!entry) return null;
  const clients = await getSolariClients();
  if (entry.profileId) await acquireProfileLock(entry.profileId, missionId);
  try {
    const { CloudCdpBrowser } = await import('./cdpBrowser.js');
    const browser = await CloudCdpBrowser.connect(
      {
        id: entry.id,
        expiresAt: new Date(Date.now() + SESSION_TIMEOUT_MS).toISOString(),
        cdpEndpoint: '',
      },
      solariCdpProxyBase(),
      () => clients.browser.release(entry.id),
    );
    const handle: BrowserSessionHandle = {
      sessionId: browser.id,
      browser,
      close: () => releaseBrowser(missionId, { hard: true }),
    };
    const browserEntry: BrowserEntry = {
      handle,
      profileId: entry.profileId,
      botId: entry.botId,
      longLived: entry.longLived,
      openedAt: entry.openedAt,
    };
    browserRegistry.set(missionId, browserEntry);
    if (entry.botId && entry.longLived) {
      botBrowserRegistry.set(personaKey(entry.botId, entry.profileId), browserEntry);
    }
    await updateLedger((state) => ({
      ...state,
      browserSessions: state.browserSessions.map((s) =>
        s.id === entry.id ? { ...s, missionId } : s,
      ),
    }));
    return handle;
  } catch (err) {
    if (entry.profileId) releaseProfileLock(entry.profileId, missionId);
    console.warn('[solariSessions] resumeBrowserSession failed — leaving ledger entry:', entry.id, err);
    return null;
  }
}

/** Close or park the mission's browser session. Long-lived persona sessions
 *  (C49) stay in botBrowserRegistry + ledger until hard:true or destroyPersonaSession. */
export async function releaseBrowser(
  missionId: string,
  opts: { hard?: boolean } = {},
): Promise<void> {
  const entry = browserRegistry.get(missionId);
  if (!entry) return;
  browserRegistry.delete(missionId);

  if (entry.longLived && entry.botId && !opts.hard) {
    botBrowserRegistry.set(personaKey(entry.botId, entry.profileId), entry);
    await updateLedger((state) => ({
      ...state,
      browserSessions: state.browserSessions.map((s) =>
        s.id === entry.handle.sessionId
          ? { ...s, missionId: '', botId: entry.botId, longLived: true }
          : s,
      ),
    }));
    // Keep profile lock held by the parked persona key so another bot cannot steal it mid-park.
    return;
  }

  if (entry.botId) {
    botBrowserRegistry.delete(personaKey(entry.botId, entry.profileId));
  }
  try {
    await entry.handle.browser.close();
  } catch (err) {
    console.error('[solariSessions] Failed to close browser session for mission', missionId, err);
  }
  await updateLedger((state) => ({
    ...state,
    browserSessions: state.browserSessions.filter((s) => s.id !== entry.handle.sessionId),
  }));
  if (entry.profileId) releaseProfileLock(entry.profileId, missionId);
}

/** Hard-destroy a parked long-lived persona browser (C49). */
export async function destroyPersonaBrowserSession(
  botId: string,
  profileId?: string,
): Promise<void> {
  const key = personaKey(botId, profileId);
  const parked = botBrowserRegistry.get(key);
  if (!parked) return;
  botBrowserRegistry.delete(key);
  for (const [missionId, entry] of [...browserRegistry.entries()]) {
    if (entry.handle.sessionId === parked.handle.sessionId) browserRegistry.delete(missionId);
  }
  try {
    await parked.handle.browser.close();
  } catch (err) {
    console.error('[solariSessions] Failed to destroy persona browser', botId, err);
  }
  await updateLedger((state) => ({
    ...state,
    browserSessions: state.browserSessions.filter((s) => s.id !== parked.handle.sessionId),
  }));
  if (parked.profileId) releaseProfileLock(parked.profileId, parked.handle.sessionId);
}

// ── Sandboxes ──────────────────────────────────────────────────────

/** Open a mission sandbox (pause-on-idle) with the shared /workspace volume
 *  mounted, or return the already-open handle for this mission. */
export async function openSandbox(
  missionId: string,
  opts: OpenSandboxOptions = {},
): Promise<SandboxHandle> {
  const existing = sandboxRegistry.get(missionId);
  if (existing) return existing.handle;
  const clients = await getSolariClients();
  const volumeId = await ensureWorkspaceVolume();
  const sandbox = await clients.sandbox.create({
    template: opts.template,
    cpu: opts.cpu,
    memMb: opts.memMb,
    timeoutMs: SESSION_TIMEOUT_MS,
    lifecycle: { onTimeout: 'pause' },
    volumes: [{ volumeId, path: WORKSPACE_MOUNT_PATH }],
  });
  const openedAt = Date.now();
  const handle: SandboxHandle = { sandbox, close: () => releaseSandbox(missionId) };
  sandboxRegistry.set(missionId, { handle, openedAt });
  await updateLedger((state) => ({
    ...state,
    sandboxes: [
      ...state.sandboxes.filter((s) => s.missionId !== missionId),
      { id: sandbox.id, missionId, openedAt },
    ],
  }));
  return handle;
}

/** The active sandbox handle for a mission, or undefined. */
export function getSandbox(missionId: string): SandboxHandle | undefined {
  return sandboxRegistry.get(missionId)?.handle;
}

/** Kill the mission's sandbox and remove it from the ledger. Idempotent. */
export async function releaseSandbox(missionId: string): Promise<void> {
  const entry = sandboxRegistry.get(missionId);
  if (!entry) return;
  sandboxRegistry.delete(missionId);
  try {
    await entry.handle.sandbox.kill();
  } catch (err) {
    console.error('[solariSessions] Failed to kill sandbox for mission', missionId, err);
  }
  await updateLedger((state) => ({
    ...state,
    sandboxes: state.sandboxes.filter((s) => s.missionId !== missionId),
  }));
}

// ── Teardown + crash sweep ─────────────────────────────────────────

async function tryBestEffort(op: () => Promise<unknown>, what: string): Promise<void> {
  try {
    await op();
  } catch (err) {
    console.error(`[solariSessions] ${what} failed:`, err);
  }
}

/** Release everything a mission owns. If the mission still holds the Agent
 *  Computer mutex, snapshot it FIRST (label 'post-run'), then release the
 *  mutex. Never throws — every resource is best-effort. */
export async function releaseAll(missionId: string): Promise<void> {
  await tryBestEffort(() => releaseBrowser(missionId), 'releaseBrowser');
  await tryBestEffort(() => releaseSandbox(missionId), 'releaseSandbox');
  if (isAgentComputerHeldBy(missionId)) {
    await tryBestEffort(() => snapshotAgentComputer('post-run'), 'post-run snapshot');
    releaseAgentComputer(missionId);
  }
}

/** Sweep orphaned resources at boot: every ledger browser/sandbox whose
 *  mission is not active in this process is released and dropped; the Agent
 *  Computer is re-attached, never destroyed. Best-effort — unreachable ids
 *  are dropped with a console.warn, never thrown. */
export async function sweepOrphans(): Promise<void> {
  const ledger = await readLedger();
  const activeMissions = new Set<string>([...browserRegistry.keys(), ...sandboxRegistry.keys()]);
  const orphanBrowsers = ledger.browserSessions.filter(
    (s) => !s.longLived && s.missionId && !activeMissions.has(s.missionId),
  );
  const orphanSandboxes = ledger.sandboxes.filter((s) => !activeMissions.has(s.missionId));
  const clients = await getSolariClients().catch(() => null);

  for (const entry of orphanBrowsers) {
    if (!clients) {
      console.warn('[solariSessions] No Solari clients — dropping unreachable orphan browser entry:', entry.id);
    } else {
      try {
        await clients.browser.sessions.releaseAndWait(entry.id);
      } catch (err) {
        console.warn('[solariSessions] Orphan browser session unreachable — dropping ledger entry:', entry.id, err);
      }
    }
  }
  for (const entry of orphanSandboxes) {
    if (!clients) {
      console.warn('[solariSessions] No Solari clients — dropping unreachable orphan sandbox entry:', entry.id);
    } else {
      try {
        await clients.sandbox.kill(entry.id);
      } catch (err) {
        console.warn('[solariSessions] Orphan sandbox unreachable — dropping ledger entry:', entry.id, err);
      }
    }
  }

  if (orphanBrowsers.length > 0 || orphanSandboxes.length > 0) {
    const browserIds = new Set(orphanBrowsers.map((s) => s.id));
    const sandboxIds = new Set(orphanSandboxes.map((s) => s.id));
    await updateLedger((state) => ({
      ...state,
      browserSessions: state.browserSessions.filter((s) => !browserIds.has(s.id)),
      sandboxes: state.sandboxes.filter((s) => !sandboxIds.has(s.id)),
    }));
  }

  if (ledger.agentComputer?.desktopId) {
    try {
      await ensureAgentComputer();
    } catch (err) {
      console.warn('[solariSessions] Could not re-attach Agent Computer — keeping its ledger entry:', err);
    }
  }
}

/** Clear all in-memory registries and queues — tests and hot-reload only.
 *  Leaves the on-disk ledger untouched. */
export function resetSolariSessionsState(): void {
  browserRegistry.clear();
  botBrowserRegistry.clear();
  sandboxRegistry.clear();
  profileLocks.clear();
  resetAgentComputerState();
}



