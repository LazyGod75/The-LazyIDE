/* solariClient — lazy singletons for the three Solari SDK clients, plus
   vault-backed API key management and typed error mapping.

   Construction is lazy on purpose: importing this module never reads the
   vault and never constructs an SDK client, so it is safe to import (and
   unit-test) with a mocked vault. The Solari API key lives ONLY in the OS
   vault under the "solari" key (see vaultClient.ts); it is never cached or
   persisted anywhere else in the app.
*/

import type { DesktopClient as SolariDesktopClient } from '@solarisdk/desktop';
import type { SandboxClient as SolariSandboxClient } from '@solarisdk/sandbox';
import { getSecretPresence, getSecretRaw } from '../vault/vaultClient.js';
import { emit } from '../bus.js';

export const SOLARI_VAULT_KEY = 'solari';

const SOLARI_BASE_URL = 'https://api.getsolari.com';

/** Cached base from the Tauri Rust Origin-strip proxy (C72). */
let cachedTauriCdpProxyBase: string | null = null;

export interface SolariCdpProxyOpts {
  /** Override import.meta.env.DEV — tests only. */
  isDev?: boolean;
}

/** CDP/ws base: Vite same-origin proxy in DEV (strips Origin). Packaged
 *  Tauri prefers the local Rust proxy (`solari_cdp_proxy_base`) which
 *  mirrors vite `/solari-cdp` Origin stripping; falls back to direct
 *  `wss://api.getsolari.com` until hydrateSolariCdpProxy() succeeds. */
export function solariCdpProxyBase(opts?: SolariCdpProxyOpts): string {
  const isDev = opts?.isDev ?? import.meta.env.DEV;
  if (typeof window === 'undefined') return 'wss://api.getsolari.com';
  if (isDev) return `${window.location.origin}/solari-cdp`;
  if (cachedTauriCdpProxyBase) return cachedTauriCdpProxyBase;
  return 'wss://api.getsolari.com';
}

/** Resolve the Rust CDP proxy URL once at boot (packaged Tauri only). */
export async function hydrateSolariCdpProxy(opts?: {
  force?: boolean;
  isDev?: boolean;
}): Promise<string | null> {
  const isDev = opts?.isDev ?? import.meta.env.DEV;
  if (isDev) return null;
  if (cachedTauriCdpProxyBase && !opts?.force) return cachedTauriCdpProxyBase;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const base = await invoke<string>('solari_cdp_proxy_base');
    if (typeof base === 'string' && base.startsWith('ws')) {
      cachedTauriCdpProxyBase = base;
      return base;
    }
  } catch (err) {
    console.warn('[solari] solari_cdp_proxy_base unavailable — using direct wss:', err);
  }
  return null;
}

export function resetSolariCdpProxyCache(): void {
  cachedTauriCdpProxyBase = null;
}

/** Human-readable note for Settings / ops when CDP fails in packaged builds. */
export const SOLARI_PROD_CORS_NOTE =
  'C72: packaged Tauri dials the Rust solari_cdp_proxy (Origin-strip, mirrors vite /solari-cdp); falls back to direct wss://api.getsolari.com if the proxy is down.';
export interface SolariClients {
  browser: CloudSolariBrowserClient;
  desktop: SolariDesktopClient;
  sandbox: SolariSandboxClient;
}

export type SolariErrorKind =
  | 'auth'
  | 'credit'
  | 'plan'
  | 'conflict'
  | 'concurrency'
  | 'badRequest'
  | 'transient'
  | 'unknown';

/** Thrown when the Solari API key is not (or not yet) configured in the vault. */
export class SolariNotConfiguredError extends Error {
  constructor() {
    super('Solari API key is not configured — set it in Settings > Solari.');
    this.name = 'SolariNotConfiguredError';
  }
}

/** Typed Solari error mapped from an SDK error by status/code fields only. */
export class SolariApiError extends Error {
  readonly kind: SolariErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean;

  constructor(kind: SolariErrorKind, status?: number, code?: string) {
    super(kind);
    this.name = 'SolariApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryable = kind === 'transient';
  }

  /** Short, actionable sentence a UI surface can show the user. */
  get userMessage(): string {
    switch (this.kind) {
      case 'auth':
        return 'Your Solari API key is invalid or missing — set it in Settings > Solari.';
      case 'credit':
        return 'Solari credits are exhausted — top up in the Solari console.';
      case 'plan':
        return 'This Solari feature requires a paid plan (desktops/VMs are not on the free tier) — upgrade in the Solari console.';
      case 'conflict':
        return 'A conflict occurred (for example, the profile editor is open) — close it and retry.';
      case 'concurrency':
        return 'Solari concurrency limit reached — close a session before opening another.';
      case 'badRequest':
        return 'The Solari request was rejected — check the request and retry.';
      case 'transient':
        return 'A transient Solari error occurred — retry shortly.';
      case 'unknown':
        return 'An unexpected Solari error occurred — retry or contact support.';
    }
  }
}

let cachedClients: SolariClients | null = null;
let cachedKey: string | undefined;

/** True when the vault holds a non-empty Solari API key. */
export async function isSolariConfigured(): Promise<boolean> {
  const presence = await getSecretPresence(SOLARI_VAULT_KEY);
  return presence.present && (presence.hint ?? '').length > 0;
}

/** Throws SolariNotConfiguredError unless a non-empty key is configured. */
export async function assertSolariConfigured(): Promise<void> {
  if (!(await isSolariConfigured())) throw new SolariNotConfiguredError();
}

/** Lazily constructs and caches the three Solari SDK clients for the vault
 *  key, reconstructing whenever the stored key changes value. */
export async function getSolariClients(): Promise<SolariClients> {
  const apiKey = await getSecretRaw(SOLARI_VAULT_KEY);
  if (cachedClients && cachedKey === apiKey) return cachedClients;
  cachedKey = apiKey;
  cachedClients = null;
  if (!apiKey || apiKey.length === 0) throw new SolariNotConfiguredError();
  // In dev the Vite proxy (/solari-api) forwards gateway calls same-origin so
  // CORS never blocks the webview; the packaged build talks to the gateway
  // directly (a Rust-side proxy is the follow-up if CORS applies there too).
  const baseUrl = import.meta.env.DEV ? `${window.location.origin}/solari-api` : SOLARI_BASE_URL;
  const opts = {
    apiKey,
    baseUrl,
    // WebView2 requires `fetch` to be invoked with the Window receiver — a bare
    // `globalThis.fetch` reference in the SDK's HttpTransport throws
    // "Illegal invocation". Bind through the member expression below.
    fetch: (input: RequestInfo | URL, init?: RequestInit) => window.fetch(input, init),
  };
  // Dynamic imports: the Solari SDKs must never be part of the eager module
  // graph. Desktop + sandbox are clean (@solarisdk/core only). The BROWSER SDK
  // pulls in patchright-core which Vite cannot bundle for the webview (no ESM
  // default / zipBundle deep-import), so it is loaded separately and — if it
  // fails — degrades to a throwing proxy instead of blocking desktop/sandbox.
  const [{ DesktopClient }, { SandboxClient }] = await Promise.all([
    import('@solarisdk/desktop'),
    import('@solarisdk/sandbox'),
  ]);
  cachedClients = {
    browser: new CloudSolariBrowserClient(apiKey, baseUrl),
    desktop: new DesktopClient(opts),
    sandbox: new SandboxClient(opts),
  };
  return cachedClients;
}

/** Clears the client cache; call after the vault key is set or deleted. */
export function resetSolariClients(): void {
  cachedClients = null;
  cachedKey = undefined;
}

/** Emits 'solari:configuredChange' with the current configured state; call
 *  after the vault key is set or deleted. */
export async function emitSolariConfiguredChange(): Promise<void> {
  emit('solari:configuredChange', { configured: await isSolariConfigured() });
}

/** Maps an SDK error to a SolariApiError by status/code fields only — never
 *  by error prose. Accepts the typed SDK errors (they expose status/code) and
 *  any object carrying those fields as numbers or strings. */
export function mapSolariError(err: unknown): SolariApiError {
  // The "no key configured" case has no status/code fields, so recognise it
  // explicitly — otherwise it maps to 'unknown' and hides the actionable
  // "set your key" guidance behind a generic "unexpected error" message.
  if (err instanceof SolariNotConfiguredError) return new SolariApiError('auth');
  const status = numericField(err, 'status');
  const code = stringField(err, 'code');
  if (status === 401) return new SolariApiError('auth', status, code);
  if (status === 402) {
    // A 402 can mean credits exhausted OR a feature the account's plan doesn't
    // include (desktops/VMs on the free tier). Distinguish by code so the UI
    // doesn't say "top up credits" for a plan-gated feature.
    if (code === 'FeatureRequiresPlan') return new SolariApiError('plan', status, code);
    return new SolariApiError('credit', status, code);
  }
  if (status === 409) return new SolariApiError('conflict', status, code);
  if (status === 429 || code === 'ConcurrencyLimitExceeded') {
    return new SolariApiError('concurrency', status, code);
  }
  if (status === 400) return new SolariApiError('badRequest', status, code);
  if (asRecord(err).retryable === true) return new SolariApiError('transient', status, code);
  return new SolariApiError('unknown', status, code);
}

function asRecord(err: unknown): Record<string, unknown> {
  return typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
}

function numericField(err: unknown, key: string): number | undefined {
  const value = asRecord(err)[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function stringField(err: unknown, key: string): string | undefined {
  const value = asRecord(err)[key];
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : undefined;
}


// ── Cloud browser client (bundle-safe HTTP + CDP, no patchright) ───

import { CloudCdpBrowser, type CdpBrowserSession } from './cdpBrowser.js';

export interface CloudBrowserLaunchOptions {
  profileId?: string;
  stealth?: boolean;
  proxy?: { country?: string; tier?: string; session?: string; sessionDuration?: number };
  captcha?: boolean;
  recording?: boolean;
  webBotAuth?: boolean;
}

/** Minimal Solari browser client over plain HTTP (through /solari-api) + the
 *  CDP driver in cdpBrowser.ts. Exposes the sessions/profiles/launch surface
 *  the LazyBot cloud tools rely on, without the patchright dependency that
 *  cannot bundle in the webview. */
export class CloudSolariBrowserClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  private async http(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await window.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let code: string | undefined;
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed?.code === 'string') code = parsed.code;
      } catch {
        // ignore
      }
      throw new SolariApiError(
        res.status === 401 ? 'auth' : res.status === 402 ? 'credit' : res.status === 429 ? 'concurrency' : 'badRequest',
        res.status,
        code,
      );
    }
    return res;
  }

  private async createSession(opts: CloudBrowserLaunchOptions = {}): Promise<CdpBrowserSession> {
    const body: Record<string, unknown> = {};
    if (opts.profileId) body.profileId = opts.profileId;
    if (opts.recording) body.recording = true;
    if (opts.stealth === true) body.stealth = true;
    if (opts.captcha === true) body.captcha = true;
    if (opts.webBotAuth === true) body.webBotAuth = true;
    if (opts.proxy !== undefined) body.proxy = opts.proxy;
    const res = await this.http('POST', '/sessions', body);
    const data = (await res.json()) as {
      sessionId: string;
      wsEndpoint?: string;
      cdpEndpoint?: string;
      expiresAt?: string;
      proxy?: CdpBrowserSession['proxy'];
    };
    if (!data.sessionId) throw new Error('Solari: unexpected session response');
    return {
      id: data.sessionId,
      cdpEndpoint: data.cdpEndpoint ?? data.wsEndpoint ?? '',
      expiresAt: data.expiresAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
      proxy: data.proxy,
    };
  }

  async launch(opts: CloudBrowserLaunchOptions = {}): Promise<CloudCdpBrowser> {
    const session = await this.createSession(opts);
    const id = session.id;
    return CloudCdpBrowser.connect(session, solariCdpProxyBase(), () => this.release(id));
  }

  async release(id: string): Promise<void> {
    await this.http('DELETE', `/sessions/${encodeURIComponent(id)}`);
  }

  async getReplayUrl(id: string): Promise<{ url: string }> {
    const res = await this.http('GET', `/sessions/${encodeURIComponent(id)}/replay-url`);
    const data = (await res.json()) as { url?: string };
    if (!data.url) throw new Error('Solari: unexpected replay-url response');
    return { url: data.url };
  }

  async listProfiles(): Promise<Array<{ id: string; name: string }>> {
    const res = await this.http('GET', '/profiles');
    const data = (await res.json()) as { profiles?: Array<{ id: string; name: string }> };
    return data.profiles ?? (data as unknown as Array<{ id: string; name: string }>);
  }

  async createProfile(opts: { name: string }): Promise<{ id: string; name: string }> {
    const res = await this.http('POST', '/profiles', opts);
    return (await res.json()) as { id: string; name: string };
  }

  async deleteProfile(id: string): Promise<void> {
    await this.http('DELETE', `/profiles/${encodeURIComponent(id)}`);
  }

  async saveProfile(id: string, storageState: unknown): Promise<void> {
    await this.http('POST', `/profiles/${encodeURIComponent(id)}/save`, { storageState });
  }

  readonly sessions = {
    create: (opts?: CloudBrowserLaunchOptions): Promise<CdpBrowserSession> => this.createSession(opts ?? {}),
    release: (id: string): void => {
      void this.release(id).catch((err) => console.error('[solari] browser release failed', err));
    },
    releaseAndWait: (id: string): Promise<void> => this.release(id),
    getReplayUrl: (id: string): Promise<{ url: string }> => this.getReplayUrl(id),
  };

  readonly profiles = {
    list: (): Promise<Array<{ id: string; name: string }>> => this.listProfiles(),
    create: (opts: { name: string }): Promise<{ id: string; name: string }> => this.createProfile(opts),
    delete: (id: string): Promise<void> => this.deleteProfile(id),
    save: (id: string, storageState: unknown): Promise<void> => this.saveProfile(id, storageState),
  };
}
