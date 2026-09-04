/// <reference types="vite/client" />

import type { StoredCapture } from './lib/platform/web';

declare global {
  interface Window {
    /** Web-mock capture store exposed for Playwright's page.evaluate() reads
     *  — see src/lib/platform/web.ts's `getWebCaptures`. */
    __lazyCaptures?: StoredCapture[];
  }
}

export {};

