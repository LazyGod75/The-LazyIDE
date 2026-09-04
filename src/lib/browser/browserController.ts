/* browserController — TypeScript wrapper for the Playwright browser automation
   Tauri commands. Provides a clean async API for the toolRuntime to call.

   The actual browser window is managed by a Rust-side Playwright controller
   process (src-tauri/src/commands/browser.rs) that spawns a Node.js script
   running Playwright. The browser window is VISIBLE by default so the user
   can see what the agent does in real-time.

   Only one browser instance is supported at a time (instance id "default").

   Emits 'browser:stateChange' on the bus whenever the browser state changes
   (open, navigate, click, fill, screenshot, close) so the canvas overlay and
   any other UI consumer can show a persistent, real-time view of what the
   agent is doing in the browser — not just ephemeral toasts.
*/

import { invoke } from '@tauri-apps/api/core';
import { emit } from '../bus.js';

export interface BrowserNavigateInfo {
  title: string;
  url: string;
}

export interface BrowserClickOptions {
  selector?: string;
  text?: string;
  ref?: string;
}

export interface BrowserState {
  isOpen: boolean;
  url: string;
  title: string;
  lastAction: string;
  lastActionDetail?: string;
  lastActionAt: number;
  screenshotDataUrl?: string;
}

export type BrowserStateListener = (state: BrowserState) => void;

class BrowserControllerImpl {
  private _isOpen = false;
  private _url = '';
  private _title = '';
  private _lastAction = '';
  private _lastActionDetail: string | undefined;
  private _lastActionAt = 0;
  private _screenshotDataUrl: string | undefined;
  private _listeners = new Set<BrowserStateListener>();

  private _state(): BrowserState {
    return {
      isOpen: this._isOpen,
      url: this._url,
      title: this._title,
      lastAction: this._lastAction,
      lastActionDetail: this._lastActionDetail,
      lastActionAt: this._lastActionAt,
      screenshotDataUrl: this._screenshotDataUrl,
    };
  }

  private _notify(action: string, detail?: string): void {
    this._lastAction = action;
    this._lastActionDetail = detail;
    this._lastActionAt = Date.now();
    const state = this._state();
    emit('browser:stateChange', state);
    for (const listener of this._listeners) {
      try { listener(state); } catch { /* listener errors are non-fatal */ }
    }
  }

  /** Subscribe to browser state changes. Returns an unsubscribe function. */
  subscribe(listener: BrowserStateListener): () => void {
    this._listeners.add(listener);
    listener(this._state());
    return () => { this._listeners.delete(listener); };
  }

  /** Get current browser state snapshot. */
  getState(): BrowserState {
    return this._state();
  }

  async open(opts: { headless?: boolean }): Promise<void> {
    await invoke<string>('browser_playwright_open', { headless: opts.headless ?? false });
    this._isOpen = true;
    this._notify('open', 'Opening browser window…');
  }

  async navigate(url: string): Promise<BrowserNavigateInfo> {
    const result = await invoke<string>('browser_playwright_navigate', { url });
    let info: BrowserNavigateInfo;
    try {
      const parsed = JSON.parse(result);
      info = { title: String(parsed.title ?? ''), url: String(parsed.url ?? url) };
    } catch {
      info = { title: '', url };
    }
    this._url = info.url;
    this._title = info.title;
    this._screenshotDataUrl = undefined;
    this._notify('navigate', info.url);
    return info;
  }

  async click(opts: BrowserClickOptions): Promise<void> {
    await invoke<string>('browser_playwright_click', {
      selector: opts.selector ?? null,
      text: opts.text ?? null,
      refId: opts.ref ?? null,
    });
    this._notify('click', String(opts.selector ?? opts.text ?? opts.ref ?? ''));
  }

  async fill(selector: string, value: string): Promise<void> {
    await invoke<string>('browser_playwright_fill', { selector, value });
    this._notify('fill', selector);
  }

  async screenshot(fullPage?: boolean): Promise<string> {
    const result = await invoke<string>('browser_playwright_screenshot', { fullPage: fullPage ?? false });
    let desc = result;
    try {
      const parsed = JSON.parse(result);
      const title = String(parsed.title ?? '');
      const url = String(parsed.url ?? '');
      const bodyText = String(parsed.bodyText ?? '');
      this._title = title;
      this._url = url;
      if (parsed.screenshotBase64) {
        this._screenshotDataUrl = `data:image/png;base64,${parsed.screenshotBase64}`;
      }
      desc = `Page: ${title}\nURL: ${url}\nContent preview: ${bodyText.slice(0, 500)}`;
    } catch { /* result is plain text */ }
    this._notify('screenshot', 'Captured page state');
    return desc;
  }

  async snapshot(): Promise<string> {
    const result = await invoke<string>('browser_playwright_snapshot');
    this._notify('snapshot', 'Accessibility tree snapshot');
    return result;
  }

  async close(): Promise<void> {
    try {
      await invoke<string>('browser_playwright_close');
    } finally {
      this._isOpen = false;
      this._url = '';
      this._title = '';
      this._screenshotDataUrl = undefined;
      this._notify('close', 'Browser closed');
    }
  }

  get isOpen(): boolean {
    return this._isOpen;
  }
}

let controllerInstance: BrowserControllerImpl | null = null;

export function getBrowserController(): BrowserControllerImpl {
  if (!controllerInstance) {
    controllerInstance = new BrowserControllerImpl();
  }
  return controllerInstance;
}
