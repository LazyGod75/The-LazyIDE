/* canvasIds.ts — id generator for canvas-owned facts minted client-side
   (drafts/notes created by the palette, quick-create, paste, duplicate).
   Uses crypto.randomUUID() when available (every real browser/Tauri webview
   target), falls back to a timestamp+random string for a test/jsdom
   environment that might lack it — never throws, never collides in
   practice.
*/

export function generateCanvasId(prefix: string): string {
  const unique =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${unique}`;
}
