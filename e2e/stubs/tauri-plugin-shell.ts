/**
 * Minimal stub for @tauri-apps/plugin-shell used in E2E / web-mode dev server.
 * The real checkout.ts wraps the import in try/catch and falls back to window.open,
 * so throwing here is fine — it exercises the correct web-mode code path.
 */
export async function open(_url: string): Promise<void> {
  throw new Error('Tauri shell not available in web mode');
}
