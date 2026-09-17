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
import { getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';
import { getCachedProjectRoot } from '../agents/projectRootCache.js';
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
  destroyQuietly,
  desktopRecordIsDead,
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
  /** Solari managed proxy tier (residential/static/mobile). */
  proxyTier?: string;
  /** Sticky proxy session id — reuses the same egress IP across opens. */
  proxySession?: string;
  /** Escalate to the "smart" proxy pool when the primary fails. */
  proxySmart?: boolean;
  /** Enable Solari web-bot auth injection (WBA). */
  webBotAuth?: boolean;
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
  /** Launch flags, kept so reuse never silently returns a session with a
   *  different stealth/proxy/captcha configuration than requested. */
  flags: OpenBrowserSessionOptions;
  /** Whether recording was on — release captures the replay URL (C-replay). */
  recording?: boolean;
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
  // Managed proxy egress requires the stealth shim (SDK contract), so any
  // proxy option without an explicit stealth flag still enables it.
  const wantsProxy = Boolean(opts.proxyCountry || opts.proxyTier || opts.proxySession || opts.proxySmart);
  if (opts.stealth || wantsProxy) launch.stealth = true;
  if (wantsProxy) {
    launch.proxy = {
      ...(opts.proxyCountry ? { country: opts.proxyCountry } : {}),
      ...(opts.proxyTier ? { tier: opts.proxyTier } : {}),
      ...(opts.proxySession ? { session: opts.proxySession } : {}),
    };
    if (opts.proxySmart) launch.proxy = { ...launch.proxy, tier: 'smart' };
  }
  if (opts.captcha) launch.captcha = true;
  if (opts.recording) launch.recording = true;
  if (opts.webBotAuth) launch.webBotAuth = true;
  return launch;
}

/** Normalise launch-relevant fields so `{stealth: undefined}` equals `{}` —
 *  reuse must never return a session whose flags differ from the request. */
function flagsMatch(a: OpenBrowserSessionOptions, b: OpenBrowserSessionOptions): boolean {
  const keys: Array<keyof OpenBrowserSessionOptions> = [
    'profileId', 'stealth', 'proxyCountry', 'proxyTier', 'proxySession',
    'proxySmart', 'webBotAuth', 'captcha', 'recording', 'longLived',
  ];
  return keys.every((k) => (a[k] ?? undefined) === (b[k] ?? undefined));
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
    if (existing.botId === opts.botId && flagsMatch(existing.flags, opts)) return existing.handle;
    await releaseBrowser(missionId, { hard: true });
  }

  // C49b — resurrect a parked persona from the LEDGER (crash-safe): the
  // in-memory botBrowserRegistry dies with the process, the ledger does not.
  if (opts.botId && opts.longLived && !botBrowserRegistry.has(personaKey(opts.botId, opts.profileId))) {
    const ledger = await readLedger();
    const parkedRow = ledger.browserSessions.find(
      (s) => s.botId === opts.botId && s.longLived && s.profileId === opts.profileId,
    );
    if (parkedRow) {
      const resumed = await resumeBrowserSession(missionId, opts.botId);
      if (resumed) return resumed;
    }
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
      flags: { ...opts },
      recording: opts.recording === true,
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
      // Resumed sessions keep the profile flag so flagsMatch accepts reuse.
      flags: { profileId: entry.profileId, botId: entry.botId, longLived: entry.longLived },
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

/** Best-effort: capture cookies/localStorage via CDP and save them into the
 *  session's Solari profile so logins actually persist across sessions —
 *  this is what makes a profile a "persona" instead of an empty shell. */
async function saveProfileState(entry: BrowserEntry): Promise<void> {
  if (!entry.profileId) return;
  try {
    const page = entry.handle.browser.contexts()[0]?.pages()[0];
    if (!page) return;
    const storageState = await page.context().storageState();
    if (storageState.cookies.length === 0 && storageState.origins.length === 0) return;
    const clients = await getSolariClients();
    await clients.browser.profiles.save(entry.profileId, storageState);
  } catch (err) {
    console.warn('[solariSessions] profile save failed for', entry.profileId, err);
  }
}

/** After releaseAndWait, the replay URL becomes available (~1-3s). Persist
 *  the NDJSON transcript under .lazy/replays/ — credential material, never
 *  logged — and remember the URL for run history.
 *
 *  The presigned URL lives on storage.googleapis.com — webview fetch() to
 *  that origin is CORS-blocked (verified live), so the bytes are pulled by
 *  the Rust `solari_replay_download` command (no Origin policy, host-
 *  allowlisted to *.storage.googleapis.com, project-jailed dest). Falls
 *  back to a direct fetch in non-Tauri contexts (tests, web platform). */
/** base64 → Uint8Array (the solari_replay_fetch bridge payload). Chunked
 *  atob — String.fromCharCode(...bytes) blows the argument limit ~100KB. */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Replay bytes → NDJSON text. GCS stores the transcript gzipped (magic
 *  1f 8b); anything else is assumed already-plaintext and decoded as UTF-8.
 *  DecompressionStream is evergreen-Chromium / Node ≥17 — available in the
 *  webview, tests, and the packaged app alike. */
async function replayBytesToNdjson(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new DecompressionStream('gzip');
    const writer = stream.writable.getWriter();
    void writer.write(bytes).then(() => writer.close());
    const decompressed = await new Response(stream.readable).arrayBuffer();
    return new TextDecoder().decode(decompressed);
  }
  return new TextDecoder().decode(bytes);
}

async function captureReplay(entry: BrowserEntry, missionId: string): Promise<void> {
  if (!entry.recording) return;
  try {
    const clients = await getSolariClients();
    const { url } = await clients.browser.sessions.getReplayUrl(entry.handle.sessionId);
    recordBrowserArtifact(missionId, { sessionId: entry.handle.sessionId, replayUrl: url });
    const platform = getPlatform();
    const root = getCachedProjectRoot();
    if (platform?.fs && root) {
      const dir = joinPath(root, '.lazy', 'replays');
      await platform.fs.createDir(dir);
      // Stored DECOMPRESSED as plain .ndjson — a human-readable transcript
      // the user can actually inspect (open-source transparency), and the
      // ordinary text write path covers both the Rust-fetch and dev-proxy
      // byte sources without a binary fs primitive.
      const path = joinPath(dir, `${entry.handle.sessionId}.ndjson`);
      let bytes: Uint8Array<ArrayBuffer> | null = null;
      try {
        // Packaged Tauri: Rust does the GCS fetch (no Origin policy, host-
        // allowlisted). The command returns base64 — never touches disk.
        const { invoke } = await import('@tauri-apps/api/core');
        bytes = base64ToBytes(await invoke<string>('solari_replay_fetch', { url }));
      } catch {
        // Non-Tauri context, dev on an older shell, or web: fall back to a
        // webview fetch — in dev the Vite /solari-replay proxy forwards the
        // bytes same-origin past the GCS CORS block.
        try {
          bytes = new Uint8Array(
            await clients.browser.sessions.downloadReplay(entry.handle.sessionId),
          );
        } catch {
          bytes = null;
        }
      }
      if (bytes) {
        await platform.fs.writeFile(path, await replayBytesToNdjson(bytes));
        recordBrowserArtifact(missionId, { sessionId: entry.handle.sessionId, replayUrl: url, replayPath: path });
      }
    }
  } catch (err) {
    console.warn('[solariSessions] replay capture failed:', err);
  }
}

/** Browser artifacts captured at release (replay URL / saved path). */
export interface BrowserArtifacts {
  sessionId: string;
  replayUrl?: string;
  replayPath?: string;
}

const browserArtifacts = new Map<string, BrowserArtifacts>();

/** Late-bound stamper registered by botEngine at module init — this module
 *  cannot import botEngine (botEngine already imports us), so the engine
 *  hands over the function. It stamps artifacts onto the live BotRun AND
 *  re-persists `.lazy/bot-runtime.json`, which is what actually survives a
 *  renderer reload mid-run: this in-memory map does not (real M138 incident
 *  — a restart between browser-close and run-finalize dropped the recorded
 *  replayUrl/replayPath from the history entry even though the .ndjson file
 *  was safely on disk). */
let runArtifactStamper:
  | ((missionId: string, artifact: { replayUrl?: string; replayPath?: string }) => void)
  | null = null;

export function registerRunArtifactStamper(
  fn: (missionId: string, artifact: { replayUrl?: string; replayPath?: string }) => void,
): void {
  runArtifactStamper = fn;
}

function recordBrowserArtifact(missionId: string, artifact: BrowserArtifacts): void {
  browserArtifacts.set(missionId, { ...browserArtifacts.get(missionId), ...artifact });
  runArtifactStamper?.(missionId, artifact);
}

/** Read the captured artifacts without consuming them — run history still
 *  owns the take; tools (e.g. cloud_browser_replay_url) only peek. */
export function peekBrowserArtifacts(missionId: string): BrowserArtifacts | undefined {
  return browserArtifacts.get(missionId);
}

/** Consume the captured artifacts for a mission (run history attaches them). */
export function takeBrowserArtifacts(missionId: string): BrowserArtifacts | undefined {
  const a = browserArtifacts.get(missionId);
  browserArtifacts.delete(missionId);
  return a;
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
  // Persist login state into the Solari profile BEFORE the session dies —
  // after browser.close() the CDP socket is gone and cookies are lost.
  await saveProfileState(entry);
  try {
    await entry.handle.browser.close();
  } catch (err) {
    console.error('[solariSessions] Failed to close browser session for mission', missionId, err);
  }
  // The session is released now — the presigned replay becomes fetchable.
  await captureReplay(entry, missionId);
  await updateLedger((state) => ({
    ...state,
    browserSessions: state.browserSessions.filter((s) => s.id !== entry.handle.sessionId),
  }));
  if (entry.profileId) releaseProfileLock(entry.profileId, missionId);
}

/** Hard-destroy a parked long-lived persona browser (C49). Falls back to
 *  the ledger when the in-memory registry lost the session (crash). */
export async function destroyPersonaBrowserSession(
  botId: string,
  profileId?: string,
): Promise<void> {
  const key = personaKey(botId, profileId);
  const parked = botBrowserRegistry.get(key);
  if (!parked) {
    // Crash-recovery path: the registry is empty but the ledger still lists
    // a longLived session for this bot — release it remotely, then clean up.
    const ledger = await readLedger();
    const row = ledger.browserSessions.find(
      (s) => s.botId === botId && s.longLived && (profileId === undefined || s.profileId === profileId),
    );
    if (row) {
      try {
        const clients = await getSolariClients();
        await clients.browser.sessions.releaseAndWait(row.id);
      } catch (err) {
        console.warn('[solariSessions] persona release unreachable — dropping ledger entry:', row.id, err);
      }
      await updateLedger((state) => ({
        ...state,
        browserSessions: state.browserSessions.filter((s) => s.id !== row.id),
      }));
      if (row.profileId) releaseProfileLock(row.profileId, row.id);
    }
    return;
  }
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
  const base = {
    template: opts.template,
    cpu: opts.cpu,
    memMb: opts.memMb,
    timeoutMs: SESSION_TIMEOUT_MS,
    lifecycle: { onTimeout: 'pause' as const },
  };
  // The shared /workspace volume is best-effort: the Solari sandbox backend
  // rejects `volumes` on providers where mounts are unsupported (501
  // "volumes not yet available on gcp"). Try the mount, retry without it —
  // a bare create surfaces real errors (auth/concurrency) unchanged.
  let sandbox;
  try {
    const volumeId = await ensureWorkspaceVolume();
    sandbox = await clients.sandbox.create({
      ...base,
      volumes: [{ volumeId, path: WORKSPACE_MOUNT_PATH }],
    });
  } catch {
    sandbox = await clients.sandbox.create(base);
  }
  // The control WebSocket is NOT opened by create() — every channel op
  // (commands.run, runCode, files.*) fails "Not connected" without it.
  await sandbox.connect();
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

  // Per-bot desktops (C50): without this check a bot VM that died while the
  // app was closed stays in the ledger forever — and still counts against
  // the account concurrency cap server-side (real incident: a 4-day-old
  // phantom desktop made every cloud_desktop_open return 429). Verify each
  // entry; destroy + drop the dead ones, keep live ones for warm reuse.
  if (clients) {
    const deadBots: string[] = [];
    for (const [botId, entry] of Object.entries(ledger.agentComputersByBotId ?? {})) {
      if (!entry?.desktopId) continue;
      try {
        const info = await clients.desktop.get(entry.desktopId);
        if (desktopRecordIsDead(info)) {
          await destroyQuietly(clients, entry.desktopId);
          deadBots.push(botId);
        }
      } catch {
        // lookup failed (404/gone) — the entry can never re-attach
        deadBots.push(botId);
      }
    }
    if (deadBots.length > 0) {
      const dead = new Set(deadBots);
      await updateLedger((state) => ({
        ...state,
        agentComputersByBotId: Object.fromEntries(
          Object.entries(state.agentComputersByBotId ?? {}).filter(([botId]) => !dead.has(botId)),
        ),
      }));
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



