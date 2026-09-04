/* botDeliverablePaths — single source of truth for LazyBot output paths.

   Local project silo:  `.lazy/bot-deliverables/<botId>/…`
   Cloud VM/sandbox:    `/workspace/bot-deliverables/<botId>/…`

   C83 — write_file, cloud_desktop_file_write and cloud_sandbox_write_file
   all remap relative bot writes onto the same bot-scoped deliverables tree
   (local vs cloud root differ; the relative suffix stays identical).
*/

/** Same mount as sessionLedger.WORKSPACE_MOUNT_PATH — inlined to avoid
 *  pulling solariClient into every write_file remapper. */
const WORKSPACE_MOUNT = '/workspace';

export const BOT_DELIVERABLES_DIR = '.lazy/bot-deliverables';
export const BOT_CLOUD_DELIVERABLES_DIR = `${WORKSPACE_MOUNT}/bot-deliverables`;

function normalizeSlashes(path: string): string {
  // path-lint-ignore: normalizeSlashes deliberately uses a raw backslash pattern —
  // this operates on bot deliverable paths from git output, not Rust canonicalize() output.
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:\//.test(path);
}

/** Remap a bot-local write onto `.lazy/bot-deliverables/<botId>/...`. */
export function remapBotDeliverablePath(botId: string, path: string): string {
  const normalized = normalizeSlashes(path);
  const prefix = `${BOT_DELIVERABLES_DIR}/${botId}/`;
  if (normalized.startsWith(prefix) || normalized.startsWith(`${BOT_DELIVERABLES_DIR}/`)) {
    return normalized;
  }
  if (isAbsolutePath(normalized)) return path;
  return `${prefix}${normalized}`;
}

/** Remap a cloud desktop/sandbox write onto `/workspace/bot-deliverables/<botId>/...`. */
export function remapBotCloudDeliverablePath(botId: string, path: string): string {
  const normalized = normalizeSlashes(path);
  const prefix = `${BOT_CLOUD_DELIVERABLES_DIR}/${botId}/`;
  if (normalized.startsWith(prefix) || normalized.startsWith(`${BOT_CLOUD_DELIVERABLES_DIR}/`)) {
    return normalized;
  }
  // Already under /workspace but not in the bot silo — leave alone (shared volume).
  if (normalized.startsWith(`${WORKSPACE_MOUNT}/`) || normalized === WORKSPACE_MOUNT) {
    return normalized;
  }
  if (isAbsolutePath(normalized) && !normalized.startsWith(WORKSPACE_MOUNT)) {
    return path;
  }
  const relative = normalized.replace(/^\.?\/+/, '');
  return `${prefix}${relative}`;
}
