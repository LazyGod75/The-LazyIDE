/* cdpFacade.ts — C73 maintainable façade over raw CDP (cdpBrowser.ts).

   Keeps JSON-RPC + Page/Target quirks behind a small, testable surface so
   bot/session code does not grow more WebSocket plumbing. Live Solari still
   uses CloudCdpBrowser; tests / F110 login-wall mocks use MockCdpTransport.
*/

import {
  buildFullPageScreenshotParams,
  emitCdpPageView,
  pickDistinctPageTarget,
  type CdpPageView,
} from './cdpBrowser.js';

/** Minimal transport — real CdpSocket or an in-memory mock. */
export interface CdpTransport {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  on(method: string, cb: (params: Record<string, unknown>) => void): () => void;
  close(): void;
}

export interface CdpFacadePageSnapshot {
  targetId: string;
  url: string;
  title: string;
  html: string;
}

/**
 * High-level browser ops used by login / 2FA / takeover flows.
 * Does not own WebSocket lifecycle — inject a transport.
 */
export class CdpSessionFacade {
  private pages = new Map<string, CdpFacadePageSnapshot>();
  private activeTargetId: string | null = null;
  private readonly _transport: CdpTransport;
  private readonly _sessionId: string;

  constructor(
    transport: CdpTransport,
    sessionId: string,
  ) {
    this._transport = transport;
    this._sessionId = sessionId;
  }

  get session(): string {
    return this._sessionId;
  }

  get activePage(): CdpFacadePageSnapshot | null {
    if (!this.activeTargetId) return null;
    return this.pages.get(this.activeTargetId) ?? null;
  }

  listPages(): CdpFacadePageSnapshot[] {
    return [...this.pages.values()];
  }

  /** Register / navigate a page and emit the same page-view signal live CDP uses. */
  async navigate(targetId: string, url: string, title = ''): Promise<CdpPageView> {
    const existing = this.pages.get(targetId);
    const next: CdpFacadePageSnapshot = {
      targetId,
      url,
      title: title || existing?.title || '',
      html: existing?.html ?? '',
    };
    this.pages.set(targetId, next);
    this.activeTargetId = targetId;
    const view: CdpPageView = { sessionId: this._sessionId, url, title: next.title };
    emitCdpPageView(view);
    return view;
  }

  setHtml(targetId: string, html: string, title?: string): void {
    const cur = this.pages.get(targetId) ?? { targetId, url: 'about:blank', title: '', html: '' };
    this.pages.set(targetId, {
      ...cur,
      html,
      title: title ?? cur.title,
    });
  }

  /** Detect login / 2FA walls from HTML (F110 fidelity without live Solari). */
  detectAuthWall(html: string): 'none' | 'login' | '2fa' {
    const lower = html.toLowerCase();
    if (
      /two[- ]?factor|2fa|otp|one[- ]time|authenticator|verification code/.test(lower)
    ) {
      return '2fa';
    }
    if (
      /type=["']password["']|name=["']password["']|sign in|log in|connexion|se connecter/.test(lower)
    ) {
      return 'login';
    }
    return 'none';
  }

  async openDistinctTab(existingTargetId: string | undefined, createdTargetId: string): Promise<string> {
    const infos = [...this.pages.keys()].map((targetId) => ({ targetId, type: 'page' as const }));
    if (!infos.some((t) => t.targetId === createdTargetId)) {
      infos.push({ targetId: createdTargetId, type: 'page' });
    }
    const picked = pickDistinctPageTarget(infos, existingTargetId, createdTargetId);
    if (!this.pages.has(picked.targetId)) {
      this.pages.set(picked.targetId, {
        targetId: picked.targetId,
        url: 'about:blank',
        title: '',
        html: '',
      });
    }
    this.activeTargetId = picked.targetId;
    return picked.targetId;
  }

  screenshotParams(fullPage: boolean): Record<string, unknown> {
    return buildFullPageScreenshotParams({ format: 'png', fullPage });
  }

  close(): void {
    this._transport.close();
    this.pages.clear();
    this.activeTargetId = null;
  }
}

/** In-memory CDP transport for ultra-fidèle mocks (no network). */
export class MockCdpTransport implements CdpTransport {
  private listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  private closed = false;

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) throw new Error('CDP connection closed');
    this.calls.push({ method, params });
    if (method === 'Target.getTargets') {
      return { targetInfos: [{ targetId: 'mock-page-1', type: 'page' }] };
    }
    if (method === 'Target.createTarget') {
      return { targetId: `mock-page-${this.calls.length}` };
    }
    if (method === 'Page.captureScreenshot') {
      // "mock" in base64 — no Buffer dependency (webview + node).
      return { data: 'bW9jaw==' };
    }
    if (method === 'Browser.getVersion') {
      return { product: 'MockCDP/1.0' };
    }
    return {};
  }

  on(method: string, cb: (params: Record<string, unknown>) => void): () => void {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method)!.add(cb);
    return () => this.listeners.get(method)?.delete(cb);
  }

  /** Test helper — fire a CDP event into subscribers. */
  emit(method: string, params: Record<string, unknown>): void {
    for (const cb of this.listeners.get(method) ?? []) cb(params);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}
