/* openExternal — open a URL in the system browser.
   On desktop (Tauri) invokes the shell plugin's `open` command directly
   through Tauri's core IPC bridge (@tauri-apps/api/core) so the URL escapes
   the webview even in the packaged production app.
   On web (isTauri() === false) falls back to window.open.

   Why not `import('@tauri-apps/plugin-shell')` (the old approach):
   That package used to be listed in vite.config.ts's build.rollupOptions.external
   (now removed — nothing dynamic-imports it anymore), which made Rollup leave
   the dynamic import as a bare "@tauri-apps/plugin-shell" specifier in the
   production bundle instead of resolving/bundling it. The webview has no
   Node-style module resolution and no import map for that specifier, so
   `await import('@tauri-apps/plugin-shell')` threw at runtime in the packaged
   app (confirmed: `dist/assets/*.js` contained the literal, unresolved
   `import("@tauri-apps/plugin-shell")` after `npm run build`). That throw was
   silently swallowed by the old try/catch, which fell back to `window.open`,
   which WebView2 does not escalate to the system browser — so clicking
   "Passer à Pro" appeared to do nothing.

   `@tauri-apps/api/core` is NOT externalized and is already used this way
   throughout the codebase (see src/lib/platform/tauri.ts), so it is proven
   to bundle correctly and work in the packaged build.
*/

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './index.js';

export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  try {
    // Matches @tauri-apps/plugin-shell's `open(path, openWith?)`, which
    // internally calls invoke('plugin:shell|open', { path, with: openWith }).
    // Granted by the "shell:allow-open" permission in
    // src-tauri/capabilities/default.json.
    await invoke('plugin:shell|open', { path: url });
  } catch (error) {
    // Do NOT fall back to window.open here — in the packaged app WebView2
    // does not escalate window.open to the system browser, so that fallback
    // would silently no-op exactly like the bug this replaces. Surface the
    // failure instead so callers can show an error to the user.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`openExternal: shell plugin failed to open "${url}": ${message}`, { cause: error });
  }
}
