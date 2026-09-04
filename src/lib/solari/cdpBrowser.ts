/* cdpBrowser.ts — bundle-safe Solari browser driver over raw CDP.

   The @solarisdk/browser SDK pulls in patchright-core which Vite cannot bundle
   for the webview (no ESM default / zipBundle deep-import). The gateway itself
   only needs plain HTTP + a CDP WebSocket, both of which work here:
     - sessions.create  POST /sessions             (through the /solari-api proxy)
     - CDP connect      ws(s)://<host>/solari-cdp/cdp/<id> (Vite strips Origin)
   A browser WebSocket always sends an Origin header, and the Solari gateway
   403s any Origin-carrying handshake, so the app dials a same-origin URL that
   Vite forwards upstream with the Origin removed — this mirrors what the SDK's
   local proxy does in Node.

   This module exposes just enough of the patchright surface that the
   cloud_browser_* handlers use: browser.id/close/isConnected/contexts/newPage
   and page.goto/title/content/url/screenshot/mouse.wheel/waitForSelector/
   waitForTimeout/context.storageState.
*/

// ── Types ──────────────────────────────────────────────────────────

export interface CdpBrowserSession {
  id: string;
  expiresAt: string;
  cdpEndpoint: string;
  proxy?: { timezoneId?: string; country?: string; tier?: string };
}

export interface CdpPageHandle {
  goto(url: string, opts?: { timeout?: number }): Promise<{ status: number; url: () => Promise<string> }>;
  title(): Promise<string>;
  content(): Promise<string>;
  url(): Promise<string>;
  screenshot(opts?: { format?: string; type?: string; fullPage?: boolean }): Promise<Uint8Array>;
  click(selector: string): Promise<void>;
  getByText(text: string): { click: () => Promise<void> };
  fill(selector: string, value: string): Promise<void>;
  mouse: { wheel(dx: number, dy: number): Promise<void> };
  waitForTimeout(ms: number): Promise<void>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  context(): { storageState(): Promise<{ cookies: never[]; origins: never[] }> };
  close(): Promise<void>;
}

// ── JSON-RPC socket ────────────────────────────────────────────────

interface PendingCall {
  id: number;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CMD_TIMEOUT_MS = 30_000;
const HEARTBEAT_MS = 15_000;

export interface CdpPageView {
  sessionId: string;
  url: string;
  title: string;
}

const pageViewListeners = new Set<(view: CdpPageView) => void>();

/** Subscribe to navigations on any CDP page. Returns unsubscribe. */
export function onCdpPageView(cb: (view: CdpPageView) => void): () => void {
  pageViewListeners.add(cb);
  return () => { pageViewListeners.delete(cb); };
}

function notifyPageView(view: CdpPageView): void {
  for (const cb of pageViewListeners) {
    try { cb(view); } catch { /* listener errors must not break CDP */ }
  }
}

/** Notify subscribers of a live page view (navigation/title). Used by CdpPage.goto
 *  and by tests that simulate a login-wall takeover signal. */
export function emitCdpPageView(view: CdpPageView): void {
  notifyPageView(view);
}

/** Pick a page target that is distinct from `existingTargetId` (C54 multi-tab). */
export function pickDistinctPageTarget(
  targetInfos: Array<{ targetId: string; type: string }>,
  existingTargetId: string | undefined,
  createdTargetId: string,
): { targetId: string; type: string } {
  const pages = targetInfos.filter((t) => t.type === 'page');
  const fresh = pages.find((t) => t.targetId === createdTargetId)
    ?? pages.find((t) => t.targetId !== existingTargetId);
  return fresh ?? { targetId: createdTargetId, type: 'page' };
}

/** CDP Page.captureScreenshot params — fullPage uses captureBeyondViewport (C55). */
export function buildFullPageScreenshotParams(opts: {
  format?: string;
  type?: string;
  fullPage?: boolean;
}): Record<string, unknown> {
  const format = opts.format ?? opts.type ?? 'png';
  const params: Record<string, unknown> = { format, fromSurface: true };
  if (opts.fullPage) params.captureBeyondViewport = true;
  return params;
}

export class CdpSocket {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private closed = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 15_000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.startHeartbeat();
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket connection failed'));
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const call = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            clearTimeout(call.timer);
            if (msg.error) call.reject(new Error(`CDP ${msg.error.message ?? 'error'}`));
            else call.resolve(msg.result);
            return;
          }
          if (msg.method && this.listeners.has(msg.method)) {
            for (const cb of this.listeners.get(msg.method)!) cb(msg.params ?? {});
          }
        } catch {
          // ignore non-JSON keepalives
        }
      };
      ws.onclose = () => {
        for (const call of this.pending.values()) {
          clearTimeout(call.timer);
          call.reject(new Error('CDP connection closed'));
        }
        this.pending.clear();
      };
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${CMD_TIMEOUT_MS}ms`));
      }, CMD_TIMEOUT_MS);
      this.pending.set(id, { id, resolve, reject, timer });
      try {
        this.ws!.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  on(method: string, cb: (params: Record<string, unknown>) => void): () => void {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method)!.add(cb);
    return () => this.listeners.get(method)?.delete(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      void this.send('Browser.getVersion').catch(() => this.close());
    }, HEARTBEAT_MS);
  }
}

// ── Page (single default page target) ──────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CdpPage implements CdpPageHandle {
  private pageSessionId: string | null = null;
  private readonly socket: CdpSocket;
  private readonly targetId: string;
  private readonly sessionId: string;
  private screencastOff: (() => void) | null = null;

  constructor(socket: CdpSocket, targetId: string, sessionId: string) {
    this.socket = socket;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  /** CDP target id for this page (C54 multi-tab). */
  get cdpTargetId(): string {
    return this.targetId;
  }

  private async session(): Promise<string> {
    if (this.pageSessionId) return this.pageSessionId;
    const res = (await this.socket.send('Target.attachToTarget', { targetId: this.targetId, flatten: true })) as {
      sessionId: string;
    };
    this.pageSessionId = res.sessionId;
    await this.socket.send('Page.enable', {}, this.pageSessionId);
    await this.socket.send('Runtime.enable', {}, this.pageSessionId);
    return this.pageSessionId;
  }

  async goto(url: string, opts: { timeout?: number } = {}): Promise<{ status: number; url: () => Promise<string> }> {
    void opts.timeout; // settle window below; kept for interface parity
    const sid = await this.session();
    const status = (await this.socket.send('Page.navigate', { url }, sid)) as { errorText?: string };
    const code = status.errorText ? 500 : 200;
    await sleep(400); // small settle for SPA navigations before title/content reads
    const [title, href] = await Promise.all([this.title(), this.url()]);
    notifyPageView({ sessionId: this.sessionId, url: href, title });
    return { status: code, url: () => this.url() };
  }

  async title(): Promise<string> {
    const sid = await this.session();
    const res = (await this.socket.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sid)) as {
      result?: { value?: string };
    };
    return String(res.result?.value ?? '');
  }

  async url(): Promise<string> {
    const sid = await this.session();
    const res = (await this.socket.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sid)) as {
      result?: { value?: string };
    };
    return String(res.result?.value ?? '');
  }

  async content(): Promise<string> {
    const sid = await this.session();
    const res = (await this.socket.send(
      'Runtime.evaluate',
      { expression: 'document.documentElement.outerHTML', returnByValue: true },
      sid,
    )) as { result?: { value?: string } };
    return String(res.result?.value ?? '');
  }

  async screenshot(opts: { format?: string; type?: string; fullPage?: boolean } = {}): Promise<Uint8Array> {
    const sid = await this.session();
    const params = buildFullPageScreenshotParams(opts);
    const res = (await this.socket.send('Page.captureScreenshot', params, sid)) as {
      data?: string;
    };
    if (!res.data) throw new Error('CDP screenshot returned no data');
    const binary = atob(res.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async click(selector: string): Promise<void> {
    const sid = await this.session();
    const res = (await this.socket.send(
      'Runtime.evaluate',
      { expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; (el as HTMLElement).click(); return 'ok'; })()`, returnByValue: true },
      sid,
    )) as { result?: { value?: string } };
    if (res.result?.value === 'missing') throw new Error(`Element not found: ${selector}`);
  }

  getByText(text: string): { click: () => Promise<void> } {
    return {
      click: async () => {
        const sid = await this.session();
        const res = (await this.socket.send(
          'Runtime.evaluate',
          { expression: `(() => { const el = [...document.querySelectorAll('button, a, [role=button], input, [contenteditable]')].find(e => (e.innerText || e.value || '').trim() === ${JSON.stringify(text)}); if (!el) return 'missing'; (el as HTMLElement).click(); return 'ok'; })()`, returnByValue: true },
          sid,
        )) as { result?: { value?: string } };
        if (res.result?.value === 'missing') throw new Error(`Element with text not found: ${text}`);
      },
    };
  }

  async fill(selector: string, value: string): Promise<void> {
    const sid = await this.session();
    const res = (await this.socket.send(
      'Runtime.evaluate',
      { expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set; if (setter) setter.call(el, ${JSON.stringify(value)}); else (el as HTMLInputElement).value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`, returnByValue: true },
      sid,
    )) as { result?: { value?: string } };
    if (res.result?.value === 'missing') throw new Error(`Element not found: ${selector}`);
  }

  mouse = {
    wheel: async (dx: number, dy: number): Promise<void> => {
      const sid = await this.session();
      await this.socket.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: 0, y: 0, deltaX: dx, deltaY: dy },
        sid,
      );
    },
  };

  async waitForTimeout(ms: number): Promise<void> {
    await sleep(ms);
  }

  async waitForSelector(selector: string, opts: { timeout?: number } = {}): Promise<unknown> {
    const sid = await this.session();
    const deadline = Date.now() + (opts.timeout ?? 30_000);
    while (Date.now() < deadline) {
      const res = (await this.socket.send(
        'Runtime.evaluate',
        { expression: `!!document.querySelector(${JSON.stringify(selector)})`, returnByValue: true },
        sid,
      )) as { result?: { value?: boolean } };
      if (res.result?.value) return {};
      await sleep(250);
    }
    throw new Error(`Timeout waiting for selector: ${selector}`);
  }

  context() {
    return {
      storageState: async () => ({ cookies: [] as never[], origins: [] as never[] }),
    };
  }

  async clickAt(x: number, y: number): Promise<void> {
    const sid = await this.session();
    await this.socket.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid);
    await this.socket.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid);
  }

  async typeText(text: string): Promise<void> {
    const sid = await this.session();
    await this.socket.send('Input.insertText', { text }, sid);
  }

  async startScreencast(onFrame: (dataUrl: string) => void): Promise<() => void> {
    this.screencastOff?.();
    const sid = await this.session();
    const off = this.socket.on('Page.screencastFrame', (params) => {
      const data = typeof params.data === 'string' ? params.data : '';
      const sessionId = params.sessionId;
      if (data) onFrame(`data:image/jpeg;base64,${data}`);
      void this.socket.send('Page.screencastFrameAck', { sessionId }, sid).catch(() => undefined);
    });
    await this.socket.send('Page.startScreencast', { format: 'jpeg', quality: 50, everyNthFrame: 2 }, sid);
    this.screencastOff = () => {
      off();
      void this.socket.send('Page.stopScreencast', {}, sid).catch(() => undefined);
      this.screencastOff = null;
    };
    return this.screencastOff;
  }

  async close(): Promise<void> {
    this.screencastOff?.();
  }
}

// ── Browser (one CDP session) ──────────────────────────────────────

export class CloudCdpBrowser {
  readonly pages: CdpPage[] = [];
  private socket: CdpSocket | null = null;
  readonly id: string;
  readonly expiresAt: string;
  private readonly cdpProxyUrl: string;
  private readonly releaseRemote?: () => Promise<void>;

  private constructor(id: string, expiresAt: string, cdpProxyUrl: string, releaseRemote?: () => Promise<void>) {
    this.id = id;
    this.expiresAt = expiresAt;
    this.cdpProxyUrl = cdpProxyUrl;
    this.releaseRemote = releaseRemote;
  }

  /** Connect a session's CDP endpoint (via the Vite /solari-cdp proxy). */
  static async connect(
    session: CdpBrowserSession,
    cdpProxyBase: string,
    releaseRemote?: () => Promise<void>,
  ): Promise<CloudCdpBrowser> {
    const browser = new CloudCdpBrowser(
      session.id,
      session.expiresAt,
      `${cdpProxyBase}/cdp/${encodeURIComponent(session.id)}`,
      releaseRemote,
    );
    await browser.attach();
    return browser;
  }

  private async attach(): Promise<void> {
    const socket = new CdpSocket(this.cdpProxyUrl);
    await socket.connect();
    this.socket = socket;
    const targets = (await socket.send('Target.getTargets')) as {
      targetInfos?: Array<{ targetId: string; type: string }>;
    };
    let pageTarget = (targets.targetInfos ?? []).find((t) => t.type === 'page');
    if (!pageTarget) {
      const created = (await socket.send('Target.createTarget', { url: 'about:blank' })) as {
        targetId: string;
      };
      pageTarget = { targetId: created.targetId, type: 'page' };
    }
    this.pages.length = 0;
    this.pages.push(new CdpPage(socket, pageTarget.targetId, this.id));
  }

  async newPage(): Promise<CdpPage> {
    if (!this.socket) throw new Error('CDP browser is not connected');
    const existingId = this.pages[0]?.cdpTargetId;
    const created = (await this.socket.send('Target.createTarget', { url: 'about:blank' })) as {
      targetId: string;
    };
    const targets = (await this.socket.send('Target.getTargets')) as {
      targetInfos?: Array<{ targetId: string; type: string }>;
    };
    const pageTarget = pickDistinctPageTarget(targets.targetInfos ?? [], existingId, created.targetId);
    const page = new CdpPage(this.socket, pageTarget.targetId, this.id);
    this.pages.push(page);
    return page;
  }

  contexts(): Array<{ pages: () => CdpPage[] }> {
    return [{ pages: () => this.pages }];
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket['closed'];
  }

  async close(): Promise<void> {
    this.pages[0]?.close().catch(() => undefined);
    this.socket?.close();
    this.socket = null;
    if (this.releaseRemote) {
      try {
        await this.releaseRemote();
      } catch (err) {
        console.error('[cdpBrowser] remote release failed', err);
      }
    }
  }
}

